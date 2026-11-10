import { CopyMediaLink } from "../components/media/CopyMediaLink";
import { mediaPermalink, unavailableMediaMessage } from "../lib/media-permalink";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useBeforeUnload, useBlocker, useLocation, useNavigate, useSearchParams } from "react-router";
import { parseMediaWorkspacePath } from "../lib/routes";
import { CollectionColorField } from "../components/CollectionColorField";
import { useControlPresentation } from "../context/ControlPresentationContext";
import { Tooltip } from "../components/ui/Tooltip";
import { Icon } from "../components/ui/Icon";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
} from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";
import { useClearFilterUndo } from "../lib/use-clear-filter-undo";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import { HttpError, type MediaCategoryDefinition } from "../lib/functions";
import {
  confirmedCollectionChangedRefs,
  listMediaCollectionItems,
  listMediaCollections,
  mutateMediaCollection,
  mediaCollectionRefKey,
  setMediaCollectionItems,
  type MediaCollectionItemPage,
  type MediaCollectionLifecycle,
  type MediaCollectionColor,
  type MediaCollectionScope,
  type MediaCollectionSummary,
} from "../lib/media-collections";
import { readMediaCollectionPins } from "../lib/media-collection-pins";
import { saveMediaCollectionPin } from "../lib/media-collection-pins-store";
import type { CmsUserDoc } from "../lib/principal";
import { mediaCollectionsPath, mediaImagesPath, mediaVideosPath } from "../lib/routes";
import { encodeCollectionsMediaLocation, parseCollectionsMediaLocation } from "../lib/media-query";
import { MediaToolbar, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import type { MediaAssetRef } from "../lib/media-identity";
import type { Principal } from "../../../packages/content-core/src/rbac";
import type { SavedMediaView } from "../lib/saved-media-views";
import { MediaCollectionItems } from "./MediaCollectionItems";
import { mediaFullViewerKey } from "../components/media/MediaFullViewer";
import "./MediaCollectionsLibrary.css";

type CollectionListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; records: MediaCollectionSummary[]; cursors: Record<MediaCollectionScope, string | null> };

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; page: MediaCollectionItemPage; pages: number };

function newRequestId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function isConflict(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409;
}

function collectionFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return "Your collection access changed. Reload the page, then sign in again if needed.";
  }
  return error instanceof Error ? error.message : fallback;
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function CollectionPin({ name, pinned, disabled, onClick }: {
  name: string; pinned: boolean; disabled: boolean; onClick: () => void;
}) {
  const presentation = useControlPresentation();
  const label = `${pinned ? "Unpin" : "Pin"} ${name}`;
  const button = <Button className="media-collection-card-pin" data-presentation={presentation}
    variant="ghost" aria-pressed={pinned} aria-label={label} disabled={disabled} onClick={onClick}>
    {presentation === "text" ? (pinned ? "Unpin" : "Pin") : <Icon name="pin" />}
  </Button>;
  return disabled || presentation === "text" ? button : <Tooltip content={label}>{button}</Tooltip>;
}

export function MediaCollectionsLibrary({
  collectionId,
  userId,
  userDoc,
  canBrowseImages,
  principal,
  categories,
  getIdToken,
  extraExitRisk = false,
  videoTransferActive = false,
  onDiscardExtra,
  onDiscardVideo,
}: {
  collectionId: string | null;
  userId: string;
  userDoc: CmsUserDoc | null;
  canBrowseImages: boolean;
  principal: Principal;
  categories: readonly MediaCategoryDefinition[];
  getIdToken: () => Promise<string>;
  /** Unsaved work owned outside this list, such as a routed image upload. */
  extraExitRisk?: boolean;
  /** A routed video transfer is running and would lose its file if this page unmounts it. */
  videoTransferActive?: boolean;
  /** Drop outside work, such as a routed upload, when the person confirms leaving. */
  onDiscardExtra?: () => void;
  onDiscardVideo?: () => void;
}) {
  const notice = useSuccessNotice();
  const currentNotice = useRef(notice);
  currentNotice.current = notice;
  const extraExitRef = useRef(extraExitRisk);
  extraExitRef.current = extraExitRisk;
  const navigate = useNavigate();
  const routeKey = useLocation().key;
  const [routeParams, setRouteParams] = useSearchParams();
  const mediaLocation = parseCollectionsMediaLocation(routeParams.toString());
  const lifecycle = mediaLocation.show;
  const scopeFilter = mediaLocation.scope;
  function writeLocation(show: MediaCollectionLifecycle, scope: MediaCollectionScope | null, ref = mediaLocation.selectedRef) {
    const next = encodeCollectionsMediaLocation(show, scope, ref);
    if (next.toString() === routeParams.toString()) return;
    internalNavigation.current = true;
    setRouteParams(next);
  }
  const [listAttempt, setListAttempt] = useState(0);
  const [listState, setListState] = useState<CollectionListState>({ status: "loading" });
  const [listLoadingScope, setListLoadingScope] = useState<MediaCollectionScope | "">("");
  const listMoreGeneration = useRef(0);
  const [listMoreError, setListMoreError] = useState("");
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [detailState, setDetailState] = useState<DetailState>({ status: "loading" });
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
  const [detailMoreError, setDetailMoreError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createScope, setCreateScope] = useState<MediaCollectionScope>("private");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createColor, setCreateColor] = useState<MediaCollectionColor>("slate");
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState("");
  const createOperation = useRef<{ fingerprint: string; requestId: string }>();
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editColor, setEditColor] = useState<MediaCollectionColor>("slate");
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState("");
  const editOperation = useRef<{ fingerprint: string; requestId: string }>();
  const editBaseline = useRef<{ collectionId: string; version: number }>();
  const [archiveDecision, setArchiveDecision] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const archiveOperation = useRef<{ action: "archive" | "restore"; version: number; requestId: string }>();
  const [removePending, setRemovePending] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [viewerExitRisk, setViewerExitRisk] = useState(false);
  const [viewerSaving, setViewerSaving] = useState(false);
  const removeOperation = useRef<{ key: string; version: number; requestId: string }>();
  const itemsHeadingRef = useRef<HTMLHeadingElement>(null);
  const storedPins = useMemo(() => readMediaCollectionPins(userDoc), [userDoc]);
  const [pins, setPins] = useState(storedPins);
  const [pinPending, setPinPending] = useState("");
  const [pinError, setPinError] = useState("");
  const generation = useRef(0);
  const accountGeneration = useRef(0);
  const viewIdentity = useRef(0);
  const internalNavigation = useRef(false);
  const prepareFilterUndo = useClearFilterUndo(routeKey, routeParams.toString(), before => {
    internalNavigation.current = true;
    setRouteParams(new URLSearchParams(before), { replace: true });
  });
  function clearFilters() {
    const before = encodeCollectionsMediaLocation(lifecycle, scopeFilter, null).toString();
    const after = encodeCollectionsMediaLocation("active", null, null).toString();
    if (prepareFilterUndo(before, after)) writeLocation("active", null, null);
  }
  const detailStateRef = useRef(detailState);
  detailStateRef.current = detailState;
  const detail = detailState.status === "ready" ? detailState.page : undefined;
  const collection = detail?.collection;
  const openedRef = mediaLocation.selectedRef;
  const viewerOpen = Boolean(openedRef && detail?.items.some(item => item.available
    && mediaFullViewerKey(item.ref) === mediaFullViewerKey(openedRef)));
  const mutationPending = createPending || editPending || archivePending || Boolean(removePending) || viewerSaving;
  const createDirty = createOpen && (Boolean(createName) || Boolean(createDescription) || createScope !== "private" || createColor !== "slate");
  const editDirty = Boolean(collection && (editName.trim() !== collection.name || editDescription.trim() !== collection.description || editColor !== (collection.color ?? "slate")));
  const ownExitRisk = mutationPending || createDirty || editDirty || viewerExitRisk;
  const exitRisk = ownExitRisk || extraExitRisk || videoTransferActive;
  const editDirtyRef = useRef(editDirty);
  editDirtyRef.current = editDirty;
  const discardUpload = useRef(false);
  const discardVideo = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    const leavesWorkspace = kind === "not-found";
    const opensRecycleBin = kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardUpload.current = leavesWorkspace || opensRecycleBin;
    discardVideo.current = leavesWorkspace;
    if (internalNavigation.current) {
      internalNavigation.current = false;
      return false;
    }
    const moving = currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash;
    if (!moving) return false;
    if (ownExitRisk) return true;
    if (videoTransferActive && discardVideo.current) return true;
    return extraExitRisk && discardUpload.current;
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useBeforeUnload(event => {
    if (!exitRisk) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const exitRiskRef = useRef(exitRisk);
  const videoActiveRef = useRef(videoTransferActive);
  exitRiskRef.current = exitRisk;
  videoActiveRef.current = videoTransferActive;
  const hasExitRisk = useCallback(() => exitRiskRef.current || videoActiveRef.current, []);
  useRegisterExitGuard(exitRisk || videoTransferActive ? { saving: mutationPending, hasUnsavedWork: hasExitRisk } : null);

  useEffect(() => setPins(storedPins), [storedPins]);

  useEffect(() => {
    listMoreGeneration.current++;
    setListLoadingScope("");
    setListMoreError("");
  }, [lifecycle, scopeFilter, collectionId, userId]);

  useEffect(() => {
    const current = ++accountGeneration.current;
    return () => {
      if (accountGeneration.current === current) accountGeneration.current++;
    };
  }, [userId]);

  useEffect(() => {
    viewIdentity.current++;
    internalNavigation.current = false;
    createOperation.current = undefined;
    setCreateOpen(false);
    setCreateScope("private");
    setCreateName("");
    setCreateDescription("");
    setCreateColor("slate");
    editBaseline.current = undefined;
    editOperation.current = undefined;
    archiveOperation.current = undefined;
    removeOperation.current = undefined;
    setEditPending(false);
    setArchivePending(false);
    setRemovePending("");
    setViewerExitRisk(false);
    setViewerSaving(false);
    setCreatePending(false);
    setEditError("");
    setArchiveError("");
    setArchiveDecision(false);
    setRemoveError("");
    setPinError("");
    setDetailMoreError("");
    setDetailLoadingMore(false);
  }, [collectionId, userId]);

  useEffect(() => {
    if (collectionId) return;
    const current = ++generation.current;
    setListLoadingScope("");
    setListState({ status: "loading" });
    void Promise.all(((["private", "all_staff"] as const).map(async scope => {
      const result = await listMediaCollections(await getIdToken(), { scope, lifecycle, limit: 30 });
      return [scope, result] as const;
    }))).then(results => {
      if (generation.current !== current) return;
      setListState({
        status: "ready",
        records: results.flatMap(([, result]) => result.collections),
        cursors: Object.fromEntries(results.map(([scope, result]) => [scope, result.nextCursor])) as Record<MediaCollectionScope, string | null>,
      });
    }).catch(error => {
      if (generation.current === current) setListState({
        status: "error",
        message: collectionFailureMessage(error, "Collections could not be loaded."),
      });
    });
    return () => { generation.current++; };
  }, [collectionId, getIdToken, lifecycle, listAttempt, userId]);

  useEffect(() => {
    if (!collectionId) return;
    if (!/^[a-f0-9]{64}$/.test(collectionId)) {
      setDetailState({ status: "error", message: unavailableMediaMessage });
      return;
    }
    const current = ++generation.current;
    setDetailLoadingMore(false);
    setDetailState({ status: "loading" });
    void listMediaCollectionItemsFromSession(collectionId, undefined, current, false);
    return () => { generation.current++; };
  }, [collectionId, detailAttempt, getIdToken, userId]);

  async function listMediaCollectionItemsFromSession(
    id: string,
    cursor: string | undefined,
    current: number,
    append: boolean,
  ) {
    const selectedRef = mediaLocation.selectedRef;
    const closesViewer = !append && detailState.status === "ready"
      && detailState.page.collection.id === id && Boolean(selectedRef);
    const clearOpened = () => {
      internalNavigation.current = true;
      setRouteParams(encodeCollectionsMediaLocation(lifecycle, scopeFilter, null), { replace: true });
      requestAnimationFrame(() => itemsHeadingRef.current?.focus());
    };
    if (closesViewer) clearOpened();
    try {
      const page = await listMediaCollectionItems(await getIdToken(), { collectionId: id, cursor, limit: 30 });
      if (generation.current !== current) return;
      setDetailState(previous => append && previous.status === "ready"
        ? { status: "ready", page: { ...page, items: [...previous.page.items, ...page.items] }, pages: previous.pages + 1 }
        : { status: "ready", page, pages: 1 });
      if (!append && selectedRef && !closesViewer && !page.items.some(item => item.available
        && mediaFullViewerKey(item.ref) === mediaFullViewerKey(selectedRef))) clearOpened();
      if (!append && (editBaseline.current?.collectionId !== page.collection.id ||
        editBaseline.current?.version !== page.collection.version)) {
        setEditName(page.collection.name);
        setEditDescription(page.collection.description);
        setEditColor(page.collection.color ?? "slate");
      }
      if (!append) editBaseline.current = { collectionId: page.collection.id, version: page.collection.version };
      setDetailMoreError("");
    } catch (error) {
      if (generation.current === current) {
        const message = error instanceof HttpError && [401, 403, 404].includes(error.status)
          ? unavailableMediaMessage
          : collectionFailureMessage(error, "This collection could not be loaded.");
        if (append) setDetailMoreError(message);
        else setDetailState({ status: "error", message });
      }
    }
  }

  async function loadMoreItems() {
    if (!collection || !detail?.nextCursor || detailLoadingMore) return;
    const current = generation.current;
    setDetailLoadingMore(true);
    setDetailMoreError("");
    try {
      await listMediaCollectionItemsFromSession(collection.id, detail.nextCursor, current, true);
    } finally {
      if (generation.current === current) setDetailLoadingMore(false);
    }
  }

  function changeCreateIntent() {
    createOperation.current = undefined;
    setCreateError("");
  }

  async function createCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    const description = createDescription.trim();
    if (!name || createPending) return;
    const fingerprint = JSON.stringify([createScope, name, description, createColor]);
    const operation = createOperation.current?.fingerprint === fingerprint
      ? createOperation.current
      : { fingerprint, requestId: newRequestId() };
    createOperation.current = operation;
    const account = accountGeneration.current;
    const view = viewIdentity.current;
    setCreatePending(true);
    setCreateError("");
    try {
      const token = await getIdToken();
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      const result = await mutateMediaCollection(token, {
        action: "create",
        requestId: operation.requestId,
        scope: createScope,
        name,
        description,
        color: createColor,
      });
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      createOperation.current = undefined;
      setCreateOpen(false);
      setCreateScope("private");
      setCreateName("");
      setCreateDescription("");
      setCreateColor("slate");
      if (blockerRef.current.state === "blocked") {
        if (!extraExitRef.current && !videoActiveRef.current) blockerRef.current.proceed();
      } else {
        internalNavigation.current = true;
        navigate(mediaCollectionsPath(result.collection.id));
      }
    } catch (error) {
      if (accountGeneration.current === account && viewIdentity.current === view) {
        if (blockerRef.current.state === "blocked") blockerRef.current.reset();
        setCreateError(collectionFailureMessage(error, "The collection could not be created. Try again."));
      }
    } finally {
      if (accountGeneration.current === account && viewIdentity.current === view) setCreatePending(false);
    }
  }

  async function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!collection || editPending) return;
    const name = editName.trim();
    const description = editDescription.trim();
    if (!name) { setEditError("Enter a collection name."); return; }
    const fingerprint = JSON.stringify([collection.id, collection.version, name, description, editColor]);
    const operation = editOperation.current?.fingerprint === fingerprint
      ? editOperation.current
      : { fingerprint, requestId: newRequestId() };
    editOperation.current = operation;
    const account = accountGeneration.current;
    const view = viewIdentity.current;
    setEditPending(true);
    setEditError("");
    try {
      const token = await getIdToken();
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      const result = await mutateMediaCollection(token, {
        action: "update",
        requestId: operation.requestId,
        collectionId: collection.id,
        baseVersion: collection.version,
        name,
        description,
        color: editColor,
      });
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      editOperation.current = undefined;
      editBaseline.current = { collectionId: result.collection.id, version: result.collection.version };
      setDetailState(previous => previous.status === "ready"
        ? { ...previous, page: { ...previous.page, collection: result.collection } }
        : previous);
      setEditName(result.collection.name);
      setEditDescription(result.collection.description);
      setEditColor(result.collection.color ?? "slate");
      if (blockerRef.current.state === "blocked" && !extraExitRef.current && !videoActiveRef.current) blockerRef.current.proceed();
    } catch (error) {
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      if (blockerRef.current.state === "blocked") blockerRef.current.reset();
      if (isConflict(error)) {
        editOperation.current = undefined;
        setEditError("This collection changed. Current details were reloaded; review them before saving again.");
        refreshDetail();
      } else {
        setEditError(collectionFailureMessage(error, "Collection details could not be saved. Try again."));
      }
    } finally {
      if (accountGeneration.current === account && viewIdentity.current === view) setEditPending(false);
    }
  }

  async function changeLifecycle() {
    if (!collection || archivePending) return;
    const action: "archive" | "restore" = collection.lifecycle === "active" ? "archive" : "restore";
    const operation = archiveOperation.current?.action === action && archiveOperation.current.version === collection.version
      ? archiveOperation.current
      : { action, version: collection.version, requestId: newRequestId() };
    archiveOperation.current = operation;
    const account = accountGeneration.current;
    const view = viewIdentity.current;
    setArchivePending(true);
    setArchiveError("");
    try {
      const token = await getIdToken();
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      await mutateMediaCollection(token, {
        action,
        requestId: operation.requestId,
        collectionId: collection.id,
        baseVersion: collection.version,
      });
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      archiveOperation.current = undefined;
      setArchiveDecision(false);
      if (blockerRef.current.state === "blocked" && !editDirtyRef.current && !extraExitRef.current && !videoActiveRef.current) blockerRef.current.proceed();
      else if (blockerRef.current.state !== "blocked") {
        internalNavigation.current = true;
        navigate(mediaCollectionsPath());
      }
    } catch (error) {
      if (accountGeneration.current !== account || viewIdentity.current !== view) return;
      if (blockerRef.current.state === "blocked") blockerRef.current.reset();
      if (isConflict(error)) {
        archiveOperation.current = undefined;
        setArchiveError("This collection changed. Reload it before trying again.");
        refreshDetail();
      } else {
        setArchiveError(collectionFailureMessage(error, "The collection could not be changed. Try again."));
      }
    } finally {
      if (accountGeneration.current === account && viewIdentity.current === view) setArchivePending(false);
    }
  }

  async function removeItems(refs: readonly MediaAssetRef[]): Promise<boolean> {
    if (!collection || removePending || collection.lifecycle !== "active" || refs.length < 1 || refs.length > 30) return false;
    const key = JSON.stringify(refs);
    const keys = new Set(refs.map(ref => JSON.stringify(ref)));
    const operation = removeOperation.current?.key === key && removeOperation.current.version === collection.membershipVersion
      ? removeOperation.current
      : { key, version: collection.membershipVersion, requestId: newRequestId() };
    removeOperation.current = operation;
    const account = accountGeneration.current;
    const view = viewIdentity.current;
    const previousItems = detail?.items ?? [];
    setRemovePending(key);
    setRemoveError("");
    try {
      const token = await getIdToken();
      if (accountGeneration.current !== account || viewIdentity.current !== view) return false;
      const result = await setMediaCollectionItems(token, {
        collectionId: collection.id,
        requestId: operation.requestId,
        baseMembershipVersion: collection.membershipVersion,
        present: false,
        refs: [...refs],
      });
      if (accountGeneration.current !== account || viewIdentity.current !== view) return false;
      if (result.collectionId !== collection.id) throw new Error("Collection response identity mismatch");
      removeOperation.current = undefined;
      const changedRefs = confirmedCollectionChangedRefs(result, refs);
      const hiddenCount = typeof result.hiddenChangedCount === "number" && Number.isSafeInteger(result.hiddenChangedCount)
        && result.hiddenChangedCount > 0 ? result.hiddenChangedCount : 0;
      setDetailState(previous => previous.status !== "ready" ? previous : {
        ...previous,
        page: {
          ...previous.page,
          collection: {
            ...previous.page.collection,
            membershipVersion: result.membershipVersion,
            itemCount: previous.page.collection.itemCount === undefined || !result.changed
              ? previous.page.collection.itemCount
              : Math.max(0, previous.page.collection.itemCount - refs.length),
          },
          items: previous.page.items.filter(candidate => !keys.has(JSON.stringify(candidate.ref))),
        },
      });
      if (changedRefs) {
        const changedKeys = new Set(changedRefs.map(mediaCollectionRefKey));
        const removedItems = previousItems.filter(item => changedKeys.has(mediaCollectionRefKey(item.ref)));
        if (removedItems.length === changedRefs.length) {
          const owner = {
            account,
            collectionId: collection.id,
            collectionName: collection.name,
            membershipVersion: result.membershipVersion,
            refs: changedRefs,
            removedItems,
            view,
          };
          let used = false;
          const message = `${itemCountLabel(changedRefs.length)} removed from ${owner.collectionName}.` +
            (hiddenCount ? ` ${itemCountLabel(hiddenCount)} could not be restored with Undo.` : "");
          notice.show(message, {
            action: { label: "Undo", onClick: () => {
              const current = detailStateRef.current;
              if (used || !notice.isCurrent() || accountGeneration.current !== owner.account || viewIdentity.current !== owner.view
                || current.status !== "ready" || current.page.collection.id !== owner.collectionId
                || current.page.collection.membershipVersion !== owner.membershipVersion) return;
              used = true;
              notice.show(`Undoing the removal from ${owner.collectionName}.`);
              void getIdToken().then(token => {
                const latest = detailStateRef.current;
                if (!notice.isCurrent() || accountGeneration.current !== owner.account || viewIdentity.current !== owner.view
                  || latest.status !== "ready" || latest.page.collection.id !== owner.collectionId
                  || latest.page.collection.membershipVersion !== owner.membershipVersion) {
                  throw new Error("Collection context changed before Undo");
                }
                return setMediaCollectionItems(token, {
                  collectionId: owner.collectionId,
                  requestId: newRequestId(),
                  baseMembershipVersion: owner.membershipVersion,
                  present: true,
                  refs: [...owner.refs],
                });
              }).then(reversed => {
                if (!notice.isCurrent() || accountGeneration.current !== owner.account || viewIdentity.current !== owner.view) return;
                if (reversed.collectionId !== owner.collectionId) {
                  throw new Error("Collection response identity mismatch");
                }
                if (!reversed.changed) {
                  refreshDetail();
                  notice.show(`The items changed before Undo. ${owner.collectionName} was reloaded.`, { tone: "error" });
                  return;
                }
                const removedByKey = new Map(owner.removedItems.map(item => [mediaCollectionRefKey(item.ref), item]));
                setDetailState(previous => {
                  if (previous.status !== "ready" || previous.page.collection.id !== owner.collectionId
                    || previous.page.collection.membershipVersion !== owner.membershipVersion) return previous;
                  const currentByKey = new Map(previous.page.items.map(item => [mediaCollectionRefKey(item.ref), item]));
                  const priorOrder = new Set(previousItems.map(item => mediaCollectionRefKey(item.ref)));
                  const restored = previousItems.flatMap(item => {
                    const key = mediaCollectionRefKey(item.ref);
                    const value = currentByKey.get(key) ?? removedByKey.get(key);
                    return value ? [value] : [];
                  });
                  const addedLater = previous.page.items.filter(item => !priorOrder.has(mediaCollectionRefKey(item.ref)));
                  return { ...previous, page: {
                    ...previous.page,
                    collection: {
                      ...previous.page.collection,
                      membershipVersion: reversed.membershipVersion,
                      itemCount: previous.page.collection.itemCount === undefined
                        ? undefined
                        : previous.page.collection.itemCount + owner.refs.length,
                    },
                    items: [...restored, ...addedLater],
                  } };
                });
                notice.show(`${itemCountLabel(owner.refs.length)} restored to ${owner.collectionName}.`);
              }).catch(failure => {
                if (!notice.isCurrent() || accountGeneration.current !== owner.account || viewIdentity.current !== owner.view) return;
                if (failure instanceof HttpError && failure.status === 409) {
                  refreshDetail();
                  notice.show(`${owner.collectionName} changed before Undo. The collection was reloaded.`, { tone: "error" });
                  return;
                }
                notice.show(`The removal from ${owner.collectionName} could not be undone. Reload the collection.`, { tone: "error" });
              });
            } },
          });
        } else if (notice.available) notice.show(`Items were removed from ${collection.name}. Undo is unavailable for this response.`);
      } else if (notice.available) notice.show(result.changed
        ? `Items were removed from ${collection.name}. Undo is unavailable for this response.`
        : `No items were removed from ${collection.name}.`);
      requestAnimationFrame(() => itemsHeadingRef.current?.focus());
      if (blockerRef.current.state === "blocked" && !editDirtyRef.current && !extraExitRef.current && !videoActiveRef.current) blockerRef.current.proceed();
      return true;
    } catch (error) {
      if (accountGeneration.current !== account || viewIdentity.current !== view) return false;
      if (blockerRef.current.state === "blocked") blockerRef.current.reset();
      if (isConflict(error)) {
        removeOperation.current = undefined;
        setRemoveError("Collection items changed. The current collection was reloaded; review your selection and try again.");
        refreshDetail();
      } else {
        setRemoveError(collectionFailureMessage(error, "Collection items could not be removed. Try again."));
      }
      return false;
    } finally {
      if (accountGeneration.current === account && viewIdentity.current === view) setRemovePending("");
    }
  }

  async function togglePin(target: MediaCollectionSummary) {
    if (pinPending) return;
    const pinned = !pins.ids.includes(target.id);
    const account = accountGeneration.current;
    setPinPending(target.id);
    setPinError("");
    try {
      const next = await saveMediaCollectionPin(userId, target.id, pinned);
      if (accountGeneration.current !== account) return;
      setPins(next);
    } catch (error) {
      if (accountGeneration.current === account) {
        setPinError(collectionFailureMessage(error, "Your collection pin could not be saved. Try again."));
      }
    } finally {
      if (accountGeneration.current === account) setPinPending("");
    }
  }

  function refreshDetail() {
    if (!collectionId) return;
    const current = ++generation.current;
    setDetailLoadingMore(false);
    void listMediaCollectionItemsFromSession(collectionId, undefined, current, false);
  }

  async function loadMoreCollections(scope: MediaCollectionScope) {
    if (listState.status !== "ready" || listLoadingScope) return;
    const cursor = listState.cursors[scope];
    if (!cursor) return;
    const current = generation.current;
    const paging = listMoreGeneration.current;
    setListLoadingScope(scope);
    setListMoreError("");
    try {
      const result = await listMediaCollections(await getIdToken(), { scope, lifecycle, cursor, limit: 30 });
      if (generation.current !== current || listMoreGeneration.current !== paging) return;
      setListState(previous => previous.status !== "ready" ? previous : {
        status: "ready",
        records: [...previous.records, ...result.collections],
        cursors: { ...previous.cursors, [scope]: result.nextCursor },
      });
    } catch (error) {
      if (generation.current === current && listMoreGeneration.current === paging) {
        setListMoreError(collectionFailureMessage(error, "More collections could not be loaded. Try again."));
      }
    } finally {
      if (generation.current === current && listMoreGeneration.current === paging) setListLoadingScope("");
    }
  }

  if (collectionId) {
    return <section className="media-collections-library" aria-labelledby="media-collection-title">
      {blocker.state === "blocked" && !mutationPending && !viewerOpen ? <LeaveGuardDialog
        onCancel={() => blocker.reset()}
        onConfirm={() => { if (discardUpload.current) onDiscardExtra?.(); if (discardVideo.current) onDiscardVideo?.(); blocker.proceed(); }} /> : null}
      {blocker.state === "blocked" && mutationPending ? <InlineMessage tone="warning" title="Change in progress">Wait for this change to finish before leaving the collection.</InlineMessage> : null}
      <Button className="media-collection-back" variant="ghost" onClick={() => navigate({
        pathname: mediaCollectionsPath(),
        search: encodeCollectionsMediaLocation(lifecycle, scopeFilter, null).toString(),
      })}>
        <Icon name="arrow-left" /> <span className="button-compact-label">All collections</span>
      </Button>
      {detailState.status === "loading" ? <LoadingIndicator label="Loading collection" />
        : detailState.status === "error" ? <InlineMessage tone="error" title="Collection unavailable">
          <span>{detailState.message}</span><Button onClick={() => setDetailAttempt(value => value + 1)}>Try again</Button>
        </InlineMessage>
          : collection ? <>
            <header className="surface-intro media-collection-detail-heading">
              <div className="media-collection-detail-title"><span className="media-collection-folder-mark" data-color={collection.color ?? "slate"} aria-hidden="true"><Icon name="folder" /></span><div><h2 id="media-collection-title">{collection.name}</h2><p>{collection.scope === "private"
                ? "Only you can see this collection. Each file keeps its existing access."
                : "All active staff can organize this collection. Each file keeps its existing access."}</p></div></div>
              <div className="media-collection-heading-actions">
                <CopyMediaLink key={collection.id} path={mediaPermalink(mediaCollectionsPath(collection.id))} />
                <StatusBadge tone="neutral">{collection.scope === "private" ? "Private" : "All staff"}</StatusBadge>
                <Button variant="ghost" disabled={Boolean(pinPending)} aria-pressed={pins.ids.includes(collection.id)}
                  aria-label={`${pins.ids.includes(collection.id) ? "Unpin" : "Pin"} ${collection.name}`}
                  onClick={() => void togglePin(collection)}><Icon name="pin" />{pins.ids.includes(collection.id) ? "Unpin" : "Pin"}</Button>
              </div>
            </header>
            {pinError ? <InlineMessage tone="error" title="Pin was not saved">{pinError}</InlineMessage> : null}
            <form className="media-collection-details-form" onSubmit={saveDetails}>
              <label>Name<TextInput required maxLength={120} disabled={editPending || collection.lifecycle === "archived"}
                value={editName} onChange={event => { setEditName(event.target.value); editOperation.current = undefined; setEditError(""); }} /></label>
              <label>Description<Textarea rows={3} maxLength={500} disabled={editPending || collection.lifecycle === "archived"}
                value={editDescription} onChange={event => { setEditDescription(event.target.value); editOperation.current = undefined; setEditError(""); }} /></label>
              <CollectionColorField value={editColor} disabled={editPending || collection.lifecycle === "archived"}
                onChange={color => { setEditColor(color); editOperation.current = undefined; setEditError(""); }} />
              {editError ? <InlineMessage tone="error" title="Collection details were not saved">{editError}</InlineMessage> : null}
              {collection.lifecycle === "active" ? <AsyncActionButton type="submit" variant="primary" label="Save collection details"
                pending={editPending} pendingLabel="Saving" disabled={editName.trim() === collection.name && editDescription.trim() === collection.description && editColor === (collection.color ?? "slate")} /> : null}
            </form>
            <section className="media-collection-items" aria-labelledby="media-collection-items-title">
              <div className="media-collection-section-heading"><div><h3 id="media-collection-items-title" ref={itemsHeadingRef} tabIndex={-1}>Items</h3><p>Removing an item from this collection does not delete or change the file.</p></div>
                {collection.itemCount !== undefined ? <StatusBadge tone="neutral">{collection.itemCount} {collection.itemCount === 1 ? "item" : "items"}</StatusBadge> : null}</div>
              {detail.items.length === 0 ? <EmptyState
                title={collection.scope === "private" ? "This collection is empty" : "No accessible items to show"}
                description={collection.scope === "private"
                  ? "Browse a media source, select items, then choose Add to collection."
                  : "This shared collection may contain files your account cannot open. Browse a media source to add files you can access."}
                action={<div className="button-row">{canBrowseImages ? <Button variant="primary" onClick={() => navigate(mediaImagesPath())}>Browse images</Button> : null}<Button variant={canBrowseImages ? undefined : "primary"} onClick={() => navigate(mediaVideosPath())}>Browse videos</Button></div>} /> : null}
              {detail.items.length > 0 || detail.nextCursor ? <MediaCollectionItems
                  collection={collection} items={detail.items} principal={principal} categories={categories}
                  getIdToken={getIdToken} userId={userId} removalPending={Boolean(removePending)}
                  removalError={removeError} onRemoveMany={removeItems}
                  onLoadMore={() => void loadMoreItems()} loadingMore={detailLoadingMore}
                  nextCursor={detail.nextCursor} pages={detailState.status === "ready" ? detailState.pages : 1}
                  onReload={refreshDetail} onViewerRiskChange={setViewerExitRisk}
                  onViewerSavingChange={setViewerSaving}
                  navigationBlocked={blocker.state === "blocked"}
                  onKeepNavigation={() => blocker.reset?.()}
                  onDiscardNavigation={() => {
                    if (discardUpload.current) onDiscardExtra?.();
                    if (discardVideo.current) onDiscardVideo?.();
                    blocker.proceed?.();
                  }}
                  onInternalNavigation={() => { internalNavigation.current = true; }} /> : null}
              {detail.items.length === 0 && !detail.nextCursor && removeError ? <InlineMessage tone="error" title="Collection items were not removed">{removeError}</InlineMessage> : null}
              {detailMoreError ? <InlineMessage tone="error" title="More items were not loaded">{detailMoreError}</InlineMessage> : null}
            </section>
            {archiveError ? <InlineMessage tone="error" title="Collection status did not change">{archiveError}</InlineMessage> : null}
            <section className="media-collection-lifecycle" aria-labelledby="media-collection-status-title">
              <h3 id="media-collection-status-title">Collection status</h3>
              <p>{collection.lifecycle === "active" ? "Archiving hides this collection from active lists. It does not archive or delete any file."
                : "This collection is archived. Restore it before changing details or items."}</p>
              {archiveDecision ? <InlineMessage tone="warning" title={collection.lifecycle === "active" ? "Archive collection?" : "Restore collection?"}>
                <span>{collection.lifecycle === "active" ? "The collection and its references are preserved." : "The collection will return to active lists."}</span>
                <AsyncActionButton label={collection.lifecycle === "active" ? "Archive collection" : "Restore collection"}
                  pending={archivePending} pendingLabel={collection.lifecycle === "active" ? "Archiving" : "Restoring"} onClick={() => void changeLifecycle()} />
                <Button disabled={archivePending} onClick={() => setArchiveDecision(false)}>Cancel</Button>
              </InlineMessage> : <Button onClick={() => setArchiveDecision(true)}>{collection.lifecycle === "active" ? "Archive collection" : "Restore collection"}</Button>}
            </section>
          </> : null}
    </section>;
  }

  const records = listState.status === "ready" ? listState.records.filter(item => !scopeFilter || item.scope === scopeFilter) : [];
  const orderedRecords = [...records].sort((left, right) => {
    const pinOrder = pins.ids.indexOf(left.id) - pins.ids.indexOf(right.id);
    if (pins.ids.includes(left.id) && pins.ids.includes(right.id)) return pinOrder;
    if (pins.ids.includes(left.id)) return -1;
    if (pins.ids.includes(right.id)) return 1;
    return left.name.localeCompare(right.name);
  });
  function applySavedView(view: SavedMediaView) {
    const savedLocation = parseCollectionsMediaLocation(view.query);
    const next = encodeCollectionsMediaLocation(savedLocation.show, savedLocation.scope, null, view.id);
    internalNavigation.current = true;
    setRouteParams(next);
  }
  function removeMissingSavedView(reason?: "deleted") {
    const next = encodeCollectionsMediaLocation(lifecycle, scopeFilter, mediaLocation.selectedRef);
    internalNavigation.current = true;
    setRouteParams(next, { replace: true });
    if (reason === "deleted") return;
    window.setTimeout(() => {
      const controller = currentNotice.current;
      if (controller.isCurrent()) {
        controller.show("This saved view is no longer available. Current filters were kept.", { tone: "error" });
      }
    }, 0);
  }
  const listToolbar: MediaToolbarSurfaceConfiguration = {
    surface: "collections", view: "list", search: null, sort: null, display: null, upload: null,
    moreItems: [], shortcuts: null,
    filter: {
      properties: [
        { id: "status", label: "Status", picker: "options", appliedCount: lifecycle === "archived" ? 1 : 0,
          options: [
            { value: "active", label: "Active", selected: lifecycle === "active" },
            { value: "archived", label: "Archived", selected: lifecycle === "archived" },
          ] },
        { id: "scope", label: "Scope", picker: "options", appliedCount: scopeFilter ? 1 : 0,
          options: [
            { value: "private", label: "Private", selected: scopeFilter === "private" },
            { value: "all_staff", label: "All staff", selected: scopeFilter === "all_staff" },
          ] },
      ],
      chips: [
        ...(lifecycle === "archived" ? [{ key: "status", field: "status", value: "archived", label: "Status: Archived" }] : []),
        ...(scopeFilter ? [{ key: "scope", field: "scope", value: scopeFilter,
          label: `Scope: ${scopeFilter === "private" ? "Private" : "All staff"}`, scopeLabel: "on this page" }] : []),
      ],
      note: "Status loads collections. Scope filters the collections already on this page.",
      onSelect: (property, value) => {
        if (property === "status") writeLocation(value === "archived" ? "archived" : "active", scopeFilter, null);
        if (property === "scope") writeLocation(lifecycle, scopeFilter === value ? null : value as MediaCollectionScope, null);
      },
      onRemove: chip => {
        if (chip.key === "status") writeLocation("active", scopeFilter, null);
        if (chip.key === "scope") writeLocation(lifecycle, null, null);
      },
      onClearAll: clearFilters,
    },
  };
  return <section className="media-collections-library" aria-labelledby="media-collections-title">
    {blocker.state === "blocked" && !mutationPending ? <LeaveGuardDialog
      onCancel={() => blocker.reset()}
      onConfirm={() => { if (discardUpload.current) onDiscardExtra?.(); if (discardVideo.current) onDiscardVideo?.(); blocker.proceed(); }} /> : null}
    {blocker.state === "blocked" && mutationPending ? <InlineMessage tone="warning" title="Change in progress">Wait for this change to finish before leaving the collection.</InlineMessage> : null}
    <header className="surface-intro"><div><h2 id="media-collections-title">Collections</h2>
      <p>Organize media into collections without copying or moving files. Share a collection with staff or keep it private.</p></div>
      <Button className="media-collection-new-button" variant="primary" onClick={() => setCreateOpen(value => !value)}>{createOpen ? "Close new collection" : "New collection"}</Button>
    </header>
    {createOpen ? <form className="media-collection-create" onSubmit={createCollection}>
      <h3>New collection</h3>
      <label>Name<TextInput autoFocus required maxLength={120} value={createName} disabled={createPending}
        onChange={event => { setCreateName(event.target.value); changeCreateIntent(); }} /></label>
      <label>Who can see and organize it?<Select value={createScope} disabled={createPending}
        onChange={event => { setCreateScope(event.target.value as MediaCollectionScope); changeCreateIntent(); }}>
        <option value="private">Only me</option><option value="all_staff">All active staff</option>
      </Select></label>
      <p>{createScope === "private" ? "Only you can see this collection. Each file keeps its existing access."
        : "All active staff can see and organize this collection. Each file still requires its own access."}</p>
      <label>Description <span>(optional)</span><Textarea rows={3} maxLength={500} value={createDescription} disabled={createPending}
        onChange={event => { setCreateDescription(event.target.value); changeCreateIntent(); }} /></label>
      <CollectionColorField value={createColor} disabled={createPending} onChange={color => { setCreateColor(color); changeCreateIntent(); }} />
      {createError ? <InlineMessage tone="error" title="Collection was not created">{createError}</InlineMessage> : null}
      <div className="button-row"><AsyncActionButton type="submit" variant="primary" label="Create collection" pending={createPending} pendingLabel="Creating" disabled={!createName.trim()} />
        <Button disabled={createPending} onClick={() => { setCreateOpen(false); setCreateError(""); createOperation.current = undefined; }}>Cancel</Button></div>
    </form> : null}
    {pinError ? <InlineMessage tone="error" title="Pin was not saved">{pinError}</InlineMessage> : null}
    <MediaToolbar configuration={listToolbar} savedViews={{
      userId,
      surface: "collections",
      query: encodeCollectionsMediaLocation(lifecycle, scopeFilter, null).toString(),
      currentViewId: mediaLocation.view,
      onApply: applySavedView,
      onMissing: removeMissingSavedView,
      onResetFilters: () => writeLocation("active", null, null),
    }} />
    {listMoreError ? <InlineMessage tone="error" title="More collections were not loaded">{listMoreError}</InlineMessage> : null}
    {listState.status === "loading" ? <LoadingIndicator label={`Loading ${lifecycle} collections`} />
      : listState.status === "error" ? <InlineMessage tone="error" title="Collections unavailable"><span>{listState.message}</span>
        <Button onClick={() => setListAttempt(value => value + 1)}>Try again</Button></InlineMessage>
        : orderedRecords.length === 0 && scopeFilter && listState.records.length > 0
          ? <EmptyState title="No collections in this scope"
              action={<Button onClick={() => writeLocation(lifecycle, null, null)}>Clear scope</Button>} />
        : orderedRecords.length === 0 ? <EmptyState title={lifecycle === "active" ? "No active collections" : "No archived collections"}
          description={lifecycle === "active" ? "Create a private collection or one shared with all active staff." : "Archived collections will appear here."}
          action={lifecycle === "active" ? <Button variant="primary" onClick={() => setCreateOpen(true)}>New collection</Button> : undefined} />
          : <><ul className="media-collection-grid">{orderedRecords.map(item => <li key={item.id}>
            <button type="button" className="media-collection-card" data-color={item.color ?? "slate"}
              onClick={() => {
                const params = encodeCollectionsMediaLocation(lifecycle, scopeFilter, null);
                navigate(`${mediaCollectionsPath(item.id)}${params.toString() ? `?${params}` : ""}`);
              }}>
              <span className="media-collection-folder-mark" data-color={item.color ?? "slate"} aria-hidden="true"><Icon name="folder" /></span>
              <span className="media-collection-card-heading"><strong>{item.name}</strong><StatusBadge tone="neutral">{item.scope === "private" ? "Private" : "All staff"}</StatusBadge></span>
              <span className="media-collection-card-description">{item.description || "No description"}</span>
              {item.itemCount !== undefined ? <span>{item.itemCount} {item.itemCount === 1 ? "item" : "items"}</span> : null}
            </button>
            <CollectionPin name={item.name} pinned={pins.ids.includes(item.id)} disabled={Boolean(pinPending)}
              onClick={() => void togglePin(item)} />
          </li>)}</ul>{listState.status === "ready" && (listState.cursors.private || listState.cursors.all_staff) ? <div className="button-row">
            {listState.cursors.private && (!scopeFilter || scopeFilter === "private") ? <Button disabled={Boolean(listLoadingScope)} onClick={() => void loadMoreCollections("private")}>{listLoadingScope === "private" ? "Loading private collections" : "Load more private collections"}</Button> : null}
            {listState.cursors.all_staff && (!scopeFilter || scopeFilter === "all_staff") ? <Button disabled={Boolean(listLoadingScope)} onClick={() => void loadMoreCollections("all_staff")}>{listLoadingScope === "all_staff" ? "Loading shared collections" : "Load more shared collections"}</Button> : null}
          </div> : null}</>}
  </section>;
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { useBeforeUnload, useBlocker, useLocation, useNavigate, useSearchParams } from "react-router";
import { parseMediaWorkspacePath } from "../lib/routes";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { Icon } from "../components/ui/Icon";
import { MediaFavoriteButton } from "../components/MediaFavoriteButton";
import { ActionControl } from "../components/ui/ActionControl";
import {
  Button,
  EmptyState,
  InlineMessage,
  StatusBadge,
} from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import {
  cmsDeleteMedia,
  cmsUpdateMediaMetadata,
  HttpError,
  type DeleteMediaResponse,
  type MediaCategoryDefinition,
  type MediaAssetSummary,
  type UpdateMediaMetadata,
  type UpdateMediaMetadataResponse,
} from "../lib/functions";
import {
  listMediaFavorites,
  setMediaFavorite,
  type MediaFavoritePage,
  type MediaFavoriteRecord,
  type MediaFavoriteRef,
} from "../lib/media-favorites";
import { mediaFavoriteKey } from "../lib/use-media-favorites";
import { favoritesChangeRevisionValue, invalidatePoster, markMediaTabCountsStale, subscribeFavoritesChange } from "../lib/media-session-cache";
import {
  listMediaSources,
  type MediaSourceSummary,
  type SourceMediaAssetSummary,
} from "../lib/source-media";
import { canManageMediaMetadata } from "../lib/access";
import { VideoViewerBody, sharePosterRead } from "./SourceMediaLibrary";
import { useSourceMediaAssetRefresh } from "../lib/use-source-media-asset-refresh";
import { useRegisterExitGuard } from "./ExitGuard";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { readRecentTags, recordRecentTags } from "../lib/recent-media-tags";
import { parseFavoritesMediaLocation, encodeFavoritesMediaLocation, type FavoriteMediaKind } from "../lib/media-query";
import { useMediaDisplay } from "../lib/use-media-display";
import { MediaToolbar, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import { MediaGrid, type MediaGridHandle } from "../components/media/MediaGrid";
import { MediaTile } from "../components/media/MediaTile";
import { MediaRow, MediaRowHeader, mediaRowColumnStyle } from "../components/media/MediaRow";
import { MediaPaging } from "../components/media/MediaPaging";
import { SelectionBar } from "../components/media/SelectionBar";
import { emptySelection, pageSelectionState, setPageSelection, type MediaSelection } from "../lib/media-selection";
import { setMediaFavorites, summarizeMediaFavoritesResult } from "../lib/media-favorites";
import { availableSelectionActions, lockedMenuActions, mediaBarActions, mediaFavoriteSelectionActions,
  mediaFavoriteTileActions, mediaMenuItems, mediaMenuTitle, type MediaTileActionId } from "../lib/media-tile-actions";
import { MediaCollectionPicker } from "../components/MediaCollectionPicker";
import { mediaCollectionsPath } from "../lib/routes";
import { MEDIA_CARD_FIELD_ORDER, listColumns } from "../lib/media-display";
import type { SavedMediaView } from "../lib/saved-media-views";
import { Checkbox } from "../components/ui/Checkbox";
import { MediaFullViewer, type MediaFullViewerItem } from "../components/media/MediaFullViewer";
import { ImageViewerBody, ImageViewerHeaderActions, imageViewerFacts } from "../components/media/ImageViewer";
import { QuickLook, type QuickLookItem } from "../components/media/QuickLook";
import { quickLookImage, quickLookPoster } from "../lib/media-quick-look";
import { selectionAnnouncement } from "../lib/media-filters";
import { ContextMenuArea } from "../components/ui/Menu";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";
import { useClearFilterUndo } from "../lib/use-clear-filter-undo";

type FavoritesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: MediaFavoritePage };

type SourceState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; sources: Map<string, MediaSourceSummary> };

type AvailableFavorite = Extract<MediaFavoriteRecord, { available: true }>;
type AvailableR2Favorite = {
  ref: Extract<MediaFavoriteRef, { backend: "r2" }>;
  createdAt: string;
  available: true;
  asset: MediaAssetSummary;
};
type AvailableS3Favorite = {
  ref: Extract<MediaFavoriteRef, { backend: "s3" }>;
  createdAt: string;
  available: true;
  asset: SourceMediaAssetSummary;
};
type FavoriteItem = { id: string; record: MediaFavoriteRecord };

function isR2Favorite(record: AvailableFavorite): record is AvailableR2Favorite {
  return record.ref.backend === "r2";
}

function isS3Favorite(record: AvailableFavorite): record is AvailableS3Favorite {
  return record.ref.backend === "s3";
}

function favoriteKind(record: MediaFavoriteRecord): FavoriteMediaKind | null {
  if (record.ref.backend === "s3") return "video";
  if (!record.available) return null;
  return record.asset.kind;
}

function availableRecordName(record: MediaFavoriteRecord): string {
  return record.available ? record.asset.name : "Unavailable favorite";
}

function sameFavoriteRef(left: MediaFavoriteRef, right: MediaFavoriteRef): boolean {
  return mediaFavoriteKey(left) === mediaFavoriteKey(right);
}

function favoriteRefLabel(ref: MediaFavoriteRef): string {
  return ref.backend === "r2" ? `R2/${ref.id}` : `S3/${ref.sourceId}/${ref.id}`;
}

export function MediaFavoritesLibrary({
  principal,
  userId,
  getIdToken,
  onExitRiskChange,
  extraExitRisk = false,
  videoTransferActive = false,
  onDiscardExtra,
  onDiscardVideo,
  categoryRegistry,
  renderR2Inspector,
  loadFavorites = listMediaFavorites,
  loadSources = listMediaSources,
}: {
  principal: Principal;
  userId: string;
  getIdToken: () => Promise<string>;
  onExitRiskChange?: (active: boolean) => void;
  /** Unsaved work owned outside this list, such as a routed image upload. */
  extraExitRisk?: boolean;
  /** A routed video transfer is running and would lose its file if this page unmounts it. */
  videoTransferActive?: boolean;
  /** Drop outside work, such as a routed upload, when the person confirms leaving. */
  onDiscardExtra?: () => void;
  onDiscardVideo?: () => void;
  categoryRegistry: {
    status: "loading" | "error" | "ready";
    categories: readonly MediaCategoryDefinition[];
  };
  /** Local gallery fixtures can supply records without a staff session. */
  loadFavorites?: typeof listMediaFavorites;
  loadSources?: typeof listMediaSources;
  renderR2Inspector?: (props: {
    asset: MediaAssetSummary;
    getIdToken: () => Promise<string>;
    categories: readonly MediaCategoryDefinition[];
    canEdit: boolean;
    favoriteControl?: ReactNode;
    deleteMedia: (asset: MediaAssetSummary) => Promise<DeleteMediaResponse>;
    saveMetadata: (asset: MediaAssetSummary, metadata: UpdateMediaMetadata) => Promise<UpdateMediaMetadataResponse>;
    onClose: () => void;
    onDeleted: (asset: MediaAssetSummary) => void;
    onDirtyChange: (dirty: boolean) => void;
    onSavingChange: (saving: boolean) => void;
    onReload: () => void;
    onSaved: (asset: MediaAssetSummary) => void;
    pageTags?: readonly string[];
    recentTags?: readonly string[];
    onTagsSaved?: (tags: readonly string[]) => void;
  }) => ReactNode;
}) {
  const navigate = useNavigate();
  const routeKey = useLocation().key;
  const notice = useSuccessNotice();
  const currentNotice = useRef(notice);
  currentNotice.current = notice;
  const currentRoute = useRef(routeKey);
  currentRoute.current = routeKey;
  const [routeParams, setRouteParams] = useSearchParams();
  const mediaLocation = parseFavoritesMediaLocation(routeParams.toString());
  const routeAssetKey = mediaLocation.selectedRef ? mediaFavoriteKey(mediaLocation.selectedRef) : null;
  const { display, setDisplay, resetDisplay } = useMediaDisplay("favorites");
  const gridRef = useRef<MediaGridHandle>(null);
  const deleteConfirmationId = useId();
  const [viewerOrder, setViewerOrder] = useState<AvailableFavorite[]>([]);
  const [quickLook, setQuickLook] = useState<{ order: AvailableFavorite[]; key: string }>();
  const [quickLookRead, setQuickLookRead] = useState<{ key: string; fileVersion?: string | null; url: string | null }>();
  const [selection, setSelection] = useState<MediaSelection<FavoriteItem>>(emptySelection);
  const [batchSaving, setBatchSaving] = useState(false);
  const [collectionRefs, setCollectionRefs] = useState<MediaFavoriteRef[] | null>(null);
  const internalNavigation = useRef<string>();
  function writeLocation(kind: FavoriteMediaKind | null, ref: MediaFavoriteRef | null, replace = false) {
    const params = encodeFavoritesMediaLocation(kind, ref);
    const next = params.toString() ? `?${params}` : "";
    if (next === `?${routeParams.toString()}` || (!next && !routeParams.toString())) return;
    internalNavigation.current = next;
    setRouteParams(params, { replace });
  }
  const prepareFilterUndo = useClearFilterUndo(routeKey, routeParams.toString(), before => {
    const params = new URLSearchParams(before);
    internalNavigation.current = before ? `?${before}` : "";
    setRouteParams(params, { replace: true });
  });
  function clearFilters() {
    const before = encodeFavoritesMediaLocation(mediaLocation.kind, null).toString();
    const after = encodeFavoritesMediaLocation(null, null).toString();
    if (prepareFilterUndo(before, after)) writeLocation(null, null);
  }
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<(string | undefined)[]>([]);
  const [attempt, setAttempt] = useState(0);
  const favoritesLibraryRevision = useSyncExternalStore(subscribeFavoritesChange, favoritesChangeRevisionValue);
  const seenFavoritesRevision = useRef(favoritesLibraryRevision);
  useEffect(() => {
    if (seenFavoritesRevision.current === favoritesLibraryRevision) return;
    seenFavoritesRevision.current = favoritesLibraryRevision;
    setAttempt(value => value + 1);
  }, [favoritesLibraryRevision]);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [state, setState] = useState<FavoritesState>({ status: "loading" });
  const [sourceState, setSourceState] = useState<SourceState>({ status: "idle" });
  const [selected, setSelected] = useState<AvailableFavorite>();
  const [pending, setPending] = useState(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const [saveError, setSaveError] = useState("");
  const [successNotice, setSuccessNotice] = useState<{ title: string; message: string }>();
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [removeDecision, setRemoveDecision] = useState<MediaFavoriteRecord>();
  const [selectionDecision, setSelectionDecision] = useState<{ next?: AvailableFavorite }>();
  const [recentTagsVersion, setRecentTagsVersion] = useState(0);
  const generation = useRef(0);
  const currentUser = useRef(userId);
  const cursorOwner = useRef(userId);
  currentUser.current = userId;
  const requestCursor = cursorOwner.current === userId ? cursor : undefined;
  const currentCursor = useRef(requestCursor);
  currentCursor.current = requestCursor;

  function restoreVisibleRecords(records: MediaFavoriteRecord[], pageBefore: MediaFavoriteRecord[]) {
    const order = new Map(pageBefore.map((record, index) => [mediaFavoriteKey(record.ref), index]));
    setState(previous => {
      if (previous.status !== "ready") return previous;
      const existing = new Set(previous.result.records.map(record => mediaFavoriteKey(record.ref)));
      const additions = records.filter(record => !existing.has(mediaFavoriteKey(record.ref)));
      return { status: "ready", result: { ...previous.result, records: [...previous.result.records, ...additions]
        .sort((left, right) => (order.get(mediaFavoriteKey(left.ref)) ?? Infinity) - (order.get(mediaFavoriteKey(right.ref)) ?? Infinity)) } };
    });
  }

  useEffect(() => {
    setCursor(undefined);
    setPreviousCursors([]);
    setSelected(undefined);
    setViewerOrder([]);
    setQuickLook(undefined);
    setPending(new Set());
    pendingRef.current = new Set();
    setSaveError("");
    setSuccessNotice(undefined);
    setRemoveDecision(undefined);
    setSelectionDecision(undefined);
    setSelection(emptySelection());
    setCollectionRefs(null);
    setBatchSaving(false);
    cursorOwner.current = userId;
  }, [userId]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setState({ status: "loading" });
    setSaveError("");
    async function load() {
      try {
        const token = await getIdToken();
        if (currentUser.current !== userId || generation.current !== requestGeneration) return;
        const result = await loadFavorites(token, { cursor: requestCursor, limit: 24 });
        if (currentUser.current !== userId || generation.current !== requestGeneration) return;
        setState({ status: "ready", result });
        setViewerOrder(previous => previous.flatMap(record => {
          const refreshed = result.records.find(item => item.available && sameFavoriteRef(item.ref, record.ref));
          return refreshed?.available ? [refreshed] : [];
        }));
        setSelected(previous => {
          if (!previous) return undefined;
          const refreshed = result.records.find(record =>
            record.available && sameFavoriteRef(record.ref, previous.ref));
          return refreshed?.available ? refreshed : previous;
        });
      } catch {
        if (currentUser.current === userId && generation.current === requestGeneration) {
          setState({ status: "error", message: "Favorites could not be loaded." });
        }
      }
    }
    void load();
    return () => { generation.current++; };
  }, [attempt, getIdToken, loadFavorites, requestCursor, userId]);

  const sourceIds = state.status === "ready"
    ? [...new Set(state.result.records.flatMap(record => record.available && record.ref.backend === "s3"
      ? [record.ref.sourceId]
      : []))].sort()
    : [];
  const sourceIdsKey = JSON.stringify(sourceIds);
  useEffect(() => {
    const requestedSourceIds = JSON.parse(sourceIdsKey) as string[];
    if (requestedSourceIds.length === 0) {
      setSourceState({ status: "idle" });
      return;
    }
    let current = true;
    setSourceState({ status: "loading" });
    async function fetchSources() {
      try {
        const result = await loadSources(await getIdToken());
        if (!current || currentUser.current !== userId) return;
        setSourceState({
          status: "ready",
          sources: new Map(result.sources.map(source => [source.id, source])),
        });
      } catch {
        if (current && currentUser.current === userId) {
          setSourceState({ status: "error", message: "Video source permissions could not be loaded." });
        }
      }
    }
    void fetchSources();
    return () => { current = false; };
  }, [getIdToken, loadSources, sourceAttempt, sourceIdsKey, userId]);

  const exitRisk = metadataDirty || metadataSaving || extraExitRisk || videoTransferActive;
  const exitRiskRef = useRef(exitRisk);
  const videoActiveRef = useRef(videoTransferActive);
  exitRiskRef.current = exitRisk;
  videoActiveRef.current = videoTransferActive;
  const hasExitRisk = useCallback(() => exitRiskRef.current || videoActiveRef.current, []);
  useRegisterExitGuard(selected || extraExitRisk || videoTransferActive ? { saving: metadataSaving, hasUnsavedWork: hasExitRisk } : null);
  useEffect(() => { onExitRiskChange?.(exitRisk); }, [exitRisk, onExitRiskChange]);
  useEffect(() => () => onExitRiskChange?.(false), [onExitRiskChange]);
  useBeforeUnload(event => {
    if (!exitRisk) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const ownExitRisk = metadataDirty || metadataSaving;
  const discardUpload = useRef(false);
  const discardVideo = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (internalNavigation.current === nextLocation.search) {
      internalNavigation.current = undefined;
      return false;
    }
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    const leavesWorkspace = kind === "not-found";
    const opensRecycleBin = kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardUpload.current = leavesWorkspace || opensRecycleBin;
    discardVideo.current = leavesWorkspace;
    const moving = currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash;
    if (!moving) return false;
    if (ownExitRisk) return true;
    if (videoTransferActive && discardVideo.current) return true;
    return extraExitRisk && discardUpload.current;
  });
  const navigationProceeding = useRef(false);
  useEffect(() => {
    if (blocker.state === "unblocked") navigationProceeding.current = false;
    if (blocker.state === "blocked" && !ownExitRisk && !metadataSaving
      && !(discardUpload.current && (extraExitRisk || videoTransferActive))
      && !navigationProceeding.current) {
      navigationProceeding.current = true;
      blocker.proceed();
    }
  }, [blocker, ownExitRisk, metadataSaving, extraExitRisk, videoTransferActive]);

  function proceedNavigation() {
    navigationProceeding.current = true;
    blocker.proceed?.();
  }

  function replaceRecord(ref: MediaFavoriteRef, asset: MediaAssetSummary | SourceMediaAssetSummary) {
    setQuickLook(previous => previous ? { ...previous, order: previous.order.map(record => sameFavoriteRef(record.ref, ref)
      ? { ...record, asset } as AvailableFavorite : record) } : previous);
    setViewerOrder(previous => previous.map(record => sameFavoriteRef(record.ref, ref)
      ? { ...record, asset } as AvailableFavorite : record));
    setState(previous => previous.status !== "ready" ? previous : {
      status: "ready",
      result: {
        ...previous.result,
        records: previous.result.records.map(record => sameFavoriteRef(record.ref, ref) && record.available
          ? { ...record, asset } as MediaFavoriteRecord
          : record),
      },
    });
  }

  function markUnavailable(ref: MediaFavoriteRef) {
    setViewerOrder(previous => previous.filter(record => !sameFavoriteRef(record.ref, ref)));
    setState(previous => previous.status !== "ready" ? previous : {
      status: "ready",
      result: {
        ...previous.result,
        records: previous.result.records.map(record => sameFavoriteRef(record.ref, ref)
          ? { ref: record.ref, createdAt: record.createdAt, available: false }
          : record),
      },
    });
    setMetadataDirty(false);
  }

  async function removeFavorite(record: MediaFavoriteRecord) {
    const key = mediaFavoriteKey(record.ref);
    if (pendingRef.current.has(key)) return;
    const requestUser = userId;
    const requestRoute = routeKey;
    const pageBefore = state.status === "ready" ? state.result.records : [];
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    setSaveError("");
    setSuccessNotice(undefined);
    try {
      const token = await getIdToken();
      if (currentUser.current !== requestUser) return;
      const result = await setMediaFavorite(token, record.ref, false);
      if (!sameFavoriteRef(result.ref, record.ref) || result.favorite !== false) {
        throw new Error("Favorite response identity mismatch");
      }
      if (currentUser.current !== requestUser) return;
      setState(previous => previous.status !== "ready" ? previous : {
        status: "ready",
        result: {
          ...previous.result,
          records: previous.result.records.filter(item => !sameFavoriteRef(item.ref, record.ref)),
        },
      });
      setViewerOrder(previous => previous.filter(item => !sameFavoriteRef(item.ref, record.ref)));
      setSelection(previous => ({ ...previous, items: previous.items.filter(item => item.id !== key) }));
      const message = record.available
        ? `${record.asset.name} was removed from your favorites.`
        : "Unavailable favorite was removed. It cannot be restored.";
      if (!notice.available) setSuccessNotice({ title: "Favorite removed", message });
      else if (!result.changed || !record.available) notice.show(message);
      else {
        const removedRecord = record;
        let used = false;
        notice.show(message, { action: { label: "Undo", onClick: () => {
          if (used || !notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute ||
            mediaFavoriteKey(removedRecord.ref) !== key) return;
          used = true;
          notice.show(`Restoring ${removedRecord.asset.name}.`);
          void (async () => {
            try {
              const undoToken = await getIdToken();
              if (!notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute) return;
              const restored = await setMediaFavorite(undoToken, removedRecord.ref, true);
              if (!sameFavoriteRef(restored.ref, removedRecord.ref) || restored.favorite !== true) {
                throw new Error("Favorite response identity mismatch");
              }
              if (!notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute) return;
              if (currentCursor.current === requestCursor) restoreVisibleRecords([removedRecord], pageBefore);
              notice.show(`${removedRecord.asset.name} was restored to your favorites.`);
            } catch (error) {
              if (!notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute) return;
              notice.show(error instanceof HttpError && error.status === 404
                ? `${removedRecord.asset.name} is no longer available and could not be restored.`
                : `${removedRecord.asset.name} could not be restored. Reload the library.`, { tone: "error" });
            }
          })();
        } } });
      }
    } catch {
      if (currentUser.current === requestUser) {
        setSaveError("The favorite could not be removed. Try again.");
      }
    } finally {
      if (currentUser.current === requestUser) {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    }
  }

  function requestRemoveFavorite(record: MediaFavoriteRecord) {
    if (selected && sameFavoriteRef(selected.ref, record.ref)) {
      if (metadataSaving) return;
      if (metadataDirty) {
        setRemoveDecision(record);
        return;
      }
    }
    void removeFavorite(record);
  }

  function requestSelection(next?: AvailableFavorite) {
    if (metadataSaving) return;
    if (selected && metadataDirty && (!next || !sameFavoriteRef(selected.ref, next.ref))) {
      setSelectionDecision({ next });
      return;
    }
    setSelected(next);
    if (next) setViewerOrder((state.status === "ready" ? state.result.records : [])
      .filter((item): item is AvailableFavorite => item.available));
    else setViewerOrder([]);
    writeLocation(mediaLocation.kind, next?.ref ?? null);
  }

  const result = state.status === "ready" ? state.result : undefined;
  const visibleRecords = result?.records.filter(record => !mediaLocation.kind || favoriteKind(record) === mediaLocation.kind) ?? [];
  const visibleItems: FavoriteItem[] = visibleRecords.map(record => ({ id: mediaFavoriteKey(record.ref), record }));
  const visibleAvailable = visibleItems.filter(item => item.record.available);
  const quickLookRecord = quickLook?.order.find(record => mediaFavoriteKey(record.ref) === quickLook.key);
  useSourceMediaAssetRefresh({ asset: quickLookRecord && isS3Favorite(quickLookRecord) ? quickLookRecord.asset : undefined,
    getIdToken, onUpdated: fresh => { if (quickLookRecord && isS3Favorite(quickLookRecord)) replaceRecord(quickLookRecord.ref, fresh); } });
  let quickLookItem: QuickLookItem | undefined;
  if (quickLookRecord) {
    const id = mediaFavoriteKey(quickLookRecord.ref);
    const name = quickLookRecord.asset.name;
    if (isS3Favorite(quickLookRecord)) {
      quickLookItem = { id, name, kind: "video", previewUrl: quickLookRead?.key === id && quickLookRead.fileVersion === quickLookRecord.asset.fileVersion ? quickLookRead.url : null };
    } else {
      const preview = quickLookImage(quickLookRecord.asset);
      quickLookItem = quickLookRecord.asset.kind === "audio" ? { id, name, kind: "audio", audio: quickLookRecord.asset } : preview.kind === "image"
        ? { id, name, kind: "image", previewUrl: preview.url, alt: preview.alt }
        : { id, name, kind: "document", originalUrl: quickLookRecord.asset.url };
    }
  }
  useEffect(() => {
    if (!quickLookRecord || !isS3Favorite(quickLookRecord)) return;
    const key = mediaFavoriteKey(quickLookRecord.ref);
    const poster = quickLookPoster(quickLookRecord.asset);
    setQuickLookRead({ key, fileVersion: quickLookRecord.asset.fileVersion, url: poster.url });
    if (!poster.read) return;
    let active = true;
    const read = sharePosterRead(quickLookRecord.asset, getIdToken);
    void read.promise.then(value => {
      if (active && value && "url" in value) setQuickLookRead({ key, fileVersion: quickLookRecord.asset.fileVersion, url: value.url });
    });
    return () => { active = false; read.release(); };
  }, [getIdToken, quickLookRecord]);
  function openQuickLook(record: AvailableFavorite) {
    setQuickLook({ order: (state.status === "ready" ? state.result.records : [])
      .filter((item): item is AvailableFavorite => item.available), key: mediaFavoriteKey(record.ref) });
  }
  function closeQuickLook(restoreFocus = true) {
    const key = quickLook?.key;
    setQuickLook(undefined);
    if (restoreFocus && key) requestAnimationFrame(() => gridRef.current?.focusItemById(key));
  }
  function stepQuickLook(direction: "previous" | "next") {
    setQuickLook(previous => {
      if (!previous) return previous;
      const index = previous.order.findIndex(item => mediaFavoriteKey(item.ref) === previous.key);
      const next = previous.order[index + (direction === "next" ? 1 : -1)];
      return next ? { ...previous, key: mediaFavoriteKey(next.ref) } : previous;
    });
  }
  const pageState = pageSelectionState(selection.items, visibleItems);
  const offPageCount = selection.items.filter(item => !visibleItems.some(visible => visible.id === item.id)).length;
  useEffect(() => {
    if (!routeAssetKey || !result) {
      if (!routeAssetKey) {
        setSelected(undefined);
        setViewerOrder([]);
      }
      return;
    }
    const matching = result.records.find(record => record.available && mediaFavoriteKey(record.ref) === routeAssetKey);
    setSelected(previous => matching?.available ? matching
      : previous && mediaFavoriteKey(previous.ref) === routeAssetKey ? previous : undefined);
    if (matching?.available) setViewerOrder(previous => previous.some(item => sameFavoriteRef(item.ref, matching.ref))
      ? previous : result.records.filter((item): item is AvailableFavorite => item.available));
  }, [routeAssetKey, result]);
  async function removeSelectedFavorites() {
    if (batchSaving || selection.items.length === 0 || selection.items.length > 100 || metadataDirty || metadataSaving) return;
    const requestUser = userId;
    const requestRoute = routeKey;
    const selectedRecords = selection.items.map(item => item.record);
    const pageBefore = state.status === "ready" ? state.result.records : [];
    const requested = selection.items.map(item => item.record.ref);
    setBatchSaving(true);
    setSaveError("");
    setSuccessNotice(undefined);
    try {
      const token = await getIdToken();
      if (currentUser.current !== requestUser) return;
      const summary = summarizeMediaFavoritesResult(await setMediaFavorites(token, requested, false));
      if (currentUser.current !== requestUser) return;
      // A changed:false success means the ref is already not a favorite, so it leaves the page too.
      const failed = new Set(summary.failedResults.map(item => mediaFavoriteKey(item.ref)));
      const removed = new Set(requested.map(mediaFavoriteKey).filter(key => !failed.has(key)));
      setState(previous => previous.status !== "ready" ? previous : {
        status: "ready", result: { ...previous.result,
          records: previous.result.records.filter(record => !removed.has(mediaFavoriteKey(record.ref))) },
      });
      setSelection(previous => ({ ...previous, items: previous.items.filter(item => !removed.has(item.id)) }));
      setViewerOrder(previous => previous.filter(item => !removed.has(mediaFavoriteKey(item.ref))));
      if (summary.failedResults.length) {
        setSaveError(`These favorites remain selected: ${summary.failedResults
          .map(item => `${favoriteRefLabel(item.ref)}: ${item.error}`).join("; ")}. Try again after checking each error.`);
      }
      if (summary.changedRefs.length) {
        const changedKeys = new Set(summary.changedRefs.map(mediaFavoriteKey));
        const restorable = selectedRecords.filter((record): record is AvailableFavorite =>
          record.available && changedKeys.has(mediaFavoriteKey(record.ref)));
        const restorableKeys = new Set(restorable.map(record => mediaFavoriteKey(record.ref)));
        const visibleBefore = pageBefore.filter(record => restorableKeys.has(mediaFavoriteKey(record.ref)));
        const unavailable = selectedRecords.filter(record => !record.available && changedKeys.has(mediaFavoriteKey(record.ref)));
        const message = `${summary.changedRefs.length} ${summary.changedRefs.length === 1 ? "favorite was" : "favorites were"} removed.` +
          (unavailable.length ? ` ${unavailable.map(record => favoriteRefLabel(record.ref)).join(", ")} cannot be restored.` : "");
        if (!notice.available) setSuccessNotice({ title: "Favorites removed", message });
        else if (!restorable.length) notice.show(message);
        else {
          let used = false;
          notice.show(message, { action: { label: "Undo", onClick: () => {
            if (used || !notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute ||
              restorable.some(record => !restorableKeys.has(mediaFavoriteKey(record.ref)))) return;
            used = true;
            notice.show(`Restoring ${restorable.length} ${restorable.length === 1 ? "favorite" : "favorites"}.`);
            void (async () => {
              try {
                const undoToken = await getIdToken();
                if (!notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute) return;
                const reverse = await setMediaFavorites(undoToken, restorable.map(record => record.ref), true);
                if (!notice.isCurrent() || currentUser.current !== requestUser || currentRoute.current !== requestRoute) return;
                const failures = reverse.results.filter((item): item is Extract<typeof item, { error: string }> => "error" in item);
                const failed = new Set(failures.map(item => mediaFavoriteKey(item.ref)));
                if (currentCursor.current === requestCursor) {
                  restoreVisibleRecords(visibleBefore.filter(record => !failed.has(mediaFavoriteKey(record.ref))), pageBefore);
                }
                if (failures.length) {
                  const names = failures.map(item => restorable.find(record => sameFavoriteRef(record.ref, item.ref))?.asset.name ?? favoriteRefLabel(item.ref));
                  notice.show(`${names.join(", ")} could not be restored. Check access or availability.`, { tone: "error" });
                } else notice.show(`${restorable.length} ${restorable.length === 1 ? "favorite was" : "favorites were"} restored.`);
              } catch {
                if (notice.isCurrent() && currentUser.current === requestUser && currentRoute.current === requestRoute) {
                  notice.show("Favorites could not be restored. Reload the library.", { tone: "error" });
                }
              }
            })();
          } } });
        }
      }
    } catch (error) {
      if (currentUser.current === requestUser) {
        markMediaTabCountsStale();
        setSaveError(error instanceof Error ? error.message : "Favorites could not be removed. Try again.");
      }
    } finally {
      if (currentUser.current === requestUser) setBatchSaving(false);
    }
  }
  const pageImageTags = useMemo(() => result?.records.flatMap((record) =>
    record.available && record.ref.backend === "r2" ? record.asset.tags : []) ?? [], [result]);
  const pageVideoTags = useMemo(() => result?.records.flatMap((record) =>
    record.available && record.ref.backend === "s3" ? record.asset.tags : []) ?? [], [result]);
  const recentImageTags = useMemo(() => readRecentTags("images", userId), [recentTagsVersion, userId]);
  const recentVideoTags = useMemo(() => readRecentTags("video", userId), [recentTagsVersion, userId]);
  const selectedR2 = selected?.ref.backend === "r2" ? selected as AvailableR2Favorite : undefined;
  const selectedS3 = selected?.ref.backend === "s3" ? selected as AvailableS3Favorite : undefined;
  const viewerItems: MediaFullViewerItem[] = viewerOrder.map(record => isS3Favorite(record)
    ? { ref: record.ref, kind: "video", name: record.asset.name }
    : { ref: record.ref, kind: record.asset.kind,
      name: record.asset.name, facts: imageViewerFacts(record.asset),
      actions: <ImageViewerHeaderActions getIdToken={getIdToken} asset={record.asset} favorite={{
        name: record.asset.name, favorite: true,
        pending: pending.has(mediaFavoriteKey(record.ref)), disabled: metadataSaving,
        onToggle: () => requestRemoveFavorite(record),
      }} /> });
  function closeViewer() {
    setSelected(undefined);
    setViewerOrder([]);
    writeLocation(mediaLocation.kind, null);
  }

  const filterKind = mediaLocation.kind;
  const kindLabels: Record<FavoriteMediaKind, string> = { image: "Images", document: "Documents", audio: "Audio", video: "Videos" };
  function applySavedView(view: SavedMediaView) {
    const savedLocation = parseFavoritesMediaLocation(view.query);
    const params = encodeFavoritesMediaLocation(savedLocation.kind, null, view.id);
    const next = params.toString() ? `?${params}` : "";
    internalNavigation.current = next;
    setRouteParams(params);
    setCursor(undefined);
    setPreviousCursors([]);
    setSelection(emptySelection());
    setQuickLook(undefined);
    if (view.display && !("pageSize" in view.display)) setDisplay(view.display);
  }
  function removeMissingSavedView(reason?: "deleted") {
    const params = encodeFavoritesMediaLocation(mediaLocation.kind, mediaLocation.selectedRef);
    const next = params.toString() ? `?${params}` : "";
    internalNavigation.current = next;
    setRouteParams(params, { replace: true });
    if (reason === "deleted") return;
    window.setTimeout(() => {
      const controller = currentNotice.current;
      if (controller.isCurrent()) {
        controller.show("This saved view is no longer available. Current filters were kept.", { tone: "error" });
      }
    }, 0);
  }
  function resetSavedViewFilters() {
    setCursor(undefined);
    setPreviousCursors([]);
    setSelection(emptySelection());
    setQuickLook(undefined);
    writeLocation(null, null);
  }
  const toolbar: MediaToolbarSurfaceConfiguration = {
    surface: "favorites",
    search: null,
    filter: {
      properties: [{ id: "kind", label: "Type", picker: "options", appliedCount: filterKind ? 1 : 0,
        options: (["image", "document", "audio", "video"] as const).map(value => ({ value, label: kindLabels[value], selected: filterKind === value })) }],
      chips: filterKind ? [{ key: "kind", field: "kind", value: filterKind, label: `Type: ${kindLabels[filterKind]}`, scopeLabel: "on this page" }] : [],
      note: "Type filters favorites on this page. Other pages may have more of this type.",
      onSelect: (_property, value) => writeLocation(filterKind === value ? null : value as FavoriteMediaKind, null),
      onRemove: () => writeLocation(null, null),
      onClearAll: clearFilters,
    },
    sort: null,
    display: {
      rows: [
        { kind: "segmented", id: "layout", label: "Layout", value: display.layout,
          options: [{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }],
          onChange: value => setDisplay({ ...display, layout: value as typeof display.layout }) },
        { kind: "segmented", id: "thumbnail", label: "Thumbnails", value: display.thumbnail,
          options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }],
          onChange: value => setDisplay({ ...display, thumbnail: value as typeof display.thumbnail }) },
        { kind: "select", id: "density", label: "Density", value: display.density,
          options: [{ value: "app", label: "Use app setting", appSetting: true }, { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" }, { value: "loose", label: "Loose" }],
          onChange: value => setDisplay({ ...display, density: value as typeof display.density }) },
        { kind: "fields", id: "fields", label: "Show on cards and in list columns",
          options: MEDIA_CARD_FIELD_ORDER.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1),
            selected: value === "updated" && display.layout === "list" ? true : display.fields[value],
            ...(value === "updated" && display.layout === "list" ? { disabled: true, note: "Always shown in list" } : {}) })),
          onChange: value => { const field = value as keyof typeof display.fields;
            if (field === "updated" && display.layout === "list") return;
            setDisplay({ ...display, fields: { ...display.fields, [field]: !display.fields[field] } }); } },
      ],
      onReset: resetDisplay,
    },
    upload: null,
    moreItems: [{ key: "select-page", label: "Select this page", icon: "check-square",
      onSelect: () => setSelection(previous => setPageSelection(previous, visibleItems, true, { cap: { max: 100, message: "Select no more than 100 favorites." } })) }],
    shortcuts: null,
  };
  const selectionActions = mediaFavoriteSelectionActions({ count: selection.items.length,
    allAvailable: selection.items.every(item => item.record.available) });
  const [hadSelection, setHadSelection] = useState(false);
  if (selection.items.length > 0 && !hadSelection) setHadSelection(true);
  const selectionStatus = selectionAnnouncement(selection.items.length, hadSelection ? 1 : 0)
    + (offPageCount ? `, ${offPageCount} from other pages or filters` : "")
    + (selection.items.length === 100 ? ". Limit of 100 reached" : "");

  function clearSelection() {
    setSelection(emptySelection());
    requestAnimationFrame(() => {
      if (!gridRef.current?.focusLastCard()) document.getElementById("favorite-media-title")?.focus();
    });
  }

  function onSelectionAction(id: string) {
    if (id === "favorite-remove") { void removeSelectedFavorites(); return; }
    if (id === "collect") {
      const available = selection.items.filter(item => item.record.available);
      if (available.length > 0 && available.length <= 30 && available.length === selection.items.length) {
        setCollectionRefs(available.map(item => item.record.ref));
      }
    }
    if (id === "clear-selection") clearSelection();
  }

  function renderFavorite(item: FavoriteItem, context: { selected: boolean; selectionMode: boolean; tabbable: boolean;
    onSelectChange: (checked: boolean, modifiers: { shiftKey: boolean }) => void }) {
    const record = item.record;
    const pendingRemoval = pending.has(item.id) || batchSaving;
    const multiple = context.selected && selection.items.length > 1;
    const actionsDisabled = pendingRemoval || metadataSaving;
    const tileActions = mediaFavoriteTileActions({ available: record.available, selected: context.selected,
      video: record.ref.backend === "s3" });
    function favoriteAction(id: MediaTileActionId) {
      if (id === "favorite" || id === "favorite-remove") requestRemoveFavorite(record);
      else if (id === "select") context.onSelectChange(!context.selected, { shiftKey: false });
      else if (record.available) {
        if (id === "open" || id === "open-full-size") requestSelection(record);
        else if (id === "quick-look") openQuickLook(record);
        else if (id === "collect") setCollectionRefs([record.ref]);
      }
    }
    const selectedActions = availableSelectionActions(selectionActions,
      batchSaving || metadataDirty || metadataSaving, false);
    const selectionMenu = multiple ? {
      count: selection.items.length, actions: selectedActions, onAction: onSelectionAction,
    } : undefined;
    function withMenu(children: ReactElement) {
      return <ContextMenuArea
        items={mediaMenuItems(multiple ? selectedActions : lockedMenuActions(tileActions, actionsDisabled),
          multiple ? onSelectionAction : favoriteAction)}
        label={mediaMenuTitle(multiple ? selection.items.length : 1, availableRecordName(record))}
        returnFocusSelector="[data-media-open]">{children}</ContextMenuArea>;
    }
    if (!record.available && display.layout === "list") return <div className="media-row favorite-media-unavailable-row"
      role="row" aria-selected={context.selected} data-selected={context.selected || undefined}
      data-unavailable="true" style={mediaRowColumnStyle(display.fields)}>
      {withMenu(<div className="media-row-track">
        <span className="media-row-mark-cell" role="gridcell"><Checkbox size="compact" className="media-row-mark" checked={context.selected} hideLabel
          label="Select unavailable favorite" disabled={batchSaving} tabIndex={context.tabbable ? undefined : -1}
          onChange={event => context.onSelectChange(event.currentTarget.checked, { shiftKey: false })} /></span>
        <span className="media-row-thumb" role="gridcell"><Icon name={record.ref.backend === "s3" ? "video" : "file"} /></span>
        <span className="media-row-main" role="gridcell"><button className="media-row-open" type="button"
          data-media-open="" tabIndex={context.tabbable ? 0 : -1}
          onClick={() => context.onSelectChange(!context.selected, { shiftKey: false })}>Unavailable favorite</button>
          <span className="media-row-sub">This saved {record.ref.backend === "s3" ? "video" : "media item"} is unavailable.</span>
        </span>
        {listColumns(display.fields).filter(column => column !== "name").map(column => <span key={column}
          className={`media-row-cell ${["type", "category", "dimensions", "tags"].includes(column) ? "media-row-cell-wide" : ""}`}
          data-column={column} role="gridcell"><span aria-hidden="true">—</span><span className="sr-only">None</span></span>)}
        <span className="media-row-actions" role="gridcell"><ActionControl action="media-favorite"
          size="compact" presentation="icons" className="media-row-action media-row-unavailable-favorite"
          contextLabel="Unavailable favorite" label={pendingRemoval ? "Saving favorite" : "Remove from favorites"}
          aria-pressed="true" aria-busy={pendingRemoval || undefined} aria-disabled={pendingRemoval || undefined}
          tabIndex={context.tabbable ? undefined : -1}
          onClick={() => { if (!pendingRemoval) requestRemoveFavorite(record); }} /></span>
      </div>)}
    </div>;
    if (!record.available) return withMenu(<div className="favorite-media-unavailable media-tile" data-unavailable="true"
      data-selected={context.selected || undefined}>
      <button type="button" data-media-open="" tabIndex={context.tabbable ? 0 : -1}
        aria-label="Select unavailable favorite" onClick={() => context.onSelectChange(!context.selected, { shiftKey: false })}>
        <Icon name={record.ref.backend === "s3" ? "video" : "file"} />
        <strong>Unavailable favorite</strong>
      </button>
      <p>This saved {record.ref.backend === "s3" ? "video" : "media item"} is no longer available to this account.</p>
      <Checkbox checked={context.selected} hideLabel label="Select unavailable favorite" disabled={batchSaving}
        tabIndex={context.tabbable ? undefined : -1}
        onChange={event => context.onSelectChange(event.currentTarget.checked, { shiftKey: false })} />
      <MediaFavoriteButton name="Unavailable favorite" favorite pending={pendingRemoval}
        tabIndex={context.tabbable ? undefined : -1} onToggle={() => requestRemoveFavorite(record)} />
    </div>);
    const shared = {
      favorite: true, favoritePending: pendingRemoval, selected: context.selected, selectionMode: context.selectionMode,
      opened: selected ? sameFavoriteRef(selected.ref, record.ref) : false, canDelete: false,
      onOpen: () => requestSelection(record), onSelectChange: context.onSelectChange,
      onAction: favoriteAction,
      actionOverride: tileActions,
      actionsDisabled, selectionMenu, tabbable: context.tabbable,
    };
    if (record.ref.backend === "s3") {
      const asset = record.asset as SourceMediaAssetSummary;
      const thumbnail = <span className="favorite-media-video-preview" aria-hidden="true"><Icon name="video" /></span>;
      const fields = { type: display.fields.type, size: display.fields.size, duration: false, rights: false,
        updated: display.fields.updated, tags: display.fields.tags, uploader: false };
      return display.layout === "list"
        ? <MediaRow {...shared} wrapCells={withMenu} surface="video" asset={asset} fields={fields} mixedFields={display.fields} thumbnail={thumbnail} />
        : withMenu(<MediaTile {...shared} surface="video" asset={asset} fields={fields} thumbnail={thumbnail} />);
    }
    const asset = record.asset as MediaAssetSummary;
    const categoryLabel = (id: string) => categoryRegistry.categories.find(category => category.id === id)?.label ?? id;
    return display.layout === "list"
      ? <MediaRow {...shared} wrapCells={withMenu} surface="images" asset={asset} fields={display.fields} categoryLabel={categoryLabel} />
      : withMenu(<MediaTile {...shared} surface="images" asset={asset} fields={display.fields} categoryLabel={categoryLabel}
          getAudioToken={getIdToken} />);
  }

  return <section className="favorite-media-library" aria-labelledby="favorite-media-title"
    data-density={display.density === "app" ? undefined : display.density} data-thumbnail={display.thumbnail}>
    <header className="surface-intro">
      <div>
        <h2 id="favorite-media-title" tabIndex={-1}>Favorites</h2>
        <p>Keep your favorite images, documents, audio and videos together. Favorites stay private to this CMS account.</p>
      </div>
      {result ? <StatusBadge tone="neutral">{result.records.length} on this page</StatusBadge> : null}
    </header>

    {successNotice ? <InlineMessage tone="success" title={successNotice.title}>{successNotice.message}</InlineMessage> : null}
    {saveError ? <InlineMessage tone="error" title="Favorite was not removed">{saveError}</InlineMessage> : null}
    {sourceState.status === "error" ? <InlineMessage tone="error" title="Video actions need attention">
      <span>{sourceState.message} Videos can still be opened with read-only actions.</span>
      <Button onClick={() => setSourceAttempt(value => value + 1)}>Try again</Button>
    </InlineMessage> : null}
    {categoryRegistry.status === "error" ? <InlineMessage tone="error" title="Media categories could not be loaded">
      Category labels use their saved ids until the registry is available.
    </InlineMessage> : null}
    <MediaToolbar configuration={toolbar} savedViews={{
      userId,
      surface: "favorites",
      query: encodeFavoritesMediaLocation(mediaLocation.kind, null).toString(),
      currentViewId: mediaLocation.view,
      display,
      onApply: applySavedView,
      onMissing: removeMissingSavedView,
      onResetFilters: resetSavedViewFilters,
    }} />
    <p className="sr-only media-selection-status" role="status">{selectionStatus}</p>

    {state.status === "loading" ? <LoadingIndicator label="Loading favorites" />
      : state.status === "error" ? <InlineMessage tone="error" title="Favorites unavailable">
        <span>{state.message}</span><Button onClick={() => setAttempt(value => value + 1)}>Try again</Button>
      </InlineMessage>
        : result && result.records.length === 0 && previousCursors.length === 0 && !result.hasMore ? <EmptyState title="No favorites yet" description="Add a favorite from an image, document, audio or video card." />
          : result ? <>
            {visibleItems.length === 0 ? <EmptyState title="No favorites on this page" description="Change Type or go to another favorites page. This filter checks the current page only." />
              : <MediaGrid label="Favorite media" className="favorite-media-grid" items={visibleItems} layout={display.layout}
                selection={selection} onSelectionChange={setSelection} handleRef={gridRef}
                rules={{ cap: { max: 100, message: "Select no more than 100 favorites." } }}
                header={display.layout === "list" ? <MediaRowHeader fields={display.fields} pageSelection={{ state: pageState,
                  onChange: checked => setSelection(previous => setPageSelection(previous, visibleItems, checked, { cap: { max: 100, message: "Select no more than 100 favorites." } })) }} /> : undefined}
                renderItem={renderFavorite}
                onOpen={item => item.record.available ? requestSelection(item.record) : setSelection(previous => setPageSelection(previous, [item], !previous.items.some(selectedItem => selectedItem.id === item.id)))}
                onQuickLook={item => { if (item.record.available) openQuickLook(item.record); }}
                onEscape={() => setSelection(emptySelection())} />}
            {previousCursors.length > 0 || result.hasMore ? <MediaPaging mode="cursor" label="Favorite pages"
              page={previousCursors.length + 1} isLastPage={!result.hasMore}
              onFirst={() => { setCursor(undefined); setPreviousCursors([]); }}
              onPrevious={() => { setCursor(previousCursors.at(-1)); setPreviousCursors(values => values.slice(0, -1)); }}
              onNext={() => { setPreviousCursors(values => [...values, cursor]); setCursor(result.nextCursor ?? undefined); }} /> : null}
          </> : null}

    <SelectionBar label="Favorite selection" count={selection.items.length} offPage={offPageCount} cap={100}
      info="Selection carries across favorite pages and Type filters." pageState={pageState}
      onPageChange={checked => setSelection(previous => setPageSelection(previous, visibleItems, checked, { cap: { max: 100, message: "Select no more than 100 favorites." } }))}
      actions={mediaBarActions(selectionActions)} actionsDisabled={batchSaving || metadataDirty || metadataSaving}
      onAction={onSelectionAction} onClear={clearSelection} error={selection.error} />

    {collectionRefs ? <MediaCollectionPicker open userId={userId} refs={collectionRefs} getIdToken={getIdToken}
      onClose={() => setCollectionRefs(null)} onAdded={collection => { setCollectionRefs(null);
        if (!notice.available) setSuccessNotice({ title: "Added to collection", message: `Added to ${collection.name}.` }); }}
      onOpenCollections={() => navigate(mediaCollectionsPath())} /> : null}

    {quickLook && quickLookRecord && quickLookItem ? <QuickLook getIdToken={getIdToken} item={quickLookItem}
      position={quickLook.order.findIndex(item => mediaFavoriteKey(item.ref) === quickLook.key) + 1}
      count={quickLook.order.length} onStep={stepQuickLook} onClose={closeQuickLook}
      onPreviewError={() => {
        if (isS3Favorite(quickLookRecord)) invalidatePoster(quickLookRecord.ref.sourceId, quickLookRecord.ref.id, quickLookRecord.asset.fileVersion);
      }} /> : null}

    {selected ? <MediaFullViewer activeRef={selected.ref} items={viewerItems}
      onClose={closeViewer}
      onStep={item => {
        const next = viewerOrder.find(record => sameFavoriteRef(record.ref, item.ref));
        if (next) { setSelected(next); writeLocation(mediaLocation.kind, next.ref); }
      }}
      onDirtyChange={setMetadataDirty} onSavingChange={setMetadataSaving}
      navigationBlocked={blocker.state === "blocked"}
      focusItem={ref => gridRef.current?.focusItemById(mediaFavoriteKey(ref)) ?? false}
      focusFallback={() => document.getElementById("favorite-media-title")?.focus()}
      renderBody={context => {
        if (context.item.ref.backend === "r2") {
          const record = viewerOrder.find(item => sameFavoriteRef(item.ref, context.item.ref));
          if (!record || !isR2Favorite(record)) return null;
          if (renderR2Inspector) return <>{context.dirtyPrompt}{renderR2Inspector({
            asset: record.asset, categories: categoryRegistry.categories,
            getIdToken,
            canEdit: canManageMediaMetadata(principal, record.asset.category) && !pending.has(mediaFavoriteKey(record.ref)),
            favoriteControl: <MediaFavoriteButton name={record.asset.name} favorite
              pending={pending.has(mediaFavoriteKey(record.ref))} onToggle={() => requestRemoveFavorite(record)} />,
            deleteMedia: async asset => cmsDeleteMedia(await getIdToken(), asset),
            saveMetadata: async (asset, metadata) => cmsUpdateMediaMetadata(await getIdToken(), asset, metadata),
            onClose: closeViewer, onDeleted: () => markUnavailable(record.ref),
            onDirtyChange: context.onDirtyChange, onSavingChange: context.onSavingChange,
            onReload: () => setAttempt(value => value + 1),
            onTagsSaved: tags => { recordRecentTags("images", tags, userId); setRecentTagsVersion(version => version + 1); },
            pageTags: pageImageTags, recentTags: recentImageTags,
            onSaved: asset => {
              replaceRecord(record.ref, asset);
              setSelected(previous => previous && sameFavoriteRef(previous.ref, record.ref) ? { ...record, asset } : previous);
            },
          })}</>;
          return <ImageViewerBody getIdToken={getIdToken} key={mediaFavoriteKey(record.ref)} asset={record.asset}
            comparisonAssets={viewerOrder.filter(isR2Favorite).map(item => item.asset)}
            categories={categoryRegistry.categories}
            canEdit={canManageMediaMetadata(principal, record.asset.category) && !pending.has(mediaFavoriteKey(record.ref))}
            deleteMedia={async asset => cmsDeleteMedia(await getIdToken(), asset)}
            saveMetadata={async (asset, metadata) => cmsUpdateMediaMetadata(await getIdToken(), asset, metadata)}
            closePrompt={context.dirtyPrompt} footerTarget={context.footerActionsTarget}
            onDeleted={() => markUnavailable(record.ref)}
            onDirtyChange={context.onDirtyChange} onSavingChange={context.onSavingChange}
            onReload={() => setAttempt(value => value + 1)}
            onTagsSaved={tags => { recordRecentTags("images", tags, userId); setRecentTagsVersion(version => version + 1); }}
            pageTags={pageImageTags} recentTags={recentImageTags}
            onSaved={asset => {
              replaceRecord(record.ref, asset);
              setSelected(previous => previous && sameFavoriteRef(previous.ref, record.ref) ? { ...record, asset } : previous);
            }} />;
        }
        const record = viewerOrder.find(item => sameFavoriteRef(item.ref, context.item.ref));
        if (!record || !isS3Favorite(record)) return null;
        const source = sourceState.status === "ready" ? sourceState.sources.get(record.ref.sourceId) : undefined;
        return <VideoViewerBody key={mediaFavoriteKey(record.ref)} principal={principal} asset={record.asset}
          getIdToken={getIdToken} canEditMetadata={source?.canEditMetadata === true && !pending.has(mediaFavoriteKey(record.ref))}
          canReplace={source?.canReplace === true}
          canExportOrientation={source?.canExportOrientation === true}
          canRequestProduction={source?.canRequestProduction === true && !pending.has(mediaFavoriteKey(record.ref))}
          canDelete={source?.canDelete === true} deleteConfirmationId={deleteConfirmationId}
          headerTarget={context.headerActionsTarget} factsTarget={context.headerFactsTarget}
          closePrompt={context.dirtyPrompt} footerTarget={context.footerActionsTarget} pageTags={pageVideoTags} recentTags={recentVideoTags}
          navigationBlocked={blocker.state === "blocked" && !metadataSaving}
          onKeepNavigation={() => blocker.reset?.()}
          onDiscardNavigation={() => {
            proceedNavigation(); setMetadataDirty(false);
            if (discardUpload.current) onDiscardExtra?.();
            if (discardVideo.current) onDiscardVideo?.();
          }}
          favorite={{ name: record.asset.name, favorite: true,
            pending: pending.has(mediaFavoriteKey(record.ref)), disabled: metadataSaving,
            onToggle: () => requestRemoveFavorite(record) }}
          onDeleted={() => markUnavailable(record.ref)}
          onDirtyChange={context.onDirtyChange} onSavingChange={context.onSavingChange}
          onBusyChange={context.onBusyChange}
          onTagsSaved={tags => { recordRecentTags("video", tags, userId); setRecentTagsVersion(version => version + 1); }}
          onUpdated={asset => {
            replaceRecord(record.ref, asset);
            setSelected(previous => previous && sameFavoriteRef(previous.ref, record.ref) ? { ...record, asset } : previous);
          }} />;
      }} /> : null}

    {!selectedR2 && !selectedS3 && blocker.state === "blocked" && (extraExitRisk || videoTransferActive) ? <LeaveGuardDialog
      onConfirm={() => {
        proceedNavigation();
        if (discardUpload.current) onDiscardExtra?.();
        if (discardVideo.current) onDiscardVideo?.();
      }}
      onCancel={() => blocker.reset()} /> : null}
    {selectedR2 && blocker.state === "blocked" && !metadataSaving ? <LeaveGuardDialog
      onConfirm={() => {
        proceedNavigation();
        setMetadataDirty(false);
        if (discardUpload.current) onDiscardExtra?.();
        if (discardVideo.current) onDiscardVideo?.();
      }}
      onCancel={() => blocker.reset()} /> : null}
    {removeDecision ? <LeaveGuardDialog
      onConfirm={() => {
        const record = removeDecision;
        setRemoveDecision(undefined);
        closeViewer();
        setMetadataDirty(false);
        requestAnimationFrame(() => {
          if (!gridRef.current?.focusItemById(mediaFavoriteKey(record.ref))) {
            document.getElementById("favorite-media-title")?.focus();
          }
        });
        void removeFavorite(record);
      }}
      onCancel={() => setRemoveDecision(undefined)} /> : null}
    {selectionDecision && !metadataSaving ? <LeaveGuardDialog
      onConfirm={() => {
        const next = selectionDecision.next;
        setSelectionDecision(undefined);
        setMetadataDirty(false);
        setSelected(next);
      }}
      onCancel={() => setSelectionDecision(undefined)} /> : null}
  </section>;
}

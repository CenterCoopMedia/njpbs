import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { AsyncActionButton, Button, EmptyState, InlineMessage, StatusBadge } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { Icon } from "./ui/Icon";
import {
  confirmedCollectionChangedRefs,
  listMediaCollections,
  setMediaCollectionItems,
  type MediaCollectionPage,
  type MediaCollectionSummary,
} from "../lib/media-collections";
import type { MediaAssetRef } from "../lib/media-identity";
import { HttpError } from "../lib/functions";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";

const MAX_COLLECTION_BATCH = 30;

function requestId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

type ScopeState = {
  records: MediaCollectionSummary[];
  cursor: string | null;
  loading: boolean;
  error: string;
};

const emptyScope = (): ScopeState => ({ records: [], cursor: null, loading: true, error: "" });

function collectionFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return "Your collection access changed. Reload the page, then sign in again if needed.";
  }
  return error instanceof Error ? error.message : fallback;
}

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

export function MediaCollectionPicker({
  open,
  userId,
  refs,
  getIdToken,
  onClose,
  onAdded,
  onOpenCollections,
}: {
  open: boolean;
  userId: string;
  refs: readonly MediaAssetRef[];
  getIdToken: () => Promise<string>;
  onClose: () => void;
  onAdded: (collection: MediaCollectionSummary) => void;
  onOpenCollections: () => void;
}) {
  const notice = useSuccessNotice();
  const [privateState, setPrivateState] = useState<ScopeState>(emptyScope);
  const [sharedState, setSharedState] = useState<ScopeState>(emptyScope);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const operation = useRef<{ collectionId: string; baseMembershipVersion: number; requestId: string }>();
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setError("");
    setSelectedId("");
    operation.current = undefined;
    loadAllScopes();
    return () => { generation.current++; };
    // Opening under another account starts a new isolated request generation.
  }, [open, userId]);

  function loadAllScopes() {
    const current = ++generation.current;
    setPrivateState(emptyScope());
    setSharedState(emptyScope());
    void Promise.all([
      loadScope("private", undefined, current, setPrivateState),
      loadScope("all_staff", undefined, current, setSharedState),
    ]);
  }

  async function loadScope(
    scope: "private" | "all_staff",
    cursor: string | undefined,
    current: number,
    setState: Dispatch<SetStateAction<ScopeState>>,
  ) {
    try {
      const result = await listMediaCollections(await getIdToken(), {
        scope,
        lifecycle: "active",
        cursor,
        limit: 30,
      });
      if (generation.current !== current) return;
      setState(previous => ({
        records: cursor ? [...previous.records, ...result.collections] : result.collections,
        cursor: result.nextCursor,
        loading: false,
        error: "",
      }));
    } catch (error) {
      if (generation.current === current) {
        setState(previous => ({
          ...previous,
          loading: false,
          error: collectionFailureMessage(error, "Collections could not be loaded."),
        }));
      }
    }
  }

  function loadMore(
    scope: "private" | "all_staff",
    state: ScopeState,
    setState: Dispatch<SetStateAction<ScopeState>>,
  ) {
    if (!state.cursor || state.loading) return;
    setState(previous => ({ ...previous, loading: true, error: "" }));
    void loadScope(scope, state.cursor, generation.current, setState);
  }

  const collections = [...privateState.records, ...sharedState.records];
  const selected = collections.find(collection => collection.id === selectedId);

  async function add() {
    if (!selected || pending || refs.length < 1 || refs.length > MAX_COLLECTION_BATCH) return;
    const current = generation.current;
    const next = operation.current?.collectionId === selected.id &&
      operation.current.baseMembershipVersion === selected.membershipVersion
      ? operation.current
      : {
          collectionId: selected.id,
          baseMembershipVersion: selected.membershipVersion,
          requestId: requestId(),
        };
    operation.current = next;
    setPending(true);
    setError("");
    try {
      const token = await getIdToken();
      if (generation.current !== current) return;
      const result = await setMediaCollectionItems(token, {
        ...next,
        present: true,
        refs: [...refs],
      });
      if (generation.current !== current) return;
      if (result.collectionId !== selected.id) throw new Error("Collection response identity mismatch");
      operation.current = undefined;
      const changedRefs = confirmedCollectionChangedRefs(result, refs);
      if (changedRefs) {
        const owner = {
          collectionId: selected.id,
          collectionName: selected.name,
          membershipVersion: result.membershipVersion,
          refs: changedRefs,
        };
        let used = false;
        notice.show(`${itemCountLabel(changedRefs.length)} added to ${owner.collectionName}.`, {
          action: { label: "Undo", onClick: () => {
            if (used || !notice.isCurrent()) return;
            used = true;
            notice.show(`Undoing the add to ${owner.collectionName}.`);
            void getIdToken().then(token => {
              if (!notice.isCurrent()) return null;
              return setMediaCollectionItems(token, {
                collectionId: owner.collectionId,
                requestId: requestId(),
                baseMembershipVersion: owner.membershipVersion,
                present: false,
                refs: [...owner.refs],
              });
            }).then(reversed => {
              if (!reversed || !notice.isCurrent()) return;
              if (reversed.collectionId !== owner.collectionId || !reversed.changed) {
                throw new Error("Collection response identity mismatch");
              }
              notice.show(`${itemCountLabel(owner.refs.length)} removed from ${owner.collectionName}.`);
            }).catch(failure => {
              if (!notice.isCurrent()) return;
              notice.show(failure instanceof HttpError && failure.status === 409
                ? `${owner.collectionName} changed before Undo. Undo was not applied. Open the collection to review its items.`
                : `The add to ${owner.collectionName} could not be undone. Open the collection to review its items.`,
              { tone: "error" });
            });
          } },
        });
      } else if (notice.available) notice.show(result.changed
        ? `Items were added to ${selected.name}.`
        : `${selected.name} already has these items.`);
      onAdded({ ...selected, membershipVersion: result.membershipVersion });
    } catch (failure) {
      if (generation.current === current) {
        if (failure instanceof HttpError && failure.status === 409) {
          operation.current = undefined;
          setPending(false);
          setSelectedId("");
          setError("This collection changed. Current collections were reloaded; select it and try again.");
          loadAllScopes();
          return;
        }
        setError(collectionFailureMessage(failure, "The selected items could not be added. Try again."));
      }
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  const loading = privateState.loading || sharedState.loading;
  const hasLoadError = Boolean(privateState.error || sharedState.error);
  const noCollections = !loading && !hasLoadError && collections.length === 0;
  return <ComponentEditorDialog
    open={open}
    onClose={onClose}
    closeDisabled={pending}
    closeLabel="Cancel"
    title="Add selected to collection"
    description={`${refs.length} ${refs.length === 1 ? "item" : "items"} selected. Files keep their access permissions.`}
    footerNote={null}
    footerActions={<AsyncActionButton
      variant="primary"
      label="Add to collection"
      pending={pending}
      pendingLabel="Adding"
      disabled={!selected || refs.length < 1 || refs.length > MAX_COLLECTION_BATCH}
      onClick={() => void add()}
    />}
  >
    {refs.length > MAX_COLLECTION_BATCH ? <InlineMessage tone="warning" title="Too many items selected">
      Select no more than {MAX_COLLECTION_BATCH} items for one collection change.
    </InlineMessage> : null}
    {error ? <InlineMessage tone="error" title="Items were not added">{error}</InlineMessage> : null}
    {privateState.error || sharedState.error ? <InlineMessage tone="error" title="Some collections are unavailable">
      <span>{privateState.error || sharedState.error}</span>
      <Button onClick={loadAllScopes}>Try again</Button>
    </InlineMessage> : null}
    {loading ? <LoadingIndicator label="Loading collections" /> : null}
    {noCollections ? <EmptyState
      title="No active collections"
      description="Create a private collection or one that all active staff can organize."
      action={<Button variant="primary" onClick={onOpenCollections}>Create collection</Button>}
    /> : <div className="media-collection-picker" aria-busy={loading || undefined}>
      {([
        ["Private collections", privateState, "private", setPrivateState],
        ["Shared with all staff", sharedState, "all_staff", setSharedState],
      ] as const).map(([label, state, scope, setState]) => state.records.length > 0 || state.cursor ? <section key={scope}>
        <h3>{label}</h3>
        <ul>
          {state.records.map(collection => <li key={collection.id}>
            <label>
              <input className="sr-only" type="radio" name="media-collection" value={collection.id}
                checked={selectedId === collection.id}
                disabled={pending}
                onChange={() => { setSelectedId(collection.id); operation.current = undefined; setError(""); }} />
              <span className="media-collection-picker-copy"><strong>{collection.name}</strong>{collection.description ? <span>{collection.description}</span> : null}</span>
              <span className={`media-collection-picker-check${selectedId === collection.id ? " is-selected" : ""}`} aria-hidden="true">
                {selectedId === collection.id ? <Icon name="check" /> : null}
              </span>
              <StatusBadge tone="neutral">{collection.scope === "private" ? "Private" : "All staff"}</StatusBadge>
            </label>
          </li>)}
        </ul>
        {state.cursor ? <Button disabled={state.loading} onClick={() => loadMore(scope, state, setState)}>
          {state.loading ? "Loading" : "Load more"}
        </Button> : null}
      </section> : null)}
    </div>}
  </ComponentEditorDialog>;
}

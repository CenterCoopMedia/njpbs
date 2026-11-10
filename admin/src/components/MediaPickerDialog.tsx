import { useOverlayOwner } from "./ComponentEditorDialog";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { AssetImage } from "./ui/AssetImage";
import { mediaImageSources } from "../lib/media-image";
import { mediaCategoryDescription, mediaCategoryLabel } from "../lib/use-media-categories";
import { mediaOriginLabel } from "../lib/media-origin";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  HttpError,
  type ListMediaResponse,
  type MediaListQuery,
  type MediaAssetSummary,
  type MediaCategoryDefinition,
} from "../lib/functions";
import { ActionControl } from "./ui/ActionControl";
import {
  MediaUploadForm,
  partialUploadReceipt,
  type MediaUploadBatchReceipt,
  type MediaUploadBatchReuse,
  type MediaUploader,
} from "./MediaUploadForm";
import { Button, EmptyState, InlineMessage } from "./ui/Primitives";
import { LoadingIndicator, Spinner } from "./ui/LoadingIndicator";
import { LeaveGuardDialog } from "../routes/LeaveGuardDialog";
import { MediaFavoriteButton } from "./MediaFavoriteButton";
import { useMediaFavorites } from "../lib/use-media-favorites";
import type { MediaFavoriteRef } from "../lib/media-favorites";
import { useOptionalShell } from "../routes/ShellContext";
import { reusedUploadMessage } from "../lib/media-upload";
import { MediaPaging } from "./media/MediaPaging";

export type MediaPickerLoader = (
  query: MediaListQuery,
  options?: { signal?: AbortSignal },
) => Promise<ListMediaResponse>;

type PickerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      result: ListMediaResponse;
      updating?: boolean;
      error?: string;
    };

interface PickerQuery {
  q: string;
  page: number;
  cursor?: string;
}

// Match the library's bounded-scan pause so ordinary typing produces one request.
const MEDIA_SEARCH_IDLE_MS = 300;
const noFavoriteSession = async () => null;

function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]",
    ),
  ).filter((element) => !element.hasAttribute("disabled"));
}

export function MediaPickerDialog({
  destination,
  kind = "image",
  currentAssetId,
  loadMedia,
  uploadMedia,
  defaultUploadCategory,
  canUploadCategory,
  categories = [],
  onDirtyChange,
  onClose,
  onSelect,
}: {
  destination?: string;
  kind?: "image" | "document";
  currentAssetId: string;
  loadMedia: MediaPickerLoader;
  uploadMedia?: MediaUploader;
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  categories?: readonly MediaCategoryDefinition[];
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  onSelect: (asset: MediaAssetSummary) => void;
}) {
  const pdf = kind === "document";
  const noun = pdf ? "PDF" : "image";
  const plural = pdf ? "PDFs" : "images";
  const pagingLabel = pdf ? "PDF pages" : "Image pages";
  const shell = useOptionalShell();
  const overlayOwner = useOverlayOwner();
  const workspace = useEditorWorkspaceView();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const retargetFocus = useRef<HTMLElement | null>(null);
  const uploadActionRef = useRef<HTMLButtonElement>(null);
  const uploadReceiptRef = useRef<HTMLDivElement>(null);
  const receiptFocusPendingRef = useRef(false);
  const pendingUploadedAssetRef = useRef<MediaAssetSummary | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState<PickerQuery>({ q: "", page: 1 });
  const [previousCursors, setPreviousCursors] = useState<(string | undefined)[]>([]);
  const [cursorRestartRequired, setCursorRestartRequired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PickerState>({ status: "loading" });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [activeUploadedAssets, setActiveUploadedAssets] = useState<
    MediaAssetSummary[]
  >([]);
  const [activeReused, setActiveReused] = useState<MediaUploadBatchReuse[]>([]);
  const [uploadReceipt, setUploadReceipt] =
    useState<MediaUploadBatchReceipt | null>(null);
  const [focusUploadAction, setFocusUploadAction] = useState(false);
  const [closeIntent, setCloseIntent] = useState<"upload" | "dialog" | null>(
    null,
  );
  const uploadCategories =
    categories?.filter(
      (category) =>
        category.active &&
        category.canUpload &&
        canUploadCategory?.(category.id) === true,
    ) ?? [];
  const uploadCategory =
    uploadCategories.find((category) => category.id === defaultUploadCategory)
      ?.id ?? uploadCategories[0]?.id;
  const mayUpload = Boolean(uploadMedia && uploadCategory && canUploadCategory);
  const loadError =
    state.status === "error"
      ? state.message
      : state.status === "ready"
        ? state.error
        : undefined;
  const favoriteRefs: MediaFavoriteRef[] = state.status === "ready"
    ? state.result.records.map(asset => ({ backend: "r2", id: asset.id }))
    : [];
  const favorites = useMediaFavorites(
    shell?.user.uid ?? "",
    favoriteRefs,
    shell?.getIdToken ?? noFavoriteSession,
  );

  useEffect(() => workspace?.kind ? workspace.retainPane("details") : undefined, [workspace?.kind, workspace?.retainPane]);
  useLayoutEffect(() => {
    // The native pane closes/reopens after its children retarget. Restore the
    // same active control after that top-layer change, without remounting it.
    const restore = retargetFocus.current;
    const frame = requestAnimationFrame(() => {
      if (restore?.isConnected && dialogRef.current?.contains(restore)) restore.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      retargetFocus.current = dialogRef.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    };
  }, [overlayOwner]);

  useEffect(() => {
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    searchRef.current?.focus();
    return () => triggerRef.current?.focus?.();
  }, []);

  useEffect(() => {
    const q = searchDraft.trim();
    if (q === query.q) return;
    const timer = globalThis.setTimeout(() => {
      setPreviousCursors([]);
      setCursorRestartRequired(false);
      setQuery({ q, page: 1 });
    }, MEDIA_SEARCH_IDLE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [query.q, searchDraft]);

  useEffect(() => {
    let current = true;
    // A page turn or a new search keeps the current grid on screen, marked busy, until the
    // next result lands. Blanking it to a loading line on every turn made the picker flash
    // and lose the person's place; the two list surfaces already keep their rows this way.
    setState((previous) =>
      previous.status === "ready"
        ? { ...previous, updating: true, error: undefined }
        : { status: "loading" },
    );
    void loadMedia({
      q: query.q,
      categories: [],
      kinds: [kind],
      sort: "updatedAt",
      direction: "desc",
      page: query.page,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    })
      .then((result) => {
        if (!current) return;
        setCursorRestartRequired(false);
        setState({ status: "ready", result });
        const uploaded = pendingUploadedAssetRef.current;
        if (uploaded) {
          pendingUploadedAssetRef.current = null;
          onSelectRef.current(uploaded);
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        setCursorRestartRequired(Boolean(query.cursor) && error instanceof HttpError &&
          (error.status === 409 || error.status === 410 || error.status === 503));
        const message =
          error instanceof Error
            ? error.message
            : "Cannot load the media library.";
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, updating: false, error: message }
            : { status: "error", message },
        );
      });
    return () => {
      current = false;
    };
  }, [attempt, loadMedia, query, kind]);

  useEffect(() => {
    if (!uploadOpen && focusUploadAction) {
      uploadActionRef.current?.focus();
      setFocusUploadAction(false);
    }
  }, [focusUploadAction, uploadOpen]);

  useEffect(() => {
    if (
      uploadOpen ||
      !uploadReceipt ||
      !receiptFocusPendingRef.current
    ) {
      return;
    }
    receiptFocusPendingRef.current = false;
    uploadReceiptRef.current?.focus();
  }, [uploadOpen, uploadReceipt]);

  useEffect(() => {
    onDirtyChange?.(uploadDirty);
  }, [onDirtyChange, uploadDirty]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    if (!uploadDirty) return;
    const preventDirtyUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventDirtyUnload);
    return () => window.removeEventListener("beforeunload", preventDirtyUnload);
  }, [uploadDirty]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // React submit events also bubble through the picker portal to its record form.
    event.stopPropagation();
    const q = searchDraft.trim();
    if (query.q === q && query.page === 1 && !query.cursor) return;
    setPreviousCursors([]);
    setCursorRestartRequired(false);
    setQuery({ q, page: 1 });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The nested leave guard owns its keyboard interaction. In particular, its Escape-to-cancel
    // event bubbles through this picker before React commits closeIntent=null; handling that same
    // event here would immediately reopen the guard.
    if (closeIntent) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (uploadOpen && uploadDirty) setCloseIntent("dialog");
      else onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = focusableWithin(dialogRef.current);
    if (focusables.length === 0) return;
    const tabbables = focusables.filter((element) => element.tabIndex >= 0);
    if (tabbables.length === 0) return;
    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const activeIndex = focusables.indexOf(
      document.activeElement as HTMLElement,
    );
    const lastIndex = focusables.indexOf(last);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeIndex >= lastIndex) {
      event.preventDefault();
      first.focus();
    }
  }

  function loadPage(page: number) {
    setState((current) => current.status === "ready"
      ? { ...current, updating: true, error: undefined }
      : current);
    setQuery((current) => ({ ...current, page }));
  }

  function firstCursorPage() {
    setState((current) => current.status === "ready"
      ? { ...current, updating: true, error: undefined }
      : current);
    setPreviousCursors([]);
    setCursorRestartRequired(false);
    setQuery((current) => ({ q: current.q, page: 1 }));
  }

  function previousCursorPage() {
    const cursor = previousCursors.at(-1);
    setState((current) => current.status === "ready"
      ? { ...current, updating: true, error: undefined }
      : current);
    setPreviousCursors((current) => current.slice(0, -1));
    setCursorRestartRequired(false);
    setQuery((current) => ({ q: current.q, page: Math.max(1, current.page - 1), ...(cursor ? { cursor } : {}) }));
  }

  function nextCursorPage(nextCursor: string) {
    setState((current) => current.status === "ready"
      ? { ...current, updating: true, error: undefined }
      : current);
    setPreviousCursors((current) => [...current, query.cursor]);
    setCursorRestartRequired(false);
    setQuery((current) => ({ q: current.q, page: current.page + 1, cursor: nextCursor }));
  }

  function recordUploadedAsset(
    asset: MediaAssetSummary,
    reuse?: MediaUploadBatchReuse,
  ) {
    setActiveUploadedAssets((current) =>
      current.some((candidate) => candidate.id === asset.id)
        ? current
        : [...current, asset],
    );
    if (reuse) setActiveReused((current) => [...current, reuse]);
  }

  function refreshLibraryAfterUpload() {
    setSearchDraft("");
    setPreviousCursors([]);
    setCursorRestartRequired(false);
    setQuery({ q: "", page: 1 });
    setState({ status: "loading" });
  }

  function finishUploadBatch(receipt: MediaUploadBatchReceipt) {
    // A reused file shows the receipt, so its warning is seen before it is used.
    const showReceipt =
      receipt.succeeded.length > 1 ||
      receipt.failed.length > 0 ||
      (receipt.reused?.length ?? 0) > 0;
    pendingUploadedAssetRef.current =
      receipt.succeeded.length === 1 && !showReceipt
        ? receipt.succeeded[0]
        : null;
    receiptFocusPendingRef.current = showReceipt;
    setUploadReceipt(showReceipt ? receipt : null);
    setActiveUploadedAssets([]);
    setActiveReused([]);
    setUploadDirty(false);
    setUploadOpen(false);
    refreshLibraryAfterUpload();
  }

  function useCommittedUpload() {
    const uploaded = pendingUploadedAssetRef.current;
    if (!uploaded) return;
    pendingUploadedAssetRef.current = null;
    onSelectRef.current(uploaded);
  }

  function closeUploadFlow() {
    const hasCommittedUploads = activeUploadedAssets.length > 0;
    if (hasCommittedUploads) {
      receiptFocusPendingRef.current = true;
      setUploadReceipt(partialUploadReceipt(activeUploadedAssets, activeReused));
      setFocusUploadAction(false);
      refreshLibraryAfterUpload();
    } else {
      setFocusUploadAction(true);
    }
    setActiveUploadedAssets([]);
    setActiveReused([]);
    setUploadDirty(false);
    setUploadOpen(false);
  }

  return <RetainedEditorHost target={overlayOwner ?? document.body} overlayOwner={overlayOwner} associateForm={false}>
    <div
      className="media-picker-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={dialogRef}
        className="media-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-mode={uploadOpen ? "upload" : "browse"}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="media-picker-heading">
          <div>
            <h2 id={titleId}>Choose {pdf ? "a PDF" : "an image"}</h2>
            <p id={descriptionId}>
              {destination ? <>For {destination}. </> : null}
              Select one {noun} to insert. You can upload several {plural} here,
              but this field uses only the one you choose.
            </p>
          </div>
          <div className="media-picker-heading-actions">
            {mayUpload && !uploadOpen ? (
              <Button
                ref={uploadActionRef}
                variant="primary"
                onClick={() => setUploadOpen(true)}
              >
                Upload {noun}
              </Button>
            ) : null}
            <ActionControl
              action="close"
              variant="ghost"
              onClick={() => {
                if (uploadOpen && uploadDirty) setCloseIntent("dialog");
                else onClose();
              }}
            />
          </div>
        </div>

        {uploadOpen &&
        uploadMedia &&
        uploadCategory &&
        canUploadCategory &&
        categories ? (
          <div className="media-picker-upload">
            <MediaUploadForm
              defaultCategory={uploadCategory}
              categories={categories}
              canUploadCategory={canUploadCategory}
              imagesOnly={!pdf}
              uploadScope={pdf ? "document" : "image"}
              onBatchComplete={finishUploadBatch}
              onCancel={() => {
                if (uploadDirty) setCloseIntent("upload");
                else closeUploadFlow();
              }}
              onDirtyChange={setUploadDirty}
              onUploaded={recordUploadedAsset}
              uploadMedia={uploadMedia}
            />
            {uploadDirty ? (
              <p className="sr-only" role="status">
                Upload details have unsaved changes.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {uploadReceipt ? (
              <div
                ref={uploadReceiptRef}
                role="region"
                aria-label="Upload batch receipt"
                tabIndex={-1}
              >
                <InlineMessage
                  tone={
                    uploadReceipt.succeeded.length > 0 ? "success" : "error"
                  }
                  title={
                    uploadReceipt.failed.length > 0
                      ? `${pdf ? "PDF" : "Image"} batch finished with failures`
                      : `${pdf ? "PDFs" : "Images"} uploaded`
                  }
                >
                  <p>Choose one uploaded {noun} to insert in this field.</p>
                  {uploadReceipt.succeeded.length > 0 ? (
                    <ul className="media-upload-receipt-list">
                      {uploadReceipt.succeeded.map((asset) => (
                        <li key={asset.id}>
                          <span>{asset.name}</span>
                          <Button
                            variant="ghost"
                            aria-label={`Use ${asset.name}`}
                            disabled={pdf && asset.mimeType !== "application/pdf"}
                        onClick={() => onSelect(asset)}
                          >
                            Use this {noun}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {uploadReceipt.failed.length > 0 ? (
                    <ul className="media-upload-receipt-list">
                      {uploadReceipt.failed.map((failure, index) => (
                        <li key={`${failure.fileName}-${index}`}>
                          <strong>{failure.fileName}</strong>: {failure.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </InlineMessage>
                {uploadReceipt.reused?.length ? (
                  <InlineMessage tone="warning" title={`Existing ${plural} were used`}>
                    <ul className="media-upload-receipt-list">
                      {uploadReceipt.reused.map((reuse, index) => (
                        <li key={`${reuse.fileName}-${index}`}>
                          {reusedUploadMessage(reuse.fileName, reuse.asset.name)}
                        </li>
                      ))}
                    </ul>
                  </InlineMessage>
                ) : null}
              </div>
            ) : null}
            <form
              className="media-picker-search"
              role="search"
              onSubmit={submitSearch}
            >
              <label htmlFor={`${titleId}-search`}>Search {plural}</label>
              <div>
                <input
                  ref={searchRef}
                  className="field-control"
                  id={`${titleId}-search`}
                  type="search"
                  maxLength={200}
                  value={searchDraft}
                  placeholder="Name, tag, or credit"
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                <Button variant="primary" type="submit">
                  Search
                </Button>
              </div>
            </form>

            {loadError ? (
              <InlineMessage tone="error" title={`Cannot load ${plural}`}>
                <span>
                  {pendingUploadedAssetRef.current
                    ? `${pendingUploadedAssetRef.current.name} was uploaded, but the ${noun} list did not refresh. ${loadError}`
                    : loadError}
                </span>
                <Button
                  onClick={cursorRestartRequired
                    ? firstCursorPage
                    : () => setAttempt((value) => value + 1)}
                >
                  {cursorRestartRequired ? "Return to first page" : "Try again"}
                </Button>
                {pendingUploadedAssetRef.current ? (
                  <Button variant="ghost" onClick={useCommittedUpload}>
                    Use uploaded {noun}
                  </Button>
                ) : null}
              </InlineMessage>
            ) : null}

            {favorites.loadError || favorites.saveError ? (
              <InlineMessage tone="error" title="Favorites need attention">
                <span>{favorites.loadError || favorites.saveError}</span>
                {favorites.loadError ? (
                  <Button disabled={favorites.retryDisabled} onClick={favorites.retry}>
                    Try again
                  </Button>
                ) : null}
              </InlineMessage>
            ) : null}

            {state.status === "loading" ? (
              <div className="media-picker-status">
                <LoadingIndicator
                  label={`Loading ${plural}`}
                  stages={[
                    `Asking the CMS for ${plural}`,
                    `Waiting for matching ${plural}`,
                  ]}
                />
              </div>
            ) : state.status === "error" ||
              (state.result.records.length === 0 && loadError) ? null
            : state.result.records.length === 0 &&
              !(state.result.paging === "cursor" &&
                (state.result.nextCursor || state.result.page > 1 || (state.result.total ?? 0) > 0)) ? (
              <EmptyState
                title={`No ${plural} found`}
                description="Change the search and try again."
              />
            ) : (
              <div
                className="media-picker-results"
                aria-busy={state.updating || undefined}
                data-updating={state.updating ? "true" : undefined}
              >
                <div className="media-picker-count" role="status">
                  {state.updating ? (
                    <span className="loading-indicator loading-indicator-inline">
                      <Spinner size="xs" />
                      <span className="loading-indicator-copy">
                        <span className="loading-indicator-label">
                          {state.result.total === null
                            ? `Updating ${state.result.records.length} ${state.result.records.length === 1 ? noun : plural} on this page`
                            : `Updating ${plural}`}
                        </span>
                      </span>
                    </span>
                  ) : state.result.records.length === 0 ? (
                    state.result.paging === "cursor" && state.result.nextCursor
                      ? "No matches on this page. Continue to search more items."
                      : "No matches on this page. Return to a previous page."
                  ) : state.result.total === null ? (
                    `${state.result.records.length} ${state.result.records.length === 1 ? noun : plural} on this page`
                  ) : (
                    `${state.result.total} ${state.result.total === 1 ? noun : plural}`
                  )}
                </div>
                {state.result.records.length === 0 ? (
                  <EmptyState
                    title={state.result.paging === "cursor" && state.result.nextCursor
                      ? "Search continues"
                      : "No matches on this page"}
                    description={state.result.paging === "cursor" && state.result.nextCursor
                      ? "Choose Next to check more items."
                      : "Return to a previous page."}
                  />
                ) : <>
                  <ul className="media-picker-grid" aria-label={`Available ${plural}`}>
                    {state.result.records.map((asset) => (
                    <li className="media-picker-card-item" key={asset.id}>
                      <button
                        type="button"
                        className="media-picker-card"
                        aria-pressed={asset.id === currentAssetId}
                        disabled={pdf && asset.mimeType !== "application/pdf"}
                        onClick={() => onSelect(asset)}
                      >
                        <span className="media-picker-thumb">
                          {pdf ? <span aria-hidden="true">PDF</span> : <AssetImage
                            {...mediaImageSources(asset, 480)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            fallback={
                              <span className="media-picker-thumb-fallback">
                                Preview unavailable
                              </span>
                            }
                          />}
                        </span>
                        <span className="media-picker-copy">
                          <strong>{asset.name}</strong>
                          <span>Category: {mediaCategoryLabel(categories, asset.category)}</span>
                          <span className="media-picker-origin">Origin: {mediaOriginLabel(asset.source)}</span>
                          <small className="media-picker-category-description">{mediaCategoryDescription(categories, asset.category)}</small>
                          {asset.width && asset.height ? (
                            <span className="media-picker-dimensions">
                              {asset.width} × {asset.height}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <MediaFavoriteButton
                        className="media-picker-favorite"
                        name={asset.name}
                        favorite={favorites.value({ backend: "r2", id: asset.id })}
                        pending={favorites.pending({ backend: "r2", id: asset.id })}
                        onToggle={() => void favorites.toggle({ backend: "r2", id: asset.id })}
                      />
                    </li>
                    ))}
                  </ul>
                </>}
                {state.result.paging === "cursor" ? (
                  state.result.page > 1 || state.result.nextCursor ? (
                    <MediaPaging mode="cursor" label={pagingLabel} page={state.result.page}
                      isLastPage={!state.result.nextCursor} loading={state.updating}
                      onFirst={firstCursorPage} onPrevious={previousCursorPage}
                      onNext={() => state.result.paging === "cursor" && state.result.nextCursor
                        ? nextCursorPage(state.result.nextCursor) : undefined} />
                  ) : null
                ) : state.result.pageCount > 1 ? (
                  <MediaPaging mode="numbered" label={pagingLabel} page={state.result.page}
                    pageCount={state.result.pageCount} loading={state.updating}
                    onPage={loadPage} />
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
      {closeIntent ? (
        <LeaveGuardDialog
          onCancel={() => setCloseIntent(null)}
          onConfirm={() => {
            const intent = closeIntent;
            setCloseIntent(null);
            if (intent === "upload") closeUploadFlow();
            else onClose();
          }}
        />
      ) : null}
    </div>
  </RetainedEditorHost>;
}

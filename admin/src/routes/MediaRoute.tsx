import { mediaPermalink, parseMediaPermalink, unavailableMediaMessage } from "../lib/media-permalink";
import { MediaMeaningResults } from "../components/MediaMeaningResults";
import { can, hasCapability } from "../../../packages/content-core/src/rbac";
import { clearFilterChips, filterChips, selectionAnnouncement } from "../lib/media-filters";
import { useMediaDisplay } from "../lib/use-media-display";
import { MediaToolbar, type MediaToolbarHandle } from "../components/media/MediaToolbar";
import type { MediaDisplayPreferences } from "../lib/media-display";
import type { SavedMediaView } from "../lib/saved-media-views";
import { MediaResultBar } from "../components/media/MediaResultBar";
import { MediaContextMenu } from "../components/media/MediaContextMenu";
import { MediaGrid, restoreMediaFocus, type MediaGridHandle, type MediaGridItemContext } from "../components/media/MediaGrid";
import { MediaRow, MediaRowHeader } from "../components/media/MediaRow";
import { MediaTile } from "../components/media/MediaTile";
import { SelectionBar } from "../components/media/SelectionBar";
import { DropOverlay } from "../components/media/DropOverlay";
import { UploadSheet } from "../components/media/UploadSheet";
import { UploadTray, type UploadTrayRow } from "../components/media/UploadTray";
import {
  emptySelection,
  offPageCount,
  pageSelectionState,
  removeSelected,
  setPageSelection,
  toggleSelection,
  type MediaSelection,
} from "../lib/media-selection";
import { availableSelectionActions, mediaBarActions, mediaSelectionActions, type MediaTileActionId } from "../lib/media-tile-actions";
import { cachedMediaList, cacheMediaList, favoritesChangeRevisionValue, invalidateMediaLists, markMediaTabCountsStale, mediaListRevision, mediaTabCounts, publishFavoritesChange, setMediaCachePrincipal, setMediaImagesCount, setMediaSourceCount, subscribeFavoritesChange, subscribeMediaTabCounts } from "../lib/media-session-cache";
import { withMediaTabCounts } from "../lib/media-tab-counts";
import { mediaShortcutBlocked } from "../lib/media-search";
import { routedBatchNotice, UNSUPPORTED_UPLOAD_MESSAGE } from "../lib/upload-destination";
import { clearRejectedUploads, currentLibraryEpoch, finishLibraryUpload, finishVideoUpload, registerLibraryUpload, routeChosenFiles, subscribeUploadRouter, uploadRouterSnapshot } from "../lib/upload-router";
import { MediaTabs } from "../components/media/MediaTabs";
import { WorkspaceUploadButton } from "../components/media/WorkspaceUploadButton";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";
import { useFavoriteUndo } from "../lib/use-favorite-undo";
import { useClearFilterUndo } from "../lib/use-clear-filter-undo";
import { currentMediaTabId, mediaTabs } from "../lib/media-tabs";

// Secondary workspaces and infrequent actions share one deferred boundary so
// the Images library does not download them on entry.
const MediaRecycleBin = lazy(async () => ({
  default: (await import("../components/MediaRecycleBin")).MediaRecycleBin,
}));
const MediaReplaceButton = lazy(async () => ({
  default: (await import("../components/media/MediaReplaceButton")).MediaReplaceButton,
}));
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Navigate,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useAuth } from "../context/AuthContext";
import {
  canManageMediaMetadata,
  canUploadMedia,
  canUseMediaLibrary,
  canUseAudioLibrary,
  canAccessMediaWorkspace,
  canReviewUgcSubmissions,
} from "../lib/access";
import {
  cmsDeleteMedia,
  cmsListMedia,
  cmsListMediaCorpus,
  cmsUpdateMediaMetadata,
  HttpError,
  type ListMediaResponse,
  type MediaCorpusRequest,
  type MediaCorpusResponse,
  type DeleteMediaResponse,
  type MediaListQuery,
  type MediaCategoryDefinition,
  type MediaAssetSummary,
  type UploadMediaMetadata,
  type UpdateMediaMetadata,
  type UpdateMediaMetadataResponse,
} from "../lib/functions";
import {
  DEFAULT_MEDIA_QUERY,
  encodeMediaLocation,
  parseMediaLocation,
  type MediaLocationState,
} from "../lib/media-query";
import {
  Button,
  EmptyState,
  InlineMessage,
} from "../components/ui/Primitives";
import { LoadingIndicator, Spinner } from "../components/ui/LoadingIndicator";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import { RequireCapability } from "./RequireCapability";
import { useShell } from "./ShellContext";
import {
  MediaUploadForm,
  partialUploadReceipt,
  type MediaUploadBatchReceipt,
  type MediaUploadBatchReuse,
  type MediaUploadQueueProjection,
  type MediaUploader,
  type MediaUploadInitialState,
} from "../components/MediaUploadForm";
import {
  authorizedMediaUploadCategory,
  reusedUploadMessage,
  uploadMediaReusingDuplicates,
} from "../lib/media-upload";
import {
  mediaCategoryLabel,
  useMediaCategories,
} from "../lib/use-media-categories";
import "./MediaRoute.css";
import { VideoUploadPanel } from "../components/VideoUploadPanel";
import { listMediaSources, uploadableSharedVideoSource, type MediaSourceSummary } from "../lib/source-media";
import { MediaFavoriteButton } from "../components/MediaFavoriteButton";
import { MediaCollectionPicker } from "../components/MediaCollectionPicker";
import { useMediaFavorites } from "../lib/use-media-favorites";
import { mediaFavoriteWriteEpoch, setMediaFavorites, type MediaFavoriteRef } from "../lib/media-favorites";
import type { MediaAssetRef } from "../lib/media-identity";
import { mediaImageSources } from "../lib/media-image";
import { MediaInspector, type MediaInspectorSaveReceipt } from "../components/media/MediaInspector";
import { ImageViewer } from "../components/media/ImageViewer";
import { MediaBulkInspector } from "../components/media/MediaBulkInspector";
import { QuickLook } from "../components/media/QuickLook";
import { quickLookImage } from "../lib/media-quick-look";
import { SourceMediaBulkEditor } from "../components/SourceMediaBulkEditor";
import { MAX_BULK_IMAGES, type BulkMetadataDraft, type BulkResult, type ImageBulkPatch } from "../lib/source-media-bulk";
import { readRecentTags, recordRecentTags } from "../lib/recent-media-tags";
import {
  mediaCollectionsPath,
  mediaImagesPath,
  mediaLibraryPath,
  mediaVideosPath,
  mediaVoiceoversPath,
  parseMediaWorkspacePath,
} from "../lib/routes";

type MediaSecondaryModule = typeof import("./MediaSecondaryRoutes");
type MediaSecondaryLoader = () => Promise<MediaSecondaryModule>;

const loadMediaSecondaryModule: MediaSecondaryLoader = () => import("./MediaSecondaryRoutes");
const reloadMediaDocument = () => window.location.reload();

class MediaSecondaryLoadError extends Error {
  constructor(originalError: unknown) {
    super("The deferred media workspace could not be loaded.", { cause: originalError });
    this.name = "MediaSecondaryLoadError";
  }
}

function createMediaSecondarySurface(load: MediaSecondaryLoader) {
  return lazy(async () => {
    try {
      return { default: (await load()).MediaSecondarySurface };
    } catch (error) {
      throw new MediaSecondaryLoadError(error);
    }
  });
}

class MediaSecondaryLoadBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { error: unknown | null }> {
  state = { error: null as unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (!(this.state.error instanceof MediaSecondaryLoadError)) throw this.state.error;
    return this.props.fallback;
  }
}

type MediaState =
  | { status: "loading" }
  | { status: "error"; message: string }
  // query is the list query this result answers, so the status names the filters it shows.
  | { status: "ready"; result: ListMediaResponse; query: MediaListQuery; error?: string };

type ImageViewerSession = { order: readonly MediaAssetSummary[]; id: string; userId: string; queryKey: string; permalinkId?: string };

function MediaLoading() {
  return (
    <div className="media-loading">
      <LoadingIndicator
        label="Loading media library"
        layout="stack"
        stages={[
          "Asking the CMS for the first page of media",
          "Waiting for the media list",
        ]}
      />
    </div>
  );
}

export function MediaLibrarySurface({
  audioLibrary = false,
  principal,
  userId,
  getIdToken,
  categories,
  loadMedia,
  loadCorpus,
  saveMetadata,
  deleteMedia,
  uploadMedia,
  initialUploadState,
  onAllCountChange,
  videoTransferActive = false,
  onDiscardVideo,
}: {
  audioLibrary?: boolean;
  principal: ReturnType<typeof useShell>["principal"];
  userId: string;
  getIdToken: () => Promise<string>;
  categories: readonly MediaCategoryDefinition[];
  /**
   * Loads one list page. Only the visible-page load passes `tabCounts`, which lets the loader
   * ask for tab counts when the session has none; searches and id lookups never do.
   */
  loadMedia: (query: MediaListQuery, options?: { tabCounts?: boolean }) => Promise<ListMediaResponse>;
  loadCorpus: (request: MediaCorpusRequest) => Promise<MediaCorpusResponse>;
  saveMetadata: (
    asset: MediaAssetSummary,
    metadata: UpdateMediaMetadata,
  ) => Promise<UpdateMediaMetadataResponse>;
  deleteMedia: (asset: MediaAssetSummary) => Promise<DeleteMediaResponse>;
  uploadMedia: MediaUploader;
  initialUploadState?: MediaUploadInitialState;
  /**
   * Reports the unfiltered total from a list already in hand, with the list revision it belongs
   * to, or null after a failed load. It never starts a request.
   */
  onAllCountChange?: (count: number | null, revision: number) => void;
  /** A routed video is in progress and would be lost if this page unmounts. */
  videoTransferActive?: boolean;
  onDiscardVideo?: () => void;
}) {
  const navigate = useNavigate();
  const notice = useSuccessNotice();
  const currentNotice = useRef(notice);
  currentNotice.current = notice;
  // Held in a ref so a new callback never restarts the list effect.
  const onAllCountChangeRef = useRef(onAllCountChange);
  onAllCountChangeRef.current = onAllCountChange;
  const [searchParams, setSearchParams] = useSearchParams();
  const routeKey = useLocation().key;
  const locationKey = searchParams.toString();
  const location = useMemo(() => {
    const parsed = parseMediaLocation(locationKey);
    return { ...parsed, query: { ...parsed.query, kinds: audioLibrary ? [] : parsed.query.kinds.filter(kind => kind !== "audio") } };
  }, [locationKey, audioLibrary]);
  const libraryLabel = audioLibrary ? "Audio" : "Images";
  const libraryPath = audioLibrary ? mediaVoiceoversPath() : mediaImagesPath();
  const permalink = parseMediaPermalink(searchParams);
  const permalinkId = permalink.assetId;
  const prepareFilterUndo = useClearFilterUndo(routeKey, locationKey, (before) => {
    setSearchParams(new URLSearchParams(before), { replace: true });
  });
  const [permalinkError, setPermalinkError] = useState("");
  const mediaIdentity = JSON.stringify(principal);
  const browseQuery = useMemo(() => ({ ...location.query, page: 1 }), [location.query]);
  const queryKey = JSON.stringify([userId, mediaIdentity, audioLibrary, browseQuery, location.view ?? null]);
  type CursorPaging = {
    key: string;
    cursor?: string;
    previous: (string | undefined)[];
  };
  const [paging, setPaging] = useState<CursorPaging>(() => ({ key: queryKey, previous: [] }));
  const [pendingCursorPaging, setPendingCursorPaging] = useState<CursorPaging | null>(null);
  useEffect(() => {
    setPaging((current) => current.key === queryKey ? current : { key: queryKey, previous: [] });
  }, [queryKey]);
  const cursor = paging.key === queryKey ? paging.cursor : undefined;
  const previousCursors = paging.key === queryKey ? paging.previous : [];
  const requestQuery = useMemo<MediaListQuery>(() => ({
    ...browseQuery,
    ...(audioLibrary ? { kinds: ["audio" as const] } : {}),
    paging: "cursor",
    page: previousCursors.length + 1,
    ...(cursor ? { cursor } : {}),
  }), [browseQuery, cursor, previousCursors.length, audioLibrary]);
  const requestKey = JSON.stringify(requestQuery);
  const { display, setDisplay, resetDisplay } = useMediaDisplay();
  const toolbarRef = useRef<MediaToolbarHandle>(null);
  setMediaCachePrincipal(userId, mediaIdentity);
  const [state, setState] = useState<MediaState>(() => {
    const cached = cachedMediaList(userId, requestQuery);
    return cached ? { status: "ready", result: cached, query: requestQuery } : { status: "loading" };
  });
  const stateUserId = useRef(userId);
  const statePrincipal = useRef(mediaIdentity);
  const [updating, setUpdating] = useState(false);
  // Each list response sets a new seed, with or without states. While a list load is in flight the
  // favorites hook waits for it instead of making its own lookup.
  const [favoriteSeed, setFavoriteSeed] = useState<{ states?: ListMediaResponse["favoriteStates"] }>();
  const awaitingFavoriteSeed = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [cursorRestartRequired, setCursorRestartRequired] = useState(false);
  const restartList = useCallback(() => {
    setPaging({ key: queryKey, previous: [] });
    setCursorRestartRequired(false);
    setAttempt((value) => value + 1);
  }, [queryKey]);
  useEffect(() => {
    if (location.query.page === 1) return;
    const params = encodeMediaLocation(browseQuery, location.selectedId, location.view);
    if (permalinkId) {
      params.set("asset", permalinkId);
      if (searchParams.has("t")) params.set("t", searchParams.get("t")!);
    }
    setSearchParams(params, { replace: true });
  }, [browseQuery, location.query.page, location.selectedId, location.view, permalinkId, searchParams, setSearchParams]);
  const selectionContext = JSON.stringify([mediaIdentity, location.query.categories, location.query.kinds]);
  const [relatedSelection, setRelatedSelection] = useState<{ context: string; asset: MediaAssetSummary } | null>(null);
  useEffect(() => { setRelatedSelection(null); }, [selectionContext]);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const metadataDirtyRef = useRef(metadataDirty);
  metadataDirtyRef.current = metadataDirty;
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<readonly MediaUploadQueueProjection[]>([]);
  const [uploadFormGeneration, setUploadFormGeneration] = useState(0);
  const [uploadTrayCollapsed, setUploadTrayCollapsed] = useState(false);
  const uploadCategory = authorizedMediaUploadCategory(principal, categories);
  const mayUpload = canUploadMedia(principal) && uploadCategory !== "";
  const previousMayUpload = useRef(mayUpload);
  const [incomingLibrary, setIncomingLibrary] = useState<readonly File[] | null>(null);
  const uploadOpener = useRef<HTMLElement | null>(null);
  const openUploadRef = useRef<(files?: readonly File[]) => void>(() => {});
  openUploadRef.current = openUpload;
  const receiveLibraryRef = useRef<(files: readonly File[]) => void>(() => {});
  receiveLibraryRef.current = (files) => {
    openUploadRef.current(files);
  };
  useEffect(() => {
    if (mayUpload) return registerLibraryUpload((files) => receiveLibraryRef.current(files));
  }, [mayUpload]);
  const [showUpload, setShowUpload] = useState(
    Boolean(initialUploadState) && canUploadMedia(principal),
  );
  const [confirmCloseUpload, setConfirmCloseUpload] = useState(false);
  // Each increment moves focus to the toolbar's Upload, such as after the upload form closes.
  const [uploadFocusRequest, setUploadFocusRequest] = useState(0);
  const [uploadReceipt, setUploadReceipt] =
    useState<MediaUploadBatchReceipt | null>(null);
  const [activeUploadedAssets, setActiveUploadedAssets] = useState<
    MediaAssetSummary[]
  >([]);
  const [activeReused, setActiveReused] = useState<MediaUploadBatchReuse[]>([]);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);
  const [collectionSelection, setCollectionSelection] = useState<MediaSelection<MediaAssetSummary>>(emptySelection);
  const [bulkSession, setBulkSession] = useState<{
    assets: readonly MediaAssetSummary[];
    reviewing: boolean;
    draft?: BulkMetadataDraft;
    focusRequest: number;
  } | null>(null);
  const [pendingBulkOpen, setPendingBulkOpen] = useState<readonly MediaAssetSummary[] | null>(null);
  const [bulkInspectorDirty, setBulkInspectorDirty] = useState(false);
  const [bulkReviewDirty, setBulkReviewDirty] = useState(false);
  const [quickLook, setQuickLook] = useState<{ order: readonly MediaAssetSummary[]; id: string } | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerSession | null>(null);
  const [pendingViewerOpen, setPendingViewerOpen] = useState<ImageViewerSession | null>(null);
  const viewerNeedsReload = useRef(false);
  const viewerGeneration = useRef(0);
  const currentViewerUserId = useRef(userId);
  currentViewerUserId.current = userId;
  const [viewerReloading, setViewerReloading] = useState(false);
  const [viewerReloadError, setViewerReloadError] = useState("");
  const viewerNavigationKeep = useRef<HTMLButtonElement>(null);
  const viewerNavigationOpener = useRef<HTMLElement | null>(null);
  const pendingViewerFocus = useRef<{ currentId: string; currentName: string; order: string[]; queryKey: string } | null>(null);
  const [viewerAnnouncement, setViewerAnnouncement] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  // What the collection picker adds: the selection from the bar, or one card's image.
  const [pickerTarget, setPickerTarget] = useState<{ assets: readonly MediaAssetSummary[]; bulk: boolean } | null>(null);
  const collectionPickerOpen = pickerTarget !== null;
  const [collectionSuccess, setCollectionSuccess] = useState("");
  const [favoritesSaving, setFavoritesSaving] = useState(false);
  const [favoritesStatus, setFavoritesStatus] = useState("");
  const [favoritesError, setFavoritesError] = useState("");
  // A card menu's Delete from library opens that item's details at the delete confirmation.
  const [deleteRequest, setDeleteRequest] = useState<{ id: string; count: number } | null>(null);
  const [recentTagsVersion, setRecentTagsVersion] = useState(0);
  const [copyResult, setCopyResult] = useState<{ status: "copied" | "failed"; name: string; url: string } | null>(null);
  const gridRef = useRef<MediaGridHandle>(null);
  const uploadReceiptRef = useRef<HTMLDivElement>(null);
  const uploadReceiptFocusPending = useRef(false);
  const uploadReloadRef = useRef<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const inspectorDirty = metadataDirty || Boolean(bulkSession && (bulkSession.reviewing ? bulkReviewDirty : bulkInspectorDirty));
  const dirty = inspectorDirty || uploadDirty;
  const videoActiveRef = useRef(videoTransferActive);
  const leavingMedia = useRef(false);
  videoActiveRef.current = videoTransferActive;

  useEffect(() => {
    const permissionLost = previousMayUpload.current && !mayUpload;
    previousMayUpload.current = mayUpload;
    if (!permissionLost) return;
    uploadController.current?.abort();
    setUploadQueue([]);
    setUploadDirty(false);
    setIncomingLibrary(null);
    setShowUpload(false);
  }, [mayUpload]);

  useEffect(() => {
    setCollectionSelection(emptySelection());
    setBulkSession(null);
    setPendingBulkOpen(null);
    setImageViewer(null);
    setPendingViewerOpen(null);
    pendingViewerFocus.current = null;
    viewerNeedsReload.current = false;
    viewerGeneration.current += 1;
    setViewerReloading(false);
    setViewerReloadError("");
    setPickerTarget(null);
    setCollectionSuccess("");
  }, [userId]);

  useEffect(() => {
    let current = true;
    setPermalinkError("");
    if (!permalinkId) {
      setImageViewer(previous => previous?.permalinkId ? null : previous);
      return;
    }
    setImageViewer(null);
    void loadMedia({ ...DEFAULT_MEDIA_QUERY, assetIds: [permalinkId] }).then(result => {
      if (!current) return;
      const asset = result.records.find(item => item.id === permalinkId);
      if (!asset) { setPermalinkError(unavailableMediaMessage); return; }
      setImageViewer({ order: [asset], id: asset.id, userId, queryKey, permalinkId });
    }).catch(() => { if (current) setPermalinkError(unavailableMediaMessage); });
    return () => { current = false; };
  }, [permalinkId, loadMedia, userId, mediaIdentity, queryKey]);

  const viewerInternalNavigation = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => {
      const moving = currentLocation.pathname !== nextLocation.pathname
        || currentLocation.search !== nextLocation.search
        || currentLocation.hash !== nextLocation.hash;
      const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
      leavingMedia.current = kind === "not-found";
      if (!moving) return false;
      if (currentLocation.pathname === nextLocation.pathname && currentLocation.hash === nextLocation.hash) {
        const current = new URLSearchParams(currentLocation.search);
        const next = new URLSearchParams(nextLocation.search);
        current.delete("view");
        next.delete("view");
        if (current.toString() === next.toString()) return false;
      }
      if (replaceBusy || (inspectorDirty && !viewerInternalNavigation.current)) return true;
      const opensRecycleBin = kind === "images"
        && new URLSearchParams(nextLocation.search).get("bin") === "1";
      if (uploadDirty && (kind !== (audioLibrary ? "voiceovers" : "images") || opensRecycleBin)) return true;
      if (!videoActiveRef.current) return false;
      return leavingMedia.current;
    },
  );
  const cursorPagingBlockerSeen = useRef(false);
  useEffect(() => {
    if (!pendingCursorPaging) {
      cursorPagingBlockerSeen.current = false;
      return;
    }
    if (blocker.state === "blocked") {
      cursorPagingBlockerSeen.current = true;
      return;
    }
    if (blocker.state !== "unblocked") return;
    if (!location.selectedId) {
      setPaging(pendingCursorPaging);
      setPendingCursorPaging(null);
    } else if (cursorPagingBlockerSeen.current) {
      // The person kept editing, so discard the page turn that caused the blocked navigation.
      setPendingCursorPaging(null);
    }
  }, [blocker.state, location.selectedId, pendingCursorPaging]);
  useEffect(() => {
    if (blocker.state === "blocked" && bulkSession?.reviewing && !bulkSaving && !bulkReviewDirty) blocker.proceed();
  }, [blocker, bulkReviewDirty, bulkSaving, bulkSession]);

  useBeforeUnload((event) => {
    if (!dirty && !replaceBusy && !videoTransferActive) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // The media surface joins the shell's one exit contract (#1032). Its blocker already holds route
  // changes and the unload handler covers a reload, but sign-out is neither, so an open upload form
  // or an unsaved metadata edit used to disappear with the session and no question asked. There is
  // no save to offer here: the upload and the metadata form each own their own commit, so the
  // prompt keeps its two answers.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const mediaHasUnsavedWork = useCallback(() => dirtyRef.current || videoActiveRef.current, []);
  useRegisterExitGuard({
    saving: metadataSaving || bulkSaving || replaceBusy,
    hasUnsavedWork: mediaHasUnsavedWork,
  });

  useEffect(() => {
    function openFromShortcut(event: KeyboardEvent) {
      if (
        event.altKey || event.shiftKey ||
        !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "u" ||
        !mayUpload || mediaShortcutBlocked(event)
      ) return;
      event.preventDefault();
      if (inspectorDirty || metadataSaving || replaceBusy || bulkSession || showUpload) {
        if (!showUpload) setUploadFocusRequest((value) => value + 1);
        return;
      }
      openUploadRef.current();
    }
    window.addEventListener("keydown", openFromShortcut);
    return () => window.removeEventListener("keydown", openFromShortcut);
  }, [bulkSession, inspectorDirty, mayUpload, metadataSaving, replaceBusy, showUpload]);

  // A change the leave prompt holds from inside a Filter, Sort or Display popover loses its
  // control when the prompt takes focus and the popover closes. Remember the popover's trigger
  // (Filter, the chip, Sort or Display) before that, and focus it after "Keep editing".
  const heldPopoverTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (blocker.state !== "blocked") return;
    const active = document.activeElement;
    viewerNavigationOpener.current = imageViewer && active instanceof HTMLElement ? active : null;
    heldPopoverTrigger.current = active instanceof HTMLElement && active.closest(".ui-popover")
      ? toolbarRef.current?.popoverTrigger() ?? null
      : null;
  }, [blocker.state]);
  useEffect(() => {
    if (blocker.state !== "unblocked") return;
    const trigger = heldPopoverTrigger.current;
    heldPopoverTrigger.current = null;
    const active = document.activeElement;
    if (!trigger?.isConnected || (active && active !== document.body && active.isConnected)) return;
    trigger.focus();
  }, [blocker.state]);

  useEffect(() => {
    if (
      !uploadReceipt ||
      !uploadReceiptFocusPending.current ||
      uploadReloadRef.current ||
      inspectorDirty ||
      metadataSaving ||
      replaceBusy ||
      state.status !== "ready" ||
      updating
    ) return;
    uploadReceiptFocusPending.current = false;
    const frame = requestAnimationFrame(() => uploadReceiptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [inspectorDirty, metadataSaving, replaceBusy, state.status, updating, uploadReceipt]);

  useEffect(() => {
    if (
      !uploadReceipt ||
      uploadDirty ||
      inspectorDirty ||
      metadataSaving ||
      replaceBusy ||
      !uploadReloadRef.current
    )
      return;
    const uploadedAssetId = uploadReloadRef.current;
    const uploadLocation = encodeMediaLocation(
      { ...DEFAULT_MEDIA_QUERY },
      uploadedAssetId,
    );
    setState({ status: "loading" });
    if (locationKey !== uploadLocation.toString()) {
      setSearchParams(uploadLocation, { replace: true });
      return;
    }
    uploadReloadRef.current = null;
    restartList();
  }, [inspectorDirty, locationKey, metadataSaving, replaceBusy, setSearchParams, uploadDirty, uploadReceipt]);

  useEffect(() => {
    if (location.query.page !== 1) return;
    let current = true;
    awaitingFavoriteSeed.current = true;
    const cached = cachedMediaList(userId, requestQuery);
    if (stateUserId.current !== userId || statePrincipal.current !== mediaIdentity) {
      stateUserId.current = userId;
      statePrincipal.current = mediaIdentity;
      setState(cached ? { status: "ready", result: cached, query: requestQuery } : { status: "loading" });
    } else if (cached) {
      setState({ status: "ready", result: cached, query: requestQuery });
    }
    const requestRevision = mediaListRevision();
    // Cached lists are cleared on every invalidation, so a cached total belongs to this revision.
    if (cached && cached.allCount !== null) onAllCountChangeRef.current?.(cached.allCount, requestRevision);
    const timer = globalThis.setTimeout(
      () => {
        setUpdating(true);
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, error: undefined }
            : previous,
        );
        const favoriteEpoch = mediaFavoriteWriteEpoch();
        void loadMedia(requestQuery, { tabCounts: true })
          .then(({ favoriteStates, ...result }) => {
            if (!current) return;
            setCursorRestartRequired(false);
            if (mediaListRevision() !== requestRevision) {
              setUpdating(false);
              restartList();
              return;
            }
            cacheMediaList(userId, requestQuery, result, requestRevision);
            if (result.allCount !== null) onAllCountChangeRef.current?.(result.allCount, requestRevision);
            setState({ status: "ready", result, query: requestQuery });
            // Set in the same render as the records, so the hearts use it instead of a second read.
            // States from a read that overlapped a favorite write are dropped; the hook reads them again.
            awaitingFavoriteSeed.current = false;
            setFavoriteSeed({ states: favoriteEpoch !== null && favoriteEpoch === mediaFavoriteWriteEpoch() ? favoriteStates : undefined });
            const focusRequest = pendingViewerFocus.current;
            if (focusRequest?.queryKey === queryKey) {
              pendingViewerFocus.current = null;
              requestAnimationFrame(() => focusAfterViewerReload(result, focusRequest));
            } else if (focusRequest) pendingViewerFocus.current = null;
            setUpdating(false);
            if (result.paging !== "cursor" && result.page !== location.query.page) {
              writeLocation({ ...location, query: { ...location.query, page: result.page } });
            }
          })
          .catch((loadError: unknown) => {
            if (!current) return;
            awaitingFavoriteSeed.current = false;
            setFavoriteSeed({});
            pendingViewerFocus.current = null;
            const message =
              loadError instanceof Error
                ? loadError.message
                : "The media library could not be loaded.";
            setCursorRestartRequired(Boolean(requestQuery.cursor) && loadError instanceof HttpError &&
              (loadError.status === 409 || loadError.status === 410 || loadError.status === 503));
            onAllCountChangeRef.current?.(null, mediaListRevision());
            if (loadError instanceof HttpError && (loadError.status === 401 || loadError.status === 403)) {
              invalidateMediaLists();
              setState({ status: "error", message });
              setUpdating(false);
              return;
            }
            setState((previous) =>
              previous.status === "ready"
                ? { ...previous, query: requestQuery, error: message }
                : { status: "error", message },
            );
            setUpdating(false);
          });
      },
      0,
    );
    return () => {
      current = false;
      globalThis.clearTimeout(timer);
    };
    // queryKey is the stable request identity. Selection changes do not reload the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, loadMedia, requestKey, userId, mediaIdentity, location.query.page]);

  useEffect(() => {
    if (state.status !== "ready" || !location.selectedId) return;
    if (relatedSelection?.context === selectionContext && relatedSelection.asset.id === location.selectedId) return;
    if (state.result.records.some((asset) => asset.id === location.selectedId))
      return;
    writeLocation({ ...location, selectedId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, state, relatedSelection, selectionContext]);

  // The one location writer. Every write keeps the saved-view id, except the upload reload,
  // which returns to the default query. Filters, sort and search replace history; selection
  // and paging push it.
  function locationParams(next: MediaLocationState) {
    const params = encodeMediaLocation(next.query, next.selectedId, next.view);
    if (permalinkId) {
      params.set("asset", permalinkId);
      if (searchParams.has("t")) params.set("t", searchParams.get("t")!);
    }
    return params;
  }

  function writeLocation(next: MediaLocationState, replace = true) {
    const params = locationParams(next);
    setSearchParams(params, { replace });
  }

  function clearFilters() {
    const next = { ...clearFilterChips(location), view: undefined };
    if (prepareFilterUndo(locationParams(location).toString(), locationParams(next).toString())) {
      writeLocation(next);
    }
  }

  function applySavedView(view: SavedMediaView) {
    if (inspectorDirty || replaceBusy) {
      notice.show("Finish editing asset details before opening a saved view.", { tone: "error" });
      return;
    }
    const saved = parseMediaLocation(view.query);
    setSearchParams(
      encodeMediaLocation({ ...saved.query, page: 1 }, null, view.id),
      { replace: true },
    );
    if (view.display) setDisplay(view.display as MediaDisplayPreferences);
  }

  function removeMissingSavedView(reason?: "deleted") {
    const requestUser = userId;
    const params = new URLSearchParams(searchParams);
    params.delete("view");
    setSearchParams(params, { replace: true });
    if (reason === "deleted") return;
    window.setTimeout(() => {
      const controller = currentNotice.current;
      if (currentUserId.current === requestUser && controller.isCurrent()) {
        controller.show("This saved view is no longer available. Current filters were kept.", { tone: "error" });
      }
    }, 0);
  }

  function resetSavedViewDefaults() {
    setSearchParams(encodeMediaLocation(DEFAULT_MEDIA_QUERY, null), { replace: true });
  }

  function setLocation(
    query: typeof location.query,
    selectedId = location.selectedId,
    replace = true,
  ) {
    writeLocation({ ...location, query, selectedId }, replace);
  }

  function selectAsset(assetId: string | null) {
    writeLocation({ ...location, selectedId: assetId }, false);
  }

  function changeCursorPage(next: CursorPaging) {
    if (replaceBusy || (inspectorDirty && !location.selectedId)) {
      notice.show("Finish editing asset details before changing pages.", { tone: "error" });
      return;
    }
    if (location.selectedId) {
      cursorPagingBlockerSeen.current = false;
      setPendingCursorPaging(next);
      selectAsset(null);
      return;
    }
    setPaging(next);
  }

  function updateAssetInMemory(asset: MediaAssetSummary) {
    setRelatedSelection(previous => previous?.asset.id === asset.id ? { ...previous, asset } : previous);
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            result: {
              ...current.result,
              records: current.result.records.map((record) =>
                record.id === asset.id ? asset : record,
              ),
            },
          }
        : current,
    );
    setMetadataDirty(false);
  }

  function replaceAsset(asset: MediaAssetSummary) {
    invalidateMediaLists();
    updateAssetInMemory(asset);
    restartList();
  }

  function replaceViewerAsset(asset: MediaAssetSummary) {
    if (!imageViewer || imageViewer.userId !== currentViewerUserId.current || imageViewer.id !== asset.id) return;
    updateAssetInMemory(asset);
    setImageViewer(previous => previous ? {
      ...previous,
      order: previous.order.map(item => item.id === asset.id ? asset : item),
    } : previous);
    viewerNeedsReload.current = true;
  }

  function finishDelete(asset: MediaAssetSummary) {
    invalidateMediaLists();
    setRelatedSelection(previous => previous?.asset.id === asset.id ? null : previous);
    setCollectionSelection(previous => previous.items.some(item => item.id === asset.id) ? removeSelected(previous, asset.id) : previous);
    setMetadataDirty(false);
    setDeleteSuccess(asset.name);
    writeLocation({ ...location, selectedId: null });
    setState({ status: "loading" });
    restartList();
  }

  function reloadSelectedAsset() {
    invalidateMediaLists();
    setMetadataDirty(false);
    if (relatedSelection?.context === selectionContext && relatedSelection.asset.id === location.selectedId) {
      const id = relatedSelection.asset.id;
      void loadMedia({ ...location.query, q: "", page: 1, assetIds: [id] }).then(fresh => {
        const asset = fresh.records.find(record => record.id === id);
        setRelatedSelection(previous => previous?.context === selectionContext && previous.asset.id === id
          ? (asset ? { context: selectionContext, asset } : null) : previous);
      }).catch(() => setRelatedSelection(previous => previous?.context === selectionContext && previous.asset.id === id ? null : previous));
      return;
    }
    setState({ status: "loading" });
    restartList();
  }

  function reloadViewerAsset() {
    if (!imageViewer || viewerReloading) return;
    const id = imageViewer.id;
    const generation = viewerGeneration.current;
    const owner = userId;
    const current = () => viewerGeneration.current === generation && currentViewerUserId.current === owner;
    setViewerReloading(true);
    setViewerReloadError("");
    void loadMedia({ ...DEFAULT_MEDIA_QUERY, assetIds: [id] }).then(fresh => {
      if (!current()) return;
      const asset = fresh.records.find(record => record.id === id);
      if (!asset) {
        viewerNeedsReload.current = true;
        setViewerReloadError("This asset is no longer available. Close the viewer to refresh the page.");
        return;
      }
      replaceViewerAsset(asset);
    }).catch(() => {
      if (current()) setViewerReloadError("The media asset could not be reloaded. Try again.");
    }).finally(() => {
      if (current()) setViewerReloading(false);
    });
  }

  const loadError =
    state.status === "error"
      ? state.message
      : state.status === "ready"
        ? state.error
        : undefined;
  const requestPending = updating ||
    (state.status === "ready" && JSON.stringify(state.query) !== requestKey);
  const result =
    state.status === "ready" &&
    (state.result.records.length > 0 || !loadError)
      ? state.result
      : null;
  const selectedAsset =
    (relatedSelection?.context === selectionContext && relatedSelection.asset.id === location.selectedId ? relatedSelection.asset : null) ??
    result?.records.find((asset) => asset.id === location.selectedId) ?? null;
  const selectedAssetRef = useRef(selectedAsset);
  selectedAssetRef.current = selectedAsset;
  const activeImageViewer = imageViewer?.userId === userId && imageViewer.queryKey === queryKey && (!location.selectedId || Boolean(imageViewer.permalinkId && imageViewer.permalinkId === permalinkId)) ? imageViewer : null;
  const activeImageViewerRef = useRef(activeImageViewer);
  activeImageViewerRef.current = activeImageViewer;
  const imageViewerAsset = activeImageViewer?.order.find(asset => asset.id === activeImageViewer.id);
  const viewerOpen = Boolean(activeImageViewer);
  function offerImageSaveUndo(receipt: MediaInspectorSaveReceipt, viewer = false) {
    const { asset, previous } = receipt;
    const requestUser = userId;
    let used = false;
    notice.show(`${asset.name} details saved.`, { action: { label: "Undo", onClick: () => {
      if (used || !notice.isCurrent() || currentUserId.current !== requestUser || metadataDirtyRef.current) {
        if (!used && notice.isCurrent()) notice.show("Save Undo is no longer available. Reload the asset before editing.", { tone: "error" });
        return;
      }
      const current = viewer
        ? activeImageViewerRef.current?.id === asset.id
          ? activeImageViewerRef.current.order.find(item => item.id === asset.id)
          : undefined
        : selectedAssetRef.current;
      if (current?.id !== asset.id || current.etag !== asset.etag) {
        notice.show("Save Undo is no longer available. Reload the asset before editing.", { tone: "error" });
        return;
      }
      used = true;
      notice.show(`Restoring ${asset.name} details.`);
      void saveMetadata(asset, previous).then(response => {
        if (!notice.isCurrent() || currentUserId.current !== requestUser) return;
        if (viewer) replaceViewerAsset(response.asset);
        else replaceAsset(response.asset);
        notice.show(`${asset.name} details restored.`);
      }).catch(error => {
        if (!notice.isCurrent() || currentUserId.current !== requestUser) return;
        if (error instanceof HttpError && error.status === 412) {
          if (viewer) reloadViewerAsset();
          else reloadSelectedAsset();
          notice.show(viewer
            ? "This asset changed. Reloading its current details."
            : "This asset changed. Reload its current details before editing.", { tone: "error" });
        } else notice.show("Could not restore asset details. Reload the asset before editing.", { tone: "error" });
      });
    } } });
  }
  useEffect(() => {
    if (blocker.state !== "blocked" || !viewerOpen) return;
    viewerNavigationKeep.current?.focus();
    viewerNavigationKeep.current?.scrollIntoView?.({ block: "nearest" });
  }, [blocker.state, viewerOpen]);
  const favoriteRefs: MediaFavoriteRef[] = [
    ...(result?.records.map(asset => ({ backend: "r2" as const, id: asset.id })) ?? []),
    ...(selectedAsset ? [{ backend: "r2" as const, id: selectedAsset.id }] : []),
    ...(imageViewerAsset && !result?.records.some(asset => asset.id === imageViewerAsset.id) && selectedAsset?.id !== imageViewerAsset.id
      ? [{ backend: "r2" as const, id: imageViewerAsset.id }] : []),
  ];
  const favorites = useMediaFavorites(userId, favoriteRefs, getIdToken, favoriteSeed, awaitingFavoriteSeed);
  const favoriteUndo = useFavoriteUndo(userId, favorites);
  const favoritesLibraryRevision = useSyncExternalStore(subscribeFavoritesChange, favoritesChangeRevisionValue);
  const seenFavoritesRevision = useRef(favoritesLibraryRevision);
  useEffect(() => {
    if (seenFavoritesRevision.current === favoritesLibraryRevision) return;
    seenFavoritesRevision.current = favoritesLibraryRevision;
    favorites.reconcile();
    restartList();
  }, [favorites, favoritesLibraryRevision]);
  const collectionAssets = collectionSelection.items;
  const pickerRefs: MediaAssetRef[] = (pickerTarget?.assets ?? []).map(asset => ({ backend: "r2", id: asset.id }));
  const pageAssets = useMemo(() => result?.records ?? [], [result]);
  const pageTags = useMemo(() => pageAssets.flatMap((asset) => asset.tags), [pageAssets]);
  const recentTags = useMemo(() => readRecentTags("images", userId), [recentTagsVersion, userId]);
  const canEditSelection = collectionAssets.some(asset => canManageMediaMetadata(principal, asset.category));
  useEffect(() => {
    if (!pendingBulkOpen || location.selectedId || blocker.state !== "unblocked") return;
    setBulkSession({ assets: pendingBulkOpen, reviewing: false, focusRequest: 0 });
    setPendingBulkOpen(null);
  }, [pendingBulkOpen, location.selectedId, blocker.state]);
  useEffect(() => {
    if (!pendingViewerOpen || location.selectedId || blocker.state !== "unblocked") return;
    if (pendingViewerOpen.userId !== userId || pendingViewerOpen.queryKey !== queryKey) {
      setPendingViewerOpen(null);
      return;
    }
    setImageViewer(pendingViewerOpen);
    setPendingViewerOpen(null);
  }, [pendingViewerOpen, location.selectedId, blocker.state, userId, queryKey]);
  useEffect(() => {
    if (!imageViewer || (imageViewer.userId === userId && imageViewer.queryKey === queryKey && (!location.selectedId || Boolean(imageViewer.permalinkId && imageViewer.permalinkId === permalinkId)))) return;
    viewerGeneration.current += 1;
    setImageViewer(null);
    setViewerReloading(false);
    setViewerReloadError("");
    if (viewerNeedsReload.current) {
      viewerNeedsReload.current = false;
      invalidateMediaLists();
      if (imageViewer.userId === userId && imageViewer.queryKey === queryKey) restartList();
    }
  }, [imageViewer, userId, queryKey, location.selectedId, permalinkId]);
  // Selecting, favoriting or collecting from a card waits while details or an upload hold
  // unsaved work, while a metadata write is in flight, or while the collection picker is open.
  const cardsLocked = dirty || metadataSaving || bulkSaving || favoritesSaving || showUpload || collectionPickerOpen || bulkSession !== null || activeImageViewer !== null;
  const quickLookLocked = inspectorDirty || metadataSaving || bulkSaving || favoritesSaving || showUpload || collectionPickerOpen || bulkSession !== null || activeImageViewer !== null;
  const selectionBusy = favoritesSaving || collectionPickerOpen || bulkSession !== null;
  const allowBulkTransition = metadataDirty && !bulkSession && !metadataSaving && !uploadDirty && !showUpload ? "edit-tags" as const : undefined;
  function changeCollectionSelection(next: MediaSelection<MediaAssetSummary>) {
    if (cardsLocked) return;
    setCollectionSelection(next);
    setCollectionSuccess("");
  }
  const categoryLabel = useCallback((id: string) => mediaCategoryLabel(categories, id), [categories]);
  const filtered =
    Boolean(location.query.q) ||
    location.query.categories.length > 0 ||
    location.query.kinds.length > 0;

  function recordUploadedAsset(
    asset: MediaAssetSummary,
    reuse?: MediaUploadBatchReuse,
  ) {
    invalidateMediaLists();
    setActiveUploadedAssets((current) =>
      current.some((candidate) => candidate.id === asset.id)
        ? current
        : [...current, asset],
    );
    if (reuse) setActiveReused((current) => [...current, reuse]);
  }

  function finishUploadBatch(receipt: MediaUploadBatchReceipt) {
    uploadReloadRef.current = receipt.succeeded.at(-1)?.id ?? null;
    uploadReceiptFocusPending.current = true;
    setUploadDirty(false);
    setShowUpload(false);
    setIncomingLibrary(null);
    setActiveUploadedAssets([]);
    setActiveReused([]);
    setUploadReceipt(receipt);
  }

  function openUpload(files?: readonly File[]) {
    const continuing = uploadDirty || uploadQueue.some((item) => item.status !== "succeeded");
    if (!continuing) {
      if (uploadQueue.length > 0) {
        setUploadQueue([]);
        setUploadFormGeneration((value) => value + 1);
      }
      setUploadReceipt(null);
      setActiveUploadedAssets([]);
      setActiveReused([]);
      setDeleteSuccess(null);
      setIncomingLibrary(files ?? null);
    }
    if (continuing && files) setIncomingLibrary(files);
    showUploadSheet();
  }

  function showUploadSheet() {
    if (!showUpload) {
      const active = document.activeElement;
      uploadOpener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setShowUpload(true);
  }

  function hideUpload() {
    setShowUpload(false);
  }

  function requestCloseUpload() {
    if (uploadQueue.some((item) => item.status === "uploading")) {
      hideUpload();
    } else if (uploadDirty) {
      setConfirmCloseUpload(true);
    } else {
      hideUpload();
    }
  }

  function discardUpload() {
    if (activeUploadedAssets.length > 0) {
      uploadReloadRef.current = activeUploadedAssets.at(-1)?.id ?? null;
      uploadReceiptFocusPending.current = true;
      setUploadReceipt(partialUploadReceipt(activeUploadedAssets, activeReused));
    }
    setActiveUploadedAssets([]);
    setActiveReused([]);
    setUploadDirty(false);
    setUploadQueue([]);
    setUploadFormGeneration((value) => value + 1);
    setIncomingLibrary(null);
    hideUpload();
  }

  function focusSearch() {
    document.getElementById("media-search-input")?.focus();
  }

  // Decision 3: after Clear selection, Escape or a bulk action, focus returns to the card that
  // last had focus, or to search when that card is gone.
  function returnFocus() {
    restoreMediaFocus(gridRef.current, focusSearch);
  }

  function clearCollectionSelection() {
    setCollectionSelection(emptySelection());
    returnFocus();
  }

  // Escape in the grid: clear the selection, else close details, else clear search.
  function escapeResults() {
    if (collectionAssets.length > 0) {
      if (!selectionBusy) clearCollectionSelection();
      return;
    }
    if (selectedAsset && !showUpload) {
      selectAsset(null);
      return;
    }
    if (location.query.q) writeLocation({ ...location, query: { ...location.query, q: "", page: 1 }, view: undefined });
    focusSearch();
  }

  function openAsset(asset: MediaAssetSummary) {
    if (bulkSession) return;
    hideUpload();
    if (asset.id !== location.selectedId) selectAsset(asset.id);
  }

  function openQuickLook(asset: MediaAssetSummary) {
    if (quickLookLocked || quickLook) return;
    setQuickLook({ order: [...pageAssets], id: asset.id });
  }

  function closeQuickLook(restoreFocus = true) {
    if (!quickLook) return;
    const id = quickLook.id;
    setQuickLook(null);
    if (restoreFocus) requestAnimationFrame(() => {
      if (!gridRef.current?.focusItemById(id)) focusSearch();
    });
  }

  function stepQuickLook(direction: "previous" | "next") {
    setQuickLook(previous => {
      if (!previous) return previous;
      const index = previous.order.findIndex(item => item.id === previous.id);
      const target = previous.order[index + (direction === "next" ? 1 : -1)];
      return target ? { ...previous, id: target.id } : previous;
    });
  }

  function focusAfterViewerReload(loaded: ListMediaResponse, request: NonNullable<typeof pendingViewerFocus.current>) {
    const available = new Set(loaded.records.map(asset => asset.id));
    const focusCard = (id: string) => available.has(id) && Boolean(gridRef.current?.focusItemById(id));
    if (focusCard(request.currentId)) {
      setViewerAnnouncement("");
      return;
    }
    const index = request.order.indexOf(request.currentId);
    const next = request.order.slice(index + 1).find(id => available.has(id));
    const previous = request.order.slice(0, Math.max(0, index)).reverse().find(id => available.has(id));
    if (!(next && focusCard(next)) && !(previous && focusCard(previous))) {
      document.getElementById("media-library-heading")?.focus({ preventScroll: true });
    }
    setViewerAnnouncement(`${request.currentName} no longer matches this view.`);
  }

  function openFullSize(asset: MediaAssetSummary) {
    if (bulkSession || showUpload || metadataSaving || activeImageViewer) return;
    const order = pageAssets.some(item => item.id === asset.id) ? [...pageAssets] : [asset];
    const session = { order, id: asset.id, userId, queryKey };
    viewerGeneration.current += 1;
    viewerNeedsReload.current = false;
    setViewerReloading(false);
    setViewerReloadError("");
    setViewerAnnouncement("");
    setQuickLook(null);
    if (location.selectedId) {
      setPendingViewerOpen(session);
      selectAsset(null);
    } else setImageViewer(session);
  }

  function closeImageViewer() {
    if (!activeImageViewer || !imageViewerAsset) return;
    const closing = imageViewerAsset;
    if (permalinkId) {
      const next = new URLSearchParams(searchParams);
      next.delete("asset");
      next.delete("t");
      viewerInternalNavigation.current = true;
      setSearchParams(next, { replace: true });
      viewerInternalNavigation.current = false;
    }
    const refresh = viewerNeedsReload.current;
    viewerGeneration.current += 1;
    viewerNeedsReload.current = false;
    setViewerReloading(false);
    setViewerReloadError("");
    setImageViewer(null);
    const focusShownCard = () => {
      if (!gridRef.current?.focusItemById(closing.id)) {
        document.getElementById("media-library-heading")?.focus({ preventScroll: true });
      }
    };
    if (refresh) {
      pendingViewerFocus.current = {
        currentId: closing.id, currentName: closing.name,
        order: activeImageViewer.order.map(item => item.id), queryKey,
      };
      requestAnimationFrame(focusShownCard);
      invalidateMediaLists();
      restartList();
    } else requestAnimationFrame(focusShownCard);
  }

  function finishViewerDelete(asset: MediaAssetSummary) {
    if (activeImageViewer) pendingViewerFocus.current = {
      currentId: asset.id, currentName: asset.name,
      order: activeImageViewer.order.map(item => item.id), queryKey,
    };
    viewerGeneration.current += 1;
    viewerNeedsReload.current = false;
    setViewerReloading(false);
    setViewerReloadError("");
    setImageViewer(null);
    setRelatedSelection(previous => previous?.asset.id === asset.id ? null : previous);
    setCollectionSelection(previous => previous.items.some(item => item.id === asset.id) ? removeSelected(previous, asset.id) : previous);
    setMetadataDirty(false);
    setDeleteSuccess(asset.name);
    if (permalinkId) {
      const next = new URLSearchParams(searchParams);
      next.delete("asset");
      next.delete("t");
      viewerInternalNavigation.current = true;
      setSearchParams(next, { replace: true });
      viewerInternalNavigation.current = false;
    }
    invalidateMediaLists();
    setState({ status: "loading" });
    restartList();
  }

  async function copyAssetLink(asset: MediaAssetSummary, fileAddress = false) {
    setCopyResult(null);
    const url = fileAddress ? asset.url : new URL(mediaPermalink(asset.kind === "audio" ? mediaVoiceoversPath() : mediaImagesPath(), asset.id), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setCopyResult({ status: "copied", name: asset.name, url });
    } catch {
      // An insecure context has no clipboard; the address stays visible to copy by hand.
      setCopyResult({ status: "failed", name: asset.name, url });
    }
  }

  function tileAction(asset: MediaAssetSummary, id: MediaTileActionId) {
    if (id === "open") {
      openAsset(asset);
      return;
    }
    if (id === "copy-link" || id === "copy-file-address") {
      if (id === "copy-file-address" && (asset.kind !== "image" || !asset.url)) return;
      void copyAssetLink(asset, id === "copy-file-address");
      return;
    }
    if (id === "quick-look") { openQuickLook(asset); return; }
    if (cardsLocked) return;
    if (id === "open-full-size") { openFullSize(asset); return; }
    if (id === "favorite") void favoriteUndo.toggle({ backend: "r2", id: asset.id }, asset.name);
    if (id === "collect") setPickerTarget({ assets: [asset], bulk: false });
    if (id === "select") changeCollectionSelection(toggleSelection(collectionSelection, asset));
    if (id === "delete") {
      setDeleteRequest(previous => ({ id: asset.id, count: (previous?.count ?? 0) + 1 }));
      openAsset(asset);
    }
  }

  function imageSelectionActions() {
    const actions = mediaSelectionActions({ surface: "images", count: collectionAssets.length, canEdit: canEditSelection });
    if (!favorites.retryDisabled) return actions;
    return actions.map(action =>
      action.id === "favorite-add" || action.id === "favorite-remove"
        ? { ...action, disabledReason: "Wait for the favorite save to finish." }
        : action);
  }

  async function favoriteSelection(favorite: boolean) {
    if (cardsLocked || favorites.retryDisabled || collectionAssets.length === 0 || collectionAssets.length > 100) return;
    const refs: MediaFavoriteRef[] = collectionAssets.map(asset => ({ backend: "r2", id: asset.id }));
    setFavoritesSaving(true);
    setFavoritesStatus("");
    setFavoritesError("");
    try {
      const token = await getIdToken();
      const result = await setMediaFavorites(token, refs, favorite);
      const changedCount = result.results.filter(item => "changed" in item && item.changed).length;
      const unchangedCount = result.results.filter(item => "changed" in item && !item.changed).length;
      const failed = result.results.filter(item => "error" in item);
      const savedIds = new Set(result.results.filter(item => "changed" in item).map(item => item.ref.id));
      const remaining = collectionAssets.filter(asset => !savedIds.has(asset.id));
      setCollectionSelection(previous => ({ ...previous, items: previous.items.filter(asset => !savedIds.has(asset.id)) }));
      const already = unchangedCount
        ? `${unchangedCount} already ${favorite ? "a favorite" : "not a favorite"}.`
        : "";
      const missed = failed.length ? `${failed.length} could not be changed.` : "";
      if (changedCount === 0 && failed.length > 0) {
        setFavoritesError([already, missed].filter(Boolean).join(" "));
      } else {
        const verb = favorite ? "Added" : "Removed";
        const direction = favorite ? "to" : "from";
        setFavoritesStatus([`${verb} ${changedCount} ${direction} favorites.`, already, missed].filter(Boolean).join(" "));
      }
      if (remaining.length === 0) requestAnimationFrame(returnFocus);
    } catch (error) {
      markMediaTabCountsStale();
      setFavoritesError(error instanceof Error ? error.message : "Favorites could not be saved. Try again.");
    } finally {
      favorites.reconcile();
      publishFavoritesChange();
      setFavoritesSaving(false);
    }
  }

  function selectionAction(id: MediaTileActionId) {
    if (favoritesSaving) return;
    if (id === "favorite-add" || id === "favorite-remove") {
      void favoriteSelection(id === "favorite-add");
      return;
    }
    if (id === "clear-selection" && !selectionBusy) clearCollectionSelection();
    if (id === "collect" && !dirty && !metadataSaving && !showUpload) {
      setPickerTarget({ assets: collectionAssets, bulk: true });
    }
    if (id === "edit-tags" && canEditSelection && collectionAssets.length > 0 && collectionAssets.length <= MAX_BULK_IMAGES && !bulkSession && !metadataSaving && !showUpload && !collectionPickerOpen) {
      const assets = [...collectionAssets];
      if (location.selectedId) {
        setPendingBulkOpen(assets);
        selectAsset(null);
      } else if (!dirty) {
        setBulkSession({ assets, reviewing: false, focusRequest: 0 });
      }
    }
  }

  function closeBulkSession(results?: BulkResult<MediaAssetSummary, ImageBulkPatch>[]) {
    setBulkSession(null);
    setBulkInspectorDirty(false);
    setBulkReviewDirty(false);
    if (results) {
      const completed = new Set(results.filter(row => row.status === "saved" || row.status === "unchanged").map(row => row.asset.id));
      setCollectionSelection(previous => ({ ...previous, items: previous.items.filter(asset => !completed.has(asset.id)) }));
      const savedTags = results.filter(row => row.status === "saved").flatMap(row => row.changes.tags ?? []);
      if (savedTags.length) {
        recordRecentTags("images", savedTags, userId);
        setRecentTagsVersion(version => version + 1);
      }
      if (results.some(row => row.status !== "pending")) {
        invalidateMediaLists();
        restartList();
      }
    }
    requestAnimationFrame(returnFocus);
  }

  // One owner for both layouts: a tile in its context menu, or a list row whose cells sit in
  // the same context menu (the row stays the grid's row). cardsLocked is the one guard.
  function renderTile(asset: MediaAssetSummary, context: MediaGridItemContext) {
    const ref = { backend: "r2" as const, id: asset.id };
    const favorite = favorites.value(ref);
    const favoritePending = favorites.pending(ref);
    // Delete opens the confirmation in details, which offers it for uploads the role manages.
    const canDelete = asset.source === "upload" && canManageMediaMetadata(principal, asset.category);
    const selectionMenu = context.selected && collectionAssets.length > 1 ? {
      count: collectionAssets.length,
      actions: availableSelectionActions(imageSelectionActions().filter(action => !action.disabledReason), cardsLocked, selectionBusy, allowBulkTransition),
      onAction: selectionAction,
    } : undefined;
    const withMenu = (children: ReactElement) => (
      <MediaContextMenu
        actionsDisabled={cardsLocked}
        allowSelectionActionWhileDisabled={allowBulkTransition}
        canEditSelection={canEditSelection}
        selectionBusy={selectionBusy}
        favoriteSettled={favorite !== undefined && !favoritePending}
        onAction={(id) => tileAction(asset, id)}
        onSelectionAction={selectionAction}
        selectionActions={imageSelectionActions().filter(action => !action.disabledReason)}
        selectionCount={collectionAssets.length}
        tile={{ surface: "images", name: asset.name, favorite: favorite === true, available: true, selected: context.selected, canDelete, quickLook: true, openFullSize: true, copyFileAddress: asset.kind === "image" && Boolean(asset.url) }}
      >
        {children}
      </MediaContextMenu>
    );
    const shared = {
      actionsDisabled: cardsLocked,
      asset,
      canDelete,
      categoryLabel,
      favorite,
      favoritePending,
      fields: display.fields,
      onAction: (id: MediaTileActionId) => tileAction(asset, id),
      onOpen: () => openAsset(asset),
      quickLook: true,
      openFullSize: true,
      onSelectChange: context.onSelectChange,
      selectionMenu,
      opened: asset.id === location.selectedId,
      selected: context.selected,
      tabbable: context.tabbable,
    };
    if (display.layout === "list") return <MediaRow {...shared} wrapCells={withMenu} />;
    return withMenu(<MediaTile {...shared} getAudioToken={audioLibrary ? getIdToken : undefined}
      selectionMode={context.selectionMode} surface="images" />);
  }

  // The selection count is announced from one always-mounted status, so the bar can come and
  // go without a live region of its own.
  const [hadSelection, setHadSelection] = useState(false);
  if (collectionAssets.length > 0 && !hadSelection) setHadSelection(true);
  const selectionStatus = selectionAnnouncement(collectionAssets.length, hadSelection ? 1 : 0);
  const resultQuery = state.status === "ready" ? state.query : location.query;
  const quickLookAsset = quickLook?.order.find(item => item.id === quickLook.id);
  const quickLookDisplay = quickLookAsset ? quickLookImage(quickLookAsset) : null;
  const uploadTrayStarted = uploadQueue.some((item) => item.status !== "pending");
  const uploadedCount = uploadQueue.filter((item) => item.status === "succeeded").length;
  const failedUploadCount = uploadQueue.filter((item) => item.status === "failed").length;
  const activeUploadIndex = uploadQueue.findIndex((item) => item.status === "uploading");
  const uploadSummary = activeUploadIndex >= 0
    ? `Uploading ${activeUploadIndex + 1} of ${uploadQueue.length}`
    : failedUploadCount > 0
      ? `${failedUploadCount} of ${uploadQueue.length} failed`
      : `Uploaded ${uploadedCount} of ${uploadQueue.length}`;
  const uploadTrayRows: readonly UploadTrayRow[] = uploadQueue.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status === "pending" ? "waiting" : item.status,
    message: item.message,
    ...(item.status === "uploading" ? { onStop: () => uploadController.current?.abort() } : {}),
    ...(item.asset ? { onViewAsset: () => {
      setShowUpload(false);
      setUploadReceipt(null);
      setRelatedSelection({ context: selectionContext, asset: item.asset! });
      selectAsset(item.asset!.id);
    } } : {}),
  }));
  const projectUploadQueue = useCallback((queue: readonly MediaUploadQueueProjection[]) => {
    setUploadQueue(queue);
    if (queue.some((item) => item.status === "pending")) setUploadReceipt(null);
  }, []);

  return (
    <section
      className="media-library"
      aria-labelledby="media-library-heading"
      data-density={display.density === "app" ? undefined : display.density}
      data-thumbnail={display.thumbnail}
    >
      <h2 id="media-library-heading" className={audioLibrary ? undefined : "sr-only"} tabIndex={-1}>{libraryLabel}</h2>
      <p className={audioLibrary ? undefined : "sr-only"}>{audioLibrary ? "Browse station audio and voiceover takes. Upload PCM WAV: Mono or stereo, 44.1 or 48 kHz, 16 or 24 bit, up to 10 MiB." : "Browse station images and documents. Upload files and manage their details."}</p>

      <MediaToolbar
        audioLibrary={audioLibrary}
        categoryIds={categories.filter((category) => category.active &&
          (canUploadMedia(principal, category.id) || canManageMediaMetadata(principal, category.id) ||
            (audioLibrary && can(principal, "media.audio.read"))))
          .map((category) => category.id)}
        categoryLabel={categoryLabel}
        categoryDescription={(id) => categories.find((category) => category.id === id)?.description}
        detailsDirty={inspectorDirty}
        display={display}
        handleRef={toolbarRef}
        mayUpload={mayUpload && !metadataSaving && !replaceBusy && bulkSession === null}
        onDisplayChange={setDisplay}
        onDisplayReset={resetDisplay}
        onClearAll={clearFilters}
        // More's Select this page, the same change as Cmd+A in the grid.
        onSelectPage={pageAssets.length > 0 && !cardsLocked
          ? () => changeCollectionSelection(setPageSelection(collectionSelection, pageAssets, true))
          : undefined}
        onStateChange={(next) => writeLocation({ ...next, view: undefined })}
        onOpenRecycleBin={!audioLibrary && hasCapability(principal, "media.manage") && !cardsLocked ? () => {
          const params = new URLSearchParams(searchParams);
          params.set("bin", "1");
          navigate(`${libraryPath}?${params}`);
        } : undefined}
        onUpload={() => openUploadRef.current()}
        result={result}
        savedViews={{
          userId,
          surface: audioLibrary ? "audio" : "images",
          query: encodeMediaLocation({ ...location.query, page: 1 }, null).toString(),
          currentViewId: location.view,
          display,
          onApply: applySavedView,
          onMissing: removeMissingSavedView,
          onResetFilters: resetSavedViewDefaults,
        }}
        state={location}
        uploadDraftCount={uploadDirty && !uploadTrayStarted ? uploadQueue.length : undefined}
        uploadFocusRequest={uploadFocusRequest}
        uploadOpen={showUpload}
      />

      {uploadReceipt ? (
        <div ref={uploadReceiptRef} tabIndex={-1}>
          <InlineMessage
            tone={
              uploadReceipt.succeeded.length > 0
                ? uploadReceipt.failed.length > 0
                  ? "warning"
                  : "success"
                : "error"
            }
            title={
              uploadReceipt.failed.length > 0
                ? "Media batch finished with failures"
                : uploadReceipt.succeeded.length === 1
                  ? "Media uploaded"
                  : "Media batch uploaded"
            }
          >
            {uploadReceipt.succeeded.length > 0 ? (
              <ul className="media-upload-receipt-list">
                {uploadReceipt.succeeded.map((asset) => (
                  <li key={asset.id}>
                    <span>{asset.name} is ready to use.</span>
                    <Button
                      variant="ghost"
                      aria-label={`View ${asset.name}`}
                      onClick={() => {
                        // A reused file can be older than the first page, so
                        // open it from the receipt's own copy.
                        setUploadReceipt(null);
                        setRelatedSelection({ context: selectionContext, asset });
                        selectAsset(asset.id);
                      }}
                    >
                      View asset
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
            <InlineMessage tone="warning" title="Existing files were used">
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

      {deleteSuccess ? (
        <InlineMessage tone="success" title="Media deleted from library">
          {deleteSuccess} is no longer available for new content.
        </InlineMessage>
      ) : null}

      {confirmCloseUpload ? (
        <LeaveGuardDialog
          onConfirm={() => {
            setConfirmCloseUpload(false);
            discardUpload();
          }}
          onCancel={() => setConfirmCloseUpload(false)}
        />
      ) : null}

      {loadError ? (
        <InlineMessage tone="error" title="Media library could not be loaded">
          <span>{loadError}</span>
          <Button onClick={cursorRestartRequired
            ? restartList
            : () => setAttempt((value) => value + 1)}>
            {cursorRestartRequired ? "Return to first page" : "Try again"}
          </Button>
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

      {favoritesStatus ? <p role="status">{favoritesStatus}</p> : null}
      {favoritesError ? <InlineMessage tone="error" title="Favorites could not be saved">{favoritesError}</InlineMessage> : null}
      {collectionSuccess ? <InlineMessage tone="success" title="Items added to collection">{collectionSuccess}</InlineMessage> : null}
      {permalink.error || permalinkError ? <InlineMessage tone="warning" title="Media unavailable">{permalink.error || permalinkError}</InlineMessage> : null}
      {copyResult?.status === "failed" ? (
        <InlineMessage tone="error" title="Link was not copied">
          <span>Copy this address instead: <span className="media-copy-link-url">{copyResult.url}</span></span>
        </InlineMessage>
      ) : null}
      <p className="sr-only media-selection-status" role="status">{selectionStatus}</p>
      <p className="sr-only media-action-status" role="status">
        {copyResult?.status === "copied" ? `Link to ${copyResult.name} copied.` : ""}
      </p>
      <p className="sr-only" role="status">{viewerAnnouncement}</p>

      <div className="media-library-layout" aria-busy={requestPending}>
        <DropOverlay
          blocked={metadataDirty}
          canUpload={mayUpload && !metadataSaving && !replaceBusy && bulkSession === null}
          destination={libraryLabel}
          onFiles={(files) => routeChosenFiles(files)}
        >
          <div className="media-results">
          {/* Related results sits at the top of the results, closed, and stays mounted across
              loads, so its scan and cache are never restarted. */}
          {!audioLibrary ? <MediaMeaningResults identity={mediaIdentity} refreshRevision={attempt} query={location.query} loadMedia={loadMedia} loadCorpus={loadCorpus} disabled={inspectorDirty || metadataSaving || showUpload || bulkSession !== null} onSelect={asset => {
            if (inspectorDirty || metadataSaving || showUpload || bulkSession) return;
            setRelatedSelection({ context: selectionContext, asset });
            selectAsset(asset.id);
          }} /> : null}
          {requestPending && result ? (
            // Visual only: the result status below the grid announces the refresh.
            <div className="media-results-updating" aria-hidden="true">
              <Spinner size="xs" />
              <span>Updating results</span>
            </div>
          ) : null}
          {state.status === "loading" ? <MediaLoading /> : null}
          {result ? (
            <>
              {result.records.length > 0 ? (
              <MediaGrid
                  handleRef={gridRef}
                  inert={bulkSession !== null || activeImageViewer !== null}
                  header={(
                    <MediaRowHeader
                      fields={display.fields}
                      pageSelection={{
                        state: pageSelectionState(collectionAssets, pageAssets),
                        disabled: cardsLocked,
                        onChange: (checked) => changeCollectionSelection(setPageSelection(collectionSelection, pageAssets, checked)),
                      }}
                      sort={{
                        sort: location.query.sort,
                        direction: location.query.direction,
                        // The same write the Sort control makes: one list request, page 1.
                        onSortChange: (next) => writeLocation({ ...location, query: { ...location.query, ...next }, view: undefined }),
                      }}
                    />
                  )}
                  items={result.records}
                  label={libraryLabel}
                  layout={display.layout}
                  onEscape={escapeResults}
                  onOpen={openAsset}
                  onQuickLook={quickLookLocked ? undefined : openQuickLook}
                  onSelectionChange={changeCollectionSelection}
                  renderItem={renderTile}
                  selection={collectionSelection}
                />
              ) : result.paging === "cursor" && result.nextCursor ? (
                <EmptyState
                  title="Search continues"
                  description="Choose Next to check more items."
                />
              ) : result.paging === "cursor" && (result.page > 1 || (result.total ?? 0) > 0) ? (
                <EmptyState
                  title="No matches on this page"
                  description="Return to a previous page."
                />
              ) : (
                <EmptyState
                  title={location.query.q ? "No keyword matches" : "No media found"}
                  description="Change or clear the current filters."
                  action={
                    filtered ? (
                      // Clears the search, Type and Category; sort stays.
                      <Button onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              )}

              {result.paging === "cursor" ? <MediaResultBar
                filterLabels={filterChips(resultQuery, categoryLabel).map((chip) => chip.label)}
                keyword={Boolean(resultQuery.q)} page={result.page} pageCount={null}
                paging="cursor" refreshing={requestPending} total={result.total}
                isLastPage={!result.nextCursor} recordsOnPage={result.records.length}
                onFirst={() => changeCursorPage({ key: queryKey, previous: [] })}
                onPrevious={() => changeCursorPage({
                  key: queryKey,
                  cursor: previousCursors.at(-1),
                  previous: previousCursors.slice(0, -1),
                })}
                onNext={() => {
                  if (!result.nextCursor) return;
                  changeCursorPage({
                    key: queryKey,
                    cursor: result.nextCursor,
                    previous: [...previousCursors, cursor],
                  });
                }}
              /> : <MediaResultBar
                filterLabels={filterChips(resultQuery, categoryLabel).map((chip) => chip.label)}
                keyword={Boolean(resultQuery.q)} page={result.page} pageCount={result.pageCount}
                refreshing={requestPending} total={result.total}
                onPage={(page) => setLocation({ ...location.query, page }, null, false)}
              />}
            </>
          ) : null}
          {/* The selection bar floats at the bottom of the results while something is selected,
              so selecting never moves the grid under the pointer. */}
          <SelectionBar
            actions={mediaBarActions(imageSelectionActions())}
            actionsDisabled={dirty || metadataSaving || bulkSaving || favoritesSaving || showUpload || bulkSession !== null}
            allowActionWhileDisabled={allowBulkTransition}
            clearDisabled={selectionBusy}
            count={collectionAssets.length}
            info="Selection carries across media pages and filters."
            label="Collection selection"
            offPage={offPageCount(collectionAssets, pageAssets)}
            onAction={selectionAction}
            onClear={clearCollectionSelection}
            onPageChange={(checked) => changeCollectionSelection(setPageSelection(collectionSelection, pageAssets, checked))}
            pageDisabled={pageAssets.length === 0 || cardsLocked}
            pageState={pageSelectionState(collectionAssets, pageAssets)}
          />
          {mayUpload && uploadTrayStarted ? (
            <UploadTray
              announcement={uploadSummary}
              collapsed={uploadTrayCollapsed}
              onCollapsedChange={setUploadTrayCollapsed}
              onOpen={showUploadSheet}
              rows={uploadTrayRows}
              summary={uploadSummary}
            />
          ) : null}
          </div>
        </DropOverlay>

        {mayUpload ? (
          <UploadSheet
            dirty={uploadDirty}
            focusReturn={uploadOpener.current}
            heading={audioLibrary ? "Upload audio" : "Upload images and documents"}
            onFocusFallback={() => setUploadFocusRequest((value) => value + 1)}
            onDismiss={hideUpload}
            onRequestClose={requestCloseUpload}
            open={showUpload}
          >
            <MediaUploadForm
              autoFocusFileInput={false}
              key={`${userId}:${uploadFormGeneration}`}
              uploadScope={audioLibrary ? "audio" : "images-and-documents"}
              defaultCategory={uploadCategory}
              canOpenRecycleBin={hasCapability(principal, "media.manage")}
              librarySearch={searchParams.toString()}
              categories={categories}
              canUploadCategory={(category) => canUploadMedia(principal, category)}
              onBatchComplete={finishUploadBatch}
              onCancel={requestCloseUpload}
              onDirtyChange={setUploadDirty}
              onQueueChange={projectUploadQueue}
              incomingFiles={incomingLibrary}
              onUploaded={recordUploadedAsset}
              uploadMedia={uploadMedia}
              uploadController={uploadController}
              initialState={uploadFormGeneration === 0 ? initialUploadState : undefined}
            />
          </UploadSheet>
        ) : null}

        {bulkSession ? <MediaBulkInspector
          assets={bulkSession.assets}
          surface="images"
          open={!bulkSession.reviewing}
          reviewing={bulkSession.reviewing}
          focusRequest={bulkSession.focusRequest}
          pageTags={pageTags}
          recentTags={recentTags}
          offPageCount={offPageCount(bulkSession.assets, pageAssets)}
          onCancel={() => closeBulkSession()}
          onDirtyChange={setBulkInspectorDirty}
          onReview={draft => setBulkSession(previous => previous ? { ...previous, draft, reviewing: true } : null)}
        /> : selectedAsset && !showUpload ? (
          <MediaInspector
            key={selectedAsset.id}
            asset={selectedAsset}
            getIdToken={getIdToken}
            categories={categories}
            canEdit={canManageMediaMetadata(principal, selectedAsset.category)}
            deleteMedia={deleteMedia}
            onClose={() => selectAsset(null)}
            onOpenFullSize={() => openFullSize(selectedAsset)}
            onDeleted={finishDelete}
            onDirtyChange={setMetadataDirty}
            onSavingChange={setMetadataSaving}
            onReload={reloadSelectedAsset}
            onSaved={(asset) => {
              notice.show(`${asset.name} details saved.`);
              replaceAsset(asset);
            }}
            onSaveReceipt={receipt => offerImageSaveUndo(receipt)}
            onTagsSaved={(tags) => {
              recordRecentTags("images", tags, userId);
              setRecentTagsVersion((version) => version + 1);
            }}
            pageTags={pageTags}
            recentTags={recentTags}
            saveMetadata={saveMetadata}
            confirmDeleteRequest={deleteRequest?.id === selectedAsset.id ? deleteRequest.count : 0}
            onConfirmDeleteShown={() => setDeleteRequest(null)}
            replaceControl={selectedAsset.kind === "image" && selectedAsset.source === "upload" &&
              selectedAsset.lifecycle === "active" && canManageMediaMetadata(principal, selectedAsset.category) ? (
                <Suspense fallback={null}>
                  <MediaReplaceButton
                    asset={selectedAsset}
                    principal={principal}
                    librarySearch={searchParams.toString()}
                    getIdToken={getIdToken}
                    disabled={metadataDirty || metadataSaving}
                    onReplaced={replaceAsset}
                    onReload={reloadSelectedAsset}
                    onBusyChange={setReplaceBusy}
                  />
                </Suspense>
              ) : undefined}
            favoriteControl={(
              <MediaFavoriteButton
                name={selectedAsset.name}
                favorite={favorites.value({ backend: "r2", id: selectedAsset.id })}
                pending={favorites.pending({ backend: "r2", id: selectedAsset.id }) || favoritesSaving}
                onToggle={() => void favoriteUndo.toggle({ backend: "r2", id: selectedAsset.id }, selectedAsset.name)}
              />
            )}
          />
        ) : null}
      </div>

      {activeImageViewer && imageViewerAsset ? <ImageViewer
        asset={imageViewerAsset}
        getIdToken={getIdToken}
        steppingOrder={activeImageViewer.order}
        onStep={asset => {
          viewerGeneration.current += 1;
          setViewerReloading(false);
          setViewerReloadError("");
          setImageViewer(previous => previous?.userId === userId && previous.queryKey === queryKey ? { ...previous, id: asset.id } : previous);
        }}
        onClose={closeImageViewer}
        reloadBusy={viewerReloading}
        reloadError={viewerReloadError}
        navigationPrompt={blocker.state === "blocked" ? (
          <InlineMessage tone="warning" title="Unsaved media changes">
            <p>Leave this page without saving your changes?</p>
            <Button disabled={metadataSaving || viewerReloading} onClick={() => {
              viewerGeneration.current += 1;
              setImageViewer(null);
              setMetadataDirty(false);
              if (viewerNeedsReload.current) {
                viewerNeedsReload.current = false;
                invalidateMediaLists();
                restartList();
              }
              if (leavingMedia.current) onDiscardVideo?.();
              blocker.proceed();
            }}>Discard changes</Button>
            <Button ref={viewerNavigationKeep} onClick={() => {
              const opener = viewerNavigationOpener.current;
              blocker.reset();
              requestAnimationFrame(() => {
                const usable = opener?.isConnected && opener !== document.body &&
                  !(opener instanceof HTMLButtonElement && opener.disabled);
                const fallback = document.querySelector<HTMLElement>(".image-viewer-details:not([hidden]) .ui-inspector-section-body:not([hidden]) input:not([disabled])") ??
                  document.querySelector<HTMLElement>('.image-viewer-details:not([hidden]) button[aria-label="Close image details"]') ??
                  document.querySelector<HTMLElement>(".image-viewer-details-toggle") ??
                  document.querySelector<HTMLElement>(".image-viewer-settings input:not([disabled])") ??
                  document.querySelector<HTMLElement>(".image-viewer-settings button:not([disabled])");
                if (usable) opener.focus();
                else fallback?.focus();
              });
            }}>Keep editing</Button>
          </InlineMessage>
        ) : null}
        categories={categories}
        canEdit={canManageMediaMetadata(principal, imageViewerAsset.category)}
        deleteMedia={deleteMedia}
        onDeleted={finishViewerDelete}
        onDirtyChange={setMetadataDirty}
        onSavingChange={setMetadataSaving}
        onReload={reloadViewerAsset}
        onSaved={(asset) => {
          notice.show(`${asset.name} details saved.`);
          replaceViewerAsset(asset);
        }}
        onSaveReceipt={receipt => offerImageSaveUndo(receipt, true)}
        onTagsSaved={tags => {
          recordRecentTags("images", tags, userId);
          setRecentTagsVersion(version => version + 1);
        }}
        pageTags={pageTags}
        recentTags={recentTags}
        saveMetadata={saveMetadata}
        favorite={{
          name: imageViewerAsset.name,
          favorite: favorites.value({ backend: "r2", id: imageViewerAsset.id }),
          pending: favorites.pending({ backend: "r2", id: imageViewerAsset.id }) || favoritesSaving,
          onToggle: () => void favoriteUndo.toggle({ backend: "r2", id: imageViewerAsset.id }, imageViewerAsset.name),
        }}
      /> : null}

      {quickLook && quickLookAsset && quickLookDisplay ? <QuickLook item={{ id: quickLookAsset.id, name: quickLookAsset.name,
        kind: quickLookAsset.kind === "audio" ? "audio" : quickLookDisplay.kind === "image" ? "image" : "document",
        audio: quickLookAsset.kind === "audio" ? quickLookAsset : undefined,
        previewUrl: quickLookDisplay.kind === "image" ? quickLookDisplay.url : null,
        alt: quickLookDisplay.kind === "image" ? quickLookDisplay.alt : undefined,
        originalUrl: quickLookDisplay.kind === "placeholder" ? quickLookAsset.url : undefined }}
        position={quickLook.order.findIndex(item => item.id === quickLookAsset.id) + 1} count={quickLook.order.length}
        getIdToken={getIdToken} onStep={stepQuickLook} onClose={closeQuickLook} /> : null}

      {/* The native replacement dialog holds focus until the request settles. */}
      {blocker.state === "blocked" && !replaceBusy && !bulkSession?.reviewing && !activeImageViewer ? (
        <LeaveGuardDialog
          onConfirm={() => {
            uploadController.current?.abort();
            setMetadataDirty(false);
            setBulkInspectorDirty(false);
            setBulkReviewDirty(false);
            if (bulkSession) setBulkSession(null);
            discardUpload();
            if (leavingMedia.current) onDiscardVideo?.();
            blocker.proceed();
          }}
          onCancel={() => { setPendingBulkOpen(null); setPendingViewerOpen(null); blocker.reset(); }}
        />
      ) : null}
      {bulkSession?.reviewing && bulkSession.draft ? <SourceMediaBulkEditor
        surface="images"
        assets={[...bulkSession.assets]}
        canEdit={asset => canManageMediaMetadata(principal, asset.category)}
        getIdToken={getIdToken}
        initialDraft={bulkSession.draft}
        onBackToEditing={() => setBulkSession(previous => previous ? { ...previous, reviewing: false, focusRequest: previous.focusRequest + 1 } : null)}
        onClose={closeBulkSession}
        onDirtyChange={setBulkReviewDirty}
        onSavingChange={setBulkSaving}
        navigationBlocked={blocker.state === "blocked" && !bulkSaving}
        onKeepNavigation={() => { if (blocker.state === "blocked") blocker.reset(); }}
        onDiscardNavigation={() => {
          setBulkSession(null);
          setBulkReviewDirty(false);
          if (leavingMedia.current) onDiscardVideo?.();
          if (blocker.state === "blocked") blocker.proceed();
        }}
      /> : null}
      {pickerTarget ? <MediaCollectionPicker
        open
        userId={userId}
        refs={pickerRefs}
        getIdToken={getIdToken}
        onClose={() => setPickerTarget(null)}
        onOpenCollections={() => navigate(mediaCollectionsPath())}
        onAdded={collection => {
          const count = pickerTarget.assets.length;
          setPickerTarget(null);
          if (pickerTarget.bulk) setCollectionSelection(emptySelection());
          if (!notice.available) setCollectionSuccess(`${count} ${count === 1 ? "item was" : "items were"} added to ${collection.name}.`);
          requestAnimationFrame(returnFocus);
        }} /> : null}
    </section>
  );
}

function ImageMediaRoute({ audioLibrary = false, videoTransferActive = false, onDiscardVideo }: {
  audioLibrary?: boolean;
  videoTransferActive?: boolean;
  onDiscardVideo?: () => void;
}) {
  const { principal, user } = useShell();
  const { getIdToken } = useAuth();
  const [searchParams] = useSearchParams();
  const { state: categoryRegistry } = useMediaCategories();
  const loadCorpus = useCallback(async (request: MediaCorpusRequest) =>
    cmsListMediaCorpus(await getIdToken(), request), [getIdToken]);
  const loadMedia = useCallback(
    async (query: MediaListQuery, options?: { tabCounts?: boolean; signal?: AbortSignal }) => {
      const token = await getIdToken();
      const scopedQuery: MediaListQuery = audioLibrary ? { ...query, kinds: ["audio"] } : query;
      if (!options?.tabCounts) return cmsListMedia(token, scopedQuery, options?.signal);
      // Counts ride on this visible-page load only when the session has none or a write made
      // them stale; they are stripped before the list result reaches the list cache. The page's
      // favorite states ride along too, so the hearts need no second request after the list.
      return withMediaTabCounts(async withCounts => {
        const send = (favorites: boolean) => cmsListMedia(token, scopedQuery, options?.signal, { counts: withCounts, favorites });
        try {
          return await send(true);
        } catch (error) {
          // An older Function rejects the unknown flag; the favorites hook then asks separately.
          if (error instanceof HttpError && error.status === 400 && /favorites/i.test(error.message)) return send(false);
          throw error;
        }
      });
    },
    [getIdToken, audioLibrary],
  );
  const saveMetadata = useCallback(
    async (asset: MediaAssetSummary, metadata: UpdateMediaMetadata) => {
      const token = await getIdToken();
      return cmsUpdateMediaMetadata(token, asset, metadata);
    },
    [getIdToken],
  );
  const uploadMedia = useCallback(
    async (file: File, metadata: UploadMediaMetadata, signal: AbortSignal) => {
      const token = await getIdToken();
      return uploadMediaReusingDuplicates(token, file, metadata, signal);
    },
    [getIdToken],
  );
  const deleteMedia = useCallback(
    async (asset: MediaAssetSummary) => {
      const token = await getIdToken();
      return cmsDeleteMedia(token, asset);
    },
    [getIdToken],
  );

  return (
    <RequireCapability
      allowed={audioLibrary ? canUseAudioLibrary : canUseMediaLibrary}
      notice="The media library is not available for your account."
    >
      {categoryRegistry.status === "error" ? (
        <InlineMessage tone="error" title="Media categories could not be loaded">
          Labels will use category ids until the registry is available.
        </InlineMessage>
      ) : null}
      {!audioLibrary && searchParams.get("bin") === "1" ? <RequireCapability allowed={principal => hasCapability(principal, "media.manage")} notice="The recycle bin is not available for your account.">
        <Suspense fallback={<LoadingIndicator label="Loading the recycle bin" />}>
          <MediaRecycleBin key={`${user.uid}:${JSON.stringify(principal)}`} getIdToken={getIdToken} categories={categoryRegistry.categories} targetId={searchParams.get("binAsset")} />
        </Suspense>
      </RequireCapability> : <MediaLibrarySurface
        key={`${audioLibrary}:${user.uid}:${JSON.stringify(principal)}`}
        audioLibrary={audioLibrary}
        principal={principal}
        userId={user.uid}
        getIdToken={getIdToken}
        categories={categoryRegistry.categories}
        deleteMedia={deleteMedia}
        loadMedia={loadMedia}
        loadCorpus={loadCorpus}
        saveMetadata={saveMetadata}
        uploadMedia={uploadMedia}
        onAllCountChange={audioLibrary ? undefined : setMediaImagesCount}
        videoTransferActive={videoTransferActive}
        onDiscardVideo={onDiscardVideo}
      />}
    </RequireCapability>
  );
}

export function MediaRoute({
  loadSecondaryModule = loadMediaSecondaryModule,
  reloadDocument = reloadMediaDocument,
}: {
  loadSecondaryModule?: MediaSecondaryLoader;
  reloadDocument?: () => void;
} = {}) {
  const notice = useSuccessNotice();
  const { principal, user, userDoc } = useShell();
  const { getIdToken } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const parsedRoute = parseMediaWorkspacePath(location.pathname);
  const entryPath = canUseMediaLibrary(principal) ? mediaImagesPath() : mediaVideosPath();
  const mediaRoute = parsedRoute.kind === "entry"
    ? parseMediaWorkspacePath(entryPath)
    : parsedRoute;
  useEffect(() => {
    if (parsedRoute.kind === "entry") {
      navigate({ pathname: entryPath, search: entryPath === mediaImagesPath() ? location.search : "" }, { replace: true });
    }
  }, [entryPath, location.search, navigate, parsedRoute.kind]);
  const [sources, setSources] = useState<MediaSourceSummary[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourcesResolved, setSourcesResolved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const needsVideoSources = mediaRoute.kind === "videos";
  const routedUploads = useSyncExternalStore(subscribeUploadRouter, uploadRouterSnapshot);
  const [routedLibraryDirty, setRoutedLibraryDirty] = useState(false);
  const [routedVideoActive, setRoutedVideoActive] = useState(false);
  const [routedVideoListRevision, setRoutedVideoListRevision] = useState({ sourceId: "", revision: 0 });
  const DeferredMediaSecondarySurface = useMemo(
    () => createMediaSecondarySurface(loadSecondaryModule),
    [loadSecondaryModule],
  );
  const routedLibraryDirtyRef = useRef(false);
  const workspaceUploadRef = useRef<HTMLButtonElement>(null);
  const restoreUploadFocus = useRef(false);
  const focusWorkspaceUpload = useCallback(() => {
    restoreUploadFocus.current = true;
  }, []);
  useEffect(() => {
    if (routedUploads.librarySession || !restoreUploadFocus.current) return;
    restoreUploadFocus.current = false;
    requestAnimationFrame(() => {
      const upload = workspaceUploadRef.current
        ?? document.querySelector<HTMLButtonElement>('.media-workspace button[aria-label="Upload media"]:not([disabled])');
      upload?.focus();
    });
  }, [mediaRoute.kind, routedUploads.librarySession]);
  const reportRoutedLibraryDirty = useCallback((dirty: boolean) => {
    routedLibraryDirtyRef.current = dirty;
    setRoutedLibraryDirty(dirty);
  }, []);
  const hasRoutedLibraryRisk = useCallback(() => routedLibraryDirtyRef.current, []);
  // Tab counts live in the session cache. They arrive only on the Images list or video sources
  // call this page already makes, and an account change clears them before this render reads.
  setMediaCachePrincipal(user.uid, JSON.stringify(principal));
  const tabCounts = useSyncExternalStore(subscribeMediaTabCounts, mediaTabCounts);
  useEffect(() => {
    if (!needsVideoSources) {
      setSourcesResolved(false);
      return;
    }
    let current = true;
    setLoading(true);
    setSourcesResolved(false);
    setSourceError("");
    listMediaSourcesFromSession();
    async function listMediaSourcesFromSession() {
      try {
        const token = await getIdToken();
        const result = await withMediaTabCounts(withCounts => withCounts
          ? listMediaSources(token, { counts: true })
          : listMediaSources(token));
        if (current) {
          setSources(result.sources);
          setSourcesResolved(true);
        }
      } catch {
        if (current) { setSources([]); setSourceError("Video sources could not be loaded."); }
      } finally {
        if (current) setLoading(false);
      }
    }
    return () => { current = false; };
  }, [getIdToken, attempt, needsVideoSources]);

  const requestedSourceId = mediaRoute.kind === "videos" ? mediaRoute.sourceId : null;
  const source = mediaRoute.kind === "videos"
    ? requestedSourceId
      ? sources.find(item => item.id === requestedSourceId)
      : sources[0]
    : undefined;

  useEffect(() => {
    if (
      mediaRoute.kind !== "videos" ||
      !mediaRoute.sourceId ||
      !sourcesResolved ||
      loading ||
      sourceError ||
      source
    ) return;
    navigate(mediaVideosPath(), { replace: true });
  }, [loading, mediaRoute, navigate, source, sourceError, sourcesResolved]);

  if (mediaRoute.kind === "not-found") {
    return <Navigate to={mediaLibraryPath()} replace />;
  }
  if (mediaRoute.kind === "images" && !canUseMediaLibrary(principal)) {
    if (new URLSearchParams(location.search).has("asset")) {
      return <InlineMessage tone="warning" title="Media unavailable">{unavailableMediaMessage}</InlineMessage>;
    }
    return <Navigate to={mediaVideosPath()} replace />;
  }

  // The current tab follows the route kind and source id, never a path prefix, so Collections
  // stays current on a collection and a custom source is current only once its tab exists.
  // Collections has no count. A missing key shows no count: never 0 and never a spinner.
  const tabs = mediaTabs({
    canUseImages: canUseMediaLibrary(principal),
    canReviewSubmissions: canReviewUgcSubmissions(principal),
    sources,
    counts: {
      ...tabCounts.sources,
      images: tabCounts.images,
      voiceovers: tabCounts.audio,
      favorites: tabCounts.favorites,
    },
  });
  // Images and an uploadable video source already have an upload control. Other tabs use
  // the shared control. It stays hidden while a video source list is still loading, so the
  // page does not flash a second button before the video panel arrives.
  const videoPagePending = mediaRoute.kind === "videos" && !sourceError && (loading || !sourcesResolved);
  const videoUploadOnPage = mediaRoute.kind === "videos" && Boolean(source?.canUpload) && !routedUploads.videoSession;
  const showWorkspaceUpload = hasCapability(principal, "media.upload")
    && mediaRoute.kind !== "images" && mediaRoute.kind !== "voiceovers"
    && mediaRoute.kind !== "submissions"
    && !routedUploads.videoSession
    && !videoUploadOnPage
    && !videoPagePending
    && !(mediaRoute.kind === "videos" && Boolean(sourceError));
  const secondaryBoundaryKey = mediaRoute.kind === "videos"
    ? `videos:${mediaRoute.sourceId ?? "default"}`
    : mediaRoute.kind;
  const deferredGuardProps = {
    libraryDirty: routedLibraryDirty || Boolean(routedUploads.librarySession),
    videoActive: routedVideoActive || Boolean(routedUploads.videoSession),
    onDiscardLibrary: () => { reportRoutedLibraryDirty(false); finishLibraryUpload(); },
    onDiscardVideo: () => finishVideoUpload(),
  };
  const secondaryReloadBlocked = deferredGuardProps.libraryDirty || deferredGuardProps.videoActive;
  return <RequireCapability allowed={canAccessMediaWorkspace} notice="The media workspace is not available for your account.">
    <div className="media-workspace">
      <div className="media-workspace-bar">
        <MediaTabs tabs={tabs} currentId={currentMediaTabId(mediaRoute, sources)} />
        {showWorkspaceUpload ? <WorkspaceUploadButton buttonRef={workspaceUploadRef} secondary={mediaRoute.kind === "collections"} /> : null}
      </div>
      {routedUploads.rejected.length > 0 ? <InlineMessage tone="error" title="Some files were not added">
        <ul className="media-upload-intake-errors">
          {routedUploads.rejected.map((name, index) => (
            <li key={`${name}-${index}`}>
              <strong>{name}</strong>: <span>{UNSUPPORTED_UPLOAD_MESSAGE}</span>
            </li>
          ))}
        </ul>
        <Button onClick={clearRejectedUploads}>Dismiss</Button>
      </InlineMessage> : null}
      {routedUploads.librarySession ? <RoutedLibraryUpload
        guardNavigation={mediaRoute.kind === "images" || (mediaRoute.kind === "videos" && !source)}
        onClose={focusWorkspaceUpload}
        reportDirty={reportRoutedLibraryDirty}
        videoSession={routedUploads.videoSession}
      /> : null}
      {routedUploads.videoSession && !videoUploadOnPage ? <RoutedVideoUpload onActiveChange={setRoutedVideoActive} onDestinationUpdated={(sourceId) => {
        setRoutedVideoListRevision(previous => ({
          sourceId,
          revision: previous.sourceId === sourceId ? previous.revision + 1 : 1,
        }));
      }} onAdmissionFailed={(message) => {
        notice.show(message, { tone: "error" });
        if (!routedVideoActive) finishVideoUpload();
      }} /> : null}
      {sourceError && needsVideoSources ? <InlineMessage tone="error" title="Video sources unavailable">{sourceError}<Button onClick={() => setAttempt(value => value + 1)}>Try again</Button></InlineMessage> : null}
      <MediaSecondaryLoadBoundary
        key={secondaryBoundaryKey}
        fallback={<>
          <InlineMessage tone="error" title="Media workspace unavailable">
            <p>This media workspace could not be loaded.</p>
            {secondaryReloadBlocked ? <p>Finish or cancel the current upload before reloading this page.</p> : null}
            <Button disabled={secondaryReloadBlocked} onClick={reloadDocument}>Reload page</Button>
          </InlineMessage>
          <DeferredMediaTransferGuard {...deferredGuardProps} />
        </>}
      >
        <Suspense fallback={<>
          <LoadingIndicator label="Loading media workspace" />
          <DeferredMediaTransferGuard {...deferredGuardProps} />
        </>}>
          {routedUploads.librarySession && mediaRoute.kind === "images" ? null
          : mediaRoute.kind === "submissions" ? <DeferredMediaSecondarySurface kind="submissions" />
          : mediaRoute.kind === "favorites" ? <DeferredMediaSecondarySurface
            kind="favorites"
            principal={principal}
            userId={user.uid}
            getIdToken={getIdToken}
            extraExitRisk={routedLibraryDirty || routedUploads.librarySession}
            videoTransferActive={routedVideoActive || routedUploads.videoSession}
            onDiscardExtra={() => { reportRoutedLibraryDirty(false); finishLibraryUpload(); }}
            onDiscardVideo={() => finishVideoUpload()}
          />
          : mediaRoute.kind === "collections" ? <DeferredMediaSecondarySurface
            key={user.uid}
            kind="collections"
            collectionId={mediaRoute.collectionId}
            principal={principal}
            userId={user.uid}
            userDoc={userDoc}
            getIdToken={getIdToken}
            extraExitRisk={routedLibraryDirty || routedUploads.librarySession}
            videoTransferActive={routedVideoActive || routedUploads.videoSession}
            onDiscardExtra={() => { reportRoutedLibraryDirty(false); finishLibraryUpload(); }}
            onDiscardVideo={() => finishVideoUpload()}
          />
          : mediaRoute.kind === "images" || mediaRoute.kind === "voiceovers" ? <ImageMediaRoute
            audioLibrary={mediaRoute.kind === "voiceovers"}
            videoTransferActive={routedVideoActive || routedUploads.videoSession}
            onDiscardVideo={() => finishVideoUpload()}
          />
          : source && sourcesResolved && !loading && !sourceError ? <DeferredMediaSecondarySurface
            kind="source"
            principal={principal}
            key={`${source.id}:${user.uid}:${JSON.stringify(principal)}`}
            source={source}
            getIdToken={getIdToken}
            userId={user.uid}
            extraExitRisk={routedLibraryDirty || routedUploads.librarySession}
            routedLibraryActive={routedUploads.librarySession}
            routedRejectedFiles={routedUploads.rejected}
            routedUploadRevision={routedVideoListRevision.sourceId === source.id ? routedVideoListRevision.revision : 0}
            routedVideoActive={routedVideoActive || routedUploads.videoSession}
            suppressUpload={routedUploads.videoSession}
            hasExtraExitRisk={hasRoutedLibraryRisk}
            onDiscardExtra={() => { reportRoutedLibraryDirty(false); finishLibraryUpload(); }}
            onDiscardVideo={() => finishVideoUpload()}
          />
          : loading ? <LoadingIndicator label="Loading media sources" />
          : !sourceError ? <EmptyState title="No video sources available" description="Your staff account has no enabled video sources yet." /> : null}
        </Suspense>
      </MediaSecondaryLoadBoundary>
      {routedUploads.videoSession && !routedUploads.librarySession && !(
        mediaRoute.kind === "images"
        || mediaRoute.kind === "favorites"
        || mediaRoute.kind === "collections"
        || mediaRoute.kind === "voiceovers"
        || mediaRoute.kind === "submissions"
        || (mediaRoute.kind === "videos" && Boolean(source) && !sourceError && !loading)
      ) ? <RoutedVideoLeaveGuard /> : null}
    </div>
  </RequireCapability>;
}

function DeferredMediaTransferGuard({
  libraryDirty,
  videoActive,
  onDiscardLibrary,
  onDiscardVideo,
}: {
  libraryDirty: boolean;
  videoActive: boolean;
  onDiscardLibrary: () => void;
  onDiscardVideo: () => void;
}) {
  const libraryDirtyRef = useRef(libraryDirty);
  const videoActiveRef = useRef(videoActive);
  libraryDirtyRef.current = libraryDirty;
  videoActiveRef.current = videoActive;
  const hasUnsavedWork = useCallback(
    () => libraryDirtyRef.current || videoActiveRef.current,
    [],
  );
  const hasRisk = libraryDirty || videoActive;
  useRegisterExitGuard(hasRisk ? { saving: false, hasUnsavedWork } : null);
  useBeforeUnload((event) => {
    if (!hasRisk) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const discardLibrary = useRef(false);
  const discardVideo = useRef(false);
  const blocker = useBlocker(({ nextLocation }) => {
    const nextRoute = parseMediaWorkspacePath(nextLocation.pathname);
    const leavesWorkspace = nextRoute.kind === "not-found";
    const opensRecycleBin = nextRoute.kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardLibrary.current = libraryDirty && (leavesWorkspace || opensRecycleBin);
    discardVideo.current = videoActive && leavesWorkspace;
    return discardLibrary.current || discardVideo.current;
  });
  if (blocker.state !== "blocked") return null;
  return <LeaveGuardDialog
    onConfirm={() => {
      if (discardLibrary.current) onDiscardLibrary();
      if (discardVideo.current) onDiscardVideo();
      blocker.proceed();
    }}
    onCancel={() => blocker.reset()}
  />;
}

function RoutedVideoLeaveGuard() {
  const blocker = useBlocker(({ nextLocation }) => {
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    return kind === "not-found";
  });
  useBeforeUnload((event) => {
    event.preventDefault();
    event.returnValue = "";
  });
  const hasUnsavedWork = useCallback(() => true, []);
  useRegisterExitGuard({ saving: false, hasUnsavedWork });
  if (blocker.state !== "blocked") return null;
  return <LeaveGuardDialog
    onConfirm={() => {
      finishVideoUpload();
      blocker.proceed();
    }}
    onCancel={() => blocker.reset()}
  />;
}

function RoutedLibraryUpload({ guardNavigation, onClose, reportDirty, videoSession }: {
  guardNavigation: boolean;
  onClose: () => void;
  reportDirty: (dirty: boolean) => void;
  videoSession: boolean;
}) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const notice = useSuccessNotice();
  const locationRef = useRef(location);
  const noticeRef = useRef(notice);
  locationRef.current = location;
  noticeRef.current = notice;
  const { principal } = useShell();
  const { getIdToken } = useAuth();
  const { state: categoryRegistry } = useMediaCategories();
  const [incoming, setIncoming] = useState<readonly File[] | null>(null);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const updateDirty = useCallback((dirty: boolean) => {
    setUploadDirty(dirty);
    reportDirty(dirty);
  }, [reportDirty]);
  useBeforeUnload((event) => {
    if (!uploadDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const receiveRef = useRef<(files: readonly File[]) => void>(() => {});
  receiveRef.current = setIncoming;
  useEffect(() => registerLibraryUpload((files) => receiveRef.current(files)), []);
  const uploadMedia = useCallback(async (file: File, metadata: UploadMediaMetadata, signal: AbortSignal) => {
    return uploadMediaReusingDuplicates(await getIdToken(), file, metadata, signal);
  }, [getIdToken]);
  function closeRoutedLibrary() {
    setIncoming(null);
    setUploadDirty(false);
    reportDirty(false);
    finishLibraryUpload();
    onClose();
  }
  if (categoryRegistry.status === "loading") return <LoadingIndicator label="Opening media uploads" />;
  if (categoryRegistry.status === "error") {
    return <InlineMessage tone="error" title="Media files were not routed">The media categories could not be loaded. <Button onClick={closeRoutedLibrary}>Dismiss</Button></InlineMessage>;
  }
  if (!incoming?.length) return null;
  const uploadCategory = authorizedMediaUploadCategory(principal, categoryRegistry.categories);
  if (!uploadCategory) {
    return <InlineMessage tone="warning" title="Media files were not routed">Your account cannot upload media files. <Button onClick={closeRoutedLibrary}>Dismiss</Button></InlineMessage>;
  }
  return <>
    <MediaUploadForm
      categories={categoryRegistry.categories}
      canOpenRecycleBin={hasCapability(principal, "media.manage")}
      librarySearch={parseMediaWorkspacePath(location.pathname).kind === "images" ? searchParams.toString() : ""}
      canUploadCategory={(category) => canUploadMedia(principal, category)}
      defaultCategory={uploadCategory}
      incomingFiles={incoming}
      onCancel={() => {
        if (uploadDirty) setConfirmClose(true);
        else closeRoutedLibrary();
      }}
      onDirtyChange={updateDirty}
      onBatchComplete={(receipt) => {
        invalidateMediaLists();
        if (parseMediaWorkspacePath(locationRef.current.pathname).kind === "images") return;
        const audioOnly = receipt.succeeded.every(asset => asset.kind === "audio");
        const mixed = !audioOnly && receipt.succeeded.some(asset => asset.kind === "audio");
        const destination = audioOnly ? "Audio" : mixed ? "Images and Audio" : "Images";
        const path = audioOnly ? mediaVoiceoversPath() : mediaImagesPath();
        const message = routedBatchNotice(
          destination,
          "file",
          receipt.succeeded.map((asset) => ({ name: asset.name, outcome: "ready" as const })),
        );
        if (!message) return;
        const token = currentLibraryEpoch();
        noticeRef.current.show(message, {
          action: {
            label: `Open ${audioOnly ? "Audio" : "Images"}`,
            onClick: () => {
              navigate(path);
              if (currentLibraryEpoch() !== token) return;
              reportDirty(false);
              finishLibraryUpload();
            },
          },
        });
      }}
      onUploaded={() => {
        invalidateMediaLists();
      }}
      uploadMedia={uploadMedia}
    />
    {guardNavigation ? <RoutedLibraryLeaveGuard
      dirty={uploadDirty || videoSession}
      onDiscard={() => { closeRoutedLibrary(); finishVideoUpload(); }}
    /> : null}
    {confirmClose ? <LeaveGuardDialog
      onConfirm={closeRoutedLibrary}
      onCancel={() => setConfirmClose(false)}
    /> : null}
  </>;
}

function RoutedLibraryLeaveGuard({ dirty, onDiscard }: {
  dirty: boolean;
  onDiscard: () => void;
}) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const hasUnsavedWork = useCallback(() => dirtyRef.current, []);
  useRegisterExitGuard(dirty ? { saving: false, hasUnsavedWork } : null);
  const blocker = useBlocker(({ nextLocation }) => {
    const nextRoute = parseMediaWorkspacePath(nextLocation.pathname);
    const opensRecycleBin = nextRoute.kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    return dirty && (opensRecycleBin || nextRoute.kind === "not-found");
  });
  return blocker.state === "blocked" ? <LeaveGuardDialog
    onConfirm={() => { onDiscard(); blocker.proceed(); }}
    onCancel={() => blocker.reset()}
  /> : null;
}

function RoutedVideoUpload({ onActiveChange, onAdmissionFailed, onDestinationUpdated }: {
  onActiveChange: (active: boolean) => void;
  onAdmissionFailed: (message: string) => void;
  onDestinationUpdated: (sourceId: string) => void;
}) {
  const navigate = useNavigate();
  const notice = useSuccessNotice();
  const { user } = useShell();
  const { getIdToken } = useAuth();
  const [destination, setDestination] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState("");
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const moreWork = useRef(false);
  const readyNames = useRef<string[]>([]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await listMediaSources(await getIdToken());
        if (!alive) return;
        const source = uploadableSharedVideoSource(result.sources);
        if (!source) setError("Video uploads are not available.");
        else setDestination({ id: source.id, label: source.label });
      } catch {
        if (alive) setError("Video upload could not find a library.");
      }
    })();
    return () => { alive = false; };
  }, [getIdToken, discoveryAttempt]);
  if (error) return <InlineMessage tone="error" title="Video was not routed">{error} <Button onClick={() => { setError(""); setDiscoveryAttempt(attempt => attempt + 1); }}>Retry</Button> <Button onClick={finishVideoUpload}>Dismiss</Button></InlineMessage>;
  if (!destination) return <LoadingIndicator label="Opening Videos" />;
  return <VideoUploadPanel
    sourceId={destination.id}
    userId={user.uid}
    getIdToken={getIdToken}
    onActiveChange={onActiveChange}
    onAdmissionFailed={onAdmissionFailed}
    onOwnershipUnavailable={() => setError("Uploads are unavailable in this browser. The selected video was not added.")}
    onMoreWork={(more) => { moreWork.current = more; }}
    onTransferStopped={(note) => {
      if (moreWork.current) return;
      const names = readyNames.current;
      readyNames.current = [];
      if (names.length === 0) {
        if (note) notice.show(note, { tone: "error" });
        finishVideoUpload();
        return;
      }
      const summary = names.length === 1
        ? `${names[0]} is in ${destination.label}.`
        : `${names.length} videos are in ${destination.label}.`;
      const message = note ? `${summary} ${note}` : summary;
      notice.show(message, {
        action: {
          label: `Open ${destination.label}`,
          onClick: () => navigate(mediaVideosPath(destination.id)),
        },
      });
      finishVideoUpload();
    }}
    onUploaded={(asset) => {
      setMediaSourceCount(destination.id, null);
      onDestinationUpdated(destination.id);
      readyNames.current = [...readyNames.current, asset.name];
      const names = readyNames.current;
      const message = names.length === 1
        ? `${asset.name} is in ${destination.label}.`
        : `${names.length} videos are in ${destination.label}.`;
      if (moreWork.current) {
        notice.show(`${asset.name} is in ${destination.label}.`);
        return;
      }
      readyNames.current = [];
      notice.show(message, {
        action: {
          label: `Open ${destination.label}`,
          onClick: () => navigate(mediaVideosPath(destination.id)),
        },
      });
      finishVideoUpload();
    }}
  />;
}

// Preserve existing voiceover bookmarks inside the shared media workspace.
export function VoiceoverMediaRoute() {
  const location = useLocation();
  return <Navigate to={{ pathname: mediaVoiceoversPath(), search: location.search }} replace />;
}

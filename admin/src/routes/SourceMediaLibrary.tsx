import { originalAccessMessage, originalStatusLabel } from "../lib/video-original";
import { useVideoOriginalStatus, VideoOriginalStatus, VideoOriginalNotices } from "../components/media/VideoOriginalStatus";
import { focusMediaDialogNavigation, mediaDialogNavigation } from "../components/media/MediaViewerNavigation";
import { ActionControl } from "../components/ui/ActionControl";
import { Menu } from "../components/ui/Menu";
import { createPortal } from "react-dom";
import { MediaPreviewHeaderActions, type MediaPreviewHeaderActionsProps } from "../components/media/MediaPreviewHeaderActions";
import { formatMediaDuration, formatMediaUpdated, formatVideoBytes } from "../lib/media-format";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { useBeforeUnload, useBlocker, useLocation, useNavigate, useSearchParams } from "react-router";
import { useVideoProductionTools } from "../components/VideoProductionTools";
import { MediaDialogNotice } from "../context/MediaDialogContext";
import { VideoMeaningSearch } from "../components/VideoMeaningSearch";
import { useSourceMediaBulkEditing } from "../components/SourceMediaBulkEditor";
import { VideoUploadPanel } from "../components/VideoUploadPanel";
import { VideoReplaceButton } from "../components/media/VideoReplaceButton";
import { VideoOrientationExport, useVideoExportCompletion } from "../components/media/VideoOrientationExport";
import { ComponentEditorDialog } from "../components/ComponentEditorDialog";
import { Icon } from "../components/ui/Icon";
import { Button, EmptyState, InlineMessage } from "../components/ui/Primitives";
import { useMediaQuery } from "../components/ui/floating";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { createSourceMediaRead, listSourceMedia, updateSourceMediaMetadata, type MediaSourceSummary, type SourceMediaAssetSummary, type SourceMediaPage, type SourceMediaRead, type SourceMediaQuery, type SourceMediaStatusPage } from "../lib/source-media";
import { useMediaProcessingPoll } from "../lib/use-media-processing-poll";
import { boundedMediaTime, mediaPermalink, parseMediaPermalink, unavailableMediaMessage } from "../lib/media-permalink";
import { mediaVideosPath } from "../lib/routes";
import { HttpError, type MediaSortDirection, type MediaSortField } from "../lib/functions";
import { getVideoTranscript, type TranscriptSettings } from "../lib/video-production";
import { invalidateVideoSearchCorpus, updateCachedVideoSearchAsset } from "../lib/video-search-session-cache";
import { cachedPoster, cachePoster, invalidatePoster, mediaListRevision, setMediaCachePrincipal, setMediaCacheUser, setMediaSourceCount } from "../lib/media-session-cache";
import { useRegisterExitGuard } from "./ExitGuard";
import { parseMediaWorkspacePath } from "../lib/routes";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useMediaFavorites } from "../lib/use-media-favorites";
import type { MediaFavoriteRef } from "../lib/media-favorites";
import { MediaContextMenu } from "../components/media/MediaContextMenu";
import { MediaGrid, restoreMediaFocus, type MediaGridHandle, type MediaGridItemContext } from "../components/media/MediaGrid";
import { MediaRow, MediaRowHeader } from "../components/media/MediaRow";
import { MediaTile } from "../components/media/MediaTile";
import { ViewerTabs } from "../components/media/ViewerTabs";
import { VideoDetailsInspector, type VideoContextView, type VideoDetailsSaveReceipt } from "../components/media/VideoDetailsInspector";
import { MediaCommentTimeline, placedComments } from "../components/media/MediaCommentTimeline";
import { VideoReviewSeek } from "../components/media/VideoReviewSeek";
import type { CommentTiming } from "../components/media/MediaFeedbackSections";
import { useMediaFeedback } from "../lib/use-media-feedback";
import { commentThreads, filteredTimelineComments } from "../lib/media-comment-threads";
import type { MediaComment } from "../lib/media-feedback";
import { commentFrameRate, frameAtPresentationTime, frameAtSeconds, seekSecondsForFrame, type CommentTimeDraft } from "../lib/media-comment-time";
import { QuickLook } from "../components/media/QuickLook";
import { quickLookPoster } from "../lib/media-quick-look";
import { SOURCE_MEDIA_FILE_CHANGED_EVENT, refreshedSourceMediaAsset, sourceMediaStatusMatches, useSourceMediaAssetRefresh } from "../lib/use-source-media-asset-refresh";
import { toggleSelection } from "../lib/media-selection";
import { selectionAnnouncement } from "../lib/media-filters";
import { availableSelectionActions, type MediaTileActionId } from "../lib/media-tile-actions";
import { readRecentTags, recordRecentTags } from "../lib/recent-media-tags";
import { stepPosition, stepTarget, viewerKeyAction, type StepDirection } from "../lib/media-step";
import { MediaToolbar, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import { MediaPaging } from "../components/media/MediaPaging";
import { DropOverlay } from "../components/media/DropOverlay";
import { UploadSheet } from "../components/media/UploadSheet";
import { DEFAULT_VIDEO_MEDIA_QUERY, parseVideoMediaLocation, encodeVideoMediaLocation, type VideoMediaLocationQuery, type VideoMediaSort } from "../lib/media-query";
import { clearVideoFilterChips, setVideoStructuredFilter, videoFilterChips, type VideoStructuredFilter } from "../lib/media-filters";
import { useMediaDisplay } from "../lib/use-media-display";
import type { SavedMediaView } from "../lib/saved-media-views";
import { DEFAULT_VIDEO_MEDIA_DISPLAY, VIDEO_MEDIA_CARD_FIELD_ORDER, type VideoMediaCardField, type VideoMediaDisplayPreferences } from "../lib/media-display";
import { hasCapability } from "../../../packages/content-core/src/rbac";
import { mediaShortcutBlocked } from "../lib/media-search";
import { splitUploadFiles } from "../lib/upload-destination";
import { routeChosenFiles } from "../lib/upload-router";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";
import { useFavoriteUndo } from "../lib/use-favorite-undo";
import { useClearFilterUndo } from "../lib/use-clear-filter-undo";
import "./SourceMediaLibrary.css";

const MAX_POSTER_READS = 4;
const ACCESS_RENEWAL_LEAD_MS = 30_000;
const VIDEO_CONTEXT_MIN_PERCENT = 30;
const VIDEO_CONTEXT_MAX_PERCENT = 70;
const VIDEO_CONTEXT_STEP_PERCENT = 2;
const VIDEO_CONTEXT_WIDTH_KEY = "cms.video-viewer.context-width";
const VIDEO_PANE_MIN_REM = 18;
const VIDEO_RESIZE_TRACK_PX = 44;
const VIDEO_SIDE_BY_SIDE_QUERY = "(min-width: 48.8125rem)";

interface VideoContextBounds { min: number; max: number }

function clampVideoContextWidth(value: number, bounds: VideoContextBounds = {
  min: VIDEO_CONTEXT_MIN_PERCENT,
  max: VIDEO_CONTEXT_MAX_PERCENT,
}): number {
  if (!Number.isFinite(value)) return 35;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)) * 4) / 4;
}

function videoPaneMinimumPixels(): number {
  if (typeof document === "undefined") return VIDEO_PANE_MIN_REM * 16;
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return VIDEO_PANE_MIN_REM * (Number.isFinite(rootSize) ? rootSize : 16);
}

function videoContextBounds(workspaceWidth: number, paneMinimum = videoPaneMinimumPixels()): VideoContextBounds {
  if (workspaceWidth <= 0) return { min: VIDEO_CONTEXT_MIN_PERCENT, max: VIDEO_CONTEXT_MAX_PERCENT };
  const min = Math.max(VIDEO_CONTEXT_MIN_PERCENT, paneMinimum / workspaceWidth * 100);
  const max = Math.min(VIDEO_CONTEXT_MAX_PERCENT,
    (workspaceWidth - VIDEO_RESIZE_TRACK_PX - paneMinimum) / workspaceWidth * 100);
  if (max < min) return { min: 50, max: 50 };
  const roundedMin = Math.ceil(min * 4) / 4;
  const roundedMax = Math.floor(max * 4) / 4;
  if (roundedMax >= roundedMin) return { min: roundedMin, max: roundedMax };
  // Rounding can cross bounds that only just fit; keep one consistent separator value.
  const only = Math.round((min + max) / 2 * 4) / 4;
  return { min: only, max: only };
}

function readVideoContextWidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(VIDEO_CONTEXT_WIDTH_KEY);
    if (raw === null || raw === undefined || raw.trim() === "") return undefined;
    return clampVideoContextWidth(Number(raw));
  } catch {
    return undefined;
  }
}

function storeVideoContextWidth(value: number) {
  try {
    globalThis.localStorage?.setItem(VIDEO_CONTEXT_WIDTH_KEY, String(value));
  } catch {
    // Blocked storage keeps the resized panes for this open viewer only.
  }
}

const TABBABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function tabbableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)]
    .filter(element => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"));
}

function stepVideoContextWidth(value: number, key: string, bounds: VideoContextBounds): number | null {
  if (key === "ArrowLeft") return clampVideoContextWidth(value - VIDEO_CONTEXT_STEP_PERCENT, bounds);
  if (key === "ArrowRight") return clampVideoContextWidth(value + VIDEO_CONTEXT_STEP_PERCENT, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}

function videoListSort(sort: VideoMediaSort): { sort: MediaSortField; direction: MediaSortDirection } {
  if (sort === "name_asc") return { sort: "name", direction: "asc" };
  if (sort === "size_desc") return { sort: "sizeBytes", direction: "desc" };
  if (sort === "size_asc") return { sort: "sizeBytes", direction: "asc" };
  return { sort: "updatedAt", direction: sort === "updated_asc" ? "asc" : "desc" };
}

function videoSortFromList(sort: MediaSortField, direction: MediaSortDirection): VideoMediaSort {
  if (sort === "name") return "name_asc";
  if (sort === "sizeBytes") return direction === "asc" ? "size_asc" : "size_desc";
  return direction === "asc" ? "updated_asc" : "updated_desc";
}

function posterObjectIdentity(value: string) {
  try {
    const url = new URL(value);
    const versionId = url.searchParams.get("versionId");
    return versionId ? JSON.stringify([url.origin, url.pathname, versionId]) : undefined;
  } catch {
    return undefined;
  }
}

function samePosterObject(left: string, right: string) {
  if (left === right) return true;
  const leftIdentity = posterObjectIdentity(left);
  return leftIdentity !== undefined && leftIdentity === posterObjectIdentity(right);
}

function sameTranscriptSelection(left: TranscriptSettings, right: TranscriptSettings) {
  return left.languageCode === right.languageCode && left.maxSpeakers === right.maxSpeakers && left.transcriptId === right.transcriptId;
}

interface PosterReadTask {
  cancelled: boolean;
  run: () => Promise<void>;
}

const posterReadQueue: PosterReadTask[] = [];
let activePosterReads = 0;

function drainPosterReadQueue() {
  while (activePosterReads < MAX_POSTER_READS && posterReadQueue.length > 0) {
    const task = posterReadQueue.shift();
    if (!task || task.cancelled) continue;
    activePosterReads += 1;
    void task.run().finally(() => {
      activePosterReads -= 1;
      drainPosterReadQueue();
    });
  }
}

function schedulePosterRead(run: () => Promise<void>) {
  const task = { cancelled: false, run };
  posterReadQueue.push(task);
  drainPosterReadQueue();
  return () => { task.cancelled = true; };
}

type PosterReadResult = { url: string } | { failed: true } | null;

interface SharedPosterRead {
  promise: Promise<PosterReadResult>;
  users: number;
  started: boolean;
  revision: number;
  /** Set when the viewing copy stops being ready: the late result is not cached. */
  stale: boolean;
  cancel: () => void;
}

// One current read per poster at a time. Switching View remounts every poster, so a read from
// the same source and list revision is shared instead of being sent again. A queued read that
// nothing waits for any longer is dropped before it is sent.
const posterReads = new Map<string, SharedPosterRead>();

function posterReadKey(asset: Pick<SourceMediaAssetSummary, "sourceId" | "id" | "fileVersion">) {
  return `${asset.sourceId}:${asset.id}:${asset.fileVersion ?? ""}`;
}

export function sharePosterRead(asset: SourceMediaAssetSummary, getIdToken: () => Promise<string>) {
  const requestRevision = mediaListRevision();
  const key = posterReadKey(asset);
  let entry = posterReads.get(key);
  if (entry && entry.revision !== requestRevision) {
    entry.stale = true;
    posterReads.delete(key);
    entry = undefined;
  }
  if (!entry) {
    let settle!: (result: PosterReadResult) => void;
    const created: SharedPosterRead = {
      promise: new Promise(resolve => { settle = resolve; }),
      users: 0,
      started: false,
      revision: requestRevision,
      stale: false,
      cancel: () => undefined,
    };
    created.cancel = schedulePosterRead(async () => {
      created.started = true;
      try {
        const requestedAt = Date.now();
        const access = await createVersionedSourceMediaRead(await getIdToken(), asset, "poster");
        if (created.stale || mediaListRevision() !== created.revision) { settle(null); return; }
        cachePoster(asset.sourceId, asset.id, access.url, access.expiresAt, requestedAt, asset.fileVersion);
        settle({ url: access.url });
      } catch {
        settle({ failed: true });
      } finally {
        if (posterReads.get(key) === created) posterReads.delete(key);
      }
    });
    posterReads.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.users += 1;
  let released = false;
  return {
    promise: shared.promise,
    release: () => {
      if (released) return;
      released = true;
      shared.users -= 1;
      if (shared.users === 0 && !shared.started) {
        shared.cancel();
        if (posterReads.get(key) === shared) posterReads.delete(key);
      }
    },
  };
}

function forgetPosterRead(asset: Pick<SourceMediaAssetSummary, "sourceId" | "id" | "fileVersion">) {
  const key = posterReadKey(asset);
  const entry = posterReads.get(key);
  if (!entry) return;
  entry.stale = true;
  posterReads.delete(key);
}

function canPlayInBrowser(asset: SourceMediaAssetSummary) {
  return asset.viewingCopy?.state === "ready" || asset.preview === "browser";
}

type QuickLookVideoSession = { order: readonly SourceMediaAssetSummary[]; id: string };

function refreshQuickLookViewingCopy(previous: QuickLookVideoSession | null, records: readonly (SourceMediaAssetSummary | SourceMediaStatusPage["records"][number])[]) {
  if (!previous) return previous;
  const refreshed = new Map(records.map(record => [record.id, record]));
  let changed = false;
  const order = previous.order.map(item => {
    const record = refreshed.get(item.id);
    if (!record) return item;
    if ("sourceId" in record) {
      const fresh = refreshedSourceMediaAsset(item, record);
      changed ||= fresh !== item;
      return fresh;
    }
    if (!sourceMediaStatusMatches(item, record) || JSON.stringify(record.viewingCopy) === JSON.stringify(item.viewingCopy)) return item;
    changed = true;
    return { ...item, viewingCopy: record.viewingCopy };
  });
  return changed ? { ...previous, order } : previous;
}

class SourceMediaFileChangedError extends Error {
  constructor() {
    super("This video's file changed. Its details are being refreshed. Save or discard any unsaved edits before trying again.");
  }
}

async function createVersionedSourceMediaRead(token: string, asset: SourceMediaAssetSummary, action: SourceMediaRead["action"]) {
  const access = await createSourceMediaRead(token, asset.sourceId, asset.id, action);
  if (asset.fileVersion && access.fileVersion && access.fileVersion !== asset.fileVersion) {
    window.dispatchEvent(new CustomEvent(SOURCE_MEDIA_FILE_CHANGED_EVENT, { detail: { sourceId: asset.sourceId, assetId: asset.id } }));
    throw new SourceMediaFileChangedError();
  }
  return access;
}

export function VideoPoster({ asset, getIdToken }: { asset: SourceMediaAssetSummary; getIdToken: () => Promise<string> }) {
  const frame = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [posterUrl, setPosterUrl] = useState<{ identity: string; url: string }>();
  const posterIdentity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
  const [posterFailed, setPosterFailed] = useState(false);
  const ready = asset.viewingCopy?.state === "ready";

  useEffect(() => {
    setPosterUrl(undefined);
    setPosterFailed(false);
    if (ready) return;
    invalidatePoster(asset.sourceId, asset.id, asset.fileVersion);
    forgetPosterRead(asset);
    setVisible(false);
  }, [asset.id, asset.sourceId, asset.fileVersion, ready]);

  useEffect(() => {
    if (!ready || !frame.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!ready || !visible) return;
    const cached = cachedPoster(asset.sourceId, asset.id, asset.fileVersion);
    if (cached) {
      setPosterUrl({ identity: posterIdentity, url: cached });
      return;
    }
    let current = true;
    const read = sharePosterRead(asset, getIdToken);
    void read.promise.then(result => {
      if (!current || !result) return;
      if ("url" in result) setPosterUrl({ identity: posterIdentity, url: result.url });
      else setPosterFailed(true);
    });
    return () => { current = false; read.release(); };
  }, [asset.id, asset.sourceId, asset.fileVersion, getIdToken, ready, visible]);

  return <span ref={frame} className="source-video-card-preview">
    {posterUrl?.identity === posterIdentity && !posterFailed ? <img src={posterUrl.url} alt="" loading="lazy" decoding="async" onError={() => { invalidatePoster(asset.sourceId, asset.id, asset.fileVersion); setPosterFailed(true); }} /> : <Icon name="video" />}
    {canPlayInBrowser(asset) ? <span className="source-video-play" aria-hidden="true"><Icon name="play" /></span> : null}
  </span>;
}

export interface VideoPreviewProps {
  sourceLabel?: string;
  principal?: Principal;
  /** A card menu's Delete from library opens the viewer at the existing confirmation. */
  initialConfirmDelete?: boolean;
  asset: SourceMediaAssetSummary;
  initialSeek?: number;
  onClose: () => void;
  getIdToken: () => Promise<string>;
  canEditMetadata: boolean;
  canReplace?: boolean;
  canExportOrientation?: boolean;
  canRequestProduction: boolean;
  canDelete: boolean;
  onDeleted: () => void;
  onUpdated: (asset: SourceMediaAssetSummary, videoSearchRevision?: number) => void;
  onSaveReceipt?: (receipt: VideoDetailsSaveReceipt) => void;
  onSaveSuccess?: (asset: SourceMediaAssetSummary) => void;
  onSearchContentChanged?: () => void;
  onExportStatus?: Parameters<typeof VideoOrientationExport>[0]["onStatus"];
  onTranscriptRequested?: (assetId: string, settings: TranscriptSettings, ready: boolean) => void;
  onTranscriptObserved?: (assetId: string, settings: TranscriptSettings) => void;
  onTranscriptReady?: (assetId: string, settings: TranscriptSettings) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  navigationBlocked: boolean;
  onDiscardNavigation: () => void;
  onKeepNavigation: () => void;
  favorite?: MediaPreviewHeaderActionsProps["favorite"];
  pageTags?: readonly string[];
  recentTags?: readonly string[];
  onTagsSaved?: (tags: readonly string[]) => void;
  preserveVideoSearchCache?: boolean;
  steppingOrder?: readonly SourceMediaAssetSummary[];
  onStep?: (asset: SourceMediaAssetSummary) => void;
  /** Viewer-only request guard; downloads and production are not unsaved edits. */
  onBusyChange?: (busy: boolean) => void;
}

export interface VideoViewerBodyProps extends Omit<VideoPreviewProps, "steppingOrder" | "onStep" | "onClose"> {
  closePrompt?: ReactNode;
  deleteConfirmationId: string;
  headerTarget: HTMLDivElement | null;
  factsTarget: HTMLSpanElement | null;
  footerTarget?: HTMLDivElement | null;
}

export function VideoViewerBody({
  initialSeek = 0,
  initialConfirmDelete = false,
  principal,
  asset,
  getIdToken,
  canEditMetadata,
  canReplace = false,
  canExportOrientation = false,
  canRequestProduction,
  canDelete,
  onDeleted,
  onUpdated,
  onSaveReceipt,
  onSaveSuccess,
  onSearchContentChanged,
  onExportStatus,
  onTranscriptRequested,
  onTranscriptObserved,
  onTranscriptReady,
  onDirtyChange,
  onSavingChange,
  onBusyChange,
  navigationBlocked,
  onDiscardNavigation,
  onKeepNavigation,
  favorite,
  pageTags = [],
  recentTags = [],
  onTagsSaved,
  preserveVideoSearchCache,
  closePrompt,
  deleteConfirmationId,
  headerTarget, factsTarget, footerTarget, sourceLabel,
}: VideoViewerBodyProps) {
  const [workspaceView, setWorkspaceView] = useState<"watch" | "transcript" | "comments">(initialConfirmDelete || initialSeek > 0 || asset.viewingCopy?.state !== "ready" ? "watch" : "transcript");
  const [contextView, setContextView] = useState<VideoContextView>("details");
  const workspaceId = useId();
  const contextId = `${workspaceId}-context`;
  const [commentsTarget, setCommentsTarget] = useState<HTMLDivElement | null>(null);
  const commentsBesidePlayer = useMediaQuery(VIDEO_SIDE_BY_SIDE_QUERY);
  const [splitPanesFit, setSplitPanesFit] = useState(true);
  const sideBySide = commentsBesidePlayer && splitPanesFit;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [contextWidth, setContextWidth] = useState<number | undefined>(readVideoContextWidth);
  const contextWidthRef = useRef(contextWidth);
  const preferredContextWidthRef = useRef(contextWidth);
  const [measuredContextWidth, setMeasuredContextWidth] = useState(contextWidth ?? 35);
  const [contextBounds, setContextBounds] = useState<VideoContextBounds>({ min: VIDEO_CONTEXT_MIN_PERCENT, max: VIDEO_CONTEXT_MAX_PERCENT });
  const contextWidthDrag = useRef<{ x: number; percent: number; workspaceWidth: number } | null>(null);
  const hasTranscriptPane = asset.sourceId === "video-library";
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [credentialsDirty, setCredentialsDirty] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [transcriptDirty, setTranscriptDirty] = useState(false);
  const [transcriptSaving, setTranscriptSaving] = useState(false);
  const [productionBusy, setProductionBusy] = useState(false);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const originalControls = useVideoOriginalStatus(asset, getIdToken, Boolean(principal && hasCapability(principal, "media.video.manage")));
  const showOriginalNotice = originalControls.noticeShown || ["archived", "restoring"].includes(originalControls.original?.state ?? "") || Boolean(originalControls.error);
  const [downloading, setDownloading] = useState<"download" | "download_web">();
  const busy = detailsSaving || transcriptSaving || credentialsBusy || replacementBusy;
  const dirty = detailsDirty || transcriptDirty || credentialsDirty;
  useSourceMediaAssetRefresh({ asset, getIdToken, onUpdated, blocked: busy || dirty || productionBusy || Boolean(downloading) });
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onSavingChange(busy);
    return () => onSavingChange(false);
  }, [onSavingChange, busy]);
  useEffect(() => {
    onBusyChange?.(busy || productionBusy || Boolean(downloading));
    return () => onBusyChange?.(false);
  }, [onBusyChange, busy, productionBusy, downloading]);
  const [access, setAccess] = useState<SourceMediaRead>();
  const [pendingAccess, setPendingAccess] = useState<SourceMediaRead>();
  const [error, setError] = useState("");
  const [timeMessage, setTimeMessage] = useState("");
  const [canRefreshPreview, setCanRefreshPreview] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [renewing, setRenewing] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const [naturalRatio, setNaturalRatio] = useState<number>();
  const feedback = useMediaFeedback({ backend: "s3", sourceId: asset.sourceId, id: asset.id }, getIdToken, asset.fileVersion);
  // Markers follow the comment filter, so resolved threads stay off the timeline until shown.
  // Times loaded for another file place nothing until the comments reload.
  const timelineComments = useMemo(
    () => feedback.commentTimesCurrent ? filteredTimelineComments(feedback.comments.comments, feedback.commentFilter) : [],
    [feedback.commentTimesCurrent, feedback.comments.comments, feedback.commentFilter],
  );
  // The server accepts frames only for a ready web copy with a measured rate; otherwise milliseconds.
  const commentRate = commentFrameRate(asset.viewingCopy?.state === "ready" ? asset.viewingCopy : undefined);
  // A draft time is kept with the file and rate it was picked on. A replaced file or a new web
  // copy changes what its numbers mean, so the draft is dropped then.
  const timingKey = `${asset.fileVersion ?? ""}|${commentRate ? `${commentRate.num}/${commentRate.den}` : "ms"}`;
  const [pickedDraft, setPickedDraft] = useState<CommentTimeDraft & { key: string } | null>(null);
  const timeDraft = pickedDraft?.key === timingKey ? pickedDraft : null;
  const setTimeDraft = (draft: CommentTimeDraft | null) => setPickedDraft(draft && { ...draft, key: timingKey });
  const [commentTimeMessage, setCommentTimeMessage] = useState("");
  const [activeCommentId, setActiveCommentId] = useState<string>();
  const [composerRequest, setComposerRequest] = useState(0);
  const [commentNavigationRequest, setCommentNavigationRequest] = useState(0);
  const [durationMs, setDurationMs] = useState(() => (asset.viewingCopy?.durationSeconds ?? 0) * 1000);
  // Media time of the frame on screen, from requestVideoFrameCallback.
  const shownMediaTime = useRef<number | null>(null);
  const production = useVideoProductionTools({ headerControls: true, workspace: hasTranscriptPane,
    commentThreads: commentThreads(feedback.comments.comments).filter(thread => timelineComments.includes(thread.comment)),
    commentsIncomplete: Boolean(feedback.comments.nextCursor),
    onOpenComment: comment => {
      openComment(comment); selectContextView("comments");
      requestAnimationFrame(() => document.getElementById(`media-comment-${comment.id}`)?.focus({ preventScroll: true }));
    },
    commentsAction: <>
      {feedback.comments.loadError || feedback.comments.moreError ? <span role="alert">{feedback.comments.loadError || feedback.comments.moreError}</span> : null}
      {feedback.comments.loadError ? <Button onClick={feedback.reloadComments}>Retry loading comments</Button>
        : feedback.comments.nextCursor ? <Button disabled={feedback.comments.loadingMore} onClick={() => void feedback.loadMoreComments()}>{feedback.comments.loadingMore ? "Loading comments" : "Load more comments"}</Button> : null}
    </>,
    onWorkspacePaneChange: view => {
    setWorkspaceView(view);
    if (sideBySide && contextView === "comments") setContextView("details");
  }, principal, onCredentialsDirtyChange: setCredentialsDirty, onCredentialsBusyChange: setCredentialsBusy, asset, getIdToken, player, canRequest: canRequestProduction, disabled: busy || Boolean(downloading), onDownloadOriginal: () => void download("download"), onTranscriptDirtyChange: setTranscriptDirty, onTranscriptSavingChange: setTranscriptSaving, onBusyChange: setProductionBusy, onSearchContentChanged, onTranscriptRequested, onTranscriptObserved, onTranscriptReady });
  const position = useRef(initialSeek);
  const pendingInitialSeek = useRef<number | null>(initialSeek > 0 ? initialSeek : null);
  const resumePlayback = useRef(false);
  const playbackRate = useRef(1);
  const fileReadContext = useRef("");
  fileReadContext.current = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
  useEffect(() => { setDownloading(undefined); }, [asset.sourceId, asset.id, asset.fileVersion]);
  const requestedIdentity = useRef(fileReadContext.current);
  const accessIdentity = useRef("");
  const renewalStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!sideBySide && workspaceView === "comments") {
      setWorkspaceView("watch");
    } else if (sideBySide && contextView === "comments" && workspaceView === "watch") {
      setWorkspaceView("comments");
    } else if (sideBySide && contextView === "comments" && workspaceView === "transcript") {
      setContextView("details");
    }
  }, [contextView, sideBySide, workspaceView]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const context = workspace?.querySelector<HTMLElement>(".video-viewer-context");
    const reading = workspace?.querySelector<HTMLElement>(".video-viewer-reading");
    if (!commentsBesidePlayer || !workspace || !context) return;
    const measure = () => {
      if (!window.matchMedia(VIDEO_SIDE_BY_SIDE_QUERY).matches) return;
      const workspaceWidth = workspace.getBoundingClientRect().width;
      if (workspaceWidth <= 0) return;
      const paneMinimum = videoPaneMinimumPixels();
      const fits = workspaceWidth >= paneMinimum * 2 + VIDEO_RESIZE_TRACK_PX;
      setSplitPanesFit(fits);
      if (!fits) return;
      const nextBounds = videoContextBounds(workspaceWidth, paneMinimum);
      setContextBounds(current => current.min === nextBounds.min && current.max === nextBounds.max ? current : nextBounds);
      if (!contextWidthDrag.current && preferredContextWidthRef.current !== undefined) {
        const bounded = clampVideoContextWidth(preferredContextWidthRef.current, nextBounds);
        if (bounded !== contextWidthRef.current) {
          contextWidthRef.current = bounded;
          setContextWidth(bounded);
        }
      }
      const next = clampVideoContextWidth(context.getBoundingClientRect().width / workspaceWidth * 100);
      setMeasuredContextWidth(current => Math.abs(current - next) >= 0.25 ? next : current);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(workspace);
    observer?.observe(context);
    // Enlarged text can grow only the reading pane to its rem minimum, so watch it too.
    if (reading) observer?.observe(reading);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [commentsBesidePlayer]);

  function updateContextWidth(value: number, persist: boolean, bounds = contextBounds) {
    const next = clampVideoContextWidth(value, bounds);
    contextWidthRef.current = next;
    setContextWidth(next);
    setMeasuredContextWidth(next);
    if (persist) {
      preferredContextWidthRef.current = next;
      storeVideoContextWidth(next);
    }
  }

  function onContextResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = stepVideoContextWidth(contextWidthRef.current ?? measuredContextWidth, event.key, contextBounds);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    updateContextWidth(next, true);
  }

  function onContextResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !workspaceRef.current) return;
    const workspaceWidth = workspaceRef.current.getBoundingClientRect().width;
    if (workspaceWidth <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const bounds = videoContextBounds(workspaceWidth);
    setContextBounds(bounds);
    contextWidthDrag.current = { x: event.clientX, percent: contextWidthRef.current ?? measuredContextWidth, workspaceWidth };
  }

  function resizeContextFromPointer(event: ReactPointerEvent<HTMLDivElement>, persist: boolean) {
    const start = contextWidthDrag.current;
    if (!start) return;
    event.stopPropagation();
    const next = start.percent + (event.clientX - start.x) / start.workspaceWidth * 100;
    updateContextWidth(next, persist, videoContextBounds(start.workspaceWidth));
    if (persist) contextWidthDrag.current = null;
  }

  function finishContextResize() {
    if (!contextWidthDrag.current) return;
    contextWidthDrag.current = null;
    updateContextWidth(contextWidthRef.current ?? measuredContextWidth, true);
  }

  // The comments panel sits beside the player, after the production tools and separator
  // in document order. Keep Tab moving between the Comments tab and its panel. The panel is a
  // portal of the inspector, so its key events bubble here through the React tree.
  function onContextKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab" || workspaceView !== "comments") return;
    const tab = workspaceRef.current?.querySelector<HTMLElement>(`[role="tab"][aria-controls="${contextId}-comments"]`);
    const first = tabbableIn(commentsTarget)[0];
    if (!tab || !first) return;
    const next = !event.shiftKey && event.target === tab ? first
      : event.shiftKey && event.target === first ? tab : null;
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function selectWorkspaceView(view: "watch" | "transcript") {
    setWorkspaceView(view);
  }

  function selectContextView(view: VideoContextView) {
    setContextView(view);
    setWorkspaceView(sideBySide && view === "comments" ? "comments" : "watch");
  }

  function rememberPlayback() {
    const element = player.current;
    if (!element) return;
    position.current = element.currentTime;
    playbackRate.current = element.playbackRate;
    resumePlayback.current = !element.paused && !element.ended;
  }

  function refreshPreview(showProgress = false) {
    if (renewalStarted.current) return;
    renewalStarted.current = true;
    rememberPlayback();
    setError("");
    setCanRefreshPreview(false);
    // Healthy expiry renewal stays silent; an explicit retry needs visible progress.
    setRenewing(showProgress);
    setAttempt(value => value + 1);
  }

  function applyPreviewAccess(result: SourceMediaRead) {
    const identity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
    if (accessIdentity.current === identity) {
      rememberPlayback();
      // A failed first URL may not have applied its linked time yet.
      if (pendingInitialSeek.current === null) pendingInitialSeek.current = position.current;
    }
    accessIdentity.current = identity;
    setPendingAccess(undefined);
    setAccess(result);
  }

  useEffect(() => {
    if (!canPlayInBrowser(asset)) return;
    let current = true;
    rememberPlayback();
    setError("");
    setCanRefreshPreview(false);
    const identity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
    if (accessIdentity.current !== identity) {
      setAccess(undefined);
      setPendingAccess(undefined);
      if (requestedIdentity.current !== identity) {
        position.current = 0;
        pendingInitialSeek.current = 0;
        resumePlayback.current = false;
        setTimeMessage("");
        setDurationMs((asset.viewingCopy?.durationSeconds ?? 0) * 1000);
      }
    }
    requestedIdentity.current = identity;
    getIdToken().then(token => current ? createVersionedSourceMediaRead(token, asset, "preview") : undefined)
      .then(result => {
        if (!current || !result) return;
        renewalStarted.current = false;
        const video = player.current;
        // Authorize ahead, but keep the active source and buffer while it plays.
        if (accessIdentity.current === identity && video && !video.paused && !video.ended && !video.error) setPendingAccess(result);
        else applyPreviewAccess(result);
        setRenewing(false);
      })
      .catch(cause => { if (current) {
        renewalStarted.current = false;
        setRenewing(false);
        const originalMessage = cause instanceof SourceMediaFileChangedError ? cause.message : originalAccessMessage(cause);
        setCanRefreshPreview(!originalMessage);
        setError(originalMessage ?? "The preview could not be opened. Try again or download the original file.");
      } });
    return () => { current = false; };
  }, [asset.id, asset.sourceId, asset.fileVersion, asset.preview, asset.viewingCopy?.state, attempt, getIdToken]);

  useEffect(() => {
    const identity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
    if (!pendingAccess || accessIdentity.current !== identity) return;
    const video = player.current;
    const applyWhenStopped = () => {
      if (accessIdentity.current !== identity) return;
      if (video && !video.paused && !video.ended && !video.error) return;
      if (Date.parse(pendingAccess.expiresAt) <= Date.now()) refreshPreview();
      else applyPreviewAccess(pendingAccess);
    };
    applyWhenStopped();
    video?.addEventListener("pause", applyWhenStopped);
    video?.addEventListener("ended", applyWhenStopped);
    video?.addEventListener("error", applyWhenStopped);
    return () => {
      video?.removeEventListener("pause", applyWhenStopped);
      video?.removeEventListener("ended", applyWhenStopped);
      video?.removeEventListener("error", applyWhenStopped);
    };
  }, [pendingAccess, asset.sourceId, asset.id, asset.fileVersion]);

  useEffect(() => {
    const video = player.current;
    shownMediaTime.current = null;
    if (!video || !("requestVideoFrameCallback" in video)) return;
    let handle = 0;
    const record: VideoFrameRequestCallback = (_now, frame) => {
      shownMediaTime.current = frame.mediaTime;
      handle = video.requestVideoFrameCallback(record);
    };
    handle = video.requestVideoFrameCallback(record);
    return () => video.cancelVideoFrameCallback(handle);
  }, [access]);

  /** The shown frame, or milliseconds when the video has no frame rate. */
  function currentCommentPoint(): number | null {
    const video = player.current;
    if (!video) return null;
    if (!commentRate) return Math.floor(video.currentTime * 1000);
    // Right after a seek the new frame may not be painted yet; then the player time is newer.
    const shown = shownMediaTime.current;
    const nearShown = shown !== null && Math.abs(video.currentTime - shown) < (2 * commentRate.den) / commentRate.num;
    return nearShown ? frameAtPresentationTime(shown, commentRate) : frameAtSeconds(video.currentTime, commentRate);
  }

  function openComment(comment: MediaComment) {
    const video = player.current;
    const time = comment.time;
    if (!video || !time?.currentVersion || !feedback.commentTimesCurrent) return;
    video.pause();
    video.currentTime = time.startFrame !== null && time.rateNum !== null && time.rateDen !== null
      ? seekSecondsForFrame(time.startFrame, { num: time.rateNum, den: time.rateDen })
      : time.startMs / 1000;
    setActiveCommentId(comment.id);
    setCommentNavigationRequest(request => request + 1);
  }

  useEffect(() => {
    if (!pickedDraft || pickedDraft.key === timingKey) return;
    setPickedDraft(null);
    setCommentTimeMessage("The video changed, so the comment time was removed. Set the time again.");
  }, [pickedDraft, timingKey]);

  // The server checks a time against the web copy's measured duration, so timing waits for it.
  // Timing does not depend on the signed preview link, so a draft stays while the link renews.
  const canTime = asset.viewingCopy?.state === "ready" && Boolean(asset.viewingCopy.durationSeconds);
  const commentTiming: CommentTiming | undefined = feedback.enabled && canTime && asset.fileVersion ? {
    rate: commentRate,
    fileVersion: asset.fileVersion,
    timesPending: !feedback.commentTimesCurrent,
    draft: timeDraft,
    message: commentTimeMessage,
    activeId: activeCommentId,
    composerRequest,
    navigationRequest: commentNavigationRequest,
    onUseCurrent: () => {
      const point = currentCommentPoint();
      if (point === null) return;
      setTimeDraft({ start: point, end: null });
      setCommentTimeMessage("");
      setComposerRequest(value => value + 1);
    },
    onSetIn: () => {
      const point = currentCommentPoint();
      if (point === null) return;
      setTimeDraft({ start: point, end: timeDraft?.end != null && timeDraft.end > point ? timeDraft.end : null });
      setCommentTimeMessage("");
    },
    onSetOut: () => {
      const point = currentCommentPoint();
      if (point === null) return;
      const start = timeDraft?.start ?? 0;
      if (point <= start) {
        setCommentTimeMessage("The range end must come after the range start.");
        return;
      }
      setTimeDraft({ start, end: point });
      setCommentTimeMessage("");
    },
    onClear: () => {
      setTimeDraft(null);
      setCommentTimeMessage("");
    },
    onSeek: openComment,
  } : undefined;

  function stepComment(direction: 1 | -1) {
    const placed = placedComments(timelineComments);
    if (!placed.length || !player.current) return;
    const active = placed.findIndex(comment => comment.id === activeCommentId);
    const nowMs = player.current.currentTime * 1000;
    const index = active >= 0
      ? active + direction
      : direction > 0
        ? placed.findIndex(comment => comment.time.startMs > nowMs)
        : placed.filter(comment => comment.time.startMs < nowMs).length - 1;
    if (placed[index]) openComment(placed[index]);
  }

  // Single-key shortcuts work only while the player or its markers have focus (WCAG 2.1.4).
  function onPlayerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!commentTiming || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
    const key = event.key.toLowerCase();
    if (key === "c") commentTiming.onUseCurrent();
    else if (key === "i") commentTiming.onSetIn();
    else if (key === "o") commentTiming.onSetOut();
    else if (key === "[" || key === "]") stepComment(key === "]" ? 1 : -1);
    else return;
    event.preventDefault();
  }

  useEffect(() => {
    const latestAccess = pendingAccess ?? access;
    if (!latestAccess) return;
    const expiresAt = Date.parse(latestAccess.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const timeout = window.setTimeout(() => refreshPreview(), Math.max(1_000, expiresAt - Date.now() - ACCESS_RENEWAL_LEAD_MS));
    return () => window.clearTimeout(timeout);
  }, [access, pendingAccess]);

  async function download(action: "download" | "download_web") {
    const context = fileReadContext.current;
    const current = () => mounted.current && fileReadContext.current === context;
    let acknowledgedCredit = asset.credit?.trim();
    if (acknowledgedCredit && !window.confirm(
      "This video requires an on-screen credit. Check the Credit field for details.\n\nContinue with the download?",
    )) return;
    setDownloading(action);
    setError("");
    setCanRefreshPreview(false);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const requestedAt = Date.now();
        const token = await getIdToken();
        if (!current()) return;
        const result = await createVersionedSourceMediaRead(token, asset, action);
        if (!current()) return;
        const currentCredit = result.credit?.trim();
        if (currentCredit && currentCredit !== acknowledgedCredit && !window.confirm(
          `This video requires an on-screen credit: ${currentCredit}\n\nContinue with the download?`,
        )) return;
        acknowledgedCredit = currentCredit;
        // Source links last five minutes. Use elapsed time to tolerate client clock skew.
        if (Date.now() - requestedAt >= 299_000) continue;
        const link = document.createElement("a");
        link.href = result.url;
        link.rel = "noreferrer";
        link.download = action === "download" ? asset.originalName : asset.originalName.replace(/\.[^.]*$/, "") + ".mp4";
        document.body.append(link);
        link.click();
        link.remove();
        return;
      }
      setError("The download link expired. Try again.");
    } catch (cause) {
      const originalMessage = cause instanceof SourceMediaFileChangedError ? cause.message : originalAccessMessage(cause);
      if (current() && originalMessage) {
        setError(originalMessage);
      } else if (current()) setError(`${action === "download_web" ? "The web copy" : "The original file"} could not be downloaded. Try again.`);
    } finally {
      if (current()) setDownloading(undefined);
    }
  }

  const viewingCopy = asset.viewingCopy;
  const playerAspectRatio = naturalRatio ?? (viewingCopy?.width && viewingCopy.height
    ? viewingCopy.width / viewingCopy.height
    : 16 / 9);
  const originalReadyMessage = ["archived", "restoring"].includes(asset.original?.state ?? "")
    ? "The original needs restoration. Check the original status in the video details."
    : "Check the original status in the video details before downloading.";
  const emptyPreview = viewingCopy?.state === "processing"
    ? { title: "Preparing preview", description: `This can take time for large files. ${originalReadyMessage}` }
    : viewingCopy?.state === "failed"
      ? { title: "Preview unavailable", description: originalReadyMessage }
      : viewingCopy?.state === "not_prepared"
        ? { title: "Preview not prepared", description: originalReadyMessage }
        : { title: "Download to watch", description: "This video format needs a compatible player on your computer." };

  const facts = [
    viewingCopy?.durationSeconds ? formatMediaDuration(viewingCopy.durationSeconds) : null,
    viewingCopy?.width && viewingCopy.height ? `${viewingCopy.width} × ${viewingCopy.height}` : null,
    formatVideoBytes(asset.sizeBytes), formatMediaUpdated(asset.createdAt),
    sourceLabel ?? (asset.sourceId === "video-library" ? "Videos" : null),
    production.transcriptStatus,
    originalStatusLabel(originalControls.original),
  ].filter(Boolean).join(" · ");
  const downloadLabel = downloading === "download_web" ? "Preparing web copy" : downloading === "download" ? "Preparing original" : "Download";
  const downloads = <Menu label={downloadLabel} tooltip={downloadLabel} icon="download" variant="primary" showGroupLabels fitBelow disabled={Boolean(downloading)} items={[
    { key: "web", group: "Video", label: "Web copy", description: viewingCopy?.sizeBytes ? formatVideoBytes(viewingCopy.sizeBytes) : undefined, hidden: viewingCopy?.state !== "ready", onSelect: () => void download("download_web") },
    { key: "original", group: "Video", label: "Original video", description: formatVideoBytes(asset.sizeBytes), onSelect: () => void download("download") },
    ...(asset.sourceId === "video-library" ? [production.editorExportsItem, ...production.downloadItems] : []),
  ]}>{downloadLabel}</Menu>;
  const preview = <>
      {closePrompt}
      {canPlayInBrowser(asset) ? <>
        <div className="source-video-review" onKeyDown={onPlayerKeyDown}>
        {access && accessIdentity.current === `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}` ? <div className="source-video-surface" style={{ width: hasTranscriptPane ? undefined : `min(100%, ${60 * playerAspectRatio}dvh)` }}><video ref={player} className="source-video-player" src={access.url} controls controlsList="nodownload" onContextMenu={event => event.preventDefault()} playsInline preload="metadata" style={{ aspectRatio: playerAspectRatio }}
          aria-label={`Preview ${asset.name}`} onTimeUpdate={() => { position.current = player.current?.currentTime ?? 0; production.onTimeUpdate(); }}
          onLoadedMetadata={() => {
            if (!player.current) return;
            setError("");
            setCanRefreshPreview(false);
            if (player.current.videoWidth && player.current.videoHeight) setNaturalRatio(player.current.videoWidth / player.current.videoHeight);
            if (Number.isFinite(player.current.duration)) setDurationMs(player.current.duration * 1000);
            // Loading can emit timeupdate at zero before metadata. Keep the requested hit until seeking is possible.
            const target = pendingInitialSeek.current ?? position.current;
            pendingInitialSeek.current = null;
            if (target > 0) {
              const bounded = boundedMediaTime(target, player.current.duration);
              position.current = bounded.seconds;
              setTimeMessage(bounded.message ?? "");
              player.current.currentTime = position.current;
            }
            player.current.playbackRate = playbackRate.current;
            if (resumePlayback.current) void player.current.play().catch(() => undefined);
            resumePlayback.current = false;
          }}
          onError={() => { setCanRefreshPreview(true); setError("Playback stopped. Refresh the preview to renew access, or download the original file."); }} />
          {commentTiming ? <VideoReviewSeek currentSeconds={production.playbackSeconds} durationMs={durationMs} disabled={!access}
            onSeek={production.seekPlayback}>
            <MediaCommentTimeline comments={timelineComments} durationMs={durationMs}
              activeId={activeCommentId} onOpen={openComment} />
          </VideoReviewSeek> : null}
          </div>
          : !error && !renewing ? <div className="source-video-loading"><LoadingIndicator label="Opening private preview" /></div> : null}
        {commentTiming ? <>
          <p className="source-video-shortcuts">With the player or comment markers focused: C comments at this {commentRate ? "frame" : "time"}, I and O set a range, [ and ] go to the previous or next comment.</p>
        </> : null}
        </div>
        {access && viewingCopy?.state === "ready" ? <p className="source-video-ready">Preview ready to watch in your browser.</p>
          : access && viewingCopy ? <p className="source-video-ready">Playing the browser-compatible original while the web copy is not ready.</p> : null}
      </> : <EmptyState title={emptyPreview.title} description={emptyPreview.description} />}
      {asset.sourceId === "video-library" ? null
        : <p className="source-video-private"><Icon name="lock" /> Only authorized Boardwalk staff can open this video.</p>}
      {navigationBlocked ? <LeaveGuardDialog onConfirm={onDiscardNavigation} onCancel={onKeepNavigation} /> : null}
  </>;
  const details = <VideoDetailsInspector contextual={hasTranscriptPane} contextId={contextId} contextView={contextView}
      commentsTarget={hasTranscriptPane && sideBySide && workspaceView === "comments" ? commentsTarget : undefined}
      onContextViewChange={hasTranscriptPane ? selectContextView : undefined}
      onDetailsRequested={hasTranscriptPane ? () => selectContextView("details") : undefined}
      asset={asset}
      canDelete={canDelete}
      canEditMetadata={canEditMetadata}
      commentTiming={commentTiming}
      deleteConfirmationId={deleteConfirmationId}
      disabled={transcriptSaving || credentialsBusy}
      feedback={feedback}
      footerTarget={footerTarget}
      getIdToken={getIdToken}
      hasOtherDirty={transcriptDirty || credentialsDirty}
      initialConfirmDelete={initialConfirmDelete}
      onDeleted={onDeleted}
      onDirtyChange={setDetailsDirty}
      onSavingChange={setDetailsSaving}
      onTagsSaved={onTagsSaved}
      onUpdated={onUpdated}
      preserveVideoSearchCache={preserveVideoSearchCache}
      onSaved={onSaveReceipt}
      onSaveSuccess={onSaveSuccess}
      pageTags={pageTags}
      recentTags={recentTags}
    />;
  return <>
    {headerTarget ? createPortal(<MediaPreviewHeaderActions downloads={downloads}
      favorite={favorite} copyLink={() => mediaPermalink(mediaVideosPath(asset.sourceId), asset.id, player.current?.currentTime ?? initialSeek)} />, headerTarget) : null}
    {factsTarget ? createPortal(facts, factsTarget) : null}
    <MediaDialogNotice>{error ? <InlineMessage tone="error" title="Video access needs attention">{error}
      {canRefreshPreview ? <Button onClick={() => refreshPreview(true)}>Refresh preview</Button> : null}
    </InlineMessage> : null}</MediaDialogNotice>
    <MediaDialogNotice>{showOriginalNotice ? <VideoOriginalStatus controls={originalControls} /> : null}</MediaDialogNotice>
    <MediaDialogNotice>{renewing ? <LoadingIndicator label="Renewing private preview" layout="inline" className="source-video-renewing" /> : null}</MediaDialogNotice>
    <MediaDialogNotice>{timeMessage ? <p role="status">{timeMessage}</p> : null}</MediaDialogNotice>
    {hasTranscriptPane ? <div className="video-viewer-workspace" data-stacked={!sideBySide || undefined} data-view={workspaceView} data-transcript ref={workspaceRef}
      style={contextWidth === undefined ? undefined : { "--video-viewer-context-width": `${contextWidth}%` } as CSSProperties}>
      <ViewerTabs className="video-workspace-tabs viewer-tabs" label="Video workspace" value={workspaceView === "comments" ? "watch" : workspaceView}
        items={[{ value: "watch", label: "Watch & details", panelId: `${workspaceId}-watch` },
          { value: "transcript", label: "Transcript", panelId: `${workspaceId}-transcript` }]} onChange={selectWorkspaceView} />
      <section className="video-viewer-context" id={`${workspaceId}-watch`} role="tabpanel" aria-label="Watch & details" onKeyDown={onContextKeyDown} onFocusCapture={event => {
        if (event.currentTarget.contains(event.target as Node)) setWorkspaceView("watch");
      }}>
        <div className="video-viewer-preview">{preview}</div>
        <div className="video-viewer-context-content">
          {!showOriginalNotice ? <VideoOriginalStatus controls={originalControls} /> : null}
          {details}
          {canReplace && canEditMetadata && principal?.id ? <div hidden={contextView !== "details"}><VideoReplaceButton asset={asset} userId={principal.id}
            canReplace={canEditMetadata} disabled={dirty || detailsSaving || transcriptSaving || credentialsBusy || productionBusy || Boolean(downloading)}
            getIdToken={getIdToken} onUpdated={onUpdated} onBusyChange={setReplacementBusy} /></div> : null}
          {canExportOrientation ? <div hidden={contextView !== "details"}><VideoOrientationExport asset={asset} getIdToken={getIdToken}
            disabled={dirty || detailsSaving || replacementBusy} onStatus={onExportStatus} /></div> : null}
          <div className="video-viewer-production" data-viewer-keys="off">{production.actions}{production.content}</div>
        </div>
      </section>
      <div aria-controls={`${workspaceId}-watch`} aria-label="Resize Watch & details" aria-orientation="vertical"
        aria-valuemax={contextBounds.max} aria-valuemin={contextBounds.min}
        aria-valuenow={measuredContextWidth} aria-valuetext={`${measuredContextWidth}% width for Watch & details`}
        className="video-viewer-resize" onKeyDown={onContextResizeKeyDown}
        onLostPointerCapture={finishContextResize}
        onPointerCancel={finishContextResize}
        onPointerDown={onContextResizePointerDown}
        onPointerMove={event => resizeContextFromPointer(event, false)}
        onPointerUp={event => resizeContextFromPointer(event, true)} role="separator" tabIndex={0} />
      <section className="video-viewer-reading" id={`${workspaceId}-side`} aria-label="Video side pane">
        <div className="video-viewer-transcript-pane" id={`${workspaceId}-transcript`} role="tabpanel" aria-label="Transcript"
          hidden={workspaceView === "comments"} onFocusCapture={event => {
            if (event.currentTarget.contains(event.target as Node)) setWorkspaceView("transcript");
          }}>
          {production.transcriptPane}
        </div>
        <div className="video-viewer-comments-host" hidden={workspaceView !== "comments"} ref={setCommentsTarget} />
      </section>
    </div> : <>
      <div className="component-editor-dialog-content">{preview}{!showOriginalNotice ? <VideoOriginalStatus controls={originalControls} /> : null}</div>
      <aside className="component-editor-dialog-settings" role="none">{details}</aside>
    </>}
  </>;
}

export function VideoPreview({
  initialSeek = 0,
  initialConfirmDelete = false,
  asset,
  onClose,
  onDirtyChange,
  onSavingChange,
  onBusyChange,
  steppingOrder,
  onStep,
  ...bodyProps
}: VideoPreviewProps) {
  const deleteConfirmationId = useId();
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [factsTarget, setFactsTarget] = useState<HTMLSpanElement | null>(null);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"close" | StepDirection>();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const promptOpener = useRef<HTMLElement | null>(null);
  const pendingStepFocus = useRef<StepDirection>();
  const openingAssetId = useRef(asset.id);
  const orderIds = useMemo(() => steppingOrder?.map(item => item.id) ?? [], [steppingOrder]);
  const previousId = stepTarget(orderIds, asset.id, "previous");
  const nextId = stepTarget(orderIds, asset.id, "next");
  const position = stepPosition(orderIds, asset.id);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange(saving); return () => onSavingChange(false); }, [saving, onSavingChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { if (!dirty) setConfirmAction(undefined); }, [dirty]);
  useEffect(() => { if (confirmAction) keepEditing.current?.focus(); }, [confirmAction]);
  useEffect(() => {
    const direction = pendingStepFocus.current;
    if (!direction) return;
    pendingStepFocus.current = undefined;
    const frame = requestAnimationFrame(() => {
      focusMediaDialogNavigation(direction, previousButton.current, nextButton.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [asset.id, nextId, previousId]);

  function finish(action: "close" | StepDirection) {
    setConfirmAction(undefined);
    if (action === "close") {
      onClose();
      return;
    }
    const targetId = stepTarget(orderIds, asset.id, action);
    const target = steppingOrder?.find(item => item.id === targetId);
    if (target) {
      openingAssetId.current = "";
      pendingStepFocus.current = action;
      onStep?.(target);
    }
  }

  function request(action: "close" | StepDirection, opener?: HTMLElement) {
    if (busy) return;
    if (dirty) {
      promptOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setConfirmAction(action);
    }
    else finish(action);
  }

  function keepCurrentVideo() {
    const opener = promptOpener.current;
    setConfirmAction(undefined);
    requestAnimationFrame(() => {
      if (opener?.isConnected && (!(opener instanceof HTMLButtonElement) || !opener.disabled)) opener.focus();
    });
  }

  const closePrompt = confirmAction ? <MediaDialogNotice><InlineMessage tone="warning" title="Unsaved video changes">
    <p>{confirmAction === "close" ? "Close without saving your changes?" : `Open the ${confirmAction} video without saving your changes?`}</p>
    <Button disabled={busy} onClick={() => finish(confirmAction)}>Discard changes</Button>
    <Button ref={keepEditing} disabled={busy} onClick={keepCurrentVideo}>Keep editing</Button>
  </InlineMessage></MediaDialogNotice> : null;

  const navigation = mediaDialogNavigation({
    position, previousRef: previousButton, nextRef: nextButton,
    previousAvailable: Boolean(previousId), nextAvailable: Boolean(nextId),
    blocked: busy, request: (direction, opener) => request(direction, opener),
  });

  return <ComponentEditorDialog open layout="video" title={asset.name} onClose={() => request("close")} closeDisabled={busy}
    focusTargetId={initialConfirmDelete && openingAssetId.current === asset.id && bodyProps.canDelete ? deleteConfirmationId : undefined}
    variant="media" footerNote="Private media stays in the staff library." closeLabel="Close" closeVariant="secondary" headerNavigation={navigation} headerFacts={<span ref={setFactsTarget} />} headerActions={<div className="media-preview-header-slot" ref={setHeaderTarget} />}
    footerActions={<div className="media-viewer-footer-slot" ref={setFooterTarget} />}
    onFrameKeyDown={event => {
      const keyOwner = event.target instanceof Element ? event.target.closest('dialog, [role="dialog"]') : null;
      if (keyOwner !== event.currentTarget) return;
      const action = viewerKeyAction({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        defaultPrevented: event.defaultPrevented,
        target: event.target,
      }, { previous: Boolean(previousId), next: Boolean(nextId) });
      if (action !== "previous" && action !== "next" && action !== "close") return;
      event.preventDefault();
      event.stopPropagation();
      request(action, event.target instanceof HTMLElement ? event.target : event.currentTarget);
    }}
    body={<VideoViewerBody key={asset.id}
      {...bodyProps}
      asset={asset}
      initialConfirmDelete={initialConfirmDelete && openingAssetId.current === asset.id}
      initialSeek={openingAssetId.current === asset.id ? initialSeek : 0}
      deleteConfirmationId={deleteConfirmationId}
      headerTarget={headerTarget} factsTarget={factsTarget} footerTarget={footerTarget}
      onDirtyChange={setDirty}
      onSavingChange={setSaving}
      onBusyChange={setBusy}
      closePrompt={closePrompt}
    />} />;
}

export function SourceMediaLibrary({ principal, source, getIdToken, userId, onExitRiskChange, extraExitRisk = false, hasExtraExitRisk, onDiscardExtra, onDiscardVideo, routedLibraryActive = false, routedRejectedFiles, routedUploadRevision = 0, routedVideoActive = false, suppressUpload = false }: {
  principal?: Principal;
  source: MediaSourceSummary;
  getIdToken: () => Promise<string>;
  userId: string;
  onExitRiskChange?: (active: boolean) => void;
  extraExitRisk?: boolean;
  hasExtraExitRisk?: () => boolean;
  onDiscardExtra?: () => void;
  onDiscardVideo?: () => void;
  routedLibraryActive?: boolean;
  routedRejectedFiles?: readonly string[];
  /** Reload this source in place after a routed video lands here. */
  routedUploadRevision?: number;
  /** A routed video is running on this read-only source and would lose its file if replaced. */
  routedVideoActive?: boolean;
  /** A routed transfer already owns the single video handler. */
  suppressUpload?: boolean;
}) {
  if (principal) setMediaCachePrincipal(userId, JSON.stringify(principal));
  else setMediaCacheUser(userId);
  const navigate = useNavigate();
  const notice = useSuccessNotice();
  const currentNotice = useRef(notice);
  currentNotice.current = notice;
  const routeKey = useLocation().key;
  const [routeParams, setRouteParams] = useSearchParams();
  const permalink = parseMediaPermalink(routeParams);
  const videoLocation = parseVideoMediaLocation(routeParams.toString());
  const videoQuery = videoLocation.query;
  const videoQueryKey = `${userId}:${source.id}:${JSON.stringify(videoQuery)}`;
  const [paging, setPaging] = useState<{ key: string; cursor?: string; previous: (string | undefined)[] }>(
    () => ({ key: videoQueryKey, previous: [] }),
  );
  useEffect(() => { setPaging(current => current.key === videoQueryKey ? current : { key: videoQueryKey, previous: [] }); }, [videoQueryKey]);
  const cursor = paging.key === videoQueryKey ? paging.cursor : undefined;
  const previousCursors = paging.key === videoQueryKey ? paging.previous : [];
  const { display, setDisplay, resetDisplay } = useMediaDisplay("video");
  // MediaSearchField owns the typed draft. Keep only a ref here so preserving that draft across
  // a filter action does not rerender the library or search the transcript corpus on every key.
  const searchDraft = useRef(videoQuery.q);
  useEffect(() => { searchDraft.current = videoQuery.q; }, [userId, source.id, videoQuery.q]);
  const [tagInput, setTagInput] = useState(videoQuery.tag ?? "");
  const [tagError, setTagError] = useState("");
  useEffect(() => { setTagInput(videoQuery.tag ?? ""); setTagError(""); }, [userId, source.id, videoQuery.tag]);
  const [uploader, setUploader] = useState<{ uid: string; name: string }>();
  const [deletedName, setDeletedName] = useState("");
  const [searchError, setSearchError] = useState("");
  const canFilterUploader = Boolean(principal && hasCapability(principal, "users.view"));
  const visibleVideoFields = display.fields;
  const search = videoQuery.q;
  const view = display.layout;
  const allowedUploader = canFilterUploader || videoQuery.by === userId ? videoQuery.by : undefined;
  const activeFilter = videoQuery.tag ? { tag: videoQuery.tag }
    : allowedUploader ? { createdBy: allowedUploader }
      : videoQuery.rights ? { rightsStatus: videoQuery.rights } : {};
  const requestQuery: SourceMediaQuery = { sourceId: source.id, q: search, cursor, limit: videoQuery.limit, ...activeFilter };
  if (search) requestQuery.sort = "name_asc";
  else if (videoQuery.sort !== "updated_desc") requestQuery.sort = videoQuery.sort;
  const queryKey = JSON.stringify(requestQuery);
  function resetPaging() { setPaging({ key: videoQueryKey, previous: [] }); }
  function writeVideoQuery(next: VideoMediaLocationQuery, replace = false) {
    const normalized = next.q.normalize("NFKC").trim();
    if (normalized.toLocaleLowerCase("en-US").length > 160) {
      setSearchError("Search text must be 160 characters or fewer after text normalization.");
      return false;
    }
    setSearchError("");
    const safeNext = !canFilterUploader && next.by !== userId ? { ...next, by: undefined } : next;
    const params = encodeVideoMediaLocation({ ...safeNext, q: normalized }, videoLocation.selectedId);
    const seconds = routeParams.get("t");
    if (seconds && videoLocation.selectedId) params.set("t", seconds);
    if (params.toString() === routeParams.toString()) return true;
    internalNavigation.current = params.toString() ? `?${params}` : "";
    setRouteParams(params, { replace });
    return true;
  }
  const currentWriteVideoQuery = useRef(writeVideoQuery);
  currentWriteVideoQuery.current = writeVideoQuery;
  useEffect(() => {
    if (videoQuery.by && !canFilterUploader && videoQuery.by !== userId) {
      writeVideoQuery({ ...videoQuery, by: undefined }, true);
    }
  }, [canFilterUploader, userId, videoQuery.by]);
  function applyDraftQuery(change: Partial<VideoMediaLocationQuery>, replace = false) {
    if (change.sort) setSizeSortFallback(false);
    return writeVideoQuery({ ...videoQuery, ...change, q: searchDraft.current }, replace);
  }
  function filterByTag(value: string) {
    if (writeVideoQuery({ ...setVideoStructuredFilter(videoLocation, { field: "tag", value }).query, q: searchDraft.current })) {
      searchDraft.current = searchDraft.current.trim();
    }
  }
  function resetFilters() {
    if (writeVideoQuery(clearVideoFilterChips(videoLocation).query)) searchDraft.current = "";
  }
  function clearFilters() {
    const next = clearVideoFilterChips(videoLocation).query;
    if (!prepareFilterUndo(videoParams(videoQuery, videoLocation.view).toString(), videoParams(next).toString())) return;
    if (writeVideoQuery(next)) searchDraft.current = "";
  }
  const [linkError, setLinkError] = useState("");
  const appliedLink = useRef("");
  const internalNavigation = useRef<string>();
  const prepareFilterUndo = useClearFilterUndo(routeKey, routeParams.toString(), (before) => {
    const params = new URLSearchParams(before);
    const restored = parseVideoMediaLocation(params.toString()).query;
    if (!canFilterUploader && restored.by && restored.by !== userId) {
      notice.show("These filters are no longer available. Reload the library.", { tone: "error" });
      return;
    }
    internalNavigation.current = before ? `?${before}` : "";
    setRouteParams(params, { replace: true });
    searchDraft.current = restored.q;
  });
  function videoParams(next: VideoMediaLocationQuery, savedViewId?: string) {
    const params = encodeVideoMediaLocation(next, videoLocation.selectedId, savedViewId);
    const seconds = routeParams.get("t");
    if (seconds && videoLocation.selectedId) params.set("t", seconds);
    return params;
  }
  function applySavedView(view: SavedMediaView) {
    const saved = parseVideoMediaLocation(view.query).query;
    const allowed = !canFilterUploader && saved.by !== userId ? { ...saved, by: undefined } : saved;
    const params = encodeVideoMediaLocation({ ...allowed, cursor: undefined }, null, view.id);
    internalNavigation.current = params.toString() ? `?${params}` : "";
    setRouteParams(params);
    searchDraft.current = allowed.q;
    resetPaging();
    if (view.display) setDisplay(view.display as VideoMediaDisplayPreferences);
  }
  function removeMissingSavedView(reason?: "deleted") {
    const requestUser = userId;
    const requestSource = source.id;
    const params = new URLSearchParams(routeParams);
    params.delete("view");
    internalNavigation.current = params.toString() ? `?${params}` : "";
    setRouteParams(params, { replace: true });
    if (reason === "deleted") return;
    window.setTimeout(() => {
      const controller = currentNotice.current;
      if (currentUserId.current === requestUser && currentSourceId.current === requestSource && controller.isCurrent()) {
        controller.show("This saved view is no longer available. Current filters were kept.", { tone: "error" });
      }
    }, 0);
  }
  function resetSavedViewDefaults() {
    const params = encodeVideoMediaLocation(DEFAULT_VIDEO_MEDIA_QUERY, null);
    internalNavigation.current = "";
    setRouteParams(params);
    searchDraft.current = "";
    resetPaging();
  }
  const viewerReturnSearch = useRef<string>();
  const linkKey = `${userId}:${source.id}:${routeParams.get("asset") ?? ""}:${routeParams.get("t") ?? ""}`;
  function writeVideoLocation(asset?: SourceMediaAssetSummary, seconds = 0, replace = false) {
    if (asset && !replace) viewerReturnSearch.current = routeParams.toString() ? `?${routeParams}` : "";
    const next = new URLSearchParams(routeParams);
    next.delete("asset"); next.delete("t");
    if (asset) {
      next.set("asset", asset.id);
      if (seconds > 0) next.set("t", String(seconds));
    }
    appliedLink.current = `${userId}:${source.id}:${next.get("asset") ?? ""}:${next.get("t") ?? ""}`;
    internalNavigation.current = next.toString() ? `?${next}` : "";
    setRouteParams(next, { replace });
  }

  const [page, setPage] = useState<SourceMediaPage>();
  const [sizeSortFallback, setSizeSortFallback] = useState(false);
  const [loadedPageKey, setLoadedPageKey] = useState<string>();
  const loadedCursor = loadedPageKey ? (JSON.parse(loadedPageKey) as SourceMediaQuery).cursor : undefined;
  const [recentTagsVersion, setRecentTagsVersion] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const completionRefresh = useRef<string | null>(null);
  const [refreshingCompletion, setRefreshingCompletion] = useState(false);
  useEffect(() => {
    const fileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string; assetId?: string }>).detail;
      if (detail?.sourceId !== source.id || !detail.assetId) return;
      completionRefresh.current = null;
      setAttempt(value => value + 1);
    };
    window.addEventListener(SOURCE_MEDIA_FILE_CHANGED_EVENT, fileChanged);
    return () => window.removeEventListener(SOURCE_MEDIA_FILE_CHANGED_EVENT, fileChanged);
  }, [source.id]);
  const lastRoutedUploadRevision = useRef(routedUploadRevision);
  useEffect(() => {
    if (lastRoutedUploadRevision.current === routedUploadRevision) return;
    lastRoutedUploadRevision.current = routedUploadRevision;
    setAttempt(value => value + 1);
  }, [routedUploadRevision]);
  const [searchRevision, setSearchRevision] = useState(0);
  // Remounting search replaces its results. Hold the remount while a viewer is open,
  // so a result that opened the viewer is still there to take focus on close.
  const [shownSearchRevision, setShownSearchRevision] = useState(0);
  const searchContentChanged = useRef(false);
  const pendingTranscripts = useRef(new Map<string, TranscriptSettings>());
  const checkingPendingTranscripts = useRef(false);
  const [initialSeek, setInitialSeek] = useState(0);
  const [selected, setSelected] = useState<SourceMediaAssetSummary>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => { if (!selected) setShownSearchRevision(searchRevision); }, [selected, searchRevision]);
  useEffect(() => {
    if (!shownSearchRevision) return;
    // A remount can remove the focused result. Keep focus in the library.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) document.getElementById("video-search")?.focus();
  }, [shownSearchRevision]);
  const [viewerOrder, setViewerOrder] = useState<SourceMediaAssetSummary[]>([]);
  const [quickLook, setQuickLook] = useState<QuickLookVideoSession | null>(null);
  const [quickLookRead, setQuickLookRead] = useState<{ id: string; fileVersion?: string | null; url: string | null }>();
  const quickLookAsset = quickLook?.order.find(item => item.id === quickLook.id);
  useSourceMediaAssetRefresh({ asset: quickLookAsset, getIdToken, onUpdated: fresh => {
    setPage(previous => previous ? { ...previous, records: previous.records.map(item => item.id === fresh.id ? fresh : item) } : previous);
    setViewerOrder(previous => previous.map(item => item.id === fresh.id ? fresh : item));
    setQuickLook(previous => previous ? { ...previous, order: previous.order.map(item => item.id === fresh.id ? fresh : item) } : previous);
  } });
  useEffect(() => {
    if (!quickLookAsset) return;
    const poster = quickLookPoster(quickLookAsset);
    setQuickLookRead({ id: quickLookAsset.id, fileVersion: quickLookAsset.fileVersion, url: poster.url });
    if (!poster.read) return;
    let current = true;
    const read = sharePosterRead(quickLookAsset, getIdToken);
    void read.promise.then(result => {
      if (current && result && "url" in result) setQuickLookRead({ id: quickLookAsset.id, fileVersion: quickLookAsset.fileVersion, url: result.url });
    });
    return () => { current = false; read.release(); };
  }, [quickLookAsset, getIdToken]);
  const viewerOrderRef = useRef(viewerOrder);
  viewerOrderRef.current = viewerOrder;
  const viewerNeedsReload = useRef(false);
  const onExportStatus = useVideoExportCompletion(() => {
    invalidateVideoSearchCorpus(source.id);
    searchContentChanged.current = true;
    viewerNeedsReload.current = true;
    setMediaSourceCount(source.id, null);
  });
  const viewerStepped = useRef(false);
  const viewerHasGridCard = useRef(false);
  const pendingViewerFocus = useRef<{ currentId: string; currentName: string; order: string[]; queryKey: string }>();
  const [viewerAnnouncement, setViewerAnnouncement] = useState("");
  const [metadataDirty, setMetadataDirty] = useState(false);
  const metadataDirtyRef = useRef(metadataDirty);
  metadataDirtyRef.current = metadataDirty;
  const currentUserId = useRef(userId);
  currentUserId.current = userId;
  const currentSourceId = useRef(source.id);
  currentSourceId.current = source.id;
  const [metadataSaving, setMetadataSaving] = useState(false);
  const metadataSavingRef = useRef(metadataSaving);
  metadataSavingRef.current = metadataSaving;
  const [viewerBusy, setViewerBusy] = useState(false);
  const viewerBusyRef = useRef(viewerBusy);
  viewerBusyRef.current = viewerBusy;
  const [transfersActive, setTransfersActive] = useState(false);
  const [uploadDefaultsDirty, setUploadDefaultsDirty] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const visibleUploadOpen = uploadOpen && !routedLibraryActive;
  const [uploadCanIntake, setUploadCanIntake] = useState(false);
  const [uploadFocusRequest, setUploadFocusRequest] = useState(0);
  const [uploadTrayTarget, setUploadTrayTarget] = useState<HTMLElement | null>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const resultSummaryRef = useRef<HTMLParagraphElement>(null);
  const gridRef = useRef<MediaGridHandle>(null);
  const [confirmDeleteOnOpen, setConfirmDeleteOnOpen] = useState(false);
  const pageVideoTags = useMemo(() => page?.records.flatMap((record) => record.tags) ?? [], [page]);
  const recentVideoTags = useMemo(() => readRecentTags("video", userId), [recentTagsVersion, userId]);
  function rememberVideoTags(tags: readonly string[]) {
    recordRecentTags("video", tags, userId);
    setRecentTagsVersion(version => version + 1);
  }
  function focusVideoCard(id: string): boolean {
    const holder = [...(libraryRef.current?.querySelectorAll<HTMLElement>("[data-media-item]") ?? [])]
      .find(element => element.dataset.mediaItem === id);
    const control = holder?.querySelector<HTMLElement>("[data-media-open]");
    if (!control) return false;
    control.focus({ preventScroll: true });
    control.scrollIntoView?.({ block: "nearest" });
    return true;
  }
  function focusAfterViewerReload(result: SourceMediaPage, request: NonNullable<typeof pendingViewerFocus.current>) {
    const available = new Set(result.records.map(record => record.id));
    if (available.has(request.currentId) && focusVideoCard(request.currentId)) {
      setViewerAnnouncement("");
      return;
    }
    const index = request.order.indexOf(request.currentId);
    const next = request.order.slice(index + 1).find(id => available.has(id));
    const previous = request.order.slice(0, Math.max(0, index)).reverse().find(id => available.has(id));
    if (!(next && focusVideoCard(next)) && !(previous && focusVideoCard(previous))) {
      document.getElementById("video-library-title")?.focus({ preventScroll: true });
    }
    setViewerAnnouncement(`${request.currentName} no longer matches this view.`);
  }
  async function closeVideo(updateLocation = true) {
    if (updateLocation) {
      if (viewerReturnSearch.current !== undefined) {
        internalNavigation.current = viewerReturnSearch.current;
        navigate(-1);
      } else {
        writeVideoLocation(undefined, 0, true);
      }
    }
    viewerReturnSearch.current = undefined;
    const closing = selectedRef.current;
    const closingOrder = viewerOrderRef.current.map(item => item.id);
    const refreshAfterClose = viewerNeedsReload.current;
    viewerNeedsReload.current = false;
    setSelected(undefined);
    if (closing) {
      if (refreshAfterClose) {
        // A saved title or time can move this video across the old page boundary.
        // Record the first-page key before clearing the cursor, or the reload
        // discards the focus request because the keys no longer match.
        const reloadQuery = { ...requestQuery };
        delete reloadQuery.cursor;
        if (viewerHasGridCard.current) {
          pendingViewerFocus.current = {
            currentId: closing.id, currentName: closing.name, order: closingOrder,
            queryKey: JSON.stringify(reloadQuery),
          };
        }
        resetPaging();
        setAttempt(value => value + 1);
      } else if (viewerStepped.current) {
        requestAnimationFrame(() => { focusVideoCard(closing.id); });
      }
    }
    if (checkingPendingTranscripts.current) return;
    checkingPendingTranscripts.current = true;
    try {
      let refresh = searchContentChanged.current;
      searchContentChanged.current = false;
      if (pendingTranscripts.current.size) {
        try {
          const token = await getIdToken();
          for (const [assetId, settings] of pendingTranscripts.current) {
            try {
              const response = await getVideoTranscript(token, { sourceId: source.id, assetId }, settings);
              if (response.transcript.state === "ready") {
                if (pendingTranscripts.current.get(assetId) === settings) pendingTranscripts.current.delete(assetId);
                invalidateVideoSearchCorpus(source.id);
                refresh = true;
              } else if (["failed", "cancelled", "stale", "not_requested", "needs_reconciliation"].includes(response.transcript.state)) {
                if (pendingTranscripts.current.get(assetId) === settings) pendingTranscripts.current.delete(assetId);
              }
            } catch (error) {
              if (error instanceof HttpError && [403, 404].includes(error.status)) {
                if (pendingTranscripts.current.get(assetId) === settings) pendingTranscripts.current.delete(assetId);
                refresh = true;
              }
            }
          }
        } catch { /* Keep pending requests when token acquisition fails. */ }
      }
      if (refresh || searchContentChanged.current) {
        searchContentChanged.current = false;
        setSearchRevision(value => value + 1);
      }
    } finally {
      checkingPendingTranscripts.current = false;
    }
  }
  function focusSearch() { document.getElementById("video-search")?.focus(); }
  const favoriteRefs: MediaFavoriteRef[] = page?.records.map(asset => ({ backend: "s3" as const, sourceId: asset.sourceId, id: asset.id })) ?? [];
  if (selected && !page?.records.some(asset => asset.id === selected.id && asset.sourceId === selected.sourceId)) {
    favoriteRefs.push({ backend: "s3", sourceId: selected.sourceId, id: selected.id });
  }
  const favorites = useMediaFavorites(userId, favoriteRefs, getIdToken);
  const favoriteUndo = useFavoriteUndo(userId, favorites);
  const bulk = useSourceMediaBulkEditing({
    source, userId, getIdToken, favorites, records: loading || error ? [] : page?.records ?? [],
    pageTags: pageVideoTags, recentTags: recentVideoTags,
    onTagsSaved: rememberVideoTags,
    disabled: Boolean(selected) || loading || Boolean(error) || metadataDirty || metadataSaving || visibleUploadOpen,
    onRefresh: () => {
      invalidateVideoSearchCorpus(source.id);
      setSearchRevision(value => value + 1);
      resetPaging();
      setAttempt(value => value + 1);
    },
    // Decision 3: back to the card that last had focus, or to search when it is gone.
    returnFocus: () => restoreMediaFocus(gridRef.current, focusSearch),
  });
  const contentLocked = metadataDirty || metadataSaving || transfersActive || bulk.dirty || bulk.saving;
  const ownExitRisk = contentLocked || uploadDefaultsDirty;
  const exitRisk = ownExitRisk || extraExitRisk || routedVideoActive;
  const discardExtraForNavigation = useRef(false);
  const discardVideoForNavigation = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && internalNavigation.current === nextLocation.search) {
      internalNavigation.current = undefined;
      return false;
    }
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    const leavesWorkspace = kind === "not-found";
    const opensRecycleBin = kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardExtraForNavigation.current = leavesWorkspace || opensRecycleBin;
    discardVideoForNavigation.current = leavesWorkspace;
    const moving = currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash;
    if (!moving) return false;
    if (ownExitRisk) return true;
    if (routedVideoActive && discardVideoForNavigation.current) return true;
    return extraExitRisk && discardExtraForNavigation.current;
  });
  useBeforeUnload(event => {
    if (!exitRisk) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const exitRiskRef = useRef(exitRisk);
  const routedVideoRef = useRef(routedVideoActive);
  exitRiskRef.current = exitRisk;
  routedVideoRef.current = routedVideoActive;
  const contentLockedRef = useRef(contentLocked);
  contentLockedRef.current = contentLocked;
  const hasExitRisk = useCallback(() => exitRiskRef.current || routedVideoRef.current, []);
  useRegisterExitGuard(selected || transfersActive || uploadDefaultsDirty || bulk.open || bulk.saving || extraExitRisk || routedVideoActive ? { saving: metadataSaving || bulk.saving, hasUnsavedWork: hasExitRisk } : null);
  useEffect(() => { onExitRiskChange?.(exitRisk); }, [exitRisk, onExitRiskChange]);
  useEffect(() => () => onExitRiskChange?.(false), [onExitRiskChange]);
  const navigationProceeding = useRef(false);
  useEffect(() => {
    if (blocker.state === "unblocked") navigationProceeding.current = false;
    if (blocker.state === "blocked" && !ownExitRisk &&
      !(discardVideoForNavigation.current && routedVideoActive) &&
      !(discardExtraForNavigation.current && extraExitRisk) &&
      !metadataSaving && !navigationProceeding.current) {
      navigationProceeding.current = true;
      blocker.proceed();
    }
  }, [blocker, ownExitRisk, routedVideoActive, extraExitRisk, metadataSaving]);
  const applyPage = useCallback((result: SourceMediaPage) => {
    const viewerRefreshBlocked = metadataDirtyRef.current || metadataSavingRef.current || viewerBusyRef.current;
    setPage(result);
    setQuickLook(previous => refreshQuickLookViewingCopy(previous, result.records));
    setViewerOrder(previous => previous.map(item => {
      const refreshed = result.records.find(record => record.id === item.id);
      return refreshed ? refreshedSourceMediaAsset(item, refreshed, viewerRefreshBlocked && item.id === selectedRef.current?.id) : item;
    }));
    setSelected(previous => {
      if (!previous) return previous;
      const refreshed = result.records.find(record => record.id === previous.id);
      return refreshed ? refreshedSourceMediaAsset(previous, refreshed, viewerRefreshBlocked) : previous;
    });
  }, []);
  const applyPollPage = useCallback((result: SourceMediaStatusPage) => {
    setQuickLook(previous => refreshQuickLookViewingCopy(previous, result.records));
    setPage(previous => previous ? {
      ...previous,
      records: previous.records.map(record => {
        const refreshed = result.records.find(candidate => candidate.id === record.id);
        return refreshed && sourceMediaStatusMatches(record, refreshed) ? { ...record, viewingCopy: refreshed.viewingCopy } : record;
      }),
    } : previous);
    setSelected(previous => {
      if (!previous) return previous;
      const refreshed = result.records.find(record => record.id === previous.id);
      return refreshed && sourceMediaStatusMatches(previous, refreshed) ? { ...previous, viewingCopy: refreshed.viewingCopy } : previous;
    });
    setViewerOrder(previous => previous.map(item => {
      const refreshed = result.records.find(record => record.id === item.id);
      return refreshed && sourceMediaStatusMatches(item, refreshed) ? { ...item, viewingCopy: refreshed.viewingCopy } : item;
    }));
  }, []);
  useEffect(() => {
    let current = true;
    const background = completionRefresh.current === `${userId}:${queryKey}`;
    completionRefresh.current = null;
    setRefreshingCompletion(background);
    if (!background) {
      setLoading(true);
      setError("");
    }
    const requestedAt = Date.now();
    // The page signs its own ready posters, so tiles skip one read call each.
    getIdToken().then(token => listSourceMedia(token, {
      ...(JSON.parse(queryKey) as SourceMediaQuery), ...(background ? {} : { posters: true }),
    }))
      .then(result => { if (current) {
        if (result.sortFallback) {
          currentWriteVideoQuery.current({ ...videoQuery, sort: result.sortFallback }, true);
          setSizeSortFallback(true);
          pendingViewerFocus.current = undefined;
        }
        for (const poster of result.posters ?? []) {
          const record = result.records.find(item => item.id === poster.assetId);
          if (!record) continue;
          const currentPoster = cachedPoster(source.id, poster.assetId, record.fileVersion);
          if (!currentPoster || !samePosterObject(currentPoster, poster.url)) {
            cachePoster(source.id, poster.assetId, poster.url, poster.expiresAt, requestedAt, record.fileVersion);
          }
        }
        applyPage(result);
        setLoadedPageKey(queryKey);
        const focusRequest = pendingViewerFocus.current;
        if (focusRequest && focusRequest.queryKey === queryKey) {
          pendingViewerFocus.current = undefined;
          requestAnimationFrame(() => focusAfterViewerReload(result, focusRequest));
        } else if (focusRequest) pendingViewerFocus.current = undefined;
        // An unfiltered page carries the source's exact total; the tab count reuses it at no cost.
        if (typeof result.total === "number") setMediaSourceCount(source.id, result.total);
        setRefreshingCompletion(false);
        setLoading(false);
      } })
      .catch(() => { if (current) {
        setRefreshingCompletion(false);
        if (!background) { pendingViewerFocus.current = undefined; setPage(undefined); setError("Videos could not be loaded. Try again."); setLoading(false); }
      } });
    return () => { current = false; };
  }, [queryKey, attempt, getIdToken, applyPage, source.id]);
  useMediaProcessingPoll(`${userId}:${queryKey}`, source.id,
    page?.records.filter(record => record.viewingCopy?.state === "processing").map(record => record.id) ?? [],
    getIdToken, applyPollPage, () => { completionRefresh.current = `${userId}:${queryKey}`; setAttempt(value => value + 1); },
    loading || refreshingCompletion || loadedPageKey !== queryKey);

  const pendingRouteNavigation = useRef(false);
  pendingRouteNavigation.current = blocker.state !== "unblocked";
  const navigationBlocked = blocker.state === "blocked" && !metadataSaving && !bulk.saving;
  // Selecting, favoriting or collecting from a card waits while the viewer, the batch editor or
  // the collection picker is open, or while details hold unsaved work (the images page's guard).
  const uploadOpenBlockedReason = routedLibraryActive
    ? "Finish the current Images upload first."
    : metadataDirty || metadataSaving
      ? "Save or discard video details first."
      : bulk.open
        ? "Finish the current bulk edit first."
        : selected
          ? "Close video details first."
          : quickLook
            ? "Close Quick Look first."
            : undefined;
  function showVideoUpload() {
    if (uploadOpenBlockedReason) return;
    setUploadOpen(true);
  }
  function routeVideoDrop(files: readonly File[]) {
    if (!uploadCanIntake || uploadOpenBlockedReason || visibleUploadOpen) return;
    const split = splitUploadFiles(files);
    routeChosenFiles(files);
    if (split.video.length > 0 && split.library.length === 0) setUploadOpen(true);
  }
  function handleWorkspaceDragOver(event: ReactDragEvent<HTMLElement>) {
    if (event.defaultPrevented || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploadCanIntake && !uploadOpenBlockedReason && !visibleUploadOpen
      ? "copy"
      : "none";
  }
  function handleWorkspaceDrop(event: ReactDragEvent<HTMLElement>) {
    if (event.defaultPrevented || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    routeVideoDrop(Array.from(event.dataTransfer.files));
  }
  useEffect(() => {
    if (source.canUpload && !suppressUpload && !routedLibraryActive) return;
    setUploadOpen(false);
  }, [routedLibraryActive, source.canUpload, suppressUpload]);
  useEffect(() => {
    function openFromShortcut(event: KeyboardEvent) {
      if (
        event.altKey || event.shiftKey ||
        !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "u" ||
        !source.canUpload || suppressUpload || mediaShortcutBlocked(event)
      ) return;
      event.preventDefault();
      if (uploadOpenBlockedReason) {
        setUploadFocusRequest(value => value + 1);
        return;
      }
      showVideoUpload();
    }
    window.addEventListener("keydown", openFromShortcut);
    return () => window.removeEventListener("keydown", openFromShortcut);
  }, [quickLook, selected, source.canUpload, suppressUpload, uploadOpenBlockedReason]);
  const cardsLocked = bulk.locked || metadataDirty || metadataSaving || visibleUploadOpen;
  // Every way of opening a video states its delete intent, so the card menu's Delete from
  // library never carries over to a later open.
  function openVideo(asset: SourceMediaAssetSummary, { confirmDelete = false, seek = 0 } = {}) {
    if (bulk.selectionBusy) return;
    setUploadOpen(false);
    viewerHasGridCard.current = page?.records.some(record => record.id === asset.id) ?? false;
    const openingPage = viewerHasGridCard.current ? page?.records ?? [asset] : [asset];
    viewerNeedsReload.current = false;
    viewerStepped.current = false;
    pendingViewerFocus.current = undefined;
    setViewerAnnouncement("");
    setViewerOrder([...openingPage]);
    setInitialSeek(seek);
    setConfirmDeleteOnOpen(confirmDelete);
    setSelected(asset);
    writeVideoLocation(asset, seek);
  }
  useEffect(() => {
    if (appliedLink.current === linkKey) return;
    let active = true;
    if (selectedRef.current) void closeVideo(false);
    else setSelected(undefined);
    setLinkError(permalink.error ?? "");
    if (!permalink.assetId) { appliedLink.current = linkKey; return; }
    void getIdToken().then(token => listSourceMedia(token, { sourceId: source.id, assetId: permalink.assetId }))
      .then(result => {
        if (!active) return;
        const asset = result.records.find(item => item.id === permalink.assetId && item.sourceId === source.id);
        if (!asset) { setLinkError(unavailableMediaMessage); return; }
        appliedLink.current = linkKey;
        setViewerOrder([asset]);
        setInitialSeek(permalink.seconds);
        setConfirmDeleteOnOpen(false);
        setSelected(asset);
      }).catch(() => { if (active) setLinkError(unavailableMediaMessage); });
    return () => { active = false; };
  }, [linkKey, getIdToken, source.id]);

  function openQuickLook(asset: SourceMediaAssetSummary) {
    if (cardsLocked || quickLook) return;
    setQuickLook({ order: [...(page?.records ?? [asset])], id: asset.id });
  }
  function closeQuickLook(restoreFocus = true) {
    if (!quickLook) return;
    const id = quickLook.id;
    setQuickLook(null);
    if (restoreFocus) requestAnimationFrame(() => { if (!gridRef.current?.focusItemById(id)) focusSearch(); });
  }
  function stepQuickLook(direction: "previous" | "next") {
    setQuickLook(previous => {
      if (!previous) return previous;
      const index = previous.order.findIndex(item => item.id === previous.id);
      const target = previous.order[index + (direction === "next" ? 1 : -1)];
      return target ? { ...previous, id: target.id } : previous;
    });
  }
  function showUploader(asset: SourceMediaAssetSummary) {
    const uid = asset.uploadedBy?.uid;
    if (!canFilterUploader || !uid) return;
    if (writeVideoQuery({ ...setVideoStructuredFilter(videoLocation, { field: "by", value: uid }).query, q: searchDraft.current })) {
      setUploader({ uid, name: asset.uploadedBy!.name });
    }
  }
  function tileAction(asset: SourceMediaAssetSummary, id: MediaTileActionId) {
    if (id === "open") { openVideo(asset); return; }
    if (id === "uploader") { showUploader(asset); return; }
    if (cardsLocked) return;
    if (id === "quick-look") { openQuickLook(asset); return; }
    if (id === "favorite") void favoriteUndo.toggle({ backend: "s3", sourceId: asset.sourceId, id: asset.id }, asset.name);
    if (id === "collect") bulk.collect(asset);
    if (id === "select") bulk.changeSelection(toggleSelection(bulk.selection, asset, bulk.rules));
    if (id === "delete") openVideo(asset, { confirmDelete: true });
  }
  // Escape in the grid: clear the selection, else clear the search. The viewer is a dialog
  // with its own Escape.
  function escapeResults() {
    if (bulk.selection.items.length > 0) {
      if (!bulk.pickerOpen) bulk.clear();
      return;
    }
    if (search || searchDraft.current) {
      searchDraft.current = "";
      writeVideoQuery({ ...videoQuery, q: "" });
    }
    focusSearch();
  }
  // One owner for both layouts: a tile in its context menu, or a list row whose
  // cells sit in the same context menu, so the row stays the grid's row. cardsLocked is the
  // one guard. Both take the same VideoPoster, so switching View reuses cached posters.
  function renderTile(asset: SourceMediaAssetSummary, context: MediaGridItemContext) {
    const ref = { backend: "s3" as const, sourceId: asset.sourceId, id: asset.id };
    const favorite = favorites.value(ref);
    const favoritePending = favorites.pending(ref);
    const canDelete = source.canDelete === true;
    const selectionBusy = bulk.selectionBusy;
    const selectionMenu = context.selected && bulk.selection.items.length > 1 ? {
      count: bulk.selection.items.length,
      actions: availableSelectionActions(
        bulk.selectionActions,
        cardsLocked,
        selectionBusy,
      ),
      onAction: bulk.selectionAction,
    } : undefined;
    const withMenu = (children: ReactElement) => <MediaContextMenu
      actionsDisabled={cardsLocked}
      canEditSelection={source.canEditMetadata}
      selectionBusy={selectionBusy}
      selectionActions={bulk.selectionActions}
      favoriteSettled={favorite !== undefined && !favoritePending}
      onAction={id => tileAction(asset, id)}
      onSelectionAction={bulk.selectionAction}
      selectionCount={bulk.selection.items.length}
      tile={{ surface: "video", name: asset.name, favorite: favorite === true, available: true, selected: context.selected, canDelete, uploader: canFilterUploader ? asset.uploadedBy : undefined, quickLook: true }}>
      {children}
    </MediaContextMenu>;
    const shared = {
      actionsDisabled: cardsLocked, asset, canDelete, favorite, favoritePending, fields: visibleVideoFields, quickLook: true,
      showUploaderFilter: canFilterUploader,
      onAction: (id: MediaTileActionId) => tileAction(asset, id), onOpen: () => openVideo(asset),
      onSelectChange: context.onSelectChange, opened: asset.id === selected?.id, selected: context.selected,
      selectionMenu,
      surface: "video" as const, tabbable: context.tabbable, thumbnail: <VideoPoster asset={asset} getIdToken={getIdToken} />,
    };
    if (view === "list") return <MediaRow {...shared} wrapCells={withMenu} />;
    return withMenu(<MediaTile {...shared} onTagFilter={filterByTag} selectionMode={context.selectionMode} />);
  }
  // The count is announced from one always-mounted status, so the bar can come and go
  // without a live region of its own.
  const [hadSelection, setHadSelection] = useState(false);
  if (bulk.selection.items.length > 0 && !hadSelection) setHadSelection(true);
  const selectionStatus = bulk.summary || selectionAnnouncement(0, hadSelection ? 1 : 0);
  function keepNavigation() { blocker.reset?.(); }
  function discardNavigation() {
    navigationProceeding.current = true;
    blocker.proceed?.();
    setMetadataDirty(false);
    if (discardVideoForNavigation.current) onDiscardVideo?.();
    if (discardExtraForNavigation.current) onDiscardExtra?.();
  }

  const tagOptions = [...new Set([videoQuery.tag, ...pageVideoTags, ...recentVideoTags].filter((value): value is string => Boolean(value)))].slice(0, 30);
  const uploaderNames = new Map<string, string>();
  if (canFilterUploader) {
    for (const asset of page?.records ?? []) {
      if (asset.uploadedBy?.uid && asset.uploadedBy.name?.trim()) uploaderNames.set(asset.uploadedBy.uid, asset.uploadedBy.name);
    }
    if (uploader?.uid && uploader.name?.trim()) uploaderNames.set(uploader.uid, uploader.name);
  }
  const filterState = { query: videoQuery, selectedId: videoLocation.selectedId };
  const chips = videoFilterChips(filterState, (id) => id === userId ? "Me" : uploaderNames.get(id) ?? "Staff uploader");
  function changeStructuredFilter(property: string, value: string) {
    if (property !== "tag" && property !== "by" && property !== "rights") return;
    if (property === "tag" && !value.trim()) { setTagError("Enter a tag or choose another filter."); return; }
    setTagError("");
    const current = videoQuery[property];
    const filter = property !== "tag" && current === value ? null : { field: property, value } as VideoStructuredFilter;
    const next = setVideoStructuredFilter(filterState, filter);
    writeVideoQuery({ ...next.query, q: searchDraft.current });
  }
  const sortOptions = [
    { value: "updated_desc", label: "Recently updated", directions: [{ value: "desc", label: "Newest first" }] },
    { value: "updated_asc", label: "Oldest update", directions: [{ value: "asc", label: "Oldest first" }] },
    { value: "name_asc", label: "Name", directions: [{ value: "asc", label: "A–Z" }] },
    { value: "size_desc", label: "File size", directions: [{ value: "desc", label: "Largest first" }, { value: "asc", label: "Smallest first" }] },
  ] as const;
  const currentSort = search ? "name_asc" : videoQuery.sort;
  const currentSortOption = currentSort === "size_asc" ? "size_desc" : currentSort;
  const toolbar: MediaToolbarSurfaceConfiguration = {
    surface: "video",
    search: {
      value: search, onCommit: (value) => {
        if (!metadataDirty && !metadataSaving && !bulk.open) writeVideoQuery({ ...videoQuery, q: value }, true);
      },
      onSubmit: (value) => {
        if (!metadataDirty && !metadataSaving && !bulk.open) writeVideoQuery({ ...videoQuery, q: value });
      },
      onDraftChange: (value) => { searchDraft.current = value; }, syncKey: `${userId}:${source.id}`,
      locked: metadataDirty || metadataSaving || bulk.open, id: "video-search", maxLength: 160,
      label: "Search video names by prefix", landmarkLabel: "Video search",
      placeholder: "Search video names", title: "Search video names by prefix · /",
    },
    filter: {
      properties: [
        { id: "tag", label: "Tag", picker: "text", appliedCount: videoQuery.tag ? 1 : 0,
          options: tagOptions.map(value => ({ value, label: value, selected: videoQuery.tag === value })),
          hint: "Enter an exact tag or choose one from this page or your recent tags.",
          text: { value: tagInput, placeholder: "Enter an exact tag", maxLength: 80, error: tagError,
            onChange: value => { setTagInput(value); setTagError(""); } } },
        { id: "rights", label: "Rights review", picker: "options", appliedCount: videoQuery.rights ? 1 : 0,
          options: [{ value: "pending", label: "Needs review" }, { value: "complete", label: "Rights recorded" }]
            .map(option => ({ ...option, selected: videoQuery.rights === option.value })) },
        { id: "by", label: "Uploader", picker: "options", appliedCount: videoQuery.by ? 1 : 0,
          options: [{ value: userId, label: "Me" },
            ...[...uploaderNames].filter(([id]) => id !== userId).map(([value, label]) => ({ value, label }))]
            .map(option => ({ ...option, selected: videoQuery.by === option.value })) },
      ],
      chips, note: "Videos filter by one property at a time.",
      onSelect: changeStructuredFilter,
      onRemove: () => writeVideoQuery({ ...setVideoStructuredFilter(filterState, null).query, q: searchDraft.current }),
      onClearAll: clearFilters,
    },
    sort: {
      model: { value: currentSortOption, direction: videoListSort(currentSort).direction, options: [...sortOptions],
        locked: search ? { label: "Name A–Z while searching", reason: "Clear search to choose another sort" } : undefined },
      onChange: ({ value, direction }) => {
        if (!search) applyDraftQuery({
          sort: value === "size_desc" && direction === "asc" ? "size_asc" : value as VideoMediaSort,
        });
      },
    },
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
        { kind: "select", id: "sort", label: "Sort by", value: currentSort, disabled: Boolean(search),
          note: search ? "Clear search to change sort" : undefined, noteBelow: Boolean(search),
          options: [{ value: "updated_desc", label: "Recently updated" }, { value: "updated_asc", label: "Oldest update" },
            { value: "name_asc", label: "Name A–Z" }, { value: "size_desc", label: "File size, largest first" },
            { value: "size_asc", label: "File size, smallest first" }],
          onChange: value => { if (!search) applyDraftQuery({ sort: value as VideoMediaSort }); } },
        { kind: "fields", id: "fields", label: "Show on cards and in list columns",
          options: VIDEO_MEDIA_CARD_FIELD_ORDER.map(value => ({ value, label: value === "rights" ? "Rights" : value === "updated" ? "Updated" : value === "uploader" ? "Uploader" : value.charAt(0).toUpperCase() + value.slice(1), selected: visibleVideoFields[value] })),
          onChange: value => { const field = value as VideoMediaCardField; setDisplay({ ...display, fields: { ...display.fields, [field]: !display.fields[field] } }); } },
        { kind: "select", id: "per-page", label: "Per page", value: String(videoQuery.limit),
          options: [24, 48, 96].map(value => ({ value: String(value), label: String(value) })),
          onChange: value => applyDraftQuery({ limit: Number(value) as typeof videoQuery.limit }) },
      ],
      onReset: () => { resetDisplay(); applyDraftQuery({ limit: DEFAULT_VIDEO_MEDIA_DISPLAY.pageSize }); },
    },
    upload: source.canUpload && !suppressUpload ? {
      buttonLabel: "Upload",
      accessibleLabel: "Upload media",
      title: "Upload images, PDFs, WAV audio, or videos",
      onUpload: showVideoUpload,
      focusRequest: uploadFocusRequest,
      lockedReason: uploadOpenBlockedReason,
    } : null,
    moreItems: [{ key: "select-page", label: "Select this page", icon: "check-square", onSelect: () => bulk.pageSelection.onChange(true) }],
    shortcuts: null,
  };

  function updateSelectedVideo(asset: SourceMediaAssetSummary, videoSearchRevision?: number) {
    const previous = selectedRef.current;
    const updated = asset.uploadedBy?.uid && asset.uploadedBy.uid === previous?.uploadedBy?.uid && previous.uploadedBy
      ? { ...asset, uploadedBy: previous.uploadedBy } : asset;
    bulk.refreshAsset(updated);
    setSelected(updated);
    setViewerOrder(order => order.map(item => item.id === updated.id ? updated : item));
    if (videoSearchRevision === undefined) invalidateVideoSearchCorpus(source.id);
    else updateCachedVideoSearchAsset(userId, updated, videoSearchRevision);
    setSearchRevision(value => value + 1);
    viewerNeedsReload.current = true;
  }

  function offerVideoSaveUndo({ previous, asset }: VideoDetailsSaveReceipt) {
    const requestUser = userId;
    let used = false;
    notice.show(`${asset.name} details saved.`, { action: { label: "Undo", onClick: () => {
      if (used || !notice.isCurrent() || currentUserId.current !== requestUser || metadataDirtyRef.current ||
        selectedRef.current?.id !== asset.id || selectedRef.current.sourceId !== asset.sourceId ||
        selectedRef.current.version !== asset.version) {
        if (!used && notice.isCurrent()) notice.show("Save Undo is no longer available. Reload the video before editing.", { tone: "error" });
        return;
      }
      used = true;
      notice.show(`Restoring ${asset.name} details.`);
      void getIdToken().then(token => updateSourceMediaMetadata(token, asset.sourceId, asset.id, asset.version, previous,
        { preserveVideoSearchCache: true }))
        .then(response => {
          if (!notice.isCurrent() || currentUserId.current !== requestUser) return;
          updateSelectedVideo(response.asset, response.videoSearchRevision);
          notice.show(`${asset.name} details restored.`);
        }).catch(error => {
          if (!notice.isCurrent() || currentUserId.current !== requestUser) return;
          if (error instanceof HttpError && error.status === 409) {
            viewerNeedsReload.current = true;
            notice.show("This video changed. Close and reload its details before editing.", { tone: "error" });
          } else notice.show("Could not restore video details. Reload the video before editing.", { tone: "error" });
        });
    } } });
  }

  return <section ref={libraryRef} className="source-media-library" aria-labelledby="video-library-title"
    onDragOver={handleWorkspaceDragOver} onDrop={handleWorkspaceDrop}
    data-density={display.density === "app" ? undefined : display.density} data-thumbnail={display.thumbnail}>
    <header className="surface-intro"><div><h2 id="video-library-title" tabIndex={-1}>{source.label}</h2><p>{source.description}</p></div></header>
    <div className="source-media-library-layout">
      <div className="source-media-library-main">
        <MediaToolbar configuration={toolbar} savedViews={{
          userId,
          surface: `video:${source.id}`,
          query: encodeVideoMediaLocation({ ...videoQuery, cursor: undefined }, null).toString(),
          currentViewId: videoLocation.view,
          display,
          onApply: applySavedView,
          onMissing: removeMissingSavedView,
          onResetFilters: resetSavedViewDefaults,
        }} />
        {searchError ? <p role="alert">{searchError}</p> : null}
        <VideoOriginalNotices sourceId={source.id} getIdToken={getIdToken}
          onDismissed={() => document.getElementById("video-library-title")?.focus()}
          onOpen={assetId => {
            void getIdToken().then(token => listSourceMedia(token, { sourceId: source.id, assetId }))
              .then(result => { if (result.records[0]) openVideo(result.records[0]); else setLinkError("This video is no longer available."); })
              .catch(() => setLinkError("This video could not be opened. Try again."));
          }} />
        {linkError ? <InlineMessage tone="warning" title="Media link">{linkError}</InlineMessage> : null}
        {source.id === "video-library" ? <VideoMeaningSearch key={`${userId}:${source.id}:${shownSearchRevision}`} userId={userId} sourceId={source.id} query={search} getIdToken={getIdToken} filters={activeFilter} disabled={contentLocked || !!selected || bulk.open || visibleUploadOpen}
          renderPoster={asset => <VideoPoster asset={asset} getIdToken={getIdToken} />}
          onOpen={(asset, seconds) => { if (!contentLockedRef.current && !selectedRef.current && !bulk.open && !visibleUploadOpen) openVideo(asset, { seek: seconds }); }} /> : null}
        {deletedName ? <InlineMessage tone="success" title="Video deleted from library">{deletedName} was removed. The original is retained for recovery.</InlineMessage> : null}
        {favorites.loadError || favorites.saveError ? <InlineMessage tone="error" title="Favorites need attention">
          <span>{favorites.loadError || favorites.saveError}</span>
          {favorites.loadError ? <Button disabled={favorites.retryDisabled} onClick={favorites.retry}>Try again</Button> : null}
        </InlineMessage> : null}
        {bulk.notice}
        {sizeSortFallback && videoQuery.sort === "updated_desc" ? <InlineMessage tone="info" role="status" title="File-size sorting is getting ready">
          Videos are shown by most recent update. Try file-size sorting again later.
        </InlineMessage> : null}
        <p className="sr-only" role="status">{selectionStatus}</p>
        <p className="sr-only" role="status">{viewerAnnouncement}</p>
        {page && !loading && !error ? <p className="source-video-result-summary" ref={resultSummaryRef} role="status" tabIndex={-1}>{page.total === null ? `${page.records.length} videos on this page` : `${page.total} videos`}{videoQuery.by ? ` · Uploaded by ${videoQuery.by === userId ? "Me" : uploaderNames.get(videoQuery.by) ?? "Staff uploader"}` : videoQuery.tag ? ` · Tag: ${videoQuery.tag}` : ""}</p> : null}
        <DropOverlay
          blocked={metadataDirty}
          canUpload={source.canUpload && !suppressUpload && uploadCanIntake && !metadataSaving && !bulk.open && (!selected || metadataDirty) && !quickLook && !visibleUploadOpen && !routedLibraryActive}
          destination={source.label}
          onFiles={routeVideoDrop}
        >
          <div className="source-video-results" data-bulk-open={bulk.open || undefined}>
            {loading ? <LoadingIndicator label="Loading videos" /> : error ? <InlineMessage tone="error" title="Video library unavailable">{error}<Button onClick={() => setAttempt(value => value + 1)}>Try again</Button></InlineMessage>
              : page && <>
                {page.records.length === 0 ? <EmptyState title="No videos found" description={search || chips.length > 0 ? "Try a different name or clear the filters." : "Videos will appear here after they are added to this library."} />
                  : <MediaGrid className="source-video-tiles" handleRef={gridRef} header={<MediaRowHeader pageSelection={bulk.pageSelection} surface="video" fields={visibleVideoFields}
                      sort={search ? undefined : { ...videoListSort(videoQuery.sort),
                        onSortChange: next => applyDraftQuery({ sort: videoSortFromList(next.sort, next.direction) }) }} />} inert={bulk.open}
                    items={page.records} label="Videos" layout={view} onEscape={escapeResults} onOpen={asset => openVideo(asset)} onQuickLook={cardsLocked ? undefined : openQuickLook}
                    onSelectionChange={bulk.changeSelection} renderItem={renderTile} rules={bulk.rules} selection={bulk.selection} />}
              </>}
            {page && (cursor || page.hasMore || loadedCursor) && !error ? <MediaPaging mode="cursor" label="Video pages" page={previousCursors.length + 1} isLastPage={!page.nextCursor} loading={loading || loadedPageKey !== queryKey} pageStartRef={resultSummaryRef}
              onFirst={resetPaging}
              onPrevious={() => setPaging({ key: videoQueryKey, cursor: previousCursors.at(-1), previous: previousCursors.slice(0, -1) })}
              onNext={() => setPaging({ key: videoQueryKey, cursor: page.nextCursor ?? undefined, previous: [...previousCursors, cursor] })} /> : null}
            {/* The bar floats at the bottom of the results while something is selected, as on the
                images page, so selecting never moves the grid under the pointer. */}
            {bulk.inspector}
            {bulk.bar}
            <div className="source-video-upload-tray" ref={setUploadTrayTarget} />
          </div>
        </DropOverlay>
      </div>
      {source.canUpload && !suppressUpload ? <UploadSheet heading={`Upload to ${source.label}`} onFocusFallback={() => setUploadFocusRequest(value => value + 1)} onRequestClose={() => setUploadOpen(false)} open={visibleUploadOpen}>
        <VideoUploadPanel key={`${userId}:${source.id}`} sourceId={source.id} userId={userId} getIdToken={getIdToken}
          onActiveChange={setTransfersActive}
          onDefaultsDirtyChange={setUploadDefaultsDirty}
          onAdmissionFailed={message => notice.show(message, { tone: "error" })}
          onCanceled={message => notice.show(message)}
          onIntakeChange={setUploadCanIntake}
          onOpenSheet={showVideoUpload}
          onTrayEmptyFocus={() => setUploadFocusRequest(value => value + 1)}
          onTransferStarted={() => setUploadOpen(false)}
          openSheetBlockedReason={uploadOpenBlockedReason}
          presentation="sheet"
          rejectedFiles={routedRejectedFiles}
          trayTarget={uploadTrayTarget}
          onUploaded={asset => { notice.show(`${asset.name} is ready in the video library.`, { preserveOnNextRoute: true }); setMediaSourceCount(source.id, null); resetFilters(); setAttempt(value => value + 1); }} />
      </UploadSheet> : null}
    </div>

    {quickLook && quickLookAsset ? <QuickLook item={{ id: quickLookAsset.id, name: quickLookAsset.name, kind: "video",
      previewUrl: quickLookRead?.id === quickLookAsset.id && quickLookRead.fileVersion === quickLookAsset.fileVersion ? quickLookRead.url : quickLookPoster(quickLookAsset).url }}
      position={quickLook.order.findIndex(item => item.id === quickLookAsset.id) + 1} count={quickLook.order.length}
      onStep={stepQuickLook} onClose={closeQuickLook} onPreviewError={item => {
        invalidatePoster(quickLookAsset.sourceId, item.id, quickLookAsset.fileVersion);
        setQuickLookRead({ id: item.id, fileVersion: quickLookAsset.fileVersion, url: null });
      }} /> : null}
    {selected ? <VideoPreview sourceLabel={source.label} initialSeek={initialSeek} initialConfirmDelete={confirmDeleteOnOpen} principal={principal} getIdToken={getIdToken} asset={selected} canEditMetadata={source.canEditMetadata} canReplace={source.canReplace === true} canExportOrientation={source.canExportOrientation === true} canRequestProduction={source.canRequestProduction} canDelete={source.canDelete === true}
      preserveVideoSearchCache
      steppingOrder={viewerOrder} onStep={asset => { viewerStepped.current = true; setSelected(asset); writeVideoLocation(asset, 0, true); }}
      pageTags={pageVideoTags} recentTags={recentVideoTags} onTagsSaved={rememberVideoTags}
      onDeleted={() => { if (!pendingRouteNavigation.current) writeVideoLocation(undefined, 0, true); pendingTranscripts.current.delete(selected.id); searchContentChanged.current = false; invalidateVideoSearchCorpus(source.id); setSearchRevision(value => value + 1); setMediaSourceCount(source.id, null); bulk.removeAsset(selected.id); setDeletedName(selected.name); setSelected(undefined); resetPaging(); setAttempt(value => value + 1); requestAnimationFrame(() => document.getElementById("video-search")?.focus()); }}
      onSearchContentChanged={() => { invalidateVideoSearchCorpus(source.id); searchContentChanged.current = true; }}
      onExportStatus={onExportStatus}
      onTranscriptRequested={(assetId, settings, ready) => {
        if (ready) {
          pendingTranscripts.current.delete(assetId);
          invalidateVideoSearchCorpus(source.id);
          searchContentChanged.current = true;
        }
        else pendingTranscripts.current.set(assetId, settings);
      }}
      onTranscriptObserved={(assetId, settings) => {
        if (!pendingTranscripts.current.has(assetId)) pendingTranscripts.current.set(assetId, { ...settings });
      }}
      onTranscriptReady={(assetId, settings) => {
        const pending = pendingTranscripts.current.get(assetId);
        if (pending && sameTranscriptSelection(pending, settings)) {
          pendingTranscripts.current.delete(assetId);
          invalidateVideoSearchCorpus(source.id);
          searchContentChanged.current = true;
        }
      }}
      onDirtyChange={setMetadataDirty} onSavingChange={setMetadataSaving} onBusyChange={setViewerBusy}
      navigationBlocked={navigationBlocked}
      onKeepNavigation={keepNavigation}
      onDiscardNavigation={discardNavigation}
      onUpdated={updateSelectedVideo} onSaveReceipt={offerVideoSaveUndo}
      onSaveSuccess={(asset) => notice.show(`${asset.name} details saved.`)}
      onClose={() => { void closeVideo(); }}
      favorite={{ name: selected.name,
        favorite: favorites.value({ backend: "s3", sourceId: selected.sourceId, id: selected.id }),
        pending: favorites.pending({ backend: "s3", sourceId: selected.sourceId, id: selected.id }),
        onToggle: () => void favoriteUndo.toggle({ backend: "s3", sourceId: selected.sourceId, id: selected.id }, selected.name) }} /> : null}
    {bulk.editor({ navigationBlocked, onKeepNavigation: keepNavigation, onDiscardNavigation: discardNavigation })}
    {!selected && !bulk.reviewOpen && navigationBlocked ? <LeaveGuardDialog
      onConfirm={() => { bulk.discard(); discardNavigation(); }} onCancel={keepNavigation} /> : null}
  </section>;
}

import { originalAccessMessage } from "../lib/video-original";
import { clipExportMessage } from "../lib/clip-export-message";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CommentThread } from "../lib/media-comment-threads";
import type { MediaComment } from "../lib/media-feedback";
import { Button, InlineMessage, Select, TextInput } from "./ui/Primitives";
import { VideoProcessingStatus } from "./VideoProcessingStatus";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { TranscriptionCredentials } from "./TranscriptionCredentials";
import { VideoTranscriptVariants } from "./VideoTranscriptVariants";
import { TranscriptEditor } from "./TranscriptEditor";
import { EditorVideoExports } from "./EditorVideoExports";
import type { MenuItem } from "./ui/Menu";
import { MediaDialogNotice } from "../context/MediaDialogContext";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import { avidFrameRates, type AvidFrameRate, type TranscriptDownloadFormat, cancelVideoTranscriptAlignment, clipResolutionAvailable, estimateAwsTranscriptionCharge, transcriptionChargeLabel, getVideoClip, getVideoTranscript, listVideoClips, parseVideoTime, readVideoClip, readVideoTranscript, readClipTranscript, type ClipTranscriptFormat, requestVideoClip, requestVideoTranscript, requestVideoTranscriptAlignment, saveVideoTranscript, videoTime, type ClipSettings, type TranscriptSegment, type TranscriptResponse, type TranscriptSettings, type VideoClip } from "../lib/video-production";
import "./VideoProductionTools.css";

function downloadFile(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}
export function videoProductionMessage(error: unknown, fallback: string, operation?: "request_transcript" | "request_clip" | "download_premiere" | "download_avid" | "download_clip_transcript") {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const detail = error instanceof Error ? error.message : "";
  const originalMessage = originalAccessMessage(error);
  if (originalMessage) return originalMessage;
  if (error && typeof error === "object" && "name" in error && error.name === "RequestNotDispatchedError") {
    return "Browser verification failed. Reload Boardwalk, then try again.";
  }
  if (operation === "download_clip_transcript" && status === 409) {
    if (detail === "Align the edited transcript or move the clip boundary to a passage boundary before exporting its transcript") return "This clip cuts through an edited passage without aligned words. Resync the transcript or export a clip that includes the full passage.";
    if (detail === "Re-export this clip to record its frame timing before downloading its transcript") return "Export this clip again before downloading its transcript. The older export has no saved frame timing.";
    if (detail === "Choose a ready clip that has not expired") return "Wait for the clip to finish. If it has expired, export it again.";
    if (detail === "Transcript has invalid passage timing") return "This transcript has invalid passage timing. Correct or resync its timing before exporting this section.";
    if (detail === "Clip exceeds transcript audio duration" || detail === "Clip timing is invalid") return "The clip range does not fit this transcript’s audio. Export a new clip within the recording’s duration.";
    return "The saved clip or transcript changed or is no longer ready. Reopen both before downloading the matching transcript.";
  }
  if (operation === "download_premiere" && status === 409 && detail === "Premiere export requires unchanged word timings for every passage. Use the text or TSV log for corrected transcripts") return "Premiere needs unchanged word timings for every passage. This saved transcript does not have them. Download text or the soundbite log instead.";
  if ((operation === "download_premiere" || operation === "download_avid") && status === 409 && detail === "Transcript has no valid timed passages to export") return "This saved transcript has no valid timed passages for this export. Download text or check the saved transcript.";
  if (operation === "download_avid" && status === 400 && detail === "Avid frame offset is too large") return "The frame offset is too large. Enter a smaller whole-frame offset.";
  if (operation === "request_transcript" && status === 429 && detail === "The paid transcript allowance cannot be verified. Ask an administrator to check paid limits or enable local processing") {
    return "The paid transcript allowance cannot be verified. Ask a CMS administrator to check paid limits or enable local processing.";
  }
  if (operation === "request_transcript" && status === 429 && detail.startsWith("The station has 500 queued or running local transcripts.")) {
    return "The station has 500 local transcripts queued or running. Wait for a transcript to finish, then try again.";
  }
  if (operation === "request_transcript" && status === 409) {
    if (detail === "Paid transcription supports videos of one hour or less. Ask an administrator about local processing for longer videos") return "Paid transcription supports videos of one hour or less. Ask an administrator about local processing for longer videos.";
    if (detail === "Transcription requires a viewing copy of 2 hours or less and under 2 GB") return "Transcription requires a viewing copy of 2 hours or less and under 2 GB. Reopen the video to check its current copy.";
    return "The viewing copy is not ready or has changed. Reopen the video and check its viewing copy before requesting transcription.";
  }
  if (operation === "request_clip" && status === 409) {
    if (detail === "Use source resolution until viewing-copy dimensions are available") return "Choose Match web copy until its dimensions are available.";
    if (detail === "Choose a resolution no larger than the viewing copy") return "Choose a resolution no larger than the viewing copy. Reopen the video if its copy has changed.";
    return "The selected range or viewing copy has changed or is not ready. Reopen the video, check its viewing copy, and select the range again.";
  }
  if (operation === "request_clip" && status === 429) {
    const message = clipExportMessage(error);
    if (message) return message;
  }
  if (status === 401) return "Your session could not be verified. Sign in again, then check the saved status.";
  if (status === 403) return "This action is not available for your account. Ask a CMS administrator for help.";
  if (status === 404) return "The video or saved result is no longer available. Reopen the video library to check its current state.";
  if (status === 429) return "The request limit has been reached. Wait before checking the saved status again.";
  if (status === 503) return "Processing is currently unavailable. Check the saved status later or ask a CMS administrator for help.";
  return fallback;
}
const clipQualityLabels = { smaller: "Smaller file", balanced: "Balanced", high: "Higher quality" };
function savedClipSettings(clip: VideoClip): ClipSettings { return { resolution: clip.resolution ?? "source", quality: clip.quality ?? "balanced" }; }
function clipSettingsLabel(clip: VideoClip) {
  const settings = savedClipSettings(clip);
  return `${settings.resolution === "source" ? "Match web copy" : settings.resolution} · ${clipQualityLabels[settings.quality]}`;
}
const activeTranscript = (state?: string) => state === "queued" || state === "processing";
const activeClip = (state?: string) => state === "queued" || state === "processing";

export function useVideoProductionTools({ headerControls = false, workspace = false, commentThreads, commentsIncomplete, onOpenComment, commentsAction, onWorkspacePaneChange, principal, onCredentialsDirtyChange, onCredentialsBusyChange, asset, getIdToken, player, canRequest, disabled, onDownloadOriginal, onTranscriptDirtyChange, onTranscriptSavingChange, onBusyChange, onSearchContentChanged, onTranscriptRequested, onTranscriptObserved, onTranscriptReady }: {
  principal?: Principal;
  headerControls?: boolean;
  workspace?: boolean;
  commentThreads?: readonly CommentThread[];
  commentsIncomplete?: boolean;
  onOpenComment?: (comment: MediaComment) => void;
  commentsAction?: ReactNode;
  onWorkspacePaneChange?: (pane: "watch" | "transcript") => void;
  onCredentialsDirtyChange?: (dirty: boolean) => void;
  onCredentialsBusyChange?: (busy: boolean) => void;
  asset: SourceMediaAssetSummary;
  getIdToken: () => Promise<string>;
  player: RefObject<HTMLVideoElement | null>;
  canRequest: boolean;
  disabled: boolean;
  onDownloadOriginal?: () => void;
  onTranscriptDirtyChange?: (dirty: boolean) => void;
  onTranscriptSavingChange?: (saving: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onSearchContentChanged?: () => void;
  onTranscriptRequested?: (assetId: string, settings: TranscriptSettings, ready: boolean) => void;
  onTranscriptObserved?: (assetId: string, settings: TranscriptSettings) => void;
  onTranscriptReady?: (assetId: string, settings: TranscriptSettings) => void;
}) {
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [credentialsDirty, setCredentialsDirty] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const credentialsLocked = credentialsDirty || credentialsBusy;
  useEffect(() => { onCredentialsDirtyChange?.(credentialsDirty); return () => onCredentialsDirtyChange?.(false); }, [credentialsDirty, onCredentialsDirtyChange]);
  useEffect(() => { onCredentialsBusyChange?.(credentialsBusy); return () => onCredentialsBusyChange?.(false); }, [credentialsBusy, onCredentialsBusyChange]);
  const [transcriptEditing, setTranscriptEditing] = useState(false);
  const [transcriptDirty, setTranscriptDirty] = useState(false);
  const [transcriptSaving, setTranscriptSaving] = useState(false);
  const [byokBusy, setByokBusy] = useState(false);
  const editingRef = useRef(false);
  const transcriptLocked = transcriptEditing || transcriptSaving || byokBusy;
  editingRef.current = transcriptLocked;
  useEffect(() => { onTranscriptDirtyChange?.(transcriptDirty); return () => onTranscriptDirtyChange?.(false); }, [transcriptDirty, onTranscriptDirtyChange]);
  useEffect(() => { onTranscriptSavingChange?.(transcriptSaving || byokBusy); return () => onTranscriptSavingChange?.(false); }, [transcriptSaving, byokBusy, onTranscriptSavingChange]);
  const [avidFrameRate, setAvidFrameRate] = useState<AvidFrameRate | "">("");
  const [avidFrameOffset, setAvidFrameOffset] = useState("0");
  const validAvidOptions = avidFrameRate !== "" && /^\d+$/.test(avidFrameOffset) && Number.isSafeInteger(Number(avidFrameOffset));
  const [playbackSeconds, setPlaybackSeconds] = useState(0);
  const [transcriptOpen, setTranscriptOpen] = useState(workspace);
  const [transcriptSettingsOpen, setTranscriptSettingsOpen] = useState(false);
  const settingsVisible = workspace ? transcriptSettingsOpen : transcriptOpen;
  const transcriptWorkspace = useRef<HTMLDivElement>(null);
  const [paidActionTarget, setPaidActionTarget] = useState<HTMLDivElement | null>(null);
  const transcriptSection = useRef<HTMLDetailsElement>(null);
  const clipSection = useRef<HTMLDetailsElement>(null);
  const transcriptSectionId = useId();
  const clipSectionId = useId();
  function openSection(section: "transcript" | "clip", { focusSummary = true }: { focusSummary?: boolean } = {}) {
    if (section === "transcript") setTranscriptOpen(true); else setClipOpen(true);
    onWorkspacePaneChange?.(section === "transcript" ? "transcript" : "watch");
    if (!focusSummary) return;
    requestAnimationFrame(() => {
      const target = section === "transcript" ? transcriptSection.current : clipSection.current;
      if (workspace && section === "transcript") {
        (transcriptWorkspace.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? transcriptWorkspace.current?.querySelector<HTMLElement>("h3"))?.focus();
        return;
      }
      target?.querySelector("summary")?.focus();
      target?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }
  const [settings, setSettings] = useState<TranscriptSettings>({ languageCode: "en-US", maxSpeakers: 10 });
  const [transcript, setTranscript] = useState<TranscriptResponse>();
  const loadedTranscriptSettings = { ...settings, transcriptId: transcript?.transcript.id ?? settings.transcriptId };
  const [transcriptError, setTranscriptError] = useState("");
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptPageLoading, setTranscriptPageLoading] = useState(false);
  const [editorExportsBusy, setEditorExportsBusy] = useState(false);
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const exportOptions = useRef<HTMLDetailsElement>(null);
  const editorExportsHost = useRef<HTMLDivElement>(null);
  const [transcriptRefresh, setTranscriptRefresh] = useState(0);
  const transcriptGeneration = useRef(0);
  const transcriptQuery = useRef("");
  const [transcriptCheckedAt, setTranscriptCheckedAt] = useState<number>();
  const [transcriptChecking, setTranscriptChecking] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipSettings, setClipSettings] = useState<ClipSettings>({ resolution: "source", quality: "balanced" });
  const clipSettingsHelpId = useId();
  const validClipSettings = clipResolutionAvailable(clipSettings.resolution, asset.viewingCopy?.width, asset.viewingCopy?.height);
  const duration = asset.viewingCopy?.durationSeconds ?? 0;
  const durationMs = Math.floor(duration * 1000);
  const [inTime, setInTime] = useState("00:00:00.000");
  const [outTime, setOutTime] = useState(videoTime(Math.min(durationMs, 1_800_000) / 1000));
  const outEdited = useRef(false);
  useEffect(() => { if (!outEdited.current && duration > 0) setOutTime(videoTime(Math.min(durationMs, 1_800_000) / 1000)); }, [durationMs]);
  const [clip, setClip] = useState<VideoClip>();
  const binaryIdentity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
  const previousBinary = useRef(binaryIdentity);
  const settingsResetPending = Boolean(settings.transcriptId && previousBinary.current !== binaryIdentity);
  useEffect(() => {
    if (previousBinary.current === binaryIdentity) return;
    previousBinary.current = binaryIdentity;
    setSettings(previous => previous.transcriptId ? { languageCode: previous.languageCode, maxSpeakers: previous.maxSpeakers } : previous);
    setTranscript(undefined);
    setTranscriptError("");
    setTranscriptCheckedAt(undefined);
    setTranscriptChecking(false);
    transcriptGeneration.current++;
    setTranscriptPageLoading(false);
    setTranscriptBusy(false);
    setClipAction(null);
    setPlaybackSeconds(0);
    setInTime("00:00:00.000");
    outEdited.current = false;
    setOutTime(videoTime(Math.min(durationMs, 1_800_000) / 1000));
    setClip(undefined);
  }, [binaryIdentity, durationMs]);
  const [recentError, setRecentError] = useState("");
  const [recentRefresh, setRecentRefresh] = useState(0);
  const [recentClips, setRecentClips] = useState<VideoClip[]>([]);
  const [recentCursor, setRecentCursor] = useState<string | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const recentGeneration = useRef(0);
  const [clipAction, setClipAction] = useState<"request" | "download" | "transcript" | null>(null);
  const [clipTranscriptFormat, setClipTranscriptFormat] = useState<ClipTranscriptFormat>("txt");
  const clipBusy = clipAction !== null;
  useEffect(() => {
    onBusyChange?.(transcriptBusy || clipBusy || editorExportsBusy);
    return () => onBusyChange?.(false);
  }, [clipBusy, editorExportsBusy, onBusyChange, transcriptBusy]);
  const [clipError, setClipError] = useState("");
  const [clipRefresh, setClipRefresh] = useState(0);
  const [clipCheckedAt, setClipCheckedAt] = useState<number>();
  const [clipChecking, setClipChecking] = useState(false);
  const [recentCheckedAt, setRecentCheckedAt] = useState<number>();
  const selectionEnd = useRef<number | null>(null);
  const selectionFrame = useRef<number>();
  const selectionGeneration = useRef(0);
  const cancelSelection = useCallback(() => {
    selectionGeneration.current += 1;
    selectionEnd.current = null;
    if (selectionFrame.current !== undefined) cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = undefined;
  }, []);
  useEffect(() => {
    function pauseHiddenSelection() {
      if (document.hidden && selectionEnd.current !== null) {
        player.current?.pause();
        cancelSelection();
      }
    }
    document.addEventListener("visibilitychange", pauseHiddenSelection);
    return () => {
      document.removeEventListener("visibilitychange", pauseHiddenSelection);
      cancelSelection();
    };
  }, [cancelSelection, player]);
  useEffect(() => { cancelSelection(); }, [binaryIdentity, cancelSelection]);
  const mounted = useRef(true);
  const transcriptReadyHandler = useRef(onTranscriptReady);
  transcriptReadyHandler.current = onTranscriptReady;
  const searchContentChangedHandler = useRef(onSearchContentChanged);
  searchContentChangedHandler.current = onSearchContentChanged;
  const transcriptObservedHandler = useRef(onTranscriptObserved);
  transcriptObservedHandler.current = onTranscriptObserved;
  const observedTranscriptStates = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identity = { sourceId: asset.sourceId, assetId: asset.id };
  const fileReadContext = useRef(binaryIdentity);
  fileReadContext.current = binaryIdentity;
  const clipDownloadContext = useRef("");
  clipDownloadContext.current = JSON.stringify([principal?.id, asset.sourceId, asset.id, asset.fileVersion, clip?.id, settings]);
  const ready = asset.viewingCopy?.state === "ready";
  const inMs = parseVideoTime(inTime);
  const outMs = parseVideoTime(outTime);
  const validRange = inMs !== null && outMs !== null && inMs >= 0 && outMs - inMs >= 250 && outMs - inMs <= 1_800_000 && outMs <= durationMs;

  useEffect(() => {
    if (!transcriptOpen || !ready || editingRef.current || settingsResetPending) return;
    let current = true;
    const generation = ++transcriptGeneration.current;
    let timer: ReturnType<typeof setTimeout>;
    const query = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}/${settings.languageCode}/${settings.maxSpeakers}/${settings.transcriptId ?? "default"}`;
    if (transcriptQuery.current !== query) {
      transcriptQuery.current = query;
      setTranscript(undefined);
      setTranscriptCheckedAt(undefined);
    }
    setTranscriptError("");
    async function load() {
      setTranscriptChecking(true);
      try {
        const token = await getIdToken();
        if (!current || generation !== transcriptGeneration.current || editingRef.current) return;
        const response = await getVideoTranscript(token, { sourceId: asset.sourceId, assetId: asset.id }, settings);
        if (!current || generation !== transcriptGeneration.current || editingRef.current) return;
        setTranscript(response);
        setTranscriptCheckedAt(Date.now());
        setTranscriptError("");
        const previousState = observedTranscriptStates.current.get(query);
        observedTranscriptStates.current.set(query, response.transcript.state);
        if (response.transcript.state === "ready") {
          if (activeTranscript(previousState)) searchContentChangedHandler.current?.();
          transcriptReadyHandler.current?.(asset.id, settings);
        }
        if (activeTranscript(response.transcript.state)) {
          transcriptObservedHandler.current?.(asset.id, settings);
          timer = setTimeout(load, 10_000);
        }
      } catch (error) {
        if (current) setTranscriptError(videoProductionMessage(error, "The saved transcript could not be checked. Check the saved status again before requesting transcription."));
      } finally { if (current) setTranscriptChecking(false); }
    }
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [asset.id, asset.sourceId, asset.fileVersion, getIdToken, ready, settings, transcriptOpen, transcriptRefresh, byokBusy, settingsResetPending]);

  useEffect(() => {
    const generation = ++recentGeneration.current;
    if (!clipOpen || !ready) return;
    let current = true;
    setRecentLoading(true);
    async function load() {
      try {
        const response = await listVideoClips(await getIdToken(), { sourceId: asset.sourceId, assetId: asset.id });
        if (current) {
          setRecentClips(response.clips.filter(clip => !("format" in clip) || clip.format === "web_mp4"));
          setRecentCursor(response.nextCursor ?? null);
          setRecentCheckedAt(Date.now()); setRecentError("");
        }
      } catch (error) { if (current) setRecentError(videoProductionMessage(error, "Recent exports could not be loaded.")); }
      finally { if (current && generation === recentGeneration.current) setRecentLoading(false); }
    }
    void load();
    return () => { current = false; };
  }, [principal?.id, asset.id, asset.sourceId, asset.version, getIdToken, clipOpen, ready, recentRefresh]);

  useEffect(() => {
    if (!clip) return;
    setRecentClips(previous => previous.some(recent => recent.id === clip.id)
      ? previous.map(recent => recent.id === clip.id ? clip : recent)
      : [clip, ...previous]);
  }, [clip]);

  async function loadOlderClips() {
    if (!recentCursor || recentLoading) return;
    const generation = recentGeneration.current;
    setRecentLoading(true);
    try {
      const response = await listVideoClips(await getIdToken(), identity, recentCursor);
      if (!mounted.current || generation !== recentGeneration.current) return;
      const older = response.clips.filter(clip => !("format" in clip) || clip.format === "web_mp4");
      setRecentClips(previous => [...new Map([...previous, ...older].map(clip => [clip.id, clip])).values()]);
      setRecentCursor(response.nextCursor ?? null);
      setRecentError("");
    } catch (error) {
      if (mounted.current && generation === recentGeneration.current) setRecentError(videoProductionMessage(error, "Older exports could not be loaded."));
    } finally { if (mounted.current && generation === recentGeneration.current) setRecentLoading(false); }
  }

  useEffect(() => {
    if (!clip) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    setClipChecking(false);
    async function poll() {
      setClipChecking(true);
      try {
        const response = await getVideoClip(await getIdToken(), { sourceId: asset.sourceId, assetId: asset.id }, clip!.id);
        if (!current) return;
        setClip(response.clip);
        setClipCheckedAt(Date.now());
        setClipError("");
        if (activeClip(response.clip.state)) timer = setTimeout(poll, 10_000);
      } catch (error) {
        if (current) setClipError(videoProductionMessage(error, "Clip status could not be checked. Use Check status before retrying."));
      } finally { if (current) setClipChecking(false); }
    }
    if (clipRefresh > 0) void poll();
    else if (activeClip(clip.state)) timer = setTimeout(poll, 10_000);
    return () => { current = false; clearTimeout(timer); };
  }, [asset.id, asset.sourceId, getIdToken, clip?.id, clip?.state, clipRefresh]);

  async function transcribe() {
    if (transcriptBusy || transcriptChecking || transcriptLocked || settings.transcriptId || disabled || !canRequest || !transcriptEligible || !requestEnabled) return;
    const context = fileReadContext.current;
    const current = () => mounted.current && fileReadContext.current === context;
    setTranscriptBusy(true);
    setTranscriptError("");
    try {
      const token = await getIdToken();
      if (!current()) return;
      const response = await requestVideoTranscript(token, identity, settings);
      if (current()) {
        setTranscript(response); setTranscriptCheckedAt(Date.now()); setTranscriptRefresh(value => value + 1);
        onTranscriptRequested?.(asset.id, { ...settings }, response.transcript.state === "ready");
      }
    } catch (error) {
      if (current()) setTranscriptError(videoProductionMessage(error, "The transcription request could not be confirmed. Check its saved status before trying again.", "request_transcript"));
    } finally { if (current()) setTranscriptBusy(false); }
  }
  async function moreTranscript(background = false) {
    if (!transcript?.nextCursor || transcriptPageLoading || transcriptBusy || transcriptLocked) return;
    if (background) setTranscriptPageLoading(true);
    else { setTranscriptError(""); setTranscriptBusy(true); }
    const generation = transcriptGeneration.current;
    const context = fileReadContext.current;
    const revision = transcript.transcript.editRevision;
    try {
      const token = await getIdToken();
      if (!mounted.current || generation !== transcriptGeneration.current) return;
      const response = await getVideoTranscript(token, identity, loadedTranscriptSettings, transcript.nextCursor);
      if (!mounted.current || generation !== transcriptGeneration.current) return;
      // A background read cannot replace in-progress corrections or a newer saved revision.
      if (background && editingRef.current) { playbackCursorAttempt.current = ""; return; }
      setTranscript(previous => previous && previous.transcript.id === transcript.transcript.id && previous.transcript.editRevision === revision
        ? { ...response, segments: [...(previous.segments ?? []), ...(response.segments ?? [])] } : previous);
    } catch (error) {
      if (mounted.current && generation === transcriptGeneration.current) {
        const message = videoProductionMessage(error, "More transcript text could not be loaded.");
        setTranscriptError(previous => background ? previous || message : message);
      }
    } finally {
      if (mounted.current && context === fileReadContext.current) {
        if (background) setTranscriptPageLoading(false); else setTranscriptBusy(false);
      }
    }
  }
  const playbackCursorAttempt = useRef("");
  useEffect(() => {
    const cursor = transcript?.nextCursor;
    const last = transcript?.segments?.at(-1);
    const key = `${transcript?.transcript.id}/${transcript?.transcript.editRevision}/${cursor}`;
    if (!workspace || !cursor || !last || playbackSeconds < last.endSeconds || disabled || transcriptPageLoading || transcriptBusy || transcriptLocked || playbackCursorAttempt.current === key) return;
    // Let staff keep reading while the next page is outside the loaded transcript.
    const focused = document.activeElement;
    if (transcriptWorkspace.current?.contains(focused) || focused?.closest('[role="menu"]')) return;
    // Fetch each saved page once on playback demand. A failed page keeps the explicit retry.
    playbackCursorAttempt.current = key;
    void moreTranscript(true);
  }, [workspace, transcript, playbackSeconds, disabled, transcriptPageLoading, transcriptBusy, transcriptLocked]);
  async function downloadTranscript(format: TranscriptDownloadFormat) {
    if (disabled || transcript?.transcript.state !== "ready" || transcriptBusy || transcriptLocked || (format === "avid" && !validAvidOptions)) return;
    const context = fileReadContext.current;
    const current = () => mounted.current && fileReadContext.current === context;
    setTranscriptBusy(true);
    setTranscriptError("");
    try {
      const token = await getIdToken();
      if (!current()) return;
      const response = await readVideoTranscript(token, identity, loadedTranscriptSettings, format, format === "avid" && avidFrameRate ? { frameRate: avidFrameRate, frameOffset: Number(avidFrameOffset) } : undefined);
      if (current()) downloadFile(response.url, `${asset.name}${format === "avid" ? "-avid-markers.txt" : format === "premiere" ? "-premiere-transcript.json" : `.${format}`}`);
    } catch (error) { if (current()) setTranscriptError(videoProductionMessage(error, "The saved transcript could not be downloaded.", format === "premiere" ? "download_premiere" : format === "avid" ? "download_avid" : undefined)); }
    finally { if (current()) setTranscriptBusy(false); }
  }
  async function exportClip(retry = false) {
    if (clipBusy || disabled || !canRequest) return;
    if (retry ? !clip?.canRetry : !validRange || !validClipSettings) return;
    const settingsToRequest = retry && clip ? savedClipSettings(clip) : clipSettings;
    if (retry && clip) {
      cancelSelection();
      setClipSettings(settingsToRequest);
      setInTime(videoTime(clip.inMs / 1000));
      setOutTime(videoTime(clip.outMs / 1000));
      outEdited.current = true;
    }
    const context = fileReadContext.current;
    const current = () => mounted.current && fileReadContext.current === context;
    setClipAction("request");
    setClipError("");
    try {
      const token = await getIdToken();
      if (!current()) return;
      const response = await requestVideoClip(token, identity, retry && clip ? clip.inMs : inMs!, retry && clip ? clip.outMs : outMs!, retry, settingsToRequest);
      if (current()) { setClip(response.clip); setClipCheckedAt(Date.now()); setRecentCursor(null); setRecentRefresh(value => value + 1); }
    } catch (error) { if (current()) setClipError(videoProductionMessage(error, "The clip request could not be confirmed. The same range can be checked safely.", "request_clip")); }
    finally { if (current()) setClipAction(null); }
  }
  async function downloadClip() {
    if (!clip) return;
    const context = fileReadContext.current;
    const current = () => mounted.current && fileReadContext.current === context;
    setClipAction("download");
    setClipError("");
    try {
      const token = await getIdToken();
      if (!current()) return;
      const response = await readVideoClip(token, identity, clip.id);
      if (current()) downloadFile(response.access.url, `${asset.name}-clip.mp4`);
    } catch (error) { if (current()) setClipError(videoProductionMessage(error, "The clip could not be downloaded. Check its saved status; it may have expired.")); }
    finally { if (current()) setClipAction(null); }
  }
  async function downloadMatchingTranscript() {
    if (!clip || clip.state !== "ready" || transcript?.transcript.state !== "ready" || transcriptLocked || clipBusy || disabled) return;
    const selectedClip = clip;
    const context = clipDownloadContext.current;
    const fileContext = fileReadContext.current;
    const generation = transcriptGeneration.current;
    setClipAction("transcript");
    setClipError("");
    try {
      const response = await readClipTranscript(await getIdToken(), identity, loadedTranscriptSettings, selectedClip.id, clipTranscriptFormat);
      if (!mounted.current || context !== clipDownloadContext.current || generation !== transcriptGeneration.current) return;
      if (response.clipId !== selectedClip.id || response.inMs !== selectedClip.inMs || response.outMs !== selectedClip.outMs) throw new Error("The saved clip changed. Reopen the clip before downloading its transcript.");
      const url = URL.createObjectURL(new Blob([response.body], { type: response.contentType }));
      downloadFile(url, response.filename);
      // Keep the object alive until the browser has started the local download.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      if (mounted.current && fileContext === fileReadContext.current) setClipError(videoProductionMessage(error, "The clip transcript could not be downloaded. Check the saved clip and try again.", "download_clip_transcript"));
    } finally {
      if (mounted.current && fileContext === fileReadContext.current) setClipAction(null);
    }
  }
  const stopAtSelectionEnd = useCallback(() => {
    const media = player.current;
    const end = selectionEnd.current;
    if (!media || end === null || media.currentTime < end) return false;
    cancelSelection();
    media.pause();
    media.currentTime = end;
    return true;
  }, [cancelSelection, player]);
  function previewSelection() {
    if (!validRange || !player.current) return;
    cancelSelection();
    const media = player.current;
    const generation = selectionGeneration.current;
    media.currentTime = inMs! / 1000;
    selectionEnd.current = outMs! / 1000;
    function checkFrame() {
      selectionFrame.current = undefined;
      if (generation !== selectionGeneration.current || stopAtSelectionEnd()) return;
      if (media.paused || media.ended) { cancelSelection(); return; }
      selectionFrame.current = requestAnimationFrame(checkFrame);
    }
    // timeupdate can arrive after a short selection has already played past its out point.
    void media.play().then(() => {
      if (generation === selectionGeneration.current) selectionFrame.current = requestAnimationFrame(checkFrame);
    }).catch(() => {
      if (generation === selectionGeneration.current) cancelSelection();
    });
  }
  const onTimeUpdate = useCallback(() => {
    stopAtSelectionEnd();
    setPlaybackSeconds(player.current?.currentTime ?? 0);
  }, [stopAtSelectionEnd, player]);
  function seekPlayback(seconds: number) {
    cancelSelection();
    setPlaybackSeconds(seconds);
    if (player.current) player.current.currentTime = seconds;
  }
  function seek(seconds: number) {
    cancelSelection();
    onWorkspacePaneChange?.("watch");
    if (player.current) { player.current.currentTime = seconds; requestAnimationFrame(() => player.current?.focus()); }
  }
  function mark(which: "in" | "out") {
    if (!player.current) return;
    cancelSelection();
    const value = videoTime(Math.min(Math.floor(player.current.currentTime * 1000), durationMs) / 1000);
    if (which === "in") setInTime(value); else { outEdited.current = true; setOutTime(value); }
  }
  const controlsDisabled = disabled || clipBusy || activeClip(clip?.state);
  const transcriptState = transcript?.transcript.state;
  const requestPolicy = transcript?.requestPolicy;
  const policyKnown = requestPolicy !== undefined && requestPolicy !== null && typeof requestPolicy.enabled === "boolean"
    && ["local-whisper", "elevenlabs", "amazon-transcribe"].includes(requestPolicy.provider) && typeof requestPolicy.fallbackEnabled === "boolean";
  const requestEnabled = policyKnown && requestPolicy?.enabled === true;
  const localRequest = requestEnabled && requestPolicy?.provider === "local-whisper";
  const elevenLabsFirst = requestPolicy?.paidFallbackProviders?.[0] === "elevenlabs";
  const awsPossible = requestEnabled && (requestPolicy?.provider === "amazon-transcribe" || requestPolicy?.fallbackEnabled === true);
  const awsTranscriptionEstimate = estimateAwsTranscriptionCharge(duration);
  const transcriptEligible = ready && duration > 0 && duration <= 7200 && (asset.viewingCopy?.sizeBytes ?? Infinity) <= 2_000_000_000;
  const clipInInput = useRef<HTMLLabelElement>(null);
  function passageRange(segment: TranscriptSegment) {
    return { start: Math.round(segment.startSeconds * 1000), end: Math.min(Math.round(segment.endSeconds * 1000), durationMs) };
  }
  function canSelectPassage(segment: TranscriptSegment) {
    const { start, end } = passageRange(segment);
    return ready && !controlsDisabled && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end - start >= 250 && end - start <= 1_800_000;
  }
  function selectPassage(segment: TranscriptSegment) {
    if (!canSelectPassage(segment)) return;
    const { start, end } = passageRange(segment);
    cancelSelection(); setInTime(videoTime(start / 1000)); setOutTime(videoTime(end / 1000)); outEdited.current = true; setClipOpen(true);
    onWorkspacePaneChange?.("watch");
    requestAnimationFrame(() => { if (mounted.current) clipInInput.current?.querySelector("input")?.focus(); });
  }
  const transcriptContent = transcriptOpen && transcriptState === "ready" && transcript ? <>
    <TranscriptEditor playbackSeconds={workspace ? playbackSeconds : undefined} commentThreads={commentThreads} commentsIncomplete={commentsIncomplete} onOpenComment={onOpenComment} commentsAction={commentsAction} loadMoreAction={workspace && transcript.nextCursor ? <Button disabled={transcriptPageLoading || transcriptBusy || transcriptLocked} onClick={() => void moreTranscript()}>{transcriptPageLoading ? "Loading more transcript" : "Load more transcript"}</Button> : null} pane={workspace} key={transcript.transcript.id} response={transcript} canEdit={canRequest} disabled={disabled || transcriptBusy || transcriptChecking || byokBusy}
      onSelectPassage={selectPassage} canSelectPassage={canSelectPassage} onSeek={seek} onDirtyChange={setTranscriptDirty} onSavingChange={setTranscriptSaving} onEditingChange={setTranscriptEditing}
      onSave={async edits => {
        const transcriptId = transcript.transcript.id;
        if (!transcriptId) throw new Error("The saved transcript identity is unavailable");
        const saved = await saveVideoTranscript(await getIdToken(), identity, { ...settings, transcriptId }, edits);
        onSearchContentChanged?.();
        return saved;
      }}
      onAlign={async retry => {
        const transcriptId = transcript.transcript.id;
        if (!transcriptId) throw new Error("The saved transcript identity is unavailable");
        return (await requestVideoTranscriptAlignment(await getIdToken(), identity, transcriptId,
          transcript.transcript.editRevision ?? 0, retry)).alignment;
      }}
      onCancelAlignment={async requestId => {
        const transcriptId = transcript.transcript.id;
        if (!transcriptId) throw new Error("The saved transcript identity is unavailable");
        return (await cancelVideoTranscriptAlignment(await getIdToken(), identity, transcriptId,
          transcript.transcript.editRevision ?? 0, requestId)).alignment;
      }}
      onSaved={setTranscript} onReload={() => setTranscriptRefresh(value => value + 1)} />
    {!workspace && transcript.nextCursor ? <Button disabled={transcriptPageLoading || transcriptBusy || transcriptLocked} onClick={() => void moreTranscript()}>{transcriptPageLoading ? "Loading more transcript" : "Load more transcript"}</Button> : null}
  </> : null;
  const transcriptFailure = transcriptError ? <InlineMessage tone="error" title="Transcript needs attention">
    {transcriptError}
    {(!transcript || transcriptState === "not_requested" || transcriptState === "ready") ? <Button disabled={transcriptBusy || transcriptChecking || transcriptLocked}
      onClick={() => { if (headerControls) openSection("transcript"); setTranscriptRefresh(value => value + 1); }}>Check saved status</Button> : null}
  </InlineMessage> : null;
  const emptyTranscriptMessage = !ready
    ? "A ready web copy is required to open a saved transcript. Check the preview in Watch & details."
    : transcriptError ? transcriptError
      : transcriptState ? `Transcript: ${transcriptState.replaceAll("_", " ")}.`
        : transcriptChecking ? "Checking for a saved transcript."
          : !transcriptEligible ? "This web copy is outside the new-transcription limits. Check saved transcript settings."
            : "No saved transcript is loaded. Open transcript settings to check its status.";
  const transcriptSettingsPanel = <details ref={transcriptSection} id={transcriptSectionId} className="video-transcript-settings" data-viewer-keys="off"
      open={settingsVisible} onToggle={event => {
        if (transcriptLocked && !event.currentTarget.open) { event.currentTarget.open = true; return; }
        if (workspace) setTranscriptSettingsOpen(event.currentTarget.open);
        else setTranscriptOpen(event.currentTarget.open);
      }}>
      <summary aria-disabled={transcriptLocked || undefined} onClick={event => { if (transcriptLocked) event.preventDefault(); }}>{workspace ? "Transcript settings" : "Transcript"}</summary>
      {transcriptEditing ? <p>Save or cancel transcript edits before closing this section or changing language.</p> : null}
      <p>Speaker labels and timestamps are saved with the video. Opening a saved transcript does not run transcription again.</p>
      {!transcriptEligible ? <p>A ready MP4 web copy of up to 2 hours and 2 GB is required.</p> : <>
        <label>Spoken language<Select value={settings.languageCode} disabled={transcriptBusy || transcriptLocked || !!settings.transcriptId || activeTranscript(transcriptState)} onChange={event => setSettings({ ...settings, languageCode: event.target.value as TranscriptSettings["languageCode"] })}><option value="en-US">English</option><option value="es-US">Spanish</option></Select></label>

        {transcriptState === "not_requested" && !settings.transcriptId && canRequest ? <div className="video-production-request-note">
          {!policyKnown ? <p>The transcription provider could not be verified. Check availability before requesting transcription.</p>
            : !requestEnabled ? <p>New transcription requests are currently unavailable. Saved transcripts remain available.</p>
            : localRequest ? <><p>Transcripts are free on our own machine. You can queue many videos; they run in order. {requestPolicy?.fallbackEnabled
              ? "If our machine cannot process a video, paid backup can run within the daily paid limits."
              : "Paid backup is off, so an administrator must check a video our machine cannot process."}</p>
              {requestPolicy?.fallbackEnabled ? <details><summary>Paid backup details</summary>
                <p>{elevenLabsFirst ? "ElevenLabs is tried first with the station key. Amazon Transcribe is the final backup." : "Amazon Transcribe is the paid backup."} Paid daily limits apply; when the allowance is used, requests stay queued for our machine.</p>
                {awsPossible && awsTranscriptionEstimate !== null ? <p>Possible AWS charge for this video: {transcriptionChargeLabel(awsTranscriptionEstimate)} for recognition. Other charges can apply.</p> : null}
              </details> : null}</>
              : requestPolicy?.provider === "elevenlabs"
                ? <p>Requests try ElevenLabs with the station key first. {requestPolicy.fallbackEnabled ? "Amazon Transcribe is the final fallback. " : ""}Paid recognition charges apply.</p>
                : <p>Requests use Amazon Transcribe. AWS recognition charges apply.</p>}
          {!localRequest && awsPossible && awsTranscriptionEstimate !== null ? <p>Possible AWS charge for this video: {transcriptionChargeLabel(awsTranscriptionEstimate)}. The estimate uses $0.36 per hour and covers recognition only. Other charges can apply.</p> : null}
          {!requestEnabled ? <Button disabled={transcriptBusy || transcriptChecking || disabled} onClick={() => setTranscriptRefresh(value => value + 1)}>Check availability</Button> : null}
        </div> : null}

        {!transcript && !transcriptError ? <p role="status">Checking for a saved transcript.</p> : null}
        {transcript && transcriptState !== "not_requested" ? <VideoProcessingStatus kind="Transcript" state={transcriptState!} processing={transcript.transcript.processing} checkedAt={transcriptCheckedAt} reference={transcript.transcript.id} /> : null}
        <VideoTranscriptVariants key={`${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}/${principal?.id ?? "staff"}`} identity={identity} getIdToken={getIdToken} open={settingsVisible} actionTarget={paidActionTarget}
          disabled={disabled || transcriptBusy || transcriptLocked || credentialsLocked} canRequest={canRequest} settings={settings} currentTranscript={transcript?.transcript} requestPolicy={requestPolicy}
          duration={duration} sizeBytes={asset.viewingCopy?.sizeBytes} refresh={credentialsBusy ? 1 : 0} onBusyChange={setByokBusy}
          onSelect={selected => {
            if (transcriptBusy || transcriptLocked) return;
            transcriptGeneration.current++;
            setTranscript(undefined); setTranscriptCheckedAt(undefined);
            setSettings(previous => selected?.id ? { languageCode: selected.languageCode === "es-US" ? "es-US" : "en-US", maxSpeakers: selected.maxSpeakers ?? 10, transcriptId: selected.id } : { languageCode: previous.languageCode, maxSpeakers: 10 });
          }}
          onRequested={response => {
            transcriptGeneration.current++;
            setTranscript(response); setTranscriptCheckedAt(Date.now());
            const requestedSettings = { languageCode: response.transcript.languageCode === "es-US" ? "es-US" as const : "en-US" as const, maxSpeakers: response.transcript.maxSpeakers ?? 10, transcriptId: response.transcript.id };
            setSettings(requestedSettings);
            setTranscriptRefresh(value => value + 1);
            onTranscriptRequested?.(asset.id, requestedSettings, response.transcript.state === "ready");
          }} />
        {transcript && transcriptState !== "not_requested" && transcriptState !== "ready" ? <Button disabled={transcriptBusy || transcriptChecking || transcriptLocked} onClick={() => setTranscriptRefresh(value => value + 1)}>{transcriptChecking ? "Checking saved status" : "Check saved status"}</Button> : null}
        {transcriptState === "ready" ? <><p>Saved transcript ready. Review speaker labels and wording before use.</p>
          <details ref={exportOptions} className="video-transcript-export-options" open={exportOptionsOpen}
            onToggle={event => setExportOptionsOpen(event.currentTarget.open)}><summary>Editing software exports</summary>
            <p>Download saved transcript data for your editing software. Check timing and speaker labels after import.</p>
            <fieldset disabled={transcriptBusy || transcriptLocked}><legend>Avid Media Composer</legend>
              <label>Editing clip or sequence frame rate<Select value={avidFrameRate} onChange={event => setAvidFrameRate(event.target.value as AvidFrameRate | "")}>
                <option value="">Choose a frame rate</option>{avidFrameRates.map(rate => <option key={rate} value={rate}>{rate === "24000/1001" ? "23.976 (24000/1001)" : rate === "30000/1001" ? "29.97 (30000/1001)" : rate === "60000/1001" ? "59.94 (60000/1001)" : rate.split("/")[0]} fps</option>)}
              </Select></label>
              <label>Elapsed frame offset<TextInput inputMode="numeric" value={avidFrameOffset} onChange={event => setAvidFrameOffset(event.target.value)} /></label>
              <p>Use a whole number of frames, starting at 0. Times use the viewing copy and this offset; this is not a source SMPTE timecode.</p>

            </fieldset>
            <h4>Adobe Premiere Pro</h4>
            <p>Premiere JSON requires saved word timings for every passage. Text corrections can remove those timings. Text and soundbite-log downloads remain available.</p>

          </details></> : null}
        {!headerControls ? transcriptFailure : null}
      </>}
      {workspace ? null : transcriptContent}
    </details>;
  const transcriptPanel = <div ref={transcriptWorkspace} className={workspace ? "video-viewer-transcript" : "video-production-sections"} data-viewer-keys="off">
    {headerControls ? <MediaDialogNotice>{transcriptFailure}</MediaDialogNotice> : null}
    {workspace ? null : transcriptSettingsPanel}
    {workspace ? transcriptContent ?? <div className="video-transcript-empty"><h3 tabIndex={-1}>Transcript</h3>
      <p>{emptyTranscriptMessage} Opening settings does not start transcription.</p>
      <Button onClick={() => { setTranscriptSettingsOpen(true); onWorkspacePaneChange?.("watch"); requestAnimationFrame(() => transcriptSection.current?.querySelector("summary")?.focus()); }}>Open transcript settings</Button>
    </div> : null}
  </div>;
  const contextContent = <div className="video-production-sections">
    {workspace ? transcriptSettingsPanel : null}
    <details ref={clipSection} id={clipSectionId} open={clipOpen} onToggle={event => setClipOpen(event.currentTarget.open)}>
      <summary>Create a clip</summary>
      <p>Export an MP4 from the web copy. The original stays unchanged. Clips stay available for 7 days.</p>
      {!ready || duration <= 0 ? <p>Wait for a ready web copy before selecting a clip.</p> : <>
        <label ref={clipInInput}>In time<TextInput value={inTime} disabled={controlsDisabled} onChange={event => { cancelSelection(); setInTime(event.target.value); }} /></label>
        <Button disabled={controlsDisabled} onClick={() => mark("in")}>Set in to playhead</Button>
        <label>Out time<TextInput value={outTime} disabled={controlsDisabled} onChange={event => { cancelSelection(); outEdited.current = true; setOutTime(event.target.value); }} /></label>
        <Button disabled={controlsDisabled} onClick={() => mark("out")}>Set out to playhead</Button>
        <p>Use hours:minutes:seconds or decimal seconds. The out point is excluded. Select 0.25 seconds to 30 minutes. Cuts round to video frames.</p>
        {!validRange ? <p role="status">Enter an in/out range within this video ({videoTime(duration)}).</p> : <p>Selected length: {videoTime((outMs! - inMs!) / 1000)}</p>}
        <label>Clip resolution<Select value={clipSettings.resolution} disabled={controlsDisabled} aria-describedby={clipSettingsHelpId} onChange={event => setClipSettings(previous => ({ ...previous, resolution: event.target.value as ClipSettings["resolution"] }))}>
          <option value="source">Match web copy</option>
          {(["1080p", "720p", "480p"] as const).map(resolution => <option key={resolution} value={resolution} disabled={!clipResolutionAvailable(resolution, asset.viewingCopy?.width, asset.viewingCopy?.height)}>{resolution}</option>)}
        </Select></label>
        <label>Clip quality<Select value={clipSettings.quality} disabled={controlsDisabled} onChange={event => setClipSettings(previous => ({ ...previous, quality: event.target.value as ClipSettings["quality"] }))}>
          <option value="smaller">Smaller file</option><option value="balanced">Balanced</option><option value="high">Higher quality</option>
        </Select></label>
        <p id={clipSettingsHelpId}>Sizes above the web copy are unavailable. Aspect ratio is retained. Higher quality can make a larger file. The preview uses the existing web copy.</p>
        {!validClipSettings ? <p role="status">Choose a resolution available from this web copy.</p> : null}
        <div className="video-production-buttons"><Button disabled={!validRange || disabled} onClick={previewSelection}>Preview selection</Button></div>
        {clip ? <div>
          <p>Clip {videoTime(clip.inMs / 1000)} to {videoTime(clip.outMs / 1000)}</p>
          <p>{clipSettingsLabel(clip)}</p>
          {Number.isSafeInteger(clip.width) && Number.isSafeInteger(clip.height) && clip.width! > 0 && clip.height! > 0 ? <p>Exported size: {clip.width} × {clip.height} pixels.</p> : null}
          <VideoProcessingStatus kind="Clip" state={clip.state} processing={clip.processing} checkedAt={clipCheckedAt} reference={clip.id} />
          {clip.state === "ready" ? <>{clip.expiresAt ? <p>Expires {new Date(clip.expiresAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET.</p> : null}</> : null}
          {clip.state === "failed" && clip.canRetry && canRequest ? <><p>A confirmed failed export can be retried. This can incur another processing charge.</p></> : null}
          {(clip.state !== "ready" && clip.state !== "expired") || clipError ? <Button disabled={clipBusy || clipChecking} onClick={() => setClipRefresh(value => value + 1)}>{clipChecking ? "Checking status" : "Check status"}</Button> : null}
        </div> : null}
        {recentError ? <InlineMessage tone="error" title="Recent exports need attention">{recentError}<Button onClick={() => setRecentRefresh(value => value + 1)}>Reload recent exports</Button></InlineMessage> : null}
        {recentClips.length > 0 ? <section aria-label="Your recent clip exports"><h4>Your recent exports</h4><ul className="video-recent-clips">{recentClips.map(recent => <li key={recent.id}><Button disabled={clipBusy} onClick={() => {
          cancelSelection(); setClip(recent); setClipSettings(savedClipSettings(recent)); setClipCheckedAt(recentCheckedAt); setInTime(videoTime(recent.inMs / 1000)); setOutTime(videoTime(recent.outMs / 1000)); outEdited.current = true; setClipRefresh(value => value + 1);
        }}>{videoTime(recent.inMs / 1000)} to {videoTime(recent.outMs / 1000)} · {clipSettingsLabel(recent)} · {recent.state}</Button></li>)}</ul></section> : null}
        {recentCursor ? <Button disabled={recentLoading || clipBusy} onClick={() => void loadOlderClips()}>{recentLoading ? "Loading older exports" : "Load older MP4 exports"}</Button> : null}
        {clipError ? <InlineMessage tone="error" title="Clip needs attention">{clipError}</InlineMessage> : null}
      </>}
    </details>
    {asset.sourceId === "video-library" ? <div ref={editorExportsHost}><EditorVideoExports
      key={`${principal?.id ?? "signed-out"}:${asset.sourceId}:${asset.id}:${asset.version}`}
      sourceRate={asset.viewingCopy} sourceDurationSeconds={duration}
      onDownloadOriginal={onDownloadOriginal}
      identity={identity} name={asset.name} getIdToken={getIdToken} canRequest={canRequest}
      disabled={disabled} inMs={inMs} outMs={outMs} validRange={validRange}
      onBusyChange={setEditorExportsBusy}
      exportEligible={ready && Number.isFinite(duration) && duration > 0 && duration <= 86_400}
      transcriptSettings={loadedTranscriptSettings} transcriptReady={transcriptState === "ready"}
      transcriptLocked={transcriptLocked || transcriptBusy}
      transcriptRevision={transcript?.transcript.editRevision ?? 0}
    /></div> : null}
    {principal ? <details open={credentialsOpen} onToggle={event => {
      if (credentialsLocked && !event.currentTarget.open) { event.currentTarget.open = true; return; }
      setCredentialsOpen(event.currentTarget.open);
    }}><summary aria-disabled={credentialsLocked || undefined} onClick={event => { if (credentialsLocked) event.preventDefault(); }}>Transcription key settings</summary>
      <p>Saving a key does not start a paid request.</p>
      {credentialsLocked ? <p>Save or clear the key entry before closing this section. Wait for a pending change to finish.</p> : null}
      {credentialsOpen ? <TranscriptionCredentials principal={principal} getIdToken={getIdToken} disabled={disabled || byokBusy} onDirtyChange={setCredentialsDirty} onBusyChange={setCredentialsBusy} /> : null}
    </details> : null}
  </div>;
  const content = workspace ? contextContent : <>{transcriptPanel}{contextContent}</>;
  const transcriptAction = <Button aria-controls={transcriptSectionId} aria-expanded={transcriptOpen} onClick={() => openSection("transcript")} aria-label="Open transcript">{headerControls ? "Transcript" : "Open transcript"}</Button>;
  const clipHeaderAction = <Button aria-controls={clipSectionId} aria-expanded={clipOpen} onClick={() => openSection("clip")} aria-label="Clip settings">{headerControls ? "Clip" : "Clip settings"}</Button>;
  const actions = <div className="video-production-actions">
    {workspace ? null : transcriptAction}
    {transcriptOpen && transcriptEligible ? <>
      {settingsVisible && ["not_requested", "queued"].includes(transcriptState ?? "") && !settings.transcriptId && canRequest ? <Button disabled={transcriptState === "queued" || disabled || transcriptBusy || transcriptChecking || !requestEnabled} onClick={() => void transcribe()}>{transcriptState === "queued" ? "Queued" : transcriptBusy ? "Sending transcription request" : "Transcribe video"}</Button> : null}
      {transcriptState === "ready" && !headerControls ? <><div className="video-production-buttons"><Button disabled={transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("txt")}>Download text</Button><Button disabled={transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("vtt")}>Download captions</Button><Button disabled={transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("srt")}>Download SRT captions</Button><Button disabled={transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("tsv")}>Download soundbite log</Button></div>
        <Button disabled={!validAvidOptions || transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("avid")}>Download Avid markers</Button><Button disabled={transcriptBusy || transcriptLocked} onClick={() => void downloadTranscript("premiere")}>Download Premiere transcript</Button>
      </> : null}
    </> : null}
    <div ref={setPaidActionTarget} />
    {clipHeaderAction}
    {clipOpen && ready && duration > 0 ? <>
      {canRequest ? <Button disabled={!validRange || !validClipSettings || controlsDisabled} onClick={() => void exportClip()}>{clipAction === "request" ? "Sending clip request" : "Export clip"}</Button> : null}
      {clip?.state === "ready" ? <>
        <Button disabled={clipBusy} onClick={() => void downloadClip()}>{clipAction === "download" ? "Preparing download" : "Download clip"}</Button>
        {clip.matchesCurrentFile === false ? <p>This clip uses a previous video file. Its transcript is unavailable here.</p> : transcriptState === "ready" ? <>
          <label>Clip transcript format<Select value={clipTranscriptFormat} disabled={clipBusy || transcriptBusy || transcriptLocked || disabled} onChange={event => setClipTranscriptFormat(event.target.value as ClipTranscriptFormat)}>
            <option value="txt">Text</option><option value="vtt">Captions (VTT)</option><option value="srt">Captions (SRT)</option><option value="tsv">Soundbite log (TSV)</option>
          </Select></label>
          <Button aria-busy={clipAction === "transcript" || undefined} disabled={clipBusy || transcriptBusy || transcriptLocked || disabled} onClick={() => void downloadMatchingTranscript()}>{clipAction === "transcript" ? "Preparing transcript" : "Download clip transcript"}</Button>
          <p>Uses this saved clip’s range and the selected saved transcript. Timestamps use the clip’s frame-rounded beginning as zero.</p>
        </> : <p>Open a saved transcript to download the matching section for this clip.</p>}
      </> : null}
      {clip?.state === "failed" && clip.canRetry && canRequest ? <Button disabled={clipBusy || clipChecking || disabled} onClick={() => void exportClip(true)}>Retry clip</Button> : null}
    </> : null}
  </div>;
  const downloadReason = disabled ? "Wait for the current media action to finish."
    : transcriptBusy ? "Wait for the current transcript action to finish."
      : transcriptLocked ? "Save or cancel transcript edits before downloading."
        : transcriptState !== "ready" ? "Open a saved transcript first." : undefined;
  const downloadItems: MenuItem[] = [
    ...([['txt', 'Plain text', 'TXT · complete saved transcript'], ['vtt', 'Web captions (VTT)', 'VTT · complete saved transcript'],
      ['srt', 'SRT captions', 'SRT · complete saved transcript'], ['tsv', 'Soundbite log (TSV)', 'TSV · timing, speakers and flags']] as const).map(([format, label, description]) => ({
      key: `transcript-${format}`, label, description, group: "Transcript", icon: "file" as const,
      disabledReason: downloadReason, onSelect: () => void downloadTranscript(format),
    })),
    { key: "transcript-avid", label: "Avid markers", group: "Editor interchange", icon: "file",
      disabledReason: downloadReason ?? (!validAvidOptions ? "Choose a frame rate and whole-frame offset in transcript export settings." : undefined),
      onSelect: () => void downloadTranscript("avid") },
    { key: "transcript-premiere", label: "Premiere transcript", group: "Editor interchange", icon: "file",
      description: "Requires saved word timings for every passage.", disabledReason: downloadReason,
      onSelect: () => void downloadTranscript("premiere") },
    { key: "transcript-settings", label: "Transcript export settings…", group: "Editor interchange", icon: "settings",
      disabledReason: disabled || transcriptBusy || transcriptLocked ? "Finish the current transcript action first." : undefined,
      onSelect: () => {
        const focusReadySettings = transcriptState === "ready";
        openSection("transcript", { focusSummary: !workspace && !focusReadySettings });
        onWorkspacePaneChange?.("watch");
        setTranscriptSettingsOpen(true);
        setExportOptionsOpen(true);
        if (focusReadySettings || workspace) {
          const focusOrigin = document.activeElement;
          requestAnimationFrame(() => {
            if (mounted.current && document.activeElement === focusOrigin) (focusReadySettings ? exportOptions.current : transcriptSection.current)?.querySelector("summary")?.focus();
          });
        }
      } },
  ];
  const editorExportsItem: MenuItem = { key: "editor-export-settings", label: "Broadcast & editing exports…", group: "Video", icon: "video",
    hidden: asset.sourceId !== "video-library", description: "Opens existing setup and review; does not request an export.",
    disabledReason: disabled ? "Wait for the current media action to finish." : undefined,
    onSelect: () => {
      onWorkspacePaneChange?.("watch");
      const details = editorExportsHost.current?.querySelector("details");
      if (!details) return;
      details.open = true;
      requestAnimationFrame(() => details.querySelector("summary")?.focus());
    } };
  return { actions, content, transcriptPane: workspace ? transcriptPanel : null, downloadItems, editorExportsItem, onTimeUpdate, playbackSeconds, seekPlayback, transcriptAction: { onSelect: () => openSection("transcript"), expanded: transcriptOpen, controls: transcriptSectionId }, clipAction: { onSelect: () => openSection("clip"), expanded: clipOpen, controls: clipSectionId }, transcriptStatus: transcriptState ? `Transcript: ${transcriptState.replaceAll("_", " ")}` : undefined };
}

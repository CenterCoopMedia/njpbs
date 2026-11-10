import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/Primitives";
import { HttpError } from "../../lib/functions";
import { cancelVideoUpload, startVideoUpload, transferVideo, VideoUploadCompletedError, VideoUploadValidationError, type VideoUploadSession } from "../../lib/source-media-upload";
import { getVideoReplacement, rollbackVideoReplacement, type VideoReplacementStatus } from "../../lib/source-video-replacement";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { invalidateVideoSearchCorpus } from "../../lib/video-search-session-cache";
import "./MediaReplaceButton.css";

const ACCEPT = ".mp4,.m4v,.mov,.webm,.mpeg,.mpg,.mkv,.avi,.wmv,.mxf";
const processingState = (state?: string) => Boolean(state && ["processing", "ready", "promoting"].includes(state));
interface SavedTransfer { requestId: string; expectedVersion: number; session?: VideoUploadSession }
function savedTransfer(key: string): SavedTransfer | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value.requestId === "string" && Number.isSafeInteger(value.expectedVersion) ? value : undefined;
  } catch { return undefined; }
}
export function VideoReplaceButton({ asset, userId, canReplace, disabled = false, getIdToken, onUpdated, onBusyChange }: {
  asset: SourceMediaAssetSummary; userId: string; canReplace: boolean; disabled?: boolean;
  getIdToken: () => Promise<string>; onUpdated: (asset: SourceMediaAssetSummary) => void; onBusyChange: (busy: boolean) => void;
}) {
  const storageKey = `boardwalk-video-replacement:${userId}:${asset.id}`;
  const transfer = useRef<SavedTransfer | undefined>(savedTransfer(storageKey));
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null), descriptionId = useId();
  const heading = useRef<HTMLHeadingElement>(null), rollbackTrigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null), restoreFocus = useRef(false), historyRequest = useRef(false);
  const historyId = useId();
  const controller = useRef<AbortController>();
  const confirmedVersion = useRef<number>();
  const alive = useRef(true), inFlight = useRef(false);
  const statusGeneration = useRef(0);
  const notifiedFileVersion = useRef(asset.fileVersion);
  const observedStatus = useRef(JSON.stringify([asset.fileVersion, asset.replacement?.state, asset.replacement?.errorCode]));
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const callbacks = useRef({ onUpdated, onBusyChange }); callbacks.current = { onUpdated, onBusyChange };
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false), [error, setError] = useState("");
  const [statusError, setStatusError] = useState(""), [historyLoading, setHistoryLoading] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [progress, setProgress] = useState(0), [message, setMessage] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [status, setStatus] = useState<VideoReplacementStatus>(), [historyOpen, setHistoryOpen] = useState(false);
  // Reopened viewers can still have their pre-upload descriptor.
  const [polling, setPolling] = useState(true);
  const [processing, setProcessing] = useState(processingState(asset.replacement?.state));
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); callbacks.current.onBusyChange(false); };
  }, []);
  useEffect(() => {
    if (file || confirmRollback) { restoreFocus.current = true; dialog.current?.showModal(); cancel.current?.focus(); }
    else {
      dialog.current?.close();
      if (restoreFocus.current) {
        restoreFocus.current = false;
        requestAnimationFrame(() => {
          if (!alive.current) return;
          const target = processing || (opener.current as HTMLButtonElement | null)?.disabled ? heading.current : opener.current;
          target?.focus();
        });
      }
    }
  }, [file, confirmRollback]);
  async function refresh(failureMessage = "Replacement status could not be checked. Reload the video to check again. The current file stays available.") {
    if (inFlight.current) return;
    const generation = ++statusGeneration.current;
    const current = () => alive.current && generation === statusGeneration.current;
    try {
      const token = await getIdToken();
      if (!current()) return;
      const result = await getVideoReplacement(token, asset.id);
      if (!current()) return;
      setStatus(result); setStatusError(""); setNow(Date.now());
      setProcessing(processingState(result.state) || result.migrationPending && result.errorCode !== "publication_refresh_failed");
      if (result.state === "complete" && result.asset.fileVersion !== notifiedFileVersion.current && !disabledRef.current) {
        invalidateVideoSearchCorpus(asset.sourceId);
        notifiedFileVersion.current = result.asset.fileVersion;
        callbacks.current.onUpdated(result.asset);
      }
      setPolling(processingState(result.state) || result.migrationPending || result.transcriptPending ||
        result.state === "complete" && result.asset.fileVersion !== notifiedFileVersion.current);
    } catch {
      if (current()) setStatusError(failureMessage);
    }
  }
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const identity = JSON.stringify([asset.fileVersion, asset.replacement?.state, asset.replacement?.errorCode]);
    if (observedStatus.current === identity) return;
    observedStatus.current = identity;
    statusGeneration.current++;
    notifiedFileVersion.current = asset.fileVersion;
    setStatus(undefined); setProcessing(processingState(asset.replacement?.state)); setPolling(true);
    if (canReplace && asset.sourceId === "video-library") void refreshRef.current();
  }, [asset.fileVersion, asset.replacement?.state, asset.replacement?.errorCode, canReplace, asset.sourceId]);
  useEffect(() => {
    const expiry = status?.previous ? Date.parse(status.previous.expiresAt) : 0;
    if (!expiry || expiry <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), expiry - Date.now());
    return () => clearTimeout(timer);
  }, [status?.previous?.expiresAt]);
  useEffect(() => {
    if (!polling || !canReplace || asset.sourceId !== "video-library") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshRef.current();
      if (!stopped) timer = setTimeout(() => void poll(), 10_000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [polling, canReplace, asset.sourceId, asset.id]);
  function store(value?: SavedTransfer) {
    transfer.current = value;
    try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); }
    catch { setMessage("Keep this window open to retain this upload's progress."); }
  }
  function finishDialog() { setFile(null); setConfirmRollback(false); }
  async function showHistory() {
    if (historyRequest.current) return;
    historyRequest.current = true; setHistoryOpen(true); setHistoryLoading(true);
    try { await refresh("File history could not be loaded. Try again."); }
    finally { historyRequest.current = false; if (alive.current) setHistoryLoading(false); }
  }
  async function run() {
    if (inFlight.current || disabled || !canReplace || (!file && !confirmRollback)) return;
    const expectedVersion = confirmedVersion.current;
    if (expectedVersion !== asset.version) {
      setError("The video changed. Review its details and confirm the replacement or rollback again.");
      finishDialog();
      return;
    }
    inFlight.current = true; setBusy(true); callbacks.current.onBusyChange(true); setError(""); setStatusError(""); setRecoveryMessage("");
    statusGeneration.current += 1;
    setMessage(confirmRollback ? "Restoring the previous file…" : "Starting replacement upload…");
    controller.current = new AbortController();
    try {
      if (confirmRollback) {
        const result = await rollbackVideoReplacement(await getIdToken(), asset.id, expectedVersion);
        if (alive.current) callbacks.current.onUpdated(result.asset);
      } else if (file) {
        const requireActiveSession = Boolean(transfer.current);
        const saved = transfer.current ?? { requestId: crypto.randomUUID(), expectedVersion };
        store(saved);
        let session = saved.session;
        if (!session) {
          const started = await startVideoUpload(getIdToken, asset.sourceId, file, { name: asset.name }, {
            requestId: saved.requestId, signal: controller.current.signal,
            replacement: { assetId: asset.id, expectedVersion: saved.expectedVersion, confirmed: true } });
          session = started.upload; store({ ...saved, session });
        }
        await transferVideo({ file, sourceId: asset.sourceId, session, getIdToken, signal: controller.current.signal, requireActiveSession,
          onProgress: bytes => { if (alive.current) setProgress(Math.floor(bytes / file.size * 100)); },
          onPhase: phase => { if (alive.current) setMessage(phase === "finishing" ? "Verifying replacement upload…" : "Uploading replacement video…"); },
          onSession: value => store({ ...saved, session: { sessionId: value.sessionId, assetId: value.assetId,
            partSize: value.partSize, totalParts: value.totalParts, expiresAt: value.expiresAt, version: value.version } }),
        });
        store();
      }
      if (!alive.current) return;
      finishDialog(); setStatus(undefined); setProcessing(true); setPolling(true); setMessage("Preparing the replacement. The current video stays live until the new viewing copy is ready.");
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof VideoUploadCompletedError) {
        store(); finishDialog(); setError(""); setMessage(""); setRecoveryMessage(cause.message); setStatus(undefined);
        setProcessing(processingState(cause.asset.replacement?.state)); setPolling(true);
        invalidateVideoSearchCorpus(asset.sourceId);
        callbacks.current.onUpdated(cause.asset);
        return;
      }
      setMessage("");
      if (cause instanceof HttpError && cause.data.upload && transfer.current) {
        const upload = cause.data.upload as VideoUploadSession;
        if (typeof upload.sessionId === "string" && upload.assetId === asset.id) store({ ...transfer.current, session: upload });
      }
      setError(controller.current.signal.aborted ? "Upload paused. Choose the same file to resume, or cancel the saved replacement."
        : cause instanceof Error ? cause.message : "Replacement failed. The current video is unchanged.");
      if (cause instanceof HttpError && ([404, 410].includes(cause.status) ||
          !transfer.current?.session && [400, 403, 409].includes(cause.status))) store();
      if (cause instanceof HttpError && cause.data.code === "replacement_unavailable") store();
      if (cause instanceof VideoUploadValidationError && !transfer.current?.session) store();
      finishDialog();
    } finally {
      inFlight.current = false;
      if (alive.current) { setBusy(false); callbacks.current.onBusyChange(false); }
    }
  }
  async function cancelSaved() {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setBusy(true); callbacks.current.onBusyChange(true);
    statusGeneration.current += 1;
    try {
      const saved = transfer.current;
      if (!saved?.session) throw Error("Choose the original file again to recover the upload session before canceling.");
      await cancelVideoUpload(getIdToken, asset.sourceId, saved.session);
      store(); setError(""); setMessage("Replacement upload canceled. The current file is unchanged.");
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 409 && cause.data.code === "upload_completed") {
        store(); setMessage(""); setError("The saved replacement upload already finished and cannot be canceled. Open file history to check its status.");
      } else if (cause instanceof HttpError && [404, 410].includes(cause.status)) {
        store(); setError(""); setMessage("The saved upload is no longer available. Choose Replace file to start again. The current file is unchanged.");
      } else setError(cause instanceof Error ? cause.message : "Cancellation failed. Try again.");
    }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); callbacks.current.onBusyChange(false); } }
  }
  if (!canReplace || asset.sourceId !== "video-library") return null;
  const pending = processing;
  const migrationFailed = (status ? status.errorCode : asset.replacement?.errorCode) === "publication_refresh_failed";
  const permissionChanged = (status?.errorCode ?? asset.replacement?.errorCode) === "replacement_permission_changed";
  const videoChanged = (status?.errorCode ?? asset.replacement?.errorCode) === "replacement_video_changed";
  const failed = !pending && !busy && !error && (status?.state ?? asset.replacement?.state) === "failed";
  const expired = Boolean(status?.previous && Date.parse(status.previous.expiresAt) <= now);
  const statusMessage = error || busy || migrationFailed ? "" : pending ? "Preparing replacement and updating published players. The current viewing copy stays available."
    : failed ? "" : status?.state === "complete" ? status.lastAction === "rollback" ? "Previous video file restored." : "Video file replaced." : message;
  return <section className="media-replace-control video-replace-control" aria-label="Video file versions" data-viewer-keys="off">
    <h3 ref={heading} tabIndex={-1}>File versions</h3>
    <Button ref={trigger} disabled={disabled || busy || pending || migrationFailed} onClick={() => input.current?.click()}>
      {transfer.current ? "Resume replacement" : "Replace file"}
    </Button>
    <input ref={input} hidden type="file" accept={ACCEPT} aria-label={`Choose a replacement video for ${asset.name}`}
      disabled={disabled || busy || pending || migrationFailed} onChange={event => {
        const chosen = event.target.files?.[0]; event.target.value = ""; setError("");
        if (chosen) { confirmedVersion.current = asset.version; opener.current = trigger.current; setProgress(0); setFile(chosen); }
      }} />
    {transfer.current && !busy ? <Button disabled={disabled || pending} onClick={() => void cancelSaved()}>Cancel saved replacement</Button> : null}
    <dialog ref={dialog} tabIndex={-1} className="media-replace-dialog" aria-label={confirmRollback ? "Confirm video rollback" : `Confirm replacement of ${asset.name}`}
      aria-describedby={descriptionId} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && inFlight.current) event.preventDefault();
      }}
      onCancel={event => { event.preventDefault(); if (!inFlight.current) finishDialog(); }}
      onClose={() => { if (inFlight.current) dialog.current?.showModal(); else finishDialog(); }}>
      <h2>{confirmRollback ? "Restore previous file" : "Replace file"}</h2>
      <p>{confirmRollback ? "Restore the previous video file?" : `Replace the file for “${asset.name}” with “${file?.name}”?`}</p>
      <p id={descriptionId}>The video keeps its ID, metadata and placements. The current video stays live while the replacement processes. One previous file is available for rollback for 14 days; replacing again removes that older rollback option.</p>
      <div className="media-form-actions">
        <Button variant="primary" disabled={disabled || busy} aria-busy={busy} onClick={() => void run()}>{confirmRollback ? "Confirm rollback" : "Confirm replacement"}</Button>
        <Button ref={cancel} disabled={busy} onClick={finishDialog}>Cancel</Button>
      </div>
      {busy && file ? <><progress max={100} value={progress} aria-label="Replacement upload progress" /><p role="status">{message}</p><Button onClick={() => controller.current?.abort()}>Pause upload</Button></> : null}
      {busy && confirmRollback ? <p role="status">Restoring the previous file…</p> : null}
    </dialog>
    {error ? <p role="alert">{error}</p> : null}
    {recoveryMessage ? <p role="status">{recoveryMessage}</p> : null}
    {statusError ? <p role="alert">{statusError}</p> : null}
    {migrationFailed ? <p role="alert">Some published players could not be updated. Existing viewing copies stay available. Open file history to restore the previous file, or ask an administrator to repair the published content. Processing retries automatically.</p> : null}
    {status?.errorCode === "promotion_retry" ? <p role="alert">The new viewing copy could not be published yet. The current video stays live. Processing will retry automatically.</p> : null}
    {status?.errorCode === "transcription_waiting" ? <p role="status">The video is ready. Its transcript is waiting to be processed.</p> : null}
    {failed && (permissionChanged || videoChanged) ? <p role="alert">The replacement stopped because {permissionChanged ? "publish or video-management permission changed" : "the video changed"}. The current file is unchanged. Reload its details; an authorized staff member can replace or restore it again.</p> : null}
    {failed && !permissionChanged && !videoChanged ? <p role="alert">The replacement could not be processed. The previous file is still live. Choose Replace file to try again.</p> : null}
    {statusMessage ? <p role="status">{statusMessage}</p> : null}
    <Button disabled={busy || historyLoading} aria-busy={historyLoading} aria-expanded={historyOpen} aria-controls={historyId} onClick={() => void showHistory()}>View file history</Button>
    {historyOpen ? <div id={historyId} className="video-replace-history">
      {historyLoading ? <p role="status">Loading file history…</p> : null}
      {status ? <>
        {status.history.length ? <ol>{status.history.map((event, index) => <li key={`${event.at}-${index}`}>{event.action === "rollback" ? "Restored" : event.action === "replace" ? "Replaced" : "Replacement requested"} {event.originalName} — {event.by}, {new Date(event.at).toLocaleString()}</li>)}</ol> : <p>No previous replacements.</p>}
        {status.previous && !expired && !pending ? <><p>Previous file: {status.previous.originalName}. Rollback expires {new Date(status.previous.expiresAt).toLocaleString()}.</p>
          <Button ref={rollbackTrigger} disabled={disabled || busy} onClick={() => { confirmedVersion.current = asset.version; opener.current = rollbackTrigger.current; setConfirmRollback(true); }}>Restore previous file</Button></> : null}
        {status.previousDeleted ? <p>Previous version deleted after 14 days</p> : status.previousCleanupPending || expired
          ? <p>Previous file’s restore window has ended. Cleanup is waiting for protected work to finish. Ask an administrator if it needs repair.</p> : null}
      </> : null}
    </div> : null}
  </section>;
}

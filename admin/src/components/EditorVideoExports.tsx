import { isBroadcastFrameRate, sourceFrameRateLabel, sourceFramesPerSecond, type SourceFrameRate } from "../lib/video-frame-rate";
import { useEffect, useRef, useState } from "react";
import { clipExportMessage } from "../lib/clip-export-message";
import { originalAccessMessage } from "../lib/video-original";
import { Button, InlineMessage, Select } from "./ui/Primitives";
import { VideoProcessingStatus } from "./VideoProcessingStatus";
import {
  cancelEditorExport, editorFormats, getEditorExport, listEditorExports, requestEditorExport,
  estimateEditorConversionCharge, exportFrameRates, exportFramesPerSecond, exportFrameRateLabel, exportRateSupported, type ExportFrameRateMode,
  type EditorExportRequest, type EditorExportScope, type EditorFormat, type EditorVideoExport,
} from "../lib/video-editor-exports";
import {
  transcriptionChargeLabel,
  readClipTranscript, readVideoClip, videoTime,
  type ClipTranscriptFormat, type TranscriptSettings, type VideoIdentity,
} from "../lib/video-production";

function download(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

function exportMessage(error: unknown) {
  const detail = originalAccessMessage(error) ?? clipExportMessage(error);
  if (detail) return detail;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 401) return "Sign in again, then check the saved export.";
  if (status === 403) return "Your account cannot use this export. Ask a CMS administrator for help.";
  if (status === 404) return "The source or export is no longer available. Reopen the video library.";
  if (status === 409) return "The source, export or transcript changed, or its timing is not ready. Check the saved status before trying again.";
  if (status === 429) return "The export request limit has been reached. Check your current exports before trying again.";
  if (status === 503) return "Editor exports are currently unavailable. Existing files can still be downloaded until they expire.";
  return "The request could not be confirmed. Check the saved status before starting another export.";
}

function savedRequest(clip: EditorVideoExport): EditorExportRequest {
  const mode = clip.frameRateMode ? { frameRateMode: clip.frameRateMode } : {};
  return clip.scope === "source"
    ? { scope: "source", format: clip.format, retry: true, ...mode }
    : { scope: "clip", format: clip.format, inMs: clip.inMs, outMs: clip.outMs, retry: true, ...mode };
}

export function EditorVideoExports({ identity, name, getIdToken, canRequest, disabled,
  onBusyChange,
  sourceRate, sourceDurationSeconds, onDownloadOriginal,
  inMs, outMs, validRange, exportEligible, transcriptSettings, transcriptReady, transcriptLocked, transcriptRevision,
}: {
  identity: VideoIdentity;
  name: string;
  sourceRate?: SourceFrameRate;
  sourceDurationSeconds?: number;
  onDownloadOriginal?: () => void;
  getIdToken: () => Promise<string>;
  canRequest: boolean;
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
  inMs: number | null;
  outMs: number | null;
  validRange: boolean;
  exportEligible: boolean;
  transcriptSettings: TranscriptSettings;
  transcriptReady: boolean;
  transcriptLocked: boolean;
  transcriptRevision: number;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<EditorExportScope>("clip");
  const [format, setFormat] = useState<EditorFormat>("broadcast_mxf");
  const [frameRateMode, setFrameRateMode] = useState<ExportFrameRateMode>("broadcast");
  const [enabled, setEnabled] = useState<boolean>();
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<EditorVideoExport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<EditorVideoExport>();
  const [refresh, setRefresh] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { onBusyChange?.(busy !== null); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [error, setError] = useState("");
  const [transcriptFormat, setTranscriptFormat] = useState<ClipTranscriptFormat>("txt");
  const mounted = useRef(true);
  const actionGeneration = useRef(0);
  const inFlight = useRef(false);
  const permissions = useRef({ disabled, canRequest, exportEligible });
  permissions.current = { disabled, canRequest, exportEligible };
  const selection = useRef("");
  selection.current = JSON.stringify([identity, transcriptSettings, transcriptLocked, transcriptRevision, selected?.id, selected?.attemptId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    void getIdToken().then(token => listEditorExports(token, identity, scope)).then(response => {
      if (!current) return;
      setClips(response.clips.filter(clip => clip.format in editorFormats));
      setNextCursor(response.nextCursor ?? null);
      setEnabled(response.editorExportsEnabled === true);
    }).catch(reason => { if (current) { setEnabled(undefined); setError(exportMessage(reason)); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, scope, refresh, identity.sourceId, identity.assetId, getIdToken]);

  useEffect(() => {
    if (!open || busy || !selected || !["queued", "processing"].includes(selected.state)) return;
    let current = true;
    const generation = actionGeneration.current;
    const timer = window.setTimeout(() => {
      void getIdToken().then(token => getEditorExport(token, identity, selected.id)).then(response => {
        if (!current || generation !== actionGeneration.current) return;
        setSelected(response.clip);
        setCheckedAt(Date.now());
      }).catch(reason => { if (current && generation === actionGeneration.current) setError(exportMessage(reason)); });
    }, 10_000);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, busy, selected, identity.sourceId, identity.assetId, getIdToken]);

  useEffect(() => {
    if (!selected) return;
    setClips(previous => previous.some(clip => clip.id === selected.id)
      ? previous.map(clip => clip.id === selected.id ? selected : clip)
      : [selected, ...previous]);
  }, [selected]);

  async function run(action: string, work: (token: string) => Promise<void>) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    actionGeneration.current += 1;
    setBusy(action);
    setError("");
    try {
      const token = await getIdToken();
      if (mounted.current && !permissions.current.disabled &&
          (action !== "request" || permissions.current.exportEligible) &&
          (!["request", "cancel"].includes(action) || permissions.current.canRequest)) await work(token);
    } catch (reason) { if (mounted.current) setError(exportMessage(reason)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  function saveResult(clip: EditorVideoExport, resetHistory = false) {
    if (!mounted.current) return;
    setSelected(clip);
    setCheckedAt(Date.now());
    if (resetHistory) { setNextCursor(null); setRefresh(value => value + 1); }
  }

  function request(retry = false) {
    if (!canRequest || !exportEligible || !enabled || loading || (retry ? !selected?.canRetry : scope === "clip" && !validRange)) return;
    if (!retry && ((format === "broadcast_mp4" && !copyEligible) || !supportedRate)) return;
    const payload: EditorExportRequest = retry && selected ? savedRequest(selected)
      : scope === "source" ? { scope, format, frameRateMode } : { scope, format, frameRateMode, inMs: inMs!, outMs: outMs! };
    void run("request", async token => saveResult((await requestEditorExport(token, identity, payload)).clip, true));
  }

  function matchingTranscript() {
    if (!selected || selected.scope !== "clip" || selected.state !== "ready" || selected.matchesCurrentFile === false || !transcriptReady || transcriptLocked) return;
    const context = selection.current;
    const clip = selected;
    void run("transcript", async token => {
      const response = await readClipTranscript(token, identity, transcriptSettings, clip.id, transcriptFormat);
      if (!mounted.current || selection.current !== context) return;
      if (response.revision !== transcriptRevision) throw Object.assign(new Error("Transcript changed"), { status: 409 });
      if (response.clipId !== clip.id || response.inMs !== clip.inMs || response.outMs !== clip.outMs) throw new Error("Export changed");
      const url = URL.createObjectURL(new Blob([response.body], { type: response.contentType }));
      download(url, response.filename);
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  function loadOlder() {
    if (!nextCursor || loading) return;
    void run("older", async token => {
      const response = await listEditorExports(token, identity, scope, nextCursor);
      if (!mounted.current) return;
      setClips(previous => [...new Map([...previous, ...response.clips.filter(clip => clip.format in editorFormats)]
        .map(clip => [clip.id, clip])).values()]);
      setNextCursor(response.nextCursor ?? null);
    });
  }

  const locked = disabled || busy !== null;
  const sourceFps = sourceFramesPerSecond(sourceRate);
  const outputFps = exportFramesPerSecond(frameRateMode, sourceRate);
  const copyEligible = sourceFps !== null && outputFps !== null && Math.abs(sourceFps - outputFps) > 0.000001;
  const supportedRate = exportRateSupported(format, frameRateMode);
  const conversionEstimate = estimateEditorConversionCharge(format, frameRateMode,
    scope === "source" ? sourceDurationSeconds ?? 0 : validRange ? (outMs! - inMs!) / 1000 : 0, sourceRate);
  const conversionLabel = frameRateMode === "source" || (sourceFps !== null && outputFps !== null && Math.abs(sourceFps - outputFps) < 0.000001) ? "No frame rate conversion"
    : sourceFps === null ? "The conversion method is selected after measuring the original"
    : frameRateMode === "broadcast" && Math.abs(sourceFps - 24000 / 1001) < 0.000001 ? "Standard 2:3 pulldown for progressive film input; otherwise interpolation"
    : "Interpolation; no FrameFormer surcharge";
  return <><section aria-label="Source frame rate">
    <p>Source frame rate: {sourceFrameRateLabel(sourceRate)}.</p>
    {sourceFps !== null && !isBroadcastFrameRate(sourceRate) ? <p role="status">Not the 29.97 fps broadcast standard. CentralCast needs 29.97 fps (30000/1001); this source cannot air. You can still select and publish this video.</p> : null}
    {isBroadcastFrameRate(sourceRate) ? <>
      <p>The original already uses 29.97 fps. A separate frame rate copy is not needed.</p>
      {onDownloadOriginal ? <Button disabled={locked} onClick={onDownloadOriginal}>Download 29.97 fps original</Button> : null}
    </> : canRequest ? <Button disabled={locked || !exportEligible || sourceFps === null} onClick={() => {
      setScope("source"); setFormat("broadcast_mp4"); setFrameRateMode("broadcast"); setSelected(undefined);
      setClips([]); setNextCursor(null); setError(""); setOpen(true);
    }}>Prepare 29.97 fps copy</Button> : null}
    {sourceFps === null ? <p>The original frame rate has not been measured. An administrator can prepare its metadata. Editor exports measure the original before conversion.</p> : null}
  </section><details open={open} aria-busy={busy !== null || loading || undefined} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Broadcast and editing exports</summary>
    <p>Convert the original to an editing format. Exports use paid processing and stay available for 7 days. The original stays unchanged.</p>
    <label>Export range<Select value={scope} disabled={locked} onChange={event => { setScope(event.target.value as EditorExportScope); if (event.target.value === "clip" && format === "broadcast_mp4") setFormat("broadcast_mxf"); setSelected(undefined); setClips([]); setNextCursor(null); setError(""); }}>
      <option value="clip">Selected clip</option><option value="source">Full video</option>
    </Select></label>
    {scope === "clip" ? <p>{validRange ? `Use the clip selection: ${videoTime(inMs! / 1000)} to ${videoTime(outMs! / 1000)}.` : "Set a valid in/out range in Clip settings first."}</p> : <p>Uses the full original. Full-video exports support recordings up to 24 hours.</p>}
    <label>Video format<Select value={format} disabled={locked} onChange={event => { setFormat(event.target.value as EditorFormat); if (event.target.value === "broadcast_mp4") setFrameRateMode("broadcast"); }}>
      {Object.entries(editorFormats).filter(([value]) => value !== "broadcast_mp4" || scope === "source").map(([value, item]) => <option key={value} value={value} >{item.label}</option>)}
    </Select></label>
    <label>Export frame rate<Select value={frameRateMode} disabled={locked} onChange={event => setFrameRateMode(event.target.value as ExportFrameRateMode)}>
      {Object.entries(exportFrameRates).map(([value, label]) => <option key={value} value={value} disabled={!exportRateSupported(format, value as ExportFrameRateMode)}>{label}</option>)}
    </Select></label>
    <p>{conversionLabel}. The original stays unchanged.</p>
    {!supportedRate ? <p role="status">XDCAM does not support this output rate. Choose another rate or format.</p> : null}
    {format === "broadcast_mp4" && !copyEligible && sourceFps !== null ? <p>The original already uses the chosen rate. Download the original without conversion.</p> : null}
    <p>{format === "broadcast_mp4" ? "MP4 copies use H.264 with stereo AAC audio when audio is present. They fit within 1920 × 1080; aspect ratio is retained."
      : "Editor exports use supported HD dimensions. A 720p film source uses 1080i for 2:3 pulldown. XDCAM and DNxHD use 720p above 30 fps. Source audio channels stay separate. DNxHR is not available yet."}</p>
    {conversionEstimate ? <p>Estimated MediaConvert charge before request: {transcriptionChargeLabel(conversionEstimate.minimum)}{conversionEstimate.maximum !== conversionEstimate.minimum ? ` to ${transcriptionChargeLabel(conversionEstimate.maximum)}` : ""}. {format === "prores_mov" ? "Original dimensions are not measured here; the estimate spans SD through 4K. Larger outputs have no published ProRes estimate." : null} Storage, requests and function execution are extra. Interpolation and telecine do not use the FrameFormer addon.</p> : <p>Set a valid range to see the MediaConvert estimate before requesting an export.</p>}
    {!exportEligible ? <p role="status">New exports require a ready viewing copy with a duration greater than zero and no longer than 24 hours. Saved exports remain available.</p> : null}
    {!enabled ? <p role="status">{loading ? "Checking export availability." : enabled === false
      ? "Editor exports are not enabled. You can check and download existing exports."
      : "Export availability could not be checked. Existing downloads remain available."}</p> : null}
    <div className="video-production-buttons">
      {canRequest ? <Button disabled={locked || loading || !enabled || !exportEligible || !supportedRate || (format === "broadcast_mp4" && !copyEligible) || (scope === "clip" && !validRange)} onClick={() => request()}>{busy === "request" ? "Sending export request" : "Export video"}</Button> : null}
      <Button disabled={locked || loading} onClick={() => { setError(""); setRefresh(value => value + 1); }}>Refresh export history</Button>
    </div>
    {clips.length > 0 ? <ul className="video-recent-clips">{clips.map(clip => <li key={clip.id}><Button disabled={locked} onClick={() => { setSelected(clip); setCheckedAt(undefined); }}>
      {editorFormats[clip.format].label} · {clip.scope === "source" ? "Full video" : `${videoTime(clip.inMs / 1000)} to ${videoTime(clip.outMs / 1000)}`} · {exportFrameRateLabel(clip.frameRateMode)} · {clip.state}
    </Button></li>)}</ul> : null}
    {nextCursor ? <Button disabled={locked || loading} onClick={loadOlder}>{busy === "older" ? "Loading older exports" : "Load older editor exports"}</Button> : null}
    {selected ? <section aria-label="Selected editor export">
      <p>{editorFormats[selected.format].label} · {selected.scope === "source" ? "Full video" : "Selected clip"} · Chosen rate: {exportFrameRateLabel(selected.frameRateMode)}</p>
      <p>Measured source: {sourceFrameRateLabel(selected)}. Output: {selected.frameRateNumerator && selected.frameRateDenominator ? `${Number((selected.frameRateNumerator / selected.frameRateDenominator).toFixed(3))} fps (${selected.frameRateNumerator}/${selected.frameRateDenominator})` : "Not measured yet"}. Method: {selected.conversionMethod ?? "Not recorded yet"}.</p>
      {selected.timecodeMode ? <p>{selected.timecodeMode === "embedded_or_zero_based" ? "The job requests an embedded timecode timeline. The AWS API describes a zero-based fallback. Output timecode presence and camera preservation have not been verified." : "The job requests a zero-based timecode timeline."} 29.97 fps exports request drop-frame timecode where the format supports it.</p> : null}
      <VideoProcessingStatus kind="Export" state={selected.state} processing={selected.processing} checkedAt={checkedAt} reference={selected.id} />
      {selected.expiresAt ? <p>Expires {new Date(selected.expiresAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET.</p> : null}
      <div className="video-production-buttons">
      <Button disabled={locked} onClick={() => void run("check", async token => saveResult((await getEditorExport(token, identity, selected.id)).clip))}>Check export status</Button>
      {selected.canCancel && canRequest ? <Button variant="danger-quiet" disabled={locked} onClick={() => void run("cancel", async token => saveResult((await cancelEditorExport(token, identity, selected)).clip))}>Cancel queued export</Button> : null}
      {selected.canRetry && canRequest ? <Button disabled={locked || loading || !enabled || !exportEligible} onClick={() => request(true)}>Retry export</Button> : null}
      {selected.state === "ready" ?
        <Button disabled={locked} onClick={() => {
          const clip = selected;
          void run("download", async token => {
            const response = await readVideoClip(token, identity, clip.id);
            if (mounted.current) download(response.access.url, `${name}-${clip.scope}.${editorFormats[clip.format].extension}`);
          });
        }}>Download video</Button> : null}
      </div>
      {selected.canCancel ? <p>Cancellation is available before processing starts. It does not restore the daily allowance.</p> : null}
      {selected.state === "ready" ? <>
        {selected.matchesCurrentFile === false ? <p>This export uses a previous video file. Its transcript is unavailable here.</p>
          : selected.scope === "clip" ? <><label>Matching transcript format<Select value={transcriptFormat} disabled={locked || transcriptLocked} onChange={event => setTranscriptFormat(event.target.value as ClipTranscriptFormat)}>
          <option value="txt">Text</option><option value="vtt">Captions (VTT)</option><option value="srt">Captions (SRT)</option><option value="tsv">Soundbite log (TSV)</option>
        </Select></label>
        <Button disabled={locked || !transcriptReady || transcriptLocked} onClick={matchingTranscript}>Download matching transcript</Button>
        <p>Uses the selected saved transcript and this export’s frame-rounded range. Open a saved transcript first.</p></> : <p>Use the transcript controls to download the full saved transcript.</p>}
      </> : null}
    </section> : null}
    {error ? <InlineMessage tone="error" title="Export needs attention">{error}</InlineMessage> : null}
  </details></>;
}

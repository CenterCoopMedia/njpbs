import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "../ui/Primitives";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { mediaPermalink } from "../../lib/media-permalink";
import { mediaVideosPath } from "../../lib/routes";
import { listVideoOrientationExports, requestVideoOrientationExport,
  type VideoOrientation, type VideoOrientationExport as ExportStatus } from "../../lib/video-production";
import "./MediaReplaceButton.css";

const POLL_MS = 15_000;
const OPTIONS: { orientation: VideoOrientation; label: string; size: string }[] = [
  { orientation: "vertical", label: "Export vertical", size: "9:16, 1080 × 1920" },
  { orientation: "horizontal", label: "Export horizontal", size: "16:9, 1920 × 1080" },
];
const active = (job?: ExportStatus) => job?.state === "queued" || job?.state === "processing" || job?.state === "finishing_upload";

/** Keep pending exports for the library's lifetime, including closed viewers. */
export function useVideoExportCompletion(onCreated: () => void) {
  const watching = useRef(new Set<string>());
  const created = useRef(onCreated); created.current = onCreated;
  return useCallback((jobs: ExportStatus[]) => {
    for (const job of jobs) {
      if (active(job)) watching.current.add(job.id);
      else if (watching.current.delete(job.id) && job.state === "complete") created.current();
    }
  }, []);
}

function statusText(job: ExportStatus) {
  const name = job.orientation === "vertical" ? "Vertical" : "Horizontal";
  if (job.state === "queued") return `${name} export is waiting for the media worker.`;
  if (job.state === "processing") return `${name} export is rendering.`;
  if (job.state === "finishing_upload") return `${name} export: Finishing upload.`;
  if (job.state === "complete") return `${name} export saved as a new video.`;
  return `${name} export failed. Press Export to try again.`;
}

/** Makes a vertical or horizontal copy of a library video on the local video worker. */
export function VideoOrientationExport({ asset, getIdToken, disabled = false, onStatus }: {
  asset: SourceMediaAssetSummary; getIdToken: () => Promise<string>; disabled?: boolean;
  onStatus?: (jobs: ExportStatus[]) => void;
}) {
  const identity = { sourceId: asset.sourceId, assetId: asset.id };
  const [jobs, setJobs] = useState<Partial<Record<VideoOrientation, ExportStatus>>>({});
  const [busy, setBusy] = useState<VideoOrientation | null>(null);
  const [error, setError] = useState("");
  const [workerReady, setWorkerReady] = useState(true);
  const alive = useRef(true);
  // A request or a newer read makes an older status read stale.
  const generation = useRef(0);
  const status = useRef(onStatus); status.current = onStatus;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    const read = ++generation.current;
    try {
      const { exports, workerReady: ready } = await listVideoOrientationExports(await getIdToken(), { sourceId: asset.sourceId, assetId: asset.id });
      if (!alive.current || read !== generation.current) return;
      // The list is newest first; keep the newest export of each format.
      const latest: Partial<Record<VideoOrientation, ExportStatus>> = {};
      for (const job of exports) latest[job.orientation] ??= job;
      setJobs(latest);
      setWorkerReady(ready);
      status.current?.(Object.values(latest));
    } catch { /* The buttons still work; status returns on the next refresh. */ }
  }, [asset.sourceId, asset.id, asset.fileVersion, getIdToken]);

  const eligible = asset.sourceId === "video-library" && asset.viewingCopy?.state === "ready";
  useEffect(() => { setJobs({}); if (eligible) void refresh(); }, [eligible, refresh]);
  const waiting = OPTIONS.some(({ orientation }) => active(jobs[orientation]));
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  async function start(orientation: VideoOrientation) {
    setBusy(orientation); setError("");
    generation.current += 1;
    try {
      const result = await requestVideoOrientationExport(await getIdToken(), identity, orientation);
      // The library still tracks a request whose viewer closed during the POST.
      status.current?.([result.export]);
      if (!alive.current) return;
      // A status read that started before this response cannot replace it.
      generation.current += 1;
      setJobs(current => ({ ...current, [orientation]: result.export }));
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "The export could not start. Try again.");
    } finally { if (alive.current) setBusy(null); }
  }

  if (!eligible) return null;
  return <section className="media-replace-control video-replace-control" aria-label="Social video formats" data-viewer-keys="off">
    <h3>Social formats</h3>
    <p>Save a copy for social video. The video stays sharp at the center over a soft, dimmed copy that fills the frame.</p>
    <div className="media-form-actions">
      {OPTIONS.map(({ orientation, label, size }) => <Button key={orientation} title={size}
        disabled={disabled || busy !== null || active(jobs[orientation])} aria-busy={busy === orientation}
        aria-label={`${label} (${size})`} onClick={() => void start(orientation)}>{label}</Button>)}
    </div>
    <div role="status">
      {workerReady ? null : <p>The media worker is not running exports right now. New exports wait in line and start when it returns.</p>}
      {OPTIONS.map(({ orientation }) => {
        const job = jobs[orientation];
        if (!job) return null;
        return <p key={orientation}>{statusText(job)}{job.state === "complete" && job.outputAssetId ? <>
          {" "}<Link to={mediaPermalink(mediaVideosPath(asset.sourceId), job.outputAssetId)}>
            Open {job.orientation} video</Link></> : null}</p>;
      })}
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

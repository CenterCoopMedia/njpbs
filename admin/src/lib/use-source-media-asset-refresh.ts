import { useEffect, useRef } from "react";
import { listSourceMedia, type SourceMediaAssetSummary, type SourceMediaProcessingStatus } from "./source-media";
import { invalidateVideoSearchCorpus } from "./video-search-session-cache";

export const SOURCE_MEDIA_FILE_CHANGED_EVENT = "boardwalk:source-media-file-changed";
const REFRESH_MS = 30_000;

export function sourceMediaStatusMatches(asset: SourceMediaAssetSummary, status: SourceMediaProcessingStatus) {
  return !status.fileVersion || status.fileVersion === asset.fileVersion;
}

/** Full reads replace binary descriptors; lightweight polls never cross files. */
export function refreshedSourceMediaAsset(previous: SourceMediaAssetSummary, fresh: SourceMediaAssetSummary, blocked = false) {
  if (fresh.version < previous.version || previous.fileVersion && !fresh.fileVersion) return previous;
  if (!blocked) return fresh;
  return sourceMediaStatusMatches(previous, fresh)
    ? { ...previous, viewingCopy: fresh.viewingCopy, uploadedBy: fresh.uploadedBy ?? previous.uploadedBy }
    : previous;
}

function changed(previous: SourceMediaAssetSummary, fresh: SourceMediaAssetSummary) {
  return previous.fileVersion !== fresh.fileVersion || previous.version !== fresh.version ||
    JSON.stringify(previous.viewingCopy) !== JSON.stringify(fresh.viewingCopy) ||
    JSON.stringify(previous.replacement) !== JSON.stringify(fresh.replacement);
}

/** Revalidate every open video surface, including read-only managers and Quick Look. */
export function useSourceMediaAssetRefresh({ asset, getIdToken, onUpdated, blocked = false }: {
  asset?: SourceMediaAssetSummary;
  getIdToken: () => Promise<string>;
  onUpdated: (asset: SourceMediaAssetSummary) => void;
  blocked?: boolean;
}) {
  const latest = useRef({ asset, getIdToken, onUpdated, blocked });
  latest.current = { asset, getIdToken, onUpdated, blocked };
  const pending = useRef<SourceMediaAssetSummary>();
  useEffect(() => {
    if (!asset || asset.kind !== "video") return;
    let stopped = false, running = false, queued = false;
    const sameAsset = (candidate?: SourceMediaAssetSummary) => candidate?.id === asset.id && candidate.sourceId === asset.sourceId;
    const apply = (fresh: SourceMediaAssetSummary) => {
      const current = latest.current;
      if (!sameAsset(current.asset) || !current.asset || fresh.version < current.asset.version ||
          current.asset.fileVersion && !fresh.fileVersion || !changed(current.asset, fresh)) return;
      if (current.blocked) { pending.current = fresh; return; }
      pending.current = undefined;
      if (current.asset.fileVersion !== fresh.fileVersion) invalidateVideoSearchCorpus(fresh.sourceId);
      current.onUpdated(fresh);
    };
    const refresh = async (force = false) => {
      if (stopped || document.visibilityState === "hidden") return;
      if (running) { queued ||= force; return; }
      running = true;
      try {
        const token = await latest.current.getIdToken();
        if (stopped || !sameAsset(latest.current.asset)) return;
        const result = await listSourceMedia(token, { sourceId: asset.sourceId, assetId: asset.id });
        const fresh = result.records.find(item => sameAsset(item));
        if (!stopped && fresh) apply(fresh);
      } catch { /* Existing media stays available; reads independently reject a changed binary. */ }
      finally {
        running = false;
        if (queued && !stopped) { queued = false; void refresh(); }
      }
    };
    const focus = () => { void refresh(); };
    const fileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sourceId?: string; assetId?: string }>).detail;
      if (detail?.sourceId === asset.sourceId && detail.assetId === asset.id) void refresh(true);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener(SOURCE_MEDIA_FILE_CHANGED_EVENT, fileChanged);
    const timer = setInterval(focus, REFRESH_MS);
    return () => {
      stopped = true; pending.current = undefined; clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener(SOURCE_MEDIA_FILE_CHANGED_EVENT, fileChanged);
    };
  }, [asset?.sourceId, asset?.id, getIdToken]);
  useEffect(() => {
    const fresh = pending.current;
    if (blocked || !asset || !fresh || fresh.id !== asset.id || fresh.sourceId !== asset.sourceId) return;
    pending.current = undefined;
    if (fresh.version < asset.version || !changed(asset, fresh)) return;
    if (fresh.fileVersion !== asset.fileVersion) invalidateVideoSearchCorpus(fresh.sourceId);
    latest.current.onUpdated(fresh);
  }, [blocked, asset?.sourceId, asset?.id, asset?.version, asset?.fileVersion]);
}

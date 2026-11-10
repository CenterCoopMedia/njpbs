import { useEffect, useRef, useState, type RefObject } from "react";
import { VIDEO_BLOCK_SOURCE_ID } from "../../../packages/content-core/src/video-block";
import { useOptionalShell } from "../routes/ShellContext";
import { listSourceMedia, type SourceMediaAssetSummary } from "./source-media";

/** Rights and license warn; they never block a pick or a publish (#2751). */
export function videoRightsWarning(asset: Pick<SourceMediaAssetSummary, "rightsStatus" | "license">): string | null {
  if (asset.rightsStatus === "pending") return "Rights are not confirmed for this video. Check before you publish.";
  if (!asset.license?.trim()) return "This video has no license recorded. Check before you publish.";
  return null;
}

export const VIDEO_MISSING_WARNING = "This video is no longer in the media library. Choose another video.";
export const VIDEO_RIGHTS_UNCHECKED_WARNING = "The rights for this video could not be checked. Review them before you publish.";

export interface VideoRightsWarning {
  assetId: string;
  /** The library name, when the asset was found. */
  name: string | null;
  message: string;
}

/**
 * First reads that start within this window share one request. Every video block editor and
 * the publish panel mount together on an open, so one read per video serves all of them. A
 * refresh always starts a new read, so it sees a change made in the library, and first reads
 * that start soon after it share that new read.
 */
const SHARE_READ_MS = 2_000;
const reads = new Map<string, { startedAt: number; result: Promise<VideoRightsWarning | null> }>();
const savedRevisions = new Map<string, number>();
const savedListeners = new Set<(assetId: string) => void>();

/** Publish an authoritative metadata-save receipt to every mounted advisory consumer. */
export function videoRightsSaved(asset: SourceMediaAssetSummary): void {
  const message = videoRightsWarning(asset);
  reads.set(asset.id, { startedAt: Date.now(), result: Promise.resolve(message
    ? { assetId: asset.id, name: asset.name, message } : null) });
  savedRevisions.set(asset.id, (savedRevisions.get(asset.id) ?? 0) + 1);
  for (const listener of savedListeners) listener(asset.id);
}

/** Empties the shared reads. Tests call this so one test's library does not leak into the next. */
export function clearVideoRightsReads(): void {
  reads.clear();
  savedRevisions.clear();
}

function readVideoRights(token: string, assetId: string, refresh: boolean): Promise<VideoRightsWarning | null> {
  const shared = reads.get(assetId);
  if (!refresh && shared && Date.now() - shared.startedAt < SHARE_READ_MS) return shared.result;
  const result = listSourceMedia(token, { sourceId: VIDEO_BLOCK_SOURCE_ID, assetId })
    .then((page): VideoRightsWarning | null => {
      const asset = page.records.find(record => record.id === assetId);
      if (!asset) return { assetId, name: null, message: VIDEO_MISSING_WARNING };
      const message = videoRightsWarning(asset);
      return message ? { assetId, name: asset.name, message } : null;
    })
    .catch(() => ({ assetId, name: null, message: VIDEO_RIGHTS_UNCHECKED_WARNING }));
  reads.set(assetId, { startedAt: Date.now(), result });
  return result;
}

/**
 * Reads the current rights of each video from the library and returns a warning for each
 * one that needs a check (#2759). A pick, a reopen, and the publish panel all see the
 * library's current values, not the values at the time of the pick. A new `refresh` value
 * reads them again for the same videos. Nothing here blocks.
 */
export function useVideoRightsWarnings(assetIds: readonly string[], refresh = 0): VideoRightsWarning[] {
  const getIdToken = useOptionalShell()?.getIdToken;
  const key = [...new Set(assetIds.filter(Boolean))].join("\n");
  const [state, setState] = useState<{ key: string; warnings: VideoRightsWarning[] }>({ key: "", warnings: [] });
  const [saved, setSaved] = useState(0);
  const lastRefresh = useRef<{ key: string; refresh: number; getIdToken: typeof getIdToken } | null>(null);

  useEffect(() => {
    const listener = (assetId: string) => { if (key.split("\n").includes(assetId)) setSaved(value => value + 1); };
    savedListeners.add(listener);
    return () => { savedListeners.delete(listener); };
  }, [key]);

  useEffect(() => {
    if (!key || !getIdToken) return;
    let current = true;
    const ids = key.split("\n");
    const revisions = ids.map(id => savedRevisions.get(id) ?? 0);
    const prior = lastRefresh.current;
    const force = refresh > 0 && (!prior || prior.key !== key || prior.refresh !== refresh || prior.getIdToken !== getIdToken);
    lastRefresh.current = { key, refresh, getIdToken };
    void getIdToken()
      .then(token => Promise.all(ids.map(assetId => readVideoRights(token, assetId, force))))
      .catch((): Array<VideoRightsWarning | null> =>
        ids.map(assetId => ({ assetId, name: null, message: VIDEO_RIGHTS_UNCHECKED_WARNING })))
      .then(results => {
        if (current && ids.every((id, index) => (savedRevisions.get(id) ?? 0) === revisions[index])) {
          setState({ key, warnings: results.filter((result): result is VideoRightsWarning => result !== null) });
        }
      });
    return () => { current = false; };
  }, [key, refresh, getIdToken, saved]);

  // A refresh of the same videos keeps the last result until the new one lands, so the
  // notice does not flicker. A different set of videos never shows the old result.
  return state.key === key ? state.warnings : [];
}

/**
 * Counts each time `ref`'s element is shown again after being hidden, and each time the window
 * regains focus. A collapsed editor panel stays mounted with `hidden`, and staff may fix rights
 * in another tab, so either one is a reason to read rights again.
 */
export function useShownAgainCount(ref: RefObject<Element | null>): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const bump = () => setCount(previous => previous + 1);
    window.addEventListener("focus", bump);
    const element = ref.current;
    let observer: IntersectionObserver | null = null;
    if (element && typeof IntersectionObserver === "function") {
      let shown: boolean | null = null;
      observer = new IntersectionObserver(entries => {
        const visible = entries.some(entry => entry.isIntersecting);
        if (shown === false && visible) bump();
        shown = visible;
      });
      observer.observe(element);
    }
    return () => {
      window.removeEventListener("focus", bump);
      observer?.disconnect();
    };
  }, [ref]);
  return count;
}

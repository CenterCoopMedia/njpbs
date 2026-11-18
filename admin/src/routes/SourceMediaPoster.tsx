import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { cachedPoster, cachePoster, invalidatePoster, mediaListRevision } from "../lib/media-session-cache";
import { canPlayInBrowser, createVersionedSourceMediaRead } from "../lib/source-media-read";
import type { SourceMediaAssetSummary } from "../lib/source-media";

const MAX_POSTER_READS = 4;

function posterObjectIdentity(value: string) {
  try {
    const url = new URL(value);
    const versionId = url.searchParams.get("versionId");
    return versionId ? JSON.stringify([url.origin, url.pathname, versionId]) : undefined;
  } catch {
    return undefined;
  }
}

export function samePosterObject(left: string, right: string) {
  if (left === right) return true;
  const leftIdentity = posterObjectIdentity(left);
  return leftIdentity !== undefined && leftIdentity === posterObjectIdentity(right);
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

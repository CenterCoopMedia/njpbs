import { useEffect, useState, useSyncExternalStore } from "react";
import type { MediaAssetSummary } from "../lib/functions";
import { mediaCacheIdentityRevision, mediaListRevision, subscribeMediaCacheIdentity } from "../lib/media-session-cache";
import type { MediaPickerLoader } from "./MediaPickerDialog";

const MAX_BATCH = 12; // cmsListMedia's assetIds request limit.
const MAX_REQUESTS = 4;
const MAX_RESULTS = 128;
const RESULT_TTL_MS = 60_000;

interface Read {
  promise: Promise<MediaAssetSummary | null>;
  resolve: (asset: MediaAssetSummary | null) => void;
  consumers: number;
  expiresAt: number;
  batch?: { controller: AbortController; reads: Read[] };
}
interface Reads {
  revision: number;
  identity: number;
  entries: Map<string, Read>;
  active: number;
  scheduled: boolean;
}

// Separate loaders can have different media authority, even for the same account.
const loaders = new WeakMap<MediaPickerLoader, Reads>();

function schedule(loadMedia: MediaPickerLoader, reads: Reads) {
  if (reads.scheduled) return;
  reads.scheduled = true;
  queueMicrotask(() => {
    reads.scheduled = false;
    while (reads.active < MAX_REQUESTS) {
      const pending = [...reads.entries].filter(([, read]) => !read.expiresAt && !read.batch);
      if (!pending.length) break;
      const entries = pending.slice(0, MAX_BATCH).sort(([left], [right]) => left.localeCompare(right));
      const batch = { controller: new AbortController(), reads: entries.map(([, read]) => read) };
      for (const [, read] of entries) read.batch = batch;
      reads.active += 1;
      void Promise.resolve().then(() => loadMedia({
        q: "", assetIds: entries.map(([id]) => id), categories: [], kinds: ["image"],
        sort: "updatedAt", direction: "desc", page: 1,
      }, { signal: batch.controller.signal })).then(result => {
        for (const [id, read] of entries) {
          const asset = result.records.find(record => record.id === id) ?? null;
          if (batch.controller.signal.aborted || reads.identity !== mediaCacheIdentityRevision()) {
            read.resolve(null);
            continue;
          }
          // Writes invalidate reuse for a later acquisition, not an already mounted preview.
          if (reads.revision !== mediaListRevision()) reads.entries.delete(id);
          read.expiresAt = Date.now() + RESULT_TTL_MS;
          read.resolve(asset);
        }
        const settled = [...reads.entries].filter(([, read]) => read.expiresAt);
        for (const [id] of settled.slice(0, Math.max(0, settled.length - MAX_RESULTS))) reads.entries.delete(id);
      }).catch(() => {
        for (const [id, read] of entries) {
          if (reads.entries.get(id) === read) reads.entries.delete(id);
          read.resolve(null);
        }
      }).finally(() => { reads.active -= 1; schedule(loadMedia, reads); });
    }
  });
}

function acquire(assetId: string, loadMedia: MediaPickerLoader, revision: number, identity: number) {
  let reads = loaders.get(loadMedia);
  if (!reads || reads.revision !== revision || reads.identity !== identity) {
    reads = { revision, identity, entries: new Map(), active: 0, scheduled: false };
    loaders.set(loadMedia, reads);
  }
  let read = reads.entries.get(assetId);
  if (read?.expiresAt && read.expiresAt <= Date.now()) {
    reads.entries.delete(assetId);
    read = undefined;
  }
  if (!read) {
    let resolve!: Read["resolve"];
    const promise = new Promise<MediaAssetSummary | null>(yes => { resolve = yes; });
    read = { promise, resolve, consumers: 0, expiresAt: 0 };
  }
  reads.entries.delete(assetId);
  reads.entries.set(assetId, read);
  read.consumers += 1;
  schedule(loadMedia, reads);
  const ownedReads = reads;
  const ownedRead = read;
  return {
    promise: read.promise,
    release() {
      ownedRead.consumers -= 1;
      if (ownedRead.consumers || ownedRead.expiresAt) return;
      const batch = ownedRead.batch;
      if (!batch) {
        if (ownedReads.entries.get(assetId) === ownedRead) ownedReads.entries.delete(assetId);
        ownedRead.resolve(null);
      } else if (batch.reads.every(entry => entry.consumers === 0)) {
        batch.controller.abort();
        for (const [id, entry] of ownedReads.entries) {
          if (entry.batch !== batch) continue;
          ownedReads.entries.delete(id);
          entry.resolve(null);
        }
      }
    },
  };
}

const NO_ASSETS: ReadonlyMap<string, MediaAssetSummary> = new Map();

function subscribeIdentity(listener: () => void) {
  // Identity can change during an ancestor's render. Notify React after that render.
  let active = true;
  const unsubscribe = subscribeMediaCacheIdentity(() => queueMicrotask(() => { if (active) listener(); }));
  return () => { active = false; unsubscribe(); };
}

export function useResolvedMediaAssets(assetIds: string[], loadMedia?: MediaPickerLoader): ReadonlyMap<string, MediaAssetSummary> {
  const key = JSON.stringify([...new Set(assetIds.filter(id => id.trim() !== ""))].sort());
  const identity = useSyncExternalStore(subscribeIdentity, mediaCacheIdentityRevision);
  const [resolved, setResolved] = useState<{
    assets: ReadonlyMap<string, MediaAssetSummary>; loader: MediaPickerLoader; identity: number; key: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    setResolved(null);
    if (!loadMedia) return;
    const revision = mediaListRevision();
    const reads = (JSON.parse(key) as string[]).map(id => acquire(id, loadMedia, revision, identity));
    void Promise.all(reads.map(read => read.promise)).then(assets => {
      if (current && identity === mediaCacheIdentityRevision()) setResolved({ assets: new Map(assets.flatMap(asset => asset ? [[asset.id, asset]] : [])), loader: loadMedia, identity, key });
    });
    return () => { current = false; for (const read of reads) read.release(); };
  }, [key, loadMedia, identity]);
  return resolved && resolved.loader === loadMedia && resolved.identity === identity && resolved.key === key
    ? resolved.assets : NO_ASSETS;
}

export function useResolvedMediaAsset(assetId: string, loadMedia?: MediaPickerLoader): MediaAssetSummary | null {
  return useResolvedMediaAssets([assetId], loadMedia).get(assetId) ?? null;
}

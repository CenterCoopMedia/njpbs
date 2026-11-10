import { HttpError, postFunction } from "./functions";
import { videoSearchShardStore, type SearchShard, type ShardStore } from "./video-search-shard-cache";
import type { VideoSearchCoverage } from "./video-search-session-cache";

export type SearchLease = { epoch: string; identity: string; usersView: boolean; checkedAt: number };
type Manifest = { epoch: string; schema: 1; identity: string; usersView: boolean; shards: { id: string; version: string; coverage: VideoSearchCoverage }[];
  tombstones: string[]; initializing: boolean; pending: number; freshnessMs: number };
export const SEARCH_FRESHNESS_MS = 60_000;

async function waitForManifest(seconds: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new DOMException("Search canceled", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, seconds * 1000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function loadVideoSearchShards({ userId, sourceId, getIdToken, signal, onItem, onValidated, onPaused, isUsable, store = videoSearchShardStore }: {
  userId: string; sourceId: string; getIdToken: () => Promise<string>; signal: AbortSignal;
  onItem: (item: SearchShard) => boolean; onValidated?: (lease: SearchLease) => void; onPaused?: (seconds: number) => void; isUsable?: () => boolean; store?: ShardStore;
}): Promise<{ supported: false; warming?: true } | { supported: true; pending: boolean; capped: boolean }> {
  const key = JSON.stringify([userId, sourceId]);
  const current = () => {
    if (signal.aborted || isUsable?.() === false) throw new DOMException("Search validation expired", "AbortError");
  };
  const request = async <T>(body: object) => {
    current();
    const token = await getIdToken(); current();
    const result = await postFunction<T>("cmsGetVideoSearchCorpus", token, { sourceId, ...body }, {}, { appCheck: "unless-automation", signal });
    current(); return result;
  };
  try {
    let manifest: Manifest;
    let checkedAt: number;
    for (let retry = 0; ; retry++) {
      checkedAt = Date.now();
      try { manifest = await request<Manifest>({ action: "manifest" }); break; }
      catch (error) {
        // Admin may precede Functions. Retain the existing bounded legacy scan.
        if (error instanceof HttpError && [400, 413].includes(error.status)) { await store.remove(key); return { supported: false }; }
        if (!(error instanceof HttpError) || error.status !== 429 || retry === 2) throw error;
        const value = error.data.retryAfterSeconds;
        const seconds = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(60, Math.ceil(value)) : 60;
        onPaused?.(seconds);
        await waitForManifest(seconds, signal);
      }
    }
    if (manifest.schema !== 1 || !Array.isArray(manifest.shards) || !Array.isArray(manifest.tombstones) ||
        manifest.shards.length > 5000 || manifest.freshnessMs !== SEARCH_FRESHNESS_MS) throw new Error("Invalid search manifest");
    if (manifest.initializing || (!manifest.shards.length && manifest.pending > 0)) {
      await store.remove(key);
      return { supported: false, warming: true };
    }
    onValidated?.({ epoch: manifest.epoch, identity: manifest.identity, usersView: manifest.usersView, checkedAt });
    const identity = JSON.stringify([manifest.identity, manifest.usersView]);
    const previous = await store.read(key); current();
    const shards: Record<string, SearchShard> = Object.create(null);
    const removed = new Set(manifest.tombstones);
    const sizes = new Map<string, number>();
    const persist = async () => {
      const bounded: Record<string, SearchShard> = Object.create(null);
      let bytes = 0;
      for (const descriptor of manifest.shards) {
        const item = shards[descriptor.id];
        if (!item) continue;
        const size = sizes.get(descriptor.id) ?? JSON.stringify(item).length * 2;
        sizes.set(descriptor.id, size);
        if (bytes + size > 32 * 1024 * 1024) break;
        bounded[descriptor.id] = item; bytes += size;
      }
      await store.write(key, { identity, shards: bounded });
    };
    for (const descriptor of manifest.shards) {
      const saved = previous?.identity === identity && Object.hasOwn(previous.shards, descriptor.id) ? previous.shards[descriptor.id] : undefined;
      if (!removed.has(descriptor.id) && saved?.version === descriptor.version) shards[descriptor.id] = saved;
    }
    // Persist removal before emitting cached text. Missing manifest entries are
    // tombstones too. Unavailable browser storage falls back to the network.
    await persist(); current();
    let capped = false;
    for (let index = 0; index < manifest.shards.length && !capped;) {
      const descriptor = manifest.shards[index];
      if (removed.has(descriptor.id)) { index++; continue; }
      if (!shards[descriptor.id]) {
        const missing = manifest.shards.slice(index).filter(item => !removed.has(item.id) && !shards[item.id]).slice(0, 8);
        const page = await request<{ schema: 1; items: SearchShard[] }>({ action: "shards", shards: missing.map(({ id, version }) => ({ id, version })) });
        if (page.schema !== 1 || !page.items.length || page.items.some(item => !missing.some(wanted => wanted.id === item.id && wanted.version === item.version))) throw new Error("Invalid search shard response");
        for (const item of page.items) shards[item.id] = item;
        await persist(); current();
      }
      const item = shards[descriptor.id];
      if (!item) throw new Error("Search shard is unavailable");
      capped = !onItem(item);
      index++;
    }
    current(); await persist();
    return { supported: true, pending: manifest.pending > 0, capped };
  } catch (error) {
    // Refusal, revision conflict and failed validation never permit stale fallback.
    const refused = error instanceof HttpError && [401, 403, 404].includes(error.status);
    const invalid = error instanceof Error && error.message.startsWith("Invalid search");
    if (refused || invalid) await store.remove(key);
    throw error;
  }
}


export async function checkVideoSearchLease(lease: SearchLease, sourceId: string, getIdToken: () => Promise<string>, signal: AbortSignal) {
  const checkedAt = Date.now();
  const token = await getIdToken();
  const result = await postFunction<{ schema: 1; unchanged: boolean; identityChanged?: boolean; identity?: string; usersView?: boolean; freshnessMs: number }>("cmsGetVideoSearchCorpus", token,
    { sourceId, action: "check", epoch: lease.epoch, identity: lease.identity, usersView: lease.usersView }, {}, { appCheck: "unless-automation", signal });
  if (result.schema !== 1 || result.freshnessMs !== SEARCH_FRESHNESS_MS) throw new Error("Invalid search lease");
  return { unchanged: result.unchanged === true, checkedAt, identityChanged: result.identityChanged === true ||
    (typeof result.identity === "string" && (result.identity !== lease.identity || result.usersView !== lease.usersView)) };
}

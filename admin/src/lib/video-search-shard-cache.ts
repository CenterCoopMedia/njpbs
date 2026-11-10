import type { SourceMediaAssetSummary } from "./source-media";
import type { VideoSearchChunk, VideoSearchCoverage } from "./video-search-session-cache";

export type SearchShard = { id: string; version: string; asset: SourceMediaAssetSummary; chunks: VideoSearchChunk[];
  revision: { reviewed: boolean; languageCode: string } | null; coverage: VideoSearchCoverage };
export type ShardCache = { identity: string; shards: Record<string, SearchShard> };
export type ShardStore = { read(key: string): Promise<ShardCache | undefined>; write(key: string, value: ShardCache): Promise<void>; remove(key: string): Promise<void> };

// Store private search bytes, never credentials or signed URLs. Account keys stay
// separate. A fresh authenticated manifest is required before using stored text.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("boardwalk-video-search-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("corpora");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Search storage is unavailable"));
  });
}

async function stored<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db!.transaction("corpora", mode);
      const request = action(transaction.objectStore("corpora"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch { return undefined; } finally { db?.close(); }
}

export const videoSearchShardStore: ShardStore = {
  read: key => stored("readonly", store => store.get(key)),
  write: async (key, value) => { await stored("readwrite", store => store.put(value, key)); },
  remove: async key => { await stored("readwrite", store => store.delete(key)); },
};

export function forgetVideoSearchShards(userId: string) {
  return videoSearchShardStore.remove(JSON.stringify([userId, "video-library"]));
}

/** Drop a missing result without discarding the other authorized shard bytes. */
export async function forgetVideoSearchShard(userId: string, sourceId: string, assetId: string) {
  const key = JSON.stringify([userId, sourceId]);
  const cached = await videoSearchShardStore.read(key);
  if (!cached || !Object.hasOwn(cached.shards, assetId)) return;
  const shards = Object.assign(Object.create(null), cached.shards);
  delete shards[assetId];
  await videoSearchShardStore.write(key, { ...cached, shards });
}

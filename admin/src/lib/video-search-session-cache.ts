import type { SourceMediaAssetSummary } from "./source-media";

export type VideoSearchChunk = { id: string; assetId: string; transcriptId: string; editRevision: number; segmentIndex: number; startSeconds: number; endSeconds: number; text: string };
export type VideoSearchCoverage = { assetsScanned: number; assetsIndexed: number; assetsWithoutTranscript: number; assetsUnavailable: number; truncatedAssets: number };
export type VideoSearchEntry = { id: string; text: string; asset: SourceMediaAssetSummary; chunk?: VideoSearchChunk; reviewed?: boolean; languageCode?: string };
export type VideoSearchSnapshot = { entries: VideoSearchEntry[]; coverage: VideoSearchCoverage; status: string; nextCursor?: string; complete: boolean };

let revision = 0;
let cached: { userId: string; sourceId: string; snapshot: VideoSearchSnapshot } | undefined;

export function videoSearchCacheRevision() { return revision; }

export function cachedVideoSearchCorpus(userId: string, sourceId: string) {
  return cached?.userId === userId && cached.sourceId === sourceId ? cached.snapshot : undefined;
}

export function cacheVideoSearchCorpus(userId: string, sourceId: string, snapshot: VideoSearchSnapshot, requestRevision: number) {
  if (requestRevision === revision) cached = { userId, sourceId, snapshot };
}

function assetSearchText(asset: SourceMediaAssetSummary) {
  return [asset.name, asset.description, ...asset.tags].filter(Boolean).join(" ");
}

/** Apply one confirmed metadata save without rereading unchanged private transcripts. */
export function updateCachedVideoSearchAsset(
  userId: string,
  asset: SourceMediaAssetSummary,
  requestRevision: number,
) {
  if (asset.sourceId !== "video-library") return false;
  if (requestRevision !== revision) {
    // A newer scan for the same account can still contain metadata from before this save.
    if (cached?.userId === userId && cached.sourceId === asset.sourceId) {
      revision += 1;
      cached = undefined;
    }
    return false;
  }
  if (cached && cached.userId !== userId) return false;
  revision += 1;
  if (!cached || cached.sourceId !== asset.sourceId) {
    cached = undefined;
    return false;
  }
  const found = cached.snapshot.entries.some(entry => entry.asset.id === asset.id);
  if (!found) {
    // A partial scan can have passed this asset without retaining it. Start over instead of
    // resuming after a cursor that could omit the changed metadata.
    cached = undefined;
    return false;
  }
  const entries = cached.snapshot.entries.map(entry => entry.asset.id !== asset.id ? entry : {
    ...entry,
    asset,
    ...(entry.id === `asset/${asset.id}` ? { text: assetSearchText(asset) } : {}),
  });
  cached = { ...cached, snapshot: { ...cached.snapshot, entries } };
  return true;
}

export function invalidateVideoSearchCorpus(sourceId?: string) {
  if (sourceId && sourceId !== "video-library") return;
  revision += 1;
  cached = undefined;
}

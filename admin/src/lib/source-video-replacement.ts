import { postFunction } from "./functions";
import type { SourceMediaAssetSummary } from "./source-media";

export interface VideoReplacementStatus {
  asset: SourceMediaAssetSummary;
  state: string;
  errorCode: string | null;
  lastAction: "replace" | "rollback" | null;
  migrationPending: boolean;
  transcriptPending: boolean;
  previous: { id: string; originalName: string; expiresAt: string } | null;
  previousDeleted: boolean;
  previousCleanupPending?: boolean;
  history: { action: string; at: string; by: string; originalName: string }[];
}
export function getVideoReplacement(token: string, assetId: string) {
  return postFunction<VideoReplacementStatus>("cmsGetSourceVideoReplacement", token, { sourceId: "video-library", assetId }, {}, { appCheck: true });
}
export function rollbackVideoReplacement(token: string, assetId: string, expectedVersion: number) {
  return postFunction<{ asset: SourceMediaAssetSummary }>("cmsRollbackSourceVideoReplacement", token,
    { sourceId: "video-library", assetId, expectedVersion, confirmed: true }, {}, { appCheck: true });
}

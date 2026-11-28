import type { OriginalAvailability } from "./video-original";
import type { MediaMetadataBounds } from "./media-browse-metadata";
import { postFunction } from "./functions";
import type { MediaTabCounts } from "./media-session-cache";
import { invalidateVideoSearchCorpus, videoSearchCacheRevision } from "./video-search-session-cache";

export function uploadableSharedVideoSource<T extends { id: string; canUpload: boolean }>(
  sources: readonly T[],
): T | null {
  return sources.find((source) => source.id === "video-library" && source.canUpload) ?? null;
}

export interface MediaSourceSummary {
  id: string;
  label: string;
  description: string;
  mediaKind: "video";
  canBrowse: true;
  canUpload: boolean;
  canEditMetadata: boolean;
  canRequestProduction: boolean;
  canDelete?: boolean;
  canReplace?: boolean;
}

export interface SourceMediaMarker {
  startMs: number;
  endMs: number;
  name: string;
  comment: string;
  type: "Comment" | "Chapter" | "Segmentation" | "WebLink";
  color: number;
}

export interface SourceMediaParent {
  sourceId: "video-library";
  assetId: string;
  inMs?: number;
  outMs?: number;
  fileVersion?: string;
}

export type MediaApprovalRendition = "original" | "viewingCopy";
export type MediaApprovalVersions = Record<MediaApprovalRendition, string | null>;

export interface SourceMediaAssetSummary {
  metadataUpdateRequested?: boolean;
  id: string;
  sourceId: string;
  name: string;
  description: string | null;
  steward?: string | null;
  originalName: string;
  mimeType: string;
  kind: "video";
  sizeBytes: number;
  preview: "browser" | "download_only";
  original?: OriginalAvailability;
  viewingCopy?: {
    state: "not_prepared" | "processing" | "ready" | "failed";
    sizeBytes?: number;
    width?: number;
    height?: number;
    durationSeconds?: number;
    sourceFrameRateNumerator?: number;
    sourceFrameRateDenominator?: number;
    /** The web copy's measured rate. */
    frameRateNumerator?: number;
    frameRateDenominator?: number;
    errorCode?: string;
  };
  replacement?: { state: "uploading" | "processing" | "ready" | "promoting" | "complete" | "failed";
    requestedAt: string | null; requestedBy: string | null; errorCode?: string };
  license: string | null;
  credit: string | null;
  tags: string[];
  markers?: SourceMediaMarker[];
  parentSource?: SourceMediaParent | null;
  rightsStatus: "complete" | "pending";
  version: number;
  /** Opaque name of the stored file; it changes when the file is replaced. */
  fileVersion?: string | null;
  approvalVersions?: MediaApprovalVersions;
  uploadedBy?: { uid?: string; name: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SourceMediaPage {
  success: true;
  records: SourceMediaAssetSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
  /** Size index is unavailable; records and cursor use the first update-order page. */
  sortFallback?: "updated_desc";
  /** Signed posters for ready videos on this page, present when the query asked for them. */
  posters?: { assetId: string; url: string; expiresAt: string }[];
}

export type SourceMediaProcessingStatus = Pick<SourceMediaAssetSummary, "id" | "viewingCopy" | "fileVersion">;
export interface SourceMediaStatusPage {
  success: true;
  records: SourceMediaProcessingStatus[];
}

export interface SourceMediaRead {
  assetId: string;
  /** Identity of the binary actually signed; omitted by older Functions. */
  fileVersion?: string | null;
  /** Saved credit at authorization time; older Functions omit it. */
  credit?: string | null;
  action: "preview" | "download" | "poster" | "download_web";
  url: string;
  expiresAt: string;
  mimeType: string;
  disposition: "inline" | "attachment";
  supportsRange: true;
}

export async function listMediaSources(token: string | null, options: { counts?: boolean } = {}) {
  const result = await postFunction<{ success: true; sources: MediaSourceSummary[]; counts?: MediaTabCounts }>(
    "cmsListMediaSources", token, options.counts ? { counts: true } : {},
  );
  // Admin and Functions deploy separately. Keep the station tab copy current for every
  // consumer, including routed uploads, with an older source API.
  return { ...result, sources: result.sources.map(source => source.id === "video-library"
    ? { ...source, label: "Videos", description: "Browse station videos for production, preview, and download." }
    : source) };
}

export interface SourceMediaQuery extends MediaMetadataBounds {
  sourceId: string;
  assetId?: string;
  cursor?: string;
  limit?: number;
  q?: string;
  tag?: string;
  createdBy?: string;
  rightsStatus?: "pending" | "complete";
  metadataUpdateRequested?: true;
  sort?: "updated_desc" | "updated_asc" | "name_asc" | "size_desc" | "size_asc";
  posters?: true;
}

export async function deleteSourceMedia(token: string | null, sourceId: string, assetId: string, expectedVersion: number) {
  const result = await postFunction<{ success: true; deleted: true }>("cmsDeleteSourceMedia", token,
    { sourceId, assetId, expectedVersion }, {}, { appCheck: true });
  invalidateVideoSearchCorpus(sourceId);
  return result;
}

export interface BinnedVideo {
  id: string;
  name: string;
  version: number;
  deletedAt: string;
}

export interface BinnedVideoPage {
  records: BinnedVideo[];
  nextCursor: string | null;
}

export interface BinnedVideoUsagePage {
  items: {
    collection: "cmsPosts" | "cmsPages";
    documentId: string;
    title: string;
    working: boolean;
    published: boolean;
  }[];
  nextCursor: string | null;
  incomplete: boolean;
}

export function listBinnedVideos(token: string, sourceId: string, cursor: string | undefined, signal: AbortSignal) {
  return postFunction<BinnedVideoPage>("cmsSourceVideoBin", token, { action: "list", sourceId, cursor }, {}, { signal });
}

export function listBinnedVideoUsage(token: string, sourceId: string, assetId: string, cursor: string | undefined, signal: AbortSignal) {
  return postFunction<BinnedVideoUsagePage>("cmsSourceVideoBin", token, { action: "usage", sourceId, assetId, cursor }, {}, { signal });
}

export function restoreBinnedVideo(token: string, sourceId: string, { id: assetId, version: expectedVersion }: BinnedVideo) {
  return postFunction<{ originalState?: "archived" | "restoring"; viewingCopyUnavailable?: boolean }>(
    "cmsSourceVideoBin", token, { action: "restore", sourceId, assetId, expectedVersion }, {}, { appCheck: true });
}

export function listSourceMedia(
  token: string | null,
  query: { sourceId: string; pendingIds: string[] },
): Promise<SourceMediaStatusPage>;
export function listSourceMedia(
  token: string | null,
  query: SourceMediaQuery,
): Promise<SourceMediaPage>;
export function listSourceMedia(
  token: string | null,
  query: SourceMediaQuery | { sourceId: string; pendingIds: string[] },
) {
  return postFunction<SourceMediaPage | SourceMediaStatusPage>("cmsListSourceMedia", token, query);
}

export interface MediaSearchRecord {
  id: string;
  sourceId: string;
  kind: "video";
  name: string;
}

export interface MediaSearchPage {
  success: true;
  records: MediaSearchRecord[];
  sources: { id: string; label: string; fields: string[]; status: "searched" | "unavailable"; error?: string }[];
  nextCursor: string | null;
}

/** Word search across every video source the person may see. It answers 403 when they see none. */
export function searchMedia(
  token: string | null,
  query: { q: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
) {
  return postFunction<MediaSearchPage>("cmsSearchMedia", token, query, {}, { signal });
}

export async function createSourceMediaRead(
  token: string | null,
  sourceId: string,
  assetId: string,
  action: "preview" | "download" | "poster" | "download_web",
) {
  const response = await postFunction<{ success: true; access: SourceMediaRead }>(
    "cmsCreateSourceMediaRead", token, { sourceId, assetId, action },
  );
  return response.access;
}

export interface PublishedSourceVideo {
  url: string;
  posterUrl: string;
  width: number;
  height: number;
  mimeType: string;
}

/** Copies a video-library item's viewing copy and poster to the public media store (#2751). */
export async function publishSourceVideo(
  token: string | null,
  assetId: string,
  content: { collection: "cmsPages" | "cmsPosts"; id: string },
) {
  const response = await postFunction<{ success: true; media: PublishedSourceVideo }>(
    "cmsPublishSourceVideo", token, { sourceId: "video-library", assetId, ...content }, {}, { operation: "publish" },
  );
  return response.media;
}

export async function updateSourceMediaMetadata(
  token: string | null,
  sourceId: string,
  assetId: string,
  expectedVersion: number,
  changes: { name?: string; description?: string; steward?: string | null; credit?: string; license?: string; tags?: string[]; rightsStatus?: "complete" | "pending"; markers?: SourceMediaMarker[] },
  options: { preserveVideoSearchCache?: boolean } = {},
): Promise<{ success: true; asset: SourceMediaAssetSummary; videoSearchRevision?: number }> {
  const videoSearchRevision = videoSearchCacheRevision();
  const result = await postFunction<{ success: true; asset: SourceMediaAssetSummary }>("cmsUpdateSourceMediaMetadata", token,
    { sourceId, assetId, expectedVersion, changes }, {}, { appCheck: true });
  if (!options.preserveVideoSearchCache) {
    invalidateVideoSearchCorpus(sourceId);
    return result;
  }
  return { ...result, videoSearchRevision };
}

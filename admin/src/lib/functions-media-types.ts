import type { MediaTabCounts } from "./media-session-cache";
import type { MediaApprovalVersions } from "./source-media";

/** The kinds the Images tab lists and filters. */
export type MediaKind = "image" | "document" | "audio";
/** Every stored media library kind. Audio appears only on the Audio tab. */
export type MediaAssetKind = MediaKind | "audio";
export type MediaSortField = "updatedAt" | "createdAt" | "name" | "sizeBytes";
export type MediaSortDirection = "asc" | "desc";

export interface MediaCategoryDefinition {
  id: string;
  label: string;
  description: string;
  order: number;
  active: boolean;
  reserved: boolean;
  version: number;
  etag: string;
  canUpload: boolean;
  canManage: boolean;
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ListMediaCategoriesResponse {
  success: true;
  categories: MediaCategoryDefinition[];
}

export interface MediaAssetSummary {
  id: string;
  name: string;
  originalName: string;
  category: string;
  categories: string[];
  tags: string[];
  description: string | null;
  altText: string | null;
  /** True when the nightly sweep wrote the alt text and no person has changed it. */
  altTextGenerated?: boolean;
  metadataUpdateRequested?: boolean;
  license: string | null;
  credit: string | null;
  mimeType: string;
  kind: MediaAssetKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbnails?: { url: string; width: number; height: number }[];
  /** True when the stored file has more than one frame. Absent means unclassified. */
  animated?: boolean;
  /** A retained private original is recorded; availability is rechecked on download. */
  originalAvailable?: boolean;
  /** The retained original's file format, shown in the Download menu. */
  originalFormat?: "JPG" | "PNG";
  approvalVersions?: MediaApprovalVersions;
  source?: "upload" | "site_seed" | "voiceover" | null;
  voiceoverTakeId?: string;
  voiceover?: import("./voiceovers").VoiceoverTake & { manifestVersion: number; performer_name: string };
  lifecycle: "active";
  version: number;
  etag: string;
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ListMediaRequest {
  q?: string;
  assetIds?: string[];
  categories?: string[];
  kinds?: MediaAssetKind[];
  sort?: MediaSortField;
  direction?: MediaSortDirection;
  page?: number;
  /** Omit to keep the 30-row library page. The maximum is the active-library scan cap. */
  pageSize?: number;
  /** Opaque indexed-library continuation. Exact-id and self-profile reads stay on legacy paging. */
  paging?: "cursor";
  cursor?: string;
}

export interface BinnedMediaAsset extends Omit<MediaAssetSummary, "lifecycle"> {
  lifecycle: "tombstoned" | "purging";
  purgeAfter: string | null;
  tombstonedAt: string | null;
  tombstonedByName: string | null;
}

export type MediaUsageState = "working" | "published" | "deployed";

export interface MediaUsageItem {
  collection: "cmsPages" | "cmsPosts" | "cmsSettings" | "cmsPostTemplates" | "cmsAuthorProfiles" | "cmsAuthorProfilesPublic";
  documentId: string;
  title: string;
}

export interface MediaUsagePage {
  items: MediaUsageItem[];
  page: number;
  pageCount: number;
}

export interface ListBinnedMediaResponse {
  success: true;
  canDeletePermanently?: boolean;
  records: BinnedMediaAsset[];
  total: number;
  page: number;
  pageCount: number;
}

/** The Images tab's query. Its Type filter offers only the Images tab's kinds. */
export type MediaListQuery = Required<
  Omit<ListMediaRequest, "assetIds" | "pageSize" | "paging" | "cursor" | "kinds">
> & { kinds: MediaKind[] } & Pick<ListMediaRequest, "assetIds" | "pageSize" | "paging" | "cursor">;

export interface SelfProfilePhotoListMediaRequest extends ListMediaRequest {
  /** Narrow self-service view: only this caller's staff profile images. */
  profilePhotoScope: "self";
}

interface ListMediaResponseBase {
  success: true;
  records: MediaAssetSummary[];
  page: number;
  /** Present only when the request asked with `counts: true`; never cached with the list. */
  counts?: MediaTabCounts;
  /** Favorite states for `records`, only when asked with `favorites: true`; never cached with the list. */
  favoriteStates?: { ref: { backend: "r2"; id: string }; favorite: boolean }[];
}

export type ListMediaResponse = ListMediaResponseBase & (
  | {
      paging?: undefined;
      total: number;
      allCount: number;
      pageCount: number;
      categoryCounts: Record<string, number>;
      kindCounts: Partial<Record<MediaKind, number>>;
      nextCursor?: undefined;
    }
  | {
      paging: "cursor";
      nextCursor: string | null;
      /** Exact only after the indexed scan reaches its terminal page. */
      total: number | null;
      /** Exact only for a terminal, unfiltered indexed scan. */
      allCount: number | null;
      pageCount: null;
      categoryCounts: null;
      kindCounts: null;
    }
);

export interface MediaCorpusRequest {
  cursor?: string;
  limit?: number;
}

export interface MediaCorpusResponse {
  success: true;
  records: MediaAssetSummary[];
  nextCursor: string | null;
}

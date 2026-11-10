import { postFunction, type MediaAssetSummary } from "./functions";
import type { MediaAssetRef } from "./media-identity";
import type { SourceMediaAssetSummary } from "./source-media";

export const MEDIA_COLLECTION_COLORS = ["slate", "blue", "green", "gold", "red", "purple"] as const;
export type MediaCollectionColor = (typeof MEDIA_COLLECTION_COLORS)[number];
export type MediaCollectionScope = "private" | "all_staff";
export type MediaCollectionLifecycle = "active" | "archived";
export type MediaCollectionAsset = MediaAssetSummary | SourceMediaAssetSummary;

export function mediaCollectionRefKey(ref: MediaAssetRef): string {
  return ref.backend === "r2"
    ? JSON.stringify(["r2", ref.id])
    : JSON.stringify(["s3", ref.sourceId, ref.id]);
}

/** An older or incomplete response cannot prove which requested refs changed. */
export function confirmedCollectionChangedRefs(
  result: { changed: boolean; replayed: boolean; changedRefs?: MediaAssetRef[] },
  requested: readonly MediaAssetRef[],
): MediaAssetRef[] | null {
  if (!result.changed || result.replayed || !Array.isArray(result.changedRefs) || result.changedRefs.length === 0) return null;
  const requestedKeys = new Set(requested.map(mediaCollectionRefKey));
  const seen = new Set<string>();
  const refs: MediaAssetRef[] = [];
  for (const candidate of result.changedRefs) {
    const ref = candidate?.backend === "r2" && typeof candidate.id === "string" && candidate.id
      ? { backend: "r2" as const, id: candidate.id }
      : candidate?.backend === "s3" && typeof candidate.sourceId === "string" && candidate.sourceId
        && typeof candidate.id === "string" && candidate.id
        ? { backend: "s3" as const, sourceId: candidate.sourceId, id: candidate.id }
        : null;
    if (!ref) return null;
    const key = mediaCollectionRefKey(ref);
    if (!requestedKeys.has(key) || seen.has(key)) return null;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

export interface MediaCollectionSummary {
  id: string;
  scope: MediaCollectionScope;
  name: string;
  description: string;
  color?: MediaCollectionColor;
  lifecycle: MediaCollectionLifecycle;
  version: number;
  membershipVersion: number;
  cover: MediaCollectionAsset | null;
  canEdit: true;
  createdAt: string | null;
  updatedAt: string | null;
  itemCount?: number;
}

export type MediaCollectionItem =
  | {
      ref: MediaAssetRef;
      addedAt: string;
      available: true;
      asset: MediaCollectionAsset;
    }
  | {
      ref: MediaAssetRef;
      addedAt: string;
      available: false;
    };

export interface MediaCollectionPage {
  success: true;
  collections: MediaCollectionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MediaCollectionItemPage {
  success: true;
  collection: MediaCollectionSummary;
  items: MediaCollectionItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type MediaCollectionMutation =
  | {
      action: "create";
      requestId: string;
      scope: MediaCollectionScope;
      name: string;
      description?: string;
      color?: MediaCollectionColor;
    }
  | {
      action: "update";
      requestId: string;
      collectionId: string;
      baseVersion: number;
      name?: string;
      description?: string;
      color?: MediaCollectionColor;
      coverRef?: MediaAssetRef | null;
    }
  | {
      action: "archive" | "restore";
      requestId: string;
      collectionId: string;
      baseVersion: number;
    };

export function listMediaCollections(
  token: string | null,
  query: {
    scope: MediaCollectionScope;
    lifecycle: MediaCollectionLifecycle;
    cursor?: string;
    limit?: number;
  },
) {
  return postFunction<MediaCollectionPage>("cmsListMediaCollections", token, query);
}

export function listMediaCollectionItems(
  token: string | null,
  query: { collectionId: string; cursor?: string; limit?: number },
) {
  return postFunction<MediaCollectionItemPage>(
    "cmsListMediaCollectionItems",
    token,
    query,
  );
}

export function mutateMediaCollection(
  token: string | null,
  request: MediaCollectionMutation,
) {
  return postFunction<{
    success: true;
    changed: boolean;
    replayed: boolean;
    collection: MediaCollectionSummary;
  }>("cmsMutateMediaCollection", token, request, {}, { appCheck: true });
}

export function setMediaCollectionItems(
  token: string | null,
  request: {
    collectionId: string;
    requestId: string;
    baseMembershipVersion: number;
    present: boolean;
    refs: MediaAssetRef[];
  },
) {
  return postFunction<{
    success: true;
    collectionId: string;
    changed: boolean;
    replayed: boolean;
    version: number;
    membershipVersion: number;
    changedRefs?: MediaAssetRef[];
    hiddenChangedCount?: number;
  }>("cmsSetMediaCollectionItems", token, request, {}, { appCheck: true });
}

import { postFunction, type MediaAssetSummary } from "./functions";
import type { MediaAssetRef } from "./media-identity";
import type { SourceMediaAssetSummary } from "./source-media";

export const MEDIA_COLLECTION_COLORS = ["slate", "blue", "green", "gold", "red", "purple"] as const;
export type MediaCollectionColor = (typeof MEDIA_COLLECTION_COLORS)[number];
export type MediaCollectionScope = "private" | "all_staff";
export type MediaCollectionLifecycle = "active" | "archived";
export type MediaCollectionAsset = MediaAssetSummary | SourceMediaAssetSummary;
export type MediaCollectionSubclipRef = { backend: "subclip"; id: string };
export type MediaCollectionItemRef = MediaAssetRef | MediaCollectionSubclipRef;

export function mediaCollectionRefKey(ref: MediaCollectionItemRef): string {
  return ref.backend === "s3"
    ? JSON.stringify([ref.backend, ref.sourceId, ref.id])
    : JSON.stringify([ref.backend, ref.id]);
}

/** An older or incomplete response cannot prove which requested refs changed. */
export function confirmedCollectionChangedRefs<Ref extends MediaCollectionItemRef>(
  result: { changed: boolean; replayed: boolean; changedRefs?: MediaCollectionItemRef[] },
  requested: readonly Ref[],
): Ref[] | null {
  if (!result.changed || result.replayed || !Array.isArray(result.changedRefs) || result.changedRefs.length === 0) return null;
  const requestedRefs = new Map(requested.map(ref => [mediaCollectionRefKey(ref), ref]));
  const seen = new Set<string>();
  const refs: Ref[] = [];
  for (const candidate of result.changedRefs) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id ||
      !["r2", "s3", "subclip"].includes(candidate.backend) ||
      (candidate.backend === "s3" && (typeof candidate.sourceId !== "string" || !candidate.sourceId))) return null;
    const key = mediaCollectionRefKey(candidate);
    const ref = requestedRefs.get(key);
    if (!ref || seen.has(key)) return null;
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

type SavedRange = {
  name: string;
  fileVersion: string;
  inMs: number;
  outMs: number;
  state: "current" | "replaced" | "unavailable";
};

export type MediaCollectionSubclip = {
  ref: MediaCollectionSubclipRef;
  addedAt: string;
} & ({ available: true; subclip: SavedRange } | { available: false });

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
  subclips?: MediaCollectionSubclip[];
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

export function openMediaCollectionSubclip(
  token: string | null,
  collectionId: string,
  subclipId: string,
  signal: AbortSignal,
) {
  return postFunction<{ success: true; subclip: SavedRange; asset: SourceMediaAssetSummary; canRequestProduction: boolean }>(
    "cmsListMediaCollectionItems", token, { collectionId, subclipId }, {}, { signal },
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
    refs: MediaCollectionItemRef[];
    subclipAssetId?: string;
  },
) {
  return postFunction<{
    success: true;
    collectionId: string;
    changed: boolean;
    replayed: boolean;
    version: number;
    membershipVersion: number;
    changedRefs?: MediaCollectionItemRef[];
    hiddenChangedCount?: number;
  }>("cmsSetMediaCollectionItems", token, request, {}, { appCheck: true });
}

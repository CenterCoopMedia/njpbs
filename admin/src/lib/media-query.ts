import type {
  MediaListQuery,
  MediaKind,
  MediaSortDirection,
  MediaSortField,
} from "./functions";
import type { MediaCollectionLifecycle, MediaCollectionScope } from "./media-collections";
import type { MediaAssetRef } from "./media-identity";
import type { SourceMediaQuery } from "./source-media";

export interface MediaLocationState {
  query: MediaListQuery;
  selectedId: string | null;
  /** A saved view id. It stays outside the list query, so list arguments and cache keys do not change. */
  view?: string;
}

export const DEFAULT_MEDIA_QUERY: MediaListQuery = Object.freeze({
  q: "",
  categories: [],
  kinds: [],
  sort: "updatedAt",
  direction: "desc",
  page: 1,
});

const KINDS = new Set<MediaKind>(["image", "document", "audio"]);
const SORT_FIELDS = new Set<MediaSortField>([
  "updatedAt",
  "createdAt",
  "name",
  "sizeBytes",
]);
const DIRECTIONS = new Set<MediaSortDirection>(["asc", "desc"]);
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const VIDEO_SORTS = new Set<NonNullable<SourceMediaQuery["sort"]>>([
  "updated_desc",
  "updated_asc",
  "name_asc",
  "size_desc",
  "size_asc",
]);
const VIDEO_LIMITS = new Set<VideoPageSize>([24, 48, 96]);
const FAVORITE_KINDS = new Set<FavoriteMediaKind>(["image", "document", "audio", "video"]);
const COLLECTION_SCOPES = new Set<MediaCollectionScope>(["private", "all_staff"]);

function uniqueBounded(values: string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

export function parseMediaLocation(search: string): MediaLocationState {
  const params = new URLSearchParams(search);
  const q = (params.get("q") ?? "").slice(0, 200).trim();
  const categories = uniqueBounded(
    params
      .getAll("category")
      .filter((value) => value.length <= 60 && CATEGORY_PATTERN.test(value)),
    20,
  );
  const kinds = uniqueBounded(params.getAll("kind"), 3).filter(
    (value): value is MediaKind => KINDS.has(value as MediaKind),
  );
  const sortCandidate = params.get("sort") as MediaSortField | null;
  const directionCandidate = params.get("direction") as MediaSortDirection | null;
  const pageCandidate = Number(params.get("page") ?? "1");
  const selectedCandidate = params.get("selected");
  const viewCandidate = params.get("view");

  return {
    query: {
      q,
      categories,
      kinds,
      sort:
        sortCandidate && SORT_FIELDS.has(sortCandidate)
          ? sortCandidate
          : DEFAULT_MEDIA_QUERY.sort,
      direction:
        directionCandidate && DIRECTIONS.has(directionCandidate)
          ? directionCandidate
          : DEFAULT_MEDIA_QUERY.direction,
      page:
        Number.isSafeInteger(pageCandidate) && pageCandidate > 0
          ? pageCandidate
          : DEFAULT_MEDIA_QUERY.page,
    },
    selectedId:
      selectedCandidate && isBoundedId(selectedCandidate)
        ? selectedCandidate
        : null,
    ...(viewCandidate && isBoundedId(viewCandidate) ? { view: viewCandidate } : {}),
  };
}

function isBoundedId(value: string): boolean {
  return value.length <= 128 && ASSET_ID_PATTERN.test(value);
}

export function encodeMediaLocation(
  query: MediaListQuery,
  selectedId: string | null,
  view?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const category of query.categories) params.append("category", category);
  for (const kind of query.kinds) params.append("kind", kind);
  if (query.sort !== DEFAULT_MEDIA_QUERY.sort) params.set("sort", query.sort);
  if (query.direction !== DEFAULT_MEDIA_QUERY.direction) {
    params.set("direction", query.direction);
  }
  if (query.page !== 1) params.set("page", String(query.page));
  if (selectedId) params.set("selected", selectedId);
  if (view) params.set("view", view);
  return params;
}

export type VideoPageSize = 24 | 48 | 96;
export type VideoMediaSort = NonNullable<SourceMediaQuery["sort"]>;
export type VideoRightsFilter = "pending" | "complete";

export interface VideoMediaLocationQuery {
  q: string;
  tag?: string;
  by?: string;
  rights?: VideoRightsFilter;
  sort: VideoMediaSort;
  limit: VideoPageSize;
  /** Cursor paging stays in route memory and is intentionally never encoded. */
  cursor?: string;
}

export interface VideoMediaLocationState {
  query: VideoMediaLocationQuery;
  selectedId: string | null;
  view?: string;
}

export const DEFAULT_VIDEO_MEDIA_QUERY: VideoMediaLocationQuery = Object.freeze({
  q: "",
  sort: "updated_desc",
  limit: 24,
});

export type FavoriteMediaKind = MediaKind | "video";

export interface FavoritesMediaLocationState {
  kind: FavoriteMediaKind | null;
  selectedRef: MediaAssetRef | null;
  view?: string;
}

export const DEFAULT_FAVORITES_MEDIA_LOCATION: FavoritesMediaLocationState = Object.freeze({
  kind: null,
  selectedRef: null,
});

export interface CollectionsMediaLocationState {
  show: MediaCollectionLifecycle;
  scope: MediaCollectionScope | null;
  selectedRef: MediaAssetRef | null;
  view?: string;
}

export const DEFAULT_COLLECTIONS_MEDIA_LOCATION: CollectionsMediaLocationState = Object.freeze({
  show: "active",
  scope: null,
  selectedRef: null,
});

function oneParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function boundedFilter(value: string | null, maxLength: number): string | null {
  if (value === null || value.length > maxLength || [...value].some((character) => character.charCodeAt(0) < 32)) {
    return null;
  }
  return value.trim() || null;
}

function boundedAssetId(value: string | null): string | null {
  return value && isBoundedId(value) ? value : null;
}

function viewParam(params: URLSearchParams): { view?: string } {
  const view = boundedAssetId(oneParam(params, "view"));
  return view ? { view } : {};
}

/** Parse video URL state without accepting the opaque, query-bound server cursor. */
export function parseVideoMediaLocation(search: string): VideoMediaLocationState {
  const params = new URLSearchParams(search);
  let q = (oneParam(params, "q") ?? "").normalize("NFKC").trim().slice(0, 160);
  // The server lowercases before checking length; some characters expand there.
  while (q.toLocaleLowerCase("en-US").length > 160) q = q.slice(0, -1);
  const tag = boundedFilter(oneParam(params, "tag"), 80);
  const by = boundedFilter(oneParam(params, "by"), 128);
  const rightsCandidate = oneParam(params, "rights");
  const rights = rightsCandidate === "pending" || rightsCandidate === "complete" ? rightsCandidate : null;
  const structured = [tag ? ["tag", tag] : null, by ? ["by", by] : null, rights ? ["rights", rights] : null]
    .filter((entry): entry is ["tag" | "by" | "rights", string] => entry !== null);
  const sortCandidate = oneParam(params, "sort") as VideoMediaSort | null;
  const limitCandidate = Number(oneParam(params, "limit"));
  const query: VideoMediaLocationQuery = {
    q,
    sort: sortCandidate && VIDEO_SORTS.has(sortCandidate) ? sortCandidate : DEFAULT_VIDEO_MEDIA_QUERY.sort,
    limit: VIDEO_LIMITS.has(limitCandidate as VideoPageSize) ? limitCandidate as VideoPageSize : DEFAULT_VIDEO_MEDIA_QUERY.limit,
  };
  if (structured.length === 1) {
    const [field, value] = structured[0];
    if (field === "rights") query.rights = value as VideoRightsFilter;
    else query[field] = value;
  }
  return {
    query,
    selectedId: boundedAssetId(oneParam(params, "asset")),
    ...viewParam(params),
  };
}

export function encodeVideoMediaLocation(
  query: VideoMediaLocationQuery,
  selectedId: string | null,
  view?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.tag) params.set("tag", query.tag);
  else if (query.by) params.set("by", query.by);
  else if (query.rights) params.set("rights", query.rights);
  if (query.sort !== DEFAULT_VIDEO_MEDIA_QUERY.sort) params.set("sort", query.sort);
  if (query.limit !== DEFAULT_VIDEO_MEDIA_QUERY.limit) params.set("limit", String(query.limit));
  if (selectedId && isBoundedId(selectedId)) params.set("asset", selectedId);
  if (view && isBoundedId(view)) params.set("view", view);
  return params;
}

function parseMediaAssetReference(value: string | null): MediaAssetRef | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts[0] === "r2" && parts.length === 2 && isBoundedId(parts[1])) {
    return { backend: "r2", id: parts[1] };
  }
  if (parts[0] === "s3" && parts.length === 3 && isBoundedId(parts[1]) && isBoundedId(parts[2])) {
    return { backend: "s3", sourceId: parts[1], id: parts[2] };
  }
  return null;
}

function encodeMediaAssetReference(ref: MediaAssetRef): string | null {
  if (!isBoundedId(ref.id)) return null;
  if (ref.backend === "r2") return `r2:${ref.id}`;
  return isBoundedId(ref.sourceId) ? `s3:${ref.sourceId}:${ref.id}` : null;
}

export function parseFavoritesMediaLocation(search: string): FavoritesMediaLocationState {
  const params = new URLSearchParams(search);
  const kindCandidate = oneParam(params, "kind") as FavoriteMediaKind | null;
  return {
    kind: kindCandidate && FAVORITE_KINDS.has(kindCandidate) ? kindCandidate : null,
    selectedRef: parseMediaAssetReference(oneParam(params, "asset")),
    ...viewParam(params),
  };
}

export function encodeFavoritesMediaLocation(
  kind: FavoriteMediaKind | null,
  selectedRef: MediaAssetRef | null,
  view?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  const asset = selectedRef && encodeMediaAssetReference(selectedRef);
  if (asset) params.set("asset", asset);
  if (view && isBoundedId(view)) params.set("view", view);
  return params;
}

export function parseCollectionsMediaLocation(search: string): CollectionsMediaLocationState {
  const params = new URLSearchParams(search);
  const showCandidate = oneParam(params, "show");
  const scopeCandidate = oneParam(params, "scope") as MediaCollectionScope | null;
  return {
    show: showCandidate === "archived" ? "archived" : "active",
    scope: scopeCandidate && COLLECTION_SCOPES.has(scopeCandidate) ? scopeCandidate : null,
    selectedRef: parseMediaAssetReference(oneParam(params, "asset")),
    ...viewParam(params),
  };
}

export function encodeCollectionsMediaLocation(
  show: MediaCollectionLifecycle,
  scope: MediaCollectionScope | null,
  selectedRef: MediaAssetRef | null,
  view?: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (show === "archived") params.set("show", show);
  if (scope) params.set("scope", scope);
  const asset = selectedRef && encodeMediaAssetReference(selectedRef);
  if (asset) params.set("asset", asset);
  if (view && isBoundedId(view)) params.set("view", view);
  return params;
}

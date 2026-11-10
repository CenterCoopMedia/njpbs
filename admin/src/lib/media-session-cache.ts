import { forgetVideoSearchShards } from "./video-search-shard-cache";
import type { ListMediaResponse, MediaListQuery } from "./functions";
import { disposeSessionMeaningSearch } from "./meaning-search-session";
import { invalidateVideoSearchCorpus } from "./video-search-session-cache";
import { setRecentTagsUser } from "./recent-media-tags";

let currentUid: string | null = null;
let currentPrincipal: string | null = null;
let revision = 0;
let identityRevision = 0;
const identityListeners = new Set<() => void>();
const mediaLists = new Map<string, ListMediaResponse>();
const posters = new Map<string, { url: string; usableUntil: number }>();
const revisionListeners = new Set<() => void>();
let revisionNoticeQueued = false;
const MAX_MEDIA_LISTS = 24;
const MAX_POSTERS = 400;

// Map keeps insertion order, so re-inserting on use and dropping the first key
// gives a small least-recently-used bound.
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as string);
}

/** Fires when the signed-in account or role changes, including sign-out. */
export function subscribeMediaCacheIdentity(listener: () => void): () => void {
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}

function notifyMediaCacheIdentity(): void {
  identityRevision += 1;
  for (const listener of [...identityListeners]) listener();
}

export function mediaCacheIdentityRevision() { return identityRevision; }

export function setMediaCacheUser(uid: string | null) {
  setRecentTagsUser(uid);
  if (currentUid === uid) return;
  if (currentUid) void forgetVideoSearchShards(currentUid);
  currentUid = uid;
  currentPrincipal = null;
  invalidateMediaLists();
  invalidateVideoSearchCorpus();
  posters.clear();
  disposeSessionMeaningSearch();
  clearMediaTabCounts();
  notifyMediaCacheIdentity();
}

export function setMediaCachePrincipal(uid: string, principal: string) {
  setMediaCacheUser(uid);
  if (currentPrincipal !== null && currentPrincipal !== principal) {
    void forgetVideoSearchShards(uid);
    invalidateMediaLists();
    invalidateVideoSearchCorpus();
    posters.clear();
    disposeSessionMeaningSearch();
    clearMediaTabCounts();
    notifyMediaCacheIdentity();
  }
  currentPrincipal = principal;
}

export function clearMediaSessionCache() {
  setRecentTagsUser(null);
  const hadIdentity = currentUid !== null || currentPrincipal !== null;
  if (currentUid) void forgetVideoSearchShards(currentUid);
  currentUid = null;
  currentPrincipal = null;
  invalidateMediaLists();
  invalidateVideoSearchCorpus();
  posters.clear();
  disposeSessionMeaningSearch();
  clearMediaTabCounts();
  if (hadIdentity) notifyMediaCacheIdentity();
}

function listKey(uid: string, query: MediaListQuery) {
  return JSON.stringify([uid, query]);
}

export function cachedMediaList(uid: string, query: MediaListQuery) {
  if (currentUid !== uid) return undefined;
  const key = listKey(uid, query);
  const result = mediaLists.get(key);
  if (result) remember(mediaLists, key, result, MAX_MEDIA_LISTS);
  return result;
}

export function mediaListRevision() { return revision; }

/**
 * Notifies after list invalidations, for useSyncExternalStore with mediaListRevision. A user or
 * principal change invalidates while a component renders, so the notice waits for a microtask
 * instead of updating another component mid-render. Several invalidations send one notice.
 */
export function subscribeMediaListRevision(listener: () => void) {
  revisionListeners.add(listener);
  return () => { revisionListeners.delete(listener); };
}

export function cacheMediaList(uid: string, query: MediaListQuery, result: ListMediaResponse, requestRevision: number) {
  if (currentUid === uid && revision === requestRevision) remember(mediaLists, listKey(uid, query), result, MAX_MEDIA_LISTS);
}

let favoritesChangeRevision = 0;
const favoritesChangeListeners = new Set<() => void>();

/** A favorite batch changed membership. Open libraries reload, including one the user opened during the request. */
export function publishFavoritesChange() {
  favoritesChangeRevision += 1;
  invalidateMediaLists();
  for (const listener of [...favoritesChangeListeners]) listener();
}

export function favoritesChangeRevisionValue() { return favoritesChangeRevision; }

export function subscribeFavoritesChange(listener: () => void) {
  favoritesChangeListeners.add(listener);
  return () => { favoritesChangeListeners.delete(listener); };
}

export function invalidateMediaLists() {
  revision += 1;
  mediaLists.clear();
  // The Images count came from a list this change made stale; hide it until a list reloads.
  if (tabCounts.images !== undefined) {
    const { images: _stale, ...rest } = tabCounts;
    setTabCounts(rest);
  }
  if (revisionNoticeQueued || revisionListeners.size === 0) return;
  revisionNoticeQueued = true;
  queueMicrotask(() => {
    revisionNoticeQueued = false;
    for (const listener of [...revisionListeners]) listener();
  });
}

/**
 * Media tab counts for this page session. They ride on list calls the page already makes: the
 * first Images list or video sources call after a page reload asks for them with `counts: true`,
 * and so does the next such call after an upload or delete. Paging, filtering, sorting and
 * searching reuse the counts in hand. A missing key means "not known": the tab shows no count.
 */
export interface MediaTabCounts {
  images?: number;
  favorites?: number;
  voiceovers?: number;
  audio?: number;
  sources?: Readonly<Record<string, number>>;
}

export interface MediaTabCountsRequest {
  countsRevision: number;
  listRevision: number;
}

const NO_TAB_COUNTS: MediaTabCounts = Object.freeze({});
let tabCounts: MediaTabCounts = NO_TAB_COUNTS;
let tabCountsReceived = false;
let tabCountsStale = false;
let tabCountsPending = false;
let tabCountsRevision = 0;
const tabCountListeners = new Set<() => void>();
let tabCountNoticeQueued = false;

function exactCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function setTabCounts(next: MediaTabCounts) {
  tabCounts = Object.keys(next).length === 0 ? NO_TAB_COUNTS : next;
  // Like the list revision notice, this waits for a microtask so an identity change during a
  // render never updates another component mid-render.
  if (tabCountNoticeQueued || tabCountListeners.size === 0) return;
  tabCountNoticeQueued = true;
  queueMicrotask(() => {
    tabCountNoticeQueued = false;
    for (const listener of [...tabCountListeners]) listener();
  });
}

function parseTabCounts(value: unknown): MediaTabCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const parsed: { -readonly [K in keyof MediaTabCounts]: MediaTabCounts[K] } = {};
  for (const key of ["images", "favorites", "voiceovers", "audio"] as const) {
    if (exactCount(raw[key])) parsed[key] = raw[key];
  }
  if (raw.sources && typeof raw.sources === "object" && !Array.isArray(raw.sources)) {
    const sources = Object.fromEntries(Object.entries(raw.sources as Record<string, unknown>)
      .filter((entry): entry is [string, number] => exactCount(entry[1])));
    if (Object.keys(sources).length > 0) parsed.sources = sources;
  }
  return parsed;
}

export function mediaTabCounts(): MediaTabCounts { return tabCounts; }

export function mediaTabCountsRevision() { return tabCountsRevision; }

export function subscribeMediaTabCounts(listener: () => void) {
  tabCountListeners.add(listener);
  return () => { tabCountListeners.delete(listener); };
}

/** Claims the one counted load this session needs, or returns null when counts are in hand. */
export function beginMediaTabCountsRequest(): MediaTabCountsRequest | null {
  if (tabCountsPending || (tabCountsReceived && !tabCountsStale)) return null;
  tabCountsPending = true;
  return { countsRevision: tabCountsRevision, listRevision: revision };
}

/** Applies a counted response. One that started before an account change or a write is dropped. */
export function finishMediaTabCountsRequest(request: MediaTabCountsRequest, counts: unknown) {
  if (request.countsRevision !== tabCountsRevision) return;
  tabCountsPending = false;
  tabCountsReceived = true;
  tabCountsStale = false;
  const next = parseTabCounts(counts);
  if (request.listRevision !== revision) delete next.images;
  if (next.images === undefined && tabCounts.images !== undefined) next.images = tabCounts.images;
  setTabCounts(counts === undefined || counts === null ? { ...tabCounts } : next);
}

/** Frees the claim after a failed request, so the next list load asks again. */
export function failMediaTabCountsRequest(request: MediaTabCountsRequest) {
  if (request.countsRevision === tabCountsRevision) tabCountsPending = false;
}

/** After an upload or delete: keep showing counts until the reload that follows replaces them. */
export function markMediaTabCountsStale() {
  tabCountsStale = true;
  tabCountsPending = false;
  tabCountsRevision += 1;
}

/** The Images count from a list response of the current list revision; null hides it. */
export function setMediaImagesCount(count: number | null, listRevision: number) {
  if (listRevision !== revision) return;
  const { images: _previous, ...rest } = tabCounts;
  if (count === null) {
    if (tabCounts.images !== undefined) setTabCounts(rest);
    return;
  }
  if (!exactCount(count) || tabCounts.images === count) return;
  setTabCounts({ ...rest, images: count });
}

/** One video source's count from an unfiltered total already in hand; null hides it. */
export function setMediaSourceCount(sourceId: string, count: number | null) {
  const { [sourceId]: previous, ...others } = tabCounts.sources ?? {};
  if (count === null ? previous === undefined : !exactCount(count) || previous === count) return;
  const sources = count === null ? others : { ...others, [sourceId]: count };
  const { sources: _sources, ...rest } = tabCounts;
  setTabCounts(Object.keys(sources).length > 0 ? { ...rest, sources } : rest);
}

/** The caller's own favorite changes move a known favorites count by that many. */
export function adjustMediaFavoritesCount(delta: number, countsRevision: number) {
  if (!Number.isSafeInteger(delta) || delta === 0) return;
  if (countsRevision !== tabCountsRevision || tabCounts.favorites === undefined) return;
  setTabCounts({ ...tabCounts, favorites: Math.max(0, tabCounts.favorites + delta) });
}

/** Account changes, sign-out and denied requests forget every count. */
export function clearMediaTabCounts() {
  tabCountsRevision += 1;
  tabCountsReceived = false;
  tabCountsStale = false;
  tabCountsPending = false;
  if (tabCounts !== NO_TAB_COUNTS) setTabCounts({});
}

function posterKey(sourceId: string, assetId: string, fileVersion?: string | null) {
  return `${sourceId}:${assetId}:${fileVersion ?? ""}`;
}

export function cachedPoster(sourceId: string, assetId: string, fileVersion?: string | null) {
  const key = posterKey(sourceId, assetId, fileVersion);
  const entry = posters.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.usableUntil) {
    posters.delete(key);
    return undefined;
  }
  remember(posters, key, entry, MAX_POSTERS);
  return entry.url;
}

export function cachePoster(sourceId: string, assetId: string, url: string, expiresAt: string | undefined, requestedAt: number, fileVersion?: string | null) {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  remember(posters, posterKey(sourceId, assetId, fileVersion), {
    url,
    usableUntil: (Number.isFinite(expiry) ? expiry : requestedAt + 5 * 60_000) - 60_000,
  }, MAX_POSTERS);
}

export function invalidatePoster(sourceId: string, assetId: string, fileVersion?: string | null) {
  if (fileVersion !== undefined) { posters.delete(posterKey(sourceId, assetId, fileVersion)); return; }
  // Callers without a file identity invalidate all versions of this asset.
  for (const key of posters.keys()) if (key.startsWith(`${sourceId}:${assetId}:`)) posters.delete(key);
}

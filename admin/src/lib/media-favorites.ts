import { postFunction, type MediaAssetSummary } from "./functions";
import { adjustMediaFavoritesCount, mediaTabCountsRevision } from "./media-session-cache";
import type { MediaAssetRef } from "./media-identity";
import type { SourceMediaAssetSummary } from "./source-media";

export type MediaFavoriteRef = MediaAssetRef;

export type MediaFavoriteRecord =
  | {
      ref: Extract<MediaFavoriteRef, { backend: "r2" }>;
      createdAt: string;
      available: true;
      asset: MediaAssetSummary;
    }
  | {
      ref: Extract<MediaFavoriteRef, { backend: "s3" }>;
      createdAt: string;
      available: true;
      asset: SourceMediaAssetSummary;
    }
  | {
      ref: MediaFavoriteRef;
      createdAt: string;
      available: false;
    };

export interface MediaFavoritePage {
  success: true;
  records: MediaFavoriteRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MediaFavoriteState {
  ref: MediaFavoriteRef;
  favorite: boolean;
}

export function listMediaFavorites(
  token: string | null,
  query: { cursor?: string; limit?: number } = {},
) {
  return postFunction<MediaFavoritePage>("cmsListMediaFavorites", token, query);
}

export function listMediaFavoriteStates(
  token: string | null,
  refs: MediaFavoriteRef[],
) {
  return postFunction<{ success: true; states: MediaFavoriteState[] }>(
    "cmsListMediaFavorites",
    token,
    { refs },
  );
}

let writeEpoch = 0;
let writesInFlight = 0;

/**
 * Changes when a favorite write starts and when it ends, and is null while one is in flight. A
 * list read is current only when this is non-null and unchanged from its start to its response.
 */
export function mediaFavoriteWriteEpoch(): number | null {
  return writesInFlight > 0 ? null : writeEpoch;
}

async function trackWrite<T>(write: () => Promise<T>): Promise<T> {
  writeEpoch += 1;
  writesInFlight += 1;
  try {
    return await write();
  } finally {
    writesInFlight -= 1;
    writeEpoch += 1;
  }
}

export async function setMediaFavorite(
  token: string | null,
  ref: MediaFavoriteRef,
  favorite: boolean,
) {
  return trackWrite(() => writeMediaFavorite(token, ref, favorite));
}

async function writeMediaFavorite(
  token: string | null,
  ref: MediaFavoriteRef,
  favorite: boolean,
) {
  const countsRevision = mediaTabCountsRevision();
  const result = await postFunction<{
    success: true;
    ref: MediaFavoriteRef;
    favorite: boolean;
    changed: boolean;
  }>(
    "cmsSetMediaFavorite",
    token,
    { ref, favorite },
    {},
    { appCheck: true },
  );
  // The response carries no count. The caller's own change moves the shown count by one, and
  // the next counted list load corrects any change made elsewhere.
  if (result.changed === true) adjustMediaFavoritesCount(result.favorite ? 1 : -1, countsRevision);
  return result;
}

export type MediaFavoriteResult =
  | (MediaFavoriteState & { changed: boolean })
  | { ref: MediaFavoriteRef; error: string; status: number };

export interface MediaFavoritesResult {
  success: true;
  favorite: boolean;
  results: MediaFavoriteResult[];
}

export interface MediaFavoritesResultSummary {
  changedRefs: MediaFavoriteRef[];
  failedResults: Extract<MediaFavoriteResult, { error: string }>[];
}

const MAX_MEDIA_FAVORITE_REFS = 100;
const MEDIA_FAVORITE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mediaFavoriteRefKey(value: unknown): string | null {
  if (
    !plainObject(value) ||
    typeof value.id !== "string" ||
    !MEDIA_FAVORITE_ID.test(value.id)
  ) return null;
  const keys = Object.keys(value).sort();
  if (
    value.backend === "r2" &&
    keys.length === 2 &&
    keys[0] === "backend" &&
    keys[1] === "id"
  ) {
    return `r2:${value.id}`;
  }
  if (
    value.backend === "s3" &&
    typeof value.sourceId === "string" &&
    MEDIA_FAVORITE_ID.test(value.sourceId) &&
    keys.length === 3 &&
    keys[0] === "backend" &&
    keys[1] === "id" &&
    keys[2] === "sourceId"
  ) {
    return `s3:${value.sourceId}:${value.id}`;
  }
  return null;
}

function validateMediaFavoriteRefs(refs: MediaFavoriteRef[]): void {
  if (
    !Array.isArray(refs) ||
    refs.length < 1 ||
    refs.length > MAX_MEDIA_FAVORITE_REFS
  ) {
    throw new Error("Favorite batch must contain 1 through 100 media references");
  }
  const keys = refs.map(mediaFavoriteRefKey);
  if (keys.some(key => key === null)) {
    throw new Error("Favorite batch contains an invalid media reference");
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error("Favorite batch contains a duplicate media reference");
  }
}

function validateMediaFavoritesResult(
  value: unknown,
  refs: MediaFavoriteRef[],
  favorite: boolean,
): MediaFavoritesResult {
  if (
    !plainObject(value) ||
    value.success !== true ||
    value.favorite !== favorite ||
    !Array.isArray(value.results) ||
    value.results.length !== refs.length
  ) {
    throw new Error("Favorite batch response is invalid");
  }
  for (let index = 0; index < refs.length; index += 1) {
    const item = value.results[index];
    if (
      !plainObject(item) ||
      mediaFavoriteRefKey(item.ref) !== mediaFavoriteRefKey(refs[index])
    ) {
      throw new Error("Favorite batch response is invalid");
    }
    const success =
      item.favorite === favorite &&
      typeof item.changed === "boolean" &&
      item.error === undefined &&
      item.status === undefined;
    const failure =
      item.favorite === undefined &&
      item.changed === undefined &&
      typeof item.error === "string" &&
      item.error.length > 0 &&
      typeof item.status === "number" &&
      Number.isSafeInteger(item.status) &&
      item.status >= 400 &&
      item.status <= 599;
    if (!success && !failure) throw new Error("Favorite batch response is invalid");
  }
  return value as unknown as MediaFavoritesResult;
}

export function summarizeMediaFavoritesResult(
  result: MediaFavoritesResult,
): MediaFavoritesResultSummary {
  const changedRefs: MediaFavoriteRef[] = [];
  const failedResults: MediaFavoritesResultSummary["failedResults"] = [];
  for (const item of result.results) {
    if ("changed" in item) {
      if (item.changed) changedRefs.push(item.ref);
    } else {
      failedResults.push(item);
    }
  }
  return { changedRefs, failedResults };
}

export async function setMediaFavorites(
  token: string | null,
  refs: MediaFavoriteRef[],
  favorite: boolean,
) {
  if (typeof favorite !== "boolean") {
    throw new Error("Favorite state must be true or false");
  }
  validateMediaFavoriteRefs(refs);
  return trackWrite(() => writeMediaFavorites(token, refs, favorite));
}

async function writeMediaFavorites(
  token: string | null,
  refs: MediaFavoriteRef[],
  favorite: boolean,
) {
  const countsRevision = mediaTabCountsRevision();
  const response = await postFunction<unknown>(
    "cmsSetMediaFavorites",
    token,
    { refs, favorite },
    {},
    { appCheck: true },
  );
  const result = validateMediaFavoritesResult(response, refs, favorite);
  const changedCount = summarizeMediaFavoritesResult(result).changedRefs.length;
  if (changedCount > 0) {
    adjustMediaFavoritesCount(result.favorite ? changedCount : -changedCount, countsRevision);
  }
  return result;
}

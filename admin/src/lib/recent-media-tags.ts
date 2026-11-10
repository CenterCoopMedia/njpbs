import { tagKey } from "../components/ui/tokenInputModel";
import type { MediaTileSurface } from "./media-tile-actions";

// The last tags saved in this browser, per account and surface, for tag suggestions.
// A per-viewer convenience only: blocked or cleared storage reads as an empty list, and
// nothing here is sent anywhere.

export const MAX_RECENT_MEDIA_TAGS = 20;
const RECENT_TAGS_PREFIX = "njpbs-admin:media-recent-tags:";
let currentUserId: string | null = null;

export function setRecentTagsUser(userId: string | null): void {
  currentUserId = userId;
  if (userId === null) clearRecentTags();
}

export function recentTagsKey(surface: MediaTileSurface, userId: string): string {
  return `${RECENT_TAGS_PREFIX}${surface}:${userId}`;
}

function browserStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Newest first, at most 20. */
export function readRecentTags(surface: MediaTileSurface, userId: string, store: Storage | null = browserStore()): string[] {
  if (!store || !userId) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(recentTagsKey(surface, userId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      .slice(0, MAX_RECENT_MEDIA_TAGS);
  } catch {
    return [];
  }
}

/** Puts the saved tags first, in the order given, and drops older copies in any letter case. */
export function recordRecentTags(surface: MediaTileSurface, tags: readonly string[], userId: string, store: Storage | null = browserStore()): void {
  if (!store || !userId || userId !== currentUserId) return;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const tag of [...tags.map((value) => value.trim()), ...readRecentTags(surface, userId, store)]) {
    const key = tagKey(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    next.push(tag);
    if (next.length >= MAX_RECENT_MEDIA_TAGS) break;
  }
  try {
    store.setItem(recentTagsKey(surface, userId), JSON.stringify(next));
  } catch {
    // Storage is full or blocked; suggestions fall back to the selection and the page.
  }
}

/** Removes account-scoped and legacy unscoped tags when the session ends. */
export function clearRecentTags(store: Storage | null = browserStore()): void {
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key?.startsWith(RECENT_TAGS_PREFIX)) store.removeItem(key);
    }
  } catch {
    // Blocked storage must not prevent sign-out.
  }
}

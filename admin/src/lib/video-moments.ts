interface Bookmark {
  id: string;
  name: string;
  seconds: number;
}

export interface VideoMoments {
  bookmarks: Bookmark[];
  resume: number | null;
}

const prefix = "njpbs.admin.video-moments:";
const retentionMs = 30 * 24 * 60 * 60 * 1000;
export const maxBookmarkNameLength = 80;
export const emptyVideoMoments: VideoMoments = { bookmarks: [], resume: null };

function userPrefix(userId: string) {
  return `${prefix}${encodeURIComponent(userId)}:`;
}

export function videoMomentsKey(userId: string, sourceId: string, assetId: string, fileVersion: string) {
  return userPrefix(userId) + JSON.stringify([sourceId, assetId, fileVersion]);
}

export function validVideoMoment(seconds: unknown): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
}

function validBookmark(value: unknown): value is Bookmark {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
    && "name" in value && typeof value.name === "string" && Boolean(value.name.trim()) && value.name.length <= maxBookmarkNameLength
    && "seconds" in value && validVideoMoment(value.seconds);
}

function parseMoments(raw: string, now = Date.now()): VideoMoments | null {
  try {
    const saved = JSON.parse(raw);
    if (typeof saved?.savedAt !== "number" || saved.savedAt <= now - retentionMs || saved.savedAt > now) return null;
    return {
      bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks.filter(validBookmark) : [],
      resume: validVideoMoment(saved.resume) ? saved.resume : null,
    };
  } catch {
    return null;
  }
}

export function readVideoMoments(key: string): VideoMoments {
  const raw = localStorage.getItem(key);
  if (raw === null) return emptyVideoMoments;
  const moments = parseMoments(raw);
  if (moments) return moments;
  localStorage.removeItem(key);
  return emptyVideoMoments;
}

export function writeVideoMoments(key: string, moments: VideoMoments) {
  if (moments.bookmarks.length || moments.resume !== null) {
    localStorage.setItem(key, JSON.stringify({ ...moments, savedAt: Date.now() }));
  } else localStorage.removeItem(key);
}

/** Keep current-account moments for at most 30 days after the last change. */
export function pruneBrowserVideoMoments(userId: string | null) {
  try {
    const retainedPrefix = userId === null ? null : userPrefix(userId);
    const now = Date.now();
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      if (retainedPrefix && key.startsWith(retainedPrefix)) {
        const raw = localStorage.getItem(key);
        if (raw && parseMoments(raw, now)) continue;
      }
      localStorage.removeItem(key);
    }
  } catch {
    // Restricted browser storage cannot interrupt sign-in or sign-out.
  }
}

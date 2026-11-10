import { mediaDisplayUrl } from "./media-image";
import type { AuthorPhoto } from "./functions";

const STORAGE_KEY = "njpbs.admin.ownAvatarPhoto";
/** A later mount in this tab reuses a crop this new. An older crop is read again. */
export const OWN_AVATAR_MAX_AGE_MS = 60_000;
/** The account avatar is 2.4rem. Two device pixels is under 80. */
export const AVATAR_DISPLAY_WIDTH = 80;
let epoch = 0;

/** Changes on every write or clear, so a profile read started earlier can be ignored. */
export function ownAvatarPhotoEpoch(): number {
  return epoch;
}

/** The crop the shell avatar draws. Nothing else from the profile is stored. */
export type AvatarPhoto = Pick<AuthorPhoto, "url" | "focalX" | "focalY">;

/** A profile photo before the shell chooses the address it will draw. */
export type AvatarPhotoSource = AvatarPhoto & {
  thumbnails?: readonly { url?: unknown; width?: unknown; height?: unknown }[] | null;
};

interface StoredAvatarPhoto {
  uid: string;
  photo: AvatarPhoto | null;
  storedAt: number;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function safeThumbnailUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

function avatarThumbnails(value: AvatarPhotoSource["thumbnails"]) {
  if (!Array.isArray(value)) return [];
  const thumbnails = [];
  for (const item of value) {
    if (!item || typeof item.url !== "string") continue;
    const url = safeThumbnailUrl(item.url);
    if (!url || !Number.isInteger(item.width) || !Number.isInteger(item.height)) continue;
    const width = item.width as number;
    const height = item.height as number;
    if (width < 1 || height < 1) continue;
    thumbnails.push({ url, width, height });
  }
  return thumbnails;
}

export function avatarPhotoFrom(photo: AvatarPhotoSource | null): AvatarPhoto | null {
  if (!photo || typeof photo.url !== "string" || photo.url.length === 0) return null;
  if (typeof photo.focalX !== "number" || !Number.isFinite(photo.focalX)) return null;
  if (typeof photo.focalY !== "number" || !Number.isFinite(photo.focalY)) return null;
  return {
    url: mediaDisplayUrl({
      url: photo.url,
      thumbnails: avatarThumbnails(photo.thumbnails),
    }, AVATAR_DISPLAY_WIDTH, AVATAR_DISPLAY_WIDTH),
    focalX: photo.focalX,
    focalY: photo.focalY,
  };
}

function storedPhoto(value: unknown): AvatarPhoto | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  return avatarPhotoFrom(value as AvatarPhoto);
}

/** `undefined` is a miss. `null` is a cached profile with no photograph. */
export function readOwnAvatarPhoto(
  uid: string,
  maxAgeMs?: number,
): AvatarPhoto | null | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredAvatarPhoto>;
    if (parsed.uid !== uid) {
      store.removeItem(STORAGE_KEY);
      return undefined;
    }
    const photo = storedPhoto(parsed.photo);
    if (photo === undefined) {
      store.removeItem(STORAGE_KEY);
      return undefined;
    }
    const storedAt = typeof parsed.storedAt === "number" && Number.isFinite(parsed.storedAt)
      ? parsed.storedAt
      : null;
    if (
      maxAgeMs !== undefined &&
      (storedAt === null || Date.now() - storedAt >= maxAgeMs)
    ) {
      return undefined;
    }
    const canonical = JSON.stringify(storedAt === null ? { uid, photo } : { uid, photo, storedAt });
    if (raw !== canonical) {
      try {
        store.setItem(STORAGE_KEY, canonical);
      } catch {
        // The read is still only the crop fields.
      }
    }
    return photo;
  } catch {
    return undefined;
  }
}

export function writeOwnAvatarPhoto(uid: string, photo: AvatarPhotoSource | null): void {
  epoch += 1;
  const store = storage();
  if (!store) return;
  const stored: StoredAvatarPhoto = {
    uid,
    photo: avatarPhotoFrom(photo),
    storedAt: Date.now(),
  };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A blocked store leaves the next mount to read the profile.
  }
}

export function clearOwnAvatarPhoto(): void {
  epoch += 1;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

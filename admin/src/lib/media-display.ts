import type { MediaAssetSummary } from "./functions";
import { formatMediaBytes, formatMediaUpdated } from "./media-format";

// Kept here too so existing imports keep working; media-format.ts owns it.
export { formatMediaBytes };

// Per-browser display preferences for the images tab.
// They live in browser storage, never in the URL, and blocked storage falls back to the
// defaults. The storage key and field names are a contract for later phases: the reader
// ignores keys it does not know and reads a missing or unknown layout as grid, so old and
// new builds agree.

export type MediaThumbnailSize = "s" | "m" | "l";
export type MediaDensity = "app" | "compact" | "comfortable" | "loose";
export type MediaCardField = "type" | "category" | "size" | "dimensions" | "updated" | "tags";
export type VideoMediaCardField = "type" | "size" | "duration" | "rights" | "updated" | "tags" | "uploader";
export type VideoMediaPageSize = 24 | 48 | 96;
export type MediaDisplaySurface = "images" | "video" | "favorites" | "collections";
export type MediaLayout = "grid" | "list";
/** A list layout column: the name is always first, then the card fields. */
export type MediaListColumn = "name" | MediaCardField;

export interface MediaDisplayPreferences {
  layout: MediaLayout;
  thumbnail: MediaThumbnailSize;
  density: MediaDensity;
  fields: Record<MediaCardField, boolean>;
}

export interface VideoMediaDisplayPreferences {
  layout: MediaLayout;
  thumbnail: MediaThumbnailSize;
  density: MediaDensity;
  fields: Record<VideoMediaCardField, boolean>;
  pageSize: VideoMediaPageSize;
}

export type MediaDisplayPreferencesFor<Surface extends MediaDisplaySurface> =
  Surface extends "video" ? VideoMediaDisplayPreferences : MediaDisplayPreferences;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MEDIA_DISPLAY_STORAGE_PREFIX = "njpbs-admin:media-display:";

export function mediaDisplayStorageKey(surface: MediaDisplaySurface): string {
  return `${MEDIA_DISPLAY_STORAGE_PREFIX}${surface}`;
}

export const MEDIA_DISPLAY_STORAGE_KEY = mediaDisplayStorageKey("images");
export const VIDEO_MEDIA_DISPLAY_STORAGE_KEY = mediaDisplayStorageKey("video");
export const MEDIA_CARD_FIELD_ORDER: readonly MediaCardField[] = ["type", "category", "size", "dimensions", "updated", "tags"];
export const VIDEO_MEDIA_CARD_FIELD_ORDER: readonly VideoMediaCardField[] = ["type", "size", "duration", "rights", "updated", "tags", "uploader"];

// The default card meta line: type, size, dimensions and a tag count.
export const DEFAULT_MEDIA_DISPLAY: MediaDisplayPreferences = Object.freeze({
  layout: "grid",
  thumbnail: "m",
  density: "app",
  fields: Object.freeze({ type: true, size: true, dimensions: true, tags: true, category: false, updated: false }),
}) as MediaDisplayPreferences;

export const DEFAULT_VIDEO_MEDIA_DISPLAY: VideoMediaDisplayPreferences = Object.freeze({
  layout: "grid",
  thumbnail: "m",
  density: "app",
  fields: Object.freeze({ type: true, size: true, duration: true, rights: true, updated: false, tags: true, uploader: false }),
  pageSize: 24,
}) as VideoMediaDisplayPreferences;

const LAYOUTS = new Set<MediaLayout>(["grid", "list"]);
const THUMBNAILS = new Set<MediaThumbnailSize>(["s", "m", "l"]);
const DENSITIES = new Set<MediaDensity>(["app", "compact", "comfortable", "loose"]);
const THUMBNAIL_TOKENS: Record<MediaThumbnailSize, string> = { s: "var(--cms-thumb-sm)", m: "var(--cms-thumb-md)", l: "var(--cms-thumb-lg)" };

export function thumbnailToken(size: MediaThumbnailSize): string {
  return THUMBNAIL_TOKENS[size];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readMediaDisplay<Surface extends MediaDisplaySurface>(
  surface: Surface,
  store: Store | null | undefined,
): MediaDisplayPreferencesFor<Surface> {
  let stored: unknown;
  try {
    const raw = store?.getItem(mediaDisplayStorageKey(surface));
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const defaults = surface === "video" ? DEFAULT_VIDEO_MEDIA_DISPLAY : DEFAULT_MEDIA_DISPLAY;
  const fieldOrder = surface === "video" ? VIDEO_MEDIA_CARD_FIELD_ORDER : MEDIA_CARD_FIELD_ORDER;
  if (!plainObject(stored)) {
    return { ...defaults, fields: { ...defaults.fields } } as MediaDisplayPreferencesFor<Surface>;
  }
  const fields: Record<string, boolean> = { ...defaults.fields };
  if (plainObject(stored.fields)) {
    for (const field of fieldOrder) {
      const value = stored.fields[field];
      if (typeof value === "boolean") fields[field] = value;
    }
  }
  const preferences = {
    layout: LAYOUTS.has(stored.layout as MediaLayout) ? (stored.layout as MediaLayout) : DEFAULT_MEDIA_DISPLAY.layout,
    thumbnail: THUMBNAILS.has(stored.thumbnail as MediaThumbnailSize) ? (stored.thumbnail as MediaThumbnailSize) : DEFAULT_MEDIA_DISPLAY.thumbnail,
    density: DENSITIES.has(stored.density as MediaDensity) ? (stored.density as MediaDensity) : DEFAULT_MEDIA_DISPLAY.density,
    fields,
  };
  return (surface === "video"
    ? { ...preferences, pageSize: DEFAULT_VIDEO_MEDIA_DISPLAY.pageSize }
    : preferences) as MediaDisplayPreferencesFor<Surface>;
}

export function writeMediaDisplay<Surface extends MediaDisplaySurface>(
  surface: Surface,
  store: Store | null | undefined,
  preferences: MediaDisplayPreferencesFor<Surface>,
): void {
  try {
    // Video page size belongs to the URL, so browser preferences keep only visual choices.
    const stored = surface === "video" ? { ...preferences, pageSize: undefined } : preferences;
    store?.setItem(mediaDisplayStorageKey(surface), JSON.stringify(stored));
  } catch {
    // Private windows and full storage keep the choice for this visit only.
  }
}

export function resetMediaDisplay(surface: MediaDisplaySurface, store: Store | null | undefined): void {
  try {
    store?.removeItem(mediaDisplayStorageKey(surface));
  } catch {
    // Nothing stored is the same as the defaults.
  }
}

/**
 * The list layout's columns: the name, the fields shown on cards in the card field order, and
 * Updated always, last, so the list can sort by it.
 */
export function listColumns(fields: Record<MediaCardField, boolean>): MediaListColumn[] {
  return ["name", ...MEDIA_CARD_FIELD_ORDER.filter((field) => field !== "updated" && fields[field]), "updated"];
}

export interface MediaCardFact {
  field: MediaCardField;
  text: string;
}

/** The card's meta facts for the visible fields, in one fixed order, each with its field. */
export function mediaCardFactEntries(
  asset: MediaAssetSummary,
  fields: Record<MediaCardField, boolean>,
  categoryLabel: (id: string) => string,
): MediaCardFact[] {
  const facts: Record<MediaCardField, string | null> = {
    type: asset.kind === "document" ? "PDF" : asset.kind === "audio" ? "WAV audio" : "Image",
    category: categoryLabel(asset.category),
    size: formatMediaBytes(asset.sizeBytes),
    dimensions: asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
    updated: formatMediaUpdated(asset.updatedAt),
    tags: asset.tags.length === 0 ? null : `${asset.tags.length} ${asset.tags.length === 1 ? "tag" : "tags"}`,
  };
  return MEDIA_CARD_FIELD_ORDER.flatMap((field) => (fields[field] && facts[field] ? [{ field, text: facts[field] as string }] : []));
}

/** The card's meta facts for the visible fields, in one fixed order. */
export function mediaCardFacts(
  asset: MediaAssetSummary,
  fields: Record<MediaCardField, boolean>,
  categoryLabel: (id: string) => string,
): string[] {
  return mediaCardFactEntries(asset, fields, categoryLabel).map((fact) => fact.text);
}

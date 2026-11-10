import { escapeHtml } from "./safe-href.ts";
import { CMS_MEDIA_ORIGIN, isCmsMediaUrl } from "./media-origin.ts";

// The video block (#2751) plays the 1080p web copy of a video-library item. Staff pick
// the item; the server owns `public`. Publishing copies the exact web MP4 and poster
// versions to R2 under cms-media/video/ and stamps their URLs into the published
// snapshot only. A working draft never carries `public`, so a video is public only
// while published content uses it.

export const VIDEO_BLOCK_SOURCE_ID = "video-library";
export const VIDEO_PUBLIC_PREFIX = `${CMS_MEDIA_ORIGIN}/cms-media/video/`;
export const VIDEO_BLOCK_LIMITS = Object.freeze({
  assetId: 200,
  title: 200,
  caption: 600,
  url: 2000,
});

export interface PublicVideoData {
  url: string;
  posterUrl: string;
  width: number;
  height: number;
  mimeType: "video/mp4";
}

export interface VideoBlockData {
  sourceId: typeof VIDEO_BLOCK_SOURCE_ID;
  assetId: string;
  title: string;
  caption?: string;
  /** Server-owned. Present only in a published snapshot. */
  public?: PublicVideoData;
}

const DATA_FIELDS = new Set(["sourceId", "assetId", "title", "caption", "public"]);
const PUBLIC_FIELDS = new Set(["url", "posterUrl", "width", "height", "mimeType"]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** An exact object URL on a media origin admitted by this build. */
export function isPublicVideoUrl(value: unknown, extension: "mp4" | "jpg"): value is string {
  if (!boundedString(value, VIDEO_BLOCK_LIMITS.url)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.href === value
    && isCmsMediaUrl(url)
    && /^\/cms-media\/video\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.(mp4|jpg)$/.test(url.pathname)
    && url.pathname.endsWith(`.${extension}`);
}

export function isPublicVideoData(value: unknown): value is PublicVideoData {
  if (!plainObject(value) || !Object.keys(value).every((key) => PUBLIC_FIELDS.has(key))) return false;
  return isPublicVideoUrl(value.url, "mp4")
    && isPublicVideoUrl(value.posterUrl, "jpg")
    && Number.isSafeInteger(value.width) && (value.width as number) > 0
    && Number.isSafeInteger(value.height) && (value.height as number) > 0
    && value.mimeType === "video/mp4";
}

/**
 * Shape check. A draft may hold an empty pick; a publishable block needs an item and
 * a title. `public` is accepted only in a well-formed server shape.
 */
export function isVideoBlockData(value: unknown, publishable = true): value is VideoBlockData {
  if (!plainObject(value) || !Object.keys(value).every((key) => DATA_FIELDS.has(key))) return false;
  if (value.sourceId !== VIDEO_BLOCK_SOURCE_ID) return false;
  if (!boundedString(value.assetId, VIDEO_BLOCK_LIMITS.assetId)) return false;
  if (!boundedString(value.title, VIDEO_BLOCK_LIMITS.title)) return false;
  if (value.caption !== undefined && !boundedString(value.caption, VIDEO_BLOCK_LIMITS.caption)) return false;
  if (value.public !== undefined && !isPublicVideoData(value.public)) return false;
  if (publishable && (!value.assetId.trim() || !value.title.trim())) return false;
  return true;
}

interface BlockLike {
  type?: unknown;
  data?: unknown;
}

/**
 * True when the page plays a video: a video block that carries `public`, the same
 * condition `renderVideoBlock` uses. Publishing stamps `public` only on visible
 * blocks, so a hidden video does not turn off analytics. Any `public` value counts,
 * so a page that renders a player is never missed (VPPA).
 */
export function containsVideo(blocks: unknown): boolean {
  return Array.isArray(blocks) && blocks.some((block) => {
    const candidate = block as BlockLike | null;
    return candidate?.type === "video" && plainObject(candidate.data) && Boolean(candidate.data.public);
  });
}

/** The block list without any client-supplied `public` on video blocks. */
export function withoutPublicVideoData<T>(blocks: T): T {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    const candidate = block as BlockLike;
    if (candidate?.type !== "video" || !plainObject(candidate.data) || !("public" in candidate.data)) return block;
    const { public: _ignored, ...data } = candidate.data;
    return { ...(block as object), data };
  }) as T;
}

export interface RenderVideoBlockOptions {
  /**
   * Private draft previews only. A block without a published copy renders a
   * placeholder that holds the player's space; public output renders nothing.
   */
  placeholder?: boolean;
}

/** Public markup. A block without a published copy renders nothing. */
export function renderVideoBlock(data: VideoBlockData, options: RenderVideoBlockOptions = {}): string {
  const media = data.public;
  const title = escapeHtml(data.title);
  const caption = data.caption?.trim()
    ? `<figcaption class="cms-video__caption">${escapeHtml(data.caption.trim())}</figcaption>`
    : "";
  if (!media) {
    if (!options.placeholder) return "";
    return `<figure class="cms-video cms-video--pending">`
      + `<div class="cms-video__placeholder">`
      + `<span class="cms-video__placeholder-title">${title}</span>`
      + `<span class="cms-video__placeholder-note">Video appears after publishing</span>`
      + `</div>${caption}</figure>`;
  }
  return `<figure class="cms-video">`
    + `<video class="cms-video__player" controls preload="none" playsinline`
    + ` poster="${escapeHtml(media.posterUrl)}" width="${media.width}" height="${media.height}"`
    + ` title="${title}" aria-label="${title}">`
    + `<source src="${escapeHtml(media.url)}" type="video/mp4">`
    + `</video>${caption}</figure>`;
}

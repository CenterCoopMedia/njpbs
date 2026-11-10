import { isImageData, parseBlocks, type EmbedData, type ImageData } from "./content-model.ts";
import { embedPlayer, xVideoLink } from "./embed-player.ts";
import { isVideoBlockData, type VideoBlockData } from "./video-block.ts";
import { safeHref } from "./safe-href.ts";

export type PostLeadMedia =
  | { kind: "image"; data: ImageData }
  | { kind: "library-video"; data: VideoBlockData; posterAssetId?: string }
  | { kind: "linked-video" | "embed"; data: EmbedData & { title: string }; posterAssetId?: string };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const assetId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** One write/read contract. Drafts may be incomplete, but never carry unsafe URLs. */
export function isPostLeadMedia(value: unknown, complete = true): value is PostLeadMedia {
  if (!object(value) || !object(value.data) || !keys(value, ["kind", "data", "posterAssetId"])) return false;
  const data = value.data;
  if (value.kind === "image") {
    return value.posterAssetId === undefined && keys(data, ["assetId", "alt", "altDecorative", "caption"])
      && isImageData(data) && (data.assetId === "" && !complete || assetId(data.assetId))
      && text(data.alt, 2000) && (data.caption === undefined || text(data.caption, 600))
      && (!complete || data.altDecorative === true || data.alt.trim().length > 0);
  }
  if (value.posterAssetId !== undefined && value.posterAssetId !== "" && !assetId(value.posterAssetId)) return false;
  if (value.kind === "library-video") {
    return isVideoBlockData(data, false) && (data.assetId === "" && !complete || assetId(data.assetId))
      && (!complete || Boolean(data.title.trim() || data.caption?.trim()));
  }
  if (value.kind !== "embed" && value.kind !== "linked-video") return false;
  if (!keys(data, ["url", "host", "caption", "title", "width", "height"]) || !text(data.title, 200)
    || !text(data.url, 4000) || data.caption !== undefined && !text(data.caption, 600)
    || data.host !== undefined && !text(data.host, 200)) return false;
  const { title: _title, ...embed } = data;
  if (!parseBlocks([{ id: "lead", type: "embed", order: 0, visible: true, data: embed }], { complete: false }).ok) return false;
  if (complete && !(data.title.trim() || (data.caption as string | undefined)?.trim())) return false;
  if (!complete && data.url === "") return true;
  if (embedPlayer(data.url) || xVideoLink(data.url)) return true;
  if (value.kind === "embed" || safeHref(data.url) !== data.url) return false;
  try {
    const url = new URL(data.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  } catch { return false; }
}

/** Missing new field reads the old image. Explicit invalid/new values never revive it. */
export function readPostLeadMedia(post: Record<string, unknown>, complete = false): PostLeadMedia | null {
  if (post.leadMedia !== undefined) return isPostLeadMedia(post.leadMedia, complete) ? post.leadMedia : null;
  if (!assetId(post.heroImage)) return null;
  const data: ImageData = { assetId: post.heroImage,
    alt: post.heroImageDecorative === true ? "" : typeof post.heroImageAlt === "string" ? post.heroImageAlt : "",
    ...(post.heroImageDecorative === true ? { altDecorative: true } : {}),
    ...(typeof post.heroImageCaption === "string" ? { caption: post.heroImageCaption } : {}) };
  return { kind: "image", data };
}

export function leadMediaAssetIds(value: unknown): string[] {
  if (!isPostLeadMedia(value, false)) return [];
  return value.kind === "image" ? (value.data.assetId ? [value.data.assetId] : [])
    : value.posterAssetId ? [value.posterAssetId] : [];
}

/** Adapt the library lead to the existing copy, retention and preview machinery. */
export function leadVideoBlocks(value: unknown) {
  return isPostLeadMedia(value, false) && value.kind === "library-video"
    ? [{ id: "post-lead-video", type: "video" as const, order: -1, visible: true, data: value.data }] : [];
}

export function withoutPublicLeadVideo<T>(value: T): T {
  if (!object(value) || value.kind !== "library-video" || !object(value.data)) return value;
  const { public: _ignored, ...data } = value.data;
  return { ...value, data } as T;
}

export function leadMediaTitle(lead: Exclude<PostLeadMedia, { kind: "image" }>): string {
  return lead.data.title.trim() || lead.data.caption?.trim() || "Video";
}


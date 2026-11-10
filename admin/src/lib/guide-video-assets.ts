import catalog from "./guide-videos.json";

export interface GuideVideo {
  id: string;
  title: string;
  page: string;
  heading: string;
}

export type GuideVideoExtension = "mp4" | "jpg" | "vtt" | "txt";

const VIDEO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VIDEO_ASSET = /^\/guide-content\/videos\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(mp4|jpg|vtt|txt)$/;

export const GUIDE_SEARCH_PASSAGE_LIMIT = 500;
export const GUIDE_SEARCH_TEXT_LIMIT = 5_000;

export const GUIDE_VIDEO_TYPES: Record<GuideVideoExtension, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  vtt: "text/vtt; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function guideVideoRecord(value: unknown, ids: Set<string>): GuideVideo {
  if (!value || typeof value !== "object") throw new Error("The guide video catalog is invalid.");
  const video = value as Record<string, unknown>;
  if (
    typeof video.id !== "string"
    || !VIDEO_ID.test(video.id)
    || ids.has(video.id)
    || typeof video.title !== "string"
    || video.title.length === 0
    || video.title.length > 160
    || typeof video.page !== "string"
    || !VIDEO_ID.test(video.page)
    || typeof video.heading !== "string"
    || video.heading.length === 0
    || video.heading.length > 160
  ) {
    throw new Error("The guide video catalog is invalid.");
  }
  ids.add(video.id);
  return {
    id: video.id,
    title: video.title,
    page: video.page,
    heading: video.heading,
  };
}

function guideVideoCatalog(value: unknown): readonly GuideVideo[] {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new Error("The guide video catalog is invalid.");
  }
  const ids = new Set<string>();
  return value.map((entry) => guideVideoRecord(entry, ids));
}

export const GUIDE_VIDEOS: readonly GuideVideo[] = guideVideoCatalog(catalog);

const GUIDE_VIDEO_IDS = new Set(GUIDE_VIDEOS.map((video) => video.id));

export function guideVideoAsset(path: string): { id: string; extension: GuideVideoExtension } | null {
  const match = VIDEO_ASSET.exec(path);
  if (!match || !GUIDE_VIDEO_IDS.has(match[1])) return null;
  return { id: match[1], extension: match[2] as GuideVideoExtension };
}

export function chunkGuideSearchText(text: string, limit = 4_500): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

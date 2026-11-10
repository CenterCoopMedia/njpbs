import { escapeHtml } from "./safe-href.ts";
import { isCmsMediaUrl } from "./media-origin.ts";

export interface CmsImageThumbnail { url: string; width: number; height: number }
interface ImageInput { url?: unknown; width?: unknown; height?: unknown; mimeType?: unknown; animated?: unknown; thumbnails?: unknown }

/** Only recorded derivatives of this immutable public original may be advertised. */
export function cmsImageThumbnails(image: ImageInput): CmsImageThumbnail[] {
  if (typeof image.url !== "string" || image.mimeType === "image/gif" || image.animated === true || !Array.isArray(image.thumbnails) ||
      !Number.isSafeInteger(image.width) || Number(image.width) < 1 ||
      !Number.isSafeInteger(image.height) || Number(image.height) < 1) return [];
  let original: URL;
  try { original = new URL(image.url); } catch { return []; }
  const match = /^(\/cms-media\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9_-]+\/)([a-f0-9]{64})\.(?:jpg|png|webp|avif)$/.exec(original.pathname);
  if (!isCmsMediaUrl(original) || !match) return [];
  const sourceWidth = Number(image.width);
  const widths = sourceWidth < 480 ? [sourceWidth] : [480, 960, 1600].filter(width => width <= sourceWidth);
  const output = new Map<number, CmsImageThumbnail>();
  for (const item of image.thumbnails.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const { url, width, height } = item as CmsImageThumbnail;
    if (!Number.isSafeInteger(width) || !widths.includes(width) ||
        !Number.isSafeInteger(height) || height < 1 || Math.abs(height - Number(image.height) * width / Number(image.width)) > 1 ||
        url !== `${original.origin}${match[1]}thumbs/${match[2]}-w${width}.webp`) continue;
    output.set(width, { url, width, height });
  }
  return [...output.values()].sort((a, b) => a.width - b.width);
}

export function cmsImageSources(image: ImageInput, sizes: string): { srcset?: string; sizes?: string } {
  const thumbnails = cmsImageThumbnails(image);
  if (!thumbnails.length) return {};
  const candidates = thumbnails.map(item => `${item.url} ${item.width}w`);
  const originalWidth = Number(image.width);
  if (originalWidth > thumbnails[thumbnails.length - 1].width) {
    candidates.push(`${image.url} ${originalWidth}w`);
  }
  return { srcset: candidates.join(", "), sizes };
}

export function cmsImageSourceAttributes(image: ImageInput, sizes: string): string {
  const sources = cmsImageSources(image, sizes);
  return sources.srcset ? ` srcset="${escapeHtml(sources.srcset)}" sizes="${escapeHtml(sizes)}"` : "";
}

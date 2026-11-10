import type { MediaAssetSummary } from "./functions";
import { cachedPoster } from "./media-session-cache";
import type { SourceMediaAssetSummary } from "./source-media";

// What Quick Look shows. Images use the largest stored thumbnail (the
// server makes 480 and 960, functions/lib/media-thumbnails.js). Animated GIFs stay on the
// original, as mediaPreviewUrl does. Documents have no rendition, so they show a placeholder.

export type QuickLookImage =
  | { kind: "image"; url: string; width: number | null; height: number | null; alt: string }
  | { kind: "placeholder"; label: "PDF" | "WAV" };

export function quickLookImage(asset: MediaAssetSummary): QuickLookImage {
  if (asset.kind === "audio") return { kind: "placeholder", label: "WAV" };
  if (asset.kind === "document") return { kind: "placeholder", label: "PDF" };
  const alt = asset.altText ?? "";
  const largest = [...(asset.thumbnails ?? [])].sort((a, b) => b.width - a.width)[0];
  if (asset.mimeType === "image/gif" || asset.animated === true || !largest) {
    return { kind: "image", url: asset.url, width: asset.width, height: asset.height, alt };
  }
  return { kind: "image", url: largest.url, width: largest.width, height: largest.height, alt };
}

/**
 * A video's poster for Quick Look: the cached poster with no request, or permission for one read
 * through the card's four-at-a-time poster queue. Only a video with a ready viewing copy has a
 * poster to read, as on the card.
 */
export function quickLookPoster(asset: SourceMediaAssetSummary): { url: string | null; read: boolean } {
  if (asset.viewingCopy?.state !== "ready") return { url: null, read: false };
  const url = cachedPoster(asset.sourceId, asset.id, asset.fileVersion);
  return url ? { url, read: false } : { url: null, read: true };
}

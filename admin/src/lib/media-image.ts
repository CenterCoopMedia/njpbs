import type { MediaAssetSummary } from "./functions";

export function mediaImageSources(asset: MediaAssetSummary, displayWidth: number) {
  const thumbnails = [...(asset.thumbnails ?? [])].sort((a, b) => a.width - b.width);
  const selected = thumbnails.find(thumbnail => thumbnail.width >= displayWidth) ?? thumbnails.at(-1);
  return {
    src: selected?.url ?? asset.url,
    srcSet: thumbnails.length ? thumbnails.map(thumbnail => `${thumbnail.url} ${thumbnail.width}w`).join(", ") : undefined,
    sizes: thumbnails.length ? `${displayWidth}px` : undefined,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
  };
}

function keepsAnimation(asset: MediaAssetSummary) {
  return asset.mimeType === "image/gif" || asset.animated === true;
}

/** The smallest stored thumbnail that covers the requested frame, or the original. */
export function mediaDisplayUrl(
  asset: {
    url: string;
    thumbnails?: readonly { url: string; width: number; height?: number }[] | null;
  },
  displayWidth: number,
  displayHeight = 0,
) {
  const thumbnails = [...(asset.thumbnails ?? [])]
    .filter((item) => {
      const height = item?.height;
      return typeof item?.url === "string"
        && Number.isInteger(item.width)
        && item.width >= displayWidth
        && (displayHeight <= 0 || (typeof height === "number" && Number.isInteger(height) && height >= displayHeight));
    })
    .sort((left, right) => left.width - right.width);
  return thumbnails[0]?.url ?? asset.url;
}

function coveringThumbnails(
  asset: MediaAssetSummary,
  displayWidth: number,
  displayHeight: number,
) {
  return [...(asset.thumbnails ?? [])]
    .filter((item) => (
      typeof item?.url === "string"
      && Number.isInteger(item.width)
      && Number.isInteger(item.height)
      && item.width >= displayWidth
      && item.height >= displayHeight
    ))
    .sort((left, right) => left.width - right.width);
}

/** Props for a preview image. GIFs and multi-frame uploads stay on the original. */
export function mediaPreviewImage(
  asset: MediaAssetSummary,
  displayWidth: number,
  displayHeight = 0,
) {
  const width = asset.width ?? undefined;
  const height = asset.height ?? undefined;
  if (keepsAnimation(asset)) {
    return { src: asset.url, srcSet: undefined, sizes: undefined, width, height };
  }
  const src = mediaDisplayUrl(asset, displayWidth, displayHeight);
  if (src === asset.url) {
    return { src, srcSet: undefined, sizes: undefined, width, height };
  }
  if (displayHeight > 0) {
    const covering = coveringThumbnails(asset, displayWidth, displayHeight);
    return {
      src,
      srcSet: covering.length ? covering.map((item) => `${item.url} ${item.width}w`).join(", ") : undefined,
      sizes: covering.length ? `${displayWidth}px` : undefined,
      width,
      height,
    };
  }
  return { ...mediaImageSources(asset, displayWidth), src };
}

/** Rendered previews keep animated GIFs and other multi-frame files on the original. */
export function mediaPreviewUrl(asset: MediaAssetSummary, displayWidth: number) {
  return mediaPreviewImage(asset, displayWidth).src;
}

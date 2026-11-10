import type { PageBlock } from "../../../packages/content-core/src/content-model";
import type { ResolvedRenderAsset } from "../../../packages/content-core/src/content-render";

export type CmsImagePlacement = "content" | "grid";

export interface CmsResponsiveImageAsset {
  credit?: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
}

/** Page assets can include PDFs; hero slots accept dimensioned images only. */
export function cmsImageAsset(asset: CmsResponsiveImageAsset | undefined):
  (CmsResponsiveImageAsset & { width: number; height: number }) | undefined {
  if (!asset || !asset.mimeType.startsWith("image/") || typeof asset.width !== "number" || typeof asset.height !== "number"
    || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width <= 0 || asset.height <= 0) return undefined;
  return { ...asset, width: asset.width, height: asset.height };
}

export interface CmsResponsiveImageSource {
  type: string;
  srcset: string;
}

export interface CmsResponsiveRenderAsset extends ResolvedRenderAsset {
  mimeType: string;
  width: number;
  height: number;
  srcset?: string;
  sizes?: string;
  sources?: CmsResponsiveImageSource[];
}

type CmsImageOutputFormat = "avif" | "webp" | "jpeg" | "png";

interface CmsImageTransform {
  src: string;
  width: number;
  height: number;
  widths: number[];
  format: CmsImageOutputFormat;
}

interface CmsImageTransformResult {
  src: string;
  srcSet: {
    attribute: string;
  };
}

export type CmsImageOptimizer = (
  options: CmsImageTransform,
) => Promise<CmsImageTransformResult>;

export interface CmsResponsiveImageRequest {
  assetId: string;
  placement: CmsImagePlacement;
}

const PLACEMENT_CONTRACTS: Record<
  CmsImagePlacement,
  { widths: readonly number[]; sizes: string }
> = {
  content: {
    widths: [320, 480, 640, 960, 1280],
    sizes: "(max-width: 1184px) calc(100vw - 64px), 1120px",
  },
  grid: {
    widths: [240, 320, 480, 640],
    sizes:
      "(max-width: 560px) calc(100vw - 48px), (max-width: 1120px) calc(50vw - 32px), 320px",
  },
};

const FALLBACK_FORMATS: Readonly<Record<string, CmsImageOutputFormat>> = {
  "image/avif": "avif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

function requiredDimension(
  value: number | undefined,
  field: "width" | "height",
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`CMS responsive image ${field} must be a positive integer`);
  }
  return value as number;
}

function responsiveWidths(
  intrinsicWidth: number,
  placement: CmsImagePlacement,
): number[] {
  const fixed = PLACEMENT_CONTRACTS[placement].widths.filter(
    (width) => width <= intrinsicWidth,
  );
  const ceiling = PLACEMENT_CONTRACTS[placement].widths.at(-1) ?? intrinsicWidth;
  return [
    ...new Set([
      ...fixed,
      ...(intrinsicWidth < ceiling ? [intrinsicWidth] : []),
      ...(fixed.length === 0 ? [intrinsicWidth] : []),
    ]),
  ].sort((left, right) => left - right);
}

/**
 * Return one stable key for an asset in one layout. One asset can appear in both
 * a full-width block and a grid, so the placement is part of the cache key.
 */
export function responsiveImageKey(
  assetId: string,
  placement: CmsImagePlacement,
): string {
  return `${placement}:${assetId}`;
}

/**
 * Collect only image references that the shared page renderer can emit. The set
 * keeps repeated gallery or card references from adding duplicate build work.
 */
export function cmsResponsiveImageRequests(
  blocks: readonly PageBlock[],
): CmsResponsiveImageRequest[] {
  const requests: CmsResponsiveImageRequest[] = [];
  const seen = new Set<string>();

  const add = (assetId: string, placement: CmsImagePlacement): void => {
    if (!assetId) return;
    const key = responsiveImageKey(assetId, placement);
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ assetId, placement });
  };

  for (const block of blocks) {
    if (!block.visible) continue;
    if (block.type === "support_appeal" && block.data.backgroundImageAssetId) {
      add(block.data.backgroundImageAssetId, "grid");
      continue;
    }
    if (block.type === "image") {
      add(block.data.assetId, "content");
      continue;
    }
    if (block.type === "bio_card") {
      if (block.data.image?.assetId) add(block.data.image.assetId, "grid");
      continue;
    }
    if (block.type === "election_results") {
      for (const race of block.data.races) for (const candidate of race.candidates) if (candidate.photo) add(candidate.photo.assetId, "grid");
      continue;
    }
    if (block.type === "image_gallery") {
      for (const image of block.data.images) add(image.assetId, "grid");
      continue;
    }
    if (block.type === "card_grid") {
      for (const card of block.data.cards) {
        if (card.imageAssetId) add(card.imageAssetId, "grid");
      }
      continue;
    }
    if (block.type === "promotion_playlist") {
      for (const card of block.data.cards) add(card.imageAssetId, "grid");
    }
  }

  return requests;
}

/**
 * Build a small responsive descriptor from one immutable CMS original. GIFs
 * remain unchanged because converting them through the static image service can
 * remove animation.
 */
export async function resolveCmsResponsiveImage(
  asset: CmsResponsiveImageAsset,
  placement: CmsImagePlacement,
  optimizer: CmsImageOptimizer,
): Promise<CmsResponsiveRenderAsset> {
  const width = requiredDimension(asset.width, "width");
  const height = requiredDimension(asset.height, "height");

  if (asset.mimeType === "image/gif") {
    return {
      ...(asset.credit ? { credit: asset.credit } : {}),
      url: asset.url,
      mimeType: asset.mimeType,
      width,
      height,
    };
  }

  const fallbackFormat = FALLBACK_FORMATS[asset.mimeType];
  if (!fallbackFormat) {
    throw new Error(`Unsupported CMS image MIME type: ${asset.mimeType}`);
  }

  const widths = responsiveWidths(width, placement);
  const outputWidth = widths.at(-1);
  if (!outputWidth) throw new Error("CMS image width variants are empty");
  const outputHeight = Math.max(1, Math.round((height * outputWidth) / width));
  const formats = [...new Set<CmsImageOutputFormat>([
    "avif",
    "webp",
    fallbackFormat,
  ])];
  const transformed = new Map<
    CmsImageOutputFormat,
    CmsImageTransformResult
  >();

  await Promise.all(
    formats.map(async (format) => {
      const result = await optimizer({
        src: asset.url,
        width: outputWidth,
        height: outputHeight,
        widths,
        format,
      });
      transformed.set(format, result);
    }),
  );

  const fallback = transformed.get(fallbackFormat);
  if (!fallback) {
    throw new Error(`CMS image fallback was not generated: ${fallbackFormat}`);
  }
  // A remote URL outside the optimizer allowlist is returned unchanged. It
  // has no generated width or format variants to advertise in a picture.
  if (fallback.src === asset.url) {
    return { ...(asset.credit ? { credit: asset.credit } : {}), url: asset.url, mimeType: asset.mimeType, width, height };
  }

  return {
    ...(asset.credit ? { credit: asset.credit } : {}),
    url: fallback.src,
    mimeType: asset.mimeType,
    width,
    height,
    srcset: fallback.srcSet.attribute,
    sizes: PLACEMENT_CONTRACTS[placement].sizes,
    sources: (["avif", "webp"] as const).map((format) => {
      const source = transformed.get(format);
      if (!source) throw new Error(`CMS image source was not generated: ${format}`);
      return {
        type: `image/${format}`,
        srcset: source.srcSet.attribute,
      };
    }),
  };
}

/** Resolve every unique page reference once and fail closed on a missing asset. */
export async function resolveCmsResponsiveAssets(
  blocks: readonly PageBlock[],
  assets: Readonly<Record<string, CmsResponsiveImageAsset | undefined>>,
  optimizer: CmsImageOptimizer,
): Promise<Map<string, ResolvedRenderAsset>> {
  const entries = await Promise.all(
    cmsResponsiveImageRequests(blocks).map(async ({ assetId, placement }) => {
      const asset = assets[assetId];
      if (!asset) {
        throw new Error(`CMS responsive image asset is missing: ${assetId}`);
      }
      return [
        responsiveImageKey(assetId, placement),
        await resolveCmsResponsiveImage(asset, placement, optimizer),
      ] as const;
    }),
  );

  return new Map<string, ResolvedRenderAsset>(entries);
}


/** Posts use their immutable public originals in both static and compiled builds.
 * Build-time derivatives cannot exist for an image first published after the
 * renderer release. Keep Pages on their existing responsive optimizer. */
export function resolveCmsPostAssets(
  blocks: readonly PageBlock[],
  assets: Readonly<Record<string, CmsResponsiveImageAsset | undefined>>,
): Promise<Map<string, ResolvedRenderAsset>> {
  return resolveCmsResponsiveAssets(blocks, assets, async ({ src }) => ({ src, srcSet: { attribute: "" } }));
}

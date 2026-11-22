import type { CmsImageThumbnail } from "./cms-image-variants.ts";

interface SpotlightStoryImageInput { image?: unknown; fallbackImage?: unknown; topicSlug?: unknown; publishedAt?: unknown; href?: unknown }
interface SpotlightStoryImage { url: string; alt: string; fallbackUrl?: string }

/** Stable bundled topic artwork; undefined for unsupported topic slugs. */
export function spotlightTopicImage(topicSlug: string, publishedAt: string | undefined, seed: string): string | undefined;

/** First supported topic's bundled artwork, in source taxonomy order. */
export function spotlightTopicImageForStory(topicSlugs: readonly string[], publishedAt: string | undefined, seed: string): string | undefined;
export function spotlightImageUrl(value: unknown): string | undefined;
export function spotlightCopyImageUrl(value: unknown): string | undefined;
export function spotlightFallbackImage(value: unknown): string | undefined;
export function spotlightStoryImage(story: SpotlightStoryImageInput): SpotlightStoryImage;
export const SPOTLIGHT_CARD_IMAGE_WIDTH: number;
export function spotlightCardThumbnailUrl(original: unknown): string | undefined;
export function spotlightCardThumbnail(original: unknown, width: unknown, height: unknown, value: unknown): CmsImageThumbnail | undefined;
export function spotlightCardImage(story: SpotlightStoryImageInput & { width?: unknown; height?: unknown; thumbnails?: unknown }): SpotlightStoryImage & { width?: number; height?: number; thumbnails?: CmsImageThumbnail[] };
export function spotlightImageAttributes(url: unknown, fallbackUrl?: unknown): string;

/** Stable bundled topic artwork; undefined for unsupported topic slugs. */
export function spotlightTopicImage(topicSlug: string, publishedAt: string | undefined, seed: string): string | undefined;

/** First supported topic's bundled artwork, in source taxonomy order. */
export function spotlightTopicImageForStory(topicSlugs: readonly string[], publishedAt: string | undefined, seed: string): string | undefined;
export function spotlightImageUrl(value: unknown): string | undefined;
export function spotlightCopyImageUrl(value: unknown): string | undefined;
export function spotlightFallbackImage(value: unknown): string | undefined;
export function spotlightStoryImage(story: { image?: unknown; fallbackImage?: unknown; sourceImage?: unknown; topicSlug?: unknown; publishedAt?: unknown; href?: unknown }): { url: string; alt: string; fallbackUrl?: string };
export function spotlightImageAttributes(url: unknown, fallbackUrl?: unknown): string;

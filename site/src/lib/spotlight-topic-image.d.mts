/** Stable bundled topic artwork; undefined for unsupported topic slugs. */
export function spotlightTopicImage(topicSlug: string, publishedAt: string | undefined, seed: string): string | undefined;

/** First supported topic's bundled artwork, in source taxonomy order. */
export function spotlightTopicImageForStory(topicSlugs: readonly string[], publishedAt: string | undefined, seed: string): string | undefined;

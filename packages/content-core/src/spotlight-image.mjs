const MILLISECONDS_PER_DAY = 86_400_000;
export const SPOTLIGHT_CARD_IMAGE_WIDTH = 768;
const TOPIC_IMAGE_SUFFIXES = ["", "-02"];
const TOPIC_IMAGE_SLUGS = new Set([
  "budget",
  "business",
  "education",
  "energy-environment",
  "healthcare",
  "immigration",
  "law-public-safety",
  "more-issues",
  "nj-decides",
  "opinion",
  "politics",
  "social-issues",
  "under-the-dome",
  "watch",
]);

/** Return one of the existing stable topic-art variants for an admitted topic. */
export function spotlightTopicImage(topicSlug, publishedAt, seed) {
  if (!TOPIC_IMAGE_SLUGS.has(topicSlug)) return undefined;
  return `/brand/spotlight/${topicSlug}${TOPIC_IMAGE_SUFFIXES[topicVariantIndex(topicSlug, publishedAt, seed)]}.jpg`;
}

/** Select the first topic that owns bundled Spotlight art. */
export function spotlightTopicImageForStory(topicSlugs, publishedAt, seed) {
  for (const topicSlug of topicSlugs) {
    const image = spotlightTopicImage(topicSlug, publishedAt, seed);
    if (image) return image;
  }
  return undefined;
}

function topicVariantIndex(topicSlug, publishedAt, seed) {
  const publishedDate = new Date(publishedAt ?? "");
  if (!Number.isNaN(publishedDate.getTime())) {
    const publishedDay = Math.floor(publishedDate.getTime() / MILLISECONDS_PER_DAY);
    return (publishedDay + stableHash(topicSlug)) % TOPIC_IMAGE_SUFFIXES.length;
  }
  return stableHash(seed) % TOPIC_IMAGE_SUFFIXES.length;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Only published raster uploads on the exact Spotlight origin enter a reader. */
export function spotlightImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.origin === "https://www.njspotlightnews.org" && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith("/wp-content/uploads/") && /\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname) &&
      !/%(?:2e|2f|5c)/i.test(url.pathname) ? value : undefined;
  } catch { return undefined; }
}

export function spotlightFallbackImage(value) {
  if (typeof value !== "string") return undefined;
  return [...TOPIC_IMAGE_SLUGS].some(topic => TOPIC_IMAGE_SUFFIXES.some(suffix => value === `/brand/spotlight/${topic}${suffix}.jpg`))
    ? value : undefined;
}

/** Story cards load only immutable NJ PBS copies, never the Spotlight origin. */
export function spotlightStoryImage(story) {
  const fallback = spotlightFallbackImage(story.fallbackImage) ?? spotlightFallbackImage(story.image) ??
    spotlightTopicImage(story.topicSlug, story.publishedAt, typeof story.href === "string" ? story.href : "") ?? "/brand/spotlight/more-issues.jpg";
  const image = spotlightCopyImageUrl(story.image);
  return image ? { url: image, alt: "", fallbackUrl: fallback } : { url: fallback, alt: "" };
}

export function spotlightCopyImageUrl(value) {
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.origin === "https://media.njpbs.org" && !url.username && !url.password && !url.search && !url.hash &&
      /^\/cms-media\/spotlight\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:jpg|png|webp|avif|gif)$/.test(url.pathname) ? value : undefined;
  } catch { return undefined; }
}

export function spotlightCardThumbnailUrl(original) {
  return spotlightCopyImageUrl(original)?.replace(/\/([a-f0-9]{64})\.[a-z]+$/, `/thumbs/$1-w${SPOTLIGHT_CARD_IMAGE_WIDTH}.webp`);
}

export function spotlightCardThumbnail(original, width, height, value) {
  const url = spotlightCardThumbnailUrl(original);
  if (!url || !value || value.url !== url || value.width !== SPOTLIGHT_CARD_IMAGE_WIDTH ||
      !Number.isSafeInteger(width) || width <= value.width || !Number.isSafeInteger(height) || height < 1 ||
      width * height > 12_000_000 || !Number.isSafeInteger(value.height) || value.height < 1 ||
      Math.abs(value.height - height * value.width / width) > 1) return undefined;
  return { url, width: value.width, height: value.height };
}

/** The shelf can use a smaller source while the hero keeps the original copy. */
export function spotlightCardImage(story) {
  const image = spotlightStoryImage(story);
  const { width, height, thumbnails } = story;
  const thumbnail = spotlightCardThumbnail(image.url, width, height, Array.isArray(thumbnails) ? thumbnails[0] : undefined);
  return thumbnail ? { ...image, width, height, thumbnails: [thumbnail] } : image;
}

/** Only fixed bundled topic paths may enter the client fallback marker. */
export function spotlightImageAttributes(url, fallbackUrl) {
  const fallback = spotlightFallbackImage(fallbackUrl) ?? spotlightFallbackImage(url);
  return fallback ? ` data-spotlight-fallback="${fallback}"` : "";
}

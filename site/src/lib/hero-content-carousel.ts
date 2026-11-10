import { spotlightStoryImage } from "../../../packages/content-core/src/spotlight-image.mjs";
export const HERO_CAROUSEL_ITEM_LIMIT = 9;
export const HERO_CAROUSEL_AUTOPLAY_MS = 120_000;

export interface HeroMediaCard {
  id?: string;
  title: string;
  description: string;
  href: string;
  image?: string;
}

export interface HeroNewsCard {
  title: string;
  href: string;
  category: string;
  dateLabel?: string;
  image?: string;
  fallbackImage?: string;
}

export interface HeroContentCarouselItem {
  id: string;
  title: string;
  description: string;
  href: string;
  image?: string;
  fallbackImage?: string;
  sourceLabel: "PBS · NJ PBS" | "NJ Spotlight News";
  meta: string;
  external: boolean;
}

export interface HeroCarouselLayout {
  cardWidth: number;
  cardHeight: number;
  radius: number;
  cameraZ: number;
  arcLift: number;
  visibleAngle: number;
}

const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const isUsableLink = (href: string) => /^(?:https?:\/\/|\/(?!\/))/.test(href);

/**
 * Interleave PBS/NJ PBS programs with NJ Spotlight News instead of presenting
 * either source as a separate mini-rail. The result is deterministic so the
 * server-rendered fallback and the enhanced 3D orbit have the same order.
 */
export function composeHeroContentCarouselItems(
  mediaCards: readonly HeroMediaCard[],
  newsCards: readonly HeroNewsCard[],
  limit = HERO_CAROUSEL_ITEM_LIMIT,
): HeroContentCarouselItem[] {
  const programs = mediaCards
    .filter(
      (card) =>
        card.title.trim().length > 0 &&
        card.description.trim().length > 0 &&
        isUsableLink(card.href),
    )
    .slice(0, 6)
    .map<HeroContentCarouselItem>((card, index) => ({
      id: `program-${card.id ?? index}`,
      title: card.title,
      description: card.description,
      href: card.href,
      image: card.image,
      sourceLabel: "PBS · NJ PBS",
      meta: "Watch on demand",
      external: /^https?:\/\//.test(card.href),
    }));

  const news = newsCards
    .filter(
      (card) =>
        card.title.trim().length > 0 &&
        card.category.trim().length > 0 &&
        isUsableLink(card.href),
    )
    .slice(0, 3)
    .map<HeroContentCarouselItem>((card, index) => ({
      id: `news-${index}`,
      title: card.title,
      description: "Read the latest reporting and analysis at NJ Spotlight News.",
      href: card.href,
      image: spotlightStoryImage(card).url,
      fallbackImage: spotlightStoryImage(card).fallbackUrl ?? spotlightStoryImage(card).url,
      sourceLabel: "NJ Spotlight News",
      meta: [card.category, card.dateLabel].filter(Boolean).join(" · "),
      external: /^https?:\/\//.test(card.href),
    }));

  const interleaved: HeroContentCarouselItem[] = [];
  const longest = Math.max(programs.length, news.length);
  for (let index = 0; index < longest; index += 1) {
    if (programs[index]) interleaved.push(programs[index]);
    if (news[index]) interleaved.push(news[index]);
  }

  return interleaved.slice(0, clamp(Math.floor(limit), 1, HERO_CAROUSEL_ITEM_LIMIT));
}

export function wrapHeroCarouselIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return ((Math.round(index) % count) + count) % count;
}

export function normalizeHeroCarouselAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

/** Return the closest equivalent rotation that brings `index` to the front. */
export function nearestHeroCarouselRotation(
  currentRotation: number,
  index: number,
  count: number,
): number {
  if (count <= 0) return 0;
  const step = TAU / count;
  const canonicalTarget = -wrapHeroCarouselIndex(index, count) * step;
  return currentRotation + normalizeHeroCarouselAngle(canonicalTarget - currentRotation);
}

/**
 * A continuously fluid layout derived from the measured viewport. There is no
 * device-name switch: narrow containers converge on a three-card visual window,
 * while wider containers expose more of the orbit.
 */
export function getHeroCarouselLayout(
  viewportWidth: number,
  viewportHeight: number,
  count: number,
): HeroCarouselLayout {
  const width = clamp(viewportWidth || 0, 280, 1_600);
  const height = clamp(viewportHeight || 0, 220, 720);
  const progress = clamp((width - 320) / 1_080, 0, 1);
  const cardWidth = clamp(width * (0.74 - progress * 0.49), 216, 324);
  const cardHeight = cardWidth * 0.78;
  const step = TAU / Math.max(count, 3);
  const circumferenceRadius = (cardWidth * Math.max(count, 3)) / TAU;
  const radius = Math.max(cardWidth * 1.42, circumferenceRadius * 1.04);
  const cameraZ = radius + clamp(cardWidth * 1.88, 430, 620);
  const arcLift = clamp(height * 0.105, 18, 56);
  const visibleAngle = step * (1.42 + progress * 1.48);

  return {
    cardWidth,
    cardHeight,
    radius,
    cameraZ,
    arcLift,
    visibleAngle,
  };
}

export function heroCarouselVisibility(
  angle: number,
  visibleAngle: number,
): number {
  const distance = Math.abs(normalizeHeroCarouselAngle(angle));
  const fadeStart = visibleAngle * 0.48;
  if (distance <= fadeStart) return 1;
  if (distance >= visibleAngle) return 0;
  const linear = 1 - (distance - fadeStart) / (visibleAngle - fadeStart);
  return linear * linear * (3 - 2 * linear);
}

import { readHomeNewscastPacket } from "../../../packages/content-core/src/home-newscast-published.ts";
import { isCalendarDay, stationCalendarDay } from "../../../packages/content-core/src/editorial-dates";
import { RELATED_STORY_INDEX } from "../../../packages/content-core/src/shelf-catalog";
import { readHomeHeroCatalog, type HomeHeroCatalogItem } from "../../../packages/content-core/src/home-hero";
// Public Home inputs, projected once by the content loader for both surfaces.
import { manualLaunchCards, selectLaunchCards, type LaunchCard } from "../data/launch-fallback";
import { safeHref } from "../../../packages/content-core/src/safe-href";
import type { HomeNewsCard, HomeProgramCard, HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { spotlightTopicImageForStory } from "./spotlight-topic-image.mjs";
import { spotlightCopyImageUrl, spotlightStoryImage } from "../../../packages/content-core/src/spotlight-image.mjs";
import { spotlightCardByline } from "../../../packages/content-core/src/spotlight-byline.mjs";
import { spotlightFeedInstant } from "../../../packages/content-core/src/home-spotlight-source";
import { formatEditorialDate } from "../../../packages/content-core/src/editorial-date-format";
export type { HomeProgramCard, HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";

interface FeedInput {
  newscast?: unknown;
  checkedAt?: string;
  cards?: unknown[];
}

function sourceCard(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Home source card is invalid");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Home source text is invalid");
  return value;
}

function link(value: unknown): string {
  const href = text(value);
  if (safeHref(href) === null || !/^(https?:\/\/|\/(?!\/))/.test(href)) {
    throw new Error("Home source URL is invalid");
  }
  return href;
}

function programCard(value: unknown): HomeProgramCard {
  const card = sourceCard(value);
  return {
    title: text(card.title), description: text(card.description), href: link(card.href),
    ...(card.image ? { image: link(card.image) } : {}),
  };
}

function newsCard(value: unknown): HomeNewsCard {
  const card = sourceCard(value);
  const image = spotlightStoryImage(card);
  const dateLabel = formatEditorialDate(stationCalendarDay(spotlightFeedInstant(card.publishedAt)));
  return {
    title: text(card.title), href: link(card.href), category: text(card.category),
    image: image.url, fallbackImage: image.fallbackUrl ?? image.url,
    ...(dateLabel ? { dateLabel } : card.dateLabel === undefined ? {} : { dateLabel: text(card.dateLabel) }),
  };
}

function checkedAt(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

export function createHomeSourceSnapshot(
  media: FeedInput,
  spotlight: FeedInput,
  publication: HomeSourceSnapshot["publication"] = null,
): HomeSourceSnapshot {
  const mediaCards = (media.cards ?? []).filter(Boolean);
  // Keep the original one-pool selection and small-catalog behavior. Only public
  // presentation fields leave this module, never raw feed requests or CMS data.
  const pool = selectLaunchCards(
    mediaCards as LaunchCard[],
    manualLaunchCards,
  ).slice(0, 24).map(programCard);
  const feedStories = (spotlight.cards ?? []).map(sourceCard);
  const heroCatalog: HomeHeroCatalogItem[] = [
    ...mediaCards.slice(0, 100).flatMap(value => {
      try {
        const card = programCard(value);
        return readHomeHeroCatalog([{ id: card.href, source: "media_manager",
          title: card.title, summary: card.description, href: card.href, categories: [], tags: [], eyebrow: "PBS · NJ PBS",
          ...(card.image ? { image: { url: card.image, alt: "" } } : {}) }]);
      } catch { return []; }
    }),
    ...RELATED_STORY_INDEX.items.map(card => {
      const feedStory = feedStories.find(item => item.href === card.href);
      const byline = spotlightCardByline(feedStory);
      const displayDate = isCalendarDay(card.publishedAt) ? card.publishedAt : stationCalendarDay(card.publishedAt);
      const topicImage = spotlightTopicImageForStory(card.topics, card.publishedAt, card.href);
      return { id: card.id, source: "spotlight" as const,
        title: card.title, summary: card.summary ?? "", href: card.href, categories: [...card.topics], tags: [],
        ...(displayDate ? { displayDate } : {}),
        ...(byline ? { byline, bylineSource: "coauthors-plus" as const } : {}),
        eyebrow: card.sourceLabel, ...(feedStory && spotlightCopyImageUrl(feedStory.image) ? { image: spotlightStoryImage(feedStory) } : card.thumbnail
          ? { image: spotlightStoryImage({ image: card.thumbnail.url, topicSlug: card.topics[0], href: card.href }) }
          : feedStory ? { image: spotlightStoryImage(feedStory) }
          : topicImage ? { image: { url: topicImage, alt: "" } } : {}) };
    }),
    ...feedStories.flatMap(card => {
      try {
        const byline = spotlightCardByline(card);
        return readHomeHeroCatalog([{ id: card.href, source: "spotlight", title: card.title,
          summary: "", href: card.href, categories: Array.isArray(card.sourceCategories) ? card.sourceCategories : [], tags: [],
          ...(byline ? { byline, bylineSource: "coauthors-plus" } : {}),
          eyebrow: "NJ Spotlight News", displayDate: stationCalendarDay(spotlightFeedInstant(card.publishedAt)),
          image: spotlightStoryImage(card) }]);
      } catch { return []; }
    }),
  ];
  return {
    heroCatalog: heroCatalog.filter((card, index) => heroCatalog.findIndex(candidate => candidate.href === card.href) === index),
    schemaVersion: 1,
    publication: publication ? {
      buildBatchId: publication.buildBatchId,
      generation: publication.generation,
      commitSha: publication.commitSha,
    } : null,
    pbs: {
      ...(Object.hasOwn(media, "newscast") ? { newscast: readHomeNewscastPacket(media.newscast) } : {}),
      source: mediaCards.length ? "media-manager" : "manual",
      checkedAt: mediaCards.length ? checkedAt(media.checkedAt) : null,
      featured: mediaCards.length > 8 ? pool.slice(0, 8) : pool,
      more: mediaCards.length > 8 ? pool.slice(8, 24) : pool,
    },
    spotlight: {
      source: "spotlight-rss", checkedAt: checkedAt(spotlight.checkedAt),
      cards: (spotlight.cards ?? []).slice(0, 8).map(newsCard),
    },
  };
}

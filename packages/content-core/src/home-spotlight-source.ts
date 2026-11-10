import { stationCalendarDay } from "./editorial-dates.ts";
import { curateHomeSource, homeSourceInstant, homeSourceObject, homeSourceText,
  type HomeSourceCard, type HomeCuratedSource, type HomeSourceSelection } from "./home-source-curation.ts";
import { spotlightStoryImage } from "./spotlight-image.mjs";
import { spotlightCardByline } from "./spotlight-byline.mjs";

type SpotlightSnapshot = { status: "ready"; source: string; checkedAt: string; cards: readonly unknown[] } | { status: "error" };

export function spotlightFeedInstant(value: unknown): string | null {
  if (homeSourceInstant(value) !== null) return value as string;
  if (typeof value !== "string") return null;
  // The existing RSS source emits UTC RFC dates. Round-trip rejects impossible days and weekdays.
  const utc = value.replace(/\+0000$/, "GMT");
  const time = Date.parse(utc);
  return Number.isFinite(time) && new Date(time).toUTCString() === utc ? new Date(time).toISOString() : null;
}

/** Adapt the existing admitted RSS snapshot. Never infer Opinion or authors from a headline. */
export function adaptHomeSpotlight(snapshot: SpotlightSnapshot, selection: HomeSourceSelection): HomeCuratedSource {
  if (snapshot.status === "error") return curateHomeSource("home-spotlight", snapshot, selection);
  if (snapshot.status !== "ready" || snapshot.source !== "nj-spotlight-news-rss" || !Array.isArray(snapshot.cards)) {
    throw new Error("Keep the approved Spotlight feed source.");
  }
  const cards = snapshot.cards.flatMap((value): HomeSourceCard[] => {
    if (!homeSourceObject(value) || value.source !== "nj-spotlight-news-rss" ||
      !homeSourceText(value.title, 300) || !homeSourceText(value.href, 2048)) return [];
    const publishedAt = spotlightFeedInstant(value.publishedAt);
    if (!publishedAt) return [];
    const categories = Array.isArray(value.sourceCategories) ? value.sourceCategories : [];
    const opinion = categories.some(category => typeof category === "string" && /^(Opinion|Op-Ed)$/i.test(category.trim()));
    const image = spotlightStoryImage(value);
    const byline = spotlightCardByline(value);
    return [{ id: value.href, source: "spotlight_news", title: value.title, href: value.href,
      sourceLabel: "NJ Spotlight News", publishedAt, displayDate: stationCalendarDay(publishedAt)!,
      ...(byline ? { byline, bylineSource: "coauthors-plus" } : {}),
      ...(opinion ? { opinion: true } : {}), ...(image ? { image } : {}) }];
  });
  return curateHomeSource("home-spotlight", { status: "ready", checkedAt: snapshot.checkedAt, cards }, selection);
}

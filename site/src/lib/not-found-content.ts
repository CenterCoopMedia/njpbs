import { contentLinkMetadata, type ContentLinkMetadata } from "../../../packages/content-core/src/content-link.ts";
import { isCalendarDay, stationCalendarDay } from "../../../packages/content-core/src/editorial-dates.ts";
import { adaptHomeStationPosts } from "../../../packages/content-core/src/home-station-posts-source.ts";
import { HOME_NEWSCAST_PROGRAM_HREF, isNewscastTitle,
  type HomeNewscastSource } from "../../../packages/content-core/src/home-newscast-source.ts";
import { resolveHomeNewscastPacket, resolvePublishedHomeNewscast } from "../../../packages/content-core/src/home-newscast-published.ts";
import { curateHomeSource, homeSourceInstant, homeSourceObject, type HomeSourceCard, type HomeCardSnapshot } from "../../../packages/content-core/src/home-source-curation.ts";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render.ts";

export interface RecoveryCard extends ContentLinkMetadata {
  slot: "newscast" | "station-story" | "spotlight-story";
  sourceLabel: "NJ PBS News" | "NJ Spotlight News";
  title: string;
  href: string;
  kind: string;
  action: string;
  image?: string;
  imageFallback?: string;
  date?: string;
  fallback: boolean;
}

const NEWS_LABELS = new Set(["nj pbs news", "njpbs news", "nj pbs news with rob nelson"]);
const normalized = (label: string) => label.toLowerCase().trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

/** Only explicitly classified station news enters this slot. A generic station
 * post, an imported Spotlight story and a full newscast are not substitutes. */
function isStationNews(post: unknown, cutoff: number, day: string): boolean {
  if (!homeSourceObject(post) || post.spotlightNews === true || isNewscastTitle(post.title)) return false;
  // An editorial/backdated display day cannot make a not-yet-published story
  // eligible. Legacy projections may have no first-publication timestamp.
  if (post.firstPublishedAt != null) {
    const firstPublished = homeSourceInstant(post.firstPublishedAt);
    if (firstPublished === null || firstPublished > cutoff) return false;
  }
  if (post.sortInstant != null && (typeof post.sortInstant !== "number" || !Number.isFinite(post.sortInstant) || post.sortInstant > cutoff)) return false;
  if (isCalendarDay(post.displayDate) && post.displayDate > day) return false;
  return [post.categories, post.tags].some(values => Array.isArray(values) &&
    values.some(value => typeof value === "string" && NEWS_LABELS.has(normalized(value))));
}

function spotlightSnapshot(sources: HomeSourceSnapshot | null | undefined): HomeCardSnapshot {
  // An admitted current empty/error catalog is authoritative. Never resurrect
  // a story from the older legacy feed when it has been removed from this one.
  if (sources?.editorial) return sources.editorial.catalog.sources["home-spotlight"];
  if (!sources?.spotlight.checkedAt) return { status: "error" };
  const heroes = sources.heroCatalog?.filter(card => card.source === "spotlight") ?? [];
  const cards: HomeSourceCard[] = sources.spotlight.cards.map(card => {
    const hero = heroes.find(item => item.href === card.href);
    return { id: card.href, source: "spotlight_news", href: card.href,
      title: card.title, sourceLabel: "NJ Spotlight News",
      ...(hero?.displayDate ? { displayDate: hero.displayDate } : {}),
      ...(card.image ? { image: { url: card.image, alt: "", ...(card.fallbackImage ? { fallbackUrl: card.fallbackImage } : {}) } } : {}) };
  });
  return { status: "ready", checkedAt: sources.spotlight.checkedAt, cards };
}

/** Three fixed sources in a stable order. Inputs must be the admitted
 * public build projections, never a working CMS document or a test fixture.
 * This function does not fetch, publish or broaden a source's admission. */
export function selectNotFoundCards(input: {
  posts: readonly unknown[];
  sources?: HomeSourceSnapshot | null;
  cutoffAt: string;
  newscast?: HomeNewscastSource;
  newsIndexAvailable?: boolean;
}): RecoveryCard[] {
  const cutoff = Date.parse(input.cutoffAt);
  const day = stationCalendarDay(input.cutoffAt);
  if (!Number.isFinite(cutoff) || !day) throw new Error("A valid recovery content cutoff is required.");
  // Prefer the admitted Home service; catalogs without it can still carry the
  // closed PBS packet. Recheck either source's rights at this recovery cutoff.
  const newscast = input.newscast ?? input.sources?.editorial?.catalog.services?.newscast ??
    (input.sources?.pbs.newscast ? resolveHomeNewscastPacket(input.sources.pbs.newscast, input.cutoffAt) : undefined);
  const broadcast = newscast ? resolvePublishedHomeNewscast(newscast, input.cutoffAt).episode : null;
  const news = adaptHomeStationPosts({ status: "ready", checkedAt: input.cutoffAt,
    posts: input.posts.filter(post => isStationNews(post, cutoff, day)) },
  { cutoffAt: input.cutoffAt }).cards[0];
  const snapshot = spotlightSnapshot(input.sources);
  const ordered: HomeCardSnapshot = snapshot.status === "ready" ? { ...snapshot, cards: [...snapshot.cards]
    .filter(card => !card.displayDate || isCalendarDay(card.displayDate) && card.displayDate <= day)
    .sort((a, b) => {
      const timestamp = (card: HomeSourceCard) => {
        const instant = card.publishedAt ? Date.parse(card.publishedAt) : NaN;
        return Number.isFinite(instant) ? instant : isCalendarDay(card.displayDate)
          ? Date.parse(`${card.displayDate}T00:00:00Z`) : -Infinity;
      };
      // Keep full timestamp precision. Stable ties retain provider order.
      return timestamp(b) - timestamp(a) || 0;
    }) } : snapshot;
  const spotlight = curateHomeSource("home-spotlight", ordered, { cutoffAt: input.cutoffAt }).cards[0];
  return [
    broadcast ? { slot: "newscast", sourceLabel: "NJ PBS News", title: broadcast.title,
      href: broadcast.href, image: broadcast.poster.url, ...(broadcast.episodeDate ? { date: broadcast.episodeDate } : {}),
      kind: "Full newscast", action: "Watch the broadcast", fallback: false }
      : { slot: "newscast", sourceLabel: "NJ PBS News", title: "NJ PBS News with Rob Nelson",
        href: HOME_NEWSCAST_PROGRAM_HREF, kind: "Full newscasts", action: "Browse broadcasts", fallback: true },
    news ? { slot: "station-story", sourceLabel: "NJ PBS News", title: news.title, href: news.href, ...contentLinkMetadata({ ...news }),
      ...(news.image ? { image: news.image.url } : {}), ...(news.displayDate ? { date: news.displayDate } : {}),
      kind: "News story", action: "Read the story", fallback: false }
      : { slot: "station-story", sourceLabel: "NJ PBS News", title: "Find more from NJ PBS News",
        href: input.newsIndexAvailable ? "/posts/" : "/", kind: "Station reporting",
        action: input.newsIndexAvailable ? "Browse posts" : "Go to NJ PBS", fallback: true },
    spotlight ? { slot: "spotlight-story", sourceLabel: "NJ Spotlight News", title: spotlight.title, href: spotlight.href,
      ...(spotlight.image ? { image: spotlight.image.url, imageFallback: spotlight.image.fallbackUrl ?? spotlight.image.url } : {}), ...(spotlight.displayDate ? { date: spotlight.displayDate } : {}),
      kind: "News article", action: "Read at NJ Spotlight News", fallback: false }
      : { slot: "spotlight-story", sourceLabel: "NJ Spotlight News", title: "More New Jersey reporting",
        href: "https://www.njspotlightnews.org/", kind: "News articles", action: "Visit NJ Spotlight News", fallback: true },
  ];
}

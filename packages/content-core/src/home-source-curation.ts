import { contentLinkError, contentLinkMetadata, type ContentLinkMetadata } from "./content-link.ts";
import { cmsImageThumbnails, type CmsImageThumbnail } from "./cms-image-variants.ts";
import { isCoverageLabelId } from "./coverage-label-id.ts";
import { isCalendarDay } from "./editorial-dates.ts";
import { isExactHttpsUrl } from "./exact-https-url.ts";
import { isCmsImageUrl } from "./media-origin.ts";
import { parsePublishInstant } from "./publish-instant.ts";
import { spotlightCopyImageUrl, spotlightFallbackImage, spotlightStoryImage } from "./spotlight-image.mjs";

export const HOME_SOURCE_LOCKS = {
  "home-featured": { source: "pbs_featured", cap: 8, browseHref: "https://watch.njpbs.org/" },
  "home-more": { source: "pbs_more", cap: 16, browseHref: "https://watch.njpbs.org/" },
  "home-spotlight": { source: "spotlight_news", cap: 8, browseHref: "https://www.njspotlightnews.org/" },
  "home-posts": { source: "station_posts", cap: 24, browseHref: "/posts/" },
} as const;
export type HomeSourceSection = keyof typeof HOME_SOURCE_LOCKS;
export type HomeCardSource = (typeof HOME_SOURCE_LOCKS)[HomeSourceSection]["source"];

export interface HomeSourceImage { url: string; alt: string; fallbackUrl?: string; width?: number; height?: number; thumbnails?: CmsImageThumbnail[] }
export interface HomeSourceCard extends ContentLinkMetadata {
  id: string;
  source: HomeCardSource;
  title: string;
  href: string;
  summary?: string;
  image?: HomeSourceImage;
  sourceLabel?: string;
  coverageLabelId?: string;
  byline?: string;
  bylineSource?: "coauthors-plus";
  publishedAt?: string;
  sourceVersion?: number;
  displayDate?: string;
  opinion?: true;
}
export type HomeCardSnapshot =
  | { status: "ready"; checkedAt: string; cards: readonly HomeSourceCard[] }
  | { status: "error" };
export interface HomeSourceSelection { cutoffAt: string; selectedIds?: readonly string[]; limit?: number }
export interface HomeCuratedSource {
  section: HomeSourceSection;
  source: HomeCardSource;
  browseHref: string;
  cutoffAt: string;
  checkedAt: string | null;
  cards: HomeSourceCard[];
  missingIds: string[];
  emptyReason: "source_empty" | "selection_unavailable" | "source_error" | null;
}

export function homeSourceText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !!value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}
export function homeSourceObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function homeSourceInstant(value: unknown): number | null {
  return typeof value === "string" ? parsePublishInstant(value) : null;
}
/** Frozen trusted artwork only; no temporary signed URLs or arbitrary remote hosts. */
export function homeSourceImage(value: unknown): HomeSourceImage | undefined {
  if (!homeSourceObject(value) || typeof value.alt !== "string" || value.alt.length > 1000 ||
    typeof value.url !== "string" || /[\\\u0000-\u0020\u007f]/.test(value.url)) return undefined;
  const local = /^\/brand\/[A-Za-z0-9_./-]+$/.test(value.url) && !value.url.split("/").includes("..");
  if (spotlightCopyImageUrl(value.url)) return { url: value.url, alt: value.alt,
    fallbackUrl: spotlightFallbackImage(value.fallbackUrl) ?? "/brand/spotlight/more-issues.jpg" };
  if (!local && (!isExactHttpsUrl(value.url, 2048) || !(() => {
    const url = new URL(value.url);
    return isCmsImageUrl(url) || url.origin === "https://image.pbs.org" && !url.search && !url.hash;
  })())) return undefined;
  const thumbnails = cmsImageThumbnails(value);
  return { url: value.url, alt: value.alt,
    ...(thumbnails.length ? { width: Number(value.width), height: Number(value.height), thumbnails } : {}) };
}
function sourceHref(source: HomeCardSource, href: unknown): href is string {
  if (source === "station_posts") return typeof href === "string" && /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(href);
  if (!isExactHttpsUrl(href, 2048) || href.includes("\\")) return false;
  const url = new URL(href);
  return !url.search && !url.hash && url.origin === (source === "spotlight_news"
    ? "https://www.njspotlightnews.org" : "https://watch.njpbs.org") && url.pathname !== "/";
}
function publicCard(value: unknown, source: HomeCardSource, cutoff: number): HomeSourceCard | null {
  if (!homeSourceObject(value) || value.source !== source || !homeSourceText(value.id, 2048) ||
    !homeSourceText(value.title, 300) || !(sourceHref(source, value.href) || source === "station_posts" && value.contentLinkMode === "custom" && !contentLinkError(value) && value.href === new URL(value.contentLinkUrl as string).href)) return null;
  if (value.publishedAt !== undefined && (homeSourceInstant(value.publishedAt) === null ||
    homeSourceInstant(value.publishedAt)! > cutoff)) return null;
  const image = source === "spotlight_news"
    ? spotlightStoryImage({ image: homeSourceObject(value.image) ? value.image.url : undefined,
      fallbackImage: homeSourceObject(value.image) ? value.image.fallbackUrl : undefined }) : homeSourceImage(value.image);
  return { id: value.id, source, title: value.title, href: value.href as string,
    ...(source === "station_posts" ? contentLinkMetadata(value) : {}),
    ...(homeSourceText(value.summary, 10000) ? { summary: value.summary } : {}),
    ...(source === "station_posts" && isCoverageLabelId(value.coverageLabelId) ? { coverageLabelId: value.coverageLabelId } : {}),
    ...(homeSourceText(value.sourceLabel, 200) ? { sourceLabel: value.sourceLabel } : {}),
    ...(homeSourceText(value.byline, 2000) ? { byline: value.byline } : {}),
    ...(source === "spotlight_news" && value.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" as const } : {}),
    ...(typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {}),
    ...(Number.isSafeInteger(value.sourceVersion) && Number(value.sourceVersion) > 0 ? { sourceVersion: Number(value.sourceVersion) } : {}),
    ...(isCalendarDay(value.displayDate) ? { displayDate: value.displayDate } : {}),
    ...(value.opinion === true ? { opinion: true } : {}), ...(image ? { image } : {}) };
}

/** Source adapters supply admitted, frozen cards. Manual IDs never supply copy or widen the source. */
export function curateHomeSource(section: HomeSourceSection, snapshot: HomeCardSnapshot,
  selection: HomeSourceSelection): HomeCuratedSource {
  const lock = Object.hasOwn(HOME_SOURCE_LOCKS, section) ? HOME_SOURCE_LOCKS[section] : undefined;
  const cutoff = homeSourceInstant(selection?.cutoffAt);
  if (!lock || cutoff === null || Object.keys(selection).some(key => !["cutoffAt", "selectedIds", "limit"].includes(key))) {
    throw new Error("Home source selection is invalid.");
  }
  const limit = selection.limit ?? lock.cap;
  if (![3, 4, 6, 8, 12, 16, 24].includes(limit) || limit > lock.cap) throw new Error("Home source limit is invalid.");
  const ids = selection.selectedIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > limit ||
    ids.some(id => !homeSourceText(id, 2048)) || new Set(ids).size !== ids.length)) {
    throw new Error("Home source card selection is invalid.");
  }
  const result: HomeCuratedSource = { section, source: lock.source, browseHref: lock.browseHref, cutoffAt: selection.cutoffAt,
    checkedAt: null, cards: [], missingIds: [], emptyReason: "source_error" };
  if (snapshot.status === "error") return result;
  const checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || checked === null || checked > cutoff || !Array.isArray(snapshot.cards)) {
    throw new Error("Home source receipt is invalid.");
  }
  const admitted = snapshot.cards.flatMap(value => {
    const card = publicCard(value, lock.source, cutoff);
    return card ? [card] : [];
  });
  // Ambiguous IDs cannot be curated; selecting one must never depend on input order.
  const counts = new Map<string, number>();
  for (const card of admitted) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  const eligible = admitted.filter(card => counts.get(card.id) === 1);
  const byId = new Map(eligible.map(card => [card.id, card]));
  const selected = ids === undefined ? eligible : ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  return { section, source: lock.source, browseHref: lock.browseHref, cutoffAt: selection.cutoffAt,
    checkedAt: snapshot.checkedAt, cards: selected.slice(0, limit),
    missingIds: ids?.filter(id => !byId.has(id)) ?? [],
    emptyReason: selected.length ? null : ids !== undefined ? "selection_unavailable" : "source_empty" };
}

/** A warning input for the editor; duplicates do not rewrite either source's selections. */
export function homeSourceDuplicates(sources: readonly HomeCuratedSource[]): { href: string; sections: string[] }[] {
  const seen = new Map<string, Set<string>>();
  for (const source of sources) for (const card of source.cards) {
    const sections = seen.get(card.href) ?? new Set<string>();
    sections.add(source.section); seen.set(card.href, sections);
  }
  return [...seen].filter(([, sections]) => sections.size > 1)
    .map(([href, sections]) => ({ href, sections: [...sections] }));
}

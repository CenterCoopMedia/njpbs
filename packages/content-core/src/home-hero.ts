import { contentLink, contentLinkMetadata, type ContentLinkMetadata } from "./content-link.ts";
import { cmsImageThumbnails, type CmsImageThumbnail } from "./cms-image-variants.ts";
import { isCoverageLabelId } from "./coverage-label-id.ts";
import { isCalendarDay } from "./editorial-dates.ts";
import { parsePublishInstant } from "./publish-instant.ts";
import { safeHref } from "./safe-href.ts";
import { spotlightStoryImage } from "./spotlight-image.mjs";
import { spotlightCardByline } from "./spotlight-byline.mjs";

export const HOME_HERO_LIMIT = 10;
export const HOME_HERO_PIN_LIMIT = 3;
export interface HomeHeroPin {
  source: "cms_posts" | "cms_pages";
  sourceId: string;
  /** UTC instant, edited in Eastern time. Omission pins until removed. */
  endsAt?: string;
}
export const HOME_HERO_TAG_LIMIT = 20;
export const HOME_HERO_TAG_MAX_LENGTH = 200;
export const HOME_HERO_SOURCES = ["cms_posts", "media_manager", "spotlight"] as const;
export type HomeHeroSource = (typeof HOME_HERO_SOURCES)[number];
export const HOME_HERO_PRESENTATIONS = ["carousel", "editorial"] as const;
export type HomeHeroPresentation = (typeof HOME_HERO_PRESENTATIONS)[number];
export const HOME_HERO_SUPPORTING_COUNTS = [1, 2, 3] as const;
export const HOME_HERO_HEADING_MAX_LENGTH = 120;
export const HOME_HERO_ACTION_MAX_LENGTH = 80;
export interface HomeHeroManualItem {
  itemId: string;
  title: string;
  summary: string;
  href: string;
  /** Blank or omitted text uses the story type's default action. */
  actionLabel?: string;
  imageAssetId?: string;
  alt?: string;
  altDecorative?: boolean;
  source?: HomeHeroSource;
  sourceId?: string;
}
export interface HomeHeroConfig {
  mode: "manual" | "category" | "tag";
  /** Omission preserves the existing carousel. Editorial shows every resolved item. */
  presentation?: HomeHeroPresentation;
  /** Editorial secondary-story count; remaining selections stay visible below. */
  supportingCount?: (typeof HOME_HERO_SUPPORTING_COUNTS)[number];
  /** Blank copy is retained while editing; the renderer uses its default heading. */
  leadHeading?: string;
  supportingHeading?: string;
  overflowHeading?: string;
  source?: HomeHeroSource;
  value?: string;
  /** Tag mode matches any value. Legacy single-value selections stay readable. */
  values?: string[];
  limit?: number;
  items?: HomeHeroManualItem[];
  /** Category/tag mode only; the first eligible pin is the lead. */
  pins?: HomeHeroPin[];
}
export interface HomeHeroCard extends ContentLinkMetadata {
  id: string;
  title: string;
  summary: string;
  href: string;
  actionLabel?: string;
  eyebrow?: string;
  /** Frozen source attribution; never authored in the hero settings. */
  byline?: string;
  /** Native publication attribution from the admitted destination Post. */
  spotlightNews?: boolean;
  coverageLabelId?: string;
  displayDate?: string;
  image?: { url: string; width?: number; height?: number; alt?: string; fallbackUrl?: string; thumbnails?: CmsImageThumbnail[] };
}
export interface HomeHeroCatalogItem extends HomeHeroCard {
  source: HomeHeroSource | "cms_pages";
  showInHomeHero?: boolean;
  bylineSource?: "coauthors-plus";
  categories: readonly string[];
  tags: readonly string[];
}
export const HOME_HERO_SOURCE_CAPABILITIES = {
  cms_posts: { label: "Published posts", category: true, tag: true },
  media_manager: { label: "PBS Media Manager", category: false, tag: false },
  spotlight: { label: "NJ Spotlight News", category: true, tag: false },
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Home hero must be an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) throw new Error(`Home hero ${field} is invalid.`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Home hero has unsupported fields.");
}
export function homeHeroHref(value: string): boolean {
  if (safeHref(value) !== value || /[\u0000-\u0020\u007f\\]/.test(value) || !/^(https?:\/\/|\/(?!\/))/.test(value)) return false;
  if (!value.startsWith("/") && !/^https?:\/\/[^/?#]/.test(value)) return false;
  try {
    const url = new URL(value, "https://njpbs.org");
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function homeHeroIsVideo(item: Pick<HomeHeroManualItem, "source" | "href">): boolean {
  if (item.source === "media_manager") return true;
  return homeHeroHref(item.href) && new URL(item.href, "https://njpbs.org").hostname === "watch.njpbs.org";
}
export function parseHomeHero(value: unknown): HomeHeroConfig | undefined {
  if (value === undefined) return undefined;
  const config = object(value);
  keys(config, ["mode", "source", "value", "values", "limit", "items", "pins", "presentation", "supportingCount", "leadHeading", "supportingHeading", "overflowHeading"]);
  if (!["manual", "category", "tag"].includes(String(config.mode))) throw new Error("Choose a Home hero selection mode.");
  if (config.presentation !== undefined && !HOME_HERO_PRESENTATIONS.includes(config.presentation as HomeHeroPresentation)) throw new Error("Choose a supported Home hero presentation.");
  if (config.supportingCount !== undefined && !HOME_HERO_SUPPORTING_COUNTS.includes(config.supportingCount as 1 | 2 | 3)) throw new Error("Choose one, two or three supporting stories.");
  text(config.leadHeading, "lead heading", HOME_HERO_HEADING_MAX_LENGTH);
  text(config.supportingHeading, "supporting heading", HOME_HERO_HEADING_MAX_LENGTH);
  text(config.overflowHeading, "overflow heading", HOME_HERO_HEADING_MAX_LENGTH);
  if (config.limit !== undefined && (!Number.isInteger(config.limit) || Number(config.limit) < 1 || Number(config.limit) > HOME_HERO_LIMIT)) throw new Error("Home hero supports one to ten slides.");
  if (config.mode !== "manual") {
    if (config.pins !== undefined) {
      if (!Array.isArray(config.pins) || config.pins.length > HOME_HERO_PIN_LIMIT) throw new Error("Home hero supports up to three pins.");
      const seen = new Set<string>();
      for (const value of config.pins) {
        const pin = object(value);
        keys(pin, ["source", "sourceId", "endsAt"]);
        if (!["cms_posts", "cms_pages"].includes(String(pin.source)) || typeof pin.sourceId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(pin.sourceId) || (pin.source === "cms_pages" && pin.sourceId === "home")) {
          throw new Error("Home hero pins must reference a Post or Page.");
        }
        const identity = `${pin.source}:${pin.sourceId}`;
        if (seen.has(identity)) throw new Error("Home hero pins must be unique.");
        seen.add(identity);
        if (pin.endsAt !== undefined && (typeof pin.endsAt !== "string" || parsePublishInstant(pin.endsAt) === null)) throw new Error("Home hero pin end time must be a UTC instant.");
      }
    }
    if (!HOME_HERO_SOURCES.includes(config.source as HomeHeroSource) || config.items !== undefined) throw new Error("Home hero source is invalid.");
    const source = config.source as HomeHeroSource;
    if (!HOME_HERO_SOURCE_CAPABILITIES[source][config.mode as "category" | "tag"]) throw new Error("This Home hero source does not provide that classification.");
    if (config.mode === "tag" && config.values !== undefined) {
      if (config.value !== undefined) throw new Error("Home hero tags cannot use both a list and a single value.");
      if (!Array.isArray(config.values) || config.values.length < 1 || config.values.length > HOME_HERO_TAG_LIMIT) {
        throw new Error(`Home hero tags: Add one to ${HOME_HERO_TAG_LIMIT} tags.`);
      }
      const seen = new Set<string>();
      for (const tag of config.values) {
        if (typeof tag !== "string" || !tag || tag !== tag.trim() || tag.length > HOME_HERO_TAG_MAX_LENGTH || seen.has(tag)) {
          throw new Error(`Home hero tags must be unique, trimmed text of one to ${HOME_HERO_TAG_MAX_LENGTH} characters.`);
        }
        seen.add(tag);
      }
    } else {
      if (config.values !== undefined) throw new Error("Home hero tag lists belong only to tag mode.");
      text(config.value, "classification", 200, true);
    }
    return { ...config } as unknown as HomeHeroConfig;
  }
  if (config.pins !== undefined || config.source !== undefined || config.value !== undefined || config.values !== undefined || !Array.isArray(config.items) || config.items.length > HOME_HERO_LIMIT) throw new Error("Home hero manual selection is invalid.");
  const seen = new Set<string>();
  const items = config.items.map(value => {
    const item = object(value);
    keys(item, ["itemId", "title", "summary", "href", "imageAssetId", "alt", "altDecorative", "source", "sourceId", "actionLabel"]);
    const id = text(item.itemId, "slide id", 200, true)!;
    if (seen.has(id)) throw new Error("Home hero slide ids must be unique.");
    seen.add(id);
    const bound = item.source !== undefined || item.sourceId !== undefined;
    if (bound) {
      if (!HOME_HERO_SOURCES.includes(item.source as HomeHeroSource)) throw new Error("Home hero slide source is invalid.");
      text(item.sourceId, "source item", item.source === "cms_posts" ? 128 : 2048, true);
      if (item.source === "cms_posts" && !/^[A-Za-z0-9_-]+$/.test(String(item.sourceId))) throw new Error("Home hero Post source id is invalid.");
    }
    text(item.title, "title", 300, !bound);
    text(item.summary, "summary", 2000);
    text(item.actionLabel, "button text", HOME_HERO_ACTION_MAX_LENGTH);
    if (typeof item.actionLabel === "string" && /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(item.actionLabel)) {
      throw new Error("Home hero button text must be plain text on one line.");
    }
    const href = text(item.href, "destination", 2048, !bound) ?? "";
    if (href.trim() && !homeHeroHref(href)) throw new Error("Home hero destination must be a web address or site path.");
    text(item.imageAssetId, "image", 128);
    if (item.imageAssetId && !/^[A-Za-z0-9_-]+$/.test(String(item.imageAssetId))) throw new Error("Home hero image must be a station media id.");
    text(item.alt, "image description", 1000);
    if (item.altDecorative !== undefined && typeof item.altDecorative !== "boolean") throw new Error("Home hero decorative image choice is invalid.");
    if (item.altDecorative && item.alt) throw new Error("A decorative Home hero image must have an empty description.");
    return { ...item, title: item.title ?? "", summary: item.summary ?? "", href } as unknown as HomeHeroManualItem;
  });
  return {
    mode: "manual",
    ...(config.limit === undefined ? {} : { limit: Number(config.limit) }),
    ...(config.presentation === undefined ? {} : { presentation: config.presentation as HomeHeroPresentation }),
    ...(config.supportingCount === undefined ? {} : { supportingCount: config.supportingCount as 1 | 2 | 3 }),
    ...(config.leadHeading === undefined ? {} : { leadHeading: config.leadHeading as string }),
    ...(config.supportingHeading === undefined ? {} : { supportingHeading: config.supportingHeading as string }),
    ...(config.overflowHeading === undefined ? {} : { overflowHeading: config.overflowHeading as string }),
    items,
  };
}
export function homeHeroAssetIds(value: unknown): string[] {
  return [...new Set((parseHomeHero(value)?.items ?? []).map(item => item.imageAssetId).filter((id): id is string => Boolean(id)))];
}
/** Paired publication regenerates Home when a pinned Page changes, or an end
 * time has passed by this normal publication/refresh's frozen rendering clock. */
export function homeHeroNeedsPageRefresh(value: unknown, changedPageIds: readonly string[], now: number): boolean {
  const config = parseHomeHero(value);
  return (config?.pins ?? []).some(pin => (pin.source === "cms_pages" && changedPageIds.includes(pin.sourceId)) ||
    (pin.endsAt !== undefined && parsePublishInstant(pin.endsAt)! <= now));
}
/** Inputs must already be frozen public projections. This resolver never fetches. */
export function resolveHomeHero(
  value: unknown,
  catalog: readonly HomeHeroCatalogItem[],
  assets: Readonly<Record<string, HomeHeroCard["image"]>> = {},
  now = Date.now(),
): HomeHeroCard[] {
  const config = parseHomeHero(value);
  if (!config) return [];
  // Retained catalogs can predate the explicit co-author field. A display name
  // alone cannot distinguish a writer from a posting account with a full name.
  const sources = catalog.map(card => card.source === "spotlight"
    ? { ...card, byline: spotlightCardByline(card) } : card);
  const limit = config.limit ?? HOME_HERO_LIMIT;
  const cards: HomeHeroCard[] = config.mode === "manual" ? (config.items ?? []).flatMap<HomeHeroCard>(item => {
    const source = item.source ? sources.find(card => card.source === item.source && card.id === item.sourceId) : undefined;
    // Native withdrawal is verified. Rotating provider-feed absence keeps the saved copy.
    if (item.source === "cms_posts" && !source) return [];
    const nativePost = sources.find(card => card.source === "cms_posts" && card.href === item.href);
    const datedSource = source ?? nativePost;
    const creditedSource = item.source === "cms_posts" || !item.href.trim() || source?.href === item.href ? source : nativePost;
    const image = item.imageAssetId ? assets[item.imageAssetId] : source?.image;
    const destination = source?.contentLinkMode === "custom" ? source : nativePost;
    const href = destination?.contentLinkMode === "custom" ? contentLink(destination, destination.href).href : item.href.trim() ? item.href : source?.href ?? item.href;
    const actionLabel = item.actionLabel?.trim() || (homeHeroIsVideo({ source: item.source, href }) ? "Watch the report" : undefined);
    return [{ id: item.itemId,
      title: item.title.trim() ? item.title : source?.title ?? item.title,
      summary: item.summary.trim() ? item.summary : source?.summary ?? item.summary,
      href,
      ...(destination || source ? contentLinkMetadata((destination ?? source) as unknown as Record<string, unknown>) : {}),
      ...(creditedSource?.byline ? { byline: creditedSource.byline } : {}),
      ...(datedSource?.displayDate ? { displayDate: datedSource.displayDate } : {}),
      ...(source?.eyebrow ? { eyebrow: source.eyebrow } : {}),
      ...(actionLabel ? { actionLabel } : {}),
      ...((item.source === "cms_posts" ? source : nativePost)?.coverageLabelId ? { coverageLabelId: (item.source === "cms_posts" ? source : nativePost)!.coverageLabelId } : {}),
      ...((item.source === "cms_posts" ? source : nativePost)?.spotlightNews === true ? { spotlightNews: true } : {}),
      ...(image ? { image: { ...image, ...(item.imageAssetId ? { alt: item.altDecorative ? "" : item.alt ?? "" } : {}) } } : {}) }];
  }) : [...(config.pins ?? []).flatMap(pin => {
    if (pin.endsAt !== undefined && parsePublishInstant(pin.endsAt)! <= now) return [];
    // Only current public projections are supplied. Missing/withdrawn content
    // never falls back to a saved headline or URL.
    const card = sources.find(item => item.source === pin.source && item.id === pin.sourceId);
    return card ? [card] : [];
  }), ...sources.filter(item => {
    if (item.source !== config.source) return false;
    if (config.mode === "category") return item.categories.includes(config.value!);
    return (item.source === "cms_posts" && item.showInHomeHero === true) ||
      (config.values ?? [config.value!]).some(tag => item.tags.includes(tag));
  })];
  const seen = new Set<string>();
  return cards.map(card => ({ ...card, href: contentLink(card, card.href).href })).filter(card => {
    if (!card.title.trim() || !homeHeroHref(card.href) || seen.has(card.href)) return false;
    seen.add(card.href);
    return true;
  }).slice(0, limit).map(({ id, title, summary, href, eyebrow, image, displayDate, spotlightNews, coverageLabelId, byline, actionLabel, ...linkSettings }) => ({ id, title, summary, href,
      ...contentLinkMetadata(linkSettings),
      ...(byline?.trim() ? { byline } : {}),
      ...(actionLabel ? { actionLabel } : {}),
      ...(spotlightNews === true ? { spotlightNews: true } : {}),
      ...(isCoverageLabelId(coverageLabelId) ? { coverageLabelId } : {}),
      ...(isCalendarDay(displayDate) ? { displayDate } : {}),
      ...(eyebrow ? { eyebrow } : {}), ...(image && homeHeroHref(image.url) ? { image } : {}) }));
}

/** Validate the public source projection before an editor uses it. */
export function readHomeHeroCatalog(value: unknown): HomeHeroCatalogItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error("Home hero source catalog is invalid.");
  return value.map(value => {
    const item = object(value);
    if (item.source !== "cms_pages" && !HOME_HERO_SOURCES.includes(item.source as HomeHeroSource)) throw new Error("Home hero catalog source is invalid.");
    const id = text(item.id, "source id", 2048, true)!;
    const title = text(item.title, "source title", 300, true)!;
    const summary = text(item.summary, "source summary", 10000) ?? "";
    const href = text(item.href, "source destination", 2048, true)!;
    if (item.showInHomeHero !== undefined && typeof item.showInHomeHero !== "boolean") throw new Error("Home hero source selection must be a boolean.");
    if (!homeHeroHref(href)) throw new Error("Home hero source destination is invalid.");
    const labels = (value: unknown): string[] => {
      if (!Array.isArray(value) || value.length > 100) throw new Error("Home hero source classification is invalid.");
      return value.map(label => text(label, "source classification", 200, true)!);
    };
    let image: HomeHeroCard["image"];
    if (item.image !== undefined) {
      const raw = object(item.image);
      if (item.source === "spotlight") {
        image = spotlightStoryImage({ image: raw.url, fallbackImage: raw.fallbackUrl,
          topicSlug: Array.isArray(item.categories) ? item.categories[0] : undefined, href });
      } else {
        const url = text(raw.url, "source image", 2048, true)!;
        if (!homeHeroHref(url)) throw new Error("Home hero source image is invalid.");
        const thumbnails = cmsImageThumbnails(raw);
        image = { url, alt: text(raw.alt, "source image description", 1000) ?? "",
          ...(Number.isSafeInteger(raw.width) && Number(raw.width) > 0 ? { width: Number(raw.width) } : {}),
          ...(Number.isSafeInteger(raw.height) && Number(raw.height) > 0 ? { height: Number(raw.height) } : {}),
          ...(thumbnails.length ? { thumbnails } : {}) };
      }
    }
    return { id, title, summary, href, source: item.source as HomeHeroCatalogItem["source"],
      ...contentLinkMetadata(item),
      categories: labels(item.categories), tags: labels(item.tags),
      ...(item.source === "cms_posts" && item.showInHomeHero === true ? { showInHomeHero: true } : {}),
      ...(item.byline === undefined ? {} : { byline: text(item.byline, "source byline", 2000) }),
      ...(item.source === "spotlight" && item.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" as const } : {}),
      ...(item.source === "cms_posts" && isCoverageLabelId(item.coverageLabelId) ? { coverageLabelId: item.coverageLabelId } : {}),
      ...(item.source === "cms_posts" && item.spotlightNews === true ? { spotlightNews: true } : {}),
      ...(isCalendarDay(item.displayDate) ? { displayDate: item.displayDate } : {}),
      ...(item.eyebrow === undefined ? {} : { eyebrow: text(item.eyebrow, "source name", 200) }),
      ...(image ? { image } : {}) };
  });
}

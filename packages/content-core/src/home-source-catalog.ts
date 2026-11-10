import { curateHomeSource, HOME_SOURCE_LOCKS, homeSourceInstant, homeSourceObject,
  type HomeCardSnapshot, type HomeCuratedSource, type HomeSourceSection } from "./home-source-curation.ts";
import type { ContentShelfBlock } from "./content-model.ts";
import { homeCatalogJson, isHomeSelectionReceipt, type HomeSelectionReceipt } from "./home-source-selection.ts";
export { homeCatalogJson, isHomeSelectedIds, isHomeSelectionReceipt } from "./home-source-selection.ts";

import { readHomeServiceSources, type HomeServiceSources } from "./home-service-sources.ts";
import { adaptHomeNewsletter } from "./home-newsletter-source.ts";

export interface HomeEditorialCatalog {
  services?: HomeServiceSources;
  schemaVersion: 1;
  cutoffAt: string;
  sources: Record<HomeSourceSection, HomeCardSnapshot>;
}
export interface HomeEditorialSourceReceipt {
  catalog: HomeEditorialCatalog;
  receipt: HomeSelectionReceipt;
}
const sections = Object.keys(HOME_SOURCE_LOCKS) as HomeSourceSection[];
const MAX_HOME_CATALOG_BYTES = 400_000;

/** Public projection only. Raw requests, credentials, videos and working records never enter it. */
export function readHomeEditorialCatalog(value: unknown): HomeEditorialCatalog {
  if (!homeSourceObject(value) || Object.keys(value).some(key => !["schemaVersion", "cutoffAt", "sources", "services"].includes(key)) ||
      Object.keys(value).length !== (Object.hasOwn(value, "services") ? 4 : 3) || value.schemaVersion !== 1 ||
      homeSourceInstant(value.cutoffAt) === null || !homeSourceObject(value.sources) ||
      Object.keys(value.sources).length !== sections.length) throw new Error("Home source catalog is invalid.");
  const sources = {} as HomeEditorialCatalog["sources"];
  for (const section of sections) {
    const snapshot = value.sources[section];
    if (!homeSourceObject(snapshot)) throw new Error("Home source catalog is invalid.");
    if (snapshot.status === "error" && Object.keys(snapshot).length === 1) {
      sources[section] = { status: "error" }; continue;
    }
    if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 ||
        !Array.isArray(snapshot.cards) || snapshot.cards.length > 200 ||
        homeSourceInstant(snapshot.checkedAt) === null) throw new Error("Home source catalog is invalid.");
    const cards = snapshot.cards.flatMap(card => curateHomeSource(section,
      { status: "ready", checkedAt: String(snapshot.checkedAt), cards: [card] },
      { cutoffAt: String(value.cutoffAt) }).cards);
    // A producer must admit and project every card first. No silent loss at a receipt boundary.
    if (homeCatalogJson(cards) !== homeCatalogJson(snapshot.cards) ||
        new Set(cards.map(card => card.id)).size !== cards.length) throw new Error("Home source catalog cards are invalid.");
    sources[section] = { status: "ready", checkedAt: String(snapshot.checkedAt), cards };
  }
  const catalog: HomeEditorialCatalog = { schemaVersion: 1, cutoffAt: String(value.cutoffAt), sources,
    ...(Object.hasOwn(value, "services") ? { services: readHomeServiceSources(value.services, String(value.cutoffAt)) } : {}) };
  if (new TextEncoder().encode(homeCatalogJson(catalog)).byteLength > MAX_HOME_CATALOG_BYTES) throw new Error("Home source catalog is too large.");
  return catalog;
}

/** Bound optional picker records to the existing whole-catalog byte budget.
 * Validate every candidate first, preserve all other source pools, and keep a
 * saved eligible ID ahead of unselected choices. Never certify malformed input. */
export function boundHomeNewsletterCatalog(value: unknown, selectedIds: readonly string[] = []): HomeEditorialCatalog {
  if (!homeSourceObject(value)) throw new Error("Home source catalog is invalid.");
  const { services, ...rest } = value;
  const base = readHomeEditorialCatalog(rest);
  if (!Object.hasOwn(value, "services")) return base;
  const admitted = readHomeServiceSources(services, base.cutoffAt);
  const bytes = (catalog: unknown) => new TextEncoder().encode(homeCatalogJson(catalog)).byteLength;
  const unavailable = { ...base, services: { ...admitted, newsletters: { status: "error" as const } } };
  const fallback = () => bytes(unavailable) <= MAX_HOME_CATALOG_BYTES ? unavailable : base;
  const snapshot = admitted.newsletters;
  if (snapshot.status === "error") return fallback();
  const records: unknown[] = [];
  const candidate = { ...base, services: { ...admitted, newsletters: { ...snapshot, records } } };
  let used = bytes(candidate);
  if (used > MAX_HOME_CATALOG_BYTES) return fallback();
  const sorted = [...snapshot.records].sort((a, b) => {
    const left = (a as { id: string }).id, right = (b as { id: string }).id;
    return Number(selectedIds.includes(right)) - Number(selectedIds.includes(left)) || left.localeCompare(right);
  });
  for (const record of sorted) {
    const size = bytes(record) + (records.length ? 1 : 0);
    if (used + size > MAX_HOME_CATALOG_BYTES) continue;
    records.push(record); used += size;
  }
  if (!records.length && snapshot.records.length) return fallback();
  return readHomeEditorialCatalog(candidate);
}
export function readHomeEditorialSourceReceipt(value: unknown): HomeEditorialSourceReceipt {
  if (!homeSourceObject(value) || Object.keys(value).length !== 2 || !isHomeSelectionReceipt(value.receipt)) {
    throw new Error("Home catalog receipt is invalid.");
  }
  return { catalog: readHomeEditorialCatalog(value.catalog), receipt: { ...value.receipt } };
}

/** Same saved selection, same current published catalog, same output on every reader. */
export function resolveHomeShelf(block: ContentShelfBlock, catalog: HomeEditorialCatalog): HomeCuratedSource {
  const section = block.section as HomeSourceSection;
  const lock = Object.hasOwn(HOME_SOURCE_LOCKS, section) ? HOME_SOURCE_LOCKS[section] : undefined;
  if (!lock || block.data.source !== lock.source || block.data.moreHref !== lock.browseHref) {
    throw new Error("Keep the Home shelf's assigned source and approved destination.");
  }
  return curateHomeSource(section, catalog.sources[section], { cutoffAt: catalog.cutoffAt,
    limit: block.data.itemLimit, ...(block.data.selectedIds === undefined ? {} : { selectedIds: block.data.selectedIds }) });
}

/** Picked shelves depend on saved IDs; automatic Post shelves depend on the current published pool. */
export function homeSectionsUsingPost(blocks: readonly { id: string; type: string; visible?: boolean; section?: string; data: unknown }[],
  postId: string): { blockId: string; section: "home-posts"; title: string }[] {
  return blocks.flatMap(block => block.visible !== false && block.type === "content_shelf" && block.section === "home-posts" &&
    homeSourceObject(block.data) && block.data.source === "station_posts" &&
    (block.data.selectedIds === undefined || Array.isArray(block.data.selectedIds) && block.data.selectedIds.includes(postId))
    ? [{ blockId: block.id, section: "home-posts" as const, title: String(block.data.title) }] : []);
}

export function homePostPlacements(snapshot: { blocks?: readonly { id?: string; type?: string; visible?: boolean; section?: string; data?: unknown; html?: unknown }[]; homeHero?: unknown },
  postId: string, slugs: readonly string[] = [], metadata?: { categories?: unknown; tags?: unknown; showInHomeHero?: unknown }):
  { blockId: string; section: string; title: string; refreshable: boolean }[] {
  const blocks = snapshot.blocks ?? [];
  const canonical = blocks.filter((block): block is { id: string; type: string; visible?: boolean; section?: string; data: unknown } => typeof block.id === "string" && typeof block.type === "string" && block.data !== undefined);
  const placements: { blockId: string; section: string; title: string; refreshable: boolean }[] = homeSectionsUsingPost(canonical, postId).map(section => ({ ...section, refreshable: true }));
  const paths = new Set(slugs.map(slug => `/posts/${slug}`));
  function mentions(value: unknown): boolean {
    if (typeof value === "string") {
      if (value === postId) return true;
      const links = [value, ...[...value.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map(match => match[1])];
      return links.some(link => {
        try {
          const url = new URL(link, "https://njpbs.org");
          return url.origin === "https://njpbs.org" && paths.has(url.pathname.replace(/\/index\.html\/?$/, "/").replace(/\/$/, ""));
        } catch { return false; }
      });
    }
    return Array.isArray(value) ? value.some(mentions) : homeSourceObject(value) ? Object.values(value).some(mentions) : false;
  }
  for (const [index, block] of blocks.entries()) {
    const blockId = block.id ?? `legacy-block-${index}`;
    if (block.visible !== false && !placements.some(placement => placement.blockId === blockId) && mentions(block)) {
      placements.push({ blockId, section: block.section ?? "content", title: block.section ?? "Home content", refreshable: false });
    }
  }
  const hero = snapshot.homeHero;
  if (homeSourceObject(hero)) {
    const labels = hero.mode === "category" ? metadata?.categories : metadata?.tags;
    const pinned = hero.mode !== "manual" && Array.isArray(hero.pins) && hero.pins.some(pin =>
      homeSourceObject(pin) && pin.source === "cms_posts" && pin.sourceId === postId);
    if (hero.mode === "manual" && Array.isArray(hero.items)) {
      const bound = hero.items.some(item => homeSourceObject(item) && item.source === "cms_posts" && item.sourceId === postId);
      const legacy = hero.items.some(item => homeSourceObject(item) && !item.sourceId && mentions(item));
      if (bound || legacy) placements.push({ blockId: "hero", section: "hero", title: "Home hero", refreshable: !legacy });
    } else if (pinned || (hero.source === "cms_posts" && ["category", "tag"].includes(String(hero.mode)) &&
        (!Array.isArray(labels) ||
          (hero.mode === "tag" && metadata?.showInHomeHero === true) ||
          (hero.mode === "tag" && Array.isArray(hero.values) ? hero.values : [hero.value]).some(value => labels.includes(value))))) {
      placements.push({ blockId: "hero", section: "hero", title: "Home hero", refreshable: true });
    }
  }
  return placements;
}

/** Public Home identities to retain when bounding a current Post catalog. */
export function homeSelectedPostIds(snapshot: { blocks?: readonly { section?: string; data?: unknown }[]; homeHero?: unknown }): string[] {
  const ids = (snapshot.blocks ?? []).flatMap(block => block.section === "home-posts" && homeSourceObject(block.data) && Array.isArray(block.data.selectedIds)
    ? block.data.selectedIds.filter((id): id is string => typeof id === "string") : []);
  const hero = snapshot.homeHero;
  if (homeSourceObject(hero) && hero.mode === "manual" && Array.isArray(hero.items)) {
    for (const item of hero.items) if (homeSourceObject(item) && item.source === "cms_posts" && typeof item.sourceId === "string") ids.push(item.sourceId);
  }
  if (homeSourceObject(hero) && hero.mode !== "manual" && Array.isArray(hero.pins)) {
    for (const pin of hero.pins) if (homeSourceObject(pin) && pin.source === "cms_posts" && typeof pin.sourceId === "string") ids.push(pin.sourceId);
  }
  return [...new Set(ids)];
}

/** Resolves a single saved Newsletter against the same approved public seal on every surface. */
export function resolveHomeNewsletter(block: import("./content-model.ts").NewsletterSignupBlock, catalog: HomeEditorialCatalog) {
  const { selectionReceipt: _receipt, ...settings } = block.data;
  return adaptHomeNewsletter({ newsletterIds: settings.newsletterIds, actionLabel: settings.actionLabel?.trim() ? settings.actionLabel : "Sign up by email",
    ...(settings.heading?.trim() ? { heading: settings.heading } : {}),
    ...(settings.intro?.trim() ? { intro: settings.intro } : {}) },
    catalog.services?.newsletters ?? { status: "error" }, catalog.cutoffAt);
}

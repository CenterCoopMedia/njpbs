import fixture from "../../../site/tests/fixtures/home-v2-selections.json";
import { CONTENT_SHELF_PRESENTATIONS, type ContentShelfBlock } from "../src/content-model";
import { readHomeEditorialSourceReceipt } from "../src/home-source-catalog";
import type { HomeHeroConfig } from "../src/home-hero";
import type { HomeSourceSnapshot } from "../src/home-rail-render";

export type ShelfLayoutState = "filled" | "one" | "empty" | "withdrawn" | "many";
export function shelfLayoutFixture(layout: "two_features" | "list", state: ShelfLayoutState) {
  const home = structuredClone(fixture.home);
  const editorial = readHomeEditorialSourceReceipt(fixture.editorial);
  const section = layout === "list" ? "home-posts" : "home-spotlight";
  // Isolate the changed shelf; retained sections remain recoverable in the draft.
  for (const candidate of home.blocks) if (candidate.type === "content_shelf" && candidate.section !== section) candidate.visible = false;
  const block = home.blocks.find(block => block.section === section)! as ContentShelfBlock;
  const pool = editorial.catalog.sources[section];
  if (pool.status !== "ready") throw new Error("fixture");
  if (layout === "list") pool.cards = [...pool.cards, {
    id: "station-update-fixture", source: "station_posts", sourceVersion: 1,
    title: "Station news fixture", summary: "A short station update for this local layout example.",
    href: "/posts/station-update-fixture/", sourceLabel: "NJ PBS", byline: "NJ PBS", displayDate: "2026-10-08",
  }];
  else pool.cards = pool.cards.map((card, index) => index === 1 ? { ...card, opinion: true } : card);
  // Keep fixture images local and deterministic; these are not publication inputs.
  pool.cards = pool.cards.map(card => ({ ...card, image: card.image?.url.startsWith("/brand/") ? card.image : { url: "/brand/home/new-jersey-blue.webp", alt: "New Jersey artwork" } }));
  if (state === "many" && layout === "list") pool.cards = [...pool.cards, ...pool.cards.map(card => ({
    ...card, id: `${card.id}-extra`, href: card.href.replace(/\/$/, "-extra/"), title: `Additional fixture: ${card.title}`,
  }))];
  const selectedIds = pool.cards.map(card => card.id);
  Object.assign(block.data, { presentation: (CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes(layout) ? layout : "rail",
    itemLimit: state === "many" ? 6 : 3, selectedIds: state === "empty" ? [] : state === "one" ? selectedIds.slice(0, 1) : selectedIds,
    title: layout === "list" ? "From NJ PBS" : "More from New Jersey" });
  if (state === "withdrawn") pool.cards = pool.cards.slice(1);
  const sources: HomeSourceSnapshot = { schemaVersion: 1, publication: editorial.receipt, editorial,
    pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
    spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] },
    heroCatalog: [{ id: "video-fixture", source: "media_manager", title: "New Jersey report fixture", summary: "A video report for this local example.",
      href: "https://watch.njpbs.org/video/report-fixture/", categories: [], tags: [], image: { url: "/brand/home/new-jersey-blue.webp", alt: "" } }],
  };
  return { home, block, sources };
}
export function heroActionFixture(override = false): HomeHeroConfig {
  return { mode: "manual", presentation: "editorial", supportingCount: 1, items: [
    { itemId: "article-fixture", title: "New Jersey story fixture", summary: "An article for this local layout example.", href: "/posts/story-fixture/" },
    { itemId: "video-fixture", source: "media_manager", sourceId: "video-fixture", title: "New Jersey report fixture", summary: "A video report for this local example.", href: "https://watch.njpbs.org/video/report-fixture/" },
    { itemId: "override-fixture", title: "Station update fixture", summary: "An optional story action example.", href: "/posts/update-fixture/",
      ...(override ? { actionLabel: "Read the full update" } : {}) },
  ] };
}

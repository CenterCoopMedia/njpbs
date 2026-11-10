import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  parseHomeHero,
  resolveHomeHero,
  homeHeroAssetIds,
  type HomeHeroCatalogItem,
  type HomeHeroConfig,
} from "../../packages/content-core/src/home-hero";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { blockContentError } from "../../packages/content-core/src/block-content-validation";
import { projectCmsPage } from "../src/lib/cms-loader";

const require = createRequire(import.meta.url);
const serverHero = require("../../functions/lib/home-hero.js");
const serverBlocks = require("../../functions/lib/content-blocks.js");
const serverComposition = require("../../functions/lib/home-composition-contract.js");
const serverContent = require("../../functions/lib/block-content-validation.js");
const { validateKnownMetadata } = require("../../functions/lib/content-metadata.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");

const manualItem = (index: number) => ({
  itemId: `story-${index}`,
  title: `Story ${index}`,
  summary: "A saved story summary.",
  href: `/posts/story-${index}/`,
});

function editorialHero(): HomeHeroConfig {
  return {
    mode: "manual",
    presentation: "editorial",
    supportingCount: 3,
    supportingHeading: "Latest stories",
    overflowHeading: "More stories",
    items: Array.from({ length: 10 }, (_, index) => manualItem(index)),
  };
}

function gridBlocks(): PageBlock[] {
  return homeCompositionDefaults().map(block => block.type === "content_shelf"
    ? { ...block, data: { ...block.data, presentation: "grid", columns: 3, itemLimit: 6 } }
    : block);
}

function homeDocument() {
  return {
    id: "home",
    template: "home",
    title: "Home",
    status: "draft",
    version: 7,
    homeCompositionVersion: 1,
    homeHero: editorialHero(),
    blocks: gridBlocks(),
  };
}

describe("Home presentation contract", () => {
  it("keeps legacy payloads unchanged without injecting presentation defaults", () => {
    const legacy = { mode: "manual", items: [manualItem(0)] };
    expect(parseHomeHero(legacy)).toEqual(legacy);
    expect(serverHero.parseHomeHero(legacy)).toEqual(legacy);
    expect(parseHomeHero(undefined)).toBeUndefined();
    expect(serverHero.parseHomeHero(undefined)).toBeUndefined();
    const blocks = homeCompositionDefaults();
    expect(parseBlocks(blocks)).toEqual({ ok: true, blocks });
    expect(serverBlocks.parseBlocks(blocks)).toEqual({ ok: true, blocks });
    expect(blocks.filter(block => block.type === "content_shelf").every(block =>
      !Object.hasOwn(block.data, "presentation") && !Object.hasOwn(block.data, "columns"),
    )).toBe(true);
  });

  it("round-trips an old version 1 Home snapshot through preview, publication and public readers", () => {
    const doc = { ...homeDocument(), homeHero: { mode: "manual", items: [manualItem(0)] },
      blocks: homeCompositionDefaults() };
    const originalHero = structuredClone(doc.homeHero);
    const originalBlocks = structuredClone(doc.blocks);
    const preview = createPreviewSnapshot("home", doc);
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc,
      publishedAt: "2026-10-08T22:00:00.000Z", publishedBy: "editor" });
    const liveDocument = { ...doc, publiclyVisible: true, published };
    const now = new Date("2026-10-08T23:00:00.000Z");
    const sitePage = projectCmsPage(liveDocument, { mode: "published", now })!;
    const publicPage = projectPublicPageDocument({ pageId: "home", document: liveDocument,
      assets: new Map(), now });
    expect(preview.homeHero).toEqual(originalHero);
    expect(preview.blocks).toEqual(originalBlocks);
    expect(published.metadata.homeHero).toEqual(originalHero);
    expect(published.blocks).toEqual(originalBlocks);
    expect(sitePage.homeHero).toEqual(originalHero);
    expect(sitePage.blocks).toEqual(originalBlocks);
    expect(publicPage.state).toBe("live");
    expect(publicPage.page.homeHero).toEqual(originalHero);
    expect(publicPage.page.blocks).toEqual(originalBlocks);
    expect(JSON.parse(JSON.stringify(sitePage.homeHero))).toEqual(originalHero);
    expect(JSON.parse(JSON.stringify(sitePage.blocks))).toEqual(originalBlocks);
  });

  it("retains editorial settings through both presentations and each selection mode", () => {
    for (const presentation of ["carousel", "editorial"] as const) {
      for (const supportingCount of [1, 2, 3] as const) {
        for (const selection of [
          { mode: "manual", items: [manualItem(0)] },
          { mode: "category", source: "cms_posts", value: "News" },
          { mode: "tag", source: "cms_posts", value: "Health" },
        ]) {
          const config = { ...selection, presentation, supportingCount,
            supportingHeading: "  Stories to follow  ", overflowHeading: "" };
          expect(parseHomeHero(config)).toEqual(config);
          expect(serverHero.parseHomeHero(config)).toEqual(config);
          expect(validateKnownMetadata({ homeHero: config })).toBeNull();
        }
      }
    }
    const whitespace = { ...editorialHero(), supportingHeading: " ", overflowHeading: "\t" };
    expect(parseHomeHero(whitespace)).toEqual(whitespace);
    expect(serverHero.parseHomeHero(whitespace)).toEqual(whitespace);
  });

  it("rejects unsupported presentation controls identically in browser and server contracts", () => {
    const invalidFields = [
      { presentation: "lead" }, { presentation: null }, { presentation: 1 },
      { supportingCount: 0 }, { supportingCount: 4 }, { supportingCount: 1.5 },
      { supportingCount: "3" }, { supportingCount: null },
      { leadHeading: null }, { leadHeading: 12 }, { leadHeading: "x".repeat(121) },
      { supportingHeading: null }, { supportingHeading: 12 },
      { supportingHeading: "x".repeat(121) }, { overflowHeading: "x".repeat(121) },
      { overflowHeading: [] }, { autoplay: false },
    ];
    for (const fields of invalidFields) {
      const invalid = { ...editorialHero(), ...fields };
      expect(() => parseHomeHero(invalid), JSON.stringify(fields)).toThrow();
      expect(() => serverHero.parseHomeHero(invalid), JSON.stringify(fields)).toThrow();
      expect(validateKnownMetadata({ homeHero: invalid })).toBeTruthy();
    }
    const maximum = { ...editorialHero(), leadHeading: "x".repeat(120), supportingHeading: "x".repeat(120), overflowHeading: "x".repeat(120) };
    expect(parseHomeHero(maximum)).toEqual(maximum);
    expect(serverHero.parseHomeHero(maximum)).toEqual(maximum);
  });

  it.each([0, 1, 4, 10])("preserves all %i resolved selections independently of supporting count", count => {
    const config = { ...editorialHero(), supportingCount: 1 as const,
      items: Array.from({ length: count }, (_, index) => manualItem(index)) };
    const expected = config.items.map(item => item.itemId);
    expect(resolveHomeHero(config, []).map(card => card.id)).toEqual(expected);
    expect(serverHero.resolveHomeHero(config, []).map((card: { id: string }) => card.id)).toEqual(expected);
    expect(config.items).toHaveLength(count);
  });

  it("keeps automatic query order, cap, source identity and media references independent of layout", () => {
    const catalog: HomeHeroCatalogItem[] = Array.from({ length: 12 }, (_, index) => ({
      id: `post-${index}`, title: `Post ${index}`, summary: "Summary", href: `/posts/${index}/`,
      source: "cms_posts", categories: ["News"], tags: [],
    }));
    const query = { mode: "category", source: "cms_posts", value: "News", limit: 10 };
    const editorial = { ...query, presentation: "editorial", supportingCount: 2 };
    expect(resolveHomeHero(editorial, catalog)).toEqual(resolveHomeHero(query, catalog));
    expect(serverHero.resolveHomeHero(editorial, catalog)).toEqual(resolveHomeHero(query, catalog));
    const withAsset = { ...editorialHero(), items: [{ ...manualItem(0), imageAssetId: "station-image", alt: "A station image" }] };
    expect(homeHeroAssetIds(withAsset)).toEqual(["station-image"]);
    expect(serverHero.homeHeroAssetIds(withAsset)).toEqual(["station-image"]);
  });

  it("admits three- and six-item grids within the unchanged named shelf bounds", () => {
    for (const presentation of [undefined, "rail", "grid"] as const) {
      for (const columns of [undefined, 2, 3, 4] as const) {
        for (const itemLimit of [3, 4, 6, 8] as const) {
          const blocks = homeCompositionDefaults().map(block => block.type === "content_shelf"
            ? { ...block, data: { ...block.data, itemLimit,
              ...(presentation === undefined ? {} : { presentation }),
              ...(columns === undefined ? {} : { columns }),
            } }
            : block);
          expect(parseBlocks(blocks)).toEqual({ ok: true, blocks });
          expect(serverBlocks.parseBlocks(blocks)).toEqual({ ok: true, blocks });
          expect(homeCompositionError("home", 1, blocks)).toBeNull();
          expect(serverComposition.homeCompositionError("home", 1, blocks)).toBeNull();
          expect(blockContentError(blocks)).toBeNull();
          expect(serverContent.blockContentError(blocks)).toBeNull();
        }
      }
    }
  });

  it("rejects unsupported shelf controls without weakening source and region protections", () => {
    for (const fields of [
      { presentation: "masonry" }, { presentation: "carousel" }, { presentation: null },
      { columns: 1 }, { columns: 5 }, { columns: "3" }, { columns: 2.5 }, { columns: null },
      { itemLimit: 5 }, { itemLimit: 0 }, { renderer: "custom" },
    ]) {
      const blocks = gridBlocks();
      const shelf = blocks.find(block => block.section === "home-featured")!;
      Object.assign(shelf.data, fields);
      expect(parseBlocks(blocks).ok, JSON.stringify(fields)).toBe(false);
      expect(serverBlocks.parseBlocks(blocks)).toEqual(parseBlocks(blocks));
    }
    for (const fields of [
      { source: "pbs_more" }, { moreHref: "/watch/" }, { itemLimit: 12 },
    ]) {
      const blocks = gridBlocks();
      Object.assign(blocks.find(block => block.section === "home-featured")!.data, fields);
      expect(parseBlocks(blocks).ok).toBe(true);
      expect(homeCompositionError("home", 1, blocks)).toBeTruthy();
      expect(serverComposition.homeCompositionError("home", 1, blocks)).toBe(homeCompositionError("home", 1, blocks));
    }
    for (const section of ["home-featured", "home-more"]) {
      const missing = gridBlocks().filter(block => block.section !== section);
      expect(homeCompositionError("home", 1, missing)).toBeTruthy();
      const hidden = gridBlocks().map(block => block.section === section ? { ...block, visible: false } : block);
      expect(homeCompositionError("home", 1, hidden)).toBeTruthy();
    }
  });

  it("carries new controls through saved preview and detached publication without draft leakage", () => {
    const doc = homeDocument();
    const original = structuredClone(doc);
    const publishedAt = "2026-10-08T22:00:00.000Z";
    const now = new Date("2026-10-08T23:00:00.000Z");
    const preview = createPreviewSnapshot("home", doc);
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt, publishedBy: "editor" });
    expect(preview.homeHero).toEqual(original.homeHero);
    expect(preview.blocks).toEqual(original.blocks);
    expect(published.metadata.homeHero).toEqual(original.homeHero);
    expect(published.blocks).toEqual(original.blocks);
    expect(published.metadata.homeCompositionVersion).toBe(1);

    doc.homeHero.presentation = "carousel";
    doc.homeHero.supportingHeading = "Draft-only heading";
    doc.homeHero.items![0].title = "Draft-only lead";
    for (const block of doc.blocks) {
      if (block.type === "content_shelf") block.data.presentation = "rail";
    }

    const publicDocument = { ...doc, publiclyVisible: true, published };
    const live = projectCmsPage(publicDocument, { mode: "published", now })!;
    const draft = projectCmsPage(doc, { mode: "draft", pageId: "home", now })!;
    const runtime = projectPublicPageDocument({ pageId: "home", document: publicDocument, assets: new Map(), now });
    expect(live.homeHero).toEqual(original.homeHero);
    expect(live.blocks).toEqual(original.blocks);
    expect(draft.homeHero).toEqual(doc.homeHero);
    expect(draft.blocks).toEqual(doc.blocks);
    expect(runtime.state).toBe("live");
    expect(runtime.page.homeHero).toEqual(original.homeHero);
    expect(runtime.page.blocks).toEqual(original.blocks);
    expect(published.metadata.homeHero).toEqual(original.homeHero);
    expect(preview.homeHero).toEqual(original.homeHero);
    expect(preview.blocks).toEqual(original.blocks);
  });
});

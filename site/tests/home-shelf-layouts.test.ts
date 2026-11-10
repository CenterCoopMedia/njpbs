import { blockContentError } from "../../packages/content-core/src/block-content-validation";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type ContentShelfBlock } from "../../packages/content-core/src/content-model";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import { parseHomeHero, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import fixture from "./fixtures/home-v2-selections.json";

const require = createRequire(import.meta.url);
const serverBlocks = require("../../functions/lib/content-blocks.js");
const serverContent = require("../../functions/lib/block-content-validation.js");
const serverHero = require("../../functions/lib/home-hero.js");
const preview = require("../../functions/lib/preview-snapshot.js");
const publication = require("../../functions/lib/publish-snapshot.js");

describe("curated Home presentation boundaries", () => {
  for (const presentation of ["two_features", "list"] as const) {
    it(`retains ${presentation} on every curated source in shared/server and saved snapshots`, () => {
      const doc = structuredClone(fixture.home);
      for (const block of doc.blocks) if (block.type === "content_shelf") Object.assign(block.data, { presentation });
      const parsed = parseBlocks(doc.blocks);
      expect(parsed).toEqual({ ok: true, blocks: doc.blocks });
      if (!parsed.ok) throw new Error(parsed.error);
      expect(serverBlocks.parseBlocks(doc.blocks)).toEqual({ ok: true, blocks: doc.blocks });
      expect(blockContentError(parsed.blocks)).toBeNull();
      expect(serverContent.blockContentError(doc.blocks)).toBeNull();
      expect(preview.createPreviewSnapshot("home", doc).blocks).toEqual(doc.blocks);
      expect(publication.createPublishedSnapshot({ collection: "cmsPages", document: doc,
        publishedAt: "2026-10-11T20:00:00.000Z", publishedBy: "fixture-editor" }).blocks).toEqual(doc.blocks);
    });

    it(`renders ${presentation} with attribution, order and withdrawal without replacement`, () => {
      const catalog = readHomeEditorialSourceReceipt(fixture.editorial).catalog;
      const block = structuredClone(fixture.home.blocks.find(block => block.section === "home-spotlight")) as ContentShelfBlock;
      block.data.presentation = presentation;
      const pool = catalog.sources["home-spotlight"];
      if (pool.status !== "ready") throw new Error("fixture");
      // The specification admits Opinion only when the source marks the card.
      pool.cards = pool.cards.map((card, index) => index === 1 ? { ...card, opinion: true } : card);
      const root = document.createElement("div");
      root.innerHTML = renderHomeCuratedShelf(block, catalog);
      expect([...root.querySelectorAll<HTMLElement>("[data-home-card-id]")].map(item => item.dataset.homeCardId)).toEqual(block.data.selectedIds);
      expect(root.querySelector(".home-curated__metadata")?.textContent).toContain("NJ Spotlight News");
      expect(root.textContent).toContain("Opinion");
      // #3513: These recorded bylines are posting accounts. Public metadata
      // omits them and uses the lead story's AP date format.
      expect([...root.querySelectorAll(".home-curated__metadata")].map(node => node.textContent)).toEqual([
        "NJ Spotlight News · Opinion · Oct. 7, 2026", "NJ Spotlight News · Oct. 8, 2026",
      ]);
      expect(root.querySelectorAll("img")).toHaveLength(presentation === "list" ? 0 : 2);
      expect(root.querySelector(".rail__track, .rail__arrow")).toBeNull();
      const savedIds = [...block.data.selectedIds!];
      pool.cards = pool.cards.slice(0, 1);
      root.innerHTML = renderHomeCuratedShelf(block, catalog);
      expect(root.querySelectorAll("[data-home-card-id]")).toHaveLength(1);
      expect(block.data.selectedIds).toEqual(savedIds);
      pool.cards = [];
      expect(renderHomeCuratedShelf(block, catalog)).toBe("");
      expect(renderHomeCuratedShelf({ ...block, visible: false }, catalog)).toBe("");
    });
  }
});

describe("editorial hero action boundaries", () => {
  const item = { itemId: "story", title: "Published story", summary: "Story summary", href: "/posts/story/" };
  it.each([
    ["https://watch.njpbs.org/video/report/", "Watch the report"],
    ["https://WATCH.NJPBS.ORG/video/report/?source=home#watch", "Watch the report"],
    ["https://watch.njpbs.org/show/news/", "Watch the report"],
    ["/posts/station-news/", "Read the story"],
    ["https://www.njspotlightnews.org/story/", "Read the story"],
    ["https://watch.njpbs.org.example.test/video/report/", "Read the story"],
    ["/posts/watch.njpbs.org/", "Read the story"],
  ])("uses the destination type for an unbound URL %s", (href, label) => {
    const config = { mode: "manual", items: [{ ...item, href }] };
    for (const resolver of [resolveHomeHero, serverHero.resolveHomeHero]) {
      const root = document.createElement("div");
      root.innerHTML = renderHomeEditorialHero(resolver(config, []));
      expect(root.querySelector(".home-editorial__action")?.textContent?.trim()).toBe(`${label} →`);
      const overridden = { mode: "manual", items: [{ ...item, href, actionLabel: "Open this report" }] };
      root.innerHTML = renderHomeEditorialHero(resolver(overridden, []));
      expect(root.querySelector(".home-editorial__action")?.textContent?.trim()).toBe("Open this report →");
    }
  });
  it("preserves optional text exactly through both parsers, preview and publication", () => {
    for (const actionLabel of [undefined, "", "  ", "Read the full story", "A".repeat(80)]) {
      const config = { mode: "manual", presentation: "editorial", items: [{ ...item, ...(actionLabel === undefined ? {} : { actionLabel }) }] };
      expect(parseHomeHero(config)).toEqual(config);
      expect(serverHero.parseHomeHero(config)).toEqual(config);
      const doc = { ...fixture.home, homeHero: config };
      expect(preview.createPreviewSnapshot("home", doc).homeHero).toEqual(config);
      expect(publication.createPublishedSnapshot({ collection: "cmsPages", document: doc,
        publishedAt: "2026-10-11T20:00:00.000Z", publishedBy: "fixture-editor" }).metadata.homeHero).toEqual(config);
    }
  });
  it.each([null, 4, "A".repeat(81), "<b>Read</b>", "Read\nthis", "Read\u0000this", "Read\u2028this", "Read\u0085this"])("refuses invalid button text at save/freeze boundaries: %j", actionLabel => {
    const config = { mode: "manual", items: [{ ...item, actionLabel }] };
    expect(() => parseHomeHero(config)).toThrow();
    expect(() => serverHero.parseHomeHero(config)).toThrow();
    expect(() => preview.createPreviewSnapshot("home", { ...fixture.home, homeHero: config })).toThrow();
  });
  it("defaults articles to Read and PBS items to Watch, retains overrides, and drops a withdrawn bound Post", () => {
    const config = { mode: "manual", items: [item, { ...item, itemId: "video", source: "media_manager", sourceId: "video",
      href: "https://watch.njpbs.org/video/report/" }, { ...item, itemId: "override", href: "/posts/other/", actionLabel: "Full report & details" }] };
    for (const resolver of [resolveHomeHero, serverHero.resolveHomeHero]) {
      const cards = resolver(config, []);
      const root = document.createElement("div");
      root.innerHTML = renderHomeEditorialHero(cards, { supportingCount: 1 });
      expect([...root.querySelectorAll(".home-editorial__action")].map(item => item.textContent?.trim()))
        .toEqual(["Read the story →", "Watch the report →", "Full report & details →"]);
      expect(resolver({ mode: "manual", items: [{ ...item, source: "cms_posts", sourceId: "withdrawn", actionLabel: "Keep reading" }] }, [])).toEqual([]);
    }
  });
});

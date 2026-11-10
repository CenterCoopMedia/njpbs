import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type PageBlock, type RichTextNode } from "../../packages/content-core/src/content-model";
import { homeCompositionDefaults, homeCompositionView, resolveHomeComposition, homeContentAreas, homePromotionPlacement, homeStructuralBlocks, homeStructuralMoveNeighbors, HOME_CONTENT_AREAS } from "../../packages/content-core/src/home-composition";
import { visibleLayoutBlocks } from "../../packages/content-core/src/content-layout";
import { homeCompositionError, HOME_DESTINATIONS, HOME_COMPOSITION_REGIONS } from "../../packages/content-core/src/home-composition-contract";
import { HOME_PASSPORT_CONTENT, homeStartItems } from "../../packages/content-core/src/home-section-render";
import { projectCmsPage } from "../src/lib/cms-loader";

const require = createRequire(import.meta.url);
const mirror = require("../../functions/lib/home-composition-contract.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { homeEditorBoundaryError } = require("../../functions/lib/home-editor-boundary.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");

function document() {
  return { id: "home", template: "home", title: "Home", status: "draft", homeCompositionVersion: 1, version: 7, blocks: homeCompositionDefaults() };
}

describe("finite Home composition", () => {
  it("shows a default manual shelf before Featured regardless of stored array position", () => {
    const shelf = {
      id: "shelf",
      type: "promotion_playlist" as const,
      order: 7,
      visible: true,
      data: {
        title: "Local films",
        placement: "before_featured" as const,
        presentation: "rail" as const,
        columns: 3,
        cards: [],
      },
    };
    const blocks = [...homeCompositionDefaults(), shelf];
    expect(homePromotionPlacement(shelf)).toBe("before_featured");
    const ids = homeStructuralBlocks(blocks).map(block => block.id);
    expect(ids.indexOf("shelf")).toBeLessThan(ids.indexOf("new-home-featured"));
    expect(ids.indexOf("shelf")).toBeGreaterThan(ids.indexOf("new-home-start"));
  });

  it("omits Start and Passport actions from Home structural move neighbors", () => {
    expect(homeStructuralMoveNeighbors(homeStructuralBlocks(homeCompositionDefaults())).map(block => block.section)).toEqual([
      "home-start",
      "home-featured",
      "home-passport-copy",
      "home-more",
      "home-spotlight",
    ]);
  });

  it("admits added rows at each shared Home section boundary without moving fixed content", () => {
    const blocks = homeCompositionDefaults();
    for (const [area, section] of Object.entries(HOME_CONTENT_AREAS)) {
      const index = section === null ? blocks.length : blocks.findIndex(block => block.section === section);
      blocks.splice(index, 0,
        { id: area, type: "row", order: 0, visible: true, data: { columns: [4, 8] } },
        { id: `${area}-text`, type: "prose", order: 0, visible: true, layout: { rowId: area, column: 1 }, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: area }] }] } } });
    }
    blocks.forEach((block, index) => { block.order = index; });
    expect(parseBlocks(blocks).ok).toBe(true);
    expect(homeCompositionError("home", 1, blocks)).toBeNull();
    expect(mirror.homeCompositionError("home", 1, blocks)).toBeNull();
    expect(homeEditorBoundaryError({ collection: "cmsPages", documentId: "home", storedBlocks: homeCompositionDefaults(), nextBlocks: blocks, storedVersion: 1, nextVersion: 1 })).toBeNull();
    const doc = { ...document(), blocks };
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    expect(published.blocks).toEqual(blocks);
    expect(createPreviewSnapshot("home", doc).blocks).toEqual(blocks);
    const runtime = projectPublicPageDocument({ pageId: "home", document: { ...doc, publiclyVisible: true, published }, assets: new Map(), now: new Date("2026-09-05T13:00:00Z") });
    expect(runtime.state).toBe("live");
    expect(runtime.page.blocks).toEqual(blocks);
    const areas = homeContentAreas(blocks);
    for (const area of Object.keys(HOME_CONTENT_AREAS) as (keyof typeof HOME_CONTENT_AREAS)[]) {
      expect(areas[area].map(block => block.id)).toEqual([area, `${area}-text`]);
    }
    expect(resolveHomeComposition(1, blocks)).toEqual(resolveHomeComposition(1, homeCompositionDefaults()));
    blocks.find(block => block.id === "before_featured")!.visible = false;
    const visible = visibleLayoutBlocks(blocks);
    expect(homeContentAreas(visible).before_featured).toEqual([]);
    expect(homeCompositionError("home", 1, visible)).toBeNull();
  });

  it("keeps added plain content valid after hidden content is projected out", () => {
    const blocks = homeCompositionDefaults();
    blocks.splice(2, 0,
      { id: "hidden", type: "divider", order: 0, visible: false, data: {} },
      { id: "shown", type: "divider", order: 0, visible: true, data: {} });
    blocks.forEach((block, index) => { block.order = index; });
    const visible = visibleLayoutBlocks(blocks);
    expect(homeCompositionError("home", 1, visible)).toBeNull();
    expect(mirror.homeCompositionError("home", 1, visible)).toBeNull();
    expect(homeContentAreas(visible).before_featured.map(block => block.id)).toEqual(["shown"]);
  });

  it("rejects insertion inside fixed controls and added automatic source shelves", () => {
    for (const index of [1, 4]) {
      const blocks = homeCompositionDefaults();
      blocks.splice(index, 0, { id: "inside-section", type: "divider", order: 0, visible: true, data: {} });
      blocks.forEach((block, order) => { block.order = order; });
      const error = homeCompositionError("home", 1, blocks);
      expect(error).toContain("between Home sections");
      expect(mirror.homeCompositionError("home", 1, blocks)).toBe(error);
    }
    const blocks = homeCompositionDefaults();
    const { section: _fixedSection, ...extra } = blocks[2];
    blocks.push({ ...extra, id: "extra-source", order: 7 });
    expect(homeCompositionError("home", 1, blocks)).toContain("named page sections");
    expect(mirror.homeCompositionError("home", 1, blocks)).toBe(homeCompositionError("home", 1, blocks));
  });

  it("maps fresh valid defaults to the exact existing public content", () => {
    const blocks = homeCompositionDefaults();
    expect(parseBlocks(blocks).ok).toBe(true);
    expect(homeCompositionError("home", 1, blocks)).toBeNull();
    expect(mirror.HOME_COMPOSITION_REGIONS).toEqual(HOME_COMPOSITION_REGIONS);
    expect(mirror.HOME_DESTINATIONS).toEqual(HOME_DESTINATIONS);
    const composition = resolveHomeComposition(1, blocks)!;
    expect(composition.start).toEqual(homeStartItems(HOME_DESTINATIONS, true));
    expect(composition.passport).toEqual(HOME_PASSPORT_CONTENT);
    expect([composition.featured.itemLimit, composition.more.itemLimit, composition.spotlight.itemLimit]).toEqual([8, 16, 8]);
    blocks[0].visible = false;
    expect(homeCompositionDefaults()[0].visible).toBe(true);
  });

  it("maps incomplete fixed copy only for a draft preview", () => {
    const blocks = homeCompositionDefaults();
    const featured = blocks.find(block => block.section === "home-featured");
    if (featured?.type !== "content_shelf") throw new Error("Expected Featured shelf");
    featured.data.title = "";

    expect(() => resolveHomeComposition(1, blocks)).toThrow(/heading/);
    expect(resolveHomeComposition(1, blocks, {}, { complete: false })?.featured.title)
      .toBe("");
    expect(projectCmsPage({ ...document(), blocks }, {
      mode: "draft",
      pageId: "home",
      now: new Date("2026-09-05T13:00:00Z"),
    })?.blocks).toEqual(blocks);
  });

  it.each([null, "1", 0, 3, true])("refuses malformed version %j in both runtimes", version => {
    const blocks = homeCompositionDefaults();
    expect(homeCompositionError("home", version, blocks)).toBeTruthy();
    expect(mirror.homeCompositionError("home", version, blocks)).toBe(homeCompositionError("home", version, blocks));
    expect(() => resolveHomeComposition(version, blocks)).toThrow();
  });

  it.each([
    ["missing", (blocks: PageBlock[]) => blocks.pop()],
    ["duplicate", (blocks: PageBlock[]) => { blocks[1] = { ...blocks[0], id: "duplicate" }; }],
    ["hidden", (blocks: PageBlock[]) => { blocks[0].visible = false; }],
    ["reordered", (blocks: PageBlock[]) => { blocks[0].order = 2; }],
    ["wrong source", (blocks: PageBlock[]) => { if (blocks[2].type === "content_shelf") blocks[2].data.source = "pbs_more"; }],
    ["unsafe destination", (blocks: PageBlock[]) => { if (blocks[4].type === "cta_row") blocks[4].data.ctas[0].href = "javascript:alert(1)"; }],
    ["oversized shelf", (blocks: PageBlock[]) => { if (blocks[2].type === "content_shelf") blocks[2].data.itemLimit = 24; }],
  ])("rejects %s regions in both runtimes", (_name, mutate) => {
    const blocks = homeCompositionDefaults();
    mutate(blocks);
    expect(homeCompositionError("home", 1, blocks)).toBeTruthy();
    expect(mirror.homeCompositionError("home", 1, blocks)).toBe(homeCompositionError("home", 1, blocks));
  });

  it("keeps legacy blocks opaque and rejects a marker on another page", () => {
    expect(resolveHomeComposition(undefined, [])).toBeNull();
    expect(homeCompositionError("home", undefined, [])).toBeNull();
    expect(homeCompositionError("about", 1, homeCompositionDefaults())).toBeTruthy();
    expect(homeEditorBoundaryError({ collection: "cmsPages", documentId: "home", storedBlocks: [], nextBlocks: homeCompositionDefaults(), nextVersion: 1 })).toContain("conversion");
  });

  it("allows a pending editor image without weakening public asset admission", () => {
    const blocks = homeCompositionDefaults();
    if (blocks[0].type !== "card_grid") throw new Error("Expected Start cards");
    blocks[0].data.cards[0].imageAssetId = "home-image";
    expect(homeCompositionView(blocks).start[0].image).toBeUndefined();
    expect(() => resolveHomeComposition(1, blocks)).toThrow("Missing Home pathway image");
    const assets = { "home-image": { url: "https://media.njpbs.org/home.webp" } };
    expect(resolveHomeComposition(1, blocks, assets)?.start[0].image).toBe(assets["home-image"].url);
  });

  it.each<RichTextNode[][]>([
    [[]],
    [[{ type: "paragraph" }]],
    [[{ type: "paragraph", content: [{ type: "text", text: "   " }] }]],
    [[{ type: "horizontalRule" }]],
  ])("rejects a Passport heading without readable body text (%j)", body => {
    const blocks = homeCompositionDefaults();
    const passport = blocks[3];
    if (passport.type !== "prose") throw new Error("Expected Passport prose");
    passport.data.content.content = [passport.data.content.content[0], ...body];
    expect(parseBlocks(blocks).ok).toBe(true);
    expect(homeCompositionError("home", 1, blocks)).toContain("followed by its body");
    expect(mirror.homeCompositionError("home", 1, blocks)).toBe(homeCompositionError("home", 1, blocks));
    expect(() => resolveHomeComposition(1, blocks)).toThrow();
  });

  it("freezes the marker with public content and keeps draft changes separate", () => {
    const doc = {
      ...document(),
      homeHeroTitle: "Watch what matters",
      homeHeroSubtitle: "Stories from across New Jersey.",
    };
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const preview = createPreviewSnapshot("home", doc);
    expect(preview.homeCompositionVersion).toBe(1);
    expect(preview.homeHeroTitle).toBe("Watch what matters");
    expect(preview.homeHeroSubtitle).toBe("Stories from across New Jersey.");
    expect(published.metadata.homeCompositionVersion).toBe(1);
    expect(published.metadata.homeHeroTitle).toBe("Watch what matters");
    expect(published.metadata.homeHeroSubtitle).toBe("Stories from across New Jersey.");
    if (doc.blocks[3].type !== "prose") throw new Error("Expected Passport prose");
    doc.homeHeroTitle = "Changed hero title";
    doc.homeHeroSubtitle = "Changed hero subtitle";
    doc.blocks[3].data.content.content[0] = { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Changed heading" }] };
    const live = projectCmsPage({ ...doc, publiclyVisible: true, published }, { mode: "published", now: new Date("2026-09-05T13:00:00Z") })!;
    const draft = projectCmsPage(doc, { mode: "draft", pageId: "home", now: new Date("2026-09-05T13:00:00Z") })!;
    expect(live.homeCompositionVersion).toBe(1);
    expect(live.homeHeroTitle).toBe("Watch what matters");
    expect(live.homeHeroSubtitle).toBe("Stories from across New Jersey.");
    expect(draft.homeHeroTitle).toBe("Changed hero title");
    expect(draft.homeHeroSubtitle).toBe("Changed hero subtitle");
    const runtime = projectPublicPageDocument({ pageId: "home", document: { ...doc, publiclyVisible: true, published }, assets: new Map(), now: new Date("2026-09-05T13:00:00Z") });
    expect(runtime.state).toBe("live");
    expect(runtime.page.homeCompositionVersion).toBe(1);
    expect(runtime.page.homeHeroTitle).toBe("Watch what matters");
    expect(runtime.page.homeHeroSubtitle).toBe("Stories from across New Jersey.");
    expect(runtime.page.blocks).toEqual(live.blocks);
    expect(resolveHomeComposition(live.homeCompositionVersion, live.blocks)!.passport.heading).toBe(HOME_PASSPORT_CONTENT.heading);
    expect(resolveHomeComposition(draft.homeCompositionVersion, draft.blocks)!.passport.heading).toBe("Changed heading");
    expect(() => createPreviewSnapshot("about", { ...doc, template: "genericPage" })).toThrow();
  });

  it("keeps absent hero copy compatible and permits blank copy only in a draft preview", () => {
    const doc = document();
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    expect(published.metadata).not.toHaveProperty("homeHeroTitle");
    expect(published.metadata).not.toHaveProperty("homeHeroSubtitle");
    const live = projectCmsPage(
      { ...doc, publiclyVisible: true, published },
      { mode: "published", now: new Date("2026-09-05T13:00:00Z") },
    );
    expect(live).not.toHaveProperty("homeHeroTitle");
    expect(live).not.toHaveProperty("homeHeroSubtitle");
    const runtime = projectPublicPageDocument({
      pageId: "home",
      document: { ...doc, publiclyVisible: true, published },
      assets: new Map(),
      now: new Date("2026-09-05T13:00:00Z"),
    });
    expect(runtime.page).not.toHaveProperty("homeHeroTitle");
    expect(runtime.page).not.toHaveProperty("homeHeroSubtitle");

    const preview = createPreviewSnapshot("home", {
      ...doc,
      homeHeroTitle: "",
      homeHeroSubtitle: "   ",
    });
    expect(preview.homeHeroTitle).toBe("");
    expect(preview.homeHeroSubtitle).toBe("   ");

    for (const field of ["homeHeroTitle", "homeHeroSubtitle"]) {
      expect(() => createPublishedSnapshot({
        collection: "cmsPages",
        document: { ...doc, [field]: " " },
        publishedAt: "2026-09-05T12:00:00.000Z",
        publishedBy: "editor",
      })).toThrow(new RegExp(field));
    }
  });

  it("refuses hidden required content and malformed markers at every projection", () => {
    for (const mutation of [
      (doc: ReturnType<typeof document>) => { doc.blocks[0].visible = false; },
      (doc: ReturnType<typeof document>) => { doc.homeCompositionVersion = 3; },
    ]) {
      const doc = document();
      mutation(doc);
      const published = { blocks: doc.blocks, metadata: { title: doc.title, homeCompositionVersion: doc.homeCompositionVersion }, sourceVersion: 7, publishedBy: "editor", publishedAt: "2026-09-05T12:00:00.000Z" };
      expect(() => createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: published.publishedAt, publishedBy: "editor" })).toThrow();
      expect(() => createPreviewSnapshot("home", doc)).toThrow();
      expect(() => projectCmsPage(doc, { mode: "draft", pageId: "home", now: new Date() })).toThrow();
      expect(() => projectPublicPageDocument({ pageId: "home", document: { ...doc, publiclyVisible: true, published }, assets: new Map(), now: new Date("2026-09-05T13:00:00Z") })).toThrow();
    }
  });
});

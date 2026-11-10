import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { parseBlocks, type ContentShelfBlock } from "../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { readHomeEditorialSourceReceipt, resolveHomeShelf, homePostPlacements, homeSectionsUsingPost, homeSelectedPostIds } from "../../packages/content-core/src/home-source-catalog";
import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import { resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { createHomeEditorialCatalog, rebuildHomeSourcesForPosts } from "../src/lib/home-editorial-catalog";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import media from "../src/data/launch-media-manager.json";
import spotlight from "./fixtures/home-sources/spotlight-feed.json";
import posts from "./fixtures/home-sources/station-posts.json";
import fixture from "./fixtures/home-v2-selections.json";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/home-source-catalog.js");
const { assertHomeCatalogReceipt } = require("../../functions/lib/home-source-selection-admission.js");
const serverHero = require("../../functions/lib/home-hero.js");
const postIds = ["57298ff3b0d0917f9e653f80bada063d", "1208e81a5470be941e3fb392eac674ae"];
const shelf = () => structuredClone(fixture.home.blocks[7]) as ContentShelfBlock;

describe("saved Home selection and current catalog boundaries", () => {
  it("rejects inherited section names on the TypeScript and Functions readers", () => {
    for (const reader of [{ resolveHomeShelf }, server]) {
      for (const section of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const block = { ...shelf(), section, data: { itemLimit: 3 } };
        expect(() => reader.resolveHomeShelf(block as never, fixture.editorial.catalog))
          .toThrow("Keep the Home shelf's assigned source and approved destination.");
      }
    }
  });
  it("refreshes only the Post pool for fast publication and keeps immutable provider selections available", () => {
    const source = { ...createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt), editorial: readHomeEditorialSourceReceipt(fixture.editorial) };
    const currentPosts = [{ ...posts[0], title: "Corrected Post headline", sourceVersion: 41 }];
    const publication = { buildBatchId: "cms-HOME6FastCatalog001", generation: 22, commitSha: "a".repeat(40) };
    const result = rebuildHomeSourcesForPosts(source, currentPosts as never, publication, "2026-10-11T19:30:00.000Z");
    expect(assertHomeCatalogReceipt(result.editorial).receipt).toMatchObject(publication);
    for (const section of ["home-featured", "home-more", "home-spotlight"] as const) {
      expect(result.editorial!.catalog.sources[section]).toEqual(fixture.editorial.catalog.sources[section]);
    }
    const cards = resolveHomeShelf(shelf(), result.editorial!.catalog);
    expect(cards.cards.map(card => card.title)).toEqual(["Corrected Post headline"]);
    expect(cards.missingIds).toEqual(["57298ff3b0d0917f9e653f80bada063d"]);
    expect(source.editorial.receipt.generation).toBe(21);
    expect(() => rebuildHomeSourcesForPosts(source, [], publication, "2026-10-11T18:00:00.000Z")).toThrow(/forward cutoff/);
  });
  it("retains older published selected Posts beyond the recent picker window without changing automatic order", () => {
    const source = createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt);
    const many = Array.from({ length: 201 }, (_, index) => ({ ...posts[0], postId: `post-${index}`, path: `/posts/story-${index}/`, sortInstant: index, title: `Story ${index}` }));
    const snapshot = { blocks: [{ section: "home-posts", data: { selectedIds: ["post-0"] } }], homeHero: { mode: "manual", items: [{ source: "cms_posts", sourceId: "post-1", href: "/override/" }] } };
    for (const reader of [{ homeSelectedPostIds }, server]) expect(reader.homeSelectedPostIds(snapshot)).toEqual(["post-0", "post-1"]);
    const selected = createHomeEditorialCatalog(source, spotlight, many as never, fixture.editorial.catalog.cutoffAt, ["post-0", "post-1"]);
    const pool = selected.catalog.sources["home-posts"];
    if (pool.status !== "ready") throw new Error("fixture");
    expect(pool.cards).toHaveLength(200);
    expect(pool.cards[0].id).toBe("post-200");
    expect(pool.cards.slice(-2).map(card => card.id)).toEqual(["post-1", "post-0"]);
    expect(pool.cards.some(card => card.id === "post-2")).toBe(false);
  });
  it("admits the fixture selection on both contracts and retains only IDs/order, never copied card content", () => {
    const parsed = parseBlocks(fixture.home.blocks);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(homeCompositionError("home", 2, parsed.blocks)).toBeNull();
    expect(assertHomeCatalogReceipt(fixture.editorial)).toEqual(readHomeEditorialSourceReceipt(fixture.editorial));
    expect(shelf().data.selectedIds).toEqual(postIds);
    expect(shelf().data).not.toHaveProperty("cards");
    expect(shelf().data).not.toHaveProperty("resolvedCards");
  });
  it("publishes real station Post attribution/dates and admits the step 5 Spotlight feed instead of legacy display copy", () => {
    const source = createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt);
    const produced = createHomeEditorialCatalog(source, spotlight, posts as never, fixture.editorial.catalog.cutoffAt);
    expect(produced.catalog.sources["home-posts"]).toEqual(fixture.editorial.catalog.sources["home-posts"]);
    const news = produced.catalog.sources["home-spotlight"];
    expect(news.status).toBe("ready");
    const recorded = fixture.editorial.catalog.sources["home-spotlight"].cards;
    expect(recorded.map(card => card.byline)).toEqual(["jmooney", "NJ Spotlight"]);
    // #3513 changes only the account attribution in this recorded source.
    const expected = recorded.map(({ byline: _postingAccount, ...card }) => card);
    if (news.status === "ready") expect(news.cards.slice(0, 2)).toEqual(expected);
    expect(JSON.stringify(produced)).not.toMatch(/"request"|"audience"|"videos"|"status":"draft"/);
  });
  it("refreshes corrections and drops withdrawn cards in selection order without mutating the saved IDs", () => {
    const current = readHomeEditorialSourceReceipt(fixture.editorial).catalog;
    const pool = current.sources["home-posts"];
    if (pool.status !== "ready") throw new Error("fixture");
    pool.cards = [{ ...pool.cards[0], title: "Corrected published headline", summary: "Corrected published summary", sourceVersion: 41 }];
    for (const reader of [{ resolveHomeShelf }, server]) {
      const result = reader.resolveHomeShelf(shelf(), current);
      expect(result.cards.map((card: any) => card.id)).toEqual(["1208e81a5470be941e3fb392eac674ae"]);
      expect(result.cards[0].title).toBe("Corrected published headline");
      expect(result.missingIds).toEqual(["57298ff3b0d0917f9e653f80bada063d"]);
    }
    const html = renderHomeCuratedShelf(shelf(), current);
    expect(html).toContain("Corrected published headline");
    expect(html).toContain("Corrected published summary");
    expect(html).toContain("NJ PBS · NJ PBS · Sept. 16, 2026");
    expect(html).not.toContain("NJ PBS announces six staff appointments");
    expect(shelf().data.selectedIds).toEqual(postIds);
  });
  it("omits empty, withdrawn, hidden and unavailable v2 banks without legacy substitutions", () => {
    const current = readHomeEditorialSourceReceipt(fixture.editorial).catalog;
    expect(renderHomeCuratedShelf({ ...shelf(), data: { ...shelf().data, selectedIds: [] } }, current)).toBe("");
    expect(renderHomeCuratedShelf({ ...shelf(), visible: false }, current)).toBe("");
    current.sources["home-posts"] = { status: "error" };
    expect(renderHomeCuratedShelf(shelf(), current)).toBe("");
    const automatic = structuredClone(fixture.home.blocks[2]) as ContentShelfBlock;
    delete automatic.data.selectedIds; delete automatic.data.selectionReceipt;
    current.sources["home-featured"] = { status: "error" };
    expect(renderHomeCuratedShelf(automatic, current)).toBe("");
  });
  it("refuses widened source, forged catalog content, mismatched digest and duplicate IDs", () => {
    const source = structuredClone(fixture.editorial);
    source.catalog.sources["home-posts"].cards[0].title = "Forged card copy";
    expect(() => assertHomeCatalogReceipt(source)).toThrow(/digest/);
    const duplicate = structuredClone(fixture.editorial);
    duplicate.catalog.sources["home-posts"].cards.push(duplicate.catalog.sources["home-posts"].cards[0]);
    expect(() => readHomeEditorialSourceReceipt(duplicate)).toThrow(/cards/);
    expect(() => resolveHomeShelf({ ...shelf(), data: { ...shelf().data, source: "pbs_more" } }, source.catalog as never)).toThrow(/assigned source/);
    const unsafe = structuredClone(fixture.editorial);
    unsafe.catalog.sources["home-posts"].cards[0].href = "https://outside.example/post/";
    expect(() => readHomeEditorialSourceReceipt(unsafe)).toThrow(/cards/);
  });
  it("reports saved Post sections, native hero selection and non-rehydratable legacy placements on both consumers", () => {
    const blocks = [{ ...shelf(), visible: true }, { type: "prose", html: '<p><a href="https://njpbs.org/posts/fixture/index.html">Legacy</a></p>' },
      { id: "external", type: "prose", data: { href: "https://outside.example/posts/fixture/" } },
      { id: "hidden", visible: false, type: "prose", data: { href: "/posts/fixture" } }];
    const snapshot = { blocks, homeHero: { mode: "manual", items: [{ source: "cms_posts", sourceId: postIds[0], href: "/overridden-destination/" }] } };
    for (const reader of [{ homeSectionsUsingPost, homePostPlacements }, server]) {
      expect(reader.homeSectionsUsingPost([shelf()], postIds[0])).toEqual([{ blockId: "saved-home-posts", section: "home-posts", title: "From NJ PBS" }]);
      expect(reader.homePostPlacements(snapshot, postIds[0], ["fixture"])).toEqual([
        { blockId: "saved-home-posts", section: "home-posts", title: "From NJ PBS", refreshable: true },
        { blockId: "legacy-block-1", section: "content", title: "Home content", refreshable: false },
        { blockId: "hero", section: "hero", title: "Home hero", refreshable: true },
      ]);
      expect(reader.homePostPlacements({ homeHero: { mode: "manual", items: [{ href: "/posts/fixture" }] } }, postIds[0], ["fixture"])).toEqual([{ blockId: "hero", section: "hero", title: "Home hero", refreshable: false }]);
      expect(reader.homePostPlacements({ homeHero: { mode: "manual", items: [{ source: "cms_posts", sourceId: postIds[0], href: "/home-only-link/" }] } }, postIds[0], ["fixture"])).toEqual([{ blockId: "hero", section: "hero", title: "Home hero", refreshable: true }]);
      expect(reader.homePostPlacements({ homeHero: { mode: "tag", source: "cms_posts", value: "News" } }, "post", [], { tags: ["News"] })).toEqual([{ blockId: "hero", section: "hero", title: "Home hero", refreshable: true }]);
      const { selectedIds: _ids, selectionReceipt: _receipt, ...automaticData } = shelf().data;
      expect(reader.homePostPlacements({ blocks: [{ ...shelf(), data: automaticData }] }, "new-published-post")).toEqual([
        { blockId: "saved-home-posts", section: "home-posts", title: "From NJ PBS", refreshable: true },
      ]);
    }
  });
  it("refreshes a manually selected native hero from current publication and removes its withdrawn item on both readers", () => {
    const config = { mode: "manual", items: [{ itemId: "retained-hero", source: "cms_posts", sourceId: posts[0].postId, title: "", summary: "", href: "" }] };
    const card = { id: posts[0].postId, source: "cms_posts", title: "Corrected Post", summary: "Current summary", href: posts[0].path,
      categories: [], tags: [], byline: "NJ PBS", displayDate: "2026-09-16", image: { url: posts[0].heroImage.url, alt: posts[0].heroImageAlt } };
    for (const reader of [{ resolveHomeHero }, serverHero]) {
      expect(reader.resolveHomeHero(config, [card])).toEqual([{ id: "retained-hero", title: "Corrected Post", summary: "Current summary", href: posts[0].path,
        byline: "NJ PBS", displayDate: "2026-09-16", image: card.image }]);
      expect(reader.resolveHomeHero(config, [])).toEqual([]);
      const overridden = { ...config, items: [{ ...config.items[0], title: "Home headline", summary: "Home summary", href: "/home-only-link/", imageAssetId: "home-image", alt: "Home artwork" }] };
      expect(reader.resolveHomeHero(overridden, [card], { "home-image": { url: "/home-image.jpg" } })).toEqual([
        { id: "retained-hero", title: "Home headline", summary: "Home summary", href: "/home-only-link/", byline: "NJ PBS", displayDate: "2026-09-16", image: { url: "/home-image.jpg", alt: "Home artwork" } },
      ]);
      expect(reader.resolveHomeHero(overridden, [], { "home-image": { url: "/home-image.jpg" } })).toEqual([]);
      const legacy = { mode: "manual", items: [{ itemId: "legacy", title: "Old title", summary: "Old summary", href: posts[0].path }] };
      expect(reader.resolveHomeHero(legacy, [])).toEqual([{ id: "legacy", title: "Old title", summary: "Old summary", href: posts[0].path }]);
    }
  });
});

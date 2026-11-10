import { describe, expect, it } from "vitest";
import * as core from "../../packages/content-core/src/home-hero";
import generated from "../../functions/lib/home-hero.js";
import * as sources from "../../packages/content-core/src/home-source-catalog";
import generatedSources from "../../functions/lib/home-source-catalog.js";
import metadata from "../../functions/lib/content-metadata.js";
import preview from "../../functions/lib/preview-snapshot.js";
import publication from "../../functions/lib/publish-snapshot.js";
import projection from "../../functions/lib/public-content-projection.js";

const now = Date.parse("2026-11-03T20:00:00.000Z");
const card = (id: string, source: core.HomeHeroCatalogItem["source"] = "cms_posts", tags = ["news"]): core.HomeHeroCatalogItem => ({
  id, source, title: id, summary: "Published summary", href: source === "cms_pages" ? `/${id}/` : `/posts/${id}/`, categories: tags, tags,
});
const pin = (sourceId: string, source: core.HomeHeroPin["source"] = "cms_posts", endsAt?: string): core.HomeHeroPin => ({
  source, sourceId, ...(endsAt ? { endsAt } : {}),
});
const config = (pins: core.HomeHeroPin[], mode: "tag" | "category" = "tag") => ({ mode, source: "cms_posts", value: "news", limit: 4, pins });
for (const [name, hero] of [["core", core], ["Functions", generated]] as const) {
  describe(`${name} hero pins`, () => {
    it.each(["tag", "category"] as const)("puts ordered pins before %s auto fill, dedupes destinations and respects the saved limit", mode => {
      const catalog = [card("newest"), card("pinned-post"), card("next"), card("older"), card("pinned-page", "cms_pages")];
      const chosen = config([pin("pinned-page", "cms_pages"), pin("pinned-post"), pin("next")], mode);
      expect(hero.resolveHomeHero(chosen, catalog, {}, now).map(item => item.href)).toEqual([
        "/pinned-page/", "/posts/pinned-post/", "/posts/next/", "/posts/newest/",
      ]);
      expect(hero.resolveHomeHero({ ...chosen, limit: 1 }, catalog, {}, now).map(item => item.id)).toEqual(["pinned-page"]);
      expect(hero.resolveHomeHero(config([pin("pinned-page", "cms_pages")]), [card("pinned-page", "cms_pages"),
        { ...card("same-destination"), href: "/pinned-page/" }, card("newest")], {}, now).map(item => item.id)).toEqual(["pinned-page", "newest"]);
    });
    it("pins content outside the automatic classification and drops expired, unpublished, deleted and withdrawn selections", () => {
      const chosen = config([pin("withdrawn"), pin("ended", "cms_pages", "2026-11-03T20:00:00.000Z"), pin("outside")]);
      const catalog = [card("newest"), card("ended", "cms_pages"), card("outside", "cms_posts", ["other"])];
      expect(hero.resolveHomeHero(chosen, catalog, {}, now - 1).map(item => item.id)).toEqual(["ended", "outside", "newest"]);
      expect(hero.resolveHomeHero(chosen, catalog, {}, now).map(item => item.id)).toEqual(["outside", "newest"]);
      expect(hero.resolveHomeHero(config([pin("unpublished"), pin("deleted")]), [card("newest")], {}, now).map(item => item.id)).toEqual(["newest"]);
      expect(hero.resolveHomeHero(config([pin("outside")]), [], {}, now)).toEqual([]);
    });
    it("keeps legacy data and manual selection unchanged and validates pin boundaries", () => {
      const legacy = { mode: "tag", source: "cms_posts", value: "news" };
      expect(hero.parseHomeHero(legacy)).toEqual(legacy);
      expect(hero.resolveHomeHero(legacy, [card("newest")], {}, now).map(item => item.id)).toEqual(["newest"]);
      const manual = { mode: "manual", items: [{ itemId: "link", title: "Manual", href: "/manual/", summary: "" }] };
      expect(hero.resolveHomeHero(manual, [], {}, now).map(item => item.href)).toEqual(["/manual/"]);
      for (const pins of [null, {}, [pin("a"), pin("b"), pin("c"), pin("d")], [pin("a"), pin("a")], [pin("../a")],
        [pin("home", "cms_pages")], [{ ...pin("a"), source: "spotlight" }], [{ ...pin("a"), href: "/copy/" }],
        [pin("a", "cms_posts", "2026-11-03T15:00")], [pin("a", "cms_posts", "2026-02-30T20:00:00.000Z")]]) {
        expect(() => hero.parseHomeHero({ ...legacy, pins })).toThrow();
      }
      expect(() => hero.parseHomeHero({ ...manual, pins: [] })).toThrow(/manual/);
      expect(hero.parseHomeHero(config([pin("same"), pin("same", "cms_pages")]))?.pins).toHaveLength(2);
    });
    it("ends priority without excluding a still-matching story from normal auto fill", () => {
      const catalog = [card("newest"), card("older")];
      expect(hero.resolveHomeHero(config([pin("older", "cms_posts", "2026-11-03T20:00:00.000Z")]), catalog, {}, now - 1).map(item => item.id)).toEqual(["older", "newest"]);
      expect(hero.resolveHomeHero(config([pin("older", "cms_posts", "2026-11-03T20:00:00.000Z")]), catalog, {}, now).map(item => item.id)).toEqual(["newest", "older"]);
      expect(hero.resolveHomeHero(config([]), catalog, {}, now).map(item => item.id)).toEqual(["newest", "older"]);
    });
  });
}

it("carries exact pin order and expiry through the metadata save, saved preview and frozen public snapshot", () => {
  const homeHero = config([pin("page-contact", "cms_pages"), pin("post-one", "cms_posts", "2026-11-04T01:00:00.000Z")]);
  const document = { title: "Home", template: "home", blocks: [], version: 7, homeHero };
  expect(metadata.validateKnownMetadata(document)).toBeNull();
  const frozen = publication.createPublishedSnapshot({ collection: "cmsPages", document,
    publishedAt: "2026-11-03T19:00:00.000Z", publishedBy: "editor" });
  expect(frozen.metadata.homeHero).toEqual(homeHero);
  expect(preview.createPreviewSnapshot("home", document).homeHero).toEqual(homeHero);
  const result = projection.projectPublicPageDocument({ pageId: "home", document: { ...document, status: "draft", publiclyVisible: true,
    publishAt: frozen.publishedAt, published: frozen }, assets: new Map(), now: new Date(now) });
  expect(result.page.homeHero).toEqual(homeHero);
  expect(metadata.validateKnownMetadata({ ...document, homeHero: config([pin("a"), pin("a")]) })).toMatch(/unique/);
});

it("retains and refreshes pinned Posts even outside the Home classification in both runtimes", () => {
  const homeHero = config([pin("outside"), pin("contact", "cms_pages")]);
  for (const implementation of [sources, generatedSources]) {
    expect(implementation.homeSelectedPostIds({ homeHero })).toEqual(["outside"]);
    expect(implementation.homePostPlacements({ homeHero }, "outside", [], { tags: ["other"] })).toEqual([
      { blockId: "hero", section: "hero", title: "Home hero", refreshable: true },
    ]);
  }
});

it("includes dependent Home in paired Page publication when a pin changed or its end time passed", () => {
  for (const hero of [core, generated]) {
    expect(hero.homeHeroNeedsPageRefresh(config([pin("contact", "cms_pages")]), ["contact"], now)).toBe(true);
    expect(hero.homeHeroNeedsPageRefresh(config([pin("contact", "cms_pages")]), ["watch"], now)).toBe(false);
    expect(hero.homeHeroNeedsPageRefresh(config([pin("older", "cms_posts", "2026-11-03T20:00:00.000Z")]), ["watch"], now)).toBe(true);
    expect(hero.homeHeroNeedsPageRefresh({ mode: "manual", items: [] }, ["contact"], now)).toBe(false);
  }
});

import { describe, expect, it } from "vitest";
import * as hero from "../../packages/content-core/src/home-hero";
import generatedHero from "../../functions/lib/home-hero.js";
import { homePostPlacements } from "../../packages/content-core/src/home-source-catalog";
import generatedSources from "../../functions/lib/home-source-catalog.js";
import snapshot from "../../functions/lib/publish-snapshot.js";
import metadata from "../../functions/lib/content-metadata.js";
import contract from "../../functions/lib/content-document-contract.js";

// Current production Home receipt, read-only on October 19: sourceVersion 100.
const liveHero = { mode: "tag", source: "cms_posts", value: "announcement", limit: 10, presentation: "editorial" };
const listHero = { mode: "tag", source: "cms_posts", values: ["announcement", "home", "hero", "main"], limit: 3 };
const post = (id: string, tags: string[], showInHomeHero?: boolean): hero.HomeHeroCatalogItem => ({
  id, source: "cms_posts", title: id, summary: "", href: `/posts/${id}/`, categories: ["news"], tags,
  ...(showInHomeHero === undefined ? {} : { showInHomeHero }),
});
const catalog = [post("checked", [], true), post("unrelated", ["other"], false), post("legacy", ["announcement"]),
  post("main", ["main"]), post("home", ["home", "hero"]), post("case", ["Home"])];

for (const [name, implementation] of [["content-core", hero], ["Functions generated copy", generatedHero]] as const) {
  describe(`${name} Home hero tag contract`, () => {
    it("includes the checkbox with unchanged live Home settings and excludes an unrelated unticked Post", () => {
      expect(implementation.resolveHomeHero(liveHero, catalog).map(card => card.id)).toEqual(["checked", "legacy"]);
      expect(implementation.parseHomeHero(liveHero)).toEqual(liveHero);
    });
    it("matches any exact listed tag, with the existing ordering, deduplication and limit", () => {
      expect(implementation.resolveHomeHero(listHero, [catalog[0], catalog[0], ...catalog.slice(1)]).map(card => card.id)).toEqual(["checked", "legacy", "main"]);
      expect(implementation.resolveHomeHero({ ...listHero, limit: 10 }, catalog).map(card => card.id)).toEqual(["checked", "legacy", "main", "home"]);
      expect(implementation.resolveHomeHero({ ...listHero, values: ["home", "Home"] }, catalog).map(card => card.id)).toEqual(["checked", "home", "case"]);
      expect(implementation.resolveHomeHero({ mode: "category", source: "cms_posts", value: "missing" }, catalog)).toEqual([]);
      expect(implementation.resolveHomeHero({ mode: "tag", source: "cms_posts", value: "announcement" }, [
        { ...catalog[0], source: "spotlight" },
      ])).toEqual([]);
    });
    it("rejects malformed, empty, untrimmed, duplicate, oversized or ambiguous lists with a clear error", () => {
      for (const values of [null, "home", [], [42], [""], [" home"], ["home "], ["home", "home"], ["x".repeat(201)], Array.from({ length: 21 }, (_, i) => `tag-${i}`)]) {
        expect(() => implementation.parseHomeHero({ ...listHero, values })).toThrow(/Home hero tags/);
      }
      expect(() => implementation.parseHomeHero({ ...listHero, value: "announcement" })).toThrow(/Home hero tags/);
      expect(() => implementation.parseHomeHero({ ...listHero, values: [] })).toThrow("Home hero tags: Add one to 20 tags.");
      expect(() => implementation.parseHomeHero({ mode: "category", source: "cms_posts", value: "news", values: ["news"] })).toThrow(/only to tag mode/);
      expect(() => implementation.parseHomeHero({ mode: "manual", items: [], values: ["home"] })).toThrow(/manual selection/);
    });
    it("preserves the checkbox through a retained catalog and rejects a non-boolean selection", () => {
      const retained = implementation.readHomeHeroCatalog(catalog);
      expect(retained[0].showInHomeHero).toBe(true);
      expect(implementation.resolveHomeHero(liveHero, retained).map(card => card.id)).toEqual(["checked", "legacy"]);
      expect(() => implementation.readHomeHeroCatalog([{ ...catalog[0], showInHomeHero: "true" }])).toThrow(/boolean/);
    });
  });
}

describe("Post publication boundaries", () => {
  it("saves and freezes a separate boolean without adding a public topic tag", () => {
    for (const showInHomeHero of [true, false]) {
      const document = { type: "post", title: "A story", slug: "a-story", version: 1, date: "2026-10-19", locale: "en", previousSlugs: [], tags: ["Transit"], blocks: [], showInHomeHero };
      expect(contract.unsupportedContentFields("cmsPosts", "post", { showInHomeHero })).toEqual([]);
      expect(contract.validateContentFieldValues("cmsPosts", "post", { showInHomeHero })).toBeNull();
      expect(metadata.validateKnownMetadata(document)).toBeNull();
      const published = snapshot.createPublishedSnapshot({ document, collection: "cmsPosts", publishedAt: "2026-10-19T12:00:00.000Z", publishedBy: "editor" });
      expect(published.metadata.showInHomeHero).toBe(showInHomeHero);
      expect(published.metadata.tags).toEqual(["Transit"]);
    }
    expect(metadata.validateKnownMetadata({ type: "post", showInHomeHero: "yes" })).toMatch(/boolean/);
    expect(contract.validateContentFieldValues("cmsPosts", "post", { showInHomeHero: "yes" })).toMatch(/boolean/);
    expect(() => snapshot.createPublishedSnapshot({ document: { type: "post", title: "A story", slug: "a-story", blocks: [], showInHomeHero: "yes" }, collection: "cmsPosts", publishedAt: "2026-10-19T12:00:00.000Z", publishedBy: "editor" })).toThrow(/boolean/);
  });
  it("refreshes build-free Home for checkbox and any-tag changes while leaving category selection unchanged", () => {
    for (const placements of [homePostPlacements, generatedSources.homePostPlacements]) {
      expect(placements({ homeHero: liveHero }, "checked", [], { tags: [], showInHomeHero: true })).toEqual([
        { blockId: "hero", section: "hero", title: "Home hero", refreshable: true },
      ]);
      expect(placements({ homeHero: liveHero }, "unchecked", [], { tags: [], showInHomeHero: false })).toEqual([]);
      expect(placements({ homeHero: listHero }, "main", [], { tags: ["main"] })).toHaveLength(1);
      expect(placements({ homeHero: { mode: "category", source: "cms_posts", value: "news" } }, "checked", [], { categories: [], showInHomeHero: true })).toEqual([]);
    }
  });
});

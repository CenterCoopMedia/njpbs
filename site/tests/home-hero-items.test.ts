import { spotlightCopyImageUrl } from "../../packages/content-core/src/spotlight-image.mjs";
import * as hero from "../../functions/lib/home-hero.js";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseHomeHero, resolveHomeHero, homeHeroAssetIds, readHomeHeroCatalog, type HomeHeroCatalogItem } from "../../packages/content-core/src/home-hero";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";
import { projectCmsPage } from "../src/lib/cms-loader";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { resolveHomeHeroItems } from "../src/lib/home-hero-items";
import launchMedia from "../src/data/launch-media-manager.json";
import spotlight from "../src/data/spotlight-news.json";

const manual = (index = 1) => ({ itemId: `slide-${index}`, title: `Slide ${index}`, summary: "Summary", href: `/updates/slide-${index}/` });
const catalog: HomeHeroCatalogItem[] = Array.from({ length: 12 }, (_, index) => ({
  id: `post-${index}`, title: `Post ${index}`, summary: "Summary", href: `/posts/post-${index}/`,
  source: "cms_posts", categories: ["news"], tags: [index % 2 ? "budget" : "health"],
}));

describe("Home hero settings and frozen resolution", () => {
  it("preserves valid story dates through automatic and manual selection", () => {
    const dated = { ...catalog[0], displayDate: "2026-09-15" };
    expect(resolveHomeHero({ mode: "category", source: "cms_posts", value: "news" }, [dated])[0].displayDate).toBe("2026-09-15");
    expect(resolveHomeHero({ mode: "manual", items: [{ ...manual(), href: dated.href }] }, [dated])[0].displayDate).toBe("2026-09-15");
    const provider = { ...dated, source: "spotlight" as const };
    expect(resolveHomeHero({ mode: "manual", items: [{ ...manual(), source: "spotlight", sourceId: provider.id }] }, [provider])[0].displayDate).toBe("2026-09-15");
    for (const displayDate of ["2026-09-15", "2026-02-30", undefined]) {
      const entries = [{ ...dated, displayDate }];
      const config = { mode: "manual", items: [{ ...manual(), href: dated.href }] };
      expect(hero.readHomeHeroCatalog(entries)).toEqual(readHomeHeroCatalog(entries));
      expect(hero.resolveHomeHero(config, entries)).toEqual(resolveHomeHero(config, entries));
    }
    expect(readHomeHeroCatalog([dated])[0].displayDate).toBe("2026-09-15");
    expect(readHomeHeroCatalog([{ ...dated, displayDate: "2026-02-30" }])[0].displayDate).toBeUndefined();
    expect(resolveHomeHero({ mode: "manual", items: [manual()] }, [dated])[0].displayDate).toBeUndefined();
  });
  it("keeps missing and empty selections on the existing fallback", () => {
    expect(parseHomeHero(undefined)).toBeUndefined();
    expect(resolveHomeHero(undefined, catalog)).toEqual([]);
    expect(resolveHomeHero({ mode: "manual", items: [] }, catalog)).toEqual([]);
    expect(resolveHomeHero({ mode: "category", source: "cms_posts", value: "missing" }, catalog)).toEqual([]);
  });
  it("supports ten ordered manual slides and rejects unsafe or invalid settings", () => {
    const config = { mode: "manual", items: Array.from({ length: 10 }, (_, index) => manual(index)) };
    expect(resolveHomeHero(config, []).map(card => card.id)).toEqual(config.items.map(item => item.itemId));
    for (const invalid of [
      { ...config, items: [...config.items, manual(10)] },
      { ...config, limit: 0 },
      { ...config, items: [manual(), manual()] },
      { ...config, items: [{ ...manual(), href: "javascript:alert(1)" }] },
      { ...config, items: [{ ...manual(), href: "//private.example/" }] },
      { ...config, items: [{ ...manual(), href: "https://" }] },
      { ...config, items: [{ ...manual(), href: "https://user:password@example.com/" }] },
      { ...config, items: [{ ...manual(), href: "https://example.com/\\secret" }] },
      { ...config, items: [{ ...manual(), imageAssetId: "../secret", alt: "Image" }] },
      { ...config, items: [{ ...manual(), source: "media_manager" }] },
      { mode: "tag", source: "media_manager", value: "invented" },
      { mode: "tag", source: "spotlight", value: "invented" },
    ]) expect(() => parseHomeHero(invalid)).toThrow();
  });
  it("filters exact public taxonomy, keeps input order and deduplicates before the ten cap", () => {
    expect(resolveHomeHero({ mode: "category", source: "cms_posts", value: "news" }, [catalog[0], ...catalog])).toEqual(catalog.slice(0, 10).map(({ source, categories, tags, ...card }) => card));
    expect(resolveHomeHero({ mode: "tag", source: "cms_posts", value: "budget", limit: 3 }, catalog).map(card => card.id)).toEqual(["post-1", "post-3", "post-5"]);
  });
  it("uses current provider artwork and keeps saved provider copies after feed rotation", () => {
    const provider = { ...catalog[0], source: "media_manager" as const, image: { url: "https://image.pbs.org/show.jpg", alt: "Source" } };
    const item = { ...manual(), source: "media_manager", sourceId: provider.id };
    expect(resolveHomeHero({ mode: "manual", items: [item] }, [provider])[0].image).toEqual(provider.image);
    expect(resolveHomeHero({ mode: "manual", items: [item] }, [])).toEqual([{ id: item.itemId, title: item.title, summary: item.summary, href: item.href, actionLabel: "Watch the report" }]);
    expect(resolveHomeHero({ mode: "manual", items: [{ ...item, source: "cms_posts" }] }, [])).toEqual([]);
    const override = { ...item, imageAssetId: "station-image", alt: "Local image" };
    expect(homeHeroAssetIds({ mode: "manual", items: [override] })).toEqual(["station-image"]);
    expect(resolveHomeHero({ mode: "manual", items: [override] }, [provider], { "station-image": { url: "/media/image.webp" } })[0].image).toEqual({ url: "/media/image.webp", alt: "Local image" });
  });
  it("provides the same bounded public-only release catalog beyond the eight-card rail", () => {
    const snapshot = createHomeSourceSnapshot(launchMedia, spotlight);
    const cards = readHomeHeroCatalog(snapshot.heroCatalog);
    expect(cards.filter(card => card.source === "media_manager").length).toBeGreaterThan(10);
    expect(cards.some(card => card.source === "spotlight" && card.categories.length > 0)).toBe(true);
    expect(JSON.stringify(cards)).not.toContain('"request"');
    expect(JSON.stringify(cards)).not.toContain('"audience"');
  });
  it("uses reviewed Spotlight photos first and topic art for every category match", () => {
    const snapshot = createHomeSourceSnapshot(launchMedia, spotlight);
    const spotlightCatalog = readHomeHeroCatalog(snapshot.heroCatalog).filter(card => card.source === "spotlight");
    const categories = [...new Set(spotlightCatalog.flatMap(card => card.categories))];

    for (const category of categories) {
      const cards = resolveHomeHeroItems({ mode: "category", source: "spotlight", value: category }, snapshot, []);
      expect(cards.length, category).toBeGreaterThan(0);
      for (const card of cards) {
        const url = card.image!.url;
        if (url.startsWith("https://")) {
          expect(spotlightCopyImageUrl(url), `${category}: ${card.title}`).toBe(url);
        } else {
          expect(url, `${category}: ${card.title}`).toMatch(/^\/brand\/spotlight\/.+\.jpg$/);
          expect(existsSync(resolve("public", url.slice(1))), url).toBe(true);
        }
      }
    }

    const reviewed = RELATED_STORY_INDEX.items[0];
    expect(spotlightCatalog.find(card => card.id === reviewed.id)?.image?.url).toBe(reviewed.thumbnail?.url);
    const delaneyHall = resolveHomeHeroItems(
      { mode: "category", source: "spotlight", value: "delaney-hall" }, snapshot, [],
    );
    expect(delaneyHall[0].image?.url).toBe("https://media.njpbs.org/cms-media/spotlight/77abda1058885842264827a77c093955df56f04ca2685be102786866dd1642e5/d700ed67f6689e1410fad8d8c8ba9e0547bb517cef91679e4fe157c6672e40a8.jpg");
    expect(delaneyHall.slice(1).every(card => /^\/brand\/spotlight\/immigration(?:-02)?\.jpg$/.test(card.image?.url ?? ""))).toBe(true);
    expect(RELATED_STORY_INDEX.items[5].thumbnail).toBeUndefined();
    expect(spotlightCatalog[5].image?.url).toMatch(/^\/brand\/spotlight\/budget(?:-02)?\.jpg$/);
  });
  it("keeps published hero metadata detached from draft edits and includes only addressed hero media", () => {
    const publicHero = { mode: "manual", items: [{ ...manual(), imageAssetId: "public-image", alt: "Public art" }] };
    const draftHero = { mode: "manual", items: [{ ...manual(), title: "Draft title", imageAssetId: "draft-image", alt: "Draft art" }] };
    const assets = new Map(["public-image", "draft-image"].map(id => [id, { id, url: `https://media.njpbs.org/cms-media/${id}.webp`, mimeType: "image/webp", width: 1600, height: 900 }]));
    const doc = { id: "home", template: "home", title: "Home", status: "published", publiclyVisible: true, publishAt: "2026-09-12T12:00:00Z",
      version: 3, blocks: [], homeHero: draftHero, published: { sourceVersion: 2, publishedAt: "2026-09-12T12:00:00Z", blocks: [], metadata: { title: "Home", homeHero: publicHero } } };
    const now = new Date("2026-09-12T13:00:00Z");
    const published = projectCmsPage(doc, { mode: "published", now, assets });
    const draft = projectCmsPage(doc, { mode: "draft", pageId: "home", now, assets });
    expect(published?.homeHero).toEqual(publicHero);
    expect(Object.keys(published?.assets ?? {})).toEqual(["public-image"]);
    expect(draft?.homeHero).toEqual(draftHero);
    expect(Object.keys(draft?.assets ?? {})).toEqual(["draft-image"]);
  });
  it("ignores invalid extra provider cards without changing the existing rail admission", () => {
    const cards = Array.from({ length: 24 }, (_, index) => ({ title: `Program ${index}`, description: "Description", href: `https://watch.njpbs.org/show/${index}/` }));
    const snapshot = createHomeSourceSnapshot({ cards: [...cards, { title: "Broken" }, cards[0]] }, {});
    expect(snapshot.pbs.featured).toHaveLength(8);
    expect(snapshot.pbs.more).toHaveLength(16);
    expect(snapshot.heroCatalog?.filter(card => card.source === "media_manager")).toHaveLength(24);
    expect(createHomeSourceSnapshot({ cards: [] }, {}).heroCatalog?.filter(card => card.source === "media_manager")).toEqual([]);
  });
  it("falls back on unavailable source data but does not hide invalid saved configuration", () => {
    expect(resolveHomeHeroItems({ mode: "category", source: "cms_posts", value: "news" }, undefined, [])).toEqual([]);
    expect(() => resolveHomeHeroItems({ mode: "unknown" }, undefined, [])).toThrow();
  });
});

it("keeps the published checkbox through the Post projection and bounded Home preview catalog", async () => {
  const { projectCmsPost } = await import("../src/lib/cms-posts-projection");
  const { homeSourcePreviewSnapshot } = await import("../src/lib/home-hero-items");
  const document = { id: "checked-post", status: "published", publiclyVisible: true, publishAt: "2026-10-19T12:00:00.000Z",
    showInHomeHero: false, published: { sourceVersion: 1, publishedAt: "2026-10-19T12:00:00.000Z", blocks: [],
      metadata: { type: "post", title: "Checked Post", date: "2026-10-19", slug: "checked-post", tags: [], showInHomeHero: true } } };
  const projected = projectCmsPost(document, { now: new Date("2026-10-19T13:00:00.000Z") })!;
  expect(projected.showInHomeHero).toBe(true);
  expect(projected.tags).toEqual([]);
  const config = { mode: "tag", source: "cms_posts", value: "announcement", limit: 10, presentation: "editorial" };
  expect(resolveHomeHeroItems(config, undefined, [projected]).map(card => card.id)).toEqual(["checked-post"]);
  const retained = homeSourcePreviewSnapshot(createHomeSourceSnapshot({}, {}), [projected]);
  expect(resolveHomeHero(config, retained.heroCatalog ?? []).map(card => card.id)).toEqual(["checked-post"]);
  const unchecked = projectCmsPost({ ...document, showInHomeHero: true, published: { ...document.published,
    metadata: { ...document.published.metadata, showInHomeHero: false } } }, { now: new Date("2026-10-19T13:00:00.000Z") })!;
  expect(resolveHomeHeroItems(config, undefined, [unchecked])).toEqual([]);
  expect(() => projectCmsPost({ ...document, published: { ...document.published,
    metadata: { ...document.published.metadata, showInHomeHero: "true" } } }, { now: new Date("2026-10-19T13:00:00.000Z") })).toThrow(/boolean/);
});

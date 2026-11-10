import { describe, expect, it } from "vitest";
import { parseHomeHero } from "../../packages/content-core/src/home-hero";
import hero from "../../functions/lib/home-hero.js";
import metadata from "../../functions/lib/content-metadata.js";
import preview from "../../functions/lib/preview-snapshot.js";
import publication from "../../functions/lib/publish-snapshot.js";
import projection from "../../functions/lib/public-content-projection.js";
import usage from "../../functions/lib/media-usage.js";

const at = "2026-09-12T12:00:00.000Z";
const manual = () => ({ mode: "manual", items: [{ itemId: "one", title: "New Jersey story",
  summary: "A local story", href: "/posts/local-story/", imageAssetId: "hero-image", alt: "A town square" }] });
const page = (homeHero = manual()) => ({ title: "NJ PBS", template: "home", blocks: [], version: 7, homeHero });
const publish = (document: unknown) => publication.createPublishedSnapshot({ collection: "cmsPages", document,
  publishedAt: at, publishedBy: "fixture-editor" });

describe("Home hero frozen boundaries", () => {
  it("counts repeated hero image use while freezing each asset once", () => {
    const homeHero = manual();
    homeHero.items.push({ ...homeHero.items[0], itemId: "two", href: "/posts/another-story/" });
    const document = page(homeHero);
    expect(usage.collectWorkingMediaUsage({ collection: "cmsPages", document }))
      .toMatchObject({ assetIds: ["hero-image"], occurrenceCount: 2 });
    expect(preview.referencedPreviewAssetIds(preview.createPreviewSnapshot("home", document))).toEqual(["hero-image"]);
  });
  it.each([manual(), { mode: "manual", items: [] }, { mode: "category", source: "cms_posts", value: "News", limit: 10 },
    { mode: "tag", source: "cms_posts", value: "Community", limit: 1 },
    { mode: "tag", source: "cms_posts", values: ["announcement", "home", "hero", "main"], limit: 10 }])("keeps the core and Functions contracts equal: %j", value => {
    expect(hero.parseHomeHero(value)).toEqual(parseHomeHero(value));
    expect(metadata.validateKnownMetadata({ homeHero: value })).toBeNull();
  });
  it.each([
    { mode: "manual", items: Array.from({ length: 11 }, (_, index) => ({ ...manual().items[0], itemId: String(index) })) },
    { mode: "manual", items: [{ ...manual().items[0], href: "javascript:alert(1)" }] },
    { mode: "manual", items: [{ ...manual().items[0], href: "https://" }] },
    { mode: "manual", items: [{ ...manual().items[0], href: "https://user:password@example.com/" }] },
    { mode: "manual", items: [{ ...manual().items[0], imageUrl: "https://untrusted.example/image.jpg" }] },
    { mode: "manual", items: [{ ...manual().items[0], imageAssetId: "nested/asset" }] },
    { mode: "tag", source: "media_manager", value: "News" },
    { mode: "manual", items: [{ ...manual().items[0], source: "spotlight" }] },
  ])("rejects unsafe or unsupported configuration at every freeze boundary: %j", value => {
    expect(() => parseHomeHero(value)).toThrow();
    expect(() => hero.parseHomeHero(value)).toThrow();
    expect(metadata.validateKnownMetadata({ homeHero: value })).toEqual(expect.any(String));
    expect(() => preview.createPreviewSnapshot("home", page(value as ReturnType<typeof manual>))).toThrow();
    expect(() => publish(page(value as ReturnType<typeof manual>))).toThrow();
  });
  it("copies exact preview and public configuration and keeps later drafts private", () => {
    const document = page();
    const frozen = publish(document);
    const saved = preview.createPreviewSnapshot("home", document);
    document.homeHero.items[0].title = "Private later edit";
    document.homeHero.items[0].imageAssetId = "private-image";
    expect(saved.homeHero.items[0].title).toBe("New Jersey story");
    expect(frozen.metadata.homeHero.items[0].title).toBe("New Jersey story");
    const result = projection.projectPublicPageDocument({ pageId: "home", document: {
      ...document, status: "draft", publiclyVisible: true, publishAt: at, published: frozen,
    }, assets: new Map([["hero-image", { url: "https://media.njpbs.org/cms-media/hero.jpg", mimeType: "image/jpeg", width: 1200, height: 800 }]]),
    now: new Date("2026-09-12T12:01:00Z") });
    expect(result.page.homeHero.items[0].title).toBe("New Jersey story");
    expect(JSON.stringify(result)).not.toContain("Private later edit");
    expect(JSON.stringify(result)).not.toContain("private-image");
    expect(preview.referencedPreviewAssetIds(saved)).toEqual(["hero-image"]);
    expect(usage.collectPublishedMediaUsage({ collection: "cmsPages", snapshot: frozen }).assetIds).toEqual(["hero-image"]);
    expect(usage.collectWorkingMediaUsage({ collection: "cmsPages", document }).assetIds).toEqual(["private-image"]);
  });
});

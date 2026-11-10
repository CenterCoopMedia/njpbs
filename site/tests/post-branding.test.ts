// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderPostBranding } from "../../packages/content-core/src/post-branding";
import { readHomeHeroCatalog, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import * as deployedHero from "../../functions/lib/home-hero.js";
import { homeHeroCatalog } from "../src/lib/home-hero-items";
import { authorPageContent } from "../src/lib/author-pages";
import type { CmsPostBuildData } from "../src/lib/cms-posts-loader";

const post = (spotlightNews?: boolean) => ({
  postId: "post-1", title: "Transit changes", summary: "A summary", excerpt: "",
  path: "/posts/transit-changes/", categories: ["Transit"], tags: ["rail"],
  authorIds: ["author-1"], displayDate: "2026-10-06", sortInstant: 1,
  credits: [{ name: "Test reporter", authorId: "author-1" }],
  heroImage: null, spotlightNews,
} as CmsPostBuildData);

describe("Post publication attribution", () => {
  it("emits a visible label only for an explicit opt-in, without an interactive or heading element", () => {
    for (const flag of [undefined, false, null, "true", 1]) expect(renderPostBranding(flag)).toBe("");
    expect(renderPostBranding(true)).toBe('<span class="post-publication post-publication--headline" data-publication="nj-spotlight-news">NJ Spotlight News</span>');
    expect(renderPostBranding(true, "card")).toContain("post-publication--card");
  });

  it("keeps the publication on both pinned and recent author listings", () => {
    const author = { authorId: "author-1", pinnedPostId: "post-1", hiddenPostIds: [] };
    const second = { ...post(), postId: "post-2" };
    const listings = authorPageContent(author, [post(true), second]).listings;
    expect(listings.map(item => item.spotlightNews)).toEqual([true, false]);
    expect(listings[0].title).toBe("Transit changes");
  });

  it("labels automatic and manual Home hero selections from admitted Post metadata", () => {
    const catalog = homeHeroCatalog(undefined, [post(true), { ...post(false), postId: "post-2", path: "/posts/other/" }]);
    const automatic = resolveHomeHero({ mode: "category", source: "cms_posts", value: "Transit" }, catalog);
    expect(automatic.map(item => item.eyebrow)).toEqual(["NJ Spotlight News", "NJ PBS"]);
    expect(automatic.map(item => item.spotlightNews)).toEqual([true, undefined]);
    expect(deployedHero.resolveHomeHero({ mode: "category", source: "cms_posts", value: "Transit" }, catalog)).toEqual(automatic);
    const manual = resolveHomeHero({ mode: "manual", items: [{ itemId: "slide-1", title: "A selected headline", summary: "", href: post().path }] }, catalog);
    expect(manual[0].spotlightNews).toBe(true);
    expect(manual[0].title).toBe("A selected headline");
  });

  it.each([true, false, undefined])("keeps native metadata on a manual Post link with custom new-tab choice %s", newTab => {
    const native = { ...post(true), coverageLabelId: "nj-decides-2026",
      ...(newTab === undefined ? {} : { contentLinkMode: "custom" as const, contentLinkUrl: "https://example.test/report", contentLinkNewTab: newTab }) };
    const catalog = readHomeHeroCatalog(JSON.parse(JSON.stringify(homeHeroCatalog(undefined, [native]))));
    const config = { mode: "manual", items: [{ itemId: "manual-post", title: "Selected headline", summary: "Selected summary", href: native.path }] };
    for (const resolve of [resolveHomeHero, deployedHero.resolveHomeHero]) {
      const card = resolve(config, catalog)[0];
      expect(card).toMatchObject({ title: "Selected headline", summary: "Selected summary", displayDate: "2026-10-06",
        byline: "Test reporter", coverageLabelId: "nj-decides-2026", spotlightNews: true,
        href: newTab === undefined ? native.path : "https://example.test/report" });
      if (newTab !== undefined) expect(card.contentLinkNewTab).toBe(newTab);
    }
  });

  it("uses the destination Post flag after a manual slide changes its provider link", () => {
    const native = homeHeroCatalog(undefined, [post(false), { ...post(true), postId: "post-2", path: "/posts/branded/" }]);
    const providers = [
      { id: "rss-1", title: "External reporting", summary: "", href: "https://www.njspotlightnews.org/story/", source: "spotlight" as const, categories: [], tags: [], eyebrow: "NJ Spotlight News" },
      { id: "pbs-1", title: "A program", summary: "", href: "https://watch.njpbs.org/video/", source: "media_manager" as const, categories: [], tags: [], eyebrow: "PBS" },
    ];
    const config = { mode: "manual", items: [
      { itemId: "changed-rss", title: "Unbranded Post", summary: "", href: post().path, source: "spotlight", sourceId: "rss-1" },
      { itemId: "changed-pbs", title: "Branded Post", summary: "", href: "/posts/branded/", source: "media_manager", sourceId: "pbs-1" },
    ] };
    const catalog = [...native, ...providers];
    const slides = resolveHomeHero(config, catalog);
    expect(renderPostBranding(slides[0].spotlightNews)).toBe("");
    expect(slides[1].spotlightNews).toBe(true);
    expect(deployedHero.resolveHomeHero(config, catalog)).toEqual(slides);
  });

  it("preserves native opt-ins through validated public catalogs without trusting external source flags", () => {
    const native = homeHeroCatalog(undefined, [post(true)]);
    const external = { ...native[0], source: "spotlight" as const, id: "external", href: "https://www.njspotlightnews.org/story/" };
    for (const read of [readHomeHeroCatalog, deployedHero.readHomeHeroCatalog]) {
      const catalog = read([...native, external]);
      expect(catalog[0].spotlightNews).toBe(true);
      expect(catalog[1].spotlightNews).toBeUndefined();
    }
  });
});

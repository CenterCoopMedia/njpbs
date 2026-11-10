import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { freezeStoryCredits } from "../../packages/content-core/src/story-credits";
import { readHomeHeroCatalog, resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { homeHeroCatalog, homeSourcePreviewSnapshot, resolveHomeHeroItems } from "../src/lib/home-hero-items";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { parseSpotlightFeed } from "../scripts/sync-spotlight-news.mjs";
import { projectAuthorSnapshot } from "../src/lib/cms-authors-projection";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { publishedPageRead, retainedHomeSources, now } from "./fixtures/published-pages/fixtures";
const require = createRequire(import.meta.url);
const serverHero = require("../../functions/lib/home-hero.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPostPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const authorId = `au_${"1".repeat(32)}`;

it("uses a renamed public author on ordinary and compiled Home, preserving guest order and withdrawn names", async () => {
  const sha = "a".repeat(40);
  const read = publishedPageRead("home", sha);
  const native = read.posts[0];
  const frozen = structuredClone(native.document.published);
  const current = native.authors[0];
  current.displayName = "Ada Renamed";
  const ordinary = projectCmsPost(native.document, { now, assets: new Map() })!;
  const publicAuthors = native.authors.map(author => projectAuthorSnapshot(author.id, author)!);
  const sources = retainedHomeSources(sha);
  const compiled = await projectPublishedPageRead(read, "home", sha, now, sources);
  for (const [posts, authors] of [[[ordinary], publicAuthors], [compiled.posts, compiled.authors]] as const) {
    const config = { mode: "manual", items: [{ itemId: "native", source: "cms_posts", sourceId: ordinary.postId }] };
    expect(resolveHomeHeroItems(config, sources, posts, {}, authors)[0].byline).toBe("Ada Renamed and Guest writer");
    expect(homeSourcePreviewSnapshot(sources, posts, [ordinary.postId], authors).heroCatalog?.[0].byline)
      .toBe("Ada Renamed and Guest writer");
    expect(resolveHomeHeroItems(config, sources, posts, {}, [])[0].byline).toBe("Ada when published and Guest writer");
  }
  expect(native.document.published).toEqual(frozen);
});

it("carries frozen credited authors through publication, public projection and both hero readers", () => {
  const credits = freezeStoryCredits([{ kind: "registered", authorId }, { kind: "custom", name: "Fixture news service" }],
    () => ({ authorId, displayName: "Fixture reporter", active: true }));
  const doc = { id: "story", type: "post", title: "Fixture story", slug: "fixture-story", previousSlugs: [], locale: "en", tags: [], categories: ["News"],
    date: "2026-10-08", editorialDateSource: "editorial", excerpt: "Fixture summary", summary: "Fixture summary",
    version: 1, status: "published", publiclyVisible: true, publishAt: "2026-10-08T12:00:00Z", credits,
    blocks: [{ id: "body", type: "prose", order: 0, visible: true, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture story body." }] }] } } }] };
  const published = createPublishedSnapshot({ collection: "cmsPosts", document: doc, publishedAt: doc.publishAt, publishedBy: "fixture-editor" });
  expect(published.metadata.credits).toEqual(credits);
  const preview = createPostPreviewSnapshot(doc.id, doc, Date.parse(doc.publishAt));
  expect(preview.published.metadata.credits).toEqual(credits);
  const previewPost = projectCmsPost({ ...preview, status: "published", publishAt: doc.publishAt }, { now: new Date("2026-10-09T12:00:00Z"), assets: new Map() })!;
  expect(homeHeroCatalog(undefined, [previewPost])[0].byline).toBe("Fixture reporter and Fixture news service");
  const post = projectCmsPost({ ...doc, credits: [], published }, { now: new Date("2026-10-09T12:00:00Z"), assets: new Map() })!;
  expect(post.credits.map(credit => credit.name)).toEqual(["Fixture reporter", "Fixture news service"]);
  const sources = createHomeSourceSnapshot({ cards: [{ title: "Provider", description: "", href: "https://watch.njpbs.org/video/fixture/" }] }, {});
  const malformed = [
    { ...post, title: "x".repeat(301) },
    { ...post, summary: "x".repeat(10001) },
    { ...post, categories: [""] },
    { ...post, heroImage: { assetId: "fixture-image", url: "/image.jpg", mimeType: "image/jpeg" as const, width: 1200, height: 800 }, heroImageAlt: "x".repeat(1001) },
  ];
  const admitted = homeSourcePreviewSnapshot(sources, [...malformed, post]);
  expect(admitted.heroCatalog?.filter(card => card.source === "cms_posts")).toHaveLength(1);
  expect(readHomeHeroCatalog(admitted.heroCatalog)).toEqual(admitted.heroCatalog);
  for (const summary of ["Short", "漢".repeat(10000)]) {
    const manyPosts = Array.from({ length: 600 }, (_, index) => ({ ...post, postId: `story-${index}`, summary }));
    const bounded = homeSourcePreviewSnapshot(sources, manyPosts);
    expect(bounded.heroCatalog?.[0].source).toBe("media_manager");
    expect(bounded.heroCatalog?.length).toBeLessThanOrEqual(500);
    expect(bounded.heroCatalog?.some(card => card.source === "cms_posts")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThan(490000);
    expect(bounded.pbs).toEqual(sources.pbs);
    const selected = homeSourcePreviewSnapshot(sources, manyPosts, ["story-599"]);
    expect(selected.heroCatalog?.[0].id).toBe("story-599");
    expect(selected.heroCatalog?.[0].source).toBe("cms_posts");
    expect(new TextEncoder().encode(JSON.stringify(selected)).length).toBeLessThan(490000);
  }
  const catalog = homeHeroCatalog(undefined, [post]);
  for (const reader of [{ readHomeHeroCatalog, resolveHomeHero }, serverHero]) {
    const source = reader.readHomeHeroCatalog(JSON.parse(JSON.stringify(catalog)));
    for (const config of [
      { mode: "manual", items: [{ itemId: "one", title: "Chosen headline", summary: "", href: post.path }] },
      { mode: "category", source: "cms_posts", value: "News" },
    ]) {
      source[0].categories = ["News"];
      expect(reader.resolveHomeHero(config, source)[0].byline).toBe("Fixture reporter and Fixture news service");
    }
  }
});

describe("feed and missing bylines", () => {
  it("keeps the explicit RSS co-author byline and creates no Media Manager author", () => {
    const cards = parseSpotlightFeed(`<rss xmlns:njspotlight="https://www.njspotlightnews.org/ns/1.0/"><channel><item><title>Feed story</title><link>https://www.njspotlightnews.org/2026/10/fixture/</link><dc:creator>jmooney</dc:creator><njspotlight:byline><![CDATA[Feed reporter &amp; colleague]]></njspotlight:byline><category>Politics</category></item></channel></rss>`);
    expect(cards[0]!.byline).toBe("Feed reporter & colleague");
    const snapshot = createHomeSourceSnapshot({ cards: [{ title: "Video", description: "", href: "https://watch.njpbs.org/video/fixture/" }] }, { cards });
    const catalog = readHomeHeroCatalog(snapshot.heroCatalog);
    expect(catalog.find(card => card.href === cards[0]!.href)?.byline).toBe("Feed reporter & colleague");
    expect(catalog.find(card => card.source === "media_manager")?.byline).toBeUndefined();
    for (const reader of [{ readHomeHeroCatalog, resolveHomeHero }, serverHero]) {
      const provider = catalog.find(card => card.href === cards[0]!.href)!;
      const config = { mode: "manual", items: [{ itemId: "feed", source: "spotlight", sourceId: provider.id, href: provider.href, title: "Chosen feed story", summary: "" }] };
      expect(reader.resolveHomeHero(config, reader.readHomeHeroCatalog(catalog))[0].byline).toBe("Feed reporter & colleague");
      config.items[0].href = "";
      expect(reader.resolveHomeHero(config, catalog)[0].byline).toBe("Feed reporter & colleague");
      config.items[0].href = "/posts/different-story/";
      expect(reader.resolveHomeHero(config, catalog)[0]).not.toHaveProperty("byline");
      const destination = { id: "destination-post", source: "cms_posts" as const, title: "Different story", summary: "", href: config.items[0].href,
        byline: "Destination reporter", categories: [], tags: [] };
      expect(reader.resolveHomeHero(config, [...catalog, destination])[0].byline).toBe("Destination reporter");
      expect(reader.resolveHomeHero({ mode: "manual", items: [{ itemId: "native", source: "cms_posts", sourceId: destination.id,
        title: "Home headline", summary: "", href: provider.href }] }, [...catalog, destination])[0].byline).toBe("Destination reporter");
    }
    const noAuthor = parseSpotlightFeed(`<rss><channel><item><title>No author</title><link>https://www.njspotlightnews.org/2026/10/anonymous/</link></item></channel></rss>`);
    expect(noAuthor[0]).not.toHaveProperty("byline");
  });

  it("prints escaped attribution on lead, supporting and overflow stories, and omits absent attribution", () => {
    const items = Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: `Story ${index}`, summary: "", href: `/posts/${index}/`, ...(index < 3 ? { byline: `Reporter <${index}>` } : {}) }));
    const html = renderHomeEditorialHero(items, { supportingCount: 1 });
    for (const index of [0, 1, 2]) expect(html).toContain(`By Reporter &lt;${index}&gt;`);
    expect(html.match(/class="home-editorial__byline"/g)).toHaveLength(3);
  });
});

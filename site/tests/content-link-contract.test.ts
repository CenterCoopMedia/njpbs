import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { contentLink, contentLinkError, contentLinkMetadata, contentLinkRedirect, contentLinkReadFits, contentLinkDirectoryFits, CONTENT_LINK_DIRECTORY_MAX_BYTES } from "../../packages/content-core/src/content-link.ts";
import { htmlDeclaresNoindex } from "../src/lib/sitemap-noindex";
import { buildPublicReleasePairSitemaps } from "../scripts/public-release-pair-aggregate-outputs";
import { renderContentLinks, contentLinkFallbackHtml } from "../src/lib/content-link-render";
import { contentLinkSearchRecords, publishedContentLinkRecords } from "../src/lib/content-link-search";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { projectCmsPage } from "../src/lib/cms-page-projection";
import { adaptHomeStationPosts } from "../../packages/content-core/src/home-station-posts-source";
import { homeHeroCatalog } from "../src/lib/home-hero-items";
import { resolveHomeHero } from "../../packages/content-core/src/home-hero";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { createExternalContentManifest, renderExternalContentRss } from "../src/lib/external-content-feed";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/content-link.js");
const { validateKnownMetadata } = require("../../functions/lib/content-metadata.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const now = new Date("2026-11-02T20:00:00.000Z");
const target = "https://example.test/report?edition=nj&year=2026#results";
const settings = { contentLinkMode: "custom" as const, contentLinkUrl: target, contentLinkNewTab: true };
const metadata = { type: "post", title: "Election reporting", slug: "election-reporting", previousSlugs: [], locale: "en", tags: [], date: "2026-11-01", ...settings };
const snapshot = { metadata, blocks: [], publishedAt: "2026-11-01T12:00:00.000Z", sourceVersion: 4 };
const postDoc = { id: "story", type: "post", status: "published", publiclyVisible: true, publishAt: snapshot.publishedAt, published: snapshot };

// #4645's URL policy is the oracle for both deployment boundaries.
describe("content link contract", () => {
  it.each(["http://example.test/", "javascript:alert(1)", "//example.test/", "https://user:password@example.test/", "https://example.test/\n", "https://example.test/ bad", "https://example.test/\u00a0", "\u3000https://example.test/", "https://example.test/\u2028", "https://example.test/\ufeff", "https://example.test/\\bad", "https://example.test/" + "a".repeat(2048), "https://example.test/" + "é".repeat(500), ""])("rejects %j in the model and Functions", url => {
    const value = { ...settings, contentLinkUrl: url };
    expect(contentLinkError(value)).toBeTruthy();
    expect(server.contentLinkError(value)).toBe(contentLinkError(value));
    expect(validateKnownMetadata({ type: "post", ...value })).toBeTruthy();
    expect(() => contentLinkMetadata(value)).toThrow();
  });
  it.each([[], {}, 1, null, false, "other"])("rejects malformed mode %j", mode => {
    const value = { ...settings, contentLinkMode: mode };
    expect(contentLinkError(value)).toBeTruthy(); expect(server.contentLinkError(value)).toBe(contentLinkError(value));
  });
  it("defaults to the ordinary address, with new tabs on only for custom URLs", () => {
    expect(contentLink({}, "/posts/election-reporting/")).toEqual({ href: "/posts/election-reporting/", external: false, newTab: false });
    expect(contentLink({ ...settings, contentLinkNewTab: undefined }, "/posts/election-reporting/")).toMatchObject({ href: target, target: "_blank", rel: "noopener noreferrer" });
    expect(contentLink({ ...settings, contentLinkNewTab: false }, "/posts/election-reporting/")).toEqual({ href: target, external: true, newTab: false });
    expect(server.contentLinkError(settings)).toBeNull();
  });
  it.each(["cmsPosts", "cmsPages"])("freezes the setting with the retained body in %s", collection => {
    const body = [{ id: "body", type: "prose", visible: true, order: 0, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this reporting when the destination changes." }] }] } } }];
    const document = { id: collection === "cmsPages" ? "contact" : "story", ...metadata, version: 4, blocks: body };
    const published = createPublishedSnapshot({ collection, document, publishedAt: snapshot.publishedAt, publishedBy: "editor", allowIncompletePresentation: true });
    expect(published.metadata).toMatchObject(settings);
    expect(published.blocks).toEqual(body);
    const disabled = createPublishedSnapshot({ collection, document: { ...document, contentLinkMode: "normal" }, publishedAt: snapshot.publishedAt, publishedBy: "editor", allowIncompletePresentation: true });
    expect(disabled.blocks).toEqual(published.blocks);
    expect(contentLink(disabled.metadata, "/contact/").href).toBe("/contact/");
  });
  it("uses only published settings in the public Post and Page projections", () => {
    const post = projectCmsPost({ ...postDoc, contentLinkMode: "normal" }, { now })!;
    const page = projectCmsPage({ ...postDoc, id: "contact", template: "genericPage", contentLinkMode: "normal", published: { ...snapshot, metadata: { title: "Contact", ...settings } } }, { mode: "published", now })!;
    expect(contentLink(post, post.path).href).toBe(target);
    expect(contentLink(page, page.path).href).toBe(target);
    expect(post.path).toBe("/posts/election-reporting/"); expect(page.path).toBe("/contact/");
  });
  it("returns an uncached 302 to the exact target, and restores normal serving when off", () => {
    const response = contentLinkRedirect(settings, { "x-njpbs-source-version": "4" })!;
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe(target);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow"); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-njpbs-source-version")).toBe("4"); expect(response.body).toBeNull();
    expect(contentLinkRedirect({ ...settings, contentLinkMode: "normal" })).toBeNull();
  });
  it("keeps home source hrefs, bound manual hero selections and RSS on the same target", () => {
    const post = projectCmsPost(postDoc, { now })!;
    const cards = adaptHomeStationPosts({ status: "ready", checkedAt: now.toISOString(), posts: [post] }, { cutoffAt: now.toISOString() }).cards;
    expect(cards[0].href).toBe(target);
    const hero = resolveHomeHero({ mode: "manual", items: [{ itemId: "hero", source: "cms_posts", sourceId: "story", title: "", summary: "", href: "/posts/election-reporting/" }] }, homeHeroCatalog(undefined, [post]));
    expect(hero[0].href).toBe(target);
    const html = renderHomeEditorialHero(hero);
    expect(html).toContain('href="https://example.test/report?edition=nj&amp;year=2026#results"');
    expect(html).toContain('rel="noopener noreferrer" target="_blank"');
    const manifest = createExternalContentManifest({ site: "https://njpbs.org", posts: [post], programs: [], authors: [], recordCards: [] });
    expect(renderExternalContentRss(manifest)).toContain("https://example.test/report?edition=nj&amp;year=2026#results");
  });
  it("searches listing metadata and target domain without indexing the retained body", () => {
    const records = contentLinkSearchRecords(new Map([["cmsPosts/story", postDoc]]), now);
    expect(records).toEqual([{ path: "/posts/election-reporting/", title: "Election reporting", text: "Election reporting", ...settings }]);
    expect(contentLinkSearchRecords(new Map([["cmsPosts/story", { ...postDoc, publiclyVisible: false }]]), now)).toEqual([]);
  });
});

// Explicit source census from git grep of path helpers and link emitters. Every
// HTML emitter is inside Astro's universal middleware; RSS/search call the same
// helper at serialization. This protects newly added routes from bypassing it.
const HTML_RENDERERS = [
  "site/src/components/CinematicHomePage.astro", "site/src/components/HomeHero.astro", "packages/content-core/src/home-editorial-render.ts",
  "packages/content-core/src/home-section-render.ts",
  "packages/content-core/src/home-curated-render.ts", "packages/content-core/src/home-rail-render.ts",
  "packages/content-core/src/shelf-full-text.ts", "site/src/components/PostIndex.astro",
  "site/src/components/AuthorPage.astro", "site/src/layouts/PublicSiteLayout.astro",
  "site/src/pages/404.astro", "site/src/lib/not-found-content.ts",
  "site/src/components/PostPage.astro", "site/src/components/PostBlockList.astro", "site/src/components/CmsBlocks.astro",
  "site/src/components/PostLiveBlog.astro", "packages/content-core/src/content-render.ts", "packages/content-core/src/content-model.ts",
  "packages/content-core/src/live-blog-render.ts", "packages/content-core/src/live-blog-follow-ups-render.ts",
  "packages/content-core/src/data-hub-reporting.ts", "site/src/pages/data-hub/[...hub].astro",
];
describe("every Post and Page link surface", () => {
  it("keeps every enumerated HTML renderer inside Astro's shared middleware boundary", () => {
    const reached = new Set<string>();
    const visit = (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(?)['"]([^'"]+)['"]/g)) {
        if (!specifier.startsWith(".")) continue;
        const path = resolve(dirname(file), specifier);
        const dependency = [path, ...[".ts", ".astro", ".js", ".tsx", "/index.ts"].map(extension => path + extension)]
          .find(candidate => /\.(?:astro|[cm]?[jt]sx?)$/.test(candidate) && existsSync(candidate));
        if (dependency) visit(dependency);
      }
    };
    for (const file of readdirSync(resolve("src/pages"), { recursive: true })) {
      if (String(file).endsWith(".astro")) visit(resolve("src/pages", String(file)));
    }
    for (const file of HTML_RENDERERS) expect(reached.has(resolve("..", file)), `${file} bypasses the Astro HTML boundary`).toBe(true);
  });
  it("applies the shared destination and new-tab contract to Post and Page anchors at that boundary", () => {
    const html = renderContentLinks(`<a class="listing" href="/posts/election-reporting/">Story</a><a href="https://njpbs.org/contact/">Page</a>`, [{ path: "/posts/election-reporting/", ...settings }, { path: "/contact/", ...settings }]);
    expect((html.match(/target="_blank"/g) ?? [])).toHaveLength(2);
    expect((html.match(/rel="noopener noreferrer"/g) ?? [])).toHaveLength(2);
    expect((html.match(/opens in new tab/g) ?? [])).toHaveLength(2);
    expect(html).not.toContain('href="/posts/');
  });
  it("covers the Astro request boundary, static builds, compiled replay and dynamic renderers", () => {
    const middleware = readFileSync(resolve("src/middleware.ts"), "utf8");
    expect(middleware).toMatch(/export const onRequest = defineMiddleware/);
    expect(middleware).toMatch(/await next\(\)/);
    expect(middleware).toMatch(/renderContentLinks\(await response\.text\(\), entries/);
    expect(middleware).toContain("new Response(html,");
    expect(readFileSync(resolve("src/compiled-renderer/middleware.ts"), "utf8")).toBe('export { onRequest } from "../middleware";\n');
    for (const file of ["src/lib/site-search.ts", "src/lib/external-content-feed.ts"]) {
      expect(readFileSync(resolve(file), "utf8"), `${file} bypasses the shared destination helper`).toMatch(/(?:contentLink|renderContentLinks)\(/);
    }
    for (const file of ["compiled-post-shadow-entry.ts", "compiled-public-page-entry.ts", "compiled-public-release-pair-entry.ts", "compiled-public-release-pair-author-entry.ts"]) expect(readFileSync(resolve("scripts", file), "utf8")).toContain("app.render(");
  });
  it("handles escaped attributes and retired paths, preserves surrounding bytes, and leaves scripts alone", () => {
    const html = '<script>const example = \'<a href="/posts/old/">\';</script><a href="/posts/old/?x=1&amp;y=2" target="_self" class="card">A &amp; B</a><a href="/untouched/">Keep</a>';
    const output = renderContentLinks(html, [{ path: "/posts/election-reporting/", previousSlugs: ["old"], ...settings, contentLinkNewTab: false }]);
    expect(output).toContain('<script>const example = \'<a href="/posts/old/">\';</script>');
    expect(output).toContain('<a class="card" href="https://example.test/report?edition=nj&amp;year=2026#results">A &amp; B</a>');
    expect(output).toContain('<a href="/untouched/">Keep</a>');
    expect(output).not.toContain('target="_self"'); expect(output).not.toContain('target="_blank"');
  });
});

it("keeps fragment controls local and resolves relative, no-slash and index.html content links", () => {
  const output = renderContentLinks('<a href="#main">Skip</a><a href="../election-reporting">Story</a><a href="/posts/election-reporting/index.html">Story</a>', [{ path: "/posts/election-reporting/", ...settings }], "https://njpbs.org/posts/other/");
  expect(output).toContain('<a href="#main">Skip</a>');
  expect((output.match(/target="_blank"/g) ?? [])).toHaveLength(2);
});
it("removes a pre-existing new-tab notice and label when staff turn new tabs off", () => {
  const output = renderContentLinks('<a href="/contact/" aria-label="Contact (opens in new tab)" target="_blank">Contact<span class="sr-only"> (opens in new tab)</span></a>', [{ path: "/contact/", ...settings, contentLinkNewTab: false }]);
  expect(output).toContain('aria-label="Contact"'); expect(output).not.toContain("opens in new tab"); expect(output).not.toContain("_blank");
});

it("keeps redirect fallback HTML noindex and excludes its NJ PBS address from the real sitemap serializer", async () => {
  const html = contentLinkFallbackHtml(settings);
  expect(htmlDeclaresNoindex(html)).toBe(true);
  async function* pages() {
    yield { path: "/", bytes: new TextEncoder().encode('<!doctype html><html><head><title>Home</title></head><body>Home</body></html>') };
    yield { path: "/posts/election-reporting/", bytes: new TextEncoder().encode(html) };
  }
  const files = await buildPublicReleasePairSitemaps(pages(), ["/sitemap-index.xml", "/sitemap-0.xml"], "https://njpbs.org");
  const xml = new TextDecoder().decode(files.find(file => file.path === "/sitemap-0.xml")!.bytes);
  expect(xml).toContain("https://njpbs.org/"); expect(xml).not.toContain("election-reporting"); expect(xml).not.toContain("example.test");
});
it("keeps RSS body links on NJ PBS while sending the item's main link to its custom target", () => {
  const doc = structuredClone(postDoc);
  doc.published.blocks = [{ id: "body", type: "prose", visible: true, order: 0, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Contact NJ PBS", marks: [{ type: "link", attrs: { href: "/contact/" } }] }] }] } } }] as never;
  const post = projectCmsPost(doc, { now })!;
  const manifest = createExternalContentManifest({ site: "https://njpbs.org", posts: [post], programs: [], authors: [], recordCards: [] });
  expect(manifest.items[0].url).toBe(target);
  expect(manifest.items[0].contentHtml).toContain('href="https://njpbs.org/contact/"');
  const linked = createExternalContentManifest({ site: "https://njpbs.org", posts: [post], programs: [], authors: [], contentLinks: [{ path: "/contact/", ...settings }] });
  expect(linked.items[0].contentHtml).toContain('href="https://example.test/report?edition=nj&amp;year=2026#results"');
  expect(linked.items[0].contentHtml).toContain('target="_blank" rel="noopener noreferrer"');
});

it.each(["https://example.test/日本", "https://例え.test/café", "https://example.test/café?name=é#résultats"])("emits URL-standard ASCII hrefs and Location headers for %s", url => {
  const value = { ...settings, contentLinkUrl: url };
  const expected = new URL(url).href;
  expect(contentLinkError(value)).toBeNull(); expect(server.contentLinkError(value)).toBeNull();
  expect(contentLink(value, "/posts/story/").href).toBe(expected);
  expect(contentLinkRedirect(value)!.headers.get("location")).toBe(expected);
  expect(server.contentLinkRedirect(value).headers.get("location")).toBe(expected);
});

it("keeps noindex destinations out of search while still resolving their links from RSS and content API bodies", () => {
  const documents = new Map([["cmsPages/contact", { status: "published", publiclyVisible: true, publishAt: snapshot.publishedAt,
    published: { ...snapshot, metadata: { title: "Contact", slug: "contact", seo: { noindex: true }, ...settings } } }]]);
  expect(contentLinkSearchRecords(documents, now)).toEqual([]);
  const links = publishedContentLinkRecords(documents, now);
  expect(renderContentLinks('<a href="/contact/">Contact</a>', links)).toContain('href="https://example.test/report?edition=nj&amp;year=2026#results"');
});

it("keeps directory bytes separate from the unchanged content budget at both model and Functions boundaries", () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({ path: `/posts/story-${index}/`, ...settings, previousSlugs: Array.from({ length: 10 }, (_, alias) => `old-${index}-${alias}`) }));
  const value = { body: "x".repeat(2 * 1024 * 1024 - 100), contentLinks: entries };
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(2 * 1024 * 1024);
  expect(contentLinkReadFits(value, 2 * 1024 * 1024)).toBe(true);
  expect(server.contentLinkReadFits(value, 2 * 1024 * 1024)).toBe(true);
  for (const key of ["published", "renderContext"] as const) {
    const envelope = { kind: "content", [key]: value };
    expect(contentLinkReadFits(envelope, 2 * 1024 * 1024, key)).toBe(true);
    expect(server.contentLinkReadFits(envelope, 2 * 1024 * 1024, key)).toBe(true);
    expect(contentLinkReadFits({ ...envelope, other: "x".repeat(200) }, 2 * 1024 * 1024, key)).toBe(false);
  }
  expect(contentLinkReadFits({ ...value, body: value.body + "x".repeat(101) }, 2 * 1024 * 1024)).toBe(false);
  const oversized = [{ ...settings, path: "/posts/story/", previousSlugs: ["x".repeat(CONTENT_LINK_DIRECTORY_MAX_BYTES)] }];
  expect(contentLinkDirectoryFits(oversized)).toBe(false);
  expect(server.contentLinkDirectoryFits(oversized)).toBe(false);
  expect(contentLinkReadFits({ body: "Small", contentLinks: oversized }, 2 * 1024 * 1024)).toBe(false);
});
it("keeps a custom-link draft's retained body in private preview and redirects only the public own-route document", () => {
  const html = '<!doctype html><html><head><title>Draft</title></head><body><h1>Retained reporting body</h1></body></html>';
  const entries = [{ path: "/posts/election-reporting/", ...settings }];
  expect(renderContentLinks(html, entries, "https://njpbs.org/posts/election-reporting/", undefined)).toBe(html);
  const publicHtml = renderContentLinks(html, entries, "https://njpbs.org/posts/election-reporting/", "/posts/election-reporting/");
  expect(publicHtml).not.toContain("Retained reporting body");
  expect(readFileSync(resolve("src/pages/posts/[...slug].astro"), "utf8")).toContain('post && renderContext?.content.kind !== "private-preview" ? contentLink(post, canonicalPath)');
  expect(publicHtml).toContain('http-equiv="refresh"');
  expect(publicHtml).toContain('name="robots" content="noindex, nofollow"');
  expect(readFileSync(resolve("src/middleware.ts"), "utf8")).toContain('content?.kind === "private-preview" ? undefined : context.url.pathname');
});

it.each([true, false])("cues static continuation links exactly when new tabs are on (%s)", newTab => {
  const html = contentLinkFallbackHtml({ ...settings, contentLinkNewTab: newTab });
  const anchor = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)![0];
  expect(anchor.includes('target="_blank"')).toBe(newTab);
  expect(anchor.includes("(opens in new tab)")).toBe(newTab);
});
it("keeps direct Post image and continuation anchors inside the new-tab notice contract", () => {
  const index = readFileSync(resolve("src/components/PostIndex.astro"), "utf8");
  const media = index.slice(index.indexOf('"post-index-card__media"'), index.indexOf("</a>", index.indexOf('"post-index-card__media"')));
  expect(media).toMatch(/aria-label=\{\s*contentLink\(post, post.path\).newTab\s*\? `\$\{post.title\} \(opens in new tab\)`/);
  const detail = readFileSync(resolve("src/pages/posts/[...slug].astro"), "utf8");
  const continuation = detail.match(/<a href=\{outbound.href\}[\s\S]*?<\/a>/)![0];
  expect(continuation).toContain("outbound.newTab && <Fragment set:html={homeExternalLinkNotice}");
});

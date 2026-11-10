// Local fixture proof for the compiled Page reader. No provider or CMS requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shelfLayoutFixture, heroActionFixture, type ShelfLayoutState } from "../../packages/content-core/fixtures/home-shelf-layouts";
import { publishedPageRead, now as publicNow } from "../tests/fixtures/published-pages/fixtures";
import { prose } from "../tests/fixtures/shadow-posts/fixtures";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { homeCatalogJson } from "../../packages/content-core/src/home-source-catalog";
import { CONTENT_SHELF_PRESENTATIONS } from "../../packages/content-core/src/content-model";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { input, fixture as previewFixture, now } from "../tests/fixtures/cms-preview-content";

const site = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(site, ".compiled-renderer");
const renderer = await import(pathToFileURL(path.join(directory, "server/entry.mjs")).href);
const publicRenderer = await import(pathToFileURL(path.join(site, ".public-page-renderer/server/entry.mjs")).href);
assert.equal(publicRenderer.rendererSha, renderer.rendererSha);
const require = createRequire(import.meta.url);
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const output = process.argv[2];
assert.ok(output, "Supply a local output directory for the HTML evidence");
await mkdir(output, { recursive: true });
await cp(path.join(directory, "client"), output, { recursive: true });
await cp(path.join(site, ".public-page-renderer/client"), output, { recursive: true });
const publicAssets = path.join(output, "posts/_no-build-assets");
await mkdir(publicAssets, { recursive: true });
await cp(path.join(site, ".public-page-renderer/client"), publicAssets, { recursive: true });
await cp(path.join(site, "public/brand"), path.join(output, "brand"), { recursive: true });

async function publicHtml(value: ReturnType<typeof shelfLayoutFixture>, homeHero: ReturnType<typeof heroActionFixture>) {
  const sources = structuredClone(value.sources);
  sources.publication!.commitSha = renderer.rendererSha;
  sources.editorial!.receipt = { ...sources.publication!, digest: createHash("sha256").update(homeCatalogJson(sources.editorial!.catalog)).digest("hex") };
  const published = createPublishedSnapshot({ collection: "cmsPages", document: { ...value.home, homeHero },
    publishedAt: "2026-10-12T10:00:00.000Z", publishedBy: "fixture-editor" });
  const projection = projectPublicPageDocument({ pageId: "home", document: { ...value.home, published, publiclyVisible: true }, now: publicNow, assets: new Map() });
  const read = publishedPageRead("home", renderer.rendererSha);
  read.page = projection.page;
  const pool = sources.editorial!.catalog.sources["home-posts"];
  read.posts = (pool.status === "ready" ? pool.cards : []).map(card => {
    const post = structuredClone(prose);
    Object.assign(post.document, { id: card.id, publishAt: card.publishedAt ?? "2026-10-11T12:00:00.000Z" });
    Object.assign(post.document.published, { sourceVersion: card.sourceVersion ?? 1,
      publishedAt: card.publishedAt ?? "2026-10-11T12:00:00.000Z" });
    Object.assign(post.document.published.metadata, { title: card.title, slug: card.href.split("/")[2],
      summary: card.summary ?? "", date: card.displayDate, credits: [{ kind: "custom", name: card.byline ?? "NJ PBS" }] });
    return post;
  }) as typeof read.posts;
  const content = await projectPublishedPageRead(read, "home", renderer.rendererSha, publicNow, sources);
  return publicRenderer.renderPublishedPage(content);
}

for (const layout of ["two_features", "list"] as const) {
  for (const state of (layout === "list" ? ["filled", "one", "empty", "withdrawn", "many"] : ["filled", "one", "empty", "withdrawn"]) as ShelfLayoutState[]) {
    const value = shelfLayoutFixture(layout, state);
    const request = input("cmsPages", "Home layout fixture");
    request.pageId = "home";
    Object.assign(request.snapshot, value.home, { homeHero: heroActionFixture(false) });
    request.rendererSha = renderer.rendererSha;
    request.expiresAtMs = Date.now() + 60_000;
    const prepared = previewFixture(request);
    prepared.request.rendererSha = renderer.rendererSha;
    const content = projectCmsPreviewContent(prepared.bytes, prepared.request, now);
    const html = await renderer.render({ content, homeSources: value.sources });
    const selected = value.block.data.selectedIds!;
    const expected = state === "withdrawn" ? selected.slice(1) : selected;
    const section = value.block.section!;
    const markup = html.match(new RegExp(`<section[^>]*data-home-section="${section}"[\\s\\S]*?<\\/section>`))?.[0] ?? "";
    assert.deepEqual([...markup.matchAll(/data-home-card-id="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&")), expected);
    if (expected.length && (CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes(layout)) {
      assert.ok(markup.includes(`home-curated__${layout}`));
      assert.ok(!markup.includes("rail__arrow"));
      if (layout === "list") assert.ok(!markup.includes("<img"));
    }
    const publicMarkup = await publicHtml(value, heroActionFixture(false));
    if ((CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes(layout)) {
      const publicSection = publicMarkup.match(new RegExp(`<section[^>]*data-home-section="${section}"[\\s\\S]*?<\\/section>`))?.[0] ?? "";
      assert.equal(publicSection, markup, "Compiled Page and fresh public Home shelf markup must match");
    }
    await writeFile(path.join(output, `${layout}-${state}.html`), publicMarkup);
  }
}
for (const override of [false, true]) {
  const value = shelfLayoutFixture("two_features", "filled");
  const request = input("cmsPages", "Home hero action fixture");
  request.pageId = "home";
  Object.assign(request.snapshot, value.home, { homeHero: heroActionFixture(override && (CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes("two_features")) });
  request.rendererSha = renderer.rendererSha;
  request.expiresAtMs = Date.now() + 60_000;
  const prepared = previewFixture(request);
  prepared.request.rendererSha = renderer.rendererSha;
  const html = await renderer.render({ content: projectCmsPreviewContent(prepared.bytes, prepared.request, now), homeSources: value.sources });
  if ((CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes("two_features")) {
    assert.ok(html.includes("Read the story"));
    assert.ok(html.includes("Watch the report"));
    if (override) assert.ok(html.includes("Read the full update"));
  }
  const publicMarkup = await publicHtml(value, heroActionFixture(override && (CONTENT_SHELF_PRESENTATIONS as readonly string[]).includes("two_features")));
  const opening = (markup: string) => markup.match(/<section[^>]*data-home-hero-presentation="editorial"[\s\S]*?<\/section>/)?.[0];
  assert.equal(opening(publicMarkup), opening(html), "Compiled Page and public hero markup must match");
  await writeFile(path.join(output, `hero-${override ? "override" : "defaults"}.html`), publicMarkup);
}
console.log(JSON.stringify({ event: "home-shelf-layouts-verified", rendererSha: renderer.rendererSha, pages: 11, output }));

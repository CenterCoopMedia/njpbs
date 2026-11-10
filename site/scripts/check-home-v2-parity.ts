import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { HOME_COMPOSITION_REGIONS, HOME_OPTIONAL_REGIONS, homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { homeCompositionGroups, isHomeLockedAuthoringSection } from "../../packages/content-core/src/home-composition";
import { parseBlocks, CONTENT_SHELF_PRESENTATIONS, type PageBlock } from "../../packages/content-core/src/content-model";
import { homeCatalogJson } from "../../packages/content-core/src/home-source-catalog";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { createHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { fixture, input, reservation } from "../tests/fixtures/cms-preview-content";
import { createPublicArtifactInventoryReceipt, type PublicArtifactSettingsInput } from "../src/lib/public-artifact-inventory";
import { publishedPageRead, retainedHomeSources, now } from "../tests/fixtures/published-pages/fixtures";
import { registeredAuthor } from "../tests/fixtures/shadow-posts/fixtures";
import currentCatalog from "../tests/fixtures/home-v2-current-catalog.json";
import newsletterCopy from "../tests/fixtures/home-sources/newsletter-public-copy.json";
import newscastFixture from "../tests/fixtures/home-sources/newscast-documented-schema.json";

const require = createRequire(import.meta.url);
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const home = JSON.parse(await readFile(option("--fixture", fileURLToPath(new URL("../tests/fixtures/home-v2-parity.json", import.meta.url))), "utf8"));
const output = new URL("../../scratch/home-v2-parity/", import.meta.url);
const mediaAssets = args.includes("--assets") ? JSON.parse(await readFile(option("--assets", ""), "utf8")) : [];
const availableAssets = new Map(mediaAssets.map((asset: { id: string }) => [asset.id, asset]));
const registered = [...HOME_COMPOSITION_REGIONS, ...HOME_OPTIONAL_REGIONS];
const parsed = parseBlocks(home.blocks);
assert.ok(parsed.ok, parsed.ok ? undefined : parsed.error);
const blocks = parsed.blocks;
assert.equal(homeCompositionError("home", 2, blocks), null);
for (const [section, type] of registered) {
  assert.equal(blocks.filter(block => block.section === section && block.type === type).length, 1,
    `Fixture must cover registered section ${section}; extend the saved snapshot when the contract grows`);
}
assert.deepEqual(blocks.map(block => block.order), blocks.map((_, index) => index));
const visibleGroups = homeCompositionGroups(blocks).filter(group => !isHomeLockedAuthoringSection(group.blocks[0].section));

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const elements = (node: Node): Element[] => [
  ...("tagName" in node ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
];
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value ?? "";
const text = (node: Node): string => "tagName" in node && ["script", "style", "svg"].includes(node.tagName) ? ""
  : "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
function signature(node: Node) {
  const nodes = elements(node);
  return {
    presentation: "tagName" in node ? attr(node, "class") : "",
    text: normalize(text(node)),
    headings: nodes.filter(node => /^h[1-6]$/.test(node.tagName)).map(node => [node.tagName, normalize(text(node))]),
    links: nodes.filter(node => node.tagName === "a").map(node => [attr(node, "href"), normalize(text(node))]),
    media: nodes.filter(node => ["img", "iframe", "video"].includes(node.tagName)).map(node => [node.tagName, attr(node, "src"), attr(node, "alt"), attr(node, "poster")]),
    cards: nodes.filter(node => attr(node, "data-home-card-id")).map(node => attr(node, "data-home-card-id")),
  };
}
function sectionNode(html: string, block: PageBlock, nodes = elements(parse(html))) {
  const named = nodes.find(node => attr(node, "data-home-section") === block.section);
  if (named) return named;
  // Passport's shared markup predates data-home-section. Its saved h2 is the
  // accessible section identity, including both copy and its adjacent action.
  if (block.type === "prose") {
    const heading = block.data.content.content[0]?.content?.map(node => node.text ?? "").join("");
    return nodes.find(node => node.tagName === "section" && elements(node).some(child => child.tagName === "h2" && normalize(text(child)) === heading));
  }
  return undefined;
}
function sections(html: string) {
  const nodes = elements(parse(html));
  return visibleGroups.flatMap(group => {
    const block = group.blocks[0];
    const node = sectionNode(html, block, nodes);
    return node ? [{ section: block.section, position: nodes.indexOf(node), value: signature(node) }] : [];
  });
}
function verifyOutput(html: string, label: string, sources: HomeSourceSnapshot, savedBlocks = blocks, fullRails = false) {
  assert.ok(sources.editorial);
  const catalog = sources.editorial.catalog;
  const nodes = elements(parse(html));
  const rendered = sections(html);
  assert.equal(rendered.length, visibleGroups.length, `${label}: every eligible saved section renders`);
  assert.deepEqual([...rendered].sort((a, b) => a.position - b.position).map(item => item.section), visibleGroups.map(group => group.blocks[0].section), `${label}: block array is the only order`);
  const hero = nodes.find(node => attr(node, "data-home-hero-presentation"));
  const footer = nodes.find(node => node.tagName === "footer");
  assert.ok(hero && footer && nodes.indexOf(hero) < rendered[0].position && nodes.indexOf(footer) > rendered.at(-1)!.position, `${label}: hero and footer stay pinned`);
  for (const group of visibleGroups) {
    const section = group.blocks[0].section;
    assert.ok(nodes.filter(node => attr(node, "data-home-section") === section).length <= 1, `${label}: ${section} renders once`);
  }
  for (const block of savedBlocks) {
    if (block.type !== "content_shelf") continue;
    const source = catalog.sources[block.section as keyof typeof catalog.sources];
    assert.ok(source.status === "ready", `${block.section}: fixture has a captured ready source`);
    const pool = source.cards;
    const available = new Set(pool.map((card: { id: string }) => card.id));
    const expectedIds = (block.data.selectedIds ?? pool.map((card: { id: string }) => card.id)).filter((id: string) => available.has(id)).slice(0, block.data.itemLimit);
    const actual = rendered.find(item => item.section === block.section)!;
    assert.deepEqual(actual.value.cards, expectedIds, `${label}: ${block.section} selected order and missing/withdrawn gaps`);
    for (const id of expectedIds) {
      const card = pool.find(card => card.id === id)!;
      const node = elements(sectionNode(html, block, nodes)!).find(node => attr(node, "data-home-card-id") === id)!;
      assert.ok(normalize(text(node)).includes(normalize(card.title)), `${label}: ${id} uses current source copy`);
      assert.ok(elements(node).some(node => node.tagName === "a" && attr(node, "href") === card.href), `${label}: ${id} keeps its source link`);
    }
    if (!fullRails) assert.ok((block.data.selectedIds ?? []).some(id => !available.has(id)), `${block.section} must exercise a missing or withdrawn selection`);
  }
  return rendered.map(({ section, value }) => ({ section, value }));
}

if (!args.includes("--browser-only")) {
  await mkdir(output, { recursive: true });
  const preview = await import(new URL("../.compiled-renderer/server/entry.mjs", import.meta.url).href);
  const publicRenderer = await import(new URL("../.public-page-renderer/server/entry.mjs", import.meta.url).href);
  assert.equal(preview.rendererSha, publicRenderer.rendererSha, "Both renderers must use the same exact source");
  const sha = preview.rendererSha;
  const published = createPublishedSnapshot({ collection: "cmsPages", document: home, publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "fixture" });
  const projected = projectPublicPageDocument({ pageId: "home", document: { ...home, status: "published", publiclyVisible: true, publishAt: published.publishedAt, published }, now, assets: availableAssets });
  const publicRead = publishedPageRead("home", sha);
  publicRead.page = projected.page;
  publicRead.posts = currentCatalog.catalog.sources["home-posts"].cards.map(card => {
    const post = structuredClone(registeredAuthor);
    post.document.id = card.id;
    Object.assign(post.document.published, { sourceVersion: card.sourceVersion, publishedAt: card.publishedAt });
    Object.assign(post.document.published.metadata, { title: card.title, summary: card.summary, slug: card.href.slice(7, -1), date: card.displayDate });
    post.authors = [];
    post.document.published.metadata.credits = [];
    return post;
  });
  const sources = retainedHomeSources(sha);
  const newscast = adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
    checkedAt: currentCatalog.catalog.cutoffAt, complete: true, response: newscastFixture }, currentCatalog.catalog.cutoffAt);
  sources.pbs.newscast = createHomeNewscastPacket(newscast);
  const catalog = { ...structuredClone(currentCatalog.catalog), services: { newscast, newsletters: { status: "ready", checkedAt: currentCatalog.catalog.cutoffAt, records: [{
    id: "parity-newsletter", kind: "newsletter", href: null, sourceVersion: 1,
    newsletter: { card: { title: newsletterCopy.title, summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl, imageAlt: "" }, image: { url: newsletterCopy.image.url } },
  }] } } };
  sources.editorial = { catalog, receipt: { ...sources.publication!, digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } } as typeof sources.editorial;
  // The public read refreshes native Post/Newsletter dependencies. Freeze this
  // very same captured context for exact saved preview and Boardwalk phone.
  Object.assign(publicRead, { homeNewsletters: { assets: [], joinedRecords: [{ id: "parity-newsletter", type: "newsletter", status: "draft", version: 2,
    title: "PRIVATE later Newsletter", approvedLibraryVersion: { type: "newsletter", status: "approved", version: 1,
      title: newsletterCopy.title, summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl, body: { type: "doc", content: [] } } }] } });
  const publicContent = await projectPublishedPageRead(publicRead, "home", sha, now, sources);
  const saved = createPreviewSnapshot("home", home);
  assert.deepEqual(saved.blocks, home.blocks, "Save/reopen retains IDs, source receipts, selections and order");
  const value = input("cmsPages", home.title);
  Object.assign(value, { pageId: "home", rendererSha: sha, snapshot: saved, assets: mediaAssets, expiresAtMs: Date.now() + 60_000 });
  Object.assign(value.publicContext, { homeSources: publicContent.homeSources, posts: publicContent.posts, recordCards: publicContent.recordCards, settings: publicContent.settings,
    receipt: createPublicArtifactInventoryReceipt({ reservation: { ...reservation, ...sources.publication }, pages: [], programs: [], authors: [],
      posts: publicRead.posts.map(post => ({ kind: "post", documentId: post.document.id, sourceVersion: post.document.published.sourceVersion,
        canonicalPath: `/posts/${post.document.published.metadata.slug}/`, aliases: [], publishedSnapshot: post.document.published })),
      settings: publicRead.settings.map(setting => ({ documentId: setting.id as PublicArtifactSettingsInput["documentId"], sourceVersion: setting.published.sourceVersion, publishedSnapshot: setting.published })),
    }) });
  const f = fixture(value);
  f.request.rendererSha = sha;
  const previewContent = projectCmsPreviewContent(f.bytes, f.request, now);
  for (const content of [previewContent, publicContent]) {
    assert.deepEqual(content.pages[0].blocks, home.blocks, "Both admitted projections preserve the entire saved array");
  }
  assert.deepEqual(previewContent.settings, publicContent.settings, "Shared chrome inputs stay fixed");
  for (const group of visibleGroups.filter(group => group.blocks.length > 1)) {
    const split = blocks.map(block => block.id === group.blocks[1].id ? { ...block, visible: false } : block);
    assert.ok(homeCompositionError("home", 2, split), "Passport copy and action cannot have separate withdrawal states");
  }
  for (const block of blocks.filter(block => block.type === "content_shelf")) {
    const wrongSource = blocks.find(candidate => candidate.type === "content_shelf" && candidate.data.source !== block.data.source)!;
    const changed = blocks.map(candidate => candidate.id === block.id ? { ...candidate, data: { ...candidate.data, source: (wrongSource as typeof block).data.source } } : candidate);
    assert.ok(homeCompositionError("home", 2, changed as PageBlock[]), `${block.section} source substitution is refused`);
  }
  const html = await preview.render({ content: previewContent, homeSources: previewContent.homeSources });
  const publicHtml = await publicRenderer.renderPublishedPage(publicContent);
  const expected = verifyOutput(html, "saved preview", publicContent.homeSources!);
  assert.deepEqual(verifyOutput(publicHtml, "public", publicContent.homeSources!), expected);
  await cp(new URL("../.compiled-renderer/client/", import.meta.url), new URL("preview/", output), { recursive: true });
  await cp(new URL("../.public-page-renderer/client/", import.meta.url), new URL("public/", output), { recursive: true });
  await writeFile(new URL("preview/index.html", output), html);
  await writeFile(new URL("public/index.html", output), publicHtml);
  await writeFile(new URL("input.json", output), JSON.stringify({ home, mediaAssets, sources: publicContent.homeSources, expected, rendererSha: sha }));
  const renderSavedVariant = async (variant: typeof home, variantSources = sources) => {
    const variantRead = structuredClone(publicRead);
    variantRead.page.blocks = variant.blocks;
    const admittedPublic = await projectPublishedPageRead(variantRead, "home", sha, now, variantSources);
    const captured = fixture({ ...value, snapshot: createPreviewSnapshot("home", variant),
      publicContext: Object.assign({}, value.publicContext, { homeSources: admittedPublic.homeSources }) });
    captured.request.rendererSha = sha;
    const admittedPreview = projectCmsPreviewContent(captured.bytes, captured.request, now);
    for (const admitted of [admittedPreview, admittedPublic]) assert.deepEqual(admitted.pages[0].blocks, variant.blocks);
    return { sources: admittedPublic.homeSources!, previewHtml: await preview.render({ content: admittedPreview, homeSources: admittedPreview.homeSources }),
      publicHtml: await publicRenderer.renderPublishedPage(admittedPublic) };
  };
  // New registered layouts enter this loop without a copied presentation list.
  for (const presentation of CONTENT_SHELF_PRESENTATIONS) {
    const variant = structuredClone(home);
    variant.blocks = variant.blocks.map((block: PageBlock) => block.type === "content_shelf" ? { ...block, data: { ...block.data, presentation } } : block);
    const result = await renderSavedVariant(variant);
    const variantExpected = verifyOutput(result.previewHtml, presentation, result.sources);
    assert.deepEqual(verifyOutput(result.publicHtml, `public ${presentation}`, result.sources), variantExpected);
    for (const block of blocks.filter(block => block.type === "content_shelf")) assert.ok(attr(sectionNode(result.previewHtml, block)!, "class").split(" ").includes(`home-shelf--${presentation}`), `${block.section}: ${presentation} is rendered`);
    await writeFile(new URL(`preview/${presentation}.html`, output), result.previewHtml);
    await writeFile(new URL(`public/${presentation}.html`, output), result.publicHtml);
    await writeFile(new URL(`input-${presentation}.json`, output), JSON.stringify({ home: variant, sources: result.sources, expected: variantExpected, rendererSha: sha }));
  }
  // Fill the three external shelves to their saved limits. Short rails do not
  // expose positioned accessibility text escaping the track's scroll clipping.
  const fullHome = structuredClone(home);
  const fullSources = structuredClone(sources);
  for (const block of fullHome.blocks as PageBlock[]) {
    if (block.type !== "content_shelf" || block.section === "home-posts") continue;
    const pool = fullSources.editorial!.catalog.sources[block.section as keyof typeof catalog.sources];
    assert.equal(pool.status, "ready");
    if (pool.status !== "ready") throw new Error("Full rail source unavailable");
    const seeds = pool.cards;
    pool.cards = Array.from({ length: block.data.itemLimit }, (_, index) => {
      const seed = seeds[index % seeds.length];
      const href = seed.href.replace(/\/$/, `-overflow-${index}/`);
      return { ...seed, id: href, href, image: block.section === "home-spotlight"
        ? { url: "/brand/spotlight/more-issues.jpg", alt: "" }
        : { url: "/brand/home/new-jersey-blue.webp", alt: "New Jersey artwork" } };
    });
    Object.assign(block.data, { presentation: "rail", selectedIds: pool.cards.map(card => card.id) });
  }
  fullSources.editorial!.receipt.digest = createHash("sha256").update(homeCatalogJson(fullSources.editorial!.catalog)).digest("hex");
  // Version 51 also retains this legacy embed after the editorial sections.
  fullHome.blocks.push({ id: "overflow-retained-embed", type: "embed", order: fullHome.blocks.length, visible: true,
    data: { url: "https://youtube.com/live/E8PthYt_OUE", caption: "Latest newscast" } });
  const fullResult = await renderSavedVariant(fullHome, fullSources);
  const fullExpected = verifyOutput(fullResult.previewHtml, "full rails", fullResult.sources, fullHome.blocks, true);
  assert.deepEqual(verifyOutput(fullResult.publicHtml, "public full rails", fullResult.sources, fullHome.blocks, true), fullExpected);
  await writeFile(new URL("preview/full-rails.html", output), fullResult.previewHtml);
  await writeFile(new URL("public/full-rails.html", output), fullResult.publicHtml);
  await writeFile(new URL("input-full-rails.json", output), JSON.stringify({ home: fullHome, sources: fullResult.sources,
    expected: fullExpected, rendererSha: sha, fullRails: true }));
  for (const group of visibleGroups) {
    const withdrawn = structuredClone(home);
    const memberIds = new Set(group.blocks.map(block => block.id));
    withdrawn.blocks = withdrawn.blocks.map((block: PageBlock) => memberIds.has(block.id) ? { ...block, visible: false } : block);
    const result = await renderSavedVariant(withdrawn);
    const remaining = expected.filter(item => item.section !== group.blocks[0].section);
    for (const markup of [result.previewHtml, result.publicHtml]) {
      assert.equal(sectionNode(markup, group.blocks[0]), undefined, `Withdrawn ${group.blocks[0].section} has no fallback output`);
      assert.deepEqual(sections(markup).map(({ section, value }) => ({ section, value })), remaining, "Withdrawal preserves every other saved section");
    }
  }
  console.log(JSON.stringify({ event: "home-v2-render-parity", rendererSha: sha, sections: expected.map(item => item.section), registered: registered.map(([section]) => section), shelfPresentations: CONTENT_SHELF_PRESENTATIONS, withdrawnGroups: visibleGroups.length }));
}

if (!args.includes("--render-only")) {
  // Browser evidence belongs to the Admin gallery's locked Chromium setup.
  // Site-only CI needs only the already-declared Playwright types/render deps.
  const { chromium } = createRequire(new URL("../../admin/package.json", import.meta.url))("@playwright/test") as Pick<typeof import("playwright"), "chromium">;
  let evidence = JSON.parse(await readFile(new URL("input.json", output), "utf8"));
  assert.deepEqual(evidence.home, home, "Browser checks must use the same saved fixture as renderer checks");
  const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", reducedMotion: "reduce", deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: string[] = [];
    const phoneMismatches: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/_home-parity-input.json") return route.fulfill({ contentType: "application/json", body: JSON.stringify(evidence) });
      const clientPath = url.pathname.startsWith("/posts/_no-build-assets/_astro/")
        ? new URL(`public/${url.pathname.slice("/posts/_no-build-assets/".length)}`, output)
        : url.pathname.startsWith("/_astro/") ? new URL(`preview${url.pathname}`, output)
        : url.pathname.startsWith("/brand/") || url.pathname === "/favicon.png" ? new URL(`../public${url.pathname}`, import.meta.url) : undefined;
      if (clientPath) {
        const contentType = { ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" }[path.extname(url.pathname)] ?? "application/octet-stream";
        try { return await route.fulfill({ contentType, body: await readFile(clientPath) }); }
        catch { return route.fulfill({ status: 404, body: "Fixture asset unavailable" }); }
      }
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return route.continue();
      return route.abort();
    });
    const siteUrl = option("--site-url", "http://127.0.0.1:4329");
    const adminUrl = option("--admin-url", "http://127.0.0.1:5198");
    const widths = args.includes("--overflow-only") ? [390, 768, 1280, 1920] : [1280, 390];
    const presentations = args.includes("--overflow-only") ? ["full-rails"] : [null, ...CONTENT_SHELF_PRESENTATIONS, "full-rails"];
    const scenarios = presentations.flatMap(presentation => widths.map(width => ({ presentation, width })));
    for (const { presentation, width } of scenarios) {
      evidence = JSON.parse(await readFile(new URL(presentation ? `input-${presentation}.json` : "input.json", output), "utf8"));
      const suffix = presentation ? `-${presentation}` : "";
      await page.setViewportSize({ width, height: 900 });
      for (const surface of ["preview", "public"]) {
        await page.goto(`${siteUrl}/${surface}/${presentation ? `${presentation}.html` : ""}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        const actual = verifyOutput(await page.content(), `${surface} ${width}`, evidence.sources, evidence.home.blocks, evidence.fullRails);
        assert.deepEqual(actual, evidence.expected);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${surface} ${width}: no horizontal page overflow`);
        await page.screenshot({ animations: "disabled", path: fileURLToPath(new URL(`${surface}-${width}${suffix}.png`, output)), fullPage: true });
        if (evidence.fullRails) {
          const rails = page.locator(".home-curated__rail");
          assert.equal(await rails.count(), 3, "Full fixture renders all three external rails");
          for (const rail of await rails.all()) {
            assert.ok(await rail.evaluate(element => element.scrollWidth > element.clientWidth), `${surface} ${width}: rail has overflow to scroll`);
            await rail.evaluate(element => { element.scrollLeft = element.scrollWidth; });
            assert.ok(await rail.evaluate(element => element.scrollLeft > 0), `${surface} ${width}: rail scrolls internally`);
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${surface} ${width}: scrolled rails stay contained`);
          await page.evaluate(() => window.scrollTo(1000, 0));
          assert.equal(await page.evaluate(() => window.scrollX), 0, `${surface} ${width}: page cannot scroll sideways`);
        }
      }
      if (args.includes("--overflow-only")) continue;
      await page.goto(`${adminUrl}/gallery.html?embed=home-v2-parity`);
      await page.getByRole("button", { name: "Reopen saved Home", exact: true }).click();
      assert.deepEqual(JSON.parse((await page.locator("[data-home-parity-saved]").getAttribute("data-home-parity-saved"))!), evidence.home.blocks);
      const controls = visibleGroups.flatMap(group => group.blocks.map(member => ({ block: group.blocks[0], member })));
      for (const { block, member } of controls) {
        await page.locator(`[id="block-card-${member.id}"]`).getByRole("button", { name: /^Edit / }).click();
        const dialog = page.getByRole("dialog");
        const panel = dialog.getByRole("complementary", { name: "Component phone preview" });
        if (width === 390) await panel.getByRole("button", { name: "Expand component preview", exact: true }).click();
        await panel.getByRole("combobox", { name: "Screen size" }).selectOption("390");
        const frame = panel.locator("iframe.home-preview-frame");
        assert.match((await frame.getAttribute("sandbox")) ?? "", /allow-same-origin/);
        await frame.contentFrame().locator("#home-preview-root").filter({ hasText: /\S/ }).waitFor();
        const phoneHtml = await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument!.documentElement.outerHTML);
        await writeFile(new URL(`phone-${member.section}-${width}${suffix}.html`, output), phoneHtml);
        await frame.screenshot({ path: fileURLToPath(new URL(`phone-${member.section}-${width}${suffix}.png`, output)) });
        const node = sectionNode(phoneHtml, block);
        try {
          assert.ok(node, `Phone preview ${width}: ${block.section} must render its entire public section`);
          assert.deepEqual(signature(node), evidence.expected.find((item: { section: string }) => item.section === block.section).value, `Phone preview ${width}: ${block.section}`);
        } catch (error) { phoneMismatches.push(String(error)); }
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
      }
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(phoneMismatches, [], "Every phone section must agree with saved preview and public output");
    console.log(JSON.stringify({ event: "home-v2-browser-parity", rendererSha: evidence.rendererSha, widths, sections: evidence.expected.map((item: { section: string }) => item.section), browserSandbox: true, shelfPresentations: presentations, phoneControls: args.includes("--overflow-only") ? 0 : visibleGroups.flatMap(group => group.blocks).length }));
  } finally { await browser.close(); }
}

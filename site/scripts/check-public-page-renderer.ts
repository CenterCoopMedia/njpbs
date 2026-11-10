import { assertPublishedResources } from "../src/lib/published-resource-check";
import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import { escapeHtml } from "../../packages/content-core/src/content-model";
import { newsletterSignupUrl } from "../../packages/content-core/src/launch-fallback";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { publishedPageRead, retainedHomeSources, pageIds, fallbackPageRead, fallbackPageIds, now } from "../tests/fixtures/published-pages/fixtures";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { projectPublicPageContextRead } from "../src/lib/public-page-context-render";
import { comparePostHtml } from "../src/lib/post-html-comparison";

const require = createRequire(new URL("../../tests/public-post-runtime/package.json", import.meta.url));
const { Miniflare, Response: WorkerResponse } = require("miniflare");
const site = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const scheduleDataPath = fileURLToPath(new URL("../tests/fixtures/schedule-corrections-2026-10-source.json", import.meta.url));
const release = JSON.parse(await readFile(new URL("../.public-page-renderer/renderer-release.json", import.meta.url), "utf8"));
assert.equal(release.environment, "development");
const rendererSha: string = release.rendererSha;
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url)),
  "build", "--config", "astro.public-page-fixtures.config.mjs"], { cwd: site, stdio: "inherit",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", CMS_CONTENT_MODE: "published",
    SCHEDULE_DATA_PATH: scheduleDataPath,
    CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_FROZEN_BUILD: "1", CMS_OFFLINE_BUILD: "1", PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0",
    PUBLIC_SHARE_REQUIRED: "0", CMS_COMPILED_RENDERER_SHA: rendererSha, ASTRO_TELEMETRY_DISABLED: "1" } });
const reads = pageIds.map(pageId => publishedPageRead(pageId, rendererSha));
const sources = retainedHomeSources(rendererSha);
const originalHomeRead = publishedPageRead("home", rendererSha);
const emptyNewsletterRead = { ...originalHomeRead, page: { ...originalHomeRead.page, homeCompositionVersion: 2,
  blocks: [...originalHomeRead.page.blocks, createHomeNewsletterBlock("public-empty-newsletter")].map((block, order) => ({ ...block, order })) } };
const frames = [...fallbackPageIds.map(pageId => fallbackPageRead(pageId, rendererSha)),
  { ...fallbackPageRead("give", rendererSha), path: "/donate/" }];
const bundle = await build({ stdin: { resolveDir: repo, contents: `
  import { renderPublishedPage, renderPublicPageContext, rendererSha } from './site/.public-page-renderer/server/entry.mjs';
  import { projectPublishedPageRead } from './site/src/lib/published-page-render.ts';
  import { projectPublicPageContextRead } from './site/src/lib/public-page-context-render.ts';
  const emptyNewsletterRead = ${JSON.stringify(emptyNewsletterRead)};
  const reads = ${JSON.stringify(reads)}; const frames = ${JSON.stringify(frames)}; const sources = ${JSON.stringify(sources)};
  export default { async fetch(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('fallback')) {
      const frame = frames.find(frame => frame.path === url.pathname);
      if (!frame) return new Response(null, { status: 404 });
      const content = await projectPublicPageContextRead(frame, rendererSha, new Date(${JSON.stringify(now.toISOString())}), frame.pageId === 'home' ? {homeSources:sources} : {});
      return new Response(await renderPublicPageContext(content), { headers: { 'content-type': 'text/html' } });
    }
    const read = url.pathname === "/" && url.searchParams.has("empty-newsletter") ? emptyNewsletterRead : reads.find(read => read.page.path === url.pathname);
    if (!read) return new Response(null, { status: 404 });
    const content = await projectPublishedPageRead(read, read.page.pageId, rendererSha, new Date(${JSON.stringify(now.toISOString())}), read.page.pageId === 'home' ? sources : undefined);
    const html = await renderPublishedPage(content);
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  } };
` }, bundle: true, write: false, platform: "browser", format: "esm" });
const runtime = new Miniflare({ workers: [{ config: { name: "public-page-runtime", type: "worker",
  compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js",
    modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } } },
  dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } }] });
try {
  await runtime.ready;
  const compiled = await import(new URL("../.public-page-renderer/server/entry.mjs", import.meta.url).href);
  const homeBannerRead = publishedPageRead("home", rendererSha);
  const bannerSetting = homeBannerRead.settings.find(setting => setting.id === "public-homepage-banner")!;
  const disabledHomeRead = structuredClone(homeBannerRead);
  const disabledSetting = disabledHomeRead.settings.find(setting => setting.id === "public-homepage-banner")!;
  (disabledSetting.published.values as { enabled: boolean }).enabled = false;
  const disabledHomeContent = await projectPublishedPageRead(disabledHomeRead, "home", rendererSha, now, sources);
  assert.doesNotMatch(await compiled.renderPublishedPage(disabledHomeContent), /aria-label="Homepage announcement"/);
  const innerRead = publishedPageRead("contact", rendererSha);
  innerRead.settings.push(bannerSetting);
  const innerContent = await projectPublishedPageRead(innerRead, "contact", rendererSha, now);
  assert.doesNotMatch(await compiled.renderPublishedPage(innerContent), /aria-label="Homepage announcement"/);
  for (const scenario of [
    { pageId: "about", theme: "nj-decides", enabled: true, heading: true },
    { pageId: "about", theme: "default", enabled: true, heading: false },
    { pageId: "about", theme: "nj-decides", enabled: false, heading: true },
    { pageId: "contact", theme: "nj-decides", enabled: true, heading: false },
  ]) {
    const read = publishedPageRead(scenario.pageId, rendererSha);
    Object.assign(read.page, { pageTheme: scenario.theme });
    const electionSetting = structuredClone(bannerSetting);
    Object.assign(electionSetting.published, { schemaVersion: 2 });
    Object.assign(electionSetting.published.values, {
      enabled: scenario.enabled, njDecides: true, message: "Published election announcement",
    });
    read.settings.push(electionSetting);
    const content = await projectPublishedPageRead(read, scenario.pageId, rendererSha, now);
    const html = await compiled.renderPublishedPage(content);
    assert.equal((html.match(/data-nj-decides-band(?=[\s>])/g) ?? []).length, 1,
      `One election identity: ${JSON.stringify(scenario)}`);
    assert.equal(html.includes('data-page-theme="nj-decides"'), scenario.heading);
    assert.equal(html.includes('aria-label="Election announcement"'), scenario.enabled && !scenario.heading);
  }
  const staffRead = publishedPageRead("staff", rendererSha);
  const staffProfile = staffRead.authors[0] as Record<string, unknown>;
  staffProfile.photo = { url: "https://media.njpbs.org/cms-media/staff/portrait.webp", mimeType: "image/webp",
    width: 800, height: 800, focalX: 0.5, focalY: 0.5, credit: "Public portrait credit" };
  staffProfile.email = "PRIVATE working email";
  staffProfile.role = "PRIVATE working role";
  const staffContent = await projectPublishedPageRead(staffRead, "staff", rendererSha, now);
  const staffHtml = await compiled.renderPublishedPage(staffContent);
  for (const value of ["Ada Reporter", "Statehouse reporter", "Covers the Legislature for NJ PBS.",
    'href="/authors/ada-reporter/"', 'href="https://x.com/adareporter"',
    'src="https://media.njpbs.org/cms-media/staff/portrait.webp"', "Public portrait credit"]) assert(staffHtml.includes(value), value);
  assert.doesNotMatch(staffHtml, /PRIVATE/);
  const emptyResponse = await runtime.dispatchFetch("https://dev-public.example.org/?empty-newsletter");
  assert.equal(emptyResponse.status, 200);
  const emptyNewsletterHtml = await emptyResponse.text();
  assert.doesNotMatch(emptyNewsletterHtml, /Choose a newsletter for this block|standard newsletter band appears|data-cms-draft-placeholder|id="newsletter-band-heading"/);
  assert.equal((emptyNewsletterHtml.match(/data-home-section="home-newsletter"/g) ?? []).length, 1);
  assert.ok(emptyNewsletterHtml.includes('id="public-empty-newsletter-heading">Get the NJ PBS email newsletter</h2>'));
  assert.ok(emptyNewsletterHtml.includes("Station news and programming updates, delivered to your inbox."));
  assert.ok(emptyNewsletterHtml.includes('src="/brand/newsletter/abstract-blue-folds.webp"'));
  assert.ok(emptyNewsletterHtml.includes(`href="${escapeHtml(newsletterSignupUrl)}"`));
  assert.ok(emptyNewsletterHtml.includes("Sign up by email</a>"));
  const emptyContent = await projectPublishedPageRead(emptyNewsletterRead, "home", rendererSha, now, sources);
  assert.deepEqual(comparePostHtml(emptyNewsletterHtml, await compiled.renderPublishedPage(emptyContent)), []);
  if (process.argv.includes("--write-review")) {
    const directory = new URL("../../scratch/home-newsletter-proof/", import.meta.url);
    await cp(new URL("../.public-page-renderer/client/", import.meta.url), directory, { recursive: true });
    await writeFile(new URL("empty-public-actual.html", directory), emptyNewsletterHtml);
  }
  for (const read of reads) {
    const response = await runtime.dispatchFetch(`https://dev-public.example.org${read.page.path}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assertPublishedResources(html, read.page.path, "https://dev-public.example.org");
    const baseline = await readFile(new URL(`../.public-page-static-fixtures${read.page.path}index.html`, import.meta.url), "utf8");
    assert.deepEqual(comparePostHtml(baseline, html), [], `Full-build/workerd Page parity for ${read.page.pageId}`);
    assert(!html.includes("PRIVATE"));
    if (read.page.pageId === "home") {
      const bannerIndex = html.indexOf('aria-label="Homepage announcement"');
      const heroIndex = html.indexOf("data-home-hero");
      assert(bannerIndex >= 0 && heroIndex > bannerIndex, "Enabled Home banner precedes the hero");
      assert(html.includes("Published Home announcement"));
    } else assert.doesNotMatch(html, /aria-label="Homepage announcement"/);
    const content = await projectPublishedPageRead(read, read.page.pageId, rendererSha, now,
      read.page.pageId === "home" ? sources : undefined);
    assert.deepEqual(comparePostHtml(html, await compiled.renderPublishedPage(content)), []);
    await assert.rejects(() => compiled.renderPublishedPage({ ...content, kind: "private-preview" }));
    await assert.rejects(() => compiled.renderPublishedPage({ ...content, target: { ...content.target, rendererSha: "f".repeat(40) } }));
  }
  execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url)),
    "build", "--config", "astro.public-page-fixtures.config.mjs"], { cwd: site, stdio: "inherit",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", CMS_CONTENT_MODE: "published",
      CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_FROZEN_BUILD: "1", CMS_OFFLINE_BUILD: "1", CMS_PAGE_FIXTURE_FALLBACK: "1",
      PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0",
      CMS_COMPILED_RENDERER_SHA: rendererSha, ASTRO_TELEMETRY_DISABLED: "1", SCHEDULE_DATA_PATH: scheduleDataPath } });
  for (const frame of frames) {
    const response = await runtime.dispatchFetch(`https://dev-public.example.org${frame.path}?fallback`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assertPublishedResources(html, frame.path, "https://dev-public.example.org");
    const baseline = await readFile(new URL(`../.public-page-static-fixtures${frame.path}index.html`, import.meta.url), "utf8");
    assert.deepEqual(comparePostHtml(baseline, html), [], `Full-build/workerd frame parity for ${frame.pageId}`);
    assert(!html.includes("PRIVATE"));
    const content = await projectPublicPageContextRead(frame, rendererSha, now, frame.pageId === "home" ? { homeSources: sources } : {});
    assert.deepEqual(comparePostHtml(html, await compiled.renderPublicPageContext(content)), []);
    await assert.rejects(() => compiled.renderPublicPageContext({ ...content, target: { ...content.target, sourceVersion: 1 } }));
    await assert.rejects(() => compiled.renderPublicPageContext({ ...content, target: { ...content.target, rendererSha: "f".repeat(40) } }));
  }
  console.log(JSON.stringify({ event: "compiled-public-page-parity", rendererSha, pages: pageIds, committedFrames: frames.map(frame => frame.path), network: "denied" }));
} finally { await runtime.dispose(); }

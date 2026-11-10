import assert from "node:assert/strict";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { projectPublicPageContextRead } from "../src/lib/public-page-context-render";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { projectPublishedRecordRead } from "../src/lib/published-record-render";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { isPrivatePreviewRender } from "../src/lib/cms-render-context";
import { publishedPageRead, now } from "../tests/fixtures/published-pages/fixtures";
import { prose, video } from "../tests/fixtures/shadow-posts/fixtures";
import { recordRead } from "../tests/fixtures/published-records/fixtures";
import { input, fixture, now as previewNow } from "../tests/fixtures/cms-preview-content";

const mode = process.argv[2] ?? process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production";
if (!["production", "development", "private"].includes(mode) || process.argv.length > 3) throw new Error("Invalid resource admission check mode");
// An explicit development probe follows --test-pages; otherwise use the normal
// public compiler output, including when it was built for development.
const directory = mode === "private" ? ".compiled-renderer" : process.argv[2] === "development" ? ".public-page-renderer" : ".public-post-renderer";
const compiled = await import(new URL(`../${directory}/server/entry.mjs`, import.meta.url).href);
const sha = compiled.rendererSha;
const origin = mode === "development" ? "https://dev-public.example.org" : "https://njpbs.org";
const unknownHost = "unreviewed.example.test";
// Oracles: the retained published Page/Post/record resource-admission fixtures.
const resources = ["script", "iframe", "img"].map(tag => ({ tag,
  html: `<${tag} src="https://${unknownHost}/resource?draft=synthetic"></${tag}>` }));
const htmlBlock = (html: string, order = 0) => ({ id: "resource-boundary", type: "html", order, visible: true, data: { html } });

async function pageContent(html: string, id = "about") {
  const read = publishedPageRead(id, sha);
  if (html) Object.assign(read.page, { blocks: [...read.page.blocks, htmlBlock(html, read.page.blocks.length)] });
  return projectPublishedPageRead(read, id, sha, now);
}
function postContent(html: string) {
  const read = structuredClone(prose);
  Object.assign(read.document.published, { blocks: [...read.document.published.blocks, htmlBlock(html, read.document.published.blocks.length)] });
  return projectPublishedPostRead(read, read.document.published.metadata.slug, sha, now)!;
}
async function rejected(render: () => Promise<string>, diagnostic: string) {
  const diagnostics: string[] = [];
  const original = console.error;
  console.error = message => { diagnostics.push(String(message)); };
  try {
    await assert.rejects(render, error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`Published resource check failed: ${diagnostic}`), error.message);
      assert.ok(!error.message.includes("draft=synthetic"));
      assert.ok(!error.message.includes("https://"));
      return true;
    });
  } finally { console.error = original; }
  assert.equal(diagnostics.join("\n"), `Published resource check failed: ${diagnostic}`);
}

if (mode === "private") {
  for (const collection of ["cmsPages", "cmsPosts"] as const) {
    for (const { html } of resources) {
      const value = input(collection);
      Object.assign(value, { rendererSha: sha, expiresAtMs: Date.now() + 60_000 });
      const blocks = [htmlBlock(html)];
      Object.assign(value.snapshot, { blocks });
      if (value.snapshot.published) Object.assign(value.snapshot.published, { blocks });
      const f = fixture(value);
      Object.assign(f.request, { rendererSha: sha });
      const content = projectCmsPreviewContent(f.bytes, f.request, previewNow);
      const context = { content, homeSources: { schemaVersion: 1 as const, publication: null, heroCatalog: [],
        pbs: { source: "manual" as const, checkedAt: null, featured: [], more: [] },
        spotlight: { source: "spotlight-rss" as const, checkedAt: null, cards: [] } } };
      assert.equal(isPrivatePreviewRender(context), true);
      const output = await compiled.render(context);
      assert.ok(output.includes(unknownHost), `${collection} private preview lost its inspectable resource`);
      assert.match(output, /<!doctype html>/i);
    }
  }
} else {
  for (const { tag, html } of resources) {
    const page = await pageContent(html);
    await rejected(() => compiled.renderPublishedPage(page), `Unreviewed ${tag} resource host: ${unknownHost}`);
    const contextRead = publishedPageRead("about", sha);
    Object.assign(contextRead.page, { blocks: [...contextRead.page.blocks, htmlBlock(html, contextRead.page.blocks.length)] });
    const context = await projectPublicPageContextRead({ ...contextRead, kind: "published-page-context",
      pageId: "about", path: "/about/", sourceSeal: { ...contextRead.sourceSeal, codeGeneration: 5 } }, sha, now);
    await rejected(() => compiled.renderPublicPageContext(context), `Unreviewed ${tag} resource host: ${unknownHost}`);
    await rejected(() => compiled.renderPublishedPost(postContent(html)), `Unreviewed ${tag} resource host: ${unknownHost}`);
  }
  for (const family of ["programs", "events"] as const) {
    const read = recordRead(family, sha);
    const path = `/${family}/${read.documents[0].published.metadata.slug}/`;
    const content = structuredClone((await projectPublishedRecordRead(read, path, sha, now))!);
    const image = family === "programs" ? content.programs[0].keyArt : content.events[0].image;
    assert.ok(image);
    image.url = `https://${unknownHost}/pixel?draft=synthetic`;
    await rejected(() => compiled.renderPublishedRecordFamily(content), `Unreviewed img resource host: ${unknownHost}`);
    for (const route of [path, `/${family}/`]) {
      const approved = await projectPublishedRecordRead(read, route, sha, now);
      assert.match(await compiled.renderPublishedRecordFamily(approved), /<!doctype html>/i);
    }
  }
  const assets = `<script type="module" src="${origin}/posts/_no-build-assets/_astro/page.js"></script>`;
  for (const html of [assets, '<img src="https://image.pbs.org/art.jpg"><iframe src="https://www.youtube-nocookie.com/embed/test"></iframe>',
    ...(mode === "development" ? ['<img src="https://dev-media.example.org/cms-media/art.webp">'] : [])]) {
    for (const output of [await compiled.renderPublishedPage(await pageContent(html)), await compiled.renderPublishedPost(postContent(html))]) {
      assert.match(output, /<!doctype html>/i);
      assert.ok(output.includes(origin + "/posts/_no-build-assets/"), "Compiled assets did not use their own deployment origin");
      if (html.includes("youtube-nocookie")) assert.doesNotMatch(output, /data-analytics-consent|id="mcjs"|id="wisepopsjs"|id="analytics-consent-default"/);
    }
  }
  if (mode === "production") {
    const development = '<script src="https://dev-public.example.org/posts/_no-build-assets/_astro/page.js"></script>';
    await rejected(() => pageContent(development).then(page => compiled.renderPublishedPage(page)), "Unreviewed script resource host: dev-public.example.org");
    await rejected(() => compiled.renderPublishedPost(postContent(development)), "Unreviewed script resource host: dev-public.example.org");
    const developmentMedia = '<img src="https://dev-media.example.org/cms-media/art.webp">';
    await rejected(() => pageContent(developmentMedia).then(page => compiled.renderPublishedPage(page)), "Unreviewed img resource host: dev-media.example.org");
    await rejected(() => compiled.renderPublishedPost(postContent(developmentMedia)), "Unreviewed img resource host: dev-media.example.org");
  }
  const kids = await compiled.renderPublishedPage(await pageContent("", "kids"));
  const videoContent = projectPublishedPostRead(video, video.document.published.metadata.slug, sha, now)!;
  for (const html of [kids, await compiled.renderPublishedPost(videoContent)]) {
    assert.doesNotMatch(html, /data-analytics-consent|id="mcjs"|id="wisepopsjs"|id="analytics-consent-default"/);
  }
}
console.log(JSON.stringify({ event: "resource-admission-verified", mode, rendererSha: sha }));

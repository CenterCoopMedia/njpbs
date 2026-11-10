import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import type { CmsProgramBuildData } from "../src/lib/cms-programs-projection";
import { isRichTextDoc, richTextRendersEmpty } from "../../packages/content-core/src/content-model";
import { isPublicContentSlug } from "../src/lib/public-content-routes";

// Local fixture build only. This imports the actual routes and components; it
// never writes to the CMS, publishes records or enables a public build family.
const site = new URL("../", import.meta.url);
const review = new URL(".cache/program-artwork-review/", site);
const output = new URL("dist/", review);
const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, site)));
await mkdir(new URL("src/pages/", review), { recursive: true });
const packet = JSON.parse(await readFile(new URL("tests/fixtures/program-artwork.json", site), "utf8"));
assert.equal(packet.programs.length, 5);
assert.equal(new Set(packet.programs.map((entry: {record: {slug: string}}) => entry.record.slug)).size, 5);
for (const { record, artworkStatus } of packet.programs) {
  assert.equal(record.status, "draft");
  assert.equal(record.type, "program");
  assert(record.title.trim() && isPublicContentSlug(record.slug));
  assert(isRichTextDoc(record.description) && !richTextRendersEmpty(record.description));
  if (record.watchUrl) {
    const url = new URL(record.watchUrl);
    assert(url.protocol === "https:" && url.hostname === "watch.njpbs.org" && !url.username && !url.password && !url.port);
  }
  assert(!record.keyArtAssetId && !record.keyArt && !record.published);
  assert(artworkStatus.startsWith("MISSING:"));
}
const text: CmsProgramBuildData["description"] = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture synopsis." }] }] };
const wrongArt: NonNullable<CmsProgramBuildData["keyArt"]> = { assetId: packet.correction.assetId, url: "/fixture.gif", mimeType: "image/gif", width: 16, height: 9 };
type ReviewRecord = Pick<CmsProgramBuildData, "title" | "slug" | "description"> & Partial<CmsProgramBuildData>;
const projection = (record: ReviewRecord, index: number): CmsProgramBuildData => ({
  programId: `review-${index}`, locale: "en", previousSlugs: [], genre: null,
  memberOnly: false, keyArt: null, keyArtAlt: "", keyArtDecorative: false,
  watchUrl: null, assets: {}, sourceVersion: 1, publishedAt: "2026-10-23T12:00:00.000Z",
  ...record, path: `/programs/${record.slug}/`,
});
const programs: CmsProgramBuildData[] = [
  projection({ title: "State of the Arts", slug: "state-of-the-arts", description: text,
    previousSlugs: ["arts-retained-fixture"], keyArt: wrongArt, keyArtDecorative: true,
    watchUrl: "https://watch.njpbs.org/show/state-of-the-arts/" }, 0),
  ...packet.programs.map((entry: { record: ReviewRecord }, index: number) => projection(entry.record, index + 1)),
];
// Positive control: the same asset is legitimate on State of Affairs. The GIF
// is a local test pixel, never supplied as editorial artwork.
Object.assign(programs[2], { keyArt: wrongArt, keyArtAlt: "State of Affairs test control" });
await writeFile(new URL("src/data.json", review), JSON.stringify(programs));
await writeFile(new URL("src/content.config.ts", review), `
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import programs from './data.json';
const collection = (name, records) => defineCollection({ schema: z.looseObject({}),
  loader: { name, async load({store}) { store.clear(); for (const data of records) store.set({id:data.programId,data}); } } });
export const collections = {
  cmsPrograms: collection('artwork-programs', programs),
  cmsPages: collection('artwork-pages', []), cmsPosts: collection('artwork-posts', []),
  cmsAuthorsPublic: collection('artwork-authors', []), cmsRecordCards: collection('artwork-cards', []),
  cmsSiteNavigation: collection('artwork-navigation', []), cmsPublicSiteChrome: collection('artwork-chrome', []),
};
`);
await writeFile(new URL("src/pages/cards.astro", review), `---
import ProgramCard from ${modulePath("src/components/record-cards/ProgramCard.astro")};
import { programCardData } from ${modulePath("src/lib/program-card-data.ts")};
import programs from '../data.json';
---
<html lang="en"><head><title>Program card fixtures</title></head><body>
{programs.map(program => <ProgramCard headingLevel={2} card={{kind:'program', title:program.title, href:program.path, program:programCardData(program)}} />)}
</body></html>
`);
await writeFile(new URL("src/pages/prepared.astro", review), `---
import ProgramPage from ${modulePath("src/components/ProgramPage.astro")};
import programs from '../data.json';
const program = programs[0];
Astro.locals.cmsRender = {content: {kind:'public-record-family', programImageDescriptors: {programs: [{programId:program.programId, content:{url:'/prepared-wrong-art.webp',width:16,height:9}}]}}};
---
<html lang="en"><head><title>Prepared descriptor fixture</title></head><body><ProgramPage entry={{data:program}} /></body></html>
`);
await writeFile(new URL("config.mjs", review), `
import { defineConfig } from 'astro/config';
export default defineConfig({ root:${JSON.stringify(fileURLToPath(site))}, site:'https://njpbs.org',
  srcDir:${JSON.stringify(fileURLToPath(new URL("src/", review)))},
  publicDir:${JSON.stringify(fileURLToPath(new URL("public/", site)))},
  cacheDir:${JSON.stringify(fileURLToPath(new URL("cache/", review)))},
  outDir:${JSON.stringify(fileURLToPath(output))}, output:'static',
  integrations:[{ name:'program-artwork-review', hooks:{ 'astro:config:setup':({injectRoute}) => {
    for (const family of ['programs','shows']) for (const name of ['index','slug']) {
      injectRoute({pattern:'/'+family+'/'+(name==='index'?'':'[...slug]'),
        entrypoint:${JSON.stringify(fileURLToPath(new URL("src/pages/", site)))}+family+'/[...'+name+'].astro', prerender:true});
    }
  } } }]
});
`);
execFileSync(process.execPath, [fileURLToPath(new URL("node_modules/astro/bin/astro.mjs", site)), "build", "--config", ".cache/program-artwork-review/config.mjs"], {
  cwd: fileURLToPath(site), stdio: "inherit",
  env: { PATH: process.env.PATH, ASTRO_TELEMETRY_DISABLED: "1", CMS_CONTENT_MODE: "published",
    PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0" },
});
await writeFile(new URL("fixture.gif", output), Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
function all(node: any): any[] { return [node, ...(node.childNodes ?? []).flatMap(all)]; }
const attr = (node: any, name: string) => node.attrs?.find((value: any) => value.name === name)?.value;
const html = async (path: string) => readFile(new URL(`${path}index.html`, output), "utf8");
const images = (value: string) => all(parse(value)).filter(node => node.tagName === "img");
const arts = await html("programs/state-of-the-arts/");
assert.equal(images(arts).filter(node => attr(node, "src") === "/fixture.gif").length, 0);
assert(!arts.includes("prepared-wrong-art"));
assert.equal(images(await html("programs/state-of-affairs/")).filter(node => attr(node, "src") === "/fixture.gif").length, 1);
assert.equal(images(await html("prepared/")).length, 0, "prepared descriptors must not restore wrong art");
for (const path of ["programs/", "cards/"]) {
  const nodes = all(parse(await html(path)));
  const imageCount = (href: string) => nodes.filter(node => node.tagName === "a" && attr(node, "href") === href)
    .flatMap(all).filter(node => node.tagName === "img").length;
  assert.equal(imageCount("/programs/state-of-the-arts/"), 0, path);
  assert.equal(imageCount("/programs/state-of-affairs/"), 1, path);
}
for (const program of programs) {
  const page = await html(`programs/${program.slug}/`);
  const nodes = all(parse(page));
  assert.equal(nodes.filter(node => node.tagName === "h1").length, 1);
  assert.equal(images(page).filter(node => attr(node, "src") === "/fixture.gif").length,
    program.slug === "state-of-affairs" ? 1 : 0);
  for (const href of [program.watchUrl ?? "https://watch.njpbs.org/", "/live/", "/schedule/"]) {
    assert(nodes.some(node => node.tagName === "a" && attr(node, "href") === href), href);
  }
  assert((await html(`shows/${program.slug}/`)).includes(`/programs/${program.slug}/`));
}
assert((await html("programs/arts-retained-fixture/")).includes("/programs/state-of-the-arts/"));
assert((await html("shows/arts-retained-fixture/")).includes("/programs/state-of-the-arts/"));
console.log(JSON.stringify({ result: "PASS", programs: programs.length, checks: ["detail", "index", "cards", "prepared descriptor", "legitimate artwork", "no-art drafts", "watch actions", "retained and shows redirects"], output: fileURLToPath(output) }));

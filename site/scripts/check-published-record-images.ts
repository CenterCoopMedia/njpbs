import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { recordRead, recordAsset, staticRecordContent, now, type RecordArtFormat } from "../tests/fixtures/published-records/fixtures";
import { recordPaths } from "../src/lib/published-record-render";
import { projectChrome } from "../src/lib/published-post-shadow";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { freezeRetainedPublicImages } from "./retained-public-images";
import { prepareProgramImageCatalog } from "./prepare-published-record-images";
import { verifyProgramImageCatalog, programImageBytes, programImageReferences } from "../src/lib/published-record-images";
import { comparePostHtml } from "../src/lib/post-html-comparison";
const require = createRequire(new URL("../../tests/public-post-runtime/package.json", import.meta.url));
const { Miniflare, Response: WorkerResponse } = require("miniflare");
const sharp = createRequire(import.meta.url)("sharp");
const site = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const productionFixtureEnvironment = {
  CMS_DEPLOYMENT_ENVIRONMENT: "production", PUBLIC_GA4_REQUIRED: "1", PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123",
  PUBLIC_REPORT_REQUIRED: "1", PUBLIC_REPORT_ENDPOINT: "https://report.example.test/", PUBLIC_TURNSTILE_SITEKEY: "public-test-sitekey",
  PUBLIC_SHARE_REQUIRED: "1", PUBLIC_SHARE_INTAKE_ENDPOINT: "https://intake.example.test/",
};
// Standalone Page/record gates must use this exact source's production graph,
// including the production shell, rather than a prior CI or local artifact.
execFileSync(process.execPath, [path.join(site, "node_modules/tsx/dist/cli.mjs"),
  path.join(site, "scripts/build-public-post-renderer.ts"), "--compile-only"], {
  cwd: site, stdio: "inherit", env: { ...process.env, ...productionFixtureEnvironment },
});
const release = JSON.parse(await readFile(new URL("../.public-post-renderer/renderer-release.json", import.meta.url), "utf8"));
const rendererSha = release.rendererSha;
const formats: RecordArtFormat[] = ["jpeg", "png", "webp", "gif"];
const privateRoot = path.join(site, ".public-page-static-fixtures", "image-inputs");
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(path.join(privateRoot, "fixture-"));
const photo = await readFile(new URL("../public/brand/spotlight/watch.jpg", import.meta.url));
const originalRows: { format: RecordArtFormat; derivatives: number; bytes: number; paths: string[] }[] = [];
try {
  for (const format of formats) {
    const inputDirectory = path.join(root, format);
    await mkdir(inputDirectory, { mode: 0o700 });
    const projected = staticRecordContent("mixed", format);
    const settings = projectChrome(recordRead("programs", rendererSha)).settings;
    const cutoffAt = { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0, toMillis: () => now.getTime() };
    const buildBatchId = `record-image-${format}`;
    const routed = (family: "programs" | "events") => recordRead(family, rendererSha, "mixed", format).documents.map(document => ({
      documentId: document.id, kind: family === "programs" ? "program" as const : "event" as const,
      sourceVersion: document.published.sourceVersion, canonicalPath: `/${family}/${document.published.metadata.slug}/`,
      aliases: document.published.metadata.previousSlugs.map(slug => `/${family}/${slug}/`), publishedSnapshot: document.published,
    }));
    const settingInputs = recordRead("programs", rendererSha).settings.map(document => ({
      documentId: document.id as "site-navigation" | "public-site-chrome", sourceVersion: document.published.sourceVersion,
      publishedSnapshot: document.published,
    }));
    const bundle = { schemaVersion: 3 as const, pages: [], posts: [], ...projected, authors: [], settings,
      receipt: createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId, generation: 1, status: "reserved",
        commitSha: rendererSha, reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null,
        cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: routed("programs"), events: routed("events"),
        authors: [], settings: settingInputs }) };
    await writeFile(path.join(inputDirectory, "input.json"), JSON.stringify(bundle), { mode: 0o600 });
    // Real encoder fixture, selected through the existing freeze boundary. GIF
    // remains a public original and must generate no derivatives or fetch.
    const bytes = format === "gif" ? null : await sharp(photo).resize(960, 540).toFormat(format).toBuffer();
    const requests: string[] = [];
    await freezeRetainedPublicImages(inputDirectory, { buildBatchId, commitSha: rendererSha }, async input => {
      requests.push(String(input));
      assert.equal(String(input), recordAsset(format).url);
      assert(bytes);
      return new Response(new Uint8Array(bytes), { headers: { "content-type": `image/${format}` } });
    });
    assert.equal(requests.length, format === "gif" ? 0 : 1);
    execFileSync(process.execPath, [path.join(site, "node_modules/tsx/dist/cli.mjs"),
      path.join(site, "tests/fixtures/published-records/build-static.mts")], { cwd: site, stdio: "inherit", env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", CMS_CONTENT_MODE: "published", ...productionFixtureEnvironment,
        CMS_OFFLINE_BUILD: "1", RECORD_PARITY_SCENARIO: "mixed", RECORD_ART_FORMAT: format,
        RECORD_IMAGE_MANIFEST: path.join(inputDirectory, "remote-images.json"), RECORD_IMAGE_BUILD_BATCH: buildBatchId,
        RECORD_IMAGE_RENDERER_SHA: rendererSha, ASTRO_TELEMETRY_DISABLED: "1",
      } });
    const directory = path.join(site, ".public-page-static-fixtures/records");
    const catalog = await prepareProgramImageCatalog({ bundle, distDirectory: directory });
    await verifyProgramImageCatalog(catalog);
    assert.equal(catalog.files.length === 0, format === "gif");
    if (format !== "gif") {
      const suffixes = new Set(catalog.files.map(file => path.extname(file.path)));
      assert(suffixes.has(".avif")); assert(suffixes.has(".webp")); assert(suffixes.has(`.${format}`));
    }
    const read = { ...recordRead("programs", rendererSha, "mixed", format), programImageDescriptors: catalog };
    const script = await build({ stdin: { resolveDir: repo, contents: `
      import { renderPublishedRecordFamily, rendererSha } from './site/.public-post-renderer/server/entry.mjs';
      import { projectPublishedRecordRead } from './site/src/lib/published-record-render.ts';
      import { verifyProgramImageCatalog, programImageBytes } from './site/src/lib/published-record-images.ts';
      const read = ${JSON.stringify(read)};
      export default { async fetch(request) {
        const path = new URL(request.url).pathname;
        // Sealed local assets exercise the network boundary.
        const file = read.programImageDescriptors.files.find(file => file.path === path);
        if (file) { await verifyProgramImageCatalog(read.programImageDescriptors); return new Response(programImageBytes(file), { headers:{'content-type':file.contentType} }); }
        const content = await projectPublishedRecordRead(read, path, rendererSha, new Date(${JSON.stringify(now.toISOString())}));
        return content ? new Response(await renderPublishedRecordFamily(content)) : new Response(null,{status:404});
      } };
    ` }, bundle: true, write: false, platform: "browser", format: "esm" });
    const runtime = new Miniflare({ workers: [{ config: { name: "record-images", type: "worker", compatibilityDate: "2026-07-09",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: script.outputFiles[0].text } } } },
      dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } }] });
    const paths = ["/programs/", "/shows/", ...projected.programs.flatMap(program => recordPaths("programs", program))];
    try {
      await runtime.ready;
      for (const route of paths) {
        const response = await runtime.dispatchFetch(`https://njpbs.org${route}`);
        assert.equal(response.status, 200);
        const html = await response.text();
        const baseline = await readFile(path.join(directory, route.slice(1), "index.html"), "utf8");
        assert.deepEqual(comparePostHtml(baseline, html), [], `${format} full-build/workerd ${route}`);
        for (const file of catalog.files) assert(!html.includes(file.base64), "Private image bytes leaked into HTML");
      }
      for (const file of catalog.files) {
        const response = await runtime.dispatchFetch(`https://njpbs.org${file.path}`);
        assert.equal(response.status, 200);
        const served = new Uint8Array(await response.arrayBuffer());
        const baseline = await readFile(path.join(directory, file.path.slice(1)));
        assert.deepEqual(served, new Uint8Array(baseline), `Full-build derivative byte parity: ${format} ${file.path}`);
        assert.deepEqual(programImageBytes(file), new Uint8Array(baseline));
      }
      for (const record of catalog.programs) for (const descriptor of [record.content, record.grid]) {
        if (format !== "gif") assert(programImageReferences(descriptor).every(path => catalog.files.some(file => file.path === path)));
      }
    } finally { await runtime.dispose(); }
    originalRows.push({ format, derivatives: catalog.files.length, bytes: catalog.files.reduce((sum, file) => sum + file.size, 0), paths });
  }
  console.log(JSON.stringify({ event: "compiled-program-production-image-parity", rendererSha, network: "denied", formats: originalRows }));
} finally { await rm(root, { recursive: true, force: true }); }

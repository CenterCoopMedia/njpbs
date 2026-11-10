import { assertPublishedResources } from "../src/lib/published-resource-check";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { familyFiles } from "./post-background-files";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { recordRead, now, type RecordScenario } from "../tests/fixtures/published-records/fixtures";
import { projectPublishedRecordRead, recordPaths } from "../src/lib/published-record-render";
import { comparePostHtml } from "../src/lib/post-html-comparison";

const require = createRequire(new URL("../../tests/public-post-runtime/package.json", import.meta.url));
const { Miniflare, Response: WorkerResponse } = require("miniflare");
const site = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const { rendererSha } = JSON.parse(await readFile(new URL("../.public-page-renderer/renderer-release.json", import.meta.url), "utf8"));
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function elements(node: Node): Element[] {
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}
const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
function jsonLd(html: string): unknown[] {
  return elements(parse(html)).filter(node => node.tagName === "script" && attribute(node, "type") === "application/ld+json")
    .map(node => JSON.parse(node.childNodes.map(child => "value" in child ? child.value : "").join("")));
}
function assertEventIndex(html: string, scenario: RecordScenario) {
  const nodes = elements(parse(html));
  const list = (id: string) => {
    const node = nodes.find(node => attribute(node, "id") === id);
    assert(node, id);
    return elements(node).filter(child => child.tagName === "a").map(child => attribute(child, "href"));
  };
  assert.deepEqual(list("upcoming-events"), scenario === "mixed" ? [
    "/events/current-ongoing/", "/events/current-upcoming-earlier/", "/events/current-event-one/",
  ] : []);
  assert.deepEqual(list("past-event-list"), scenario === "mixed" ? [
    "/events/current-past-recent/", "/events/current-past-older/",
  ] : []);
  for (const [id, hidden] of [["no-upcoming", scenario === "mixed"], ["past-events", scenario !== "mixed"]] as const) {
    const node = nodes.find(node => attribute(node, "id") === id);
    assert(node, id);
    assert.equal(attribute(node, "hidden") !== undefined, hidden, id);
  }
}

async function verifyScenario(scenario: RecordScenario) {
  execFileSync(process.execPath, ["--import", fileURLToPath(new URL("../tests/fixtures/published-records/clock.mjs", import.meta.url)),
    fileURLToPath(new URL("../node_modules/astro/bin/astro.mjs", import.meta.url)),
    "build", "--config", "astro.public-record-fixtures.config.mjs"], { cwd: site, stdio: "inherit",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", CMS_CONTENT_MODE: "published",
      CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_FROZEN_BUILD: "1", PUBLIC_GA4_REQUIRED: "0",
      PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0", ASTRO_TELEMETRY_DISABLED: "1", RECORD_PARITY_SCENARIO: scenario } });
  const retained = await familyFiles(fileURLToPath(new URL("../.public-page-static-fixtures/records/", import.meta.url)), ["programs", "events"]);
  const reads = [recordRead("programs", rendererSha, scenario), recordRead("events", rendererSha, scenario)];
  const bundle = await build({ stdin: { resolveDir: repo, contents: `
    import { renderPublishedRecordFamily, rendererSha } from './site/.public-page-renderer/server/entry.mjs';
    import { projectPublishedRecordRead } from './site/src/lib/published-record-render.ts';
    const reads = ${JSON.stringify(reads)};
    export default { async fetch(request) {
      const path = new URL(request.url).pathname;
      const read = reads.find(read => path.startsWith('/' + read.family + '/') || read.family === 'programs' && path.startsWith('/shows/'));
      if (!read) return new Response(null, { status: 404 });
      const content = await projectPublishedRecordRead(read, path, rendererSha, new Date(${JSON.stringify(now.toISOString())}));
      return content ? new Response(await renderPublishedRecordFamily(content), { headers: {'content-type':'text/html'} }) : new Response(null, {status:404});
    } };
  ` }, bundle: true, write: false, platform: "browser", format: "esm" });
  const runtime = new Miniflare({ workers: [{ config: { name: "public-record-runtime", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } } },
    dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } }] });
  const paths: string[] = [];
  try {
    await runtime.ready;
    const compiled = await import(new URL("../.public-page-renderer/server/entry.mjs", import.meta.url).href);
    for (const read of reads) {
      const index = await projectPublishedRecordRead(read, `/${read.family}/`, rendererSha, now);
      const records = read.family === "programs" ? index!.programs : index!.events;
      const routes = [`/${read.family}/`, ...(read.family === "programs" ? ["/shows/"] : []), ...records.flatMap(record => recordPaths(read.family, record))];
      for (const path of routes) {
        const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`);
        assert.equal(response.status, 200, path);
        const html = await response.text();
        assertPublishedResources(html, path, "https://dev-public.example.org");
        const baseline = await readFile(new URL(`../.public-page-static-fixtures/records${path}index.html`, import.meta.url), "utf8");
        assert.deepEqual(comparePostHtml(baseline, html), [], `Full-build/workerd record parity: ${scenario} ${path}`);
        const stored = retained.find(file => file.path === path);
        assert(stored, `Context family includes ${scenario} ${path}`);
        assert(stored.outputs.includes(read.family), `Context family includes ${scenario} ${path}`);
        assert.equal(stored.digest, createHash("sha256").update(baseline).digest("hex"), `Retained full-build bytes: ${scenario} ${path}`);
        assert.deepEqual(jsonLd(html), jsonLd(baseline), `Record JSON-LD: ${path}`);
        assert(!html.includes("PRIVATE"));
        const content = (await projectPublishedRecordRead(read, path, rendererSha, now))!;
        assert.deepEqual(comparePostHtml(html, await compiled.renderPublishedRecordFamily(content)), []);
        await assert.rejects(() => compiled.renderPublishedRecordFamily({ ...content, kind: "private-preview" }));
        await assert.rejects(() => compiled.renderPublishedRecordFamily({ ...content, target: { ...content.target, rendererSha: "f".repeat(40) } }));
        if (path === "/events/") assertEventIndex(html, scenario);
        paths.push(path);
      }
      if (scenario !== "mixed") {
        const original = recordRead(read.family, rendererSha);
        for (const document of original.documents) {
          const bases = read.family === "programs" ? ["programs", "shows"] : ["events"];
          for (const base of bases) {
            for (const slug of [document.published.metadata.slug, ...document.published.metadata.previousSlugs]) {
              const path = `/${base}/${slug}/`;
              assert.equal((await runtime.dispatchFetch(`https://dev-public.example.org${path}`)).status, 404, path);
              await assert.rejects(() => readFile(new URL(`../.public-page-static-fixtures/records${path}index.html`, import.meta.url)));
            }
          }
        }
      }
    }
    assert.equal((await runtime.dispatchFetch("https://dev-public.example.org/events/missing/")).status, 404);
    console.log(JSON.stringify({ event: "compiled-public-record-parity", rendererSha, scenario, clock: now.toISOString(), paths, network: "denied" }));
  } finally { await runtime.dispose(); }
}

for (const scenario of ["mixed", "empty", "withdrawn"] as const) await verifyScenario(scenario);

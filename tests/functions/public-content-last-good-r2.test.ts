import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const rendererSha = "a".repeat(40);
// PublicSiteLayout emits its processed module script after Base's closing html.
const html = '<!doctype html><html><body>Verified retained HTML</body></html>' +
  '<script type="module" src="/posts/_no-build-assets/_astro/layout.js"></script>';
const digest = createHash("sha256").update(html).digest("hex");
let runtime: Miniflare;

beforeAll(async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { createPublicContentLastGood } from './workers/src/public-content-last-good';
    import { publicationTarget } from './functions/lib/publication-target';
    export default { async fetch(request, env) {
      const retained = createPublicContentLastGood({ store: env.CONTENT,
        target: publicationTarget('production'), rendererSha: '${rendererSha}' });
      const response = new Response(${JSON.stringify(html)}, { headers: {
        'content-type': 'text/html; charset=utf-8', 'x-njpbs-content-source': 'cms-page-no-build',
        'x-njpbs-renderer-sha': '${rendererSha}', 'x-njpbs-code-generation': '7',
        'x-njpbs-html-sha256': '${digest}' } });
      await retained.store(request, response);
      return await retained.read(request, 7) ?? new Response('Missing retained copy', { status: 404 });
    } };` }, bundle: true, format: "esm", platform: "browser", write: false });
  runtime = new Miniflare({ workers: [{ config: { name: "last-good-r2", type: "worker",
    compatibilityDate: "2026-07-10", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: compiled.outputFiles[0].text },
    } }, env: { CONTENT: { type: "r2", name: "last-good" } } } }] });
});

it("retains Page and Post responses through waitUntil, including Astro trailers, for an authority outage", async () => {
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { createPublicContentLastGood } from './workers/src/public-content-last-good';
    import { createNoBuildPageWorker } from './workers/src/no-build-page-worker';
    import { createTransitionalPostReadWorker } from './workers/src/transitional-post-read-worker';
    import { publicationTarget } from './functions/lib/publication-target';
    import fixture from './site/tests/fixtures/shadow-posts/post.json';
    const target = publicationTarget('production'), rendererSha = '${rendererSha}', html = ${JSON.stringify(html)};
    const receipt = { schemaVersion: 1, postId: fixture.document.id, operationId: 'A'.repeat(20),
      rendererSha, sourceVersion: 7, slug: 'shadow-fixture', ownedSlugs: ['shadow-fixture', 'old-fixture'],
      generation: 999, visible: true, contextDigest: 'b'.repeat(64), admissionRevision: 1 };
    const page = { kind: 'context-page', contextReceipt: { rendererSha, contextRevision: 1,
      contextDigest: '${createHash("sha256").update("njpbs-public-context-v1:1").digest("hex")}',
      codeGeneration: 7, path: '/contact/', source: 'site' },
      renderContext: { kind: 'published-page-context', pageId: 'contact', path: '/contact/', page: null,
        sourceSeal: { rendererSha, contextRevision: 1,
          contextDigest: '${createHash("sha256").update("njpbs-public-context-v1:1").digest("hex")}', codeGeneration: 7 },
        posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } };
    export default { async fetch(request, env, ctx) {
      const lastGood = createPublicContentLastGood({ store: env.CONTENT, target, rendererSha });
      const outage = request.headers.has('fixture-outage');
      const common = { target, rendererSha, rendererReady: true, lastGood,
        cache: caches.default, waitUntil: task => ctx.waitUntil(task),
        readWithdrawal: async () => null, render: async () => html,
        fetchAsset: async request => new URL(request.url).pathname === '/_publication.json'
          ? Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 7 }) : new Response('Assets') };
      if (new URL(request.url).pathname === '/contact/') return createNoBuildPageWorker({ ...common,
        renderContext: async () => html, getDecision: async () => {
          if (outage) throw new Error('Fixture outage'); return page;
        } }).fetch(request);
      return createTransitionalPostReadWorker({ ...common,
        now: () => Date.now() + (outage ? 120_000 : 0), getDecision: async path => {
        if (outage) throw new Error('Fixture outage');
        return path === '/_publication.json' ? { kind: 'receipts', catalog: { schemaVersion: 1,
          rendererSha, generation: 999, contextDigest: 'b'.repeat(64), admissionRevision: 1, posts: [receipt] } }
          : { kind: 'post', receipt, published: fixture };
      } }).fetch(request);
    } };` }, bundle: true, format: "esm", platform: "browser", write: false });
  const serving = new Miniflare({ workers: [{ config: { name: "last-good-serving", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: compiled.outputFiles[0].text },
    } }, env: { CONTENT: { type: "r2", name: "last-good-serving" } } } }] });
  try {
    const bucket = await serving.getR2Bucket("CONTENT");
    for (const [path, source] of [["/contact/", "cms-page-context"], ["/posts/shadow-fixture/", "cms-no-build"]]) {
      const fresh = await serving.dispatchFetch(`https://njpbs.org${path}`);
      expect(fresh.headers.get("x-njpbs-content-source"), path + ": " + await fresh.clone().text()).toBe(source);
      expect(fresh.headers.get("x-njpbs-code-generation")).toBe("7");
      expect(fresh.headers.get("x-njpbs-html-sha256")).toBe(digest);
      expect(await fresh.text()).toBe(html);
      const key = `public-content-last-good/v1/njpbs-production/${rendererSha}/7/${encodeURIComponent(path)}.html`;
      await expect.poll(async () => (await bucket.head(key))?.customMetadata?.bodyDigest).toBe(digest);
      const stored = await bucket.get(key);
      expect(await stored!.text()).toBe(html);
      expect(stored!.customMetadata?.codeGeneration).toBe("7");
      const stale = await serving.dispatchFetch(`https://njpbs.org${path}`, { headers: { "fixture-outage": "true" } });
      expect(stale.headers.get("x-njpbs-content-source")).toBe("r2-last-good");
      expect(stale.headers.has("x-njpbs-publication-operation")).toBe(false);
      expect(await stale.text()).toBe(html);
    }
  } finally { await serving.dispose(); }
});
afterAll(async () => { await runtime?.dispose(); });

it("stores verified HTML through the actual Worker R2 binding and reads it back", async () => {
  const response = await runtime.dispatchFetch("https://njpbs.org/about/");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
  const bucket = await runtime.getR2Bucket("CONTENT");
  const objects = await bucket.list();
  expect(objects.objects).toHaveLength(1);
  const stored = await bucket.head(objects.objects[0].key);
  expect(stored?.customMetadata?.bodyDigest).toBe(digest);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { publishedPageRead, pageDocument, retainedHomeSources, pageIds, fallbackPageRead, fallbackPageIds } from "../tests/fixtures/published-pages/fixtures";
import { encodePageWithdrawalManifest, pageWithdrawalManifestKey } from "../../workers/src/durable-page-withdrawals";

const require = createRequire(new URL("../../tests/public-post-runtime/package.json", import.meta.url));
const { Miniflare, Response: WorkerResponse } = require("miniflare");
const { digest } = require("../../functions/lib/no-build-page-ownership.js");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const release = JSON.parse(await readFile(new URL("../.public-page-renderer/renderer-release.json", import.meta.url), "utf8"));
assert.equal(release.environment, "development");
const { rendererSha } = release;
const sources = retainedHomeSources(rendererSha);
const frames = [...fallbackPageIds.map(pageId => fallbackPageRead(pageId, rendererSha)),
  { ...fallbackPageRead("give", rendererSha), path: "/donate/" }];
const replies = pageIds.map((pageId, index) => {
  const published = publishedPageRead(pageId, rendererSha);
  const path = published.page.path;
  return { kind: "page", published, receipt: { schemaVersion: 1, pageId,
    operationId: String(index + 1).repeat(20), sourceVersion: published.page.sourceVersion,
    snapshotDigest: digest(pageDocument(pageId).published), path,
    ownedPaths: pageId === "home" ? ["/", "/_home-sources.json"] : [path, ...(published.page.previousSlugs ?? []).map((slug: string) => `/${slug}/`)],
    rendererSha, generation: 6, operationGeneration: 6, codeGeneration: sources.publication!.generation, visible: true,
    contextDigest: published.sourceSeal.contextDigest, admissionRevision: 2,
    ...(pageId === "home" ? { homeRefreshRevision: 1 } : {}) },
  ...(pageId === "home" ? { needsBaseline: true, homeRefresh: { schemaVersion: 1, revision: 1, status: "pending" } } : {}) };
});
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../workers/src/dev-public-worker.ts", import.meta.url))],
  absWorkingDir: repo, bundle: true, write: false, platform: "browser", format: "esm",
  plugins: [{ name: "isolated-dev-page-graph", setup(build) {
    build.onResolve({ filter: /\.public-post-renderer\/server\/entry\.mjs$/ }, () => ({
      path: fileURLToPath(new URL("../.public-page-renderer/server/entry.mjs", import.meta.url)),
    }));
  } }] });
const authority = `import { WorkerEntrypoint } from 'cloudflare:workers';
  const replies = ${JSON.stringify(replies)}; const frames = ${JSON.stringify(frames)}; let mode = 'normal'; let calls = 0; let pageCalls = 0; let postCalls = 0;
  export class PublicContentEntrypoint extends WorkerEntrypoint {
    getNoBuildPage(path, sha) {
      pageCalls++;
      if (sha !== ${JSON.stringify(rendererSha)} || ['outage','deploying','mismatch','missing-claim','timeout'].includes(mode)) throw new Error('Authority unavailable');
      if (mode.startsWith('context')) {
        if (path === '/schedule/' || path === '/live/') throw new Error('Lineup authority unavailable');
        if (path === '/public-meetings/') return {kind:'redirect',location:'/meeting-notices/',contextReceipt:{
          rendererSha:sha,contextRevision:4,contextDigest:frames[0].sourceSeal.contextDigest,codeGeneration:5,path,source:'site'}};
        const canonical = path === '/_home-sources.json' ? '/' : path;
        const frame = frames.find(frame => frame.path === canonical);
        if (!frame) return {kind:'pass'};
        const contextReceipt = {...frame.sourceSeal,path:canonical,source:'site'};
        if (mode === 'context-race' && ++calls > 1) contextReceipt.contextRevision++;
        return {kind:path === '/_home-sources.json' ? 'context-home-sources':'context-page',
          renderContext:frame,contextReceipt};
      }
      const original = replies.find(reply => reply.receipt.ownedPaths.includes(path));
      if (!original) return {kind:'pass'};
      const reply = structuredClone(original);
      if (mode === 'republish') {reply.receipt.operationId='R'.repeat(20);reply.receipt.operationGeneration++;reply.receipt.generation++;}
      if (mode === 'race' && ++calls > 1) reply.receipt.operationId = 'Z'.repeat(20);
      if (mode === 'gone') { reply.kind = 'gone'; reply.receipt.visible = false; delete reply.published; return reply; }
      if (path === '/_home-sources.json') reply.kind = 'home-sources';
      else if (path !== reply.receipt.path) {reply.kind='alias';reply.location=reply.receipt.path;delete reply.published;}
      return reply;
    }
    getNoBuildPost() {
      postCalls++;
      if (mode !== 'nonempty') return {kind:'pass'};
      return {kind:'receipts',catalog:{schemaVersion:1,rendererSha:${JSON.stringify(rendererSha)},generation:6,
        contextDigest:replies[0].receipt.contextDigest,admissionRevision:2,posts:[{schemaVersion:1,postId:'fixture-post',
          operationId:'P'.repeat(20),rendererSha:${JSON.stringify(rendererSha)},generation:6,sourceVersion:4,slug:'fixture-post',
          ownedSlugs:['fixture-post'],visible:true,contextDigest:replies[0].receipt.contextDigest,admissionRevision:2}]}};
    }
  }
  export default {fetch(request) { const path=new URL(request.url).pathname;
    if(path==='/counts') return Response.json({pageCalls,postCalls});
    mode=path.slice(1);calls=0;pageCalls=0;postCalls=0;return new Response(null,{status:204});}};`;
const runtime = new Miniflare({ workers: [
  { config: { name: "page-serving", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    env: { NO_BUILD_POST_RENDERER_SHA: { type: "text", value: rendererSha }, NO_BUILD_PAGE_RENDERER_SHA: { type: "text", value: rendererSha },
      DURABLE_POST_WITHDRAWALS: { type: "r2", name: "withdrawals" },
      CMS_API: { type: "worker", worker: "authority", exportName: "PublicContentEntrypoint" },
      ASSETS: { type: "fetcher", handler: (request: Request) => {
        const path = new URL(request.url).pathname;
        return new WorkerResponse(path === '/_publication.json' ? JSON.stringify({schemaVersion:1,...sources.publication})
          : path === '/_home-sources.json' ? JSON.stringify(sources) : "Static unowned Page fixture",
        {headers:{'content-type':'application/json'}});
      } } } },
    dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } },
  { config: { name: "authority", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: authority } } } } },
] });
try {
  await runtime.ready;
  for (const reply of replies) {
    for (const path of reply.receipt.ownedPaths) {
      const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`, { redirect: "manual" });
      assert.equal(response.status, path === reply.receipt.path || path === '/_home-sources.json' ? 200 : 308);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-njpbs-publication-operation'), reply.receipt.operationId);
      assert.equal(response.headers.get('x-njpbs-snapshot-sha256'), reply.receipt.snapshotDigest);
      const text = await response.text();
      assert(!text.includes('PRIVATE'));
      assert(!text.includes('Static unowned'));
      if (path === '/_home-sources.json') {
        assert.equal(JSON.parse(text).publication.buildBatchId, reply.receipt.operationId);
      } else if (path === reply.receipt.path) {
        assert.match(text, /<!doctype html>/i);
        assert.match(text, /<\/html>/i);
      } else assert.equal(response.headers.get('location'), reply.receipt.path);
    }
  }
  const head = await runtime.dispatchFetch('https://dev-public.example.org/contact/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(await (await runtime.dispatchFetch('https://dev-public.example.org/unowned/')).text(), 'Static unowned Page fixture');
  const service = await runtime.getWorker('authority');
  for (const mode of ['normal', 'outage']) {
    await service.fetch(`https://fixture.invalid/${mode}`);
    for (const path of ['/posts/', '/posts', '/posts/index.html', '/authors/', '/authors/index.html']) {
      const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`);
      assert.equal(response.headers.get('x-njpbs-publication-refresh'), null, path);
    }
    const counts = await (await service.fetch('https://fixture.invalid/counts')).json();
    assert.equal(counts.pageCalls, 0, mode);
    // The outage pass can reuse the Post reader's verified warm authority.
    if (mode === "normal") assert(counts.postCalls > 0, mode);
  }
  await service.fetch('https://fixture.invalid/nonempty');
  for (const path of ['/', '/_home-sources.json']) {
    const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-njpbs-content-source'), 'cms-page-no-build');
    assert.equal(response.headers.get('x-njpbs-publication-operation'), replies[0].receipt.operationId);
  }
  await service.fetch('https://fixture.invalid/outage');
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/renamed-page/')).headers.get('x-njpbs-content-source'), 'assets');
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/earlier-page/')).headers.get('x-njpbs-content-source'), 'assets');
  await service.fetch('https://fixture.invalid/race');
  const rerendered = await runtime.dispatchFetch('https://dev-public.example.org/contact/');
  assert.equal(rerendered.headers.get('x-njpbs-content-source'), 'cms-page-no-build');
  assert.equal(rerendered.headers.get('x-njpbs-publication-operation'), 'Z'.repeat(20));
  assert.match(await rerendered.text(), /<!doctype html>/i);
  await service.fetch('https://fixture.invalid/gone');
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/renamed-page/')).status, 410);
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/earlier-page/')).status, 410);
  await service.fetch('https://fixture.invalid/context');
  for (const path of frames.map(frame => frame.path)) {
    const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-njpbs-content-source'), 'cms-page-context');
    assert.equal(response.headers.get('x-njpbs-publication-operation'), null);
    assert.equal(response.headers.get('x-njpbs-source-version'), null);
    assert.equal(response.headers.get('x-njpbs-public-context-revision'), '4');
    const text = await response.text();
    assert(!text.includes('PRIVATE')); assert(!text.includes('Static unowned'));
    assert.match(text, /<!doctype html>/i);
  }
  const baselineCatalog = await runtime.dispatchFetch('https://dev-public.example.org/_home-sources.json');
  assert.equal(baselineCatalog.headers.get('x-njpbs-content-source'), 'assets');
  assert.deepEqual((await baselineCatalog.json()).editorial, sources.editorial);
  const alias = await runtime.dispatchFetch('https://dev-public.example.org/public-meetings/', {redirect:'manual'});
  assert.equal(alias.status, 308); assert.equal(alias.headers.get('location'), '/meeting-notices/');
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/schedule/')).headers.get('x-njpbs-content-source'), 'assets');
  assert.equal((await runtime.dispatchFetch('https://dev-public.example.org/live/')).headers.get('x-njpbs-content-source'), 'assets');
  await service.fetch('https://fixture.invalid/context-race');
  assert.equal(await (await runtime.dispatchFetch('https://dev-public.example.org/contact/')).text(), 'Static unowned Page fixture');
  const removed = replies.at(-1)!;
  const withdrawalKey = pageWithdrawalManifestKey('template-dev-public');
  const withdrawalBucket = await runtime.getR2Bucket('DURABLE_POST_WITHDRAWALS');
  await withdrawalBucket.put(withdrawalKey, encodePageWithdrawalManifest({schemaVersion:1,workerName:'template-dev-public',contextRevision:4,
    withdrawals:[{pageId:removed.receipt.pageId,operationId:removed.receipt.operationId,sourceVersion:removed.receipt.sourceVersion,
      revision:6,ownedPaths:removed.receipt.ownedPaths,verifiedAt:1234}]},'template-dev-public'));
  await service.fetch('https://fixture.invalid/gone');
  for (const path of removed.receipt.ownedPaths) {
    const response = await runtime.dispatchFetch(`https://dev-public.example.org${path}`);
    assert.equal(response.status,410);
    assert.equal(response.headers.get('x-njpbs-durable-withdrawal-operation'),removed.receipt.operationId);
  }
  for (const mode of ['deploying','mismatch','missing-claim','timeout']) {
    await service.fetch(`https://fixture.invalid/${mode}`);
    for (const path of removed.receipt.ownedPaths) for (const method of ['GET','HEAD']) {
      const response=await runtime.dispatchFetch(`https://dev-public.example.org${path}`,{method});
      assert.equal(response.status,410);assert.equal(await response.text(),'');
      assert.equal(response.headers.get('x-njpbs-content-source'),'durable-page-withdrawal');
    }
  }
  await service.fetch('https://fixture.invalid/republish');
  assert.equal((await runtime.dispatchFetch(`https://dev-public.example.org${removed.receipt.path}`)).status,200);
  assert.equal(JSON.parse(await(await withdrawalBucket.get(withdrawalKey)).text()).withdrawals[0].revision,6);
  await service.fetch('https://fixture.invalid/outage');
  assert.equal((await runtime.dispatchFetch(`https://dev-public.example.org${removed.receipt.path}`)).status,410);
  console.log(JSON.stringify({ event: 'public-page-serving-contract', rendererSha, pages: pageIds, network: 'denied' }));
} finally { await runtime.dispose(); }

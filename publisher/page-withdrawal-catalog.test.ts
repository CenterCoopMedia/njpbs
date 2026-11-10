import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { publishPageWithdrawalCatalog } from "./page-withdrawal-catalog";
import { pageWithdrawalManifestKey, readDurablePageWithdrawal } from "../workers/src/durable-page-withdrawals";
import { publicationTarget } from "../functions/lib/publication-target.js";
import type { CatalogObservation, CatalogStore } from "./withdrawal-catalog";
import { publishedPageRead } from "../site/tests/fixtures/published-pages/fixtures";

const target = publicationTarget("development"), sha = "a".repeat(40), operationId = "A".repeat(20);
const key = pageWithdrawalManifestKey(target.workerName);
let runtime: Miniflare, store: CatalogStore;
function observation(revision = 3): CatalogObservation {
  const marker = { schemaVersion: 1, pageId: "contact", operationId, sourceVersion: 7, revision,
    ownedPaths: ["/contact/", "/old-contact/"], snapshotDigest: "c".repeat(64), contextRevision: revision };
  const owner = { schemaVersion: 1, pageId: "contact", operationId, sourceVersion: 7,
    generation: revision, visible: false, ownedPaths: marker.ownedPaths, durableWithdrawal: marker };
  return { contextRevision: revision, pointer: { state: "idle", activeCommitSha: sha }, owners: [owner],
    queues: new Map([[operationId, { transport: "page-no-build-v1", status: "pending", noBuildPage: {
      ...marker, generation: revision, visible: false } }]]),
    posts: new Map([["contact", { publiclyVisible: false, published: { sourceVersion: 7 } }]]) };
}
const options = () => ({ store, target, account: "unused-fixture-observer", commitSha: sha });
const current = async () => JSON.parse(await (await runtime.getR2Bucket("WITHDRAWALS")).get(key).then(value => value!.text()));
beforeAll(async () => {
  const published = publishedPageRead("contact", sha);
  const contents = `import { createNoBuildPageWorker } from './workers/src/no-build-page-worker';
    import { readDurablePageWithdrawal } from './workers/src/durable-page-withdrawals';
    const published=${JSON.stringify(published)};
    export default { async fetch(request, env) {
      const mode=new URL(request.url).searchParams.get('mode');
      const worker=createNoBuildPageWorker({rendererSha:'${sha}',rendererReady:mode!=='renderer-down',
        cache:{async match(){},async put(){}},readWithdrawal:path=>readDurablePageWithdrawal(env.WITHDRAWALS,'${target.workerName}',path),
        fetchAsset:async()=>new Response('Old withdrawn Assets'),
        getDecision:async path=>{
          if(mode!=='republish' && mode!=='code-only' && mode!=='race' && mode!=='fresh-race') throw new Error('Authority unavailable');
          return {kind:path==='/contact/'?'page':'alias',location:'/contact/',published,
            receipt:{schemaVersion:1,pageId:'contact',operationId:'B'.repeat(20),sourceVersion:published.page.sourceVersion,
              path:'/contact/',ownedPaths:['/contact/','/old-contact/'],rendererSha:'${sha}',snapshotDigest:'c'.repeat(64),
              contextDigest:published.sourceSeal.contextDigest,admissionRevision:2,visible:true,generation:100,
              operationGeneration:mode==='code-only'?3:4,codeGeneration:5}};
        },render:async()=>{
          if(mode==='race' || mode==='fresh-race'){
            const object=await env.WITHDRAWALS.get('${key}');
            const value=object?JSON.parse(await object.text()):{schemaVersion:1,workerName:'${target.workerName}',contextRevision:5,
              withdrawals:[{pageId:'contact',operationId:'C'.repeat(20),sourceVersion:7,revision:5,
                ownedPaths:['/contact/','/old-contact/'],verifiedAt:1234}]};
            value.contextRevision=5;value.withdrawals[0].revision=5;value.withdrawals[0].operationId='C'.repeat(20);
            await env.WITHDRAWALS.put('${key}',JSON.stringify(value));
          }
          return '<!doctype html><html><body>New Page</body></html>';
        }});
      return await worker.fetch(request);
    }};`;
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "browser", format: "esm" });
  runtime = new Miniflare({ workers: [{ config: { name: "page-withdrawal-reader", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    env: { WITHDRAWALS: { type: "r2", name: "withdrawals" } } },
    dev: { outboundService: { type: "fetcher", handler: () => new Response(null, { status: 502 }) } } }] });
  await runtime.ready;
  store = await runtime.getR2Bucket("WITHDRAWALS") as unknown as CatalogStore;
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => { await (await runtime.getR2Bucket("WITHDRAWALS")).delete(key); });

it("publishes the transaction marker before completion and serves 410 through every outage", async () => {
  await publishPageWithdrawalCatalog(options(), async () => observation());
  for (const mode of ["deploying", "mismatch", "missing-claim", "timeout", "renderer-down"]) {
    for (const path of ["/contact/", "/old-contact/"]) for (const method of ["GET", "HEAD"]) {
      const response = await runtime.dispatchFetch(`${target.origin}${path}?mode=${mode}`, { method });
      expect(response.status).toBe(410);
      expect(await response.text()).toBe("");
      expect(response.headers.get("x-njpbs-content-source")).toBe("durable-page-withdrawal");
    }
  }
  expect((await current()).withdrawals[0]).toMatchObject({ pageId: "contact", revision: 3, operationId });
});
it("keeps a tombstone through newer republishing and refuses code-only or raced visibility", async () => {
  await publishPageWithdrawalCatalog(options(), async () => observation());
  expect(await (await runtime.dispatchFetch(`${target.origin}/contact/?mode=republish`)).text()).toContain("New Page");
  expect((await runtime.dispatchFetch(`${target.origin}/old-contact/?mode=republish`, { redirect: "manual" })).status).toBe(308);
  expect((await runtime.dispatchFetch(`${target.origin}/contact/?mode=code-only`)).status).toBe(410);
  expect((await runtime.dispatchFetch(`${target.origin}/contact/?mode=race`)).status).toBe(410);
  expect((await current()).withdrawals[0].revision).toBe(5);
});
it("refuses a first durable withdrawal that arrives after rendering starts", async () => {
  expect((await runtime.dispatchFetch(`${target.origin}/contact/?mode=fresh-race`)).status).toBe(410);
  expect((await current()).withdrawals[0].revision).toBe(5);
});
it("retains markers through cancelled prior operations and rejects corrupt acceptance", async () => {
  await publishPageWithdrawalCatalog(options(), async () => observation());
  const next = observation();
  next.owners[0] = { ...next.owners[0], operationId: "B".repeat(20), generation: 4, visible: true };
  next.queues.get(operationId)!.status = "cancelled";
  next.posts.set("contact", { publiclyVisible: true, published: { sourceVersion: 8 } });
  const before = await current();
  await publishPageWithdrawalCatalog(options(), async () => next);
  expect((await current()).withdrawals).toEqual(before.withdrawals);
  next.queues.get(operationId)!.noBuildPage.visible = true;
  await expect(publishPageWithdrawalCatalog(options(), async () => next)).rejects.toThrow();
  expect(await current()).toEqual(before);
});
it("reobserves after a CAS conflict and cannot overwrite a newer marker", async () => {
  await publishPageWithdrawalCatalog(options(), async () => observation());
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const stale = publishPageWithdrawalCatalog({ ...options(), store: { get: key => store.get(key),
    async put(key, text, conditions) { ready(); await held; return store.put(key, text, conditions); } } }, async () => observation(4));
  const outcome = expect(stale).rejects.toThrow();
  await started;
  await publishPageWithdrawalCatalog(options(), async () => observation(5));
  release(); await outcome;
  expect((await current()).withdrawals[0].revision).toBe(5);
});
it("keeps production and development Page keys separate and fails closed on malformed storage", async () => {
  expect(pageWithdrawalManifestKey("njpbs-production")).toBe("page-withdrawals/njpbs-production/catalog-v1.json");
  expect(pageWithdrawalManifestKey("njpbs-production")).not.toBe(key);
  expect(() => pageWithdrawalManifestKey("unknown-worker")).toThrow();
  await (await runtime.getR2Bucket("WITHDRAWALS")).put(key, "{}");
  await expect(readDurablePageWithdrawal(store, target.workerName, "/contact/")).rejects.toThrow();
  for (const method of ["GET", "HEAD"]) {
    const response = await runtime.dispatchFetch(`${target.origin}/contact/?mode=outage`, { method });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Old withdrawn Assets");
    expect(response.headers.get("x-njpbs-content-source")).toBeNull();
  }
  // Home cannot be withdrawn, so its static copy still serves during the outage.
  const home = await runtime.dispatchFetch(`${target.origin}/?mode=outage`);
  expect(home.status).toBe(200);
  expect(home.headers.get("x-njpbs-content-source")).toBe("assets");
  expect(await home.text()).toBe("Old withdrawn Assets");
});
it("never serves a withdrawn identity after its catalog becomes malformed", async () => {
  await publishPageWithdrawalCatalog(options(), async () => observation());
  const valid = JSON.stringify(await current());
  const bucket = await runtime.getR2Bucket("WITHDRAWALS");
  for (const corrupt of ["{}", valid.slice(0, -1), valid.replace('"schemaVersion":1', '"schemaVersion":2'),
    valid.replace(target.workerName, "njpbs-production")]) {
    await bucket.put(key, corrupt);
    for (const mode of ["outage", "renderer-down"]) for (const path of ["/contact/", "/old-contact/"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await runtime.dispatchFetch(`${target.origin}${path}?mode=${mode}`, { method });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("Old withdrawn Assets");
      }
    }
  }
});

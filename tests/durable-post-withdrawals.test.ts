import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { encodeWithdrawalManifest, readDurablePostWithdrawal, withdrawalManifestKey, WITHDRAWAL_MANIFEST_BYTES } from "../workers/src/durable-post-withdrawals";

const workerName = "njpbs-production", key = withdrawalManifestKey(workerName);
const manifest = { schemaVersion: 1, workerName, contextRevision: 3, withdrawals: [{ postId: "removed-post",
  operationId: "A".repeat(20), sourceVersion: 7, revision: 3, ownedSlugs: ["removed-story", "old-story"], verifiedAt: 1234 }] };
let runtime: Miniflare;
beforeAll(async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { createTransitionalPostReadWorker } from './workers/src/transitional-post-read-worker';
    import { readDurablePostWithdrawal } from './workers/src/durable-post-withdrawals';
    import fixture from './site/tests/fixtures/shadow-posts/post.json';
    let reads = 0;
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/stats') return Response.json({ reads });
      const mode = url.searchParams.get('mode');
      let authorityReads = 0;
      const receipt = { schemaVersion:1, postId:'removed-post', operationId:'${"A".repeat(20)}',
        sourceVersion:7, slug:'removed-story', ownedSlugs:['removed-story','old-story'], visible:false,
        rendererSha:'${"a".repeat(40)}', generation:1, contextDigest:'${"b".repeat(64)}', admissionRevision:1 };
      const posts = createTransitionalPostReadWorker({ rendererSha:'${"a".repeat(40)}',
        rendererReady: mode !== 'renderer-cold',
        cache:{ async match(){ throw new Error('Cache unavailable'); }, async put(){ throw new Error('Cache unavailable'); } },
        waitUntil:work => ctx.waitUntil(work), render:async()=> {
          if (mode === 'withdraw-during-render') {
            const next = ${JSON.stringify(manifest)};
            next.contextRevision = 5;
            next.withdrawals[0].revision = 5;
            next.withdrawals[0].operationId = '${"B".repeat(20)}';
            await env.WITHDRAWALS.put('${key}', JSON.stringify(next));
          }
          return '<!doctype html><html>Republished story</html>';
        },
        getDecision:async path => {
          authorityReads++;
          if (mode === 'live-withdrawal') return { kind:'gone', receipt:{...receipt,generation:5,operationId:'${"B".repeat(20)}'} };
          if (['republished', 'older-visible', 'withdraw-during-render'].includes(mode)) {
            const current = { ...receipt, visible:true, generation:mode === 'older-visible' ? 3 : 4 };
            if (path === '/posts/old-story/') return { kind:'alias', receipt:current, location:'/posts/removed-story/' };
            const published = structuredClone(fixture);
            published.document.id = 'removed-post';
            published.document.published.metadata.slug = 'removed-story';
            return { kind:'post', receipt:current, published };
          }
          if (mode === 'healthy') return { kind:'pass' };
          if (mode === 'warm-gone') return path === '/_publication.json'
            ? { kind:'receipts', receipt } : { kind:'gone', receipt };
          throw new Error('Database unavailable');
        },
        readWithdrawal:slug => readDurablePostWithdrawal({ async get(key) {
          reads++;
          if (mode === 'r2-down') throw new Error('R2 unavailable');
          return env.WITHDRAWALS.get(key);
        } }, '${workerName}', slug),
        fetchAsset:async request => new Response(request.method === 'HEAD' ? null : 'Static story copy') });
      return await posts.fetch(request) ?? new Response('Ordinary page');
    } }
  ` }, bundle: true, write: false, platform: "browser", format: "esm" });
  runtime = new Miniflare({ workers: [{ config: { name: "durable-reader", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    env: { WITHDRAWALS: { type: "r2", name: "withdrawals" } } } }] });
  await runtime.ready;
});

it("serves a newer reachable republish, retains its tombstone during outage, and refuses older or render-raced authority", async () => {
  await (await runtime.getR2Bucket("WITHDRAWALS")).put(key, encodeWithdrawalManifest(manifest, workerName));
  for (const method of ["GET", "HEAD"]) {
    await (await runtime.getR2Bucket("WITHDRAWALS")).put(key, encodeWithdrawalManifest(manifest, workerName));
    const live = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/?mode=republished", { method });
    expect(live.status).toBe(200);
    expect(await live.text()).toBe(method === "HEAD" ? "" : "<!doctype html><html>Republished story</html>");
    const alias = await runtime.dispatchFetch("https://njpbs.org/posts/old-story/?mode=republished", { method, redirect: "manual" });
    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/posts/removed-story/");
    for (const mode of ["", "older-visible", "withdraw-during-render"]) {
      const gone = await runtime.dispatchFetch(`https://njpbs.org/posts/removed-story/?mode=${mode}`, { method });
      expect(gone.status).toBe(410);
      expect(await gone.text()).toBe("");
    }
  }
  const current = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/?mode=live-withdrawal");
  expect(current.status).toBe(410);
  expect(current.headers.get("x-njpbs-content-source")).toBe("cms-no-build");
  expect(current.headers.get("x-njpbs-publication-operation")).toBe("B".repeat(20));
  expect(JSON.parse(await (await (await runtime.getR2Bucket("WITHDRAWALS")).get(key))!.text()).withdrawals[0].revision).toBe(5);
});
afterAll(async () => { await runtime?.dispose(); });

it("keeps canonical and retained alias tombstones during an outage through the actual R2 binding", async () => {
  const bucket = await runtime.getR2Bucket("WITHDRAWALS");
  await bucket.put(key, encodeWithdrawalManifest(manifest, workerName));
  for (const slug of ["removed-story", "old-story"]) for (const method of ["GET", "HEAD"]) for (const mode of ["", "renderer-cold"]) {
    const response = await runtime.dispatchFetch(`https://njpbs.org/posts/${slug}/?mode=${mode}`, { method });
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-njpbs-content-source")).toBe("durable-post-withdrawal");
    expect(await response.text()).toBe("");
  }
});

it("keeps unknown Posts on Assets, refuses Assets on R2 failure and checks tombstones before healthy authority", async () => {
  const unknown = await runtime.dispatchFetch("https://njpbs.org/posts/unknown-story/");
  expect(unknown.status).toBe(200);
  expect(await unknown.text()).toBe("Static story copy");
  const down = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/?mode=r2-down");
  expect(down.status).toBe(503);
  expect(down.headers.get("cache-control")).toBe("no-store");
  expect(await down.text()).not.toContain("Static story copy");
  const before = await (await runtime.dispatchFetch("https://njpbs.org/stats")).json() as { reads: number };
  const live = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/?mode=healthy");
  expect(live.status).toBe(410);
  const gone = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/?mode=warm-gone");
  expect(gone.status).toBe(410);
  const after = await (await runtime.dispatchFetch("https://njpbs.org/stats")).json() as { reads: number };
  expect(after.reads).toBe(before.reads + 2);
});

it("keeps Assets when no withdrawal catalog exists", async () => {
  await (await runtime.getR2Bucket("WITHDRAWALS")).delete(key);
  const response = await runtime.dispatchFetch("https://njpbs.org/posts/removed-story/");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("Static story copy");
});

it.each(["malformed", "truncated", "wrong target", "oversize"])("never serves a withdrawn Post from Assets with a %s catalog", async variant => {
  const bucket = await runtime.getR2Bucket("WITHDRAWALS");
  const valid = encodeWithdrawalManifest(manifest, workerName);
  if (variant === "malformed") await bucket.put(key, "not-json");
  else if (variant === "truncated") await bucket.put(key, valid.slice(0, -1));
  else if (variant === "wrong target") await bucket.put(key, JSON.stringify({ ...manifest, workerName: "template-dev-public" }));
  else await bucket.put(key, new Uint8Array(WITHDRAWAL_MANIFEST_BYTES + 1));
  for (const slug of ["removed-story", "old-story"]) for (const method of ["GET", "HEAD"]) for (const mode of ["", "renderer-cold"]) {
    const response = await runtime.dispatchFetch(`https://njpbs.org/posts/${slug}/?mode=${mode}`, { method });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("Static story copy");
  }
});

it("bounds an unavailable R2 read as unknown and cancels a body that arrives after the timeout", async () => {
  vi.useFakeTimers();
  try {
    let release!: (value: any) => void;
    const cancel = vi.fn();
    const store = { get: () => new Promise<any>(resolve => { release = resolve; }) };
    const result = readDurablePostWithdrawal(store, workerName, "removed-story");
    const outcome = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(500);
    await outcome;
    release({ etag: "test", size: 1, body: new ReadableStream({ cancel }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps static Home during unavailable authority without caching an Asset pass", async () => {
  const bundle = await build({ stdin: { resolveDir: resolve("."), contents: `
    import { createNoBuildPostWorker } from './workers/src/no-build-post-worker.ts';
    import { servePublicRequest } from './workers/src/public-worker.ts';
    export default { async fetch(request) {
      const assets = async () => fetch('https://private.invalid/asset');
      if (new URL(request.url).search === '?old-pass') {
        await caches.default.put(new Request('https://njpbs.org/?__background=' + 'a'.repeat(40)), new Response('', { headers: {
          'cache-control': 'public, max-age=15', 'x-njpbs-home-pass': '1',
          'x-njpbs-edge-expires-at': String(Date.now() + 15000) } }));
        return new Response('seeded');
      }
      const noBuildPosts = createNoBuildPostWorker({ rendererSha: 'a'.repeat(40), cache: caches.default,
        render: async () => { throw new Error('unexpected render'); }, fetchAsset: assets,
        getDecision: async () => (await fetch('https://private.invalid/home')).json() });
      return servePublicRequest(request, { fetchAsset: assets, noBuildPosts,
        getPublishedPage: async () => { throw new Error('unexpected Contact read'); } });
    } };
  ` }, bundle: true, write: false, platform: "browser", format: "esm" });
  let mode = "unknown";
  let calls = 0;
  let assetReads = 0;
  const runtime = new Miniflare({ workers: [{ config: { name: "home-availability", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
    } } }, dev: { outboundService: { type: "fetcher", handler: async request => {
      if (new URL(request.url).pathname === "/asset") { assetReads++; return new WorkerResponse("Full-build Home"); }
      calls++;
      if (mode === "timeout") await new Promise(resolve => setTimeout(resolve, 1_600));
      if (mode === "unknown") return new WorkerResponse("CMS unavailable", { status: 503 });
      if (mode === "pass") return WorkerResponse.json({ kind: "pass" });
      return WorkerResponse.json({ kind: "background", status: mode === "paused" ? 503 : 200,
        bytes: Buffer.from("Verified Home without withdrawn card").toString("base64"), headers: {
          "x-njpbs-admission-revision": "1", "x-njpbs-background-renderer-sha": "a".repeat(40),
          "x-njpbs-background-purge-tag": "njpbs-post-background", "content-type": "text/html",
        } });
    } } } }] });
  try {
    await runtime.ready;
    const cold = await runtime.dispatchFetch("https://njpbs.org/");
    expect(cold.status).toBe(200);
    expect(await cold.text()).toBe("Full-build Home");
    const before = calls;
    expect((await runtime.dispatchFetch("https://njpbs.org/")).status).toBe(200);
    expect(calls).toBe(before + 1);
    expect((await runtime.dispatchFetch("https://njpbs.org/?utm_source=newsletter", {
      headers: { cookie: "consent=accepted" },
    })).status).toBe(200);
    expect(calls).toBe(before + 2);
    // Entries written by the previous release must not keep an old pass alive.
    await runtime.dispatchFetch("https://njpbs.org/?old-pass");
    expect((await runtime.dispatchFetch("https://njpbs.org/")).status).toBe(200);
    expect(assetReads).toBe(4);
    for (mode of ["current", "paused", "pass", "timeout"]) {
      const response = await runtime.dispatchFetch("https://njpbs.org/?cms-context=home");
      expect(response.status).toBe(200);
      const body = await response.text();
      if (mode === "current") expect(body).toBe("Verified Home without withdrawn card");
      else if (mode === "pass") expect(body).toBe("Full-build Home");
      else expect(body).toBe("Full-build Home");
    }
    expect(assetReads).toBe(7);
  } finally { await runtime.dispose(); }
});

it("serves listing families and shared HEAD entries through the real workerd cache", async () => {
  const bundle = await build({ stdin: { resolveDir: resolve("."), contents: `
    import { createNoBuildPostWorker } from './workers/src/no-build-post-worker.ts';
    let rendererSha = "a".repeat(40);
    export default { async fetch(request) {
      const url = new URL(request.url);
      if (url.search === '?release-b') { rendererSha = 'b'.repeat(40); return new Response('activated'); }
      const key = new Request('https://njpbs.org' + url.pathname + '?__background=' + rendererSha);
      if (url.search === '?inspect') {
        const entry = await caches.default.match(key);
        return Response.json({ expiresAt: Number(entry?.headers.get('x-njpbs-edge-expires-at')),
          control: entry?.headers.get('cache-control'), tag: entry?.headers.get('cache-tag') });
      }
      if (url.search === '?expired-entry') {
        await caches.default.put(key, new Response('expired old content', { headers: {
          'cache-control': 'public, max-age=3600', 'x-njpbs-edge-expires-at': String(Date.now() - 1) } }));
        return new Response('seeded');
      }
      if (url.search === '?evict') { await caches.default.delete(key); return new Response('evicted'); }
      return createNoBuildPostWorker({ rendererSha, cache: caches.default,
        render: async () => { throw new Error('unexpected render'); },
        fetchAsset: async request => new Response('release stylesheet', {
          status: new URL(request.url).pathname === '/_astro/' + rendererSha[0] + '.css' ? 200 : 404 }),
        getDecision: async (path, method) => (await fetch('https://private.invalid/decision', {
          method: 'POST', body: JSON.stringify({ path, method }) })).json(),
      }).fetch(request);
    } };
  ` }, bundle: true, write: false, platform: "browser", format: "esm" });
  let receiptRendererSha = "a".repeat(40);
  let calls = 0;
  let status = 200;
  let admissionRevision: string | undefined = "1";
  let contextOnly = false;
  let contextRevision = "3";
  let contextDigest: string | undefined = "b".repeat(64);
  let body = "last verified family";
  let expiresAt: number | undefined;
  let assetsVerified = true;
  const methods: string[] = [];
  const runtime = new Miniflare({ workers: [{ config: { name: "background-runtime", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js",
      modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } } },
    dev: { outboundService: { type: "fetcher", handler: async request => {
      expect(new URL(request.url).hostname).toBe("private.invalid");
      const input = await request.json() as { path: string; method: string };
      methods.push(input.method);
      calls++;
      return WorkerResponse.json({ kind: "background", status, bytes: Buffer.from(input.path === "/_astro/a.css" ? "verified old stylesheet" : body).toString("base64"),
        headers: { "cache-control": "no-store", "content-type": input.path.startsWith("/_astro/") ? "text/css" : "text/html; charset=utf-8",
          ...(contextOnly ? { "x-njpbs-public-context-revision": contextRevision }
            : admissionRevision === undefined ? {} : { "x-njpbs-admission-revision": admissionRevision }),
          ...(contextDigest === undefined ? {} : { "x-njpbs-background-context-sha256": contextDigest }),
          ...(assetsVerified ? { "x-njpbs-background-assets": "verified" } : {}),
          "x-njpbs-background-state": "stale", "x-njpbs-background-renderer-sha": receiptRendererSha, "x-njpbs-background-purge-tag": "njpbs-post-background",
          ...(expiresAt === undefined ? {} : { "x-njpbs-background-expires-at": String(expiresAt) }) } });
    } } } }] });
  try {
    await runtime.ready;
    for (const path of ["/", "/_home-sources.json", "/posts/", "/authors/fixture/", "/feeds/news.xml", "/api/v1/content.json",
      "/sitemap-index.xml", "/pagefind/pagefind.js", "/search/meaning-index.json"]) {
      const before = calls;
      const head = await runtime.dispatchFetch(`https://njpbs.org${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("cache-control")).toBe("no-store");
      const get = await runtime.dispatchFetch(`https://njpbs.org${path}`);
      expect(await get.text()).toBe(body);
      expect(get.headers.get("x-njpbs-background-cache")).toBe("HIT");
      expect(calls - before).toBe(1);
      expect(get.headers.get("x-njpbs-admission-revision")).toBe("1");
      expect(get.headers.get("access-control-expose-headers")?.split(", ")).toEqual([
        "x-njpbs-admission-revision", "x-njpbs-background-state", "x-njpbs-background-renderer-sha",
        "x-njpbs-background-context-sha256", "x-njpbs-background-revision",
      ]);
      expect(get.headers.has("cache-tag")).toBe(false);
      if (path === "/") {
        const publicVisitor = await runtime.dispatchFetch("https://njpbs.org/?fbclid=fixture", {
          headers: { cookie: "consent=accepted" },
        });
        expect(await publicVisitor.text()).toBe(body);
        expect(publicVisitor.headers.get("x-njpbs-background-cache")).toBe("HIT");
        expect(calls - before).toBe(1);
        for (const options of [
          { url: "https://njpbs.org/?cms-context=home", headers: { cookie: "consent=accepted" } },
          { url: "https://njpbs.org/", headers: { authorization: "Bearer fixture" } },
        ]) {
          const staff = await runtime.dispatchFetch(options.url, { headers: options.headers });
          expect(staff.headers.get("x-njpbs-background-cache")).toBe("BYPASS");
        }
      }
    }
    expect(methods.every(method => method === "GET")).toBe(true);
    const beforeHomeAlias = calls;
    const homeAlias = await runtime.dispatchFetch("https://njpbs.org/index.html/");
    expect(await homeAlias.text()).toBe(body);
    expect(homeAlias.headers.get("x-njpbs-background-cache")).toBe("HIT");
    expect(calls).toBe(beforeHomeAlias);
    // A removal after fill can retain this entry only for the original 15s budget.
    status = 503;
    const beforeWithdrawalRead = calls;
    const retained = await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js");
    expect(retained.status).toBe(200);
    expect(calls).toBe(beforeWithdrawalRead);
    const metadata = await (await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?inspect")).json() as {
      expiresAt: number; control: string; tag: string };
    expect(metadata.expiresAt).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(metadata.control).toMatch(/^public, max-age=(?:[1-9]|1[0-5])$/);
    expect(metadata.tag).toBe("njpbs-post-background");
    status = 200;
    for (const headers of [{ cookie: "fixture=1" }, { authorization: "Bearer fixture" }]) {
      const response = await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js", { headers });
      expect(response.headers.get("x-njpbs-background-cache")).toBe("BYPASS");
    }
    const query = await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?query=1");
    expect(query.headers.get("x-njpbs-background-cache")).toBe("BYPASS");
    // Purge evicts the old object; the next ordinary request selects replacement bytes.
    await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?evict");
    body = "replacement family";
    expect(await (await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js")).text()).toBe(body);
    await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?evict");
    expiresAt = Date.now() - 1;
    const expired = await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js");
    expect(expired.status).toBe(503);
    expect(await expired.text()).not.toContain(body);
    expiresAt = undefined;
    await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?expired-entry");
    const refreshed = await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js");
    expect(await refreshed.text()).toBe(body);
    expect(refreshed.headers.get("x-njpbs-background-cache")).toBe("MISS");
    await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js?evict");
    status = 503;
    expect((await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js")).status).toBe(503);
    status = 200;
    expect((await runtime.dispatchFetch("https://njpbs.org/pagefind/pagefind.js")).status).toBe(200);
    // A cache fill must carry valid admission evidence after the restack.
    for (const revision of [undefined, "0", "bad", "9007199254740992"]) {
      await runtime.dispatchFetch("https://njpbs.org/posts/?evict");
      admissionRevision = revision;
      const refused = await runtime.dispatchFetch("https://njpbs.org/posts/");
      expect(refused.status).toBe(503);
      expect(await refused.text()).not.toContain(body);
    }
    admissionRevision = "2";
    const admitted = await runtime.dispatchFetch("https://njpbs.org/posts/");
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("x-njpbs-admission-revision")).toBe("2");
    const admittedHead = await runtime.dispatchFetch("https://njpbs.org/posts/", { method: "HEAD" });
    expect(admittedHead.headers.get("x-njpbs-background-cache")).toBe("HIT");
    expect(admittedHead.headers.get("x-njpbs-admission-revision")).toBe("2");
    // #3096: a new Worker uses verified old HTML and its retained asset graph.
    body = '<link rel="stylesheet" href="/_astro/a.css">old release listing';
    await runtime.dispatchFetch("https://njpbs.org/posts/?evict");
    expect((await runtime.dispatchFetch("https://njpbs.org/posts/")).status).toBe(200);
    expect((await runtime.dispatchFetch("https://njpbs.org/_astro/a.css")).status).toBe(200);
    await runtime.dispatchFetch("https://njpbs.org/posts/?release-b");
    const oldAsset = await runtime.dispatchFetch("https://njpbs.org/_astro/a.css");
    expect(oldAsset.status).toBe(200);
    expect(await oldAsset.text()).toBe("verified old stylesheet");
    expect(oldAsset.headers.get("content-type")).toBe("text/css");
    for (const method of ["GET", "HEAD"]) {
      const retained = await runtime.dispatchFetch("https://njpbs.org/posts/", { method });
      expect(retained.status).toBe(200);
      expect(await retained.text()).toBe(method === "HEAD" ? "" : body);
    }
    // A legacy release with no asset manifest keeps its old refusal behavior.
    await runtime.dispatchFetch("https://njpbs.org/posts/?evict");
    assetsVerified = false;
    expect((await runtime.dispatchFetch("https://njpbs.org/posts/")).status).toBe(503);
    assetsVerified = true;
    expiresAt = Date.now() - 1;
    for (const method of ["GET", "HEAD"]) {
      expect((await runtime.dispatchFetch("https://njpbs.org/posts/", { method })).status).toBe(503);
    }
    expiresAt = undefined;
    receiptRendererSha = "b".repeat(40);
    body = '<link rel="stylesheet" href="/_astro/b.css">new release listing';
    const replaced = await runtime.dispatchFetch("https://njpbs.org/posts/");
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).toBe(body);
    expect((await runtime.dispatchFetch("https://njpbs.org/_astro/b.css")).status).toBe(200);
    contextOnly = true;
    for (const revision of ["0", "bad", "9007199254740992", "3"]) {
      contextRevision = revision;
      await runtime.dispatchFetch("https://njpbs.org/feeds/news.xml?evict");
      const response = await runtime.dispatchFetch("https://njpbs.org/feeds/news.xml");
      expect(response.status).toBe(revision === "3" ? 200 : 503);
      if (revision === "3") {
        expect(response.headers.has("x-njpbs-admission-revision")).toBe(false);
        expect(response.headers.get("x-njpbs-public-context-revision")).toBe("3");
        expect(response.headers.get("access-control-expose-headers")).toContain("x-njpbs-public-context-revision");
        const head = await runtime.dispatchFetch("https://njpbs.org/feeds/news.xml", { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
      }
    }
    for (contextDigest of [undefined, "bad"]) {
      await runtime.dispatchFetch("https://njpbs.org/feeds/news.xml?evict");
      expect((await runtime.dispatchFetch("https://njpbs.org/feeds/news.xml")).status).toBe(503);
    }
  } finally { await runtime.dispose(); }
});

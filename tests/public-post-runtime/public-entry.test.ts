import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("serves copied Data Hub embeds through the legacy Snippet and public Worker", async () => {
  const base = "/data/figures/unemployment/embed/";
  const cases = [
    ["?view=chart", ""],
    ["?view=number", "number/"],
    ["?view=chart&revision=2026-11-09", "2026-11-09/chart/"],
    ["?view=number&revision=2026-11-09", "2026-11-09/number/"],
  ];
  const assets = new Set(cases.map(([, suffix]) => base + suffix));
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL("../../", import.meta.url)), contents: `
      import legacy from './site/snippets/legacy-redirects/snippet.js';
      import publicWorker from './workers/src/public-no-build-entry.ts';
      export default { fetch(request, env, ctx) {
        return legacy.fetch(request, {
          ASSETS: { fetch: originRequest => publicWorker.fetch(originRequest, env, ctx) },
        });
      } };` },
    bundle: true, write: false, platform: "browser", format: "esm",
  });
  const runtime = new Miniflare({ workers: [{ config: {
    name: "figure-embed", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
    } },
    env: {
      DURABLE_POST_WITHDRAWALS: { type: "r2", name: "figure-embed" },
      ASSETS: { type: "fetcher", handler: request => {
        const { pathname, search } = new URL(request.url);
        if (search || !assets.has(pathname)) return new WorkerResponse(null, { status: 404 });
        return new WorkerResponse(pathname, { headers: {
          "content-type": "text/html", "x-frame-options": "SAMEORIGIN",
        } });
      } },
    },
  } }] });
  try {
    const headers = { referer: "https://example.org/", "sec-fetch-dest": "iframe" };
    for (const [query, suffix] of cases) {
      const response = await runtime.dispatchFetch(`https://njpbs.org${base}${query}`, { headers });
      expect(response.status, query).toBe(200);
      expect(await response.text(), query).toBe(base + suffix);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors *");
      expect(response.headers.has("x-frame-options")).toBe(false);
    }
    const missing = await runtime.dispatchFetch("https://njpbs.org/data/figures/unknown/embed/?view=chart", { headers });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-cache");

    const retired = await runtime.dispatchFetch("https://njpbs.org/old-wordpress-post/embed/");
    expect(retired.status).toBe(410);
    expect(retired.headers.get("cache-control")).toBe("no-store");
  } finally { await runtime.dispose(); }
});

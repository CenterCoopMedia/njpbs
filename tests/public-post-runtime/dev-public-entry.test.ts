import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// The actual dev entry and compiled graph use service/Assets boundary fixtures.
// The real Firestore suite separately proves the exact candidate lease gate.
it("attests a leased dev baseline through the actual Worker entry and refuses an unknown candidate", async () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const { rendererSha } = JSON.parse(await readFile(new URL("../../site/.public-post-renderer/renderer-release.json", import.meta.url), "utf8"));
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../../workers/src/dev-public-worker.ts", import.meta.url))],
    absWorkingDir: repo, bundle: true, write: false, platform: "browser", format: "esm" });
  const body = JSON.stringify({ buildBatchId: "cms-fixture", generation: 7, commitSha: rendererSha });
  const authority = `import { WorkerEntrypoint } from 'cloudflare:workers';
    const calls = [];
    export class PublicContentEntrypoint extends WorkerEntrypoint {
      getNoBuildPost(path, sha, method, probe) {
        calls.push({ path, sha, method, candidate: probe?.buildBatchId, version: probe?.versionId });
        if (path !== '/_publication.json' || sha !== ${JSON.stringify(rendererSha)} ||
            probe?.buildBatchId !== 'cms-fixture' || probe?.versionId !== 'fixture-version') throw new Error('Unknown candidate');
        return { kind: 'baseline-probe' };
      }
    }
    export default { fetch() { return Response.json(calls); } };`;
  const runtime = new Miniflare({ workers: [
    { config: { name: "dev-public-entry", type: "worker", compatibilityDate: "2026-07-09",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
      env: { NO_BUILD_POST_RENDERER_SHA: { type: "text", value: rendererSha },
        CMS_API: { type: "worker", worker: "authority", exportName: "PublicContentEntrypoint" },
        ASSETS: { type: "fetcher", handler: () => new WorkerResponse(body, { headers: { "content-type": "application/json" } }) } } } },
    { config: { name: "authority", type: "worker", compatibilityDate: "2026-07-09",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: authority } } } } },
  ] });
  try {
    await runtime.ready;
    const valid = await runtime.dispatchFetch("https://dev-public.example.org/_publication.json?candidate=cms-fixture&version=fixture-version");
    expect(valid.status).toBe(200);
    expect(valid.headers.get("x-njpbs-publication-origin")).toBe("template-dev-public");
    expect(valid.headers.get("cache-control")).toBe("no-store");
    expect(await valid.text()).toBe(body);
    const unknown = await runtime.dispatchFetch("https://dev-public.example.org/_publication.json?candidate=foreign&version=fixture-version");
    expect(unknown.status).toBe(503);
    expect(await unknown.text()).not.toBe(body);
    const production = await runtime.dispatchFetch("https://njpbs.org/_publication.json?candidate=cms-fixture&version=fixture-version");
    expect(production.status).toBe(404);
    const authorityWorker = await runtime.getWorker("authority");
    const calls = await (await authorityWorker.fetch("https://fixture.example.org/calls")).json();
    expect(calls).toEqual([
      { path: "/_publication.json", sha: rendererSha, method: "GET", candidate: "cms-fixture", version: "fixture-version" },
      { path: "/_publication.json", sha: rendererSha, method: "GET", candidate: "foreign", version: "fixture-version" },
    ]);
  } finally { await runtime.dispose(); }
});

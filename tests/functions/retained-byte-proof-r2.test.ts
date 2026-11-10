import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Actual Page/Post owners, R2 and Worker crypto. The observer has a distinct
// service-binding entry and independently reads the same private test bucket.
it("proves the real Page and Post owners through Worker crypto and exact R2 readback", async () => {
  const rendererSha = "a".repeat(40), contextDigest = createHash("sha256").update("njpbs-public-context-v1:1").digest("hex");
  const html = '<!doctype html><html><body>Worker retained origin</body></html><script type="module" src="/layout.js"></script>';
  const bodyDigest = createHash("sha256").update(html).digest("hex");
  const contents = `
    import { createRetainedByteProofHandler, createRetainedByteObservation } from './workers/src/retained-byte-proof';
    import { createNoBuildPageWorker } from './workers/src/no-build-page-worker';
    import { createTransitionalPostReadWorker } from './workers/src/transitional-post-read-worker';
    import { publicationTarget } from './functions/lib/publication-target';
    import fixture from './site/tests/fixtures/shadow-posts/post.json';
    const target = publicationTarget('production'), rendererSha = '${rendererSha}', html = ${JSON.stringify(html)};
    const deployment = { rendererSha, versionId: 'fixture-version-7', codeGeneration: 7 };
    // Deliberately synthetic test material; never an installation credential.
    const key = crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const page = { kind: 'context-page', contextReceipt: { rendererSha, contextRevision: 1,
      contextDigest: '${contextDigest}', codeGeneration: 7, path: '/contact/', source: 'site' },
      renderContext: { kind: 'published-page-context', pageId: 'contact', path: '/contact/', page: null,
        sourceSeal: { rendererSha, contextRevision: 1, contextDigest: '${contextDigest}', codeGeneration: 7 },
        posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } };
    const receipt = { schemaVersion: 1, postId: fixture.document.id, operationId: 'A'.repeat(20), rendererSha,
      sourceVersion: 7, slug: 'shadow-fixture', ownedSlugs: ['shadow-fixture', 'old-fixture'], generation: 999,
      visible: true, contextDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64), admissionRevision: 1 };
    export default { async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path === '/__fixture-observe/') {
        const route = request.headers.get('fixture-route');
        const isPost = route.startsWith('/posts/');
        const authority = { 'x-njpbs-content-source': isPost ? 'cms-no-build' : 'cms-page-context',
          'x-njpbs-context-sha256': isPost ? 'b'.repeat(64) : '${contextDigest}',
          'x-njpbs-public-context-revision': isPost ? null : '1',
          'x-njpbs-publication-operation': isPost ? 'A'.repeat(20) : null,
          'x-njpbs-source-version': isPost ? '7' : null, 'x-njpbs-snapshot-sha256': isPost ? 'c'.repeat(64) : null,
          'x-njpbs-admission-revision': isPost ? '1' : null };
        const observation = await createRetainedByteObservation({ target, deployment, expected: { path: route,
          bodyDigest: '${bodyDigest}', authority }, key: await key });
        const response = await env.ORIGIN.fetch(observation.request);
        try { return Response.json(await observation.verify(response, env.CONTENT)); }
        catch { return new Response('Fixture proof refused; origin status ' + response.status, { status: 503 }); }
      }
      const common = { target, rendererSha, rendererReady: true, cache: caches.default, waitUntil: task => ctx.waitUntil(task),
        readWithdrawal: async () => null, render: async () => html,
        fetchAsset: async request => new URL(request.url).pathname === '/_publication.json'
          ? Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 7 }) : new Response('Assets') };
      const serve = async (request, proof) => new URL(request.url).pathname === '/contact/'
        ? createNoBuildPageWorker({ ...common, ...(proof ?? {}), renderContext: async () => html, getDecision: async () => page }).fetch(request)
        : createTransitionalPostReadWorker({ ...common, ...(proof ?? {}), getDecision: async path => path === '/_publication.json'
          ? { kind: 'receipts', catalog: { schemaVersion: 1, rendererSha, generation: 999, contextDigest: 'b'.repeat(64), admissionRevision: 1, posts: [receipt] } }
          : { kind: 'post', receipt, published: fixture } }).fetch(request);
      return createRetainedByteProofHandler({ target, deployment, key: await key, store: env.CONTENT, cache: caches.default, serve }).fetch(request);
    } };`;
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents }, bundle: true, format: "esm", platform: "browser", write: false });
  const config = { type: "worker" as const, compatibilityDate: "2026-07-10", manifest: { mainModule: "index.js", modules: {
    "index.js": { type: "esm" as const, contents: compiled.outputFiles[0].text },
  } } };
  const runtime = new Miniflare({ workers: [
    { config: { ...config, name: "proof-origin", env: { CONTENT: { type: "r2", name: "proof-content" } } } },
    { config: { ...config, name: "proof-observer", env: { CONTENT: { type: "r2", name: "proof-content" }, ORIGIN: { type: "worker", workerName: "proof-origin" } } } },
  ] });
  try {
    const observer = await runtime.getWorker("proof-observer");
    const bucket = await runtime.getR2Bucket("CONTENT", "proof-origin");
    for (const path of ["/contact/", "/posts/shadow-fixture/"]) {
      const result = await observer.fetch("https://njpbs.org/__fixture-observe/", { headers: { "fixture-route": path } });
      expect(result.status, path + ": " + await result.clone().text()).toBe(200);
      const evidence = await result.json() as { objectKey: string; bodyDigest: string; boundary: string };
      expect(evidence.boundary).toBe("origin-html");
      expect(evidence.bodyDigest).toBe(bodyDigest);
      const object = await bucket.get(evidence.objectKey);
      expect(await object!.text()).toBe(html);
      expect(object!.customMetadata?.codeGeneration).toBe("7");
      expect(object!.customMetadata?.path).toBe(path);
      // Same metadata with corrupt object bytes must never pass a later proof.
      await bucket.put(evidence.objectKey, html.replace("origin", "broken"), { customMetadata: object!.customMetadata });
      const refused = await observer.fetch("https://njpbs.org/__fixture-observe/", { headers: { "fixture-route": path } });
      expect(refused.status).toBe(503);
    }
  } finally { await runtime.dispose(); }
});

import { Miniflare } from "miniflare";

// Run the actual R2 GET inside workerd, returning its metadata and streaming
// body together. Miniflare's direct object proxy performs a synchronous RPC
// for each property access; production Worker objects have local properties.
// There is no cache: every get below performs a fresh bucket.get in workerd.
const source = `export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/object") return new Response(null, { status: 400 });
  const object = await env.CONTENT.get(url.searchParams.get("key"));
  if (!object) return new Response(null, { status: 404 });
  const metadata = { key: object.key, size: object.size, version: object.version,
    etag: object.etag, httpEtag: object.httpEtag, uploaded: object.uploaded.toISOString(),
    customMetadata: object.customMetadata, httpMetadata: object.httpMetadata };
  return new Response(object.body, { headers: {
    "x-fixture-r2-object": encodeURIComponent(JSON.stringify(metadata))
  } });
} };`;

/** Actual local R2 with one asynchronous GET transport boundary. Writes,
 * conditions, checksums, lists and heads use the original Miniflare bucket.
 * The two integration fixtures use only unconditional full-object GETs. */
export async function publicReleaseR2Fixture(name: string) {
  const runtime = new Miniflare({ workers: [{ config: { name, type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: source } } },
    env: { CONTENT: { type: "r2", name } } } }] });
  try {
    const bucket = await runtime.getR2Bucket("CONTENT"), worker = await runtime.getWorker(name);
    const store = {
      async get(key: string, options?: unknown) {
        if (options !== undefined) throw new Error("Fixture R2 GET options are unsupported");
        const response = await worker.fetch(`https://r2-fixture.invalid/object?key=${encodeURIComponent(key)}`);
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok || !response.body) throw new Error("Fixture R2 GET failed");
        const raw = response.headers.get("x-fixture-r2-object");
        if (!raw) { await response.body.cancel(); throw new Error("Fixture R2 metadata missing"); }
        const metadata = JSON.parse(decodeURIComponent(raw));
        return { ...metadata, uploaded: new Date(metadata.uploaded), body: response.body,
          get bodyUsed() { return response.bodyUsed; },
          arrayBuffer: () => response.arrayBuffer(), text: () => response.text(),
          json: () => response.json(), blob: () => response.blob(),
        };
      },
      put: bucket.put.bind(bucket), head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket), delete: bucket.delete.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
      resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    } as typeof bucket;
    return { runtime, store };
  } catch (error) { await runtime.dispose(); throw error; }
}

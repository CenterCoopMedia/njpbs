import { Miniflare } from "miniflare";

type FixtureWriteOptions = {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  sha256?: string;
  customMetadata?: Record<string, string>;
};

// Read and write bytes through the Worker entrypoint. This avoids Miniflare's
// binding proxy for PUTs and returns GET properties together with the stream.
const source = `function describe(object) {
  return { key: object.key, size: object.size, version: object.version,
    etag: object.etag, httpEtag: object.httpEtag, uploaded: object.uploaded.toISOString(),
    customMetadata: object.customMetadata, httpMetadata: object.httpMetadata };
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (url.pathname !== "/object" || key === null) return new Response(null, { status: 400 });
  if (request.method === "PUT") {
    const options = request.headers.get("x-fixture-r2-put-options");
    const bytes = await request.arrayBuffer();
    const object = await env.CONTENT.put(key, bytes, options ? JSON.parse(decodeURIComponent(options)) : undefined);
    return object ? Response.json(describe(object)) : new Response(null, { status: 412 });
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const object = await env.CONTENT.get(key);
  if (!object) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: {
    "x-fixture-r2-object": encodeURIComponent(JSON.stringify(describe(object)))
  } });
} };`;

const objectUrl = (key: string) => `https://r2-fixture.invalid/object?key=${encodeURIComponent(key)}`;

/** Local R2 with unconditional full-object reads and conditional byte writes.
 * Other operations use the Miniflare bucket's binding directly. */
export async function publicReleaseR2Fixture(name: string) {
  const runtime = new Miniflare({ workers: [{ config: { name, type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: source } } },
    env: { CONTENT: { type: "r2", name } } } }] });
  try {
    const bucket = await runtime.getR2Bucket("CONTENT");
    const store = {
      async get(key: string, options?: unknown) {
        if (options !== undefined) throw new Error("Fixture R2 GET options are unsupported");
        const response = await runtime.dispatchFetch(objectUrl(key));
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
      async put(key: string, bytes: Uint8Array, options?: FixtureWriteOptions) {
        const headers = options ? { "x-fixture-r2-put-options": encodeURIComponent(JSON.stringify(options)) } : undefined;
        const response = await runtime.dispatchFetch(objectUrl(key), { method: "PUT", body: new Uint8Array(bytes), headers });
        if (response.status === 412) return null;
        if (!response.ok) { await response.body?.cancel(); throw new Error("Fixture R2 PUT failed"); }
        const metadata = await response.json();
        return { ...metadata, uploaded: new Date(metadata.uploaded) };
      },
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket), delete: bucket.delete.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
      resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    } as typeof bucket;
    return { runtime, store };
  } catch (error) { await runtime.dispose(); throw error; }
}

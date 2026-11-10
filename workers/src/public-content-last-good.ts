import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { publicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const LAST_GOOD_WORKERS = new Set([publicationTarget("production").workerName, publicationTarget("development").workerName]);
type StoredObject = Pick<R2ObjectBody, "size" | "body" | "customMetadata">;
export type ContentStore = {
  head(key: string): Promise<Pick<R2Object, "size" | "etag" | "customMetadata"> | null>;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, value: Uint8Array, options: R2PutOptions): Promise<unknown>;
};
export type PublicContentLastGood = {
  read(request: Request, codeGeneration: number): Promise<Response | null>;
  store(request: Request, response: Response): Promise<void>;
};

class RetentionError extends Error {
  constructor(readonly code: "oversized-html" | "incomplete-html" | "unsupported-html-trailer" | "digest-mismatch" | "identity-mismatch") {
    super(code);
  }
}
/** Emit bounded categories only: provider exceptions can contain credentials. */
export function reportLastGoodRetentionFailure(stage: "page-store" | "artifact-identity" | "post-store" |
  "proof-request" | "proof-origin" | "proof-retention" | "proof-readback", error: unknown): void {
  console.warn("public-last-good-retention", { outcome: "failed", stage,
    reason: error instanceof RetentionError ? error.code : "unavailable" });
}

export async function readAssetCodeGeneration(fetchAsset: (request: Request) => Promise<Response>,
  target: PublicationTarget, rendererSha: string, expectedGeneration?: string | null): Promise<number> {
  const response = await fetchAsset(new Request(`${target.origin}/_publication.json`));
  if (response.status !== 200 || !response.body) throw new Error("Code artifact identity unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 64 * 1024) throw new RetentionError("identity-mismatch");
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let identity;
  try { identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RetentionError("identity-mismatch"); }
  if (identity?.schemaVersion !== 1 || identity.commitSha !== rendererSha ||
      !Number.isSafeInteger(identity.generation) || identity.generation < 1 ||
      expectedGeneration != null && expectedGeneration !== String(identity.generation)) throw new RetentionError("identity-mismatch");
  return identity.generation;
}

export function isVerifiedLastGoodResponse(path: string, response: Response, rendererSha: string): boolean {
  const source = response.headers.get("x-njpbs-content-source");
  if (path.startsWith("/posts/")) return ["cms-no-build", "cms-code-post-context"].includes(source ?? "") &&
    response.headers.get("x-njpbs-renderer-sha") === rendererSha;
  const record = /^\/(programs|shows|events)\/[^/]+\/$/.exec(path);
  if (record) {
    return response.headers.get("x-njpbs-record-family") === (record[1] === "events" ? "events" : "programs") &&
      /^[A-Za-z0-9_-]{1,128}$/.test(response.headers.get("x-njpbs-record-id") ?? "") &&
      response.headers.get("x-njpbs-record-visible") === "true" &&
      response.headers.get("x-njpbs-background-state") === "current" &&
      response.headers.get("x-njpbs-background-renderer-sha") === rendererSha;
  }
  return ["cms-page-no-build", "cms-page-context"].includes(source ?? "") &&
    response.headers.get("x-njpbs-renderer-sha") === rendererSha;
}

export async function retainedHtmlDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function readRetainedHtml(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) { onAbort(); throw new Error("Retained HTML unavailable"); }
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) throw new Error("Retained HTML unavailable");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_HTML_BYTES) throw new RetentionError("oversized-html");
      chunks.push(chunk.value);
    }
  } finally {
    // A cloned response is a tee. Cancellation must not wait for the viewer's
    // branch to finish before rejecting an oversized retention attempt.
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Astro emits PublicSiteLayout's processed scripts after Base closes html.
  // Require the complete document and complete script trailers; still hash
  // every byte (including those trailers) against the fresh authority proof.
  let end = -1;
  // Search the original string: Unicode case folding can change its length.
  for (const closing of html.matchAll(/<\/html>/gi)) end = closing.index;
  const trailer = end < 0 ? "" : html.slice(end + "</html>".length);
  if (!/^\s*<!doctype html>/i.test(html) || end < 0) throw new RetentionError("incomplete-html");
  // The renderer's external module trailer has this exact shape. Bound both
  // the suffix and script count; do not accept arbitrary trailing markup.
  const moduleScript = /\s*<script type="module" src="[^"<>]+"><\/script>/y;
  let trailerOffset = 0, scripts = 0;
  if (trailer.length > 64 * 1024 || new TextEncoder().encode(trailer).byteLength > 64 * 1024) {
    throw new RetentionError("unsupported-html-trailer");
  }
  while (trailer.slice(trailerOffset).trim()) {
    moduleScript.lastIndex = trailerOffset;
    if (++scripts > 16 || !moduleScript.exec(trailer)) throw new RetentionError("unsupported-html-trailer");
    trailerOffset = moduleScript.lastIndex;
  }
  return bytes;
}

/** Read-only exact-object proof. The caller supplies independently known identity;
 * metadata alone never certifies bytes or a fresh publication. */
export async function readVerifiedLastGoodBytes(store: Pick<ContentStore, "get">, target: PublicationTarget,
  rendererSha: string, codeGeneration: number, path: string, expectedDigest: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!LAST_GOOD_WORKERS.has(target.workerName) || !/^[a-f0-9]{40}$/.test(rendererSha) ||
      !Number.isSafeInteger(codeGeneration) || codeGeneration < 1 || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
      !(path === "/" || /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) ||
        /^\/(posts|programs|shows|events)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path))) return null;
  try {
    if (signal?.aborted) return null;
    const object = await store.get(lastGoodObjectKey(target, rendererSha, codeGeneration, path));
    if (!object) return null;
    const seal = object.customMetadata;
    if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_HTML_BYTES ||
        seal?.schemaVersion !== "1" || seal.rendererSha !== rendererSha || seal.path !== path ||
        seal.codeGeneration !== String(codeGeneration) || seal.bodyDigest !== expectedDigest) {
      void object.body.cancel().catch(() => {}); return null;
    }
    const bytes = await readRetainedHtml(object.body, signal);
    return bytes.byteLength === object.size && await retainedHtmlDigest(bytes) === expectedDigest ? bytes : null;
  } catch { return null; }
}
export const lastGoodObjectKey = (target: PublicationTarget, rendererSha: string, generation: number, path: string) =>
  `public-content-last-good/v1/${target.workerName}/${rendererSha}/${generation}/${encodeURIComponent(path)}.html`;

/** Stale display bytes only. Each source has its own namespace until the
 * compatible-renderer contract and retained code assets support cross-release reads. */
export function createPublicContentLastGood({ store, target, rendererSha }: {
  store: ContentStore; target: PublicationTarget; rendererSha: string;
}): PublicContentLastGood {
  if (!LAST_GOOD_WORKERS.has(target.workerName) || !/^[a-f0-9]{40}$/.test(rendererSha)) {
    throw new Error("Invalid last-good content identity");
  }
  function pathFor(request: Request): string | null {
    const url = new URL(request.url);
    if (url.origin !== target.origin || url.search || !["GET", "HEAD"].includes(request.method) ||
        ["authorization", "cookie", "range"].some(header => request.headers.has(header)) ||
        !(url.pathname === "/" || /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname) ||
          /^\/(posts|programs|shows|events)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname))) return null;
    return url.pathname;
  }
  const keyFor = (path: string, generation: number) =>
    lastGoodObjectKey(target, rendererSha, generation, path);
  return {
    async read(request, codeGeneration) {
      const path = pathFor(request);
      if (!path || !Number.isSafeInteger(codeGeneration) || codeGeneration < 1) return null;
      const object = await store.get(keyFor(path, codeGeneration));
      if (!object) return null;
      try {
        const seal = object.customMetadata;
        if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_HTML_BYTES ||
            seal?.schemaVersion !== "1" || seal.rendererSha !== rendererSha || seal.path !== path ||
            seal.codeGeneration !== String(codeGeneration) ||
            !/^[a-f0-9]{64}$/.test(seal.bodyDigest ?? "")) {
          await object.body.cancel();
          return null;
        }
        const bytes = await readRetainedHtml(object.body, request.signal);
        if (bytes.byteLength !== object.size || await retainedHtmlDigest(bytes) !== seal.bodyDigest) return null;
        return new Response(request.method === "HEAD" ? null : bytes, { headers: {
          ...SECURITY_HEADER_BASELINE, "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "x-njpbs-content-source": "r2-last-good", "x-njpbs-publication-refresh": "pending", "retry-after": "1",
        } });
      } catch { return null; }
    },
    async store(request, response) {
      const path = pathFor(request);
      if (!path || request.method !== "GET" || response.status !== 200 || !response.body ||
          response.headers.has("set-cookie") || response.headers.has("content-range") ||
          response.headers.get("content-type") !== "text/html; charset=utf-8" ||
          !isVerifiedLastGoodResponse(path, response, rendererSha)) return;
      const expectedDigest = response.headers.get("x-njpbs-html-sha256");
      const generationHeader = response.headers.get("x-njpbs-code-generation") ?? "";
      const codeGeneration = Number(generationHeader);
      if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? "") || !/^[1-9]\d*$/.test(generationHeader) ||
          !Number.isSafeInteger(codeGeneration)) return;
      const key = keyFor(path, codeGeneration);
      // Capture our branch before the first await. The viewer can consume the
      // original response while R2 metadata is still in flight.
      const copy = response.clone();
      try {
        const before = await store.head(key);
        if (before && before.size > 0 && before.size <= MAX_HTML_BYTES &&
            before.customMetadata?.schemaVersion === "1" && before.customMetadata.rendererSha === rendererSha &&
            before.customMetadata.codeGeneration === generationHeader &&
            before.customMetadata.path === path && before.customMetadata.bodyDigest === expectedDigest) return;
        const bytes = await readRetainedHtml(copy.body!, request.signal);
        const bodyDigest = await retainedHtmlDigest(bytes);
        if (bodyDigest !== expectedDigest) throw new RetentionError("digest-mismatch");
        await store.put(key, bytes, {
          // A competing retention may finish during the body read. Keep its
          // copy instead of overwriting a key that changed after our head read.
          onlyIf: before ? { etagMatches: before.etag } : { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "text/html; charset=utf-8" },
          customMetadata: { schemaVersion: "1", rendererSha, codeGeneration: generationHeader, path, bodyDigest },
        });
      } finally { void copy.body?.cancel().catch(() => {}); }
    },
  };
}

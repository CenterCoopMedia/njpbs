import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";
import { BASELINE_MANIFEST_BYTES, baselineManifestKey, baselineObjectKey, baselinePublication,
  validateContentBaseline, type BaselineFile } from "../../packages/content-core/src/public-content-baseline";

type BaselineObject = Pick<R2ObjectBody, "body" | "size" | "checksums">;
export type BaselineStore = { get(key: string): Promise<BaselineObject | null> };
function invalid(): never { throw new Error("The retained content baseline is invalid"); }
// Retain only one verified immutable table, never request I/O or a binding.
// A short negative cache lets an additive seed become visible without a deploy.
let manifestCache: { key: string; files: ReadonlyMap<string, BaselineFile> | null; expiresAt: number } | undefined;

async function within<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The retained baseline read timed out")), 500);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function json(body: ReadableStream<Uint8Array>, maximum: number): Promise<unknown> {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    return await within((async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) invalid();
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    })());
  } finally { void reader.cancel().catch(() => {}); }
}
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", json: "application/json", xml: "application/xml",
  pdf: "application/pdf", css: "text/css; charset=utf-8", js: "application/javascript", mjs: "application/javascript",
  wasm: "application/wasm", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", avif: "image/avif", gif: "image/gif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8" };

function sealedFileResponse(request: Request, target: PublicationTarget, file: BaselineFile, stored: BaselineObject): Response {
  const path = new URL(request.url).pathname;
  const noStore = path.startsWith("/posts/") || path === "/_schedule-sources.json";
  const etag = `"${file.digest}"`;
  const headers = new Headers({ ...SECURITY_HEADER_BASELINE,
    "cache-control": noStore ? "no-store" : "public, max-age=0, must-revalidate", etag,
    "content-type": MIME[file.path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream",
    "content-length": String(file.bytes), "x-njpbs-asset-storage": "r2-baseline" });
  if (["/_home-sources.json", "/_content-status.json", "/_schedule-sources.json"].includes(path)) {
    headers.set("access-control-allow-origin", target.environment === "production" ? "https://admin.njpbs.org" : "https://dev-admin.example.org");
  }
  const unchanged = request.headers.get("if-none-match")?.split(",").some(value =>
    value.trim() === "*" || value.trim().replace(/^W\//, "") === etag);
  if (unchanged) {
    void stored.body.cancel().catch(() => {});
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") void stored.body.cancel().catch(() => {});
  return new Response(request.method === "HEAD" ? null : stored.body, { headers });
}

/** An additive transport for the exact deployed artifact. Current owners still
 * decide first; unknown/unsupported reads keep legacy Assets. */
export function createContentBaselineAssetReader({ target, rendererSha, store, fetchAsset }: {
  target: PublicationTarget; rendererSha: string; store: BaselineStore;
  fetchAsset(request: Request): Promise<Response>;
}): (request: Request) => Promise<Response> {
  target = assertPublicationTarget(target);
  if (!/^[a-f0-9]{40}$/.test(rendererSha)) invalid();
  let snapshot: Promise<ReadonlyMap<string, BaselineFile> | null> | undefined;
  async function manifest() {
    const response = await within(fetchAsset(new Request(`${target.origin}/_publication.json`)));
    if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); invalid(); }
    const identity = baselinePublication(await json(response.body, 8 * 1024));
    if (identity.commitSha !== rendererSha) invalid();
    const key = baselineManifestKey(target, identity);
    if (manifestCache?.key === key && manifestCache.expiresAt > Date.now()) return manifestCache.files;
    try {
      const stored = await within(store.get(key));
      if (!stored) throw new Error("The retained baseline is not seeded");
      if (stored.size < 1 || stored.size > BASELINE_MANIFEST_BYTES) { void stored.body.cancel().catch(() => {}); invalid(); }
      const value = await validateContentBaseline(await json(stored.body, BASELINE_MANIFEST_BYTES), identity);
      const files = new Map(value.files.map(file => ["/" + file.path.split("/").map(encodeURIComponent).join("/"), file]));
      manifestCache = { key, files, expiresAt: Infinity };
      return files;
    } catch {
      if (manifestCache?.key === key && manifestCache.files) return manifestCache.files;
      manifestCache = { key, files: null, expiresAt: Date.now() + 30_000 };
      return null;
    }
  }
  async function retained(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const filePath = path.endsWith("/") ? `${path}index.html` : path;
    // Redirect/navigation rules remain with Assets until explicit adoption.
    if (/\.html$/i.test(path) || ["/_headers", "/_redirects"].includes(path) || path.startsWith("/resources/nj-politics/")) return null;
    if (path.startsWith("/_") && !["/_home-sources.json", "/_content-status.json", "/_schedule-sources.json"].includes(path) &&
        !path.startsWith("/_astro/")) return null;
    const files = await (snapshot ??= manifest().catch(() => null));
    const file = files?.get(filePath);
    if (!file) return null;
    const stored = await within(store.get(baselineObjectKey(target, file.digest)));
    if (!stored) return null;
    const checksum = stored.checksums.sha256;
    const seal = checksum && Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, "0")).join("");
    if (stored.size !== file.bytes || seal !== file.digest) { void stored.body.cancel().catch(() => {}); return null; }
    return sealedFileResponse(request, target, file, stored);
  }
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== target.origin || !["GET", "HEAD"].includes(request.method) || url.search ||
        request.headers.has("authorization") || [...request.headers.keys()].some(name =>
          name === "range" || name.startsWith("if-") && name !== "if-none-match") ||
        url.pathname === "/_publication.json") return fetchAsset(request);
    let asset: Response | undefined;
    if (!url.pathname.startsWith("/pagefind/") &&
        /\.(?:avif|gif|ico|png|jpe?g|webp|svg|css|[cm]?js|wasm|woff2?|otf|ttf)$/i.test(url.pathname)) {
      asset = await fetchAsset(request);
      if (asset.status !== 404) return asset;
    }
    try {
      const response = await retained(request);
      if (response) { void asset?.body?.cancel().catch(() => {}); return response; }
    } catch { /* The old transport remains available during additive adoption. */ }
    return asset ?? fetchAsset(request);
  };
}

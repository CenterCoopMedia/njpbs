import { liveBlogFeed, manifestFromLiveBlogHtml } from "../../packages/content-core/src/live-blog-manifest";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { publicationPostCacheTag, type PublicationTarget } from "../../functions/lib/publication-target.js";

const FEED_CACHE_CONTROL = "public, max-age=0, s-maxage=20, stale-while-revalidate=30";

/** Derive a small public read from existing immutable Post output. Cache misses
 * use the reader's withdrawal/visibility gate; cached metadata is advisory for
 * its advertised cache window. The explicit HTML load uses that gate again. */
export function createLiveBlogFeedReader({ target, rendererSha, cache, readPage, now = Date.now }: {
  target: PublicationTarget;
  rendererSha: string;
  cache: Pick<Cache, "match" | "put">;
  readPage(request: Request): Promise<Response | null>;
  now?: () => number;
}) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const slug = /^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(url.pathname)?.[1];
    if (url.origin !== target.origin || !slug || !["GET", "HEAD"].includes(request.method) ||
        url.searchParams.size !== 1 || url.searchParams.get("live-blog") !== "updates") return null;
    const headers = { ...SECURITY_HEADER_BASELINE, "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex" };
    const failure = (status: number) => new Response(null, { status, headers: { ...headers, "Cache-Control": "no-store" } });
    const key = new Request(`${target.origin}${url.pathname}?__live_blog_manifest=${rendererSha}`);
    const read = async () => {
      const cached = await cache.match(key).catch(() => undefined);
      if (cached && Number(cached.headers.get("x-njpbs-live-blog-expires")) > now()) {
        const revision = cached.headers.get("x-njpbs-live-blog-revision");
        const snapshot = revision && await cache.match(new Request(`${key.url}&revision=${revision}`)).catch(() => undefined);
        if (snapshot) return snapshot;
      }
      const source = await readPage(new Request(`${target.origin}${url.pathname}`, { headers: { Accept: "text/html" } }));
      if (!source || source.status !== 200) return failure(source?.status === 410 ? 410 : source?.status === 404 ? 404 : 503);
      if (!source.headers.get("content-type")?.includes("text/html")) return failure(503);
      const reader = source.body?.getReader();
      if (!reader) return failure(503);
      const decoder = new TextDecoder(); let size = 0, text = "";
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) return failure(503);
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      const manifest = manifestFromLiveBlogHtml(text);
      if (!manifest) return failure(404);
      const json = JSON.stringify(liveBlogFeed(manifest));
      const snapshotSha = source.headers.get("x-njpbs-snapshot-sha256");
      const revision = snapshotSha && /^[a-f0-9]{64}$/.test(snapshotSha) ? snapshotSha :
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
      const response = new Response(json, { headers: { ...headers, "Cache-Control": FEED_CACHE_CONTROL } });
      const stored = new Response(response.clone().body, { headers: { ...headers, "Cache-Control": "public, max-age=20",
        "Cache-Tag": publicationPostCacheTag(target, slug), "x-njpbs-live-blog-expires": String(now() + 20_000) } });
      await cache.put(new Request(`${key.url}&revision=${revision}`), stored).catch(() => undefined);
      await cache.put(key, new Response(null, { headers: { "Cache-Control": "public, max-age=20",
        "Cache-Tag": publicationPostCacheTag(target, slug), "x-njpbs-live-blog-expires": String(now() + 20_000),
        "x-njpbs-live-blog-revision": revision } })).catch(() => undefined);
      return response;
    };
    try {
      // Cache API entries share the revision across requests. Response streams
      // and in-flight I/O stay owned by this request in the Workers runtime.
      const response = await read();
      const outgoing = new Headers(response.headers);
      outgoing.delete("x-njpbs-live-blog-expires"); outgoing.delete("Cache-Tag");
      if (response.status === 200) outgoing.set("Cache-Control", FEED_CACHE_CONTROL);
      return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: outgoing });
    } catch { return failure(503); }
  };
}

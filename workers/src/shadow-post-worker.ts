import { CONTENT_LINK_DIRECTORY_MAX_BYTES } from "../../packages/content-core/src/content-link.ts";
import { publicationTarget, publicationPostCacheTag } from "../../functions/lib/publication-target.js";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { isPublicContentSlug, postPublicPath } from "../../site/src/lib/public-content-routes";
import { projectPublishedPostRead, type PublishedPostContent, type PublishedPostReader } from "../../site/src/lib/published-post-shadow";

const CACHE_FRESH_MS = 300_000;
const CACHE_STALE_IF_ERROR_MS = 60_000;

interface ShadowConfig {
  SHADOW_POSTS_ENABLED: string;
  SHADOW_POST_SLUGS: string;
}
interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}
interface RevisionStore {
  get(key: string, options: { type: "json"; cacheTtl: number }): Promise<unknown>;
}
type PostRevision = { kind: "withdrawn" } | { kind: "published"; revision: string; sourceRevision: string };
async function currentRevision(store: RevisionStore | undefined, slug: string): Promise<PostRevision | null> {
  try {
    const record = await store?.get(`post:${slug}`, { type: "json", cacheTtl: 60 });
    if (record === null || typeof record !== "object" || !("schemaVersion" in record) || record.schemaVersion !== 1 || !("kind" in record)) return null;
    if (record.kind === "withdrawn") return { kind: "withdrawn" };
    if (record.kind === "published" && "revision" in record && typeof record.revision === "string" && /^[a-f0-9]{64}$/.test(record.revision) &&
        "sourceRevision" in record && typeof record.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(record.sourceRevision)) {
      return { kind: "published", revision: record.revision, sourceRevision: record.sourceRevision };
    }
  } catch { /* Missing or unreachable KV keeps the existing read-through safety check. */ }
  return null;
}

export interface PostRoutePurger {
  purge(tags: string[]): Promise<void>;
}
export function postCacheTag(slug: string): string {
  postPublicPath(slug);
  return publicationPostCacheTag(publicationTarget("development"), slug);
}

/** Publish follow-up boundary, called after durable acceptance. The caller
 * supplies old and new slugs and retains failed invalidations for retry.
 * No production publisher is wired to this shadow implementation.
 */
export async function purgePublishedPostRoutes(slugs: readonly string[], purger: PostRoutePurger): Promise<void> {
  await purger.purge([...new Set(slugs)].map(postCacheTag));
}
function errorPage(status: number): Response {
  return new Response("<!doctype html><html lang=\"en\"><title>Post unavailable</title><h1>Post unavailable</h1><p>Please try again later.</p></html>", {
    status, headers: { ...SECURITY_HEADER_BASELINE, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" },
  });
}
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

class PublishedPostRefusal extends Error {
  constructor() { super("Published read refused"); }
}

export function createShadowPostWorker(dependencies: {
  reader: PublishedPostReader;
  render(content: PublishedPostContent): Promise<string>;
  rendererSha: string;
  cache: EdgeCache;
  revisions?: RevisionStore;
  now?: () => Date;
}) {
  return {
    async fetch(request: Request, config: ShadowConfig): Promise<Response> {
      const url = new URL(request.url);
      const slug = /^\/posts\/([^/]+)\/$/.exec(url.pathname)?.[1];
      const allowed = config.SHADOW_POST_SLUGS.split(",").map(value => value.trim());
      if (url.origin !== "https://dev-public.example.org" || url.search || config.SHADOW_POSTS_ENABLED !== "true" ||
        !isPublicContentSlug(slug) || !allowed.includes(slug)) return errorPage(404);
      if (request.method !== "GET" && request.method !== "HEAD") return errorPage(405);
      const time = (dependencies.now ?? (() => new Date()))();
      const record = await currentRevision(dependencies.revisions, slug);
      if (record?.kind === "withdrawn") return errorPage(410);
      const revision = record?.revision;
      const expectedSource = record?.sourceRevision;
      const cacheKey = (hash: string) => new Request(`${url.origin}${postPublicPath(slug)}?__shadow_revision=${dependencies.rendererSha}-${hash}`);
      const visitorResponse = (response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
      };
      try {
        const key = revision ? cacheKey(revision) : undefined;
        const cached = key ? await dependencies.cache.match(key) : undefined;
        const freshUntil = Number(cached?.headers.get("X-Njpbs-Cache-Fresh-Until"));
        if (cached && freshUntil > time.getTime()) {
          return visitorResponse(cached);
        }
        let input: unknown;
        try { input = await dependencies.reader.read(slug); }
        catch (error) {
          // Bound an outage when KV still admits an old revision because its
          // withdrawal writer is also unavailable. Failures never extend this window.
          if (cached?.status === 200 && freshUntil + CACHE_STALE_IF_ERROR_MS > time.getTime() &&
              !(error instanceof PublishedPostRefusal)) return visitorResponse(cached);
          throw error;
        }
        const gone = input !== null && typeof input === "object" && "kind" in input && input.kind === "gone";
        const content = gone ? null : projectPublishedPostRead(input, slug, dependencies.rendererSha, time);
        if (!content) {
          const absent = errorPage(gone ? 410 : 404);
          if (key) {
            const marker = new Response(absent.clone().body, { status: absent.status, headers: absent.headers });
            marker.headers.set("Cache-Control", "public, max-age=86400");
            marker.headers.set("Cache-Tag", postCacheTag(slug));
            marker.headers.set("X-Njpbs-Cache-Fresh-Until", String(time.getTime() + CACHE_FRESH_MS));
            await dependencies.cache.put(key, marker);
          }
          return absent;
        }
        // Never put a newer reader result under an older KV revision. During
        // propagation it can be returned, but only its own revision can cache it.
        const sourceRevision = await digest(JSON.stringify(input));
        const hash = await digest(JSON.stringify(content));
        const renderKey = cacheKey(revision && expectedSource === sourceRevision ? revision : `read-${sourceRevision}`);
        let response = revision ? undefined : await dependencies.cache.match(renderKey);
        if (!response) {
          const html = await dependencies.render(content);
          if (!/^\s*<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<\/html>/i.test(html)) throw new Error("Incomplete rendered HTML");
          response = new Response(html, { headers: { ...SECURITY_HEADER_BASELINE,
            "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400",
            "Cache-Tag": postCacheTag(slug), "X-Robots-Tag": "noindex, nofollow, noarchive",
            "X-Njpbs-Source-Version": String(content.target.sourceVersion),
            "X-Njpbs-Renderer-Sha": dependencies.rendererSha, "X-Njpbs-Input-Sha256": hash,
            "X-Njpbs-Cache-Fresh-Until": String(time.getTime() + CACHE_FRESH_MS),
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
          } });
          await dependencies.cache.put(renderKey, response.clone());
        }
        return visitorResponse(response);
      } catch {
        return errorPage(503);
      }
    },
  };
}

/** Authenticated read-only service binding. No generic CMS endpoint or browser SDK. */
export function servicePublishedPostReader(service: { fetch(request: Request): Promise<Response> },
  options: { secret: string; now?: () => Date }): PublishedPostReader {
  return {
    async read(slug) {
      postPublicPath(slug);
      if (typeof options.secret !== "string" || options.secret.length < 32) throw new Error("Unconfigured published reader");
      const path = postPublicPath(slug);
      const timestamp = String((options.now ?? (() => new Date()))().getTime());
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(options.secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key,
        new TextEncoder().encode(`njpbs-post-reader-v1\nGET\n${path}\n${timestamp}`));
      const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
      const response = await service.fetch(new Request(`https://published-posts.internal${path}`, {
        headers: { "x-njpbs-post-timestamp": timestamp, "x-njpbs-post-signature": hex },
        redirect: "manual", signal: AbortSignal.timeout(10_000),
      }));
      if (response.status === 401 || response.status === 403 || response.headers.get("X-Njpbs-Post-Read-Failure") === "refusal") {
        throw new PublishedPostRefusal();
      }
      // A misrouted or missing Function can return a platform 404 or 410. Only the
      // reader's own JSON envelope may map to absent or deleted content.
      if (response.status === 404 || response.status === 410) {
        const kind = response.status === 404 ? "not-found" : "gone";
        const body = response.headers.get("Content-Type")?.includes("application/json")
          ? await response.json().catch(() => null) as { kind?: unknown } | null : null;
        if (body?.kind !== kind) throw new Error("Published read failed");
        return kind === "gone" ? { kind: "gone" } : null;
      }
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) throw new Error("Published read failed");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty published read");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024 + CONTENT_LINK_DIRECTORY_MAX_BYTES) { await reader.cancel(); throw new Error("Published read too large"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  };
}

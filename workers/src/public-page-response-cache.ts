import type { NoBuildPageReply } from "../../cms-api/src/index";
import type { PublicationTarget } from "../../functions/lib/publication-target";
import { publicationPostCacheTag } from "../../functions/lib/publication-target";

const TTL_MS = 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const REVISION_HEADER = "x-njpbs-page-cache-revision";
const EXPIRY_HEADER = "x-njpbs-page-cache-until";
const HOME_FRESH_MS = 10_000;
const HOME_FENCE_HEADER = "x-njpbs-home-cache-fence";
const HOME_FRESH_HEADER = "x-njpbs-home-cache-until";
type HomeFence = { id: string; startedAt: number };

// Transport lifetime is not part of publication identity or the second
// authority comparison. The origin may renew its lease for identical content.
export function pageDecisionIdentity(reply: NoBuildPageReply): string {
  const { decisionCacheUntil: _until, ...decision } = reply;
  return JSON.stringify(decision);
}
async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
export function cacheablePageRequest(request: Request, path: string): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && !url.search && !request.headers.has("authorization") &&
    !request.headers.has("cookie") && !request.headers.has("range") && (path === "/" || /^\/[a-z0-9-]+\/$/.test(path)) &&
    !["/schedule/", "/live/"].includes(path);
}
export function cacheablePageDecision(reply: NoBuildPageReply, now: number): boolean {
  return ["page", "context-page"].includes(reply.kind) &&
    !["schedule", "live"].includes(reply.receipt?.pageId ?? (reply.renderContext as { pageId?: string })?.pageId ?? "") &&
    Number.isSafeInteger(reply.decisionCacheUntil) && reply.decisionCacheUntil! > now && reply.decisionCacheUntil! <= now + TTL_MS;
}

/** Stores completed, validated HTML under the original origin lease. Home can
 * qualify a shorter witnessed lease after recheck; other hits need fresh authority. */
export function createPublicPageResponseCache({ cache, target, rendererSha, now }: {
  cache: Pick<Cache, "match" | "put">; target: PublicationTarget; rendererSha: string; now: () => number;
}) {
  // Cache API bytes survive isolate eviction in the same data center. Keep
  // their discovery key there too, rather than in an isolate-local Map. The
  // stored identity and original lease remain candidates for fresh authority.
  const keyFor = (path: string) => new Request(`${target.origin}/__public-page-response/v3?${
    new URLSearchParams({ renderer: rendererSha, path })}`);
  const tag = publicationPostCacheTag(target, "background");
  const fenceKey = (id: string) => new Request(`${target.origin}/__public-home-response-fence/${rendererSha}/${id}`);
  async function fencePresent(id: string): Promise<boolean> {
    return /^[a-f0-9-]{36}$/.test(id) && (await cache.match(fenceKey(id)))?.status === 200;
  }
  return {
    async beginHome(): Promise<HomeFence | undefined> {
      if (target.environment !== "production") return;
      const fence = { id: crypto.randomUUID(), startedAt: now() };
      // The same global tag purge used by Posts removes this witness even if
      // an older RPC or HTML write completes after the purge.
      await cache.put(fenceKey(fence.id), new Response("1", { headers: {
        "Cache-Tag": tag, "cache-control": "public, max-age=20",
      } }));
      return fence;
    },
    async freshHome(candidate: { homeFence: string; homeFreshUntil: number; expiresAt: number }): Promise<boolean> {
      if (!candidate.homeFence || candidate.homeFreshUntil <= now() || candidate.homeFreshUntil > now() + HOME_FRESH_MS ||
          candidate.expiresAt <= now()) return false;
      return await fencePresent(candidate.homeFence) && candidate.homeFreshUntil > now() && candidate.expiresAt > now();
    },
    async qualifyHome(reply: NoBuildPageReply, fence: HomeFence): Promise<void> {
      const freshUntil = Math.min(fence.startedAt + HOME_FRESH_MS, reply.decisionCacheUntil ?? 0);
      if (freshUntil <= now() || !await fencePresent(fence.id)) return;
      const response = await cache.match(keyFor("/"));
      if (!response || response.headers.get(REVISION_HEADER) !== await digest(pageDecisionIdentity(reply))) return;
      const headers = new Headers(response.headers);
      headers.set(HOME_FENCE_HEADER, fence.id);
      headers.set(HOME_FRESH_HEADER, String(freshUntil));
      headers.set("Cache-Tag", tag);
      // A purge during this write removes the witness. A late put cannot
      // recreate it, and the resulting response is never a fresh hit.
      await cache.put(keyFor("/"), new Response(response.body, { headers }));
    },
    async read(path: string) {
      try {
        if (target.environment !== "production") return;
        const response = await cache.match(keyFor(path));
        if (response?.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html") ||
            !["cms-page-no-build", "cms-page-context"].includes(response.headers.get("x-njpbs-content-source") ?? "")) return;
        const revision = response.headers.get(REVISION_HEADER) ?? "";
        const expiresAt = Number(response.headers.get(EXPIRY_HEADER));
        if (!/^[a-f0-9]{64}$/.test(revision) || !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now() || expiresAt > now() + TTL_MS) return;
        const body = await response.text();
        if (new TextEncoder().encode(body).length > MAX_BYTES || !/^\s*<!doctype html>/i.test(body) || !/<\/html>/i.test(body) ||
            await digest(body) !== response.headers.get("x-njpbs-html-sha256")) return;
        const headers = new Headers(response.headers);
        const homeFence = headers.get(HOME_FENCE_HEADER) ?? "";
        const homeFreshUntil = Number(headers.get(HOME_FRESH_HEADER));
        headers.delete(REVISION_HEADER);
        headers.delete(EXPIRY_HEADER);
        headers.delete(HOME_FENCE_HEADER);
        headers.delete(HOME_FRESH_HEADER);
        headers.delete("Cache-Tag");
        headers.set("cache-control", "no-store");
        headers.set("x-njpbs-page-cache", "hit");
        return { revision, expiresAt, homeFence, homeFreshUntil,
          response: new Response(body, { status: 200, headers }) };
      } catch { return; }
    },
    async matches(candidate: { revision: string; expiresAt: number }, reply: NoBuildPageReply) {
      if (candidate.expiresAt <= now() || !cacheablePageDecision(reply, now())) return false;
      const same = candidate.revision === await digest(pageDecisionIdentity(reply));
      return same && candidate.expiresAt > now() && cacheablePageDecision(reply, now());
    },
    async store(path: string, reply: NoBuildPageReply, response: Response): Promise<Response> {
      if (target.environment !== "production" || !cacheablePageDecision(reply, now()) || response.status !== 200 ||
          !response.headers.get("content-type")?.startsWith("text/html")) return response;
      const headers = new Headers(response.headers);
      headers.set("x-njpbs-page-cache", "miss");
      const result = new Response(response.body, { status: response.status, headers });
      try {
        const revision = await digest(pageDecisionIdentity(reply));
        if (!cacheablePageDecision(reply, now())) return result;
        const stored = result.clone();
        const cacheHeaders = new Headers(stored.headers);
        // A renewed origin lease never extends an existing candidate. These
        // metadata describe only this completed render's original lifetime.
        cacheHeaders.set(REVISION_HEADER, revision);
        cacheHeaders.set(EXPIRY_HEADER, String(reply.decisionCacheUntil));
        cacheHeaders.set("cache-control", "public, max-age=60");
        await cache.put(keyFor(path), new Response(stored.body, { headers: cacheHeaders }));
      } catch { /* A failed cache write cannot change a validated public reply. */ }
      return result;
    },
  };
}

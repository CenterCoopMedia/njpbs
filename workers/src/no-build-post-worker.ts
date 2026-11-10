import { contentLinkRedirect } from "../../packages/content-core/src/content-link.ts";
import { publicPostReceiptIdentity } from "../../packages/content-core/src/public-post-receipt-identity";
import { publicRecordFamily } from "./durable-record-withdrawals";
import type { NoBuildPostReply } from "../../cms-api/src/index";
import { assertPublicationTarget, publicationTarget, publicationPostCacheTag, type PublicationTarget } from "../../functions/lib/publication-target.js";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { isPublicContentSlug, postPublicPath } from "../../site/src/lib/public-content-routes";
import { projectPublishedPostRead, type PublishedPostContent, type PublishedPostReader } from "../../site/src/lib/published-post-shadow";

export interface NoBuildPostConfig {
  enabled?: boolean;
  /** Retain owned routes when disabling. Removal requires a verified static rollback. */
  allowlist?: readonly { documentId: string; slug: string }[];
}

export const NO_BUILD_POST_DEFAULTS: Readonly<NoBuildPostConfig> = Object.freeze({
  enabled: false,
  allowlist: Object.freeze([]),
});

function unavailable(status: number, head: boolean): Response {
  return new Response(head ? null : "Post unavailable", { status, headers: {
    ...SECURITY_HEADER_BASELINE, "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
    ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
  } });
}

/** Public serving factory. The production entry delegates admission and retained
 * route decisions to the authoritative private reader; deployment stays separate.
 * Unlike the dev KV pilot, every request requires an authoritative published read.
 * The caller must verify the one Post has no Home placement before admission.
 * Response headers describe this render, not aggregate/Admin publication receipts.
 */
export function createNoBuildPostWorker(dependencies: {
  target?: PublicationTarget;
  reader?: PublishedPostReader;
  render(content: PublishedPostContent): Promise<string>;
  rendererSha: string;
  cache: Pick<Cache, "match" | "put">;
  now?: () => Date;
  getDecision?(path: string, method: string, probe?: { buildBatchId: string; versionId: string }): Promise<NoBuildPostReply>;
  fetchAsset?(request: Request): Promise<Response>;
}, config: NoBuildPostConfig = NO_BUILD_POST_DEFAULTS) {
  if (!/^[a-f0-9]{40}$/.test(dependencies.rendererSha)) {
    throw new Error("Invalid no-build renderer release");
  }
  const target = assertPublicationTarget(dependencies.target ?? publicationTarget("production"));
  const allowlist = config.allowlist ?? [];
  if (allowlist.length > 1 || allowlist.some(post => !isPublicContentSlug(post.slug) ||
      typeof post.documentId !== "string" || !post.documentId.trim())) {
    throw new Error("No-build admission requires one exact Post");
  }
  // Caller mutation cannot expand admission or release route ownership.
  const post = allowlist[0] && { ...allowlist[0] };
  const enabled = config.enabled === true;
  return {
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.origin !== target.origin) return null;
      if (dependencies.getDecision && dependencies.fetchAsset) {
        return serveAuthoritativePost(request, { ...dependencies, target } as AuthoritativeDependencies);
      }
      if (!post) return null;
      let path: string;
      try { path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, "/"); } catch { return null; }
      const slug = /^\/posts\/([^/]+)(?:\/(?:index\.html\/?)?)?$/.exec(path)?.[1];
      if (slug !== post.slug) return null;
      const head = request.method === "HEAD";
      if (!enabled) return unavailable(503, head);
      if (request.method !== "GET" && !head) return unavailable(405, false);
      try {
        const input = await dependencies.reader?.read(slug);
        if (input !== null && typeof input === "object" && "kind" in input && input.kind === "gone") {
          return unavailable(410, head);
        }
        const content = projectPublishedPostRead(input, slug, dependencies.rendererSha,
          (dependencies.now ?? (() => new Date()))());
        if (!content) return unavailable(404, head);
        if (content.target.documentId !== post.documentId) return unavailable(503, head);
        const redirect = contentLinkRedirect(content.posts[0]);
        if (redirect) return redirect;
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
        const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
        const key = new Request(`${target.origin}${postPublicPath(slug)}?__no_build=${dependencies.rendererSha}-${digest}`);
        // Cache is only a render optimization, never an admission/visibility source.
        let cached = await dependencies.cache.match(key).catch(() => undefined);
        if (!cached) {
          const html = await dependencies.render(content);
          if (!/^\s*<!doctype html>/i.test(html) || !/<html\b/i.test(html) || !/<\/html>/i.test(html)) {
            throw new Error("Incomplete rendered HTML");
          }
          cached = new Response(html, { headers: {
            ...SECURITY_HEADER_BASELINE, "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=86400", "X-Njpbs-Content-Source": "cms-no-build",
            "X-Njpbs-Source-Version": String(content.target.sourceVersion),
            "X-Njpbs-Renderer-Sha": dependencies.rendererSha, "X-Njpbs-Input-Sha256": digest,
            ...(content.posts[0].noindex ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
          } });
          await dependencies.cache.put(key, cached.clone()).catch(() => undefined);
        }
        const headers = new Headers(cached.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(head ? null : cached.body, { status: cached.status, headers });
      } catch {
        return unavailable(503, head);
      }
    },
  };
}


type AuthoritativeDependencies = {
  target: PublicationTarget;
  rendererSha: string;
  cache: Pick<Cache, "match" | "put">;
  render(content: PublishedPostContent): Promise<string>;
  getDecision(path: string, method: string, probe?: { buildBatchId: string; versionId: string }): Promise<NoBuildPostReply>;
  fetchAsset(request: Request): Promise<Response>;
};

async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function serveRenderedPost(request: Request, path: string, reply: NoBuildPostReply,
  content: PublishedPostContent, dependencies: AuthoritativeDependencies, head: boolean): Promise<Response> {
  const redirect = contentLinkRedirect(content.posts[0], receiptHeaders(reply, dependencies.target));
  if (redirect) {
    const current = await dependencies.getDecision(path, head ? "HEAD" : "GET");
    const currentContent = current.kind === "post" && projectPublishedPostRead(current.published, current.receipt!.slug, dependencies.rendererSha, new Date());
    if (!currentContent || JSON.stringify(current.receipt) !== JSON.stringify(reply.receipt) || JSON.stringify(currentContent) !== JSON.stringify(content)) throw new Error("Public context changed");
    return redirect;
  }
  const inputDigest = await sha256(JSON.stringify(content));
  const identity = await sha256(JSON.stringify([reply.receipt, inputDigest]));
  const key = new Request(`${dependencies.target.origin}${postPublicPath(reply.receipt!.slug)}?__no_build=v1-${identity}`);
  // A private or preview request can use the public reader, but never the cache.
  const cacheable = !request.headers.has("authorization") && !request.headers.has("cookie") &&
    !new URL(request.url).search;
  let cached = cacheable ? await dependencies.cache.match(key).catch(() => undefined) : undefined;
  const hit = Boolean(cached);
  if (!cached) {
    const html = await dependencies.render(content);
    if (!/^\s*<!doctype html>/i.test(html) || !/<\/html>/i.test(html)) throw new Error("Incomplete Post render");
    if (new TextEncoder().encode(html).length > 2 * 1024 * 1024) throw new Error("Post render exceeds its bound");
    const headers = receiptHeaders(reply, dependencies.target);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("x-njpbs-input-sha256", inputDigest);
    headers.set("x-njpbs-html-sha256", await sha256(html));
    headers.set("Cache-Control", "public, max-age=86400");
    headers.set("Cache-Tag", publicationPostCacheTag(dependencies.target, reply.receipt!.slug));
    cached = new Response(html, { headers });
  }
  if (cacheable && !hit) await dependencies.cache.put(key, cached.clone()).catch(() => undefined);
  // Both HIT and MISS must pass the same fresh authority check. A late fill can
  // only write its obsolete identity; it cannot select bytes for a newer version.
  const current = await dependencies.getDecision(path, head ? "HEAD" : "GET");
  const currentContent = current.kind === "post" && projectPublishedPostRead(
    current.published, current.receipt!.slug, dependencies.rendererSha, new Date());
  if (!currentContent || JSON.stringify(current.receipt) !== JSON.stringify(reply.receipt) ||
      await sha256(JSON.stringify(currentContent)) !== inputDigest) throw new Error("Public context changed");
  const headers = new Headers(cached.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("Cache-Tag");
  headers.set("X-Njpbs-Render-Cache", cacheable ? (hit ? "HIT" : "MISS") : "BYPASS");
  return new Response(head ? null : cached.body, { headers });
}

function receiptHeaders(reply: NoBuildPostReply, target: PublicationTarget): Headers {
  const receipt = reply.receipt;
  const snapshotDigest = receipt?.snapshotDigest;
  const datasetFiguresDigest = receipt?.datasetFiguresDigest;
  if (!receipt || receipt.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(receipt.rendererSha) ||
      !/^[A-Za-z0-9]{20}$/.test(receipt.operationId) || !Number.isSafeInteger(receipt.sourceVersion) ||
      !Number.isSafeInteger(receipt.generation) || !Array.isArray(receipt.ownedSlugs) ||
      !/^[a-f0-9]{64}$/.test(receipt.contextDigest) ||
      snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
      datasetFiguresDigest !== undefined &&
        (!/^[a-f0-9]{64}$/.test(datasetFiguresDigest) || !/^[a-f0-9]{64}$/.test(snapshotDigest ?? ""))) {
    throw new Error("Invalid Post receipt");
  }
  const revision = receipt.admissionRevision;
  const legacyStatic = receipt.mode === "static" && ["static", "alias", "gone"].includes(reply.kind) && revision === undefined;
  if (!legacyStatic && !(Number.isSafeInteger(revision) && revision! > 0) &&
      !(reply.kind === "gone" && revision === null)) throw new Error("Invalid admission receipt");
  if (!["static", "alias", "gone"].includes(reply.kind) && receipt.mode === "static") throw new Error("Invalid static receipt");
  return new Headers({ ...SECURITY_HEADER_BASELINE, "Cache-Control": "no-store",
    "X-Njpbs-Content-Source": receipt.mode === "static" ? "cms-static-return" : "cms-no-build", "X-Njpbs-Source-Version": String(receipt.sourceVersion),
    "X-Njpbs-Renderer-Sha": receipt.rendererSha, "X-Njpbs-Publication-Operation": receipt.operationId,
    "X-Njpbs-Context-Sha256": receipt.contextDigest, "Access-Control-Allow-Origin": target.environment === "development" ? "https://dev-admin.example.org" : "https://admin.njpbs.org",
    ...(snapshotDigest ? { "X-Njpbs-Snapshot-Sha256": snapshotDigest } : {}),
    ...(datasetFiguresDigest ? { "X-Njpbs-Dataset-Figures-Sha256": datasetFiguresDigest } : {}),
    ...(!legacyStatic ? { "X-Njpbs-Admission-Revision": revision === null ? "unavailable" : String(revision) } : {}),
    "Access-Control-Expose-Headers": "x-njpbs-content-source, x-njpbs-source-version, x-njpbs-renderer-sha, x-njpbs-publication-operation, x-njpbs-context-sha256, x-njpbs-snapshot-sha256, x-njpbs-dataset-figures-sha256, x-njpbs-input-sha256, x-njpbs-html-sha256, x-njpbs-admission-revision",
  });
}

async function serveStaticPost(path: string, reply: NoBuildPostReply,
  dependencies: AuthoritativeDependencies, head: boolean): Promise<Response> {
  const headers = receiptHeaders(reply, dependencies.target);
  if (path === postPublicPath(reply.receipt!.slug) && reply.receipt?.contentRedirectUrl) {
    const redirect = contentLinkRedirect({ contentLinkMode: "custom", contentLinkUrl: reply.receipt.contentRedirectUrl }, headers)!;
    const current = await dependencies.getDecision(path, head ? "HEAD" : "GET");
    if (current.kind !== "static" || JSON.stringify(current.receipt) !== JSON.stringify(reply.receipt)) throw new Error("Static Post authority changed");
    return redirect;
  }
  const file = reply.staticFile;
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  if (file) {
    if (!file.path.startsWith("/") || file.path.length > 256 || /[%?#\\\s]/.test(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 16 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(file.digest)) throw new Error("Invalid static Post file");
    const asset = await dependencies.fetchAsset(new Request(`${dependencies.target.origin}${file.path}`, {
      redirect: "manual", headers: { "cache-control": "no-cache" },
    }));
    if (asset.status !== 200 || !asset.body) throw new Error("Static Post file is unavailable");
    const reader = asset.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > file.bytes) throw new Error("Static Post file exceeds its receipt");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    if (size !== file.bytes) throw new Error("Static Post file size changed");
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== file.digest) throw new Error("Static Post file changed");
    const contentType = asset.headers.get("content-type");
    if (!contentType || contentType.length > 128) throw new Error("Static Post file has no content type");
    headers.set("Content-Type", contentType);
    headers.set("x-njpbs-html-sha256", digest);
    if (["/_publication.json", "/_content-status.json"].includes(path)) headers.set("x-njpbs-publication-origin", dependencies.target.workerName);
  }
  const current = await dependencies.getDecision(path, head ? "HEAD" : "GET");
  if (current.kind === "gone") return new Response(null, { status: 410, headers: receiptHeaders(current, dependencies.target) });
  if (current.kind !== "static" || JSON.stringify(current) !== JSON.stringify(reply)) throw new Error("Static Post context changed");
  return new Response(head ? null : bytes, { status: file ? 200 : 404, headers });
}

async function servePostReceipts(path: string, reply: NoBuildPostReply, headers: Headers,
  dependencies: AuthoritativeDependencies, head: boolean): Promise<Response> {
  const baselineRequest = new Request(`${dependencies.target.origin}${path}`, { headers: { "cache-control": "no-cache" } });
  const asset = await dependencies.fetchAsset(baselineRequest);
  if (!asset.ok) throw new Error("Public baseline receipt is unavailable");
  const baseline = await asset.json() as Record<string, unknown>;
  if (baseline.schemaVersion !== 1 || !Number.isSafeInteger(baseline.generation) ||
      baseline.commitSha !== dependencies.rendererSha) throw new Error("Public receipt baseline changed");
  const catalog = reply.catalog;
  const posts = catalog?.posts ?? [reply.receipt!];
  const receipt = catalog ?? reply.receipt!;
  const slugs = new Set<string>();
  const postIds = new Set<string>();
  for (const post of posts) {
    receiptHeaders({ kind: post.mode === "static" ? "static" : "receipts", receipt: post }, dependencies.target);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(post.postId) || !isPublicContentSlug(post.slug) ||
        !post.ownedSlugs.includes(post.slug) || postIds.has(post.postId) ||
        post.ownedSlugs.some(slug => !isPublicContentSlug(slug) || slugs.has(slug))) throw new Error("Invalid Post catalog");
    postIds.add(post.postId);
    for (const slug of post.ownedSlugs) slugs.add(slug);
  }
  const orderedPosts = [...posts].sort((left, right) => left.postId.localeCompare(right.postId));
  // An ordinary same-source release can change carried routes. Include its
  // baseline identity as well as the complete current public context.
  const identity = await publicPostReceiptIdentity({ posts: orderedPosts,
    workerName: dependencies.target.workerName, rendererSha: dependencies.rendererSha,
    contextDigest: receipt.contextDigest, admissionRevision: receipt.admissionRevision, generation: receipt.generation,
    baseline: { buildBatchId: baseline.buildBatchId, generation: baseline.generation } });
  let body: unknown = identity;
  if (path === "/_content-status.json") {
    if (!Array.isArray(baseline.routes) || baseline.routes.length > 10_000) throw new Error("Invalid public inventory");
    const owned = await Promise.all(orderedPosts.map(async post => ({ post,
      contentKey: await sha256(`cmsPosts/${post.postId}`) })));
    const keys = new Set(owned.map(value => value.contentKey));
    const routes = baseline.routes.filter((route: { path?: string; contentKey?: string }) =>
      !keys.has(route.contentKey ?? "") && ![...slugs].some(slug => route.path === postPublicPath(slug)));
    for (const { post, contentKey } of owned) {
      if (post.visible) routes.push({ path: postPublicPath(post.slug), source: "cms", contentKey, sourceVersion: post.sourceVersion });
    }
    if (routes.length > 10_000 || new Set(routes.map((route: { path?: string }) => route.path)).size !== routes.length) throw new Error("Invalid public inventory");
    body = { ...identity, collections: ["cmsPages", "cmsPosts"], routes };
  }
  const current = await dependencies.getDecision(path, head ? "HEAD" : "GET");
  if (current.kind !== "receipts" || JSON.stringify([current.catalog, current.receipt]) !== JSON.stringify([reply.catalog, reply.receipt])) throw new Error("Public context changed");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("x-njpbs-publication-origin", dependencies.target.workerName);
  return new Response(head ? null : JSON.stringify(body), { headers });
}

function catalogHeaders(reply: NoBuildPostReply, dependencies: AuthoritativeDependencies): Headers {
  const catalog = reply.catalog;
  if (!catalog || catalog.schemaVersion !== 1 || catalog.rendererSha !== dependencies.rendererSha ||
      !Number.isSafeInteger(catalog.generation) || catalog.generation < 1 ||
      !/^[a-f0-9]{64}$/.test(catalog.contextDigest) || !Number.isSafeInteger(catalog.admissionRevision) ||
      catalog.admissionRevision < 1 || !Array.isArray(catalog.posts) || !catalog.posts.length) throw new Error("Invalid Post catalog receipt");
  return new Headers({ ...SECURITY_HEADER_BASELINE, "Cache-Control": "no-store",
    "X-Njpbs-Content-Source": "cms-no-build", "X-Njpbs-Renderer-Sha": catalog.rendererSha,
    "X-Njpbs-Context-Sha256": catalog.contextDigest, "X-Njpbs-Admission-Revision": String(catalog.admissionRevision),
    "Access-Control-Allow-Origin": dependencies.target.environment === "development" ? "https://dev-admin.example.org" : "https://admin.njpbs.org" });
}

function isBackgroundPath(path: string): boolean {
  return path === "/" || path === "/_home-sources.json" || /^\/posts\/?$/.test(path) || /^\/posts\/page(?:\/|$)/.test(path) ||
    /^\/authors(?:\/|$)/.test(path) || path === "/feeds/news.xml" ||
    path === "/api/v1/content.json" || /^\/api\/v1\/content(?:\/|$)/.test(path) ||
    /^\/sitemap(?:-index|-\d+)?\.xml$/.test(path) || /^\/pagefind(?:\/|$)/.test(path) ||
    path === "/search/meaning-index.json" || publicRecordFamily(path) !== null;
}

function backgroundReleaseAccepted(headers: Headers, rendererSha: string): boolean {
  const receiptRelease = headers.get("x-njpbs-background-renderer-sha") ?? "";
  return /^[a-f0-9]{40}$/.test(receiptRelease) &&
    (receiptRelease === rendererSha || headers.get("x-njpbs-background-assets") === "verified");
}
function isHomePath(path: string): boolean { return path === "/" || path === "/_home-sources.json"; }
export function isIndependentPostBackgroundPath(path: string): boolean {
  return isBackgroundPath(path) && !isHomePath(path) || path.startsWith("/_astro/");
}

async function serveBackground(request: Request, path: string, dependencies: AuthoritativeDependencies): Promise<Response | null> {
  const started = Date.now();
  const url = new URL(request.url);
  // Home decisions and immutable bytes are public. Consent cookies and referral
  // parameters do not change them; explicit staff reads still bypass the cache.
  const cacheable = !request.headers.has("authorization") && (isHomePath(path)
    ? !url.searchParams.has("cms-context")
    : !request.headers.has("cookie") && !url.search);
  const key = new Request(`${dependencies.target.origin}${path}?__background=${dependencies.rendererSha}`);
  const cached = cacheable ? await dependencies.cache.match(key).catch(() => undefined) : undefined;
  const deadline = Number(cached?.headers.get("x-njpbs-edge-expires-at"));
  if (cached && backgroundReleaseAccepted(cached.headers, dependencies.rendererSha) && deadline > Date.now()) return backgroundResponse(cached, request.method === "HEAD", "HIT");
  // A HEAD miss fetches the complete public object so GET and HEAD share one entry.
  let reply: NoBuildPostReply;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = dependencies.getDecision(path, "GET");
    reply = await (isHomePath(path) ? Promise.race([decision, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Home decision timed out")), 1_500);
    })]) : decision);
  }
  catch (error) {
    if (!isHomePath(path)) throw error;
    return null;
  }
  finally { if (timer !== undefined) clearTimeout(timer); }
  // Keep the static Home outage copy, without caching a pass that can bypass
  // subsequently available removal authority.
  if (reply.kind === "pass" || isHomePath(path) && reply.kind === "background" && reply.status === 503) return null;
  if (reply.kind === "static") return serveStaticPost(path, reply, dependencies, request.method === "HEAD");
  if (reply.kind !== "background" || ![200, 404, 405, 410, 503].includes(reply.status!) ||
      typeof reply.bytes !== "string" || reply.bytes.length > 24 * 1024 * 1024) throw new Error("Invalid background reply");
  const contextRevision = reply.headers?.["x-njpbs-public-context-revision"];
  const revision = contextRevision ?? reply.headers?.["x-njpbs-admission-revision"];
  if (reply.status !== 503 && (!revision || !/^[1-9]\d*$/.test(revision) ||
      !Number.isSafeInteger(Number(revision)))) throw new Error("Invalid background authority receipt");
  if (reply.status !== 503 && contextRevision !== undefined &&
      !/^[a-f0-9]{64}$/.test(reply.headers?.["x-njpbs-background-context-sha256"] ?? "")) {
    throw new Error("Invalid background context receipt");
  }
  const headers = new Headers(SECURITY_HEADER_BASELINE);
  for (const [name, value] of Object.entries(reply.headers ?? {})) headers.set(name, value);
  if (reply.status === 200 && !backgroundReleaseAccepted(headers, dependencies.rendererSha)) {
    throw new Error("Background release is unknown");
  }
  // Set one case-insensitive Cache-Control value.
  headers.set("Cache-Control", "no-store");
  const bytes = Uint8Array.from(atob(reply.bytes), character => character.charCodeAt(0));
  if (reply.status === 200 && /^\/(programs|shows|events)\/[^/]+\/$/.test(path) &&
      headers.get("x-njpbs-record-visible") === "true" && headers.get("content-type") === "text/html; charset=utf-8") {
    headers.set("x-njpbs-html-sha256", await sha256(bytes));
  }
  const response = new Response(bytes, { status: reply.status, headers });
  const staleDeadline = headers.has("x-njpbs-background-expires-at") ? Number(headers.get("x-njpbs-background-expires-at")) : Infinity;
  const expiresAt = Math.min(started + 15_000, staleDeadline);
  if (staleDeadline <= Date.now() || Number.isNaN(staleDeadline)) throw new Error("Background reply expired");
  const tag = headers.get("x-njpbs-background-purge-tag");
  if (cacheable && reply.status === 200 && expiresAt > Date.now() && tag === publicationPostCacheTag(dependencies.target, "background")) {
    const stored = new Response(response.clone().body, response);
    stored.headers.set("Cache-Control", `public, max-age=${Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))}`);
    stored.headers.set("Cache-Tag", tag!);
    stored.headers.set("x-njpbs-edge-expires-at", String(expiresAt));
    await dependencies.cache.put(key, stored).catch(() => undefined);
  }
  if (reply.status === 200 && expiresAt <= Date.now()) throw new Error("Background reply expired");
  return backgroundResponse(response, request.method === "HEAD", cacheable ? "MISS" : "BYPASS");
}

function backgroundResponse(response: Response, head: boolean, cache: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Njpbs-Background-Cache", cache);
  headers.set("Access-Control-Allow-Origin", "https://admin.njpbs.org");
  headers.set("Access-Control-Expose-Headers", "x-njpbs-admission-revision, x-njpbs-background-state, x-njpbs-background-renderer-sha, x-njpbs-background-context-sha256, x-njpbs-background-revision");
  if (headers.has("x-njpbs-record-id")) headers.append("Access-Control-Expose-Headers",
    "x-njpbs-record-id, x-njpbs-record-family, x-njpbs-record-generation, x-njpbs-record-visible, x-njpbs-publication-operation, x-njpbs-source-version, x-njpbs-snapshot-sha256");
  if (headers.has("x-njpbs-public-context-revision")) {
    headers.append("Access-Control-Expose-Headers", "x-njpbs-public-context-revision");
  }
  headers.delete("Cache-Tag");
  headers.delete("x-njpbs-edge-expires-at");
  headers.delete("x-njpbs-background-purge-tag");
  return new Response(head ? null : response.body, { status: response.status, headers });
}

async function serveAuthoritativePost(request: Request, dependencies: AuthoritativeDependencies): Promise<Response | null> {
  const url = new URL(request.url);

  const head = request.method === "HEAD";
  try {
    let path = url.pathname;
    for (let i = 0; i < 32 && /%[a-f0-9]{2}/i.test(path); i++) path = decodeURIComponent(path);
    // Remaining encoded layers make ownership unknown; never try older Assets.
    if (/%[a-f0-9]{2}/i.test(path)) throw new Error("Public path encoding exceeds its bound");
    if (!/^\/(?:$|index\.html\/?$|posts(?:\/|$)|authors(?:\/|$)|programs(?:\/|$)|shows(?:\/|$)|events(?:\/|$)|feeds\/|api\/v1\/|sitemap|pagefind\/|search\/|_astro\/|_home-sources\.json$|_publication\.json$|_content-status\.json$)/.test(path)) return null;
    if (/%|\\|\/\//.test(path)) throw new Error("Invalid public path");
    if (path.startsWith("/posts/_no-build-assets/")) return null;
    if (!head && request.method !== "GET") return unavailable(405, false);
    if (path === "/_publication.json" && url.searchParams.get("cms-context") === "code") return null;
    path = path.replace(/\/index\.html\/?$/, "/");
    if (/^\/posts\/[^/]+$/.test(path) || /^\/(programs|shows|events)(?:\/[^/]+)?$/.test(path)) path += "/";
    const probe = url.pathname === "/_publication.json" && (url.searchParams.has("candidate") || url.searchParams.has("version"))
      ? { buildBatchId: url.searchParams.get("candidate") ?? "", versionId: url.searchParams.get("version") ?? "" } : undefined;
    if (path.startsWith("/_astro/")) {
      const asset = await dependencies.fetchAsset(request);
      if (asset.status !== 404) return asset;
      return await serveBackground(request, path, dependencies) ?? asset;
    }
    if (isBackgroundPath(path)) {
      return await serveBackground(request, path, dependencies);
    }
    const reply = await dependencies.getDecision(path, head ? "HEAD" : "GET", probe);
    if (reply.kind === "pass" || reply.kind === "baseline-probe") return null;
    if (reply.kind === "static") return await serveStaticPost(path, reply, dependencies, head);
    if (reply.kind === "receipts" && reply.catalog) {
      return await servePostReceipts(path, reply, catalogHeaders(reply, dependencies), dependencies, head);
    }
    const headers = receiptHeaders(reply, dependencies.target);
    if (reply.receipt!.rendererSha !== dependencies.rendererSha) throw new Error("Renderer changed");
    if (reply.kind === "gone") { headers.set("X-Robots-Tag", "noindex, nofollow"); return new Response(null, { status: 410, headers }); }
    if (reply.kind === "alias") {
      if (reply.location !== postPublicPath(reply.receipt!.slug)) throw new Error("Invalid Post alias");
      headers.set("Location", reply.location);
      return new Response(null, { status: 308, headers });
    }
    if (reply.kind === "receipts") return await servePostReceipts(path, reply, headers, dependencies, head);
    if (reply.kind !== "post") throw new Error("Invalid Post reply");
    const content = projectPublishedPostRead(reply.published, reply.receipt!.slug, dependencies.rendererSha, new Date());
    if (!content || content.target.documentId !== reply.receipt!.postId ||
        content.target.sourceVersion !== reply.receipt!.sourceVersion) throw new Error("Post source changed");
    return await serveRenderedPost(request, path, reply, content, dependencies, head);
  } catch { return unavailable(503, head); }
}

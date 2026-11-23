import { publicRecordFamily, type RecordRouteAuthority, type RecordWithdrawal } from "./durable-record-withdrawals";
import { createLiveBlogFeedReader } from "./live-blog-feed";
import type { NoBuildPostReply } from "../../cms-api/src/index";
import { createNoBuildPostWorker, isIndependentPostBackgroundPath } from "./no-build-post-worker";
import { assertPublicationTarget, publicationTarget, publicationPostCacheTag, type PublicationTarget } from "../../functions/lib/publication-target.js";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { isVideoCatalogPath } from "../../packages/content-core/src/video-catalog-path";
import { PUBLIC_GONE_BRANCH_HEADER } from "./public-gone";
import { useAssetsForUnavailablePost } from "../../functions/lib/transitional-post-fallback.js";
import { isPostRouteSlug, postSlugForPath } from "../../site/src/lib/public-content-routes";
import type { PublishedPostContent } from "../../site/src/lib/published-post-shadow";
import { WITHDRAWAL_UNKNOWN_HEADER, type Withdrawal } from "./durable-post-withdrawals";
import { isVerifiedLastGoodResponse, readAssetCodeGeneration, reportLastGoodRetentionFailure, type PublicContentLastGood } from "./public-content-last-good";

const TTL_MS = 10_000;
const STALE_MS = 30_000;
const FAILURE_TTL_MS = 1_000;
const AUTHORITY_TIMEOUT_MS = 3_000;
const DTO_BYTES_MAX = 2 * 1024 * 1024;
// One background file may contain 16 MiB of raw bytes. Its base64 response and
// bounded receipt envelope have a separate limit from Post/catalog decisions.
const BACKGROUND_DTO_BYTES_MAX = Math.ceil(16 * 1024 * 1024 / 3) * 4 + 64 * 1024;
type Refresh = { task: Promise<Entry>; purgeFence?: string; readOrder?: number };
const WITHDRAWAL_AUTHORITY_TTL_MS = 60_000;
type WithdrawalAuthority = { schemaVersion: 1; expiresAt: number; purgeFence?: string; reply?: NoBuildPostReply; retry?: true };
type WithdrawalRefresh = { task: Promise<WithdrawalAuthority>; readOrder?: number };
const authorityScope = () => ({
  refreshes: new Map<string, Refresh>(), withdrawalRefreshes: new Map<string, WithdrawalRefresh>(), order: 0,
});
const sharedAuthority = authorityScope();
const scopedAuthority = new WeakMap<object, typeof sharedAuthority>();

type Entry = ({ schemaVersion: 1; expiresAt: number; staleUntil: number; retryAt?: number; catalogId: string;
  state: "ready"; reply: NoBuildPostReply } | {
  schemaVersion: 1; expiresAt: number; catalogId: string; state: "unavailable";
}) & { purgeFence?: string };
type Dependencies = {
  target?: PublicationTarget;
  rendererSha: string;
  rendererReady?: boolean;
  recordRendererReady?: boolean;
  readRecordAuthority?(path: string): Promise<RecordRouteAuthority | null>;
  cache: Pick<Cache, "match" | "put">;
  /** A proof request's cache namespace must also isolate its in-flight reads. */
  authorityScope?: object;
  getDecision(path: string, method: string, probe?: { buildBatchId: string; versionId: string }): Promise<NoBuildPostReply>;
  fetchAsset(request: Request): Promise<Response>;
  render(content: PublishedPostContent): Promise<string>;
  waitUntil(task: Promise<unknown>): void;
  now?: () => number;
  readWithdrawal?: (slug: string) => Promise<Withdrawal | null>;
  readCodePost?: (request: Request) => Promise<Response | null>;
  lastGood?: PublicContentLastGood;
};

function publicPath(path: string): string | null {
  for (let index = 0; index < 32 && /%[a-f0-9]{2}/i.test(path); index++) path = decodeURIComponent(path);
  if (/%|\\|\/\//.test(path) || path.length > 512) throw new Error("Invalid public path");
  if (path.startsWith("/posts/_no-build-assets/")) return null;
  path = path.replace(/\/index\.html\/?$/, "/");
  if (/^\/(?:es\/)?posts\/[^/]+$/.test(path) || /^\/(programs|shows|events)(?:\/[^/]+)?$/.test(path) ||
      isVideoCatalogPath(path) && !path.endsWith("/")) path += "/";
  if (!isIndependentPostBackgroundPath(path) && !["/", "/_home-sources.json", "/_publication.json", "/_content-status.json"].includes(path) &&
      !postSlugForPath(path)) return null;
  return path;
}

async function timed<T>(task: Promise<T>, timeoutMs = AUTHORITY_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Public authority unavailable")), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Missing cached public authority");
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) throw new Error("Cached public authority exceeds its bound");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validReply(value: unknown): value is NoBuildPostReply {
  return object(value) && ["pass", "post", "alias", "gone", "receipts", "partial-receipts", "background", "static"].includes(String(value.kind));
}
function catalogPosts(reply: NoBuildPostReply) {
  if (reply.kind === "pass") return [];
  if (!["receipts", "partial-receipts", "static"].includes(reply.kind)) throw new Error("Invalid public catalog");
  const posts = reply.catalog?.posts ?? (reply.receipt ? [reply.receipt] : null);
  const refused = reply.catalog?.refusedPosts;
  if (!Array.isArray(posts) || posts.some(post => !post || !isPostRouteSlug(post.slug) ||
      !Array.isArray(post.ownedSlugs) || post.ownedSlugs.some(slug => !isPostRouteSlug(slug))) ||
      (reply.kind === "partial-receipts" ? !Array.isArray(refused) || !refused.length || refused.some(owner =>
        typeof owner?.postId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.postId) || !Array.isArray(owner.ownedSlugs) ||
        !owner.ownedSlugs.length || owner.ownedSlugs.some(slug => !isPostRouteSlug(slug)))
        : !posts.length || refused !== undefined)) {
    throw new Error("Invalid public catalog");
  }
  return [...posts, ...(refused ?? [])];
}

/** The single full-build transition seam. Remove with #2793.
 * Cache API shares authority within a colo. It has no CAS: separate cold isolates
 * can make bounded duplicate refreshes. The map joins refreshes in one isolate.
 */
export function createTransitionalPostReadWorker(dependencies: Dependencies) {
  let authority = sharedAuthority;
  if (dependencies.authorityScope) {
    const scope = dependencies.authorityScope;
    authority = scopedAuthority.get(scope) ?? authorityScope();
    scopedAuthority.set(scope, authority);
  }
  const { refreshes, withdrawalRefreshes } = authority;
  const target = assertPublicationTarget(dependencies.target ?? publicationTarget("production"));
  const purgeTag = publicationPostCacheTag(target, "background");
  const now = dependencies.now ?? Date.now;
  if (!/^[a-f0-9]{40}$/.test(dependencies.rendererSha)) throw new Error("Invalid public renderer release");
  const keyFor = (path: string, method: string, catalog = false) => new Request(`${target.origin}/__post-authority/v2?${new URLSearchParams({
    target: target.workerName, renderer: dependencies.rendererSha, path, method, kind: catalog ? "catalog" : "route",
  })}`);
  const catalogKey = keyFor("/_publication.json", "GET", true);
  const withdrawalKeyFor = (path: string) => new Request(`${target.origin}/__post-withdrawal-authority/v1?${new URLSearchParams({
    target: target.workerName, renderer: dependencies.rendererSha, path,
  })}`);
  const lastGoodPath = (request: Request) => {
    const url = new URL(request.url);
    return !url.search && ["GET", "HEAD"].includes(request.method) &&
      !["authorization", "cookie", "range"].some(header => request.headers.has(header)) &&
      (postSlugForPath(url.pathname) || /^\/(programs|shows|events)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)) ? url.pathname : null;
  };
  /** A 410, a 503 for unknown withdrawal state, or null when no withdrawal
   * applies. Rejects when the route has no last-good authority. */
  async function lastGoodWithdrawal(request: Request, path: string): Promise<Response | null> {
    const slug = postSlugForPath(path);
    if (slug) {
      if (!dependencies.readWithdrawal) throw new Error("Post withdrawal authority unavailable");
      let marker: Withdrawal | null;
      try { marker = await timed(dependencies.readWithdrawal(slug), 500); }
      catch { return unavailable(request); }
      return marker ? resolvePostTombstone(request, path, slug, marker, "post-last-good-tombstone") : null;
    }
    if (!dependencies.readRecordAuthority) throw new Error("Record withdrawal authority unavailable");
    let authority: RecordRouteAuthority | null;
    try { authority = await timed(dependencies.readRecordAuthority(path), 500); }
    catch { return unavailable(request); }
    if (!authority) throw new Error("Record withdrawal authority unavailable");
    if (authority.withdrawal) return recordGone(authority.withdrawal);
    if (!authority.owned) throw new Error("Record namespace unavailable");
    return null;
  }
  async function lastGoodFallback(request: Request): Promise<Response | null> {
    const path = lastGoodPath(request);
    if (!path || !dependencies.lastGood) return null;
    try {
      const withdrawn = await lastGoodWithdrawal(request, path);
      if (withdrawn) return withdrawn;
      const generation = await timed(readAssetCodeGeneration(dependencies.fetchAsset, target, dependencies.rendererSha), 500);
      const retained = await timed(dependencies.lastGood.read(request, generation), 500);
      return retained ? await lastGoodWithdrawal(request, path) ?? retained : null;
    } catch { return null; }
  }
  async function retain(request: Request, response: Response | null): Promise<Response | null> {
    const path = lastGoodPath(request);
    if (request.method !== "GET" || !path ||
        response?.status !== 200 || !response.body || response.headers.get("content-type") !== "text/html; charset=utf-8" ||
        !isVerifiedLastGoodResponse(path, response, dependencies.rendererSha)) return response;
    let generation: number;
    try {
      // Post publication generations are not code artifact generations. Read
      // the immutable Assets binding instead of relabeling an owner revision.
      generation = await timed(readAssetCodeGeneration(dependencies.fetchAsset, target, dependencies.rendererSha,
        response.headers.get("x-njpbs-code-generation")), 500);
    } catch (error) {
      reportLastGoodRetentionFailure("artifact-identity", error);
      // A code-context response already has an authoritative receipt seal.
      // An optional retention lookup cannot remove it or relabel its bytes.
      // Ordinary Posts without that seal remain without one on failure.
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("x-njpbs-code-generation", String(generation));
    const certified = new Response(response.body, { status: response.status, headers });
    if (dependencies.lastGood) dependencies.waitUntil(dependencies.lastGood.store(request, certified)
      .catch(error => { reportLastGoodRetentionFailure("post-store", error); }));
    return certified;
  }
  const dtoLimit = (key: Request) => isIndependentPostBackgroundPath(new URL(key.url).searchParams.get("path") ?? "")
    ? BACKGROUND_DTO_BYTES_MAX : DTO_BYTES_MAX;

  const fenceKey = (key: Request, fence: string) => {
    const url = new URL(key.url);
    url.searchParams.set("purge-fence", fence);
    return new Request(url);
  };
  async function fencePresent(key: Request, fence: string): Promise<boolean | undefined> {
    try { return !!await timed(dependencies.cache.match(fenceKey(key, fence)), 100); }
    catch { return undefined; }
  }
  const current = (key: Request, entry: Entry) => entry.purgeFence
    ? fencePresent(key, entry.purgeFence) : Promise.resolve(true);
  const unavailableAuthority = (catalogId: string): Entry => ({ schemaVersion: 1, expiresAt: now() + FAILURE_TTL_MS,
    catalogId, state: "unavailable" });

  async function read(key: Request): Promise<Entry | undefined> {
    try {
      const response = await timed(dependencies.cache.match(key), 100);
      if (!response) return undefined;
      const deadline = Number(response.headers.get("x-njpbs-authority-expires-at"));
      if (!Number.isSafeInteger(deadline)) return undefined;
      const value = await timed(boundedJson(response, dtoLimit(key)), 100);
      if (!object(value) || value.schemaVersion !== 1 || value.expiresAt !== deadline ||
          deadline > now() + TTL_MS || typeof value.catalogId !== "string" ||
          !["ready", "unavailable"].includes(String(value.state)) || typeof value.purgeFence !== "string" ||
          !/^[a-f0-9-]{36}$/.test(value.purgeFence)) return undefined;
      if (value.state === "unavailable" && deadline <= now()) return undefined;
      if (value.state === "ready" && (!validReply(value.reply) || !Number.isSafeInteger(value.staleUntil) ||
          Number(value.staleUntil) < deadline || Number(value.staleUntil) <= now() ||
          Number(value.staleUntil) > now() + TTL_MS + STALE_MS || value.retryAt !== undefined &&
          (!Number.isSafeInteger(value.retryAt) || Number(value.retryAt) > now() + FAILURE_TTL_MS ||
            Number(value.retryAt) > Number(value.staleUntil)))) return undefined;
      if (key.url === catalogKey.url && value.state === "ready") catalogPosts(value.reply as NoBuildPostReply);
      if (await fencePresent(key, value.purgeFence) !== true) return undefined;
      return value as Entry;
    } catch { return undefined; }
  }

  async function store(key: Request, entry: Entry) {
    const text = JSON.stringify(entry);
    if (new TextEncoder().encode(text).byteLength > dtoLimit(key)) throw new Error("Public authority exceeds its bound");
    const retainUntil = entry.state === "ready" ? entry.staleUntil : entry.expiresAt;
    const maxAge = Math.max(1, Math.ceil((retainUntil - now()) / 1000));
    await timed(dependencies.cache.put(key, new Response(text, { headers: {
      "content-type": "application/json", "cache-control": `public, max-age=${maxAge}`, "Cache-Tag": purgeTag,
      "x-njpbs-authority-expires-at": String(entry.expiresAt),
    } })), 100);
  }

  function refresh(key: Request, path: string, method: string, catalogId = "",
    requestedAt = ++authority.order, join = true): Promise<Entry> {
    const existing = join ? refreshes.get(key.url) : undefined;
    if (existing) return (async () => {
      // A cold post-purge request must not join a pre-purge RPC. Only its own
      // record may be removed; an older task must not erase its replacement.
      if (existing.purgeFence) {
        const present = await fencePresent(key, existing.purgeFence);
        if (present !== true) {
          if (present === false && refreshes.get(key.url) === existing) refreshes.delete(key.url);
          return refresh(key, path, method, catalogId, requestedAt, present === false);
        }
      }
      const entry = await existing.task;
      if (!entry.purgeFence) return refresh(key, path, method, catalogId, requestedAt, false);
      // A withdrawal read started before this request could predate a republish.
      if (entry.state === "ready" && entry.reply.kind === "gone" && entry.retryAt === undefined &&
          (existing.readOrder ?? 0) < requestedAt) {
        return refresh(key, path, method, catalogId, requestedAt);
      }
      return catalogId && entry.catalogId !== catalogId ? refresh(key, path, method, catalogId, requestedAt) : entry;
    })();
    const running = {} as Refresh;
    const task = (async () => {
      let cached = await read(key);
      if (cached && (cached.state === "ready" && (cached.retryAt ?? 0) > now() ||
          (cached.state !== "ready" || cached.reply.kind !== "gone") && cached.expiresAt > now()) &&
          (!catalogId || cached.catalogId === catalogId)) return cached;
      try {
        // Store a unique tagged witness BEFORE reading authority. A purge
        // deletes it even if the RPC or entry put finishes after the purge.
        const fence = crypto.randomUUID();
        await timed(dependencies.cache.put(fenceKey(key, fence), new Response("1", { headers: {
          "Cache-Tag": purgeTag,
          "cache-control": `public, max-age=${(AUTHORITY_TIMEOUT_MS + TTL_MS + STALE_MS) / 1000}`,
        } })), 100);
        running.purgeFence = fence;
      } catch { /* Fresh authority can still answer when Cache API is unavailable. */ }
      // A purge between the first read and witness put also removes last-good
      // fallback. Never adopt that earlier snapshot under a newer witness.
      cached = running.purgeFence ? await read(key) : undefined;
      let entry: Entry;
      let fresh = false;
      try {
        running.readOrder = ++authority.order;
        const reply = await timed(Promise.resolve().then(() => dependencies.getDecision(path, method)));
        if (!validReply(reply) || useAssetsForUnavailablePost(reply.status ?? 200)) throw new Error("Public authority unavailable");
        if (key.url === catalogKey.url) catalogPosts(reply);
        const serialized = JSON.stringify(reply);
        if (new TextEncoder().encode(serialized).byteLength + 256 > dtoLimit(key)) throw new Error("Public authority exceeds its bound");
        entry = { schemaVersion: 1, expiresAt: now() + TTL_MS, staleUntil: now() + TTL_MS + STALE_MS,
          state: "ready", catalogId: catalogId || await digest(serialized), reply: JSON.parse(serialized) };
        fresh = true;
      } catch {
        // Throttle failed refreshes without turning old ownership into fresh
        // authority. Last-good bytes retain only their original horizon.
        entry = cached?.state === "ready" && cached.reply.kind !== "pass" &&
          (!catalogId || cached.catalogId === catalogId) && cached.staleUntil > now()
          ? { ...cached, retryAt: Math.min(now() + FAILURE_TTL_MS, cached.staleUntil) }
          : { schemaVersion: 1, expiresAt: now() + FAILURE_TTL_MS, catalogId, state: "unavailable" };
      }
      entry = { ...entry, purgeFence: running.purgeFence };
      const present = entry.purgeFence ? await current(key, entry) : undefined;
      // A failed lookup is unknown, not a purge acknowledgment. Only fresh RPC
      // bytes can answer uncached in that case; last-good input cannot be used.
      if (present === undefined) entry = fresh ? { ...entry, purgeFence: undefined } : unavailableAuthority(catalogId);
      try { if (entry.purgeFence && present === true) await store(key, entry); }
      catch { /* Current authority can answer even when cache storage fails. */ }
      return entry;
    })().finally(() => { if (refreshes.get(key.url) === running) refreshes.delete(key.url); });
    running.task = task;
    if (join) refreshes.set(key.url, running);
    dependencies.waitUntil(task);
    return task;
  }

  async function decision(key: Request, path: string, method: string, catalogId = ""): Promise<Entry> {
    const cached = await read(key);
    if (cached && (!catalogId || cached.catalogId === catalogId)) {
      // Cached withdrawals still fence static copies during an outage.
      // They cannot decide a 410 after the origin accepts a republish.
      if (cached.state === "ready" && cached.reply.kind === "gone") {
        return refresh(key, path, method, catalogId);
      }
      // An old unowned answer cannot authorize Assets after a later removal.
      if (cached.state === "ready" && cached.reply.kind === "pass" && cached.expiresAt <= now()) {
        return refresh(key, path, method, catalogId);
      }
      if (cached.expiresAt <= now() && (cached.state !== "ready" || (cached.retryAt ?? 0) <= now())) {
        refresh(key, path, method, catalogId);
      }
      return cached;
    }
    // A cold colo and a purged route must read current ownership before Assets
    // can answer. New Posts have no full-build detail to fall back to.
    try {
      return await timed((async () => {
        let entry = await refresh(key, path, method, catalogId);
        if (await current(key, entry) !== true) entry = await refresh(key, path, method, catalogId);
        return await current(key, entry) === true ? entry : unavailableAuthority(catalogId);
      })());
    } catch { return unavailableAuthority(catalogId); }
  }

  function unavailable(request: Request, status = 503): Response {
    return new Response(request.method === "HEAD" ? null : "Content is being updated.", { status, headers: {
      ...SECURITY_HEADER_BASELINE, "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Retry-After": "1",
      ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
    } });
  }

  function unavailableWithoutCopy(request: Request): Response {
    const response = unavailable(request);
    response.headers.set(WITHDRAWAL_UNKNOWN_HEADER, "unknown");
    return response;
  }

  function durableGone(withdrawal: Withdrawal, branch: string): Response {
    return new Response(null, { status: 410, headers: {
        ...SECURITY_HEADER_BASELINE, "cache-control": "no-store", "x-njpbs-content-source": "durable-post-withdrawal",
      [PUBLIC_GONE_BRANCH_HEADER]: branch,
        "x-njpbs-publication-operation": withdrawal.operationId, "x-njpbs-source-version": String(withdrawal.sourceVersion),
        "x-njpbs-withdrawal-revision": String(withdrawal.revision), "x-njpbs-durable-withdrawal-operation": withdrawal.operationId, "x-robots-tag": "noindex, nofollow",
      } });
  }

  function visibleAfterWithdrawal(reply: NoBuildPostReply | undefined, withdrawal: Withdrawal, slug: string): boolean {
    if (!reply?.receipt) return false;
    const { receipt } = reply;
    return ["post", "alias", "static"].includes(reply.kind) && receipt.visible === true &&
      receipt.rendererSha === dependencies.rendererSha && receipt.postId === withdrawal.postId &&
      Array.isArray(receipt.ownedSlugs) && receipt.ownedSlugs.includes(slug) &&
      Number.isSafeInteger(receipt.generation) && receipt.generation > withdrawal.revision;
  }

  async function withdrawalAuthority(path: string, withdrawal: Withdrawal, slug: string,
    requestedAt = ++authority.order): Promise<WithdrawalAuthority> {
    const key = withdrawalKeyFor(path);
    try {
      const cached = await timed(dependencies.cache.match(key), 100);
      if (cached) {
        const entry = await timed(boundedJson(cached, DTO_BYTES_MAX), 100) as WithdrawalAuthority;
        if (entry.schemaVersion === 1 && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now() &&
            entry.expiresAt <= now() + (entry.reply ? WITHDRAWAL_AUTHORITY_TTL_MS : FAILURE_TTL_MS) &&
            entry.expiresAt === Number(cached.headers.get("x-njpbs-authority-expires-at")) &&
            (entry.reply === undefined || validReply(entry.reply) && visibleAfterWithdrawal(entry.reply, withdrawal, slug)) &&
            typeof entry.purgeFence === "string" && /^[a-f0-9-]{36}$/.test(entry.purgeFence) &&
            await fencePresent(key, entry.purgeFence) === true) return entry.reply ? entry : { ...entry, retry: true };
      }
    } catch { /* Live authority can still answer when Cache API is unavailable. */ }
    const running = withdrawalRefreshes.get(key.url);
    if (running) {
      const entry = await running.task;
      if ((running.readOrder ?? 0) >= requestedAt || visibleAfterWithdrawal(entry.reply, withdrawal, slug)) return entry;
      return withdrawalAuthority(path, withdrawal, slug, requestedAt);
    }
    const pending = {} as WithdrawalRefresh;
    pending.task = (async (): Promise<WithdrawalAuthority> => {
      const started = now(), purgeFence = crypto.randomUUID();
      let witnessed = false;
      try {
        await timed(dependencies.cache.put(fenceKey(key, purgeFence), new Response("1", { headers: {
          "Cache-Tag": purgeTag, "cache-control": `public, max-age=${WITHDRAWAL_AUTHORITY_TTL_MS / 1000 + 3}`,
        } })), 100);
        witnessed = true;
      } catch { /* A fresh read is usable without caching it. */ }
      let entry: WithdrawalAuthority;
      try {
        pending.readOrder = ++authority.order;
        const reply = await timed(Promise.resolve().then(() => dependencies.getDecision(path, "GET")));
        if (!validReply(reply) || !["post", "alias", "static", "gone"].includes(reply.kind) ||
            !reply.receipt || !Number.isSafeInteger(reply.receipt.generation) || reply.receipt.generation < 1 ||
            reply.receipt.rendererSha !== dependencies.rendererSha) throw new Error("Withdrawal authority unavailable");
        const text = JSON.stringify(reply);
        if (new TextEncoder().encode(text).byteLength + 256 > DTO_BYTES_MAX) throw new Error("Withdrawal authority exceeds its bound");
        entry = { schemaVersion: 1, expiresAt: started + WITHDRAWAL_AUTHORITY_TTL_MS, reply: JSON.parse(text) };
      } catch { entry = { schemaVersion: 1, expiresAt: now() + FAILURE_TTL_MS }; }
      if (witnessed) {
        if (await fencePresent(key, purgeFence) !== true) return { schemaVersion: 1, expiresAt: now() };
        entry.purgeFence = purgeFence;
        if (!entry.reply || visibleAfterWithdrawal(entry.reply, withdrawal, slug)) try {
          await timed(dependencies.cache.put(key, new Response(JSON.stringify(entry), { headers: {
            "Cache-Tag": purgeTag, "cache-control": `public, max-age=${Math.max(1, Math.ceil((entry.expiresAt - now()) / 1000))}`,
            "x-njpbs-authority-expires-at": String(entry.expiresAt),
          } })), 100);
        } catch { /* Cache writes do not extend this request's authority horizon. */ }
      }
      return entry;
    })().finally(() => { if (withdrawalRefreshes.get(key.url) === pending) withdrawalRefreshes.delete(key.url); });
    withdrawalRefreshes.set(key.url, pending);
    return pending.task;
  }

  async function resolvePostTombstone(request: Request, path: string, slug: string, withdrawal: Withdrawal,
    branch: string): Promise<Response> {
    if (dependencies.rendererReady === false) return durableGone(withdrawal, "post-tombstone-renderer");
    let visible = false;
    try {
      const authority = await withdrawalAuthority(path, withdrawal, slug);
      const reply = authority.reply, receipt = reply?.receipt;
      if (authority.retry) return unavailableWithoutCopy(request);
      if (!reply || !receipt || authority.expiresAt <= now()) return durableGone(withdrawal, branch);
      const currentAbsence = reply.kind === "gone" && receipt.visible === false &&
        Number.isSafeInteger(receipt.generation) && receipt.generation >= withdrawal.revision &&
        receipt.postId === withdrawal.postId && Array.isArray(receipt.ownedSlugs) && receipt.ownedSlugs.includes(slug);
      visible = visibleAfterWithdrawal(reply, withdrawal, slug);
      if (!visible && !currentAbsence) return durableGone(withdrawal, "post-tombstone-conflict");
      const worker = createNoBuildPostWorker({ ...dependencies, target, now: () => new Date(now()),
        getDecision: async () => {
          if (authority.expiresAt <= now()) throw new Error("Withdrawal authority expired");
          return structuredClone(reply);
        } });
      const response = await worker.fetch(request);
      const latest = await timed(dependencies.readWithdrawal!(slug), 500);
      if (latest && (latest.postId !== receipt.postId || latest.revision > receipt.generation ||
          latest.revision === receipt.generation && visible)) return durableGone(latest, "post-tombstone-race");
      if (!latest || authority.expiresAt <= now() || authority.purgeFence &&
          await fencePresent(withdrawalKeyFor(path), authority.purgeFence) !== true) {
        return visible ? unavailableWithoutCopy(request) : durableGone(withdrawal, "post-tombstone-recheck");
      }
      if (response && (visible ? [200, 302, 308].includes(response.status) : response.status === 410)) return response;
    } catch { /* An accepted visible revision never falls back to an older 410. */ }
    return visible ? unavailableWithoutCopy(request) : durableGone(withdrawal, branch);
  }

  async function codeContext(request: Request): Promise<Response | null> {
    // Candidate/static-return readbacks must verify their original sealed bytes.
    if (!dependencies.readCodePost || new URL(request.url).searchParams.has("cms-code")) return null;
    let codeWithdrawal = false;
    try {
      const response = await timed((async () => {
        // Released Assets are only a bounded route hint. Private CODE authority
        // still qualifies the body and current joins before any replacement.
        const inventory = await dependencies.fetchAsset(new Request(`${target.origin}/_content-status.json`));
        if (inventory.status !== 200) return null;
        let value: unknown;
        try { value = await boundedJson(inventory, DTO_BYTES_MAX); }
        catch { return null; }
        if (!object(value) || value.schemaVersion !== 1 || value.commitSha !== dependencies.rendererSha ||
            !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
            typeof value.buildBatchId !== "string" || !/^cms-[A-Za-z0-9]{20}$/.test(value.buildBatchId) ||
            !Array.isArray(value.routes) || value.routes.length > 10_000 || value.routes.some(route =>
              !object(route) || typeof route.path !== "string" || route.path.length > 512)) return null;
        if (!value.routes.some(route => object(route) && route.path === new URL(request.url).pathname &&
            route.source === "cms" && route.recordContext === true && typeof route.contentKey === "string" && /^[a-f0-9]{64}$/.test(route.contentKey) &&
            Number.isSafeInteger(route.sourceVersion) && Number(route.sourceVersion) > 0)) return null;
        return dependencies.readCodePost!(request);
      })(), AUTHORITY_TIMEOUT_MS);
      if (response?.status !== 410 || !dependencies.readWithdrawal) return response;
      codeWithdrawal = true;
    } catch { /* A failed context may have seen a newer withdrawal. */ }
    // The current no-build reader can confirm a publication that the code
    // context could not qualify. Check before allowing a static copy.
    const path = new URL(request.url).pathname, slug = postSlugForPath(path);
    if (!slug || !dependencies.readWithdrawal) return unavailable(request);
    try {
      const marker = await timed(dependencies.readWithdrawal(slug), 500);
      if (marker) return resolvePostTombstone(request, path, slug, marker, "post-code-context-tombstone");
      return codeWithdrawal ? unavailableWithoutCopy(request) : unavailable(request);
    } catch {
      return unavailableWithoutCopy(request);
    }
  }

  async function assets(request: Request, pending: boolean, codeRequest?: Request, staticMiss?: Response): Promise<Response> {
    if (codeRequest && dependencies.readCodePost && new URL(request.url).pathname === new URL(codeRequest.url).pathname) {
      const context = await codeContext(codeRequest);
      if (context && [200, 302, 308, 410].includes(context.status)) return context;
      // Unknown withdrawal state never authorizes the Assets copy.
      if (context?.status === 503 && context.headers.get(WITHDRAWAL_UNKNOWN_HEADER) === "unknown") return context;
      if (context) pending = true;
    }
    // A fresh unowned catalog still selects its code Assets. Outage copies
    // cannot override that current decision or complete a publication proof.
    if (!codeRequest) {
      const retained = await lastGoodFallback(request);
      if (retained) return retained;
    }
    const response = staticMiss ?? await dependencies.fetchAsset(request);
    if (response.status === 410 && postSlugForPath(publicPath(new URL(request.url).pathname) ?? "")) {
      void response.body?.cancel().catch(() => {});
      return unavailable(request);
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    if (pending) {
      headers.set("x-njpbs-publication-refresh", "pending");
      headers.set("Retry-After", "1");
      headers.set("cache-control", "no-store");
    }
    if (["/_publication.json", "/_content-status.json"].includes(new URL(request.url).pathname)) {
      headers.set("x-njpbs-publication-origin", target.workerName);
      headers.set("cache-control", "no-store");
    }
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const publicReader = {
    async fetch(request: Request, retryExpired = true): Promise<Response | null> {
      let withdrawalKnown = true;
      let staticMiss: Response | undefined;
      // Static copies predate later withdrawals. Unknown durable state never
      // authorizes an Assets or last-good copy; fresh authority may still decide.
      const copy = (pending: boolean, codeRequest?: Request) =>
        withdrawalKnown ? assets(request, pending, codeRequest, staticMiss) : unavailable(request);
      const url = new URL(request.url);
      if (url.origin !== target.origin) return null;
      let path: string | null;
      try { path = publicPath(url.pathname); }
      catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }); }
      if (!path) return null;
      const probe = path === "/_publication.json" && (url.searchParams.has("candidate") || url.searchParams.has("version"));
      const normalized = new URL(url);
      normalized.pathname = path;
      const workerRequest = new Request(normalized, request);
      if (probe) {
        const worker = createNoBuildPostWorker({ ...dependencies, target, now: () => new Date(now()),
          getDecision: async (probePath, method, identity) => {
            const reply = await timed(Promise.resolve().then(() => dependencies.getDecision(probePath, method, identity)));
            if (reply.kind !== "baseline-probe") throw new Error("Unleased public artifact probe");
            return reply;
          } });
        return worker.fetch(workerRequest);
      }
      if (path === "/_publication.json" && url.searchParams.get("cms-context") === "code") {
        return assets(request, false);
      }
      if (!["GET", "HEAD"].includes(request.method)) return assets(request, false);
      const slug = postSlugForPath(path);
      let withdrawal: Withdrawal | null = null;
      if (slug && dependencies.readWithdrawal) {
        try { withdrawal = await timed(dependencies.readWithdrawal(slug), 500); }
        catch { withdrawalKnown = false; }
      }
      if (withdrawal) {
        // A republish retains the tombstone. Qualify the current owner
        // before allowing it to decide this response.
        return resolvePostTombstone(workerRequest, path, slug!, withdrawal, "post-tombstone-authority");
      }
      if (path.startsWith("/_astro/")) {
        const asset = await dependencies.fetchAsset(request);
        if (asset.status !== 404) return asset;
        staticMiss = asset;
      }
      if (dependencies.rendererReady === false) return copy(false);
      // Aggregate/context ownership does not depend on an admitted Post. The
      // same authoritative route cache serves it before an empty Post catalog.
      const independent = isIndependentPostBackgroundPath(path);
      const authorityKey = independent ? keyFor(path, "GET") : catalogKey;
      let catalog = await decision(authorityKey, independent ? path : "/_publication.json", "GET");
      if (slug && catalog.state === "ready" && catalog.expiresAt <= now() &&
          !catalogPosts(catalog.reply).some(post => post.ownedSlugs.includes(slug))) {
        // A healthy refresh may add this slug. Await it before either Assets
        // or refusal answers an unowned route; join the in-flight revalidation.
        catalog = await refresh(catalogKey, "/_publication.json", "GET");
      }
      if (catalog.state === "unavailable") return copy(true);
      if (slug && catalog.reply.catalog?.refusedPosts?.some(post => post.ownedSlugs.includes(slug))) {
        return unavailable(request);
      }
      const posts = independent ? [] : catalogPosts(catalog.reply);
      if (!independent && !posts.length) return copy(refreshes.has(catalogKey.url), slug && catalog.expiresAt > now() ? workerRequest : undefined);
      if (slug && !posts.some(post => post.ownedSlugs.includes(slug))) {
        // Only a fresh catalog can prove that a route belongs to code Assets.
        if (catalog.expiresAt <= now()) return copy(true);
        return copy(false, workerRequest);
      }
      // GET supplies complete bytes for the shared GET/HEAD render entry.
      const routeKey = independent ? authorityKey : path === "/_publication.json" ? catalogKey : keyFor(path, "GET");
      const route = routeKey.url === authorityKey.url ? catalog : await decision(routeKey, path, "GET", catalog.catalogId);
      if (route.state === "unavailable" || slug && route.reply.kind === "pass") return copy(true);
      const withdrawn = route.reply.kind === "gone";
      if (withdrawn && route.retryAt !== undefined) return unavailableWithoutCopy(request);
      // Unknown withdrawal state needs fresh authority; the stale window is not fresh.
      const expiresAt = withdrawalKnown ? Math.min(catalog.staleUntil, route.staleUntil)
        : Math.min(catalog.expiresAt, route.expiresAt);
      const renderKey = (key: Request) => {
        const url = new URL(key.url);
        url.searchParams.set("__authority_catalog", catalog.catalogId);
        return new Request(url, key);
      };
      const worker = createNoBuildPostWorker({ ...dependencies, target, now: () => new Date(now()),
        async fetchAsset(assetRequest) {
          // Reuse the miss only for this request with the original URL. A
          // normalized asset spelling can have a separate Assets response.
          if (staticMiss && assetRequest === workerRequest && workerRequest.url === request.url) return staticMiss;
          return dependencies.fetchAsset(assetRequest);
        },
        cache: {
          match: key => dependencies.cache.match(renderKey(key as Request)),
          put: (key, response) => dependencies.cache.put(renderKey(key as Request), response),
        },
        getDecision: async (currentPath, method) => {
          if (currentPath !== path || !["GET", "HEAD"].includes(method) || expiresAt <= now()) {
            throw new Error("Public decision expired");
          }
          // One response uses one bounded authority snapshot. A concurrent
          // revalidation cannot mix new receipt fields with older render input.
          return structuredClone(route.reply);
        } });
      let response = await worker.fetch(workerRequest);
      if (response?.status === 200 && response.headers.get("x-njpbs-content-source") === "cms-static-return") {
        const context = await codeContext(workerRequest);
        if (context && [200, 302, 308, 410].includes(context.status)) response = context;
        else if (context?.status === 503 && context.headers.get(WITHDRAWAL_UNKNOWN_HEADER) === "unknown") return context;
        else if (context) {
          const headers = new Headers(response.headers);
          headers.set("x-njpbs-publication-refresh", "pending");
          response = new Response(response.body, { status: response.status, headers });
        }
      }
      if (await current(authorityKey, catalog) !== true || await current(routeKey, route) !== true) {
        if (retryExpired) return publicReader.fetch(request, false);
        return withdrawn ? unavailableWithoutCopy(request) : copy(true);
      }
      if (expiresAt <= now()) {
        // A route read or render can outlive a nearly expired last-good
        // catalog. Retry once with current authority before refusing the reply.
        if (retryExpired) return publicReader.fetch(request, false);
        return unavailable(request);
      }
      if (!response || useAssetsForUnavailablePost(response.status)) {
        return withdrawn ? unavailableWithoutCopy(request) : copy(false);
      }
      return response;
    },
  };
  function recordGone(withdrawal: RecordWithdrawal): Response {
    return new Response(null, { status: 410, headers: { ...SECURITY_HEADER_BASELINE,
      "cache-control": "no-store", "x-njpbs-content-source": "durable-record-withdrawal",
      "x-njpbs-record-id": withdrawal.recordId, "x-njpbs-record-family": withdrawal.family,
      "x-njpbs-publication-operation": withdrawal.operationId, "x-njpbs-source-version": String(withdrawal.sourceVersion),
      "x-njpbs-withdrawal-revision": String(withdrawal.revision), "x-njpbs-durable-withdrawal-operation": withdrawal.operationId, "x-robots-tag": "noindex, nofollow" } });
  }
  function outranksRecordWithdrawal(response: Response | null, marker: RecordWithdrawal): boolean {
    if (!response || response.headers.get("x-njpbs-record-id") !== marker.recordId ||
        response.headers.get("x-njpbs-record-family") !== marker.family) return false;
    const revision = Number(response.headers.get("x-njpbs-record-generation"));
    const sourceVersion = Number(response.headers.get("x-njpbs-source-version"));
    return Number.isSafeInteger(revision) && Number.isSafeInteger(sourceVersion) && sourceVersion >= marker.sourceVersion &&
      (response.status === 410 && response.headers.get("x-njpbs-record-visible") === "false" && revision >= marker.revision ||
        response.status === 200 && response.headers.get("x-njpbs-record-visible") === "true" && revision > marker.revision);
  }
  /** Rejects when durable withdrawal state is unknown. */
  async function recordAuthority(path: string) {
    return await timed(Promise.resolve().then(() => dependencies.readRecordAuthority?.(path) ?? null), 500);
  }
  const reader = { async fetch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.origin !== target.origin) return null;
    let path: string | null;
    try { path = publicPath(url.pathname); }
    catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }); }
    if (!path || !publicRecordFamily(path)) return retain(request, await publicReader.fetch(request));
    // Unknown withdrawal state refuses every Record answer, live or static.
    let before: RecordRouteAuthority | null;
    try { before = await recordAuthority(path); } catch { return unavailable(request); }
    const marker = before?.withdrawal;
    // A compiled capability is default-off. R2 ownership is the dispatch hint;
    // it grants no content authority and makes unregistered routes cost no RPC.
    if (dependencies.recordRendererReady !== true) return marker ? recordGone(marker) : null;
    if (before?.owned === false && !marker) return null;
    const response = await publicReader.fetch(request);
    let after: RecordRouteAuthority | null;
    try { after = await recordAuthority(path); }
    catch {
      // A marker observed before or during the fallback keeps its 410.
      if (marker) return recordGone(marker);
      return response?.status === 410 && response.headers.get("x-njpbs-content-source") === "durable-record-withdrawal"
        ? response : unavailable(request);
    }
    const latest = after?.withdrawal;
    if (marker && !latest) return recordGone(marker);
    if (latest && !outranksRecordWithdrawal(response, latest)) return recordGone(latest);
    if (latest && response?.status === 410) {
      const headers = new Headers(response.headers);
      headers.set("x-njpbs-durable-withdrawal-operation", latest.operationId);
      headers.set("x-njpbs-withdrawal-revision", String(latest.revision));
      return new Response(response.body, { status: response.status, headers });
    }
    return retain(request, response);
  } };
  const feed = createLiveBlogFeedReader({ target, rendererSha: dependencies.rendererSha, cache: dependencies.cache, now,
    readPage: async request => await reader.fetch(request) ?? dependencies.fetchAsset(request) });
  return { async fetch(request: Request): Promise<Response | null> {
    return await feed(request) ?? reader.fetch(request);
  } };
}

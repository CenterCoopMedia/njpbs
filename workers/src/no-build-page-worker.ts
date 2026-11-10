import { contentLinkRedirect } from "../../packages/content-core/src/content-link.ts";
import sourcePayload from "../../functions/lib/no-build-page-source-payload.js";
import type { NoBuildPageReply } from "../../cms-api/src/index";
import { isIndependentPostBackgroundPath } from "./no-build-post-worker";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { isPublicPagePath, PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import { projectPublishedPageRead, type PublishedPageContent } from "../../site/src/lib/published-page-render";
import { publicationTarget, assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";
import type { HomeSourceSnapshot } from "../../site/src/lib/home-sources";
import { readHomeSourceSnapshot } from "../../packages/content-core/src/home-published-sources";
import { projectPublicPageContextRead, type PublicPageContextContent } from "../../site/src/lib/public-page-context-render";
import type { PageWithdrawal } from "./durable-page-withdrawals";
import { readScheduleSourceSnapshot } from "../../packages/content-core/src/schedule-source-snapshot";
import { createPublicPageResponseCache, cacheablePageRequest, cacheablePageDecision, pageDecisionIdentity } from "./public-page-response-cache";
import { readAssetCodeGeneration, reportLastGoodRetentionFailure, type PublicContentLastGood } from "./public-content-last-good";

export const isPageScheduleExportPath = (path: string) =>
  ["/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"].includes(path);

// The real 38-day Schedule renders about 2.35 MiB. Keep HTML bounded with
// room for its retained correction dates and normal provider text growth.
export const PUBLIC_PAGE_HTML_MAX_BYTES = 4 * 1024 * 1024;
// After the first authority read, public HTML shares one render/recheck budget.
export const PUBLIC_PAGE_WAIT_MS = 2_000;
const MAX_PAGE_RENDER_ATTEMPTS = 3;
const HOME_BASELINE_MAX_BYTES = 2 * 1024 * 1024;
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function bounded<T>(work: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Page authority unavailable")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function unavailable(head: boolean, status = 503): Response {
  return new Response(head ? null : "Page unavailable", { status, headers: {
    ...SECURITY_HEADER_BASELINE, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8",
    ...(status === 405 ? { allow: "GET, HEAD" } : {}),
  } });
}
function pagePath(path: string): string | null {
  for (let count = 0; count < 32 && /%[a-f0-9]{2}/i.test(path); count++) path = decodeURIComponent(path);
  if (/%|\\|\/\//.test(path) || path.length > 512) throw new Error("Invalid Page path");
  path = path.replace(/\/index\.html\/?$/, "/");
  if (path === "/_home-sources.json" || isPageScheduleExportPath(path)) return path;
  if (/^\/[^/.]+$/.test(path)) path += "/";
  if (isIndependentPostBackgroundPath(path)) return null;
  return /^(?:\/|\/[^/.]+\/)$/.test(path) ? path : null;
}
function durableGone(withdrawal: PageWithdrawal): Response {
  return new Response(null, { status: 410, headers: {
    ...SECURITY_HEADER_BASELINE, "cache-control": "no-store", "x-njpbs-content-source": "durable-page-withdrawal",
    "x-njpbs-publication-operation": withdrawal.operationId, "x-njpbs-source-version": String(withdrawal.sourceVersion),
    "x-njpbs-withdrawal-revision": String(withdrawal.revision), "x-robots-tag": "noindex, nofollow",
  } });
}
function outranksWithdrawal(reply: NoBuildPageReply, withdrawal: PageWithdrawal, path: string): boolean {
  const receipt = reply.receipt;
  return !!receipt && receipt.pageId === withdrawal.pageId && receipt.ownedPaths.includes(path) &&
    Number.isSafeInteger(receipt.operationGeneration) && (
      reply.kind === "gone" && !receipt.visible && receipt.operationGeneration! >= withdrawal.revision ||
      ["page", "alias"].includes(reply.kind) && receipt.visible && receipt.operationGeneration! > withdrawal.revision);
}
function receiptHeaders(reply: NoBuildPageReply, rendererSha: string, adminOrigin: string): Headers {
  const receipt = reply.receipt;
  const datasetFiguresDigest = receipt?.datasetFiguresDigest;
  const definition = PUBLIC_PAGES.find(page => page.id === receipt?.pageId);
  const maxPaths = definition ? 102 + ("aliases" in definition ? definition.aliases.length : 0) : 101;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.rendererSha !== rendererSha ||
      !isPublicPagePath(receipt.pageId, receipt.path) || !/^[A-Za-z0-9]{20}$/.test(receipt.operationId) ||
      !Number.isSafeInteger(receipt.sourceVersion) || receipt.sourceVersion < 1 ||
      !Number.isSafeInteger(receipt.codeGeneration) || receipt.codeGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(receipt.snapshotDigest) || !/^[a-f0-9]{64}$/.test(receipt.contextDigest) ||
      datasetFiguresDigest !== undefined && !/^[a-f0-9]{64}$/.test(datasetFiguresDigest) ||
      typeof receipt.visible !== "boolean" || !Array.isArray(receipt.ownedPaths) ||
      !receipt.ownedPaths.includes(receipt.path) || receipt.ownedPaths.length > maxPaths ||
      !(Number.isSafeInteger(receipt.admissionRevision) && receipt.admissionRevision! > 0 ||
        reply.kind === "gone" && receipt.admissionRevision === null)) throw new Error("Invalid Page receipt");
  return new Headers({ ...SECURITY_HEADER_BASELINE, "cache-control": "no-store",
    "x-njpbs-content-source": "cms-page-no-build", "x-njpbs-source-version": String(receipt.sourceVersion),
    "x-njpbs-publication-operation": receipt.operationId, "x-njpbs-renderer-sha": rendererSha,
    "x-njpbs-context-sha256": receipt.contextDigest, "x-njpbs-snapshot-sha256": receipt.snapshotDigest,
    "x-njpbs-code-generation": String(receipt.codeGeneration),
    ...(datasetFiguresDigest ? { "x-njpbs-dataset-figures-sha256": datasetFiguresDigest } : {}),
    "x-njpbs-admission-revision": String(receipt.admissionRevision ?? "unavailable"),
    "access-control-allow-origin": adminOrigin,
    "access-control-expose-headers": "x-njpbs-content-source, x-njpbs-source-version, x-njpbs-publication-operation, x-njpbs-renderer-sha, x-njpbs-context-sha256, x-njpbs-snapshot-sha256, x-njpbs-dataset-figures-sha256, x-njpbs-input-sha256, x-njpbs-record-source-sha256, x-njpbs-schedule-receipt-sha256, x-njpbs-html-sha256, x-njpbs-admission-revision, x-njpbs-home-refresh-revision, x-njpbs-durable-withdrawal-operation, x-njpbs-withdrawal-revision",
    ...(receipt.pageId === "home" ? { "x-njpbs-home-refresh-revision": String(receipt.homeRefreshRevision) } : {}),
  });
}

async function baselineHomeSources(reply: NoBuildPageReply, fetchAsset: (request: Request) => Promise<Response>, target: PublicationTarget): Promise<HomeSourceSnapshot> {
  async function read(path: string) {
    const response = await fetchAsset(new Request(`${target.origin}${path}`));
    if (response.status !== 200 || !response.body) throw new Error("Home baseline unavailable");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > HOME_BASELINE_MAX_BYTES) throw new Error("Home baseline exceeds its bound");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const [publication, sources] = await Promise.all([read("/_publication.json"), read("/_home-sources.json")]);
  const identity = reply.receipt ?? reply.contextReceipt;
  if (publication.schemaVersion !== 1 || publication.generation !== identity?.codeGeneration ||
      publication.commitSha !== identity?.rendererSha) throw new Error("Home baseline code identity differs");
  return readHomeSourceSnapshot(sources, publication);
}

/** Home can reuse a bounded, purge-witnessed authority lease. Other Page hits
 * and misses read current origin authority; guarded fallback keeps outages readable. */
export function createNoBuildPageWorker(deps: {
  target?: PublicationTarget; rendererSha: string; rendererReady: boolean; cache: Pick<Cache, "match" | "put">;
  getDecision(path: string, method: string): Promise<NoBuildPageReply>;
  render(content: PublishedPageContent): Promise<string>; now?: () => Date;
  renderContext?(content: PublicPageContextContent): Promise<string>;
  fetchAsset(request: Request): Promise<Response>;
  readWithdrawal?(path: string): Promise<PageWithdrawal | null>;
  withdrawalsOnly?: boolean;
  lastGood?: PublicContentLastGood;
  waitUntil?(task: Promise<unknown>): void;
}) {
  const target = assertPublicationTarget(deps.target ?? publicationTarget("development"));
  const nowMs = () => deps.now?.().getTime() ?? Date.now();
  const responseCache = createPublicPageResponseCache({ cache: deps.cache, target, rendererSha: deps.rendererSha, now: nowMs });
  const adminOrigin = target.environment === "development" ? "https://dev-admin.example.org" : "https://admin.njpbs.org";
  if (!/^[a-f0-9]{40}$/.test(deps.rendererSha)) throw new Error("Invalid Page renderer release");
  function retain(request: Request, response: Response): Response {
    if (deps.lastGood && deps.waitUntil) deps.waitUntil(deps.lastGood.store(request, response)
      .catch(error => { reportLastGoodRetentionFailure("page-store", error); }));
    return response;
  }
  async function fallback(request: Request,
    measure = async <T>(_phase: string, work: () => Promise<T>): Promise<T> => work()): Promise<Response> {
    const path = pagePath(new URL(request.url).pathname);
    if (["GET", "HEAD"].includes(request.method) && deps.readWithdrawal && path) {
      // Static copies predate later withdrawals. Unknown durable state never
      // authorizes a last-good or Assets copy of a withdrawable Page path.
      const known = () => measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500)).then(
        latest => ({ latest }), () => null);
      const first = await known();
      if (!first) return unavailable(request.method === "HEAD");
      if (first.latest) return durableGone(first.latest);
      if (deps.lastGood) {
        let retained: Response | null | undefined;
        try {
          const generation = await bounded(readAssetCodeGeneration(deps.fetchAsset, target, deps.rendererSha), 500);
          retained = await bounded(deps.lastGood.read(request, generation), 500);
        } catch { /* Last-good storage failure keeps the Assets copy. */ }
        if (retained) {
          // Read withdrawal state again after storage I/O.
          const current = await known();
          if (!current) return unavailable(request.method === "HEAD");
          return current.latest ? durableGone(current.latest) : retained;
        }
      }
    }
    const response = await deps.fetchAsset(request);
    const headers = new Headers(response.headers);
    // Assets bytes cannot inherit an editorial receipt or complete a queue.
    for (const name of [...headers.keys()]) if (name.startsWith("x-njpbs-")) headers.delete(name);
    headers.set("cache-control", "no-store");
    headers.set("x-njpbs-content-source", "assets");
    headers.set("x-njpbs-publication-refresh", "pending");
    headers.set("retry-after", "1");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  }
  return { async fetch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.origin !== target.origin) return null;
    const head = request.method === "HEAD";
    let parsedPath;
    try { parsedPath = pagePath(url.pathname); } catch { return unavailable(head, 404); }
    if (!parsedPath) return null;
    const path = parsedPath;
    if (isPageScheduleExportPath(path)) {
      const query = [...url.searchParams];
      const adminRefresh = path === "/_schedule-sources.json" && query.length === 1 &&
        query[0][0] === "cms-schedule" && /^[a-z0-9]{1,32}$/.test(query[0][1]);
      const refreshQuery = query.length === 1 && query[0][0] === "_njpbs_refresh" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(query[0][1]);
      const validQuery = query.length === 0 || adminRefresh || refreshQuery;
      if (url.pathname !== path || !validQuery) return unavailable(head, 404);
      if (!["GET", "HEAD"].includes(request.method)) return unavailable(false, 405);
      if (!deps.rendererReady || deps.withdrawalsOnly) return null;
      try {
        const reply = await bounded(deps.getDecision(path, head ? "HEAD" : "GET"));
        const receipt = reply.scheduleReceipt;
        if (reply.kind !== "schedule-export" || reply.path !== path || reply.receipt || reply.contextReceipt ||
            !receipt || receipt.schemaVersion !== 1 || receipt.code.commitSha !== deps.rendererSha ||
            !Number.isSafeInteger(receipt.code.generation) || receipt.code.generation < 1 ||
            receipt.code.schemaVersion !== 1 || receipt.code.digestAlgorithm !== "sha256" ||
            [receipt.code.artifactDigest, receipt.code.artifactReceiptDigest, receipt.code.mediaManifestDigest,
              receipt.code.contextDigest].some(value => !/^[a-f0-9]{64}$/.test(value)) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.code.buildBatchId) ||
            !Number.isSafeInteger(receipt.contextRevision) || receipt.contextRevision < 1 ||
            receipt.contextDigest !== await digest(`njpbs-public-context-v1:${receipt.contextRevision}`) ||
            receipt.source.runtime.owner !== "cloudflare" || !/^[a-f0-9]{40}$/.test(receipt.source.runtime.release) ||
            !/^[A-Za-z0-9]{20}$/.test(receipt.source.operationId) ||
            !/^[a-f0-9]{64}$/.test(receipt.source.contentDigest) || !/^[a-f0-9]{64}$/.test(receipt.source.scheduleDigest) ||
            !Number.isSafeInteger(receipt.source.checkedAt) || receipt.source.checkedAt < 1 ||
            receipt.exportedAt !== new Date(receipt.source.checkedAt).toISOString() ||
            !Number.isFinite(Date.parse(receipt.generatedAt)) || Date.parse(receipt.generatedAt) > receipt.source.checkedAt ||
            typeof reply.bytes !== "string" || reply.bytes.length > Math.ceil(16 * 1024 * 1024 / 3) * 4) {
          throw new Error("Invalid Page schedule receipt");
        }
        for (const [seal, type] of [[receipt.rawJson, "application/json"], [receipt.retainedPdf, "application/pdf"],
          [receipt.projectionJson, "application/json; charset=utf-8"]] as const) {
          if (!seal || !/^[a-f0-9]{64}$/.test(seal.digest) || !Number.isSafeInteger(seal.size) ||
              seal.size < 1 || seal.size > 16 * 1024 * 1024 || seal.contentType !== type) throw new Error("Invalid schedule file seal");
        }
        const bytes = Uint8Array.from(atob(reply.bytes), value => value.charCodeAt(0));
        const json = path === "/_schedule-sources.json";
        const seal = json ? receipt.projectionJson : receipt.retainedPdf;
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          value => value.toString(16).padStart(2, "0")).join("");
        if (bytes.length !== seal.size || hash !== seal.digest) throw new Error("Schedule export bytes differ");
        if (json) {
          const snapshot = readScheduleSourceSnapshot(JSON.parse(new TextDecoder().decode(bytes)), { schemaVersion: 1,
            buildBatchId: receipt.code.buildBatchId, generation: receipt.code.generation, commitSha: receipt.code.commitSha });
          if (snapshot.checkedAt !== receipt.generatedAt) throw new Error("Schedule projection source differs");
        } else if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Invalid retained schedule PDF");
        const current = await bounded(deps.getDecision(path, head ? "HEAD" : "GET"));
        if (JSON.stringify(current) !== JSON.stringify(reply)) throw new Error("Page schedule authority moved");
        return new Response(head ? null : bytes, { headers: { ...SECURITY_HEADER_BASELINE,
          "cache-control": "no-store", "content-type": seal.contentType,
          "x-njpbs-content-source": "cms-page-schedule", "x-njpbs-renderer-sha": deps.rendererSha,
          "access-control-allow-origin": adminOrigin,
          "access-control-expose-headers": "x-njpbs-renderer-sha, x-njpbs-public-context-revision, x-njpbs-context-sha256, x-njpbs-code-generation, x-njpbs-raw-schedule-sha256, x-njpbs-schedule-projection-sha256, x-njpbs-schedule-pdf-sha256, x-njpbs-schedule-exported-at",
          "x-njpbs-public-context-revision": String(receipt.contextRevision), "x-njpbs-context-sha256": receipt.contextDigest,
          "x-njpbs-code-generation": String(receipt.code.generation), "x-njpbs-raw-schedule-sha256": receipt.rawJson.digest,
          "x-njpbs-schedule-projection-sha256": receipt.projectionJson.digest,
          "x-njpbs-schedule-pdf-sha256": receipt.retainedPdf.digest, "x-njpbs-schedule-exported-at": receipt.exportedAt,
        } });
      } catch { return null; }
    }
    const publicPageRequest = ["GET", "HEAD"].includes(request.method) && path !== "/_home-sources.json";
    const phases = ["decision", "render", "recheck", "withdrawal", "fallback"] as const;
    const durations = new Map<string, number>();
    let renderStarted: number | null = null;
    function finishRender() {
      if (renderStarted === null) return;
      durations.set("render", (durations.get("render") ?? 0) + Math.max(0, Date.now() - renderStarted));
      renderStarted = null;
    }
    async function measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
      if (phase === "recheck") finishRender();
      const started = Date.now();
      try { return await work(); }
      finally { durations.set(phase, (durations.get(phase) ?? 0) + Math.max(0, Date.now() - started)); }
    }
    const pageFallback = () => {
      finishRender();
      return measure("fallback", () => fallback(request, measure));
    };
    async function serve(): Promise<Response | null> {
      let deadline = Infinity;
      // Cache I/O is optional: at most 100 ms per request, outside the
      // editorial render/recheck budget. A miss cannot revoke authority.
      let cacheMilliseconds = 100;
      async function cacheWork<T>(work: () => Promise<T>): Promise<T | undefined> {
        if (cacheMilliseconds <= 0 || Date.now() >= deadline) return;
        const started = Date.now();
        try { return await bounded(work(), Math.max(0, started + cacheMilliseconds - Date.now())); }
        catch { return undefined; } // Cache failure never changes editorial authority.
        finally {
          const spent = Math.min(cacheMilliseconds, Math.max(0, Date.now() - started));
          cacheMilliseconds -= spent;
          if (Number.isFinite(deadline)) deadline += spent;
        }
      }
      function wait<T>(work: () => Promise<T>): Promise<T> {
        checkBudget();
        return bounded(work(), Math.min(10_000, deadline - Date.now()));
      }
      function checkBudget() {
        if (Date.now() >= deadline) throw new Error("Page request budget exhausted");
      }
      let withdrawal: PageWithdrawal | null = null, withdrawalKnown = true;
      if (["GET", "HEAD"].includes(request.method) && deps.readWithdrawal) {
        try { withdrawal = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500)); }
        catch { withdrawalKnown = false; } // Fresh authority may still decide; static copies may not.
      }
      if (deps.withdrawalsOnly && !withdrawalKnown) return unavailable(head);
      if (deps.withdrawalsOnly && !withdrawal) return null;
      // The binding is a compiled-code capability marker, never admission. An
      // older dev release has no Page lane and keeps its frozen Assets contract.
      if (!deps.rendererReady) return withdrawal ? durableGone(withdrawal) : pageFallback();
      async function servingRefusal(reply: NoBuildPageReply): Promise<Response | null> {
        if (withdrawal) return durableGone(withdrawal);
        if (reply.kind === "schedule-unavailable") return pageFallback();
        if (deps.readWithdrawal) {
          try {
            const latest = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500));
            if (latest) return durableGone(latest);
          } catch { /* Unknown storage keeps the existing pass-through contract. */ }
        }
        return null;
      }
      try {
        // Read or discard the cache candidate before the fresh origin check.
        // A hit has no render window for an unnoticed authority change.
        const canCacheResponse = target.environment === "production" && cacheablePageRequest(request, path);
        const candidate = canCacheResponse ? await measure("decision", () => cacheWork(() => responseCache.read(path))) : undefined;
        // Home shares Posts' witnessed ten-second edge freshness. Private,
        // query-bearing and explicit revalidation requests still read origin.
        const anonymousHome = canCacheResponse && path === "/" && !!deps.readWithdrawal &&
          !request.headers.get("cache-control")?.match(/no-cache|no-store|max-age=0/i);
        if (anonymousHome && candidate && withdrawalKnown && !withdrawal &&
            await cacheWork(() => responseCache.freshHome(candidate))) {
          try {
            const latest = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500));
            if (!latest && await cacheWork(() => responseCache.freshHome(candidate))) return candidate.response;
          } catch { /* Unknown withdrawal authority requires a fresh origin decision. */ }
        }
        const homeFence = anonymousHome ? await cacheWork(() => responseCache.beginHome()) : undefined;
        // Keep the first lookup's 10 s allowance for cold cmsGetPublicPage
        // instances. Bound rendering and all later reads after it succeeds.
        let reply = await measure("decision", () => wait(() => deps.getDecision(path, head ? "HEAD" : "GET")));
        if (publicPageRequest) deadline = Date.now() + PUBLIC_PAGE_WAIT_MS;
        // Continuous publishing is valid authority. After three renders, keep
        // the newest completed bytes rather than an older last-good/Assets copy.
        // A changed withdrawal/redirect may take one final terminal-only pass.
        for (let attempt = 0; attempt <= MAX_PAGE_RENDER_ATTEMPTS; attempt++) {
          checkBudget();
          const canCacheBody = canCacheResponse && !["schedule", "live"].includes(reply.receipt?.pageId ??
            (reply.renderContext as { pageId?: string })?.pageId ?? "");
          if (withdrawal && !outranksWithdrawal(reply, withdrawal, path)) return durableGone(withdrawal);
          if (candidate && await cacheWork(() => responseCache.matches(candidate, reply))) {
            if ((reply.receipt || attempt > 0) && deps.readWithdrawal) {
              let latest: PageWithdrawal | null = null;
              try { latest = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500)); } catch { /* Known absence still wins. */ }
              if (withdrawal && !latest) return durableGone(withdrawal);
              if (latest && !outranksWithdrawal(reply, latest, path)) return durableGone(latest);
            }
            if (candidate.expiresAt > nowMs() && cacheablePageDecision(reply, nowMs())) {
              if (homeFence) await cacheWork(() => responseCache.qualifyHome(reply, homeFence));
              return candidate.response;
            }
          }
          if (reply.kind === "schedule-unavailable") return pageFallback();
          if (reply.kind === "pass") return null;
          if (!["GET", "HEAD"].includes(request.method)) return unavailable(false, 405);
          renderStarted = Date.now();
          if (reply.contextReceipt) {
            const receipt = reply.contextReceipt;
            const canonical = path === "/_home-sources.json" ? "/" : path;
            if (receipt.rendererSha !== deps.rendererSha || receipt.path !== canonical ||
                !Number.isSafeInteger(receipt.contextRevision) || receipt.contextRevision < 1 ||
                !Number.isSafeInteger(receipt.codeGeneration) || receipt.codeGeneration < 1 ||
                !/^[a-f0-9]{64}$/.test(receipt.contextDigest) || !["cms", "site"].includes(receipt.source) ||
                receipt.source === "cms" && (!Number.isSafeInteger(receipt.sourceVersion) || receipt.sourceVersion! < 1) ||
                receipt.source === "site" && receipt.sourceVersion !== undefined || reply.receipt) throw new Error("Invalid Page context receipt");
            if (reply.kind === "context-home-sources") {
              // Before transfer, the picker keeps the existing code catalog and
              // its registered digest. A context frame is no editorial operation.
              const sources = await wait(() => baselineHomeSources(reply, deps.fetchAsset, target));
              const current = await measure("recheck", () => wait(() => deps.getDecision(path, head ? "HEAD" : "GET")));
              if (pageDecisionIdentity(current) !== pageDecisionIdentity(reply)) return pageFallback();
              return new Response(head ? null : JSON.stringify(sources), { headers: {
                ...SECURITY_HEADER_BASELINE, "cache-control": "no-store", "content-type": "application/json",
                "x-njpbs-content-source": "assets", "access-control-allow-origin": adminOrigin,
                "x-njpbs-html-sha256": await digest(JSON.stringify(sources)),
              } });
            }
            const headers = new Headers({ ...SECURITY_HEADER_BASELINE, "cache-control": "no-store",
              "x-njpbs-content-source": "cms-page-context", "x-njpbs-renderer-sha": deps.rendererSha,
              "x-njpbs-context-sha256": receipt.contextDigest, "x-njpbs-public-context-revision": String(receipt.contextRevision),
              "x-njpbs-code-generation": String(receipt.codeGeneration), "x-njpbs-page-path": receipt.path,
              "access-control-allow-origin": adminOrigin,
              ...(receipt.sourceVersion !== undefined ? { "x-njpbs-source-version": String(receipt.sourceVersion) } : {}) });
            let body: string | null = null;
            let status: number;
            if (reply.kind === "redirect" && reply.location && /^\/[a-z0-9-]+\/$/.test(reply.location) && reply.location !== path) {
              status = 308; headers.set("location", reply.location);
            } else if (reply.kind === "gone" && canonical !== "/") {
              status = 410; headers.set("x-robots-tag", "noindex, nofollow");
            } else if (reply.kind === "context-page") {
              const homeSources = canonical === "/" ? reply.homeSources ?? (deps.fetchAsset
                ? await wait(() => baselineHomeSources(reply, deps.fetchAsset, target)) : undefined) : undefined;
              const content = await wait(() => projectPublicPageContextRead(reply.renderContext, deps.rendererSha,
                deps.now?.() ?? new Date(), { homeSources: homeSources ?? undefined }));
              if (content.target.pagePath !== canonical || content.target.contextRevision !== receipt.contextRevision ||
                  content.target.contextDigest !== receipt.contextDigest || content.target.codeGeneration !== receipt.codeGeneration ||
                  content.target.source !== receipt.source || content.target.sourceVersion !== receipt.sourceVersion) throw new Error("Page context changed");
              const outbound = content.pages[0] && contentLinkRedirect(content.pages[0], headers);
              if (outbound) {
                const recordSourceDigest = await digest(sourcePayload.recordSourceBindingPayload(reply.renderContext));
                headers.set("x-njpbs-record-source-sha256", recordSourceDigest);
                headers.set("x-njpbs-input-sha256", await digest(JSON.stringify({ content, recordSourceDigest })));
                if (content.schedule) headers.set("x-njpbs-schedule-receipt-sha256", await digest(JSON.stringify(content.schedule.receipt)));
                status = 302;
                headers.set("location", outbound.headers.get("location")!);
                headers.set("x-robots-tag", "noindex, nofollow");
              } else {
                const recordSourceDigest = await digest(sourcePayload.recordSourceBindingPayload(reply.renderContext));
                const inputDigest = await digest(JSON.stringify({ content, recordSourceDigest }));
                const key = new Request(`${target.origin}${path}?__page_context=${await digest(JSON.stringify([receipt, inputDigest]))}`);
                const cacheable = canCacheBody;
                const cached = cacheable ? await cacheWork(() => deps.cache.match(key)) : undefined;
                const cachedBody = cached ? await cacheWork(() => cached.text()) : undefined;
                body = cachedBody ?? (deps.renderContext ? await wait(() => deps.renderContext!(content)) : null);
                if (body === null || new TextEncoder().encode(body).length > PUBLIC_PAGE_HTML_MAX_BYTES ||
                    (!/^\s*<!doctype html>/i.test(body) || !/<\/html>/i.test(body))) throw new Error("Incomplete context Page");
                if (cachedBody === undefined && cacheable) await cacheWork(() => deps.cache.put(key, new Response(body)));
                headers.set("content-type", "text/html; charset=utf-8");
                headers.set("x-njpbs-input-sha256", inputDigest);
                headers.set("x-njpbs-record-source-sha256", recordSourceDigest); headers.set("x-njpbs-html-sha256", await digest(body));
                if (content.schedule) headers.set("x-njpbs-schedule-receipt-sha256", await digest(JSON.stringify(content.schedule.receipt)));
                status = 200;
              }
            } else throw new Error("Invalid context Page decision");
            const response = new Response(head ? null : body, { status, headers });
            const prepared = canCacheResponse ? await cacheWork(() => responseCache.store(path, reply, response.clone())) ?? response : response;
            const current = await measure("recheck", () => wait(() => deps.getDecision(path, head ? "HEAD" : "GET")));
            if (publicPageRequest && ["pass", "schedule-unavailable"].includes(current.kind)) return servingRefusal(current);
            const authorityUnchanged = pageDecisionIdentity(current) === pageDecisionIdentity(reply);
            if (!authorityUnchanged) {
              if (!publicPageRequest) throw new Error("Page context authority changed");
              if (attempt + 1 < MAX_PAGE_RENDER_ATTEMPTS || attempt < MAX_PAGE_RENDER_ATTEMPTS &&
                  ["gone", "alias", "redirect"].includes(current.kind)) {
                reply = current;
                continue;
              }
            }
            if (deps.readWithdrawal) {
              let latest: PageWithdrawal | null = null;
              try { latest = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500)); }
              catch { /* Keep the same known-withdrawal policy as receipt Pages. */ }
              if (withdrawal && !latest) return durableGone(withdrawal);
              if (latest && !outranksWithdrawal(reply, latest, path)) return durableGone(latest);
            }
            if (authorityUnchanged && homeFence) await cacheWork(() => responseCache.qualifyHome(reply, homeFence));
            return authorityUnchanged ? retain(request, prepared) : prepared;
          }
          const headers = receiptHeaders(reply, deps.rendererSha, adminOrigin);
          if (!reply.receipt!.ownedPaths.includes(path)) throw new Error("Unowned Page route");
          const now = deps.now?.() ?? new Date();
          let body: string | null = null;
          let status: number;
          if (reply.kind === "gone" && !reply.receipt!.visible && reply.receipt!.pageId !== "home") status = 410;
          else if (reply.kind === "alias" && reply.receipt!.visible && reply.location === reply.receipt!.path && path !== reply.location) {
            status = 308; headers.set("location", reply.location);
          } else if (["page", "home-sources"].includes(reply.kind) && reply.receipt!.visible) {
            const homeSources = reply.needsBaseline && reply.receipt!.pageId === "home" && deps.fetchAsset
              ? await wait(() => baselineHomeSources(reply, deps.fetchAsset, target)) : reply.homeSources;
            const publication = reply.receipt!.pageId === "home" ? reply.publication ?? {
              buildBatchId: reply.receipt!.operationId, generation: reply.receipt!.generation, commitSha: deps.rendererSha,
            } : undefined;
            const content = await wait(() => projectPublishedPageRead(reply.published, reply.receipt!.pageId, deps.rendererSha, now,
              homeSources ?? undefined, publication));
            if (content.target.sourceVersion !== reply.receipt!.sourceVersion || content.target.pagePath !== reply.receipt!.path ||
                content.target.contextDigest !== reply.receipt!.contextDigest) throw new Error("Page render identity changed");
            const outbound = reply.kind === "page" ? contentLinkRedirect(content.pages[0], headers) : null;
            if (outbound) {
              const recordSourceDigest = await digest(sourcePayload.recordSourceBindingPayload(reply.published));
              headers.set("x-njpbs-record-source-sha256", recordSourceDigest);
              headers.set("x-njpbs-input-sha256", await digest(JSON.stringify({ content, recordSourceDigest })));
              if (content.schedule) headers.set("x-njpbs-schedule-receipt-sha256", await digest(JSON.stringify(content.schedule.receipt)));
              status = 302;
              headers.set("location", outbound.headers.get("location")!);
              headers.set("x-robots-tag", "noindex, nofollow");
            } else {
              const recordSourceDigest = await digest(sourcePayload.recordSourceBindingPayload(reply.published));
              const inputDigest = await digest(JSON.stringify({ content, recordSourceDigest }));
              const key = new Request(`${target.origin}${path}?__page_render=${await digest(JSON.stringify([reply.receipt, inputDigest]))}`);
              const cacheable = canCacheBody;
              const cached = cacheable ? await cacheWork(() => deps.cache.match(key)) : undefined;
              const cachedBody = cached ? await cacheWork(() => cached.text()) : undefined;
              body = cachedBody ?? (reply.kind === "home-sources"
                ? JSON.stringify(content.homeSources) : await wait(() => deps.render(content)));
              const maxBytes = reply.kind === "home-sources" ? HOME_BASELINE_MAX_BYTES : PUBLIC_PAGE_HTML_MAX_BYTES;
              if (new TextEncoder().encode(body).length > maxBytes ||
                  reply.kind === "page" && (!/^\s*<!doctype html>/i.test(body) || !/<\/html>/i.test(body))) throw new Error("Incomplete Page render");
              if (cachedBody === undefined && cacheable) await cacheWork(() => deps.cache.put(key, new Response(body)));
              headers.set("content-type", reply.kind === "home-sources" ? "application/json" : "text/html; charset=utf-8");
              headers.set("x-njpbs-input-sha256", inputDigest);
              headers.set("x-njpbs-record-source-sha256", recordSourceDigest);
              if (content.schedule) headers.set("x-njpbs-schedule-receipt-sha256", await digest(JSON.stringify(content.schedule.receipt)));
              headers.set("x-njpbs-html-sha256", await digest(body));
              status = 200;
            }
          } else throw new Error("Invalid Page decision");
          const prepared = canCacheResponse && status === 200
            ? await cacheWork(() => responseCache.store(path, reply, new Response(body, { status, headers }))) : null;
          const current = await measure("recheck", () => wait(() => deps.getDecision(path, head ? "HEAD" : "GET")));
          if (publicPageRequest && ["pass", "schedule-unavailable"].includes(current.kind)) return servingRefusal(current);
          const authorityUnchanged = pageDecisionIdentity(current) === pageDecisionIdentity(reply);
          if (!authorityUnchanged) {
            if (!publicPageRequest) throw new Error("Page authority changed");
            if (attempt + 1 < MAX_PAGE_RENDER_ATTEMPTS || attempt < MAX_PAGE_RENDER_ATTEMPTS &&
                ["gone", "alias", "redirect"].includes(current.kind)) {
              reply = current;
              continue;
            }
          }
          if (deps.readWithdrawal) {
            let latest: PageWithdrawal | null = null;
            try { latest = await measure("withdrawal", () => bounded(deps.readWithdrawal!(path), 500)); }
            catch { /* A known tombstone still wins; unknown storage follows Post failure behavior. */ }
            if (withdrawal && !latest) return durableGone(withdrawal);
            if (latest && !outranksWithdrawal(reply, latest, path)) return durableGone(latest);
            if (latest && !reply.receipt!.visible && latest.operationId === reply.receipt!.operationId &&
                latest.revision === reply.receipt!.operationGeneration && latest.sourceVersion === reply.receipt!.sourceVersion) {
              headers.set("x-njpbs-durable-withdrawal-operation", latest.operationId);
              headers.set("x-njpbs-withdrawal-revision", String(latest.revision));
            }
          }
          const response = prepared ?? new Response(head ? null : body, { status, headers });
          if (authorityUnchanged && homeFence) await cacheWork(() => responseCache.qualifyHome(reply, homeFence));
          return authorityUnchanged ? retain(request, response) : response;
        }
        throw new Error("Page render attempts exhausted");
      } catch { return withdrawal ? durableGone(withdrawal) : pageFallback(); }
    }
    const response = await serve();
    if (!response || !publicPageRequest) return response;
    const headers = new Headers(response.headers);
    headers.set("server-timing", phases.map(phase => `${phase};dur=${(durations.get(phase) ?? 0).toFixed(1)}`).join(", "));
    return new Response(response.body, { status: response.status, headers });
  } };
}

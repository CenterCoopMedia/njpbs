import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { AUTHORITY_BUDGET_MS, ROUTING_FRESH_MS, ROOT_RECEIPT_PATH, bytesDigest, canonicalReleaseValue,
  matchesSelectedPair, originFor, parseSelectorReceipt, releaseDigest, stripInternalHeaders,
  type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";

export type PairProofEvidence = { epoch: number; pairId: string; manifestDigest: string; operationId: string;
  sourceVersion: number; snapshotDigest: string; rendererSha: string; bodyDigest: string };
export type SlotReply = { kind: "response"; response: Response; evidence?: PairProofEvidence } | { kind: "reselect" };
export type PublicSlot = { identity: PublicReleasePair; serve(request: Request, selection: SelectorReceipt, proof?: boolean, budgetMs?: number): Promise<SlotReply> };
type ReadSelector = (signal: AbortSignal, proof?: boolean, budgetMs?: number) => Promise<SelectorReceipt>;
export type RoutingEvent = "isolate-start" | "request" | "cache-hit" | "refresh" | "refresh-complete" | "refresh-join" | "refresh-failed" | "invalidation" | "reselection" | "proof";
type Observe = (event: RoutingEvent, durationMs?: number) => void;
const unavailable = () => new Error("Public release authority is unavailable");

async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  if (milliseconds <= 0) throw unavailable();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Per-isolate single flight. No periodic work, KV authority or stale refresh lease. */
export function createSelectorCache({ environment, readSelector, now = () => performance.now(), observe = () => {} }: {
  environment: SelectorReceipt["environment"]; readSelector: ReadSelector; now?: () => number; observe?: Observe;
}) {
  let cached: { receipt: SelectorReceipt; startedAt: number; expiresAt: number } | undefined;
  type SharedRead = { deadline: number; promise: Promise<SelectorReceipt> };
  let pending: SharedRead | undefined;
  const forcedBatches = new Map<boolean, SharedRead & { started: boolean }>();
  let minimumEpoch = 0;
  let latestContextSequence = -1;
  const fresh = async (proof = false, deadline = now() + AUTHORITY_BUDGET_MS) => {
    const started = now(); observe("refresh");
    try {
      if (!Number.isFinite(deadline) || deadline <= started) throw unavailable();
      const value = parseSelectorReceipt(await bounded(signal => {
        const remaining = Math.floor(deadline - now());
        if (remaining < 1) throw unavailable();
        return readSelector(signal, proof, remaining);
      }, deadline - started), environment);
      if (now() < started || now() >= started + ROUTING_FRESH_MS || value.selector.epoch < minimumEpoch ||
          value.selector.epoch === minimumEpoch && value.selector.contentHead.contextSequence < latestContextSequence) throw unavailable();
      latestContextSequence = value.selector.epoch > minimumEpoch ? value.selector.contentHead.contextSequence : Math.max(latestContextSequence, value.selector.contentHead.contextSequence);
      minimumEpoch = value.selector.epoch;
      observe("refresh-complete", now() - started);
      return { receipt: value, startedAt: started, expiresAt: started + ROUTING_FRESH_MS };
    } catch { observe("refresh-failed", now() - started); throw unavailable(); }
  };
  const get = async (force = false, proof = false, budgetMs = AUTHORITY_BUDGET_MS): Promise<SelectorReceipt> => {
    const deadline = now() + Math.min(AUTHORITY_BUDGET_MS, budgetMs);
    if (!Number.isFinite(budgetMs) || !Number.isFinite(deadline) || deadline <= now()) throw unavailable();
    const wait = async (shared: SharedRead): Promise<SelectorReceipt> => {
      try { return await shared.promise; }
      catch (error) {
        // Never extend an in-flight reader's paid authority budget. A later
        // still-live waiter can fund a new single-flight after the shorter
        // read expires. RPC millisecond rounding may expire it <1ms early.
        if (deadline <= shared.deadline || now() + 1 < shared.deadline || now() >= deadline) throw error;
        return get(force, proof, deadline - now());
      }
    };
    if (force) {
      // Only requests admitted before this read starts may share it. Joining
      // an already-running read could certify authority older than a proof.
      const previous = forcedBatches.get(proof);
      if (previous && !previous.started) { observe("refresh-join"); return wait(previous); }
      const batch = { deadline, started: false, promise: undefined as unknown as Promise<SelectorReceipt> };
      batch.promise = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
        batch.started = true; cached = await fresh(proof, deadline); return cached.receipt;
      }).finally(() => { if (forcedBatches.get(proof) === batch) forcedBatches.delete(proof); });
      forcedBatches.set(proof, batch);
      return wait(batch);
    }
    if (cached && now() >= cached.startedAt && now() < cached.expiresAt && cached.receipt.selector.epoch >= minimumEpoch) {
      observe("cache-hit"); return cached.receipt;
    }
    if (pending) { observe("refresh-join"); return wait(pending); }
    const refresh: SharedRead = { deadline, promise: undefined as unknown as Promise<SelectorReceipt> };
    refresh.promise = fresh(false, deadline).then(value => { cached = value; return value.receipt; }).finally(() => { if (pending === refresh) pending = undefined; });
    pending = refresh;
    return wait(refresh);
  };
  return {
    get,
    invalidate(epoch: number) {
      if (!Number.isSafeInteger(epoch) || epoch <= minimumEpoch || epoch <= (cached?.receipt.selector.epoch ?? 0)) return;
      minimumEpoch = epoch; latestContextSequence = -1; cached = undefined; pending = undefined; observe("invalidation");
    },
  };
}

function publicResponse(request: Request, response: Response, pending = false): Response {
  const headers = stripInternalHeaders(response.headers);
  headers.set("cache-control", "no-store");
  if (pending) headers.set("publication-refresh", "pending");
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
const errorResponse = (status = 503) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export function createPublicReleaseRouter({ environment, slots, readSelector, bootstrapPairId, readRecovery, serveRecovery, admitAuthority,
  now = () => performance.now(), observe = () => {} }: {
  environment: SelectorReceipt["environment"]; slots: PublicSlot[]; readSelector: ReadSelector;
  admitAuthority?: (signal: AbortSignal, budgetMs: number) => Promise<void>;
  /** Required in the first-install packet. A selector naming anything else refuses. */
  bootstrapPairId?: string;
  /** Recovery is advisory; the slot must verify retained identity, bytes and current durable withdrawals. */
  readRecovery?: (signal: AbortSignal) => Promise<SelectorReceipt | null>;
  serveRecovery?: (request: Request, receipt: SelectorReceipt, signal: AbortSignal) => Promise<Response | null>;
  now?: () => number; observe?: Observe;
}) {
  if (slots.length !== 2 || slots[0].identity.pairId === slots[1].identity.pairId) throw unavailable();
  const cache = createSelectorCache({ environment, readSelector, now, observe });
  let recovery: SelectorReceipt | undefined;
  observe("isolate-start");
  const slotFor = (receipt: SelectorReceipt) => {
    const slot = slots.find(candidate => matchesSelectedPair(candidate.identity, receipt));
    if (!slot || bootstrapPairId && slot.identity.pairId !== bootstrapPairId) throw unavailable();
    return slot;
  };
  const validRequest = (request: Request) => new URL(request.url).origin === originFor(environment);
  const safeRecovery = async (request: Request, deadline: number): Promise<Response> => {
    if (!serveRecovery || new URL(request.url).pathname === ROOT_RECEIPT_PATH) return errorResponse();
    try {
      const remaining = deadline - now();
      // Recovery gets only the request's remaining budget, never a fresh timeout.
      return await bounded(async signal => {
        const value = recovery ?? await readRecovery?.(signal);
        if (!value) return errorResponse();
        const receipt = parseSelectorReceipt(value, environment); slotFor(receipt);
        const response = await serveRecovery(request, receipt, signal);
        return response ? publicResponse(request, response, true) : errorResponse();
      }, remaining);
    } catch { return errorResponse(); }
  };
  const select = async (deadline: number, force = false, proof = false) => {
    const receipt = await bounded(() => cache.get(force, proof, deadline - now()), deadline - now());
    slotFor(receipt); recovery = receipt;
    return receipt;
  };
  return {
    invalidate: cache.invalidate,
    async fetch(viewerRequest: Request, requestDeadline = now() + AUTHORITY_BUDGET_MS): Promise<Response> {
      if (!validRequest(viewerRequest)) return errorResponse(404);
      if (!["GET", "HEAD"].includes(viewerRequest.method)) return errorResponse(405);
      const deadline = Math.min(now() + AUTHORITY_BUDGET_MS, requestDeadline);
      if (!Number.isFinite(deadline) || deadline <= now()) return errorResponse();
      const routingDeadline = deadline - 750;
      const request = new Request(viewerRequest, { headers: stripInternalHeaders(viewerRequest.headers), redirect: "manual" });
      observe("request");
      try {
        if (admitAuthority) await bounded(signal => admitAuthority(signal, Math.floor(routingDeadline - now())), routingDeadline - now());
        if (new URL(request.url).pathname === ROOT_RECEIPT_PATH) {
          const receipt = await select(deadline, true), slot = slotFor(receipt);
          const body = canonicalReleaseValue({ schemaVersion: 2, environment, epoch: receipt.selector.epoch,
            pair: receipt.selector.selectedPair, codeReceiptDigest: slot.identity.codeAssetManifestDigest,
            contentHead: receipt.selector.contentHead, selectorDigest: await releaseDigest(receipt.selector) });
          return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": "application/json", "cache-control": "no-store",
            "x-njpbs-publication-origin": environment === "production" ? "njpbs-production" : "template-dev-public" } });
        }
        // Leave a bounded storage-only recovery window inside the same budget.
        let receipt = await select(routingDeadline);
        let reply = await bounded(() => slotFor(receipt).serve(request, receipt, false, Math.floor(routingDeadline - now())), routingDeadline - now());
        if (reply.kind === "reselect") {
          observe("reselection"); receipt = await select(routingDeadline, true);
          reply = await bounded(() => slotFor(receipt).serve(request, receipt, false, Math.floor(routingDeadline - now())), routingDeadline - now());
        }
        if (reply.kind !== "response" || !(reply.response instanceof Response)) throw unavailable();
        return publicResponse(request, reply.response);
      } catch { return safeRecovery(request, deadline); }
    },
    /** Private confirmation only. An HTTP header never grants this method. */
    async prove(viewerRequest: Request, expectedBodyDigest: string, expected: { status?: 200 | 302 | 308 | 410 } = {}, requestDeadline = now() + AUTHORITY_BUDGET_MS): Promise<Response> {
      const status = expected.status ?? 200;
      if (!validRequest(viewerRequest) || viewerRequest.method !== "GET" || ![200, 302, 308, 410].includes(status) || !/^[a-f0-9]{64}$/.test(expectedBodyDigest)) return errorResponse();
      const deadline = Math.min(now() + AUTHORITY_BUDGET_MS, requestDeadline);
      if (!Number.isFinite(deadline) || deadline <= now()) return errorResponse();
      const request = new Request(viewerRequest, { headers: stripInternalHeaders(viewerRequest.headers), redirect: "manual" });
      // An exact-byte proof is unconditional and complete.
      for (const name of ["range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"]) request.headers.delete(name);
      observe("proof");
      try {
        const before = await select(deadline, true, true);
        const reply = await bounded(() => slotFor(before).serve(request, before, true, Math.floor(deadline - now())), deadline - now());
        if (reply.kind !== "response" || reply.response.status !== status) throw unavailable();
        const bytes = await bounded(async () => {
          const length = Number(reply.response.headers.get("content-length"));
          if (length > 16 * 1024 * 1024) throw unavailable();
          const reader = reply.response.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
          if (reader) try { for (;;) { const { value, done } = await reader.read(); if (done) break;
            size += value.length; if (size > 16 * 1024 * 1024) throw unavailable(); parts.push(value); } }
          finally { await reader.cancel().catch(() => {}); }
          const result = new Uint8Array(size); let offset = 0;
          for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
        }, deadline - now());
        const after = await select(deadline, true, true);
        if (canonicalReleaseValue(before.selector) !== canonicalReleaseValue(after.selector) || await bytesDigest(bytes) !== expectedBodyDigest) throw unavailable();
        const evidence = reply.evidence;
        if (!evidence || evidence.epoch !== after.selector.epoch || evidence.pairId !== after.selector.selectedPair.pairId ||
            evidence.manifestDigest !== after.selector.contentHead.manifestDigest || evidence.rendererSha !== after.selector.activeCommitSha ||
            evidence.bodyDigest !== expectedBodyDigest || !Number.isSafeInteger(evidence.sourceVersion) || evidence.sourceVersion < 1 ||
            !/^[a-f0-9]{64}$/.test(evidence.snapshotDigest) || !/^[A-Za-z0-9._:-]{1,128}$/.test(evidence.operationId)) throw unavailable();
        const response = publicResponse(request, new Response(bytes, { status, headers: reply.response.headers }));
        response.headers.set("x-njpbs-publication-origin", environment === "production" ? "njpbs-production" : "template-dev-public");
        response.headers.set("x-njpbs-selector-sha256", await releaseDigest(after.selector));
        response.headers.set("x-njpbs-html-sha256", expectedBodyDigest);
        for (const [name, value] of Object.entries({ "x-njpbs-release-epoch": evidence.epoch, "x-njpbs-release-pair": evidence.pairId,
          "x-njpbs-content-head-sha256": evidence.manifestDigest, "x-njpbs-publication-operation": evidence.operationId,
          "x-njpbs-source-version": evidence.sourceVersion, "x-njpbs-snapshot-sha256": evidence.snapshotDigest,
          "x-njpbs-renderer-sha": evidence.rendererSha })) response.headers.set(name, String(value));
        return response;
      } catch { return errorResponse(); }
    },
  };
}

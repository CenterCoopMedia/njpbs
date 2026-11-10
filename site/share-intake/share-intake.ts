import { MIN_DWELL_MS, passesDwell } from "../src/lib/report-form";
import { allowedTurnstileHostname, hashIp, verifyTurnstile } from "../worker/report-intake";
import type { ExpiredReservation, LimitAction, LimitResult } from "./rate-limit";

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const REQUIRED_DWELL_MS = MIN_DWELL_MS;
const DEFAULT_ORIGIN = "https://njpbs.org";
const ROUTES = { "/config": "ugcGetConfig", "/start": "ugcStartSubmission", "/complete": "ugcCompleteSubmission" } as const;

export interface LimitStub {
  apply(input: LimitAction): Promise<LimitResult>;
}

export interface LimitNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LimitStub;
}

export interface Env {
  ALLOWED_ORIGIN?: string;
  FUNCTIONS_BASE_URL?: string;
  CMS_EDGE_ORIGIN_SECRET?: string;
  TURNSTILE_SECRET?: string;
  IP_HASH_SALT?: string;
  RATE_LIMITER?: LimitNamespace;
}

export interface ConfigCache {
  expiresAt: number;
  payload: Record<string, unknown> | null;
}

export interface HandleDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): number;
  configCache?: ConfigCache;
}

function cors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(payload: Record<string, unknown>, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function refusal(admission: Extract<LimitResult, { allowed: false }>, headers: Record<string, string>): Response {
  return json("error" in admission ? { error: admission.error } : { error: "rate_limited", retryAfter: admission.retryAfter }, 429, headers);
}

function configuredBase(env: Env): string | null {
  if (!env.FUNCTIONS_BASE_URL) return null;
  try {
    const url = new URL(env.FUNCTIONS_BASE_URL);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | "too_large" | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return null;
  const length = Number(request.headers.get("Content-Length"));
  if (length > MAX_BODY_BYTES) return "too_large";
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function limit(env: Env, input: LimitAction): Promise<LimitResult> {
  const stub = env.RATE_LIMITER!.get(env.RATE_LIMITER!.idFromName("share-intake"));
  return await stub.apply(input);
}

async function forward(
  endpoint: string,
  body: Record<string, unknown> | null,
  ip: string,
  ipHash: string | null,
  base: string,
  secret: string,
  deps: HandleDeps,
  leaseUntil?: number,
  reconcile = false,
): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  const headers: Record<string, string> = { "x-njpbs-cms-edge": secret, "x-njpbs-client-ip": ip };
  if (reconcile) headers["x-njpbs-quota-reconcile"] = "1";
  const init: RequestInit = { method: body ? "POST" : "GET", headers, redirect: "manual" };
  if (body) {
    headers["Content-Type"] = "application/json";
    const { turnstileToken: _token, website: _website, ...safeBody } = body;
    init.body = JSON.stringify({ ...safeBody, clientIpHash: ipHash });
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (leaseUntil !== undefined) {
    const remaining = leaseUntil - deps.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    init.signal = controller.signal;
    timeout = setTimeout(() => controller.abort(), remaining);
  }
  try {
    const res = await deps.fetch(new URL(endpoint, base).href, init);
    if (res.status < 200 || res.status >= 600 || res.status >= 300 && res.status < 400) return null;
    const payload: unknown = await res.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { status: res.status, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function reconcileReservations(
  reservations: ExpiredReservation[], env: Env, deps: HandleDeps, base: string, ip: string,
): Promise<boolean> {
  const results = await Promise.all(reservations.map(async (reservation) => {
    try {
      const claim = await limit(env, { action: "claim_reconcile", ...reservation, now: deps.now() });
      if (!claim.allowed || !claim.reconciliation) return false;
      const result = await forward(ROUTES["/complete"], {
        requestId: reservation.requestId, submissionId: reservation.submissionId,
      }, ip, reservation.ipHash, base, env.CMS_EDGE_ORIGIN_SECRET!, deps, claim.reconciliation.leaseUntil, true);
      const bytes = result?.payload.quotaBytes;
      if (result?.status !== 200 || !Number.isSafeInteger(bytes) || (bytes as number) < 0) return false;
      const settled = await limit(env, { action: "reconcile", ...reservation, bytes: bytes as number,
        leaseUntil: claim.reconciliation.leaseUntil, now: deps.now() });
      return settled.allowed;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function handleShareIntake(request: Request, env: Env, deps: HandleDeps): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!(path in ROUTES)) return json({ error: "not_found" }, 404, {});
  const origin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  if (request.headers.get("Origin") !== origin) return json({ error: "forbidden" }, 403, {});
  const responseHeaders = cors(origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
  const expectedMethod = path === "/config" ? "GET" : "POST";
  if (request.method !== expectedMethod) return json({ error: "not_found" }, 404, responseHeaders);

  const hostname = allowedTurnstileHostname(env);
  const base = configuredBase(env);
  if (!hostname || !base || !env.CMS_EDGE_ORIGIN_SECRET || !env.IP_HASH_SALT || !env.RATE_LIMITER || !env.TURNSTILE_SECRET) {
    return json({ error: "misconfigured" }, 500, responseHeaders);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return json({ error: "invalid" }, 400, responseHeaders);
  if (path === "/config") {
    const cache = deps.configCache;
    const now = deps.now();
    if (cache?.payload && cache.expiresAt > now) {
      const remaining = Math.ceil((cache.expiresAt - now) / 1000);
      return json(cache.payload, 200, { ...responseHeaders, "Cache-Control": `public, max-age=${remaining}` });
    }
    const result = await forward(ROUTES[path], null, ip, null, base, env.CMS_EDGE_ORIGIN_SECRET, deps);
    if (!result) return json({ error: "upstream" }, 502, responseHeaders);
    if (result.status === 200 && cache) {
      cache.payload = result.payload;
      cache.expiresAt = now + 60_000;
    }
    return json(result.payload, result.status, result.status === 200
      ? { ...responseHeaders, "Cache-Control": "public, max-age=60" }
      : responseHeaders);
  }

  const body = await readJson(request);
  if (body === "too_large") return json({ error: "too_large" }, 413, responseHeaders);
  if (!body) return json({ error: "invalid" }, 400, responseHeaders);
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);

  if (path === "/start") {
    if (Boolean(body.website) || !passesDwell(body.timeElapsed as number)) return json({ ok: true }, 200, responseHeaders);
    const size = (body.file as { size?: unknown } | null)?.size;
    if (!validId(body.requestId) || !Number.isSafeInteger(size) || (size as number) <= 0) {
      return json({ error: "invalid" }, 400, responseHeaders);
    }
    if ((size as number) > MAX_FILE_BYTES) return json({ error: "too_large" }, 413, responseHeaders);
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    if (!await verifyTurnstile(token, env.TURNSTILE_SECRET, ip, hostname, deps)) {
      return json({ error: "turnstile" }, 403, responseHeaders);
    }

    const requestId = body.requestId as string;
    const now = deps.now();
    let admission: LimitResult;
    try {
      admission = await limit(env, { action: "reserve", requestId, ipHash, bytes: size as number, now });
    } catch {
      return json({ error: "upstream" }, 502, responseHeaders);
    }
    // Resolve expired holds in small batches only when they block admission.
    // Each successful reconciliation removes a candidate; failed origin calls
    // keep their charge and lease, so the loop cannot repeat a failed batch.
    while (!admission.allowed && "reservations" in admission && admission.reservations?.length) {
      if (!await reconcileReservations(admission.reservations, env, deps, base, ip)) break;
      try {
        admission = await limit(env, { action: "reserve", requestId, ipHash, bytes: size as number, now: deps.now() });
      } catch {
        return json({ error: "upstream" }, 502, responseHeaders);
      }
    }
    if (!admission.allowed) return refusal(admission, responseHeaders);

    const result = await forward(ROUTES[path], body, ip, ipHash, base, env.CMS_EDGE_ORIGIN_SECRET, deps);
    if (!result) return json({ error: "upstream" }, 502, responseHeaders);
    if (result.status >= 400) {
      if (!admission.existing) await limit(env, { action: "cancel", requestId, ipHash, now: deps.now() }).catch(() => {});
      return json(result.payload, result.status, responseHeaders);
    }
    if (typeof result.payload.submissionId !== "string" || !result.payload.submissionId) {
      return json({ error: "upstream" }, 502, responseHeaders);
    }
    try {
      const accepted = await limit(env, { action: "accept", requestId, ipHash, submissionId: result.payload.submissionId, now: deps.now() });
      if (!accepted.allowed) return json({ error: "upstream" }, 502, responseHeaders);
    } catch {
      return json({ error: "upstream" }, 502, responseHeaders);
    }
    return json(result.payload, result.status, responseHeaders);
  }

  if (!validId(body.requestId) || typeof body.submissionId !== "string" || !body.submissionId) {
    return json({ error: "invalid" }, 400, responseHeaders);
  }
  let completion: { attempt: number; leaseUntil: number };
  try {
    const admission = await limit(env, {
      action: "claim_complete", requestId: body.requestId, ipHash, submissionId: body.submissionId, now: deps.now(),
    });
    if (!admission.allowed) return refusal(admission, responseHeaders);
    if (!admission.completion) return json({ error: "upstream" }, 502, responseHeaders);
    completion = admission.completion;
  } catch {
    return json({ error: "upstream" }, 502, responseHeaders);
  }
  const result = await forward(ROUTES["/complete"], body, ip, ipHash, base, env.CMS_EDGE_ORIGIN_SECRET, deps, completion.leaseUntil);
  const retryable = !result || result.status >= 500 || result.status === 404 && result.payload.error === "missing_upload";
  if (retryable) {
    try {
      await limit(env, { action: "retry_complete", requestId: body.requestId, ipHash, submissionId: body.submissionId, attempt: completion.attempt, now: deps.now() });
    } catch {
      return json({ error: "upstream" }, 502, responseHeaders);
    }
  }
  if (!result) return json({ error: "upstream" }, 502, responseHeaders);
  if (!retryable) {
    const uploaded = result.status >= 200 && result.status < 300 && result.payload.ok === true;
    const releaseSlot = uploaded || (result.status === 422 && result.payload.error === "rejected_file") ||
      (result.status === 410 && result.payload.error === "expired");
    // The origin outcome is definitive even when this bookkeeping RPC fails.
    await limit(env, { action: "complete", requestId: body.requestId, ipHash, submissionId: body.submissionId,
      attempt: completion.attempt, releaseSlot, uploaded, now: deps.now() }).catch(() => {});
    if (releaseSlot && !uploaded) {
      await reconcileReservations([{ requestId: body.requestId, ipHash, submissionId: body.submissionId }], env, deps, base, ip);
    }
  }
  return json(result.payload, result.status, responseHeaders);
}

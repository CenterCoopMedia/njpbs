// The public edge for the "report a problem" widget: a Cloudflare Worker's
// request-handling logic, kept as plain functions so it can be unit-tested under
// the site's existing Vitest without the Workers runtime. index.ts is a thin
// adapter that calls handleReport with the real Workers globals.
//
// This is the server-side control. The widget's client checks are a convenience;
// these run at the edge where a caller cannot skip them. The validation rules are
// imported from the same report-form module the widget uses, so the two surfaces
// cannot drift. The Worker is stateless except for a KV rate-limit counter: it
// verifies, gates, rate-limits, and forwards a Bearer-authed payload to the bot
// intake. It stores no reports and holds no Telegram token.
//
// Configuration and request order: site/worker/README.md.

import {
  buildReportPayload,
  isDescriptionLongEnough,
  isValidCategory,
  passesDwell,
} from "../src/lib/report-form";
import type { ConsoleEntry } from "../src/lib/console-capture";

// A minimal Workers KV surface, declared locally so this file type-checks under
// the site's DOM-typed tsconfig without pulling in @cloudflare/workers-types
// (whose global Request/Response/fetch types conflict with the DOM lib).
export interface ReportKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  // Turnstile secret key (server side). Required; its absence is a misconfig.
  TURNSTILE_SECRET?: string;
  // Bot intake URL over the Cloudflare tunnel and the shared Bearer secret only
  // the Worker holds. Both required to forward.
  INTAKE_URL?: string;
  INTAKE_SECRET?: string;
  // Cloudflare Access service-token credentials. The intake host (intake.example.org)
  // sits behind Access, so the forward is admitted only when it presents these on
  // the CF-Access-Client-Id / CF-Access-Client-Secret headers. Set as Worker
  // secrets in production; when unset (local/tests) the headers are simply omitted.
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  // Salt for the client-IP hash, so a stored hash is not a bare IP digest.
  // Required: its absence is treated as a misconfig (500), like the other secrets.
  IP_HASH_SALT?: string;
  // Browser origin allowed to POST here. Defaults to the production site.
  ALLOWED_ORIGIN?: string;
  // KV namespace for the per-IP rate-limit counter. If unbound, rate limiting is
  // skipped (fail open): the intake can re-check, and the other gates still run.
  RATE_LIMIT?: ReportKV;
}

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "follow" | "manual" | "error";
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HandleDeps {
  fetch: FetchLike;
  now: () => number;
}

export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // one hour, mirrors CJS2026
// Largest request body the edge will read. buildReportPayload clamps every field,
// but only after the whole body is read and JSON.parsed, so without this a
// multi-megabyte POST burns Worker CPU on a parse whose result is thrown away. The
// largest legitimate report clamps to ~34 KB (a 2000-char description, 50 console
// entries of 500 chars, plus the capped url/userAgent/screenSize), so 128 KB is
// well clear of a real report while dropping the oversized bodies this guards.
export const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_ALLOWED_ORIGIN = "https://njpbs.org";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// sha256 hex of the input, using Web Crypto (present in both the Workers runtime
// and Node 20+). Truncated by the caller.
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A stable, salted, truncated hash of the client IP. Never the raw IP: the
// non-goal is storing client IPs, only enough to rate-limit. Truncation keeps it
// short; the salt stops it being a plain reversible digest of a known IP.
export async function hashIp(ip: string, salt: string): Promise<string> {
  const hex = await sha256Hex(`${salt}:${ip}`);
  return hex.slice(0, 32);
}

// The hostname a Turnstile token is accepted from. siteverify reports the page that
// solved the widget, not this Worker, so the expected value is the site's own host
// rather than report.njpbs.org. Derived from the same ALLOWED_ORIGIN the CORS header
// uses, so one setting moves both and they cannot drift apart.
//
// Returns null unless ALLOWED_ORIGIN is a serialized HTTP origin. `new URL` throws
// for a bare `njpbs.org` but accepts values such as `localhost:8788` as a scheme and
// accepts absolute URLs with paths, none of which is a valid CORS origin value. The
// caller deliberately validates this before the rate-limit write so a configuration
// failure returns a diagnosable response without spending viewer quota.
export function allowedTurnstileHostname(env: Env): string | null {
  try {
    const configuredOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
    const parsed = new URL(configuredOrigin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || parsed.origin !== configuredOrigin
    ) {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

// Verify the Turnstile token against Cloudflare's siteverify. Returns false on a
// missing token, a non-2xx response, or an unsuccessful verdict, so the caller
// treats any uncertainty as "not verified".
//
// `success` alone does not say the token came from our page. A token minted by the
// same widget on another configured hostname or form verifies with that widget's
// secret too. siteverify reports the solving hostname; requiring it to equal our own
// binds the token to this site.
//
// Exact equality, not a suffix match. The bind is deliberately the same width as the
// CORS allowlist, since both read ALLOWED_ORIGIN, so it can never refuse an origin
// the preflight already admits. That parity is the reason it is safe rather than any
// claim about which hosts exist: the site is also built to template-dev.pages.dev and to
// the njpbs-production workers.dev project, and a submit from either is already
// refused at CORS today. A suffix match would buy no legitimate caller anything and
// would admit an attacker-registered evil-njpbs.org.
//
// The sibling half of this check, binding the token's `action`, is not here: it needs
// the widget to render a report-specific action first, and enforcing a value the
// widget does not send yet would reject every real submit. See issue #315.
export async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string,
  expectedHostname: string,
  deps: HandleDeps,
): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  let res;
  try {
    res = await deps.fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as {
    success?: boolean;
    hostname?: string;
  } | null;
  if (!data || !data.success) return false;
  // A response that omits hostname is uncertainty, not permission, so it fails closed
  // like every other unknown above.
  return data.hostname === expectedHostname;
}

// Fixed one-hour-window counter per IP hash. KV lacks atomic increment, but for a
// best-effort spam gate a get-then-put is fine; a few boundary races do not
// matter. Returns whether the cap is already reached (without incrementing past
// it, so a blocked caller does not keep extending its own window).
export async function checkRateLimit(
  kv: ReportKV,
  ipHash: string,
  now: number,
): Promise<{ exceeded: boolean; count: number }> {
  const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
  const key = `rl:${ipHash}:${bucket}`;
  const raw = await kv.get(key);
  const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
  if (count >= RATE_LIMIT_MAX) {
    return { exceeded: true, count };
  }
  await kv.put(key, String(count + 1), {
    expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 60,
  });
  return { exceeded: false, count: count + 1 };
}

// Read the request body with a hard byte cap, stopping as soon as the cap is
// passed rather than buffering the whole thing. Returns the decoded text, or
// { tooLarge: true } when the body runs past maxBytes so the caller answers 413.
// This is what makes the cap real for a body that omits or lies about its
// Content-Length (a chunked upload): the reader is cancelled after at most one
// chunk over the limit, so an unbounded payload is never fully held in memory.
// A genuine stream error propagates, so the caller treats it as an invalid body.
async function readCappedText(
  request: Request,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true }> {
  const body = request.body;
  if (!body) {
    // No stream to read (e.g. an empty body); nothing can exceed the cap.
    return { text: await request.text() };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged) };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(
  payload: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// A record shows automated intent (honeypot filled) or a submit faster than a
// person could manage (dwell under the minimum). We answer with the same success
// a real report gets and forward nothing, so the client cannot tell it was
// dropped or learn how to get past the gate. Mirrors CJS2026's fake 200.
function looksAutomated(body: Record<string, unknown>): boolean {
  const honeypot = body.website;
  const honeypotFilled =
    typeof honeypot === "string" ? honeypot.trim().length > 0 : Boolean(honeypot);
  const timeElapsed = typeof body.timeElapsed === "number" ? body.timeElapsed : Number.NaN;
  return honeypotFilled || !passesDwell(timeElapsed);
}

export async function handleReport(
  request: Request,
  env: Env,
  deps: HandleDeps,
): Promise<Response> {
  const origin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  const cors = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed." }, 405, {
      ...cors,
      Allow: "POST, OPTIONS",
    });
  }

  // Drop an oversized body before parsing it. The declared length is a cheap
  // pre-read reject; readCappedText is the real guard, stopping the read as soon
  // as the byte cap is passed so a missing or lying Content-Length (a chunked
  // upload) cannot make the Worker buffer a multi-megabyte payload. Either way an
  // over-cap body never reaches JSON.parse.
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ success: false, error: "Report is too large." }, 413, cors);
  }
  let capped;
  try {
    capped = await readCappedText(request, MAX_BODY_BYTES);
  } catch {
    return json({ success: false, error: "Invalid request." }, 400, cors);
  }
  if ("tooLarge" in capped) {
    return json({ success: false, error: "Report is too large." }, 413, cors);
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(capped.text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    return json({ success: false, error: "Invalid request." }, 400, cors);
  }

  // Silent bot drop before spending a siteverify call or a KV write.
  if (looksAutomated(parsed)) {
    return json({ success: true }, 200, cors);
  }

  if (!isValidCategory(parsed.category)) {
    return json({ success: false, error: "Pick a category." }, 400, cors);
  }
  const description = typeof parsed.description === "string" ? parsed.description : "";
  if (!isDescriptionLongEnough(description)) {
    return json({ success: false, error: "Add a little more detail." }, 400, cors);
  }

  // Every deploy-configuration check runs before the rate-limit write, so a
  // misconfigured Worker refuses the request without spending one of the
  // reporter's hourly slots. Retries against a broken deploy would otherwise
  // accumulate in the KV bucket and hold a 429 over the reporter after the
  // config is fixed.
  const expectedHostname = allowedTurnstileHostname(env);
  if (expectedHostname === null) {
    // An unparseable ALLOWED_ORIGIN is the same class of deploy mistake as an unset
    // secret, so it gets the same answer instead of a crash.
    return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
  }
  if (!env.IP_HASH_SALT) {
    // Without a salt the IP hash is a bare, brute-forceable digest of the IPv4
    // space, so fail loud like the other required secrets rather than store one.
    return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
  }
  if (!env.TURNSTILE_SECRET) {
    // Misconfiguration, not the caller's fault: fail loud rather than silently
    // accepting unverified reports.
    return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
  }
  if (!env.INTAKE_URL || !env.INTAKE_SECRET) {
    // Checked here rather than at the forward so a dead intake does not spend the
    // reporter's quota slot and a siteverify call before failing anyway.
    return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
  }
  try {
    const intakeUrl = new URL(env.INTAKE_URL);
    if (
      (intakeUrl.protocol !== "http:" && intakeUrl.protocol !== "https:")
      || !intakeUrl.hostname
      || intakeUrl.username
      || intakeUrl.password
    ) {
      return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
    }
  } catch {
    // Present but not an absolute HTTP URL. The forward's fetch would throw on it
    // after the quota and the token were already spent, so it is the same deploy
    // mistake as a malformed ALLOWED_ORIGIN and gets the same answer here.
    return json({ success: false, error: "Reporting is misconfigured." }, 500, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);

  // Rate-limit before Turnstile so a flood from one IP does not run up siteverify
  // calls. Skipped if no KV is bound (fail open); the intake can re-check.
  if (env.RATE_LIMIT) {
    const rl = await checkRateLimit(env.RATE_LIMIT, ipHash, deps.now());
    if (rl.exceeded) {
      return json({ success: false, error: "Too many reports. Try again later." }, 429, cors);
    }
  }
  const token = typeof parsed.turnstileToken === "string" ? parsed.turnstileToken : "";
  const verified = await verifyTurnstile(
    token,
    env.TURNSTILE_SECRET,
    ip,
    expectedHostname,
    deps,
  );
  if (!verified) {
    return json({ success: false, error: "Verification failed. Please try again." }, 403, cors);
  }

  let payload;
  try {
    payload = buildReportPayload({
      category: parsed.category,
      description,
      email: parsed.email,
      url: typeof parsed.url === "string" ? parsed.url : null,
      userAgent: typeof parsed.userAgent === "string" ? parsed.userAgent : null,
      screenSize: typeof parsed.screenSize === "string" ? parsed.screenSize : null,
      consoleLogs: Array.isArray(parsed.consoleLogs)
        ? (parsed.consoleLogs as ConsoleEntry[])
        : [],
      formOpenedAt: typeof parsed.formOpenedAt === "number" ? parsed.formOpenedAt : null,
      timeElapsed: typeof parsed.timeElapsed === "number" ? parsed.timeElapsed : null,
      turnstileToken: null,
    });
  } catch {
    return json({ success: false, error: "Invalid request." }, 400, cors);
  }

  // The token was consumed at the edge; the intake gets everything but that, plus
  // the IP hash it cannot compute itself (it never sees the real IP).
  const forwardBody = {
    category: payload.category,
    description: payload.description,
    email: payload.email,
    url: payload.url,
    userAgent: payload.userAgent,
    screenSize: payload.screenSize,
    consoleLogs: payload.consoleLogs,
    formOpenedAt: payload.formOpenedAt,
    timeElapsed: payload.timeElapsed,
    ipHash,
  };

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.INTAKE_SECRET}`,
  };
  // The intake sits behind Cloudflare Access. Present the service-token
  // credentials so Access admits this server-to-server POST; without them Access
  // rejects the call with a 302 to its login page and it never reaches the
  // intake. Both are set as Worker secrets in production.
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    forwardHeaders["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    forwardHeaders["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  let forwardRes;
  try {
    forwardRes = await deps.fetch(env.INTAKE_URL, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(forwardBody),
      // Do not follow redirects. If Access rejects the forward (a missing, wrong,
      // or expired service token, or a policy change) it answers with a 302 to
      // its login page; following that lands on a 200 HTML page and forwardRes.ok
      // would falsely read as success while no report reached the intake. With
      // manual redirect a 302 stays a 302, so the !ok guard below returns 502.
      redirect: "manual",
    });
  } catch {
    return json({ success: false, error: "Could not queue the report." }, 502, cors);
  }
  if (!forwardRes.ok) {
    return json({ success: false, error: "Could not queue the report." }, 502, cors);
  }

  // The report is durably queued at the intake; the browser can be told it worked
  // before any Telegram or issue side effect runs.
  return json({ success: true }, 200, cors);
}

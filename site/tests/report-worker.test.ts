// @vitest-environment node
// The Worker logic needs no DOM; Node gives Request/Response/crypto.subtle. These
// exercise report-intake.ts directly with injected fetch/now/KV, so the spam
// gates, Turnstile verify, rate-limit counter, and forward contract are covered
// without the Workers runtime. The shared validation rules are pinned separately
// in report-form.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  allowedTurnstileHostname,
  checkRateLimit,
  handleReport,
  hashIp,
  MAX_BODY_BYTES,
  RATE_LIMIT_MAX,
  verifyTurnstile,
  type Env,
  type HandleDeps,
  type ReportKV,
} from "../worker/report-intake";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const INTAKE = "https://intake.example/njpbs-report";

function makeKV(): ReportKV {
  const store = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(store.has(k) ? (store.get(k) as string) : null),
    put: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

// A fetch double that answers siteverify with the given verdict and the intake
// with the given ok flag, and records its calls so tests can assert the forward.
// siteverify reports the hostname that solved the widget; it defaults to the host
// in makeEnv's ALLOWED_ORIGIN so the ordinary case is a token minted on our page.
function makeDeps(opts: {
  turnstile?: boolean;
  intakeOk?: boolean;
  now?: number;
  turnstileHostname?: string | null;
} = {}) {
  const {
    turnstile = true,
    intakeOk = true,
    now = 1_000_000_000,
    turnstileHostname = "njpbs.org",
  } = opts;
  const fetch = vi.fn(async (
    input: string,
    _init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    if (input === SITEVERIFY) {
      // null models a response that omits the field entirely, not one that sends null.
      const verdict: { success: boolean; hostname?: string } = { success: turnstile };
      if (turnstileHostname !== null) verdict.hostname = turnstileHostname;
      return { ok: true, status: 200, json: async () => verdict };
    }
    if (input === INTAKE) {
      return { ok: intakeOk, status: intakeOk ? 200 : 503, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const deps: HandleDeps = { fetch, now: () => now };
  return { deps, fetch };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TURNSTILE_SECRET: "secret",
    INTAKE_URL: INTAKE,
    INTAKE_SECRET: "bearer-token",
    IP_HASH_SALT: "salt",
    ALLOWED_ORIGIN: "https://njpbs.org",
    RATE_LIMIT: makeKV(),
    ...overrides,
  };
}

const validBody = {
  category: "bug",
  description: "the live player will not load on my phone",
  email: "viewer@example.com",
  url: "https://njpbs.org/live/",
  userAgent: "Mozilla/5.0",
  screenSize: "390x844",
  formOpenedAt: 1000,
  timeElapsed: 5000,
  turnstileToken: "tok",
  website: "",
};

function post(body: unknown, ip = "203.0.113.5"): Request {
  return new Request("https://report.njpbs.org/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("verifyTurnstile", () => {
  const HOST = "njpbs.org";

  it("returns false without a token and never calls siteverify", async () => {
    const { deps, fetch } = makeDeps();
    expect(await verifyTurnstile("", "secret", "1.2.3.4", HOST, deps)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes on a successful verdict and fails on an unsuccessful one", async () => {
    expect(await verifyTurnstile("tok", "secret", "", HOST, makeDeps({ turnstile: true }).deps)).toBe(true);
    expect(await verifyTurnstile("tok", "secret", "", HOST, makeDeps({ turnstile: false }).deps)).toBe(false);
  });

  it("fails closed when siteverify errors", async () => {
    const deps: HandleDeps = { fetch: vi.fn(async () => Promise.reject(new Error("net"))), now: () => 0 };
    expect(await verifyTurnstile("tok", "secret", "", HOST, deps)).toBe(false);
  });

  it("rejects a token solved on another hostname", async () => {
    // The same widget can be configured for more than one hostname, so a token from
    // another permitted host can pass the success check. Without this bind the
    // verdict alone would admit it.
    const { deps } = makeDeps({ turnstileHostname: "someone-elses-site.example" });
    expect(await verifyTurnstile("tok", "secret", "", HOST, deps)).toBe(false);
  });

  it("rejects a verdict that omits the hostname", async () => {
    const { deps } = makeDeps({ turnstileHostname: null });
    expect(await verifyTurnstile("tok", "secret", "", HOST, deps)).toBe(false);
  });

  it("does not accept a subdomain or a suffix match of the allowed host", async () => {
    // www.njpbs.org 301s to the apex, so it never carries a document and never needs
    // to pass. evil-njpbs.org is the case a suffix comparison would wrongly admit,
    // and it is registrable by anyone.
    for (const host of ["www.njpbs.org", "evil-njpbs.org", "njpbs.org.attacker.example"]) {
      const { deps } = makeDeps({ turnstileHostname: host });
      expect(await verifyTurnstile("tok", "secret", "", HOST, deps)).toBe(false);
    }
  });
});

describe("allowedTurnstileHostname", () => {
  it("takes the host from ALLOWED_ORIGIN so CORS and Turnstile cannot drift apart", () => {
    expect(allowedTurnstileHostname(makeEnv({ ALLOWED_ORIGIN: "https://staging.njpbs.org" })))
      .toBe("staging.njpbs.org");
  });

  it("falls back to the production host when ALLOWED_ORIGIN is unset", () => {
    expect(allowedTurnstileHostname(makeEnv({ ALLOWED_ORIGIN: undefined }))).toBe("njpbs.org");
  });

  it("returns null unless ALLOWED_ORIGIN is a serialized HTTP origin", () => {
    // new URL accepts host:port as a scheme and accepts paths on absolute URLs, but
    // neither is a valid Access-Control-Allow-Origin value.
    for (const origin of [
      "njpbs.org",
      "localhost:8788",
      "mailto:ops@example.com",
      "https://njpbs.org/report",
    ]) {
      expect(allowedTurnstileHostname(makeEnv({ ALLOWED_ORIGIN: origin }))).toBeNull();
    }
  });
});

describe("hashIp", () => {
  it("is a 32-char hex hash, never the raw IP", async () => {
    const h = await hashIp("203.0.113.5", "salt");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain("203.0.113.5");
  });

  it("is stable for the same input and varies by IP and by salt", async () => {
    expect(await hashIp("1.1.1.1", "salt")).toBe(await hashIp("1.1.1.1", "salt"));
    expect(await hashIp("1.1.1.1", "salt")).not.toBe(await hashIp("1.1.1.2", "salt"));
    expect(await hashIp("1.1.1.1", "salt")).not.toBe(await hashIp("1.1.1.1", "pepper"));
  });
});

describe("checkRateLimit", () => {
  it("allows up to the cap, then reports exceeded without incrementing further", async () => {
    const kv = makeKV();
    for (let i = 1; i <= RATE_LIMIT_MAX; i++) {
      const r = await checkRateLimit(kv, "hash", 1_000_000_000);
      expect(r.exceeded).toBe(false);
      expect(r.count).toBe(i);
    }
    const over = await checkRateLimit(kv, "hash", 1_000_000_000);
    expect(over.exceeded).toBe(true);
    expect(over.count).toBe(RATE_LIMIT_MAX);
  });

  it("resets in a new hourly window", async () => {
    const kv = makeKV();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) await checkRateLimit(kv, "hash", 0);
    expect((await checkRateLimit(kv, "hash", 0)).exceeded).toBe(true);
    // One hour later is a fresh bucket.
    expect((await checkRateLimit(kv, "hash", 60 * 60 * 1000)).exceeded).toBe(false);
  });
});

describe("handleReport", () => {
  it("answers the CORS preflight", async () => {
    const { deps } = makeDeps();
    const res = await handleReport(
      new Request("https://report.njpbs.org/", { method: "OPTIONS" }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://njpbs.org");
  });

  it("rejects a non-POST method", async () => {
    const { deps } = makeDeps();
    const res = await handleReport(
      new Request("https://report.njpbs.org/", { method: "GET" }),
      makeEnv(),
      deps,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });

  it("rejects a body that is not JSON", async () => {
    const { deps } = makeDeps();
    const res = await handleReport(post("not json at all"), makeEnv(), deps);
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body with a 413 before parsing or forwarding", async () => {
    const { deps, fetch } = makeDeps();
    // Past the cap even though every field would otherwise validate: the guard
    // must fire before JSON.parse, so no siteverify or intake call is spent on it.
    const huge = JSON.stringify({ ...validBody, description: "x".repeat(MAX_BODY_BYTES + 1) });
    const res = await handleReport(post(huge), makeEnv(), deps);
    expect(res.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caps an oversized chunked body that declares no Content-Length", async () => {
    const { deps, fetch } = makeDeps();
    // A stream body is sent chunked with no Content-Length, so the declared-length
    // fast path cannot catch it. The streaming read must stop past the cap instead
    // of buffering the whole payload, still answering 413 and forwarding nothing.
    const oversized = new TextEncoder().encode(
      JSON.stringify({ ...validBody, description: "x".repeat(MAX_BODY_BYTES + 1) }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    });
    const req = new Request("https://report.njpbs.org/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.get("Content-Length")).toBeNull();
    const res = await handleReport(req, makeEnv(), deps);
    expect(res.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("silently drops a filled honeypot with a fake success and forwards nothing", async () => {
    const { deps, fetch } = makeDeps();
    const res = await handleReport(post({ ...validBody, website: "spam" }), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("silently drops a submit faster than the dwell", async () => {
    const { deps, fetch } = makeDeps();
    const res = await handleReport(post({ ...validBody, timeElapsed: 500 }), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown category and a too-short description without spending a verify call", async () => {
    const bad = makeDeps();
    expect((await handleReport(post({ ...validBody, category: "spam" }), makeEnv(), bad.deps)).status).toBe(400);
    expect(bad.fetch).not.toHaveBeenCalled();

    const short = makeDeps();
    expect((await handleReport(post({ ...validBody, description: "too short" }), makeEnv(), short.deps)).status).toBe(400);
    expect(short.fetch).not.toHaveBeenCalled();
  });

  it("rejects a failed Turnstile verdict and does not forward", async () => {
    const { deps, fetch } = makeDeps({ turnstile: false });
    const res = await handleReport(post(validBody), makeEnv(), deps);
    expect(res.status).toBe(403);
    // siteverify was called; the intake was not.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a token minted on another site and does not forward", async () => {
    // The whole point of the hostname bind: siteverify says success, so every other
    // gate here is satisfied, and the report is still refused because the token was
    // not solved on njpbs.org.
    const { deps, fetch } = makeDeps({ turnstile: true, turnstileHostname: "other.example" });
    const res = await handleReport(post(validBody), makeEnv(), deps);
    expect(res.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("binds the token to the configured origin, not a hardcoded host", async () => {
    // A Worker deployed with a different ALLOWED_ORIGIN accepts that origin's tokens
    // and refuses production's, so the two settings stay one setting.
    const staging = makeEnv({ ALLOWED_ORIGIN: "https://staging.njpbs.org" });
    const solvedOnStaging = makeDeps({ turnstileHostname: "staging.njpbs.org" });
    expect((await handleReport(post(validBody), staging, solvedOnStaging.deps)).status).toBe(200);

    const solvedOnProd = makeDeps({ turnstileHostname: "njpbs.org" });
    expect((await handleReport(post(validBody), staging, solvedOnProd.deps)).status).toBe(403);
  });

  it("fails loud on a malformed ALLOWED_ORIGIN instead of throwing", async () => {
    // Without the guard this is an uncaught TypeError from new URL, which reaches the
    // reporter as a Workers 1101 with no CORS header and no body. Parsing before the
    // rate-limit write also keeps a deploy mistake from spending viewer quota.
    const { deps, fetch } = makeDeps();
    const put = vi.fn(() => Promise.resolve());
    const rateLimit: ReportKV = {
      get: () => Promise.resolve(null),
      put,
    };
    const res = await handleReport(
      post(validBody),
      makeEnv({ ALLOWED_ORIGIN: "njpbs.org", RATE_LIMIT: rateLimit }),
      deps,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "Reporting is misconfigured." });
    // No siteverify call: the misconfig is caught before the token is spent.
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not spend rate-limit quota on a misconfigured deploy", async () => {
    // Retries against a broken deploy must not accumulate in the KV bucket: once the
    // config is fixed, the reporter still has their full hourly allowance. One shared
    // env so every call sees the same bucket.
    const env = makeEnv();
    const ip = "203.0.113.7";
    const broken = { ...env, ALLOWED_ORIGIN: "njpbs.org" };
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const { deps } = makeDeps();
      expect((await handleReport(post(validBody, ip), broken, deps)).status).toBe(500);
    }
    // Config fixed: the same IP submits the full cap, so the failures spent nothing.
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const { deps } = makeDeps();
      expect((await handleReport(post(validBody, ip), env, deps)).status).toBe(200);
    }
    const { deps } = makeDeps();
    expect((await handleReport(post(validBody, ip), env, deps)).status).toBe(429);
  });

  it("fails loud when the Turnstile secret is unset", async () => {
    const { deps } = makeDeps();
    const res = await handleReport(post(validBody), makeEnv({ TURNSTILE_SECRET: undefined }), deps);
    expect(res.status).toBe(500);
  });

  it("fails loud when the IP hash salt is unset rather than storing an unsalted hash", async () => {
    const { deps, fetch } = makeDeps();
    const res = await handleReport(post(validBody), makeEnv({ IP_HASH_SALT: undefined }), deps);
    expect(res.status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards a Bearer-authed payload with the IP hash and no token on the happy path", async () => {
    const { deps, fetch } = makeDeps();
    const res = await handleReport(post(validBody), makeEnv(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const intakeCall = fetch.mock.calls.find((c) => c[0] === INTAKE);
    expect(intakeCall).toBeDefined();
    const init = intakeCall![1] as unknown as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe("Bearer bearer-token");
    const forwarded = JSON.parse(init.body);
    expect(forwarded.category).toBe("bug");
    expect(forwarded.email).toBe("viewer@example.com");
    expect(forwarded.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(forwarded.turnstileToken).toBeUndefined();
    // No Access service-token env set, so those headers are omitted.
    expect(init.headers["CF-Access-Client-Id"]).toBeUndefined();
    expect(init.headers["CF-Access-Client-Secret"]).toBeUndefined();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://njpbs.org");
  });

  it("adds the Cloudflare Access service-token headers when configured", async () => {
    const { deps, fetch } = makeDeps();
    const env = makeEnv({
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });
    const res = await handleReport(post(validBody), env, deps);
    expect(res.status).toBe(200);

    const intakeCall = fetch.mock.calls.find((c) => c[0] === INTAKE);
    const init = intakeCall![1] as unknown as { headers: Record<string, string> };
    expect(init.headers["CF-Access-Client-Id"]).toBe("client-id.access");
    expect(init.headers["CF-Access-Client-Secret"]).toBe("client-secret");
    // The Bearer still rides alongside: Access is the outer gate, the Bearer the inner one.
    expect(init.headers.Authorization).toBe("Bearer bearer-token");
  });

  it("forwards to the intake with manual redirect so an Access login 302 fails closed", async () => {
    const { deps, fetch } = makeDeps();
    const res = await handleReport(post(validBody), makeEnv(), deps);
    expect(res.status).toBe(200);

    const intakeCall = fetch.mock.calls.find((c) => c[0] === INTAKE);
    const init = intakeCall![1] as unknown as { redirect?: string };
    // fetch follows redirects by default; Access answers an unauthenticated
    // service call with a 302 to its login page. Following it lands on a 200 and
    // reads as success while no report reached the intake. Manual redirect keeps
    // the 302 a 302, so the !forwardRes.ok guard returns 502 (see the
    // "intake is unreachable" case) instead of a false success.
    expect(init.redirect).toBe("manual");
  });

  it("returns 502 when the intake is unreachable", async () => {
    const { deps } = makeDeps({ intakeOk: false });
    const res = await handleReport(post(validBody), makeEnv(), deps);
    expect(res.status).toBe(502);
  });

  it("fails loud when the intake is not configured", async () => {
    const { deps } = makeDeps();
    const res = await handleReport(post(validBody), makeEnv({ INTAKE_URL: undefined }), deps);
    expect(res.status).toBe(500);
  });

  it("fails loud on an invalid intake URL before spending anything", async () => {
    // Present but not an absolute HTTP URL: fetch would reject or misinterpret these
    // values after siteverify ran and the quota slot was written. Catch them with the
    // other config checks instead.
    for (const intakeUrl of [
      "intake.example.org/api/njpbs/report",
      "intake.example.org:443",
      "mailto:ops@example.com",
    ]) {
      const { deps, fetch } = makeDeps();
      const res = await handleReport(
        post(validBody),
        makeEnv({ INTAKE_URL: intakeUrl }),
        deps,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: "Reporting is misconfigured." });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("rate-limits past the hourly cap with a 429", async () => {
    const env = makeEnv(); // one shared KV across calls
    const ip = "198.51.100.9";
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const { deps } = makeDeps();
      const ok = await handleReport(post(validBody, ip), env, deps);
      expect(ok.status).toBe(200);
    }
    const { deps, fetch } = makeDeps();
    const over = await handleReport(post(validBody, ip), env, deps);
    expect(over.status).toBe(429);
    // Blocked before spending a verify call.
    expect(fetch).not.toHaveBeenCalled();
  });
});

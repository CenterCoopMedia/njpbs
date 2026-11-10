// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { handleShareIntake, type Env, type HandleDeps, type LimitNamespace, type LimitStub } from "../share-intake/share-intake";
import { applyLimit, DAY_MS, FORM_BYTES_PER_DAY, HOUR_MS, initializeLimiter, STARTS_SCHEMA, UPLOAD_LEASE_MS, type SqlStore } from "../share-intake/rate-limit";

const BASE = "https://us-central1-njpbs-site.cloudfunctions.net/";
const NOW = 100 * DAY_MS + 12 * HOUR_MS;
const IP = "203.0.113.5";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeSql(legacy = false): { sql: SqlStore; close: () => void } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlStore = {
    exec<T extends Record<string, string | number | null | ArrayBuffer>>(query: string, ...bindings: (string | number | null | ArrayBuffer)[]): Iterable<T> {
      const statement = db.prepare(query);
      const values = bindings as (string | number | null)[];
      if (/^(SELECT|PRAGMA)/.test(query.trimStart())) return statement.all(...values) as T[];
      statement.run(...values);
      return [];
    },
  };
  sql.exec(legacy ? STARTS_SCHEMA.replace(",\n  charged_at INTEGER,\n  reconcile_until INTEGER", "") : STARTS_SCHEMA);
  if (legacy) sql.exec(`CREATE TABLE completions (
    request_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL, in_flight INTEGER NOT NULL
  )`);
  else initializeLimiter(sql);
  return { sql, close: () => db.close() };
}

function reconcile(sql: SqlStore, binding: { requestId: string; ipHash: string; submissionId: string }, now: number, bytes: number) {
  const claim = applyLimit(sql, { action: "claim_reconcile", ...binding, now });
  if (!claim.allowed || !claim.reconciliation) throw new Error("Reconciliation not admitted");
  expect(applyLimit(sql, { action: "reconcile", ...binding, leaseUntil: claim.reconciliation.leaseUntil, bytes, now }).allowed).toBe(true);
}

function makeLimiter(sql: SqlStore): LimitNamespace {
  const stub: LimitStub = {
    apply: async (input) => applyLimit(sql, input),
  };
  return { idFromName: (name) => name, get: () => stub };
}

function makeEnv(limiter: LimitNamespace, overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGIN: "https://njpbs.org",
    FUNCTIONS_BASE_URL: BASE,
    CMS_EDGE_ORIGIN_SECRET: "edge-secret",
    TURNSTILE_SECRET: "turnstile-secret",
    IP_HASH_SALT: "salt",
    RATE_LIMITER: limiter,
    ...overrides,
  };
}

function makeDeps(options: { hostname?: string; startStatus?: number; completeStatus?: number; completeError?: string } = {}) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("siteverify")) return Response.json({ success: true, hostname: options.hostname ?? "njpbs.org" });
    if (url.endsWith("ugcGetConfig")) return Response.json({ open: false, texts: { closed: "This form is not open yet." } });
    if (url.endsWith("ugcStartSubmission")) return Response.json(
      options.startStatus ? { error: "closed" } : { submissionId: "sub-1", uploadUrl: "https://upload.example/", uploadHeaders: {}, expiresAt: NOW + UPLOAD_LEASE_MS },
      { status: options.startStatus ?? 200 },
    );
    if (url.endsWith("ugcCompleteSubmission") && (_init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"] === "1") {
      return Response.json({ quotaBytes: 0 });
    }
    if (url.endsWith("ugcCompleteSubmission")) return Response.json(
      options.completeStatus ? { error: options.completeError ?? "missing_upload" } : { ok: true },
      { status: options.completeStatus ?? 200 },
    );
    throw new Error(`Unexpected URL: ${url}`);
  });
  const deps: HandleDeps = { fetch, now: () => NOW, configCache: { expiresAt: 0, payload: null } };
  return { deps, fetch };
}

const startBody = {
  requestId: uuid(1), name: "Viewer", email: "viewer@example.org", message: "A message with enough detail.",
  consentVersion: "v1", consentTextHash: "a".repeat(64), consentChecked: true, ageAttested: true,
  file: { name: "video.mp4", type: "video/mp4", size: 100 }, turnstileToken: "token", website: "",
  timeElapsed: 5000,
};

function req(path: string, method: string, body?: unknown, origin = "https://njpbs.org"): Request {
  return new Request(`https://intake.njpbs.org${path}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": IP },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("share intake routes", () => {
  it("accepts only the configured origin and known routes", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    expect((await handleShareIntake(req("/start", "OPTIONS"), env, deps)).status).toBe(204);
    expect((await handleShareIntake(req("/start", "POST", startBody, "https://other.example"), env, deps)).status).toBe(403);
    expect((await handleShareIntake(req("/other", "GET"), env, deps)).status).toBe(404);
    expect((await handleShareIntake(req("/start", "GET"), env, deps)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    close();
  });

  it("caches config for no more than 60 seconds", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    expect((await handleShareIntake(req("/config", "GET"), env, deps)).status).toBe(200);
    deps.now = () => NOW + 30_000;
    expect((await handleShareIntake(req("/config", "GET"), env, deps)).headers.get("Cache-Control")).toBe("public, max-age=30");
    expect(fetch).toHaveBeenCalledTimes(1);
    deps.now = () => NOW + 60_000;
    await handleShareIntake(req("/config", "GET"), env, deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    close();
  });

  it("silently drops a honeypot or short dwell without verification or rate writes", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    for (const body of [{ ...startBody, website: "spam" }, { ...startBody, timeElapsed: 1000 }, { ...startBody, timeElapsed: undefined, startedAt: NOW - 5000 }]) {
      const res = await handleShareIntake(req("/start", "POST", body), env, deps);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect([...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM starts")][0].count).toBe(0);
    close();
  });

  it("accepts elapsed dwell even when the client clock is ahead", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps } = makeDeps();
    const response = await handleShareIntake(req("/start", "POST", { ...startBody, startedAt: NOW + 60_000 }), env, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ submissionId: "sub-1" });
    close();
  });

  it("fails closed on configuration errors and a foreign Turnstile hostname", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    const broken = { ...env, FUNCTIONS_BASE_URL: "http://insecure.example" };
    expect((await handleShareIntake(req("/start", "POST", startBody), broken, deps)).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect([...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM starts")][0].count).toBe(0);
    const foreign = makeDeps({ hostname: "other.example" });
    expect((await handleShareIntake(req("/start", "POST", startBody), env, foreign.deps)).status).toBe(403);
    expect(foreign.fetch).toHaveBeenCalledTimes(1);
    close();
  });

  it("rejects non-JSON and a streamed body over 8 KiB", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps } = makeDeps();
    const plain = req("/start", "POST", startBody);
    plain.headers.set("Content-Type", "text/plain");
    expect((await handleShareIntake(plain, env, deps)).status).toBe(400);
    const large = req("/start", "POST", { ...startBody, message: "x".repeat(9_000) });
    large.headers.delete("Content-Length");
    expect((await handleShareIntake(large, env, deps)).status).toBe(413);
    close();
  });

  it("forwards the agreed body and headers, then releases the slot on complete", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    const start = await handleShareIntake(req("/start", "POST", startBody), env, deps);
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ submissionId: "sub-1" });
    const call = fetch.mock.calls.find(([url]) => url.endsWith("ugcStartSubmission"));
    expect(call).toBeDefined();
    const init = call![1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-njpbs-cms-edge"]).toBe("edge-secret");
    expect((init.headers as Record<string, string>)["x-njpbs-client-ip"]).toBe(IP);
    expect(init.redirect).toBe("manual");
    const forwarded = JSON.parse(init.body as string);
    expect(forwarded.requestId).toBe(startBody.requestId);
    expect(forwarded.clientIpHash).toMatch(/^[0-9a-f]{32}$/);
    expect(forwarded.turnstileToken).toBeUndefined();
    expect(forwarded.website).toBeUndefined();
    expect((await handleShareIntake(req("/start", "POST", { ...startBody, requestId: uuid(2) }), env, deps)).status).toBe(429);
    const complete = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
    expect(await complete.json()).toEqual({ ok: true });
    expect((await handleShareIntake(req("/start", "POST", { ...startBody, requestId: uuid(2) }), env, deps)).status).toBe(200);
    close();
  });

  it("passes Function errors through and frees a refused reservation", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps } = makeDeps({ startStatus: 403 });
    const res = await handleShareIntake(req("/start", "POST", startBody), env, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "closed" });
    expect([...sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM starts")][0].count).toBe(0);
    close();
  });

  it("releases the upload slot after a rejected file", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps } = makeDeps({ completeStatus: 422, completeError: "rejected_file" });
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const complete = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
    expect(complete.status).toBe(422);
    expect(await complete.json()).toEqual({ error: "rejected_file" });
    expect((await handleShareIntake(req("/start", "POST", { ...startBody, requestId: uuid(2) }), env, deps)).status).toBe(200);
    close();
  });

  it("retries the same request ID after a lost Function response", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    let failed = false;
    deps.fetch = async (url, init) => {
      if (url.endsWith("ugcStartSubmission") && !failed) {
        failed = true;
        throw new Error("Connection closed");
      }
      return fetch(url, init);
    };
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(502);
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    expect((await handleShareIntake(req("/start", "POST", { ...startBody, requestId: uuid(2) }), env, deps)).status).toBe(429);
    close();
  });

  it.each(["missing", "unaccepted"])("refuses completion with a %s start", async (state) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    const completion = { submissionId: "sub-1", requestId: uuid(1) };
    if (state === "unaccepted") {
      deps.fetch = async (url, init) => {
        if (url.endsWith("ugcStartSubmission")) throw new Error("Connection closed");
        return fetch(url, init);
      };
      expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(502);
    }
    expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status).toBe(429);
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
    close();
  });

  it.each(["request", "submission", "IP"])("refuses a completion with a different %s binding", async (binding) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const before = [...sql.exec("SELECT * FROM starts")];
    const completion = req("/complete", "POST", {
      submissionId: binding === "submission" ? "sub-other" : "sub-1",
      requestId: binding === "request" ? uuid(2) : uuid(1),
    });
    if (binding === "IP") completion.headers.set("CF-Connecting-IP", "203.0.113.6");
    const response = await handleShareIntake(completion, env, deps);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited", retryAfter: 1 });
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
    expect([...sql.exec("SELECT * FROM starts")]).toEqual(before);
    expect((await handleShareIntake(req("/start", "POST", { ...startBody, requestId: uuid(2) }), env, deps)).status).toBe(429);
    close();
  });

  it.each(["accepted", "rejected", "unavailable", "lost response"])("bounds completion attempts when the origin result is %s", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps({
      completeStatus: outcome === "rejected" ? 422 : outcome === "unavailable" ? 503 : undefined,
      completeError: outcome === "rejected" ? "rejected_file" : "unavailable",
    });
    if (outcome === "lost response") {
      deps.fetch = async (url, init) => {
        const result = await fetch(url, init);
        if (url.endsWith("ugcCompleteSubmission")) throw new Error("Connection closed");
        return result;
      };
    }
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const completion = { submissionId: "sub-1", requestId: uuid(1) };
    expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status)
      .toBe(outcome === "rejected" ? 422 : outcome === "unavailable" ? 503 : outcome === "lost response" ? 502 : 200);
    // A repeated start must not restore consumed completion admission.
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const retryable = outcome === "unavailable" || outcome === "lost response";
    if (retryable) {
      for (let attempt = 2; attempt <= 3; attempt++) {
        expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status)
          .toBe(outcome === "unavailable" ? 503 : 502);
      }
    }
    expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status).toBe(429);
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(retryable ? 3 : 1);
    close();
  });

  it.each(["accepted", "rejected", "exhausted"])("returns a client-handled terminal error for an %s claim", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps({
      completeStatus: outcome === "rejected" ? 422 : outcome === "exhausted" ? 503 : undefined,
      completeError: outcome === "rejected" ? "rejected_file" : "unavailable",
    });
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      const completion = { submissionId: "sub-1", requestId: uuid(1) };
      for (let attempt = 0; attempt < (outcome === "exhausted" ? 3 : 1); attempt++) {
        await handleShareIntake(req("/complete", "POST", completion), env, deps);
      }
      deps.now = () => NOW + 10 * 60 * 1000;
      const response = await handleShareIntake(req("/complete", "POST", completion), env, deps);
      expect(response.status).toBe(429);
      // The existing form clears its request when it receives expired.
      expect(await response.json()).toEqual({ error: "expired" });
      expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(outcome === "exhausted" ? 3 : 1);
    } finally { close(); }
  });

  it("reclaims a lost claim response after its lease without resetting the budget", async () => {
    const { sql, close } = makeSql();
    let loseClaim = true;
    const env = makeEnv({ idFromName: (name) => name, get: () => ({ apply: async (input) => {
      const result = applyLimit(sql, input);
      if (input.action === "claim_complete" && loseClaim) {
        loseClaim = false;
        throw new Error("Claim response lost");
      }
      return result;
    } }) });
    const { deps, fetch } = makeDeps();
    const completion = { submissionId: "sub-1", requestId: uuid(1) };
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status).toBe(502);
      deps.now = () => NOW + 1000;
      const busy = await handleShareIntake(req("/complete", "POST", completion), env, deps);
      expect(busy.status).toBe(429);
      expect(await busy.json()).toEqual({ error: "rate_limited", retryAfter: 599 });
      expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
      deps.now = () => NOW + 10 * 60 * 1000;
      const recovered = await handleShareIntake(req("/complete", "POST", completion), env, deps);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ ok: true });
      expect([...sql.exec<{ attempts: number }>("SELECT attempts FROM completions")][0].attempts).toBe(2);
    } finally { close(); }
  });

  it("does not forward a claim response received after its lease expires", async () => {
    const { sql, close } = makeSql();
    const { deps, fetch } = makeDeps();
    const env = makeEnv({ idFromName: (name) => name, get: () => ({ apply: async (input) => {
      const result = applyLimit(sql, input);
      if (input.action === "claim_complete") deps.now = () => NOW + 10 * 60 * 1000;
      return result;
    } }) });
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      expect((await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps)).status).toBe(502);
      expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
    } finally { close(); }
  });

  it("returns a terminal error after a fenced upload's reservation leaves the ledger", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    const acceptedAt = 101 * DAY_MS - HOUR_MS / 2;
    deps.now = () => acceptedAt;
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      deps.now = () => acceptedAt + UPLOAD_LEASE_MS + HOUR_MS + 1;
      const [row] = [...sql.exec<{ ip_hash: string }>("SELECT ip_hash FROM starts WHERE request_id = ?", uuid(1))];
      reconcile(sql, { requestId: uuid(1), ipHash: row.ip_hash, submissionId: "sub-1" }, deps.now(), 0);
      deps.now = () => acceptedAt + 2 * DAY_MS;
      applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: "b".repeat(32), bytes: 100, now: deps.now() });
      const response = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "expired" });
      expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
    } finally { close(); }
  });

  it.each(["success", "rejection"])("preserves terminal origin %s if slot release fails", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv({ idFromName: (name) => name, get: () => ({ apply: async (input) => {
      if (input.action === "complete") throw new Error("Slot release unavailable");
      return applyLimit(sql, input);
    } }) });
    const { deps } = makeDeps({ completeStatus: outcome === "rejection" ? 422 : undefined, completeError: "rejected_file" });
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      const response = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
      expect(response.status).toBe(outcome === "rejection" ? 422 : 200);
      expect(await response.json()).toEqual(outcome === "rejection" ? { error: "rejected_file" } : { ok: true });
    } finally { close(); }
  });

  it("aborts a pending origin request at the completion lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    deps.now = () => Date.now();
    let entered!: () => void;
    const enteredOrigin = new Promise<void>((resolve) => { entered = resolve; });
    deps.fetch = async (url, init) => {
      if (!url.endsWith("ugcCompleteSubmission")) return fetch(url, init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Origin request aborted")), { once: true });
        entered();
      });
    };
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      const pending = handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
      await enteredOrigin;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect((await pending).status).toBe(502);
      deps.fetch = fetch;
      expect((await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps)).status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally { close(); vi.useRealTimers(); }
  });

  it.each(["missing upload", "unavailable", "lost response"])("completes a bounded retry after %s", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    let failed = false;
    deps.fetch = async (url, init) => {
      if (url.endsWith("ugcCompleteSubmission") && !failed) {
        failed = true;
        await fetch(url, init);
        if (outcome === "lost response") throw new Error("Connection closed");
        return Response.json({ error: outcome === "missing upload" ? "missing_upload" : "unavailable" },
          { status: outcome === "missing upload" ? 404 : 503 });
      }
      return fetch(url, init);
    };
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const completion = { submissionId: "sub-1", requestId: uuid(1) };
    expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status)
      .toBe(outcome === "missing upload" ? 404 : outcome === "unavailable" ? 503 : 502);
    // The form reuses /start and the same upload reservation for missing bytes.
    if (outcome === "missing upload") {
      expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    }
    const retry = await handleShareIntake(req("/complete", "POST", completion), env, deps);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status).toBe(429);
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(2);
    close();
  });

  it("refuses overlapping completions before either origin call finishes", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    let finish: ((response: Response) => void) | undefined;
    let entered!: () => void;
    const enteredOrigin = new Promise<void>((resolve) => { entered = resolve; });
    deps.fetch = async (url, init) => {
      if (url.endsWith("ugcCompleteSubmission")) {
        const response = await fetch(url, init);
        if (finish) return response;
        return new Promise<Response>((resolve) => { finish = resolve; entered(); });
      }
      return fetch(url, init);
    };
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    const completion = { submissionId: "sub-1", requestId: uuid(1) };
    const first = handleShareIntake(req("/complete", "POST", completion), env, deps);
    await enteredOrigin;
    try {
      expect((await handleShareIntake(req("/complete", "POST", completion), env, deps)).status).toBe(429);
      expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(1);
    } finally {
      finish!(Response.json({ ok: true }));
      expect((await first).status).toBe(200);
      close();
    }
  });

  it.each(["absent", "present", "unavailable"])("reconciles abandoned reservations through the origin when storage is %s", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    const later = NOW + UPLOAD_LEASE_MS + HOUR_MS;
    deps.now = () => later;
    deps.fetch = async (url, init) => {
      if ((init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"] === "1") {
        await fetch(url, init);
        const body = JSON.parse(init!.body as string);
        expect(body.clientIpHash).toBe(Number(body.requestId.slice(-12)).toString(16).padStart(32, "0"));
        return outcome === "unavailable" ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({ quotaBytes: outcome === "present" ? 500 * 1024 * 1024 : 0 });
      }
      return fetch(url, init);
    };
    try {
      for (let i = 1; i <= 4; i++) {
        const binding = { requestId: uuid(i), ipHash: i.toString(16).padStart(32, "0"), submissionId: `sub-${i}` };
        applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW });
        applyLimit(sql, { action: "accept", ...binding, now: NOW });
      }
      const response = await handleShareIntake(req("/start", "POST", {
        ...startBody, requestId: uuid(5), file: { ...startBody.file, size: 100 * 1024 * 1024 },
      }), env, deps);
      expect(response.status).toBe(outcome === "absent" ? 200 : 429);
      expect(fetch.mock.calls.filter(([, init]) => (init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"] === "1")).toHaveLength(4);
      if (outcome === "unavailable") {
        expect(applyLimit(sql, { action: "reserve", requestId: uuid(6), ipHash: "f".repeat(32),
          bytes: 100 * 1024 * 1024, now: later + 1 }).allowed).toBe(false);
      }
    } finally { close(); }
  });

  it("does not forward a caller's reconciliation header", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    try {
      await handleShareIntake(req("/start", "POST", startBody), env, deps);
      const request = req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) });
      request.headers.set("x-njpbs-quota-reconcile", "1");
      expect((await handleShareIntake(request, env, deps)).status).toBe(200);
      const origin = fetch.mock.calls.find(([url]) => url.endsWith("ugcCompleteSubmission"));
      expect((origin![1]!.headers as Record<string, string>)["x-njpbs-quota-reconcile"]).toBeUndefined();
    } finally { close(); }
  });

  it.each(["success", "rejection", "expiry"])("settles the byte hold only from the origin %s", async (outcome) => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps } = makeDeps({
      completeStatus: outcome === "rejection" ? 422 : outcome === "expiry" ? 410 : undefined,
      completeError: outcome === "rejection" ? "rejected_file" : "expired",
    });
    try {
      await handleShareIntake(req("/start", "POST", { ...startBody, file: { ...startBody.file, size: 500 * 1024 * 1024 } }), env, deps);
      await handleShareIntake(req("/complete", "POST", {
        submissionId: "sub-1", requestId: uuid(1), uploaded: true, bytes: 1, ok: true,
      }), env, deps);
      const remaining = FORM_BYTES_PER_DAY - 500 * 1024 * 1024;
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: "b".repeat(32), bytes: remaining + 1, now: NOW }).allowed)
        .toBe(outcome !== "success");
      expect([...sql.exec("SELECT bytes, charged_at, expires_at FROM starts WHERE request_id = ?", uuid(1))])
        .toEqual([{ bytes: outcome === "success" ? 500 * 1024 * 1024 : 0, charged_at: NOW, expires_at: NOW }]);
    } finally { close(); }
  });

  it("refuses completion when the limiter is unavailable", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    env.RATE_LIMITER = { idFromName: (name) => name, get: () => ({ apply: async () => { throw new Error("Limiter unavailable"); } }) };
    const response = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
    expect(response.status).toBe(502);
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(0);
    close();
  });

  it("allows an accepted slow upload to complete after its signed URL lease expires", async () => {
    const { sql, close } = makeSql();
    const env = makeEnv(makeLimiter(sql));
    const { deps, fetch } = makeDeps();
    expect((await handleShareIntake(req("/start", "POST", startBody), env, deps)).status).toBe(200);
    deps.now = () => NOW + UPLOAD_LEASE_MS + 1;
    const response = await handleShareIntake(req("/complete", "POST", { submissionId: "sub-1", requestId: uuid(1) }), env, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("ugcCompleteSubmission") && !(init?.headers as Record<string, string>)?.["x-njpbs-quota-reconcile"])).toHaveLength(1);
    close();
  });
});

describe("share intake limiter", () => {
  const IP_A = "a".repeat(32);
  const IP_B = "b".repeat(32);

  it.each(["retry_complete", "complete"] as const)("fences a stale %s from a reclaimed attempt", (action) => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const lease = 10 * 60 * 1000;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 100, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW }).allowed).toBe(true);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW + lease }).allowed).toBe(true);
      const before = [...sql.exec("SELECT * FROM completions")];
      applyLimit(sql, { action, ...binding, attempt: 1, now: NOW + lease + 1000 });
      // Even the current attempt cannot settle another IP's reservation.
      applyLimit(sql, { action, ...binding, ipHash: IP_B, attempt: 2, now: NOW + lease + 1000 });
      expect([...sql.exec("SELECT * FROM completions")]).toEqual(before);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW + lease + 1000 }))
        .toEqual({ allowed: false, retryAfter: 599 });
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_A, bytes: 100, now: NOW + lease + 1000 }).allowed).toBe(false);
      applyLimit(sql, { action: "complete", ...binding, attempt: 2, now: NOW + lease + 1000 });
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW + 2 * lease }))
        .toEqual({ allowed: false, error: "expired" });
    } finally { close(); }
  });

  it("expires three abandoned attempts without reopening the completion budget", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const lease = 10 * 60 * 1000;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 100, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW + attempt * lease }).allowed).toBe(true);
      }
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW + 3 * lease }))
        .toEqual({ allowed: false, error: "expired" });
      expect([...sql.exec<{ attempts: number }>("SELECT attempts FROM completions")][0].attempts).toBe(3);
    } finally { close(); }
  });

  it("retains an active completion lease across UTC-day reservation cleanup", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const acceptedAt = 101 * DAY_MS - HOUR_MS / 2;
    const claimedAt = acceptedAt + HOUR_MS + 1;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 100, now: acceptedAt });
      applyLimit(sql, { action: "accept", ...binding, now: acceptedAt });
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: claimedAt }).allowed).toBe(true);
      const before = [...sql.exec("SELECT * FROM completions")];
      applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B, bytes: 100, now: claimedAt + 1 });
      expect([...sql.exec("SELECT * FROM completions")]).toEqual(before);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: claimedAt + 1000 }))
        .toEqual({ allowed: false, retryAfter: 599 });
      applyLimit(sql, { action: "reserve", requestId: uuid(3), ipHash: IP_B, bytes: 100, now: acceptedAt + UPLOAD_LEASE_MS + HOUR_MS });
      // Connector finding PRRT_kwDOSuN5xc6rAMnP: an expired lease still needs
      // storage reconciliation before its reservation can leave the ledger.
      expect([...sql.exec("SELECT * FROM completions")]).toEqual(before);
      reconcile(sql, binding, acceptedAt + UPLOAD_LEASE_MS + HOUR_MS, 0);
      applyLimit(sql, { action: "reserve", requestId: uuid(4), ipHash: IP_B, bytes: 100, now: acceptedAt + 2 * DAY_MS });
      expect([...sql.exec("SELECT * FROM completions")]).toEqual([]);
    } finally { close(); }
  });

  it("adds the lease column once and preserves existing reservations and terminal claims", () => {
    const { sql, close } = makeSql(true);
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    try {
      sql.exec(`INSERT INTO starts (request_id, ip_hash, bytes, created_at, accepted_at, expires_at, submission_id)
        VALUES (?, ?, 100, ?, ?, ?, ?)`, uuid(1), IP_A, NOW, NOW, NOW + UPLOAD_LEASE_MS, "sub-1");
      sql.exec("INSERT INTO completions (request_id, submission_id, attempts, in_flight) VALUES (?, ?, 1, 1)", uuid(1), "sub-1");
      const starts = [...sql.exec("SELECT * FROM starts")];
      initializeLimiter(sql);
      initializeLimiter(sql);
      expect([...sql.exec("SELECT * FROM starts")]).toEqual(starts.map((row) => ({ ...row, charged_at: NOW, reconcile_until: null })));
      expect([...sql.exec("SELECT * FROM completions")]).toEqual([
        { request_id: uuid(1), submission_id: "sub-1", attempts: 1, in_flight: 1, lease_until: null },
      ]);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: NOW }))
        .toEqual({ allowed: false, error: "expired" });
    } finally { close(); }
  });

  it("limits accepted starts per IP per rolling hour and releases an expired lease", () => {
    const { sql, close } = makeSql();
    for (let i = 1; i <= 3; i++) {
      const at = NOW + i * 1000;
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(i), ipHash: IP_A, bytes: 100, now: at }).allowed).toBe(true);
      applyLimit(sql, { action: "accept", requestId: uuid(i), ipHash: IP_A, submissionId: `sub-${i}`, now: at });
      applyLimit(sql, { action: "complete", requestId: uuid(i), ipHash: IP_A, submissionId: `sub-${i}`, now: at });
    }
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(4), ipHash: IP_A, bytes: 100, now: NOW + 4000 }))
      .toEqual({ allowed: false, retryAfter: HOUR_MS / 1000 - 3 });
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(4), ipHash: IP_A, bytes: 100, now: NOW + HOUR_MS + 1001 }).allowed).toBe(true);
    close();
  });

  it("holds one upload per IP for 15 minutes and counts accepted bytes through completion", () => {
    const { sql, close } = makeSql();
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(1), ipHash: IP_A, bytes: 100, now: NOW }).allowed).toBe(true);
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_A, bytes: 100, now: NOW + 1 }))
      .toEqual({ allowed: false, retryAfter: UPLOAD_LEASE_MS / 1000 });
    applyLimit(sql, { action: "accept", requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1", now: NOW });
    applyLimit(sql, { action: "complete", requestId: uuid(1), ipHash: IP_B, submissionId: "sub-1", now: NOW + 2 });
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_A, bytes: 100, now: NOW + 3 }).allowed).toBe(false);
    applyLimit(sql, { action: "complete", requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1", now: NOW + 4 });
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_A, bytes: 100, now: NOW + 5 }).allowed).toBe(true);
    expect(applyLimit(sql, { action: "reserve", requestId: uuid(3), ipHash: IP_A, bytes: 100, now: NOW + UPLOAD_LEASE_MS + 5 }).allowed).toBe(true);
    close();
  });

  it("releases the byte budget after four abandoned maximum-size uploads expire", () => {
    const { sql, close } = makeSql();
    try {
      for (let i = 1; i <= 4; i++) {
        const binding = { requestId: uuid(i), ipHash: i.toString(16).padStart(32, "0"), submissionId: `sub-${i}` };
        expect(applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW }).allowed).toBe(true);
        applyLimit(sql, { action: "accept", ...binding, now: NOW });
      }
      const next = { action: "reserve" as const, requestId: uuid(5), ipHash: IP_A, bytes: 100 * 1024 * 1024 };
      expect(applyLimit(sql, { ...next, now: NOW }).allowed).toBe(false);
      const later = NOW + UPLOAD_LEASE_MS + HOUR_MS;
      expect(applyLimit(sql, { ...next, now: later }).allowed).toBe(false);
      for (let i = 1; i <= 4; i++) {
        reconcile(sql, { requestId: uuid(i), ipHash: i.toString(16).padStart(32, "0"), submissionId: `sub-${i}` }, later, 0);
      }
      expect(applyLimit(sql, { ...next, now: later }).allowed).toBe(true);
    } finally { close(); }
  });

  it.each([0, 500 * 1024 * 1024])("reconciles expired storage holding %i bytes before admitting another upload", (bytes) => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const later = NOW + UPLOAD_LEASE_MS + HOUR_MS;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      const next = { action: "reserve" as const, requestId: uuid(2), ipHash: IP_B, bytes: FORM_BYTES_PER_DAY, now: later };
      expect(applyLimit(sql, next).allowed).toBe(false);
      const claim = applyLimit(sql, { action: "claim_reconcile", ...binding, now: later });
      if (!claim.allowed || !claim.reconciliation) throw new Error("Reconciliation not admitted");
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: later }).allowed).toBe(false);
      applyLimit(sql, { action: "reconcile", ...binding, leaseUntil: claim.reconciliation.leaseUntil, bytes, now: later });
      expect(applyLimit(sql, next).allowed).toBe(bytes === 0);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: later }).allowed).toBe(bytes > 0);
    } finally { close(); }
  });

  it("preserves slow uploads for an hour after URL expiry before reconciliation", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const cutoff = NOW + UPLOAD_LEASE_MS + HOUR_MS;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      expect(applyLimit(sql, { action: "claim_reconcile", ...binding, now: cutoff - 1 }).allowed).toBe(false);
      const busy = applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B,
        bytes: FORM_BYTES_PER_DAY, now: cutoff - 1 });
      expect(busy).toEqual({ allowed: false, retryAfter: 1 });
      expect(applyLimit(sql, { action: "claim_reconcile", ...binding, now: cutoff }).allowed).toBe(true);
    } finally { close(); }
  });

  it("fences stale and mismatched reconciliation responses", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const later = NOW + UPLOAD_LEASE_MS + HOUR_MS;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      const first = applyLimit(sql, { action: "claim_reconcile", ...binding, now: later });
      if (!first.allowed || !first.reconciliation) throw new Error("Reconciliation not admitted");
      const again = first.reconciliation.leaseUntil;
      const second = applyLimit(sql, { action: "claim_reconcile", ...binding, now: again });
      if (!second.allowed || !second.reconciliation) throw new Error("Reconciliation not admitted");
      expect(applyLimit(sql, { action: "reconcile", ...binding, bytes: 0, leaseUntil: again, now: again }).allowed).toBe(false);
      expect(applyLimit(sql, { action: "reconcile", ...binding, ipHash: IP_B, bytes: 0,
        leaseUntil: second.reconciliation.leaseUntil, now: again }).allowed).toBe(false);
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B,
        bytes: FORM_BYTES_PER_DAY, now: again }).allowed).toBe(false);
    } finally { close(); }
  });

  it("retains a slow upload across midnight until its transfer grace ends", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const start = 101 * DAY_MS - HOUR_MS / 2;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: start });
      applyLimit(sql, { action: "accept", ...binding, now: start });
      applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B, bytes: 100,
        now: start + HOUR_MS + 1 });
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: start + HOUR_MS + 1 }).allowed).toBe(true);
    } finally { close(); }
  });

  it("counts active holds across midnight and successful bytes on their completion day", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const midnight = 101 * DAY_MS;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: midnight - 1000 });
      applyLimit(sql, { action: "accept", ...binding, now: midnight - 1000 });
      const next = { action: "reserve" as const, requestId: uuid(2), ipHash: IP_B, bytes: FORM_BYTES_PER_DAY - 500 * 1024 * 1024 + 1 };
      expect(applyLimit(sql, { ...next, now: midnight }).allowed).toBe(false);
      applyLimit(sql, { action: "claim_complete", ...binding, now: midnight });
      applyLimit(sql, { action: "complete", ...binding, attempt: 1, uploaded: true, now: midnight + 1 });
      // Cleanup must retain today's completed bytes even when accepted yesterday.
      expect(applyLimit(sql, { ...next, now: midnight + 2 * HOUR_MS }).allowed).toBe(false);
      expect(applyLimit(sql, { ...next, now: midnight + DAY_MS }).allowed).toBe(true);
    } finally { close(); }
  });

  it.each([0, 500 * 1024 * 1024])("retains prior-day uncharged uploads until reconciliation settles %i bytes", (bytes) => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    const start = 101 * DAY_MS - HOUR_MS / 2;
    const later = start + UPLOAD_LEASE_MS + HOUR_MS + 1;
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: start });
      applyLimit(sql, { action: "accept", ...binding, now: start });
      const next = { action: "reserve" as const, requestId: uuid(2), ipHash: IP_B,
        bytes: FORM_BYTES_PER_DAY, now: later };
      expect(applyLimit(sql, next)).toMatchObject({ allowed: false, reservations: [binding] });
      // Both a present object and an absent key need an origin receipt first.
      reconcile(sql, binding, later, bytes);
      expect([...sql.exec("SELECT bytes, charged_at FROM starts WHERE request_id = ?", binding.requestId)])
        .toEqual([{ bytes, charged_at: later }]);
      expect(applyLimit(sql, next).allowed).toBe(bytes === 0);
      expect(applyLimit(sql, { action: "claim_complete", ...binding, now: later }).allowed).toBe(bytes > 0);
      applyLimit(sql, { ...next, requestId: uuid(3), now: later + DAY_MS });
      expect([...sql.exec("SELECT * FROM starts WHERE request_id = ?", binding.requestId)]).toEqual([]);
    } finally { close(); }
  });

  it("does not extend an abandoned byte hold when start is retried", () => {
    const { sql, close } = makeSql();
    const binding = { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" };
    try {
      applyLimit(sql, { action: "reserve", ...binding, bytes: 500 * 1024 * 1024, now: NOW });
      applyLimit(sql, { action: "accept", ...binding, now: NOW });
      expect(applyLimit(sql, { action: "reserve", ...binding, bytes: 1, now: NOW + UPLOAD_LEASE_MS - 1 }))
        .toEqual({ allowed: true, existing: true });
      applyLimit(sql, { action: "accept", ...binding, now: NOW + UPLOAD_LEASE_MS - 1 });
      const expired = applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B,
        bytes: FORM_BYTES_PER_DAY, now: NOW + UPLOAD_LEASE_MS + HOUR_MS });
      expect(expired.allowed).toBe(false);
      expect(expired).toMatchObject({ reservations: [binding] });
      reconcile(sql, binding, NOW + UPLOAD_LEASE_MS + HOUR_MS, 0);
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(2), ipHash: IP_B,
        bytes: FORM_BYTES_PER_DAY, now: NOW + UPLOAD_LEASE_MS + HOUR_MS }).allowed).toBe(true);
    } finally { close(); }
  });

  it("migrates abandoned legacy holds without releasing terminal legacy charges", () => {
    const { sql, close } = makeSql(true);
    try {
      for (let i = 1; i <= 2; i++) {
        sql.exec(`INSERT INTO starts (request_id, ip_hash, bytes, created_at, accepted_at, expires_at, submission_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, uuid(i), i === 1 ? IP_A : IP_B, 500 * 1024 * 1024, NOW, NOW, NOW + UPLOAD_LEASE_MS, `sub-${i}`);
      }
      sql.exec("INSERT INTO completions (request_id, submission_id, attempts, in_flight) VALUES (?, ?, 1, 1)", uuid(2), "sub-2");
      initializeLimiter(sql);
      initializeLimiter(sql);
      const later = NOW + UPLOAD_LEASE_MS + HOUR_MS;
      reconcile(sql, { requestId: uuid(1), ipHash: IP_A, submissionId: "sub-1" }, later, 0);
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(3), ipHash: IP_A,
        bytes: FORM_BYTES_PER_DAY - 500 * 1024 * 1024 + 1, now: later }).allowed).toBe(false);
      expect(applyLimit(sql, { action: "reserve", requestId: uuid(3), ipHash: IP_A,
        bytes: FORM_BYTES_PER_DAY - 500 * 1024 * 1024, now: later }).allowed).toBe(true);
    } finally { close(); }
  });

  it("caps the form at 100 starts and 2 GiB of declared bytes per UTC day", () => {
    const countDb = makeSql();
    for (let i = 1; i <= 100; i++) {
      const ip = i.toString(16).padStart(32, "0");
      applyLimit(countDb.sql, { action: "reserve", requestId: uuid(i), ipHash: ip, bytes: 1, now: NOW });
      applyLimit(countDb.sql, { action: "accept", requestId: uuid(i), ipHash: ip, submissionId: `sub-${i}`, now: NOW });
    }
    expect(applyLimit(countDb.sql, { action: "reserve", requestId: uuid(101), ipHash: IP_A, bytes: 1, now: NOW }))
      .toEqual({ allowed: false, retryAfter: 12 * HOUR_MS / 1000 });
    countDb.close();

    const byteDb = makeSql();
    for (let i = 1; i <= 4; i++) {
      const ip = i.toString(16).padStart(32, "0");
      applyLimit(byteDb.sql, { action: "reserve", requestId: uuid(i), ipHash: ip, bytes: 500 * 1024 * 1024, now: NOW });
      applyLimit(byteDb.sql, { action: "accept", requestId: uuid(i), ipHash: ip, submissionId: `sub-${i}`, now: NOW });
    }
    expect(FORM_BYTES_PER_DAY).toBe(2 * 1024 * 1024 * 1024);
    expect(applyLimit(byteDb.sql, { action: "reserve", requestId: uuid(5), ipHash: IP_A, bytes: 100 * 1024 * 1024, now: NOW }).allowed).toBe(false);
    byteDb.close();
  });
});

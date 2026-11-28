import { afterEach, describe, expect, it, vi } from "vitest";
import cmsEdge from "../../functions/lib/cms-edge.js";
import { cmsEdgeFetch } from "../setup/cms-edge-fetch.js";
import authPkg from "../../functions/lib/auth.js";
import firebasePkg from "../../functions/lib/firebase.js";
import desktopSessions from "../../functions/lib/premiere-desktop-session.js";

const {
  CMS_EDGE_ORIGIN_SECRET,
  cmsEdgeOptions,
  secretsMatch,
  withCmsEdge,
} = cmsEdge;

function responseDouble() {
  const response = {
    headers: {},
    statusCode: null,
    body: null,
    set: vi.fn((name, value) => {
      response.headers[name] = value;
      return response;
    }),
    status: vi.fn((status) => {
      response.statusCode = status;
      return response;
    }),
    json: vi.fn((body) => {
      response.body = body;
      return response;
    }),
  };
  return response;
}

describe("CMS Function edge boundary", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); authPkg.resetAuthTokenCache(); });

  it.each(["auth/id-token-expired", "auth/id-token-revoked"])("preserves the precise masked refusal: %s", async code => {
    vi.spyOn(firebasePkg.admin.auth(), "verifyIdToken").mockRejectedValue(Object.assign(new Error("Synthetic refusal"), { code }));
    const wrapped = withCmsEdge(async (req, res) => {
      try { await authPkg.requireAuth(req); } catch { res.status(401).json({ error: "Access is unavailable", reason: "token_expired" }); }
    }, { readSecret: () => "expected-secret" });
    const response = responseDouble();
    await wrapped({ headers: { "x-njpbs-cms-edge": "expected-secret", authorization: "Bearer synthetic-refusal" } }, response);
    expect(response.body).toEqual({ error: "Access is unavailable", code: "session_expired",
      ...(code === "auth/id-token-expired" ? { reason: "token_expired" } : {}) });
  });

  it("preserves a session code when the handler masks an authentication error", async () => {
    const wrapped = withCmsEdge(async (req, res) => {
      try { await authPkg.requireAuth(req); }
      catch { res.status(401).json({ error: "Access is unavailable" }); }
    }, { readSecret: () => "expected-secret" });
    const response = responseDouble();
    await wrapped({ headers: { "x-njpbs-cms-edge": "expected-secret" } }, response);
    expect(response.body).toEqual({ error: "Access is unavailable", code: "session_expired" });
  });

  it("does not label a masked App Check refusal as a staff session error", async () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "false");
    const wrapped = withCmsEdge(async (_req, res) => {
      try { await authPkg.verifyAppCheckToken(undefined); }
      catch { res.status(401).json({ error: "Access is unavailable" }); }
    }, { readSecret: () => "expected-secret" });
    const response = responseDouble();
    await wrapped({ headers: { "x-njpbs-cms-edge": "expected-secret" } }, response);
    expect(response.body).toEqual({ error: "Access is unavailable" });
  });

  // One staff profile per uid behind the shared admin check, with access levels switched on.
  function refusalFixture(uid, accessTier) {
    vi.stubEnv("FUNCTION_TARGET", "cmsSyntheticAdminAction");
    vi.spyOn(firebasePkg.admin.auth(), "verifyIdToken").mockResolvedValue({ uid, email_verified: true });
    vi.spyOn(firebasePkg.db, "collection").mockImplementation(name => ({ doc: () => ({ get: async () => (name === "system"
      ? { exists: true, data: () => ({ schema: 1, state: "active", cleanScan: true }) }
      : { exists: true, data: () => ({ active: true, accessTier }) }) }) }));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const wrapped = withCmsEdge(async (req, res) => {
      try { await authPkg.requireAdmin(req); res.status(200).json({ ok: true }); }
      catch (error) { res.status(error.status ?? 500).json({ error: error.message }); }
    }, { logger, readSecret: () => "expected-secret" });
    const request = { headers: { "x-njpbs-cms-edge": "expected-secret", authorization: `Bearer ${uid}-token`,
      "x-njpbs-request-id": "request-1" } };
    return { logger, run: () => wrapped(request, responseDouble()) };
  }

  it("logs one permission refusal with the caller digest and no identifying fields", async () => {
    const { logger, run } = refusalFixture("staff-editor", "editor");
    await run();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("permission_refused", {
      event: "permission_refused",
      function: "cmsSyntheticAdminAction",
      required: "admin",
      accessTier: "editor",
      // SHA-256 of "staff-editor", the digest usage analytics keys people by.
      caller: "2f82f25ec33a07569fe10ecedd1d9044ed20f9880e63721c05a3c731080d5b26",
      requestId: "request-1",
    });
  });

  it("logs once through nested edge wrappers and records a caller who verified the token directly", async () => {
    vi.stubEnv("FUNCTION_TARGET", "cmsSyntheticReader");
    vi.spyOn(firebasePkg.admin.auth(), "verifyIdToken").mockResolvedValue({ uid: "staff-editor", email_verified: true });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const edge = { logger, readSecret: () => "expected-secret" };
    const inner = withCmsEdge(async (req, res) => {
      await authPkg.verifyAuthToken(req.headers.authorization);
      res.status(403).json({ error: "Unavailable" });
    }, edge);
    const outer = withCmsEdge((req, res) => inner(req, res), edge);
    await outer({ headers: { "x-njpbs-cms-edge": "expected-secret", authorization: "Bearer nested-token" } }, responseDouble());
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("permission_refused", {
      event: "permission_refused",
      function: "cmsSyntheticReader",
      required: null,
      accessTier: null,
      caller: "2f82f25ec33a07569fe10ecedd1d9044ed20f9880e63721c05a3c731080d5b26",
      requestId: null,
    });
  });

  it("records the caller of a refused Premiere desktop session", async () => {
    vi.stubEnv("FUNCTION_TARGET", "cmsPremiereRequest");
    const firestore = { collection: name => ({ doc: () => ({ get: async () => (name === "system"
      ? { exists: true, data: () => ({ schema: 1, state: "active", cleanScan: true }) }
      : { exists: true, data: () => ({ active: false, accessTier: "editor" }) }) }) }) };
    const auth = { getUser: async () => ({ disabled: false, emailVerified: true }) };
    const sessions = desktopSessions.createDesktopSessions({ firestore, auth, now: () => 1_000_000_000 });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const wrapped = withCmsEdge(async (_req, res) => {
      try { await sessions.activeActor("staff-editor", 999_999); res.status(200).json({ ok: true }); }
      catch (error) { res.status(error.status ?? 500).json({ error: error.message }); }
    }, { logger, readSecret: () => "expected-secret" });
    await wrapped({ headers: { "x-njpbs-cms-edge": "expected-secret" } }, responseDouble());
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("permission_refused", {
      event: "permission_refused",
      function: "cmsPremiereRequest",
      required: "active_staff",
      accessTier: "editor",
      caller: "2f82f25ec33a07569fe10ecedd1d9044ed20f9880e63721c05a3c731080d5b26",
      requestId: null,
    });
  });

  it("logs nothing for a permitted call", async () => {
    const { logger, run } = refusalFixture("staff-admin", "admin");
    await run();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses a constant-time equality contract for exact nonempty secrets", () => {
    expect(secretsMatch("same-secret", "same-secret")).toBe(true);
    expect(secretsMatch("same-secret", "wrong-secret")).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch("short", "longer")).toBe(false);
  });

  it("refuses a direct request before the Function handler runs", async () => {
    const handler = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const wrapped = withCmsEdge(handler, {
      logger,
      readSecret: () => "expected-secret",
    });
    const res = responseDouble();

    await wrapped(
      { headers: {}, method: "POST", path: "/cmsListContent" },
      res,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "CMS API edge is required" });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not trust the client IP header when the edge secret is wrong", async () => {
    const handler = vi.fn();
    const wrapped = withCmsEdge(handler, {
      logger: { error: vi.fn(), warn: vi.fn() },
      readSecret: () => "expected-secret",
    });
    const req = {
      headers: {
        "x-forwarded-for": "198.51.100.9",
        "x-njpbs-client-ip": "203.0.113.8",
        "x-njpbs-cms-edge": "wrong-secret",
      },
      method: "POST",
      path: "/cmsSaveContent",
    };

    await wrapped(req, responseDouble());

    expect(handler).not.toHaveBeenCalled();
    expect(req.headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  it("allows the edge request and does not replace Function authorization", async () => {
    const handler = vi.fn(async (_req, res) => {
      res.status(401).json({ error: "Missing bearer token" });
    });
    const wrapped = withCmsEdge(handler, {
      logger: { error: vi.fn(), warn: vi.fn() },
      readSecret: () => "expected-secret",
    });
    const res = responseDouble();

    await wrapped(
      {
        headers: { "x-njpbs-cms-edge": "expected-secret" },
        method: "POST",
        path: "/cmsListContent",
      },
      res,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(401);
  });

  it("replaces an untrusted forwarded address with the edge-verified client IP", async () => {
    const handler = vi.fn(async (req, res) => {
      res.status(200).json({ source: req.headers["x-forwarded-for"] });
    });
    const wrapped = withCmsEdge(handler, {
      logger: { error: vi.fn(), warn: vi.fn() },
      readSecret: () => "expected-secret",
    });
    const res = responseDouble();

    await wrapped(
      {
        get ip() {
          return "198.51.100.10";
        },
        headers: {
          "x-forwarded-for": "198.51.100.9",
          "x-njpbs-client-ip": "203.0.113.8",
          "x-njpbs-cms-edge": "expected-secret",
        },
        method: "POST",
        path: "/cmsSaveContent",
      },
      res,
    );

    expect(res.body).toEqual({ source: "203.0.113.8" });
  });

  it("adds the edge secret and omits production CORS middleware", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "false");
    const existingSecret = { name: "EXISTING" };
    const options = cmsEdgeOptions({
      cors: true,
      maxInstances: 5,
      secrets: [existingSecret],
    });

    expect(options).toMatchObject({ maxInstances: 5 });
    expect(options).not.toHaveProperty("cors");
    expect(options.secrets).toEqual([existingSecret, CMS_EDGE_ORIGIN_SECRET]);
  });

  it("preserves endpoint CORS for direct emulator development", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "true");
    const cors = ["http://localhost:5173", /127\.0\.0\.1/];

    expect(cmsEdgeOptions({ cors }).cors).toEqual(cors);
  });

  it("does not add the edge secret to emulator CORS preflight requests", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const fetch = cmsEdgeFetch(request, "127.0.0.1:5001");

    await fetch(
      "http://127.0.0.1:5001/demo-njpbs/us-central1/cmsSaveContent",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization,content-type,x-njpbs-cms-edge",
        },
      },
    );

    expect(
      new Headers(request.mock.calls[0][1].headers).has("x-njpbs-cms-edge"),
    ).toBe(false);
  });
});

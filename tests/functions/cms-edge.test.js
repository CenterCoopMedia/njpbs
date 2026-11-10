import { afterEach, describe, expect, it, vi } from "vitest";
import cmsEdge from "../../functions/lib/cms-edge.js";
import { cmsEdgeFetch } from "../setup/cms-edge-fetch.js";
import authPkg from "../../functions/lib/auth.js";
import firebasePkg from "../../functions/lib/firebase.js";

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

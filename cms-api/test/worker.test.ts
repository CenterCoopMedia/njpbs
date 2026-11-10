import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, SignJWT } from "jose";
import { FirebaseTokenError, verifyFirebaseIdToken } from "../src/firebase-auth";
import { createCmsApiHandler, validateStaffSiteAccess, type CmsApiEnv } from "../src/index";
import { ENDPOINTS, RATE_POLICIES } from "../src/config";
import type { CmsRateLimiter, ConsumeResult } from "../src/rate-limiter";

const ALLOWED: ConsumeResult = {
  allowed: true,
  remaining: 10,
  retryAfterSeconds: 0,
};

function fakeEnv(
  consume: (name: string) => ConsumeResult | Promise<ConsumeResult> = () =>
    ALLOWED,
): CmsApiEnv {
  const namespace = {
    getByName(name: string) {
      return {
        consume: () => consume(name),
      };
    },
  } as unknown as DurableObjectNamespace<CmsRateLimiter>;
  return {
    ALLOW_LOCAL_ORIGINS: "false",
    CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests",
    FIREBASE_PROJECT_ID: "njpbs-site",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
    RATE_LIMITERS: namespace,
  };
}

function request(
  endpoint: string,
  init: RequestInit = {},
): Request {
  const {
    body,
    headers: requestHeaders = {},
    method = "POST",
    ...rest
  } = init;
  return new Request(`https://api.example.org/${endpoint}`, {
    ...rest,
    method,
    headers: {
      authorization: "Bearer valid-token",
      "cf-connecting-ip": "203.0.113.8",
      "content-type": "application/json",
      origin: "https://admin.njpbs.org",
      ...(requestHeaders as Record<string, string>),
    },
    body:
      body ??
      (method === "GET" || method === "HEAD" || method === "OPTIONS"
        ? undefined
        : "{}"),
  });
}

function handler(fetchOrigin: typeof fetch = vi.fn()) {
  return createCmsApiHandler({
    fetchOrigin,
    now: () => 1_000,
    randomUUID: () => "request-id",
    verifyToken: async () => ({ uid: "editor-1" }),
  });
}

it("drops usage analytics at its own exhausted budget while editorial metadata stays available", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
  const worker = handler(fetchOrigin);
  const environment = fakeEnv(name => name.includes(":usage:")
    ? { allowed: false, remaining: 0, retryAfterSeconds: 10 } : ALLOWED);
  expect((await worker.fetch(request("cmsCollectBoardwalkUsage"), environment)).status).toBe(429);
  expect((await worker.fetch(request("cmsUpdateMediaMetadata"), environment)).status).toBe(200);
  expect(fetchOrigin).toHaveBeenCalledTimes(1);
});

it("refuses expensive usage reports at their own budget without denying editorial reads", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
  const worker = handler(fetchOrigin);
  const environment = fakeEnv(name => name.includes(":usageReport:")
    ? { allowed: false, remaining: 0, retryAfterSeconds: 60 } : ALLOWED);
  expect((await worker.fetch(request("cmsGetBoardwalkUsage"), environment)).status).toBe(429);
  expect((await worker.fetch(request("cmsGetContent"), environment)).status).toBe(200);
  expect(fetchOrigin).toHaveBeenCalledTimes(1);
});

describe("server-side sign-in audit", () => {
  const AUDIT_URL = "registerStaffProfile";
  function session() {
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext;
    return { ctx, settled: () => Promise.all(tasks) };
  }
  function audited(fetchOrigin: ReturnType<typeof vi.fn<typeof fetch>>) {
    return fetchOrigin.mock.calls.filter(([url]) => String(url).endsWith(`/${AUDIT_URL}`));
  }
  function worker(fetchOrigin: typeof fetch, authTimes: number[] = [100], now: () => number = Date.now) {
    return createCmsApiHandler({ fetchOrigin, now, verifyToken: async () =>
      ({ uid: "editor-1", authTime: authTimes.length > 1 ? authTimes.shift()! : authTimes[0]! }) });
  }

  it("asks the admission boundary once when a session reads without signing in through the client", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    const api = worker(fetchOrigin);
    const { ctx, settled } = session();
    await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
    await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
    await settled();
    expect(audited(fetchOrigin)).toHaveLength(1);
    const [, init] = audited(fetchOrigin)[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer valid-token");
    expect(headers.get("x-njpbs-cms-edge")).toBe(fakeEnv().CMS_EDGE_ORIGIN_SECRET);
  });

  it("asks again for a new sign-in, after a server failure, an unverified refusal, an expired token, a failed row write and an unreadable reply", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcomes = [new Response("{}", { status: 503 }),
      Response.json({ code: "unverified_email" }, { status: 403 }),
      Response.json({ code: "session_expired" }, { status: 401 }),
      Response.json({ success: true, auditPending: true }),
      new Response("{"),
      Response.json({ success: true }),
      Response.json({ code: "inactive_account" }, { status: 403 })];
    const fetchOrigin = vi.fn<typeof fetch>(async (url) => String(url).endsWith(`/${AUDIT_URL}`)
      ? outcomes.shift()! : Response.json({ success: true }));
    let clock = 1_000_000;
    const api = worker(fetchOrigin, [100, 100, 100, 100, 100, 100, 100, 200, 200], () => clock);
    const { ctx, settled } = session();
    for (let reads = 0; reads < 9; reads += 1) {
      await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
      await settled();
      clock += 60_000;
    }
    expect(audited(fetchOrigin)).toHaveLength(7);
  });

  it("waits out the retry delay after an unverified refusal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async (url) => String(url).endsWith(`/${AUDIT_URL}`)
      ? Response.json({ code: "unverified_email" }, { status: 403 }) : Response.json({ success: true }));
    let clock = 1_000_000;
    const api = worker(fetchOrigin, [100], () => clock);
    const { ctx, settled } = session();
    for (let reads = 0; reads < 5; reads += 1) {
      await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
      await settled();
      clock += 1_000;
    }
    expect(audited(fetchOrigin)).toHaveLength(1);
    clock += 60_000;
    await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
    expect(audited(fetchOrigin)).toHaveLength(2);
  });

  it("still asks after a client admission call that may not have reached the writer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    const api = worker(fetchOrigin);
    const { ctx, settled } = session();
    await api.fetch(request(AUDIT_URL), fakeEnv(), ctx);
    expect(audited(fetchOrigin)).toHaveLength(1);
    await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
    await settled();
    expect(audited(fetchOrigin)).toHaveLength(2);
  });

  it("does not treat a studio connector as a sign-in", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    const api = createCmsApiHandler({ fetchOrigin,
      verifyToken: async () => ({ uid: "device-1", authTime: 100, deviceIdentity: true }) });
    const { ctx, settled } = session();
    await api.fetch(request("cmsListContent"), fakeEnv(), ctx);
    await settled();
    expect(audited(fetchOrigin)).toHaveLength(0);
  });
});

it.each([
  ["timeout", async () => { throw new DOMException("Request timed out", "TimeoutError"); }],
  ["non-200 response", async () => new Response("Unavailable", { status: 503 })],
  ["unparseable JSON", async () => new Response("not JSON")],
  ["invalid key set", async () => Response.json({ keys: "invalid" })],
  ["network failure", async () => { throw new TypeError("Fetch failed"); }],
  ["auth-like infrastructure message", async () => { throw new Error("Invalid or expired authentication token"); }],
] as const)("returns a retryable refusal without a session code for JWKS %s", async (_label, fetchKeys) => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { privateKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({ auth_time: Math.floor(Date.now() / 1_000) })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://securetoken.google.com/njpbs-site")
    .setAudience("njpbs-site")
    .setSubject("editor-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  const keySet = createRemoteJWKSet(new URL("https://keys.example.test/jwks"), {
    [customFetch]: fetchKeys,
  });
  const fetchOrigin = vi.fn<typeof fetch>();
  const worker = createCmsApiHandler({
    fetchOrigin,
    verifyToken: (value, project) => verifyFirebaseIdToken(value, project, { keySet }),
  });
  const response = await worker.fetch(request("cmsListContent", {
    headers: { authorization: `Bearer ${token}` },
  }), fakeEnv());

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Authentication service is unavailable" });
  expect(fetchOrigin).not.toHaveBeenCalled();
});

async function signingKey(kid: string) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const token = await new SignJWT({ auth_time: Math.floor(Date.now() / 1_000) })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer("https://securetoken.google.com/njpbs-site")
    .setAudience("njpbs-site").setSubject("editor-1").setIssuedAt().setExpirationTime("1h")
    .sign(pair.privateKey);
  return { token, jwk: { ...await exportJWK(pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

it("keeps a new signing key retryable during cooldown without another key request", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const oldKey = await signingKey("old-key");
  const newKey = await signingKey("new-key");
  let published = oldKey.jwk;
  const fetchKeys = vi.fn(async () => Response.json({ keys: [published] }));
  const keySet = createRemoteJWKSet(new URL("https://keys.example.test/jwks"), {
    cooldownDuration: 5 * 60 * 1_000, [customFetch]: fetchKeys,
  });
  await verifyFirebaseIdToken(oldKey.token, "njpbs-site", { keySet });
  published = newKey.jwk;
  const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const worker = createCmsApiHandler({ fetchOrigin,
    verifyToken: (value, project) => verifyFirebaseIdToken(value, project, { keySet }) });
  const send = () => worker.fetch(request("cmsListContent", {
    headers: { authorization: `Bearer ${newKey.token}` },
  }), fakeEnv());

  const refused = await send();
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({ error: "Authentication service is unavailable" });
  expect(fetchKeys).toHaveBeenCalledOnce();
  expect(fetchOrigin).not.toHaveBeenCalled();

  await keySet.reload();
  expect((await send()).status).toBe(200);
  expect(fetchKeys).toHaveBeenCalledTimes(2);
  expect(fetchOrigin).toHaveBeenCalledOnce();
});

it("ends a session when the signing key is absent from freshly fetched keys", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const published = await signingKey("published-key");
  const unknown = await signingKey("absent-key");
  const fetchKeys = vi.fn(async () => Response.json({ keys: [published.jwk] }));
  const keySet = createRemoteJWKSet(new URL("https://keys.example.test/jwks"), {
    cooldownDuration: 5 * 60 * 1_000, [customFetch]: fetchKeys,
  });
  const fetchOrigin = vi.fn<typeof fetch>();
  const worker = createCmsApiHandler({ fetchOrigin,
    verifyToken: (value, project) => verifyFirebaseIdToken(value, project, { keySet }) });
  const refused = await worker.fetch(request("cmsListContent", {
    headers: { authorization: `Bearer ${unknown.token}` },
  }), fakeEnv());
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ code: "session_expired" });
  expect(fetchKeys).toHaveBeenCalledOnce();
  expect(fetchOrigin).not.toHaveBeenCalled();
});

it("labels only a cryptographically verified JWT expiry as token expiry", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const pair = await generateKeyPair("RS256", { extractable: true });
  const now = Math.floor(Date.now() / 1_000);
  const expired = await new SignJWT({ auth_time: now - 7_200 })
    .setProtectedHeader({ alg: "RS256", kid: "expired-key" }).setSubject("editor-1")
    .setIssuer("https://securetoken.google.com/njpbs-site").setAudience("njpbs-site")
    .setIssuedAt(now - 7_200).setExpirationTime(now - 60).sign(pair.privateKey);
  const keySet = createRemoteJWKSet(new URL("https://keys.example.test/jwks"), {
    [customFetch]: async () => Response.json({ keys: [{ ...await exportJWK(pair.publicKey), kid: "expired-key" }] }),
  });
  const fetchOrigin = vi.fn<typeof fetch>();
  const worker = createCmsApiHandler({ fetchOrigin,
    verifyToken: (value, project) => verifyFirebaseIdToken(value, project, { keySet }) });
  const refused = await worker.fetch(request("cmsListContent", { headers: { authorization: `Bearer ${expired}` } }), fakeEnv());
  expect(refused.status).toBe(401);
  expect(await refused.json()).toMatchObject({ code: "session_expired", reason: "token_expired" });
  expect(fetchOrigin).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CMS API edge", () => {
  it("admits only an explicitly stored-only dev report route and never forwards a mixed tuple", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dev = { ...fakeEnv(), CMS_DEPLOYMENT_ENVIRONMENT: "development",
      FIREBASE_PROJECT_ID: "njpbs-site-dev", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
      ADMIN_ORIGIN: "https://dev-admin.example.org", CMS_DEV_REPORT_INTAKE_MODE: "stored-only" };
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response('{"success":true}', { status: 201 }));
    const report = () => new Request("https://dev-api.example.org/cmsSubmitBugReport", request("cmsSubmitBugReport", {
      headers: { origin: "https://dev-admin.example.org", "content-type": "multipart/form-data; boundary=test" }, body: "--test--",
    }));
    expect((await handler(fetchOrigin).fetch(report(), dev)).status).toBe(201);
    expect(String(fetchOrigin.mock.calls[0][0])).toBe(`${dev.FUNCTIONS_ORIGIN}/cmsSubmitBugReport`);
    for (const replacement of [
      { CMS_DEV_REPORT_INTAKE_MODE: undefined }, { CMS_DEV_REPORT_INTAKE_MODE: "" },
      { CMS_DEV_REPORT_INTAKE_MODE: "send" }, { FIREBASE_PROJECT_ID: "njpbs-site" },
      { CMS_DEPLOYMENT_ENVIRONMENT: "production" }, { FUNCTIONS_ORIGIN: fakeEnv().FUNCTIONS_ORIGIN },
      { ADMIN_ORIGIN: "https://admin.njpbs.org" }, { ALLOW_LOCAL_ORIGINS: "true" },
      { CMS_DEPLOYMENT_ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "njpbs-site" },
    ]) {
      fetchOrigin.mockClear();
      const refused = await handler(fetchOrigin).fetch(report(), { ...dev, ...replacement });
      expect(refused.status).toBe(503);
      expect(refused.headers.get("cache-control")).toContain("no-store");
      expect(fetchOrigin).not.toHaveBeenCalled();
    }
    expect((await handler(fetchOrigin).fetch(request("cmsSubmitBugReport", { method: "OPTIONS",
      headers: { origin: dev.ADMIN_ORIGIN } }), { ...dev, CMS_DEV_REPORT_INTAKE_MODE: undefined })).status).toBe(503);
    expect((await handler(fetchOrigin).fetch(request("cmsGetBugReport", { headers: { origin: dev.ADMIN_ORIGIN } }), dev)).status).toBe(404);
    expect(fetchOrigin).not.toHaveBeenCalled();
    const productionTuple = new Request("https://dev-api.example.org/cmsSubmitBugReport", request("cmsSubmitBugReport", {
      headers: { "content-type": "multipart/form-data; boundary=test" }, body: "--test--",
    }));
    expect((await handler(fetchOrigin).fetch(productionTuple, fakeEnv())).status).toBe(503);
    expect(fetchOrigin).not.toHaveBeenCalled();
    expect((await handler(fetchOrigin).fetch(request("cmsSubmitBugReport", {
      headers: { "content-type": "multipart/form-data; boundary=test" }, body: "--test--",
    }), { ...fakeEnv(), CMS_DEV_REPORT_INTAKE_MODE: "stored-only" })).status).toBe(503);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("refuses mixed dev targets, unused endpoints, and production Admin origins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dev = {
      ...fakeEnv(),
      CMS_DEPLOYMENT_ENVIRONMENT: "development",
      FIREBASE_PROJECT_ID: "njpbs-site-dev",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
      ADMIN_ORIGIN: "https://dev-admin.example.org",
    };
    expect((await handler().fetch(request("cmsGetSettings"), dev)).status).toBe(403);
    const unavailable = await handler().fetch(request("cmsGetAnalytics", {
      headers: { origin: "https://dev-admin.example.org" },
    }), dev);
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    expect(unavailable.headers.get("x-njpbs-request-id")).toBe("request-id");
    const preflight = await handler().fetch(request("cmsGetAnalytics", {
      method: "OPTIONS", headers: { origin: "https://dev-admin.example.org" },
    }), dev);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    const mixed = await handler().fetch(request("cmsGetSettings", {
      headers: { origin: "https://dev-admin.example.org" },
    }), { ...dev, FIREBASE_PROJECT_ID: "njpbs-site" });
    expect(mixed.status).toBe(503);
    expect(mixed.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    expect(mixed.headers.get("x-njpbs-request-id")).toBe("request-id");
  });
  it("serves the enabled byline projection without calling the Firebase Function", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const authorId = `au_${"a".repeat(32)}`;
    const fetchOrigin = vi.fn<typeof fetch>(async (url) => {
      const address = String(url);
      if (address.includes("accounts:lookup")) {
        return new Response(JSON.stringify({ users: [{ localId: "editor-1", validSince: "90" }] }));
      }
      if (address.includes("/users/editor-1")) return new Response("{}");
      if (address.includes(":runQuery")) {
        return new Response(JSON.stringify([{ document: {
          name: `projects/njpbs-site/databases/(default)/documents/cmsBylineDirectory/${authorId}`,
          fields: {
            authorId: { stringValue: authorId },
            eligible: { booleanValue: true },
            displayName: { stringValue: "A reporter" },
            jobTitle: { nullValue: "NULL_VALUE" },
            profileReadiness: { mapValue: { fields: {
              hasPhoto: { booleanValue: true }, hasJobTitle: { booleanValue: false },
              hasBio: { booleanValue: true }, published: { booleanValue: true },
            } } },
          },
        } }]));
      }
      if (address.includes("/cmsBylineSelf/editor-1")) {
        return new Response(JSON.stringify({ fields: { authorId: { stringValue: authorId } } }));
      }
      throw new Error("Firebase Function should not be called");
    });
    const worker = createCmsApiHandler({
      fetchOrigin,
      verifyToken: async () => ({ uid: "editor-1", authTime: 100 }),
    });
    const env = { ...fakeEnv(), CMS_BYLINE_EDGE_ENABLED: "true",
      FIREBASE_WEB_API_KEY: "test-api-key-1234567890" };
    const response = await worker.fetch(request("cmsListBylineAuthors", {
      body: JSON.stringify({ limit: 2 }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiVersion: 1, success: true,
      authors: [{ authorId, displayName: "A reporter", jobTitle: null,
        profileReadiness: { hasPhoto: true, hasJobTitle: false, hasBio: true, published: true } }],
      nextCursor: null, selfAuthorId: authorId });
    expect(fetchOrigin).toHaveBeenCalledTimes(4);
    expect(response.headers.get("x-njpbs-byline-runtime")).toBe("cloudflare");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-njpbs-byline-runtime");
  });

  it("uses the existing Function response if the enabled byline projection is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("accounts:lookup")
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ apiVersion: 1, success: true,
          authors: [], nextCursor: null, selfAuthorId: null }),
        { headers: { "content-type": "application/json" } }),
    );
    const worker = createCmsApiHandler({
      fetchOrigin,
      verifyToken: async () => ({ uid: "editor-1", authTime: 100 }),
    });
    const response = await worker.fetch(request("cmsListBylineAuthors"), {
      ...fakeEnv(), CMS_BYLINE_EDGE_ENABLED: "true",
      FIREBASE_WEB_API_KEY: "test-api-key-1234567890",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-byline-runtime")).toBeNull();
    expect(fetchOrigin.mock.calls.map(([url]) => String(url))).toEqual([
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=test-api-key-1234567890",
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsListBylineAuthors",
    ]);
  });

  it("uses Functions readiness while older directory rows await backfill", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authorId = `au_${"a".repeat(32)}`;
    const body = { apiVersion: 1, success: true, authors: [{ authorId, displayName: "A reporter",
      jobTitle: null, profileReadiness: { hasPhoto: true, hasJobTitle: false, hasBio: true, published: true } }],
    nextCursor: null, selfAuthorId: null };
    const fetchOrigin = vi.fn<typeof fetch>(async url => {
      const address = String(url);
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
      if (address.includes("accounts:lookup")) return json({ users: [{ localId: "editor-1" }] });
      if (address.includes("/users/editor-1")) return json({});
      if (address.includes(":runQuery")) return json([{ document: {
        name: `projects/njpbs-site/databases/(default)/documents/cmsBylineDirectory/${authorId}`,
        fields: { authorId: { stringValue: authorId }, displayName: { stringValue: "A reporter" },
          jobTitle: { nullValue: "NULL_VALUE" }, eligible: { booleanValue: true } },
      } }]);
      if (address.includes("/cmsBylineSelf/editor-1")) return new Response("{}", { status: 404 });
      if (address.endsWith("/cmsListBylineAuthors")) return json(body);
      throw new Error("Unexpected fixture request");
    });
    const worker = createCmsApiHandler({ fetchOrigin,
      verifyToken: async () => ({ uid: "editor-1", authTime: 100 }) });
    const response = await worker.fetch(request("cmsListBylineAuthors"), { ...fakeEnv(),
      CMS_BYLINE_EDGE_ENABLED: "true", FIREBASE_WEB_API_KEY: "test-api-key-1234567890" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("x-njpbs-byline-runtime")).toBeNull();
    expect(fetchOrigin.mock.calls.filter(([url]) => String(url).endsWith("/cmsListBylineAuthors"))).toHaveLength(1);
  });

  it("rate-limits worker credentials by IP before the authentication document read", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const denied: ConsumeResult = { allowed: false, remaining: 0, retryAfterSeconds: 2 };
    const fetchOrigin = vi.fn<typeof fetch>();
    const verifyToken = vi.fn();
    const seenBuckets: string[] = [];
    const response = await createCmsApiHandler({ fetchOrigin, verifyToken }).fetch(
      request("videoTranscriptWorkerHeartbeat", {
        headers: { authorization: `Bearer ${"a".repeat(48)}`, origin: "" },
      }),
      fakeEnv((name) => {
        seenBuckets.push(name);
        return name.startsWith("v1:ip:worker:") ? denied : ALLOWED;
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-rate-limit-scope")).toBe("ip");
    expect(seenBuckets).toHaveLength(1);
    expect(fetchOrigin).not.toHaveBeenCalled();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("forwards bounded worker requests without Firebase staff authentication", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response("{}"));
    const verifyToken = vi.fn();
    const response = await createCmsApiHandler({ fetchOrigin, verifyToken }).fetch(
      request("videoTranscriptWorkerClaim", {
        headers: { authorization: `Bearer ${"a".repeat(48)}`, origin: "" },
      }),
      fakeEnv(),
    );
    expect(response.status).toBe(200);
    expect(verifyToken).not.toHaveBeenCalled();
    const [url, init] = fetchOrigin.mock.calls[0]!;
    expect(url).toBe("https://us-central1-njpbs-site.cloudfunctions.net/videoTranscriptWorkerClaim");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"a".repeat(48)}`);
  });

  it.each([
    ["cmsListTranscriptionCredentials", "read"],
    ["cmsSaveTranscriptionCredential", "mutation"],
    ["cmsDisconnectTranscriptionCredential", "mutation"],
    ["cmsGetTranscriptionOptions", "read"],
    ["cmsRequestByokVideoTranscript", "mutation"],
    ["cmsListVideoTranscripts", "read"],
  ] as const)("routes bounded %s without logging credential bodies", async (endpoint, rateClass) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response('{"success":true}', { headers: { "content-type": "application/json" } }));
    const body = JSON.stringify({ scope: "personal", provider: "openai", key: "synthetic-key-must-not-be-logged" });
    const response = await handler(fetchOrigin).fetch(request(endpoint, { body }), fakeEnv());
    expect(response.status).toBe(200);
    const maxBytes = (endpoint === "cmsSaveTranscriptionCredential" ? 16 : 8) * 1024;
    expect(ENDPOINTS[endpoint]).toEqual({ contentType: "json", maxBytes, rateClass });
    expect(fetchOrigin).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-key-must-not-be-logged");
    fetchOrigin.mockClear();
    const oversized = await handler(fetchOrigin).fetch(request(endpoint, { body: "x".repeat(maxBytes + 1) }), fakeEnv());
    expect(oversized.status).toBe(413);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it.each([
    ["cmsGetMediaReview", "read", 4],
    ["cmsSaveMediaReview", "mutation", 16],
    ["cmsListMediaComments", "read", 4],
    ["cmsMutateMediaComment", "mutation", 16],
  ] as const)("routes bounded media feedback endpoint %s", async (
    endpoint,
    rateClass,
    maxKib,
  ) => {
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response('{"success":true}', {
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await handler(fetchOrigin).fetch(
      request(endpoint, { body: JSON.stringify({ schemaVersion: 1 }) }),
      fakeEnv(),
    );
    expect(response.status).toBe(200);
    expect(ENDPOINTS[endpoint]).toEqual({
      contentType: "json",
      maxBytes: maxKib * 1024,
      rateClass,
    });
    expect(fetchOrigin.mock.calls[0][0]).toBe(
      `https://us-central1-njpbs-site.cloudfunctions.net/${endpoint}`,
    );
  });

  it("routes image replacement with upload limits and forwards the strong ETag", async () => {
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response('{"success":true}'));
    const worker = handler(fetchOrigin);
    const headers = { "content-type": "multipart/form-data; boundary=test", "if-match": '"asset-1:2"' };
    const response = await worker.fetch(request("cmsReplaceMediaBinary", { body: "--test--", headers }), fakeEnv());
    expect(response.status).toBe(200);
    expect(ENDPOINTS.cmsReplaceMediaBinary).toEqual(ENDPOINTS.cmsUploadMedia);
    expect(fetchOrigin.mock.calls[0][0]).toBe("https://us-central1-njpbs-site.cloudfunctions.net/cmsReplaceMediaBinary");
    expect(new Headers(fetchOrigin.mock.calls[0][1]?.headers).get("if-match")).toBe('"asset-1:2"');
    fetchOrigin.mockClear();
    expect((await worker.fetch(request("cmsReplaceMediaBinary", { headers: { ...headers, authorization: "" } }), fakeEnv())).status).toBe(401);
    expect((await worker.fetch(request("cmsReplaceMediaBinary", { headers: { ...headers, "content-length": String(ENDPOINTS.cmsReplaceMediaBinary.maxBytes + 1) } }), fakeEnv())).status).toBe(413);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it.each([
    ["cmsListBinnedMedia", "read"],
    ["cmsRestoreMedia", "metadata"],
  ] as const)("routes protected image bin endpoint %s", async (endpoint, rateClass) => {
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response('{"success":true}'));
    const worker = handler(fetchOrigin);
    const response = await worker.fetch(request(endpoint, {
      body: JSON.stringify({ assetId: "asset-1" }),
      headers: { "if-match": '"asset-1:2"' },
    }), fakeEnv());
    expect(response.status).toBe(200);
    expect(ENDPOINTS[endpoint]).toEqual({ contentType: "json", maxBytes: 4 * 1024, rateClass });
    expect(fetchOrigin.mock.calls[0][0]).toBe(`https://us-central1-njpbs-site.cloudfunctions.net/${endpoint}`);
    expect(new Headers(fetchOrigin.mock.calls[0][1]?.headers).get("if-match")).toBe('"asset-1:2"');
    fetchOrigin.mockClear();
    const denied = await worker.fetch(request(endpoint, { headers: { authorization: "" } }), fakeEnv());
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "session_expired" });
    const oversized = await worker.fetch(request(endpoint, { body: "x".repeat(4097) }), fakeEnv());
    expect(oversized.status).toBe(413);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it.each(['"', '\\'])("forwards maximum-length credential keys with JSON escaping for %s", async character => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response('{"success":true}', { headers: { "content-type": "application/json" } }));
    const body = JSON.stringify({ scope: "personal", provider: "elevenlabs", expectedRevision: 0, key: character.repeat(4096) });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(8 * 1024);
    expect((await handler(fetchOrigin).fetch(request("cmsSaveTranscriptionCredential", { body }), fakeEnv())).status).toBe(200);
    expect(fetchOrigin).toHaveBeenCalledOnce();
  });

  it.each(["ip", "actor"] as const)("keeps CORS and fails closed when the %s limiter rejects", async (scope) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    const env = fakeEnv(async (name) => {
      if (name.startsWith(`v1:${scope}:`)) throw new Error("private dependency detail");
      return ALLOWED;
    });
    const response = await handler(fetchOrigin).fetch(request("cmsListMedia"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
    expect(response.headers.get("x-njpbs-request-id")).toBe("request-id");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Request limit service is unavailable. Try again later." });
    expect(fetchOrigin).not.toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private dependency detail");
  });

  it("routes the bounded voiceover review and streams private audio unchanged", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/cmsGetVoiceoverAudio")) {
        return new Response(new TextEncoder().encode("WAVE"), {
          status: 200,
          headers: {
            "cache-control": "private, no-store",
            "content-length": "4",
            "content-type": "audio/wav",
          },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const seenBuckets: string[] = [];
    const env = fakeEnv((name) => {
      seenBuckets.push(name);
      return ALLOWED;
    });

    const review = await handler(fetchOrigin).fetch(
      request("cmsVoiceoverReview", {
        body: JSON.stringify({ action: "list", schemaVersion: 1 }),
      }),
      env,
    );
    const audio = await handler(fetchOrigin).fetch(
      request("cmsGetVoiceoverAudio", {
        body: JSON.stringify({ schemaVersion: 1, takeId: "soft-spoken-take-01" }),
      }),
      env,
    );

    expect(ENDPOINTS.cmsVoiceoverReview).toEqual({
      contentType: "json",
      maxBytes: 8 * 1024,
      rateClass: "mutation",
    });
    expect(ENDPOINTS.cmsGetVoiceoverAudio).toEqual({
      contentType: "json",
      maxBytes: 2 * 1024,
      rateClass: "read",
    });
    expect(review.status).toBe(200);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("cache-control")).toBe("private, no-store");
    expect(audio.headers.get("content-length")).toBe("4");
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
      new TextEncoder().encode("WAVE"),
    );
    expect(fetchOrigin.mock.calls.map(([url]) => url)).toEqual([
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsVoiceoverReview",
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsGetVoiceoverAudio",
    ]);
    expect(seenBuckets.some((name) => name.startsWith("v1:actor:mutation:")))
      .toBe(true);
    expect(seenBuckets.some((name) => name.startsWith("v1:actor:read:")))
      .toBe(true);
  });

  it("routes account requests and forwards only the Firebase App Check token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const seenBuckets: string[] = [];
    const response = await handler(fetchOrigin).fetch(
      request("submitStaffAccessRequest", {
        headers: {
          "x-firebase-appcheck": "valid-app-check-token",
          "x-firebase-appcheck-debug-token": "browser-forgery",
        },
        body: JSON.stringify({ reason: "I edit program pages." }),
      }),
      fakeEnv((name) => {
        seenBuckets.push(name);
        return ALLOWED;
      }),
    );

    expect(response.status).toBe(200);
    expect(ENDPOINTS.submitStaffAccessRequest).toEqual({
      contentType: "json",
      maxBytes: 4 * 1024,
      rateClass: "accountRequest",
    });
    expect(seenBuckets).toEqual(expect.arrayContaining([
      expect.stringMatching(/^v1:ip:accountRequest:/),
      expect.stringMatching(/^v1:actor:accountRequest:/),
    ]));
    expect(RATE_POLICIES.accountRequest).toEqual({
      actor: { capacity: 5, refillPerSecond: 1 / 86_400 },
      ip: { capacity: 5, refillPerSecond: 1 / 21_600 },
    });
    const [url, init] = fetchOrigin.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe(
      "https://us-central1-njpbs-site.cloudfunctions.net/submitStaffAccessRequest",
    );
    expect(headers.get("x-firebase-appcheck")).toBe("valid-app-check-token");
    expect(headers.has("x-firebase-appcheck-debug-token")).toBe(false);
  });

  it("rate-limits password recovery by IP and forwards it without a Firebase identity", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const verifyToken = vi.fn(async () => ({ uid: "should-not-run" }));
    const seenBuckets: string[] = [];
    const response = await createCmsApiHandler({
      fetchOrigin,
      now: () => 1_000,
      randomUUID: () => "request-id",
      verifyToken,
    }).fetch(
      request("requestStaffPasswordReset", {
        headers: {
          authorization: "",
          "x-firebase-appcheck": "valid-app-check-token",
        },
        body: JSON.stringify({ email: "person@example.org" }),
      }),
      fakeEnv((name) => {
        seenBuckets.push(name);
        return ALLOWED;
      }),
    );

    expect(response.status).toBe(200);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(seenBuckets).toHaveLength(1);
    expect(seenBuckets[0]).toMatch(/^v1:ip:accountRecovery:/);
    const headers = new Headers(fetchOrigin.mock.calls[0]![1]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-firebase-appcheck")).toBe("valid-app-check-token");
  });

  it("authenticates invalid tokens for every protected settings route", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: "Invalid App Check token" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "x-njpbs-cms-settings-contract": "newsroom-milestone-v1",
        },
      }),
    );
    const verifyToken = vi.fn(async () => {
      throw new FirebaseTokenError();
    });
    const seenBuckets: string[] = [];
    const worker = createCmsApiHandler({
      fetchOrigin,
      now: () => 1_000,
      randomUUID: () => "request-id",
      verifyToken,
    });

    for (const endpoint of [
      "cmsGetNewsroomBanner",
      "cmsGetSettings",
      "cmsGetCoverageLabels",
      "cmsPublishSettings",
      "cmsSaveSettings",
    ]) {
      const response = await worker.fetch(
        request(endpoint, {
          headers: {
            authorization: "Bearer invalid-token",
          },
        }),
        fakeEnv((name) => {
          seenBuckets.push(name);
          return ALLOWED;
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "session_expired" });
      expect(response.headers.get("x-njpbs-cms-settings-contract"))
        .toBe("newsroom-milestone-v1");
    }

    expect(verifyToken).toHaveBeenCalledTimes(5);
    expect(seenBuckets).toHaveLength(5);
    expect(seenBuckets).toEqual([
      expect.stringMatching(/^v1:ip:read:/),
      expect.stringMatching(/^v1:ip:read:/),
      expect.stringMatching(/^v1:ip:read:/),
      expect.stringMatching(/^v1:ip:publish:/),
      expect.stringMatching(/^v1:ip:mutation:/),
    ]);
    expect(fetchOrigin).not.toHaveBeenCalled();

    const unrelated = await worker.fetch(
      request("cmsListContent", {
        headers: { authorization: "Bearer invalid-token" },
      }),
      fakeEnv(),
    );
    expect(unrelated.status).toBe(401);
    expect(verifyToken).toHaveBeenCalledTimes(6);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("routes schedule and newsroom settings through bounded operation classes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const seenBuckets: string[] = [];
    const worker = handler(fetchOrigin);
    const env = fakeEnv((name) => {
      seenBuckets.push(name);
      return ALLOWED;
    });

    await expect(worker.fetch(request("cmsGetBroadcastSchedule"), env))
      .resolves.toMatchObject({ status: 200 });
    await expect(worker.fetch(request("cmsGetNewsroomBanner"), env))
      .resolves.toMatchObject({ status: 200 });
    await expect(worker.fetch(request("cmsGetSettings"), env))
      .resolves.toMatchObject({ status: 200 });
    await expect(worker.fetch(request("cmsPublishSettings"), env))
      .resolves.toMatchObject({ status: 200 });
    await expect(worker.fetch(request("cmsSaveSettings"), env))
      .resolves.toMatchObject({ status: 200 });

    expect(ENDPOINTS.cmsGetBroadcastSchedule.rateClass).toBe("read");
    expect(ENDPOINTS.cmsGetNewsroomBanner.rateClass).toBe("read");
    expect(ENDPOINTS.cmsGetSettings.rateClass).toBe("read");
    expect(ENDPOINTS.cmsPublishSettings.rateClass).toBe("publish");
    expect(ENDPOINTS.cmsSaveSettings.rateClass).toBe("mutation");
    expect(ENDPOINTS.cmsRequestVideoTranscript.rateClass).toBe("mutation");
    expect(seenBuckets.some((name) => name.startsWith("v1:actor:read:")))
      .toBe(true);
    expect(seenBuckets.some((name) => name.startsWith("v1:actor:mutation:")))
      .toBe(true);
  });

  it("routes the bounded media usage repair as a lifecycle operation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const seenBuckets: string[] = [];

    const response = await handler(fetchOrigin).fetch(
      request("cmsScanMediaUsage", {
        body: JSON.stringify({ mode: "dry-run" }),
      }),
      fakeEnv((name) => {
        seenBuckets.push(name);
        return ALLOWED;
      }),
    );

    expect(response.status).toBe(200);
    expect(ENDPOINTS.cmsScanMediaUsage).toEqual({
      contentType: "json",
      maxBytes: 4 * 1024,
      rateClass: "lifecycle",
    });
    expect(seenBuckets.some((name) =>
      name.startsWith("v1:ip:lifecycle:"),
    )).toBe(true);
    expect(seenBuckets.some((name) =>
      name.startsWith("v1:actor:lifecycle:"),
    )).toBe(true);
    expect(fetchOrigin).toHaveBeenCalledWith(
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsScanMediaUsage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes managed media-category reads and versioned changes", () => {
    expect(ENDPOINTS.cmsListMediaCategories).toEqual({
      contentType: "json",
      maxBytes: 4 * 1024,
      rateClass: "read",
    });
    expect(ENDPOINTS.cmsMutateMediaCategory).toEqual({
      contentType: "json",
      maxBytes: 8 * 1024,
      rateClass: "metadata",
    });
  });

  it("routes media usage through the read limiter and refuses oversized bodies before forwarding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }));
    const worker = handler(fetchOrigin);
    const buckets: string[] = [];
    const env = fakeEnv(name => { buckets.push(name); return ALLOWED; });

    const response = await worker.fetch(request("cmsListMediaUsage", {
      body: JSON.stringify({ assetId: "art", state: "working" }),
    }), env);
    expect(response.status).toBe(200);
    expect(fetchOrigin.mock.calls[0]?.[0]).toBe(
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsListMediaUsage");
    expect(buckets.some(name => name.startsWith("v1:actor:read:"))).toBe(true);

    const oversized = await worker.fetch(request("cmsListMediaUsage", {
      body: JSON.stringify({ assetId: "x".repeat(4096) }),
    }), env);
    expect(oversized.status).toBe(413);
    expect(fetchOrigin).toHaveBeenCalledTimes(1);
  });

  it("stops reading a streamed body when it exceeds the endpoint limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    const chunk = new Uint8Array(512);
    const availableChunks = 32;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === availableChunks) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamedRequest = new Request(
      "https://api.example.org/registerStaffProfile",
      {
        method: "POST",
        headers: {
          authorization: "Bearer valid-token",
          "cf-connecting-ip": "203.0.113.8",
          "content-type": "application/json",
          origin: "https://admin.njpbs.org",
        },
        body,
      },
    );

    const response = await handler(fetchOrigin).fetch(streamedRequest, fakeEnv());

    expect(response.status).toBe(413);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("keeps the size-limit response when stream cancellation fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2049));
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const streamedRequest = request("registerStaffProfile", { body });

    const response = await handler().fetch(streamedRequest, fakeEnv());

    expect(response.status).toBe(413);
  });

  it("routes newsroom settings reads, draft saves, and publishes with bounded policies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const worker = handler(fetchOrigin);
    const expectedPolicies = {
      cmsGetCoverageLabels: { contentType: "json", maxBytes: 16 * 1024, rateClass: "read" },
      cmsGetSettings: {
        contentType: "json",
        maxBytes: 16 * 1024,
        rateClass: "read",
      },
      cmsSaveSettings: {
        contentType: "json",
        maxBytes: 512 * 1024,
        rateClass: "mutation",
      },
      cmsPublishSettings: {
        contentType: "json",
        maxBytes: 16 * 1024,
        rateClass: "publish",
      },
    } as const;

    for (const [endpoint, policy] of Object.entries(expectedPolicies)) {
      const response = await worker.fetch(
        request(endpoint, {
          body: JSON.stringify({ id: "newsroom-banner" }),
        }),
        fakeEnv(),
      );
      expect(response.status).toBe(200);
      expect(ENDPOINTS[endpoint as keyof typeof ENDPOINTS]).toEqual(policy);
    }

    expect(fetchOrigin.mock.calls.map(([url]) => url)).toEqual(
      Object.keys(expectedPolicies).map(
        (endpoint) =>
          `https://us-central1-njpbs-site.cloudfunctions.net/${endpoint}`,
      ),
    );
  });

  it("preserves both banner links across settings saves and published replies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const values = { enabled: true, njDecides: true, message: "Election night", linkLabel: "Results", linkHref: "/results/",
      secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/" };
    const reply = { success: true, settings: { schemaVersion: 4, version: 8, values,
      published: { schemaVersion: 4, sourceVersion: 7, publishedAt: "2026-11-03T19:00:00.000Z", values } } };
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(reply), {
      headers: { "content-type": "application/json" },
    }));
    const worker = handler(fetchOrigin);
    for (const endpoint of ["cmsSaveSettings", "cmsGetSettings", "cmsPublishSettings"]) {
      const body = JSON.stringify({ id: "public-homepage-banner", ...(endpoint === "cmsSaveSettings" ? { values, baseVersion: 7 } : { baseVersion: 7 }) });
      const response = await worker.fetch(request(endpoint, { body }), fakeEnv());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(reply);
      expect(new TextDecoder().decode(fetchOrigin.mock.calls.at(-1)?.[1]?.body as Uint8Array)).toBe(body);
    }
  });

  it("routes the five author profile endpoints with bounded policies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const worker = handler(fetchOrigin);
    const expectedPolicies = {
      cmsGetAuthorProfile: {
        contentType: "json",
        maxBytes: 2 * 1024,
        rateClass: "read",
      },
      cmsUpdateAuthorProfile: {
        contentType: "json",
        maxBytes: 16 * 1024,
        rateClass: "mutation",
      },
      cmsSetAuthorProfileVisibility: {
        contentType: "json",
        maxBytes: 2 * 1024,
        rateClass: "publish",
      },
      cmsListAuthorProfiles: {
        contentType: "json",
        maxBytes: 2 * 1024,
        rateClass: "read",
      },
      cmsAdminUpdateAuthorProfile: {
        contentType: "json",
        maxBytes: 16 * 1024,
        rateClass: "mutation",
      },
    } as const;

    for (const [endpoint, policy] of Object.entries(expectedPolicies)) {
      const response = await worker.fetch(
        request(endpoint, { body: JSON.stringify({ expectedVersion: 1 }) }),
        fakeEnv(),
      );
      expect(response.status).toBe(200);
      const declared = ENDPOINTS[endpoint as keyof typeof ENDPOINTS];
      expect(declared).toEqual(policy);
      // None of them may be reachable without a verified caller.
      expect(declared).not.toHaveProperty("auth");
    }

    expect(fetchOrigin.mock.calls.map(([url]) => url)).toEqual(
      Object.keys(expectedPolicies).map(
        (endpoint) =>
          `https://us-central1-njpbs-site.cloudfunctions.net/${endpoint}`,
      ),
    );
  });

  it("serves an edge-only health check", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handler().fetch(
      new Request("https://api.example.org/health"),
      fakeEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "njpbs-cms-api",
    });
  });

  it("rejects unknown routes, unsupported methods, and unapproved origins", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const worker = handler();

    await expect(
      worker.fetch(request("not-a-function"), fakeEnv()),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      worker.fetch(request("cmsSetMediaLifecycle"), fakeEnv()),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      worker.fetch(
        request("cmsListContent", { method: "GET", body: undefined }),
        fakeEnv(),
      ),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      worker.fetch(
        request("cmsListContent", {
          headers: { origin: "https://attacker.example" },
        }),
        fakeEnv(),
      ),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("answers an approved CORS preflight without a bearer token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handler().fetch(
      request("cmsListContent", {
        method: "OPTIONS",
        body: undefined,
        headers: {
          authorization: "",
          "access-control-request-method": "POST",
        },
      }),
      fakeEnv(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://admin.njpbs.org",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "if-match",
    );
  });

  it("allows localhost CORS only when local development enables it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const localRequest = request("cmsListContent", {
      method: "OPTIONS",
      body: undefined,
      headers: {
        authorization: "",
        origin: "http://localhost:5173",
      },
    });

    await expect(handler().fetch(localRequest, fakeEnv())).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      handler().fetch(localRequest, {
        ...fakeEnv(),
        ALLOW_LOCAL_ORIGINS: "true",
      }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("rejects compressed, mistyped, and oversized bodies before the origin", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    const worker = handler(fetchOrigin);

    const compressed = await worker.fetch(
      request("cmsListContent", {
        headers: { "content-encoding": "gzip" },
      }),
      fakeEnv(),
    );
    const mistyped = await worker.fetch(
      request("cmsListContent", {
        headers: { "content-type": "text/plain" },
      }),
      fakeEnv(),
    );
    const consume = vi.fn(() => ALLOWED);
    const oversizedRequest = request("cmsListContent", {
      headers: { "content-length": String(64 * 1024 + 1) },
    });
    const getReader = vi.spyOn(oversizedRequest.body!, "getReader");
    const oversized = await worker.fetch(
      oversizedRequest,
      fakeEnv(consume),
    );

    expect([compressed.status, mistyped.status, oversized.status]).toEqual([
      415, 415, 413,
    ]);
    expect(consume).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("stops a headerless many-chunk body at the byte limit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    const worker = handler(fetchOrigin);
    const maxBytes = ENDPOINTS.registerStaffProfile.maxBytes;
    let remaining = maxBytes + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array([1]));
        remaining -= 1;
      },
    });
    const streamed = new Request("https://api.example.org/registerStaffProfile", {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "cf-connecting-ip": "203.0.113.8",
        "content-type": "application/json",
        origin: "https://admin.njpbs.org",
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await worker.fetch(streamed, fakeEnv());

    expect(response.status).toBe(413);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });

  it("verifies identity, applies both budgets, and sends only trusted origin headers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const upstream = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
        etag: '"asset.1"',
      },
    });
    const fetchOrigin = vi.fn<typeof fetch>(async () => upstream);
    const seenBuckets: string[] = [];
    const response = await handler(fetchOrigin).fetch(
      request("cmsUpdateMediaMetadata", {
        headers: {
          "if-match": '"asset.1"',
          "x-njpbs-cms-edge": "browser-forgery",
          "x-forwarded-for": "198.51.100.9",
        },
      }),
      fakeEnv((name) => {
        seenBuckets.push(name);
        return ALLOWED;
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://admin.njpbs.org",
    );
    expect(response.headers.get("etag")).toBe('"asset.1"');
    expect(seenBuckets.some((name) => name.startsWith("v1:ip:metadata:"))).toBe(
      true,
    );
    expect(
      seenBuckets.some((name) => name.startsWith("v1:actor:metadata:")),
    ).toBe(true);

    const [url, init] = fetchOrigin.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe(
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsUpdateMediaMetadata",
    );
    expect(headers.get("authorization")).toBe("Bearer valid-token");
    expect(headers.get("if-match")).toBe('"asset.1"');
    expect(headers.get("x-njpbs-cms-edge")).toBe("edge-secret-for-tests");
    expect(headers.get("x-njpbs-client-ip")).toBe("203.0.113.8");
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("does not forward the missing-IP rate-limit sentinel to the origin", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await handler(fetchOrigin).fetch(
      request("cmsListContent", {
        headers: { "cf-connecting-ip": "" },
      }),
      fakeEnv(),
    );

    expect(response.status).toBe(200);
    const headers = new Headers(fetchOrigin.mock.calls[0]![1]?.headers);
    expect(headers.has("x-njpbs-client-ip")).toBe(false);
  });

  it("returns Retry-After when a shared actor or IP budget is empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const denied: ConsumeResult = {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    };
    const ipResponse = await handler().fetch(
      request("cmsListMedia"),
      fakeEnv((name) => (name.startsWith("v1:ip:") ? denied : ALLOWED)),
    );
    const actorResponse = await handler().fetch(
      request("cmsListMedia"),
      fakeEnv((name) => (name.startsWith("v1:actor:") ? denied : ALLOWED)),
    );

    expect(ipResponse.status).toBe(429);
    expect(ipResponse.headers.get("retry-after")).toBe("17");
    expect(ipResponse.headers.get("x-rate-limit-scope")).toBe("ip");
    expect(actorResponse.status).toBe(429);
    expect(actorResponse.headers.get("x-rate-limit-scope")).toBe("actor");
  });

  it("does not buffer bodies rejected by IP, identity, or actor gates", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const denied: ConsumeResult = {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    };
    const verifyToken = vi.fn(async (token: string) => {
      if (token === "invalid-token") throw new FirebaseTokenError();
      return { uid: "editor-1" };
    });
    const worker = createCmsApiHandler({
      fetchOrigin: vi.fn(),
      now: () => 1_000,
      randomUUID: () => "request-id",
      verifyToken,
    });
    const rejected = [
      {
        request: request("cmsUploadMedia", {
          body: "large-upload",
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
        env: fakeEnv((name) => name.startsWith("v1:ip:") ? denied : ALLOWED),
        status: 429,
      },
      {
        request: request("cmsUploadMedia", {
          body: "large-upload",
          headers: {
            authorization: "",
            "content-type": "multipart/form-data; boundary=test",
          },
        }),
        env: fakeEnv(),
        status: 401,
      },
      {
        request: request("cmsUploadMedia", {
          body: "large-upload",
          headers: {
            authorization: "Bearer invalid-token",
            "content-type": "multipart/form-data; boundary=test",
          },
        }),
        env: fakeEnv(),
        status: 401,
      },
      {
        request: request("cmsUploadMedia", {
          body: "large-upload",
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
        env: fakeEnv((name) => name.startsWith("v1:actor:") ? denied : ALLOWED),
        status: 429,
      },
      {
        request: request("cmsUploadMedia", {
          body: "large-upload",
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
        env: { ...fakeEnv(), CMS_EDGE_ORIGIN_SECRET: "" },
        status: 503,
      },
    ];

    for (const candidate of rejected) {
      const getReader = vi.spyOn(candidate.request.body!, "getReader");
      const response = await worker.fetch(candidate.request, candidate.env);
      expect(response.status).toBe(candidate.status);
      expect(getReader).not.toHaveBeenCalled();
    }
    expect(verifyToken).toHaveBeenCalledTimes(3);
  });

  it("buffers an accepted request only after both identity budgets", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const order: string[] = [];
    const fetchOrigin = vi.fn<typeof fetch>(async () => {
      order.push("origin");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const worker = createCmsApiHandler({
      fetchOrigin,
      now: () => 1_000,
      randomUUID: () => "request-id",
      verifyToken: async () => {
        order.push("verify");
        return { uid: "editor-1" };
      },
    });
    const accepted = request("cmsUploadMedia", {
      body: "upload",
      headers: { "content-type": "multipart/form-data; boundary=test" },
    });
    const getReader = accepted.body!.getReader.bind(accepted.body!);
    vi.spyOn(accepted.body!, "getReader").mockImplementation(() => {
      order.push("body");
      return getReader();
    });

    const response = await worker.fetch(
      accepted,
      fakeEnv((name) => {
        order.push(name.startsWith("v1:ip:") ? "ip" : "actor");
        return ALLOWED;
      }),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["ip", "verify", "actor", "body", "origin"]);
  });

  it("does not forward an invalid Firebase token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchOrigin = vi.fn<typeof fetch>();
    const worker = createCmsApiHandler({
      fetchOrigin,
      now: () => 1_000,
      randomUUID: () => "request-id",
      verifyToken: async () => {
        throw new FirebaseTokenError();
      },
    });

    const response = await worker.fetch(request("cmsListContent"), fakeEnv());

    expect(response.status).toBe(401);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
});


describe("staff-site admission rate limits", () => {
  const denied: ConsumeResult = { allowed: false, remaining: 0, retryAfterSeconds: 1 };
  it("limits the IP before token verification or Firebase calls", async () => {
    const verifyToken = vi.fn();
    const fetchOrigin = vi.fn();
    expect(await validateStaffSiteAccess(fakeEnv(() => denied), "valid-token", "203.0.113.1", { verifyToken, fetchOrigin })).toBe(429);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
  it("rejects a forged identity before its actor bucket or Firebase", async () => {
    const consume = vi.fn(() => ALLOWED);
    const fetchOrigin = vi.fn();
    const verifyToken = vi.fn().mockRejectedValue(new FirebaseTokenError());
    expect(await validateStaffSiteAccess(fakeEnv(consume), "forged-token", "203.0.113.1", { verifyToken, fetchOrigin })).toBe(401);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
  it("limits a verified pending account before the Firebase profile read", async () => {
    const fetchOrigin = vi.fn();
    const verifyToken = vi.fn().mockResolvedValue({ uid: "pending-user" });
    const env = fakeEnv((name) => name.startsWith("v1:actor:staffSite:") ? denied : ALLOWED);
    expect(await validateStaffSiteAccess(env, "valid-token", "203.0.113.1", { verifyToken, fetchOrigin })).toBe(429);
    expect(verifyToken).toHaveBeenCalled();
    expect(fetchOrigin).not.toHaveBeenCalled();
  });
  it("uses one verified actor bucket across refreshed tokens and checks live access", async () => {
    const names: string[] = [];
    const env = fakeEnv((name) => { names.push(name); return ALLOWED; });
    const fetchOrigin = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const verifyToken = vi.fn().mockResolvedValue({ uid: "staff-1" });
    for (const token of ["first-token", "refreshed-token"]) {
      expect(await validateStaffSiteAccess(env, token, "203.0.113.1", { verifyToken, fetchOrigin })).toBe(403);
    }
    const actorNames = names.filter((name) => name.startsWith("v1:actor:staffSite:"));
    expect(actorNames).toHaveLength(2);
    expect(actorNames[0]).toBe(actorNames[1]);
    expect(actorNames[0]).not.toContain("staff-1");
    expect(fetchOrigin).toHaveBeenCalledTimes(2);
  });
});

describe("private preview wake", () => {
  const sha = "a".repeat(40);
  function context(tasks: Promise<unknown>[]) {
    return { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext;
  }

  it.each(["success", "rejection", "missing method", "missing binding"])("preserves durable acceptance on %s", async (outcome) => {
    const tasks: Promise<unknown>[] = [];
    const wake = vi.fn(async () => { if (outcome === "rejection") throw new Error("Unavailable"); });
    const env = fakeEnv();
    if (outcome !== "missing binding") env.PREVIEW_RENDERER = outcome === "missing method"
      ? {} as NonNullable<CmsApiEnv["PREVIEW_RENDERER"]> : { wake };
    const body = '{"success":true,"queueId":"abcdefghijklmnopqrst","status":"pending"}';
    const response = await handler(vi.fn(async () => new Response(body, { status: 202,
      headers: { "x-njpbs-preview-wake": sha, "content-type": "application/json" } }))).fetch(
      request("cmsPreview"), env, context(tasks));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe(body);
    expect(response.headers.has("x-njpbs-preview-wake")).toBe(false);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    if (["success", "rejection"].includes(outcome)) expect(wake).toHaveBeenCalledWith(sha, "request-id");
  });

  it("returns acceptance before a slow wake finishes", async () => {
    let finish!: () => void;
    const tasks: Promise<unknown>[] = [];
    const wake = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const response = await handler(vi.fn(async () => new Response("accepted", {
      status: 202, headers: { "x-njpbs-preview-wake": sha },
    }))).fetch(request("cmsPreview"), { ...fakeEnv(), PREVIEW_RENDERER: { wake } }, context(tasks));
    expect(await response.text()).toBe("accepted");
    expect(wake).toHaveBeenCalledOnce();
    finish();
    await Promise.all(tasks);
  });

  it.each([
    ["cmsPreview", 403, sha], ["cmsPreview", 202, "invalid"],
    ["cmsPreview", 202, ""], ["cmsSave", 202, sha],
  ])("does not wake for %s %s %s", async (endpoint, status, marker) => {
    const tasks: Promise<unknown>[] = [];
    const wake = vi.fn();
    const response = await handler(vi.fn(async () => new Response("unchanged", { status,
      headers: { "x-njpbs-preview-wake": marker } }))).fetch(
      request(endpoint), { ...fakeEnv(), PREVIEW_RENDERER: { wake } }, context(tasks));
    expect(response.headers.has("x-njpbs-preview-wake")).toBe(false);
    expect(tasks).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("addressed preview status wait cancellation", () => {
  it("forwards abort only for opted-in addressed waits", async () => {
    const fetchOrigin = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const worker = handler(fetchOrigin);
    const controller = new AbortController();
    await worker.fetch(request("cmsPreviewStatus", { signal: controller.signal,
      body: JSON.stringify({ queueId: "a".repeat(20), waitMs: 5000, observedStatus: "building" }) }), fakeEnv());
    const signal = fetchOrigin.mock.calls[0][1]?.signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    for (const body of [{ queueId: "a".repeat(20) }, { pageId: "home", waitMs: 5000, observedStatus: "building" }]) {
      await worker.fetch(request("cmsPreviewStatus", { body: JSON.stringify(body) }), fakeEnv());
    }
    expect(fetchOrigin.mock.calls[1][1]?.signal).toBeUndefined();
    expect(fetchOrigin.mock.calls[2][1]?.signal).toBeUndefined();
  });
});

it("keeps publication rechecks behind authentication, bounded JSON and the existing publish budget", async () => {
  const forwarded = vi.fn<typeof fetch>(async () => new Response('{"success":true,"outcome":"confirmed_late"}', {
    headers: { "content-type": "application/json" },
  }));
  const budgets: string[] = [];
  const api = handler(forwarded);
  const settings = fakeEnv(name => { budgets.push(name); return ALLOWED; });
  expect((await api.fetch(request("cmsRecheckPublication", { headers: { authorization: "" } }), settings)).status).toBe(401);
  expect((await api.fetch(request("cmsRecheckPublication", {
    body: JSON.stringify({ queueId: "A".repeat(20), excess: "x".repeat(2048) }),
  }), settings)).status).toBe(413);
  expect(forwarded).not.toHaveBeenCalled();
  const checked = await api.fetch(request("cmsRecheckPublication", { body: JSON.stringify({ queueId: "A".repeat(20) }) }), settings);
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ success: true, outcome: "confirmed_late" });
  expect(new URL(String(forwarded.mock.calls[0][0])).pathname).toBe("/cmsRecheckPublication");
  expect(budgets.some(name => name.includes("publish"))).toBe(true);
});

describe("retained preview pair wakes", () => {
  it.each(["preview-old", "preview-new", "preview-missing", "invalid", ""])("uses only the exact retained binding for %s", async pairId => {
    const old = vi.fn(async () => {}), next = vi.fn(async () => {}), legacy = vi.fn(async () => {}), tasks: Promise<unknown>[] = [];
    const response = await handler(vi.fn(async () => new Response("accepted", { status: 202,
      headers: { "x-njpbs-preview-wake": "a".repeat(40), "x-njpbs-preview-pair": pairId } }))).fetch(request("cmsPreview"), {
        ...fakeEnv(), PREVIEW_RENDERER: { wake: legacy }, PREVIEW_PAIR_WAKE_ENABLED: "true",
        PREVIEW_PAIR_BINDINGS_JSON: JSON.stringify({ "preview-old": "PREVIEW_PAIR_OLD", "preview-new": "PREVIEW_PAIR_NEW" }),
        PREVIEW_PAIR_OLD: { wake: old }, PREVIEW_PAIR_NEW: { wake: next },
      }, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext);
    expect(response.status).toBe(202); expect(await response.text()).toBe("accepted");
    expect(response.headers.has("x-njpbs-preview-pair")).toBe(false); expect(response.headers.has("x-njpbs-preview-wake")).toBe(false);
    await Promise.all(tasks); expect(legacy).not.toHaveBeenCalled();
    expect(old).toHaveBeenCalledTimes(pairId === "preview-old" ? 1 : 0);
    expect(next).toHaveBeenCalledTimes(pairId === "preview-new" ? 1 : 0);
  });
  it("keeps schema-two wakes inert until enabled and strips pair identity on other responses", async () => {
    const legacy = vi.fn(async () => {}), tasks: Promise<unknown>[] = [];
    for (const endpoint of ["cmsPreview", "cmsSaveContent"]) {
      const response = await handler(vi.fn(async () => new Response("accepted", { status: 202,
        headers: { "x-njpbs-preview-wake": "a".repeat(40), "x-njpbs-preview-pair": "preview-old" } }))).fetch(request(endpoint),
          { ...fakeEnv(), PREVIEW_RENDERER: { wake: legacy } }, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext);
      expect(response.headers.has("x-njpbs-preview-pair")).toBe(false);
    }
    await Promise.all(tasks); expect(legacy).not.toHaveBeenCalled();
  });
});

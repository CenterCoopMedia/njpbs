import { afterEach, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import { RATE_POLICIES } from "../src/config";
const functionsReader = "a".repeat(64), cmsApiReader = "b".repeat(64);
const cmsApiVersion = "55555555-5555-4555-8555-555555555555";
const requestId = "33333333-3333-4333-8333-333333333333";
const sessionIds = { functions: "11111111-1111-4111-8111-111111111111", cmsApi: "22222222-2222-4222-8222-222222222222" };
const envelope = { version: 1, action: "request", sessionIds, endpoint: "cmsPreview", body: { pageId: "home" } };
const allowed = { allowed: true, remaining: 10, retryAfterSeconds: 0 };
const decoded = (body: BodyInit | null | undefined) => typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
function setup() {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const consumed: any[] = [];
  const env = { ALLOW_LOCAL_ORIGINS: "false", CMS_EDGE_ORIGIN_SECRET: "fixture-edge", FIREBASE_PROJECT_ID: "njpbs-site",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net", CMS_READER_BRIDGE_ENABLED: "true",
    CMS_READER_BRIDGE_OPERATION_ID: "reader-installed", CMS_API_WORKER_VERSION: { id: cmsApiVersion }, RATE_LIMITERS: { getByName: () => ({ consume: (input: any) => { consumed.push(input); return allowed; } }) } } as unknown as CmsApiEnv;
  const fetchOrigin = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(decoded(init?.body));
    if (body.action === "describe") return Response.json({ schemaVersion: 2, version: body.version, operationId: "reader-installed", functionsReader, cmsApiReader, cmsApiVersion });
    return new Response('{"queueId":"original","status":"pending"}', { headers: {
      "content-type": "application/json", "x-njpbs-functions-reader": functionsReader, "x-njpbs-gateway-reader": cmsApiReader,
    } });
  });
  const verifyToken = vi.fn(async () => ({ uid: "staff" }));
  const handler = createCmsApiHandler({ fetchOrigin, verifyToken, randomUUID: () => requestId });
  const incoming = (body: unknown = envelope, headers = {}, path = "/api/cms/v1/reader") => new Request(`https://api.example.org${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: "Bearer fixture-staff",
      origin: "https://admin.njpbs.org", "cf-connecting-ip": "203.0.113.8", "x-firebase-appcheck": "fixture-appcheck", ...headers },
  });
  return { env, handler, fetchOrigin, consumed, incoming };
}
afterEach(() => vi.restoreAllMocks());
it.each([1, 2])("mounts retained v%s after shared gates and preserves preview rate policy and trusted stamps", async version => {
  const { env, handler, fetchOrigin, consumed, incoming } = setup();
  const reply = await handler.fetch(incoming({ ...envelope, version }, {
    "x-njpbs-cms-reader": "forged", "x-njpbs-request-id": "forged", "x-njpbs-client-ip": "forged",
  }, `/api/cms/v${version}/reader`), env);
  expect(reply.status).toBe(200);
  expect(await reply.text()).toBe('{"queueId":"original","status":"pending"}');
  expect(reply.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
  expect(reply.headers.get("cache-control")).toBe("private, no-store");
  expect(consumed.map(c => c.capacity)).toEqual([RATE_POLICIES.read.ip.capacity, RATE_POLICIES.read.actor.capacity,
    RATE_POLICIES.preview.actor.capacity, RATE_POLICIES.preview.ip.capacity]);
  expect(fetchOrigin.mock.calls).toHaveLength(2);
  for (const [url, init] of fetchOrigin.mock.calls) {
    expect(url).toBe(`${env.FUNCTIONS_ORIGIN}/cmsReaderV${version}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("origin")).toBe(null);
    expect(headers.get("x-njpbs-cms-edge")).toBe("fixture-edge");
    expect(headers.get("x-njpbs-request-id")).toBe(requestId);
    expect(headers.get("x-njpbs-client-ip")).toBe("203.0.113.8");
    expect(headers.get("x-firebase-appcheck")).toBe("fixture-appcheck");
  }
  expect(new Headers(fetchOrigin.mock.calls[1][1]?.headers).get("x-njpbs-cms-reader")).toBe(cmsApiReader);
  expect(JSON.parse(decoded(fetchOrigin.mock.calls[1][1]?.body))).toEqual({ ...envelope, version });
});
it("is absent by default and rejects foreign origins and missing staff before descriptor I/O", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  expect((await handler.fetch(incoming(), { ...env, CMS_READER_BRIDGE_ENABLED: undefined })).status).toBe(404);
  expect((await handler.fetch(incoming(envelope, { origin: "https://other.example" }), env)).status).toBe(403);
  expect((await handler.fetch(incoming(envelope, { authorization: "" }), env)).status).toBe(401);
  expect(fetchOrigin.mock.calls).toHaveLength(0);
});
it("rate exhaustion and nested endpoint limits refuse before descriptor I/O", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  const denied = { ...env, RATE_LIMITERS: { getByName: () => ({ consume: (input: any) => input.capacity === RATE_POLICIES.preview.actor.capacity
    ? { allowed: false, remaining: 0, retryAfterSeconds: 37 } : allowed }) } } as unknown as CmsApiEnv;
  const reply = await handler.fetch(incoming(), denied);
  expect(reply.status).toBe(429); expect(reply.headers.get("retry-after")).toBe("37");
  expect((await handler.fetch(incoming({ ...envelope, body: { text: "x".repeat(65537) } }), env)).status).toBe(413);
  expect((await handler.fetch(incoming({ ...envelope, endpoint: "cmsSaveContent" }), env)).status).toBe(400);
  expect(fetchOrigin.mock.calls).toHaveLength(0);
});
it("descriptor failures, oversized streams and changed original identities fail closed without a second call", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  for (const response of [new Response("{}", { status: 503 }), Response.json({ schemaVersion: 2, version: 1,
    operationId: "reader-other", functionsReader, cmsApiReader, cmsApiVersion }), new Response("x".repeat(1025), { headers: { "content-type": "application/json" } })]) {
    fetchOrigin.mockReset().mockResolvedValueOnce(response);
    expect((await handler.fetch(incoming(), env)).status).toBe(503);
    expect(fetchOrigin.mock.calls).toHaveLength(1);
  }
});
it.each([
  [{ error: "Invalid or expired authentication token", code: "session_expired", reason: "token_expired" },
    { error: "Versioned CMS reader unavailable", code: "session_expired", reason: "token_expired" }],
  [{ error: "CMS reader unavailable", code: "session_expired", reason: "provider detail", detail: "provider detail" },
    { error: "Versioned CMS reader unavailable", code: "session_expired" }],
])("carries the typed session refusal from the descriptor read, and nothing else", async (refusal, expected) => {
  const { env, handler, fetchOrigin, incoming } = setup();
  fetchOrigin.mockReset().mockResolvedValueOnce(Response.json(refusal, { status: 401 }));
  const reply = await handler.fetch(incoming(), env);
  expect(reply.status).toBe(401);
  expect(await reply.json()).toEqual(expected);
  expect(reply.headers.get("cache-control")).toBe("private, no-store");
  expect(reply.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
  expect(fetchOrigin.mock.calls).toHaveLength(1);
});
it("keeps every other descriptor refusal as an unavailable reader", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  for (const response of [Response.json({ error: "Other" }, { status: 401 }),
    Response.json({ code: "app_check_failed" }, { status: 401 }),
    Response.json({ code: "session_expired" }, { status: 403 }),
    new Response("session_expired", { status: 401 }),
    new Response(JSON.stringify({ code: "session_expired", pad: "x".repeat(1025) }), { status: 401, headers: { "content-type": "application/json" } })]) {
    fetchOrigin.mockReset().mockResolvedValueOnce(response);
    const reply = await handler.fetch(incoming(), env);
    expect(reply.status).toBe(503);
    expect(await reply.json()).toMatchObject({ error: "Versioned CMS reader unavailable" });
  }
});
it("refuses a reader response that disagrees with the original descriptor", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  fetchOrigin.mockResolvedValueOnce(Response.json({ schemaVersion: 2, version: 1, operationId: "reader-installed", functionsReader, cmsApiReader, cmsApiVersion }))
    .mockResolvedValueOnce(new Response("{}", { headers: { "x-njpbs-functions-reader": "c".repeat(64), "x-njpbs-gateway-reader": cmsApiReader } }));
  expect((await handler.fetch(incoming(), env)).status).toBe(503);
});
it("bounds the metadata read at three seconds without a retry or endpoint dispatch", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(duration => {
    expect(duration).toBe(3000);
    return deadline.signal;
  });
  const { env, handler, fetchOrigin, incoming } = setup();
  let dispatched!: () => void;
  const ready = new Promise<void>(resolve => { dispatched = resolve; });
  fetchOrigin.mockImplementationOnce(async (_url, init) => {
    dispatched();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const pending = handler.fetch(incoming(), env);
  await ready;
  deadline.abort();
  expect((await pending).status).toBe(503);
  expect(fetchOrigin.mock.calls).toHaveLength(1);
});

it("refuses a changed or missing executing gateway version without claiming an installed reader", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  expect((await handler.fetch(incoming(), { ...env, CMS_API_WORKER_VERSION: undefined })).status).toBe(503);
  expect((await handler.fetch(incoming(), { ...env, CMS_API_WORKER_VERSION: { id: "66666666-6666-4666-8666-666666666666" } })).status).toBe(503);
  expect(fetchOrigin.mock.calls).toHaveLength(2);
});
it("wakes the original accepted preview owner and removes private wake headers", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  const rendererSha = "e".repeat(40), wake = vi.fn(async () => undefined);
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as ExecutionContext;
  fetchOrigin.mockResolvedValueOnce(Response.json({ schemaVersion: 2, version: 1, operationId: "reader-installed", functionsReader, cmsApiReader, cmsApiVersion }))
    .mockResolvedValueOnce(new Response('{"status":"pending"}', { status: 202, headers: { "content-type": "application/json",
      "x-njpbs-functions-reader": functionsReader, "x-njpbs-gateway-reader": cmsApiReader, "x-njpbs-preview-wake": rendererSha } }));
  const response = await handler.fetch(incoming(), { ...env, PREVIEW_RENDERER: { wake } as any }, ctx);
  await Promise.all(waits);
  expect(response.status).toBe(202);
  expect(wake).toHaveBeenCalledWith(rendererSha, expect.stringMatching(/^[a-f0-9-]{36}$/i));
  expect(response.headers.has("x-njpbs-preview-wake")).toBe(false);
  expect(response.headers.has("x-njpbs-preview-pair")).toBe(false);
});

it("a malformed JSON envelope returns a guarded refusal with CORS and the generated request ID", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  const valid = incoming();
  const malformed = new Request(valid.url, { method: "POST", headers: valid.headers, body: "{" });
  const response = await handler.fetch(malformed, env);
  expect(response.status).toBe(503);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
  expect(response.headers.get("x-njpbs-request-id")).toBe(requestId);
  expect(fetchOrigin).not.toHaveBeenCalled();
});

it("charges open to the write budget and refuses it before descriptor or session I/O", async () => {
  const { env, handler, fetchOrigin, incoming, consumed } = setup();
  const denied = { ...env, RATE_LIMITERS: { getByName: () => ({ consume: (input: any) => {
    consumed.push(input);
    return input.capacity === RATE_POLICIES.mutation.actor.capacity
      ? { allowed: false, retryAfterSeconds: 19, remaining: 0 } : allowed;
  } }) } } as unknown as CmsApiEnv;
  const result = await handler.fetch(incoming({ version: 1, action: "open", sessionIds, ttlMs: 86_400_000 }), denied);
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("19");
  expect(consumed.map(value => value.capacity)).toEqual([
    RATE_POLICIES.read.ip.capacity, RATE_POLICIES.read.actor.capacity, RATE_POLICIES.mutation.actor.capacity,
  ]);
  expect(fetchOrigin).not.toHaveBeenCalled();
});

it("preserves the original Function's quota status and Retry-After through the gateway", async () => {
  const { env, handler, fetchOrigin, incoming } = setup();
  fetchOrigin.mockResolvedValueOnce(Response.json({ schemaVersion: 2, version: 1,
    operationId: "reader-installed", functionsReader, cmsApiReader, cmsApiVersion }))
    .mockResolvedValueOnce(Response.json({ error: "Versioned CMS reader unavailable" }, {
      status: 429, headers: { "retry-after": "900" },
    }));
  const result = await handler.fetch(incoming({ version: 1, action: "open", sessionIds, ttlMs: 86_400_000 }), env);
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("900");
  expect(fetchOrigin.mock.calls).toHaveLength(2);
});

it.each([1, 2])("development v%s stays absent by default and uses only the development Functions target when installed", async version => {
  const { env, handler, fetchOrigin, incoming } = setup();
  const dev = { ...env, CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org" };
  const request = () => incoming({ ...envelope, version }, { origin: "https://dev-admin.example.org" }, `/api/cms/v${version}/reader`);
  expect((await handler.fetch(request(), { ...dev, CMS_READER_BRIDGE_ENABLED: "false" })).status).toBe(404);
  expect(fetchOrigin).not.toHaveBeenCalled();
  const reply = await handler.fetch(request(), dev);
  expect(reply.status).toBe(200);
  expect(reply.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
  expect(fetchOrigin.mock.calls).toHaveLength(2);
  expect(fetchOrigin.mock.calls.every(([url]) => url === `https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsReaderV${version}`)).toBe(true);
  fetchOrigin.mockClear();
  expect((await handler.fetch(request(), { ...dev, FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" })).status).toBe(503);
  expect((await handler.fetch(incoming(envelope, {}, "/cmsReadPairCurrentCodeV2"), dev)).status).toBe(404);
  expect(fetchOrigin).not.toHaveBeenCalled();
});

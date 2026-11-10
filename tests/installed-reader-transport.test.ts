import { expect, it, vi } from "vitest";
import { createInstalledReaderTransport } from "../admin/src/lib/installed-reader-transport";

const functionsReader = "a".repeat(64), cmsApiReader = "b".repeat(64);
const manifest = JSON.stringify({ schemaVersion: 2, version: 1, functionsReader, cmsApiReader });
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
function setup(extra: Record<string, unknown> = {}) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  let issued = 0;
  const clock = { now: 1000 };
  const opened = (body: any) => Response.json({ schemaVersion: 2, version: body.version,
    identities: { functions: functionsReader, cmsApi: cmsApiReader },
    leases: Object.fromEntries(Object.entries(body.sessionIds).map(([component, sessionId]) => [component,
      { sessionId, readerDigest: component === "functions" ? functionsReader : cmsApiReader, issuedAt: 1000, expiresAt: 1000 + 24 * 60 * 60_000 }])) });
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.action === "open" ? opened(body) : Response.json({ queueId: "original", status: "pending" });
  });
  const options = { enabled: "true", manifest, origin: "https://api.example.org", storage,
    request, now: () => clock.now, randomUUID: () => ids[issued++], ...extra };
  const transport = createInstalledReaderTransport(options)!;
  const send = (body: unknown = { pageId: "original", sourceVersion: 7 }) => transport.send({
    endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", appCheckToken: "fixture-appcheck", body,
  }).then(({ response }) => response);
  return { transport, send, request, storage, options, clock };
}
it("disabled adoption reads no storage and sends no request", () => {
  const storage = { getItem: () => { throw new Error("must not read"); }, setItem: () => { throw new Error("must not write"); } };
  expect(createInstalledReaderTransport({ enabled: "false", manifest: "invalid", origin: "", storage })).toBe(null);
});
it("opens once, then preserves bodies, App Check and operation identity on the installed path", async () => {
  const { send, request, transport } = setup();
  const body = { pageId: "original", sourceVersion: 7, operationId: "same-operation" };
  expect(await (await send(body)).json()).toEqual({ queueId: "original", status: "pending" });
  await send(body);
  expect(transport.supports("cmsSaveContent")).toBe(false);
  expect(request.mock.calls).toHaveLength(3);
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe("https://api.example.org/api/cms/v1/reader");
    expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-staff", "x-firebase-appcheck": "fixture-appcheck" });
  }
  expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({ version: 1, action: "request",
    sessionIds: { functions: ids[0], cmsApi: ids[1] }, endpoint: "cmsPreview", body });
  expect(request.mock.calls[1][1]?.body).toBe(request.mock.calls[2][1]?.body);
});
it("tab reload and manual lost-open retry retain original UUIDs", async () => {
  const { send, request, options } = setup();
  request.mockRejectedValueOnce(new Error("lost response"));
  await expect(send()).rejects.toThrow("lost response");
  expect(request.mock.calls).toHaveLength(1);
  await send();
  const reloaded = createInstalledReaderTransport({ ...options, randomUUID: () => { throw new Error("must retain UUIDs"); } })!;
  await reloaded.send({ endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", body: {} });
  expect(request.mock.calls[0][1]?.body).toBe(request.mock.calls[1][1]?.body);
  expect(request.mock.calls[0][1]?.body).toBe(request.mock.calls[3][1]?.body);
});
it("shares one open across concurrent requests", async () => {
  const { send, request } = setup();
  await Promise.all([send(), send()]);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["open", "request", "request"]);
});
it("an expired request never reopens or falls back", async () => {
  const { send, request } = setup();
  await send();
  request.mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 409 }));
  expect((await send()).status).toBe(409);
  expect(request.mock.calls).toHaveLength(3);
  expect(JSON.parse(String(request.mock.calls[2][1]?.body)).action).toBe("request");
});
it("a refused open sends no endpoint request", async () => {
  const { send, request } = setup();
  request.mockResolvedValueOnce(Response.json({ error: "refused" }, { status: 403 }));
  expect((await send()).status).toBe(403);
  expect(request.mock.calls).toHaveLength(1);
});
it("refuses mismatched reader proof and corrupt retained sessions before an endpoint dispatch", async () => {
  const { send, request, storage, options } = setup();
  request.mockResolvedValueOnce(Response.json({ schemaVersion: 2, version: 1, identities: { functions: "c".repeat(64), cmsApi: cmsApiReader } }));
  await expect(send()).rejects.toThrow("configuration unavailable");
  expect(request.mock.calls).toHaveLength(1);
  storage.setItem(`cms-reader:${functionsReader}:${cmsApiReader}:1:staff`, "{}");
  const reloaded = createInstalledReaderTransport(options)!;
  await expect(reloaded.send({ endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", body: {} })).rejects.toThrow("configuration unavailable");
  expect(request.mock.calls).toHaveLength(1);
});
it("refuses malformed active configuration and an unrelated endpoint", async () => {
  expect(() => setup({ manifest: "{}" })).toThrow("configuration unavailable");
  const { transport, request } = setup();
  await expect(transport.send({ endpoint: "cmsSaveContent", principalId: "staff", token: "fixture-staff", body: {} })).rejects.toThrow("configuration unavailable");
  expect(request.mock.calls).toHaveLength(0);
});

it("a loaded tab never renews, while explicit reload after confirmed expiry can request a new current-reader lease", async () => {
  const { send, request, options, clock } = setup();
  await send();
  clock.now += 24 * 60 * 60_000;
  await expect(send()).rejects.toThrow("Reload Boardwalk");
  expect(request.mock.calls).toHaveLength(2);
  const reloaded = createInstalledReaderTransport(options)!;
  await reloaded.send({ endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", body: {} });
  expect(JSON.parse(String(request.mock.calls[2][1]?.body)).sessionIds).toEqual({ functions: ids[2], cmsApi: ids[3] });
});
it("reload recovery still obeys a closed server reader window", async () => {
  const { send, request, options, clock } = setup();
  await send();
  clock.now += 24 * 60 * 60_000;
  request.mockResolvedValueOnce(Response.json({ error: "Reader closed" }, { status: 503 }));
  const reloaded = createInstalledReaderTransport(options)!;
  expect((await reloaded.send({ endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", body: {} })).response.status).toBe(503);
  expect(request.mock.calls).toHaveLength(3);
});

it("canceling the first waiter leaves the shared open and second request available", async () => {
  const { transport, send, request } = setup();
  const original = request.getMockImplementation()!;
  let release = () => {};
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  request.mockImplementationOnce(async (url, init) => {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(init?.signal?.reason);
      release = () => { init?.signal?.removeEventListener("abort", abort); resolve(); };
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener("abort", abort, { once: true });
      started();
    });
    return original(url, init);
  });
  const canceled = new AbortController();
  const first = transport.send({ endpoint: "cmsPreviewStatus", principalId: "staff", token: "fixture-staff",
    body: { queueId: "original" }, signal: canceled.signal });
  const firstCanceled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = send().then(response => ({ response, error: null }), error => ({ response: null, error }));
  try {
    await ready;
    canceled.abort();
    await firstCanceled;
    release();
    const survived = await second;
    expect(survived.error).toBe(null);
    expect(await survived.response!.json()).toEqual({ queueId: "original", status: "pending" });
    expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(["open", "request"]);
    expect(request.mock.calls[0][1]?.signal).toBeUndefined();
  } finally { release(); }
});

const expiredReply = (sessionIds: Record<string, string>, extra: Record<string, unknown> = {}) => Response.json({
  schemaVersion: 2, version: 1, code: "cms-reader-session-expired", identities: { functions: functionsReader, cmsApi: cmsApiReader },
  expired: [{ sessionId: sessionIds.functions, readerDigest: functionsReader, issuedAt: 1000, expiresAt: 1001 }], ...extra }, { status: 410 });
it("a 410 that does not name this tab's original lease stays uncertain and keeps its IDs", async () => {
  const foreign = { functions: ids[3] };
  for (const [reply, retained] of [
    [() => Response.json({ error: "gone" }, { status: 410 }), "plain"],
    [() => expiredReply(foreign), "another session"],
    [() => expiredReply({ functions: ids[0] }, { identities: { functions: "c".repeat(64), cmsApi: cmsApiReader } }), "another reader"],
    [() => expiredReply({ functions: ids[0] }, { expired: [] }), "no lease"],
    [() => new Response("not json", { status: 410 }), "unparseable"],
  ] as const) {
    const { send, request, options } = setup();
    request.mockResolvedValueOnce(reply());
    expect((await send()).status, retained).toBe(410);
    await createInstalledReaderTransport({ ...options, randomUUID: () => { throw new Error(`must retain UUIDs: ${retained}`); } })!
      .send({ endpoint: "cmsPreview", principalId: "staff", token: "fixture-staff", body: {} });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).sessionIds).toEqual(JSON.parse(String(request.mock.calls[1][1]?.body)).sessionIds);
  }
});
it("an endpoint's own 410 passes through a live session unchanged", async () => {
  const { send, request } = setup();
  await send();
  request.mockResolvedValueOnce(Response.json({ error: "preview expired" }, { status: 410 }));
  expect((await send()).status).toBe(410);
  expect((await send()).status).toBe(200);
});
it("typed expiry ends every waiter on the shared open with no hidden retry", async () => {
  const { send, request } = setup();
  request.mockImplementationOnce(async (_url, init) => expiredReply(JSON.parse(String(init?.body)).sessionIds));
  const outcomes = await Promise.allSettled([send(), send()]);
  expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
  await expect(send()).rejects.toThrow("Reload Boardwalk");
  expect(request.mock.calls).toHaveLength(1);
});

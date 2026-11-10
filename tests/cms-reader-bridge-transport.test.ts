import { expect, it, vi } from "vitest";
import { createCmsReaderBridge } from "../cms-api/src/cms-reader-bridge";
import { FirebaseTokenError } from "../cms-api/src/firebase-auth";
import { createVersionedReaderClient } from "../admin/src/lib/versioned-reader-client";
import { createCmsReaderReplayTransport } from "../scripts/lib/cms-reader-bridge-install.mjs";

const gatewayDigest = "a".repeat(64), functionsDigest = "b".repeat(64);
const targets = [1, 2].map(version => ({ version: version as 1 | 2,
  functionsUrl: `https://us-central1-njpbs-site.cloudfunctions.net/cmsReaderV${version}`, gatewayReaderDigest: gatewayDigest }));
const sessionIds = { functions: "11111111-1111-4111-8111-111111111111", cmsApi: "22222222-2222-4222-8222-222222222222" };
const body = { version: 1, action: "request", sessionIds, endpoint: "cmsGetPublicPage", body: { mode: "no-build-post-v1" } };
function incoming(value = body, path = "/api/cms/v1/reader", headers = {}) {
  return new Request(`https://api.example.org${path}`, { method: "POST", body: JSON.stringify(value),
    headers: { "content-type": "application/json", authorization: "Bearer fixture-staff", ...headers } });
}
const setup = (extra = {}) => {
  const request = vi.fn(async () => new Response('{"kind":"post","chrome":{"value":1}}', { headers: {
    "content-type": "application/json", "x-njpbs-functions-reader": functionsDigest,
    "x-njpbs-gateway-reader": gatewayDigest, "set-cookie": "must-not-forward", "authorization": "must-not-forward",
  } }));
  const verifyToken = vi.fn(async () => ({ uid: "staff" }));
  const bridge = createCmsReaderBridge({ targets, projectId: "njpbs-site",
    readEdgeSecret: () => "fixture-edge", request: request as unknown as typeof fetch, verifyToken, ...extra });
  return { request, verifyToken, handler: (incoming: Request) => bridge(incoming, {
    requestId: "33333333-3333-4333-8333-333333333333", clientIp: "203.0.113.9",
  }) };
};
it.each([1, 2])("preserves actual request and reply bytes on retained version %s", async version => {
  const { handler, request, verifyToken } = setup();
  const input = { ...body, version };
  const reply = await handler(incoming(input, `/api/cms/v${version}/reader`, {
    "x-njpbs-cms-reader": "forged", "x-njpbs-cms-edge": "forged", "x-firebase-appcheck": "fixture-appcheck",
    "x-njpbs-client-ip": "forged", "x-njpbs-request-id": "forged",
  }));
  expect(reply?.status).toBe(200);
  expect(await reply?.text()).toBe('{"kind":"post","chrome":{"value":1}}');
  expect(verifyToken).toHaveBeenCalledOnce();
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(targets[version - 1].functionsUrl);
  expect(new TextDecoder().decode(init.body as Uint8Array)).toBe(JSON.stringify(input));
  expect(init.headers).toMatchObject({ "x-njpbs-cms-reader": gatewayDigest, "x-njpbs-cms-edge": "fixture-edge", "x-firebase-appcheck": "fixture-appcheck",
    "x-njpbs-client-ip": "203.0.113.9", "x-njpbs-request-id": "33333333-3333-4333-8333-333333333333" });
  expect(reply?.headers.get("cache-control")).toBe("private, no-store");
  expect(reply?.headers.has("set-cookie")).toBe(false);
  expect(reply?.headers.has("authorization")).toBe(false);
});
it("requires authentication before forwarding and never retries", async () => {
  const { handler, request } = setup({ verifyToken: async () => { throw new FirebaseTokenError(); } });
  expect((await handler(incoming()))?.status).toBe(401);
  expect(request).not.toHaveBeenCalled();
  const failed = vi.fn(async () => { throw new Error("connection lost"); });
  expect((await setup({ request: failed }).handler(incoming()))?.status).toBe(503);
  expect(failed).toHaveBeenCalledOnce();
  expect((await setup({ verifyToken: async () => { throw new Error("Auth infrastructure unavailable"); } }).handler(incoming()))?.status).toBe(503);
});
it("refuses mismatched versions, reader identities, unknown routes and oversized streamed bodies", async () => {
  const { handler, request } = setup();
  expect(await handler(incoming(body, "/api/cms/v3/reader"))).toBe(null);
  expect((await handler(incoming({ ...body, version: 2 })))?.status).toBe(400);
  expect(request).not.toHaveBeenCalled();
  const wrong = setup({ request: async () => new Response("{}", { headers: { "x-njpbs-gateway-reader": "c".repeat(64) } }) });
  expect((await wrong.handler(incoming()))?.status).toBe(503);
  const tooLarge = incoming({ ...body, body: { text: "x".repeat(2 * 1024 * 1024) } });
  expect((await handler(tooLarge))?.status).toBe(413);
  expect(request).not.toHaveBeenCalled();
});
it("the explicit client retains session IDs across manual lost-response retry without renewal or hidden fetches", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost")).mockResolvedValue(new Response("{}"));
  const readToken = vi.fn(async () => "fixture-staff");
  const client = createVersionedReaderClient({ origin: "https://api.example.org", version: 1, sessionIds, readToken, request });
  await expect(client.open()).rejects.toThrow("lost");
  expect(request).toHaveBeenCalledOnce();
  await client.open();
  expect(request.mock.calls[0][1]?.body).toBe(request.mock.calls[1][1]?.body);
  await client.request("cmsGetPublishedSettings", { id: "station" });
  expect(request).toHaveBeenCalledTimes(3);
  expect(readToken).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toMatchObject({ sessionIds, action: "request", version: 1 });
});
it("refuses alternate origins, credentials in URLs and missing explicit target configuration", () => {
  expect(() => createVersionedReaderClient({ origin: "https://evil.example", version: 1, sessionIds, readToken: async () => "" })).toThrow();
  expect(() => createVersionedReaderClient({ origin: "https://user:password@api.example.org", version: 1, sessionIds, readToken: async () => "" })).toThrow();
  expect(() => setup({ targets: [] })).toThrow();
  expect(() => setup({ targets: [{ ...targets[0], functionsUrl: "https://evil.example/function" }] })).toThrow();
  expect(() => setup({ targets: [{ ...targets[0], functionsUrl: "https://us-central1-other-project.cloudfunctions.net/function" }] })).toThrow();
  const readStaffToken = vi.fn(), readEdgeSecret = vi.fn();
  expect(() => createCmsReaderReplayTransport({ projectId: "njpbs-site", readStaffToken, readEdgeSecret, targets: {
    functions: { 1: "https://us-central1-other-project.cloudfunctions.net/reader", 2: targets[1].functionsUrl },
    cmsApi: { 1: "https://api.example.org/api/cms/v1/reader", 2: "https://api.example.org/api/cms/v2/reader" },
  } })).toThrow();
  expect(readStaffToken).not.toHaveBeenCalled(); expect(readEdgeSecret).not.toHaveBeenCalled();
});

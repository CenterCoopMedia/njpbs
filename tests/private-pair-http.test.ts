import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import slot, { PublicReleaseSlotEntrypoint, assertEmbeddedPublicSlot, type PublicReleaseSlotEnvironment } from "../workers/src/public-release-slot-worker";
import operator, { type PrivatePairOperatorEnvironment } from "../workers/src/private-pair-operator-worker";
import { PAIR_READER_PATH, PAIR_READER_REQUEST_LIMIT, PAIR_OPERATOR_CAPTURE_PATH, PAIR_OPERATOR_PROVE_PATH } from "../packages/content-core/src/private-pair-http";
import { sealedPair } from "./helpers/sealed-public-release-pair";
import { createPrivatePairOperatorClient } from "../site/scripts/public-release-pair-operator-client";
import gateway from "../workers/src/private-pair-reader-gateway";

const origin = "https://private-reader.example.test", audience = "a".repeat(64), clientId = "fixture123.access";
const { pair, seals } = sealedPair(origin);
const { versionId, ...publicWorker } = pair.publicWorker;
const { readerReceiptDigest: _runtimeReceipt, ...stable } = pair;
const config = { CMS_DEV_ACCESS_ORIGIN: "https://access.example.org", PAIR_PRIVATE_HTTP_ENABLED: "true", PAIR_PRIVATE_ORIGIN: origin, PAIR_ACCESS_AUDIENCE: audience, PAIR_ACCESS_CLIENT_ID: clientId };
let key: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { key = await generateKeyPair("RS256"); jwk = { ...await exportJWK(key.publicKey), kid: "fixture", alg: "RS256" }; });
afterEach(() => vi.unstubAllGlobals());
function jwks(origin = "https://access.example.org") {
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(String(url)).toBe(`${origin}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
}
async function token(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: "app", sub: "", common_name: clientId, iss: "https://access.example.org",
    aud: [audience], iat: now, exp: now + 60, ...changes }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(key.privateKey);
}
const request = (path: string, assertion: string, value: unknown = {}) => new Request(`${origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion,
    "content-length": String(Buffer.byteLength(JSON.stringify(value))),
    "cf-access-client-secret": "synthetic-only", cookie: "synthetic-only", "x-njpbs-publication-operation": "untrusted" }, body: JSON.stringify(value),
});
function slotEnv(readPrivatePair = vi.fn(async (_request: Request, _pair: unknown) => new Response('{"actual":"bytes"}', {
  headers: { "content-type": "application/json", "cache-control": "private, no-store" },
}))) {
  return { ...config, PUBLIC_PAIR_IDENTITY_JSON: JSON.stringify({ ...stable, publicWorker }), PAIR_WORKER_VERSION: { id: versionId },
    PAIR_READER: { readPrivatePair, readerInstallation: vi.fn(async () => ({ actual: true })) } } as unknown as PublicReleaseSlotEnvironment;
}
it("refuses unknown or disabled HTTP before binding or credential work", async () => {
  const env = { get PAIR_READER() { throw new Error("Touched binding"); } } as PublicReleaseSlotEnvironment;
  expect((await slot.fetch(request("/wake", ""), env)).status).toBe(404);
  expect((await slot.fetch(request(PAIR_READER_PATH, ""), env)).status).toBe(403);
  expect((await slot.fetch(new Request(`${origin}${PAIR_READER_PATH}`), env)).status).toBe(404);
});
it("validates signed Access identity and strips credentials before the actual slot binding", async () => {
  jwks(); const env = slotEnv();
  const result = await slot.fetch(request(PAIR_READER_PATH, await token(), { immutable: true }), env);
  expect(result.status).toBe(200); expect(await result.text()).toBe('{"actual":"bytes"}');
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  const [forwarded, owner] = vi.mocked(env.PAIR_READER!.readPrivatePair).mock.calls[0];
  expect(owner).toEqual(pair); expect([...forwarded.headers]).toEqual([["content-type", "application/json"]]);
  expect(await forwarded.json()).toEqual({ immutable: true });
});
it("uses the configured Access issuer for signing keys and token verification", async () => {
  const issuer = "https://second-access.example.org";
  jwks(issuer);
  const env = { ...slotEnv(), CMS_DEV_ACCESS_ORIGIN: issuer };
  expect((await slot.fetch(request(PAIR_READER_PATH, await token({ iss: issuer })), env)).status).toBe(200);
});
it.each([undefined, "", "http://access.example.org", "https://user:pass@access.example.org", "https://access.example.org/path"])(
  "refuses absent or invalid issuer configuration %s before key lookup", async origin => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const env = { ...slotEnv(), CMS_DEV_ACCESS_ORIGIN: origin };
    expect((await slot.fetch(request(PAIR_READER_PATH, await token()), env)).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
    expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
  });
it("relays the private gateway only to the actual slot, which verifies Access and reads exact bytes", async () => {
  jwks(); const env = slotEnv(), entry = Object.create(PublicReleaseSlotEntrypoint.prototype); entry.env = env;
  const target = { readPrivatePairHttp: vi.fn((input: Request) => entry.readPrivatePairHttp(input)) };
  const config = { PAIR_READER_GATEWAY_ENABLED: "true", PAIR_PRIVATE_ORIGIN: origin, PAIR_SLOT_READER: target };
  const result = await gateway.fetch(request(PAIR_READER_PATH, await token(), { immutable: true }), config);
  expect(result.status).toBe(200); expect(await result.text()).toBe('{"actual":"bytes"}');
  const forwarded = target.readPrivatePairHttp.mock.calls[0][0];
  expect(forwarded.headers.has("cf-access-client-secret")).toBe(false); expect(forwarded.headers.has("cookie")).toBe(false);
  expect(forwarded.headers.has("cf-access-jwt-assertion")).toBe(true);
  expect((await gateway.fetch(request(PAIR_READER_PATH, ""), config)).status).toBe(403);
  expect(env.PAIR_READER!.readPrivatePair).toHaveBeenCalledOnce();
  target.readPrivatePairHttp.mockClear();
  expect((await gateway.fetch(request(PAIR_READER_PATH, ""), { ...config, PAIR_READER_GATEWAY_ENABLED: "false" })).status).toBe(404);
  expect((await gateway.fetch(request(`${PAIR_READER_PATH}?publish=1`, ""), config)).status).toBe(404);
  expect((await gateway.fetch(request("/private-pair-reader/v2/installation", ""), config)).status).toBe(404);
  expect(target.readPrivatePairHttp).not.toHaveBeenCalled();
});
it.each([{ aud: ["d".repeat(64)] }, { common_name: "operator123.access" }])("refuses signed gateway assertions for another app or operator client %j", async claims => {
  jwks(); const env = slotEnv(), entry = Object.create(PublicReleaseSlotEntrypoint.prototype); entry.env = env;
  const result = await gateway.fetch(request(PAIR_READER_PATH, await token(claims)), {
    PAIR_READER_GATEWAY_ENABLED: "true", PAIR_PRIVATE_ORIGIN: origin,
    PAIR_SLOT_READER: { readPrivatePairHttp: (input: Request) => entry.readPrivatePairHttp(input) },
  });
  expect(result.status).toBe(403); expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
});
it.each([
  { aud: ["b".repeat(64)] }, { iss: "https://other.cloudflareaccess.com" }, { common_name: "other.access" },
  { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 3600 }, { type: "org" }, { sub: "human" }, { email: "user@example.test" },
])("refuses incorrect signed Access claims %j", async changes => {
  jwks(); const env = slotEnv();
  expect((await slot.fetch(request(PAIR_READER_PATH, await token(changes)), env)).status).toBe(403);
  expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
});
it("refuses unsigned assertions, wrong origin, query and streamed oversized input", async () => {
  jwks(); const env = slotEnv(), assertion = await token();
  expect((await slot.fetch(request(PAIR_READER_PATH, "unsigned"), env)).status).toBe(403);
  expect((await slot.fetch(request(`${PAIR_READER_PATH}?mode=publish`, assertion), env)).status).toBe(403);
  expect((await slot.fetch(request(PAIR_READER_PATH, assertion), { ...env, PAIR_PRIVATE_ORIGIN: "https://other.example.test" })).status).toBe(403);
  expect((await slot.fetch(request(PAIR_READER_PATH, assertion, "x".repeat(PAIR_READER_REQUEST_LIMIT)), env)).status).toBe(503);
  expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
});
it("refuses an incorrect embedded slot version or receipt origin", async () => {
  const env = slotEnv();
  expect(assertEmbeddedPublicSlot(env, pair)).toEqual(pair);
  expect(() => assertEmbeddedPublicSlot({ ...env, PAIR_WORKER_VERSION: { id: "bbbbbbbb-1111-4111-8111-111111111111" } }, pair)).toThrow();
  expect(() => assertEmbeddedPublicSlot(env, { ...pair, readerReceiptDigest: "f".repeat(64) })).toThrow();
  expect(() => assertEmbeddedPublicSlot({ ...env, PAIR_PRIVATE_ORIGIN: "https://other.example.test" }, pair)).toThrow();
});
it("refuses a valid-looking assertion signed by another issuer key", async () => {
  jwks(); const env = slotEnv(), other = await generateKeyPair("RS256"), now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ type: "app", sub: "", common_name: clientId,
    iss: "https://access.example.org", aud: [audience], iat: now, exp: now + 60 })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(other.privateKey);
  expect((await slot.fetch(request(PAIR_READER_PATH, assertion), env)).status).toBe(403);
  expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
});
it("refuses absent, excessive or incorrect declared lengths before the reader binding", async () => {
  jwks(); const env = slotEnv(), assertion = await token();
  for (const length of [null, String(PAIR_READER_REQUEST_LIMIT + 1), "1", "-1", "2x"]) {
    const input = request(PAIR_READER_PATH, assertion);
    if (length === null) input.headers.delete("content-length"); else input.headers.set("content-length", length);
    expect((await slot.fetch(input, env)).status).toBe(503);
  }
  expect(env.PAIR_READER!.readPrivatePair).not.toHaveBeenCalled();
});
it("exposes actual slot installation only through private RPC", async () => {
  const env = slotEnv(), entry = Object.create(PublicReleaseSlotEntrypoint.prototype); entry.env = env;
  expect((await entry.readerInstallation()).seals).toEqual(seals);
  expect((await slot.fetch(request("/private-pair-reader/v2/installation", ""), env)).status).toBe(404);
});
function operatorEnv() {
  return { ...config, PAIR_ACCESS_AUDIENCE: "b".repeat(64), PAIR_ACCESS_CLIENT_ID: "operator123.access",
    PAIR_READER_ACCESS_JSON: JSON.stringify([{ audience, clientId }, { audience: "c".repeat(64), clientId: "second123.access" }]),
    PAIR_PROOF_ORIGIN: "https://dev-public.example.org", PAIR_INGRESS_PROOF: {
    prove: vi.fn(async (_request: Request, _digest: string, expected: { status: number }) => new Response("", { status: expected.status,
      headers: { "x-njpbs-publication-operation": "original-operation", "cache-control": "no-store" } })),
    captureRecovery: vi.fn(async () => {}),
  } } as PrivatePairOperatorEnvironment;
}
it("bridges only authenticated proof and recovery calls with exact proof bytes", async () => {
  jwks(); const env = operatorEnv(), assertion = await token({ aud: [env.PAIR_ACCESS_AUDIENCE], common_name: env.PAIR_ACCESS_CLIENT_ID });
  const proof = await operator.fetch(request(PAIR_OPERATOR_PROVE_PATH, assertion, { path: "/withdrawn/", bodyDigest: "b".repeat(64), status: 410 }), env);
  expect(proof.status).toBe(410); expect(proof.headers.get("x-njpbs-publication-operation")).toBe("original-operation");
  const forwarded = vi.mocked(env.PAIR_INGRESS_PROOF.prove).mock.calls[0][0];
  expect(forwarded.url).toBe("https://dev-public.example.org/withdrawn/"); expect([...forwarded.headers]).toEqual([]);
  expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH, assertion), env)).status).toBe(204);
  expect(env.PAIR_INGRESS_PROOF.captureRecovery).toHaveBeenCalledOnce();
});
it.each(["//evil.example.test/", "/posts/../", "/?publish=1", "https://evil.example.test/"])("refuses operator target %s", async path => {
  jwks(); const env = operatorEnv();
  expect((await operator.fetch(request(PAIR_OPERATOR_PROVE_PATH, await token({ aud: [env.PAIR_ACCESS_AUDIENCE], common_name: env.PAIR_ACCESS_CLIENT_ID }),
    { path, bodyDigest: "b".repeat(64), status: 200 }), env)).status).toBe(400);
  expect(env.PAIR_INGRESS_PROOF.prove).not.toHaveBeenCalled();
});
it("never invokes capture through an unauthenticated or extra-field request", async () => {
  jwks(); const env = operatorEnv();
  expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH, ""), env)).status).toBe(403);
  expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH,
    await token({ aud: [env.PAIR_ACCESS_AUDIENCE], common_name: env.PAIR_ACCESS_CLIENT_ID }), { epoch: 2 }), env)).status).toBe(400);
  expect(env.PAIR_INGRESS_PROOF.captureRecovery).not.toHaveBeenCalled();
});
it("refuses a reader token and refuses shared Access app or token configuration on the operator", async () => {
  jwks(); const env = operatorEnv(), readerToken = await token();
  expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH, readerToken), env)).status).toBe(403);
  const operatorToken = await token({ aud: [env.PAIR_ACCESS_AUDIENCE], common_name: env.PAIR_ACCESS_CLIENT_ID });
  for (const changes of [{ PAIR_ACCESS_AUDIENCE: audience }, { PAIR_ACCESS_CLIENT_ID: clientId }]) {
    expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH, operatorToken), { ...env, ...changes })).status).toBe(403);
  }
  for (const changes of [{ PAIR_ACCESS_AUDIENCE: "c".repeat(64) }, { PAIR_ACCESS_CLIENT_ID: "second123.access" }]) {
    expect((await operator.fetch(request(PAIR_OPERATOR_CAPTURE_PATH, operatorToken), { ...env, ...changes })).status).toBe(403);
  }
  expect(env.PAIR_INGRESS_PROOF.captureRecovery).not.toHaveBeenCalled();
  expect(env.PAIR_INGRESS_PROOF.prove).not.toHaveBeenCalled();
});
it("reads operator service credentials at use, preserves 410 and refuses redirects", async () => {
  let reads = 0, redirect = false;
  const client = createPrivatePairOperatorClient({ origin, credentials: async () => { reads++; return {
    "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": "synthetic-only" }; } });
  expect(reads).toBe(0);
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("CF-Access-Client-Secret")).toBe("synthetic-only");
    expect(init.redirect).toBe("manual");
    return new Response("", { status: redirect ? 302 : 410, headers: { "cache-control": "private, no-store" } });
  });
  expect((await client.prove({ path: "/gone/", bodyDigest: "a".repeat(64), status: 410 })).status).toBe(410);
  expect(reads).toBe(1); redirect = true;
  await expect(client.prove({ path: "/gone/", bodyDigest: "a".repeat(64), status: 410 })).rejects.toThrow("unavailable");
});

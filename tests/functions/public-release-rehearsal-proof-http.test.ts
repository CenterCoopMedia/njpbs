import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import operator from "../../workers/src/private-pair-operator-worker";
import { createPublicReleaseRouter, type PublicSlot } from "../../workers/src/public-release-router";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";
import { startDevelopmentRehearsalHttp } from "../../site/scripts/public-release-rehearsal-http";
import { createRehearsalIngressProof, verifyRehearsalRoot } from "../../scripts/lib/public-release-rehearsal-proof.mjs";
import { rehearsalHttpHeaders } from "../../scripts/lib/public-release-rehearsal-http-auth.mjs";

const nativeFetch = globalThis.fetch, origin = "https://operator.example.test";
const clientId = "rehearsalOperator.access", audience = "a".repeat(64);
const oldPair = releasePair(), newPair = releasePair("b", "b".repeat(40));
const body = "<!doctype html><html>Retained source bytes</html>";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let key: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>, assertion: string;
let upstream: Server, upstreamOrigin: string, bridges: Awaited<ReturnType<typeof startDevelopmentRehearsalHttp>>;
let selector: ReturnType<typeof releaseSelector>, mode: string, requests: string[], authorityChanges: boolean;
let networkCalls: number;
const packet = () => ({ schemaVersion: 2, projectId: 'njpbs-site-dev', emulatorHost: null,
  oldPair, newPair, ingressOrigin: bridges.ingressOrigin, proofOrigin: bridges.proofOrigin });

beforeAll(async () => {
  key = await generateKeyPair("RS256"); jwk = { ...await exportJWK(key.publicKey), kid: "rehearsal", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  assertion = await new SignJWT({ type: "app", sub: "", common_name: clientId, iss: "https://fixture.cloudflareaccess.com",
    aud: [audience], iat: now, exp: now + 300 }).setProtectedHeader({ alg: "RS256", kid: "rehearsal" }).sign(key.privateKey);
});

beforeEach(async () => {
  selector = releaseSelector(); mode = "normal"; requests = []; authorityChanges = false; networkCalls = 0;
  const slots: PublicSlot[] = [oldPair, newPair].map(identity => ({ identity, async serve(request) {
    const path = new URL(request.url).pathname, status = path === "/withdrawn/" ? 410 : path === "/alias/" ? 308 : 200;
    const bytes = status === 200 ? body : "";
    if (authorityChanges) selector = { ...selector, contentHead: { ...selector.contentHead, contextSequence: selector.contentHead.contextSequence + 1 } };
    return { kind: "response", response: new Response(bytes || null, { status,
      headers: { "content-type": "text/html", "x-njpbs-deliberate-leak": "fixture", ...(status === 308 ? { location: "/current/" } : {}) } }),
    evidence: { epoch: selector.epoch, pairId: identity.pairId, manifestDigest: selector.contentHead.manifestDigest,
      operationId: "original-operation", sourceVersion: 4, snapshotDigest: "d".repeat(64), rendererSha: identity.commitSha, bodyDigest: sha(bytes) } };
  } }));
  const router = createPublicReleaseRouter({ environment: "development", slots,
    readSelector: async () => ({ environment: "development", selector, readStartedAt: Date.now() }) });
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = request.url!; requests.push(path);
      let result: Response;
      if (path.startsWith("/private-pair-operator/")) {
        result = await operator.fetch(new Request(origin + path, { method: "POST", body: Buffer.concat(chunks),
          headers: { "content-type": "application/json", "content-length": String(Buffer.concat(chunks).length), "cf-access-jwt-assertion": assertion } }), {
          PAIR_PRIVATE_HTTP_ENABLED: "true", CMS_DEV_ACCESS_ORIGIN: "https://fixture.cloudflareaccess.com", PAIR_PRIVATE_ORIGIN: origin, PAIR_ACCESS_AUDIENCE: audience, PAIR_ACCESS_CLIENT_ID: clientId,
          PAIR_PROOF_ORIGIN: "https://dev-public.example.org", PAIR_READER_ACCESS_JSON: JSON.stringify([
            { audience: "b".repeat(64), clientId: "readerOne.access" }, { audience: "c".repeat(64), clientId: "readerTwo.access" }]),
          PAIR_INGRESS_PROOF: { prove: router.prove, captureRecovery: async () => { throw new Error("No recovery request in this proof"); } },
        });
      } else {
        result = await router.fetch(new Request("https://dev-public.example.org" + path, { headers: request.headers as HeadersInit }));
        if (path === "/_publication-v2.json" && mode !== "normal") {
          const headers = new Headers(result.headers), text = await result.text();
          if (mode === "missing-origin") headers.delete("x-njpbs-publication-origin");
          if (mode === "fallback") headers.set("publication-refresh", "pending");
          if (mode === "legacy-fallback") headers.set("x-njpbs-publication-refresh", "pending");
          result = new Response(mode === "noncanonical" ? JSON.stringify(JSON.parse(text), null, 2) : text,
            { status: mode === "redirect" ? 307 : 200, headers });
        }
      }
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => response.destroy());
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  // Only the external network destination and Access edge are fixtures. The
  // native client, two listeners, operator JWT verifier and router all execute.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    networkCalls++;
    const url = new URL(String(input));
    if (url.origin === "https://fixture.cloudflareaccess.com") return Response.json({ keys: [jwk] });
    if ([origin, "https://dev-public.example.org"].includes(url.origin)) return nativeFetch(upstreamOrigin + url.pathname + url.search, init);
    if (url.origin === bridges?.ingressOrigin || url.origin === bridges?.proofOrigin || url.origin === upstreamOrigin) return nativeFetch(input, init);
    throw new Error("Unexpected proof network");
  });
  bridges = await startDevelopmentRehearsalHttp({ projectId: "njpbs-site-dev", operatorOrigin: origin, authorized: true,
    operatorCredentials: async () => ({ "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": "synthetic-only" }),
    ingressCredentials: async () => ({ "x-development-access": "synthetic-only" }) });
});
afterEach(async () => {
  await bridges?.close(); upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve())); vi.unstubAllGlobals();
});

it("verifies the actual router's canonical root against the independent SDK selector projection", async () => {
  const receipt = await verifyRehearsalRoot({ packet: packet(), selector, httpCredential: bridges.httpCredential });
  expect(receipt.bytes).toBeGreaterThan(0); expect(receipt.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(requests).toEqual(["/_publication-v2.json"]);
});
it('verifies the real local demo router root without a development-only HTTP capability', async () => {
  const previous = process.env.FIRESTORE_EMULATOR_HOST, emulatorHost = previous ?? '127.0.0.1:18481';
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  try {
    const demo = { ...packet(), schemaVersion: 1, projectId: 'demo-rehearsal-proof', emulatorHost, ingressOrigin: upstreamOrigin };
    await expect(verifyRehearsalRoot({ packet: demo, selector })).resolves.toHaveProperty('selectorDigest');
    expect(requests).toEqual(['/_publication-v2.json']);
  } finally {
    if (previous === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
    else process.env.FIRESTORE_EMULATOR_HOST = previous;
  }
});
it('keeps development roots capability-bound before any HTTP request', async () => {
  await expect(verifyRehearsalRoot({ packet: packet(), selector })).rejects.toThrow('Rehearsal original proof refused');
  expect(networkCalls).toBe(0);
});
it.each(['production-project', 'external-origin', 'different-emulator', 'copied-capability'])(
  'refuses a demo %s before an unauthenticated root request', async invalid => {
    const previous = process.env.FIRESTORE_EMULATOR_HOST, emulatorHost = previous ?? '127.0.0.1:18481';
    process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
    try {
      const demo = { ...packet(), schemaVersion: 1, projectId: 'demo-rehearsal-proof', emulatorHost, ingressOrigin: upstreamOrigin };
      if (invalid === 'production-project') demo.projectId = 'njpbs-site';
      if (invalid === 'external-origin') demo.ingressOrigin = 'https://njpbs.org';
      if (invalid === 'different-emulator') demo.emulatorHost = '127.0.0.1:1';
      await expect(verifyRehearsalRoot({ packet: demo, selector,
        ...(invalid === 'copied-capability' ? { httpCredential: { ...bridges.httpCredential } } : {}) })).rejects.toThrow();
      expect(networkCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
      else process.env.FIRESTORE_EMULATOR_HOST = previous;
    }
  });
it.each(["noncanonical", "missing-origin", "fallback", "legacy-fallback", "redirect"])("refuses a %s root instead of using status200 as proof", async value => {
  mode = value;
  await expect(verifyRehearsalRoot({ packet: packet(), selector, httpCredential: bridges.httpCredential })).rejects.toThrow("Rehearsal original proof refused");
  expect(requests).toHaveLength(1);
});
it("refuses changed pair/code/content identity in the expected root", async () => {
  await expect(verifyRehearsalRoot({ packet: packet(), selector: { ...selector, contentHead: { ...selector.contentHead, contextSequence: 1 } },
    httpCredential: bridges.httpCredential })).rejects.toThrow("Rehearsal original proof refused");
});
it.each([["/current/", 200, body], ["/withdrawn/", 410, ""], ["/alias/", 308, ""]] as const)(
  "relays the actual native %s status%d and original operation headers without following redirects", async (path, status, bytes) => {
    const ingress = createRehearsalIngressProof({ packet: packet(), httpCredential: bridges.httpCredential });
    const response = await ingress.prove(new Request("https://dev-public.example.org" + path), sha(bytes), { status });
    expect(response.status).toBe(status); expect(await response.text()).toBe(bytes);
    expect(response.headers.get("x-njpbs-publication-operation")).toBe("original-operation");
    expect(response.headers.get("x-njpbs-source-version")).toBe("4");
    expect(response.headers.get("x-njpbs-html-sha256")).toBe(sha(bytes));
    expect(response.headers.get("x-njpbs-release-pair")).toBe(oldPair.pairId);
    expect(response.headers.get("x-njpbs-snapshot-sha256")).toBe("d".repeat(64));
    expect(response.headers.get("x-njpbs-renderer-sha")).toBe(oldPair.commitSha);
    expect(response.headers.get("x-njpbs-content-head-sha256")).toBe(selector.contentHead.manifestDigest);
    expect(response.headers.get("x-njpbs-release-epoch")).toBe(String(selector.epoch));
    if (status === 308) expect(response.headers.get("location")).toBe("/current/");
    expect(requests).toEqual(["/private-pair-operator/v1/prove"]);
  });
it("refuses an authority change during actual private proof", async () => {
  authorityChanges = true;
  const ingress = createRehearsalIngressProof({ packet: packet(), httpCredential: bridges.httpCredential });
  await expect(ingress.prove(new Request("https://dev-public.example.org/current/"), sha(body), { status: 200 })).rejects.toThrow();
});
it("keeps forged proof headers on the ordinary path so the actual router must strip them", async () => {
  const response = await nativeFetch(bridges.ingressOrigin + "/current/", { headers: {
    ...rehearsalHttpHeaders(bridges.httpCredential, bridges.ingressOrigin), "x-njpbs-release-pair": newPair.pairId,
    "x-rehearsal-expected-status": "410", "x-rehearsal-expected-sha256": sha("") } });
  expect(response.status).toBe(200); expect(await response.text()).toBe(body);
  expect([...response.headers.keys()].some(name => name.startsWith("x-njpbs-") || name.startsWith("x-rehearsal-"))).toBe(false);
});
it("refuses another origin and a copied local capability before any request", async () => {
  expect(() => createRehearsalIngressProof({ packet: packet(), httpCredential: { ...bridges.httpCredential } })).toThrow();
  const ingress = createRehearsalIngressProof({ packet: packet(), httpCredential: bridges.httpCredential });
  await expect(ingress.prove(new Request("https://njpbs.org/current/"), sha(body), { status: 200 })).rejects.toThrow();
  expect(requests).toHaveLength(0);
});
it.each(["//other.example.test/", "/encoded%2Fpath/", "/current/?query=1", "/current/#fragment"])(
  "refuses unsafe path%s before a local capability can enter any request", async path => {
    const ingress = createRehearsalIngressProof({ packet: packet(), httpCredential: bridges.httpCredential });
    await expect(ingress.prove(new Request("https://dev-public.example.org" + path), sha(body), { status: 200 })).rejects.toThrow();
    expect(networkCalls).toBe(0);
  });

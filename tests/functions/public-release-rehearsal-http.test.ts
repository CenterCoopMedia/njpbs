import { createServer, request as httpRequest, type Server } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startDevelopmentRehearsalHttp } from "../../site/scripts/public-release-rehearsal-http";
import { missingBindings, execute, startLayerFourHttp } from "../../scripts/lib/public-release-rehearsal-adapter.mjs";
import { rehearsalHttpHeaders, hasRehearsalHttpCredential, createRehearsalHttpCredential,
  bindRehearsalHttpCredential, closeRehearsalHttpCredential } from "../../scripts/lib/public-release-rehearsal-http-auth.mjs";

const nativeFetch = globalThis.fetch;
const operatorOrigin = "https://operator.example.test";
const body = "<!doctype html><html>Current operation</html>";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const proofHeaders = { "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8",
  "x-njpbs-html-sha256": sha(body), "x-njpbs-release-epoch": "7", "x-njpbs-release-pair": "original-pair",
  "x-njpbs-publication-operation": "original-operation", "x-njpbs-source-version": "4",
  "x-njpbs-snapshot-sha256": "a".repeat(64), "x-njpbs-renderer-sha": "b".repeat(40),
  "x-njpbs-content-head-sha256": "c".repeat(64), "x-njpbs-selector-sha256": "d".repeat(64),
  "x-njpbs-publication-origin": "template-dev-public" };
let upstream: Server, upstreamOrigin: string;
let bridges: Awaited<ReturnType<typeof startDevelopmentRehearsalHttp>> | undefined;
let mode: "html" | "withdrawn" | "redirect" | "missing-header" | "gzip";
let requests: Array<{ url: string; method: string; headers: Record<string, unknown>; body: string }>;
let operatorReads: number, ingressReads: number;

beforeEach(async () => {
  mode = "html"; requests = []; operatorReads = 0; ingressReads = 0;
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(part);
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: request.url!, method: request.method!, headers: request.headers, body: text });
      if (request.url === "/private-pair-operator/v1/prove") {
        const input = JSON.parse(text);
        expect(request.headers["cf-access-client-id"]).toBe("fixtureOperator.access");
        expect(request.headers["cf-access-client-secret"]).toBe("fixture-operator-secret");
        expect(Number(request.headers["content-length"])).toBe(Buffer.byteLength(text));
        expect(input).toEqual({ path: mode === "withdrawn" ? "/withdrawn/" : "/current/",
          bodyDigest: mode === "withdrawn" ? sha("") : sha(body), status: mode === "withdrawn" ? 410 : 200 });
        if (mode === "redirect") { response.writeHead(307, { "cache-control": "private, no-store", location: "https://other.example.test/" }).end(); return; }
        const headers: Record<string, string> = { ...proofHeaders, "set-cookie": "synthetic-session=fixture",
          authorization: "Bearer synthetic-response", "cf-access-jwt-assertion": "synthetic-assertion" };
        if (mode === "withdrawn") headers["x-njpbs-html-sha256"] = sha("");
        if (mode === "missing-header") delete headers["x-njpbs-selector-sha256"];
        if (mode === "gzip") headers["content-encoding"] = "gzip";
        const bytes = mode === "withdrawn" ? Buffer.alloc(0) : mode === "gzip" ? gzipSync(body) : Buffer.from(body);
        response.writeHead(mode === "withdrawn" ? 410 : 200, { ...headers, "content-length": bytes.length }).end(bytes);
        return;
      }
      expect(request.headers["x-development-gate"]).toBe("fixture-development-access");
      response.writeHead(200, { "content-type": "text/html", "x-njpbs-deliberate-leak": "upstream-value" }).end(body);
    })().catch(() => response.destroy());
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  upstreamOrigin = `http://127.0.0.1:${address.port}`;
  // Only rewrite the network destination. The actual operator client, native
  // fetch serialization, headers, framing and HTTP listeners all run unchanged.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (![operatorOrigin, "https://dev-public.example.org"].includes(url.origin)) throw new Error("Unexpected network destination");
    return nativeFetch(`${upstreamOrigin}${url.pathname}${url.search}`, init);
  });
});
afterEach(async () => {
  await bridges?.close(); bridges = undefined;
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  vi.unstubAllGlobals();
});

const options = () => ({ projectId: "njpbs-site-dev", operatorOrigin, authorized: true,
  operatorCredentials: async () => { operatorReads++; return { "CF-Access-Client-Id": "fixtureOperator.access", "CF-Access-Client-Secret": "fixture-operator-secret" }; },
  ingressCredentials: async () => { ingressReads++; return { "x-development-gate": "fixture-development-access" }; } });
function localHeaders(origin: string, extra: Record<string, string> = {}) {
  if (!bridges) throw new Error("Missing owned bridge");
  return { ...extra, ...rehearsalHttpHeaders(bridges.httpCredential, origin) };
}
async function proof(path = "/current/", digest = sha(body), status = "200") {
  bridges ??= await startDevelopmentRehearsalHttp(options());
  return nativeFetch(`${bridges.proofOrigin}${path}`, { redirect: "manual",
    headers: localHeaders(bridges.proofOrigin, { "x-rehearsal-expected-sha256": digest, "x-rehearsal-expected-status": status }) });
}

it("uses the actual HTTPS operator client across two real HTTP listeners without inventing proof fields", async () => {
  const response = await proof();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
  for (const [name, value] of Object.entries(proofHeaders)) expect(response.headers.get(name)).toBe(value);
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("authorization")).toBe(false); expect(response.headers.has("cf-access-jwt-assertion")).toBe(false);
  expect(operatorReads).toBe(1); expect(ingressReads).toBe(0);
  expect(requests).toHaveLength(1);
});
it("returns native withdrawal status, empty bytes and the actual operation headers", async () => {
  mode = "withdrawn";
  const response = await proof("/withdrawn/", sha(""), "410");
  expect(response.status).toBe(410); expect(await response.text()).toBe("");
  expect(response.headers.get("x-njpbs-html-sha256")).toBe(sha(""));
  expect(response.headers.get("x-njpbs-publication-operation")).toBe("original-operation");
});
it("does not fill a proof header missing from the real response", async () => {
  mode = "missing-header";
  const response = await proof();
  expect(response.status).toBe(200); expect(response.headers.has("x-njpbs-selector-sha256")).toBe(false);
  await response.body?.cancel();
});
it("forwards decoded entity bytes without stale compression or length framing", async () => {
  mode = "gzip";
  const response = await proof();
  expect(await response.text()).toBe(body);
  expect(response.headers.has("content-encoding")).toBe(false);
  expect(response.headers.get("x-njpbs-html-sha256")).toBe(sha(body));
});
it("passes forged proof headers and upstream leaks through the ordinary path for the harness to check", async () => {
  bridges = await startDevelopmentRehearsalHttp(options());
  const response = await nativeFetch(`${bridges.ingressOrigin}/current/`, { headers: localHeaders(bridges.ingressOrigin, {
    "x-njpbs-release-epoch": "forged", "x-rehearsal-expected-status": "418", cookie: "forged-cookie" }) });
  expect(await response.text()).toBe(body);
  expect(response.headers.get("x-njpbs-deliberate-leak")).toBe("upstream-value");
  expect(requests[0].headers["x-njpbs-release-epoch"]).toBe("forged");
  expect(requests[0].headers["x-rehearsal-expected-status"]).toBe("418");
  expect(requests[0].headers.authorization).toBeUndefined(); expect(requests[0].headers.cookie).toBeUndefined();
  expect(ingressReads).toBe(1); expect(operatorReads).toBe(0);
});
it.each(["digest", "status", "query", "method"])("refuses invalid %s before credential retrieval", async kind => {
  bridges = await startDevelopmentRehearsalHttp(options());
  const response = await nativeFetch(`${bridges.proofOrigin}/current/${kind === "query" ? "?extra=1" : ""}`, {
    method: kind === "method" ? "POST" : "GET", headers: localHeaders(bridges.proofOrigin, { "x-rehearsal-expected-sha256": kind === "digest" ? "invalid" : sha(body),
      "x-rehearsal-expected-status": kind === "status" ? "418" : "200" }) });
  expect([405, 502]).toContain(response.status); await response.body?.cancel();
  expect(operatorReads).toBe(0); expect(requests).toHaveLength(0);
});
it("does not follow an upstream redirect with operator credentials", async () => {
  mode = "redirect";
  const response = await proof();
  expect(response.status).toBe(502); await response.body?.cancel(); expect(requests).toHaveLength(1);
});
it("keeps setup off by default, forbids production and leaves the whole-rehearsal guard intact", async () => {
  await expect(startDevelopmentRehearsalHttp({ ...options(), authorized: false })).rejects.toThrow();
  await expect(startDevelopmentRehearsalHttp({ ...options(), projectId: "njpbs-site" })).rejects.toThrow();
  await expect(startLayerFourHttp({ ...options(), authorized: false })).rejects.toThrow();
  expect(operatorReads + ingressReads).toBe(0);
  expect(missingBindings).toEqual(['layer-5-switch-admission-and-terminal-owner', 'layer-6-preview-and-component-failure-boundaries']);
  await expect(execute({})).rejects.toThrow("Rehearsal bindings missing");
});
it("redacts malformed endpoint details before credentials or listeners are used", async () => {
  await expect(startDevelopmentRehearsalHttp({ ...options(), operatorOrigin: "malformed:fixture-sensitive" })).rejects.toThrow("Development rehearsal HTTP bridge refused");
  expect(operatorReads + ingressReads).toBe(0); expect(requests).toHaveLength(0);
});
it("ends the HTTP request at its deadline even when a credential callback never returns", async () => {
  bridges = await startDevelopmentRehearsalHttp({ ...options(), operatorCredentials: () => new Promise<HeadersInit>(() => {}) });
  const response = await nativeFetch(`${bridges.proofOrigin}/current/`, { signal: AbortSignal.timeout(6_000),
    headers: localHeaders(bridges.proofOrigin, { "x-rehearsal-expected-sha256": sha(body), "x-rehearsal-expected-status": "200" }) });
  expect(response.status).toBe(504); await response.body?.cancel(); expect(requests).toHaveLength(0);
});
it("loads the single adapter transport through the actual development Node loader", () => {
  const loader = fileURLToPath(new URL("../../site/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e",
    'const {startLayerFourHttp}=await import("./scripts/lib/public-release-rehearsal-adapter.mjs");try{await startLayerFourHttp({authorized:false});process.exitCode=1;}catch(error){process.exitCode=error.message==="Development rehearsal HTTP bridge refused"?0:1;}'],
  { cwd: root, timeout: 10_000, stdio: "pipe" });
  expect(result.status, "Owned Node transport import refused").toBe(0);
});
it.each(["ingressOrigin", "proofOrigin"] as const)("refuses unauthenticated and other-session requests on %s before Access credentials", async side => {
  bridges = await startDevelopmentRehearsalHttp(options());
  const origin = bridges[side], other = createRehearsalHttpCredential();
  bindRehearsalHttpCredential(other, [bridges.ingressOrigin, bridges.proofOrigin]);
  try {
    for (const headers of [{}, rehearsalHttpHeaders(other, origin)]) {
      const response = await nativeFetch(`${origin}/current/`, { headers });
      expect(response.status).toBe(403); await response.body?.cancel();
    }
    expect(operatorReads + ingressReads).toBe(0); expect(requests).toHaveLength(0);
  } finally { closeRehearsalHttpCredential(other); }
});
it.each(["ingressOrigin", "proofOrigin"] as const)("refuses a rebound Host on %s even with the live capability", async side => {
  bridges = await startDevelopmentRehearsalHttp(options());
  const origin = bridges[side];
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${origin}/current/`, { headers: { ...localHeaders(origin), host: "rebound.example.test" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject); request.end();
  });
  expect(status).toBe(403); expect(operatorReads + ingressReads).toBe(0); expect(requests).toHaveLength(0);
});
it("keeps the capability out of serialized packets and revokes it on close", async () => {
  bridges = await startDevelopmentRehearsalHttp(options());
  const credential = bridges.httpCredential, serialized = JSON.stringify(credential);
  expect(serialized).toBe("{}"); expect(hasRehearsalHttpCredential(JSON.parse(serialized))).toBe(false);
  expect(() => rehearsalHttpHeaders(credential, "https://other.example.test")).toThrow("Rehearsal HTTP credential refused");
  await bridges.close();
  expect(hasRehearsalHttpCredential(credential)).toBe(false);
  expect(() => rehearsalHttpHeaders(credential, bridges!.proofOrigin)).toThrow("Rehearsal HTTP credential refused");
});

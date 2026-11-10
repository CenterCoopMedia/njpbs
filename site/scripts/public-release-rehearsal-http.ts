import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import targets from "../../functions/lib/publication-target.js";
import { createPrivatePairOperatorClient } from "./public-release-pair-operator-client";
import { createRehearsalHttpCredential, bindRehearsalHttpCredential, acceptRehearsalHttpAuthorization,
  closeRehearsalHttpCredential } from "../../scripts/lib/public-release-rehearsal-http-auth.mjs";

function refuse(): never { throw new Error("Development rehearsal HTTP bridge refused"); }
const deadlineMs = 3_000;
const bodyLimit = 16 * 1024 * 1024;
const developmentTarget = targets.publicationTarget("development");
const transportHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

function requestPath(request: IncomingMessage, proof: boolean) {
  const raw = request.url;
  if (!raw || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//")) refuse();
  const url = new URL(raw, "http://127.0.0.1");
  if (url.hash || url.pathname !== raw.split("?")[0] || proof && url.search) refuse();
  return `${url.pathname}${url.search}`;
}

function viewerHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || transportHeaders.has(name) || name === "authorization" || name === "cookie" || name.startsWith("cf-access-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function copyResponse(upstream: Response, response: ServerResponse, head: boolean, signal: AbortSignal) {
  for (const [name, value] of upstream.headers) {
    // Node fetch decodes the entity. Do not forward its old wire framing or
    // an authentication cookie. Proof headers and status remain untouched.
    if (!transportHeaders.has(name) && name !== "content-encoding" && name !== "set-cookie" &&
        name !== "authorization" && !name.startsWith("cf-access-")) response.setHeader(name, value);
  }
  response.writeHead(upstream.status);
  if (!upstream.body || head) { await upstream.body?.cancel(); response.end(); return; }
  const reader = upstream.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > bodyLimit) refuse();
      if (!response.write(part.value)) await once(response, "drain", { signal });
    }
    response.end();
  } finally { await reader.cancel().catch(() => {}); }
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") refuse();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  if (!server.listening) return;
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

/** Explicit local setup only. Both listeners call real HTTPS transports; no
 * selector, proof header or successful rehearsal state is constructed here. */
export async function startDevelopmentRehearsalHttp({ projectId, operatorOrigin, operatorCredentials, ingressCredentials,
  authorized = false, ingressPort = 0, proofPort = 0 }: {
  projectId: string; operatorOrigin: string;
  operatorCredentials(): Promise<HeadersInit>; ingressCredentials(): Promise<HeadersInit>;
  authorized?: boolean; ingressPort?: number; proofPort?: number;
}) {
  if (authorized !== true || projectId !== developmentTarget.projectId ||
      typeof operatorCredentials !== "function" || typeof ingressCredentials !== "function" ||
      typeof operatorOrigin !== "string" || operatorOrigin.length > 2048 ||
      [ingressPort, proofPort].some(port => !Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) ||
      ingressPort !== 0 && ingressPort === proofPort) refuse();
  let operator: ReturnType<typeof createPrivatePairOperatorClient>;
  try { operator = createPrivatePairOperatorClient({ origin: operatorOrigin, credentials: operatorCredentials }); }
  catch { refuse(); }
  const canonicalOrigin = developmentTarget.origin;
  const httpCredential = createRehearsalHttpCredential();
  const handle = (proof: boolean) => (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(504, { "cache-control": "no-store" }).end();
    }, deadlineMs);
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    void (async () => {
      const authority = `127.0.0.1:${request.socket.localPort}`;
      if (request.headers.host !== authority || !acceptRehearsalHttpAuthorization(httpCredential,
        `http://${authority}`, request.headers.authorization)) {
        response.writeHead(403, { "cache-control": "no-store" }).end(); return;
      }
      if (request.method !== "GET" && (proof || request.method !== "HEAD")) {
        response.writeHead(405, { "cache-control": "no-store" }).end(); return;
      }
      const path = requestPath(request, proof);
      let upstream: Response;
      if (proof) {
        const bodyDigest = request.headers["x-rehearsal-expected-sha256"], status = request.headers["x-rehearsal-expected-status"];
        if (typeof bodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(bodyDigest) || typeof status !== "string" || !["200", "308", "410"].includes(status)) refuse();
        upstream = await operator.prove({ path, bodyDigest, status: status === "200" ? 200 : status === "308" ? 308 : 410, signal: controller.signal });
      } else {
        const headers = viewerHeaders(request);
        // Preserve forged viewer proof headers so the real ingress, rather
        // than this bridge, must demonstrate that it strips them.
        new Headers(await ingressCredentials()).forEach((value, name) => headers.set(name, value));
        upstream = await fetch(`${canonicalOrigin}${path}`, { method: request.method, headers,
          redirect: "manual", cache: "no-store", signal: controller.signal });
      }
      await copyResponse(upstream, response, request.method === "HEAD", controller.signal);
    })().catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "cache-control": "no-store" }).end();
    }).finally(() => clearTimeout(timer));
  };
  const ingress = createServer(handle(false)), proof = createServer(handle(true));
  for (const server of [ingress, proof]) { server.headersTimeout = deadlineMs; server.requestTimeout = deadlineMs; }
  try {
    const ingressOrigin = await listen(ingress, ingressPort), proofOrigin = await listen(proof, proofPort);
    bindRehearsalHttpCredential(httpCredential, [ingressOrigin, proofOrigin]);
    return { ingressOrigin, proofOrigin, httpCredential,
      close: async () => { closeRehearsalHttpCredential(httpCredential); await close(ingress); await close(proof); } };
  } catch { closeRehearsalHttpCredential(httpCredential); await close(ingress); await close(proof); refuse(); }
}

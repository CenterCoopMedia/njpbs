import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createCmsReaderBridge } from "../../cms-api/src/cms-reader-bridge";
import { createCmsReaderReplayTransport } from "../../scripts/lib/cms-reader-bridge-install.mjs";
import { readerAdapterEnvironment } from "../../scripts/lib/cms-reader-first-install-cases.mjs";
const require = createRequire(import.meta.url);
export async function nativeReaderHttp(db: any, fixture: any, config: any) {
  const ids = require("../../functions/lib/cms-versioned-reader.js").readerIdentities(fixture.readers);
  const handlers = Object.fromEntries([1, 2].map(version => [version, require("../../functions/cms-reader-mount.js").createCmsReaderMount({
    firestore: db, version, environment: readerAdapterEnvironment(config), authenticate: async () => fixture.actor,
    edge: { readSecret: () => "fixture-edge", logger: { warn() {}, error() {} } } })]));
  let origin: string;
  const redirected: typeof fetch = (url, init) => fetch(`${origin}${new URL(String(url)).pathname}`, init);
  const gateway = createCmsReaderBridge({ projectId: "njpbs-site-dev", readEdgeSecret: () => "fixture-edge", verifyToken: async () => ({ uid: fixture.actor.uid }),
    request: redirected, targets: [1, 2].map(version => ({ version: version as 1 | 2,
      functionsUrl: `https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsReaderV${version}`, gatewayReaderDigest: ids.cmsApi })) });
  const server: Server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks), path = incoming.url!;
      if (path.startsWith("/api/cms/")) {
        const response = await gateway(new Request(`https://dev-api.example.org${path}`, { method: "POST",
          headers: incoming.headers as Record<string, string>, body: rawBody }), { requestId: "33333333-3333-4333-8333-333333333333", clientIp: "203.0.113.9" });
        if (!response) throw new Error("Unknown fixture path");
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
      } else {
        const res = { headersSent: false, code: 200, set(name: string, value: string) { outgoing.setHeader(name, value); return res; },
          status(code: number) { res.code = code; return res; }, json(value: unknown) { res.headersSent = true;
            outgoing.statusCode = res.code; outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify(value)); return res; },
          send(value: any) { res.headersSent = true; outgoing.statusCode = res.code;
            if (!outgoing.hasHeader("content-type")) outgoing.setHeader("content-type", "application/json"); outgoing.end(value); return res; } };
        await handlers[Number(path.at(-1))]({ method: "POST", headers: incoming.headers, rawBody, is: () => true, body: JSON.parse(rawBody.toString()) }, res);
      }
    } catch { outgoing.writeHead(503); outgoing.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return { request: redirected, transport: (targets: any) => createCmsReaderReplayTransport({ projectId: "njpbs-site-dev", targets,
    readStaffToken: async () => "fixture-staff", readEdgeSecret: async () => "fixture-edge", fetchImpl: redirected }),
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

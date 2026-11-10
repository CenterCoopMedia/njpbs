import { createServer } from "node:http";
import type { Firestore } from "firebase-admin/firestore";
import { sealedPair } from "./sealed-public-release-pair";
import { capturedPairInput } from "./captured-public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import { createPrivatePairReader, readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { writePublicReleasePairView, type PairViewOutputInput, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
// Production seals keep HTTPS. Only this network boundary maps synthetic
// HTTPS destinations to local HTTP; native origin guards run unchanged.
const loopbackReaders = new Map<string, string>();
let originalFetch: typeof fetch | undefined;
export async function privateReaderTransport(environment: 'development' | 'production' = 'development') {
  let handler: ((request: Request) => Promise<Response>) | undefined, origin = "", received = 0;
  let authorization = 'Bearer synthetic-qualification-test';
  let transform: ((response: Response) => Promise<Response>) | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      received++;
      if (request.headers.authorization !== authorization) { response.writeHead(401).end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      if (!handler) { response.writeHead(503).end(); return; }
      const read = await handler(new Request(`${origin}${request.url}`, { method: request.method,
        headers: { "content-type": String(request.headers["content-type"] ?? "") }, body: Buffer.concat(chunks) }));
      const result = transform ? await transform(read) : read;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) for await (const chunk of result.body) response.write(chunk);
      response.end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  origin = `http://127.0.0.1:${address.port}`;
  if (environment === 'production') {
    authorization += '-' + address.port;
    const loopback = origin;
    origin = `https://production-reader-${address.port}.example.test`;
    if (!originalFetch) {
      originalFetch = globalThis.fetch;
      const request = originalFetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const target = loopbackReaders.get(url.origin);
        return target ? request(target + url.pathname + url.search, init) : request(input, init);
      };
    }
    loopbackReaders.set(origin, loopback);
  }
  return { origin, credentials: async () => ({ authorization }),
    install(value: (request: Request) => Promise<Response>) { handler = value; },
    get received() { return received; }, setTransform(value: typeof transform) { transform = value; },
    async close() {
      loopbackReaders.delete(origin);
      if (!loopbackReaders.size && originalFetch) { globalThis.fetch = originalFetch; originalFetch = undefined; }
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
export async function privateReaderFixture(firestore: Firestore, store: PairViewStore, outputs: PairViewOutputInput[]) {
  const transport = await privateReaderTransport();
  const { pair, seals } = sealedPair(transport.origin);
  try {
    await firestore.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
    await work.registerPublicReleasePair({ firestore, pair });
    await firestore.doc(readerSealPath(pair)).create(seals);
    const capture = capturedPairInput(pair, { sourceOperationId: "remote-qualification-fixture" });
    async function* inputFiles() { yield* capture.files; }
    const captured = await capturePublicReleasePairInput({ firestore, store, pair, plan: capture.root,
      expectedCursor: capture.cursor, expectedSource: capture.root.source, files: inputFiles() });
    const { taskId } = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
      firestore, transaction, pair, input: { ...capture.taskInput, inputManifestDigest: captured.receipt.inputManifestDigest } }));
    const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId, now: 1000 });
    if (!claim) throw new Error("Missing fixture claim");
    const claimDigest = protocol.publicReleaseDigest(claim.token);
    async function* stream() { yield* outputs; }
    const written = await writePublicReleasePairView({ store, pair, identity: claim.identity, claimDigest,
      cursor: capture.cursor, outputs: stream() });
    await work.settlePublicReleasePairWork({ firestore, pair, taskId, token: claim.token, manifestDigest: written.manifestDigest, now: 1001 });
    const staged = await stagePublicReleasePairView({ firestore, store, pair, identity: claim.identity,
      claimDigest, manifestDigest: written.manifestDigest });
    transport.install(createPrivatePairReader({ firestore, store, pair, installed: seals }));
    return { pair, seals, store, staged: staged.record, captured: captured.receipt,
      selectedView: { identity: claim.identity, claimDigest, manifestDigest: written.manifestDigest, manifestBytes: written.manifestBytes },
      credentials: transport.credentials, get received() { return transport.received; },
      setTransform: transport.setTransform, close: transport.close };
  } catch (error) { await transport.close(); throw error; }
}

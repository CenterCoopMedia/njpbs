import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { capturedPairInput, seedCapturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import { writePublicReleasePairView, type PairViewOutputInput, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { createPrivatePairReader, readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { createPrivatePairReaderClient } from "../../site/scripts/public-release-pair-reader-client";
import { PAIR_READER_CONTRACT, PAIR_READER_PATH, PAIR_READER_BYTES_LIMIT, parseReaderSeals,
  type ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";

let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, bucket: R2Bucket, server: Server, origin: string;
let handler: (request: Request) => Promise<Response>;
let transform: ((response: Response) => Promise<Response>) | undefined;
let received = 0;
let requestLength: string | undefined, requestBytes = 0;
let store: PairViewStore;
const encode = (value: string) => new TextEncoder().encode(value);
const publicHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const output = (path: string, text: string, status: 200 | 308 | 410 = 200): PairViewOutputInput => ({ path, status,
  headers: { ...publicHeaders, ...(status === 308 ? { location: "/posts/current/" } : {}) }, bytes: encode(text) });
const rows = [output("/_astro/main.js", "export const code = 1"),
  output("/_home-sources.json", '{"items":[]}'), output("/about/", "<!doctype html><html>About</html>"),
  output("/posts/current/", "<!doctype html><html>Current</html>"), output("/posts/old/", "", 308), output("/withdrawn/", "", 410)];
async function* outputs(values = rows) { yield* values; }
let pair: ReturnType<typeof releasePair>, seals: ReaderSeals;
let prepared: Awaited<ReturnType<typeof prepare>>;

beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-reader.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "private-reader-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "reader-views" } } } }] });
  bucket = await runtime.getR2Bucket("CONTENT");
  server = createServer((request, response) => {
    void (async () => {
      received++;
      if (request.headers.authorization !== "Bearer synthetic-private-test") { response.writeHead(401).end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      requestLength = request.headers["content-length"];
      requestBytes = body.byteLength;
      const http = new Request(`${origin}${request.url}`, { method: request.method,
        headers: { "content-type": String(request.headers["content-type"] ?? "") }, body });
      const read = await handler(http), result = transform ? await transform(read) : read;
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        for await (const chunk of result.body) response.write(chunk);
      }
      response.end();
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  const objects = await bucket.list(); if (objects.objects.length) await bucket.delete(objects.objects.map(row => row.key));
  store = bucket; transform = undefined; received = 0; requestLength = undefined; requestBytes = 0;
  const base = releasePair();
  const deployment = { schemaVersion: 1 as const, environment: base.environment as "development", service: base.publicWorker.service,
    versionId: base.publicWorker.versionId, commitSha: base.commitSha, origin,
    contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) };
  const capabilities = { schemaVersion: 1 as const, rendererSha: base.commitSha,
    post: { dataFigureVersion: 1 as const, electionResultsVersion: 1 as const, liveBlogVersion: 1 as const },
    page: { dataFigureVersion: 1 as const, electionResultsVersion: 1 as const, dataHubReportingVersion: 1 as const, dataHubCompositionVersion: 1 as const },
    record: { families: ["programs", "events"] as const,
      terminalOwner: { schemaVersion: 1 as const, transport: "public-context-no-build-v1" as const, rendererSha: base.commitSha } } };
  pair = { ...base, readerContractDigest: deployment.contractDigest,
    readerReceiptDigest: protocol.publicReleaseDigest(deployment), capabilityDigest: protocol.publicReleaseDigest(capabilities) };
  seals = { schemaVersion: 1, status: "verified", deployment, capabilities };
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
  await db.doc(readerSealPath(pair)).create(seals);
  prepared = await prepare(); install();
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await runtime?.dispose();
});
function install() { handler = createPrivatePairReader({ firestore: db, store, pair, installed: seals }); }
async function prepare(values = rows) {
  const captured = capturedPairInput(pair, { sourceOperationId: `read-${values.length}` });
  await seedCapturedPairInput(db, pair, captured.scope);
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
    firestore: db, transaction, pair, input: captured.taskInput }));
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId, now: 1000 });
  if (!claim) throw new Error("Missing test claim");
  const claimDigest = protocol.publicReleaseDigest(claim.token);
  const cursor = { baselineDigest: "b".repeat(64), sequence: claim.identity.contextSequence, lastDigest: "c".repeat(64) };
  const written = await writePublicReleasePairView({ store, pair, identity: claim.identity, claimDigest, cursor, outputs: outputs(values) });
  await work.settlePublicReleasePairWork({ firestore: db, pair, taskId, token: claim.token, manifestDigest: written.manifestDigest, now: 1001 });
  const staged = await stagePublicReleasePairView({ firestore: db, store, pair, identity: claim.identity, claimDigest,
    manifestDigest: written.manifestDigest });
  return { identity: claim.identity, claimDigest, manifestDigest: written.manifestDigest, manifestBytes: written.manifestBytes,
    staged: staged.record, taskId };
}
const client = () => createPrivatePairReaderClient({ pair, seals,
  credentials: async () => ({ authorization: "Bearer synthetic-private-test" }) });
const read = (paths = rows.map(row => row.path), changes = {}) => client()({ ...prepared, paths, ...changes });

it("crosses the actual HTTP listener, reads settled R2 bytes in a batch, and grants no selection", async () => {
  const before = (await db.doc("system/publicDeployment").get()).data();
  const result = await read();
  expect(received).toBe(1);
  expect(requestLength).toMatch(/^[0-9]+$/);
  expect(Number(requestLength)).toBe(requestBytes);
  expect(requestBytes).toBeGreaterThan(0);
  expect(result.seals).toEqual(seals);
  expect(result.stagedReadbackDigest).toBe(prepared.staged.readbackDigest);
  expect(result.outputs.map(row => Buffer.from(row.bodyBase64, "base64"))).toEqual(rows.map(row => Buffer.from(row.bytes)));
  expect(result.outputs.map(row => row.status)).toEqual([200, 200, 200, 200, 308, 410]);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).get()).data()!.status).toBe("candidate");
});
it.each(["retired", "billing", "missing-seal", "revoked-seal", "staged", "receipt"])("refuses %s before any object read", async mode => {
  const base = work.publicReleasePairPath(pair.pairId);
  if (mode === "retired") await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
  if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
  if (mode === "missing-seal") await db.doc(readerSealPath(pair)).delete();
  if (mode === "revoked-seal") await db.doc(readerSealPath(pair)).update({ status: "revoked" });
  if (mode === "staged") await db.doc(`${base}/views/${prepared.manifestDigest}`).delete();
  if (mode === "receipt") await db.doc(`${base}/receipts/${prepared.taskId}`).update({ claimDigest: "f".repeat(64) });
  let gets = 0; store = { put: (...args) => bucket.put(...args), get: key => { gets++; return bucket.get(key); } }; install();
  await expect(read()).rejects.toThrow("Private pair reader refused"); expect(gets).toBe(0);
});
it.each(["claim", "source", "input", "manifest", "paths", "missing-route"])("refuses altered %s identity", async mode => {
  const changes = mode === "claim" ? { claimDigest: "e".repeat(64) } : mode === "source" ? { identity: { ...prepared.identity, sourceVersion: 5 } }
    : mode === "input" ? { identity: { ...prepared.identity, inputManifestDigest: "e".repeat(64) } }
    : mode === "manifest" ? { manifestDigest: "e".repeat(64) } : mode === "paths" ? { paths: ["/about/", "/about/"] }
    : { paths: ["/missing/"] };
  await expect(read(undefined, changes)).rejects.toThrow();
});
it("rechecks the live capability seal after body I/O", async () => {
  store = { put: (...args) => bucket.put(...args), get: async key => {
    const object = await bucket.get(key);
    if (key.includes("/objects/")) await db.doc(readerSealPath(pair)).delete();
    return object;
  } }; install();
  await expect(read(["/about/"])).rejects.toThrow();
});
it.each(["root", "page", "body"])("refuses corrupt %s bytes", async mode => {
  const objects = await bucket.list();
  const key = objects.objects.find(row => row.key.includes(mode === "root" ? "/views/" : mode === "page" ? "/pages/" : "/objects/"))!.key;
  const object = await bucket.get(key), bytes = new Uint8Array(await object!.arrayBuffer()); bytes[0] ^= 1;
  await bucket.put(key, bytes, { customMetadata: object!.customMetadata });
  await expect(read()).rejects.toThrow();
});
it.each(["body", "nonce", "seal", "headers", "extra-route", "redirect"])("rejects actual transport %s disagreement", async mode => {
  transform = async response => {
    if (mode === "redirect") return new Response(null, { status: 307, headers: { location: origin } });
    const value = await response.json() as any;
    if (mode === "body") value.outputs[0].bodyBase64 = Buffer.from("wrong actual bytes").toString("base64");
    if (mode === "nonce") value.requestDigest = "f".repeat(64);
    if (mode === "seal") value.seals.capabilities.page.dataHubCompositionVersion = 0;
    if (mode === "headers") value.outputs[0].headers["set-cookie"] = "synthetic";
    if (mode === "extra-route") value.outputs.push(value.outputs[0]);
    return new Response(JSON.stringify(value), { headers: response.headers });
  };
  await expect(read()).rejects.toThrow();
  expect(received).toBe(1);
});
it("does not scan unrequested view bodies and refuses batch byte overflow", async () => {
  const gets: string[] = []; store = { put: (...args) => bucket.put(...args), get: key => { gets.push(key); return bucket.get(key); } }; install();
  await read(["/about/"]);
  expect(gets.filter(key => key.includes("/objects/"))).toHaveLength(1);
  const huge = output("/one.bin", "a"); huge.bytes = new Uint8Array(PAIR_READER_BYTES_LIMIT); huge.headers["content-type"] = "application/octet-stream";
  prepared = await prepare([huge, output("/two/", "extra")]);
  await expect(read(["/one.bin", "/two/"])).rejects.toThrow();
});
it("refuses missing authentication and public method paths", async () => {
  const noAuth = createPrivatePairReaderClient({ pair, seals, credentials: async () => ({}) });
  await expect(noAuth({ ...prepared, paths: ["/about/"] })).rejects.toThrow();
  expect((await handler(new Request(`${origin}${PAIR_READER_PATH}`))).status).toBe(404);
});
it("never accepts a different installed source, terminal owner, or Data Hub seal", () => {
  for (const change of [
    { ...seals, deployment: { ...seals.deployment, versionId: "b".repeat(36) } },
    { ...seals, capabilities: { ...seals.capabilities, record: { ...seals.capabilities.record, terminalOwner: null } } },
    { ...seals, capabilities: { ...seals.capabilities, page: { ...seals.capabilities.page, dataHubReportingVersion: 0 } } },
  ]) expect(() => parseReaderSeals(change, pair)).toThrow();
});
it("bounds stalled credentials and honors pre-abort before any network request", async () => {
  const stopped = new AbortController(); stopped.abort();
  await expect(read(undefined, { signal: stopped.signal })).rejects.toThrow(); expect(received).toBe(0);
  const slow = createPrivatePairReaderClient({ pair, seals, credentials: () => new Promise(() => {}) });
  const cancel = new AbortController(); setTimeout(() => cancel.abort(), 20);
  await expect(slow({ ...prepared, paths: ["/about/"], signal: cancel.signal })).rejects.toThrow();
  expect(received).toBe(0);
});

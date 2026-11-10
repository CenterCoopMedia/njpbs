import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { seedCapturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import legacy from "../../functions/lib/public-deployment.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { pairStorageRpc } from "../../publisher/pair-storage-rpc";
import { publicReleasePairRpcStore } from "../../site/scripts/public-release-pair-storage-rpc";
import { encodePairStorageBatchRequest, parsePairStorageBatchResult, PAIR_STORAGE_BATCH_BODY_LIMIT } from "../../packages/content-core/src/public-release-storage-batch";

const pair = releasePair(), base = work.publicReleasePairPath(pair.pairId), networkFetch = globalThis.fetch;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inputKey = (bytes: Uint8Array) => `release-pair-inputs/v2/${pair.pairId}/objects/${digest(bytes)}.json`;
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket, taskId: string, claimDigest: string;
let gets: string[], puts: string[], reads: string[], requests: Request[];
let read: (path: string) => Promise<Record<string, any> | null>;
let put: (key: string, body: any, options: any) => Promise<any>;
let get: (key: string) => Promise<any>;
const bucket = { get: (key: string) => { gets.push(key); return get(key); },
  put: (key: string, body: any, options: any) => { puts.push(key); return put(key, body, options); } };
const authority = () => ({ pair, read: async (path: string) => { reads.push(path); return read(path); } });
const jsonRequest = (value: unknown, write = false) => {
  const body = JSON.stringify(value);
  return new Request(`http://pair-storage.internal/_batch/v1/${write ? `put/${taskId}/${claimDigest}` : "get"}`, {
    method: "POST", body, headers: { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json" } });
};
function items(count = 4) {
  return Array.from({ length: count }, (_, index) => {
    const body = new TextEncoder().encode(`private batch ${index}`), bodydigest = digest(body);
    return { key: `release-pairs/${pair.pairId}/${taskId}/claims/${claimDigest}/objects/${bodydigest}`, body,
      customMetadata: { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), taskid: taskId, claimdigest: claimDigest, bodydigest } };
  });
}
const writeRequest = (members = items()) => jsonRequest(JSON.parse(encodePairStorageBatchRequest(members, true)), true);
const handle = (request: Request) => pairStorageRpc(request, bucket as any, authority());
const client = () => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request.clone()); const response = await handle(request);
    if (request.method === "POST" && response.ok) expect(response.headers.get("content-encoding")).toBe("identity");
    return response;
  });
  return publicReleasePairRpcStore();
};
beforeAll(async () => {
  db = isolatedFirestore("pair-storage-batch");
  runtime = new Miniflare({ workers: [{ config: { name: "storage-batch", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "storage-batch" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db, networkFetch);
  const objects = await store.list(); if (objects.objects.length) await store.delete(objects.objects.map(object => object.key));
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
  const capture = await seedCapturedPairInput(db, pair);
  ({ taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair, input: capture.taskInput })));
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId });
  claimDigest = protocol.publicReleaseDigest(claim!.token);
  read = async path => (await db.doc(path).get()).data() ?? null;
  put = (key, body, options) => store.put(key, body, options);
  get = key => store.get(key);
  gets = []; puts = []; reads = []; requests = [];
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await runtime?.dispose(); });

it("coalesces four immutable writes with fresh shared guards and a fresh lease before every conditional put", async () => {
  const rpc = client(), members = items();
  const options = (member: typeof members[number]) => ({ onlyIf: { etagDoesNotMatch: "*" }, sha256: member.customMetadata.bodydigest, customMetadata: member.customMetadata });
  await Promise.all(members.map(member => rpc.put(member.key, member.body, options(member))));
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([["POST", `/_batch/v1/put/${taskId}/${claimDigest}`]]);
  // Fresh SDK reads may finish in any order; the batch response still retains
  // its requested order and every exact object must be written once.
  expect([...puts].sort()).toEqual(members.map(member => member.key).sort());
  expect(reads).toHaveLength(8);
  expect(reads.filter(path => path === `${base}/work/${taskId}`)).toHaveLength(5);
  expect(reads.filter(path => path === `${base}/journals/${pair.publisher.journalNamespace}`)).toHaveLength(1);
  await Promise.all(members.map(member => rpc.put(member.key, member.body, options(member))));
  expect(reads).toHaveLength(16); // A new request never reuses admission.
  expect(requests).toHaveLength(2); // Existing objects remain 412/idempotent.
  const objects = await Promise.all(members.map(member => store.get(member.key)));
  expect(await Promise.all(objects.map(object => object!.arrayBuffer().then(body => new Uint8Array(body))))).toEqual(members.map(member => member.body));
});
it("returns independent actual small, empty and missing objects; disabled billing refuses the next request", async () => {
  const bodies = [new Uint8Array([0, 1, 255]), new Uint8Array()], keys = [...bodies.map(inputKey), inputKey(new Uint8Array([3]))];
  await Promise.all(bodies.map((body, index) => store.put(keys[index], body, { customMetadata: { fixture: "actual" } })));
  const rpc = client(), values = await Promise.all(keys.map(key => rpc.get(key)));
  expect(requests).toHaveLength(1); expect(reads).toHaveLength(2);
  expect(new Uint8Array(await new Response(values[0]!.body).arrayBuffer())).toEqual(bodies[0]);
  expect(await values[1]!.body.getReader().read()).toEqual({ value: undefined, done: true }); expect(values[2]).toBe(null);
  await db.doc("system/billing").set({ disabled: true }); const count = gets.length;
  expect((await Promise.allSettled(keys.map(key => rpc.get(key)))).every(result => result.status === "rejected")).toBe(true);
  expect(reads).toHaveLength(4); expect(gets).toHaveLength(count);
});
it("keeps the original single path for large bodies and obtains a fresh guarded GET for a large batch result", async () => {
  const members = items(2), large = new Uint8Array(PAIR_STORAGE_BATCH_BODY_LIMIT + 1); large[0] = 42;
  const bodydigest = digest(large), key = `release-pairs/${pair.pairId}/${taskId}/claims/${claimDigest}/objects/${bodydigest}`;
  const rpc = client();
  await rpc.put(key, large, { onlyIf: { etagDoesNotMatch: "*" }, sha256: bodydigest, customMetadata: { ...members[0].customMetadata, bodydigest } });
  await store.put(members[1].key, members[1].body, { customMetadata: members[1].customMetadata });
  requests.length = 0; reads.length = 0;
  const values = await Promise.all([rpc.get(key), rpc.get(members[1].key)]);
  expect(requests.map(request => request.method)).toEqual(["POST", "GET"]); expect(reads).toHaveLength(4);
  expect(new Uint8Array(await new Response(values[0]!.body).arrayBuffer())).toEqual(large);
  await values[1]!.body.cancel();
});
it.each(["duplicate", "other-pair", "other-claim", "extra", "digest", "metadata", "oversize", "short", "host", "query"])(
  "refuses the entire malformed %s batch before any write", async fault => {
    const members = items(2), value = JSON.parse(encodePairStorageBatchRequest(members, true));
    if (fault === "duplicate") value.items[1].key = value.items[0].key;
    if (fault === "other-pair") value.items[1].key = value.items[1].key.replace(pair.pairId, "other-pair");
    if (fault === "other-claim") value.items[1].key = value.items[1].key.replace(claimDigest, "f".repeat(64));
    if (fault === "extra") value.items[1].authorized = true;
    if (fault === "digest") value.items[1].bodyBase64 = Buffer.from("corrupt").toString("base64");
    if (fault === "metadata") value.items[1].customMetadata.pairdigest = "f".repeat(64);
    if (fault === "oversize") value.items[1].bodyBase64 = Buffer.alloc(PAIR_STORAGE_BATCH_BODY_LIMIT + 1).toString("base64");
    const original = jsonRequest(value, true), headers = new Headers(original.headers);
    if (fault === "short") headers.set("content-length", String(Number(headers.get("content-length")) + 1));
    const url = fault === "host" ? original.url.replace("pair-storage.internal", "public.example") : fault === "query" ? original.url + "?allowed=true" : original.url;
    const request = new Request(url, { method: "POST", headers, body: await original.text() });
    expect((await handle(request)).status).toBe(403); expect(puts).toEqual([]);
  });
it.each(["runtime", "billing", "task", "journal", "replacement"])("freshly refuses %s authority on a later batch", async fault => {
  expect((await handle(writeRequest())).status).toBe(200); const count = puts.length;
  if (fault === "runtime") await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
  if (fault === "billing") await db.doc("system/billing").set({ disabled: true });
  if (fault === "task") await db.doc(`${base}/work/${taskId}`).update({ leaseUntil: 1 });
  if (fault === "journal") await db.doc(`${base}/journals/${pair.publisher.journalNamespace}`).update({ job: null });
  if (fault === "replacement") await db.doc(`${base}/work/${taskId}`).update({ claimDigest: "f".repeat(64) });
  expect((await handle(writeRequest())).status).toBe(fault === "billing" ? 503 : 403); expect(puts).toHaveLength(count);
});
it("rereads the lease after a slowly arriving body, before any put", async () => {
  const original = writeRequest(), bytes = new Uint8Array(await original.arrayBuffer());
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    await db.doc(`${base}/work/${taskId}`).update({ leaseUntil: 1 }); controller.enqueue(bytes); controller.close();
  } }, { highWaterMark: 0 });
  const response = await handle(new Request(original.url, { method: "POST", headers: original.headers, body, duplex: "half" } as RequestInit));
  const results = parsePairStorageBatchResult(await response.json(), items().map(item => item.key), true);
  expect(results.map(result => result.status)).toEqual([403, 403, 403, 403]); expect(puts).toEqual([]);
});
it("rereads each member's lease even when an earlier member has already been written", async () => {
  let release!: () => void, taskReads = 0; const changed = new Promise<void>(resolve => { release = resolve; });
  read = async path => {
    if (path === `${base}/work/${taskId}` && ++taskReads > 2) await changed;
    return (await db.doc(path).get()).data() ?? null;
  };
  put = async (key, body, options) => {
    try { const result = await store.put(key, body, options); await db.doc(`${base}/work/${taskId}`).update({ leaseUntil: 1 }); return result; }
    finally { release(); }
  };
  const results = parsePairStorageBatchResult(await (await handle(writeRequest())).json(), items().map(item => item.key), true);
  expect(results.map(result => result.status).sort()).toEqual([201, 403, 403, 403]); expect(puts).toHaveLength(1); expect(taskReads).toBe(5);
});
it("drains other native operations before reporting one interrupted write", async () => {
  const members = items(); let release!: () => void; const failed = new Promise<void>(resolve => { release = resolve; });
  const completed: string[] = [];
  put = async (key, body, options) => {
    if (key === members[0].key) { release(); throw new Error("local transport interruption"); }
    await failed; const result = await store.put(key, body, options); completed.push(key); return result;
  };
  expect((await handle(writeRequest(members))).status).toBe(503); expect(completed).toHaveLength(3); expect(puts).toHaveLength(4);
});
it("snapshots queued caller bytes, preserves duplicate streams and does not batch across claims", async () => {
  const rpc = client(), members = items(2), original = new Uint8Array(members[0].body);
  const writing = members.map(member => rpc.put(member.key, member.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: member.customMetadata.bodydigest, customMetadata: member.customMetadata }));
  members[0].body.fill(255); members[0].customMetadata.bodydigest = "f".repeat(64);
  await Promise.all(writing);
  expect(new Uint8Array(await (await store.get(members[0].key))!.arrayBuffer())).toEqual(original);
  requests.length = 0;
  const values = await Promise.all([rpc.get(members[0].key), rpc.get(members[0].key)]);
  expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
  expect(await Promise.all(values.map(value => new Response(value!.body).arrayBuffer().then(body => new Uint8Array(body))))).toEqual([original, original]);
  requests.length = 0;
  const other = items(2)[1]; other.key = other.key.replace(claimDigest, "f".repeat(64));
  await Promise.allSettled([rpc.put(items(2)[0].key, original, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest(original), customMetadata: items(2)[0].customMetadata }),
    rpc.put(other.key, other.body, { onlyIf: { etagDoesNotMatch: "*" }, sha256: other.customMetadata.bodydigest, customMetadata: other.customMetadata })]);
  expect(requests.map(request => request.method)).toEqual(["PUT", "PUT"]);
});

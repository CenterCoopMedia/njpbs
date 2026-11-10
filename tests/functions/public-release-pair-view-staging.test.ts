import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import { writePublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { capturedPairInput, seedCapturedPairInput } from "../helpers/captured-public-release-pair-input.js";

const pair = releasePair();
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
const base = work.publicReleasePairPath(pair.pairId);
const captured = capturedPairInput(pair, { sourceOperationId: "stage-operation" });
const input = captured.taskInput;
const cursor = { baselineDigest: "b".repeat(64), sequence: 12, lastDigest: "c".repeat(64) };
const html = new TextEncoder().encode("<!doctype html><html>Verified private output</html>");
async function* outputs() { yield { path: "/about/", status: 200 as const,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, bytes: html }; }
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-view-staging.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-stage-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "stage-views" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  const objects = await store.list();
  if (objects.objects.length) await store.delete(objects.objects.map(object => object.key));
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
});
afterAll(async () => { await runtime?.dispose(); });

async function prepare(complete = true) {
  await seedCapturedPairInput(db, pair, captured.scope);
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
    firestore: db, transaction, pair, input }));
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId, now: 1000 });
  const claimDigest = protocol.publicReleaseDigest(claim!.token);
  const written = await writePublicReleasePairView({ store, pair, identity: claim!.identity, claimDigest, cursor, outputs: outputs() });
  if (complete) await work.settlePublicReleasePairWork({ firestore: db, pair, taskId, token: claim!.token,
    manifestDigest: written.manifestDigest, now: 1001 });
  return { claim: claim!, claimDigest, written, taskId };
}
const stage = (prepared: Awaited<ReturnType<typeof prepare>>, changes = {}) => stagePublicReleasePairView({
  firestore: db, store, pair, identity: prepared.claim.identity, claimDigest: prepared.claimDigest,
  manifestDigest: prepared.written.manifestDigest, ...changes });

it("stages actual byte readback only for the original completed receipt and retries idempotently", async () => {
  const before = (await db.doc("system/publicDeployment").get()).data();
  const prepared = await prepare();
  const first = await stage(prepared), retry = await stage(prepared);
  expect(first.idempotent).toBe(false);
  expect(retry).toEqual({ idempotent: true, record: first.record });
  expect(first.record.status).toBe("staged");
  expect(first.record.outputCount).toBe(1);
  expect(first.record.outputBytes).toBe(html.byteLength);
  expect(first.record.readbackDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(first.record.claimDigest).toBe(prepared.claimDigest);
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.doc(`${base}/controls/runtime`).get()).data()!.status).toBe("candidate");
});

it.each(["uncompleted", "retired", "disabled", "receipt-changed", "work-changed"])(
  "refuses %s authority before any R2 read", async mode => {
    const prepared = await prepare(mode !== "uncompleted");
    if (mode === "retired") await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
    if (mode === "disabled") await db.doc("system/billing").set({ disabled: true });
    if (mode === "receipt-changed") await db.doc(`${base}/receipts/${prepared.taskId}`).update({ claimDigest: "f".repeat(64) });
    if (mode === "work-changed") await db.doc(`${base}/work/${prepared.taskId}`).update({ receiptDigest: "f".repeat(64) });
    let reads = 0;
    const observed: PairViewStore = { put: (...args) => store.put(...args), get: key => { reads++; return store.get(key); } };
    await expect(stage(prepared, { store: observed })).rejects.toThrow();
    expect(reads).toBe(0);
    expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
  });

it("refuses an expired attempt after a replacement completes, without relabeling its view", async () => {
  const old = await prepare(false);
  const next = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: old.taskId, now: 61_001 });
  const claimDigest = protocol.publicReleaseDigest(next!.token);
  const written = await writePublicReleasePairView({ store, pair, identity: next!.identity, claimDigest, cursor, outputs: outputs() });
  await work.settlePublicReleasePairWork({ firestore: db, pair, taskId: old.taskId, token: next!.token,
    manifestDigest: written.manifestDigest, now: 61_002 });
  await expect(stage(old)).rejects.toThrow();
  const current = await stage({ ...old, claim: next!, claimDigest, written });
  expect(current.record.claimDigest).toBe(claimDigest);
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
});

it("refuses body corruption even on a previously staged root", async () => {
  const prepared = await prepare();
  await stage(prepared);
  const listing = await store.list();
  const key = listing.objects.find(object => object.key.includes("/objects/"))!.key;
  const object = await store.get(key), bytes = new Uint8Array(await object!.arrayBuffer()); bytes[0] ^= 1;
  await store.put(key, bytes, { customMetadata: object!.customMetadata });
  await expect(stage(prepared)).rejects.toThrow();
  expect((await db.collection(`${base}/views`).get()).size).toBe(1);
});

it.each(["disabled", "retired"])("rechecks %s authority after the actual byte proof", async mode => {
  const prepared = await prepare();
  let changed = false;
  const observed: PairViewStore = { put: (...args) => store.put(...args), get: async key => {
    const object = await store.get(key);
    if (!changed && key.includes("/objects/")) {
      changed = true;
      if (mode === "disabled") await db.doc("system/billing").set({ disabled: true });
      else await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
    }
    return object;
  } };
  await expect(stage(prepared, { store: observed })).rejects.toThrow();
  expect(changed).toBe(true);
  expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
});

it("refuses a conflicting durable staging record and an aborted request", async () => {
  const prepared = await prepare();
  const controller = new AbortController(); controller.abort();
  await expect(stage(prepared, { signal: controller.signal })).rejects.toThrow();
  expect((await db.collection(`${base}/views`).get()).empty).toBe(true);
  await stage(prepared);
  await db.doc(`${base}/views/${prepared.written.manifestDigest}`).update({ outputCount: 2 });
  await expect(stage(prepared)).rejects.toThrow();
});

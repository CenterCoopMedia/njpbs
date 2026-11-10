import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, pairReference, releaseSelector } from "../helpers/private-public-release-pair.js";
import { capturedPairInput, capturedSnapshotDigest } from "../helpers/captured-public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import legacy from "../../functions/lib/public-deployment.js";
import { capturePublicReleasePairInput, openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { withPublicReleasePairVerifiedReads } from "../../site/scripts/public-release-pair-verified-read";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";

const pair = releasePair(), nextPair = releasePair("b", "b".repeat(40));
const base = work.publicReleasePairPath(pair.pairId);
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
const fixture = () => capturedPairInput(pair, { sourceOperationId: "input-operation" });
type Fixture = ReturnType<typeof fixture>;
async function* stream(files: Fixture["files"]) { for (const file of files) yield { name: file.name, bytes: file.bytes }; }
const capture = (value: Fixture, changes = {}) => capturePublicReleasePairInput({ firestore: db, store, pair, plan: value.root,
  expectedSource: value.root.source, expectedCursor: value.cursor, files: stream(value.files), ...changes });
const enqueue = (value: Fixture, changes = {}) => db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
  firestore: db, transaction, pair, input: { ...value.taskInput, ...changes } }));
const identity = (value: Fixture) => ({ schemaVersion: 2 as const, pair: pairReference(pair), ...value.taskInput });
const open = (value: Fixture, changes = {}) => openPublicReleasePairInput({ firestore: db, store, pair,
  identity: identity(value), expectedSource: value.root.source, expectedCursor: value.cursor, ...changes });

beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-input.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-input-test", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-inputs" } } } }] });
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

function expandedFixture() {
  const value = fixture(), original = value.files[0].bytes;
  for (let index = 0; index < 4; index++) value.files.push({ name: `extra/${index}.json`,
    bytes: new Uint8Array([...original, ...Array(index + 1).fill(10)]), dependencies: [] });
  value.root.files = value.files.map(file => {
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    return { name: file.name, digest, bytes: file.bytes.length,
      objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${digest}.json`, dependencies: file.dependencies };
  }).sort((a, b) => a.name < b.name ? -1 : 1);
  value.root.entryFiles = value.root.files.map(file => file.name);
  return value;
}

it("bounds real H put/readback work to four and withholds the final root until every readback finishes", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0, roots = 0;
  const observed: PairViewStore = { async put(key, bytes, options) {
    if (key.includes("/manifests/")) roots++; return store.put(key, bytes, options);
  }, async get(key) {
    const object = await store.get(key);
    if (key.includes("/objects/")) { reads++; if (reads === 4) entered(); await gate; }
    return object;
  } };
  const result = capture(expandedFixture(), { store: observed });
  try {
    await Promise.race([ready, result.then(() => { throw new Error("Capture finished before its readback barrier"); })]);
    expect(reads).toBe(4); expect(roots).toBe(0);
    release(); const captured = await result;
    expect(reads).toBe(6); expect(roots).toBe(1); expect(captured.receipt.fileCount).toBe(6);
  } finally { release(); await result.catch(() => {}); }
});

it("drains an actual failed H batch without later writes or a captured root", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let reads = 0, writes = 0, roots = 0, settled = false;
  const observed: PairViewStore = { async put(key, bytes, options) {
    if (key.includes("/manifests/")) roots++; else writes++;
    return store.put(key, bytes, options);
  }, async get(key) {
    const object = await store.get(key);
    if (key.includes("/objects/")) {
      reads++; if (reads === 4) entered();
      if (reads === 1) { await object?.body.cancel(); throw new Error("original transport failure"); }
      await gate;
    }
    return object;
  } };
  const result = capture(expandedFixture(), { store: observed });
  const failure = result.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await Promise.race([ready, failure.then(error => { throw error ?? new Error("Capture finished before its readback barrier"); })]);
    expect(settled).toBe(false); expect(writes).toBe(4); expect(roots).toBe(0);
    release(); expect(await failure).toMatchObject({ message: "original transport failure" });
    expect(writes).toBe(4); expect(roots).toBe(0);
  } finally { release(); await result.catch(() => {}); }
});

it("reuses actual verified R2 H bytes only inside one original task, with defensive copies", async () => {
  const value = fixture(); await capture(value);
  const selected = value.root.files.find(file => file.name === "snapshot.json")!;
  let reads = 0;
  const measured: PairViewStore = { get: key => { if (key === selected.objectKey) reads++; return store.get(key); },
    put: (key, bytes, options) => store.put(key, bytes, options) };
  await withPublicReleasePairVerifiedReads(measured, async scoped => {
    const frozen = await open(value, { store: scoped });
    const first = await frozen.readFile("snapshot.json"); first[0] ^= 1;
    expect(await frozen.readFile("snapshot.json")).toEqual(value.files.find(file => file.name === "snapshot.json")!.bytes);
    expect(reads).toBe(1);
  });
  await withPublicReleasePairVerifiedReads(measured, async scoped => {
    const frozen = await open(value, { store: scoped }); await frozen.readFile("snapshot.json");
  });
  expect(reads).toBe(2);
});

it("keeps the original H byte-failure owner and retries a rejected read freshly within the task", async () => {
  const value = fixture(); await capture(value);
  const selected = value.root.files.find(file => file.name === "snapshot.json")!, original = value.files.find(file => file.name === "snapshot.json")!.bytes;
  const metadata = (await store.head(selected.objectKey))!.customMetadata;
  const corrupt = new Uint8Array(original); corrupt[0] ^= 1;
  await store.put(selected.objectKey, corrupt, { customMetadata: metadata });
  await withPublicReleasePairVerifiedReads(store, async scoped => {
    const frozen = await open(value, { store: scoped });
    await expect(frozen.readFile("snapshot.json")).rejects.toMatchObject({ code: "input-unavailable" });
    await store.put(selected.objectKey, original, { customMetadata: metadata });
    expect(await frozen.readFile("snapshot.json")).toEqual(original);
  });
});

it("captures real source bytes and readback before enqueue, keeping the original snapshot seal", async () => {
  const value = fixture();
  await expect(enqueue(value)).rejects.toThrow();
  expect((await db.collection(`${base}/work`).get()).empty).toBe(true);
  const captured = await capture(value);
  // Expected values were independently hashed from captured source/manifest
  // fixture bytes before calling the new capture code.
  expect(captured.receipt.inputManifestDigest).toBe(value.inputManifestDigest);
  expect(captured.receipt.manifestBytes).toBe(value.rootBytes.byteLength);
  expect(captured.receipt.scope.snapshotDigest).toBe(capturedSnapshotDigest);
  expect(captured.receipt.scope.snapshotDigest).not.toBe(captured.receipt.inputManifestDigest);
  const raw = new Uint8Array(await (await store.get(value.receipt.manifestKey))!.arrayBuffer());
  expect(raw).toEqual(value.rootBytes);
  expect(createHash("sha256").update(raw).digest("hex")).toBe(value.inputManifestDigest);
  expect((await db.collection(`${base}/work`).get()).empty).toBe(true);
  const queued = await enqueue(value);
  expect(queued.idempotent).toBe(false);
  const claimed = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId: queued.taskId, now: 1000 });
  expect(claimed!.identity.snapshotDigest).toBe(capturedSnapshotDigest);
  expect(claimed!.identity.inputManifestDigest).toBe(value.inputManifestDigest);
  const frozen = await open(value);
  expect(await frozen.readFile("snapshot.json")).toEqual(value.files.find(file => file.name === "snapshot.json")!.bytes);
  for (const file of value.files) expect(new TextDecoder().decode(file.bytes)).not.toContain("Private working title");
});

it("freezes one input per scope and retries independently of file traversal order", async () => {
  const value = fixture();
  const first = await capture(value);
  const before = await store.head(first.receipt.manifestKey);
  const retry = await capture(value, { files: stream([...value.files].reverse()) });
  expect(retry.idempotent).toBe(true);
  expect(retry.receipt).toEqual(first.receipt);
  expect((await store.head(first.receipt.manifestKey))!.etag).toBe(before!.etag);
  expect((await db.collection(`${base}/inputs`).get()).size).toBe(1);
  expect((await db.collection(`${base}/inputScopes`).get()).size).toBe(1);
  const reordered = { files: value.root.files, entryFiles: value.root.entryFiles, snapshotFile: value.root.snapshotFile,
    cursor: { lastDigest: value.cursor.lastDigest, sequence: value.cursor.sequence, baselineDigest: value.cursor.baselineDigest },
    scope: { contextSequence: value.scope.contextSequence, snapshotDigest: value.scope.snapshotDigest,
      sourceVersion: value.scope.sourceVersion, sourceOperationId: value.scope.sourceOperationId, kind: value.scope.kind },
    source: { id: value.root.source.id, kind: value.root.source.kind }, pairDigest: value.root.pairDigest,
    kind: "pair-render-input", schemaVersion: 2 };
  expect((await capture(value, { plan: reordered })).receipt.inputManifestDigest).toBe(value.inputManifestDigest);
});

it("refuses a different input root for an already frozen original scope", async () => {
  const value = fixture();
  await capture(value);
  // Different actual captured bytes (equivalent JSON with whitespace), not a
  // digest obtained from the new capture implementation.
  const context = value.files.find(file => file.name === "context.json")!;
  const changedBytes = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(context.bytes)), null, 2));
  const changedDigest = createHash("sha256").update(changedBytes).digest("hex");
  const plan = { ...value.root, files: value.root.files.map(file => file.name === context.name
    ? { ...file, digest: changedDigest, bytes: changedBytes.byteLength,
      objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${changedDigest}.json` } : file) };
  let reads = 0, writes = 0;
  const observed: PairViewStore = { get: key => { reads++; return store.get(key); },
    put: (...args) => { writes++; return store.put(...args); } };
  await expect(capture(value, { plan, store: observed, files: stream(value.files.map(file => file.name === context.name
    ? { ...file, bytes: changedBytes } : file)) })).rejects.toThrow();
  expect(reads).toBe(0); expect(writes).toBe(0);
  expect((await db.collection(`${base}/inputs`).get()).size).toBe(1);
  expect((await enqueue(value)).taskId).toMatch(/^[a-f0-9]{64}$/);
});

it("refuses the wrong pair or original source before capturing any bytes", async () => {
  const value = fixture();
  await work.registerPublicReleasePair({ firestore: db, pair: nextPair });
  await expect(capture(value, { pair: nextPair })).rejects.toThrow();
  await expect(capture(value, { expectedSource: { kind: "post", id: "other-post" } })).rejects.toThrow();
  expect((await store.list()).objects).toHaveLength(0);
  expect((await db.collection(`${base}/inputs`).get()).empty).toBe(true);
});

it.each(["baselineDigest", "sequence", "lastDigest"])("refuses a wrong %s cursor component", async component => {
  const value = fixture();
  const expectedCursor = { ...value.cursor, [component]: component === "sequence" ? 13 : "f".repeat(64) };
  await expect(capture(value, { expectedCursor })).rejects.toThrow();
  expect((await store.list()).objects).toHaveLength(0);
  expect((await db.collection(`${base}/inputs`).get()).empty).toBe(true);
});

it("refuses a referenced blob missing from the inventory and a body missing from the stream", async () => {
  const value = fixture();
  const missingInventory = { ...value.root, files: value.root.files.filter(file => file.name !== "context.json") };
  await expect(capture(value, { plan: missingInventory })).rejects.toThrow();
  expect((await store.list()).objects).toHaveLength(0);
  await expect(capture(value, { files: stream(value.files.filter(file => file.name !== "context.json")) })).rejects.toThrow();
  expect(await store.head(value.receipt.manifestKey)).toBeNull();
  expect((await db.collection(`${base}/inputs`).get()).empty).toBe(true);
  await expect(enqueue(value)).rejects.toThrow();
  expect((await capture(value)).receipt.inputManifestDigest).toBe(value.inputManifestDigest);
});

it("rejects missing or changed task input digests and a missing scope receipt", async () => {
  const value = fixture();
  await capture(value);
  await expect(db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({
    firestore: db, transaction, pair, input: value.scope }))).rejects.toThrow();
  await expect(enqueue(value, { inputManifestDigest: "0".repeat(64) })).rejects.toThrow();
  const slots = await db.collection(`${base}/inputScopes`).get();
  await slots.docs[0].ref.delete();
  await expect(enqueue(value)).rejects.toThrow();
  expect((await db.collection(`${base}/work`).get()).empty).toBe(true);
});

it("never replaces corrupt stored inputs or falls back to a newer mutable document", async () => {
  const value = fixture();
  await capture(value); await enqueue(value);
  await db.doc(`cmsPosts/${value.root.source.id}`).set({ published: { sourceVersion: 99, title: "Different latest content" } });
  const frozen = await open(value);
  const snapshot = value.root.files.find(file => file.name === "snapshot.json")!;
  expect(await frozen.readFile(snapshot.name)).toEqual(value.files.find(file => file.name === snapshot.name)!.bytes);
  const object = await store.get(snapshot.objectKey), damaged = new Uint8Array(await object!.arrayBuffer()); damaged[0] ^= 1;
  await store.put(snapshot.objectKey, damaged, { customMetadata: object!.customMetadata });
  const damagedHead = await store.head(snapshot.objectKey);
  await expect(frozen.readFile(snapshot.name)).rejects.toThrow();
  await expect(capture(value)).rejects.toThrow();
  expect((await store.head(snapshot.objectKey))!.etag).toBe(damagedHead!.etag);
  await store.delete(snapshot.objectKey);
  await expect(frozen.readFile(snapshot.name)).rejects.toThrow();
  expect((await db.doc(`cmsPosts/${value.root.source.id}`).get()).data()!.published.sourceVersion).toBe(99);
});

it.each(["disabled", "retired"])("rechecks %s authority after complete storage readback", async mode => {
  const value = fixture();
  let changed = false;
  const observed: PairViewStore = { put: (...args) => store.put(...args), get: async key => {
    const object = await store.get(key);
    if (!changed && key === value.receipt.manifestKey) {
      changed = true;
      if (mode === "disabled") await db.doc("system/billing").set({ disabled: true });
      else await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
    }
    return object;
  } };
  await expect(capture(value, { store: observed })).rejects.toThrow();
  expect(changed).toBe(true);
  expect((await db.collection(`${base}/inputs`).get()).empty).toBe(true);
  expect((await db.collection(`${base}/inputScopes`).get()).empty).toBe(true);
});

it("repairs only the original frozen receipt for retained accepted work after a switch", async () => {
  await work.registerPublicReleasePair({ firestore: db, pair: nextPair });
  for (const target of [pair, nextPair]) await db.doc(`${work.publicReleasePairPath(target.pairId)}/controls/runtime`).update({ status: "retained" });
  const oldSelector = releaseSelector();
  await db.doc("system/publicDeployment").set(oldSelector);
  const value = capturedPairInput(pair, { kind: "accepted", sourceOperationId: "accepted-operation" });
  await capture(value); const queued = await enqueue(value);
  const switched = { ...oldSelector, epoch: 2, activeGeneration: 8, lastReservedGeneration: 8, newestEligibleGeneration: 8,
    selectedPair: oldSelector.recoveryPair, recoveryPair: oldSelector.selectedPair, activeCommitSha: nextPair.commitSha,
    contentHead: { ...oldSelector.contentHead, pairId: nextPair.pairId } };
  await db.doc("system/publicDeployment").set(switched);
  await db.doc(`${base}/inputs/${value.inputManifestDigest}`).delete();
  await capture(value);
  expect((await enqueue(value)).taskId).toBe(queued.taskId);
  expect((await db.collection(`${base}/work`).get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(switched);
  const unaccepted = capturedPairInput(pair, { kind: "accepted", sourceOperationId: "not-accepted-before-switch" });
  await expect(capture(unaccepted)).rejects.toThrow();
});

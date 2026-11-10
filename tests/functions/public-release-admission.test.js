import { beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import { seedCapturedPairInput, capturedSnapshotDigest } from "../helpers/captured-public-release-pair-input.js";
import admissions from "../../functions/lib/public-release-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import switches from "../../functions/lib/public-release-switch.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { bumpPublicContextRevision } from "../../functions/lib/public-context-revision.js";
const document = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
const contract = { schemaVersion: 2, families: ["posts", "settings", "context"], features: [] };
const change = { kind: "post", id: document.id, action: "publish", sourceVersion: document.published.sourceVersion, snapshot: document.published };
const source = admissions.publicationSource(change);
let db;
beforeAll(() => { db = isolatedFirestore("public-release-admission.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
const state = async path => (await db.doc(path).get()).data();
async function seed() {
  const seeded = await seedSwitch(db, { admittedContract: contract });
  await db.doc(`${admissions.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admissions.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  for (const pair of [seeded.old, seeded.next]) await db.doc(`${work.publicReleasePairPath(pair.pairId)}/journals/${pair.publisher.journalNamespace}`)
    .set({ schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null });
  return seeded;
}
const prepare = (transaction, operationId = "original-operation", overrides = {}) => admissions.preparePairPublicationInTransaction({
  firestore: db, transaction, operationId, source, change, contextRevision: 13, ...overrides });
const accept = (operationId = "original-operation") => db.runTransaction(async transaction => {
  const prepared = await prepare(transaction, operationId);
  if (!prepared.idempotent) {
    prepared.write(); transaction.set(db.doc(`cmsPosts/${document.id}`), document); bumpPublicContextRevision(transaction, db);
  }
  return prepared.admission;
});
it("admits through the actual stored Timestamp codec without broadening selector wire parsing", async () => {
  const { selector } = await seed(), updatedAt = Timestamp.fromMillis(1_793_188_800_000);
  await db.doc("system/publicDeployment").update({ updatedAt });
  expect(() => protocol.parsePublicReleaseSelector({ ...selector, updatedAt })).toThrow();
  const accepted = await accept();
  expect(accepted.pair).toEqual(selector.selectedPair);
  expect(accepted.epoch).toBe(selector.epoch);
  expect((await db.doc("system/publicDeployment").get()).data().updatedAt).toEqual(updatedAt);
  expect((await db.runTransaction(transaction => prepare(transaction))).idempotent).toBe(true);
});
const apply = attempt => switches.applyPublicReleaseSwitch({ firestore: db, attempt, qualificationReadOwner: fixtureReadOwner,
  assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
it("commits original pair admission, queue and outbox with source/context; creates no precaptured task", async () => {
  const { old } = await seed(); const admitted = await accept();
  expect(admitted).toMatchObject({ operationId: "original-operation", pair: { pairId: old.pairId }, epoch: 1, changeSequence: 1, contextRevision: 13 });
  expect(await state(`cmsPosts/${document.id}`)).toEqual(document);
  expect(await state("system/publicReleaseChanges/entries/0000000000000001")).toMatchObject({ operationId: admitted.operationId, pair: admitted.pair });
  expect(await state(`system/publicReleaseChanges/captures/${admitted.operationId}`)).toMatchObject({ status: "pending" });
  expect(await state(`cmsPublishQueue/${admitted.operationId}`)).toMatchObject({ transport: admissions.TRANSPORT, execution: null, status: "pending" });
  expect((await db.collection(`${work.publicReleasePairPath(old.pairId)}/work`).get()).empty).toBe(true);
  expect(await state(admissions.ADMISSIONS)).toMatchObject({ sequence: 1, pendingCount: 1, pendingDigest: protocol.publicReleaseDigest(admitted) });
});
it("seals numeric-key snapshots with the producer's actual JSON bytes so later H capture keeps the same source scope", async () => {
  await seed();
  const snapshot = { sourceVersion: 1, values: { 2: "two", 10: "ten" } };
  const dependency = { kind: "provider", id: "external", action: "dependency", sourceVersion: 1, snapshot };
  const expected = createHash("sha256").update('{"sourceVersion":1,"values":{"2":"two","10":"ten"}}').digest("hex");
  const source = admissions.publicationSource(dependency);
  expect(source.snapshotDigest).toBe(expected);
  await db.runTransaction(async transaction => {
    const prepared = await prepare(transaction, "numeric-context", { source, change: dependency }); prepared.write();
    bumpPublicContextRevision(transaction, db);
  });
  expect(await state("system/publicReleaseChanges/entries/0000000000000001")).toMatchObject({ changes: [{ snapshotDigest: expected }] });
});
it("rolls back the entire acceptance if the source transaction aborts", async () => {
  await seed();
  await expect(db.runTransaction(async transaction => { const result = await prepare(transaction); result.write(); throw new Error("source-version-conflict"); })).rejects.toThrow();
  expect((await db.collection(`${admissions.ADMISSIONS}/operations`).get()).empty).toBe(true);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});
it.each(["paused", "deselected", "pins", "billing"])("accepts an owned withdrawal during %s without new work admission", async mode => {
  await seed(); await accept();
  if (mode === "paused") await db.doc("system/noBuildPostAdmission").update({ enabled: false });
  if (mode === "deselected") await db.doc("system/noBuildPostAdmission").update({ families: {} });
  if (mode === "pins") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
  const removal = { ...change, action: "withdraw" };
  await db.runTransaction(async transaction => {
    const result = await prepare(transaction, "withdraw-operation", { source: admissions.publicationSource(removal), change: removal, contextRevision: 14 });
    result.write(); transaction.set(db.doc(`cmsPosts/${document.id}`), { ...document, publiclyVisible: false });
    bumpPublicContextRevision(transaction, db, { withdrawal: true });
  });
  expect(await state(`cmsPosts/${document.id}`)).toMatchObject({ publiclyVisible: false });
  expect(await state("cmsPublishQueue/withdraw-operation")).toMatchObject({ transport: admissions.TRANSPORT, status: "pending" });
});
it("serializes a real publish/switch race so acceptance commits wholly at one selected pair", async () => {
  const { attempt } = await seed(); await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
  const [publication] = await Promise.allSettled([accept(), apply(attempt)]);
  expect(publication.status).toBe("fulfilled");
  const selected = await state(switches.ROOT);
  expect(publication.value.pair).toEqual(selected.selectedPair);
  expect(publication.value.epoch).toBe(selected.epoch);
  expect((await db.collection(`${admissions.ADMISSIONS}/operations`).get()).size).toBe(1);
});
it("accepts new work at NEXT when the switch wins, including the atomically moved producer enrollment", async () => {
  const { attempt, next } = await seed(); await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
  await apply(attempt);
  expect(await state("system/publicReleaseChangeLog")).toMatchObject({ pair: { pairId: next.pairId }, head: { sequence: 1 } });
  const admitted = await accept();
  expect(admitted).toMatchObject({ pair: { pairId: next.pairId }, epoch: 2, changeSequence: 2 });
  expect(await state("system/publicReleaseChanges/entries/0000000000000002")).toMatchObject({ operationId: admitted.operationId, pair: admitted.pair });
});
it("refuses a stale switch witness after acceptance; lost acceptance response reuses its original pair after selection changes", async () => {
  const { attempt, selector } = await seed(); await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
  const first = await accept(); await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  await db.doc(switches.ROOT).set({ ...selector, epoch: 2, selectedPair: selector.recoveryPair,
    recoveryPair: selector.selectedPair, activeCommitSha: selector.recoveryPair.commitSha,
    activeDeploymentId: selector.recoveryPair.publicWorkerVersionId, contentHead: { ...selector.contentHead, pairId: selector.recoveryPair.pairId } });
  expect(await accept()).toEqual(first);
  expect((await db.collection(`${admissions.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});
it("captures/enqueues exact accepted OLD scope after selection moves; unrelated or altered old work refuses", async () => {
  const { old, selector } = await seed(); const admitted = await accept();
  await db.doc(switches.ROOT).set({ ...selector, epoch: 2, selectedPair: selector.recoveryPair, recoveryPair: selector.selectedPair,
    activeCommitSha: selector.recoveryPair.commitSha, activeDeploymentId: selector.recoveryPair.publicWorkerVersionId,
    contentHead: { ...selector.contentHead, pairId: selector.recoveryPair.pairId } });
  const scope = { kind: "accepted", sourceOperationId: admitted.operationId, sourceVersion: document.published.sourceVersion,
    snapshotDigest: capturedSnapshotDigest, contextSequence: 1 };
  await expect(db.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({ firestore: db, transaction,
    pair: old, scope, inputManifestDigest: "d".repeat(64) }))).resolves.toEqual({ receipt: null, slot: null });
  await expect(db.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({ firestore: db, transaction,
    pair: old, scope: { ...scope, sourceOperationId: "unaccepted-operation" }, inputManifestDigest: "d".repeat(64) }))).rejects.toThrow();
  const entry = await state("system/publicReleaseChanges/entries/0000000000000001");
  const captured = await seedCapturedPairInput(db, old, scope, { baselineDigest: entry.previousDigest, lastDigest: entry.entryDigest });
  const task = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction,
    pair: old, input: captured.taskInput }));
  expect(task.idempotent).toBe(false);
  expect((await work.claimPublicReleasePairWork({ firestore: db, pair: old, taskId: task.taskId, now: 1000 })).identity.pair.pairId).toBe(old.pairId);
  const altered = await seedCapturedPairInput(db, old, { ...scope, sourceVersion: scope.sourceVersion + 1 });
  await expect(db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction,
    pair: old, input: altered.taskInput }))).rejects.toThrow();
});
it.each(["adoption", "disabled", "unselected-family", "feature", "queue-collision"])("refuses %s before acceptance writes", async mode => {
  await seed(); let overrides = {};
  if (mode === "adoption") await db.doc(`${admissions.ADMISSIONS}/controls/adoption`).update({ enabled: false });
  if (mode === "disabled") await db.doc("system/billing").set({ disabled: true });
  if (mode === "unselected-family") await db.doc("system/noBuildPostAdmission").update({ families: {} });
  if (mode === "queue-collision") await db.doc("cmsPublishQueue/original-operation").set({ transport: "legacy" });
  if (mode === "feature") { const snapshot = { ...document.published, metadata: { ...document.published.metadata, liveBlog: {} } };
    const required = { ...change, snapshot }; overrides = { source: admissions.publicationSource(required), change: required }; }
  await expect(db.runTransaction(transaction => prepare(transaction, "original-operation", overrides))).rejects.toThrow();
  expect((await db.collection(`${admissions.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

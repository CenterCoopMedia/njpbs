import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import holds, { type RehearsalHoldPlan } from "../../functions/lib/public-release-rehearsal-hold.js";
import admission from "../../functions/lib/public-release-admission.js";
import protocol from "../../functions/lib/public-release-pair.js";
import context from "../../functions/lib/public-context-revision.js";

const db = isolatedFirestore("rehearsal-hold"), operationId = "H".repeat(20);
const contract = { schemaVersion: 2, families: ["context"], features: [] };
let plan: RehearsalHoldPlan;
const change = (id = operationId) => ({ kind: "provider" as const, id, action: "dependency" as const,
  sourceVersion: 1, snapshot: { sourceVersion: 1, value: id } });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const sides = await seedSwitch(db, { admittedContract: contract });
  await db.doc(`${admission.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  plan = { schemaVersion: 2, runId: "hold-run", operationId, pair: sides.old, targetPair: sides.next, expectedEpoch: sides.selector.epoch,
    source: admission.publicationSource(change()), durationMs: 600_000, releaseActionId: "release-held", cancelActionId: "cancel-held" };
});
async function accept(id = operationId) {
  return db.runTransaction(async transaction => {
    const revision = (await transaction.get(db.doc("system/publicDeployment/contexts/public"))).data()!.revision;
    const prepared = await admission.preparePairPublicationInTransaction({ firestore: db, transaction, operationId: id,
      source: admission.publicationSource(change(id)), change: change(id), contextRevision: revision + 1 });
    prepared.write(); if (!prepared.idempotent) context.bumpPublicContextRevision(transaction, db);
    return prepared.admission;
  });
}
const reserve = (override = {}) => holds.reserveRehearsalPublicationHold({ firestore: db, plan, enabled: true, ...override });
const read = () => holds.readRehearsalPublicationHold({ firestore: db, plan });
it("is off by default and leaves ordinary acceptance unheld", async () => {
  await expect(reserve({ enabled: undefined })).rejects.toThrow();
  const accepted = await accept();
  expect(await read()).toBeNull();
  expect(await db.runTransaction(transaction => holds.assertNotHeldInTransaction({ firestore: db, transaction, pair: plan.pair, accepted }))).toBeNull();
});
it.each(["production", "foreign-db", "same-pair", "bad-operation", "unbounded", "wrong-selected", "unadopted", "wrong-source"])("refuses %s before creating a hold", async which => {
  let input: any = { firestore: db, plan, enabled: true };
  if (which === "production") input.plan = { ...plan, pair: { ...plan.pair, environment: "production" } };
  if (which === "foreign-db") input.firestore = { projectId: "njpbs-site" };
  if (which === "same-pair") input.plan = { ...plan, targetPair: plan.pair };
  if (which === "bad-operation") input.plan = { ...plan, operationId: "short" };
  if (which === "unbounded") input.plan = { ...plan, durationMs: holds.HOLD_MS_LIMIT + 1 };
  if (which === "wrong-selected") input.plan = { ...plan, pair: plan.targetPair, targetPair: plan.pair };
  if (which === "unadopted") await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: false });
  if (which === "wrong-source") input.plan = { ...plan, source: { ...plan.source, sourceVersion: 0 } };
  await expect(holds.reserveRehearsalPublicationHold(input)).rejects.toThrow();
  expect((await db.collection(holds.HOLDS).get()).empty).toBe(true);
});
it("atomically binds the actual admission and recovers the same original after lost responses and restart", async () => {
  const intent = await reserve(), before = await db.doc(holds.path(operationId)).get();
  expect((await read())!.status).toBe("reserved");
  expect(await reserve()).toEqual(intent);
  const accepted = await accept(), bound = await read();
  expect(bound).toMatchObject({ status: "held", binding: { schemaVersion: 2, holdDigest: protocol.publicReleaseDigest(intent), admissionDigest: protocol.publicReleaseDigest(accepted) } });
  expect(await accept()).toEqual(accepted);
  expect(await reserve()).toEqual(intent);
  expect((await before.ref.get()).updateTime).toEqual(before.updateTime);
  await expect(db.runTransaction(transaction => holds.assertNotHeldInTransaction({ firestore: db, transaction, pair: plan.pair, accepted }))).rejects.toThrow(holds.RehearsalPublicationHeldError);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", execution: null, terminalReceipt: null });
  expect((await db.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
  expect((await db.doc(admission.ADMISSIONS).get()).data()!.pendingCount).toBe(1);
  await expect(reserve({ plan: { ...plan, source: { ...plan.source, snapshotDigest: "0".repeat(64) } } })).rejects.toThrow();
  const second = await accept("U".repeat(20));
  expect(await db.runTransaction(transaction => holds.assertNotHeldInTransaction({ firestore: db, transaction, pair: plan.pair, accepted: second }))).toBeNull();
});
it("never arms after acceptance and resolves a real reservation race on the native owners", async () => {
  const results = await Promise.allSettled([reserve(), accept()]);
  expect(results[1].status).toBe("fulfilled");
  const state = await read();
  if (results[0].status === "fulfilled") expect(state?.status).toBe("held");
  else expect(state).toBeNull();
  if (!state) await expect(reserve()).rejects.toThrow();
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).size).toBe(1);
});
it.each(["source", "pair", "epoch"])("refuses mismatched %s acceptance without partial queue, outbox or binding", async mismatch => {
  const original = await reserve();
  if (mismatch === "source") plan = { ...plan, source: { ...plan.source, sourceVersion: 2 } };
  if (mismatch === "epoch") await db.doc("system/publicDeployment").update({ epoch: plan.expectedEpoch + 1 });
  if (mismatch === "pair") await db.doc("system/publicDeployment").update({ selectedPair: protocol.publicReleasePairReference(plan.targetPair), activeCommitSha: plan.targetPair.commitSha });
  if (mismatch === "source") {
    // Tamper the declared reservation source at the boundary, retaining a valid
    // intent codec; actual admission must compare its independently derived source.
    await db.doc(holds.path(operationId)).set({ ...original, plan, planDigest: protocol.publicReleaseDigest(plan) });
  }
  await expect(accept()).rejects.toThrow();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).exists).toBe(false);
  expect((await db.doc(`${holds.path(operationId)}/receipts/admission`).get()).exists).toBe(false);
  expect((await db.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).exists).toBe(false);
});
it("cancels only the original run/action and never reports cancellation as a released proof", async () => {
  const intent = await reserve(); await accept();
  const input = { firestore: db, plan, enabled: true, holdDigest: protocol.publicReleaseDigest(intent), actionId: plan.cancelActionId };
  await expect(holds.cancelRehearsalPublicationHold({ ...input, actionId: plan.releaseActionId })).rejects.toThrow();
  const cancelled = await holds.cancelRehearsalPublicationHold(input);
  expect(cancelled).toMatchObject({ outcome: "cancelled", evidence: null });
  expect(await holds.cancelRehearsalPublicationHold(input)).toEqual(cancelled);
  expect((await read())?.status).toBe("cancelled");
  const accepted = admission.parseAdmission((await db.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data());
  await expect(db.runTransaction(transaction => holds.assertNotHeldInTransaction({ firestore: db, transaction, pair: plan.pair, accepted }))).resolves.toMatchObject({ status: "cancelled" });
});
it("expires by real SDK time without a future clock, hint reset or manufactured release", async () => {
  plan = { ...plan, durationMs: 1_000 };
  await reserve(); const accepted = await accept();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  expect((await read())?.status).toBe("expired");
  await expect(db.runTransaction(transaction => holds.assertNotHeldInTransaction({ firestore: db, transaction, pair: plan.pair, accepted }))).resolves.toMatchObject({ status: "expired", outcome: null });
  expect((await db.doc(admission.publicationPendingPath(plan.pair.pairId, operationId)).get()).data()!.nextAttemptAt).toBe(0);
});
it("refuses corrupted binding or a foreign original and bounds a run to one hold per pair", async () => {
  await reserve(); const accepted = await accept();
  await expect(reserve({ plan: { ...plan, operationId: "B".repeat(20) } })).rejects.toThrow();
  await expect(db.runTransaction(transaction => holds.stateInTransaction({ firestore: db, transaction, pair: plan.targetPair, accepted }))).rejects.toThrow();
  await db.doc(`${holds.path(operationId)}/receipts/admission`).update({ admissionDigest: "0".repeat(64) });
  await expect(read()).rejects.toThrow();
});

it("never reports held if a mismatched installed runtime already settled or lost the original pending marker", async () => {
  await reserve(); await accept();
  const marker = db.doc(`${admission.ADMISSIONS}/pending/${operationId}`), original = (await marker.get()).data()!;
  await marker.delete(); await expect(read()).rejects.toThrow(); await marker.set(original);
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "success" });
  await expect(read()).rejects.toThrow();
});

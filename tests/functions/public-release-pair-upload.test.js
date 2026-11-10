import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";

let db;
const pair = releasePair();
const accountId = "c".repeat(32);
const assignedVersion = "12345678-1234-4234-8234-123456789abc";
function uploadPlan(input = pair) {
  const pairTemplate = structuredClone(input);
  delete pairTemplate.publisher.workerVersionId;
  return { schemaVersion: 2, kind: "private-pair-publisher-upload", pairTemplate, accountId,
    imageReference: `registry.cloudflare.com/${accountId}/publisher/candidate@${input.publisher.imageDigest}`,
    bundleDigest: "d".repeat(64), configurationDigest: "e".repeat(64) };
}
function readback(plan) {
  return { planDigest: protocol.publicReleaseDigest(plan), publisherApplication: plan.pairTemplate.publisher.application,
    workerVersionId: assignedVersion, bundleDigest: plan.bundleDigest,
    configurationDigest: plan.configurationDigest, imageDigest: plan.pairTemplate.publisher.imageDigest };
}
function distinctPair(index) {
    const item = releasePair(), suffix = String(index).padStart(12, "0");
    const incarnation = `00000000-0000-4000-8000-${suffix}`;
    item.publicWorker = { service: `njpbs-pair-slot-${incarnation}`, incarnation,
      versionId: `10000000-0000-4000-8000-${suffix}` };
    item.pairId = `${item.publicWorker.service}:${incarnation}`;
    item.publisher = { ...item.publisher, application: `njpbs-pair-publisher-${incarnation}`,
      workerVersionId: `20000000-0000-4000-8000-${suffix}`, journalNamespace: `private-${index}` };
    return item;
}
beforeAll(() => { db = isolatedFirestore("public-release-pair-upload.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

it("grants exactly one upload before any immutable pair or rollout exists", async () => {
  const plan = uploadPlan();
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => rollout.reservePublicReleasePairUpload({ firestore: db, plan })));
  expect(outcomes.filter(result => result.mayStartInstall)).toHaveLength(1);
  const attempt = (await db.doc(rollout.publicReleasePairUploadPath(pair.pairId)).get()).data();
  expect(attempt).toEqual({ schemaVersion: 2, pairId: pair.pairId, planDigest: protocol.publicReleaseDigest(plan),
    state: "reserved", workerVersionId: null, readbackDigest: null });
  expect((await db.doc(work.publicReleasePairPath(pair.pairId)).get()).exists).toBe(false);
  expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/rollouts/publisher`).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("fences concurrent different plans for the same incarnation", async () => {
  const plans = [uploadPlan(), { ...uploadPlan(), bundleDigest: "f".repeat(64) }];
  const outcomes = await Promise.allSettled(plans.map(plan => rollout.reservePublicReleasePairUpload({ firestore: db, plan })));
  expect(outcomes.filter(result => result.status === "fulfilled" && result.value.mayStartInstall)).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((await db.collection(`${work.publicReleasePairPath(pair.pairId)}/rollouts`).get()).size).toBe(1);
});

it("rejects changed plans and wrong account/image/private resource identities", async () => {
  const plan = uploadPlan();
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  for (const changed of [
    { ...plan, bundleDigest: "f".repeat(64) },
    { ...plan, configurationDigest: "f".repeat(64) },
    { ...plan, accountId: "f".repeat(32) },
    { ...plan, imageReference: plan.imageReference.replace("publisher/candidate", "../candidate") },
    { ...plan, pairTemplate: pair },
    { ...plan, pairTemplate: { ...plan.pairTemplate, publisher: { ...plan.pairTemplate.publisher, application: "njpbs-cms-publisher" } } },
  ]) await expect(rollout.reservePublicReleasePairUpload({ firestore: db, plan: changed })).rejects.toThrow();
  expect((await rollout.reservePublicReleasePairUpload({ firestore: db, plan })).mayStartInstall).toBe(false);
});

it("preserves an uncertain attempt and seals the independently read UUID exactly once", async () => {
  const plan = uploadPlan(), proof = readback(plan);
  await expect(rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: proof })).rejects.toThrow();
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan });
  expect(await rollout.reservePublicReleasePairUpload({ firestore: db, plan })).toMatchObject({ mayStartInstall: false,
    state: "uncertain", workerVersionId: null });
  for (const changed of [
    { ...proof, workerVersionId: "00000000-0000-0000-0000-000000000000" },
    { ...proof, workerVersionId: [assignedVersion] },
    { ...proof, imageDigest: `sha256:${"f".repeat(64)}` },
    { ...proof, configurationDigest: "f".repeat(64) },
    { ...proof, publisherApplication: "njpbs-cms-publisher" },
  ]) await expect(rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: changed })).rejects.toThrow();
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: proof });
  expect(await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: proof }))
    .toEqual({ idempotent: true, workerVersionId: assignedVersion });
  await expect(rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan })).rejects.toThrow();
  await expect(rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan,
    readback: { ...proof, workerVersionId: pair.publisher.workerVersionId } })).rejects.toThrow();
  expect(await rollout.reservePublicReleasePairUpload({ firestore: db, plan })).toMatchObject({ mayStartInstall: false,
    state: "uploaded", workerVersionId: assignedVersion });
});

it("refuses another upload when the eight-pair registry is full", async () => {
  for (let index = 1; index <= 8; index++) await work.registerPublicReleasePair({ firestore: db, pair: distinctPair(index) });
  const ninth = distinctPair(9);
  await expect(rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(ninth) })).rejects.toThrow();
  expect((await db.doc(rollout.publicReleasePairUploadPath(ninth.pairId)).get()).exists).toBe(false);
});

it("hands only the sealed assigned version to the candidate rollout gate", async () => {
  const plan = uploadPlan();
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: readback(plan) });
  const sealed = { ...pair, publisher: { ...pair.publisher, workerVersionId: assignedVersion } };
  await work.registerPublicReleasePair({ firestore: db, pair: sealed });
  expect((await rollout.reservePublicReleasePairUpload({ firestore: db, plan })).mayStartInstall).toBe(false);
  expect(await rollout.reservePublicReleasePairRollout({ firestore: db, pair: sealed }))
    .toEqual({ mayStartProviderWrite: true, state: "reserved" });
  await expect(rollout.reservePublicReleasePairRollout({ firestore: db, pair })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});

it("refuses an already registered incarnation, a retained journal and disabled billing", async () => {
  const plan = uploadPlan();
  await work.registerPublicReleasePair({ firestore: db, pair });
  await expect(rollout.reservePublicReleasePairUpload({ firestore: db, plan })).rejects.toThrow();
  const candidate = releasePair("b", "b".repeat(40));
  candidate.publisher.journalNamespace = pair.publisher.journalNamespace;
  await expect(rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(candidate) })).rejects.toThrow();
  await db.doc("system/billing").set({ disabled: true });
  await expect(rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(releasePair("b", "b".repeat(40))) })).rejects.toThrow();
  expect((await db.doc(rollout.publicReleasePairUploadPath(candidate.pairId)).get()).exists).toBe(false);
});


it("counts pending distinct plans atomically against the eight-slot limit", async () => {
  for (let index = 1; index <= 7; index++) await work.registerPublicReleasePair({ firestore: db, pair: distinctPair(index) });
  const outcomes = await Promise.allSettled([8, 9].map(index =>
    rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(distinctPair(index)) })));
  expect(outcomes.filter(row => row.status === "fulfilled" && row.value.mayStartInstall)).toHaveLength(1);
  expect(outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
  expect((await db.doc("system/publicReleasePairUploads").get()).data().plans).toHaveLength(1);
});

it("fences simultaneous pending plans that share a journal namespace", async () => {
  const first = distinctPair(1), second = distinctPair(2);
  second.publisher.journalNamespace = first.publisher.journalNamespace;
  const outcomes = await Promise.allSettled([first, second].map(item =>
    rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(item) })));
  expect(outcomes.filter(row => row.status === "fulfilled" && row.value.mayStartInstall)).toHaveLength(1);
  expect(outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
});

it("requires the exact uploaded UUID and bundle/configuration seal before rollout", async () => {
  const plan = uploadPlan();
  const sealed = { ...pair, publisher: { ...pair.publisher, workerVersionId: assignedVersion } };
  await work.registerPublicReleasePair({ firestore: db, pair: sealed });
  await expect(rollout.reservePublicReleasePairRollout({ firestore: db, pair: sealed }))
    .rejects.toMatchObject({ code: "PAIR_PUBLISHER_UPLOAD_PENDING", retryable: true });
  // Registration cannot manufacture upload proof. Seed the durable upload state
  // to exercise corrupt/incomplete persisted receipts at the rollout boundary.
  await db.doc("system/publicReleasePairUploads").set({ schemaVersion: 2, plans: [plan] });
  const attempt = { schemaVersion: 2, pairId: pair.pairId, planDigest: protocol.publicReleaseDigest(plan),
    state: "uncertain", workerVersionId: null, readbackDigest: null };
  const ref = db.doc(rollout.publicReleasePairUploadPath(pair.pairId));
  await ref.set(attempt);
  await expect(rollout.reservePublicReleasePairRollout({ firestore: db, pair: sealed }))
    .rejects.toMatchObject({ code: "PAIR_PUBLISHER_UPLOAD_PENDING", retryable: true });
  const proof = readback(plan);
  for (const changed of [{ ...proof, workerVersionId: pair.publisher.workerVersionId },
    { ...proof, bundleDigest: "f".repeat(64) }, { ...proof, configurationDigest: "f".repeat(64) }]) {
    await ref.set({ ...attempt, state: "uploaded", workerVersionId: changed.workerVersionId,
      readbackDigest: protocol.publicReleaseDigest(changed) });
    await expect(rollout.reservePublicReleasePairRollout({ firestore: db, pair: sealed }))
      .rejects.toMatchObject({ code: "PAIR_PUBLISHER_UPLOAD_PENDING", retryable: true });
  }
  expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/rollouts/publisher`).get()).exists).toBe(false);
});


it("grants each install stage once and fences lost responses and changed operation identities", async () => {
  const plan = uploadPlan(), requestDigest = "a".repeat(64), readbackDigest = "b".repeat(64);
  const operation = name => ({ firestore: db, plan, operation: name, requestDigest });
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await expect(rollout.reservePublicReleasePairInstallOperation(operation("version"))).rejects.toThrow();
  const outcomes = await Promise.all([1, 2].map(() => rollout.reservePublicReleasePairInstallOperation(operation("identity"))));
  expect(outcomes.filter(row => row.mayStartProviderWrite)).toHaveLength(1);
  await rollout.recordPublicReleasePairInstallOperation(operation("identity"));
  expect(await rollout.reservePublicReleasePairInstallOperation(operation("identity")))
    .toEqual({ mayStartProviderWrite: false, state: "uncertain" });
  await expect(rollout.reservePublicReleasePairInstallOperation({ ...operation("identity"), requestDigest: "c".repeat(64) })).rejects.toThrow();
  await rollout.recordPublicReleasePairInstallOperation({ ...operation("identity"), readbackDigest });
  expect((await rollout.reservePublicReleasePairInstallOperation(operation("version"))).mayStartProviderWrite).toBe(true);
  await expect(rollout.reservePublicReleasePairInstallOperation(operation("deployment"))).rejects.toThrow();
  await rollout.recordPublicReleasePairInstallOperation({ ...operation("version"), readbackDigest });
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: readback(plan) });
  const sealed = { ...pair, publisher: { ...pair.publisher, workerVersionId: assignedVersion } };
  await work.registerPublicReleasePair({ firestore: db, pair: sealed });
  await expect(rollout.reservePublicReleasePairInstallOperation(operation("deployment"))).rejects.toThrow();
  await rollout.reservePublicReleasePairRollout({ firestore: db, pair: sealed });
  expect((await rollout.reservePublicReleasePairInstallOperation(operation("deployment"))).mayStartProviderWrite).toBe(true);
  await expect(rollout.reservePublicReleasePairInstallOperation(operation("container"))).rejects.toThrow();
  await rollout.recordPublicReleasePairInstallOperation({ ...operation("deployment"), readbackDigest });
  expect((await rollout.reservePublicReleasePairInstallOperation(operation("container"))).mayStartProviderWrite).toBe(true);
  await rollout.recordPublicReleasePairInstallOperation({ ...operation("container"), readbackDigest });
  expect(await rollout.recordPublicReleasePairInstallOperation({ ...operation("container"), readbackDigest })).toEqual({ idempotent: true });
  await expect(rollout.recordPublicReleasePairInstallOperation(operation("container"))).rejects.toThrow();
  for (const name of ["identity", "version", "deployment", "container"])
    expect((await rollout.reservePublicReleasePairInstallOperation(operation(name))).mayStartProviderWrite).toBe(false);
});


it("never grants a missing version operation after an uncertain upload", async () => {
  const plan = uploadPlan(), requestDigest = "a".repeat(64);
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  const context = { firestore: db, plan, operation: "identity", requestDigest };
  await rollout.reservePublicReleasePairInstallOperation(context);
  await rollout.recordPublicReleasePairInstallOperation({ ...context, readbackDigest: "b".repeat(64) });
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan });
  await expect(rollout.reservePublicReleasePairInstallOperation({ ...context, operation: "version" })).rejects.toThrow();
  expect((await db.doc(`${rollout.publicReleasePairUploadPath(pair.pairId)}/operations/version`).get()).exists).toBe(false);
});


it("refuses early/wrong UUID registration without consuming the reserved incarnation", async () => {
  const plan = uploadPlan(), sealed = { ...pair, publisher: { ...pair.publisher, workerVersionId: assignedVersion } };
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await expect(work.registerPublicReleasePair({ firestore: db, pair: sealed }))
    .rejects.toMatchObject({ code: "PAIR_PUBLISHER_UPLOAD_PENDING", retryable: true });
  expect((await db.doc(work.publicReleasePairPath(pair.pairId)).get()).exists).toBe(false);
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: readback(plan) });
  await expect(work.registerPublicReleasePair({ firestore: db, pair }))
    .rejects.toMatchObject({ code: "PAIR_PUBLISHER_UPLOAD_PENDING", retryable: true });
  expect((await db.doc(work.publicReleasePairPath(pair.pairId)).get()).exists).toBe(false);
  expect(await work.registerPublicReleasePair({ firestore: db, pair: sealed })).toMatchObject({ idempotent: false });
  expect(await work.registerPublicReleasePair({ firestore: db, pair: sealed })).toMatchObject({ idempotent: true });
});

it("preserves ordinary registration while protecting pending journals and the last slot", async () => {
  for (let index = 1; index <= 7; index++) await work.registerPublicReleasePair({ firestore: db, pair: distinctPair(index) });
  const eighth = distinctPair(8), ninth = distinctPair(9), plan = uploadPlan(eighth);
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan });
  await expect(work.registerPublicReleasePair({ firestore: db, pair: ninth })).rejects.toThrow();
  ninth.publisher.journalNamespace = eighth.publisher.journalNamespace;
  await expect(work.registerPublicReleasePair({ firestore: db, pair: ninth })).rejects.toThrow();
  const registered = (await db.doc("system/publicReleasePairs").get()).data();
  expect(registered.pairIds).toHaveLength(7);
  await rollout.recordPublicReleasePairUploadReadback({ firestore: db, plan, readback: readback(plan) });
  expect(await work.registerPublicReleasePair({ firestore: db,
    pair: { ...eighth, publisher: { ...eighth.publisher, workerVersionId: assignedVersion } } })).toMatchObject({ idempotent: false });
  expect((await db.doc("system/publicReleasePairs").get()).data().pairIds).toHaveLength(8);
});


it("refuses a registration that takes a pending journal even when slots remain", async () => {
  const candidate = distinctPair(1), other = distinctPair(2);
  await rollout.reservePublicReleasePairUpload({ firestore: db, plan: uploadPlan(candidate) });
  other.publisher.journalNamespace = candidate.publisher.journalNamespace;
  await expect(work.registerPublicReleasePair({ firestore: db, pair: other })).rejects.toThrow();
  expect((await db.doc(work.publicReleasePairPath(other.pairId)).get()).exists).toBe(false);
  other.publisher.journalNamespace = "distinct-other-journal";
  expect(await work.registerPublicReleasePair({ firestore: db, pair: other })).toMatchObject({ idempotent: false });
});

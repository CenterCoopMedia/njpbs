import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import legacy from "../../functions/lib/public-deployment.js";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { wakePublicReleasePair } from "../../publisher/release-pair-wake";
import { capturedSnapshotDigest, seedCapturedPairInput } from "../helpers/captured-public-release-pair-input.js";

let db;
const old = releasePair(), next = releasePair("b", "b".repeat(40));
const path = pair => work.publicReleasePairPath(pair.pairId);
const input = (kind = "qualification", sourceOperationId = "operation-one") => ({ kind, sourceOperationId,
  sourceVersion: 7, snapshotDigest: capturedSnapshotDigest, contextSequence: 12 });
const enqueue = async (pair, task) => {
  const captured = await seedCapturedPairInput(db, pair, task);
  return db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair, input: captured.taskInput }));
};
const register = pair => work.registerPublicReleasePair({ firestore: db, pair });
const claim = (pair, taskId, now = 1000) => work.claimPublicReleasePairWork({ firestore: db, pair, taskId, now });
const complete = (pair, claimed, now = 1001) => work.settlePublicReleasePairWork({ firestore: db, pair,
  taskId: claimed.taskId, token: claimed.token, manifestDigest: "e".repeat(64), now });
const stored = async (pair, taskId) => (await db.doc(`${path(pair)}/work/${taskId}`).get()).data();

beforeAll(() => { db = isolatedFirestore("public-release-pair-work.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
});

it("registers isolated candidates without changing pins, the public pointer or legacy journals", async () => {
  await register(old); await register(next);
  expect((await register(old)).idempotent).toBe(true);
  await expect(register({ ...old, readerReceiptDigest: "0".repeat(64) })).rejects.toThrow();
  const third = releasePair("c", "c".repeat(40));
  await expect(register({ ...third, publisher: { ...third.publisher, application: old.publisher.application } })).rejects.toThrow();
  await expect(register({ ...third, publisher: { ...third.publisher, journalNamespace: old.publisher.journalNamespace } })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(legacy.initialPublicDeploymentPointer());
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
  expect((await db.collection("cmsPublicationSerializerJournals").get()).empty).toBe(true);
  for (const pair of [old, next]) {
    expect((await db.doc(`${path(pair)}/journals/${pair.publisher.journalNamespace}`).get()).data()).toMatchObject({ pairId: pair.pairId, job: null });
  }
});

it("permits candidate qualification only, fences simultaneous claims and makes completion idempotent", async () => {
  await register(next);
  await expect(enqueue(next, input("accepted"))).rejects.toThrow();
  const queued = await enqueue(next, input());
  expect((await enqueue(next, input())).idempotent).toBe(true);
  const claims = await Promise.all([claim(next, queued.taskId), claim(next, queued.taskId)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const accepted = claims.find(Boolean);
  expect(accepted.identity.pair).toEqual(pairReference(next));
  expect(accepted.outputPrefix).toBe(`release-pairs/${next.pairId}/${queued.taskId}/claims/${(await stored(next, queued.taskId)).claimDigest}/`);
  await complete(next, accepted);
  expect((await complete(next, accepted)).idempotent).toBe(true);
  expect((await stored(next, queued.taskId)).status).toBe("complete");
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});

it("keeps OLD accepted work on OLD after the default changes and refuses new OLD admissions", async () => {
  await register(old); await register(next);
  for (const pair of [old, next]) await db.doc(`${path(pair)}/controls/runtime`).update({ status: "retained" });
  const selector = releaseSelector();
  await db.doc("system/publicDeployment").set(selector);
  const original = await enqueue(old, input("accepted"));
  const switched = { ...selector, epoch: 2, activeGeneration: 8, lastReservedGeneration: 8, newestEligibleGeneration: 8,
    selectedPair: selector.recoveryPair, recoveryPair: selector.selectedPair, activeCommitSha: next.commitSha,
    contentHead: { ...selector.contentHead, pairId: next.pairId } };
  await db.doc("system/publicDeployment").set(switched);
  expect((await enqueue(old, input("accepted"))).idempotent).toBe(true);
  await expect(enqueue(old, input("accepted", "new-old-operation"))).rejects.toThrow();
  await enqueue(next, input("accepted", "new-operation"));
  const accepted = await claim(old, original.taskId);
  await complete(old, accepted);
  expect((await stored(old, original.taskId)).identity.pair).toEqual(pairReference(old));
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(switched);
  // A pair with even the same source cannot consume another incarnation's task.
  await expect(claim(next, original.taskId)).rejects.toThrow();
  await db.doc(`${path(old)}/controls/runtime`).update({ status: "retired" });
  await expect(work.readPublicReleasePairWork({ firestore: db, pair: old, now: 1001 })).rejects.toThrow();
});

it("recovers a missed wake and expired claim, renews exact ownership, and refuses stale settlement", async () => {
  await register(next);
  const { taskId } = await enqueue(next, input());
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now: 1000 })).taskIds).toEqual([taskId]);
  const first = await claim(next, taskId);
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now: 1001 })).taskIds).toEqual([]);
  await work.renewPublicReleasePairWork({ firestore: db, pair: next, taskId, token: first.token, now: 2000 });
  expect(await claim(next, taskId, 61_001)).toBe(null);
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now: 62_001 })).taskIds).toEqual([taskId]);
  const second = await claim(next, taskId, 62_001);
  expect(second.outputPrefix).not.toBe(first.outputPrefix);
  expect(second.identity).toEqual(first.identity);
  expect((await stored(next, taskId)).attempts).toBe(2);
  await expect(complete(next, first, 62_002)).rejects.toThrow();
  await complete(next, second, 62_002);
});

it("records final expired work as failed once and releases its journal without another execution", async () => {
  await register(next);
  const { taskId } = await enqueue(next, input());
  for (let attempt = 0; attempt < 4; attempt++) expect(Boolean(await claim(next, taskId, 1000 + attempt * 60_001))).toBe(true);
  expect(await claim(next, taskId, 1000 + 4 * 60_001)).toBe(null);
  expect((await stored(next, taskId)).status).toBe("failed");
  expect((await stored(next, taskId)).nextAttemptAt).toBe(null);
  expect((await stored(next, taskId)).lastFailure).toBe("lease-expired");
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now: 1_000_000 })).taskIds).toEqual([]);
});

it("routes private wakes by exact incarnation and uses the same durable predicate for idle/minute recovery", async () => {
  await register(next);
  const identity = { pairId: next.pairId, commitSha: next.commitSha, environment: next.environment, journalNamespace: next.publisher.journalNamespace };
  let starts = 0;
  const wake = change => wakePublicReleasePair({ pair: next, identity: { ...identity, ...change },
    readWork: () => work.readPublicReleasePairWork({ firestore: db, pair: next, now: 1000 }), start: async () => { starts++; } });
  expect(await wake()).toBe(false);
  await enqueue(next, input());
  await expect(wake({ pairId: old.pairId })).rejects.toThrow();
  await expect(wake({ commitSha: old.commitSha })).rejects.toThrow();
  await expect(wake({ journalNamespace: old.publisher.journalNamespace })).rejects.toThrow();
  await expect(wake({ environment: "production" })).rejects.toThrow();
  expect(starts).toBe(0);
  expect(await wake()).toBe(true);
  await db.doc("system/billing").set({ disabled: true });
  expect(await wake()).toBe(false);
  expect(starts).toBe(1);
});

it("prioritizes an accepted retry ahead of more than one page of pending qualification work", async () => {
  await register(old); await register(next);
  for (let index = 0; index < 21; index++) await enqueue(next, input("qualification", `qualification-${index}`));
  await db.doc(`${path(next)}/controls/runtime`).update({ status: "retained" });
  const selector = releaseSelector();
  await db.doc("system/publicDeployment").set({ ...selector, selectedPair: pairReference(next), recoveryPair: pairReference(old),
    activeCommitSha: next.commitSha, contentHead: { ...selector.contentHead, pairId: next.pairId } });
  const accepted = await enqueue(next, input("accepted"));
  const claimed = await claim(next, accepted.taskId);
  await work.settlePublicReleasePairWork({ firestore: db, pair: next, taskId: accepted.taskId, token: claimed.token,
    manifestDigest: null, failureCode: "render-failed", retryAt: 2000, now: 1001 });
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now: 2001 })).taskIds).toEqual([accepted.taskId]);
});

it("runs and retries private work without activating a release or claiming publication success", async () => {
  await register(next);
  const { taskId } = await enqueue(next, input());
  const before = (await db.doc("system/publicDeployment").get()).data();
  let now = 1000;
  expect(await runPublicReleasePairWorkOnce({ firestore: db, pair: next, clock: () => now,
    execute: async () => { throw new work.PairExecutionError("render-failed"); } })).toBe("retry-recorded");
  expect((await stored(next, taskId)).lastFailure).toBe("render-failed");
  expect((await work.readPublicReleasePairWork({ firestore: db, pair: next, now })).taskIds).toEqual([]);
  now = 2001;
  expect(await runPublicReleasePairWorkOnce({ firestore: db, pair: next, clock: () => now,
    execute: async ({ identity, outputPrefix, renew }) => {
      expect(identity.snapshotDigest).toBe(capturedSnapshotDigest);
      expect(outputPrefix).toContain(next.pairId);
      await renew();
      return { manifestDigest: "e".repeat(64) };
    } })).toBe("complete");
  expect((await stored(next, taskId)).attempts).toBe(2);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});

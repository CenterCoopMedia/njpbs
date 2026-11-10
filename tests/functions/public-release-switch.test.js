import { beforeAll, beforeEach, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner, capabilities } from "../helpers/public-release-switch.js";
import switches from "../../functions/lib/public-release-switch.js";
import pair from "../../functions/lib/public-release-pair.js";
import fence from "../../functions/lib/public-release-writer-fence.js";
import legacy from "../../functions/lib/public-deployment-coordinator.js";
import legacyPointer from "../../functions/lib/public-deployment.js";
import producer from "../../functions/lib/public-release-producer.js";
import sourceBody from "../../functions/lib/public-release-source-body.js";
let db;
beforeAll(() => { db = isolatedFirestore("public-release-switch.test.js"); });
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db); });
const reserve = attempt => switches.reservePublicReleaseSwitch({ firestore: db, attempt });
const apply = (attempt, assertQualificationsCurrentInTransaction = fixtureGuard) => switches.applyPublicReleaseSwitch({ firestore: db, attempt,
  qualificationReadOwner: fixtureReadOwner, assertQualificationsCurrentInTransaction, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
const state = async path => (await db.doc(path).get()).data();

it("persists one immutable attempt and fences release writers without changing the serving selector or admission", async () => {
  const { attempt, selector } = await seedSwitch(db);
  const admission = await state("system/noBuildPostAdmission");
  expect((await reserve(attempt)).idempotent).toBe(false);
  expect((await reserve(attempt)).idempotent).toBe(true);
  await expect(reserve({ ...attempt, witnessDigest: "0".repeat(64) })).rejects.toThrow();
  await expect(reserve({ ...attempt, operationId: "competing-switch" })).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect(await state("system/noBuildPostAdmission")).toEqual(admission);
  // Legacy acquisition must read the same fence even on a valid legacy pointer.
  await db.doc(switches.ROOT).set(legacyPointer.initialPublicDeploymentPointer());
  await expect(legacy.reservePublicBuildBatch({ firestore: db, buildBatchId: "legacy-attempt", commitSha: attempt.oldPair.commitSha,
    runtime: { owner: "cloudflare", release: attempt.oldPair.commitSha } })).rejects.toThrow();
  expect((await db.doc(`${switches.ROOT}/buildBatches/legacy-attempt`).get()).exists).toBe(false);
});

it("changes selector, both ready pins, capabilities, receipt, audit and media counters in one transaction", async () => {
  const olderMedia = { pairId: "retained-older-pair", manifestDigest: "a".repeat(64) };
  const { attempt, next, old, qualifications } = await seedSwitch(db, { extraMediaReferences: [olderMedia] }), admission = await state("system/noBuildPostAdmission");
  await reserve(attempt);
  let guarded = 0;
  const result = await apply(attempt, async ({ transaction, pairs }) => {
    guarded++; expect(pairs.map(pair => pair.pairId)).toEqual([old.pairId, next.pairId]);
    expect((await transaction.get(db.doc(switches.ROOT))).data().epoch).toBe(1);
  });
  expect(guarded).toBe(1);
  expect(result.idempotent).toBe(false);
  const pointer = await state(switches.ROOT);
  expect(pointer).toMatchObject({ state: "idle", epoch: 2, activeGeneration: 8, lastReservedGeneration: 8,
    newestEligibleGeneration: 8, activeCommitSha: next.commitSha, recoveryPair: { pairId: old.pairId } });
  expect(await state("system/cmsPublicationRuntime")).toMatchObject({ phase: "ready", commitSha: next.commitSha, cloud: { phase: "ready", commitSha: next.commitSha } });
  expect(await state("system/noBuildPostAdmission")).toEqual(admission);
  for (const path of Object.values(switches.CAPABILITY_PATHS)) expect(await state(path)).toMatchObject({ generation: 8, rendererSha: next.commitSha });
  expect(await state(switches.MEDIA)).toMatchObject({ epoch: 2, activeGeneration: 8, lastReservedGeneration: 8, newestEligibleGeneration: 8 });
  const media = await state(switches.MEDIA);
  expect(media.references).toContainEqual(olderMedia);
  for (const [index, owner] of [old, next].entries()) {
    expect(media.references.find(reference => reference.pairId === owner.pairId).manifestDigest).toBe(qualifications[index].contentHead.manifestDigest);
  }
  const audit = await db.collection("admin_logs").orderBy("at", "desc").get();
  expect(audit.size).toBe(1);
  expect(audit.docs[0].data()).toMatchObject({ actorUid: "system:public-release-switch", target: switches.ROOT });
  expect(audit.docs[0].data().timestamp.toMillis()).toBeGreaterThan(0);
  expect((await db.doc(fence.RELEASE_WRITER_FENCE_PATH).get()).exists).toBe(false);
  expect(result.receipt.selectorDigest).toBe(pair.publicReleaseDigest(pointer));
  const entries = await db.collection("system/publicReleaseChanges/entries").get();
  expect(entries.size).toBe(1);
  const entry = entries.docs[0].data();
  expect(entry).toMatchObject({ operationId: switches.switchChangeOperationId(attempt.operationId), pair: selectorReference(old) });
  const member = await state(producer.publicReleaseMemberPath(entry.operationId, "provider", "public-code"));
  const body = await db.runTransaction(transaction => sourceBody.readPublicReleaseSourceBody({ firestore: db, transaction,
    contentDigest: member.contentDigest }), { readOnly: true });
  expect(body.snapshot.codeReference).toMatchObject({ schemaVersion: 2, kind: "pair", side: selectorReference(next) });
  expect(body.documents.find(doc => doc.path === `system/publicReleaseSwitches/entries/${attempt.operationId}`).data)
    .toEqual({ schemaVersion: 2, operationId: attempt.operationId, selector: pointer,
      pins: await state("system/cmsPublicationRuntime") });
  expect(await state("system/publicReleaseChangeLog")).toMatchObject({ pair: selectorReference(next), head: { sequence: 1 } });
});
it("reads a migrated legacy Timestamp through the stored codec and keeps switch wire receipts strict", async () => {
  const { attempt, selector } = await seedSwitch(db), updatedAt = Timestamp.fromMillis(1_793_188_800_000);
  await db.doc(switches.ROOT).update({ updatedAt });
  expect(() => pair.parsePublicReleaseSelector({ ...selector, updatedAt })).toThrow();
  expect(pair.parseStoredPublicReleaseSelector((await db.doc(switches.ROOT).get()).data())).toEqual(selector);
  await reserve(attempt);
  const result = await apply(attempt);
  expect(result.receipt.selector.priorSelectorDigest).toBe(pair.publicReleaseDigest(selector));
  expect(pair.parsePublicReleaseSelector(result.receipt.selector)).toEqual(result.receipt.selector);
  expect((await apply(attempt)).idempotent).toBe(true);
});
const selectorReference = value => pair.publicReleasePairReference(value);

it.each(["disabled", "missing-family"])("preserves registered record namespaces when the exact candidate capability is %s", async mode => {
  const nextCapabilities = capabilities("b".repeat(40));
  if (mode === "disabled") nextCapabilities.records.servingEnabled = false;
  else nextCapabilities.records.families = ["programs"];
  const { attempt, selector } = await seedSwitch(db, { nextCapabilities }); await reserve(attempt);
  await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection(switches.RECEIPTS).get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});

it("feeds the actual switch event into historical frozen sources and refuses a broken pair-code seal", async () => {
  const { attempt, next } = await seedSwitch(db); await reserve(attempt); await apply(attempt);
  const historical = (await import("../../functions/lib/public-release-historical-state.js")).default;
  const { freezePublicReleaseSourceDependencies } = await import("../../site/scripts/public-release-pair-frozen-sources");
  const state = await historical.reconstructPublicReleaseState({ firestore: db,
    sourceOperationId: switches.switchChangeOperationId(attempt.operationId) });
  const providerStore = { put() { throw new Error("Unexpected mutable write"); }, get() { throw new Error("Unexpected mutable read"); } };
  const frozen = await freezePublicReleaseSourceDependencies({ firestore: db, state, providerStore });
  expect(frozen.qualifiedCode.publication.commitSha).toBe(next.commitSha);
  expect(frozen.files.has("code-source.json")).toBe(true);
  const work = (await import("../../functions/lib/public-release-pair-work.js")).default;
  await db.doc(`${work.publicReleasePairPath(next.pairId)}/codePacks/publication`).update({ baselineDigest: "0".repeat(64) });
  await expect(freezePublicReleaseSourceDependencies({ firestore: db, state, providerStore })).rejects.toThrow();
});

it.each(["missing", "tampered"])("refuses a %s actual reader seal before selecting or appending", async mode => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  const { readerSealPath } = await import("../../site/scripts/public-release-pair-private-reader");
  const ref = db.doc(readerSealPath(attempt.newPair));
  if (mode === "missing") await ref.delete();
  else await ref.update({ "capabilities.post.dataFigureVersion": 0 });
  await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection(switches.RECEIPTS).get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});

it("refuses a separately digested publication control that differs from the sealed reader", async () => {
  const nextCapabilities = capabilities("b".repeat(40));
  delete nextCapabilities.posts.dataFigureVersion;
  const { attempt, selector, qualifications } = await seedSwitch(db, { nextCapabilities }); await reserve(attempt);
  expect(qualifications[1].controlsDigest).toBe(pair.publicReleaseDigest(nextCapabilities));
  expect(qualifications[1].controlsDigest).not.toBe(attempt.newPair.capabilityDigest);
  await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection(switches.RECEIPTS).get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});

it("applies a maximum-length operation id without growing its change-log identity beyond the protocol limit", async () => {
  const { attempt } = await seedSwitch(db, { operationId: "x".repeat(128) });
  await reserve(attempt); expect((await apply(attempt)).idempotent).toBe(false);
});

it.each(["missing", "changed-pack", "wrong-pair"])("refuses %s code publication without selecting or emitting an event", async mode => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  const work = (await import("../../functions/lib/public-release-pair-work.js")).default;
  const base = work.publicReleasePairPath(attempt.newPair.pairId);
  if (mode === "missing") await db.doc(`${base}/codePacks/publication`).delete();
  if (mode === "changed-pack") await db.doc(`${base}/codePacks/baseline`).update({ commitSha: attempt.oldPair.commitSha });
  if (mode === "wrong-pair") await db.doc(`${base}/codePacks/publication`).update({ "reference.side": selector.selectedPair });
  await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});

it("resolves a lost response and simultaneous apply through the same immutable receipt, even after another switch", async () => {
  const { attempt } = await seedSwitch(db); await reserve(attempt);
  const results = await Promise.all([apply(attempt), apply(attempt)]);
  expect(results.filter(result => !result.idempotent)).toHaveLength(1);
  expect(results[0].receipt).toEqual(results[1].receipt);
  await db.doc(switches.ROOT).update({ epoch: 100 });
  expect(await apply(attempt)).toEqual({ idempotent: true, receipt: results[0].receipt });
  expect((await db.collection(switches.RECEIPTS).get()).size).toBe(1);
  expect((await db.collection("admin_logs").get()).size).toBe(1);
});

it.each(["system/publicDeployment/contexts/public", "system/publicReleaseChanges", "system/noBuildPostAdmission", switches.MEDIA])("refuses a stale witness after %s changes without any partial selection writes", async path => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  await db.doc(path).update({ changed: true });
  await expect(apply(attempt)).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection(switches.RECEIPTS).get()).empty).toBe(true);
  expect((await db.collection("admin_logs").get()).empty).toBe(true);
});

it("refuses missing actual qualification guard and rolls back writes when that guard rejects", async () => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  await expect(switches.applyPublicReleaseSwitch({ firestore: db, attempt })).rejects.toThrow();
  await expect(apply(attempt, async () => { throw new Error("actual deployed reader drifted"); })).rejects.toThrow();
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection(switches.RECEIPTS).get()).empty).toBe(true);
});

it("shares one opaque read tracker from the first switch read and refuses an exhausted final budget before writes", async () => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  let tracker, reads = 0, guards = 0;
  const qualificationReadOwner = {
    ...fixtureReadOwner,
    trackQualificationTransactionReads(original) {
      const transaction = new Proxy(original, { get(target, key) {
        if (key === "get" || key === "getAll") return async (...args) => {
          const result = await target[key](...args); reads++; return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      tracker = { transaction }; return tracker;
    },
    assertQualificationTransactionReadBudget(value) { expect(value).toBe(tracker); expect(reads).toBeGreaterThan(5); throw new Error("qualification-validator-limit"); },
  };
  const guard = async input => { expect(input.readTracker).toBe(tracker); expect(input.transaction).toBe(tracker.transaction); guards++; };
  await expect(switches.applyPublicReleaseSwitch({ firestore: db, attempt, qualificationReadOwner,
    assertQualificationsCurrentInTransaction: guard, assertAcceptedWorkIncludedInTransaction: guard })).rejects.toThrow("qualification-validator-limit");
  expect(guards).toBe(2);
  expect(await state(switches.ROOT)).toEqual(selector);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).empty).toBe(true);
});

it("refuses a mismatched provider readback and a changed predecessor", async () => {
  const { attempt, selector } = await seedSwitch(db); await reserve(attempt);
  const base = (await import("../../functions/lib/public-release-pair-work.js")).default.publicReleasePairPath(attempt.newPair.pairId);
  await db.doc(`${base}/rollouts/publisher`).update({ readbackDigest: "0".repeat(64) });
  await expect(apply(attempt)).rejects.toThrow();
  await db.doc(`${base}/rollouts/publisher`).update({ readbackDigest: "c".repeat(64) });
  await db.doc(switches.ROOT).update({ contentHead: { ...selector.contentHead, manifestDigest: "0".repeat(64) } });
  await expect(apply(attempt)).rejects.toThrow();
});

it("returns to OLD through a fresh current-content proof and a larger epoch/generation", async () => {
  const first = await seedSwitch(db); await reserve(first.attempt); const selected = (await apply(first.attempt)).receipt.selector;
  const back = await seedSwitch(db, { selector: selected, old: first.next, next: first.old, operationId: "return-to-old" });
  await reserve(back.attempt);
  const result = await apply(back.attempt);
  expect(result.receipt.selector).toMatchObject({ epoch: 3, activeGeneration: 9, activeCommitSha: first.old.commitSha,
    contentHead: { viewId: "view-return-to-old" } });
  expect(result.receipt.selector.contentHead).not.toEqual(first.selector.contentHead);
});

it("abandons only an unapplied attempt and cannot reacquire or apply an abandoned identity", async () => {
  const { attempt } = await seedSwitch(db); await reserve(attempt);
  expect(await switches.abandonPublicReleaseSwitch({ firestore: db, attempt })).toEqual({ idempotent: false });
  expect(await reserve(attempt)).toMatchObject({ idempotent: true });
  await expect(apply(attempt)).rejects.toThrow();
  const fresh = { ...attempt, operationId: "fresh-attempt" };
  await reserve(fresh); await apply(fresh);
  await expect(switches.abandonPublicReleaseSwitch({ firestore: db, attempt: fresh })).rejects.toThrow();
});

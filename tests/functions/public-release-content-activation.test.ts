import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { replayMixedBaselineFixture } from "../helpers/public-release-pair-replay-mixed";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import producer from "../../functions/lib/public-release-producer.js";
import log from "../../functions/lib/public-release-change-log.js";
import admission from "../../functions/lib/public-release-admission.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import fence from "../../functions/lib/public-release-writer-fence.js";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { replayPublicReleasePairToHead } from "../../site/scripts/public-release-pair-log-replay";
import { activationOutboxPath, handoffPublicReleasePairActivation, recoverPublicReleasePairActivations, retryPublicReleasePairActivation } from "../../site/scripts/public-release-pair-activation-outbox";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "../../site/scripts/public-release-pair-publication-seals";
import { activatePublicReleasePairPublication, activateStagedPublicReleasePairPublication, PublicationActivationError } from "../../site/scripts/public-release-pair-content-activation";
import switches from "../../functions/lib/public-release-switch.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import { PairSourceCensusError } from "../../site/scripts/public-release-pair-source-census";
import { PairQualificationError } from "../../site/scripts/public-release-pair-qualification-authority";
import settingsContract from "../../functions/lib/cms-settings-contract.js";

let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
beforeAll(async () => {
  db = isolatedFirestore("public-release-content-activation.test.ts");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  runtime = new Miniflare({ workers: [{ config: { name: "activation-proof", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "activation-proof" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
afterAll(async () => { await runtime?.dispose(); });

async function stagePublication(source: Awaited<ReturnType<typeof replayMixedBaselineFixture>>, operationId: string,
  version: number, revision: number) {
  const story = (await db.doc("cmsPosts/story").get()).data()!;
  const published = { ...story.published, sourceVersion: version };
  await db.runTransaction(async transaction => {
    const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId,
      changes: [producer.publicContentChange("cmsPosts", "story", { published })] });
    write(); transaction.set(db.doc("cmsPosts/story"), { ...story, version, published });
    transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision });
  });
  const captured = await captureHistoricalPublicReleasePairInput({ firestore: source.sourceDb, store,
    pair: source.pair, providerStore: source.providerStore, sourceOperationId: operationId, kind: "recovery" });
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db,
    transaction, pair: source.pair, input: { ...captured.root.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
  const staged = await stagedPublicReleasePairCompositeFixture({ ...source.shared, content: captured, taskId }, store);
  return { published, reference: { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest,
    manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes } };
}

it("atomically activates one real full replay owner, refuses stale/fenced/unproven attempts and recovers its original lost response", async () => {
  // Actual source/H/G/composite/replay proof. Route bodies remain the existing
  // fixture bytes; the resumed qualifier owns the ordinary seal-only API test.
  const source = await replayMixedBaselineFixture(db, store);
  try {
    await source.initialize();
    const baseline = await replay.sealPublicReleasePairReplayWitness({ firestore: db, pair: source.pair });
    const baselineCheckpoint = (await db.doc(replay.checkpointPath(source.pair)).get()).data()!;
    const base = work.publicReleasePairPath(source.pair.pairId), oldCode = source.shared.sourcePair;
    await db.doc("system/publicDeployment").set({ ...releaseSelector(), selectedPair: protocol.publicReleasePairReference(oldCode),
      recoveryPair: protocol.publicReleasePairReference(source.pair), activeCommitSha: oldCode.commitSha });
    await db.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: source.pair.pairId, status: "retained" });
    const operationId = "activation-publication-one", first = await stagePublication(source, operationId, 10, 2);
    const { published, reference } = first;
    const later = await stagePublication(source, "activation-later-publication", 11, 3);
    const replayed = await replayPublicReleasePairToHead({ firestore: db, store, pair: source.pair,
      resolveView: async entry => entry.operationId === operationId ? reference : later.reference });
    if (replayed.status !== "complete") throw new Error("Expected complete real replay");
    const selector = { ...releaseSelector(), activeCommitSha: source.pair.commitSha,
      selectedPair: protocol.publicReleasePairReference(source.pair), recoveryPair: protocol.publicReleasePairReference(source.shared.sourcePair),
      contentHead: { pairId: source.pair.pairId, viewId: baseline.witnessDigest,
        manifestDigest: baseline.witness.contentViewDigest, contextSequence: baseline.witness.headCursor.sequence } };
    const oldHead = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(source.pair), contentHead: selector.contentHead };
    const media = { schemaVersion: 2, epoch: selector.epoch, activeGeneration: selector.activeGeneration,
      lastReservedGeneration: selector.activeGeneration, newestEligibleGeneration: selector.activeGeneration,
      references: [{ pairId: source.pair.pairId, manifestDigest: oldHead.contentHead.manifestDigest },
        { pairId: oldCode.pairId, manifestDigest: "a".repeat(64) }] };
    const accepted = admission.parseAdmission({ schemaVersion: 2, operationId, source: admission.publicationSource({ kind: "post", id: "story", action: "publish", snapshot: published }),
      pair: protocol.publicReleasePairReference(source.shared.sourcePair), pairDigest: protocol.publicReleaseDigest(source.shared.sourcePair), epoch: selector.epoch,
      changeSequence: reference.identity.contextSequence, contextRevision: 2, admissionSequence: 1, admittedContractDigest: selector.admittedContractDigest });
    const admissionDigest = protocol.publicReleaseDigest(accepted), pending = { schemaVersion: 2, operationId, admissionDigest };
    const queue = { schemaVersion: 2, transport: admission.TRANSPORT, operationId, admissionDigest, pair: accepted.pair,
      status: "pending", execution: null, terminalReceipt: null };
    await db.doc("system/publicDeployment").set(selector);
    await db.doc(`${base}/heads/current`).set(oldHead);
    await db.doc(switches.MEDIA).set(media);
    await db.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: source.pair.pairId, status: "retained" });
    await db.doc(`${admission.ADMISSIONS}/operations/${operationId}`).create(accepted);
    await db.doc(`${admission.ADMISSIONS}/pending/${operationId}`).create(pending);
    await db.doc(`cmsPublishQueue/${operationId}`).create(queue);
    const laterOperationId = later.reference.identity.sourceOperationId;
    const acceptedLater = admission.parseAdmission({ ...accepted, operationId: laterOperationId,
      source: admission.publicationSource({ kind: "post", id: "story", action: "publish", snapshot: later.published }),
      changeSequence: 2, contextRevision: 3, admissionSequence: 2 });
    const laterDigest = protocol.publicReleaseDigest(acceptedLater);
    await db.doc(`${admission.ADMISSIONS}/operations/${laterOperationId}`).create(acceptedLater);
    await db.doc(`${admission.ADMISSIONS}/pending/${laterOperationId}`).create({ schemaVersion: 2, operationId: laterOperationId, admissionDigest: laterDigest });
    await db.doc(`cmsPublishQueue/${laterOperationId}`).create({ ...queue, operationId: laterOperationId, admissionDigest: laterDigest });
    // Resume a verified baseline while the original predecessor is completed
    // but its G metadata has not arrived. This is a backlog, not a failure.
    const checkpointRef = db.doc(replay.checkpointPath(source.pair)), completedCheckpoint = (await checkpointRef.get()).data()!;
    const predecessorRef = db.doc(`${base}/views/${reference.manifestDigest}`), predecessor = (await predecessorRef.get()).data()!;
    await checkpointRef.set(baselineCheckpoint); await predecessorRef.delete();
    try {
      const originalCompletionRef = db.doc(`${base}/receipts/${protocol.publicReleaseDigest(reference.identity)}`);
      const originalCompletion = (await originalCompletionRef.get()).data()!;
      await originalCompletionRef.update({ claimDigest: "corrupt-completed-claim" });
      try {
        await expect(activateStagedPublicReleasePairPublication({ firestore: db, store, pair: source.pair, identity: later.reference.identity,
          claimDigest: later.reference.claimDigest, manifestDigest: later.reference.manifestDigest })).rejects.toMatchObject({ name: "PublicReleaseProtocolError" });
      } finally { await originalCompletionRef.set(originalCompletion); }
      await expect(activateStagedPublicReleasePairPublication({ firestore: db, store, pair: source.pair, identity: later.reference.identity,
        claimDigest: later.reference.claimDigest, manifestDigest: later.reference.manifestDigest })).rejects.toMatchObject({ code: "content-activation-replay-pending" });
      expect((await checkpointRef.get()).data()?.cursor).toEqual(baseline.witness.headCursor);
    } finally { await predecessorRef.set(predecessor); await checkpointRef.set(completedCheckpoint); }
    const owner = { firestore: db, store, pair: source.pair, identity: reference.identity,
      claimDigest: reference.claimDigest, manifestDigest: reference.manifestDigest };
    const taskId = protocol.publicReleaseDigest(reference.identity), stagePath = `${base}/staging/${taskId}`,
      outboxPath = activationOutboxPath(source.pair, taskId);
    const originalStaging = (await db.doc(stagePath).get()).data()!;
    const beforeCommit = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return async () => { throw new Error("Process stopped before handoff transaction"); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(handoffPublicReleasePairActivation({ ...owner, firestore: beforeCommit })).rejects.toThrow();
    expect((await db.doc(stagePath).get()).exists).toBe(true);
    expect((await db.doc(outboxPath).get()).exists).toBe(false);
    let dropped = false;
    const lostReply = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return async (update: any, config: any) => {
        const result = await target.runTransaction(update, config);
        if (!dropped) { dropped = true; throw new Error("Handoff committed; response lost"); }
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(handoffPublicReleasePairActivation({ ...owner, firestore: lostReply })).rejects.toThrow();
    expect((await db.doc(stagePath).get()).exists).toBe(false);
    expect((await db.doc(outboxPath).get()).data()?.intent.identity).toEqual(reference.identity);
    expect((await handoffPublicReleasePairActivation(owner)).idempotent).toBe(true);
    const attempt = activation.parseContentActivationAttempt({ schemaVersion: 2, operationId, admissionDigest, pair: source.pair,
      expectedSelectorDigest: protocol.publicReleaseDigest(selector), expectedHeadDigest: protocol.publicReleaseDigest(oldHead),
      witnessDigest: replayed.witnessDigest, headCursor: replayed.witness.headCursor, originalView: reference });
    const replayProof = await replay.openPublicReleasePairReplayWitnessProof({ firestore: db, pair: source.pair,
      headCursor: attempt.headCursor, witnessDigest: attempt.witnessDigest });
    // The external qualifier boundary is deliberately not certified here. The
    // atomic writer must run that actual owner's mandatory guard before writes.
    const publicationReadOwner = { trackQualificationTransactionReads, assertQualificationTransactionReadBudget };
    const assertPublicationCurrentInTransaction = async ({ transaction }: any) => {
      expect((await transaction.get(db.doc(`${admission.ADMISSIONS}/operations/${operationId}`))).data()).toEqual(accepted);
    };
    const options = { firestore: db, attempt, replayProof, publicationReadOwner, assertPublicationCurrentInTransaction };
    const stoppedPublication = { activate: async () => ({ idempotent: false, receipt: {} as any }) };
    await expect(activatePublicReleasePairPublication({ firestore: db, store, pair: source.pair, operationId,
      admissionDigest, originalView: reference, witnessDigest: replayed.witnessDigest })).rejects.toThrow();
    expect((await db.doc(`${base}/heads/current`).get()).data()).toEqual(oldHead);
    // Inject the actual owner error classes at the SDK transaction boundary.
    // A real atomic epoch/media change models concurrent authority movement;
    // stable invalid source and unsupported errors must keep their identity.
    for (const ownerError of [new PairSourceCensusError("source-census-mismatch"), new PairQualificationError("stale-qualification"),
      new PairSourceCensusError("source-census-read-limit")]) {
      for (const moved of [false, true]) {
        const faultingDb = new Proxy(db, { get(target, key) {
          if (key === "runTransaction") return async () => {
            if (moved) await target.batch().set(target.doc("system/publicDeployment"), { ...selector, epoch: selector.epoch + 1 })
              .set(target.doc(switches.MEDIA), { ...media, epoch: selector.epoch + 1 }).commit();
            throw ownerError;
          };
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        } });
        try {
          const result = activatePublicReleasePairPublication({ firestore: faultingDb, store, pair: source.pair, operationId,
            admissionDigest, originalView: reference, witnessDigest: replayed.witnessDigest });
          if (moved && ownerError.code !== "source-census-read-limit")
            await expect(result).rejects.toMatchObject({ code: "content-activation-stale-snapshot" });
          else await expect(result).rejects.toBe(ownerError);
        } finally {
          await db.batch().set(db.doc("system/publicDeployment"), selector).set(db.doc(switches.MEDIA), media).commit();
        }
      }
    }
    await recoverPublicReleasePairActivations({ ...owner, publication: { activate: async () => {
      throw new PublicationActivationError("content-activation-replay-pending");
    } }, taskId });
    expect((await db.doc(outboxPath).get()).data()).toMatchObject({ attempts: 0, lastFailure: "replay-pending" });
    const staleAttempt = { ...attempt, expectedHeadDigest: "0".repeat(64) };
    for (let race = 1; race <= 4; race++) {
      await recoverPublicReleasePairActivations({ ...owner, taskId, now: () => Date.now() + race * 2_000,
        publication: { activate: async () => activation.activatePublicReleasePairContent({ ...options, attempt: staleAttempt }) } });
    }
    expect((await db.doc(outboxPath).get()).data()).toMatchObject({ attempts: 0, lastFailure: "stale-snapshot" });
    expect((await db.doc(outboxPath).get()).data()?.nextAttemptAt).not.toBeNull();
    const beforeBilling = (await db.doc(outboxPath).get()).data();
    await db.doc("system/billing").set({ disabled: true });
    await recoverPublicReleasePairActivations({ ...owner, publication: stoppedPublication, taskId });
    expect((await db.doc(outboxPath).get()).data()).toEqual(beforeBilling);
    await db.doc("system/billing").set({ disabled: false });
    await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
    await expect(recoverPublicReleasePairActivations({ ...owner, publication: stoppedPublication, taskId })).rejects.toThrow();
    expect((await db.doc(outboxPath).get()).data()).toEqual(beforeBilling);
    await db.doc(`${base}/controls/runtime`).update({ status: "retained" });
    let repairClock = Date.now() + 2_000;
    const installedExecutor = createPublicReleasePairExecutor({ firestore: db, store, pair: source.pair, publication: stoppedPublication,
      clock: () => repairClock });
    // Drive the actual quarantine writer by withholding one original claim
    // object. Pause only the unrelated fixture staging row during this fault.
    // No completion, identity or claim is replaced by the repair.
    await db.doc(outboxPath).delete(); await db.doc(stagePath).set(originalStaging);
    const laterTaskId = protocol.publicReleaseDigest(later.reference.identity), laterStageRef = db.doc(`${base}/staging/${laterTaskId}`);
    const laterStaging = (await laterStageRef.get()).data()!;
    await laterStageRef.delete();
    const objects = await store.list({ prefix: `release-pairs/${source.pair.pairId}/${taskId}/claims/` });
    const body = objects.objects.find(object => object.key.includes("/objects/"));
    if (!body) throw new Error("Missing original claim body");
    const originalBody = await store.get(body.key);
    const bodyBytes = new Uint8Array(await originalBody!.arrayBuffer());
    const stagingFailurePath = `${base}/stagingFailures/${taskId}`;
    await store.delete(body.key);
    try {
      await installedExecutor.recover();
      repairClock += 60_001; await installedExecutor.recover();
      repairClock += 120_001; await installedExecutor.recover();
      expect((await db.doc(stagePath).get()).exists).toBe(false);
      expect((await db.doc(stagingFailurePath).get()).data()).toMatchObject({ attempts: 3, status: "quarantined", failedAt: repairClock });
      // The actual quarantined predecessor stops the later original
      // continuation. It must leave the minute-wake query until explicit repair.
      await laterStageRef.set(laterStaging);
      await handoffPublicReleasePairActivation({ firestore: db, store, pair: source.pair, ...later.reference });
      await checkpointRef.set(baselineCheckpoint);
      await recoverPublicReleasePairActivations({ firestore: db, store, pair: source.pair,
        taskId: laterTaskId, publication: { activate: activateStagedPublicReleasePairPublication }, now: () => repairClock });
      expect((await db.doc(activationOutboxPath(source.pair, laterTaskId)).get()).data()).toMatchObject({
        attempts: 0, nextAttemptAt: null, lastFailure: "replay-predecessor-failed" });
      expect((await db.collection(`${base}/activationPending`).where("nextAttemptAt", "<=", repairClock).get()).empty).toBe(true);
      expect((await checkpointRef.get()).data()?.cursor).toEqual(baseline.witness.headCursor);
    } finally {
      await store.put(body.key, bodyBytes, { customMetadata: originalBody!.customMetadata });
      await checkpointRef.set(completedCheckpoint);
      await db.doc(activationOutboxPath(source.pair, laterTaskId)).delete(); await laterStageRef.set(laterStaging);
    }
    await installedExecutor.retryQuarantined(taskId);
    expect((await db.doc(stagingFailurePath).get()).exists).toBe(false);
    expect((await db.doc(outboxPath).get()).data()?.attempts).toBe(1);
    await recoverPublicReleasePairActivations({ ...owner, publication: stoppedPublication, taskId, now: () => repairClock + 5_000 });
    await recoverPublicReleasePairActivations({ ...owner, publication: stoppedPublication, taskId, now: () => repairClock + 8_000 });
    expect((await db.doc(outboxPath).get()).data()).toMatchObject({ attempts: 3, nextAttemptAt: null, lastFailure: "activation-refused" });
    await retryPublicReleasePairActivation({ ...owner, publication: stoppedPublication, taskId, now: () => repairClock + 11_000 });
    expect((await db.doc(outboxPath).get()).data()).toMatchObject({ attempts: 1, lastFailure: "activation-refused" });
    for (const changed of [{ expectedHeadDigest: "0".repeat(64) }, { expectedSelectorDigest: "0".repeat(64) },
      { headCursor: baseline.witness.headCursor }]) {
      await expect(activation.activatePublicReleasePairContent({ ...options, attempt: { ...attempt, ...changed } }))
        .rejects.toMatchObject({ code: "content-activation-stale-snapshot" });
    }
    await db.doc(switches.MEDIA).set({ ...media, references: [{ ...media.references[0], manifestDigest: "0".repeat(64) }, media.references[1]] });
    await expect(activation.activatePublicReleasePairContent(options)).rejects.toThrow();
    await db.doc(switches.MEDIA).set(media);
    await db.doc(fence.RELEASE_WRITER_FENCE_PATH).create({ schemaVersion: 2, operationId: "switch-reserved", attemptDigest: "a".repeat(64) });
    await expect(activation.activatePublicReleasePairContent(options)).rejects.toThrow();
    await db.doc(fence.RELEASE_WRITER_FENCE_PATH).delete();
    await expect(activation.activatePublicReleasePairContent({ ...options, replayProof: { ...replayProof, namespaces: [] } })).rejects.toThrow();
    await expect(activation.activatePublicReleasePairContent({ ...options,
      assertPublicationCurrentInTransaction: async () => { throw new Error("Reader or source seal changed"); } })).rejects.toThrow();
    expect((await db.doc(activation.activationPath(source.pair, operationId)).get()).exists).toBe(false);
    expect((await db.doc(`${base}/heads/current`).get()).data()).toEqual(oldHead);
    const results = await Promise.all([activation.activatePublicReleasePairContent(options), activation.activatePublicReleasePairContent(options)]);
    expect(results.filter(result => !result.idempotent)).toHaveLength(1);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect(results[0].receipt.headView).toEqual(later.reference);
    expect(results[0].receipt.attempt.originalView).toEqual(reference);
    expect(results[0].receipt.admission.source.sourceVersion).toBe(10);
    expect(results[0].receipt.headView.identity.sourceVersion).toBe(11);
    expect(results[0].receipt.contentHead).toEqual({ pairId: source.pair.pairId, viewId: replayed.witnessDigest,
      manifestDigest: replayed.witness.contentViewDigest, contextSequence: replayed.witness.headCursor.sequence });
    const after = (await db.doc("system/publicDeployment").get()).data()!;
    expect(after).toEqual({ ...selector, contentHead: results[0].receipt.contentHead });
    expect((await db.doc(switches.MEDIA).get()).data()).toEqual({ ...media,
      references: [{ ...media.references[0], manifestDigest: results[0].receipt.contentHead.manifestDigest }, media.references[1]] });
    expect((await db.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).data()).toEqual(pending);
    expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toEqual(queue);
    expect((await db.collection(`${base}/publicationActivations`).get()).size).toBe(1);
    await recoverPublicReleasePairActivations({ ...owner, publication: { activate: async () => activation.activatePublicReleasePairContent(options) },
      taskId, now: () => repairClock + 15_000 });
    expect((await db.doc(outboxPath).get()).exists).toBe(false);
    expect((await db.doc(stagePath).get()).exists).toBe(false);
    // The first activation already selected cursor2. Its later accepted
    // operation still needs its own once-only receipt, without rewriting or
    // invalidating the identical head/selector a second time.
    // Independent retained-recovery subcase: seed a trusted terminal FACT as
    // the real read-only terminal owner specifies; this is not a byte issuer.
    // Restore only this subcase's fixture controls/acknowledgement afterward.
    const selectedState = (await db.doc("system/publicDeployment").get()).data()!;
    const mediaState = (await db.doc(switches.MEDIA).get()).data()!;
    const recoverySelector = { ...selector, selectedPair: protocol.publicReleasePairReference(oldCode),
      recoveryPair: protocol.publicReleasePairReference(source.pair), activeCommitSha: oldCode.commitSha,
      contentHead: { pairId: oldCode.pairId, viewId: "retained-canonical-head", manifestDigest: media.references[1].manifestDigest, contextSequence: 2 } };
    const originalIdentity = { schemaVersion: 2 as const, pair: acceptedLater.pair, kind: "accepted" as const,
      sourceOperationId: laterOperationId, sourceVersion: acceptedLater.source.sourceVersion, snapshotDigest: acceptedLater.source.snapshotDigest,
      contextSequence: acceptedLater.changeSequence, inputManifestDigest: "5".repeat(64) };
    const originalExecution = { schemaVersion: 2 as const, pair: acceptedLater.pair, pairDigest: acceptedLater.pairDigest,
      identity: originalIdentity, taskId: protocol.publicReleaseDigest(originalIdentity), inputManifestDigest: originalIdentity.inputManifestDigest,
      claimDigest: "6".repeat(64), manifestDigest: "7".repeat(64) };
    const terminalFact = terminal.parsePairPublicationTerminalReceipt({ schemaVersion: 2, kind: "pair-publication-terminal",
      operationId: laterOperationId, admissionDigest: laterDigest, outcome: "success", selector: recoverySelector,
      selectorDigest: protocol.publicReleaseDigest(recoverySelector), originalExecution,
      activation: { kind: "pair-publication", operationId: laterOperationId, receiptDigest: "8".repeat(64) },
      coverageDigest: "9".repeat(64), canonicalProofDigest: "a".repeat(64), supersededBy: null });
    const laterQueueRef = db.doc(`cmsPublishQueue/${laterOperationId}`), laterQueue = (await laterQueueRef.get()).data()!;
    const laterPendingRef = db.doc(`${admission.ADMISSIONS}/pending/${laterOperationId}`), laterPending = (await laterPendingRef.get()).data()!;
    const terminalRef = db.doc(`${terminal.TERMINAL_RECEIPTS}/${laterOperationId}`);
    await db.doc("system/publicDeployment").set(recoverySelector);
    await db.doc(`${base}/heads/current`).set(oldHead);
    await db.doc(switches.MEDIA).set(media);
    await laterPendingRef.delete(); await terminalRef.create(terminalFact);
    await laterQueueRef.set({ ...laterQueue, status: "success", execution: originalExecution, terminalReceipt: "0".repeat(64) });
    const recoveryAttempt = activation.parseContentActivationAttempt({ ...attempt, operationId: laterOperationId,
      admissionDigest: laterDigest, originalView: later.reference, expectedSelectorDigest: protocol.publicReleaseDigest(recoverySelector) });
    const recoveryOptions = { ...options, attempt: recoveryAttempt,
      assertPublicationCurrentInTransaction: async ({ transaction }: any) => {
        expect((await transaction.get(db.doc(`${admission.ADMISSIONS}/operations/${laterOperationId}`))).data()).toEqual(acceptedLater);
      }, assertOriginalTerminalInTransaction: terminal.assertPairPublicationTerminalReceiptInTransaction };
    await expect(activation.activatePublicReleasePairContent(recoveryOptions)).rejects.toThrow();
    await laterQueueRef.update({ terminalReceipt: protocol.publicReleaseDigest(terminalFact) });
    const selectedRecoveryBefore = await db.doc("system/publicDeployment").get();
    const recovered = await activation.activatePublicReleasePairContent(recoveryOptions);
    expect(recovered.receipt).toMatchObject({ selectedAtActivation: false, originalTerminalDigest: protocol.publicReleaseDigest(terminalFact),
      contentHead: results[0].receipt.contentHead });
    expect((await selectedRecoveryBefore.ref.get()).updateTime!.isEqual(selectedRecoveryBefore.updateTime!)).toBe(true);
    expect((await db.doc(switches.MEDIA).get()).data()).toEqual(mediaState);
    await db.doc(activation.activationPath(source.pair, laterOperationId)).delete();
    await terminalRef.delete(); await laterQueueRef.set(laterQueue); await laterPendingRef.set(laterPending);
    await db.doc("system/publicDeployment").set(selectedState);
    const [selectedBefore, headBefore, mediaBefore] = await db.getAll(db.doc("system/publicDeployment"), db.doc(`${base}/heads/current`), db.doc(switches.MEDIA));
    const laterAttempt = activation.parseContentActivationAttempt({ ...attempt, operationId: laterOperationId, admissionDigest: laterDigest,
      originalView: later.reference, expectedSelectorDigest: protocol.publicReleaseDigest(selectedBefore.data()),
      expectedHeadDigest: protocol.publicReleaseDigest(headBefore.data()) });
    const laterOptions = { ...options, attempt: laterAttempt, assertPublicationCurrentInTransaction: async ({ transaction }: any) => {
      expect((await transaction.get(db.doc(`${admission.ADMISSIONS}/operations/${laterOperationId}`))).data()).toEqual(acceptedLater);
    } };
    await expect(activation.activatePublicReleasePairContent({ ...laterOptions, attempt: { ...laterAttempt, originalView: reference } })).rejects.toThrow();
    const coalesced = await activation.activatePublicReleasePairContent(laterOptions);
    expect(coalesced).toMatchObject({ idempotent: false, receipt: { status: "activated", admission: { operationId: laterOperationId } } });
    const [selectedAfter, headAfter, mediaAfter] = await db.getAll(selectedBefore.ref, headBefore.ref, mediaBefore.ref);
    expect(selectedAfter.updateTime!.isEqual(selectedBefore.updateTime!)).toBe(true);
    expect(headAfter.updateTime!.isEqual(headBefore.updateTime!)).toBe(true);
    expect(mediaAfter.updateTime!.isEqual(mediaBefore.updateTime!)).toBe(true);
    expect((await db.collection(`${base}/publicationActivations`).get()).size).toBe(2);
    await db.doc("system/publicDeployment").update({ epoch: selector.epoch + 1 });
    expect(await activation.activatePublicReleasePairContent(options)).toEqual({ idempotent: true, receipt: results[0].receipt });
    expect(await activation.readPublicReleasePairContentActivation({ firestore: db, attempt })).toEqual(results[0].receipt);
    expect((await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).get()).data()?.sequence).toBe(2);
  } finally { await source.close(); }
}, 180_000);

it("stages an unadmitted settings recovery with the installed publication capability without inventing an admission", async () => {
  const settingsDb = isolatedFirestore("public-release-content-activation-unadmitted-settings");
  const settingsRuntime = new Miniflare({ workers: [{ config: { name: "unadmitted-settings", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "unadmitted-settings" } } } }] });
  const settingsStore = await settingsRuntime.getR2Bucket("CONTENT");
  let source: Awaited<ReturnType<typeof replayMixedBaselineFixture>> | undefined;
  try {
    source = await replayMixedBaselineFixture(settingsDb, settingsStore);
    await source.initialize();
    await settingsDb.doc("system/publicDeployment").set({ ...releaseSelector(),
      selectedPair: protocol.publicReleasePairReference(source.shared.sourcePair),
      recoveryPair: protocol.publicReleasePairReference(source.pair), activeCommitSha: source.shared.sourcePair.commitSha });
    await settingsDb.doc(`${work.publicReleasePairPath(source.pair.pairId)}/controls/runtime`).set({
      schemaVersion: 2, pairId: source.pair.pairId, status: "retained" });
    const operationId = "settings-without-publication-admission", published = settingsContract.createCmsSettingsPublishedSnapshot({
      schema: settingsContract.cmsSettingsSchemaFor("public-homepage-banner", 1), sourceVersion: 1,
      publishedAt: "2026-10-28T00:00:00.000Z", values: { enabled: false, message: "Settings replay fixture" } });
    await settingsDb.runTransaction(async transaction => {
      const write = await producer.preparePublicReleaseProducerInTransaction({ firestore: settingsDb, transaction, operationId,
        changes: [{ kind: "settings", id: "public-homepage-banner", action: "publish", sourceVersion: 1, snapshot: published }] });
      write(); transaction.set(settingsDb.doc("cmsSettings/public-homepage-banner"), { version: 1, published });
      transaction.update(settingsDb.doc("system/publicDeployment/contexts/public"), { revision: 2 });
    });
    const captured = await captureHistoricalPublicReleasePairInput({ firestore: source.sourceDb, store: settingsStore,
      pair: source.pair, providerStore: source.providerStore, sourceOperationId: operationId, kind: "recovery" });
    const { taskId } = await settingsDb.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: settingsDb,
      transaction, pair: source!.pair, input: { ...captured.root.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
    const staged = await stagedPublicReleasePairCompositeFixture({ ...source.shared, content: captured, taskId }, settingsStore, true);
    const base = work.publicReleasePairPath(source.pair.pairId), receiptRef = settingsDb.doc(`${base}/receipts/${taskId}`);
    const completion = (await receiptRef.get()).data()!, selector = (await settingsDb.doc("system/publicDeployment").get()).data();
    let activations = 0;
    const executor = createPublicReleasePairExecutor({ firestore: settingsDb, store: settingsStore, pair: source.pair,
      publication: { activate: async () => { activations++; throw new Error("Unadmitted settings cannot activate a publication"); } } });
    await executor.stage(completion as any);
    await executor.stage(completion as any);
    expect(activations).toBe(0);
    expect((await settingsDb.doc(`${base}/staging/${taskId}`).get()).exists).toBe(false);
    expect((await settingsDb.doc(`${base}/stagingFailures/${taskId}`).get()).exists).toBe(false);
    expect((await settingsDb.doc(activationOutboxPath(source.pair, taskId)).get()).exists).toBe(false);
    expect((await settingsDb.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).exists).toBe(false);
    expect((await settingsDb.doc(activation.activationPath(source.pair, operationId)).get()).exists).toBe(false);
    expect((await settingsDb.doc(`${base}/views/${staged.rendered.manifestDigest}`).get()).data()?.status).toBe("staged");
    expect((await receiptRef.get()).data()).toEqual(completion);
    expect((await settingsDb.doc(`${base}/work/${taskId}`).get()).data()?.attempts).toBe(1);
    expect((await settingsDb.doc("system/publicDeployment").get()).data()).toEqual(selector);
  } finally { await source?.close(); await settingsRuntime.dispose(); }
}, 120_000);

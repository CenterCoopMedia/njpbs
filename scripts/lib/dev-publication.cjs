"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { addressedPublishChanges } = require("../../functions/lib/publish-build-state");
const { reserveCmsPublishArtifact, queueIncludesArtifact } = require("../../functions/lib/cms-publish-artifact");
const { publicationTarget } = require("../../functions/lib/publication-target");
const { publicationRuntime, assertPublicationOwner, runtimeFields } = require("../../functions/lib/publication-runtime-owner");
const { assertPublicDeploymentPointer, projectPublicBuildReservation, projectPublicDeploymentLease,
  assertPublicDeploymentReservedBatch, assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentTerminalBatchStructure, assertPublicDeploymentCancelledBatch } = require("../../functions/lib/public-deployment");
const { publicDeploymentRef, publicBuildBatchRef, publicWorkerCandidateRef, acquirePublicDeploymentLease } = require("../../functions/lib/public-deployment-coordinator");
const { createPublicMediaManifest } = require("../../functions/lib/public-media-manifest");
const { stagePublicMediaManifest, markPublicMediaManifestReady } = require("../../functions/lib/public-media-manifest-store");
const { projectPublicWorkerCandidateInput, projectPublicWorkerCandidate, publicWorkerCandidateTag,
  assertPublicWorkerCandidateDatabase } = require("../../functions/lib/public-worker-candidate");
const { recordPublicWorkerCandidate } = require("../../functions/lib/public-worker-candidate-store");
const { settlePublicDeploymentOutcome } = require("../../functions/lib/public-deployment-outcome-store");
const { recordCmsPublishArtifactInclusion, settleCmsPublishQueueFromPublicDeployment,
  assertTerminalAlignment, terminalLease } = require("../../functions/lib/cms-public-deployment-writeback");
const { STALE_PUBLISH_ERROR } = require("../../functions/lib/publish-reconcile");
const preupload = require("../../functions/lib/dev-publication-preupload");
const { publicReleaseDigest, exact } = require("../../functions/lib/public-release-pair");

const PUBLICATION_TARGET = publicationTarget("development");
const TARGET = Object.freeze({ environment: "development", projectId: "njpbs-site-dev",
  workerName: "template-dev-public", origin: "https://dev-public.example.org", previewBucket: "template-dev-cms-previews" });
const hash = value => createHash("sha256").update(value).digest("hex");
const inputRef = (db, id) => publicBuildBatchRef(db, id.buildBatchId).collection("inputs").doc("devFrozen");

function assertDevTarget(target) {
  if (!isDeepStrictEqual(target, TARGET)) throw new Error("Refusing a non-development publication target");
  return target;
}
function assertDevDatabase(db) {
  assertPublicWorkerCandidateDatabase(db, PUBLICATION_TARGET);
}
function assertDevQueue(queue) {
  if (!queue || queue.transport !== "github" || queue.environment !== TARGET.environment ||
      queue.projectId !== TARGET.projectId || !Array.isArray(queue.changes) ||
      addressedPublishChanges(queue.changes).length !== queue.changes.length) {
    throw new Error("Invalid development publication queue");
  }
  return queue;
}
function assertIdentity(identity) {
  if (!/^[A-Za-z0-9]{20}$/.test(identity.queueId ?? "") || identity.buildBatchId !== "cms-" + identity.queueId ||
      !/^[a-f0-9]{40}$/.test(identity.commitSha ?? "")) throw new Error("Invalid development publication identity");
}
async function selectDevPublicationSource(db, { eventName, eventSha, queueId, retainedIdentity }) {
  assertDevDatabase(db);
  if (!["push", "repository_dispatch", "workflow_dispatch"].includes(eventName) ||
      !/^[A-Za-z0-9]{20}$/.test(queueId ?? "")) throw new Error("Invalid dev source selection input");
  return db.runTransaction(async transaction => {
    const [legacy, queueRow] = await transaction.getAll(db.doc("system/devPublication"),
      db.collection("cmsPublishQueue").doc(queueId));
    if (legacy.exists) throw new Error("The legacy development publication journal requires a drained-state migration after all work is terminal");
    let commitSha = eventSha;
    if (eventName !== "push") {
      if (!queueRow.exists) throw new Error("The development publication queue is missing");
      const queue = assertDevQueue(queueRow.data());
      if (!queue.runtime) throw new Error("The development queue requires a cloud runtime migration with matching metadata");
      commitSha = publicationRuntime(queue.runtime).release;
    }
    if (typeof commitSha !== "string" || commitSha.length !== 40 || !/^[a-f0-9]{40}$/.test(commitSha)) {
      throw new Error("Invalid dev publication source SHA");
    }
    const identity = { queueId, buildBatchId: "cms-" + queueId, commitSha };
    if (queueRow.exists) queueRuntime(queueRow.data(), identity);
    if (retainedIdentity && !isDeepStrictEqual(retainedIdentity, identity)) throw new Error("Retained dev source differs");
    return commitSha;
  }, { readOnly: true });
}
function queueRuntime(queue, identity) {
  assertDevQueue(queue);
  if (!queue.runtime) throw new Error("The development queue requires a cloud runtime migration with matching metadata");
  const runtime = publicationRuntime(queue.runtime);
  if (runtime.owner !== "cloudflare" || runtime.release !== identity.commitSha) {
    throw new Error("The development queue requires a cloud runtime migration with matching metadata");
  }
  return runtime;
}
function assertFrozenInput(input, identity) {
  if (!input || input.schemaVersion !== 1 ||
      Object.keys(input).length !== 6 || Object.keys(input).some(key =>
        !["schemaVersion", "queueId", "buildBatchId", "commitSha", "inputDigest", "recordedAt"].includes(key)) ||
      ["queueId", "buildBatchId", "commitSha"].some(key => input[key] !== identity[key]) ||
      !/^[a-f0-9]{64}$/.test(input.inputDigest ?? "")) throw new Error("Retained dev input conflicts");
}
function batchReservation(batch, identity) {
  if (batch.status === "retired") {
    preupload.assertDevPreuploadRetiredBatch(batch, identity.buildBatchId);
    const { retiredAt, retirementReceipt, ...original } = batch;
    return projectPublicBuildReservation({ ...original, status: "reserved" }, identity.buildBatchId);
  }
  if (batch.status === "reserved") assertPublicDeploymentReservedBatch(batch, identity.buildBatchId);
  else if (["deployed", "failed"].includes(batch.status)) assertPublicDeploymentTerminalBatchStructure(batch, identity.buildBatchId);
  else if (batch.status === "cancelled") assertPublicDeploymentCancelledBatch(batch, identity.buildBatchId);
  else assertPublicDeploymentLeaseBatch(batch, identity.buildBatchId);
  return projectPublicBuildReservation(batch, identity.buildBatchId);
}

// The operator proves the original Actions failure before calling this owner.
// No absence-only or ordinary workflow cleanup path may invoke settlement.
async function settleDevPreuploadFailure(db, request, { readOnly = false } = {}) {
  assertDevDatabase(db);
  preupload.parseDevPreuploadSettlement(request);
  const { identity, generation, inputDigest, failure } = request;
  if (hash(`dev-code-refresh:${failure.runId}`).slice(0, 20) !== identity.queueId) preupload.refuse();
  const queueRef = db.doc(`cmsPublishQueue/${identity.queueId}`);
  const batchRef = publicBuildBatchRef(db, identity.buildBatchId);
  const receiptRef = batchRef.collection("retirements").doc("devPreupload");
  await db.runTransaction(async transaction => {
    const [legacy, queueRow, batchRow, candidate, inputRow, pointerRow, manifest, verification, receiptRow] = await transaction.getAll(
      db.doc("system/devPublication"), queueRef, batchRef, publicWorkerCandidateRef(db, identity.buildBatchId),
      inputRef(db, identity), publicDeploymentRef(db), batchRef.collection("manifests").doc("publicMedia"),
      batchRef.collection("manifests").doc("publicMedia").collection("verifications").doc("complete"), receiptRef);
    await require("../../functions/lib/public-release-writer-fence").assertNoReleaseWriterInTransaction({ firestore: db, transaction });
    if (legacy.exists || !queueRow.exists || !batchRow.exists || !inputRow.exists || !pointerRow.exists ||
        candidate.exists || manifest.exists || verification.exists) preupload.refuse();
    const pointer = assertPublicDeploymentPointer(pointerRow.data());
    if (pointer.state !== "idle") preupload.refuse();
    const queue = queueRow.data(), batch = batchRow.data(), input = inputRow.data();
    const runtime = queueRuntime(queue, identity);
    assertPublicationOwner(batch, runtime);
    assertFrozenInput(input, identity);
    if (input.inputDigest !== inputDigest) preupload.refuse();
    if (batch.status === "retired") {
      preupload.assertDevPreuploadRetiredBatch(batch, identity.buildBatchId);
      const receipt = batch.retirementReceipt;
      const { preUploadFailureReceiptDigest, ...originalQueue } = queue;
      if (!isDeepStrictEqual(receipt.request, request) || !receiptRow.exists ||
          !isDeepStrictEqual(receiptRow.data(), { ...receipt, retiredAt: batch.retiredAt }) ||
          queue.status !== "failed" || queue.error !== preupload.FAILURE ||
          !isDeepStrictEqual(queue.completedAt, batch.retiredAt) || preUploadFailureReceiptDigest !== publicReleaseDigest(receipt) ||
          receipt.originalQueueDigest !== publicReleaseDigest({ ...originalQueue, status: "pending", error: null, completedAt: null }) ||
          receipt.originalInputDigest !== publicReleaseDigest(input)) preupload.refuse();
      return;
    }
    if (readOnly || receiptRow.exists) preupload.refuse();
    assertPublicDeploymentReservedBatch(batch, identity.buildBatchId);
    exact(queue, ["status", "transport", "environment", "projectId", "triggeredBy", "triggeredByEmail", "triggeredAt",
      "completedAt", "error", "changes", "runtime", "artifactBuild"]);
    const reservation = projectPublicBuildReservation(batch, identity.buildBatchId);
    if (queue.status !== "pending" || queue.triggeredBy !== "dev-code-refresh" || queue.triggeredByEmail !== null ||
        queue.changes.length !== 0 || queue.completedAt !== null || queue.error !== null ||
        batch.noBuildStaticInput !== undefined || reservation.generation !== generation || reservation.commitSha !== identity.commitSha ||
        !isDeepStrictEqual(queue.artifactBuild, { buildBatchId: identity.buildBatchId, generation,
          commitSha: identity.commitSha, cutoffAt: batch.cutoffAt }) ||
        pointer.lastReservedGeneration < generation || pointer.activeGeneration === generation ||
        pointer.newestEligibleGeneration === generation || pointer.newestEligibleBuildBatchId === identity.buildBatchId ||
        !Number.isFinite(input.recordedAt?.toMillis?.()) || input.recordedAt.toMillis() < batch.reservedAt.toMillis() ||
        input.recordedAt.toMillis() > Date.parse(failure.completedAt)) preupload.refuse();
    const receipt = { schemaVersion: 1, reason: preupload.REASON, outcome: "failed_not_published", request,
      requestDigest: publicReleaseDigest(request), originalQueueDigest: publicReleaseDigest(queue),
      originalBatchDigest: publicReleaseDigest(batch), originalInputDigest: publicReleaseDigest(input) };
    const retiredAt = FieldValue.serverTimestamp();
    transaction.create(receiptRef, { ...receipt, retiredAt });
    transaction.update(batchRef, { status: "retired", retiredAt, retirementReceipt: receipt });
    transaction.update(queueRef, { status: "failed", error: preupload.FAILURE, completedAt: retiredAt,
      preUploadFailureReceiptDigest: publicReleaseDigest(receipt) });
  }, readOnly ? { readOnly: true } : {});
  return (await receiptRef.get()).data();
}

// The legacy journal is never drained, reset or adopted by the new adapter.
// Migration must prove all legacy work terminal before removal.
async function readDevPublication(db, identity) {
  assertDevDatabase(db);
  assertIdentity(identity);
  return db.runTransaction(async transaction => {
    const [legacy, queueRow, batchRow, candidateRow, inputRow, pointerRow] = await transaction.getAll(
      db.doc("system/devPublication"), db.collection("cmsPublishQueue").doc(identity.queueId),
      publicBuildBatchRef(db, identity.buildBatchId), publicWorkerCandidateRef(db, identity.buildBatchId),
      inputRef(db, identity), publicDeploymentRef(db));
    if (legacy.exists) throw new Error("The legacy development publication journal requires a drained-state migration after all work is terminal");
    const queue = queueRow.exists ? assertDevQueue(queueRow.data()) : null;
    const runtime = queue ? queueRuntime(queue, identity) : null;
    const batch = batchRow.exists ? batchRow.data() : null;
    if (batch) {
      assertPublicationOwner(batch, runtime);
      const reservation = batchReservation(batch, identity);
      if (reservation.commitSha !== identity.commitSha) throw new Error("Retained dev batch conflicts");
    }
    const candidate = candidateRow.exists ? projectPublicWorkerCandidate(candidateRow.data(), identity.buildBatchId,
      { target: PUBLICATION_TARGET }) : null;
    const input = inputRow.exists ? inputRow.data() : null;
    if (input) assertFrozenInput(input, identity);
    return { queue, runtime, batch, candidate, input,
      pointer: pointerRow.exists ? assertPublicDeploymentPointer(pointerRow.data()) : null };
  }, { readOnly: true });
}

async function reserveDevPublication(db, identity) {
  const current = await readDevPublication(db, identity);
  if (!current.queue) throw new Error("The development publication queue is missing");
  if (current.queue.status === "success") return null;
  if (current.input) throw new Error("Use the retained frozen inputs; do not reread CMS on retry");
  return reserveCmsPublishArtifact({ firestore: db, ...identity, runtime: current.runtime, target: PUBLICATION_TARGET });
}

function assertDevPublicationUnreserved(current) {
  if (current.queue?.artifactBuild || current.batch || current.candidate || current.input) {
    throw new Error("Missing retained dev input after reservation requires an owner decision");
  }
}

async function recordDevInputs(db, identity, inputDigest) {
  const current = await readDevPublication(db, identity);
  if (!/^[a-f0-9]{64}$/.test(inputDigest ?? "") || !current.batch || !current.queue) {
    throw new Error("Invalid frozen dev inputs");
  }
  const expected = { schemaVersion: 1, ...identity, inputDigest };
  await db.runTransaction(async transaction => {
    const [legacy, queueRow, batchRow, inputRow] = await transaction.getAll(db.doc("system/devPublication"),
      db.collection("cmsPublishQueue").doc(identity.queueId), publicBuildBatchRef(db, identity.buildBatchId), inputRef(db, identity));
    if (legacy.exists) throw new Error("The legacy development publication journal requires a drained-state migration after all work is terminal");
    const runtime = queueRuntime(queueRow.data(), identity);
    assertPublicationOwner(batchRow.data(), runtime);
    const reservation = projectPublicBuildReservation(batchRow.data(), identity.buildBatchId);
    if (reservation.commitSha !== identity.commitSha || queueRow.data().artifactBuild?.generation !== reservation.generation) {
      throw new Error("Retained dev batch conflicts");
    }
    if (inputRow.exists) {
      const { recordedAt, ...stored } = inputRow.data();
      if (!isDeepStrictEqual(stored, expected)) throw new Error("Retained dev input conflicts");
      return;
    }
    transaction.create(inputRef(db, identity), { ...expected, recordedAt: FieldValue.serverTimestamp() });
  });
}

async function recordDevCandidate(db, identity, { inventory, publication, version, wranglerVersion, inputDigest, staticProof }) {
  const current = await readDevPublication(db, identity);
  if (!current.batch || current.input?.inputDigest !== inputDigest || !queueIncludesArtifact(current.queue, inventory) ||
      publication.artifactReceiptDigest !== hash(JSON.stringify(inventory)) ||
      version.noBuildPost?.schemaVersion !== 2 || version.noBuildPost.rendererSha !== identity.commitSha) {
    throw new Error("Development candidate does not match its frozen artifact");
  }
  const manifest = createPublicMediaManifest({ reservation: projectPublicBuildReservation(current.batch, identity.buildBatchId),
    artifactInventory: inventory.families.map(family => ({ collection: family.collection, complete: family.complete,
      documentIds: family.artifacts.map(artifact => artifact.documentId) })), owners: inventory.owners });
  if (manifest.mediaManifestDigest !== publication.mediaManifestDigest || manifest.mediaManifestDigest !== inventory.mediaManifestDigest) {
    throw new Error("Development media manifest differs");
  }
  const candidate = projectPublicWorkerCandidateInput({ ...runtimeFields(current.runtime), schemaVersion: 1,
    buildBatchId: identity.buildBatchId, generation: inventory.generation, commitSha: identity.commitSha,
    workerName: PUBLICATION_TARGET.workerName, workerVersionId: version.workerVersionId,
    workerVersionTag: publicWorkerCandidateTag(publication), versionCreatedOn: version.versionCreatedOn,
    artifactDigest: publication.artifactDigest, artifactReceiptDigest: publication.artifactReceiptDigest,
    publicationReceiptDigest: publication.publicationReceiptDigest, mediaManifestDigest: publication.mediaManifestDigest,
    artifactFileCount: publication.artifactFileCount, artifactBytes: publication.artifactBytes,
    wranglerVersion, noBuildPost: version.noBuildPost,
    ...(version.noBuildPage ? { noBuildPage: version.noBuildPage } : {}),
    ...(version.noBuildRecord ? { noBuildRecord: version.noBuildRecord } : {}),
    ...(staticProof ? { noBuildStatic: staticProof } : {}) }, { target: PUBLICATION_TARGET });
  await recordCmsPublishArtifactInclusion({ firestore: db, queueId: identity.queueId, artifactReceipt: inventory,
    runtime: current.runtime, target: PUBLICATION_TARGET });
  await stagePublicMediaManifest({ firestore: db, manifest });
  await markPublicMediaManifestReady({ firestore: db, manifest });
  return (await recordPublicWorkerCandidate({ firestore: db, candidate, runtime: current.runtime, target: PUBLICATION_TARGET })).candidate;
}

async function acquireDevDeploymentLease(db, identity) {
  const current = await readDevPublication(db, identity);
  return acquirePublicDeploymentLease({ firestore: db, buildBatchId: identity.buildBatchId, commitSha: identity.commitSha,
    runtime: current.runtime, target: PUBLICATION_TARGET });
}
async function settleDevDeploymentOutcome(db, identity, lease, evidence) {
  const current = await readDevPublication(db, identity);
  return settlePublicDeploymentOutcome({ firestore: db, lease, evidence, runtime: current.runtime, target: PUBLICATION_TARGET });
}

// Terminal queue writeback consumes the generic outcome. This adapter never
// promotes a pointer, fabricates batch readiness or owns a second activation.
async function finishDevPublication(db, identity, { timeoutOutcome = null } = {}) {
  const current = await readDevPublication(db, identity);
  if (!current.queue || !current.batch) return "unclaimed";
  // The ordinary finalize/fail cleanup cannot undo a failed-queue refusal.
  // Only the verified recovery path supplies the original deployed outcome.
  if (current.queue.status === "failed") {
    if (!timeoutOutcome) return "unclaimed";
    assertTimedOutDevTerminal({ ...current, outcome: timeoutOutcome });
  }
  if (current.batch.status === "deployed") {
    return (await settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: identity.queueId,
      runtime: current.runtime, target: PUBLICATION_TARGET, devQueueMode: timeoutOutcome ? "timeout" : "ordinary" })).outcome;
  }
  if (["deploying", "reconciling"].includes(current.batch.status)) {
    const outcome = await settleDevDeploymentOutcome(db, identity,
      projectPublicDeploymentLease(current.batch, identity.buildBatchId), { action: "reconcile" });
    if (outcome.outcome === "deployed") return finishDevPublication(db, identity);
    return outcome.outcome;
  }
  // A pre-lease failure preserves reservation/candidate evidence. Cancellation
  // needs its existing authorized generic owner; a workflow cleanup cannot invent it.
  return current.queue.status === "success" ? "success" : "unclaimed";
}

function assertDevReconcileSource({ identity, generation, workerVersionId, batch, candidate, queue, inventory, input }) {
  assertIdentity(identity);
  const runtime = queueRuntime(queue, identity);
  assertPublicationOwner(batch, runtime);
  const reservation = batchReservation(batch, identity);
  assertFrozenInput(input, identity);
  const missingCandidate = candidate === null || candidate === undefined;
  if (!missingCandidate) {
    candidate = projectPublicWorkerCandidate(candidate, identity.buildBatchId, { target: PUBLICATION_TARGET });
    assertPublicationOwner(candidate, runtime);
  }
  if (!Number.isSafeInteger(generation) || generation < 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workerVersionId ?? "") ||
      !(missingCandidate ? ["reserved", "ready"] : ["ready", "deploying", "reconciling", "deployed"]).includes(batch.status) ||
      !queueIncludesArtifact(queue, inventory) ||
      (!missingCandidate && (candidate.workerName !== TARGET.workerName || candidate.workerVersionId !== workerVersionId ||
        candidate.noBuildPost?.schemaVersion !== 2 || candidate.noBuildPost.rendererSha !== identity.commitSha)) ||
      reservation.generation !== generation || inventory.generation !== generation ||
      [queue.artifactBuild, inventory, ...(missingCandidate ? [] : [candidate])].some(value => value?.buildBatchId !== identity.buildBatchId ||
        value.commitSha !== identity.commitSha || value.generation !== generation)) {
    throw new Error("Dev reconciliation requires the exact generic queue, batch and candidate");
  }
  return runtime;
}

function assertDevReconcileInputs(input) {
  assertDevReconcileSource(input);
  const { queue, batch } = input;
  if (queue.status === "failed") {
    assertTimedOutDevTerminal(input);
  } else if (!["pending", "publishing", "success"].includes(queue.status) ||
      queue.status === "success" && batch.status !== "deployed") {
    throw new Error("Dev reconciliation requires the exact generic queue, batch and candidate");
  }
}

function assertTimedOutDevTerminal({ queue, batch, candidate, outcome }) {
  if (queue.error !== STALE_PUBLISH_ERROR || batch.status !== "deployed" || !outcome)
    throw new Error("Dev timeout recovery requires the exact deployed receipt");
  // The same owner alignment guard is repeated by writeback in its original
  // transaction, together with the exact timeout reason from the actual row.
  const runtime = queueRuntime(queue, { commitSha: batch.commitSha });
  assertTerminalAlignment({ queue, batch, candidate, outcome, runtime, target: PUBLICATION_TARGET });
}

// This permits verification of an existing lease only. It cannot admit a failed
// queue to writeback; assertDevReconcileInputs requires its deployed outcome.
function prepareTimedOutDevReconciliation(input) {
  assertDevReconcileSource(input);
  const { identity, queue, batch, candidate, inventory, publication } = input;
  if (queue.status !== "failed" || queue.error !== STALE_PUBLISH_ERROR || !candidate ||
      !["deploying", "reconciling", "deployed"].includes(batch.status) ||
      publication?.artifactReceiptDigest !== hash(JSON.stringify(inventory)) ||
      ["buildBatchId", "generation", "commitSha", "artifactDigest", "artifactReceiptDigest",
        "publicationReceiptDigest", "mediaManifestDigest", "artifactFileCount", "artifactBytes"]
        .some(key => candidate[key] !== publication[key])) {
    throw new Error("Dev timeout recovery requires the original retained candidate");
  }
  return batch.status === "deployed" ? terminalLease(batch) : projectPublicDeploymentLease(batch, identity.buildBatchId);
}

module.exports = { TARGET, hash, assertDevTarget, assertDevDatabase, assertDevQueue, assertIdentity,
  selectDevPublicationSource,
  readDevPublication, reserveDevPublication, recordDevInputs, recordDevCandidate,
  assertDevPublicationUnreserved,
  acquireDevDeploymentLease, settleDevDeploymentOutcome, finishDevPublication, assertDevReconcileInputs,
  prepareTimedOutDevReconciliation, settleDevPreuploadFailure };

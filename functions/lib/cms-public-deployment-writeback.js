"use strict";

// Durable queue evidence for an already-built and already-activated public
// Worker artifact. This module has no handler, listener, workflow, transport,
// credential, environment, or automatic caller.

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { runtimeFields, assertPublicationOwner } = require("./publication-runtime-owner");
const { publicationTarget, assertPublicationTarget } = require("./publication-target");
const {
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  assertPublicWorkerCandidateMatchesBatch,
  assertPublicWorkerCandidateDatabase,
} = require("./public-worker-candidate");
const {
  settlePublicDeploymentOutcome,
} = require("./public-deployment-outcome-store");
const {
  queueIncludesArtifact,
  timestampParts,
} = require("./cms-publish-artifact");
const { settleBuildQueue } = require("./publish-build-state");
const { STALE_PUBLISH_ERROR } = require("./publish-reconcile");

const QUEUE_COLLECTION = "cmsPublishQueue";
const INCLUSION_SCHEMA_VERSION = 1;
const DEPLOYMENT_PROVIDER = "cloudflare-workers";
const DIGEST = /^[a-f0-9]{64}$/;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INCLUSION_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "artifactReceiptDigest",
  "recordedAt",
]);
const DEPLOYMENT_RECEIPT_FIELDS = new Set([
  "provider",
  "queueId",
  "buildBatchId",
  "generation",
  "commitSha",
  "deploymentId",
  "versionId",
  "publicUrl",
  "visibleAt",
  "publishToVisibleMs",
]);

function writebackError(message) {
  throw new Error(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    writebackError("firestore is required");
  }
}

function assertQueueId(queueId) {
  if (!QUEUE_ID.test(queueId ?? "")) {
    writebackError("The CMS publish queue id is invalid");
  }
  return queueId;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function projectQueueArtifactBuild(value) {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== 4 ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    timestampMillis(value.cutoffAt) === null
  ) {
    writebackError("The CMS publish queue artifact build is invalid");
  }
  return {
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt: value.cutoffAt,
  };
}

function sameArtifactBuild(left, right) {
  const leftCutoff = timestampParts(left.cutoffAt);
  const rightCutoff = timestampParts(right.cutoffAt);
  return Boolean(
    leftCutoff &&
      rightCutoff &&
      left.buildBatchId === right.buildBatchId &&
      left.generation === right.generation &&
      left.commitSha === right.commitSha &&
      leftCutoff.seconds === rightCutoff.seconds &&
      leftCutoff.nanoseconds === rightCutoff.nanoseconds
  );
}

function projectInclusionReceipt(value) {
  if (
    !hasExactFields(value, INCLUSION_FIELDS) ||
    value.schemaVersion !== INCLUSION_SCHEMA_VERSION ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    timestampMillis(value.cutoffAt) === null ||
    !DIGEST.test(value.artifactReceiptDigest) ||
    timestampMillis(value.recordedAt) === null ||
    timestampMillis(value.recordedAt) < timestampMillis(value.cutoffAt)
  ) {
    writebackError("The CMS publish artifact inclusion receipt is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt: value.cutoffAt,
    artifactReceiptDigest: value.artifactReceiptDigest,
    recordedAt: value.recordedAt,
  };
}

function inclusionMatchesBuild(inclusion, build) {
  return sameArtifactBuild(inclusion, build);
}

function inclusionProjection(build, artifactReceiptDigest) {
  return {
    schemaVersion: INCLUSION_SCHEMA_VERSION,
    buildBatchId: build.buildBatchId,
    generation: build.generation,
    commitSha: build.commitSha,
    cutoffAt: build.cutoffAt,
    artifactReceiptDigest,
  };
}

function inclusionWithoutTimestamp(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== "recordedAt"),
  );
}

async function recordCmsPublishArtifactInclusion({
  firestore,
  queueId,
  artifactReceipt,
  runtime,
  target,
}) {
  assertFirestore(firestore);
  assertPublicWorkerCandidateDatabase(firestore, target);
  assertQueueId(queueId);
  const artifactReceiptDigest = sha256Json(artifactReceipt);
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const result = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(queueRef);
    if (!snapshot.exists) {
      writebackError(`Publish queue ${queueId} was not found`);
    }
    const queue = snapshot.data();
    assertPublicationOwner(queue, runtime ?? { owner: "node-compute", release: artifactReceipt?.commitSha });
    if (!queueIncludesArtifact(queue, artifactReceipt)) {
      writebackError(
        `Publish queue ${queueId} artifact receipt does not include its revisions`,
      );
    }
    const build = projectQueueArtifactBuild(queue.artifactBuild);
    const expected = inclusionProjection(build, artifactReceiptDigest);
    if (queue.artifactInclusion !== undefined) {
      const stored = projectInclusionReceipt(queue.artifactInclusion);
      if (!isDeepStrictEqual(inclusionWithoutTimestamp(stored), expected)) {
        writebackError(`Publish queue ${queueId} artifact inclusion conflicts`);
      }
      return { idempotent: true, receipt: stored };
    }
    if (!["pending", "publishing"].includes(queue.status)) {
      writebackError(`Publish queue ${queueId} is already ${String(queue.status)}`);
    }
    transaction.update(queueRef, {
      artifactInclusion: {
        ...expected,
        recordedAt: FieldValue.serverTimestamp(),
      },
    });
    return { idempotent: false, receipt: null };
  });
  if (result.receipt) return result;
  const snapshot = await queueRef.get();
  const receipt = projectInclusionReceipt(snapshot.data()?.artifactInclusion);
  const expected = inclusionProjection(
    projectQueueArtifactBuild(snapshot.data()?.artifactBuild),
    artifactReceiptDigest,
  );
  if (!isDeepStrictEqual(inclusionWithoutTimestamp(receipt), expected)) {
    writebackError(`Publish queue ${queueId} artifact inclusion conflicts`);
  }
  return { idempotent: false, receipt };
}

function terminalLease(batch) {
  return {
    ...runtimeFields(batch.runtime),
    schemaVersion: batch.schemaVersion,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    leaseToken: batch.leaseToken,
    leaseAcquiredAt: batch.leaseAcquiredAt,
    predecessorGeneration: batch.predecessorGeneration,
    predecessorDeploymentId: batch.predecessorDeploymentId,
    predecessorCommitSha: batch.predecessorCommitSha,
  };
}

function terminalEvidence(batch) {
  return {
    action: "activate",
    buildBatchId: batch.buildBatchId,
    deploymentId: batch.deploymentId,
    versionId: batch.deploymentVersionId,
    commitSha: batch.commitSha,
  };
}

function projectDeploymentReceipt(value, { target = publicationTarget() } = {}) {
  target = assertPublicationTarget(target);
  if (
    !hasExactFields(value, DEPLOYMENT_RECEIPT_FIELDS) ||
    value.provider !== DEPLOYMENT_PROVIDER ||
    !QUEUE_ID.test(value.queueId ?? "") ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    !CLOUDFLARE_UUID.test(value.deploymentId ?? "") ||
    !CLOUDFLARE_UUID.test(value.versionId ?? "") ||
    value.publicUrl !== `${target.origin}/` ||
    timestampMillis(value.visibleAt) === null ||
    !Number.isSafeInteger(value.publishToVisibleMs) ||
    value.publishToVisibleMs < 0
  ) {
    writebackError("The CMS public deployment receipt is invalid");
  }
  return {
    provider: value.provider,
    queueId: value.queueId,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    deploymentId: value.deploymentId,
    versionId: value.versionId,
    publicUrl: value.publicUrl,
    visibleAt: value.visibleAt,
    publishToVisibleMs: value.publishToVisibleMs,
  };
}

function deploymentReceipt({ queueId, batch, outcome, triggeredAt, target }) {
  const expected = assertPublicationTarget(target ?? publicationTarget());
  const visibleAtMs = timestampMillis(batch.deployedAt);
  const triggeredAtMs = timestampMillis(triggeredAt);
  if (
    visibleAtMs === null ||
    triggeredAtMs === null ||
    visibleAtMs < triggeredAtMs
  ) {
    writebackError("The CMS public deployment timing receipt is invalid");
  }
  return projectDeploymentReceipt({
    provider: DEPLOYMENT_PROVIDER,
    queueId,
    buildBatchId: outcome.buildBatchId,
    generation: outcome.generation,
    commitSha: outcome.commitSha,
    deploymentId: outcome.deploymentId,
    versionId: outcome.versionId,
    publicUrl: `${expected.origin}/`,
    visibleAt: batch.deployedAt,
    publishToVisibleMs: visibleAtMs - triggeredAtMs,
  }, { target: expected });
}

function assertTerminalAlignment({ queue, batch, candidate, outcome, target, runtime }) {
  const executor = runtime ?? { owner: "node-compute", release: batch.commitSha };
  assertPublicationOwner(queue, executor);
  assertPublicationOwner(batch, executor);
  const build = projectQueueArtifactBuild(queue.artifactBuild);
  const inclusion = projectInclusionReceipt(queue.artifactInclusion);
  const projectedCandidate = assertPublicWorkerCandidateMatchesBatch(
    candidate,
    batch,
    { target },
  );
  if (
    !inclusionMatchesBuild(inclusion, build) ||
    inclusion.artifactReceiptDigest !==
      projectedCandidate.artifactReceiptDigest ||
    batch.status !== "deployed" ||
    batch.buildBatchId !== outcome.buildBatchId ||
    batch.generation !== outcome.generation ||
    batch.commitSha !== outcome.commitSha ||
    batch.deploymentId !== outcome.deploymentId ||
    batch.deploymentVersionId !== outcome.versionId ||
    projectedCandidate.workerVersionId !== outcome.versionId ||
    timestampMillis(batch.deployedAt) === null
  ) {
    writebackError("The CMS public deployment terminal evidence is invalid");
  }
}

function assertDevQueueMode(queue, mode, target) {
  if (mode === undefined) return;
  if (!["ordinary", "timeout"].includes(mode) ||
      assertPublicationTarget(target ?? publicationTarget()).environment !== "development" ||
      mode === "ordinary" && queue.status === "failed" ||
      mode === "timeout" && queue.status !== "success" &&
        (queue.status !== "failed" || queue.error !== STALE_PUBLISH_ERROR)) {
    writebackError("The development queue recovery state is invalid");
  }
}

async function settleCmsPublishQueueFromPublicDeployment({
  firestore,
  queueId,
  runtime,
  target,
  devQueueMode,
}) {
  assertFirestore(firestore);
  assertPublicWorkerCandidateDatabase(firestore, target);
  assertQueueId(queueId);
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const initialQueueSnapshot = await queueRef.get();
  if (!initialQueueSnapshot.exists) {
    writebackError(`Publish queue ${queueId} was not found`);
  }
  const initialQueue = initialQueueSnapshot.data();
  assertDevQueueMode(initialQueue, devQueueMode, target);
  const build = projectQueueArtifactBuild(initialQueue.artifactBuild);
  const executor = runtime ?? { owner: "node-compute", release: build.commitSha };
  assertPublicationOwner(initialQueue, executor);
  const batchRef = publicBuildBatchRef(firestore, build.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(firestore, build.buildBatchId);
  const [batchSnapshot, candidateSnapshot] = await Promise.all([
    batchRef.get(),
    candidateRef.get(),
  ]);
  if (!batchSnapshot.exists || !candidateSnapshot.exists) {
    writebackError("The CMS public deployment terminal evidence is missing");
  }
  const batch = batchSnapshot.data();
  if (batch.status !== "deployed") {
    writebackError("The CMS public deployment is not deployed");
  }
  const terminal = await settlePublicDeploymentOutcome({
    firestore,
    lease: terminalLease(batch),
    evidence: terminalEvidence(batch),
    runtime,
    target,
  });
  if (terminal.outcome !== "deployed") {
    writebackError("The CMS public deployment is not deployed");
  }
  assertTerminalAlignment({
    queue: initialQueue,
    batch,
    candidate: candidateSnapshot.data(),
    outcome: terminal.receipt,
    runtime,
    target,
  });
  const receipt = deploymentReceipt({
    queueId,
    batch,
    outcome: terminal.receipt,
    triggeredAt: initialQueue.triggeredAt,
    target,
  });

  const settlement = await settleBuildQueue(firestore, {
    queueId,
    status: "success",
    returnResult: true,
    acceptQueue: (queue) => [
      "pending",
      "publishing",
      "failed",
      "cancelled",
      "success",
    ].includes(queue.status),
    preflight: async ({ transaction, queue }) => {
      assertDevQueueMode(queue, devQueueMode, target);
      const [currentBatchSnapshot, currentCandidateSnapshot] = await Promise.all([
        transaction.get(batchRef),
        transaction.get(candidateRef),
      ]);
      if (!currentBatchSnapshot.exists || !currentCandidateSnapshot.exists) {
        writebackError("The CMS public deployment terminal evidence is missing");
      }
      assertTerminalAlignment({
        queue,
        batch: currentBatchSnapshot.data(),
        candidate: currentCandidateSnapshot.data(),
        outcome: terminal.receipt,
        runtime,
        target,
      });
    },
    queueUpdate: {
      status: "success",
      completedAt: FieldValue.serverTimestamp(),
      error: FieldValue.delete(),
      gitCommitSha: receipt.commitSha,
      deploymentReceipt: receipt,
    },
  });
  if (!settlement.settled) {
    writebackError(`Publish queue ${queueId} could not be settled`);
  }
  if (settlement.idempotent) {
    const finalQueue = (await queueRef.get()).data();
    return {
      outcome: "success",
      idempotent: true,
      receipt: projectDeploymentReceipt(finalQueue?.deploymentReceipt, { target }),
    };
  }
  return { outcome: "success", idempotent: false, receipt };
}

module.exports = {
  assertTerminalAlignment,
  terminalLease,
  projectDeploymentReceipt,
  projectInclusionReceipt,
  recordCmsPublishArtifactInclusion,
  settleCmsPublishQueueFromPublicDeployment,
};

"use strict";

// Guarded Firestore state transition for the one empty serializer baseline
// used before the full apex moves to the public Worker. Provider observation
// and the local token-journal clear remain in the operator.

const {
  BASELINE_ACTOR,
  projectExactQueue,
} = require("./cms-publication-baseline");
const { timestampParts } = require("./cms-publish-artifact");
const {
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentLeaseReceipt,
  assertPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  projectPublicDeploymentLease,
  timestampMillis,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  assertManifestCompletion,
  assertPublicDeploymentTerminalBatch,
} = require("./public-deployment-outcome-store");
const {
  publicDeploymentCloudflareEvidenceDigest,
} = require("./public-deployment-cloudflare");
const {
  publicMediaManifestRef,
  publicMediaManifestVerificationRef,
} = require("./public-media-manifest-store");
const {
  assertPublicWorkerCandidateMatchesBatch,
} = require("./public-worker-candidate");
const { projectClaim } = require("./cms-publication-serializer");
const {
  projectInclusionReceipt,
} = require("./cms-public-deployment-writeback");

const RETIREMENT_SCHEMA_VERSION = 1;
const RETIREMENT_REASON = "source_superseded_before_apex_cutover";
const RETIREMENT_ERROR =
  "Pre-cutover baseline retired before apex publication.";
const RETIREMENT_ACTION = "cms-publication-baseline.retire";
const RETIREMENT_SOURCE = "cms-publication-baseline-retirement";
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ARTIFACT_BUILD_FIELDS = new Set([
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
]);
const RETIREMENT_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "reason",
  "queueId",
  "buildBatchId",
  "generation",
  "commitSha",
  "deploymentId",
  "versionId",
  "retiredAt",
]);

class CmsPublicationBaselineRetirementError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationBaselineRetirementError";
  }
}

function retirementError(message) {
  throw new CmsPublicationBaselineRetirementError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function sameTimestamp(left, right) {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  return Boolean(
    leftParts &&
      rightParts &&
      leftParts.seconds === rightParts.seconds &&
      leftParts.nanoseconds === rightParts.nanoseconds,
  );
}

function assertInput(expected) {
  if (
    !plainObject(expected) ||
    !QUEUE_ID.test(expected.queueId ?? "") ||
    expected.buildBatchId !== `cms-${expected.queueId}` ||
    !isPublicDeploymentIdentifier(expected.buildBatchId) ||
    !Number.isSafeInteger(expected.generation) ||
    expected.generation < 1 ||
    !isCommitSha(expected.commitSha) ||
    !CLOUDFLARE_UUID.test(expected.deploymentId ?? "") ||
    !CLOUDFLARE_UUID.test(expected.versionId ?? "") ||
    !SERIALIZER_ID.test(expected.serializerId ?? "") ||
    (expected.claimTokenDigest !== null &&
      !TOKEN_DIGEST.test(expected.claimTokenDigest ?? ""))
  ) {
    retirementError("The CMS publication baseline retirement input is invalid");
  }
  return Object.freeze({
    ...expected,
    deploymentId: expected.deploymentId.toLowerCase(),
    versionId: expected.versionId.toLowerCase(),
  });
}

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    retirementError("Firestore is required for baseline retirement");
  }
}

function projectArtifactBuild(value, expected) {
  if (
    !hasExactFields(value, ARTIFACT_BUILD_FIELDS) ||
    value.buildBatchId !== expected.buildBatchId ||
    value.generation !== expected.generation ||
    value.commitSha !== expected.commitSha ||
    timestampMillis(value.cutoffAt) === null
  ) {
    retirementError("The CMS publication baseline artifact build is invalid");
  }
  return Object.freeze({ ...value });
}

function projectRetirementReceipt(value, expected) {
  if (
    !hasExactFields(value, RETIREMENT_RECEIPT_FIELDS) ||
    value.schemaVersion !== RETIREMENT_SCHEMA_VERSION ||
    value.reason !== RETIREMENT_REASON ||
    value.queueId !== expected.queueId ||
    value.buildBatchId !== expected.buildBatchId ||
    value.generation !== expected.generation ||
    value.commitSha !== expected.commitSha ||
    value.deploymentId !== expected.deploymentId ||
    value.versionId !== expected.versionId ||
    timestampMillis(value.retiredAt) === null
  ) {
    retirementError("The CMS publication baseline retirement receipt is invalid");
  }
  return Object.freeze({ ...value });
}

function projectQueue(snapshot, expected, batch, candidate) {
  let queue;
  try {
    queue = projectExactQueue(snapshot, {
      queueId: expected.queueId,
      commitSha: expected.commitSha,
    });
  } catch {
    retirementError("The CMS publication baseline queue is invalid");
  }
  if (!queue || !["publishing", "cancelled"].includes(queue.status)) {
    retirementError("The CMS publication baseline queue is not retireable");
  }
  let claim;
  let inclusion;
  try {
    claim = projectClaim(queue.serializerClaim);
    inclusion = projectInclusionReceipt(queue.artifactInclusion);
  } catch {
    retirementError("The CMS publication baseline queue evidence is invalid");
  }
  const build = projectArtifactBuild(queue.artifactBuild, expected);
  if (
    claim.serializerId !== expected.serializerId ||
    claim.buildBatchId !== expected.buildBatchId ||
    claim.commitSha !== expected.commitSha ||
    inclusion.buildBatchId !== build.buildBatchId ||
    inclusion.generation !== build.generation ||
    inclusion.commitSha !== build.commitSha ||
    !sameTimestamp(build.cutoffAt, batch.cutoffAt) ||
    !sameTimestamp(inclusion.cutoffAt, build.cutoffAt) ||
    inclusion.artifactReceiptDigest !== candidate.artifactReceiptDigest
  ) {
    retirementError("The CMS publication baseline queue evidence conflicts");
  }
  if (
    expected.claimTokenDigest !== null &&
    claim.tokenDigest !== expected.claimTokenDigest
  ) {
    retirementError("The CMS publication baseline journal token conflicts");
  }
  if (queue.status === "publishing") {
    if (
      expected.claimTokenDigest === null ||
      queue.completedAt !== null ||
      queue.error !== null ||
      Object.hasOwn(queue, "baselineRetirementReceipt") ||
      Object.hasOwn(queue, "deploymentReceipt")
    ) {
      retirementError("The CMS publication baseline queue is not retireable");
    }
    return Object.freeze({ queue, claim, build, inclusion, receipt: null });
  }
  const receipt = projectRetirementReceipt(
    queue.baselineRetirementReceipt,
    expected,
  );
  if (
    queue.error !== RETIREMENT_ERROR ||
    queue.gitCommitSha !== expected.commitSha ||
    Object.hasOwn(queue, "deploymentReceipt") ||
    !sameTimestamp(queue.completedAt, receipt.retiredAt)
  ) {
    retirementError("The CMS publication baseline retirement receipt conflicts");
  }
  return Object.freeze({ queue, claim, build, inclusion, receipt });
}

function terminalLease(batch) {
  const fields = {
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
  let projected;
  try {
    projected = assertPublicDeploymentLeaseReceipt(fields);
  } catch {
    retirementError("The CMS publication baseline deployment lease is invalid");
  }
  return projected;
}

function projectTargetState({
  pointerValue,
  batchValue,
  candidateValue,
  manifestValue,
  verificationValue,
}, expected) {
  let pointer;
  let candidate;
  let manifest;
  try {
    pointer = assertPublicDeploymentPointer(pointerValue);
    candidate = assertPublicWorkerCandidateMatchesBatch(candidateValue, batchValue);
    manifest = assertManifestCompletion({
      batch: batchValue,
      header: manifestValue,
      verification: verificationValue,
    });
  } catch {
    retirementError("The CMS publication baseline deployment state is invalid");
  }
  if (
    pointer.mediaLifecycleReady !== false ||
    pointer.lastReservedGeneration !== expected.generation ||
    pointer.newestEligibleGeneration !== expected.generation ||
    pointer.newestEligibleBuildBatchId !== expected.buildBatchId ||
    batchValue.buildBatchId !== expected.buildBatchId ||
    batchValue.generation !== expected.generation ||
    batchValue.commitSha !== expected.commitSha ||
    candidate.workerVersionId !== expected.versionId ||
    candidate.mediaManifestDigest !== manifest.mediaManifestDigest
  ) {
    retirementError("The CMS publication baseline deployment state conflicts");
  }
  if (batchValue.status === "reconciling") {
    let lease;
    try {
      lease = projectPublicDeploymentLease(
        assertPublicDeploymentLeaseBatch(batchValue, expected.buildBatchId),
        expected.buildBatchId,
      );
    } catch {
      retirementError("The CMS publication baseline deployment lease is invalid");
    }
    if (
      pointer.state !== "reconciling" ||
      pointer.candidateBuildBatchId !== expected.buildBatchId ||
      pointer.candidateGeneration !== expected.generation ||
      pointer.candidateCommitSha !== expected.commitSha ||
      pointer.leaseToken !== lease.leaseToken ||
      !sameTimestamp(pointer.leaseAcquiredAt, lease.leaseAcquiredAt) ||
      pointer.cloudflareEvidenceDigest !== batchValue.cloudflareEvidenceDigest ||
      !sameTimestamp(pointer.reconcilingAt, batchValue.reconcilingAt)
    ) {
      retirementError("The CMS publication baseline deployment lease conflicts");
    }
    return Object.freeze({ phase: "reconciling", pointer, batch: batchValue, candidate, lease });
  }
  if (
    batchValue.status !== "deployed" ||
    pointer.state !== "idle" ||
    pointer.activeGeneration !== expected.generation ||
    pointer.activeDeploymentId !== expected.deploymentId ||
    pointer.activeCommitSha !== expected.commitSha ||
    batchValue.deploymentId !== expected.deploymentId ||
    batchValue.deploymentVersionId !== expected.versionId ||
    timestampMillis(batchValue.deployedAt) === null
  ) {
    retirementError("The CMS publication baseline is not the active deployment");
  }
  const lease = terminalLease(batchValue);
  try {
    const evidence = {
      action: "activate",
      buildBatchId: expected.buildBatchId,
      deploymentId: expected.deploymentId,
      versionId: expected.versionId,
      commitSha: expected.commitSha,
    };
    assertPublicDeploymentTerminalBatch({
      batch: batchValue,
      lease,
      evidence,
      evidenceDigest: publicDeploymentCloudflareEvidenceDigest(
        evidence,
        expected.buildBatchId,
      ),
      manifest,
    });
  } catch {
    retirementError("The CMS publication baseline terminal state is invalid");
  }
  return Object.freeze({
    phase: "deployed",
    pointer,
    batch: batchValue,
    candidate,
    lease,
  });
}

async function readCmsPublicationBaselineRetirementState({
  firestore,
  expected: expectedValue,
}) {
  assertFirestore(firestore);
  const expected = assertInput(expectedValue);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, expected.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(
    firestore,
    expected.buildBatchId,
  );
  const manifestRef = publicMediaManifestRef(
    firestore,
    expected.buildBatchId,
  );
  const verificationRef = publicMediaManifestVerificationRef(
    firestore,
    expected.buildBatchId,
  );
  const queueRef = firestore.collection("cmsPublishQueue").doc(expected.queueId);
  return firestore.runTransaction(async (transaction) => {
    const [
      pointerSnapshot,
      batchSnapshot,
      candidateSnapshot,
      manifestSnapshot,
      verificationSnapshot,
      queueSnapshot,
    ] = await transaction.getAll(
      pointerRef,
      batchRef,
      candidateRef,
      manifestRef,
      verificationRef,
      queueRef,
    );
    if (
      !pointerSnapshot.exists ||
      !batchSnapshot.exists ||
      !candidateSnapshot.exists ||
      !manifestSnapshot.exists ||
      !verificationSnapshot.exists ||
      !queueSnapshot.exists
    ) {
      retirementError("The CMS publication baseline retirement state is incomplete");
    }
    const target = projectTargetState({
      pointerValue: pointerSnapshot.data(),
      batchValue: batchSnapshot.data(),
      candidateValue: candidateSnapshot.data(),
      manifestValue: manifestSnapshot.data(),
      verificationValue: verificationSnapshot.data(),
    }, expected);
    const queue = projectQueue(
      queueSnapshot,
      expected,
      target.batch,
      target.candidate,
    );
    if (queue.receipt && target.phase !== "deployed") {
      retirementError("The retired CMS publication baseline is not active");
    }
    return Object.freeze({ ...target, queue });
  });
}

function auditEntry({ expected, before, after, timestamp }) {
  return {
    actorUid: BASELINE_ACTOR.uid,
    actorEmail: BASELINE_ACTOR.email,
    action: RETIREMENT_ACTION,
    target: `cmsPublishQueue/${expected.queueId}`,
    before,
    after,
    source: RETIREMENT_SOURCE,
    timestamp,
    at: new Date().toISOString(),
  };
}

async function retireCmsPublicationBaseline({
  firestore,
  expected: expectedValue,
  serverTimestamp,
}) {
  assertFirestore(firestore);
  if (typeof serverTimestamp !== "function") {
    retirementError(
      "A Firestore server timestamp is required for baseline retirement",
    );
  }
  const expected = assertInput(expectedValue);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, expected.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(
    firestore,
    expected.buildBatchId,
  );
  const manifestRef = publicMediaManifestRef(
    firestore,
    expected.buildBatchId,
  );
  const verificationRef = publicMediaManifestVerificationRef(
    firestore,
    expected.buildBatchId,
  );
  const queueRef = firestore.collection("cmsPublishQueue").doc(expected.queueId);

  return firestore.runTransaction(async (transaction) => {
    const [
      pointerSnapshot,
      batchSnapshot,
      candidateSnapshot,
      manifestSnapshot,
      verificationSnapshot,
      queueSnapshot,
    ] = await transaction.getAll(
      pointerRef,
      batchRef,
      candidateRef,
      manifestRef,
      verificationRef,
      queueRef,
    );
    if (
      !pointerSnapshot.exists ||
      !batchSnapshot.exists ||
      !candidateSnapshot.exists ||
      !manifestSnapshot.exists ||
      !verificationSnapshot.exists ||
      !queueSnapshot.exists
    ) {
      retirementError("The CMS publication baseline retirement state is incomplete");
    }
    const target = projectTargetState({
      pointerValue: pointerSnapshot.data(),
      batchValue: batchSnapshot.data(),
      candidateValue: candidateSnapshot.data(),
      manifestValue: manifestSnapshot.data(),
      verificationValue: verificationSnapshot.data(),
    }, expected);
    if (target.phase !== "deployed") {
      retirementError("The CMS publication baseline is not the active deployment");
    }
    const projectedQueue = projectQueue(
      queueSnapshot,
      expected,
      target.batch,
      target.candidate,
    );
    if (projectedQueue.receipt) {
      return Object.freeze({
        outcome: "cancelled",
        idempotent: true,
        receipt: projectedQueue.receipt,
      });
    }

    const timestamp = serverTimestamp();
    const receipt = {
      schemaVersion: RETIREMENT_SCHEMA_VERSION,
      reason: RETIREMENT_REASON,
      queueId: expected.queueId,
      buildBatchId: expected.buildBatchId,
      generation: expected.generation,
      commitSha: expected.commitSha,
      deploymentId: expected.deploymentId,
      versionId: expected.versionId,
      retiredAt: timestamp,
    };
    transaction.update(queueRef, {
      status: "cancelled",
      completedAt: timestamp,
      error: RETIREMENT_ERROR,
      gitCommitSha: expected.commitSha,
      baselineRetirementReceipt: receipt,
    });
    transaction.create(
      firestore.collection("admin_logs").doc(),
      auditEntry({
        expected,
        before: {
          status: projectedQueue.queue.status,
          buildBatchId: expected.buildBatchId,
          generation: expected.generation,
          commitSha: expected.commitSha,
        },
        after: {
          status: "cancelled",
          reason: RETIREMENT_REASON,
          activeGeneration: target.pointer.activeGeneration,
          activeDeploymentId: target.pointer.activeDeploymentId,
        },
        timestamp,
      }),
    );
    return Object.freeze({
      outcome: "cancelled",
      idempotent: false,
      receipt,
    });
  });
}

module.exports = {
  CmsPublicationBaselineRetirementError,
  RETIREMENT_ACTION,
  RETIREMENT_ERROR,
  RETIREMENT_REASON,
  readCmsPublicationBaselineRetirementState,
  retireCmsPublicationBaseline,
};

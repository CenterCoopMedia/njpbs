"use strict";

const { isDeepStrictEqual } = require("node:util");
const { runtimeFields, assertRuntimeSource } = require("./publication-runtime-owner");

const { PUBLIC_DEPLOYMENT_SCHEMA_VERSION, PublicDeploymentStateError, PublicDeploymentFenceError, assertPublishedMediaReadiness, assertMediaLifecycleDeploymentFence, plainObject, isPublicDeploymentIdentifier, isCommitSha, timestampMillis, hasOnlyFields, validDeploymentReceipt, initialPublicDeploymentPointer, assertPublicDeploymentPointer, readPublicDeploymentPointer } = require("./public-deployment-pointer");
const PUBLIC_BUILD_RESERVATION_FIELDS = [
  "runtime",
  "noBuildStaticInput",
  "schemaVersion",
  "buildBatchId",
  "generation",
  "status",
  "commitSha",
  "reservedAgainstGeneration",
  "reservedAgainstDeploymentId",
  "reservedAgainstCommitSha",
  "cutoffAt",
  "reservedAt",
];
const PUBLIC_BUILD_RESERVED_FIELDS = new Set(PUBLIC_BUILD_RESERVATION_FIELDS);
const PUBLIC_BUILD_READY_FIELDS = new Set([
  ...PUBLIC_BUILD_RESERVATION_FIELDS,
  "readyAt",
]);
const PUBLIC_BUILD_DEPLOYING_FIELDS = new Set([
  ...PUBLIC_BUILD_READY_FIELDS,
  "leaseToken",
  "leaseAcquiredAt",
  "predecessorGeneration",
  "predecessorDeploymentId",
  "predecessorCommitSha",
]);
const PUBLIC_BUILD_RECONCILING_FIELDS = new Set([
  ...PUBLIC_BUILD_DEPLOYING_FIELDS,
  "reconcilingAt",
  "cloudflareEvidenceDigest",
]);
const PUBLIC_BUILD_TERMINAL_BASE_FIELDS = new Set([
  ...PUBLIC_BUILD_DEPLOYING_FIELDS,
  "mediaManifestDigest",
  "cloudflareEvidenceDigest",
]);
const PUBLIC_BUILD_DEPLOYED_FIELDS = new Set([
  ...PUBLIC_BUILD_TERMINAL_BASE_FIELDS,
  "deployedAt",
  "deploymentId",
  "deploymentVersionId",
]);
const PUBLIC_BUILD_FAILED_FIELDS = new Set([
  ...PUBLIC_BUILD_TERMINAL_BASE_FIELDS,
  "failedAt",
  "terminalOutcome",
]);
const PUBLIC_BUILD_SUPERSEDED_FIELDS = new Set([
  ...PUBLIC_BUILD_READY_FIELDS,
  "supersededReason",
  "supersededAt",
  "supersededByGeneration",
  "supersededByBuildBatchId",
]);
const PUBLIC_BUILD_CANCELLED_FIELDS = new Set([
  ...PUBLIC_BUILD_RESERVATION_FIELDS,
  "cancelledReason",
  "cancelledAt",
  "cancellationReceipt",
]);
const PUBLIC_BUILD_CANCELLED_REASON = "source_superseded_before_candidate";
const PUBLIC_BUILD_CANCELLATION_RECEIPT_V1_FIELDS = new Set([
  "schemaVersion",
  "reason",
  "queueId",
  "buildBatchId",
  "generation",
  "queueCommitSha",
  "operatorCommitSha",
  "serializerId",
  "claimTokenDigest",
  "cutoffAt",
  "cancelledAt",
]);
const PUBLIC_BUILD_CANCELLATION_RECEIPT_FIELDS = new Set([
  ...PUBLIC_BUILD_CANCELLATION_RECEIPT_V1_FIELDS,
  "artifactReceiptDigest",
  "artifactInclusionRecordedAt",
]);
const DIGEST = /^[a-f0-9]{64}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PUBLIC_DEPLOYMENT_LEASE_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "leaseToken",
  "leaseAcquiredAt",
  "predecessorGeneration",
  "predecessorDeploymentId",
  "predecessorCommitSha",
]);
const TERMINAL_FAILURE_OUTCOMES = new Set([
  "fail",
  "cancelled",
  "terminated",
]);
const RESTORED_PREDECESSOR_FIELDS = new Set(["buildBatchId", "generation", "commitSha", "deploymentId", "versionId",
  "artifactDigest", "artifactReceiptDigest", "publicationReceiptDigest", "mediaManifestDigest"]);

function projectPublicDeploymentRestoreReceipt(value) {
  if (!plainObject(value) || Object.keys(value).length !== RESTORED_PREDECESSOR_FIELDS.size ||
      !hasOnlyFields(value, RESTORED_PREDECESSOR_FIELDS) || !isPublicDeploymentIdentifier(value.buildBatchId) ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || !isCommitSha(value.commitSha) ||
      !CLOUDFLARE_UUID.test(value.deploymentId ?? "") || !CLOUDFLARE_UUID.test(value.versionId ?? "") ||
      !["artifactDigest", "artifactReceiptDigest", "publicationReceiptDigest", "mediaManifestDigest"].every(field => DIGEST.test(value[field] ?? ""))) {
    throw new PublicDeploymentStateError("The restored predecessor receipt is invalid");
  }
  return Object.freeze(Object.fromEntries([...RESTORED_PREDECESSOR_FIELDS].map(field => [field, value[field]])));
}

function projectPublicBuildReservation(value, expectedBuildBatchId = null) {
  if (value?.status === "retired") {
    throw new PublicDeploymentStateError("The historical public reservation is retired");
  }
  if (
    !plainObject(value) ||
    value.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    (expectedBuildBatchId !== null &&
      value.buildBatchId !== expectedBuildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    !Number.isSafeInteger(value.reservedAgainstGeneration) ||
    value.reservedAgainstGeneration < 0 ||
    value.reservedAgainstGeneration >= value.generation ||
    (value.reservedAgainstGeneration === 0 &&
      (value.reservedAgainstDeploymentId !== null ||
        value.reservedAgainstCommitSha !== null)) ||
    (value.reservedAgainstGeneration > 0 &&
      (!isPublicDeploymentIdentifier(value.reservedAgainstDeploymentId) ||
        !isCommitSha(value.reservedAgainstCommitSha))) ||
    timestampMillis(value.cutoffAt) === null ||
    timestampMillis(value.reservedAt) === null
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment build batch is invalid",
    );
  }
  if (value.runtime !== undefined) assertRuntimeSource(value.runtime, value.commitSha);
  if (value.noBuildStaticInput !== undefined) require("./no-build-post-static-return").projectStaticInput(value.noBuildStaticInput);
  return Object.freeze({
    ...runtimeFields(value.runtime),
    schemaVersion: value.schemaVersion,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    reservedAgainstGeneration: value.reservedAgainstGeneration,
    reservedAgainstDeploymentId: value.reservedAgainstDeploymentId,
    reservedAgainstCommitSha: value.reservedAgainstCommitSha,
    cutoffAt: value.cutoffAt,
    reservedAt: value.reservedAt,
  });
}

function assertPublicDeploymentReservedBatch(
  value,
  expectedBuildBatchId = null,
) {
  projectPublicBuildReservation(value, expectedBuildBatchId);
  const cutoffAt = timestampMillis(value.cutoffAt);
  const reservedAt = timestampMillis(value.reservedAt);
  if (
    value.status !== "reserved" ||
    !hasOnlyFields(value, PUBLIC_BUILD_RESERVED_FIELDS) ||
    reservedAt < cutoffAt
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment build batch is invalid",
    );
  }
  return value;
}

function assertPublicDeploymentCancelledBatch(
  value,
  expectedBuildBatchId = null,
) {
  const reservation = projectPublicBuildReservation(
    value,
    expectedBuildBatchId,
  );
  const receipt = value?.cancellationReceipt;
  const receiptFields = receipt?.schemaVersion === 1
    ? PUBLIC_BUILD_CANCELLATION_RECEIPT_V1_FIELDS
    : PUBLIC_BUILD_CANCELLATION_RECEIPT_FIELDS;
  const inclusionBindingValid = receipt?.schemaVersion === 1 ||
    ((receipt?.artifactReceiptDigest === null &&
      receipt?.artifactInclusionRecordedAt === null) ||
      (DIGEST.test(receipt?.artifactReceiptDigest ?? "") &&
        timestampMillis(receipt?.artifactInclusionRecordedAt) !== null &&
        timestampMillis(receipt.artifactInclusionRecordedAt) >=
          timestampMillis(receipt.cutoffAt) &&
        timestampMillis(receipt.artifactInclusionRecordedAt) <=
          timestampMillis(receipt.cancelledAt)));
  if (
    value.status !== "cancelled" ||
    !hasOnlyFields(value, PUBLIC_BUILD_CANCELLED_FIELDS) ||
    value.cancelledReason !== PUBLIC_BUILD_CANCELLED_REASON ||
    timestampMillis(value.cancelledAt) === null ||
    timestampMillis(value.cancelledAt) < timestampMillis(value.reservedAt) ||
    !plainObject(receipt) ||
    !hasOnlyFields(receipt, receiptFields) ||
    Object.keys(receipt).length !== receiptFields.size ||
    ![1, 2].includes(receipt.schemaVersion) ||
    receipt.reason !== PUBLIC_BUILD_CANCELLED_REASON ||
    !QUEUE_ID.test(receipt.queueId ?? "") ||
    receipt.buildBatchId !== `cms-${receipt.queueId}` ||
    receipt.buildBatchId !== reservation.buildBatchId ||
    receipt.generation !== reservation.generation ||
    receipt.queueCommitSha !== reservation.commitSha ||
    !isCommitSha(receipt.operatorCommitSha) ||
    receipt.operatorCommitSha === reservation.commitSha ||
    !SERIALIZER_ID.test(receipt.serializerId ?? "") ||
    !DIGEST.test(receipt.claimTokenDigest) ||
    !sameTimestamp(receipt.cutoffAt, reservation.cutoffAt) ||
    !sameTimestamp(receipt.cancelledAt, value.cancelledAt) ||
    !inclusionBindingValid
  ) {
    throw new PublicDeploymentStateError(
      "The cancelled public deployment build batch is invalid",
    );
  }
  return value;
}

// Historical reservations never reached readiness or acquired a lease. Their
// operator receipt is separate from cancellation and deployment evidence.
function assertPublicDeploymentRetiredBatch(value, expectedBuildBatchId = null) {
  const fields = new Set([...PUBLIC_BUILD_RESERVATION_FIELDS, "retiredAt", "retirementReceipt"]);
  const receiptFields = new Set(["schemaVersion", "reason", "issue", "originalOwner",
    "activeGeneration", "activeCommitSha", "activeDeploymentId", "operatorCommitSha", "planDigest"]);
  const { retiredAt, retirementReceipt: receipt, ...original } = value ?? {};
  assertPublicDeploymentReservedBatch({ ...original, status: "reserved" }, expectedBuildBatchId);
  if (value.status !== "retired" || value.runtime !== undefined || !hasOnlyFields(value, fields) ||
      timestampMillis(retiredAt) === null || timestampMillis(retiredAt) < timestampMillis(value.reservedAt) ||
      !plainObject(receipt) || Object.keys(receipt).length !== receiptFields.size || !hasOnlyFields(receipt, receiptFields) ||
      receipt.schemaVersion !== 1 || receipt.reason !== "historical_reserved_below_active" ||
      receipt.issue !== 3195 || receipt.originalOwner !== "node-compute" ||
      !Number.isSafeInteger(receipt.activeGeneration) || receipt.activeGeneration <= value.generation ||
      !isCommitSha(receipt.activeCommitSha) || !isPublicDeploymentIdentifier(receipt.activeDeploymentId) ||
      !isCommitSha(receipt.operatorCommitSha) || !DIGEST.test(receipt.planDigest ?? "")) {
    throw new PublicDeploymentStateError("The retired public deployment reservation is invalid");
  }
  return value;
}

// A cloud release reservation that failed before staging has no queue,
// candidate or release request. Its receipt is separate from the historical one.
function assertPublicDeploymentRetiredCloudReleaseBatch(value, expectedBuildBatchId = null) {
  const fields = new Set([...PUBLIC_BUILD_RESERVATION_FIELDS, "retiredAt", "retirementReceipt"]);
  const receiptFields = new Set(["schemaVersion", "reason", "originalOwner",
    "activeGeneration", "activeCommitSha", "activeDeploymentId"]);
  const { retiredAt, retirementReceipt: receipt, ...original } = value ?? {};
  assertPublicDeploymentReservedBatch({ ...original, status: "reserved" }, expectedBuildBatchId);
  if (value.status !== "retired" || value.runtime?.owner !== "cloudflare" ||
      value.noBuildStaticInput !== undefined || !hasOnlyFields(value, fields) ||
      timestampMillis(retiredAt) === null || timestampMillis(retiredAt) < timestampMillis(value.reservedAt) ||
      !plainObject(receipt) || Object.keys(receipt).length !== receiptFields.size || !hasOnlyFields(receipt, receiptFields) ||
      receipt.schemaVersion !== 1 || receipt.reason !== "cloud_release_not_staged" ||
      receipt.originalOwner !== "cloudflare" ||
      !Number.isSafeInteger(receipt.activeGeneration) || receipt.activeGeneration < 0 ||
      !validDeploymentReceipt(receipt.activeGeneration, receipt.activeDeploymentId, receipt.activeCommitSha)) {
    throw new PublicDeploymentStateError("The retired cloud release reservation is invalid");
  }
  return value;
}

function assertPublicDeploymentLeaseBatch(value, expectedBuildBatchId = null) {
  projectPublicBuildReservation(value, expectedBuildBatchId);
  const fields =
    value.status === "ready"
      ? PUBLIC_BUILD_READY_FIELDS
      : value.status === "deploying"
        ? PUBLIC_BUILD_DEPLOYING_FIELDS
        : value.status === "reconciling"
          ? PUBLIC_BUILD_RECONCILING_FIELDS
        : value.status === "superseded"
          ? PUBLIC_BUILD_SUPERSEDED_FIELDS
          : null;
  const cutoffAt = timestampMillis(value.cutoffAt);
  const reservedAt = timestampMillis(value.reservedAt);
  const readyAt = timestampMillis(value.readyAt);
  let validState = Boolean(
    fields !== null &&
      hasOnlyFields(value, fields) &&
      cutoffAt !== null &&
      reservedAt !== null &&
      readyAt !== null &&
      reservedAt >= cutoffAt &&
      readyAt >= reservedAt,
  );

  if (value.status === "deploying" || value.status === "reconciling") {
    const leaseAcquiredAt = timestampMillis(value.leaseAcquiredAt);
    validState = Boolean(
      validState &&
        isPublicDeploymentIdentifier(value.leaseToken) &&
        leaseAcquiredAt !== null &&
        leaseAcquiredAt >= readyAt &&
        Number.isSafeInteger(value.predecessorGeneration) &&
        value.predecessorGeneration >= 0 &&
        value.predecessorGeneration < value.generation &&
        validDeploymentReceipt(
          value.predecessorGeneration,
          value.predecessorDeploymentId,
          value.predecessorCommitSha,
        ),
    );
    if (value.status === "reconciling") {
      const reconcilingAt = timestampMillis(value.reconcilingAt);
      validState = Boolean(
        validState &&
          reconcilingAt !== null &&
          reconcilingAt >= leaseAcquiredAt &&
          DIGEST.test(value.cloudflareEvidenceDigest),
      );
    }
  } else if (value.status === "superseded") {
    const supersededAt = timestampMillis(value.supersededAt);
    validState = Boolean(
      validState &&
        value.supersededReason === "newer_eligible_generation" &&
        supersededAt !== null &&
        supersededAt >= readyAt &&
        Number.isSafeInteger(value.supersededByGeneration) &&
        value.supersededByGeneration > value.generation &&
        isPublicDeploymentIdentifier(value.supersededByBuildBatchId),
    );
  }

  if (!validState) {
    throw new PublicDeploymentStateError(
      "The public deployment build batch is invalid",
    );
  }
  return value;
}

function assertPublicDeploymentTerminalBatchStructure(
  batch,
  expectedBuildBatchId = null,
) {
  const requiredFields = batch?.status === "deployed"
    ? PUBLIC_BUILD_DEPLOYED_FIELDS
    : batch?.status === "failed"
      ? PUBLIC_BUILD_FAILED_FIELDS
      : null;
  const fields = requiredFields === null ? null : new Set(requiredFields);
  if (fields && !Object.hasOwn(batch, "runtime")) fields.delete("runtime");
  if (fields && !Object.hasOwn(batch, "noBuildStaticInput")) fields.delete("noBuildStaticInput");
  if (fields && batch.status === "failed" && Object.hasOwn(batch, "restoredPredecessor")) fields.add("restoredPredecessor");
  if (
    fields === null ||
    !plainObject(batch) ||
    !hasOnlyFields(batch, fields) ||
    Object.keys(batch).length !== fields.size
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment terminal receipt is invalid",
    );
  }
  projectPublicBuildReservation(batch, expectedBuildBatchId);
  if (batch.restoredPredecessor !== undefined) {
    const restored = projectPublicDeploymentRestoreReceipt(batch.restoredPredecessor);
    if (batch.terminalOutcome !== "cancelled" || restored.generation !== batch.predecessorGeneration ||
        restored.commitSha !== batch.predecessorCommitSha) {
      throw new PublicDeploymentStateError("The restored predecessor receipt is invalid");
    }
  }
  assertPublicDeploymentLeaseReceipt({
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
  });
  if (
    timestampMillis(batch.readyAt) === null ||
    timestampMillis(batch.readyAt) < timestampMillis(batch.reservedAt) ||
    timestampMillis(batch.leaseAcquiredAt) < timestampMillis(batch.readyAt) ||
    !DIGEST.test(batch.mediaManifestDigest) ||
    !DIGEST.test(batch.cloudflareEvidenceDigest)
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment terminal receipt is invalid",
    );
  }

  const terminalAt = batch.status === "deployed"
    ? batch.deployedAt
    : batch.failedAt;
  const validOutcome = batch.status === "deployed"
    ? CLOUDFLARE_UUID.test(batch.deploymentId ?? "") &&
      CLOUDFLARE_UUID.test(batch.deploymentVersionId ?? "")
    : TERMINAL_FAILURE_OUTCOMES.has(batch.terminalOutcome);
  if (
    !validOutcome ||
    timestampMillis(terminalAt) === null ||
    timestampMillis(terminalAt) < timestampMillis(batch.leaseAcquiredAt)
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment terminal receipt is invalid",
    );
  }
  return batch;
}

function sameTimestamp(left, right) {
  const leftMillis = timestampMillis(left);
  return leftMillis !== null && leftMillis === timestampMillis(right);
}

function supersedePlan(pointer) {
  return Object.freeze({
    action: "supersede",
    supersededByGeneration: pointer.newestEligibleGeneration,
    supersededByBuildBatchId: pointer.newestEligibleBuildBatchId,
  });
}

function planPublicDeploymentLeaseAcquisition(pointerValue, batchValue) {
  const pointer = assertPublicDeploymentPointer(pointerValue);
  const batch = assertPublicDeploymentLeaseBatch(
    batchValue,
    batchValue?.buildBatchId,
  );
  if (
    batch.generation > pointer.lastReservedGeneration ||
    (batch.status === "superseded" &&
      (batch.supersededByGeneration > pointer.lastReservedGeneration ||
        batch.supersededByGeneration > pointer.newestEligibleGeneration ||
        (batch.supersededByGeneration === pointer.newestEligibleGeneration &&
          batch.supersededByBuildBatchId !==
            pointer.newestEligibleBuildBatchId)))
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment generation counter regressed",
    );
  }

  const pointerHasLease =
    pointer.state === "deploying" || pointer.state === "reconciling";
  const pointerClaimsBatch =
    pointerHasLease &&
    pointer.candidateGeneration === batch.generation &&
    pointer.candidateBuildBatchId === batch.buildBatchId;
  if (
    pointerClaimsBatch &&
    batch.status !== "deploying" &&
    batch.status !== "reconciling"
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment lease receipt is invalid",
    );
  }

  if (batch.status === "deploying") {
    if (
      pointer.state !== "deploying" ||
      pointer.candidateGeneration !== batch.generation ||
      pointer.candidateBuildBatchId !== batch.buildBatchId ||
      pointer.candidateCommitSha !== batch.commitSha ||
      !isDeepStrictEqual(pointer.runtime, batch.runtime) ||
      pointer.leaseToken !== batch.leaseToken ||
      !sameTimestamp(pointer.leaseAcquiredAt, batch.leaseAcquiredAt) ||
      pointer.predecessorGeneration !== batch.predecessorGeneration ||
      pointer.predecessorDeploymentId !== batch.predecessorDeploymentId ||
      pointer.predecessorCommitSha !== batch.predecessorCommitSha
    ) {
      throw new PublicDeploymentStateError(
        "The public deployment lease receipt is invalid",
      );
    }
    return Object.freeze({ action: "retry" });
  }

  if (batch.status === "reconciling") {
    if (
      pointer.state !== "reconciling" ||
      pointer.candidateGeneration !== batch.generation ||
      pointer.candidateBuildBatchId !== batch.buildBatchId ||
      pointer.candidateCommitSha !== batch.commitSha ||
      !isDeepStrictEqual(pointer.runtime, batch.runtime) ||
      pointer.leaseToken !== batch.leaseToken ||
      !sameTimestamp(pointer.leaseAcquiredAt, batch.leaseAcquiredAt) ||
      pointer.predecessorGeneration !== batch.predecessorGeneration ||
      pointer.predecessorDeploymentId !== batch.predecessorDeploymentId ||
      pointer.predecessorCommitSha !== batch.predecessorCommitSha ||
      !sameTimestamp(pointer.reconcilingAt, batch.reconcilingAt) ||
      pointer.cloudflareEvidenceDigest !== batch.cloudflareEvidenceDigest
    ) {
      throw new PublicDeploymentStateError(
        "The public deployment lease receipt is invalid",
      );
    }
    return Object.freeze({ action: "retry" });
  }

  if (batch.status === "superseded") {
    return Object.freeze({
      action: "supersede",
      supersededByGeneration: batch.supersededByGeneration,
      supersededByBuildBatchId: batch.supersededByBuildBatchId,
    });
  }

  if (batch.generation < pointer.newestEligibleGeneration) {
    return supersedePlan(pointer);
  }
  if (
    batch.generation <= pointer.activeGeneration ||
    batch.generation > pointer.newestEligibleGeneration ||
    batch.buildBatchId !== pointer.newestEligibleBuildBatchId
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment eligible generation is invalid",
    );
  }
  if (pointerHasLease) {
    if (
      pointer.candidateGeneration === batch.generation &&
      pointer.candidateBuildBatchId === batch.buildBatchId
    ) {
      throw new PublicDeploymentStateError(
        "The public deployment lease receipt is invalid",
      );
    }
    return Object.freeze({ action: "busy" });
  }
  return Object.freeze({ action: "acquire" });
}

function assertPublicDeploymentLeaseReceipt(value) {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== PUBLIC_DEPLOYMENT_LEASE_FIELDS.size + (Object.hasOwn(value, "runtime") ? 1 : 0) ||
    !hasOnlyFields(value, new Set([...PUBLIC_DEPLOYMENT_LEASE_FIELDS, "runtime"])) ||
    value.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    !isPublicDeploymentIdentifier(value.leaseToken) ||
    timestampMillis(value.leaseAcquiredAt) === null ||
    !Number.isSafeInteger(value.predecessorGeneration) ||
    value.predecessorGeneration < 0 ||
    value.predecessorGeneration >= value.generation ||
    !validDeploymentReceipt(
      value.predecessorGeneration,
      value.predecessorDeploymentId,
      value.predecessorCommitSha,
    )
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment lease receipt is invalid",
    );
  }
  return Object.freeze({
    ...runtimeFields(value.runtime),
    schemaVersion: value.schemaVersion,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    leaseToken: value.leaseToken,
    leaseAcquiredAt: value.leaseAcquiredAt,
    predecessorGeneration: value.predecessorGeneration,
    predecessorDeploymentId: value.predecessorDeploymentId,
    predecessorCommitSha: value.predecessorCommitSha,
  });
}

function projectPublicDeploymentLease(value, expectedBuildBatchId = null) {
  const batch = assertPublicDeploymentLeaseBatch(value, expectedBuildBatchId);
  if (batch.status !== "deploying" && batch.status !== "reconciling") {
    throw new PublicDeploymentStateError(
      "The public deployment lease receipt is invalid",
    );
  }
  return assertPublicDeploymentLeaseReceipt({
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
  });
}

function projectPublicBuildReadiness(value, expectedBuildBatchId = null) {
  const batch = assertPublicDeploymentLeaseBatch(value, expectedBuildBatchId);
  return Object.freeze({
    ...runtimeFields(batch.runtime),
    schemaVersion: batch.schemaVersion,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    readyAt: batch.readyAt,
  });
}

function projectPublicBuildSupersession(value, expectedBuildBatchId = null) {
  const batch = assertPublicDeploymentLeaseBatch(value, expectedBuildBatchId);
  if (batch.status !== "superseded") {
    throw new PublicDeploymentStateError(
      "The public deployment supersession receipt is invalid",
    );
  }
  return Object.freeze({
    ...runtimeFields(batch.runtime),
    schemaVersion: batch.schemaVersion,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    supersededReason: batch.supersededReason,
    supersededAt: batch.supersededAt,
    supersededByGeneration: batch.supersededByGeneration,
    supersededByBuildBatchId: batch.supersededByBuildBatchId,
  });
}

module.exports = {
  assertPublicDeploymentRetiredBatch,
  assertPublicDeploymentRetiredCloudReleaseBatch,
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  PUBLIC_BUILD_CANCELLED_REASON,
  PublicDeploymentFenceError,
  PublicDeploymentStateError,
  assertMediaLifecycleDeploymentFence,
  assertPublishedMediaReadiness,
  assertPublicDeploymentCancelledBatch,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentLeaseReceipt,
  assertPublicDeploymentPointer,
  assertPublicDeploymentReservedBatch,
  assertPublicDeploymentTerminalBatchStructure,
  initialPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  planPublicDeploymentLeaseAcquisition,
  projectPublicBuildSupersession,
  projectPublicBuildReservation,
  projectPublicBuildReadiness,
  projectPublicDeploymentLease,
  projectPublicDeploymentRestoreReceipt,
  timestampMillis,
};

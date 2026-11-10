"use strict";

// Inert one-time bootstrap for the public deployment coordinator. This module
// validates already-fetched Cloudflare evidence and writes one Firestore
// receipt. It does not call Cloudflare, deploy traffic, enable media lifecycle
// changes, expose a handler, or register a production caller.

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  PublicDeploymentStateError,
  assertPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");
const {
  projectCloudflareActiveDeploymentObservation,
  projectCloudflareVersionBuildObservation,
} = require("./public-deployment-cloudflare");
const {
  publicDeploymentRef,
} = require("./public-deployment-coordinator");

const PUBLIC_WORKER_NAME = "njpbs-production";
const PUBLIC_WORKER_BRANCH = "production";
const BOOTSTRAP_RECEIPT_ID = "initial";
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CANONICAL_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_FIELDS = [
  "schemaVersion",
  "workerName",
  "buildBatchId",
  "cloudflareBuildUuid",
  "deploymentId",
  "versionId",
  "commitSha",
  "branch",
  "externalScriptId",
  "buildCreatedOn",
  "buildStoppedOn",
  "deploymentCreatedOn",
];
const EVIDENCE_RECORD_FIELDS = new Set([
  ...EVIDENCE_FIELDS,
  "evidenceDigest",
]);
const RECEIPT_FIELDS = new Set([
  ...EVIDENCE_RECORD_FIELDS,
  "generation",
  "bootstrappedAt",
]);

class PublicDeploymentBootstrapEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicDeploymentBootstrapEvidenceError";
  }
}

function evidenceError(message) {
  throw new PublicDeploymentBootstrapEvidenceError(message);
}

function stateError(message) {
  throw new PublicDeploymentStateError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return (
    plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field))
  );
}

function isCloudflareUuid(value) {
  return typeof value === "string" && CLOUDFLARE_UUID.test(value);
}

function isCanonicalDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_DATE_TIME.test(value)) {
    return false;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function evidenceDigest(value) {
  const core = Object.fromEntries(
    EVIDENCE_FIELDS.map((field) => [field, value[field]]),
  );
  return createHash("sha256")
    .update(JSON.stringify(core), "utf8")
    .digest("hex");
}

function bootstrapBuildBatchId(cloudflareBuildUuid) {
  return `bootstrap:${cloudflareBuildUuid}`;
}

function validBootstrapIdentity(value) {
  return Boolean(
    value.schemaVersion === PUBLIC_DEPLOYMENT_SCHEMA_VERSION &&
      value.workerName === PUBLIC_WORKER_NAME &&
      isCloudflareUuid(value.cloudflareBuildUuid) &&
      value.buildBatchId === bootstrapBuildBatchId(value.cloudflareBuildUuid) &&
      isPublicDeploymentIdentifier(value.buildBatchId) &&
      isCloudflareUuid(value.deploymentId) &&
      isCloudflareUuid(value.versionId) &&
      isCommitSha(value.commitSha) &&
      value.branch === PUBLIC_WORKER_BRANCH &&
      isPublicDeploymentIdentifier(value.externalScriptId),
  );
}

function validBootstrapTimeline(value) {
  if (
    !isCanonicalDateTime(value.buildCreatedOn) ||
    !isCanonicalDateTime(value.buildStoppedOn) ||
    !isCanonicalDateTime(value.deploymentCreatedOn)
  ) {
    return false;
  }
  const buildCreatedAt = Date.parse(value.buildCreatedOn);
  return Boolean(
    Date.parse(value.buildStoppedOn) >= buildCreatedAt &&
      Date.parse(value.deploymentCreatedOn) >= buildCreatedAt,
  );
}

function assertPublicDeploymentBootstrapEvidence(value) {
  if (
    !hasExactFields(value, EVIDENCE_RECORD_FIELDS) ||
    !validBootstrapIdentity(value) ||
    !validBootstrapTimeline(value) ||
    !DIGEST.test(value.evidenceDigest) ||
    value.evidenceDigest !== evidenceDigest(value)
  ) {
    evidenceError("The public deployment bootstrap evidence is invalid");
  }
  return Object.freeze({ ...value });
}

function projectPublicDeploymentBootstrapEvidence({
  workerName,
  expectedExternalScriptId,
  deploymentsResponse,
  buildsByVersionResponse,
} = {}) {
  if (
    workerName !== PUBLIC_WORKER_NAME ||
    !isPublicDeploymentIdentifier(expectedExternalScriptId)
  ) {
    evidenceError("The public deployment bootstrap target is invalid");
  }

  let active;
  let build;
  try {
    active = projectCloudflareActiveDeploymentObservation(deploymentsResponse);
    if (active === null) {
      evidenceError("The public Worker has no active deployment");
    }
    build = projectCloudflareVersionBuildObservation(
      buildsByVersionResponse,
      active.versionId,
    );
  } catch (error) {
    if (error instanceof PublicDeploymentBootstrapEvidenceError) throw error;
    evidenceError("The public deployment bootstrap evidence is invalid");
  }

  const rawActive = deploymentsResponse.result.deployments[0];
  if (
    rawActive.source !== "wrangler" ||
    !plainObject(rawActive.annotations) ||
    rawActive.annotations["workers/triggered_by"] !== "deployment" ||
    build.status !== "stopped" ||
    build.outcome !== "success" ||
    build.stoppedOn === null ||
    build.branch !== PUBLIC_WORKER_BRANCH ||
    build.externalScriptId !== expectedExternalScriptId
  ) {
    evidenceError("The public deployment bootstrap evidence is invalid");
  }

  const projected = {
    schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
    workerName: PUBLIC_WORKER_NAME,
    buildBatchId: bootstrapBuildBatchId(build.buildUuid),
    cloudflareBuildUuid: build.buildUuid,
    deploymentId: active.deploymentId,
    versionId: active.versionId,
    commitSha: build.commitSha,
    branch: build.branch,
    externalScriptId: build.externalScriptId,
    buildCreatedOn: build.createdOn,
    buildStoppedOn: build.stoppedOn,
    deploymentCreatedOn: active.createdOn,
  };
  return assertPublicDeploymentBootstrapEvidence({
    ...projected,
    evidenceDigest: evidenceDigest(projected),
  });
}

function assertPublicDeploymentBootstrapReceipt(value) {
  if (
    !hasExactFields(value, RECEIPT_FIELDS) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    timestampMillis(value.bootstrappedAt) === null
  ) {
    stateError("The public deployment bootstrap receipt is invalid");
  }
  try {
    assertPublicDeploymentBootstrapEvidence(
      Object.fromEntries(
        [...EVIDENCE_RECORD_FIELDS].map((field) => [field, value[field]]),
      ),
    );
  } catch (error) {
    if (error instanceof PublicDeploymentBootstrapEvidenceError) {
      stateError("The public deployment bootstrap receipt is invalid");
    }
    throw error;
  }
  return Object.freeze({ ...value });
}

function publicDeploymentBootstrapReceiptRef(firestore) {
  return publicDeploymentRef(firestore)
    .collection("bootstrapReceipts")
    .doc(BOOTSTRAP_RECEIPT_ID);
}

function assertFirestore(firestore) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    stateError("firestore is required");
  }
}

function isUnbootstrappedPointer(pointer) {
  return Boolean(
    pointer.state === "idle" &&
      pointer.mediaLifecycleReady === false &&
      pointer.activeGeneration === 0 &&
      pointer.activeDeploymentId === null &&
      pointer.activeCommitSha === null &&
      pointer.newestEligibleGeneration === 0 &&
      pointer.newestEligibleBuildBatchId === null,
  );
}

function receiptMatchesEvidence(receipt, evidence) {
  return [...EVIDENCE_RECORD_FIELDS].every(
    (field) => receipt[field] === evidence[field],
  );
}

function pointerMatchesReceipt(pointer, receipt) {
  return Boolean(
    pointer.activeGeneration === receipt.generation &&
      pointer.activeDeploymentId === receipt.deploymentId &&
      pointer.activeCommitSha === receipt.commitSha,
  );
}

async function bootstrapPublicDeployment({ firestore, evidence } = {}) {
  assertFirestore(firestore);
  const projectedEvidence = assertPublicDeploymentBootstrapEvidence(evidence);
  const pointerRef = publicDeploymentRef(firestore);
  const receiptRef = publicDeploymentBootstrapReceiptRef(firestore);

  const transactionResult = await firestore.runTransaction(
    async (transaction) => {
      const [pointerSnapshot, receiptSnapshot] = await Promise.all([
        transaction.get(pointerRef),
        transaction.get(receiptRef),
      ]);
      if (!pointerSnapshot.exists) {
        stateError("The public deployment coordinator does not exist");
      }
      const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());

      if (receiptSnapshot.exists) {
        const receipt = assertPublicDeploymentBootstrapReceipt(
          receiptSnapshot.data(),
        );
        if (!receiptMatchesEvidence(receipt, projectedEvidence)) {
          stateError(
            "The public deployment bootstrap belongs to different Cloudflare evidence",
          );
        }
        if (!pointerMatchesReceipt(pointer, receipt)) {
          stateError(
            "The public deployment bootstrap no longer matches the active deployment",
          );
        }
        return { idempotent: true };
      }

      if (!isUnbootstrappedPointer(pointer)) {
        stateError("The public deployment coordinator already has an active receipt");
      }
      const generation = pointer.lastReservedGeneration + 1;
      if (!Number.isSafeInteger(generation)) {
        stateError("No public deployment bootstrap generation is available");
      }
      const timestamp = FieldValue.serverTimestamp();
      transaction.set(pointerRef, {
        ...pointer,
        mediaLifecycleReady: false,
        state: "idle",
        activeGeneration: generation,
        activeDeploymentId: projectedEvidence.deploymentId,
        activeCommitSha: projectedEvidence.commitSha,
        lastReservedGeneration: generation,
        newestEligibleGeneration: generation,
        newestEligibleBuildBatchId: projectedEvidence.buildBatchId,
        updatedAt: timestamp,
      });
      transaction.set(receiptRef, {
        ...projectedEvidence,
        generation,
        bootstrappedAt: timestamp,
      });
      return { idempotent: false };
    },
  );

  const receiptSnapshot = await receiptRef.get();
  if (!receiptSnapshot.exists) {
    stateError("The public deployment bootstrap was not persisted");
  }
  const receipt = assertPublicDeploymentBootstrapReceipt(receiptSnapshot.data());
  if (!receiptMatchesEvidence(receipt, projectedEvidence)) {
    stateError("The persisted public deployment bootstrap is invalid");
  }
  return { idempotent: transactionResult.idempotent, receipt };
}

module.exports = {
  PublicDeploymentBootstrapEvidenceError,
  assertPublicDeploymentBootstrapEvidence,
  assertPublicDeploymentBootstrapReceipt,
  bootstrapPublicDeployment,
  projectPublicDeploymentBootstrapEvidence,
  publicDeploymentBootstrapReceiptRef,
};

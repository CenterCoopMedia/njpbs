"use strict";

// Audited activation of uploaded media in public artifacts. The
// caller must first verify the exact active Worker and the exact root
// publication receipt. This transaction binds that proof to the coordinator's
// current deployed candidate before it opens the media publication fence.

const { isDeepStrictEqual } = require("node:util");
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
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  assertPublicWorkerCandidateMatchesBatch,
} = require("./public-worker-candidate");
const { assertRecoveryInput } = require("./cms-publication-baseline-recovery");
const { projectExactQueue } = require("./cms-publication-baseline");
const { projectDeploymentReceipt, projectInclusionReceipt } =
  require("./cms-public-deployment-writeback");

const ACTIVATION_RECEIPT_ID = "enabled";
const ADMIN_LOGS_COLLECTION = "admin_logs";
const PUBLIC_RECEIPT_URL = "https://njpbs.org/_publication.json";
const DIGEST = /^[a-f0-9]{64}$/;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROOF_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "deploymentId",
  "versionId",
  "publicationReceiptDigest",
  "publicReceiptUrl",
]);
const RECEIPT_FIELDS = new Set([...PROOF_FIELDS, "activatedAt"]);

function stateError(message) {
  throw new PublicDeploymentStateError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function projectPublicMediaLifecycleProof(value) {
  if (
    !hasExactFields(value, PROOF_FIELDS) ||
    value.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    !CLOUDFLARE_UUID.test(value.deploymentId) ||
    !CLOUDFLARE_UUID.test(value.versionId) ||
    !DIGEST.test(value.publicationReceiptDigest) ||
    value.publicReceiptUrl !== PUBLIC_RECEIPT_URL
  ) {
    stateError("The public media lifecycle activation proof is invalid");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    deploymentId: value.deploymentId.toLowerCase(),
    versionId: value.versionId.toLowerCase(),
    publicationReceiptDigest: value.publicationReceiptDigest,
    publicReceiptUrl: value.publicReceiptUrl,
  });
}

function projectPublicMediaLifecycleActivationReceipt(value) {
  if (!hasExactFields(value, RECEIPT_FIELDS) ||
      timestampMillis(value.activatedAt) === null) {
    stateError("The public media lifecycle activation receipt is invalid");
  }
  return Object.freeze({
    ...projectPublicMediaLifecycleProof(
      Object.fromEntries(
        Object.entries(value).filter(([field]) => field !== "activatedAt"),
      ),
    ),
    activatedAt: value.activatedAt,
  });
}

function publicMediaLifecycleActivationRef(firestore) {
  return publicDeploymentRef(firestore)
    .collection("mediaLifecycleActivations")
    .doc(ACTIVATION_RECEIPT_ID);
}

function assertActivationState({ pointer, batch, candidate, proof }) {
  if (
    pointer.state !== "idle" ||
    pointer.activeGeneration !== proof.generation ||
    pointer.activeDeploymentId !== proof.deploymentId ||
    pointer.activeCommitSha !== proof.commitSha ||
    pointer.lastReservedGeneration !== proof.generation ||
    pointer.newestEligibleGeneration !== proof.generation ||
    pointer.newestEligibleBuildBatchId !== proof.buildBatchId ||
    batch?.status !== "deployed" ||
    batch.buildBatchId !== proof.buildBatchId ||
    batch.generation !== proof.generation ||
    batch.commitSha !== proof.commitSha ||
    batch.deploymentId !== proof.deploymentId ||
    batch.deploymentVersionId !== proof.versionId ||
    candidate.workerVersionId !== proof.versionId ||
    candidate.publicationReceiptDigest !== proof.publicationReceiptDigest
  ) {
    stateError("The public media lifecycle activation is not the current deployment");
  }
}

function defaultAdminLogEntry({ proof, before, after }) {
  return {
    actorUid: "system:public-deployment",
    actorEmail: null,
    action: "public-media-lifecycle.activate",
    target: "system/publicDeployment",
    before,
    after,
    source: "public-media-lifecycle-activation",
    timestamp: FieldValue.serverTimestamp(),
    at: new Date().toISOString(),
    proof: {
      buildBatchId: proof.buildBatchId,
      generation: proof.generation,
      deploymentId: proof.deploymentId,
      versionId: proof.versionId,
      publicationReceiptDigest: proof.publicationReceiptDigest,
    },
  };
}

async function assertCompletedRecovery({ firestore, transaction, proof, batch, candidate, previous }) {
  const queueId = /^cms-([A-Za-z0-9]{20})$/.exec(proof.buildBatchId)?.[1];
  if (!queueId) stateError("Media reactivation requires a completed baseline recovery");
  const queueRef = firestore.collection("cmsPublishQueue").doc(queueId);
  const [queueSnapshot, recoverySnapshot] = await transaction.getAll(
    queueRef, queueRef.collection("recovery").doc("baseline"),
  );
  const recovery = recoverySnapshot.data();
  let queue, deployment, inclusion;
  try {
    assertRecoveryInput(recovery ?? {});
    queue = projectExactQueue(queueSnapshot, { queueId, commitSha: proof.commitSha });
    deployment = projectDeploymentReceipt(queue?.deploymentReceipt);
    inclusion = projectInclusionReceipt(queue?.artifactInclusion);
  } catch {
    stateError("The media reactivation recovery evidence is invalid");
  }
  const expected = recovery.expected;
  // Readiness can span ordinary deployments. The retained activation may be
  // older than the recovery predecessor, but cannot come from after it.
  if (
    !hasExactFields(recovery, new Set(["queueId", "commitSha", "expected", "buildBatchId", "createdAt"])) ||
    recovery.queueId !== queueId || recovery.commitSha !== proof.commitSha ||
    recovery.buildBatchId !== proof.buildBatchId ||
    timestampMillis(recovery.createdAt) === null ||
    timestampMillis(previous.activatedAt) > timestampMillis(recovery.createdAt) ||
    previous.generation > expected.activeGeneration ||
    proof.generation !== expected.lastReservedGeneration + 1 ||
    batch.reservedAgainstGeneration !== expected.activeGeneration ||
    batch.reservedAgainstDeploymentId !== expected.activeDeploymentId ||
    batch.reservedAgainstCommitSha !== expected.activeCommitSha ||
    queue.status !== "success" || timestampMillis(queue.completedAt) === null ||
    !isDeepStrictEqual(queue.artifactBuild, {
      buildBatchId: proof.buildBatchId, generation: proof.generation,
      commitSha: proof.commitSha, cutoffAt: batch.cutoffAt,
    }) ||
    [deployment, inclusion].some(receipt =>
      receipt.buildBatchId !== proof.buildBatchId || receipt.generation !== proof.generation ||
      receipt.commitSha !== proof.commitSha) ||
    deployment.queueId !== queueId || deployment.deploymentId !== proof.deploymentId ||
    deployment.versionId !== proof.versionId ||
    !isDeepStrictEqual(inclusion.cutoffAt, batch.cutoffAt) ||
    inclusion.artifactReceiptDigest !== candidate.artifactReceiptDigest
  ) {
    stateError("The media reactivation recovery receipt conflicts with the current deployment");
  }
  return queueId;
}

async function activatePublicMediaLifecycle({
  firestore,
  proof: proofValue,
  adminLogEntryFn = defaultAdminLogEntry,
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    stateError("firestore is required");
  }
  if (typeof adminLogEntryFn !== "function") {
    stateError("The public media lifecycle audit writer is invalid");
  }
  const proof = projectPublicMediaLifecycleProof(proofValue);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, proof.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(firestore, proof.buildBatchId);
  const activationRef = publicMediaLifecycleActivationRef(firestore);

  const result = await firestore.runTransaction(async (transaction) => {
    const [pointerSnapshot, batchSnapshot, candidateSnapshot, activationSnapshot] =
      await transaction.getAll(
        pointerRef,
        batchRef,
        candidateRef,
        activationRef,
      );
    if (!pointerSnapshot.exists || !batchSnapshot.exists ||
        !candidateSnapshot.exists) {
      stateError("The public media lifecycle deployment evidence is missing");
    }
    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    const batch = batchSnapshot.data();
    const candidate = assertPublicWorkerCandidateMatchesBatch(
      candidateSnapshot.data(),
      batch,
    );
    assertActivationState({ pointer, batch, candidate, proof });

    let previous = null;
    let recoveryQueueId = null;
    if (activationSnapshot.exists) {
      const receipt = projectPublicMediaLifecycleActivationReceipt(
        activationSnapshot.data(),
      );
      const receiptProof = Object.fromEntries(
        Object.entries(receipt).filter(([field]) => field !== "activatedAt"),
      );
      if (pointer.mediaLifecycleReady && isDeepStrictEqual(receiptProof, proof)) {
        return { idempotent: true, receipt };
      }
      if (pointer.mediaLifecycleReady || isDeepStrictEqual(receiptProof, proof)) {
        stateError("The public media lifecycle activation receipt conflicts");
      }
      recoveryQueueId = await assertCompletedRecovery({
        firestore, transaction, proof, batch, candidate, previous: receipt,
      });
      previous = receipt;
    }
    if (pointer.mediaLifecycleReady) {
      stateError("The public media lifecycle activation receipt is missing");
    }

    const timestamp = FieldValue.serverTimestamp();
    transaction.set(pointerRef, {
      ...pointer,
      mediaLifecycleReady: true,
      updatedAt: timestamp,
    });
    if (previous) {
      transaction.create(
        pointerRef.collection("mediaLifecycleActivations").doc(`generation-${previous.generation}`),
        previous,
      );
      transaction.set(activationRef, { ...proof, activatedAt: timestamp });
    } else {
      transaction.create(activationRef, { ...proof, activatedAt: timestamp });
    }
    transaction.create(
      firestore.collection(ADMIN_LOGS_COLLECTION).doc(),
      adminLogEntryFn({
        proof,
        before: {
          ...(previous ? { activation: previous, recoveryQueueId } : {}),
          mediaLifecycleReady: false,
          activeGeneration: pointer.activeGeneration,
          activeDeploymentId: pointer.activeDeploymentId,
        },
        after: {
          mediaLifecycleReady: true,
          activeGeneration: pointer.activeGeneration,
          activeDeploymentId: pointer.activeDeploymentId,
        },
      }),
    );
    return { idempotent: false, receipt: null };
  });

  if (result.receipt) return result;
  const snapshot = await activationRef.get();
  if (!snapshot.exists) {
    stateError("The public media lifecycle activation was not persisted");
  }
  return {
    idempotent: false,
    receipt: projectPublicMediaLifecycleActivationReceipt(snapshot.data()),
  };
}

module.exports = {
  PUBLIC_RECEIPT_URL,
  activatePublicMediaLifecycle,
  projectPublicMediaLifecycleActivationReceipt,
  projectPublicMediaLifecycleProof,
  publicMediaLifecycleActivationRef,
};

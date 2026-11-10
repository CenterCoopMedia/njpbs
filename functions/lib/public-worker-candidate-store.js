"use strict";

const { assertPublicationOwner, assertRuntimeSource } = require("./publication-runtime-owner");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const {
  PublicDeploymentStateError,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentPointer,
  assertPublicDeploymentReservedBatch,
  planPublicDeploymentLeaseAcquisition,
  timestampMillis,
} = require("./public-deployment");
const {
  publicDeploymentRef,
  publicBuildBatchRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  assertPublicWorkerCandidateMatchesBatch,
  assertPublicWorkerCandidateDatabase,
  projectPublicWorkerCandidate,
  projectPublicWorkerCandidateInput,
} = require("./public-worker-candidate");

function stateError(message) {
  throw new PublicDeploymentStateError(message);
}

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    stateError("firestore is required");
  }
}

function candidateInputFromStored(candidate) {
  return Object.fromEntries(
    Object.entries(candidate).filter(([field]) => field !== "recordedAt"),
  );
}

function assertCandidateManifestCompletion({
  batch,
  candidate,
  header,
  verification,
}) {
  if (
    !header ||
    !verification ||
    header.buildBatchId !== batch.buildBatchId ||
    header.generation !== batch.generation ||
    header.commitSha !== batch.commitSha ||
    header.mediaManifestDigest !== candidate.mediaManifestDigest ||
    verification.buildBatchId !== header.buildBatchId ||
    verification.generation !== header.generation ||
    verification.mediaManifestDigest !== header.mediaManifestDigest ||
    verification.ownerCount !== header.ownerCount ||
    verification.chunkCount !== header.chunkCount ||
    timestampMillis(verification.verifiedAt) === null ||
    timestampMillis(verification.verifiedAt) > timestampMillis(batch.readyAt)
  ) {
    stateError("The public media manifest completion receipt is invalid");
  }
}

async function recordPublicWorkerCandidate({ firestore, candidate, runtime, target } = {}) {
  assertFirestore(firestore);
  assertPublicWorkerCandidateDatabase(firestore, target);
  const projectedInput = projectPublicWorkerCandidateInput(candidate, { target });
  const executor = runtime ?? { owner: "node-compute", release: projectedInput.commitSha };
  assertRuntimeSource(executor, projectedInput.commitSha);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(
    firestore,
    projectedInput.buildBatchId,
  );
  const candidateRef = publicWorkerCandidateRef(
    firestore,
    projectedInput.buildBatchId,
  );
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  const verificationRef = manifestRef
    .collection("verifications")
    .doc("complete");

  const idempotent = await firestore.runTransaction(async (transaction) => {
    const [
      pointerSnapshot,
      batchSnapshot,
      candidateSnapshot,
      manifestSnapshot,
      verificationSnapshot,
    ] = await Promise.all([
      transaction.get(pointerRef),
      transaction.get(batchRef),
      transaction.get(candidateRef),
      transaction.get(manifestRef),
      transaction.get(verificationRef),
    ]);
    if (!pointerSnapshot.exists || !batchSnapshot.exists) {
      stateError("The public deployment reservation does not exist");
    }
    assertPublicationOwner(batchSnapshot.data(), executor);
    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    if (batchSnapshot.data().status === "reserved") {
      const reservation = assertPublicDeploymentReservedBatch(
        batchSnapshot.data(),
        projectedInput.buildBatchId,
      );
      if (
        candidateSnapshot.exists ||
        reservation.generation !== projectedInput.generation ||
        reservation.commitSha !== projectedInput.commitSha
      ) {
        stateError("The public Worker candidate does not match its build batch");
      }
      stateError("The public media manifest is not ready");
    }
    const batch = assertPublicDeploymentLeaseBatch(
      batchSnapshot.data(),
      projectedInput.buildBatchId,
    );
    assertCandidateManifestCompletion({
      batch,
      candidate: projectedInput,
      header: manifestSnapshot.exists ? manifestSnapshot.data() : null,
      verification: verificationSnapshot.exists
        ? verificationSnapshot.data()
        : null,
    });
    if (candidateSnapshot.exists) {
      const stored = assertPublicWorkerCandidateMatchesBatch(
        candidateSnapshot.data(),
        batch,
        { target },
      );
      if (
        !isDeepStrictEqual(
          candidateInputFromStored(stored),
          projectedInput,
        )
      ) {
        stateError("The public Worker candidate conflicts with its build batch");
      }
      planPublicDeploymentLeaseAcquisition(pointer, batch);
      return true;
    }
    if (batch.status !== "ready") {
      stateError("The public media manifest is not ready");
    }
    assertPublicWorkerCandidateMatchesBatch(
      { ...projectedInput, recordedAt: batch.readyAt },
      batch,
      { target },
    );
    if (
      batch.generation > pointer.lastReservedGeneration ||
      batch.generation <= pointer.activeGeneration ||
      (pointer.newestEligibleGeneration === batch.generation &&
        pointer.newestEligibleBuildBatchId !== batch.buildBatchId) ||
      ((pointer.state === "deploying" || pointer.state === "reconciling") &&
        pointer.candidateGeneration === batch.generation)
    ) {
      stateError("The public Worker candidate readiness state is invalid");
    }

    const timestamp = FieldValue.serverTimestamp();
    transaction.create(candidateRef, {
      ...projectedInput,
      recordedAt: timestamp,
    });
    if (batch.generation > pointer.newestEligibleGeneration) {
      transaction.set(pointerRef, {
        ...pointer,
        newestEligibleGeneration: batch.generation,
        newestEligibleBuildBatchId: batch.buildBatchId,
        updatedAt: timestamp,
      });
    }
    return false;
  });

  const stored = await candidateRef.get();
  if (!stored.exists) {
    stateError("The public Worker candidate was not persisted");
  }
  return {
    idempotent,
    candidate: projectPublicWorkerCandidate(
      stored.data(),
      projectedInput.buildBatchId,
      { target },
    ),
  };
}

module.exports = {
  recordPublicWorkerCandidate,
};

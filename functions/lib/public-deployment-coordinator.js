"use strict";

const { assertNoBuildCandidateInTransaction } = require("./no-build-post-publication");
const { assertNoBuildPageCandidateInTransaction } = require("./no-build-page-candidate");

const { runtimeFields, assertPublicationOwner, assertRuntimeSource } = require("./publication-runtime-owner");
const { randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  PublicDeploymentStateError,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentPointer,
  initialPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  planPublicDeploymentLeaseAcquisition,
  projectPublicBuildSupersession,
  projectPublicBuildReservation,
  projectPublicDeploymentLease,
} = require("./public-deployment");
const {
  assertPublicWorkerCandidateMatchesBatch,
  assertPublicWorkerCandidateDatabase,
} = require("./public-worker-candidate");

function publicDeploymentRef(firestore) {
  return firestore.collection("system").doc("publicDeployment");
}

function publicBuildBatchRef(firestore, buildBatchId) {
  return publicDeploymentRef(firestore)
    .collection("buildBatches")
    .doc(buildBatchId);
}

function publicWorkerCandidateRef(firestore, buildBatchId) {
  return publicBuildBatchRef(firestore, buildBatchId)
    .collection("candidates")
    .doc("worker");
}

function exactRetry(batch, { buildBatchId, commitSha }) {
  const reservation = projectPublicBuildReservation(batch, buildBatchId);
  if (reservation.commitSha !== commitSha) {
    throw new PublicDeploymentStateError(
      "This public build batch belongs to a different commit",
    );
  }
  return reservation;
}

function exactLeaseBatch(batch, { buildBatchId, commitSha }) {
  const validated = assertPublicDeploymentLeaseBatch(batch, buildBatchId);
  if (validated.commitSha !== commitSha) {
    throw new PublicDeploymentStateError(
      "This public build batch belongs to a different commit",
    );
  }
  return validated;
}

async function reservePublicBuildBatch({ firestore, buildBatchId, commitSha, staticPostQueueId, runtime, target }) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new PublicDeploymentStateError("firestore is required");
  }
  if (!isPublicDeploymentIdentifier(buildBatchId)) {
    throw new PublicDeploymentStateError("buildBatchId is invalid");
  }
  if (!isCommitSha(commitSha)) {
    throw new PublicDeploymentStateError("commitSha is invalid");
  }

  const executor = runtime ?? { owner: "node-compute", release: commitSha };
  assertPublicWorkerCandidateDatabase(firestore, target);
  assertRuntimeSource(executor, commitSha);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, buildBatchId);
  const releaseId = /^cms-([A-Za-z0-9]{20})$/.exec(buildBatchId)?.[1];
  const preparationRef = releaseId ? firestore.doc(`system/publicReleasePreparations/entries/${releaseId}`) : null;
  const idempotent = await firestore.runTransaction(async (transaction) => {
    const [pointerSnapshot, batchSnapshot, preparationSnapshot] = await Promise.all([
      transaction.get(pointerRef),
      transaction.get(batchRef),
      preparationRef ? transaction.get(preparationRef) : null,
    ]);
    await require("./public-release-writer-fence").assertNoReleaseWriterInTransaction({ firestore, transaction });
    // A detached input has an earlier cutoff. Ordinary reservation must never
    // reuse its operation id; a separate promotion owns that exact identity.
    if (preparationSnapshot?.exists) {
      throw new PublicDeploymentStateError("This operation id belongs to a detached release preparation");
    }
    const pointer = pointerSnapshot.exists
      ? assertPublicDeploymentPointer(pointerSnapshot.data())
      : initialPublicDeploymentPointer();

    if (batchSnapshot.exists) {
      assertPublicationOwner(batchSnapshot.data(), executor);
      const reservation = exactRetry(batchSnapshot.data(), {
        buildBatchId,
        commitSha,
      });
      if (pointer.lastReservedGeneration < reservation.generation) {
        throw new PublicDeploymentStateError(
          "The public deployment generation counter regressed",
        );
      }
      return true;
    }

    const staticInput = await require("./no-build-post-static-return").staticInputForQueueInTransaction({
        firestore, transaction, queueId: staticPostQueueId,
      });
    // Static input binds only to the exact queue's own build batch.
    if (staticInput && staticPostQueueId !== undefined && buildBatchId !== `cms-${staticPostQueueId}`) {
      throw new PublicDeploymentStateError("The static Post reservation queue is invalid");
    }
    const generation = pointer.lastReservedGeneration + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new PublicDeploymentStateError(
        "No public deployment generation is available",
      );
    }
    const timestamp = FieldValue.serverTimestamp();
    const batch = {
      ...runtimeFields(runtime),
      schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
      buildBatchId,
      generation,
      status: "reserved",
      commitSha,
      // Lease acquisition must capture the then-active predecessor for its CAS.
      reservedAgainstGeneration: pointer.activeGeneration,
      reservedAgainstDeploymentId: pointer.activeDeploymentId,
      reservedAgainstCommitSha: pointer.activeCommitSha,
      cutoffAt: timestamp,
      reservedAt: timestamp,
      ...(staticInput ? { noBuildStaticInput: staticInput } : {}),
    };
    const coordinator = {
      ...pointer,
      lastReservedGeneration: generation,
      updatedAt: timestamp,
    };
    transaction.set(pointerRef, coordinator);
    transaction.set(batchRef, batch);
    return false;
  });

  const batchSnapshot = await batchRef.get();
  if (!batchSnapshot.exists) {
    throw new PublicDeploymentStateError(
      "The public deployment reservation was not persisted",
    );
  }
  const batch = exactRetry(batchSnapshot.data(), {
    buildBatchId,
    commitSha,
  });
  return { idempotent, batch };
}

async function acquirePublicDeploymentLease({
  firestore,
  buildBatchId,
  commitSha,
  runtime,
  target,
}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new PublicDeploymentStateError("firestore is required");
  }
  if (!isPublicDeploymentIdentifier(buildBatchId)) {
    throw new PublicDeploymentStateError("buildBatchId is invalid");
  }
  if (!isCommitSha(commitSha)) {
    throw new PublicDeploymentStateError("commitSha is invalid");
  }

  const executor = runtime ?? { owner: "node-compute", release: commitSha };
  assertPublicWorkerCandidateDatabase(firestore, target);
  assertRuntimeSource(executor, commitSha);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, buildBatchId);
  const candidateRef = publicWorkerCandidateRef(firestore, buildBatchId);
  const serverOwnedLeaseToken = randomUUID();
  const transactionResult = await firestore.runTransaction(
    async (transaction) => {
      const [pointerSnapshot, batchSnapshot, candidateSnapshot] = await Promise.all([
        transaction.get(pointerRef),
        transaction.get(batchRef),
        transaction.get(candidateRef),
      ]);
      await require("./public-release-writer-fence").assertNoReleaseWriterInTransaction({ firestore, transaction });
      if (
        !pointerSnapshot.exists ||
        !batchSnapshot.exists
      ) {
        throw new PublicDeploymentStateError(
          "The public deployment reservation does not exist",
        );
      }

      const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
      const batch = exactLeaseBatch(batchSnapshot.data(), {
        buildBatchId,
        commitSha,
      });
      if (!candidateSnapshot.exists) {
        throw new PublicDeploymentStateError(
          "The prepared public Worker candidate does not exist",
        );
      }
      assertPublicationOwner(batch, executor);
      const candidate = assertPublicWorkerCandidateMatchesBatch(
        candidateSnapshot.data(),
        batch,
        { target },
      );
      const plan = planPublicDeploymentLeaseAcquisition(pointer, batch);

      if (plan.action === "busy") {
        return { action: plan.action, idempotent: false, candidate };
      }
      if (plan.action === "retry") {
        return { action: plan.action, idempotent: true, candidate };
      }
      if (plan.action === "supersede" && batch.status === "superseded") {
        return { action: plan.action, idempotent: true, candidate };
      }

      const timestamp = FieldValue.serverTimestamp();
      if (plan.action === "supersede") {
        transaction.set(batchRef, {
          ...batch,
          status: "superseded",
          supersededReason: "newer_eligible_generation",
          supersededAt: timestamp,
          supersededByGeneration: plan.supersededByGeneration,
          supersededByBuildBatchId: plan.supersededByBuildBatchId,
        });
        return { action: plan.action, idempotent: false, candidate };
      }

      await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate });
      await assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate });
      const predecessor = {
        predecessorGeneration: pointer.activeGeneration,
        predecessorDeploymentId: pointer.activeDeploymentId,
        predecessorCommitSha: pointer.activeCommitSha,
      };
      transaction.set(pointerRef, {
        ...pointer,
        state: "deploying",
        ...runtimeFields(batch.runtime),
        leaseToken: serverOwnedLeaseToken,
        leaseAcquiredAt: timestamp,
        candidateGeneration: batch.generation,
        candidateBuildBatchId: batch.buildBatchId,
        candidateCommitSha: batch.commitSha,
        ...predecessor,
        updatedAt: timestamp,
      });
      transaction.set(batchRef, {
        ...batch,
        status: "deploying",
        leaseToken: serverOwnedLeaseToken,
        leaseAcquiredAt: timestamp,
        ...predecessor,
      });
      return { action: plan.action, idempotent: false, candidate };
    },
  );

  if (transactionResult.action === "busy") {
    return { outcome: "busy", idempotent: false };
  }

  const batchSnapshot = await batchRef.get();
  if (!batchSnapshot.exists) {
    throw new PublicDeploymentStateError(
      "The public deployment lease result was not persisted",
    );
  }
  const batch = exactLeaseBatch(batchSnapshot.data(), {
    buildBatchId,
    commitSha,
  });
  if (transactionResult.action === "supersede") {
    return {
      outcome: "superseded",
      idempotent: transactionResult.idempotent,
      supersession: projectPublicBuildSupersession(batch, buildBatchId),
    };
  }
  return {
    outcome: "acquired",
    idempotent: transactionResult.idempotent,
    lease: projectPublicDeploymentLease(batch, buildBatchId),
    candidate: transactionResult.candidate,
  };
}

module.exports = {
  acquirePublicDeploymentLease,
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
  reservePublicBuildBatch,
};

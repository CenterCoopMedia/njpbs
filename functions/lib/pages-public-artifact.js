"use strict";

const {
  PublicDeploymentStateError,
  assertPublicDeploymentPointer,
  assertPublicDeploymentTerminalBatchStructure,
  isCommitSha,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
} = require("./public-deployment-coordinator");

async function selectActivePublicBuildBatch({ firestore, commitSha }) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new PublicDeploymentStateError("firestore is required");
  }
  if (!isCommitSha(commitSha)) {
    throw new PublicDeploymentStateError("commitSha is invalid");
  }

  return firestore.runTransaction(async (transaction) => {
    const pointerSnapshot = await transaction.get(publicDeploymentRef(firestore));
    if (!pointerSnapshot.exists) {
      throw new PublicDeploymentStateError(
        "The active public deployment does not exist",
      );
    }
    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    if (
      pointer.state !== "idle" ||
      pointer.mediaLifecycleReady !== true ||
      pointer.activeGeneration < 1 ||
      pointer.activeGeneration !== pointer.lastReservedGeneration ||
      pointer.activeGeneration !== pointer.newestEligibleGeneration ||
      pointer.activeCommitSha !== commitSha
    ) {
      throw new PublicDeploymentStateError(
        "The Pages source does not match one aligned active public deployment",
      );
    }

    const buildBatchId = pointer.newestEligibleBuildBatchId;
    const batchSnapshot = await transaction.get(
      publicBuildBatchRef(firestore, buildBatchId),
    );
    if (!batchSnapshot.exists) {
      throw new PublicDeploymentStateError(
        "The active public build batch does not exist",
      );
    }
    const batch = assertPublicDeploymentTerminalBatchStructure(
      batchSnapshot.data(),
      buildBatchId,
    );
    if (
      batch.status !== "deployed" ||
      batch.generation !== pointer.activeGeneration ||
      batch.commitSha !== pointer.activeCommitSha ||
      batch.deploymentId !== pointer.activeDeploymentId
    ) {
      throw new PublicDeploymentStateError(
        "The active public build batch does not match the deployment pointer",
      );
    }

    return Object.freeze({
      buildBatchId: batch.buildBatchId,
      generation: batch.generation,
      commitSha: batch.commitSha,
    });
  });
}

module.exports = { selectActivePublicBuildBatch };

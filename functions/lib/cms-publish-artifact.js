"use strict";

const { assertPublicationOwner, assertRuntimeSource } = require("./publication-runtime-owner");
const { reservePublicBuildBatch } = require("./public-deployment-coordinator");
const { addressedPublishChanges } = require("./publish-build-state");

function timestampParts(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < 0 ||
    !Number.isSafeInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds > 999_999_999
  ) {
    return null;
  }
  return {
    seconds: value.seconds,
    nanoseconds: value.nanoseconds,
  };
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

function queueArtifactBuild(batch) {
  return Object.freeze({
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    cutoffAt: batch.cutoffAt,
  });
}

function sameQueueArtifactBuild(left, right) {
  return Boolean(
    left &&
      left.buildBatchId === right.buildBatchId &&
      left.generation === right.generation &&
      left.commitSha === right.commitSha &&
      sameTimestamp(left.cutoffAt, right.cutoffAt),
  );
}

async function reserveCmsPublishArtifact({
  firestore,
  queueId,
  buildBatchId = queueId,
  commitSha,
  runtime,
  target,
}) {
  const queueRef = firestore.collection("cmsPublishQueue").doc(queueId);
  const initialQueue = await queueRef.get();
  if (!initialQueue.exists) {
    throw new Error(`Publish queue ${queueId} was not found`);
  }
  const executor = runtime ?? { owner: "node-compute", release: commitSha };
  assertRuntimeSource(executor, commitSha);
  assertPublicationOwner(initialQueue.data(), executor);
  if (initialQueue.data().status === "success") return null;
  if (![
    "pending",
    "publishing",
    "public_unconfirmed",
    "failed",
    "cancelled",
  ].includes(initialQueue.data().status)) {
    throw new Error(
      `Publish queue ${queueId} is already ${String(initialQueue.data().status)}`,
    );
  }

  const { batch } = await reservePublicBuildBatch({ firestore, buildBatchId, commitSha, staticPostQueueId: queueId, runtime, target });
  const artifactBuild = queueArtifactBuild(batch);

  const result = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(queueRef);
    if (!snapshot.exists) {
      throw new Error(`Publish queue ${queueId} was not found`);
    }
    const queue = snapshot.data();
    assertPublicationOwner(queue, executor);
    if (queue.status === "success") return "settled";
    if (![
      "pending",
      "publishing",
      "public_unconfirmed",
      "failed",
      "cancelled",
    ].includes(queue.status)) {
      throw new Error(`Publish queue ${queueId} is already ${String(queue.status)}`);
    }
    if (queue.artifactBuild !== undefined) {
      if (sameQueueArtifactBuild(queue.artifactBuild, artifactBuild)) {
        return "bound";
      }
      if (queue.status === "pending" || queue.status === "publishing") {
        throw new Error(`Publish queue ${queueId} belongs to another artifact`);
      }
      if (queue.status === "public_unconfirmed") {
        if (queue.artifactBuildRollback !== undefined) {
          throw new Error(`Publish queue ${queueId} already has an artifact retry`);
        }
        transaction.update(queueRef, {
          artifactBuild,
          artifactBuildRollback: {
            artifactBuild: queue.artifactBuild,
            completedAt: queue.completedAt ?? null,
            deploymentClaim: queue.deploymentClaim ?? null,
          },
          completedAt: null,
          status: "publishing",
        });
        return "bound";
      }
    }
    if (queue.status === "public_unconfirmed") {
      throw new Error(`Publish queue ${queueId} has no deployed artifact to retry`);
    }
    transaction.update(queueRef, { artifactBuild });
    return "bound";
  });

  return result === "settled" ? null : artifactBuild;
}

function receiptTimestamp(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < 0 ||
    !Number.isSafeInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds > 999_999_999
  ) {
    return null;
  }
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}

function queueIncludesArtifact(queue, receipt) {
  const build = queue?.artifactBuild;
  const cutoff = receiptTimestamp(receipt?.cutoffAt);
  const expectedCutoff = timestampParts(build?.cutoffAt);
  if (
    !build ||
    !cutoff ||
    !expectedCutoff ||
    receipt?.buildBatchId !== build.buildBatchId ||
    receipt?.generation !== build.generation ||
    receipt?.commitSha !== build.commitSha ||
    cutoff.seconds !== expectedCutoff.seconds ||
    cutoff.nanoseconds !== expectedCutoff.nanoseconds ||
    !Array.isArray(receipt?.families)
  ) {
    return false;
  }

  const versionsByCollection = new Map();
  for (const collection of ["cmsPages", "cmsPosts", "cmsSettings"]) {
    const family = receipt.families.find(
      (candidate) => candidate?.collection === collection && candidate.complete === true,
    );
    if (!family || !Array.isArray(family.artifacts)) return false;
    const versions = new Map();
    for (const artifact of family.artifacts) {
      if (
        !artifact ||
        typeof artifact.documentId !== "string" ||
        !Number.isSafeInteger(artifact.sourceVersion) ||
        versions.has(artifact.documentId)
      ) {
        return false;
      }
      versions.set(artifact.documentId, artifact.sourceVersion);
    }
    versionsByCollection.set(collection, versions);
  }

  const requested = Array.isArray(queue.changes) ? queue.changes : [];
  const addressed = addressedPublishChanges(requested);
  if (addressed.length !== requested.length) return false;
  return addressed.every(
    (change) =>
      change.operation === "withdraw"
        ? !versionsByCollection.get(change.collection).has(change.id)
        : versionsByCollection.get(change.collection)?.get(change.id) === change.sourceVersion,
  );
}

module.exports = {
  queueIncludesArtifact,
  reserveCmsPublishArtifact,
  sameQueueArtifactBuild,
  timestampParts,
};

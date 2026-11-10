"use strict";

// Retained queue claims and receipt validation for artifact and exact-record
// recovery. The retired OFJ listener has no replacement here; cloud ownership
// uses its own scoped queues and rejects legacy serializer work.

const { assertPublicationOwner, assertRuntimeSource } = require("./publication-runtime-owner");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const {
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");
const {
  assertCmsPublicationClaim,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./cms-publication-runtime-control");

const QUEUE_COLLECTION = "cmsPublishQueue";
const SERIALIZER_CLAIM_SCHEMA_VERSION = 1;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const CLAIM_TOKEN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TERMINAL_STATUSES = new Set([
  "success",
  "failed",
  "cancelled",
]);
const CLAIM_FIELDS = new Set([
  "schemaVersion",
  "serializerId",
  "buildBatchId",
  "commitSha",
  "tokenDigest",
  "claimedAt",
]);

function serializerError(message) {
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
    serializerError("firestore is required");
  }
}

function projectClaim(value) {
  if (
    !hasExactFields(value, CLAIM_FIELDS) ||
    value.schemaVersion !== SERIALIZER_CLAIM_SCHEMA_VERSION ||
    !SERIALIZER_ID.test(value.serializerId ?? "") ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !isCommitSha(value.commitSha) ||
    !TOKEN_DIGEST.test(value.tokenDigest ?? "") ||
    timestampMillis(value.claimedAt) === null
  ) {
    serializerError("The CMS publication serializer claim is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    serializerId: value.serializerId,
    buildBatchId: value.buildBatchId,
    commitSha: value.commitSha,
    tokenDigest: value.tokenDigest,
    claimedAt: value.claimedAt,
  };
}

function claimInput({
  queueId,
  buildBatchId,
  commitSha,
  serializerId,
  claimToken,
}) {
  if (
    !QUEUE_ID.test(queueId ?? "") ||
    !isPublicDeploymentIdentifier(buildBatchId) ||
    !isCommitSha(commitSha) ||
    !SERIALIZER_ID.test(serializerId ?? "") ||
    !CLAIM_TOKEN.test(claimToken ?? "")
  ) {
    serializerError("The CMS publication serializer claim input is invalid");
  }
  const tokenDigest = cmsPublicationSerializerTokenDigest(claimToken);
  return {
    queueId,
    claim: {
      schemaVersion: SERIALIZER_CLAIM_SCHEMA_VERSION,
      serializerId,
      buildBatchId,
      commitSha,
      tokenDigest,
    },
  };
}

function cmsPublicationSerializerTokenDigest(claimToken) {
  if (!CLAIM_TOKEN.test(claimToken ?? "")) {
    serializerError("The CMS publication serializer claim token is invalid");
  }
  return createHash("sha256")
    .update("cms-publication-serializer-v1\0")
    .update(claimToken.toLowerCase())
    .digest("hex");
}

function claimWithoutTimestamp(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== "claimedAt"),
  );
}

async function claimCmsPublishQueue({
  firestore,
  queueId,
  buildBatchId,
  commitSha,
  serializerId,
  claimToken,
  runtime,
}) {
  assertFirestore(firestore);
  const executor = runtime ?? { owner: "node-compute", release: commitSha };
  assertRuntimeSource(executor, commitSha);
  if (executor.owner !== "node-compute") serializerError("Cloud cannot consume legacy serializer work");
  const requested = claimInput({
    queueId,
    buildBatchId,
    commitSha,
    serializerId,
    claimToken,
  });
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const result = await firestore.runTransaction(async (transaction) => {
    const runtimeControl =
      await readCmsPublicationRuntimeControlInTransaction({
        firestore,
        transaction,
      });
    const snapshot = await transaction.get(queueRef);
    if (!snapshot.exists) {
      serializerError(`Publish queue ${queueId} was not found`);
    }
    const queue = snapshot.data();
    assertPublicationOwner(queue, executor);
    if (queue.transport !== "serializer") {
      serializerError(
        `Publish queue ${queueId} is not owned by the CMS publication serializer`,
      );
    }
    if (
      queue.commitSha !== undefined &&
      (!isCommitSha(queue.commitSha) || queue.commitSha !== commitSha)
    ) {
      serializerError(`Publish queue ${queueId} source commit conflicts`);
    }
    if (TERMINAL_STATUSES.has(queue.status)) {
      return {
        outcome: "terminal",
        idempotent: true,
        status: queue.status,
      };
    }
    if (timestampMillis(queue.triggeredAt) === null) {
      serializerError("The CMS publication queue trigger time is invalid");
    }
    if (queue.serializerClaim !== undefined) {
      const stored = projectClaim(queue.serializerClaim);
      if (queue.status !== "publishing") {
        serializerError("The CMS publication serializer claim state is invalid");
      }
      if (isDeepStrictEqual(claimWithoutTimestamp(stored), requested.claim)) {
        assertCmsPublicationClaim(runtimeControl, {
          commitSha,
          serializerId,
        });
        return { outcome: "claimed", idempotent: true, receipt: stored };
      }
      assertCmsPublicationClaim(runtimeControl, {
        commitSha,
        serializerId,
      });
      return { outcome: "busy", idempotent: false };
    }
    if (queue.status === "publishing") {
      return { outcome: "busy", idempotent: false };
    }
    if (queue.status !== "pending") {
      serializerError(`Publish queue ${queueId} is already ${String(queue.status)}`);
    }
    assertCmsPublicationClaim(runtimeControl, { commitSha, serializerId });
    transaction.update(queueRef, {
      status: "publishing",
      serializerClaim: {
        ...requested.claim,
        claimedAt: FieldValue.serverTimestamp(),
      },
    });
    return { outcome: "claimed", idempotent: false, receipt: null };
  });
  if (result.outcome !== "claimed" || result.receipt) return result;

  const snapshot = await queueRef.get();
  const receipt = projectClaim(snapshot.data()?.serializerClaim);
  if (!isDeepStrictEqual(claimWithoutTimestamp(receipt), requested.claim)) {
    serializerError(`Publish queue ${queueId} serializer claim conflicts`);
  }
  return { outcome: "claimed", idempotent: false, receipt };
}

module.exports = {
  claimCmsPublishQueue,
  cmsPublicationSerializerTokenDigest,
  projectClaim,
};

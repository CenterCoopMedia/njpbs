"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
} = require("./cms-settings-contract");

const CONTENT_PUBLISHABLE_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);
// The settings documents the public build reads at its cutoff.
const PUBLIC_SETTINGS_IDS = new Set([
  require("./cms-settings-contract").STORY_CTAS_SETTINGS_ID,
  require("./cms-settings-contract").COVERAGE_LABELS_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
]);
const PUBLISH_BUILD_PENDING_FIELD = "publishBuildPending";
const PUBLISH_BUILD_QUEUE_FIELD = "publishBuildQueueId";
const PUBLISH_BUILD_SETTLEMENT_FIELD = "publishBuildSettlement";
const PUBLIC_SOURCE_VERSION_FIELD = "publicSourceVersion";
function addressedPublishChanges(changes) {
  const addressed = new Map();
  for (const change of Array.isArray(changes) ? changes : []) {
    const isContent = CONTENT_PUBLISHABLE_COLLECTIONS.has(change?.collection);
    const isPublicSetting =
      change?.collection === "cmsSettings" &&
      PUBLIC_SETTINGS_IDS.has(change?.id);
    if (
      !change ||
      (!isContent && !isPublicSetting) ||
      typeof change.id !== "string" ||
      change.id.length === 0 ||
      change.id.includes("/") ||
      !Number.isSafeInteger(change.sourceVersion) ||
      change.sourceVersion < 1 ||
      (change.operation !== undefined &&
        (change.operation !== "withdraw" || !isContent))
    ) {
      continue;
    }
    addressed.set(`${change.collection}/${change.id}`, {
      collection: change.collection,
      id: change.id,
      sourceVersion: change.sourceVersion,
      ...(change.operation === "withdraw" ? { operation: "withdraw" } : {}),
    });
  }
  return [...addressed.values()];
}

function addressedContentChanges(changes) {
  return addressedPublishChanges(changes).filter((change) =>
    CONTENT_PUBLISHABLE_COLLECTIONS.has(change.collection));
}

function isPendingPublishChange(document, change) {
  return Boolean(
    (change.operation === "withdraw"
      ? document?.publiclyVisible === false
      : document?.status === "published" || document?.publiclyVisible === true) &&
      document?.[PUBLISH_BUILD_PENDING_FIELD] === true &&
      document?.published?.sourceVersion === change.sourceVersion &&
      !document?.[PUBLISH_BUILD_QUEUE_FIELD],
  );
}

function isConfirmedPublishChange(document, change) {
  return Boolean(
    (change.operation === "withdraw"
      ? document?.publiclyVisible === false
      : document?.status === "published" || document?.publiclyVisible === true) &&
      document?.[PUBLISH_BUILD_PENDING_FIELD] !== true &&
      document?.published?.sourceVersion === change.sourceVersion,
  );
}

function projectArtifactBuildRollback(queue) {
  const value = queue.artifactBuildRollback;
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.artifactBuild ||
    !Object.hasOwn(value, "completedAt") ||
    !Object.hasOwn(value, "deploymentClaim")
  ) {
    throw new Error("Publish queue artifact retry rollback is invalid");
  }
  return value;
}

function restoreUnconfirmedArtifactUpdate(rollback) {
  return {
    status: "public_unconfirmed",
    completedAt: rollback.completedAt,
    error: FieldValue.delete(),
    artifactBuild: rollback.artifactBuild,
    artifactBuildRollback: FieldValue.delete(),
    deploymentClaim:
      rollback.deploymentClaim === null
        ? FieldValue.delete()
        : rollback.deploymentClaim,
  };
}

async function markBuildEnqueuedInTransaction(
  firestore,
  transaction,
  { queueId, changes },
) {
  if (typeof queueId !== "string" || queueId.length === 0) return 0;
  const addressed = addressedContentChanges(changes);
  if (addressed.length === 0) return 0;

  const current = [];
  for (const change of addressed) {
    const ref = firestore.collection(change.collection).doc(change.id);
    current.push({
      change,
      ref,
      snapshot: await transaction.get(ref),
    });
  }
  let marked = 0;
  for (const item of current) {
    if (item.change.collection === "cmsPages" && item.change.operation !== "withdraw" &&
        item.snapshot.exists && isPendingPublishChange(item.snapshot.data(), item.change)) {
      await require("./page-reader-compatibility").assertInstalledPageReaders({ firestore, transaction,
        pageId: item.change.id, blocks: item.snapshot.data().published?.blocks });
    }
  }
  for (const item of current) {
    if (!item.snapshot.exists) continue;
    const document = item.snapshot.data();
    if (isPendingPublishChange(document, item.change)) {
      transaction.update(item.ref, {
        [PUBLISH_BUILD_QUEUE_FIELD]: queueId,
      });
      marked += 1;
    }
  }
  return marked;
}

async function settleBuildQueue(
  firestore,
  {
    queueId,
    status,
    queueUpdate,
    acceptQueue = null,
    preflight = null,
    returnResult = false,
  },
) {
  if (typeof queueId !== "string" || queueId.length === 0) return false;
  const result = await firestore.runTransaction((transaction) =>
    settleBuildQueueInTransaction(firestore, transaction, {
      queueId, status, queueUpdate, acceptQueue, preflight,
    }));
  if (returnResult) {
    return {
      settled: result !== false,
      idempotent: result === "idempotent",
    };
  }
  return result !== false;
}

// Keep operator cancellation and workflow settlement on the same revision rules.
async function settleBuildQueueInTransaction(
  firestore,
  transaction,
  { queueId, status, queueUpdate, acceptQueue = null, preflight = null },
) {
  const queueRef = firestore.collection("cmsPublishQueue").doc(queueId);
  const queueSnapshot = await transaction.get(queueRef);
  if (!queueSnapshot.exists) return false;
  const queue = queueSnapshot.data();
  if (acceptQueue && !acceptQueue(queue)) return false;
  const artifactRetryRollback = projectArtifactBuildRollback(queue);
  const retryFailed =
    artifactRetryRollback !== null &&
    (status === "failed" || status === "cancelled");
  // Workflow callbacks are at-least-once: a rerun or delayed terminal step
  // can report the same queue again. Success is monotonic and can never be
  // regressed by a later failure/cancellation. Repeated failed/cancelled
  // callbacks are also no-ops. A later deployed result may upgrade a failure
  // or cancellation to public_unconfirmed, and an exact public receipt may
  // upgrade any of those states to success.
  if (
    queue.status === "success" ||
    (["failed", "cancelled"].includes(queue.status) &&
      !["success", "public_unconfirmed"].includes(status)) ||
    (queue.status === "public_unconfirmed" && status !== "success")
  ) {
    return "idempotent";
  }
  if (preflight) await preflight({ transaction, queue, queueRef });
  const artifactSettled =
    retryFailed || status === "success" || status === "public_unconfirmed";
  const confirmsUnconfirmedDeployment =
    queue.status === "public_unconfirmed" && status === "success";
  const lateSettlement =
    artifactSettled &&
    ["public_unconfirmed", "failed", "cancelled"].includes(queue.status);

  const current = [];
  for (const change of addressedContentChanges(queue.changes)) {
    const ref = firestore.collection(change.collection).doc(change.id);
    current.push({
      change,
      ref,
      snapshot: await transaction.get(ref),
    });
  }

  // Use one exact revision predicate for both settlement and Home invalidation.
  // All Home authority/task reads must finish before the first queue write.
  const settling = current.filter(item => {
    if (!item.snapshot.exists) return false;
    const document = item.snapshot.data();
    return (
      (item.change.operation === "withdraw"
        ? document?.publiclyVisible === false
        : document?.status === "published" || document?.publiclyVisible === true) &&
      (document?.[PUBLISH_BUILD_PENDING_FIELD] === true ||
        (confirmsUnconfirmedDeployment && document?.[PUBLISH_BUILD_PENDING_FIELD] === false)) &&
      document?.published?.sourceVersion === item.change.sourceVersion &&
      (document?.[PUBLISH_BUILD_QUEUE_FIELD] === queueId ||
        (lateSettlement && !document?.[PUBLISH_BUILD_QUEUE_FIELD]))
    );
  });
  const settlingPosts = settling.filter(item => item.change.collection === "cmsPosts");
  const fullBuildHomeTransport = queue.transport === "serializer" ||
    (queue.transport === "github" && queue.runtime?.owner === "cloudflare");
  const writeHomeRefresh = status === "success" && fullBuildHomeTransport && settlingPosts.length
    ? await require("./no-build-home-ownership").prepareHomeFullBuildPostRefreshInTransaction({
      firestore, transaction, queueId, sourceTransport: queue.transport,
      posts: settlingPosts.map(item => ({ postId: item.change.id, nextDocument: item.snapshot.data() })),
    })
    : () => {};

  let resolvedQueueUpdate =
    typeof queueUpdate === "function" ? queueUpdate(queue) : queueUpdate;
  if (
    !resolvedQueueUpdate ||
    typeof resolvedQueueUpdate !== "object" ||
    Array.isArray(resolvedQueueUpdate)
  ) {
    throw new Error("Publish queue update is invalid");
  }
  if (retryFailed) {
    resolvedQueueUpdate = restoreUnconfirmedArtifactUpdate(
      artifactRetryRollback,
    );
  } else if (artifactRetryRollback !== null) {
    resolvedQueueUpdate = {
      ...resolvedQueueUpdate,
      artifactBuildRollback: FieldValue.delete(),
    };
  }
  transaction.update(queueRef, resolvedQueueUpdate);
  for (const item of settling) {
    transaction.update(item.ref, {
      [PUBLISH_BUILD_PENDING_FIELD]: artifactSettled ? false : true,
      [PUBLISH_BUILD_QUEUE_FIELD]: null,
      [PUBLISH_BUILD_SETTLEMENT_FIELD]: {
        status: retryFailed ? "public_unconfirmed" : status,
        sourceVersion: item.change.sourceVersion,
        operation: item.change.operation ?? "publish",
        ...(status === "success" && queue.transport === "page-no-build-v1" ? {
          pageReceipt: { operationId: queueId, sourceVersion: item.change.sourceVersion,
            visible: item.change.operation !== "withdraw" },
        } : {}),
      },
      ...(status === "success"
        ? { [PUBLIC_SOURCE_VERSION_FIELD]: item.change.operation === "withdraw" ? null : item.change.sourceVersion }
        : {}),
    });
  }
  writeHomeRefresh();
  return "settled";
}

module.exports = {
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  PUBLISH_BUILD_SETTLEMENT_FIELD,
  PUBLIC_SOURCE_VERSION_FIELD,
  addressedPublishChanges,
  isConfirmedPublishChange,
  isPendingPublishChange,
  markBuildEnqueuedInTransaction,
  settleBuildQueue,
  settleBuildQueueInTransaction,
};

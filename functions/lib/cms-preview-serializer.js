"use strict";

// Durable queue ownership and bounded restart recovery for the private preview
// artifact serializer. This module has no handler, function export, credential,
// environment, build, upload, deployment, or automatic caller.

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { previewTimings, previewStartup } = require("./preview-timings");
const previewPairs = require("./cms-preview-pair");
const { timestampMillis } = require("./public-deployment");
const { validPreviewTarget, previewTargetPath } = require("./preview-target");
const {
  PREVIEW_BUILD_TIMEOUT_MS,
  PREVIEW_BUILD_TIMEOUT_ERROR,
} = require("./preview-build-policy");

const QUEUE_COLLECTION = "cmsPreviewQueue";
const PREVIEW_CLAIM_SCHEMA_VERSION = 1;
const MAX_PENDING_LISTENER_ROWS = 10;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const CLAIM_TOKEN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const TERMINAL_STATUSES = new Set(["ready", "failed", "expired"]);
const CLAIM_FIELDS = new Set([
  "schemaVersion",
  "serializerId",
  "rendererSha",
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
  return (
    plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field))
  );
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
    value.schemaVersion !== PREVIEW_CLAIM_SCHEMA_VERSION ||
    !SERIALIZER_ID.test(value.serializerId ?? "") ||
    !COMMIT_SHA.test(value.rendererSha ?? "") ||
    !TOKEN_DIGEST.test(value.tokenDigest ?? "") ||
    timestampMillis(value.claimedAt) === null
  ) {
    serializerError("The CMS preview serializer claim is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    serializerId: value.serializerId,
    rendererSha: value.rendererSha,
    tokenDigest: value.tokenDigest,
    claimedAt: value.claimedAt,
  };
}

function claimInput({ queueId, rendererSha, serializerId, claimToken }) {
  if (
    !QUEUE_ID.test(queueId ?? "") ||
    !COMMIT_SHA.test(rendererSha ?? "") ||
    !SERIALIZER_ID.test(serializerId ?? "") ||
    !CLAIM_TOKEN.test(claimToken ?? "")
  ) {
    serializerError("The CMS preview serializer claim input is invalid");
  }
  const tokenDigest = createHash("sha256")
    .update("cms-preview-serializer-v1\0")
    .update(claimToken.toLowerCase())
    .digest("hex");
  return {
    queueId,
    claim: {
      schemaVersion: PREVIEW_CLAIM_SCHEMA_VERSION,
      serializerId,
      rendererSha,
      tokenDigest,
    },
  };
}

function claimWithoutTimestamp(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== "claimedAt"),
  );
}

async function claimCmsPreviewQueue({
  firestore,
  queueId,
  rendererSha,
  serializerId,
  claimToken,
  now = () => Date.now(),
}) {
  assertFirestore(firestore);
  const requested = claimInput({
    queueId,
    rendererSha,
    serializerId,
    claimToken,
  });
  const currentTime = Number(now());
  if (!Number.isFinite(currentTime)) {
    serializerError("The CMS preview serializer clock is invalid");
  }
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const result = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(queueRef);
    if (!snapshot.exists) {
      serializerError(`Preview queue ${queueId} was not found`);
    }
    const queue = snapshot.data();
    if (queue.previewPairId !== undefined) {
      const selector = previewPairs.parseSelector((await transaction.get(firestore.doc(previewPairs.SELECTOR_PATH))).data());
      const pair = previewPairs.parsePair((await transaction.get(
        firestore.collection(previewPairs.PAIRS).doc(queue.previewPairId))).data());
      if (![selector.selectedPairId, selector.recoveryPairId].includes(pair.pairId) ||
          pair.pairId !== queue.previewPairId || pair.rendererSha !== rendererSha ||
          pair.serializerId !== serializerId || queue.serializerId !== serializerId || queue.previewRequestContract !== 1) {
        serializerError("The CMS preview queue belongs to another retained pair");
      }
    }
    if (queue.transport !== "serializer") {
      serializerError(
        `Preview queue ${queueId} is not owned by the CMS preview serializer`,
      );
    }
    if (TERMINAL_STATUSES.has(queue.status)) {
      return {
        outcome: "terminal",
        idempotent: true,
        status: queue.status,
      };
    }
    const requestedAt = timestampMillis(queue.requestedAt);
    const expiresAt = timestampMillis(queue.expiresAt);
    if (
      requestedAt === null ||
      expiresAt === null ||
      expiresAt <= requestedAt ||
      !Number.isSafeInteger(queue.sourceVersion) ||
      queue.sourceVersion < 1 ||
      queue.rendererSha !== rendererSha
    ) {
      serializerError("The CMS preview queue identity is invalid");
    }
    if (requestedAt + PREVIEW_BUILD_TIMEOUT_MS <= currentTime) {
      transaction.update(queueRef, {
        status: "failed",
        completedAt: Timestamp.fromMillis(currentTime),
        previewUrl: null,
        error: PREVIEW_BUILD_TIMEOUT_ERROR,
      });
      return { outcome: "terminal", idempotent: false, status: "failed" };
    }
    if (expiresAt <= currentTime) {
      transaction.update(queueRef, {
        status: "expired",
        completedAt: FieldValue.serverTimestamp(),
        previewUrl: null,
        error: null,
      });
      return { outcome: "terminal", idempotent: false, status: "expired" };
    }
    if (queue.serializerClaim !== undefined) {
      const stored = projectClaim(queue.serializerClaim);
      if (queue.status !== "building") {
        serializerError("The CMS preview serializer claim state is invalid");
      }
      if (isDeepStrictEqual(claimWithoutTimestamp(stored), requested.claim)) {
        return { outcome: "claimed", idempotent: true, receipt: stored };
      }
      return { outcome: "busy", idempotent: false };
    }
    if (queue.status === "building") {
      return { outcome: "busy", idempotent: false };
    }
    if (queue.status !== "pending") {
      serializerError(
        `Preview queue ${queueId} is already ${String(queue.status)}`,
      );
    }
    transaction.update(queueRef, {
      status: "building",
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
    serializerError(`Preview queue ${queueId} serializer claim conflicts`);
  }
  return { outcome: "claimed", idempotent: false, receipt };
}

function asError(value, fallback) {
  return value instanceof Error ? value : new Error(fallback);
}

async function setCmsPreviewContextRefreshing({ firestore, refreshing, ...input }) {
  assertFirestore(firestore);
  if (typeof refreshing !== "boolean") serializerError("The CMS preview progress input is invalid");
  const requested = claimInput(input);
  return firestore.runTransaction(async transaction => {
    const ref = firestore.collection(QUEUE_COLLECTION).doc(input.queueId);
    const queue = (await transaction.get(ref)).data();
    if (queue?.status !== "building" ||
        !isDeepStrictEqual(claimWithoutTimestamp(projectClaim(queue.serializerClaim)), requested.claim)) {
      serializerError("The CMS preview progress does not own this queue");
    }
    if (queue.contextRefreshing !== refreshing) transaction.update(ref, { contextRefreshing: refreshing });
  });
}

/** Record a processor result only for its exact retained claim and snapshot.
 * The processor calls this after all artifact uploads succeed. It cannot supply
 * an arbitrary reviewer URL, and a late result cannot revive a terminal queue.
 */
async function finishCmsPreviewQueue({
  firestore,
  deploymentEnvironment = "production",
  queueId,
  rendererSha,
  serializerId,
  claimToken,
  pageId,
  collection = "cmsPages",
  persistent = false,
  sourceVersion,
  expiresAtMs,
  status,
  timingsMs,
  startup,
  failureReason,
  now = () => Date.now(),
}) {
  assertFirestore(firestore);
  const requested = claimInput({ queueId, rendererSha, serializerId, claimToken });
  const currentTime = Number(now());
  if (
    !validPreviewTarget(collection, pageId) ||
    !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 ||
    !Number.isSafeInteger(expiresAtMs) || !/^\d{13}$/.test(String(expiresAtMs)) ||
    !Number.isSafeInteger(currentTime) ||
    (status !== "ready" && status !== "failed") ||
    (failureReason !== undefined && (status !== "failed" || failureReason !== "preview_context_refreshing"))
  ) {
    serializerError("The CMS preview completion input is invalid");
  }
  const isDev = firestore.projectId === "njpbs-site-dev";
  if (deploymentEnvironment === "development" && !isDev) {
    serializerError("Dev preview completion refused for another project");
  }
  const previewOrigin = isDev ? "https://dev-preview.example.org" : "https://preview.njpbs.org";
  const previewUrl = status === "ready" ? `${previewOrigin}/${persistent ? "s" : "p"}/${queueId}/` : null;
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  return firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(queueRef);
    if (!snapshot.exists) serializerError(`Preview queue ${queueId} was not found`);
    const queue = snapshot.data();
    if (
      queue.transport !== "serializer" || queue.rendererSha !== rendererSha ||
      queue.pageId !== pageId || queue.sourceVersion !== sourceVersion ||
      (queue.collection ?? "cmsPages") !== collection ||
      (queue.persistent === true) !== persistent ||
      queue.snapshot?.id !== pageId || queue.snapshot?.version !== sourceVersion ||
      timestampMillis(queue.expiresAt) !== expiresAtMs
    ) {
      serializerError("The CMS preview completion does not match its queue snapshot");
    }
    if (collection === "cmsPosts" && queue.pagePath !== previewTargetPath(collection, pageId, queue.snapshot)) {
      serializerError("The CMS post preview route does not match its snapshot");
    }
    const storedClaim = projectClaim(queue.serializerClaim);
    if (!isDeepStrictEqual(claimWithoutTimestamp(storedClaim), requested.claim)) {
      serializerError("The CMS preview completion does not own this queue");
    }
    const requestedAt = timestampMillis(queue.requestedAt);
    if (requestedAt === null || expiresAtMs <= requestedAt) {
      serializerError("The CMS preview queue timestamps are invalid");
    }
    if (TERMINAL_STATUSES.has(queue.status)) {
      // A lost transaction response can retry a ready request that settled as
      // timed out or expired. Keep that stored result even past a later deadline.
      const normalizedReady = status === "ready" && queue.previewUrl === null && (
        (queue.status === "failed" && queue.error === PREVIEW_BUILD_TIMEOUT_ERROR &&
          requestedAt + PREVIEW_BUILD_TIMEOUT_MS <= currentTime) ||
        (queue.status === "expired" && expiresAtMs <= currentTime)
      );
      if (!normalizedReady && (queue.status !== status || queue.previewUrl !== previewUrl ||
          (status === "ready" && queue.gitCommitSha !== rendererSha))) {
        serializerError("The CMS preview queue already has a different terminal result");
      }
      return { changed: false, status: queue.status, previewUrl: queue.previewUrl };
    }
    if (queue.status !== "building") serializerError("The CMS preview queue is not building");
    let terminalStatus = status;
    let error = status === "failed" ? "Preview build failed. Try again or contact an administrator." : null;
    if (failureReason === "preview_context_refreshing") {
      error = "Previews are refreshing after a recent publish. Try again in a minute.";
    }
    if (requestedAt + PREVIEW_BUILD_TIMEOUT_MS <= currentTime) {
      terminalStatus = "failed";
      error = PREVIEW_BUILD_TIMEOUT_ERROR;
      failureReason = undefined;
    } else if (expiresAtMs <= currentTime) {
      terminalStatus = "expired";
      error = null;
    }
    const finalUrl = terminalStatus === "ready" ? previewUrl : null;
    transaction.update(queueRef, {
      status: terminalStatus,
      completedAt: FieldValue.serverTimestamp(),
      timingsMs: previewTimings(timingsMs),
      startup: previewStartup(startup),
      previewUrl: finalUrl,
      error,
      failureReason: terminalStatus === "failed" ? failureReason ?? null : null,
      ...(terminalStatus === "ready" ? { gitCommitSha: rendererSha } : {}),
    });
    return { changed: true, status: terminalStatus, previewUrl: finalUrl };
  });
}

function pendingQueueId(change) {
  if (
    !plainObject(change) ||
    change.type !== "added" ||
    !plainObject(change.doc) ||
    !QUEUE_ID.test(change.doc.id ?? "")
  ) {
    serializerError("The CMS preview listener change is invalid");
  }
  return change.doc.id;
}

async function startCmsPreviewSerializerListener({
  firestore,
  serializerId,
  rendererSha,
  processQueue,
}) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    !SERIALIZER_ID.test(serializerId ?? "") ||
    (rendererSha !== undefined && !COMMIT_SHA.test(rendererSha)) ||
    typeof processQueue !== "function"
  ) {
    serializerError("The CMS preview listener input is invalid");
  }

  const collection = firestore.collection(QUEUE_COLLECTION);
  const recoverySnapshot = await collection
    .where("status", "==", "building")
    .where("serializerClaim.serializerId", "==", serializerId)
    .limit(MAX_PENDING_LISTENER_ROWS)
    .get();
  if (
    !recoverySnapshot ||
    !Array.isArray(recoverySnapshot.docs) ||
    recoverySnapshot.docs.length > MAX_PENDING_LISTENER_ROWS ||
    recoverySnapshot.docs.some(
      (document) => !plainObject(document) || !QUEUE_ID.test(document.id ?? ""),
    )
  ) {
    serializerError("The CMS preview recovery snapshot is invalid");
  }

  let detach = null;
  let closing = false;
  let closeError = null;
  let closedSettled = false;
  let draining = false;
  const pending = recoverySnapshot.docs.map((document) => document.id);
  const queued = new Set(pending);
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const settleClosed = () => {
    if (closedSettled || draining) return;
    closedSettled = true;
    if (closeError) rejectClosed(closeError);
    else resolveClosed({ reason: "stopped" });
  };

  const close = (error = null) => {
    if (closing) {
      if (error && !closeError) closeError = error;
      return;
    }
    closing = true;
    closeError = error;
    if (typeof detach === "function") detach();
    settleClosed();
  };

  const drain = async () => {
    if (draining || closing) return;
    draining = true;
    try {
      while (!closing && pending.length > 0) {
        const queueId = pending.shift();
        try {
          await processQueue(queueId);
        } catch (error) {
          close(asError(error, "CMS preview queue processing failed"));
          return;
        } finally {
          queued.delete(queueId);
        }
      }
    } finally {
      draining = false;
      if (closing) settleClosed();
    }
  };

  const receive = (snapshot) => {
    if (closing) return;
    try {
      if (!snapshot || typeof snapshot.docChanges !== "function") {
        serializerError("The CMS preview listener snapshot is invalid");
      }
      for (const change of snapshot.docChanges()) {
        if (change?.type !== "added") continue;
        const queueId = pendingQueueId(change);
        if (queued.has(queueId)) continue;
        queued.add(queueId);
        pending.push(queueId);
      }
      void drain();
    } catch (error) {
      close(asError(error, "CMS preview listener snapshot failed"));
    }
  };

  const fail = (error) => {
    close(asError(error, "CMS preview listener failed"));
  };

  let query = collection
    .where("status", "==", "pending")
    .where("transport", "==", "serializer");
  if (rendererSha !== undefined) query = query.where("rendererSha", "==", rendererSha);
  if (/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId)) query = query.where("serializerId", "==", serializerId);
  query = query.limit(MAX_PENDING_LISTENER_ROWS);
  detach = query.onSnapshot(receive, fail);
  if (typeof detach !== "function") {
    close(
      new Error("The CMS preview listener did not return a detach function"),
    );
  } else if (closing) {
    detach();
  }
  void drain();

  return {
    closed,
    stop: () => close(),
  };
}

module.exports = {
  MAX_PENDING_LISTENER_ROWS,
  claimCmsPreviewQueue,
  finishCmsPreviewQueue,
  setCmsPreviewContextRefreshing,
  projectClaim,
  startCmsPreviewSerializerListener,
};

"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { can, hasCapability } = require("./rbac");
const { contentResourceSection } = require("./content-authorization");
const { adminLogEntry } = require("./audit");
const { settleBuildQueueInTransaction } = require("./publish-build-state");
const { readNoBuildPageOwner } = require("./no-build-page-ownership");
const { readNoBuildPostOwner } = require("./no-build-post-ownership");
const { preparePageConfirmation, assertPageQueue } = require("./no-build-page-recovery");
const { assertReadbackTarget, publicReadbackHeaders, withinDeadline,
  readPublicPostReceipt, assertCurrentPostReceipt } = require("./no-build-post-recovery");

const PAGE = "page-no-build-v1", POST = "post-no-build-v1";
const PROOF_FAILED_MESSAGE = "The public check still failed. Try Check again later or contact a Site owner.";

function failedMessage(queue) {
  return queue.changes?.[0]?.operation === "withdraw"
    ? "The public site could not confirm this removal. Open the record to retry removal."
    : "The public site could not confirm this publication. Open the record to retry publication.";
}

function refuse(status, message) { throw Object.assign(new Error(message), { status }); }

const { exhaustedPostProof } = require("./no-build-post-proof-state");

function eligible(queue) {
  return ["failed", "public_unconfirmed"].includes(queue?.status) || exhaustedPostProof(queue);
}

async function readRecheck({ firestore, transaction, queueId, actor }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${queueId}`);
  const queue = (await transaction.get(queueRef)).data();
  if (!queue) refuse(404, "Publication request not found.");
  if (!eligible(queue)) refuse(409, "Only failed or unconfirmed publications can be checked again.");
  if (![PAGE, POST].includes(queue.transport)) refuse(409, failedMessage(queue));
  const page = queue.transport === PAGE;
  const operation = page ? queue.noBuildPage : queue.noBuildPost;
  const change = queue.changes?.[0];
  const collection = page ? "cmsPages" : "cmsPosts";
  const id = page ? operation?.pageId : operation?.postId;
  if (queue.changes?.length !== 1 || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      operation.operationId !== queueId || change?.collection !== collection || change.id !== id ||
      !Number.isSafeInteger(change.sourceVersion) || change.sourceVersion < 1 ||
      change.sourceVersion !== operation.sourceVersion ||
      (change.operation !== undefined && change.operation !== "withdraw") ||
      (change.operation === "withdraw") === operation.visible) refuse(409, "The publication identity is unavailable.");
  const recordRef = firestore.doc(`${collection}/${id}`);
  const record = (await transaction.get(recordRef)).data();
  const resource = { ownerId: record?.createdBy, section: contentResourceSection({ collection, documentId: id, stored: record }) };
  if (!record || !can(actor.principal, "content.publish", resource)) refuse(403, "Publish access required.");
  const { state } = page
    ? await readNoBuildPageOwner({ firestore, transaction, pageId: id })
    : await readNoBuildPostOwner({ firestore, transaction, postId: id });
  if (!state?.operationId || state.mode === "static") refuse(409, failedMessage(queue));
  const visible = record.publiclyVisible === true || record.publiclyVisible === undefined && record.status === "published";
  if (record.published?.sourceVersion !== state.sourceVersion || visible !== state.visible ||
      record.publishBuildQueueId && record.publishBuildQueueId !== state.operationId) {
    refuse(409, "The record's publication changed. Reload its status.");
  }
  const superseded = state.operationId !== queueId;
  if (superseded && !(state.generation > operation.generation && state.sourceVersion >= operation.sourceVersion)) {
    refuse(409, "A newer publication could not be identified.");
  }
  const currentQueue = superseded
    ? (await transaction.get(firestore.doc(`cmsPublishQueue/${state.operationId}`))).data() : queue;
  if (page) assertPageQueue(currentQueue, state);
  else if (currentQueue?.transport !== POST || currentQueue.noBuildPost?.operationId !== state.operationId ||
      currentQueue.noBuildPost.postId !== id || currentQueue.noBuildPost.sourceVersion !== state.sourceVersion ||
      currentQueue.noBuildPost.snapshotDigest !== state.snapshotDigest) refuse(409, "The Post publication identity changed.");
  return { queueRef, queue, recordRef, record, state, currentQueue, superseded, page };
}

async function preparePostConfirmation({ firestore, state, target, headers = {}, fetchPublic = fetch }) {
  target = assertReadbackTarget(firestore, target);
  const readHeaders = publicReadbackHeaders(target, headers);
  const receipt = await withinDeadline(10_000, signal => readPublicPostReceipt(state, fetchPublic, signal, target, readHeaders));
  return { receipt, preflight: ({ transaction }) => assertCurrentPostReceipt(firestore, transaction, state, receipt) };
}

async function recheckPublication({ firestore, queueId, actor, source = null, ...network }) {
  if (!hasCapability(actor.principal, "content.publish")) refuse(403, "Publish access required.");
  if (typeof queueId !== "string" || !/^[A-Za-z0-9]{20}$/.test(queueId)) refuse(400, "A valid publication request is required.");
  const initial = await firestore.runTransaction(transaction => readRecheck({ firestore, transaction, queueId, actor }), { readOnly: true });
  let proof;
  try {
    proof = await (initial.page ? preparePageConfirmation : preparePostConfirmation)({ firestore, state: initial.state, ...network });
  } catch { /* Failed public IO is a supported outcome, with fixed staff text. */ }
  const auditRef = firestore.collection("admin_logs").doc();
  return firestore.runTransaction(async transaction => {
    const current = await readRecheck({ firestore, transaction, queueId, actor });
    if (!isDeepStrictEqual(initial.queue, current.queue) || !isDeepStrictEqual(initial.state, current.state) ||
        !isDeepStrictEqual(initial.record, current.record) || !isDeepStrictEqual(initial.currentQueue, current.currentQueue)) {
      refuse(409, "Publication changed during the check. Reload its status.");
    }
    if (proof) await proof.preflight({ transaction, queue: current.currentQueue });
    const outcome = !proof ? "failed" : current.superseded ? "superseded" : "confirmed_late";
    let message = failedMessage(current.queue);
    if (outcome === "confirmed_late") message = "Publication confirmed on the public site.";
    if (outcome === "superseded") message = "A newer publication is live. This request no longer needs recovery.";
    if (outcome === "failed" && exhaustedPostProof(current.queue)) message = PROOF_FAILED_MESSAGE;
    const check = { outcome, actorUid: actor.uid, checkedAt: FieldValue.serverTimestamp(), message };
    if (outcome === "confirmed_late" && !exhaustedPostProof(current.queue)) {
      await settleBuildQueueInTransaction(firestore, transaction, {
        queueId, status: "success", queueUpdate: { status: "success", completedAt: FieldValue.serverTimestamp(),
          error: null, claim: null, nextAttemptAt: null, publicReceipt: proof.receipt, lastPublicCheck: check,
          ...(!current.page ? { postProof: { status: "verified", attempts: current.queue.postProof?.attempts ?? 0,
            claim: null, nextAttemptAt: null, error: null, completedAt: FieldValue.serverTimestamp() } } : {}) },
      });
    } else {
      const update = { lastPublicCheck: check };
      if (outcome === "superseded" && !exhaustedPostProof(current.queue)) Object.assign(update, {
        status: "superseded", completedAt: FieldValue.serverTimestamp(), error: null, claim: null, nextAttemptAt: null,
        supersededBy: current.state.operationId,
      });
      if (exhaustedPostProof(current.queue) && proof) {
        update.postProof = { ...current.queue.postProof, status: current.superseded ? "superseded" : "verified",
          claim: null, nextAttemptAt: null, error: null, completedAt: FieldValue.serverTimestamp() };
        if (!current.superseded) update.publicReceipt = proof.receipt;
      }
      transaction.update(current.queueRef, update);
    }
    if (outcome === "confirmed_late" && !current.page && current.state.visible &&
        current.record.published?.sourceVersion === current.state.sourceVersion) {
      transaction.update(current.recordRef, { publicPostProof: { operationId: queueId,
        sourceVersion: current.state.sourceVersion, status: "verified", retryPending: false } });
    }
    transaction.create(auditRef, adminLogEntry({ actorUid: actor.uid, actorEmail: actor.email ?? null,
      action: "cms.publicationRechecked", target: queueId, source,
      before: { status: current.queue.status },
      after: { outcome, operationId: current.state.operationId, sourceVersion: current.state.sourceVersion,
        ...(proof ? { receipt: proof.receipt } : {}) },
    }));
    return { success: true, queueId, outcome, message };
  });
}

module.exports = { recheckPublication, exhaustedPostProof };

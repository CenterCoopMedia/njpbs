"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { can, canEditContent } = require("./rbac");
const { contentResourceSection } = require("./content-authorization");
const { addressedPublishChanges } = require("./publish-build-state");
const { newDevGithubQueueFields } = require("./dev-publication-queue");
const { assertSerializerPublicationEnabledInTransaction } = require("./serializer-publication-control");
const {
  assertCmsPublicationAdmission,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./cms-publication-runtime-control");

function reject(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function createPublicationReservation(firestore, { actor, changes, source, transport }) {
  const queueRef = firestore.collection("cmsPublishQueue").doc();
  const auditRef = firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc();
  const queue = {
    status: "reserved", transport,
    triggeredBy: actor.uid, triggeredByEmail: actor.email ?? null,
    triggeredAt: FieldValue.serverTimestamp(), completedAt: null, error: null, changes,
  };
  const audit = adminLogEntry({
    actorUid: actor.uid, actorEmail: actor.email ?? null,
    action: "cms.publicationRequested", target: queueRef.id,
    after: { status: "reserved", transport, changes }, source,
  });
  return { queueRef, auditRef, queue, audit };
}

// A retry requeues an immutable public snapshot or its withdrawal. It never
// saves the working copy. Reserve the queue with its owner in one transaction,
// so two requests cannot create two independently owned publication jobs.
async function reservePublicationRetry({ firestore, actor, changes, baseVersion, source, transport, assertInTransactionFn = null }) {
  const addressed = addressedPublishChanges(changes);
  if (addressed.length !== 1 || changes.length !== 1 ||
      !["cmsPages", "cmsPosts"].includes(addressed[0].collection) ||
      !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
    reject(400, "Retry requires one exact content version.");
  }
  const change = addressed[0];
  const contentRef = firestore.collection(change.collection).doc(change.id);
  const reservation = createPublicationReservation(firestore, { actor, changes: addressed, source, transport });
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(contentRef);
    const runtimeControl =
      await readCmsPublicationRuntimeControlInTransaction({
        firestore,
        transaction,
      });
    const stored = snapshot.exists ? snapshot.data() : null;
    const resource = {
      ownerId: stored?.createdBy,
      section: contentResourceSection({ collection: change.collection, documentId: change.id, stored }),
    };
    const withdrawal = change.operation === "withdraw";
    const allowed = withdrawal
      ? can(actor.principal, "content.unpublish", resource) || can(actor.principal, "content.delete", resource)
      : canEditContent(actor.principal, resource) || can(actor.principal, "content.publish", resource);
    if (!allowed) reject(403, "Publication access required.");
    const visible = stored?.publiclyVisible === true ||
      (stored?.publiclyVisible === undefined && stored?.status === "published");
    if (!stored || stored.deleted === true || stored.version !== baseVersion ||
        stored.published?.sourceVersion !== change.sourceVersion || visible === withdrawal) {
      reject(409, "Publication changed. Reload its status before retrying.");
    }
    await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
    const existingId = stored.publishBuildQueueId;
    const writeRetry = assertInTransactionFn ? await assertInTransactionFn({ transaction, stored, reservation }) : null;
    if (existingId) {
      if (typeof existingId !== "string" || existingId.includes("/")) reject(409, "The existing publication needs recovery.");
      const existing = await transaction.get(firestore.collection("cmsPublishQueue").doc(existingId));
      if (existing.exists) {
        const queue = existing.data();
        if (["reserved", "pending", "publishing"].includes(queue.status)) {
          const matching = addressedPublishChanges(queue.changes).some((entry) =>
            entry.collection === change.collection && entry.id === change.id &&
            entry.sourceVersion === change.sourceVersion && entry.operation === change.operation);
          if (!matching || !["github", "serializer"].includes(queue.transport) ||
              typeof queue.triggeredBy !== "string" || !queue.triggeredBy) {
            reject(409, "The existing publication does not match this version. Contact an administrator.");
          }
          // Only an exact single-change reservation can be resumed by this
          // endpoint. A shared scheduled batch stays owned by its batch runner.
          if (writeRetry) writeRetry();
          return { queueId: existingId, reserved: queue.status === "reserved" && queue.changes.length === 1, transport: queue.transport, existing: true,
            actor: { uid: queue.triggeredBy, email: queue.triggeredByEmail ?? null } };
        }
        if (!["success", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(queue.status)) {
          reject(409, "The existing publication needs recovery.");
        }
      }
    }
    await assertSerializerPublicationEnabledInTransaction({ firestore, transaction });
    assertCmsPublicationAdmission(runtimeControl);
    Object.assign(reservation.queue, await newDevGithubQueueFields({ firestore, transaction,
      control: runtimeControl, transport }));
    if (writeRetry) writeRetry();
    transaction.update(contentRef, {
      publishBuildPending: true, publishBuildQueueId: reservation.queueRef.id,
    });
    transaction.create(reservation.queueRef, reservation.queue);
    transaction.create(reservation.auditRef, reservation.audit);
    return { queueId: reservation.queueRef.id, reserved: true, transport, existing: false };
  });
}

module.exports = { createPublicationReservation, reservePublicationRetry };

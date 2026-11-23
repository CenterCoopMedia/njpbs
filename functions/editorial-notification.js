"use strict";

const logger = require("firebase-functions/logger");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { admin, db } = require("./lib/firebase");
const { AUDIT_COLLECTIONS } = require("./lib/audit");
const { accessTierReadsActive } = require("./lib/access-tier-activation");
const { editorialRecipient, staffAccessFields } = require("./lib/editorial-notice");
const { STAFF_EMAIL_API_TOKEN, deliverStaffAccessEmail, queueStaffAccessEmail } = require("./staff-access-email");

async function deliverEditorialNotification(auditId, audit, deps = {}) {
  if (!audit?.after?.editorialNotice) return [];

  const { firestore = db, authClient = admin.auth(), now = () => new Date() } = deps;
  const { assignee, requester, ...notice } = audit.after.editorialNotice;
  const tiersActive = await accessTierReadsActive(firestore);
  const users = firestore.collection("users");
  const candidates = notice.action === "submit" ? [assignee] : [notice.ownerId, requester, assignee];
  const ids = [...new Set(candidates)].filter(uid => typeof uid === "string" &&
    uid !== audit.actorUid && uid.length > 0 && uid.length <= 128 &&
    !uid.includes("/") && uid !== "." && uid !== ".." && !/^__.*__$/.test(uid));
  const profiles = ids.length ? await firestore.getAll(...ids.map(uid => users.doc(uid)),
    { fieldMask: staffAccessFields }) : [];
  const recipientsFor = async (profiles) => (await Promise.all(profiles.map(profile =>
    editorialRecipient(firestore, authClient, tiersActive, profile, notice)))).filter(Boolean);
  let recipients = await recipientsFor(profiles);
  if (notice.action === "submit" && recipients.length === 0) {
    const reviewers = await users.select(...staffAccessFields).get();
    recipients = await recipientsFor(reviewers.docs.filter(profile => profile.id !== audit.actorUid));
  }

  const unique = new Map(recipients.map(recipient => [recipient.to, recipient]));
  const attempts = await Promise.allSettled([...unique.values()].map(async ({ uid, to }) => {
    // Firestore can deliver a creation event more than once. A replay never
    // resets a claimed or settled outbox row.
    const batch = firestore.batch();
    const id = queueStaffAccessEmail(batch, firestore, {
      uid, to, eventType: "editorial", deliveryId: auditId, editorialNotice: notice,
    }, now(), { createOnly: true });
    try {
      await batch.commit();
    } catch (error) {
      if (error.code !== 6) throw error; // ALREADY_EXISTS
    }
    return deliverStaffAccessEmail(id, { ...deps, firestore, authClient, now });
  }));
  if (attempts.some(attempt => attempt.status === "rejected")) {
    throw new Error("Editorial notification outbox processing failed");
  }
  return attempts.map(attempt => attempt.value);
}

const onEditorialNotificationCreated = onDocumentCreated({
  document: `${AUDIT_COLLECTIONS.adminLogs}/{auditId}`,
  secrets: [STAFF_EMAIL_API_TOKEN],
  retry: true,
}, async (event) => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  try {
    const results = await deliverEditorialNotification(event.params.auditId, event.data?.data());
    if (results.length) {
      logger.info("Editorial notification processed", { states: results.map(result => result.state) });
    }
  } catch {
    // Provider and identity errors can contain addresses. Keep them out of
    // logs and let the trigger retry the idempotent outbox operation.
    throw new Error("Editorial notification processing failed");
  }
});

module.exports = { deliverEditorialNotification, onEditorialNotificationCreated };

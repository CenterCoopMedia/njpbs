"use strict";

// Automation accounts (#4716, #4717). A document at cmsAutomationAccounts/{uid} marks a staff
// identity that scripts and agents use instead of a person. The marker is server-only:
// firestore.rules refuses every client read and write, so a client cannot remove it and turn
// these guards off.
//
// The Boardwalk editing lock is a client-written courtesy lease (cmsEditorLocks). Staff saves
// still rely on it only as presence, plus the optimistic baseVersion check. An automation
// account must do more: it must hold its own live lease on the record and echo the exact
// version it read. A person who has the record open therefore never loses unsaved work to an
// agent save, and an agent never overwrites a version it did not read. The lease rules admit
// site-wide editors and administrators, so an automation account needs a site-wide grant. The
// same rules refuse a marked account a forced takeover of another person's live lease, so its
// own lease here always means it claimed an absent, released or expired lease.

const { verifyAppCheckToken } = require("./auth");

const AUTOMATION_ACCOUNTS_COLLECTION = "cmsAutomationAccounts";
const EDITOR_LOCKS_COLLECTION = "cmsEditorLocks";
// The lease window that the editor and firestore.rules use (admin/src/lib/editor-locks.ts).
const EDITOR_LOCK_LEASE_MS = 120_000;

const AUTOMATION_VERSION_MESSAGE = "Automation saves require the exact saved baseVersion.";
const AUTOMATION_CREATE_MESSAGE = "Automation accounts change saved content only. Create new content in Boardwalk.";
const AUTOMATION_LOCK_MESSAGE =
  "Hold the editing lock for this record before an automated change. Someone else may have it open.";

// Read outside the write transaction: the marker changes only by operator action, and the
// lease read below is the part that must be transactional.
async function readAutomationAccount(firestore, uid) {
  if (typeof uid !== "string" || uid === "") return false;
  const snapshot = await firestore.collection(AUTOMATION_ACCOUNTS_COLLECTION).doc(uid).get();
  return snapshot.exists;
}

// A headless agent browser cannot pass the reCAPTCHA Enterprise check behind App Check (#4950).
// The transcript and video search reads call this after requirePrincipal: a marked automation
// account that sends no App Check token reads with its verified session and the usual source
// authorization. A token that is sent is still verified, and every other caller still needs one.
async function verifyAppCheckUnlessAutomation(req, actor, { firestore, verifyAppCheckFn = verifyAppCheckToken }) {
  const token = req.headers?.["x-firebase-appcheck"];
  try {
    return await verifyAppCheckFn(token);
  } catch (error) {
    const missing = error?.code === "app_check_failed" && (typeof token !== "string" || !token.trim());
    if (missing && await readAutomationAccount(firestore, actor?.uid)) return null;
    throw error;
  }
}

function heartbeatMillis(value) {
  return typeof value?.toMillis === "function" ? value.toMillis() : NaN;
}

function holdsLiveLease(lock, { uid, collection, documentId, nowMs }) {
  if (!lock || lock.releasedAt !== undefined) return false;
  if (lock.ownerId !== uid) return false;
  if (lock.contentCollection !== collection || lock.contentId !== documentId) return false;
  const age = nowMs - heartbeatMillis(lock.heartbeatAt);
  return Number.isFinite(age) && age < EDITOR_LOCK_LEASE_MS;
}

/**
 * Returns null when the caller may continue, or { status, message, details } when an
 * automation account has not met its write rules. Call it inside the write transaction after
 * the record authorization, so it reveals nothing to a caller who could not write anyway and so
 * a lease change during the transaction makes Firestore run the callback again.
 */
async function automationWriteRefusal(transaction, firestore, {
  automationAccount,
  uid,
  collection,
  documentId,
  echoesVersion,
  creating = false,
  nowMs = Date.now(),
}) {
  if (!automationAccount) return null;
  // A lease addresses saved content, and firestore.rules refuse leases on absent Posts.
  if (creating) return { status: 400, message: AUTOMATION_CREATE_MESSAGE, details: {} };
  if (!echoesVersion) return { status: 400, message: AUTOMATION_VERSION_MESSAGE, details: {} };
  const lockId = `${collection}:${documentId}`;
  const snapshot = await transaction.get(firestore.collection(EDITOR_LOCKS_COLLECTION).doc(lockId));
  const lock = snapshot.exists ? snapshot.data() : null;
  if (holdsLiveLease(lock, { uid, collection, documentId, nowMs })) return null;
  return { status: 409, message: AUTOMATION_LOCK_MESSAGE, details: { lockRequired: true } };
}

module.exports = {
  AUTOMATION_ACCOUNTS_COLLECTION,
  AUTOMATION_CREATE_MESSAGE,
  AUTOMATION_LOCK_MESSAGE,
  AUTOMATION_VERSION_MESSAGE,
  EDITOR_LOCK_LEASE_MS,
  automationWriteRefusal,
  readAutomationAccount,
  verifyAppCheckUnlessAutomation,
};

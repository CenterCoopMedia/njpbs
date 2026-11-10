"use strict";

// Staff sign-in evidence for the append-only audit log (#205).
//
// Every other audit row rides along with the write it describes, inside the same
// transaction, because the write itself is the thing being recorded. A sign-in
// has no such write: it is an access event, not a content change, so it needs its
// own writer at the boundary where the server first decides whether a verified
// Firebase identity is admitted staff.
//
// Two properties matter more than the row's shape.
//
// One row per sign-in, not per page load. The admin app re-validates its session
// through the server boundary on every auth-state change -- a reload, a second
// tab, a token refresh -- and an audit stream that recorded each of those would
// bury the events an administrator is actually looking for. The row is therefore
// keyed by the sign-in itself: the uid plus the `auth_time` claim, which changes
// only when the person actually authenticates again. The second and later calls
// for one session lose the create and are reported as duplicates rather than
// written. A provider that surfaces no sign-in time falls back to an unkeyed row,
// because losing the event is worse than repeating it.
//
// A failed audit write is never a lockout. Elsewhere a missing audit row is a
// compliance defect that surfaces to the caller (see `lib/audit.js`), and that is
// right for a privileged action the operator can retry. Here the caller is a
// person signing in, and a Firestore hiccup that locked the whole newsroom out of
// the CMS would be a far larger failure than a gap in the sign-in stream. This
// writer fails open and logs, and the docs record that weaker guarantee.
//
// Privacy: the row names the account uid and the address the audit stream already
// records for every actor, and nothing else. No display name, no user agent. The
// source is the request address, the same field every other writer records.

const { createHash } = require("node:crypto");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");

const SIGN_IN_ACTIONS = Object.freeze({
  accepted: "auth.login",
  refused: "auth.login.refused",
});
const REFUSED_COOLDOWNS_COLLECTION = "staffSignInRefusedCooldowns";
const REFUSED_COOLDOWN_HOURS = 24;
const REFUSED_COOLDOWN_RETENTION_DAYS = 2;

// Firestore rejects an id containing "/", and the uid and auth_time are both
// already constrained by Firebase Auth, so the pair needs no escaping.
function signInAuditDocumentId({ uid, authTime } = {}) {
  if (typeof uid !== "string" || !uid || !Number.isFinite(authTime)) return null;
  return `signin_${uid}_${Math.floor(authTime)}`;
}

// Firestore's ALREADY_EXISTS is code 6 over gRPC and a string code through the
// admin SDK's error wrapper, depending on which layer surfaces it.
function isAlreadyExists(error) {
  return (
    error?.code === 6 ||
    error?.code === "already-exists" ||
    /already exists/i.test(error?.message ?? "")
  );
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateFrom(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value.toDate === "function") {
    const converted = value.toDate();
    return converted instanceof Date && Number.isFinite(converted.getTime())
      ? converted
      : null;
  }
  return null;
}

function plusDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function cooldownDocId(kind, value) {
  return `${kind}_${createHash("sha256").update(`${kind}\0${value}`).digest("hex")}`;
}

function refusedCooldownIds({ email, source, uid }) {
  const ids = [];
  if (email) ids.push(cooldownDocId("email", email.toLowerCase()));
  if (source) ids.push(cooldownDocId("ip", source));
  if (ids.length === 0 && uid) ids.push(cooldownDocId("uid", uid));
  return ids;
}

/**
 * Append one sign-in row to `admin_logs`. Returns what happened rather than
 * throwing, so a caller on the sign-in path can carry on either way.
 */
async function recordStaffSignIn({
  firestore,
  actor = {},
  admitted,
  reason = null,
  source = null,
  adminLogEntryFn = adminLogEntry,
  log = console,
  now = new Date(),
}) {
  const uid = trimmedString(actor.uid);
  if (!uid) return { recorded: false, reason: "no_actor" };
  if (admitted !== true && actor.emailVerified === false) {
    return { recorded: false, reason: "unverified" };
  }

  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const email = trimmedString(actor.email);
  const ip = trimmedString(source);
  const entry = adminLogEntryFn({
    actorUid: uid,
    actorEmail: email,
    // Written as literals rather than through SIGN_IN_ACTIONS: the label
    // coverage test reads the codes back out of the writers, and a code hidden
    // behind a constant here would reach an administrator unlabeled.
    action: admitted === true ? "auth.login" : "auth.login.refused",
    target: `users/${uid}`,
    before: null,
    after: {
      admitted: admitted === true,
      provider: trimmedString(actor.provider),
      reason: trimmedString(reason),
    },
    source: ip,
  });

  const documentId = signInAuditDocumentId({ uid, authTime: actor.authTime });
  const logs = firestore.collection(AUDIT_COLLECTIONS.adminLogs);
  const logRef = documentId ? logs.doc(documentId) : logs.doc();

  if (admitted === true) {
    try {
      await logRef.create(entry);
      return { recorded: true, reason: null };
    } catch (error) {
      if (isAlreadyExists(error)) return { recorded: false, reason: "duplicate" };
      log.error?.("staff sign-in audit write failed", error);
      return { recorded: false, reason: "write_failed" };
    }
  }

  const cooldownIds = refusedCooldownIds({ email, source: ip, uid });
  const cooldownCol = firestore.collection(REFUSED_COOLDOWNS_COLLECTION);
  const cooldownMs = REFUSED_COOLDOWN_HOURS * 60 * 60 * 1000;
  try {
    return await firestore.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(
        cooldownIds.map((id) => transaction.get(cooldownCol.doc(id))),
      );
      for (const snapshot of snapshots) {
        const lastRefusedAt = dateFrom(
          snapshot.exists ? snapshot.data()?.lastRefusedAt : null,
        );
        if (lastRefusedAt && lastRefusedAt.getTime() + cooldownMs > at.getTime()) {
          return { recorded: false, reason: "cooldown" };
        }
      }
      transaction.create(logRef, entry);
      const cooldown = {
        lastRefusedAt: at,
        updatedAt: at,
        expireAt: plusDays(at, REFUSED_COOLDOWN_RETENTION_DAYS),
      };
      for (const id of cooldownIds) {
        transaction.set(cooldownCol.doc(id), cooldown);
      }
      return { recorded: true, reason: null };
    });
  } catch (error) {
    if (isAlreadyExists(error)) return { recorded: false, reason: "duplicate" };
    log.error?.("staff sign-in audit write failed", error);
    return { recorded: false, reason: "write_failed" };
  }
}

module.exports = {
  REFUSED_COOLDOWNS_COLLECTION,
  REFUSED_COOLDOWN_HOURS,
  SIGN_IN_ACTIONS,
  isAlreadyExists,
  recordStaffSignIn,
  signInAuditDocumentId,
};

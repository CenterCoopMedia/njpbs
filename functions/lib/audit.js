"use strict";

const { admin, db } = require("./firebase");
const { FieldValue } = require("firebase-admin/firestore");

const AUDIT_COLLECTIONS = Object.freeze({
  adminLogs: "admin_logs",
  versionHistory: "cmsVersionHistory",
});

// Builds one admin_logs entry: actor (uid + email), action, target, structured
// before/after snapshots, source (request IP / invocation context, nullable), and
// both a server timestamp and an ISO string. Append-only: callers only ever create
// a new document with this shape.
function adminLogEntry({
  actorUid,
  actorEmail = null,
  action,
  target = null,
  before = null,
  after = null,
  source = null,
}) {
  if (!actorUid) throw new Error("adminLogEntry requires actorUid");
  if (!action) throw new Error("adminLogEntry requires action");
  return {
    actorUid,
    actorEmail,
    action,
    target,
    before: before ?? null,
    after: after ?? null,
    source,
    timestamp: (admin.firestore.FieldValue || FieldValue).serverTimestamp(),
    at: new Date().toISOString(),
  };
}

// Standalone append to admin_logs. Does not swallow errors: a missing audit row is a
// compliance defect (#196), so a failed write surfaces to the caller.
async function logAdminAction(fields) {
  return db.collection(AUDIT_COLLECTIONS.adminLogs).add(adminLogEntry(fields));
}

// Builds one cmsVersionHistory entry. Extends the CJS2026 field shape (collection,
// documentId, action, userId, userEmail, timestamp) with structured before/after
// snapshots and a source field, per #196.
function versionHistoryEntry({
  collection,
  documentId = null,
  action,
  before = null,
  after = null,
  actorUid,
  actorEmail = null,
  source = null,
}) {
  if (!collection) throw new Error("versionHistoryEntry requires collection");
  if (!action) throw new Error("versionHistoryEntry requires action");
  if (!actorUid) throw new Error("versionHistoryEntry requires actorUid");
  return {
    collection,
    documentId,
    action,
    before: before ?? null,
    after: after ?? null,
    userId: actorUid,
    userEmail: actorEmail,
    source,
    timestamp: (admin.firestore.FieldValue || FieldValue).serverTimestamp(),
    at: new Date().toISOString(),
  };
}

module.exports = {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  logAdminAction,
  versionHistoryEntry,
};

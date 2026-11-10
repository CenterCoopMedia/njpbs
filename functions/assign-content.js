"use strict";

const { userDocUsesAccessTier } = require("./lib/access-tier-activation");
const { principalFromUserDoc } = require("./lib/principal");
const { hasCapability } = require("./lib/rbac");

const { contentVersion } = require("./lib/content-version");

// Assignment is editorial workflow state, not authorship metadata. This endpoint is the only
// browser-facing way to change cmsPosts.assignee: ordinary saves preserve the server-owned field,
// while this dedicated mutation verifies the selected staff account, checks the exact record
// version the editor saw, and commits the record, history snapshot, and audit row together.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requireAdmin } = require("./lib/auth");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const {
  RECORD_KINDS,
  isAssignableContentStatus,
  retiredRecordKindError,
} = require("./lib/content-library");
const { advanceReviewRequest } = require("./lib/review-queue");

const MAX_DOCUMENT_ID_BYTES = 1_500;

class AssignmentRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AssignmentRejection";
    this.status = status;
  }
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function isBoundedDocumentId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_DOCUMENT_ID_BYTES &&
    value === value.trim() &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function validateAssignmentRequest(body) {
  if (!isBoundedDocumentId(body?.id)) {
    return "id must be a bounded Firestore document id";
  }
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) {
    return "baseVersion must be a positive safe integer";
  }
  if (body.assignee !== null && !isBoundedDocumentId(body.assignee)) {
    return "assignee must be a bounded Firestore document id or null";
  }
  return null;
}

// Top-level roles are persisted in `role`; editor and contributor are persisted as grants.
// Malformed/unknown role strings deny by default. A scoped grant still makes someone a valid
// workflow participant even though separate capability checks decide which content they may edit.
function isAssignableUser(user, tiersActive = false) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return false;
  if (user.active === false) return false;
  if (tiersActive && Object.hasOwn(user, "accessTier")) {
    return hasCapability(principalFromUserDoc("assignment", user, tiersActive), "content.create");
  }
  if (user.role === "admin" || user.role === "super_admin") return true;
  return (
    Array.isArray(user.grants) &&
    user.grants.some(
      (grant) =>
        grant &&
        typeof grant === "object" &&
        !Array.isArray(grant) &&
        (grant.role === "editor" || grant.role === "contributor"),
    )
  );
}

function createCmsAssignContentHandler(deps = {}) {
  const {
    firestore = db,
    requireAdminFn = requireAdmin,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requireAdminFn(req);
      const validationError = validateAssignmentRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { id, baseVersion, assignee } = req.body;
      const source = getClientIp(req);
      const outcome = await firestore.runTransaction(async (tx) => {
        const recordRef = firestore.collection("cmsPosts").doc(id);
        const recordSnapshot = await tx.get(recordRef);
        if (!recordSnapshot.exists) {
          throw new AssignmentRejection(404, "This content record is no longer available.");
        }
        const stored = recordSnapshot.data();
        if (stored?.deleted === true || !RECORD_KINDS.includes(stored?.type)) {
          throw new AssignmentRejection(404, "This content record is no longer available.");
        }
        // Assignment is work routing, and a retired kind (#1039) has no work left to
        // route: no editor route opens one, so an assignee could never act on it. The
        // record keeps the assignee it already had; only archiving remains.
        const retiredKindError = retiredRecordKindError(stored.type, "archived");
        if (retiredKindError) {
          throw new AssignmentRejection(400, retiredKindError);
        }
        if (!isAssignableContentStatus(stored.status)) {
          throw new AssignmentRejection(
            409,
            "This record's workflow status does not allow assignment.",
          );
        }
        if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
          throw new AssignmentRejection(
            409,
            "This record has no current version. Save it in the editor before assigning it.",
          );
        }
        if (stored.version !== baseVersion) {
          throw new AssignmentRejection(
            409,
            "This record changed since you opened it. Reload before changing its assignment.",
          );
        }

        if (assignee !== null) {
          const assigneeSnapshot = await tx.get(
            firestore.collection("users").doc(assignee),
          );
          if (!assigneeSnapshot.exists || !isAssignableUser(assigneeSnapshot.data(),
              await userDocUsesAccessTier(firestore, assigneeSnapshot.data(), tx))) {
            throw new AssignmentRejection(
              400,
              "The selected assignee is not an active CMS staff member.",
            );
          }
        }

        const priorAssignee =
          typeof stored.assignee === "string" && stored.assignee.length > 0
            ? stored.assignee
            : null;
        if (priorAssignee === assignee) {
          return { document: { ...stored, id }, changed: false };
        }

        const timestamp = now();
        const assigned = {
          ...stored,
          id,
          assignee,
          updatedAt: timestamp,
          updatedBy: user.uid,
          version: stored.version + 1,
          contentVersion: contentVersion(stored),
        };
        if (stored.status === "in_review") {
          const advancedRequest = advanceReviewRequest(stored.reviewRequest, {
            collection: "cmsPosts",
            id,
            sourceVersion: assigned.version,
          });
          if (advancedRequest) assigned.reviewRequest = advancedRequest;
        }
        tx.set(recordRef, assigned);
        tx.set(
          firestore.collection(AUDIT_COLLECTIONS.versionHistory).doc(),
          versionHistoryEntryFn({
            collection: "cmsPosts",
            documentId: id,
            action: "assign",
            before: stored,
            after: assigned,
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            source,
          }),
        );
        tx.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: "cms.assign",
            target: `cmsPosts/${id}`,
            before: { assignee: priorAssignee, version: stored.version },
            after: { assignee, version: assigned.version },
            source,
          }),
        );
        return { document: assigned, changed: true };
      });

      res.status(200).json({
        success: true,
        id,
        changed: outcome.changed,
        document: outcome.document,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      if (!(error instanceof AssignmentRejection) && status >= 500) {
        log.error("cmsAssignContent failed", error);
      }
      res.status(status).json({
        error: error?.message || "Failed to update content assignment",
      });
    }
  };
}

const cmsAssignContent = cmsOnRequest(
  { cors: true },
  createCmsAssignContentHandler(),
);

module.exports = {
  AssignmentRejection,
  MAX_DOCUMENT_ID_BYTES,
  cmsAssignContent,
  createCmsAssignContentHandler,
  isAssignableUser,
  validateAssignmentRequest,
};

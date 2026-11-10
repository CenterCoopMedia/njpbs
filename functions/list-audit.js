"use strict";

// cmsListAudit: the admin-only read boundary for the append-only compliance stream (#205).
// The function returns a bounded newest-first page and an opaque cursor. It does not add an audit
// row for its own read because the stream records state changes, not routine inspection.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { FieldPath } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { hasCapability } = require("./lib/rbac");
const {
  activityVisibility,
  resolveActivityEntries,
} = require("./lib/activity-directory");

const AUDIT_PAGE_SIZE = 50;
const MAX_CURSOR_BYTES = 4_096;
const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_EVIDENCE_BYTES = 16_384;
const MAX_SMALL_VALUE_BYTES = 4_096;
const MAX_ACTOR_UID_BYTES = 1_500;
const MAX_EMAIL_BYTES = 1_024;
const MAX_ACTION_BYTES = 256;
const FORBIDDEN_MESSAGE = "You do not have permission to view administrative activity.";
const INCOMPLETE_MESSAGE =
  "Administrative activity is missing one or more timestamps.";

class AuditReadRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuditReadRejection";
    this.status = status;
  }
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

function isCanonicalInstant(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateCursorValue(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isCanonicalInstant(value.at) ||
    !isBoundedDocumentId(value.id)
  ) {
    throw new AuditReadRejection(400, "cursor is invalid");
  }
  return { at: value.at, id: value.id };
}

function encodeAuditCursor(value) {
  return Buffer.from(JSON.stringify(validateCursorValue(value)), "utf8").toString(
    "base64url",
  );
}

function decodeAuditCursor(cursor) {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new AuditReadRejection(400, "cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return validateCursorValue(decoded);
  } catch (error) {
    if (error instanceof AuditReadRejection) throw error;
    throw new AuditReadRejection(400, "cursor is invalid");
  }
}

function jsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (value === undefined) return null;
  if (depth >= 8) return "[Maximum depth]";
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString()
      : "[Invalid timestamp]";
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular value]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, 200).map((item) => jsonSafe(item, depth + 1, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    output[key] = jsonSafe(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function boundedValue(value, maximumBytes) {
  if (value === null || value === undefined) return null;
  const normalized = jsonSafe(value);
  const byteLength = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  return byteLength <= maximumBytes
    ? normalized
    : { truncated: true, byteLength };
}

function boundedString(value, maximumBytes, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maximumBytes
    ? normalized
    : fallback;
}

// The content API attribution (#4716): the staff request and the reviewed plan digest. Only
// the exact stored shape is returned; anything else is left out.
function automationDetails(value) {
  const reference = value?.requestReference;
  const digest = value?.planDigest;
  if (typeof reference !== "string" || !/^[\x20-\x7e]{1,200}$/.test(reference)) return null;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return null;
  return { requestReference: reference, planDigest: digest };
}

function auditEntryFromDoc(doc) {
  const data = doc.data();
  const automation = automationDetails(data?.automation);
  return {
    id: doc.id,
    actorUid: boundedString(data?.actorUid, MAX_ACTOR_UID_BYTES, null),
    actorEmail: boundedString(data?.actorEmail, MAX_EMAIL_BYTES, null),
    action: boundedString(data?.action, MAX_ACTION_BYTES, "unknown"),
    target: boundedValue(data?.target, MAX_SMALL_VALUE_BYTES),
    before: boundedValue(data?.before, MAX_EVIDENCE_BYTES),
    after: boundedValue(data?.after, MAX_EVIDENCE_BYTES),
    source: boundedValue(data?.source, MAX_SMALL_VALUE_BYTES),
    at: isCanonicalInstant(data?.at) ? data.at : null,
    ...(automation ? { automation } : {}),
  };
}

function validateRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AuditReadRejection(400, "Request body must be an object");
  }
  if (body.cursor === undefined) return null;
  return decodeAuditCursor(body.cursor);
}

async function auditTimestampCoverage(firestore) {
  const audit = firestore.collection("admin_logs");
  const [totalSnapshot, timestampedSnapshot] = await Promise.all([
    audit.count().get(),
    audit.orderBy("at").count().get(),
  ]);
  return {
    total: totalSnapshot.data().count,
    timestamped: timestampedSnapshot.data().count,
  };
}

function createCmsListAuditHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    documentIdField = FieldPath.documentId(),
    verifyAuditTimestampCoverageFn = auditTimestampCoverage,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "audit.view")) {
        log.warn("cmsListAudit refused a caller without audit access", {
          uid: user.uid,
        });
        throw new AuditReadRejection(403, FORBIDDEN_MESSAGE);
      }

      const cursor = validateRequestBody(req.body === undefined ? {} : req.body);
      const coverage = await verifyAuditTimestampCoverageFn(firestore);
      const coverageIsValid =
        Number.isSafeInteger(coverage?.total) &&
        coverage.total >= 0 &&
        Number.isSafeInteger(coverage?.timestamped) &&
        coverage.timestamped >= 0 &&
        coverage.total === coverage.timestamped;
      if (!coverageIsValid) {
        const counts = {
          total: coverage?.total ?? null,
          timestamped: coverage?.timestamped ?? null,
        };
        log.error(
          "cmsListAudit found rows missing from the timestamp index",
          counts,
        );
        throw new AuditReadRejection(503, INCOMPLETE_MESSAGE);
      }
      let query = firestore
        .collection("admin_logs")
        .orderBy("at", "desc")
        .orderBy(documentIdField, "desc");
      if (cursor) query = query.startAfter(cursor.at, cursor.id);
      const snapshot = await query.limit(AUDIT_PAGE_SIZE + 1).get();
      const pageDocs = snapshot.docs.slice(0, AUDIT_PAGE_SIZE);
      const hasMore = snapshot.docs.length > AUDIT_PAGE_SIZE;
      const invalidTimestampDoc = pageDocs.find(
        (doc) => !isCanonicalInstant(doc.data()?.at),
      );
      if (invalidTimestampDoc) {
        log.error("cmsListAudit found a row with an invalid timestamp", {
          id: invalidTimestampDoc.id,
        });
        throw new AuditReadRejection(
          503,
          "Administrative activity contains an invalid timestamp",
        );
      }
      const lastDoc = pageDocs.at(-1);
      const lastAt = lastDoc?.data()?.at;

      // The readable half of the response (#1038). Names are joined here, at read
      // time, from the directory as it stands now: the stored rows keep their
      // recorded identifiers untouched, and the join adds no writable field.
      // Account-bearing fields are returned only for a caller who also holds
      // users.view, so audit.view alone does not become a staff directory.
      const entries = await resolveActivityEntries({
        firestore,
        entries: pageDocs.map(auditEntryFromDoc),
        visibility: activityVisibility(user.principal),
        log,
      });

      res.status(200).json({
        success: true,
        entries,
        nextCursor:
          hasMore && lastDoc
            ? encodeAuditCursor({ at: lastAt, id: lastDoc.id })
            : null,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status =
        error?.status || (error?.code === "failed-precondition" ? 503 : 500);
      if (!(error instanceof AuditReadRejection) && status >= 500) {
        log.error("cmsListAudit failed", error);
      }
      res.status(status).json({
        error: error?.message || "Administrative activity could not be loaded",
      });
    }
  };
}

const cmsListAudit = cmsOnRequest({ cors: true }, createCmsListAuditHandler());

module.exports = {
  AUDIT_PAGE_SIZE,
  AuditReadRejection,
  FORBIDDEN_MESSAGE,
  INCOMPLETE_MESSAGE,
  auditEntryFromDoc,
  auditTimestampCoverage,
  cmsListAudit,
  createCmsListAuditHandler,
  decodeAuditCursor,
  encodeAuditCursor,
};

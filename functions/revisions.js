"use strict";

// Authenticated, record-aware reads for immutable CMS revision history (#913).
// Browser reads of cmsVersionHistory are denied in Firestore rules. These two
// endpoints first authorize the caller against the current content record, then
// return either a bounded summary page or one complete immutable history row.

const { isDeepStrictEqual } = require("node:util");
const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { FieldPath } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const {
  authorizeContentRead,
  contentResource,
  mayAnswerAbsentRecordRead,
  mayReachContentRead,
} = require("./lib/content-authorization");
const { PAGE_EDITOR_TEMPLATES } = require("./lib/public-page-contract");

const REVISION_PAGE_SIZE = 30;
const MAX_CURSOR_BYTES = 4_096;
const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_IDENTITY_BYTES = 1_024;
const MAX_ACTION_BYTES = 256;
const MAX_CHANGED_FIELDS = 50;
const MAX_MEDIA_REFERENCES = 500;
const REVISION_COLLECTION = "cmsVersionHistory";
const CONTENT_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);
const ANSWERABLE_ABSENT_PAGE_IDS = new Set([
  ...Object.keys(PAGE_EDITOR_TEMPLATES),
  ...Object.values(PAGE_EDITOR_TEMPLATES),
]);
const FORBIDDEN_MESSAGE = "You do not have permission to view this record's revisions.";
const RECORD_NOT_FOUND_MESSAGE = "This record is no longer available.";
const REVISION_NOT_FOUND_MESSAGE = "That revision could not be found.";
const INCOMPLETE_MESSAGE = "Revision history is missing one or more timestamps.";

class RevisionReadRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RevisionReadRejection";
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
    throw new RevisionReadRejection(400, "cursor is invalid");
  }
  return { at: value.at, id: value.id };
}

function encodeRevisionCursor(value) {
  return Buffer.from(
    JSON.stringify(validateCursorValue(value)),
    "utf8",
  ).toString("base64url");
}

function decodeRevisionCursor(cursor) {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new RevisionReadRejection(400, "cursor is invalid");
  }
  try {
    return validateCursorValue(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch (error) {
    if (error instanceof RevisionReadRejection) throw error;
    throw new RevisionReadRejection(400, "cursor is invalid");
  }
}

function validateTarget(body, { requireRevisionId = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RevisionReadRejection(400, "Request body must be an object");
  }
  if (!CONTENT_COLLECTIONS.has(body.collection)) {
    throw new RevisionReadRejection(
      400,
      `collection must be one of ${[...CONTENT_COLLECTIONS].join(", ")}`,
    );
  }
  if (!isBoundedDocumentId(body.id)) {
    throw new RevisionReadRejection(400, "id must be a bounded Firestore document id");
  }
  if (requireRevisionId && !isBoundedDocumentId(body.revisionId)) {
    throw new RevisionReadRejection(
      400,
      "revisionId must be a bounded Firestore document id",
    );
  }
}

function validateListRequest(body) {
  validateTarget(body);
  return body.cursor === undefined ? null : decodeRevisionCursor(body.cursor);
}

function boundedString(value, maximumBytes, fallback = null) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maximumBytes
    ? normalized
    : fallback;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function statusValue(value) {
  return boundedString(value, 128, null);
}

function blockCount(snapshot) {
  return Array.isArray(snapshot?.blocks) ? snapshot.blocks.length : null;
}

function referencedMediaIds(value) {
  const ids = new Set();
  const seen = new Set();

  function visit(candidate, key, depth) {
    if (ids.size >= MAX_MEDIA_REFERENCES || depth > 12) return;
    if (
      typeof candidate === "string" &&
      (key === "assetId" || key?.endsWith("AssetId")) &&
      candidate.length > 0
    ) {
      ids.add(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, null, depth + 1);
    } else {
      for (const [childKey, item] of Object.entries(candidate)) {
        visit(item, childKey, depth + 1);
      }
    }
    seen.delete(candidate);
  }

  visit(value, null, 0);
  return ids;
}

function changedFieldSummary(before, after) {
  const beforeRecord =
    before && typeof before === "object" && !Array.isArray(before) ? before : {};
  const afterRecord =
    after && typeof after === "object" && !Array.isArray(after) ? after : {};
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
    .filter((key) => !isDeepStrictEqual(beforeRecord[key], afterRecord[key]))
    .sort();
  return {
    changedFields: keys.slice(0, MAX_CHANGED_FIELDS),
    changedFieldCount: keys.length,
    changedFieldsTruncated: keys.length > MAX_CHANGED_FIELDS,
  };
}

function jsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (value === undefined) return null;
  if (depth >= 24) return "[Maximum depth]";
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
  const output = Array.isArray(value)
    ? value.map((item) => jsonSafe(item, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          jsonSafe(item, depth + 1, seen),
        ]),
      );
  seen.delete(value);
  return output;
}

function revisionSummaryFromDoc(doc) {
  const data = doc.data() ?? {};
  const before = data.before;
  const after = data.after;
  const afterMedia = referencedMediaIds(after);
  const beforeTruncated = data.beforeTruncated === true || before?.beforeTruncated === true;
  const comparison = beforeTruncated
    ? {
        diffAvailable: false,
        mediaReferencesAdded: null,
        mediaReferencesRemoved: null,
        changedFields: [],
        changedFieldCount: null,
        changedFieldsTruncated: false,
      }
    : (() => {
        const beforeMedia = referencedMediaIds(before);
        return {
          diffAvailable: true,
          mediaReferencesAdded: [...afterMedia].filter((id) => !beforeMedia.has(id)).length,
          mediaReferencesRemoved: [...beforeMedia].filter((id) => !afterMedia.has(id)).length,
          ...changedFieldSummary(before, after),
        };
      })();
  return {
    id: doc.id,
    action: boundedString(data.action, MAX_ACTION_BYTES, "unknown"),
    actorUid: boundedString(data.userId, MAX_IDENTITY_BYTES),
    actorEmail: boundedString(data.userEmail, MAX_IDENTITY_BYTES),
    at: isCanonicalInstant(data.at) ? data.at : null,
    beforeVersion: positiveVersion(before?.version),
    version: positiveVersion(after?.version),
    contentVersion: positiveVersion(after?.contentVersion ?? after?.version),
    beforeStatus: statusValue(before?.status),
    status: statusValue(after?.status),
    beforeBlockCount: blockCount(before),
    blockCount: blockCount(after),
    mediaReferenceCount: afterMedia.size,
    beforeTruncated,
    ...comparison,
  };
}

function revisionDetailFromDoc(doc) {
  const data = doc.data() ?? {};
  return {
    id: doc.id,
    collection: data.collection,
    documentId: data.documentId,
    action: boundedString(data.action, MAX_ACTION_BYTES, "unknown"),
    actorUid: boundedString(data.userId, MAX_IDENTITY_BYTES),
    actorEmail: boundedString(data.userEmail, MAX_IDENTITY_BYTES),
    at: data.at,
    before: jsonSafe(data.before),
    after: jsonSafe(data.after),
    beforeTruncated: data.beforeTruncated === true || data.before?.beforeTruncated === true,
  };
}

async function authorizeRevisionTarget({ firestore, user, collection, id, log }) {
  if (!mayReachContentRead(user.principal)) {
    log.warn("Revision read refused a caller with no content capability", {
      uid: user.uid,
      collection,
      documentId: id,
    });
    throw new RevisionReadRejection(403, FORBIDDEN_MESSAGE);
  }

  const snapshot = await firestore.collection(collection).doc(id).get();
  if (!snapshot.exists) {
    const mayAnswerAbsent =
      (collection === "cmsPages" && ANSWERABLE_ABSENT_PAGE_IDS.has(id)) ||
      (collection === "cmsPosts" && mayAnswerAbsentRecordRead(user.principal));
    if (!mayAnswerAbsent) {
      log.warn("Revision read refused for an absent content record", {
        uid: user.uid,
        collection,
        documentId: id,
      });
      throw new RevisionReadRejection(403, FORBIDDEN_MESSAGE);
    }
    throw new RevisionReadRejection(404, RECORD_NOT_FOUND_MESSAGE);
  }
  const stored = snapshot.data() ?? {};
  // A revision list is a read of the record's history, so it is authorized against
  // the record itself -- its owner and its editorial desk (#845). A scoped grant
  // that could not open the current document must not be able to read what it used
  // to say, and an unsectioned record stays closed to one.
  const decision = authorizeContentRead(user.principal, {
    exists: true,
    resource: contentResource({ collection, documentId: id, stored }),
  });
  if (!decision.allowed) {
    log.warn("Revision read refused for the current content record", {
      uid: user.uid,
      collection,
      documentId: id,
      reason: decision.reason,
    });
    throw new RevisionReadRejection(403, FORBIDDEN_MESSAGE);
  }
  if (stored.deleted === true) {
    throw new RevisionReadRejection(404, RECORD_NOT_FOUND_MESSAGE);
  }
}

function revisionTargetQuery(firestore, collection, id) {
  return firestore
    .collection(REVISION_COLLECTION)
    .where("collection", "==", collection)
    .where("documentId", "==", id);
}

async function revisionTimestampCoverage(firestore, collection, id) {
  const target = revisionTargetQuery(firestore, collection, id);
  const [totalSnapshot, timestampedSnapshot] = await Promise.all([
    target.count().get(),
    target.orderBy("at", "desc").count().get(),
  ]);
  return {
    total: totalSnapshot.data().count,
    timestamped: timestampedSnapshot.data().count,
  };
}

function responseStatus(error) {
  return error?.status || (error?.code === "failed-precondition" ? 503 : 500);
}

function createCmsListRevisionsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    documentIdField = FieldPath.documentId(),
    verifyRevisionTimestampCoverageFn = revisionTimestampCoverage,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      const body = req.body === undefined ? {} : req.body;
      const cursor = validateListRequest(body);
      const { collection, id } = body;
      await authorizeRevisionTarget({ firestore, user, collection, id, log });

      const coverage = await verifyRevisionTimestampCoverageFn(
        firestore,
        collection,
        id,
      );
      if (
        !Number.isSafeInteger(coverage?.total) ||
        coverage.total < 0 ||
        !Number.isSafeInteger(coverage?.timestamped) ||
        coverage.timestamped < 0 ||
        coverage.total !== coverage.timestamped
      ) {
        log.error("cmsListRevisions found target rows missing from the timestamp index", {
          collection,
          documentId: id,
          total: coverage?.total ?? null,
          timestamped: coverage?.timestamped ?? null,
        });
        throw new RevisionReadRejection(503, INCOMPLETE_MESSAGE);
      }

      let query = revisionTargetQuery(firestore, collection, id)
        .orderBy("at", "desc")
        .orderBy(documentIdField, "desc");
      if (cursor) query = query.startAfter(cursor.at, cursor.id);
      const snapshot = await query.limit(REVISION_PAGE_SIZE + 1).get();
      const pageDocs = snapshot.docs.slice(0, REVISION_PAGE_SIZE);
      const invalidTimestampDoc = pageDocs.find(
        (doc) => !isCanonicalInstant(doc.data()?.at),
      );
      if (invalidTimestampDoc) {
        log.error("cmsListRevisions found a row with an invalid timestamp", {
          id: invalidTimestampDoc.id,
          collection,
          documentId: id,
        });
        throw new RevisionReadRejection(
          503,
          "Revision history contains an invalid timestamp.",
        );
      }
      const hasMore = snapshot.docs.length > REVISION_PAGE_SIZE;
      const lastDoc = pageDocs.at(-1);
      res.status(200).json({
        success: true,
        entries: pageDocs.map(revisionSummaryFromDoc),
        nextCursor:
          hasMore && lastDoc
            ? encodeRevisionCursor({ at: lastDoc.data().at, id: lastDoc.id })
            : null,
      });
    } catch (error) {
      if (res.headersSent) return;
      const status = responseStatus(error);
      if (!(error instanceof RevisionReadRejection) && status >= 500) {
        log.error("cmsListRevisions failed", error);
      }
      res.status(status).json({
        error: error?.message || "Revision history could not be loaded",
      });
    }
  };
}

function createCmsGetRevisionHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);
      const body = req.body === undefined ? {} : req.body;
      validateTarget(body, { requireRevisionId: true });
      const { collection, id, revisionId } = body;
      await authorizeRevisionTarget({ firestore, user, collection, id, log });

      const snapshot = await firestore
        .collection(REVISION_COLLECTION)
        .doc(revisionId)
        .get();
      const data = snapshot.exists ? snapshot.data() : null;
      if (
        !snapshot.exists ||
        data?.collection !== collection ||
        data?.documentId !== id
      ) {
        throw new RevisionReadRejection(404, REVISION_NOT_FOUND_MESSAGE);
      }
      if (!isCanonicalInstant(data.at)) {
        throw new RevisionReadRejection(
          503,
          "That revision has an invalid timestamp.",
        );
      }
      res.status(200).json({
        success: true,
        revision: revisionDetailFromDoc(snapshot),
      });
    } catch (error) {
      if (res.headersSent) return;
      const status = responseStatus(error);
      if (!(error instanceof RevisionReadRejection) && status >= 500) {
        log.error("cmsGetRevision failed", error);
      }
      res.status(status).json({
        error: error?.message || "That revision could not be loaded",
      });
    }
  };
}

const cmsListRevisions = cmsOnRequest(
  { cors: true, invoker: "public" },
  createCmsListRevisionsHandler(),
);
const cmsGetRevision = cmsOnRequest(
  { cors: true, invoker: "public" },
  createCmsGetRevisionHandler(),
);

module.exports = {
  FORBIDDEN_MESSAGE,
  INCOMPLETE_MESSAGE,
  REVISION_PAGE_SIZE,
  RevisionReadRejection,
  cmsGetRevision,
  cmsListRevisions,
  createCmsGetRevisionHandler,
  createCmsListRevisionsHandler,
  decodeRevisionCursor,
  encodeRevisionCursor,
  revisionDetailFromDoc,
  revisionSummaryFromDoc,
  revisionTimestampCoverage,
};

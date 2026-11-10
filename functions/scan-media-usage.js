"use strict";

// Authenticated operator repair for bounded working and published media usage.
// It walks only the three canonical owner collections in a fixed id order. Each
// apply owner keeps its usage writes and compact audit receipt in one transaction.

const { isDeepStrictEqual } = require("node:util");
const { createHmac, timingSafeEqual } = require("node:crypto");
const { FieldPath } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest, configuredEdgeSecret } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { CMS_SETTINGS_SCHEMAS } = require("./lib/cms-settings-contract");
const { hasGlobalCapability } = require("./lib/rbac");
const {
  JsonRequestError,
  requestHeader,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const {
  MEDIA_USAGE_COLLECTIONS,
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  mediaUsageDocument,
  prepareMediaUsageWrites,
} = require("./lib/media-usage");

const CONTENT_STATUSES = new Set([
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
]);
const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_MEDIA_USAGE_REPAIR_CURSOR_BYTES = 4_096;
const MAX_MEDIA_USAGE_REPAIR_REQUEST_BYTES = 4_096;
const MAX_MEDIA_USAGE_REPAIR_OWNERS = 10;
const MEDIA_USAGE_REPAIR_CURSOR_VERSION = 1;
const MEDIA_USAGE_REPAIR_COLLECTIONS = Object.freeze([
  "cmsPages",
  "cmsPosts",
  "cmsSettings",
  "cmsPostTemplates",
]);
const MEDIA_USAGE_REPAIR_MODES = new Set(["dry-run", "apply"]);
const MEDIA_USAGE_SCAN_REQUEST_FIELDS = new Set(["mode", "cursor", "limit"]);
const FORBIDDEN_MESSAGE = "You do not have permission to repair media usage.";

class MediaUsageRepairError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "MediaUsageRepairError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLegacyBlockOnlySnapshot(document) {
  return (
    plainObject(document?.published) &&
    document.published.metadata === undefined &&
    document.published.sourceVersion === undefined
  );
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
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

function isBoundedActorUid(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_DOCUMENT_ID_BYTES
  );
}

function validateMediaUsageRepairCursorValue(value) {
  const keys = plainObject(value) ? Object.keys(value).sort() : [];
  if (
    keys.length !== 3 ||
    keys[0] !== "collection" ||
    keys[1] !== "documentId" ||
    keys[2] !== "v" ||
    value.v !== MEDIA_USAGE_REPAIR_CURSOR_VERSION ||
    !MEDIA_USAGE_REPAIR_COLLECTIONS.includes(value.collection) ||
    !isBoundedDocumentId(value.documentId)
  ) {
    throw new MediaUsageRepairError("The media usage repair cursor is invalid", 400);
  }
  return {
    v: MEDIA_USAGE_REPAIR_CURSOR_VERSION,
    collection: value.collection,
    documentId: value.documentId,
  };
}

function cursorSecretBytes(secret) {
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < 16
  ) {
    throw new MediaUsageRepairError(
      "The media usage repair cursor service is unavailable",
      503,
    );
  }
  return Buffer.from(secret, "utf8");
}

function cursorSignature(payload, secret) {
  return createHmac("sha256", cursorSecretBytes(secret))
    .update(payload, "utf8")
    .digest();
}

function encodeMediaUsageRepairCursor(value, secret) {
  const payload = Buffer.from(
    JSON.stringify(validateMediaUsageRepairCursorValue(value)),
    "utf8",
  ).toString("base64url");
  const signature = cursorSignature(payload, secret).toString("base64url");
  return `${payload}.${signature}`;
}

function decodeMediaUsageRepairCursor(cursor, secret) {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_MEDIA_USAGE_REPAIR_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new MediaUsageRepairError("The media usage repair cursor is invalid", 400);
  }
  try {
    const [payload, suppliedSignatureText] = cursor.split(".");
    const bytes = Buffer.from(payload, "base64url");
    const suppliedSignature = Buffer.from(suppliedSignatureText, "base64url");
    const expectedSignature = cursorSignature(payload, secret);
    if (
      bytes.toString("base64url") !== payload ||
      suppliedSignature.toString("base64url") !== suppliedSignatureText ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new MediaUsageRepairError(
        "The media usage repair cursor is invalid",
        400,
      );
    }
    return validateMediaUsageRepairCursorValue(
      JSON.parse(bytes.toString("utf8")),
    );
  } catch (error) {
    if (error instanceof MediaUsageRepairError) throw error;
    throw new MediaUsageRepairError("The media usage repair cursor is invalid", 400);
  }
}

function validateMediaUsageScanRequest(body, { cursorSecret } = {}) {
  if (!plainObject(body)) {
    throw new MediaUsageRepairError(
      "The media usage repair request must be an object",
      400,
    );
  }
  const unknownField = Object.keys(body).find(
    (field) => !MEDIA_USAGE_SCAN_REQUEST_FIELDS.has(field),
  );
  if (unknownField) {
    throw new MediaUsageRepairError(
      `Unknown media usage repair field ${unknownField}`,
      400,
    );
  }
  if (!MEDIA_USAGE_REPAIR_MODES.has(body.mode)) {
    throw new MediaUsageRepairError(
      "mode must be dry-run or apply",
      400,
    );
  }
  const cursor = body.cursor === undefined ? null : body.cursor;
  if (cursor !== null) decodeMediaUsageRepairCursor(cursor, cursorSecret);
  const limit = body.limit === undefined
    ? MAX_MEDIA_USAGE_REPAIR_OWNERS
    : body.limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MEDIA_USAGE_REPAIR_OWNERS
  ) {
    throw new MediaUsageRepairError(
      `limit must be an integer from 1 through ${MAX_MEDIA_USAGE_REPAIR_OWNERS}`,
      400,
    );
  }
  return { mode: body.mode, cursor, limit };
}

function emptyUsage() {
  return { assetIds: [], occurrenceCount: 0 };
}

function stateInput(state, sourceVersion, usage) {
  return { state, sourceVersion, usage };
}

function deriveSettingsStates({
  collection,
  documentId,
  document,
  settingsSchemas,
}) {
  const working = stateInput(
    "working",
    document.version,
    collectWorkingMediaUsage({
      collection,
      documentId,
      document,
      settingsSchemas,
    }),
  );
  if (document.published === undefined) {
    return {
      working,
      published: stateInput("published", document.version, emptyUsage()),
    };
  }
  if (!plainObject(document.published)) {
    throw new MediaUsageRepairError(
      "The CMS settings published snapshot is invalid",
    );
  }
  const published = collectPublishedMediaUsage({
    collection,
    documentId,
    documentVersion: document.version,
    snapshot: document.published,
    settingsSchemas,
  });
  return {
    working,
    published: stateInput(
      "published",
      document.published.sourceVersion,
      published,
    ),
  };
}

function assertContentLifecycle(document) {
  if (!CONTENT_STATUSES.has(document.status)) {
    throw new MediaUsageRepairError("The content lifecycle is invalid");
  }
  if (
    document.deleted !== undefined &&
    typeof document.deleted !== "boolean"
  ) {
    throw new MediaUsageRepairError("The content delete state is invalid");
  }
  if (
    document.publiclyVisible !== undefined &&
    typeof document.publiclyVisible !== "boolean"
  ) {
    throw new MediaUsageRepairError("The content public visibility is invalid");
  }
  if (
    document.deleted !== true &&
    ((document.status === "published" && document.publiclyVisible === false) ||
      (document.status === "archived" && document.publiclyVisible === true))
  ) {
    throw new MediaUsageRepairError("The content lifecycle is inconsistent");
  }
}

function deriveContentStates({ collection, documentId, document }) {
  assertContentLifecycle(document);
  if (document.deleted === true) {
    return {
      working: stateInput("working", document.version, emptyUsage()),
      published: stateInput("published", document.version, emptyUsage()),
    };
  }

  const working = stateInput(
    "working",
    document.version,
    collectWorkingMediaUsage({ collection, documentId, document }),
  );
  const hasActiveSnapshot =
    !isLegacyBlockOnlySnapshot(document) &&
    (document.publiclyVisible === true ||
      (document.publiclyVisible === undefined &&
        document.status === "published"));
  if (!hasActiveSnapshot) {
    return {
      working,
      published: stateInput("published", document.version, emptyUsage()),
    };
  }
  if (!plainObject(document.published)) {
    throw new MediaUsageRepairError("The content published snapshot is invalid");
  }
  if (
    !positiveVersion(document.published.sourceVersion) ||
    document.published.sourceVersion > document.version
  ) {
    throw new MediaUsageRepairError(
      "The content published source version is invalid",
    );
  }
  return {
    working,
    published: stateInput(
      "published",
      document.published.sourceVersion,
      collectPublishedMediaUsage({
        collection,
        documentId,
        documentVersion: document.version,
        snapshot: document.published,
      }),
    ),
  };
}

function deriveMediaUsageStates({
  collection,
  documentId,
  document,
  // Only tests inject fixture schemas. A future production caller must not derive
  // this catalog from request data.
  settingsSchemas = CMS_SETTINGS_SCHEMAS,
}) {
  if (
    !MEDIA_USAGE_COLLECTIONS.has(collection) ||
    !isBoundedDocumentId(documentId) ||
    !plainObject(document)
  ) {
    throw new MediaUsageRepairError("The media usage repair owner is invalid", 400);
  }
  if (!positiveVersion(document.version)) {
    throw new MediaUsageRepairError(
      "The media usage repair source version is invalid",
    );
  }
  try {
    return collection === "cmsSettings"
      ? deriveSettingsStates({
          collection,
          documentId,
          document,
          settingsSchemas,
        })
      : deriveContentStates({ collection, documentId, document });
  } catch (error) {
    if (error instanceof MediaUsageError) {
      throw new MediaUsageRepairError(error.message, error.status);
    }
    throw error;
  }
}

function usageAuditReceipt(snapshot, expectedState) {
  if (!snapshot?.exists) return { exists: false, valid: false };
  const value = snapshot.data();
  const assetIds = Array.isArray(value?.assetIds) ? value.assetIds : null;
  const assetCount = assetIds === null ? null : Math.min(assetIds.length, 101);
  const assetCountOverflow = assetIds !== null && assetIds.length > 100;
  let valid = false;
  if (!assetCountOverflow && plainObject(value)) {
    try {
      valid = isDeepStrictEqual(
        value,
        mediaUsageDocument({
          state: value.state,
          sourceVersion: value.sourceVersion,
          usage: {
            assetIds: value.assetIds,
            occurrenceCount: value.occurrenceCount,
          },
        }),
      ) && value.state === expectedState;
    } catch {
      valid = false;
    }
  }
  return {
    exists: true,
    valid,
    sourceVersion: positiveVersion(value?.sourceVersion)
      ? value.sourceVersion
      : null,
    assetCount,
    assetCountOverflow,
    occurrenceCount: Number.isSafeInteger(value?.occurrenceCount)
      ? value.occurrenceCount
      : null,
  };
}

function documentAuditReceipt(document) {
  return usageAuditReceipt(
    { exists: true, data: () => document },
    document.state,
  );
}

function validateRepairInput({
  firestore,
  collection,
  documentId,
  actorUid,
  adminLogEntryFn,
  apply,
}) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    throw new MediaUsageRepairError("Firestore is required", 500);
  }
  if (
    !MEDIA_USAGE_COLLECTIONS.has(collection) ||
    !isBoundedDocumentId(documentId)
  ) {
    throw new MediaUsageRepairError("The media usage repair owner is invalid", 400);
  }
  if (!isBoundedActorUid(actorUid)) {
    throw new MediaUsageRepairError("The media usage repair actor is invalid", 400);
  }
  if (typeof apply !== "boolean") {
    throw new MediaUsageRepairError("The media usage repair mode is invalid", 500);
  }
  if (apply && typeof adminLogEntryFn !== "function") {
    throw new MediaUsageRepairError("The media usage repair audit is invalid", 500);
  }
}

async function processMediaUsageOwner({
  firestore,
  collection,
  documentId,
  actorUid,
  actorEmail = null,
  source = null,
  settingsSchemas = CMS_SETTINGS_SCHEMAS,
  adminLogEntryFn = adminLogEntry,
  apply,
}) {
  validateRepairInput({
    firestore,
    collection,
    documentId,
    actorUid,
    adminLogEntryFn,
    apply,
  });

  const ownerRef = firestore.collection(collection).doc(documentId);
  const usageCollection = firestore.collection(
    `${collection}/${documentId}/mediaUsage`,
  );
  const usageRefs = {
    working: usageCollection.doc("working"),
    published: usageCollection.doc("published"),
  };

  return firestore.runTransaction(async (transaction) => {
    const [ownerSnapshot, workingSnapshot, publishedSnapshot] = await Promise.all([
      transaction.get(ownerRef),
      transaction.get(usageRefs.working),
      transaction.get(usageRefs.published),
    ]);
    const baseResult = {
      collection,
      documentId,
      changedStates: [],
    };
    if (!ownerSnapshot.exists) return { status: "missing", ...baseResult };

    const states = deriveMediaUsageStates({
      collection,
      documentId,
      document: ownerSnapshot.data(),
      settingsSchemas,
    });
    let prepared;
    try {
      prepared = await prepareMediaUsageWrites({
        firestore,
        transaction,
        collection,
        documentId,
        states: [states.working, states.published],
      });
    } catch (error) {
      if (error instanceof MediaUsageError) {
        throw new MediaUsageRepairError(error.message, error.status);
      }
      throw error;
    }
    const existing = {
      working: workingSnapshot,
      published: publishedSnapshot,
    };
    const changedStates = ["working", "published"].filter(
      (state) =>
        !existing[state].exists ||
        !isDeepStrictEqual(existing[state].data(), prepared[state].document),
    );
    if (changedStates.length === 0) {
      return { status: "unchanged", ...baseResult };
    }
    if (!apply) {
      return {
        status: "would_repair",
        collection,
        documentId,
        changedStates,
      };
    }

    for (const state of changedStates) {
      transaction.set(prepared[state].ref, prepared[state].document);
    }
    transaction.set(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid,
        actorEmail,
        action: "cms.media-usage-repair",
        target: `${collection}/${documentId}`,
        before: {
          working: usageAuditReceipt(workingSnapshot, "working"),
          published: usageAuditReceipt(publishedSnapshot, "published"),
        },
        after: {
          changedStates,
          working: documentAuditReceipt(prepared.working.document),
          published: documentAuditReceipt(prepared.published.document),
        },
        source,
      }),
    );
    return {
      status: "repaired",
      collection,
      documentId,
      changedStates,
    };
  });
}

async function inspectMediaUsageOwner(input) {
  return processMediaUsageOwner({ ...input, apply: false });
}

async function repairMediaUsageOwner(input) {
  return processMediaUsageOwner({ ...input, apply: true });
}

async function readMediaUsageRepairOwners({
  firestore,
  cursor,
  limit,
  documentIdField,
}) {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new MediaUsageRepairError("Firestore is required", 500);
  }
  const owners = [];
  const target = limit + 1;
  const startCollectionIndex = cursor
    ? MEDIA_USAGE_REPAIR_COLLECTIONS.indexOf(cursor.collection)
    : 0;

  for (
    let index = startCollectionIndex;
    index < MEDIA_USAGE_REPAIR_COLLECTIONS.length && owners.length < target;
    index += 1
  ) {
    const collection = MEDIA_USAGE_REPAIR_COLLECTIONS[index];
    let query = firestore
      .collection(collection)
      .select()
      .orderBy(documentIdField, "asc");
    if (cursor && index === startCollectionIndex) {
      query = query.startAfter(cursor.documentId);
    }
    const snapshot = await query.limit(target - owners.length).get();
    for (const document of snapshot.docs) {
      if (!isBoundedDocumentId(document.id)) {
        throw new MediaUsageRepairError(
          "The media usage repair found an invalid owner id",
          409,
        );
      }
      owners.push({ collection, documentId: document.id });
    }
  }
  return owners;
}

function emptyRepairSummary() {
  return {
    scanned: 0,
    wouldRepair: 0,
    repaired: 0,
    unchanged: 0,
    missing: 0,
  };
}

function recordRepairOutcome(summary, status, mode) {
  summary.scanned += 1;
  if (status === "unchanged" || status === "missing") {
    summary[status] += 1;
    return;
  }
  if (status === "would_repair" && mode === "dry-run") {
    summary.wouldRepair += 1;
    return;
  }
  if (status === "repaired" && mode === "apply") {
    summary.repaired += 1;
    return;
  }
  throw new MediaUsageRepairError(
    "The media usage repair returned an invalid outcome",
    500,
  );
}

async function scanMediaUsagePage({
  firestore,
  mode,
  cursor = null,
  limit = MAX_MEDIA_USAGE_REPAIR_OWNERS,
  actorUid,
  actorEmail = null,
  source = null,
  settingsSchemas = CMS_SETTINGS_SCHEMAS,
  documentIdField = FieldPath.documentId(),
  inspectOwnerFn = inspectMediaUsageOwner,
  repairOwnerFn = repairMediaUsageOwner,
  cursorSecret,
}) {
  cursorSecretBytes(cursorSecret);
  const request = validateMediaUsageScanRequest(
    { mode, cursor, limit },
    { cursorSecret },
  );
  if (!isBoundedActorUid(actorUid)) {
    throw new MediaUsageRepairError("The media usage repair actor is invalid", 400);
  }
  if (
    typeof inspectOwnerFn !== "function" ||
    typeof repairOwnerFn !== "function"
  ) {
    throw new MediaUsageRepairError(
      "The media usage repair processor is invalid",
      500,
    );
  }
  const cursorValue = request.cursor === null
    ? null
    : decodeMediaUsageRepairCursor(request.cursor, cursorSecret);
  const owners = await readMediaUsageRepairOwners({
    firestore,
    cursor: cursorValue,
    limit: request.limit,
    documentIdField,
  });
  const pageOwners = owners.slice(0, request.limit);
  const processOwner = request.mode === "apply"
    ? repairOwnerFn
    : inspectOwnerFn;
  const summary = emptyRepairSummary();

  // Each owner is independent and sequential. If one fails, the request stops
  // without advancing its cursor. A retry rechecks any earlier apply owners and
  // treats their exact records as no-ops.
  for (const owner of pageOwners) {
    const outcome = await processOwner({
      firestore,
      ...owner,
      actorUid,
      actorEmail,
      source,
      settingsSchemas,
    });
    recordRepairOutcome(summary, outcome?.status, request.mode);
  }

  const lastOwner = pageOwners.at(-1);
  return {
    mode: request.mode,
    summary,
    nextCursor:
      owners.length > request.limit && lastOwner
        ? encodeMediaUsageRepairCursor({
            v: MEDIA_USAGE_REPAIR_CURSOR_VERSION,
            ...lastOwner,
          }, cursorSecret)
        : null,
  };
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function clientIp(req) {
  return (
    requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
    req.ip ||
    null
  );
}

function createCmsScanMediaUsageHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    scanMediaUsagePageFn = scanMediaUsagePage,
    readCursorSecretFn = configuredEdgeSecret,
    documentIdField = FieldPath.documentId(),
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateBoundedJsonRequest(req, MAX_MEDIA_USAGE_REPAIR_REQUEST_BYTES);
      const user = await requirePrincipalFn(req);
      if (!hasGlobalCapability(user.principal, "media.manage")) {
        log.warn("cmsScanMediaUsage refused a caller without site-wide access", {
          uid: user.uid,
        });
        throw new MediaUsageRepairError(FORBIDDEN_MESSAGE, 403);
      }
      const cursorSecret = readCursorSecretFn();
      cursorSecretBytes(cursorSecret);
      const input = validateMediaUsageScanRequest(
        req.body,
        { cursorSecret },
      );
      const page = await scanMediaUsagePageFn({
        firestore,
        ...input,
        actorUid: user.uid,
        actorEmail: user.email ?? null,
        source: clientIp(req),
        cursorSecret,
        documentIdField,
      });
      res.status(200).json({ success: true, ...page });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof MediaUsageRepairError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status ||
        (error?.code === "failed-precondition" ? 503 : 500);
      if (!expected || status >= 500) {
        log.error("cmsScanMediaUsage failed", error);
      }
      res.status(status).json({
        error: expected
          ? error.message
          : "Media usage repair could not be completed",
      });
    }
  };
}

const cmsScanMediaUsage = cmsOnRequest(
  {
    cors: true,
    concurrency: 1,
    maxInstances: 1,
    timeoutSeconds: 120,
  },
  createCmsScanMediaUsageHandler(),
);

module.exports = {
  CONTENT_STATUSES,
  FORBIDDEN_MESSAGE,
  MAX_DOCUMENT_ID_BYTES,
  MAX_MEDIA_USAGE_REPAIR_CURSOR_BYTES,
  MAX_MEDIA_USAGE_REPAIR_OWNERS,
  MAX_MEDIA_USAGE_REPAIR_REQUEST_BYTES,
  MEDIA_USAGE_REPAIR_COLLECTIONS,
  MEDIA_USAGE_REPAIR_CURSOR_VERSION,
  MediaUsageRepairError,
  cmsScanMediaUsage,
  createCmsScanMediaUsageHandler,
  decodeMediaUsageRepairCursor,
  deriveMediaUsageStates,
  encodeMediaUsageRepairCursor,
  inspectMediaUsageOwner,
  isBoundedDocumentId,
  readMediaUsageRepairOwners,
  repairMediaUsageOwner,
  scanMediaUsagePage,
  usageAuditReceipt,
  validateMediaUsageScanRequest,
};

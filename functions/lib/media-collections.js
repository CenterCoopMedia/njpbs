"use strict";

const { createHash } = require("node:crypto");
const {
  MediaAssetRefValidationError,
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
  parseUniqueMediaAssetRefs,
  storedMediaAssetRef,
} = require("./media-asset-ref");

const COLLECTION_SCHEMA_VERSION = 1;
const COLLECTION_SCOPES = Object.freeze(["private", "all_staff"]);
const COLLECTION_LIFECYCLES = Object.freeze(["active", "archived"]);
const COLLECTION_COLORS = Object.freeze(["slate", "blue", "green", "gold", "red", "purple"]);
const MAX_COLLECTION_PAGE_SIZE = 30;
const MAX_COLLECTION_ITEM_BATCH = 30;
const MAX_COLLECTION_ITEM_SCAN = 100;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{64}$/;

class MediaCollectionValidationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "MediaCollectionValidationError";
    this.status = status;
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownFields(value, allowed, label = "Request") {
  if (!plainObject(value)) {
    throw new MediaCollectionValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new MediaCollectionValidationError(
      `Unknown ${label.toLowerCase()} field ${unknown}`,
    );
  }
}

function requiredChoice(value, choices, label) {
  if (!choices.includes(value)) {
    throw new MediaCollectionValidationError(`${label} is invalid`);
  }
  return value;
}

function requiredDocumentId(value, label = "Collection id") {
  if (typeof value !== "string" || !DOCUMENT_ID_PATTERN.test(value)) {
    throw new MediaCollectionValidationError(`${label} is invalid`);
  }
  return value;
}

function requiredRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new MediaCollectionValidationError(
      "A collection request needs a unique request id",
    );
  }
  return value;
}

function positiveVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MediaCollectionValidationError(`${label} is invalid`);
  }
  return value;
}

function parseName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new MediaCollectionValidationError(
      "Use a collection name of 1 to 120 characters",
    );
  }
  return value.trim();
}

function parseDescription(value) {
  if (typeof value !== "string" || value.length > 500) {
    throw new MediaCollectionValidationError(
      "Use a description of at most 500 characters",
    );
  }
  return value;
}

function parseCollectionRef(value) {
  try {
    return parseMediaAssetRef(value);
  } catch (error) {
    if (error instanceof MediaAssetRefValidationError) {
      throw new MediaCollectionValidationError(error.message, error.status);
    }
    throw error;
  }
}

function parseSortedRefs(values) {
  let refs;
  try {
    refs = parseUniqueMediaAssetRefs(values, MAX_COLLECTION_ITEM_BATCH);
  } catch (error) {
    if (error instanceof MediaAssetRefValidationError) {
      throw new MediaCollectionValidationError(error.message, error.status);
    }
    throw error;
  }
  if (refs.length === 0) {
    throw new MediaCollectionValidationError("Choose at least one collection item");
  }
  return refs.sort((left, right) =>
    canonicalMediaAssetRef(left).localeCompare(canonicalMediaAssetRef(right)));
}

function parseCursor(value, expected) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new MediaCollectionValidationError("Cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !plainObject(decoded) ||
      decoded.v !== 1 ||
      Object.entries(expected).some(([key, expectedValue]) => decoded[key] !== expectedValue) ||
      !Number.isSafeInteger(decoded.seconds) ||
      decoded.seconds < 0 ||
      decoded.seconds > MAX_TIMESTAMP_SECONDS ||
      !Number.isSafeInteger(decoded.nanoseconds) ||
      decoded.nanoseconds < 0 ||
      decoded.nanoseconds > 999_999_999 ||
      typeof decoded.id !== "string" ||
      !DOCUMENT_ID_PATTERN.test(decoded.id)
    ) {
      throw new Error("Invalid cursor fields");
    }
    return {
      seconds: decoded.seconds,
      nanoseconds: decoded.nanoseconds,
      id: decoded.id,
    };
  } catch {
    throw new MediaCollectionValidationError("Cursor is invalid");
  }
}

function timestampParts(document, field) {
  const value = document.data()?.[field];
  if (!Number.isSafeInteger(value?.seconds) || !Number.isSafeInteger(value?.nanoseconds)) {
    throw new Error(`Media collection record ${document.id} has no valid ${field}`);
  }
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}

function encodeCursor(binding, document, field) {
  return Buffer.from(JSON.stringify({
    v: 1,
    ...binding,
    ...timestampParts(document, field),
    id: document.id,
  }), "utf8").toString("base64url");
}

function pageLimit(value) {
  const limit = value === undefined ? MAX_COLLECTION_PAGE_SIZE : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COLLECTION_PAGE_SIZE) {
    throw new MediaCollectionValidationError(
      `Limit must be a whole number from 1 through ${MAX_COLLECTION_PAGE_SIZE}`,
    );
  }
  return limit;
}

function parseListCollectionsRequest(value, uid) {
  rejectUnknownFields(value, new Set(["scope", "lifecycle", "cursor", "limit"]));
  const scope = requiredChoice(value.scope, COLLECTION_SCOPES, "Collection scope");
  const lifecycle = requiredChoice(
    value.lifecycle,
    COLLECTION_LIFECYCLES,
    "Collection lifecycle",
  );
  return {
    scope,
    lifecycle,
    limit: pageLimit(value.limit),
    cursor: value.cursor === undefined
      ? null
      : parseCursor(value.cursor, { uid, scope, lifecycle, kind: "collections" }),
  };
}

function parseListCollectionItemsRequest(value, uid) {
  rejectUnknownFields(value, new Set(["collectionId", "cursor", "limit"]));
  const collectionId = requiredDocumentId(value.collectionId);
  return {
    collectionId,
    limit: pageLimit(value.limit),
    cursor: value.cursor === undefined
      ? null
      : parseCursor(value.cursor, { uid, collectionId, kind: "items" }),
  };
}

function parseMutateCollectionRequest(value) {
  if (!plainObject(value)) {
    throw new MediaCollectionValidationError("Request must be an object");
  }
  const action = requiredChoice(
    value.action,
    ["create", "update", "archive", "restore"],
    "Collection action",
  );
  const allowed = {
    create: new Set(["action", "requestId", "scope", "name", "description", "color"]),
    update: new Set([
      "action", "requestId", "collectionId", "baseVersion",
      "name", "description", "coverRef", "color",
    ]),
    archive: new Set(["action", "requestId", "collectionId", "baseVersion"]),
    restore: new Set(["action", "requestId", "collectionId", "baseVersion"]),
  }[action];
  rejectUnknownFields(value, allowed);
  const requestId = requiredRequestId(value.requestId);
  if (action === "create") {
    return {
      action,
      requestId,
      scope: requiredChoice(value.scope, COLLECTION_SCOPES, "Collection scope"),
      name: parseName(value.name),
      description: value.description === undefined ? "" : parseDescription(value.description),
      ...(value.color === undefined ? {} : { color: parseColor(value.color) }),
    };
  }
  const request = {
    action,
    requestId,
    collectionId: requiredDocumentId(value.collectionId),
    baseVersion: positiveVersion(value.baseVersion, "Base version"),
  };
  if (action !== "update") return request;
  if (value.name === undefined && value.description === undefined && value.coverRef === undefined && value.color === undefined) {
    throw new MediaCollectionValidationError("Choose a collection field to update");
  }
  return {
    ...request,
    ...(value.name === undefined ? {} : { name: parseName(value.name) }),
    ...(value.color === undefined ? {} : { color: parseColor(value.color) }),
    ...(value.description === undefined
      ? {}
      : { description: parseDescription(value.description) }),
    ...(value.coverRef === undefined
      ? {}
      : { coverRef: value.coverRef === null ? null : parseCollectionRef(value.coverRef) }),
  };
}

function parseSetCollectionItemsRequest(value) {
  rejectUnknownFields(
    value,
    new Set([
      "collectionId", "requestId", "baseMembershipVersion", "present", "refs",
    ]),
  );
  if (typeof value.present !== "boolean") {
    throw new MediaCollectionValidationError("Item state must be true or false");
  }
  return {
    collectionId: requiredDocumentId(value.collectionId),
    requestId: requiredRequestId(value.requestId),
    baseMembershipVersion: positiveVersion(
      value.baseMembershipVersion,
      "Base membership version",
    ),
    present: value.present,
    refs: parseSortedRefs(value.refs),
  };
}

function collectionDocumentId(uid, requestId) {
  return createHash("sha256").update(`${uid}\0${requestId}`, "utf8").digest("hex");
}

function collectionRequestDocumentId(uid, requestId) {
  return createHash("sha256").update(`${uid}\0${requestId}`, "utf8").digest("hex");
}

function requestFingerprint(request) {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function storedCollection(value) {
  if (!plainObject(value) || value.schemaVersion !== COLLECTION_SCHEMA_VERSION) return null;
  if (!COLLECTION_SCOPES.includes(value.scope) ||
      !COLLECTION_LIFECYCLES.includes(value.lifecycle) ||
      typeof value.createdBy !== "string" || !value.createdBy ||
      typeof value.name !== "string" || !value.name || value.name.length > 120 ||
      typeof value.description !== "string" || value.description.length > 500 ||
      (value.color !== undefined && !COLLECTION_COLORS.includes(value.color)) ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      !Number.isSafeInteger(value.membershipVersion) || value.membershipVersion < 1 ||
      !Number.isSafeInteger(value.itemCount) || value.itemCount < 0) {
    return null;
  }
  if (value.scope === "private" && value.ownerUid !== value.createdBy) return null;
  if (value.scope === "all_staff" && value.ownerUid !== undefined) return null;
  let coverRef = null;
  if (value.coverRef !== null && value.coverRef !== undefined) {
    try {
      coverRef = parseMediaAssetRef(value.coverRef);
    } catch {
      return null;
    }
  }
  return { ...value, coverRef, color: value.color === undefined ? "slate" : value.color };
}

function parseColor(value) {
  if (value === undefined) return "slate";
  if (!COLLECTION_COLORS.includes(value)) {
    throw new MediaCollectionValidationError("Collection color is not available");
  }
  return value;
}

function storedCollectionItem(value) {
  const ref = storedMediaAssetRef(value);
  return ref && value?.schemaVersion === COLLECTION_SCHEMA_VERSION ? ref : null;
}

function timestampIso(value) {
  const date = value?.toDate?.();
  return date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

module.exports = {
  COLLECTION_COLORS,
  COLLECTION_LIFECYCLES,
  COLLECTION_SCHEMA_VERSION,
  COLLECTION_SCOPES,
  DOCUMENT_ID_PATTERN,
  MAX_COLLECTION_ITEM_BATCH,
  MAX_COLLECTION_ITEM_SCAN,
  MAX_COLLECTION_PAGE_SIZE,
  MediaCollectionValidationError,
  collectionDocumentId,
  collectionRequestDocumentId,
  encodeCursor,
  mediaAssetRefDocumentId,
  parseListCollectionItemsRequest,
  parseListCollectionsRequest,
  parseMutateCollectionRequest,
  parseSetCollectionItemsRequest,
  requestFingerprint,
  storedCollection,
  storedCollectionItem,
  timestampIso,
};

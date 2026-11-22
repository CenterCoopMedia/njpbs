"use strict";

const { createHash } = require("node:crypto");
const {
  MediaAssetRefValidationError,
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
} = require("./media-asset-ref");
const { SUBCLIP_ID_PATTERN } = require("./saved-video-subclips");
const { ID_PATTERN } = require("./source-media-contract");

const COLLECTION_SCHEMA_VERSION = 1;
const COLLECTION_SCOPES = Object.freeze(["private", "all_staff"]);
const COLLECTION_PERMISSIONS = Object.freeze(["view", "organize", "manage_sharing"]);
const MAX_COLLECTION_SHARES = 50;
const STAFF_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COLLECTION_LIFECYCLES = Object.freeze(["active", "archived"]);
const COLLECTION_COLORS = Object.freeze(["slate", "blue", "green", "gold", "red", "purple"]);
const MAX_COLLECTION_PAGE_SIZE = 30;
const MAX_PINNED_COLLECTIONS = 20;
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

function parseCollectionItemRef(value) {
  if (value?.backend === "subclip") {
    rejectUnknownFields(value, new Set(["backend", "id"]), "Subclip reference");
    if (typeof value.id !== "string" || !SUBCLIP_ID_PATTERN.test(value.id)) {
      throw new MediaCollectionValidationError("Saved subclip id is invalid");
    }
    return { backend: "subclip", id: value.id };
  }
  return parseCollectionRef(value);
}

function canonicalCollectionItemRef(ref) {
  return ref.backend === "subclip" ? `subclip:${ref.id}` : canonicalMediaAssetRef(ref);
}

function collectionItemDocumentId(ref) {
  return ref.backend === "subclip"
    ? createHash("sha256").update(canonicalCollectionItemRef(ref), "utf8").digest("hex")
    : mediaAssetRefDocumentId(ref);
}

function parseSortedRefs(values) {
  if (!Array.isArray(values)) throw new MediaCollectionValidationError("Refs must be an array");
  if (values.length > MAX_COLLECTION_ITEM_BATCH) throw new MediaCollectionValidationError("Refs has too many values");
  if (values.length === 0) {
    throw new MediaCollectionValidationError("Choose at least one collection item");
  }
  const unique = new Map(values.map(value => {
    const ref = parseCollectionItemRef(value);
    return [canonicalCollectionItemRef(ref), ref];
  }));
  return [...unique.values()].sort((left, right) =>
    canonicalCollectionItemRef(left).localeCompare(canonicalCollectionItemRef(right)));
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
  rejectUnknownFields(value, new Set(["scope", "lifecycle", "cursor", "limit", "pinnedIds"]));
  const scope = requiredChoice(value.scope, COLLECTION_SCOPES, "Collection scope");
  const lifecycle = requiredChoice(
    value.lifecycle,
    COLLECTION_LIFECYCLES,
    "Collection lifecycle",
  );
  const pinnedIds = value.pinnedIds === undefined ? [] : value.pinnedIds;
  if (!Array.isArray(pinnedIds) || pinnedIds.length > MAX_PINNED_COLLECTIONS) {
    throw new MediaCollectionValidationError(`Choose up to ${MAX_PINNED_COLLECTIONS} pinned collections`);
  }
  return {
    scope,
    lifecycle,
    limit: pageLimit(value.limit),
    pinnedIds: [...new Set(pinnedIds.map((id) => requiredDocumentId(id, "Pinned collection id")))],
    cursor: value.cursor === undefined
      ? null
      : parseCursor(value.cursor, { uid, scope, lifecycle, kind: "collections" }),
  };
}

function parseListCollectionItemsRequest(value, uid) {
  rejectUnknownFields(value, new Set(["collectionId", "cursor", "limit", "subclipId"]));
  const collectionId = requiredDocumentId(value.collectionId);
  if (value.subclipId !== undefined) {
    if (value.cursor !== undefined || value.limit !== undefined) {
      throw new MediaCollectionValidationError("Open a subclip without a page limit or cursor");
    }
    return { collectionId, subclipRef: parseCollectionItemRef({ backend: "subclip", id: value.subclipId }) };
  }
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
    ["create", "update", "archive", "restore", "set_sharing"],
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
    set_sharing: new Set(["action", "requestId", "collectionId", "baseVersion", "uid", "permission"]),
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
  if (action === "set_sharing") {
    if (typeof value.uid !== "string" || !STAFF_UID_PATTERN.test(value.uid)) {
      throw new MediaCollectionValidationError("Staff account is invalid");
    }
    return {
      ...request,
      uid: value.uid,
      permission: value.permission === null ? null
        : requiredChoice(value.permission, COLLECTION_PERMISSIONS, "Collection permission"),
    };
  }
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
      "collectionId", "requestId", "baseMembershipVersion", "present", "refs", "subclipAssetId",
    ]),
  );
  if (typeof value.present !== "boolean") {
    throw new MediaCollectionValidationError("Item state must be true or false");
  }
  const refs = parseSortedRefs(value.refs);
  const addingSubclip = value.present && refs.some(ref => ref.backend === "subclip");
  if (addingSubclip ? refs.length !== 1 || typeof value.subclipAssetId !== "string" || !ID_PATTERN.test(value.subclipAssetId)
    : value.subclipAssetId !== undefined) {
    throw new MediaCollectionValidationError("Choose one saved subclip and its source video");
  }
  return {
    collectionId: requiredDocumentId(value.collectionId),
    requestId: requiredRequestId(value.requestId),
    baseMembershipVersion: positiveVersion(
      value.baseMembershipVersion,
      "Base membership version",
    ),
    present: value.present,
    refs,
    ...(addingSubclip ? { subclipAssetId: value.subclipAssetId } : {}),
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
  const sharing = value.sharing === undefined ? [] : value.sharing;
  if (!Array.isArray(sharing) || sharing.length > MAX_COLLECTION_SHARES ||
      (value.scope === "all_staff" && sharing.length > 0) ||
      sharing.some(grant => !plainObject(grant) || typeof grant.uid !== "string" ||
        !STAFF_UID_PATTERN.test(grant.uid) || grant.uid === value.ownerUid ||
        !COLLECTION_PERMISSIONS.includes(grant.permission)) ||
      new Set(sharing.map(grant => grant.uid)).size !== sharing.length) return null;
  let coverRef = null;
  if (value.coverRef !== null && value.coverRef !== undefined) {
    try {
      coverRef = parseMediaAssetRef(value.coverRef);
    } catch {
      return null;
    }
  }
  return { ...value, sharing, coverRef, color: value.color === undefined ? "slate" : value.color };
}

function collectionPermission(actorUid, collection) {
  if (!collection) return null;
  if (collection.scope === "all_staff") return "organize";
  if (collection.ownerUid === actorUid) return "manage_sharing";
  return collection.sharing.find(grant => grant.uid === actorUid)?.permission ?? null;
}

function parseColor(value) {
  if (value === undefined) return "slate";
  if (!COLLECTION_COLORS.includes(value)) {
    throw new MediaCollectionValidationError("Collection color is not available");
  }
  return value;
}

function storedCollectionItem(value) {
  if (value?.schemaVersion !== COLLECTION_SCHEMA_VERSION) return null;
  try {
    const ref = parseCollectionItemRef(value.ref);
    return canonicalCollectionItemRef(ref) === value.canonicalRef ? ref : null;
  } catch (error) {
    if (error instanceof MediaCollectionValidationError) return null;
    throw error;
  }
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
  COLLECTION_PERMISSIONS,
  COLLECTION_SCHEMA_VERSION,
  COLLECTION_SCOPES,
  DOCUMENT_ID_PATTERN,
  MAX_COLLECTION_ITEM_BATCH,
  MAX_COLLECTION_ITEM_SCAN,
  MAX_COLLECTION_PAGE_SIZE,
  MAX_COLLECTION_SHARES,
  MediaCollectionValidationError,
  canonicalCollectionItemRef,
  collectionDocumentId,
  collectionItemDocumentId,
  collectionPermission,
  collectionRequestDocumentId,
  encodeCursor,
  mediaAssetRefDocumentId,
  parseCollectionItemRef,
  parseListCollectionItemsRequest,
  parseListCollectionsRequest,
  parseMutateCollectionRequest,
  parseSetCollectionItemsRequest,
  requestFingerprint,
  storedCollection,
  storedCollectionItem,
  timestampIso,
};

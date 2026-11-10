"use strict";

const { createHash } = require("node:crypto");
const {
  parseSourceMediaRendition,
  sourceMediaViewingCopySummary,
} = require("./source-media-rendition");

const MAX_QUERY_LENGTH = 160;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;
const MAX_NAME_SORT_LENGTH = 512;
const MAX_NAME_SORT_BYTES = 1500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class SourceMediaValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SourceMediaValidationError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownFields(value, allowed, label) {
  if (!plainObject(value)) {
    throw new SourceMediaValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new SourceMediaValidationError(`Unknown ${label.toLowerCase()} field ${unknown}`);
  }
}

function requiredId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new SourceMediaValidationError(`${label} is invalid`);
  }
  return value;
}

function parseSourceMediaMarkers(value = []) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new SourceMediaValidationError("Markers must contain 100 or fewer entries");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) {
    throw new SourceMediaValidationError("Markers must fit within 64 KiB");
  }
  return value.map((marker) => {
    rejectUnknownFields(marker, new Set(["startMs", "endMs", "name", "comment", "type", "color"]), "Marker");
    if (!Number.isSafeInteger(marker.startMs) || marker.startMs < 0 ||
        !Number.isSafeInteger(marker.endMs) || marker.endMs < marker.startMs) {
      throw new SourceMediaValidationError("Marker times must be nonnegative whole milliseconds with end at or after start");
    }
    if (typeof marker.name !== "string" || marker.name.length > 200 ||
        typeof marker.comment !== "string" || marker.comment.length > 1000) {
      throw new SourceMediaValidationError("Marker name or comment exceeds its text limit");
    }
    if (marker.type === "WebLink") {
      throw new SourceMediaValidationError("WebLink markers cannot round-trip because Premiere cannot restore their URL and target");
    }
    if (!["Comment", "Chapter", "Segmentation"].includes(marker.type) ||
        !Number.isInteger(marker.color) || marker.color < 0 || marker.color > 7) {
      throw new SourceMediaValidationError("Marker type or color is invalid");
    }
    return { startMs: marker.startMs, endMs: marker.endMs, name: marker.name,
      comment: marker.comment, type: marker.type, color: marker.color };
  });
}

function parseSourceMediaParent(value) {
  if (value === undefined || value === null) return null;
  rejectUnknownFields(value, new Set(["sourceId", "assetId", "inMs", "outMs"]), "Parent source");
  if (value.sourceId !== "video-library") {
    throw new SourceMediaValidationError("Parent source must be the shared video library");
  }
  const parent = { sourceId: value.sourceId, assetId: requiredId(value.assetId, "Parent asset id") };
  if (value.inMs !== undefined || value.outMs !== undefined) {
    if (!Number.isSafeInteger(value.inMs) || value.inMs < 0 ||
        !Number.isSafeInteger(value.outMs) || value.outMs <= value.inMs) {
      throw new SourceMediaValidationError("Parent range requires whole milliseconds with out after in");
    }
    parent.inMs = value.inMs;
    parent.outMs = value.outMs;
  }
  return parent;
}

function normalizeSearchPrefix(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new SourceMediaValidationError("Search text must be a string");
  }
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new SourceMediaValidationError(
      `Search text must be ${MAX_QUERY_LENGTH} characters or fewer`,
    );
  }
  return normalized;
}

function normalizeSourceMediaNameSort(value) {
  if (typeof value !== "string") {
    throw new SourceMediaValidationError("Name is invalid");
  }
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > MAX_NAME_SORT_LENGTH) {
    throw new SourceMediaValidationError(
      `Normalized name must be ${MAX_NAME_SORT_LENGTH} characters or fewer`,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_NAME_SORT_BYTES) {
    throw new SourceMediaValidationError("Normalized name exceeds the indexed text limit; shorten the title");
  }
  return normalized;
}

function validCursorSort(value, order) {
  if (order === "size_desc" || order === "size_asc") {
    return Number.isSafeInteger(value) && value >= 0;
  }
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_NAME_SORT_LENGTH && Buffer.byteLength(value, "utf8") <= MAX_NAME_SORT_BYTES;
}

function parseCursor(value, request) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new SourceMediaValidationError("Cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !plainObject(decoded) ||
      decoded.sourceId !== request.sourceId ||
      decoded.q !== request.q ||
      (decoded.tag ?? "") !== request.tag ||
      (decoded.createdBy ?? "") !== request.createdBy ||
      (decoded.rightsStatus ?? "") !== request.rightsStatus ||
      (decoded.order ?? (request.q ? "name_asc" : "updated_desc")) !== request.sort ||
      typeof decoded.id !== "string" ||
      !ID_PATTERN.test(decoded.id) ||
      !validCursorSort(decoded.sort, request.sort)
    ) {
      throw new Error("Invalid cursor fields");
    }
    return { id: decoded.id, sort: decoded.sort };
  } catch {
    throw new SourceMediaValidationError("Cursor is invalid");
  }
}

function encodeCursor({ sourceId, q, tag = "", createdBy = "", rightsStatus = "",
  order = q ? "name_asc" : "updated_desc", id, sort }) {
  return Buffer.from(JSON.stringify({ sourceId, q, tag, createdBy, rightsStatus, order, id, sort }), "utf8")
    .toString("base64url");
}

function parseListFilter(value, label, maxLength) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" || value.length > maxLength ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new SourceMediaValidationError(`${label} is invalid`);
  }
  return value.trim();
}

function parseSourceMediaListRequest(value) {
  rejectUnknownFields(value, new Set([
    "sourceId", "assetId", "pendingIds", "cursor", "limit", "q", "tag", "createdBy", "rightsStatus", "sort", "posters",
  ]), "Request");
  const sourceId = requiredId(value.sourceId, "Source id");
  if (value.pendingIds !== undefined) {
    if (Object.keys(value).some(key => !["sourceId", "pendingIds"].includes(key)) ||
        !Array.isArray(value.pendingIds) || value.pendingIds.length < 1 || value.pendingIds.length > MAX_PAGE_SIZE) {
      throw new SourceMediaValidationError(`Status lookup requires 1 through ${MAX_PAGE_SIZE} IDs and no list options`);
    }
    return { sourceId, pendingIds: [...new Set(value.pendingIds.map(id => requiredId(id, "Asset id")))] };
  }
  if (value.posters !== undefined && value.posters !== true) {
    throw new SourceMediaValidationError("Posters must be true when present");
  }
  const posters = value.posters === true ? { posters: true } : {};
  if (value.assetId !== undefined) {
    if (Object.keys(value).some(key => !["sourceId", "assetId", "posters"].includes(key))) {
      throw new SourceMediaValidationError("Exact asset lookup cannot include list filters");
    }
    return { sourceId, assetId: requiredId(value.assetId, "Asset id"), ...posters };
  }
  const q = normalizeSearchPrefix(value.q);
  const tag = parseListFilter(value.tag, "Tag", 80);
  const createdBy = parseListFilter(value.createdBy, "Uploader", 128);
  const rightsStatus = parseListFilter(value.rightsStatus, "Rights status", 20);
  if (rightsStatus && !["pending", "complete"].includes(rightsStatus)) {
    throw new SourceMediaValidationError("Rights status must be pending or complete");
  }
  // A single indexed filter keeps every supported query bounded without a filter cross-product.
  if ([tag, createdBy, rightsStatus].filter(Boolean).length > 1) {
    throw new SourceMediaValidationError("Choose one tag, uploader, or rights filter at a time");
  }
  const requestedSort = value.sort ?? "updated_desc";
  if (!["updated_desc", "updated_asc", "name_asc", "size_desc", "size_asc"].includes(requestedSort)) {
    throw new SourceMediaValidationError(
      "Sort must be updated_desc, updated_asc, name_asc, size_desc, or size_asc",
    );
  }
  // Firestore prefix bounds require the name field to be the first sort.
  const sort = q ? "name_asc" : requestedSort;
  const limit = value.limit === undefined ? DEFAULT_PAGE_SIZE : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new SourceMediaValidationError(
      `Limit must be a whole number from 1 through ${MAX_PAGE_SIZE}`,
    );
  }
  const request = { sourceId, q, tag, createdBy, rightsStatus, sort, limit };
  return { ...request, cursor: parseCursor(value.cursor, request), ...posters };
}

function parseSourceMediaReadRequest(value) {
  rejectUnknownFields(value, new Set(["sourceId", "assetId", "action"]), "Request");
  const action = value.action;
  if (!["preview", "download", "poster", "download_web"].includes(action)) {
    throw new SourceMediaValidationError(
      "Action must be preview, download, poster, or download_web",
    );
  }
  return {
    sourceId: requiredId(value.sourceId, "Source id"),
    assetId: requiredId(value.assetId, "Asset id"),
    action,
  };
}

function isoTimestamp(value) {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.valueOf())
      ? date.toISOString()
      : null;
  }
  return null;
}

function nullableText(value, maxLength = 500) {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function parseSourceMediaAsset(id, value) {
  if (!ID_PATTERN.test(id) || !plainObject(value)) return null;
  if (
    !ID_PATTERN.test(value.sourceId) ||
    value.lifecycle !== "active" ||
    value.kind !== "video" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 500 ||
    typeof value.originalName !== "string" ||
    !value.originalName.trim() ||
    value.originalName.length > 500 ||
    typeof value.nameSort !== "string" ||
    !value.nameSort ||
    value.nameSort.length > MAX_NAME_SORT_LENGTH ||
    Buffer.byteLength(value.nameSort, "utf8") > MAX_NAME_SORT_BYTES ||
    typeof value.updatedAtSort !== "string" ||
    !isoTimestamp(value.updatedAtSort) ||
    typeof value.mimeType !== "string" ||
    !(value.mimeType.startsWith("video/") || value.mimeType === "application/mxf") ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    (value.preview !== "browser" && value.preview !== "download_only") ||
    (value.rightsStatus !== "complete" && value.rightsStatus !== "pending") ||
    typeof value.objectKey !== "string" ||
    !value.objectKey ||
    value.objectKey.length > 1024 ||
    typeof value.objectVersionId !== "string" ||
    !value.objectVersionId ||
    value.objectVersionId.length > 1024 ||
    !Array.isArray(value.tags) ||
    value.tags.length > 30 ||
    value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 80)
  ) {
    return null;
  }
  let markers;
  let parentSource;
  try {
    markers = parseSourceMediaMarkers(value.markers);
    parentSource = parseSourceMediaParent(value.parentSource);
  } catch { return null; }
  const asset = {
    id,
    sourceId: value.sourceId,
    name: value.name.trim(),
    originalName: value.originalName.trim(),
    description: nullableText(value.description, 2_000),
    metadataUpdateRequested: value.metadataUpdateRequested === true,
    nameSort: value.nameSort,
    updatedAtSort: value.updatedAtSort,
    mimeType: value.mimeType,
    kind: "video",
    sizeBytes: value.sizeBytes,
    preview: value.preview,
    license: nullableText(value.license),
    credit: nullableText(value.credit),
    tags: value.tags.map((tag) => tag.trim()),
    markers,
    parentSource,
    rightsStatus: value.rightsStatus,
    version: value.version,
    createdBy: nullableText(value.createdBy, 128),
    createdAt: isoTimestamp(value.createdAt),
    updatedAt: isoTimestamp(value.updatedAt),
    objectKey: value.objectKey,
    objectVersionId: value.objectVersionId,
    checksumSha256: typeof value.checksumSha256 === "string" ? value.checksumSha256 : null,
  };
  return {
    ...asset,
    rendition: parseSourceMediaRendition(value.rendition, asset),
    ...(["uploading", "processing", "ready", "promoting", "complete", "failed"].includes(value.replacement?.state) ? {
      replacement: { state: value.replacement.state, requestedAt: isoTimestamp(value.replacement.requestedAt),
        requestedBy: nullableText(value.replacement.requestedBy, 200),
        ...(value.replacement.errorCode ? { errorCode: ["publication_refresh_failed", "replacement_permission_changed", "replacement_video_changed"].includes(value.replacement.errorCode) ? value.replacement.errorCode : "processing_failed" } : {}) },
    } : {}),
  };
}

/**
 * An opaque token that changes when the original file is replaced. Timed comments send it back
 * so a time picked on the old file cannot be stamped on the new one. The S3 version stays private.
 */
function sourceMediaFileVersion(objectVersionId) {
  if (typeof objectVersionId !== "string" || !objectVersionId) return null;
  return createHash("sha256").update(`source-media-file-version:${objectVersionId}`).digest("hex").slice(0, 32);
}

function sourceMediaAssetSummary(asset) {
  return {
    id: asset.id,
    sourceId: asset.sourceId,
    name: asset.name,
    originalName: asset.originalName,
    description: asset.description,
    metadataUpdateRequested: asset.metadataUpdateRequested === true,
    mimeType: asset.mimeType,
    kind: asset.kind,
    sizeBytes: asset.sizeBytes,
    preview: asset.preview,
    license: asset.license,
    credit: asset.credit,
    tags: asset.tags,
    parentSource: asset.parentSource ?? null,
    rightsStatus: asset.rightsStatus,
    version: asset.version,
    fileVersion: sourceMediaFileVersion(asset.objectVersionId),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    uploadedBy: asset.createdBy && !asset.createdBy.startsWith("system:")
      ? { uid: asset.createdBy, name: "Uploader name unavailable" }
      : null,
    viewingCopy: sourceMediaViewingCopySummary(asset.rendition),
    ...(asset.replacement ? { replacement: asset.replacement } : {}),
  };
}

function sourceMediaAssetDetail(asset) {
  return { ...sourceMediaAssetSummary(asset), markers: asset.markers ?? [] };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  ID_PATTERN,
  MAX_PAGE_SIZE,
  MAX_QUERY_LENGTH,
  MAX_NAME_SORT_LENGTH,
  MAX_NAME_SORT_BYTES,
  SourceMediaValidationError,
  encodeCursor,
  normalizeSearchPrefix,
  normalizeSourceMediaNameSort,
  parseSourceMediaAsset,
  parseSourceMediaMarkers,
  parseSourceMediaParent,
  parseSourceMediaListRequest,
  parseSourceMediaReadRequest,
  sourceMediaAssetSummary,
  sourceMediaAssetDetail,
  sourceMediaFileVersion,
};

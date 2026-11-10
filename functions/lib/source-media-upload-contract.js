"use strict";

const {
  SourceMediaValidationError,
  normalizeSourceMediaNameSort,
  parseSourceMediaMarkers,
  parseSourceMediaParent,
} = require("./source-media-contract");

const MIB = 1024 * 1024;
const DEFAULT_PART_SIZE = 16 * MIB;
const MAX_PART_SIZE = 64 * MIB;
const MAX_PARTS = 4_000;
const MAX_SIGN_WINDOW = 6;
const MAX_VIDEO_BYTES = MAX_PART_SIZE * MAX_PARTS;
const CHECKSUM_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const VIDEO_MIME_EXTENSIONS = Object.freeze({
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/mpeg": ".mpeg",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/x-ms-wmv": ".wmv",
  "application/mxf": ".mxf",
});
const EXTENSION_MIME_TYPES = Object.freeze({
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".mxf": "application/mxf",
});

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknown(value, allowed, label = "Request") {
  if (!plainObject(value)) throw new SourceMediaValidationError(`${label} must be an object`);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new SourceMediaValidationError(`Unknown ${label.toLowerCase()} field ${unknown}`);
  }
}

function boundedText(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new SourceMediaValidationError(`${label} is invalid`);
  }
  return value.trim();
}

function requiredId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new SourceMediaValidationError(`${label} is invalid`);
  }
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SourceMediaValidationError("Upload version is invalid");
  }
  return value;
}

function normalizeTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new SourceMediaValidationError("Tags must contain 30 or fewer values");
  }
  return [...new Set(value.map((tag) => boundedText(tag, "Tag", 80)))];
}

function normalizeMetadata(value, originalName, { partial = false } = {}) {
  if (value === undefined && !partial) value = {};
  rejectUnknown(
    value,
    new Set(["name", "description", "credit", "license", "tags", "rightsStatus", "markers", "metadataUpdateRequested"]),
    "Metadata",
  );
  const output = {};
  if (value.metadataUpdateRequested !== undefined) {
    if (value.metadataUpdateRequested !== undefined && typeof value.metadataUpdateRequested !== "boolean") {
      throw new SourceMediaValidationError("metadataUpdateRequested must be a boolean");
    }
    output.metadataUpdateRequested = value.metadataUpdateRequested === true;
  }
  if (!partial || value.name !== undefined) {
    output.name = boundedText(value.name ?? originalName, "Name", 500);
    normalizeSourceMediaNameSort(output.name);
  }
  for (const field of ["description", "credit", "license"]) {
    if (!partial || value[field] !== undefined) {
      output[field] = boundedText(value[field], field, field === "description" ? 2_000 : 500, {
        nullable: true,
      });
    }
  }
  if (!partial || value.tags !== undefined) output.tags = normalizeTags(value.tags);
  if (value.markers !== undefined) output.markers = parseSourceMediaMarkers(value.markers);
  if (!partial || value.rightsStatus !== undefined) {
    const status = value.rightsStatus ?? "pending";
    if (status !== "complete" && status !== "pending") {
      throw new SourceMediaValidationError("Rights status is invalid");
    }
    output.rightsStatus = status;
  }
  return output;
}

function normalizeVideoMimeType(value, originalName) {
  const supplied = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (Object.hasOwn(VIDEO_MIME_EXTENSIONS, supplied)) return supplied;
  if (supplied && supplied !== "application/octet-stream") {
    throw new SourceMediaValidationError("Video type is not supported");
  }
  const extension = originalName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  const inferred = EXTENSION_MIME_TYPES[extension];
  if (!inferred) throw new SourceMediaValidationError("Video type is not supported");
  return inferred;
}

function parseStartUploadRequest(value) {
  rejectUnknown(
    value,
    new Set(["sourceId", "requestId", "originalName", "mimeType", "sizeBytes", "lastModified", "metadata", "parentSource", "replacement"]),
  );
  const originalName = boundedText(value.originalName, "File name", 500);
  const mimeType = normalizeVideoMimeType(value.mimeType, originalName);
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_VIDEO_BYTES) {
    throw new SourceMediaValidationError(`Video size must be from 1 through ${MAX_VIDEO_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(value.lastModified) || value.lastModified < 0) {
    throw new SourceMediaValidationError("File modification time is invalid");
  }
  const parentSource = parseSourceMediaParent(value.parentSource);
  let replacement;
  if (value.replacement !== undefined) {
    rejectUnknown(value.replacement, new Set(["assetId", "expectedVersion", "confirmed"]), "Replacement");
    if (value.sourceId !== "video-library" || value.replacement.confirmed !== true || parentSource || value.metadata !== undefined) {
      throw new SourceMediaValidationError("Confirm video replacement without changing metadata or placements");
    }
    replacement = { assetId: requiredId(value.replacement.assetId, "Asset id"),
      expectedVersion: version(value.replacement.expectedVersion), confirmed: true };
  }
  if (parentSource && value.sourceId !== parentSource.sourceId) {
    throw new SourceMediaValidationError("Parent and new asset must belong to the shared video library");
  }
  return {
    sourceId: requiredId(value.sourceId, "Source id"),
    ...(value.requestId === undefined ? {} : { requestId: requiredId(value.requestId, "Request id") }),
    ...(parentSource ? { parentSource } : {}),
    ...(replacement ? { replacement } : {}),
    originalName,
    mimeType,
    sizeBytes: value.sizeBytes,
    lastModified: value.lastModified,
    metadata: normalizeMetadata(value.metadata, originalName),
  };
}

function expectedPartSize(totalSize, partSize, partNumber, totalParts) {
  if (partNumber < totalParts) return partSize;
  return totalSize - partSize * (totalParts - 1);
}

function choosePartSize(sizeBytes) {
  const required = Math.ceil(sizeBytes / MAX_PARTS / MIB) * MIB;
  return Math.min(MAX_PART_SIZE, Math.max(DEFAULT_PART_SIZE, required));
}

function parseSignUploadPartsRequest(value) {
  rejectUnknown(value, new Set(["sourceId", "sessionId", "version", "parts"]));
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > MAX_SIGN_WINDOW) {
    throw new SourceMediaValidationError(`Parts must contain from 1 through ${MAX_SIGN_WINDOW} values`);
  }
  const seen = new Set();
  const parts = value.parts.map((part) => {
    rejectUnknown(part, new Set(["partNumber", "sizeBytes", "checksumSha256"]), "Part");
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > MAX_PARTS || seen.has(part.partNumber)) {
      throw new SourceMediaValidationError("Part number is invalid or duplicated");
    }
    seen.add(part.partNumber);
    if (!Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 1) {
      throw new SourceMediaValidationError("Part size is invalid");
    }
    if (typeof part.checksumSha256 !== "string" || !CHECKSUM_PATTERN.test(part.checksumSha256)) {
      throw new SourceMediaValidationError("Part SHA-256 checksum is invalid");
    }
    return part;
  });
  return {
    sourceId: requiredId(value.sourceId, "Source id"),
    sessionId: requiredId(value.sessionId, "Session id"),
    version: version(value.version),
    parts,
  };
}

function parseSessionRequest(value, { requiresVersion = false } = {}) {
  const fields = new Set(["sourceId", "sessionId"]);
  if (requiresVersion) fields.add("version");
  rejectUnknown(value, fields);
  const parsed = {
    sourceId: requiredId(value.sourceId, "Source id"),
    sessionId: requiredId(value.sessionId, "Session id"),
  };
  if (requiresVersion) parsed.version = version(value.version);
  return parsed;
}

function parseDeleteSourceMediaRequest(value) {
  rejectUnknown(value, new Set(["sourceId", "assetId", "expectedVersion"]));
  return {
    sourceId: requiredId(value.sourceId, "Source id"),
    assetId: requiredId(value.assetId, "Asset id"),
    expectedVersion: version(value.expectedVersion),
  };
}

function parseMetadataUpdateRequest(value) {
  rejectUnknown(value, new Set(["sourceId", "assetId", "expectedVersion", "changes"]));
  if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) {
    throw new SourceMediaValidationError("Expected asset version is invalid");
  }
  const changes = normalizeMetadata(value.changes, null, { partial: true });
  if (!Object.keys(changes).length) {
    throw new SourceMediaValidationError("Changes must include at least one metadata field");
  }
  return {
    sourceId: requiredId(value.sourceId, "Source id"),
    assetId: requiredId(value.assetId, "Asset id"),
    expectedVersion: value.expectedVersion,
    changes,
  };
}

module.exports = {
  CHECKSUM_PATTERN,
  DEFAULT_PART_SIZE,
  MAX_PART_SIZE,
  MAX_PARTS,
  MAX_SIGN_WINDOW,
  MAX_VIDEO_BYTES,
  VIDEO_MIME_EXTENSIONS,
  choosePartSize,
  expectedPartSize,
  normalizeMetadata,
  normalizeVideoMimeType,
  parseDeleteSourceMediaRequest,
  parseMetadataUpdateRequest,
  parseSessionRequest,
  parseSignUploadPartsRequest,
  parseStartUploadRequest,
};

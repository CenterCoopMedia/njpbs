"use strict";

const { createHash } = require("node:crypto");

const MEDIA_ASSET_REF_BACKENDS = Object.freeze(["r2", "s3"]);
const MEDIA_ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class MediaAssetRefValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaAssetRefValidationError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownFields(value, allowed, label) {
  if (!plainObject(value)) {
    throw new MediaAssetRefValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new MediaAssetRefValidationError(`Unknown ${label.toLowerCase()} field ${unknown}`);
  }
}

function requiredId(value, label) {
  if (typeof value !== "string" || !MEDIA_ASSET_ID_PATTERN.test(value)) {
    throw new MediaAssetRefValidationError(`${label} is invalid`);
  }
  return value;
}

function parseMediaAssetRef(value) {
  rejectUnknownFields(value, new Set(["backend", "sourceId", "id"]), "Asset reference");
  if (!MEDIA_ASSET_REF_BACKENDS.includes(value.backend)) {
    throw new MediaAssetRefValidationError("Asset reference backend is invalid");
  }
  const id = requiredId(value.id, "Asset id");
  if (value.backend === "r2") {
    if (value.sourceId !== undefined) {
      throw new MediaAssetRefValidationError("R2 asset reference cannot include a source id");
    }
    return { backend: "r2", id };
  }
  return {
    backend: "s3",
    sourceId: requiredId(value.sourceId, "Source id"),
    id,
  };
}

function canonicalMediaAssetRef(ref) {
  return ref.backend === "r2"
    ? `r2:${ref.id}`
    : `s3:${ref.sourceId}:${ref.id}`;
}

function mediaAssetRefDocumentId(ref) {
  return createHash("sha256").update(canonicalMediaAssetRef(ref), "utf8").digest("hex");
}

function parseUniqueMediaAssetRefs(values, maxRefs) {
  if (!Array.isArray(values)) {
    throw new MediaAssetRefValidationError("Refs must be an array");
  }
  if (!Number.isSafeInteger(maxRefs) || maxRefs < 1 || values.length > maxRefs) {
    throw new MediaAssetRefValidationError("Refs has too many values");
  }
  const refs = [];
  const seen = new Set();
  for (const value of values) {
    const ref = parseMediaAssetRef(value);
    const canonical = canonicalMediaAssetRef(ref);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      refs.push(ref);
    }
  }
  return refs;
}

function storedMediaAssetRef(value) {
  if (!plainObject(value)) return null;
  try {
    const ref = parseMediaAssetRef(value.ref);
    return canonicalMediaAssetRef(ref) === value.canonicalRef ? ref : null;
  } catch (error) {
    if (error instanceof MediaAssetRefValidationError) return null;
    throw error;
  }
}

module.exports = {
  MEDIA_ASSET_ID_PATTERN,
  MEDIA_ASSET_REF_BACKENDS,
  MediaAssetRefValidationError,
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
  parseUniqueMediaAssetRefs,
  storedMediaAssetRef,
};

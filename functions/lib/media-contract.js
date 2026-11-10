"use strict";

const ASSET_ID_MAX_BYTES = 128;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_CONFIGURED_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_BYTES;
const MAX_IMAGE_PIXELS = 100_000_000;
// Web-copy output and synchronous thumbnail input use the same lower pixel budget.
const MAX_WEB_COPY_PIXELS = 25_000_000;
const MAX_TAGS = 20;
const MAX_MEDIA_CATEGORY_ASSIGNMENTS = 8;
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MEDIA_TYPES = Object.freeze({
  "image/jpeg": Object.freeze({ extension: "jpg", kind: "image", sharpFormat: "jpeg" }),
  "image/png": Object.freeze({ extension: "png", kind: "image", sharpFormat: "png" }),
  "image/webp": Object.freeze({ extension: "webp", kind: "image", sharpFormat: "webp" }),
  "image/gif": Object.freeze({ extension: "gif", kind: "image", sharpFormat: "gif" }),
  "image/avif": Object.freeze({ extension: "avif", kind: "image", sharpFormat: "heif" }),
  "application/pdf": Object.freeze({ extension: "pdf", kind: "document" }),
  "audio/wav": Object.freeze({ extension: "wav", kind: "audio" }),
});

const MEDIA_FILENAME_EXTENSIONS = Object.freeze({
  "image/jpeg": Object.freeze(["jpg", "jpeg"]),
  "image/png": Object.freeze(["png"]),
  "image/webp": Object.freeze(["webp"]),
  "image/gif": Object.freeze(["gif"]),
  "image/avif": Object.freeze(["avif"]),
  "application/pdf": Object.freeze(["pdf"]),
  "audio/wav": Object.freeze(["wav"]),
});

class MediaValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaValidationError";
    this.status = status;
  }
}

function requireString(value, label, { max, allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw new MediaValidationError(`${label} is required`);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new MediaValidationError(`${label} is required`);
  }
  if (max && normalized.length > max) {
    throw new MediaValidationError(`${label} must be ${max} characters or fewer`);
  }
  return normalized;
}

function optionalString(value, label, max) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, label, { max });
}

function normalizeOriginalName(value) {
  const name = requireString(value, "Original filename", { max: 255 });
  const invalid = [...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      character === "/" ||
      character === "\\" ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    );
  });
  if (invalid) {
    throw new MediaValidationError("Original filename contains invalid characters");
  }
  return name;
}

function normalizeEditableOriginalName(value, mimeType) {
  const name = normalizeOriginalName(value);
  const extensions = MEDIA_FILENAME_EXTENSIONS[mimeType];
  if (!extensions) {
    throw new MediaValidationError("This file type does not support filename changes");
  }
  const separator = name.lastIndexOf(".");
  const extension = separator > 0
    ? name.slice(separator + 1).toLocaleLowerCase("en-US")
    : "";
  if (!extensions.includes(extension)) {
    const allowed = extensions.map((candidate) => `.${candidate}`).join(" or ");
    throw new MediaValidationError(
      `Original filename must use ${allowed} for ${mimeType}`,
    );
  }
  return name;
}

function normalizeTags(value) {
  if (value === undefined || value === null || value === "") return [];
  let candidates;
  if (Array.isArray(value)) {
    candidates = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        candidates = JSON.parse(trimmed);
      } catch {
        throw new MediaValidationError("Tags must be a JSON array or a comma-separated list");
      }
    } else {
      candidates = trimmed.split(",");
    }
  } else {
    throw new MediaValidationError("Tags must be a JSON array or a comma-separated list");
  }
  if (!Array.isArray(candidates)) {
    throw new MediaValidationError("Tags must be a JSON array or a comma-separated list");
  }
  const tags = [];
  const seen = new Set();
  for (const value of candidates) {
    const tag = requireString(value, "Each tag", { max: 40 });
    const key = tag.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) {
    throw new MediaValidationError(`Use ${MAX_TAGS} tags or fewer`);
  }
  return tags;
}

function normalizeMediaCategoryAssignments(value, primaryCategory) {
  const primary = requireString(primaryCategory, "Primary category", { max: 60 })
    .toLocaleLowerCase("en-US");
  if (!CATEGORY_PATTERN.test(primary)) {
    throw new MediaValidationError(
      "Primary category must use lowercase letters, numbers, and single hyphens",
    );
  }
  let candidates = value;
  if (candidates === undefined || candidates === null || candidates === "") {
    candidates = [primary];
  } else if (typeof candidates === "string") {
    try {
      candidates = JSON.parse(candidates);
    } catch {
      throw new MediaValidationError("Categories must be a JSON array");
    }
  }
  if (!Array.isArray(candidates)) {
    throw new MediaValidationError("Categories must be an array");
  }
  if (candidates.length < 1 || candidates.length > MAX_MEDIA_CATEGORY_ASSIGNMENTS) {
    throw new MediaValidationError(
      `Choose between 1 and ${MAX_MEDIA_CATEGORY_ASSIGNMENTS} categories`,
    );
  }
  const normalized = [];
  const seen = new Set();
  for (const value of candidates) {
    const category = requireString(value, "Each category", { max: 60 })
      .toLocaleLowerCase("en-US");
    if (!CATEGORY_PATTERN.test(category)) {
      throw new MediaValidationError(
        "Each category must use lowercase letters, numbers, and single hyphens",
      );
    }
    if (seen.has(category)) {
      throw new MediaValidationError("Categories cannot contain duplicates");
    }
    seen.add(category);
    normalized.push(category);
  }
  if (!seen.has(primary)) {
    throw new MediaValidationError(
      "The primary category must remain assigned",
    );
  }
  return [primary, ...normalized.filter((category) => category !== primary)];
}

function normalizeUploadMetadata(fields, originalName) {
  const source = fields && typeof fields === "object" && !Array.isArray(fields)
    ? fields
    : {};
  const safeOriginalName = normalizeOriginalName(originalName);
  const nameFallback = safeOriginalName.replace(/\.[^.]+$/, "");
  const category = requireString(source.category ?? "general", "Category", { max: 60 })
    .toLocaleLowerCase("en-US");
  if (!CATEGORY_PATTERN.test(category)) {
    throw new MediaValidationError(
      "Category must use lowercase letters, numbers, and single hyphens",
    );
  }
  if (source.metadataUpdateRequested !== undefined &&
      ![true, false, "true", "false"].includes(source.metadataUpdateRequested)) {
    throw new MediaValidationError("metadataUpdateRequested must be a boolean");
  }
  return {
    ...(source.metadataUpdateRequested !== undefined ? { metadataUpdateRequested: source.metadataUpdateRequested === true || source.metadataUpdateRequested === "true" } : {}),
    name: requireString(source.name ?? nameFallback, "Name", { max: 180 }),
    category,
    categories: normalizeMediaCategoryAssignments(source.categories, category),
    description: optionalString(source.description, "Description", 2_000),
    altText: optionalString(source.altText, "Alt text suggestion", 500),
    license: optionalString(source.license, "License", 120),
    credit: optionalString(source.credit, "Credit", 300),
    tags: normalizeTags(source.tags),
  };
}

function assertAssetId(assetId) {
  if (
    typeof assetId !== "string" ||
    assetId.length === 0 ||
    Buffer.byteLength(assetId, "utf8") > ASSET_ID_MAX_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(assetId)
  ) {
    throw new MediaValidationError("The server created an invalid asset id", 500);
  }
  return assetId;
}

function mediaType(mimeType) {
  return Object.hasOwn(MEDIA_TYPES, mimeType) ? MEDIA_TYPES[mimeType] : null;
}

function finalObjectKey({ category, assetId, contentHash, mimeType }) {
  const type = mediaType(mimeType);
  if (!type) throw new MediaValidationError("This file type is not supported");
  assertAssetId(assetId);
  if (!CATEGORY_PATTERN.test(category)) {
    throw new MediaValidationError("The media category is not path-safe");
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new MediaValidationError("The media content hash is invalid", 500);
  }
  return `cms-media/${category}/${assetId}/${contentHash}.${type.extension}`;
}

function thumbnailObjectKey({ category, assetId, contentHash, width }) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 1600) {
    throw new MediaValidationError("The media thumbnail width is invalid", 500);
  }
  const originalKey = finalObjectKey({
    category, assetId, contentHash, mimeType: "image/webp",
  });
  return `${originalKey.slice(0, originalKey.lastIndexOf("/"))}/thumbs/${contentHash}-w${width}.webp`;
}

function stagingObjectKey(attemptId) {
  assertAssetId(attemptId);
  return `cms-media-staging/${attemptId}`;
}

function publicMediaUrl(origin, key) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    throw new MediaValidationError("The media public origin is not configured", 503);
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new MediaValidationError("The media public origin must be an HTTPS origin", 503);
  }
  base.pathname = `${base.pathname.replace(/\/?$/, "/")}${key}`;
  return base.toString();
}

function mediaProjection(record) {
  const credit = record.mimeType?.startsWith("image/")
    ? optionalString(typeof record.credit === "string" ? record.credit.trim() : record.credit, "Credit", 300) : null;
  return {
    url: record.url,
    altText: record.altText,
    ...(credit ? { credit } : {}),
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
  };
}

module.exports = {
  ASSET_ID_MAX_BYTES,
  CATEGORY_PATTERN,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_WEB_COPY_PIXELS,
  MAX_MEDIA_CATEGORY_ASSIGNMENTS,
  MAX_CONFIGURED_UPLOAD_BYTES,
  MAX_TAGS,
  MEDIA_TYPES,
  MediaValidationError,
  assertAssetId,
  finalObjectKey,
  thumbnailObjectKey,
  mediaProjection,
  mediaType,
  normalizeTags,
  normalizeEditableOriginalName,
  normalizeOriginalName,
  normalizeMediaCategoryAssignments,
  normalizeUploadMetadata,
  publicMediaUrl,
  stagingObjectKey,
};

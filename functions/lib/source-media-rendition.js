"use strict";

const { createHash } = require("node:crypto");

const RENDITION_SCHEMA_VERSION = 1;
const RENDITION_STATES = Object.freeze([
  "not_prepared",
  "processing",
  "ready",
  "failed",
]);
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const POSTER_NAME_PATTERN = /^preview-poster\.\d{7}\.jpg$/;

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyFields(value, allowed) {
  return plainObject(value) && Object.keys(value).every((field) => allowed.has(field));
}

function validSourceIdentity(asset) {
  return Boolean(
    plainObject(asset) &&
    typeof asset.sourceId === "string" && asset.sourceId.length > 0 &&
    typeof asset.id === "string" && asset.id.length > 0 &&
    typeof asset.objectKey === "string" && asset.objectKey.length > 0 &&
    typeof asset.objectVersionId === "string" && asset.objectVersionId.length > 0 &&
    Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes >= 0
  );
}

function sourceMediaRenditionId(asset) {
  if (!validSourceIdentity(asset)) {
    throw new TypeError("Source media rendition identity is invalid");
  }
  return createHash("sha256").update(JSON.stringify([
    asset.sourceId,
    asset.id,
    asset.objectKey,
    asset.objectVersionId,
    asset.sizeBytes,
    RENDITION_SCHEMA_VERSION,
  ])).digest("hex");
}

function sourceMediaRenditionOutputPrefix(asset, attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new TypeError("Source media rendition attempt id is invalid");
  }
  return `outputs/${sourceMediaRenditionId(asset)}/${attemptId}/`;
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function optionalPositiveInteger(value) {
  return value === undefined || positiveInteger(value);
}

function optionalDuration(value) {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

function validSourceFrameRate(value, prefix = "sourceFrameRate") {
  const numerator = value[`${prefix}Numerator`];
  const denominator = value[`${prefix}Denominator`];
  return (numerator === undefined && denominator === undefined) ||
    (positiveInteger(numerator) && positiveInteger(denominator) && numerator / denominator <= 240);
}

function parseWebOutput(value, prefix) {
  if (!hasOnlyFields(value, new Set([
    "objectKey",
    "objectVersionId",
    "sizeBytes",
    "mimeType",
    "width",
    "height",
    "durationSeconds",
    "sourceFrameRateNumerator",
    "sourceFrameRateDenominator",
    "frameRateNumerator",
    "frameRateDenominator",
  ]))) return null;
  if (
    value.objectKey !== `${prefix}preview.mp4` ||
    typeof value.objectVersionId !== "string" ||
    !value.objectVersionId ||
    value.objectVersionId.length > 1024 ||
    !positiveInteger(value.sizeBytes) ||
    value.mimeType !== "video/mp4" ||
    !optionalPositiveInteger(value.width) ||
    !optionalPositiveInteger(value.height) ||
    !validSourceFrameRate(value) ||
    !validSourceFrameRate(value, "frameRate") ||
    !optionalDuration(value.durationSeconds)
  ) return null;
  return {
    objectKey: value.objectKey,
    objectVersionId: value.objectVersionId,
    sizeBytes: value.sizeBytes,
    mimeType: "video/mp4",
    ...(value.sourceFrameRateNumerator === undefined ? {} : {
      sourceFrameRateNumerator: value.sourceFrameRateNumerator,
      sourceFrameRateDenominator: value.sourceFrameRateDenominator,
    }),
    ...(value.frameRateNumerator === undefined ? {} : {
      frameRateNumerator: value.frameRateNumerator,
      frameRateDenominator: value.frameRateDenominator,
    }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.durationSeconds === undefined ? {} : {
      durationSeconds: value.durationSeconds,
    }),
  };
}

function parsePosterOutput(value, prefix) {
  if (!hasOnlyFields(value, new Set([
    "objectKey",
    "objectVersionId",
    "sizeBytes",
    "mimeType",
  ]))) return null;
  const relativeKey = typeof value.objectKey === "string" && value.objectKey.startsWith(prefix)
    ? value.objectKey.slice(prefix.length)
    : null;
  if (
    !relativeKey ||
    !POSTER_NAME_PATTERN.test(relativeKey) ||
    typeof value.objectVersionId !== "string" ||
    !value.objectVersionId ||
    value.objectVersionId.length > 1024 ||
    !positiveInteger(value.sizeBytes) ||
    value.mimeType !== "image/jpeg"
  ) return null;
  return {
    objectKey: value.objectKey,
    objectVersionId: value.objectVersionId,
    sizeBytes: value.sizeBytes,
    mimeType: "image/jpeg",
  };
}

function parseSourceMediaRendition(value, asset) {
  if (!validSourceIdentity(asset) || !hasOnlyFields(value, new Set([
    "schemaVersion",
    "state",
    "sourceObjectKey",
    "sourceObjectVersionId",
    "sourceSizeBytes",
    "attemptId",
    "updatedAt",
    "errorCode",
    "web",
    "poster",
  ]))) return null;
  if (
    value.schemaVersion !== RENDITION_SCHEMA_VERSION ||
    !RENDITION_STATES.includes(value.state) ||
    value.sourceObjectKey !== asset.objectKey ||
    value.sourceObjectVersionId !== asset.objectVersionId ||
    value.sourceSizeBytes !== asset.sizeBytes ||
    typeof value.attemptId !== "string" ||
    !ATTEMPT_ID_PATTERN.test(value.attemptId)
  ) return null;
  const updatedAt = isoTimestamp(value.updatedAt);
  if (!updatedAt) return null;

  const prefix = sourceMediaRenditionOutputPrefix(asset, value.attemptId);
  const web = value.web === undefined ? null : parseWebOutput(value.web, prefix);
  const poster = value.poster === undefined ? null : parsePosterOutput(value.poster, prefix);
  const errorCode = value.errorCode === undefined ? null : value.errorCode;
  if (
    (value.web !== undefined && !web) ||
    (value.poster !== undefined && !poster) ||
    (errorCode !== null && (
      typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)
    )) ||
    (value.state === "ready" && (!web || !poster || errorCode !== null)) ||
    (value.state !== "ready" && (web || poster)) ||
    (value.state !== "failed" && errorCode !== null)
  ) return null;

  return {
    schemaVersion: RENDITION_SCHEMA_VERSION,
    state: value.state,
    sourceObjectKey: value.sourceObjectKey,
    sourceObjectVersionId: value.sourceObjectVersionId,
    sourceSizeBytes: value.sourceSizeBytes,
    attemptId: value.attemptId,
    updatedAt,
    ...(errorCode === null ? {} : { errorCode }),
    ...(web ? { web } : {}),
    ...(poster ? { poster } : {}),
  };
}

function sourceMediaViewingCopySummary(rendition) {
  if (!rendition) return { state: "not_prepared" };
  if (rendition.state === "ready") {
    return {
      state: "ready",
      sizeBytes: rendition.web.sizeBytes,
      ...(rendition.web.sourceFrameRateNumerator === undefined ? {} : {
        sourceFrameRateNumerator: rendition.web.sourceFrameRateNumerator,
        sourceFrameRateDenominator: rendition.web.sourceFrameRateDenominator,
      }),
      ...(rendition.web.frameRateNumerator === undefined ? {} : {
        frameRateNumerator: rendition.web.frameRateNumerator,
        frameRateDenominator: rendition.web.frameRateDenominator,
      }),
      ...(rendition.web.width === undefined ? {} : { width: rendition.web.width }),
      ...(rendition.web.height === undefined ? {} : { height: rendition.web.height }),
      ...(rendition.web.durationSeconds === undefined ? {} : {
        durationSeconds: rendition.web.durationSeconds,
      }),
    };
  }
  return {
    state: rendition.state,
    ...(rendition.errorCode === undefined ? {} : { errorCode: rendition.errorCode }),
  };
}

module.exports = {
  validSourceFrameRate,
  ATTEMPT_ID_PATTERN,
  POSTER_NAME_PATTERN,
  RENDITION_SCHEMA_VERSION,
  RENDITION_STATES,
  parseSourceMediaRendition,
  sourceMediaRenditionId,
  sourceMediaRenditionOutputPrefix,
  sourceMediaViewingCopySummary,
};

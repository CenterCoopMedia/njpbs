"use strict";

const { createHash } = require("node:crypto");
const {
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_IMAGE_PIXELS,
  MEDIA_TYPES,
  MediaValidationError,
  assertAssetId,
  normalizeOriginalName,
} = require("./media-contract");

const PHOTO_MAX_BYTES = DEFAULT_MAX_UPLOAD_BYTES;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
const RETENTION_DAYS = 90;
const UPLOAD_URL_LIFETIME_SECONDS = 15 * 60;
const UGC_STATUSES = Object.freeze(["pending", "rejected", "imported"]);
const UGC_SCOPES = Object.freeze(["broadcast", "web", "social"]);
const UGC_TYPES = Object.freeze({
  "image/jpeg": MEDIA_TYPES["image/jpeg"],
  "image/png": MEDIA_TYPES["image/png"],
  "image/webp": MEDIA_TYPES["image/webp"],
  "image/avif": MEDIA_TYPES["image/avif"],
  "video/mp4": Object.freeze({ kind: "video" }),
  "video/quicktime": Object.freeze({ kind: "video" }),
  "video/webm": Object.freeze({ kind: "video" }),
});
const CONSENT_TEXT_FIELDS = Object.freeze([
  "release", "checkbox", "age", "ageHelp", "privacy", "closed", "thanks",
]);

class UgcContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "UgcContractError";
    this.code = code;
  }
}

function requiredText(value, min, max) {
  if (typeof value !== "string") throw new UgcContractError("invalid");
  const text = value.trim();
  if (text.length < min || text.length > max) throw new UgcContractError("invalid");
  return text;
}

function normalizeFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new UgcContractError("invalid");
  }
  if (typeof file.type !== "string" || !Object.hasOwn(UGC_TYPES, file.type)) {
    throw new UgcContractError("type");
  }
  const type = UGC_TYPES[file.type];
  const maxBytes = type.kind === "video" ? VIDEO_MAX_BYTES : PHOTO_MAX_BYTES;
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    throw new UgcContractError("invalid");
  }
  if (file.size > maxBytes) throw new UgcContractError("too_large");
  let name;
  try {
    name = normalizeOriginalName(file.name);
  } catch (error) {
    if (!(error instanceof MediaValidationError)) throw error;
    throw new UgcContractError("invalid");
  }
  return { name, type: file.type, size: file.size };
}

function normalizeStartRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UgcContractError("invalid");
  }
  if (typeof value.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId) ||
      value.consentChecked !== true || value.ageAttested !== true ||
      typeof value.consentVersion !== "string" || !value.consentVersion ||
      typeof value.consentTextHash !== "string" || !/^[a-f0-9]{64}$/.test(value.consentTextHash)) {
    throw new UgcContractError("invalid");
  }
  const name = requiredText(value.name, 1, 300);
  const email = requiredText(value.email, 3, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UgcContractError("invalid");
  const message = requiredText(value.message, 10, 2000);
  return {
    requestId: value.requestId.toLowerCase(), name, email, message,
    consentVersion: value.consentVersion,
    consentTextHash: value.consentTextHash,
    file: normalizeFile(value.file),
  };
}

function quarantineObjectKey(submissionId, objectId) {
  try {
    assertAssetId(submissionId);
    assertAssetId(objectId);
  } catch (error) {
    if (!(error instanceof MediaValidationError)) throw error;
    throw new UgcContractError("invalid");
  }
  return `ugc-quarantine/${submissionId}/${objectId}`;
}

function consentTextHash(release) {
  return createHash("sha256").update(release, "utf8").digest("hex");
}

function readConsentConfig(data) {
  const texts = data?.texts;
  const approved = typeof data?.consentVersion === "string" &&
    data.consentVersion.trim().length > 0 &&
    typeof data?.approvedBy === "string" && data.approvedBy.trim().length > 0 &&
    Boolean(data?.approvedAt) &&
    texts && typeof texts === "object" &&
    CONSENT_TEXT_FIELDS.every((field) =>
      typeof texts[field] === "string" && texts[field].trim().length > 0);
  if (!approved) {
    return {
      open: false,
      consentVersion: null,
      consentTextHash: null,
      texts: Object.fromEntries(CONSENT_TEXT_FIELDS.map((field) => [field, ""])),
    };
  }
  return {
    open: true,
    consentVersion: data.consentVersion,
    consentTextHash: consentTextHash(texts.release),
    texts: Object.fromEntries(CONSENT_TEXT_FIELDS.map((field) => [field, texts[field]])),
  };
}

module.exports = {
  CONSENT_TEXT_FIELDS,
  MAX_IMAGE_PIXELS,
  PHOTO_MAX_BYTES,
  RETENTION_DAYS,
  UGC_SCOPES,
  UGC_STATUSES,
  UGC_TYPES,
  UPLOAD_URL_LIFETIME_SECONDS,
  VIDEO_MAX_BYTES,
  UgcContractError,
  consentTextHash,
  normalizeFile,
  normalizeStartRequest,
  quarantineObjectKey,
  readConsentConfig,
};

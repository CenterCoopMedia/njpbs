"use strict";

const { ALL_CAPABILITIES, hasCapability } = require("./rbac");

const VOICEOVER_SCHEMA_VERSION = 1;
const SUPPORTED_MANIFEST_VERSION = 1;
const LIBRARY_DOCUMENT = "voiceoverLibrary/current";
const TAKES_COLLECTION = "voiceoverTakes";
const REVIEWS_COLLECTION = "voiceoverReviews";
const MAX_TAKES = 500;
const MAX_NOTES_CHARACTERS = 2_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

class VoiceoverError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "VoiceoverError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validId(value) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]{0,149}$/.test(value);
}

function validAssetId(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function validText(value, maximumLength, { empty = false } = {}) {
  return typeof value === "string" &&
    value.length <= maximumLength &&
    (empty || value.trim().length > 0);
}

function normalizeNotes(value) {
  if (typeof value !== "string") {
    throw new VoiceoverError(400, "Notes must be text.");
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.from(normalized).length > MAX_NOTES_CHARACTERS) {
    throw new VoiceoverError(
      400,
      `Notes must be ${MAX_NOTES_CHARACTERS.toLocaleString("en-US")} characters or fewer.`,
    );
  }
  return normalized;
}

function parseReviewRequest(body) {
  if (!isPlainObject(body) ||
      !["list", "save", "get-media", "save-media"].includes(body.action)) {
    throw new VoiceoverError(400, "Choose a voiceover review action.");
  }
  if (body.schemaVersion !== VOICEOVER_SCHEMA_VERSION) {
    throw new VoiceoverError(409, "This voiceover review version is not supported.");
  }
  if (body.action === "list") {
    if (!hasExactKeys(body, ["action", "schemaVersion"])) {
      throw new VoiceoverError(400, "The voiceover list request is invalid.");
    }
    return { action: "list", schemaVersion: VOICEOVER_SCHEMA_VERSION };
  }

  if (body.action === "get-media") {
    if (!hasExactKeys(body, ["action", "schemaVersion", "assetId"]) ||
        !validAssetId(body.assetId)) {
      throw new VoiceoverError(400, "The voiceover media review request is invalid.");
    }
    return {
      action: "get-media",
      schemaVersion: VOICEOVER_SCHEMA_VERSION,
      assetId: body.assetId,
    };
  }

  if (body.action === "save-media") {
    const keys = [
      "action",
      "schemaVersion",
      "assetId",
      "baseVersion",
      "moreLikeThis",
      "notes",
    ];
    if (!hasExactKeys(body, keys) || !validAssetId(body.assetId)) {
      throw new VoiceoverError(400, "The voiceover media review request is invalid.");
    }
    if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0) {
      throw new VoiceoverError(400, "Reload the voiceover review before saving.");
    }
    if (typeof body.moreLikeThis !== "boolean") {
      throw new VoiceoverError(400, "Voiceover review choices must be true or false.");
    }
    return {
      action: "save-media",
      schemaVersion: VOICEOVER_SCHEMA_VERSION,
      assetId: body.assetId,
      baseVersion: body.baseVersion,
      moreLikeThis: body.moreLikeThis,
      notes: normalizeNotes(body.notes),
    };
  }

  const keys = [
    "action",
    "schemaVersion",
    "manifestVersion",
    "takeId",
    "baseVersion",
    "favorite",
    "moreLikeThis",
    "notes",
  ];
  if (!hasExactKeys(body, keys)) {
    throw new VoiceoverError(400, "The voiceover review request is invalid.");
  }
  if (body.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    throw new VoiceoverError(409, "Reload the voiceover library before saving.");
  }
  if (!validId(body.takeId)) {
    throw new VoiceoverError(400, "Choose a valid voiceover take.");
  }
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0) {
    throw new VoiceoverError(400, "Reload the voiceover review before saving.");
  }
  if (typeof body.favorite !== "boolean" || typeof body.moreLikeThis !== "boolean") {
    throw new VoiceoverError(400, "Voiceover review choices must be true or false.");
  }
  return {
    action: "save",
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    takeId: body.takeId,
    baseVersion: body.baseVersion,
    favorite: body.favorite,
    moreLikeThis: body.moreLikeThis,
    notes: normalizeNotes(body.notes),
  };
}

function parseAudioRequest(body) {
  const assetRequest = hasExactKeys(body, ["schemaVersion", "assetId"]);
  const takeRequest = hasExactKeys(body, ["schemaVersion", "takeId"]);
  if (!assetRequest && !takeRequest) {
    throw new VoiceoverError(400, "The voiceover audio request is invalid.");
  }
  if (body.schemaVersion !== VOICEOVER_SCHEMA_VERSION) {
    throw new VoiceoverError(409, "This voiceover audio version is not supported.");
  }
  if (assetRequest) {
    if (!validAssetId(body.assetId)) {
      throw new VoiceoverError(400, "Choose a valid media asset.");
    }
    return { schemaVersion: VOICEOVER_SCHEMA_VERSION, assetId: body.assetId };
  }
  if (!hasExactKeys(body, ["schemaVersion", "takeId"])) {
    throw new VoiceoverError(400, "The voiceover audio request is invalid.");
  }
  if (!validId(body.takeId)) {
    throw new VoiceoverError(400, "Choose a valid voiceover take.");
  }
  return { schemaVersion: VOICEOVER_SCHEMA_VERSION, takeId: body.takeId };
}

function requireAdmittedStaff(user) {
  const admitted = user?.emailVerified === true &&
    ALL_CAPABILITIES.some((capability) =>
      hasCapability(user?.principal, capability));
  if (!admitted) {
    throw new VoiceoverError(403, "CMS access required.");
  }
}

function performerProjection(value) {
  if (!isPlainObject(value)) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 100) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  const performers = {};
  for (const [id, performer] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!validId(id) || !isPlainObject(performer) ||
        !hasExactKeys(performer, ["name"]) ||
        !validText(performer.name, 120)) {
      throw new VoiceoverError(503, "The voiceover library is unavailable.");
    }
    performers[id] = { name: performer.name.trim() };
  }
  return performers;
}

function libraryProjection(value) {
  if (!isPlainObject(value) ||
      value.schemaVersion !== VOICEOVER_SCHEMA_VERSION ||
      value.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
      value.status !== "review-ready" ||
      !Number.isSafeInteger(value.takeCount) ||
      value.takeCount < 1 || value.takeCount > MAX_TAKES) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  return {
    manifestVersion: value.manifestVersion,
    performers: performerProjection(value.performers),
    takeCount: value.takeCount,
  };
}

function takeProjection(id, value, manifestVersion) {
  const validFlags = Array.isArray(value?.flags) && value.flags.length <= 20 &&
    value.flags.every((flag) => validText(flag, 80));
  if (!validId(id) || !isPlainObject(value) || value.id !== id ||
      value.schemaVersion !== VOICEOVER_SCHEMA_VERSION ||
      value.manifestVersion !== manifestVersion || value.active !== true ||
      !validId(value.family_id) || !validText(value.family, 200) ||
      !Number.isSafeInteger(value.take) || value.take < 1 || value.take > 999 ||
      !validId(value.style) || !validId(value.performer_id) ||
      !validText(value.text, 1_000) || !validText(value.display_text, 1_000) ||
      typeof value.complete !== "boolean" || !validFlags) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  if (value.insert_note !== undefined && !validText(value.insert_note, 500, { empty: true })) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  if (value.duration_seconds !== undefined &&
      (!Number.isFinite(value.duration_seconds) || value.duration_seconds <= 0 ||
       value.duration_seconds > 3_600)) {
    throw new VoiceoverError(503, "The voiceover library is unavailable.");
  }
  return {
    id,
    family_id: value.family_id,
    family: value.family,
    take: value.take,
    style: value.style,
    performer_id: value.performer_id,
    text: value.text,
    display_text: value.display_text,
    complete: value.complete,
    flags: [...value.flags],
    ...(value.insert_note ? { insert_note: value.insert_note } : {}),
    ...(value.duration_seconds !== undefined
      ? { duration_seconds: value.duration_seconds }
      : {}),
  };
}

function reviewProjection(takeId, value, manifestVersion) {
  if (!validId(takeId) || !isPlainObject(value) || value.takeId !== takeId ||
      value.schemaVersion !== VOICEOVER_SCHEMA_VERSION ||
      value.manifestVersion !== manifestVersion ||
      typeof value.favorite !== "boolean" ||
      typeof value.moreLikeThis !== "boolean" ||
      typeof value.notes !== "string" ||
      Array.from(value.notes).length > MAX_NOTES_CHARACTERS ||
      !Number.isSafeInteger(value.version) || value.version < 1 ||
      !validText(value.updatedAt, 40) || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new VoiceoverError(503, "Voiceover reviews are unavailable.");
  }
  return {
    favorite: value.favorite,
    moreLikeThis: value.moreLikeThis,
    notes: value.notes,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

module.exports = {
  LIBRARY_DOCUMENT,
  MAX_AUDIO_BYTES,
  MAX_NOTES_CHARACTERS,
  MAX_TAKES,
  REVIEWS_COLLECTION,
  SUPPORTED_MANIFEST_VERSION,
  TAKES_COLLECTION,
  VOICEOVER_SCHEMA_VERSION,
  VoiceoverError,
  hasExactKeys,
  isPlainObject,
  libraryProjection,
  normalizeNotes,
  parseAudioRequest,
  parseReviewRequest,
  performerProjection,
  requireAdmittedStaff,
  reviewProjection,
  takeProjection,
  validAssetId,
  validId,
};

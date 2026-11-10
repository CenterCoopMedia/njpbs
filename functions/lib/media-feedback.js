"use strict";

const { createHash } = require("node:crypto");
const {
  MediaAssetRefValidationError,
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
  storedMediaAssetRef,
} = require("./media-asset-ref");
const { sourceMediaFileVersion } = require("./source-media-contract");

const MEDIA_FEEDBACK_SCHEMA_VERSION = 1;
const MEDIA_REVIEWS_COLLECTION = "mediaReviews";
const MEDIA_COMMENTS_COLLECTION = "mediaComments";
const ITEMS_COLLECTION = "items";
const REQUESTS_COLLECTION = "requests";
const MAX_FEEDBACK_TEXT_CHARACTERS = 2_000;
const MAX_COMMENT_PAGE_SIZE = 30;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{64}$/;
// Bounds for a timed comment: 24 hours at the 240 fps rendition ceiling.
const MAX_COMMENT_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT_FRAME = 24 * 60 * 60 * 240;
const COMMENT_TIME_CHANGED_CODE = "media_comment_time_changed";
const COMMENT_HAS_REPLIES_CODE = "media_comment_has_replies";
// A comment can name up to ten staff members. Only their account IDs are stored.
const MAX_COMMENT_MENTIONS = 10;
const STAFF_UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COMMENT_ACTIONS = ["create", "edit", "delete", "resolve", "reopen"];

class MediaFeedbackValidationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "MediaFeedbackValidationError";
    this.status = status;
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownFields(value, allowed, label = "Request") {
  if (!plainObject(value)) {
    throw new MediaFeedbackValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new MediaFeedbackValidationError(
      `Unknown ${label.toLowerCase()} field ${unknown}`,
    );
  }
}

function feedbackValidation(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof MediaAssetRefValidationError) {
      throw new MediaFeedbackValidationError(error.message, error.status);
    }
    throw error;
  }
}

function parseFeedbackRef(value) {
  return feedbackValidation(() => parseMediaAssetRef(value));
}

function requireSchemaVersion(value) {
  if (value !== MEDIA_FEEDBACK_SCHEMA_VERSION) {
    throw new MediaFeedbackValidationError(
      "This media feedback version is not supported",
      409,
    );
  }
}

function normalizeText(value, label, { empty = true } = {}) {
  if (typeof value !== "string") {
    throw new MediaFeedbackValidationError(`${label} must be text`);
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.from(normalized).length > MAX_FEEDBACK_TEXT_CHARACTERS) {
    throw new MediaFeedbackValidationError(
      `${label} must be ${MAX_FEEDBACK_TEXT_CHARACTERS.toLocaleString("en-US")} characters or fewer`,
    );
  }
  if (!empty && normalized.trim().length === 0) {
    throw new MediaFeedbackValidationError(`${label} must not be empty`);
  }
  return normalized;
}

function parseGetMediaReviewRequest(value) {
  rejectUnknownFields(value, new Set(["schemaVersion", "ref"]));
  requireSchemaVersion(value.schemaVersion);
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref: parseFeedbackRef(value.ref),
  };
}

function parseSaveMediaReviewRequest(value) {
  rejectUnknownFields(
    value,
    new Set(["schemaVersion", "ref", "baseVersion", "moreLikeThis", "notes"]),
  );
  requireSchemaVersion(value.schemaVersion);
  if (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0) {
    throw new MediaFeedbackValidationError(
      "Reload the media review before saving",
    );
  }
  if (typeof value.moreLikeThis !== "boolean") {
    throw new MediaFeedbackValidationError("More like this must be true or false");
  }
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref: parseFeedbackRef(value.ref),
    baseVersion: value.baseVersion,
    moreLikeThis: value.moreLikeThis,
    notes: normalizeText(value.notes, "Notes"),
  };
}

function decodeCommentCursor(value, ref) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new MediaFeedbackValidationError("Cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !plainObject(decoded) ||
      decoded.v !== 1 ||
      decoded.ref !== canonicalMediaAssetRef(ref) ||
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
    throw new MediaFeedbackValidationError("Cursor is invalid");
  }
}

function encodeCommentCursor(ref, document) {
  const createdAt = document.data()?.createdAt;
  if (
    !Number.isSafeInteger(createdAt?.seconds) ||
    !Number.isSafeInteger(createdAt?.nanoseconds)
  ) {
    throw new Error(`Media comment ${document.id} has no valid createdAt`);
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    ref: canonicalMediaAssetRef(ref),
    seconds: createdAt.seconds,
    nanoseconds: createdAt.nanoseconds,
    id: document.id,
  }), "utf8").toString("base64url");
}

function parseListMediaCommentsRequest(value) {
  rejectUnknownFields(value, new Set(["schemaVersion", "ref", "cursor", "limit", "staff", "export"]));
  requireSchemaVersion(value.schemaVersion);
  const ref = parseFeedbackRef(value.ref);
  if (value.export !== undefined) {
    if (!["open", "resolved", "mine", "mentions", "all"].includes(value.export) ||
        value.cursor !== undefined || value.limit !== undefined || value.staff !== undefined) {
      throw new MediaFeedbackValidationError("A comment export needs a valid filter and no paging or staff fields");
    }
    return { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ref, export: value.export };
  }
  // `staff: true` asks for the staff that can be mentioned on this item instead of a page.
  if (value.staff !== undefined) {
    if (value.staff !== true || value.cursor !== undefined || value.limit !== undefined) {
      throw new MediaFeedbackValidationError("A staff list request takes only the item reference");
    }
    return { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ref, staff: true };
  }
  const limit = value.limit === undefined ? MAX_COMMENT_PAGE_SIZE : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMMENT_PAGE_SIZE) {
    throw new MediaFeedbackValidationError(
      `Limit must be a whole number from 1 through ${MAX_COMMENT_PAGE_SIZE}`,
    );
  }
  return {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref,
    limit,
    cursor: value.cursor === undefined ? null : decodeCommentCursor(value.cursor, ref),
  };
}

// Videos with a frame rate send whole frames; videos without one send milliseconds.
// A single point has no end. A range end is the last frame (or millisecond) and follows the start.
function parseCommentTime(value) {
  if (value === undefined) return null;
  if (!plainObject(value)) throw new MediaFeedbackValidationError("Comment time is invalid");
  const frames = Object.hasOwn(value, "startFrame");
  const [startField, endField, max] = frames
    ? ["startFrame", "endFrame", MAX_COMMENT_FRAME]
    : ["startMs", "endMs", MAX_COMMENT_MS];
  rejectUnknownFields(value, new Set([startField, endField, "fileVersion"]), "Comment time");
  const start = value[startField];
  const end = value[endField] ?? null;
  if (
    !Number.isSafeInteger(start) || start < 0 || start > max ||
    (end !== null && (!Number.isSafeInteger(end) || end <= start || end > max)) ||
    typeof value.fileVersion !== "string" || !/^[0-9a-f]{32}$/.test(value.fileVersion)
  ) {
    throw new MediaFeedbackValidationError("Comment time is invalid");
  }
  return { [startField]: start, [endField]: end, fileVersion: value.fileVersion };
}

// Mentions are account IDs. A repeated ID is refused, not merged, so nothing is dropped silently.
function parseMentions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_COMMENT_MENTIONS ||
      !value.every((uid) => typeof uid === "string" && STAFF_UID_PATTERN.test(uid))) {
    throw new MediaFeedbackValidationError(
      `Mentions must be a list of up to ${MAX_COMMENT_MENTIONS} staff accounts`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new MediaFeedbackValidationError("A staff member is mentioned more than once");
  }
  return [...value];
}

function parseMutateMediaCommentRequest(value) {
  rejectUnknownFields(
    value,
    new Set([
      "schemaVersion",
      "ref",
      "action",
      "requestId",
      "commentId",
      "baseVersion",
      "text",
      "time",
      "parentId",
      "mentions",
    ]),
  );
  requireSchemaVersion(value.schemaVersion);
  if (!COMMENT_ACTIONS.includes(value.action)) {
    throw new MediaFeedbackValidationError("Comment action is invalid");
  }
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new MediaFeedbackValidationError("Request id is invalid");
  }
  const request = {
    schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION,
    ref: parseFeedbackRef(value.ref),
    action: value.action,
    requestId: value.requestId,
  };
  if (value.action === "create") {
    if (value.commentId !== undefined || value.baseVersion !== undefined) {
      throw new MediaFeedbackValidationError(
        "A new comment cannot include a comment id or base version",
      );
    }
    const parentId = value.parentId ?? null;
    if (parentId !== null &&
        (typeof parentId !== "string" || !DOCUMENT_ID_PATTERN.test(parentId))) {
      throw new MediaFeedbackValidationError("Reply target is invalid");
    }
    // A reply uses the time of the first comment in its thread; it has no time of its own.
    if (parentId !== null && value.time !== undefined) {
      throw new MediaFeedbackValidationError("A reply cannot have its own time");
    }
    return {
      ...request,
      text: normalizeText(value.text, "Comment", { empty: false }),
      time: parseCommentTime(value.time),
      parentId,
      mentions: parseMentions(value.mentions),
    };
  }
  if (value.time !== undefined) {
    throw new MediaFeedbackValidationError("A comment time cannot change after it is added");
  }
  if (value.parentId !== undefined) {
    throw new MediaFeedbackValidationError("A comment cannot move to another thread");
  }
  if (typeof value.commentId !== "string" || !DOCUMENT_ID_PATTERN.test(value.commentId)) {
    throw new MediaFeedbackValidationError("Comment id is invalid");
  }
  if (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 1) {
    throw new MediaFeedbackValidationError(
      "Reload the media comment before changing it",
    );
  }
  if (value.action !== "edit") {
    if (value.text !== undefined || value.mentions !== undefined) {
      throw new MediaFeedbackValidationError(
        value.action === "delete"
          ? "A deleted comment cannot include text"
          : "Resolving or reopening a thread cannot change its text",
      );
    }
    return {
      ...request,
      commentId: value.commentId,
      baseVersion: value.baseVersion,
    };
  }
  // An edit without `mentions` keeps the stored mentions.
  return {
    ...request,
    commentId: value.commentId,
    baseVersion: value.baseVersion,
    text: normalizeText(value.text, "Comment", { empty: false }),
    mentions: value.mentions === undefined ? null : parseMentions(value.mentions),
  };
}

function timestampIso(value) {
  const date = value?.toDate?.();
  if (date instanceof Date && Number.isFinite(date.getTime())) {
    return date.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function reviewProjection(value) {
  if (
    !plainObject(value) ||
    value.schemaVersion !== MEDIA_FEEDBACK_SCHEMA_VERSION ||
    typeof value.moreLikeThis !== "boolean" ||
    typeof value.notes !== "string" ||
    Array.from(value.notes).length > MAX_FEEDBACK_TEXT_CHARACTERS ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !timestampIso(value.updatedAt)
  ) {
    throw new Error("Stored media review is invalid");
  }
  return {
    moreLikeThis: value.moreLikeThis,
    notes: value.notes,
    version: value.version,
    updatedAt: timestampIso(value.updatedAt),
  };
}

function storedMediaReview(ref, value) {
  const storedRef = storedMediaAssetRef(value);
  if (
    !storedRef ||
    canonicalMediaAssetRef(storedRef) !== canonicalMediaAssetRef(ref) ||
    !timestampIso(value.createdAt)
  ) {
    throw new Error("Stored media review identity is invalid");
  }
  return reviewProjection(value);
}

function validAuthorName(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 120 &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
}

function frameStartMs(frame, rateNum, rateDen) {
  return Math.floor((frame * rateDen * 1000) / rateNum);
}

/**
 * Frames count only when the web copy's measured rate equals the original's. A variable-rate
 * original can give a web copy with another rate; those comments use milliseconds.
 */
function commentFrameRate(web) {
  const n = web?.frameRateNumerator;
  const d = web?.frameRateDenominator;
  const sourceN = web?.sourceFrameRateNumerator;
  const sourceD = web?.sourceFrameRateDenominator;
  if (![n, d, sourceN, sourceD].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return n * sourceD === d * sourceN ? [n, d] : null;
}

// The server takes the frame rate and file version from the asset record, never from the
// request, so a comment always records the version and rate it was made against.
function timedCommentFields(asset, time) {
  if (!time) return {};
  if (!asset) {
    throw new MediaFeedbackValidationError("Timed comments are available only on videos");
  }
  // The time was picked on the file the reviewer opened; a replaced file has other frames.
  if (time.fileVersion !== sourceMediaFileVersion(asset.objectVersionId)) {
    throw new MediaFeedbackValidationError(
      "This video was replaced after you opened it. Reload the video and set the time again",
      409,
      COMMENT_TIME_CHANGED_CODE,
    );
  }
  const web = asset.rendition?.state === "ready" ? asset.rendition.web : null;
  const [rateNum, rateDen] = commentFrameRate(web) ?? [null, null];
  const frames = Object.hasOwn(time, "startFrame");
  if (frames !== (rateNum !== null)) {
    throw new MediaFeedbackValidationError(
      "The frame rate of this video changed. Reload the video and try again",
      409,
      COMMENT_TIME_CHANGED_CODE,
    );
  }
  const startMs = frames ? frameStartMs(time.startFrame, rateNum, rateDen) : time.startMs;
  // A frame range ends where its last frame ends.
  const endMs = frames
    ? time.endFrame === null ? null : frameStartMs(time.endFrame + 1, rateNum, rateDen)
    : time.endMs;
  // Bounds come from the measured web copy; without its duration a time cannot be checked.
  if (typeof web?.durationSeconds !== "number") {
    throw new MediaFeedbackValidationError("Comment times are available when the web copy of this video is ready");
  }
  const durationMs = Math.ceil(web.durationSeconds * 1000);
  // The last frame of a range must start before the end of the video.
  const lastStartMs = frames && time.endFrame !== null ? frameStartMs(time.endFrame, rateNum, rateDen) : null;
  if (startMs >= durationMs || (lastStartMs !== null && lastStartMs >= durationMs) ||
      (!frames && endMs !== null && endMs > durationMs)) {
    throw new MediaFeedbackValidationError("Comment time is past the end of this video");
  }
  return {
    sourceVersion: asset.objectVersionId,
    startFrame: frames ? time.startFrame : null,
    endFrame: frames ? time.endFrame : null,
    rateNum,
    rateDen,
    startMs,
    endMs,
  };
}

function nullableInteger(value, min = 0) {
  return value === null || (Number.isSafeInteger(value) && value >= min);
}

function storedCommentTime(id, value) {
  if (value.startMs === undefined) return null;
  const framed = value.rateNum !== null;
  if (
    typeof value.sourceVersion !== "string" ||
    !value.sourceVersion ||
    value.sourceVersion.length > 1024 ||
    !Number.isSafeInteger(value.startMs) || value.startMs < 0 ||
    !nullableInteger(value.endMs, value.startMs + 1) ||
    !nullableInteger(value.rateNum, 1) ||
    !nullableInteger(value.rateDen, 1) ||
    (value.rateDen === null) === framed ||
    !nullableInteger(value.startFrame) ||
    (value.startFrame === null) === framed ||
    !nullableInteger(value.endFrame, (value.startFrame ?? 0) + 1) ||
    (!framed && value.endFrame !== null)
  ) {
    throw new Error(`Stored media comment ${id} time is invalid`);
  }
  return {
    sourceVersion: value.sourceVersion,
    startFrame: value.startFrame,
    endFrame: value.endFrame,
    rateNum: value.rateNum,
    rateDen: value.rateDen,
    startMs: value.startMs,
    endMs: value.endMs,
  };
}

function storedThreadFields(id, value) {
  const parentId = value.parentId ?? null;
  const mentions = value.mentions ?? [];
  const resolvedAt = value.resolvedAt ?? null;
  const resolvedBy = value.resolvedBy ?? null;
  const replyCount = value.replyCount ?? 0;
  if (
    (parentId !== null && (typeof parentId !== "string" || !DOCUMENT_ID_PATTERN.test(parentId))) ||
    !Array.isArray(mentions) ||
    mentions.length > MAX_COMMENT_MENTIONS ||
    !mentions.every((uid) => typeof uid === "string" && STAFF_UID_PATTERN.test(uid)) ||
    new Set(mentions).size !== mentions.length ||
    (resolvedAt === null) !== (resolvedBy === null) ||
    (resolvedAt !== null && !timestampIso(resolvedAt)) ||
    (resolvedBy !== null && (typeof resolvedBy !== "string" || !STAFF_UID_PATTERN.test(resolvedBy))) ||
    !Number.isSafeInteger(replyCount) || replyCount < 0 ||
    // A reply has no time, no replies, and no resolve state of its own.
    (parentId !== null && (value.startMs !== undefined || resolvedAt !== null || replyCount !== 0))
  ) {
    throw new Error(`Stored media comment ${id} thread fields are invalid`);
  }
  return { parentId, mentions: [...mentions], resolvedAt, resolvedBy, replyCount };
}

function storedMediaComment(id, ref, value) {
  const storedRef = storedMediaAssetRef(value);
  if (
    !DOCUMENT_ID_PATTERN.test(id) ||
    value.schemaVersion !== MEDIA_FEEDBACK_SCHEMA_VERSION ||
    !storedRef ||
    canonicalMediaAssetRef(storedRef) !== canonicalMediaAssetRef(ref) ||
    typeof value.authorUid !== "string" ||
    value.authorUid.length < 1 ||
    value.authorUid.length > 128 ||
    !validAuthorName(value.authorName) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    Array.from(value.text).length > MAX_FEEDBACK_TEXT_CHARACTERS ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.createFingerprint !== "string" ||
    !DOCUMENT_ID_PATTERN.test(value.createFingerprint) ||
    !timestampIso(value.createdAt) ||
    !timestampIso(value.updatedAt)
  ) {
    throw new Error(`Stored media comment ${id} is invalid`);
  }
  return {
    ref: storedRef,
    canonicalRef: canonicalMediaAssetRef(storedRef),
    authorUid: value.authorUid,
    authorName: value.authorName.trim(),
    text: value.text,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    createFingerprint: value.createFingerprint,
    time: storedCommentTime(id, value),
    ...storedThreadFields(id, value),
  };
}

const FORMER_STAFF_NAME = "Former staff member";

// `currentSourceVersion` is the current file version of the asset. Clients learn only whether
// a comment was made on that version, not the storage version ID. `names` maps account IDs to
// the names of active staff, read at request time; `moderates` says whether the reader uploaded
// the item or manages its media. The reply count stays private.
function commentProjection(
  id,
  comment,
  actorUid,
  currentSourceVersion = null,
  { names = new Map(), moderates = false } = {},
) {
  const { sourceVersion, ...time } = comment.time ?? {};
  const parentId = comment.parentId ?? null;
  const mentions = comment.mentions ?? [];
  const resolvedBy = comment.resolvedBy ?? null;
  const person = (uid) => ({ uid, name: names.get(uid) ?? FORMER_STAFF_NAME });
  return {
    id,
    authorUid: comment.authorUid,
    authorName: comment.authorName,
    text: comment.text,
    version: comment.version,
    createdAt: timestampIso(comment.createdAt),
    updatedAt: timestampIso(comment.updatedAt),
    canEdit: comment.authorUid === actorUid,
    parentId,
    mentions: mentions.map(person),
    mentionsYou: mentions.includes(actorUid),
    resolvedAt: comment.resolvedAt ? timestampIso(comment.resolvedAt) : null,
    resolvedBy: resolvedBy === null ? null : person(resolvedBy),
    canResolve: parentId === null && (comment.authorUid === actorUid || moderates),
    // The count stays private. A reader learns only whether any reply exists, so the client
    // does not offer Delete when replies sit on a page it has not loaded.
    hasReplies: parentId === null && (comment.replyCount ?? 0) > 0,
    ...(comment.time
      ? { time: { ...time, currentVersion: sourceVersion === currentSourceVersion } }
      : {}),
  };
}

function mediaReviewItems(firestore, uid) {
  return firestore
    .collection(MEDIA_REVIEWS_COLLECTION)
    .doc(uid)
    .collection(ITEMS_COLLECTION);
}

function mediaComments(firestore, ref) {
  return firestore
    .collection(MEDIA_COMMENTS_COLLECTION)
    .doc(mediaAssetRefDocumentId(ref))
    .collection(ITEMS_COLLECTION);
}

function mediaCommentRequests(firestore, ref) {
  return firestore
    .collection(MEDIA_COMMENTS_COLLECTION)
    .doc(mediaAssetRefDocumentId(ref))
    .collection(REQUESTS_COLLECTION);
}

function mediaCommentDocumentId(uid, requestId) {
  return createHash("sha256")
    .update(`${uid}\0${requestId}`, "utf8")
    .digest("hex");
}

// Optional parts join the fingerprint only when present, so a plain comment keeps the same
// fingerprint it had before replies and mentions existed.
function commentCreateFingerprint(ref, text, time = null, parentId = null, mentions = []) {
  return createHash("sha256")
    .update(JSON.stringify({
      ref: canonicalMediaAssetRef(ref),
      text,
      ...(time ? { time } : {}),
      ...(parentId ? { parentId } : {}),
      ...(mentions.length ? { mentions } : {}),
    }), "utf8")
    .digest("hex");
}

module.exports = {
  COMMENT_ACTIONS,
  COMMENT_HAS_REPLIES_CODE,
  COMMENT_TIME_CHANGED_CODE,
  FORMER_STAFF_NAME,
  MAX_COMMENT_MENTIONS,
  STAFF_UID_PATTERN,
  DOCUMENT_ID_PATTERN,
  ITEMS_COLLECTION,
  MAX_COMMENT_PAGE_SIZE,
  MAX_FEEDBACK_TEXT_CHARACTERS,
  MEDIA_COMMENTS_COLLECTION,
  MEDIA_FEEDBACK_SCHEMA_VERSION,
  MEDIA_REVIEWS_COLLECTION,
  REQUESTS_COLLECTION,
  MediaFeedbackValidationError,
  commentCreateFingerprint,
  commentProjection,
  decodeCommentCursor,
  encodeCommentCursor,
  mediaCommentDocumentId,
  mediaCommentRequests,
  mediaComments,
  mediaReviewItems,
  normalizeText,
  parseGetMediaReviewRequest,
  parseListMediaCommentsRequest,
  parseMutateMediaCommentRequest,
  parseSaveMediaReviewRequest,
  reviewProjection,
  storedMediaComment,
  storedMediaReview,
  timedCommentFields,
  timestampIso,
  validAuthorName,
};

"use strict";

const { createHash } = require("node:crypto");
const { ID_PATTERN, SourceMediaValidationError } = require("./source-media-contract");

const MAX_LOCAL_ID_LENGTH = 128;
const MAX_OPAQUE_STRING_LENGTH = 1024;
const CONTENT_ID_LENGTH = 64;
const CONTENT_ID_PATTERN = new RegExp(`^[a-f0-9]{${CONTENT_ID_LENGTH}}$`);
const IMPORT_FIELDS = ["workspaceId", "importKind", "storyId", "mappingVersion"];
const VIDEO_FIELDS = ["kind", "sourceId", "assetId", "expectedVersion", "fileVersion", "expectedUpdateTime"];
const SELECTION_FIELDS = {
  video: VIDEO_FIELDS,
  clip: [...VIDEO_FIELDS, "clipId", "expectedClipOutput", "expectedJobUpdateTime"],
  transcript: [...VIDEO_FIELDS, "transcriptId", "expectedEditRevision", "expectedJobUpdateTime"],
  image: ["kind", "assetId", "expectedVersion", "expectedUpdateTime"],
  post: ["kind", "recordId", "expectedVersion", "expectedUpdateTime"],
  "around-nj": ["kind", "recordId", "expectedUpdateTime"],
};
const SAFE_ERROR_CODES = Object.freeze([
  "invalid_request", "invalid_transition", "not_authorized", "not_configured", "selection_changed",
  "output_unavailable", "description_too_long", "transient_failure", "remote_conflict", "outcome_unknown",
]);

const TRANSITIONS = {
  queued: { start: "transferring", confirmed_failure: "failed", confirmed_conflict: "conflict" },
  transferring: { confirmed_complete: "complete", confirmed_failure: "failed",
    confirmed_conflict: "conflict", outcome_unknown: "reconciliation" },
  complete: {},
  conflict: {},
  failed: { retry: "queued" },
  reconciliation: { confirmed_complete: "complete", confirmed_failure: "failed", confirmed_conflict: "conflict" },
};

function problem(code, status, message) {
  const error = new SourceMediaValidationError(message, status);
  error.code = code;
  return error;
}

function invalidRequest() {
  return problem("invalid_request", 400, "Transfer request is invalid");
}

function onlyFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !fields.includes(key))) {
    throw invalidRequest();
  }
}

function id(value, pattern = ID_PATTERN) {
  if (typeof value !== "string" || value.trim() !== value || !pattern.test(value)) throw invalidRequest();
  return value;
}

function opaque(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_OPAQUE_STRING_LENGTH ||
      !value.isWellFormed() || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function integer(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalidRequest();
  return value;
}

function parseClipOutput(value) {
  onlyFields(value, ["attemptId", "objectKey", "objectVersionId", "sizeBytes"]);
  return {
    attemptId: id(value.attemptId),
    objectKey: opaque(value.objectKey),
    objectVersionId: opaque(value.objectVersionId),
    sizeBytes: integer(value.sizeBytes),
  };
}

function parseSelection(value) {
  if (!value || !Object.hasOwn(SELECTION_FIELDS, value.kind)) throw invalidRequest();
  onlyFields(value, SELECTION_FIELDS[value.kind]);
  const result = { kind: value.kind, expectedUpdateTime: opaque(value.expectedUpdateTime) };
  if (["video", "clip", "transcript", "image"].includes(value.kind)) result.assetId = id(value.assetId);
  if (value.kind === "post" || value.kind === "around-nj") {
    result.recordId = id(value.recordId, value.kind === "around-nj" ? CONTENT_ID_PATTERN : ID_PATTERN);
  }
  if (value.kind !== "around-nj") result.expectedVersion = integer(value.expectedVersion);
  if (["video", "clip", "transcript"].includes(value.kind)) {
    if (value.sourceId !== "video-library") throw invalidRequest();
    result.sourceId = value.sourceId;
    result.fileVersion = opaque(value.fileVersion);
  }
  if (value.kind === "clip") {
    result.clipId = id(value.clipId, CONTENT_ID_PATTERN);
    result.expectedClipOutput = parseClipOutput(value.expectedClipOutput);
  }
  if (value.kind === "transcript") {
    result.transcriptId = id(value.transcriptId, CONTENT_ID_PATTERN);
    result.expectedEditRevision = integer(value.expectedEditRevision, 0);
  }
  if (value.kind === "clip" || value.kind === "transcript") {
    result.expectedJobUpdateTime = opaque(value.expectedJobUpdateTime);
  }
  return result;
}

function parseExportRequest(value) {
  onlyFields(value, ["workspaceId", "selection", "target", "mappingVersion"]);
  const selection = parseSelection(value.selection);
  const target = value.target;
  if (!target || !["story-asset", "new-story", "dossier"].includes(target.kind)) throw invalidRequest();
  onlyFields(target, target.kind === "new-story" ? ["kind"] : ["kind", "storyId"]);
  const supported = { video: ["story-asset", "new-story"], clip: ["story-asset", "new-story"], image: ["story-asset", "new-story"],
    transcript: ["dossier", "new-story"], post: ["new-story"], "around-nj": ["new-story"] };
  if (!supported[selection.kind].includes(target.kind)) throw invalidRequest();
  return {
    workspaceId: opaque(value.workspaceId), selection,
    target: target.kind === "new-story" ? { kind: target.kind } : { kind: target.kind, storyId: opaque(target.storyId) },
    mappingVersion: integer(value.mappingVersion),
  };
}

function parseImportRequest(value) {
  onlyFields(value, IMPORT_FIELDS);
  if (value.importKind !== "story-with-brief-and-dossiers") throw invalidRequest();
  return { workspaceId: opaque(value.workspaceId), importKind: value.importKind,
    storyId: opaque(value.storyId), mappingVersion: integer(value.mappingVersion) };
}

// Fixed-order tuples implement the Boardwalk key encoding.
function buildDedupKey(direction, selectionSnapshot) {
  if (direction === "export") {
    const { workspaceId, selection: s, target, mappingVersion } = parseExportRequest(selectionSnapshot);
    const output = s.expectedClipOutput;
    return JSON.stringify([
      "boardwalk-transfer-v2", direction, workspaceId, target.kind, target.storyId ?? null,
      s.kind, s.sourceId ?? null, s.assetId ?? s.recordId, s.expectedVersion ?? null, s.fileVersion ?? null,
      s.expectedUpdateTime, s.clipId ?? null,
      output ? [output.attemptId, output.objectKey, output.objectVersionId, output.sizeBytes] : null,
      s.transcriptId ?? null, s.expectedEditRevision ?? null, s.expectedJobUpdateTime ?? null, mappingVersion,
    ]);
  }
  if (direction === "import") {
    onlyFields(selectionSnapshot, [...IMPORT_FIELDS, "remoteChangeMarker"]);
    const { remoteChangeMarker, ...value } = selectionSnapshot;
    const request = parseImportRequest(value);
    return JSON.stringify([
      "boardwalk-transfer-v2", direction, request.workspaceId, request.importKind, request.storyId,
      opaque(remoteChangeMarker), request.mappingVersion,
    ]);
  }
  throw invalidRequest();
}

function transferOperationId(direction, selectionSnapshot) {
  return createHash("sha256").update(buildDedupKey(direction, selectionSnapshot), "utf8").digest("hex");
}

function requireState(state) {
  if (typeof state !== "string" || !Object.hasOwn(TRANSITIONS, state)) {
    throw problem("invalid_transition", 409, "Transfer transition is invalid");
  }
}

function transition(currentState, event, errorCode, hasCompletedSteps = false) {
  requireState(currentState);
  if (typeof event !== "string" || !Object.hasOwn(TRANSITIONS[currentState], event)) {
    throw problem("invalid_transition", 409, "Transfer transition is invalid");
  }
  if (event === "retry" && !canRetry(currentState, errorCode, hasCompletedSteps)) {
    throw problem("invalid_transition", 409, "Transfer transition is invalid");
  }
  return TRANSITIONS[currentState][event];
}

function isTerminal(state) {
  requireState(state);
  return state === "complete" || state === "conflict";
}

function canRetry(state, errorCode, hasCompletedSteps = false) {
  requireState(state);
  const partialRetry = hasCompletedSteps === true &&
    ["output_unavailable", "not_authorized", "not_configured", "invalid_request"].includes(errorCode);
  return state === "failed" && (errorCode === "transient_failure" || partialRetry);
}

function transferError(code) {
  if (!SAFE_ERROR_CODES.includes(code)) return invalidRequest();
  return problem(code, code === "not_authorized" ? 403 : 409, "Transfer could not be completed");
}

module.exports = {
  MAX_LOCAL_ID_LENGTH, MAX_OPAQUE_STRING_LENGTH, CONTENT_ID_LENGTH,
  SAFE_ERROR_CODES, parseExportRequest, parseImportRequest, buildDedupKey, transferOperationId,
  transition, isTerminal, canRetry, transferError,
};

"use strict";

const { createHash } = require("node:crypto");
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_PASSAGES = 100;

function fail(code = "alignment_request_invalid") {
  // Keep private text, object names and model output out of error messages.
  throw Object.assign(new Error("Transcript alignment is unavailable"), { code });
}
function fields(value, names) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function hasControls(value, multiline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 || code === 127) && !(multiline && [9, 10, 13].includes(code));
  });
}
function text(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit &&
    !hasControls(value);
}
function size(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function boundedJson(value, limit, code) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { fail(code); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > limit) fail(code);
  return encoded;
}

function canonicalSnapshot(snapshot) {
  if (!fields(snapshot, ["source", "input", "transcript", "engine", "passages"])) fail();
  const { source, input, transcript, engine, passages } = snapshot;
  if (!fields(source, ["sourceId", "assetId", "bucket", "objectKey", "objectVersionId", "sizeBytes"]) ||
      !["sourceId", "assetId", "bucket"].every((key) => text(source[key], 128)) ||
      !text(source.objectKey, 1024) || !text(source.objectVersionId, 1024) || !size(source.sizeBytes)) fail();
  if (!fields(input, ["bucket", "objectKey", "objectVersionId", "sizeBytes", "durationSeconds"]) ||
      !text(input.bucket, 128) || !text(input.objectKey, 1024) || !text(input.objectVersionId, 1024) ||
      !size(input.sizeBytes) || input.sizeBytes > 2_000_000_000 ||
      !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 7200) fail();
  if (!fields(transcript, ["id", "editRevision", "languageCode", "segmentsVersionId"]) ||
      typeof transcript.id !== "string" || !/^[a-f0-9]{64}$/.test(transcript.id) ||
      !Number.isSafeInteger(transcript.editRevision) || transcript.editRevision < 0 ||
      transcript.editRevision >= Number.MAX_SAFE_INTEGER || !["en-US", "es-US"].includes(transcript.languageCode) ||
      !text(transcript.segmentsVersionId, 1024)) fail();
  if (!fields(engine, ["adapterRevision", "modelRepository", "modelRevision", "cacheSha256"]) ||
      !text(engine.adapterRevision, 128) || !text(engine.modelRepository, 256) ||
      typeof engine.modelRevision !== "string" || !/^[a-f0-9]{40}$/.test(engine.modelRevision) ||
      typeof engine.cacheSha256 !== "string" || !/^[a-f0-9]{64}$/.test(engine.cacheSha256)) fail();
  if (!Array.isArray(passages) || !passages.length || passages.length > MAX_PASSAGES) fail();
  let lastIndex = -1;
  const selection = passages.map((passage) => {
    if (!fields(passage, ["index", "text", "startSeconds", "endSeconds", "overlappingSpeech"]) ||
        !Number.isSafeInteger(passage.index) || passage.index <= lastIndex ||
        typeof passage.text !== "string" || passage.text.length > 16000 ||
        hasControls(passage.text, true) ||
        !Number.isFinite(passage.startSeconds) || !Number.isFinite(passage.endSeconds) ||
        passage.startSeconds < 0 || passage.endSeconds <= passage.startSeconds ||
        passage.endSeconds > input.durationSeconds || typeof passage.overlappingSpeech !== "boolean") fail();
    lastIndex = passage.index;
    return { index: passage.index, text: passage.text, startSeconds: passage.startSeconds,
      endSeconds: passage.endSeconds, overlappingSpeech: passage.overlappingSpeech };
  });
  // Fixed field order makes identity independent of object insertion order.
  const identity = ["boardwalk-corrected-word-alignment-v1",
    [source.sourceId, source.assetId, source.bucket, source.objectKey, source.objectVersionId, source.sizeBytes],
    [input.bucket, input.objectKey, input.objectVersionId, input.sizeBytes, input.durationSeconds],
    [transcript.id, transcript.editRevision, transcript.languageCode, transcript.segmentsVersionId],
    [engine.adapterRevision, engine.modelRepository, engine.modelRevision, engine.cacheSha256], selection];
  return { id: createHash("sha256").update(boundedJson(identity, MAX_REQUEST_BYTES)).digest("hex"), passages: selection };
}

/** Build only from an authorized, server-read immutable source and saved edit. */
function alignmentRequest(snapshot) {
  return canonicalSnapshot(snapshot);
}

/** Validate a candidate, not a commit, audio-review decision or export grant. */
function validateAlignmentCompletion(currentSnapshot, result) {
  const current = canonicalSnapshot(currentSnapshot);
  const invalid = "alignment_result_invalid";
  if (!fields(result, ["requestId", "status", "passages"]) ||
      typeof result.requestId !== "string" || !/^[a-f0-9]{64}$/.test(result.requestId)) fail(invalid);
  if (result.requestId !== current.id) fail("alignment_stale");
  if (result.status !== "complete") fail("alignment_unavailable");
  if (!Array.isArray(result.passages) || result.passages.length !== current.passages.length) fail(invalid);
  // The HTTP adapter must bound raw bytes before parsing; this is a second guard.
  boundedJson(result, MAX_RESULT_BYTES, invalid);
  const candidates = result.passages.map((passage, index) => {
    const expected = current.passages[index];
    if (!fields(passage, ["index", "words"]) || passage.index !== expected.index || !Array.isArray(passage.words)) fail(invalid);
    if (expected.overlappingSpeech) fail("alignment_unavailable");
    const tokens = expected.text.trim() ? expected.text.trim().split(/\s+/u) : [];
    if (passage.words.length !== tokens.length) fail(invalid);
    let previousEnd = expected.startSeconds;
    const words = passage.words.map((word, wordIndex) => {
      // Check uncertainty first, including an omitted aligned flag.
      if (!word || typeof word !== "object" || Array.isArray(word)) fail(invalid);
      if (word.aligned !== true) fail("alignment_unavailable");
      if (!fields(word, ["text", "startSeconds", "endSeconds", "aligned"]) || word.text !== tokens[wordIndex] ||
          !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds) ||
          word.startSeconds < previousEnd || word.endSeconds <= word.startSeconds ||
          word.endSeconds > expected.endSeconds) fail(invalid);
      previousEnd = word.endSeconds;
      return { text: word.text, startSeconds: word.startSeconds, endSeconds: word.endSeconds };
    });
    return { index: expected.index, words };
  });
  return { requestId: current.id, status: "candidate", timingBasis: "viewing-copy-elapsed", passages: candidates };
}

module.exports = { alignmentRequest, validateAlignmentCompletion };

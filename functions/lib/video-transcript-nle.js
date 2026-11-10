"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { SourceMediaValidationError } = require("./source-media-contract");

const FRAME_RATES = Object.freeze(["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseNleSettings(request) {
  if (request.format !== "avid") {
    if (request.frameRate !== undefined || request.frameOffset !== undefined) throw new SourceMediaValidationError("Frame settings apply only to Avid markers");
    return {};
  }
  const frameOffset = request.frameOffset ?? 0;
  if (!FRAME_RATES.includes(request.frameRate) || !Number.isSafeInteger(frameOffset) || frameOffset < 0) {
    throw new SourceMediaValidationError("Choose the editing frame rate and a nonnegative whole-frame offset");
  }
  return { frameRate: request.frameRate, frameOffset };
}

function speakerLabel(job, speaker) {
  const name = job.speakerNames?.[speaker] || (speaker === "unknown" ? "Unknown speaker" : `Speaker ${Number(speaker.slice(4)) + 1}`);
  const role = job.speakerRoles?.[speaker];
  return role ? `${name} (${role})` : name;
}
function validSegment(segment, duration) {
  return Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.startSeconds >= 0 &&
    segment.endSeconds >= segment.startSeconds && segment.endSeconds <= duration + 0.001 &&
    typeof segment.text === "string" && /^(?:unknown|spk_(?:0|[1-9]\d?))$/.test(segment.speaker);
}
function checkSegments(segments, job) {
  if (!Number.isFinite(job.durationSeconds) || job.durationSeconds <= 0 || !Array.isArray(segments) || !segments.length ||
      segments.some((segment) => !validSegment(segment, job.durationSeconds))) {
    throw new SourceMediaValidationError("Transcript has no valid timed passages to export", 409);
  }
}

function avidMarkers(segments, job, request) {
  checkSegments(segments, job);
  const { frameRate, frameOffset } = parseNleSettings({ ...request, format: "avid" });
  const [numerator, denominator] = frameRate.split("/").map(Number);
  const cell = (value) => [...String(value)].map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character).join("");
  // Avid 2025.x Editing Guide: Name<TAB>Frame<TAB>Track<TAB>Color<TAB>Comment, no header.
  return segments.map((segment) => {
    const frame = frameOffset + Math.round(segment.startSeconds * numerator / denominator);
    if (!Number.isSafeInteger(frame)) throw new SourceMediaValidationError("Avid frame offset is too large");
    const timing = `Elapsed in ${segment.startSeconds.toFixed(3)}s; out ${segment.endSeconds.toFixed(3)}s; duration ${(segment.endSeconds - segment.startSeconds).toFixed(3)}s`;
    const flags = [segment.speakerUncertain ? "speaker uncertain" : "", segment.overlappingSpeech ? "overlapping speech" : ""].filter(Boolean);
    const review = job.reviewedRevision === (job.editRevision ?? 0) ? "checked against audio" : "not reviewed";
    return [speakerLabel(job, segment.speaker), frame, "V1", flags.length ? "red" : "blue",
      `${timing}; revision ${job.editRevision ?? 0}; ${review}${flags.length ? "; " + flags.join("; ") : ""}; ${segment.text}`].map(cell).join("\t");
  }).join("\n") + "\n";
}

function alignedWords(segment) {
  const words = segment.words;
  const normalized = (text) => text.trim().replace(/\s+/g, " ");
  if (!Array.isArray(words) || !words.length || words.length > 200000 ||
      words.some((word) => typeof word.text !== "string" || !word.text.trim()) ||
      normalized(words.map((word) => word.text.trim()).join(" ")) !== normalized(segment.text)) return false;
  let previous = segment.startSeconds;
  return words.every((word) => {
    const valid = Number.isFinite(word.startSeconds) && Number.isFinite(word.endSeconds) && word.startSeconds >= previous &&
      word.startSeconds >= segment.startSeconds - 0.001 && word.endSeconds >= word.startSeconds && word.endSeconds <= segment.endSeconds + 0.001 &&
      (word.confidence === undefined || (Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 1));
    previous = word.startSeconds;
    return valid;
  });
}

function premiereTranscript(segments, job, uuid = randomUUID) {
  checkSegments(segments, job);
  if (segments.some((segment) => !alignedWords(segment))) {
    throw new SourceMediaValidationError("Premiere export requires unchanged word timings for every passage. Use the text or TSV log for corrected transcripts", 409);
  }
  // Adobe's published schema has es-es, but not es-US. Do not relabel a dialect.
  const language = job.languageCode === "en-US" ? "en-us" : "??-??";
  const ids = new Map();
  const speakers = [...new Set(segments.map((segment) => segment.speaker))].map((speaker) => {
    const id = uuid();
    if (!UUID_V4.test(id) || [...ids.values()].includes(id)) throw new Error("transcript_export_id_invalid");
    ids.set(speaker, id);
    return { id, name: speakerLabel(job, speaker) };
  });
  return { language, speakers, segments: segments.map((segment) => ({
    duration: segment.endSeconds - segment.startSeconds, language, speaker: ids.get(segment.speaker), start: segment.startSeconds,
    words: segment.words.map((word) => ({
      confidence: word.confidence ?? 0, duration: word.endSeconds - word.startSeconds,
      eos: /[.!?]["')]*$/.test(word.text.trim()), start: word.startSeconds, tags: [], text: word.text,
      type: /^[\p{P}\p{S}]+$/u.test(word.text.trim()) ? "punctuation" : "word",
    })),
  })) };
}

function nleExport(segments, job, request) {
  const settings = parseNleSettings(request);
  if (!["avid", "premiere"].includes(request.format)) throw new SourceMediaValidationError("NLE export format is invalid");
  const revision = job.editRevision ?? 0;
  const hash = createHash("sha256").update(JSON.stringify(["nle-v1", job.id, revision, request.format, settings])).digest("hex");
  return { key: `transcripts/results/${job.id}.r${revision}.${request.format}.${hash}.${request.format === "avid" ? "txt" : "json"}`,
    filename: request.format === "avid" ? "avid-markers.txt" : "premiere-transcript.json",
    contentType: request.format === "avid" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    body: request.format === "avid" ? avidMarkers(segments, job, request) : JSON.stringify(premiereTranscript(segments, job)),
  };
}

module.exports = { alignedWords, FRAME_RATES, parseNleSettings, avidMarkers, premiereTranscript, nleExport };

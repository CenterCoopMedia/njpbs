"use strict";

const { TERMINAL_FAILURE_CODES } = require("./video-transcript-audio-input");
const AUDIO_FAILURE_CODES = new Set([...TERMINAL_FAILURE_CODES, "attempts_exhausted"]);
const STATUS_CODES = new Set([
  "original_archived", "original_check_failed",
  "billing_unavailable", "paid_budget_unavailable", "local_audio_preparation_failed", "transcription_failed", "conversion_failed", "source_unavailable",
  "processing_timeout", "processing_failed", "processing_unconfirmed", "start_not_confirmed",
  "byok_admission_invalid", "byok_preparation_failed", "byok_spool_missing", "byok_spool_invalid", "elevenlabs_request_rejected", "elevenlabs_submission_uncertain",
  "editor_video_unsupported", "editor_audio_unsupported", "export_source_mismatch",
  "editor_video_track_unsupported", "editor_duration_unsupported", "prores_video_unsupported", "avid_video_unsupported",
  "original_media_unsupported", "original_timing_unsupported", "original_output_limit",
]);
const STAGES = new Set(["queued", "preparing", "processing", "finalizing", "ready", "failed", "needs_attention", "expired"]);
const TERMINAL = new Set(["ready", "failed", "stale", "cancelled", "needs_reconciliation"]);

function requesterName(value) {
  return typeof value === "string" && value.trim() && value.length <= 100 &&
    !value.includes("@") && [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) ? value.trim() : null;
}
function requesterId(value) {
  return typeof value === "string" && value.trim() && value.length <= 128 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) ? value.trim() : null;
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function processingStatus(job, provider, expired = false) {
  const phases = { pending: "queued", starting: "processing", running: "processing", ready: "ready",
    failed: "failed", stale: "needs_attention", cancelled: "needs_attention", needs_reconciliation: "needs_attention" };
  let stage = phases[job.phase] ?? "needs_attention";
  if (!TERMINAL.has(job.phase) && STAGES.has(job.processingStage)) stage = job.processingStage;
  if (expired) stage = "expired";
  let statusCode = STATUS_CODES.has(job.errorCode) ? job.errorCode : null;
  if (AUDIO_FAILURE_CODES.has(job.errorCode)) statusCode = "processing_failed";
  // Only new requests capture this field from the authenticated account.
  const name = requesterName(job.requesterDisplayName);
  return { stage, provider, ...(name ? { requestedByName: name } : {}), requestedBy: requesterId(job.requestedBy),
    requestedAt: iso(job.requestedAt ?? job.createdAt), startedAt: iso(job.startedAt),
    updatedAt: iso(job.updatedAt), completedAt: iso(job.completedAt), percentComplete: null,
    statusCode };
}
function processingChanges(current, changes, now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  const result = { ...changes, updatedAt };
  if (!current.startedAt && (changes.processingStage === "preparing" || ["starting", "running"].includes(changes.phase))) result.startedAt = updatedAt;
  if (TERMINAL.has(changes.phase) && !current.completedAt) result.completedAt = updatedAt;
  return result;
}
module.exports = { processingStatus, processingChanges, requesterName };

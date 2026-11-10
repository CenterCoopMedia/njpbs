"use strict";

const { parseNleSettings } = require("./video-transcript-nle");
const { processingStatus } = require("./video-processing-status");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { SourceMediaValidationError } = require("./source-media-contract");
const { parseSourceMediaRendition } = require("./source-media-rendition");
const { PAID_FALLBACK_POLICY } = require("./video-transcript-fallback-policy");
const { captionCues } = require("./video-caption-cues");

const ENGINE_REVISION = "aws-transcribe-standard-batch-v1";
const MAX_DURATION_SECONDS = 2 * 60 * 60;
const MAX_INPUT_BYTES = 2_000_000_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_EDIT_REQUEST_BYTES = 2 * 1024 * 1024;
const SPEAKER_ID = /^(?:spk_(?:0|[1-9]\d?)|unknown)$/;

function hasControlCharacters(value, multiline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 || code === 127) && !(multiline && [9, 10, 13].includes(code));
  });
}

function parseTranscriptEdit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceMediaValidationError("Transcript edit is invalid");
  }
  const { revision, segments = [], speakerNames = {}, speakerRoles = {}, reviewed, ...identity } = value;
  const request = parseTranscriptRequest(identity, { variant: true });
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER ||
      !Array.isArray(segments) || segments.length > PAGE_SIZE ||
      !speakerNames || typeof speakerNames !== "object" || Array.isArray(speakerNames) ||
      Object.keys(speakerNames).length > 101 ||
      !speakerRoles || typeof speakerRoles !== "object" || Array.isArray(speakerRoles) || Object.keys(speakerRoles).length > 101 ||
      (reviewed !== undefined && reviewed !== true) ||
      (reviewed === true && (segments.length || Object.keys(speakerNames).length || Object.keys(speakerRoles).length)) ||
      (!reviewed && !segments.length && !Object.keys(speakerNames).length && !Object.keys(speakerRoles).length)) {
    throw new SourceMediaValidationError("Transcript edit is invalid");
  }
  const indexes = new Set();
  for (const patch of segments) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some((key) => !["index", "text", "speaker"].includes(key)) ||
        !Number.isSafeInteger(patch.index) || patch.index < 0 || indexes.has(patch.index) ||
        (patch.text === undefined && patch.speaker === undefined) ||
        (patch.text !== undefined && (typeof patch.text !== "string" || patch.text.length > 16000 || hasControlCharacters(patch.text, true))) ||
        (patch.speaker !== undefined && (typeof patch.speaker !== "string" || !SPEAKER_ID.test(patch.speaker)))) {
      throw new SourceMediaValidationError("Transcript segment edit is invalid");
    }
    indexes.add(patch.index);
  }
  for (const [speaker, name] of Object.entries(speakerNames)) {
    if (speaker === "unknown" || !SPEAKER_ID.test(speaker) || typeof name !== "string" || name.length > 100 || hasControlCharacters(name)) {
      throw new SourceMediaValidationError("Speaker name is invalid");
    }
  }
  for (const [speaker, role] of Object.entries(speakerRoles)) {
    if (speaker === "unknown" || !SPEAKER_ID.test(speaker) || typeof role !== "string" || role.length > 240 || hasControlCharacters(role)) {
      throw new SourceMediaValidationError("Speaker role is invalid");
    }
  }
  return { ...request, revision, segments, speakerNames, speakerRoles, ...(reviewed ? { reviewed: true } : {}) };
}

function applyTranscriptEdit(job, segments, request) {
  const edited = segments.map((segment) => ({ ...segment }));
  for (const patch of request.segments) {
    if (patch.index >= segments.length) throw new SourceMediaValidationError("Transcript segment index is invalid");
    if (patch.text !== undefined) {
      if (patch.text !== edited[patch.index].text) delete edited[patch.index].words;
      edited[patch.index].text = patch.text;
    }
    if (patch.speaker !== undefined && patch.speaker !== edited[patch.index].speaker) {
      edited[patch.index].speaker = patch.speaker;
      if (patch.speaker === "unknown") edited[patch.index].speakerUncertain = true;
      else delete edited[patch.index].speakerUncertain;
    }
  }
  const speakerNames = { ...job.speakerNames };
  for (const [speaker, name] of Object.entries(request.speakerNames)) {
    if (name.trim()) speakerNames[speaker] = name.trim();
    else delete speakerNames[speaker];
  }
  const speakerRoles = { ...job.speakerRoles };
  for (const [speaker, role] of Object.entries(request.speakerRoles ?? {})) {
    if (role.trim()) speakerRoles[speaker] = role.trim();
    else delete speakerRoles[speaker];
  }
  if (isDeepStrictEqual(edited, segments) && isDeepStrictEqual(speakerNames, job.speakerNames ?? {}) &&
      isDeepStrictEqual(speakerRoles, job.speakerRoles ?? {})) {
    throw new SourceMediaValidationError("Transcript edit has no changes");
  }
  return { segments: edited, speakerNames, speakerRoles };
}

function parseTranscriptRequest(value, { read = false, download = false, variant = false } = {}) {
  const requesting = !read && !download && !variant;
  const allowed = new Set(["sourceId", "assetId", "languageCode", "maxSpeakers", ...(requesting ? ["provider", "newAttemptOf", "attemptKey"] : ["transcriptId"]), ...(read ? ["cursor"] : []), ...(download ? ["format", "frameRate", "frameOffset", "clipId"] : [])]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.sourceId !== "video-library" || typeof value.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId)) {
    throw new SourceMediaValidationError("Transcript request is invalid");
  }
  if (value.transcriptId !== undefined && (!/^[a-f0-9]{64}$/.test(value.transcriptId) || typeof value.transcriptId !== "string" ||
      value.languageCode !== undefined || value.maxSpeakers !== undefined)) {
    throw new SourceMediaValidationError("Choose a transcript ID or legacy settings, not both");
  }
  const languageCode = value.languageCode ?? "en-US";
  const maxSpeakers = value.maxSpeakers ?? 10;
  if (!["en-US", "es-US"].includes(languageCode) ||
      !Number.isInteger(maxSpeakers) || maxSpeakers < 2 || maxSpeakers > 10) {
    throw new SourceMediaValidationError("Choose English or Spanish and 2 to 10 speakers");
  }
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 256)) {
    throw new SourceMediaValidationError("Transcript cursor is invalid");
  }
  if (download && !["txt", "vtt", "srt", "tsv", "avid", "premiere"].includes(value.format)) {
    throw new SourceMediaValidationError("Choose a supported transcript download");
  }
  if (value.clipId !== undefined && (!download || typeof value.clipId !== "string" || !/^[a-f0-9]{64}$/.test(value.clipId) || !["txt", "vtt", "srt", "tsv"].includes(value.format))) {
    throw new SourceMediaValidationError("Choose a saved clip and a text, caption or soundbite log format");
  }
  if (requesting && ((value.provider !== undefined && !["local", "amazon-transcribe"].includes(value.provider)) ||
      (value.newAttemptOf !== undefined && !value.provider) || (value.provider !== undefined && !value.newAttemptOf))) {
    throw new SourceMediaValidationError("Choose a transcript provider");
  }
  const attempt = requesting ? require("./video-transcript-attempt").parseNewAttempt(value.newAttemptOf, value.attemptKey) : {};
  return { sourceId: value.sourceId, assetId: value.assetId, ...(value.clipId === undefined ? {} : { clipId: value.clipId }), ...(value.transcriptId === undefined ? { languageCode, maxSpeakers } : { transcriptId: value.transcriptId }),
    ...attempt, ...(requesting && value.provider ? { provider: value.provider } : {}),
    ...(download ? { format: value.format, ...parseNleSettings(value) } : {}),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
}

function timestamp(seconds, separator = ".") {
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 3600000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}${separator}${String(milliseconds % 1000).padStart(3, "0")}`;
}

function transcriptExports(segments, speakerNames = {}) {
  const label = (segment) => speakerNames[segment.speaker] || (segment.speaker === "unknown" ? "Unknown speaker" : `Speaker ${Number(segment.speaker.slice(4)) + 1}`);
  const safeVtt = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    txt: segments.map((segment) => `[${timestamp(segment.startSeconds)}] ${label(segment)}: ${segment.text}`).join("\n\n") + "\n",
    vtt: "WEBVTT\n\n" + captionCues(segments).map((cue, index) => `${index + 1}\n${timestamp(cue.startSeconds)} --> ${timestamp(cue.endSeconds)}\n<v ${safeVtt(label(cue)).replace(/[\r\n]+/g, " ")}>${safeVtt(cue.text)}</v>\n`).join("\n"),
  };
}

// SRT is built on request from the current segments, so older transcripts need no cached copy.
// Cue text omits speaker names, as the VTT voice tags do not display. A blank line would end the cue.
function transcriptSrt(segments) {
  return captionCues(segments).map((cue, index) => `${index + 1}\n${timestamp(cue.startSeconds, ",")} --> ${timestamp(cue.endSeconds, ",")}\n${cue.text}\n`).join("\n");
}

function transcriptLog(segments, job, metadata) {
  // Escape cell separators and formula prefixes without changing the saved quote.
  const cell = (value) => {
    const text = String(value ?? "").replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
    return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
  };
  const revision = job.editRevision ?? 0;
  const reviewed = job.reviewedRevision === revision;
  const columns = ["source_title", "asset_id", "source_version", "transcript_id", "revision", "timing_basis", "in_ms", "out_ms", "duration_ms", "speaker_id", "speaker_name", "speaker_role", "text", "speaker_uncertain", "overlapping_speech", "review_status", "reviewed_by", "reviewed_at"];
  const rows = segments.map((segment) => {
    const start = Math.round(segment.startSeconds * 1000);
    const end = Math.round(segment.endSeconds * 1000);
    return [metadata.title, metadata.assetId, metadata.sourceVersion, job.id, revision, metadata.timingBasis ?? "viewing-copy-elapsed", start, end, end - start,
      segment.speaker, job.speakerNames?.[segment.speaker] ?? (segment.speaker === "unknown" ? "Unknown speaker" : `Speaker ${Number(segment.speaker.slice(4)) + 1}`),
      job.speakerRoles?.[segment.speaker] ?? "", segment.text, segment.speakerUncertain === true, segment.overlappingSpeech === true, reviewed ? "checked against audio" : "not reviewed",
      reviewed ? job.reviewedBy : "", reviewed ? job.reviewedAt : ""].map(cell).join("\t");
  });
  return columns.join("\t") + "\n" + rows.join("\n") + "\n";
}

function transcriptId(asset, bucket, settings) {
  // Standard Transcribe does not expose a pin-able model version. This revision
  // pins our settings contract; cached output is never silently regenerated.
  return createHash("sha256").update(JSON.stringify([
    asset.sourceId, bucket, asset.objectKey, asset.objectVersionId, asset.sizeBytes,
    ENGINE_REVISION, settings.languageCode, settings.maxSpeakers,
    ...(settings.requestedProvider ? [settings.requestedProvider, settings.attemptGeneration ?? 0, settings.previousTranscriptId ?? null] : []),
    ...(settings.attemptKey ? [settings.attemptKey] : []),
  ])).digest("hex");
}

function transcriptInput(asset) {
  const rendition = parseSourceMediaRendition(asset.rendition, asset);
  if (rendition?.state !== "ready") {
    throw new SourceMediaValidationError("Prepare the viewing copy before transcribing", 409);
  }
  const web = rendition.web;
  if (!Number.isFinite(web.durationSeconds) || web.durationSeconds <= 0 ||
      web.durationSeconds > MAX_DURATION_SECONDS || web.sizeBytes > MAX_INPUT_BYTES) {
    throw new SourceMediaValidationError("Transcription requires a viewing copy of 2 hours or less and under 2 GB", 409);
  }
  return web;
}

function transcriptSummary(job) {
  if (!job) return { state: "not_requested" };
  const stationFallback = job.processingPolicy === PAID_FALLBACK_POLICY &&
    job.provider === "amazon-transcribe" && ["pending", "waiting", "ready"].includes(job.paidFallbackState);
  const provider = job.provider === "local" ? "local-whisper" :
    job.provider === "elevenlabs" || stationFallback ? "elevenlabs" :
      job.provider === undefined || job.provider === "amazon-transcribe" ? "amazon-transcribe" : null;
  const revision = job.editRevision ?? 0;
  const alignment = job.alignmentRevision === revision && typeof job.alignmentRequestId === "string"
    ? { state: job.alignmentState ?? "not_requested", timingBasis: "viewing-copy-elapsed",
      revision, requestId: job.alignmentRequestId, eligiblePassages: job.alignmentEligibleCount ?? 0,
      unavailablePassages: job.alignmentUnavailableCount ?? 0, updatedAt: job.alignmentUpdatedAt ?? null }
    : { state: "not_requested", timingBasis: "viewing-copy-elapsed" };
  return {
    processing: { ...processingStatus(job, provider),
      localStage: provider === "local-whisper" && ["downloading", "preparing", "transcribing", "aligning", "diarizing", "finalizing"].includes(job.localStage) ? job.localStage : null,
      fallbackReason: provider !== "elevenlabs" && ["local_worker_unavailable", "local_processing_failed", "local_model_unavailable", "local_input_failed"].includes(job.fallbackReason) ? job.fallbackReason : null,
      // Ohio Standard Batch price checked 2026-09-15, USD0.0001/second, no minimum.
      // https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/current/us-east-2/index.json
      estimatedAwsChargeUsd: ["local-whisper", "amazon-transcribe"].includes(provider) && Number.isFinite(job.durationSeconds) && job.durationSeconds > 0
        ? Math.ceil(job.durationSeconds) / 10000 : null },
    id: job.id, state: job.phase === "pending" ? "queued" :
      ["starting", "running"].includes(job.phase) ? "processing" : job.phase,
    languageCode: job.languageCode, maxSpeakers: job.maxSpeakers,
    durationSeconds: job.durationSeconds, totalSegments: job.totalSegments ?? 0,
    editRevision: job.editRevision ?? 0, speakerNames: job.speakerNames ?? {}, speakerRoles: job.speakerRoles ?? {},
    reviewedRevision: job.reviewedRevision ?? null, reviewedBy: job.reviewedBy ?? null, reviewedByName: job.reviewedByName ?? null, reviewedAt: job.reviewedAt ?? null,
    alignment,
    ...(job.errorCode && (provider !== "elevenlabs" || ["byok_admission_invalid", "byok_preparation_failed", "byok_spool_missing", "byok_spool_invalid", "elevenlabs_request_rejected", "elevenlabs_submission_uncertain"].includes(job.errorCode)) ? { errorCode: job.errorCode } : {}),
  };
}

function transcriptPage(job, segments, cursor) {
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed.id !== job.id || !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0 || parsed.offset > segments.length) throw new Error();
      if ((parsed.revision ?? 0) !== (job.editRevision ?? 0)) {
        throw new SourceMediaValidationError("Transcript changed. Reload the transcript before continuing", 409);
      }
      offset = parsed.offset;
    } catch (error) {
      if (error.status === 409) throw error;
      throw new SourceMediaValidationError("Transcript cursor is invalid");
    }
  }
  const end = Math.min(offset + PAGE_SIZE, segments.length);
  return { ...transcriptSummary(job),
    speakerIds: [...new Set([...segments.map((segment) => segment.speaker), ...Object.keys(job.speakerNames ?? {}), ...Object.keys(job.speakerRoles ?? {})])],
    segments: segments.slice(offset, end).map((segment, index) => ({ ...segment, index: offset + index })),
    nextCursor: end < segments.length
      ? Buffer.from(JSON.stringify({ id: job.id, offset: end, revision: job.editRevision ?? 0 })).toString("base64url") : null };
}

function normalizeTranscript(document, expectedName) {
  if (document?.jobName !== expectedName || document.status !== "COMPLETED" ||
      !Array.isArray(document.results?.items) || document.results.items.length > 200_000) {
    throw new Error("transcript_output_invalid");
  }
  const speakerByTime = new Map();
  for (const segment of document.results.speaker_labels?.segments ?? []) {
    for (const item of segment.items ?? []) speakerByTime.set(item.start_time, item.speaker_label ?? segment.speaker_label);
  }
  const segments = [];
  for (const item of document.results.items) {
    const content = item.alternatives?.[0]?.content;
    if (typeof content !== "string" || content.length > 4096) throw new Error("transcript_output_invalid");
    const last = segments.at(-1);
    if (item.type === "punctuation") {
      if (last) {
        last.text += content;
        if (last.words?.length) last.words.at(-1).text += content;
      }
      continue;
    }
    const start = Number(item.start_time);
    const end = Number(item.end_time);
    const speaker = item.speaker_label ?? speakerByTime.get(item.start_time) ?? "unknown";
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start ||
        end > MAX_DURATION_SECONDS + 60 || !SPEAKER_ID.test(speaker)) {
      throw new Error("transcript_output_invalid");
    }
    const word = { startSeconds: start, endSeconds: end, text: content };
    if (item.alternatives[0].confidence !== undefined) {
      const confidence = Number(item.alternatives[0].confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("transcript_output_invalid");
      word.confidence = confidence;
    }
    const sentenceBreak = last && /[.!?]["')]*$/.test(last.text) && last.endSeconds - last.startSeconds >= 15;
    if (last && last.speaker === speaker && start - last.endSeconds < 2 &&
        end - last.startSeconds <= 30 && last.text.length + content.length < 500 && !sentenceBreak) {
      last.text += ` ${content}`;
      last.endSeconds = end;
      last.words.push(word);
    } else {
      segments.push({ speaker, startSeconds: start, endSeconds: end, text: content, words: [word] });
    }
  }
  return segments;
}

module.exports = { transcriptLog, MAX_EDIT_REQUEST_BYTES, parseTranscriptEdit, applyTranscriptEdit, ENGINE_REVISION, MAX_DURATION_SECONDS, MAX_INPUT_BYTES, MAX_RESULT_BYTES,
  parseTranscriptRequest, transcriptId, transcriptInput, transcriptSummary, transcriptPage, normalizeTranscript, transcriptExports, transcriptSrt };

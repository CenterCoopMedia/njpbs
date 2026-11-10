"use strict";
const { processingStatus } = require("./video-processing-status");
const { createHash } = require("node:crypto");
const { ID_PATTERN, SourceMediaValidationError } = require("./source-media-contract");

const CLIP_JOBS = "mediaSourceClipJobs";
const CLIP_TTL_MS = 7 * 86400 * 1000;
const SOURCE_EXPORT_MAX_DURATION_SECONDS = 86400;
const CLIP_SOURCE_END_TOLERANCE_SECONDS = 1.001;
const EXPORT_FORMATS = ["web_mp4", "broadcast_mxf", "prores_mov", "avid_mxf", "original_copy", "broadcast_mp4"];
const OUTPUT_FRAME_RATES = Object.freeze({ broadcast: [30000, 1001], "24000/1001": [24000, 1001],
  "24/1": [24, 1], "25/1": [25, 1], "30/1": [30, 1], "50/1": [50, 1], "60000/1001": [60000, 1001], "60/1": [60, 1] });
const EXPORT_SCOPES = ["clip", "source"];

function problem(status, message) { return new SourceMediaValidationError(message, status); }
function jobScope(value = {}) { return value.scope ?? "clip"; }
function jobFormat(value = {}) { return value.format ?? "web_mp4"; }
function parseClipHistoryCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw problem(400, "Video export history request is invalid");
  }
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
        Object.keys(cursor).sort().join(",") !== "id,requestedAt" ||
        typeof cursor.id !== "string" || !/^[a-f0-9]{64}$/.test(cursor.id) ||
        typeof cursor.requestedAt !== "string" || !Number.isFinite(Date.parse(cursor.requestedAt))) throw new Error();
    return cursor;
  } catch {
    throw problem(400, "Video export history request is invalid");
  }
}
function encodeClipHistoryCursor(job) {
  if (!job || typeof job.id !== "string" || !/^[a-f0-9]{64}$/.test(job.id) ||
      typeof job.requestedAt !== "string" || !Number.isFinite(Date.parse(job.requestedAt))) {
    throw new Error("clip_history_cursor_invalid");
  }
  return Buffer.from(JSON.stringify({ id: job.id, requestedAt: job.requestedAt }), "utf8").toString("base64url");
}

function clipSettings(value = {}) {
  const resolution = value.resolution === undefined ? "source" : value.resolution;
  const quality = value.quality === undefined ? "balanced" : value.quality;
  if (!["source", "1080p", "720p", "480p"].includes(resolution) ||
      !["smaller", "balanced", "high"].includes(quality)) {
    throw problem(400, "Choose a supported clip resolution and quality");
  }
  return { resolution, quality };
}

function exportSettings(value = {}) {
  const scope = jobScope(value);
  const format = jobFormat(value);
  if (!EXPORT_SCOPES.includes(scope) || !EXPORT_FORMATS.includes(format)) {
    throw problem(400, "Choose a supported video export format");
  }
  if (scope === "source" && format === "web_mp4") {
    throw problem(400, "Use the existing original or web-copy download for a full MP4 video");
  }
  if (scope === "source" && format === "original_copy") {
    throw problem(400, "Download the existing original for a full video");
  }
  if (format !== "web_mp4" && (value.resolution !== undefined || value.quality !== undefined)) {
    throw problem(400, "Editor exports retain the supported source size and do not use web-copy quality settings");
  }
  if (format === "broadcast_mp4" && scope !== "source") {
    throw problem(400, "A frame rate copy uses the full original video");
  }
  const editor = ["broadcast_mxf", "prores_mov", "avid_mxf", "broadcast_mp4"].includes(format);
  if (value.frameRateMode !== undefined && (typeof value.frameRateMode !== "string" || !editor || !(value.frameRateMode === "source" || Object.hasOwn(OUTPUT_FRAME_RATES, value.frameRateMode)))) {
    throw problem(400, "Choose a supported export frame rate");
  }
  if (format === "broadcast_mxf" && ["24/1", "30/1", "60/1"].includes(value.frameRateMode)) {
    throw problem(400, "XDCAM does not support this output rate. Choose another format");
  }
  if (editor) return { scope, format, ...(value.retry === true && value.frameRateMode === undefined && format !== "broadcast_mp4"
    ? {} : { frameRateMode: value.frameRateMode ?? "broadcast" }) };
  return format === "web_mp4"
    ? { scope, format, ...clipSettings(value) }
    : { scope, format };
}

function parseClipRequest(value, action) {
  const fields = action === "request"
    ? ["sourceId", "assetId", "inMs", "outMs", "retry", "resolution", "quality", "scope", "format", "frameRateMode"]
    : ["sourceId", "assetId", "clipId", ...(action === "get" ? ["scope", "cursor"] : []),
      ...(action === "cancel" ? ["attemptId"] : [])];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) || value.sourceId !== "video-library" ||
      typeof value.assetId !== "string" || !ID_PATTERN.test(value.assetId)) {
    throw problem(400, "Clip request is invalid");
  }
  if (action !== "request") {
    if (action === "get" && value.clipId === undefined) {
      const scope = value.scope ?? "clip";
      if (!EXPORT_SCOPES.includes(scope)) {
        throw problem(400, "Video export history request is invalid");
      }
      return { ...value, scope, cursor: parseClipHistoryCursor(value.cursor) };
    }
    if (value.cursor !== undefined || typeof value.clipId !== "string" || !/^[a-f0-9]{64}$/.test(value.clipId)) {
      throw problem(400, "Clip id is invalid");
    }
    if (action === "cancel" && (typeof value.attemptId !== "string" || !ID_PATTERN.test(value.attemptId))) {
      throw problem(400, "Video export attempt is invalid");
    }
    return value;
  }
  if (value.retry !== undefined && typeof value.retry !== "boolean") {
    throw problem(400, "Clip retry value is invalid");
  }
  const settings = exportSettings(value);
  if (settings.scope === "source") {
    if (value.inMs !== undefined || value.outMs !== undefined) {
      throw problem(400, "A full-source export does not accept clip boundaries");
    }
    return { ...value, ...settings, retry: value.retry ?? false };
  }
  if (!Number.isSafeInteger(value.inMs) || !Number.isSafeInteger(value.outMs) || value.inMs < 0 ||
      value.outMs - value.inMs < 250 || value.outMs - value.inMs > 1800000) {
    throw problem(400, "Choose a clip between 0.25 seconds and 30 minutes");
  }
  return { ...value, ...settings, retry: value.retry ?? false };
}

function validateClipResolution(settings, web) {
  if (jobFormat(settings) !== "web_mp4" || clipSettings(settings).resolution === "source") return;
  if (!Number.isSafeInteger(web.width) || !Number.isSafeInteger(web.height) || Math.min(web.width, web.height) <= 0) {
    throw problem(409, "Use source resolution until viewing-copy dimensions are available");
  }
  if (Number.parseInt(settings.resolution, 10) > Math.min(web.width, web.height)) {
    throw problem(409, "Choose a resolution no larger than the viewing copy");
  }
}

function clipIdentity(job) {
  const scope = jobScope(job);
  const format = jobFormat(job);
  const original = [job.sourceId, job.assetId, job.sourceObjectKey, job.sourceObjectVersionId, job.sourceSizeBytes];
  const frameIdentity = job.frameRateMode === undefined ? [] : ["frame-rate-v1", job.frameRateMode];
  if (scope === "source") {
    return createHash("sha256").update(JSON.stringify([...original, "source-export-v1", format, ...frameIdentity])).digest("hex");
  }
  const identity = [...original, job.inputObjectKey, job.inputObjectVersionId, job.inputSizeBytes, job.inMs, job.outMs];
  if (format !== "web_mp4") {
    identity.push(format === "original_copy" ? "original-copy-v1" : "clip-v3", format);
  } else {
    const { resolution, quality } = clipSettings(job);
    identity.push(...(resolution === "source" && quality === "balanced"
      ? ["clip-v1"]
      : ["clip-v2", resolution, quality]));
  }
  return createHash("sha256").update(JSON.stringify([...identity, ...frameIdentity])).digest("hex");
}

function sameClipSource(asset, job) {
  const originalMatches = asset?.sourceId === job.sourceId && asset.id === job.assetId &&
    asset.objectKey === job.sourceObjectKey && asset.objectVersionId === job.sourceObjectVersionId &&
    asset.sizeBytes === job.sourceSizeBytes;
  if (!originalMatches || jobScope(job) === "source") return originalMatches;
  return asset.rendition?.state === "ready" && asset.rendition.web.objectKey === job.inputObjectKey &&
    asset.rendition.web.objectVersionId === job.inputObjectVersionId && asset.rendition.web.sizeBytes === job.inputSizeBytes;
}

// Ohio on-demand Professional tier HD rates per output minute, checked 2026-09-23 (price list published 2026-09-11):
// MPEG-2 single pass USD0.024 and USD0.030, Apple ProRes and VC-3 USD0.048 and USD0.060, for <=30 fps and >30 to 60 fps.
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSElementalMediaConvert/current/us-east-2/index.json
// Each output is billed in one-second increments with a 10-second minimum (https://aws.amazon.com/mediaconvert/pricing/).
const EDITOR_USD_PER_OUTPUT_MINUTE = { broadcast_mxf: [0.024, 0.03], prores_mov: [0.048, 0.06], avid_mxf: [0.048, 0.06], broadcast_mp4: [0.024, 0.03] };
// S3 Standard Ohio, first 50 TB, USD0.023 per GB-month, checked 2026-09-23 (price list published 2026-09-18).
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-2/index.json
// Keep the legacy 14-day export and 28-day staging allowances for existing per-attempt estimates.
// Estimates are recomputed from jobs rather than persisted; reducing the multiplier would rewrite history.
// The current staging lifecycle is 3+1 days with immediate verified-copy cleanup; this remains a conservative
// legacy allowance until estimates have a versioned per-attempt policy. Review the versioned storage lifecycle policy before changing this allowance.
const S3_USD_PER_GB_DAY = 0.023 / 30 / 2 ** 30;

// One ready attempt: its conversion plus output and staging storage. Earlier attempts are not included.
// An expired export keeps its estimate, because the charge was already incurred.
function editorExportChargeUsd(job) {
  const rates = EDITOR_USD_PER_OUTPUT_MINUTE[jobFormat(job)];
  const { durationSeconds, frameRateNumerator, frameRateDenominator, sizeBytes } = job.output ?? {};
  const fps = frameRateNumerator / frameRateDenominator;
  if (!rates || job.phase !== "ready" || !(durationSeconds > 0) || !(fps > 0 && fps <= 60) ||
      !Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(job.sourceSizeBytes)) return null;
  const shortSide = Math.min(job.output.width, job.output.height);
  // https://aws.amazon.com/mediaconvert/pricing/ measures the short side for portrait outputs.
  // AWS publishes no ProRes price above 2160; do not present an HD estimate for that raster.
  if (jobFormat(job) === "prores_mov" && shortSide > 2160) return null;
  const resolutionMultiplier = jobFormat(job) === "prores_mov" && Number.isFinite(shortSide)
    ? (shortSide < 720 ? 0.5 : shortSide > 1080 ? 2 : 1) : 1;
  const conversion = Math.max(10, Math.ceil(durationSeconds)) / 60 * rates[fps <= 30 ? 0 : 1] * resolutionMultiplier;
  const storage = (sizeBytes * 14 + job.sourceSizeBytes * 28) * S3_USD_PER_GB_DAY;
  return Math.round((conversion + storage) * 10000) / 10000;
}

function clipSummary(job, now = Date.now()) {
  const expired = job.phase === "ready" && Date.parse(job.expiresAt) <= now;
  const states = { pending: "queued", running: "processing", ready: "ready", failed: "failed", needs_reconciliation: "failed", cancelled: "cancelled" };
  const format = jobFormat(job);
  return {
    processing: { ...processingStatus(job, format === "original_copy" ? "aws-ffmpeg" : "aws-mediaconvert", expired), estimatedAwsChargeUsd: editorExportChargeUsd(job) },
    id: job.id, attemptId: job.attemptId,
    state: expired ? "expired" : states[job.phase] ?? "failed", scope: jobScope(job), format,
    inMs: job.inMs, outMs: job.outMs, ...(format === "web_mp4" ? clipSettings(job) : {}),
    width: job.output?.width ?? null, height: job.output?.height ?? null,
    durationMs: Number.isFinite(job.output?.sourceStartSeconds) && Number.isFinite(job.output?.sourceEndSeconds)
      ? Math.round((job.output.sourceEndSeconds - job.output.sourceStartSeconds) * 1000)
      : Number.isSafeInteger(job.inMs) && Number.isSafeInteger(job.outMs) ? job.outMs - job.inMs : null,
    expiresAt: job.expiresAt ?? null, errorCode: job.errorCode ?? null, sizeBytes: job.output?.sizeBytes ?? null,
    sourceStartSeconds: job.output?.sourceStartSeconds ?? null,
    sourceEndSeconds: job.output?.sourceEndSeconds ?? null,
    sourceFrameDurationSeconds: job.output?.sourceFrameDurationSeconds ?? null,
    frameRateNumerator: job.output?.frameRateNumerator ?? null,
    frameRateDenominator: job.output?.frameRateDenominator ?? null,
    frameRateMode: job.frameRateMode ?? null,
    requestedFrameRate: job.frameRateMode === "broadcast" ? "30000/1001" : job.frameRateMode ?? "source",
    sourceFrameRateNumerator: job.output?.sourceFrameRateNumerator ?? job.sourceFrameRateNumerator ?? null,
    sourceFrameRateDenominator: job.output?.sourceFrameRateDenominator ?? job.sourceFrameRateDenominator ?? null,
    conversionMethod: job.output?.conversionMethod ?? null,
    timecodeMode: job.output?.timecodeMode ?? null,
    scanType: job.output?.scanType ?? null,
    audioChannels: job.output?.audioChannels ?? null,
    audioTracks: job.output?.audioTracks ?? null,
    audioCodec: job.output?.audioCodec ?? null,
    audioSampleRate: job.output?.audioSampleRate ?? null,
    audioBitDepth: job.output?.audioBitDepth ?? null,
    container: job.output?.container ?? null,
    videoCodec: job.output?.videoCodec ?? null,
    profile: job.output?.profile ?? null,
    // Earlier ProRes/Avid jobs inherited the XDCAM input rejection. New rejections use distinct codes.
    canRetry: job.phase === "failed" && job.attempts < 3 && (job.retryable === true ||
      (["prores_mov", "avid_mxf"].includes(jobFormat(job)) && job.errorCode === "editor_video_unsupported")),
    canCancel: job.phase === "pending" && !job.leaseOwner && !job.executionArn,
  };
}

function validateOutputTiming(job, output, required) {
  const values = [output.sourceStartSeconds, output.sourceEndSeconds, output.sourceFrameDurationSeconds];
  if (!required && values.every((value) => value === undefined)) return {};
  if (!values.every(Number.isFinite) || output.sourceStartSeconds < 0 || output.sourceEndSeconds <= output.sourceStartSeconds ||
      output.sourceEndSeconds > SOURCE_EXPORT_MAX_DURATION_SECONDS || output.sourceFrameDurationSeconds <= 0 ||
      output.sourceFrameDurationSeconds > 1) throw new Error("clip_output_timing_invalid");
  const frame = output.sourceFrameDurationSeconds;
  if (jobScope(job) === "source") {
    if (output.sourceStartSeconds !== 0) throw new Error("clip_output_timing_invalid");
    return { sourceStartSeconds: 0, sourceEndSeconds: output.sourceEndSeconds,
      sourceFrameDurationSeconds: frame };
  }
  const requestedStart = job.inMs / 1000;
  const requestedEnd = job.outMs / 1000;
  if (output.sourceStartSeconds > requestedStart + 1e-6 || requestedStart - output.sourceStartSeconds >= frame + 1e-6 ||
      requestedEnd - output.sourceEndSeconds > CLIP_SOURCE_END_TOLERANCE_SECONDS ||
      output.sourceEndSeconds - requestedEnd >= frame + 1e-6) {
    throw new Error("clip_output_timing_invalid");
  }
  return { sourceStartSeconds: output.sourceStartSeconds, sourceEndSeconds: output.sourceEndSeconds,
    sourceFrameDurationSeconds: frame };
}

function validEditorialVideo(output, format) {
  const key = `${output.width}x${output.height}:${output.scanType}`;
  const rate = `${output.frameRateNumerator}/${output.frameRateDenominator}`;
  const standardRates = new Set(["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"]);
  if (format === "prores_mov") {
    return [output.width, output.height].every(size => Number.isSafeInteger(size) && size >= 32 && size <= 4096 && size % 2 === 0) &&
      standardRates.has(rate);
  }
  if (format === "avid_mxf") {
    const rates = {
      "1920x1080:progressive": standardRates,
      "1920x1080:interlaced": new Set(["25/1", "30000/1001", "30/1"]),
      "1280x720:progressive": standardRates,
    };
    return rates[key]?.has(rate) === true;
  }
  const rates = {
    "1920x1080:progressive": new Set(["24000/1001", "25/1", "30000/1001"]),
    "1920x1080:interlaced": new Set(["25/1", "30000/1001"]),
    "1280x720:progressive": new Set(["24000/1001", "25/1", "50/1", "30000/1001", "60000/1001"]),
  };
  return rates[key]?.has(rate) === true;
}

const EDITOR_FORMATS = Object.freeze({
  broadcast_mp4: { resultKey: "broadcastMp4", filename: "broadcast.mp4", mimeType: "video/mp4",
    container: "mp4", videoCodec: "h264", profile: "frame_rate_copy", audioChannels: [0, 2] },
  broadcast_mxf: { resultKey: "broadcast", filename: "broadcast.mxf", mimeType: "application/mxf",
    container: "mxf", videoCodec: "mpeg2", profile: "xdcam_rdd9", audioChannels: [2, 4, 8] },
  prores_mov: { resultKey: "prores", filename: "prores.mov", mimeType: "video/quicktime",
    container: "quicktime", videoCodec: "prores", profile: "prores_422_hq", audioChannels: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  avid_mxf: { resultKey: "avid", filename: "avid.mxf", mimeType: "application/mxf",
    container: "mxf", videoCodec: "vc3", profile: "vc3_class_145_8bit", audioChannels: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
});

function validBroadcastCopyVideo(output) {
  return Number.isSafeInteger(output.width) && Number.isSafeInteger(output.height) &&
    Math.min(output.width, output.height) > 0 && Math.max(output.width, output.height) <= 1920 &&
    Math.min(output.width, output.height) <= 1080;
}

function validateFrameRateOutput(job, output) {
  const n = output.sourceFrameRateNumerator;
  const d = output.sourceFrameRateDenominator;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0 || n / d > 240) {
    throw new Error("clip_source_frame_rate_invalid");
  }
  const expectedRate = job.frameRateMode === "source" ? [n, d] : OUTPUT_FRAME_RATES[job.frameRateMode];
  if (!expectedRate) throw new Error("clip_output_frame_rate_invalid");
  const sameRate = n * expectedRate[1] === d * expectedRate[0];
  const broadcastRate = expectedRate[0] * 1001 === expectedRate[1] * 30000;
  const expectedMethod = sameRate ? "none"
    : broadcastRate && n * 1001 === d * 24000 && output.scanType === "interlaced" ? "telecine" : "interpolate";
  if (output.frameRateNumerator * expectedRate[1] !== output.frameRateDenominator * expectedRate[0] ||
      output.conversionMethod !== expectedMethod || output.timecodeMode !== "embedded_or_zero_based") {
    throw new Error("clip_output_frame_rate_invalid");
  }
}

function validateEditorOutput(job, result) {
  const spec = EDITOR_FORMATS[jobFormat(job)];
  const output = result?.[spec?.resultKey];
  const expected = `outputs/clips/${job.id}/${job.attemptId}/${spec?.filename}`;
  const rateOk = Number.isSafeInteger(output?.frameRateNumerator) && Number.isSafeInteger(output?.frameRateDenominator) &&
    output.frameRateNumerator > 0 && output.frameRateDenominator > 0;
  const audioOk = output?.audioChannels === 0
    ? output.audioTracks === 0 && output.audioCodec === "none" && output.audioSampleRate === null && output.audioBitDepth === null
    : jobFormat(job) === "broadcast_mp4"
      ? output?.audioTracks === 1 && output?.audioChannels === 2 && output?.audioCodec === "aac" && output?.audioSampleRate === 48000 && output?.audioBitDepth === null
      : output?.audioTracks === output?.audioChannels && output?.audioCodec === "pcm" &&
      output?.audioSampleRate === 48000 && output?.audioBitDepth === 24;
  if (result?.id !== job.id || result.attemptId !== job.attemptId || output?.objectKey !== expected ||
      typeof output.objectVersionId !== "string" || !output.objectVersionId || output.objectVersionId.length > 1024 ||
      !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes <= 0 || output.mimeType !== spec?.mimeType ||
      output.container !== spec.container || output.videoCodec !== spec.videoCodec || output.profile !== spec.profile ||
      !["progressive", "interlaced"].includes(output.scanType) || !rateOk ||
      !spec.audioChannels.includes(output.audioChannels) || !audioOk ||
      (jobFormat(job) === "broadcast_mp4" ? !validBroadcastCopyVideo(output) : !validEditorialVideo(output, jobFormat(job))) ||
      !Number.isFinite(output.durationSeconds) || output.durationSeconds <= 0) throw new Error("clip_output_invalid");
  const timing = validateOutputTiming(job, output, true);
  if (job.frameRateMode !== undefined) validateFrameRateOutput(job, output);
  const toleranceMs = job.frameRateMode !== undefined && job.frameRateMode !== "source" ? 1000 * output.frameRateDenominator / output.frameRateNumerator + 1e-6
    : Math.max(500, timing.sourceFrameDurationSeconds * 2000);
  if (Math.abs(output.durationSeconds * 1000 - (timing.sourceEndSeconds - timing.sourceStartSeconds) * 1000) > toleranceMs) {
    throw new Error("clip_output_duration_invalid");
  }
  return { ...output, ...timing };
}

function validateClipOutput(job, result) {
  if (jobFormat(job) === "original_copy") return validateOriginalOutput(job, result);
  if (jobFormat(job) !== "web_mp4") return validateEditorOutput(job, result);
  const web = result?.web;
  const frameSeconds = web?.frameDurationSeconds;
  if (frameSeconds !== undefined && (!Number.isFinite(frameSeconds) || frameSeconds < 1 / 60 || frameSeconds > 1)) {
    throw new Error("clip_output_frame_rate_invalid");
  }
  const durationToleranceMs = Math.max(500, (frameSeconds ?? 0) * 2000);
  if (result?.id !== job.id || result.attemptId !== job.attemptId ||
      web?.objectKey !== `outputs/clips/${job.id}/${job.attemptId}/preview.mp4` ||
      typeof web.objectVersionId !== "string" || !web.objectVersionId || web.objectVersionId.length > 1024 ||
      !Number.isSafeInteger(web.sizeBytes) || web.sizeBytes <= 0 || web.mimeType !== "video/mp4" ||
      !Number.isFinite(web.durationSeconds) || web.durationSeconds <= 0 ||
      Math.abs(web.durationSeconds * 1000 - (job.outMs - job.inMs)) > durationToleranceMs) {
    throw new Error("clip_output_invalid");
  }
  const { resolution, quality } = clipSettings(job);
  const hasDimensions = web.width !== undefined || web.height !== undefined;
  if (hasDimensions || resolution !== "source" || quality !== "balanced") {
    const cap = resolution === "source" ? 1080 : Number.parseInt(resolution, 10);
    const longCap = cap === 1080 ? 1920 : cap === 720 ? 1280 : 854;
    if (!Number.isSafeInteger(web.width) || !Number.isSafeInteger(web.height) || Math.min(web.width, web.height) <= 0 ||
        Math.min(web.width, web.height) > cap || Math.max(web.width, web.height) > longCap) {
      throw new Error("clip_output_dimensions_invalid");
    }
  }
  return {
    objectKey: web.objectKey, objectVersionId: web.objectVersionId, sizeBytes: web.sizeBytes,
    mimeType: "video/mp4", durationSeconds: web.durationSeconds,
    ...(hasDimensions ? { width: web.width, height: web.height } : {}),
    ...(frameSeconds === undefined ? {} : { frameDurationSeconds: frameSeconds }),
    ...validateOutputTiming(job, web, false),
  };
}

function validateOriginalOutput(job, result) {
  const output = result?.original;
  const proof = output?.provenance;
  const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (result?.id !== job.id || result?.attemptId !== job.attemptId || jobScope(job) !== "clip" ||
      output?.objectKey !== `outputs/clips/${job.id}/${job.attemptId}/original.mov` ||
      typeof output?.objectVersionId !== "string" || !output.objectVersionId || output.objectVersionId.length > 1024 ||
      !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 1 || output.sizeBytes > 64 * 1024 ** 3 ||
      output.mimeType !== "video/quicktime" || output.container !== "quicktime" ||
      !["h264", "prores"].includes(output.videoCodec) || !hex(output.sha256) ||
      !Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || Math.min(output.width, output.height) < 1 ||
      output.requestedInMs !== job.inMs || output.requestedOutMs !== job.outMs ||
      proof?.revision !== "original-copy-v1" || proof.timingEvidence !== "verified-packet-subsequence" ||
      proof.sourceObjectVersionId !== job.sourceObjectVersionId || proof.sourceSizeBytes !== job.sourceSizeBytes ||
      !hex(proof.ffmpegArtifactSha256) || !Array.isArray(proof.streams) || proof.streams.length < 1 || proof.streams.length > 9) {
    throw new Error("original_output_invalid");
  }
  const start = output.sourceStartSeconds;
  const end = output.sourceEndSeconds;
  const frame = output.sourceFrameDurationSeconds;
  if (![start, end, frame, output.durationSeconds].every(Number.isFinite) || start < 0 || end <= start ||
      end > SOURCE_EXPORT_MAX_DURATION_SECONDS || frame <= 0 || frame > 1 || output.durationSeconds <= 0 ||
      start > job.inMs / 1000 + 1e-6 || end < job.outMs / 1000 - 1e-6 ||
      job.inMs / 1000 - start > 30 || end - job.outMs / 1000 > 30 ||
      Math.abs(output.durationSeconds - (end - start)) > Math.max(0.5, frame * 2)) {
    throw new Error("original_output_timing_invalid");
  }
  const videos = proof.streams.filter(stream => stream.kind === "video");
  const timeBase = value => typeof value === "string" && /^[1-9]\d{0,9}\/[1-9]\d{0,9}$/.test(value);
  if (videos.length !== 1 || videos[0].codec !== output.videoCodec ||
      new Set(proof.streams.map(stream => stream.sourceIndex)).size !== proof.streams.length ||
      new Set(proof.streams.map(stream => stream.outputIndex)).size !== proof.streams.length ||
      proof.streams.some(stream =>
        !Number.isSafeInteger(stream.sourceIndex) || stream.sourceIndex < 0 || stream.sourceIndex > 32 ||
        !Number.isSafeInteger(stream.outputIndex) || stream.outputIndex < 0 || stream.outputIndex >= proof.streams.length ||
        !["video", "audio"].includes(stream.kind) ||
        (stream.kind === "audio" && !["aac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s16be", "pcm_s24be", "pcm_s32be"].includes(stream.codec)) ||
        !Number.isSafeInteger(stream.packetCount) || stream.packetCount < 1 || !hex(stream.packetSha256) ||
        !timeBase(stream.sourceTimeBase) || !timeBase(stream.outputTimeBase) ||
        ![stream.sourceStartSeconds, stream.sourceEndSeconds, stream.outputStartSeconds, stream.outputEndSeconds,
          stream.timestampOffsetSeconds].every(Number.isFinite) ||
        stream.sourceEndSeconds <= stream.sourceStartSeconds || stream.outputEndSeconds <= stream.outputStartSeconds ||
        !Number.isSafeInteger(stream.initialSkipSamples) || stream.initialSkipSamples < 0 ||
        !Number.isSafeInteger(stream.discardPadding) || stream.discardPadding < 0)) {
    throw new Error("original_output_provenance_invalid");
  }
  return output;
}

module.exports = {
  OUTPUT_FRAME_RATES, CLIP_JOBS, CLIP_TTL_MS, EXPORT_FORMATS, EXPORT_SCOPES, EDITOR_FORMATS, SOURCE_EXPORT_MAX_DURATION_SECONDS,
  problem, parseClipRequest, parseClipHistoryCursor, encodeClipHistoryCursor,
  clipSettings, exportSettings, jobScope, jobFormat, validateClipResolution,
  clipIdentity, sameClipSource, clipSummary, validateClipOutput,
};

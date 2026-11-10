"use strict";

// Only bounded numeric timings can enter persisted diagnostic receipts.
const PREVIEW_STAGES = Object.freeze([
  "node-startup", "source-check", "runtime-import", "package-check", "sandbox-check", "runtime-check", "public-context",
  "index-check", "listener-start", "runtime-ready", "runtime-setup", "pair-authority", "pair-context", "wake", "health", "claim", "queue-read",
  "input-read", "input-freeze", "render", "pack", "upload", "finish",
]);
function previewTimings(value) {
  const timings = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return timings;
  for (const stage of PREVIEW_STAGES) {
    const duration = value[stage];
    if (Number.isSafeInteger(duration) && duration >= 0 && duration <= 86_400_000) timings[stage] = duration;
  }
  return timings;
}

function previewStartup(value) {
  if (!value || typeof value !== "object" ||
      typeof value.startupId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.startupId) ||
      !Number.isSafeInteger(value.processStartedAtMs) || value.processStartedAtMs < 1_000_000_000_000 ||
      value.processStartedAtMs > 9_999_999_999_999) return null;
  return { startupId: value.startupId, processStartedAtMs: value.processStartedAtMs,
    timingsMs: previewTimings(value.timingsMs) };
}

module.exports = { PREVIEW_STAGES, previewTimings, previewStartup };

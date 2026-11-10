"use strict";

const { ownsPublication, samePublicationOwner, publicationRuntime } = require("./publication-runtime-owner");
const EXTERNAL_REFRESH_PATH = "system/publicDeployment/externalRefresh/current";
const EXTERNAL_INPUT_FILES = ["launch-media-manager.json", "spotlight-news.json", "schedule.json"];
const MAX_HOLD_MS = 12 * 3_600_000;
const HOLD_CLOCK_SKEW_MS = 5 * 60_000;

function externalRefreshHold(state, now = Date.now()) {
  const hold = state?.hold;
  if (hold === undefined || hold === null) return null;
  if (!hold || typeof hold !== "object" || Array.isArray(hold) || Object.keys(hold).length !== 3 ||
      typeof hold.operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(hold.operationId) ||
      !Number.isSafeInteger(hold.startedAt) || hold.startedAt < 0 || !Number.isSafeInteger(hold.until) || hold.until <= hold.startedAt) {
    throw new Error("Invalid external refresh hold");
  }
  // An out-of-policy duration must not stop providers indefinitely.
  return hold.until - hold.startedAt > MAX_HOLD_MS || hold.until > now + MAX_HOLD_MS + HOLD_CLOCK_SKEW_MS ? null : hold;
}

function externalRefreshHeld(state, now = Date.now()) {
  const hold = externalRefreshHold(state, now);
  return hold !== null && hold.until > now;
}

function externalRefreshDue(state, runtime, now = Date.now()) {
  publicationRuntime(runtime);
  if (runtime.owner !== "cloudflare") throw new Error("External refresh requires the cloud owner");
  if (!state) return true;
  if (state.schemaVersion !== 1 || !samePublicationOwner(state, runtime) ||
      !["fetching", "verified", "failed"].includes(state.status) || !Number.isFinite(state.nextAttemptAt)) {
    throw new Error("Invalid external refresh state");
  }
  return !externalRefreshHeld(state, now) && (!ownsPublication(state, runtime) || state.nextAttemptAt <= now);
}

// Twice daily at 07:00 and 19:00 America/New_York (0 7,19 * * * in station time).
// Observe UTC hours so Eastern wall-clock slots follow both EST and EDT.
function nextExternalRefreshAt(now) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let at = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000; at <= now + 26 * 3_600_000; at += 3_600_000) {
    const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    if ([7, 19].includes(Number(parts.hour)) && parts.minute === "00") return at;
  }
  throw new Error("Invalid external refresh schedule");
}

module.exports = { EXTERNAL_REFRESH_PATH, EXTERNAL_INPUT_FILES, externalRefreshHold, externalRefreshHeld, externalRefreshDue, nextExternalRefreshAt };

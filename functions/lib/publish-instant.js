"use strict";

// Deployment-safe CommonJS mirror of packages/content-core/src/publish-instant.ts.
// The build gate and Cloud Functions must reject the same malformed or impossible
// stored instants, so every Functions caller shares this one parser.

const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function parsePublishInstant(value) {
  if (typeof value !== "string") return null;
  const match = value.match(UTC_INSTANT);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const ms = millis ? Number(millis.padEnd(3, "0")) : 0;
  const instant = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const roundTrip = new Date(instant);
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d ||
    roundTrip.getUTCHours() !== h ||
    roundTrip.getUTCMinutes() !== mi ||
    roundTrip.getUTCSeconds() !== s
  ) {
    return null;
  }
  return instant;
}

module.exports = { parsePublishInstant };

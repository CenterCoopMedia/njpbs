"use strict";

// Mirrors packages/content-core/src/public-record-kinds.ts. Keep this
// dependency-free so the site parity test can load the Functions answer without
// importing the Firebase runtime, and so the publish snapshot writer and the
// scheduled runner can ask one question rather than restating `type === "post"`.
//
// A kind added here but not in the canonical module lets the server freeze a
// snapshot the public build will not route; a kind added there but not here
// leaves an Admin button whose server action refuses. The parity test in
// site/tests/public-record-kinds.test.ts fails on either direction.

const PUBLICLY_ROUTED_RECORD_KINDS = ["post", "program", "event"];

// A Map, not an object literal, so `constructor` and `__proto__` answer "not a
// routed kind" rather than something inherited from Object.prototype.
const ROUTE_BASES = new Map([
  ["post", "/posts/"],
  ["program", "/programs/"],
  ["event", "/events/"],
]);

function recordKindHasPublicRoute(value) {
  return typeof value === "string" && ROUTE_BASES.has(value);
}

function publicRouteBaseForRecordKind(value) {
  if (typeof value !== "string") return null;
  return ROUTE_BASES.get(value) ?? null;
}

module.exports = {
  PUBLICLY_ROUTED_RECORD_KINDS,
  recordKindHasPublicRoute,
  publicRouteBaseForRecordKind,
};

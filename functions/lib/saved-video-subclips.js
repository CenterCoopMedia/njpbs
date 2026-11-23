"use strict";

const { createHash } = require("node:crypto");

const SUBCLIP_ID_PATTERN = /^[a-f0-9]{64}$/;

function hashSubclipFields(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function videoSubclipLibraryRef(firestore, uid, sourceId, assetId) {
  return firestore.collection("mediaSourceSubclipLibraries").doc(hashSubclipFields([uid, sourceId, assetId]));
}

function subclipState(subclip, fileVersion, durationSeconds) {
  if (subclip.fileVersion !== fileVersion) return "replaced";
  const durationMs = Math.floor((durationSeconds ?? 0) * 1000);
  return Number.isSafeInteger(durationMs) && subclip.outMs <= durationMs ? "current" : "unavailable";
}

module.exports = { SUBCLIP_ID_PATTERN, hashSubclipFields, subclipState, videoSubclipLibraryRef };

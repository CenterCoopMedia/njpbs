"use strict";

const { resolve } = require("node:path");
const APPLICATION_ROOT = `${resolve(__dirname, "..")}/`;
const STATES = new Set(["available", "archived", "restoring", "restored"]);
const ARCHIVE_TIERS = new Set(["ARCHIVE_ACCESS", "DEEP_ARCHIVE_ACCESS"]);
const ARCHIVE_CLASSES = ["GLACIER", "DEEP_ARCHIVE"];
const ORIGINAL_BUCKETS = new Set(
  (process.env.CMS_MEDIA_ORIGINAL_BUCKETS ?? "").split(",").map(value => value.trim()).filter(Boolean),
);

function originalAvailability(value, asset) {
  if (!value || value.sourceId !== asset.sourceId || value.objectKey !== asset.objectKey || value.objectVersionId !== asset.objectVersionId ||
      value.sizeBytes !== asset.sizeBytes || !STATES.has(value.state) ||
      typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  return { state: value.state, checkedAt: value.checkedAt,
    archiveTier: ARCHIVE_TIERS.has(value.archiveTier) ? value.archiveTier : null,
    ...(Number.isFinite(Date.parse(value.restoredAt)) ? { restoredAt: value.restoredAt } : {}),
    ...(value.state === "restored" && typeof value.availableUntil === "string" && Number.isFinite(Date.parse(value.availableUntil))
      ? { availableUntil: value.availableUntil } : {}) };
}

function stateFromHead(head, previous, now = Date.now()) {
  // S3 removes archive-class copies at expiry-date. Intelligent-Tiering has no temporary copy.
  const expiry = ARCHIVE_CLASSES.includes(head.StorageClass)
    ? Date.parse(/expiry-date="([^"]+)"/.exec(head.Restore ?? "")?.[1] ?? "") : NaN;
  const ongoing = /ongoing-request="true"/.test(head.Restore ?? "");
  const completed = /ongoing-request="false"/.test(head.Restore ?? "") && !(expiry <= now);
  const archiveTier = ARCHIVE_TIERS.has(head.ArchiveStatus) ? head.ArchiveStatus : null;
  let state = "available";
  if (ongoing) state = "restoring";
  else if ((archiveTier || ARCHIVE_CLASSES.includes(head.StorageClass)) && !completed) state = "archived";
  else if (completed || previous?.state === "restoring" || previous?.state === "restored") state = "restored";
  return { state, archiveTier, checkedAt: new Date(now).toISOString(),
    ...(state === "restored" ? { restoredAt: previous?.restoredAt ?? new Date(now).toISOString() } : {}),
    ...(state === "restored" && Number.isFinite(expiry) ? { availableUntil: new Date(expiry).toISOString() } : {}) };
}

class OriginalArchivedError extends Error {
  constructor(original = { state: "archived", archiveTier: null }) {
    const restoring = original.state === "restoring";
    super(restoring
      ? "The original is restoring. Wait for it to finish, then try again. Standard retrieval can take up to 12 hours."
      : "The original is archived. Select Restore original in the video details, then try again after it is restored. Standard retrieval can take up to 12 hours. If Restore original is not available, ask a person who manages video.");
    this.name = "OriginalArchivedError";
    this.status = 409;
    this.code = restoring ? "original_restoring" : "original_archived";
    this.original = original;
  }
}

function assertOriginalReadable(head) {
  const original = stateFromHead(head);
  if (["archived", "restoring"].includes(original.state) ||
      (ARCHIVE_CLASSES.includes(head.StorageClass) && !/ongoing-request="false"/.test(head.Restore ?? ""))) {
    throw new OriginalArchivedError(original.state === "available" ? { ...original, state: "archived" } : original);
  }
}

function mapOriginalStorageError(error) {
  return error?.name === "InvalidObjectState" ? new OriginalArchivedError() : error;
}

module.exports = { ORIGINAL_BUCKETS, originalAvailability, stateFromHead, OriginalArchivedError,
  assertOriginalReadable, mapOriginalStorageError };

// SDK messages, stacks and response bodies can contain signed URLs or credentials.
function safeStorageDiagnostic(error) {
  const token = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : null;
  const status = error?.$metadata?.httpStatusCode ?? error?.status;
  // Keep code locations for application failures, without the stack's message or arguments.
  const frames = typeof error?.stack === "string" ? error.stack.split("\n").slice(1, 16).flatMap(line => {
    const start = line.lastIndexOf(APPLICATION_ROOT);
    if (start < 0) return [];
    const match = line.slice(start + APPLICATION_ROOT.length).match(/^([A-Za-z0-9_/-]+\.js):(\d{1,7}):(\d{1,7})\)?$/);
    if (match?.[1].split("/").some(part => ["node_modules", ".."].includes(part))) return [];
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 5) : [];
  return { errorName: token(error?.name) ?? "Error",
    errorCode: Number.isInteger(error?.code) ? error.code : token(error?.code),
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    ...(frames.length ? { frames } : {}) };
}
module.exports.safeStorageDiagnostic = safeStorageDiagnostic;

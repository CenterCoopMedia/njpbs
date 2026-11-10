"use strict";

const { createHash } = require("node:crypto");
const { publicPageDefinition, publicPagePath } = require("./public-page-contract");
const { isServerMintableSlugShape } = require("./post-slug-contract");
const { publicRouteBaseForRecordKind } = require("./public-record-kinds");

const PREVIEW_HEADS_COLLECTION = "cmsPreviewHeads";
const PREVIEW_REFRESH_MS = 5 * 60 * 1000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function timestampToMillis(value) {
  try {
    if (value && typeof value.toMillis === "function") {
      const millis = value.toMillis();
      return Number.isFinite(millis) ? millis : null;
    }
    const date =
      value && typeof value.toDate === "function"
        ? value.toDate()
        : value instanceof Date
          ? value
          : null;
    const millis = date?.getTime();
    return Number.isFinite(millis) ? millis : null;
  } catch {
    return null;
  }
}

function previewExpiryMillis(data) {
  const expiry = timestampToMillis(data.expiresAt);
  const completed = timestampToMillis(data.completedAt);
  if (!Number.isFinite(expiry)) return null;
  return Number.isFinite(completed) ? Math.min(expiry, completed + PREVIEW_TTL_MS) : expiry;
}

function validPreviewTarget(collection, id) {
  if (collection === "cmsPages") return Boolean(publicPageDefinition(id));
  return collection === "cmsPosts" && typeof id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

function previewContentKey(collection, id) {
  if (!validPreviewTarget(collection, id)) throw new Error("Invalid preview target");
  return createHash("sha256").update(`${collection}\0${id}`).digest("hex");
}

function previewTargetPath(collection, id, snapshot) {
  if (!validPreviewTarget(collection, id)) throw new Error("Invalid preview target");
  if (collection === "cmsPages") {
    const path = publicPagePath(id, snapshot);
    if (!path) throw new Error("Page preview has no saved route");
    return path;
  }
  const slug = snapshot?.published?.metadata?.slug;
  if (!isServerMintableSlugShape(slug)) throw new Error("Record preview has no saved route");
  // Older private Post snapshots predate the type discriminator in this route
  // lookup. They still belong under /posts/; new Event snapshots name their type.
  const base = publicRouteBaseForRecordKind(snapshot?.published?.metadata?.type ?? "post");
  if (!base) throw new Error("Record preview has no public route");
  return `${base}${slug}/`;
}

module.exports = {
  PREVIEW_HEADS_COLLECTION,
  PREVIEW_REFRESH_MS,
  PREVIEW_TTL_MS,
  previewExpiryMillis,
  timestampToMillis,
  validPreviewTarget,
  previewContentKey,
  previewTargetPath,
};

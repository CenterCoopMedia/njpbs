"use strict";

const { createHash } = require("node:crypto");
const { assertInputTree } = require("./no-build-page-contract");
const { PROGRAM_METADATA_FIELDS, EVENT_METADATA_FIELDS, createPublishedSnapshot } = require("./publish-snapshot");
const { parsePublishInstant } = require("./publish-instant");
const { previousVideoCopies } = require("./public-video-references");
const { isServerMintableSlugShape } = require("./post-slug-contract");

const RECORD_FAMILIES = new Map([["programs", "program"], ["events", "event"]]);
const validRecordId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function refuse(message) {
  throw Object.assign(new Error(`Build-free record: ${message}`), { status: 409 });
}
function assertFields(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.keys(value).some(key => !allowed.includes(key))) refuse("Unsupported snapshot fields.");
}
function recordFamilyForPath(path) {
  if (typeof path !== "string" || path.length > 512) return null;
  const match = /^\/(programs|events|shows)\/(?:([^/]+)\/)?$/.exec(path);
  if (!match || match[2] !== undefined && !isServerMintableSlugShape(match[2])) return null;
  return match[1] === "shows" ? "programs" : match[1];
}
function recordIndexPaths(family) {
  if (!RECORD_FAMILIES.has(family)) refuse("Unknown record family.");
  return family === "programs" ? ["/programs/", "/shows/"] : ["/events/"];
}

/** A frozen snapshot supplies content. The caller still owns visibility,
 * current-source checks, public media and transaction/release authority. */
function validateNoBuildRecordSnapshot({ family, documentId, snapshot }) {
  // Use the Page boundary's existing bounded JSON validator before recursive
  // rich-text parsing; typed objects, getters, cycles and oversized input fail.
  try { assertInputTree(snapshot); } catch { refuse("The snapshot must be bounded JSON."); }
  const kind = RECORD_FAMILIES.get(family);
  if (!kind || !validRecordId(documentId)) refuse("Invalid record identity.");
  assertFields(snapshot, ["metadata", "blocks", "sourceVersion", "contentVersion", "publishedAt", "publishedBy", "previousVideoCopies"]);
  assertFields(snapshot.metadata, kind === "program" ? PROGRAM_METADATA_FIELDS : EVENT_METADATA_FIELDS);
  const metadata = snapshot.metadata;
  if (metadata.type !== kind || !isServerMintableSlugShape(metadata.slug) || metadata.slug.length > 480 ||
      !Array.isArray(snapshot.blocks) || snapshot.blocks.length !== 0 ||
      !Number.isSafeInteger(snapshot.sourceVersion) || snapshot.sourceVersion < 1 ||
      snapshot.contentVersion !== undefined && (!Number.isSafeInteger(snapshot.contentVersion) || snapshot.contentVersion < 1) ||
      parsePublishInstant(snapshot.publishedAt) === null || typeof snapshot.publishedBy !== "string" || !snapshot.publishedBy.trim()) {
    refuse("Invalid published snapshot.");
  }
  const aliases = metadata.previousSlugs ?? (kind === "program" ? [] : null);
  if (!Array.isArray(aliases) || aliases.length > 100 || aliases.some(slug => typeof slug !== "string")) {
    refuse("Invalid retained slugs.");
  }
  const links = kind === "program" ? ["watchUrl"] : ["onlineUrl", "registrationUrl"];
  for (const field of links) {
    const value = metadata[field];
    if (value !== undefined && value !== "" && !(kind === "event" && value === null) && typeof value !== "string") {
      refuse("Invalid public URL.");
    }
  }
  if (snapshot.previousVideoCopies !== undefined && (!Array.isArray(snapshot.previousVideoCopies) ||
      previousVideoCopies(snapshot).length !== snapshot.previousVideoCopies.length)) refuse("Invalid retained video references.");
  try {
    createPublishedSnapshot({ collection: "cmsPosts", document: { ...metadata,
      previousSlugs: aliases, version: snapshot.sourceVersion }, publishedAt: snapshot.publishedAt, publishedBy: snapshot.publishedBy });
  } catch { refuse("The snapshot does not meet the publication contract."); }
  const assetId = metadata[kind === "program" ? "keyArtAssetId" : "imageAssetId"];
  if (assetId !== undefined && assetId !== null && assetId !== "" && !validRecordId(assetId)) refuse("Invalid image identity.");
  // Match the static projector: remove self/duplicate aliases, ignore historical
  // strings without a public route, and retain the /shows/ mirror for Programs.
  const slugs = [...new Set([metadata.slug, ...aliases.filter(isServerMintableSlugShape)])];
  const ownedPaths = slugs.map(slug => `/${family}/${slug}/`);
  if (kind === "program") ownedPaths.push(...slugs.map(slug => `/shows/${slug}/`));
  if (ownedPaths.some(path => path.length > 512)) refuse("A retained route exceeds the reader limit.");
  return { family, kind, documentId, sourceVersion: snapshot.sourceVersion,
    canonicalPath: `/${family}/${metadata.slug}/`, ownedPaths, assetIds: assetId ? [assetId] : [] };
}

function recordSnapshotDigest(snapshot) {
  try { assertInputTree(snapshot); } catch { refuse("The snapshot must be bounded JSON."); }
  // Firestore map order is not source identity; array order remains significant.
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

module.exports = { validRecordId, recordFamilyForPath, recordIndexPaths, validateNoBuildRecordSnapshot, recordSnapshotDigest };

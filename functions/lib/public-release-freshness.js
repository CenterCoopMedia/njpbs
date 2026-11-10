"use strict";

const { createHash } = require("node:crypto");
const { publiclyVisible } = require("./public-video-references");
const { digest: canonicalDigest } = require("./no-build-page-ownership");
const { PreparedPublicReleaseError } = require("./public-release-error");
const { collectPublishedMediaUsage, MediaUsageError } = require("./media-usage");
const { resolveApprovedLibraryVersions } = require("./approved-library-records");

// Published snapshots define CMS identity. Draft-only inserts and saves must
// never make a ready release stale. Public authority records use update times.
const COLLECTIONS = ["system/publicDeployment/noBuildPostOwners", "system/publicDeployment/noBuildPageOwners",
  "system/publicDeployment/noBuildPageRoutes", "system/publicDeployment/noBuildRecordOwners",
  "system/publicDeployment/noBuildRecordRoutes"];
const DOCUMENTS = ["system/publicDeployment/contexts/public", "system/noBuildPostAdmission",
  "system/publicDeployment/noBuildPosts/current", "system/publicDeployment/noBuildPosts/capability",
  "system/publicDeployment/noBuildPages/capability", "system/publicDeployment/noBuildRecords/capability",
  "system/publicDeployment/noBuildRecordFamilies/current"];

async function publicReleaseFreshnessDigest(transaction, firestore) {
  const publicRecords = name => transaction.get(firestore.collection(name)
    .select("published", "publiclyVisible", "deleted", "status", "publishAt", "type", "version"));
  const [pages, posts, authors, settings, collections, documents] = await Promise.all([
    publicRecords("cmsPages"),
    publicRecords("cmsPosts"),
    transaction.get(firestore.collection("cmsAuthorProfilesPublic").select("photo")),
    transaction.get(firestore.collection("cmsSettings").select("published", "version")),
    Promise.all(COLLECTIONS.map(name => transaction.get(firestore.collection(name).select()))),
    transaction.getAll(...DOCUMENTS.map(name => firestore.doc(name))),
  ]);
  const postRecords = posts.docs.map(row => ({ ...row.data(), id: row.id }));
  const approved = new Map((await resolveApprovedLibraryVersions(firestore, postRecords, query => transaction.get(query)))
    .map(record => [record.id, record.approvedLibraryVersion]));
  const mediaIds = new Set();
  const retainMedia = (collection, snapshot, documentId, documentVersion) => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    for (const id of collectPublishedMediaUsage({ collection, snapshot, documentId, documentVersion }).assetIds) mediaIds.add(id);
  };
  const snapshots = [];
  for (const [collection, records] of [["cmsPages", pages], ["cmsPosts", posts]]) {
    for (const row of records.docs) {
      const value = row.data();
      const visible = publiclyVisible(value);
      const library = collection === "cmsPosts" ? approved.get(row.id) : null;
      if (!visible && !library) continue;
      snapshots.push([row.ref.path, canonicalDigest({ published: visible ? value.published ?? null : null,
        publishAt: visible ? (value.status === "published" ? value.publishAt : value.published?.publishedAt) ?? null : null,
        approvedLibraryVersion: library ?? null })]);
      if (visible) retainMedia(collection, value.published);
      if (library) retainMedia("cmsPosts", { metadata: library });
    }
  }
  for (const author of authors.docs) retainMedia("cmsAuthorProfilesPublic", author.data());
  // Settings have no visibility gate. Only their immutable published snapshot
  // enters the build; working values and draft versions must not invalidate it.
  for (const row of settings.docs) {
    const value = row.data();
    if (value.published === undefined) continue;
    snapshots.push([row.ref.path, canonicalDigest(value.published)]);
    try {
      retainMedia("cmsSettings", value.published, row.id, value.version);
    } catch (error) {
      // Invalid legacy settings cannot contribute rendered media. Keep hashing
      // their snapshot; the build keeps its existing validation and fallbacks.
      if (!(error instanceof MediaUsageError)) throw error;
    }
  }
  const assets = [];
  const ids = [...mediaIds].sort();
  for (let offset = 0; offset < ids.length; offset += 100) {
    assets.push(...await transaction.getAll(...ids.slice(offset, offset + 100).map(id => firestore.doc(`media_assets_public/${id}`))));
  }
  const rows = [...authors.docs, ...collections.flatMap(collection => collection.docs), ...documents, ...assets].map(row => {
    if (!row.exists) return [row.ref.path, null];
    const time = row.updateTime;
    if (!Number.isSafeInteger(time?.seconds) || !Number.isSafeInteger(time?.nanoseconds)) {
      throw new PreparedPublicReleaseError("The public release source identity is unavailable");
    }
    return [row.ref.path, time.seconds, time.nanoseconds];
  }).concat(snapshots).sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

module.exports = { publicReleaseFreshnessDigest };

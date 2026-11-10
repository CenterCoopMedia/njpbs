"use strict";

const { isDeepStrictEqual } = require("node:util");
const { publiclyVisible, publicCopies } = require("./public-video-references");
const { isPublicVideoData } = require("./video-block");

const MAX_CONTENT = 5000;
const REFERENCE_FIELDS = ["type", "liveBlog", "blocks", "leadMedia", "published.metadata.type",
  "published.metadata.liveBlog", "published.metadata.leadMedia", "published.blocks", "published.sourceVersion",
  "createdBy", "section", "published.metadata.section", "publiclyVisible", "status", "deleted", "publishBuildPending",
  "publishBuildQueueId", "publishBuildSettlement", "publicSourceVersion", "published.previousVideoCopies"];
const FAILED_PUBLICATIONS = new Set(["failed", "cancelled", "public_unconfirmed"]);
async function publicationNeedsRepair(firestore, document, transaction) {
  if (typeof document.publishBuildQueueId === "string" && document.publishBuildQueueId) {
    const ref = firestore.collection("cmsPublishQueue").doc(document.publishBuildQueueId);
    const queue = (transaction ? await transaction.get(ref) : await ref.get()).data();
    // A current retry owns the status; an older settlement must not hide it.
    return !queue || FAILED_PUBLICATIONS.has(queue.status);
  }
  return FAILED_PUBLICATIONS.has(document.publishBuildSettlement?.status);
}
function refreshSnapshot(snapshot, { assetId, media }) {
  const copy = structuredClone(snapshot);
  function visit(value) {
    if (!value || typeof value !== "object") return;
    // Both body video blocks and lead/live-blog library videos share this data shape.
    if (value.sourceId === "video-library" && value.assetId === assetId && isPublicVideoData(value.public)) {
      value.public = structuredClone(media);
    }
    for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
  }
  visit(copy);
  return copy;
}

/** The publication owners permit only this exact, server-selected binary dependency change. */
function assertVideoReplacementRefresh(before, after, binding) {
  if (!binding || typeof binding.assetId !== "string" || !isPublicVideoData(binding.media) || !before?.published) {
    throw Object.assign(Error("Video replacement publication identity is invalid"), { status: 409 });
  }
  const expected = { ...before, published: refreshSnapshot(before.published, binding) };
  const withoutQueue = value => {
    const copy = structuredClone(value);
    delete copy.publishBuildPending; delete copy.publishBuildQueueId;
    // These copies protect the previous live rendering until the normal owner confirms the new one.
    if (copy.published) delete copy.published.previousVideoCopies;
    return copy;
  };
  if (!isDeepStrictEqual(withoutQueue(expected), withoutQueue(after))) {
    throw Object.assign(Error("Video replacement cannot change saved or published editorial content"), { status: 409 });
  }
}

async function contentRows(firestore, transaction) {
  const rows = [];
  for (const collection of ["cmsPosts", "cmsPages"]) {
    const query = firestore.collection(collection).select(...REFERENCE_FIELDS).limit(MAX_CONTENT + 1);
    const snapshot = transaction ? await transaction.get(query) : await query.get();
    if (snapshot.size > MAX_CONTENT) throw Error("video_reference_scan_limit");
    rows.push(...snapshot.docs);
  }
  return rows;
}

async function migrateVideoReferences({ firestore, assetId, media, maxOwners = 5 }) {
  let pending = false, changed = 0;
  const failedOwners = [];
  for (const row of await contentRows(firestore)) {
    const value = row.data();
    if (!publiclyVisible(value) || !publicCopies(value).some(copy => copy.assetId === assetId)) continue;
    if (isDeepStrictEqual(refreshSnapshot(value.published, { assetId, media }), value.published)) {
      // Program/Event snapshots have no video layout. Their retained URL-only
      // copies protect an older rendering and need no record-owner refresh.
      if (value.publishBuildPending) {
        pending = true;
        if (await publicationNeedsRepair(firestore, value) && failedOwners.length < 5) failedOwners.push(row.ref.path);
      }
      continue;
    }
    if (changed >= maxOwners) { pending = true; continue; }
    try { await firestore.runTransaction(async transaction => {
      const current = (await transaction.get(row.ref)).data();
      const publicRecord = (await transaction.get(firestore.doc(`cmsPublicVideos/${assetId}`))).data();
      if (!publiclyVisible(current)) return;
      if (publicRecord?.revoked || !isDeepStrictEqual(publicRecord?.media, media)) throw Error("video_public_copy_changed");
      if (current.publishBuildPending) {
        pending = true;
        if (await publicationNeedsRepair(firestore, current, transaction) && failedOwners.length < 5) failedOwners.push(row.ref.path);
        return;
      }
      const binding = { assetId, media };
      const published = refreshSnapshot(current.published, binding);
      if (isDeepStrictEqual(published, current.published)) return;
      published.previousVideoCopies = [...new Map([...publicCopies(current, true), ...(published.previousVideoCopies ?? [])]
        .map(copy => [copy.url, copy])).values()];
      const queueRef = firestore.collection("cmsPublishQueue").doc();
      const nextDocument = { ...current, published, publishBuildPending: true, publishBuildQueueId: queueRef.id };
      assertVideoReplacementRefresh(current, nextDocument, binding);
      const prepared = await require("./no-build-content-publication").prepareNoBuildContentPublication({
        firestore, transaction, collection: row.ref.parent.id, documentId: row.id, nextDocument, queueRef,
        actor: { uid: "system:video-replacement" }, videoReplacementRefresh: binding });
      if (!prepared || prepared.requiresPrimaryAdmission) throw Error("video_publication_owner_unavailable");
      const mediaUsage = await require("./media-usage").prepareMediaUsageWrite({ firestore, transaction,
        collection: row.ref.parent.id, documentId: row.id, state: "published", sourceVersion: published.sourceVersion,
        usage: require("./media-usage").collectPublishedMediaUsage({ collection: row.ref.parent.id, snapshot: published }),
        ...(prepared.releaseSelector ? { releaseSelector: prepared.releaseSelector } : {}) });
      const datasets = await require("./dataset-usage").prepareDatasetUsageWrites({ firestore, transaction,
        collection: row.ref.parent.id, documentId: row.id, snapshot: published, previousSnapshot: current.published,
        operationId: prepared.operation.operationId, visible: true });
      prepared.write(); datasets(); transaction.set(mediaUsage.ref, mediaUsage.document);
      transaction.update(row.ref, { published, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
      changed++; pending = true;
    }); } catch {
      pending = true;
      if (failedOwners.length < 5) failedOwners.push(row.ref.path);
    }
  }
  return { pending, changed, failedOwners };
}

module.exports = { refreshSnapshot, assertVideoReplacementRefresh, contentRows, migrateVideoReferences };

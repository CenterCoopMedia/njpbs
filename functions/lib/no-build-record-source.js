"use strict";

const { pagePublicationTarget } = require("./no-build-page-target");
const { assertPublicDeploymentPointer, assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const { validateNoBuildRecordSnapshot, recordSnapshotDigest, validRecordId } = require("./no-build-record-contract");
const { publiclyVisible } = require("./public-video-references");
const { parsePublishInstant } = require("./publish-instant");
const { mediaReplacementRef } = require("./media-replacement");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { selectedAssets } = require("./public-content-projection");
const { readPublishedChrome, publicRichText } = require("../published-post-reader");

const MAX_RECORDS = 1000;
function refuse(message) {
  throw Object.assign(new Error(`Build-free record input: ${message}`), { status: 409 });
}
async function getAll(transaction, refs) {
  const rows = [];
  for (let offset = 0; offset < refs.length; offset += 100) {
    rows.push(...await transaction.getAll(...refs.slice(offset, offset + 100)));
  }
  return rows;
}
function recordIsPublic(document, now) {
  if (!publiclyVisible(document)) return false;
  const instant = parsePublishInstant(document.status === "published" ? document.publishAt : document.published?.publishedAt);
  return instant !== null && instant <= now.getTime();
}

/** Paired public/private media and replacement locks share the caller's read
 * snapshot. Only selected public fields leave this boundary. */
async function readRecordMediaInTransaction({ firestore, transaction, assetIds, pointer }) {
  if (!Array.isArray(assetIds) || assetIds.length > MAX_RECORDS ||
      new Set(assetIds).size !== assetIds.length || assetIds.some(id => !validRecordId(id))) refuse("Invalid media roster.");
  const rows = await getAll(transaction, assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`),
    firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id)]));
  const uploadedMediaReady = assetIds.some((_id, index) => rows[index * 3].data()?.source === "upload");
  if (uploadedMediaReady) {
    if (pointer.schemaVersion === 2) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector: pointer });
    else assertMediaLifecycleDeploymentFence(pointer);
  }
  const assets = new Map(assetIds.map((assetId, index) => {
    if (rows[index * 3 + 2].exists) refuse("An image replacement is pending.");
    return [assetId, assertPublishedAssetProjection({ assetId, owner: "published record",
      privateSnapshot: rows[index * 3], publicSnapshot: rows[index * 3 + 1], uploadedMediaReady })];
  }));
  const projected = selectedAssets({ assetIds }, assets);
  return assetIds.map(id => ({ id, ...projected[id] }));
}

function selectPublicRecord(documentId, document, family) {
  const snapshot = document.published;
  const plan = validateNoBuildRecordSnapshot({ family, documentId, snapshot });
  if (!Number.isSafeInteger(document.version) || document.version < plan.sourceVersion ||
      document.publicSourceVersion !== undefined && document.publicSourceVersion !== null &&
        (!Number.isSafeInteger(document.publicSourceVersion) || document.publicSourceVersion < 1 || document.publicSourceVersion > plan.sourceVersion)) {
    refuse("The published source version changed.");
  }
  const metadata = { ...snapshot.metadata, description: publicRichText(snapshot.metadata.description) };
  return { plan, source: { documentId, sourceVersion: snapshot.sourceVersion,
    snapshotDigest: recordSnapshotDigest(snapshot), ownedPaths: plan.ownedPaths },
  document: { id: documentId, version: snapshot.sourceVersion, status: "published", publiclyVisible: true,
    deleted: false, publishAt: snapshot.publishedAt, published: { metadata, blocks: [],
      sourceVersion: snapshot.sourceVersion, publishedAt: snapshot.publishedAt } } };
}

/** Preparation input, never serving authority. A complete query and an optional
 * trusted prospective snapshot let acceptance inspect collisions before writes.
 * The returned source roster stays private; the read contains no draft or actor. */
async function readPendingRecordFamilyInTransaction({ firestore, transaction, family, rendererSha,
  now = new Date(), nextDocument, documentId, releaseSelector }) {
  if (!["programs", "events"].includes(family) || !/^[a-f0-9]{40}$/.test(rendererSha ?? "") ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) refuse("Invalid family or renderer.");
  pagePublicationTarget({ firestore });
  const raw = (await transaction.get(firestore.doc("system/publicDeployment"))).data(), pair = require("./public-release-pair");
  const pointer = releaseSelector === undefined ? assertPublicDeploymentPointer(raw) : require("./public-release-media-fence").parseStoredSelector(raw);
  if (releaseSelector !== undefined && pair.publicReleaseDigest(pair.parsePublicReleaseSelector(releaseSelector)) !== pair.publicReleaseDigest(pointer)) refuse("The selected pair changed.");
  if (pointer.state !== "idle" || pointer.activeCommitSha !== rendererSha || pointer.activeGeneration < 1) refuse("The code release changed.");
  const contextRevision = await readPublicContextRevisionInTransaction(transaction, firestore);
  const kind = family === "programs" ? "program" : "event";
  const rows = await transaction.get(firestore.collection("cmsPosts").where("published.metadata.type", "==", kind)
    .select("published", "version", "publicSourceVersion", "status", "publishAt", "publiclyVisible", "deleted").limit(MAX_RECORDS + 1));
  if (rows.size > MAX_RECORDS) refuse("The family exceeds the input limit.");
  const byId = new Map(rows.docs.map(row => [row.id, row.data()]));
  if (nextDocument !== undefined) {
    if (!validRecordId(documentId) || nextDocument?.published?.metadata?.type !== kind) refuse("Invalid prospective record.");
    byId.set(documentId, nextDocument);
  }
  if (byId.size > MAX_RECORDS) refuse("The family exceeds the input limit.");
  const documents = [], sources = [], paths = new Set(), assetIds = new Set();
  for (const [id, document] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    if (!recordIsPublic(document, now)) continue;
    const selected = selectPublicRecord(id, document, family);
    for (const path of selected.plan.ownedPaths) {
      if (paths.has(path)) refuse("Published record routes collide.");
      paths.add(path);
    }
    for (const assetId of selected.plan.assetIds) assetIds.add(assetId);
    documents.push(selected.document);
    sources.push(selected.source);
  }
  const assets = await readRecordMediaInTransaction({ firestore, transaction, pointer, assetIds: [...assetIds].sort() });
  const chrome = await readPublishedChrome(firestore, transaction, now);
  const read = { kind: "published-record-family", family, complete: true, documents, assets, ...chrome,
    sourceSeal: { rendererSha, contextRevision, contextDigest: publicContextDigest(contextRevision) } };
  if (!require("./content-link").contentLinkReadFits(read, 8 * 1024 * 1024)) refuse("The family exceeds the byte limit.");
  return { read, sources, pointer };
}

module.exports = { MAX_RECORDS, recordIsPublic, readRecordMediaInTransaction, readPendingRecordFamilyInTransaction };

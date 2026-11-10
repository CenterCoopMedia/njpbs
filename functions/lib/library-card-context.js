"use strict";

const { createHash } = require("node:crypto");
const { shapeJoinedRecord, joinedAssetIds } = require("./joined-records");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { selectedAssets } = require("./public-content-projection");
const { mediaReplacementRef } = require("./media-replacement");

function refuse(message) { throw Object.assign(new Error(message), { status: 409 }); }

async function assertLibraryCardMedia({ firestore, transaction, record }) {
  const assetIds = joinedAssetIds(record ? [record] : []);
  if (!assetIds.length) return;
  const rows = await transaction.getAll(...assetIds.flatMap(id => [
    firestore.doc(`media_assets/${id}`), firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id),
  ]));
  let uploadedMediaReady = false;
  if (assetIds.some((_id, index) => rows[index * 3].data()?.source === "upload")) {
    assertMediaLifecycleDeploymentFence((await transaction.get(firestore.doc("system/publicDeployment"))).data());
    uploadedMediaReady = true;
  }
  const assets = new Map(assetIds.map((id, index) => {
    if (rows[index * 3 + 2].exists) refuse("A library card image replacement is in progress.");
    return [id, assertPublishedAssetProjection({ assetId: id, owner: "approved library card",
      privateSnapshot: rows[index * 3], publicSnapshot: rows[index * 3 + 1], uploadedMediaReady })];
  }));
  selectedAssets({ assetIds }, assets);
}

/** Prepare the public dependency before writes. The lifecycle caller owns
 * authorization, validation and the atomic history row; working saves stay private. */
async function prepareLibraryCardContextInTransaction({ firestore, transaction, collection, documentId,
  beforeDocument, nextDocument, action }) {
  if (collection !== "cmsPosts" || !["sponsor", "newsletter"].includes(nextDocument?.type) ||
      !["approve", "archive", "unpublish"].includes(action)) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(documentId ?? "") || beforeDocument?.type !== nextDocument.type ||
      !Number.isSafeInteger(beforeDocument?.version) || beforeDocument.version < 1 ||
      !Number.isSafeInteger(nextDocument.version) || nextDocument.version !== beforeDocument.version + 1 ||
      action === "approve" && (nextDocument.status !== "approved" || nextDocument.deleted)) {
    refuse("The library card lifecycle identity changed.");
  }
  const snapshot = await transaction.get(firestore.collection("cmsVersionHistory")
    .where("collection", "==", collection).where("documentId", "==", documentId));
  const history = snapshot.docs.map(row => row.data());
  const nextHistory = [...history, { collection, documentId, action, before: beforeDocument, after: nextDocument }];
  // Both projections use the same approved-history reader as live Post joins.
  // The new history entry is committed by the caller alongside its record write.
  const before = shapeJoinedRecord(documentId, beforeDocument, history);
  const record = shapeJoinedRecord(documentId, nextDocument, nextHistory);
  if (action === "approve" && !record) refuse("The approved library card history is unavailable.");
  if (!before && !record) return null;
  await assertLibraryCardMedia({ firestore, transaction, record });
  return { operation: { schemaVersion: 1, recordId: documentId, kind: nextDocument.type, action,
    sourceVersion: nextDocument.version, withdrawal: record === null,
    projectionDigest: createHash("sha256").update(JSON.stringify(record)).digest("hex") }, record };
}

module.exports = { prepareLibraryCardContextInTransaction };

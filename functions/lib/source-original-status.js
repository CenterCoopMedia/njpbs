"use strict";

const { originalAvailability } = require("./source-original-state");
const ORIGINAL_STATUS = "mediaSourceOriginalStatus";

function originalStatusRef(firestore, assetId) {
  return firestore.collection(ORIGINAL_STATUS).doc(assetId);
}

async function readOriginalStatuses(firestore, assets) {
  if (!assets.length) return new Map();
  const references = assets.map(asset => originalStatusRef(firestore, asset.id));
  const snapshots = typeof firestore.getAll === "function"
    ? await firestore.getAll(...references) : await Promise.all(references.map(ref => ref.get()));
  return new Map(assets.map((asset, index) => [asset.id, originalAvailability(snapshots[index].data(), asset)]));
}

module.exports = { ORIGINAL_STATUS, originalStatusRef, readOriginalStatuses };

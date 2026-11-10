"use strict";

const { randomUUID } = require("node:crypto");
const SEARCH_SHARDS = "mediaSourceSearchShards";
const SEARCH_STATE = "mediaSourceSearchState";

function bumpVideoSearchEpoch(tx, firestore, state = {}) {
  const epoch = randomUUID();
  tx.set(firestore.collection(SEARCH_STATE).doc("video-library"), { ...state, epoch }, { merge: true });
  return epoch;
}

// Bulk writers queue their whole transaction here, with ONE source epoch write.
// No transaction-object cache: Firestore can retry with the same transaction.
function enqueueVideoSearchShards(tx, firestore, assetIds, sourceId = "video-library", state) {
  if (sourceId !== "video-library") return;
  for (const assetId of new Set(assetIds)) {
    tx.set(firestore.collection(SEARCH_SHARDS).doc(assetId), {
      sourceId, generation: randomUUID(), pending: true, tombstone: true,
      requestedAt: new Date().toISOString(),
    });
  }
  if (assetIds.length || state) return bumpVideoSearchEpoch(tx, firestore, state);
}

// Pending is an immediate tombstone, committed with the authoritative change.
function enqueueVideoSearchShard(tx, firestore, assetId, sourceId = "video-library") {
  return enqueueVideoSearchShards(tx, firestore, [assetId], sourceId);
}

module.exports = { SEARCH_SHARDS, SEARCH_STATE, bumpVideoSearchEpoch, enqueueVideoSearchShard, enqueueVideoSearchShards };

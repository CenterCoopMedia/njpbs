"use strict";

// One deterministic server-only document serializes binary replacement against every other
// asset mutation. The content-hash owner remains the durable cross-service recovery receipt.

function mediaReplacementRef(firestore, assetId) {
  return firestore.collection("system/media/replacements").doc(assetId);
}

module.exports = { mediaReplacementRef };

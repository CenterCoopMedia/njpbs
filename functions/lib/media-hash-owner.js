"use strict";

const { createHash } = require("node:crypto");

function ownerRef(firestore, contentHash, assetId) {
  // Archive attachment IDs own their own metadata and object lifecycle, even
  // when two attachments deliver identical bytes.
  const id = /^archive-[a-f0-9]{64}$/.test(assetId ?? "")
    ? createHash("sha256").update(`${assetId}:${contentHash}`).digest("hex")
    : contentHash;
  return firestore.collection("system").doc("media").collection("hashOwners").doc(id);
}

module.exports = { ownerRef };

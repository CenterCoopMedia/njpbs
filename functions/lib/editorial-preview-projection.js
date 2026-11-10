"use strict";
const { ownsPublication } = require("./publication-runtime-owner");
const digest = /^[a-f0-9]{64}$/;

function verifiedPreviewProjection(preparation, runtime, contextDigest) {
  const projection = preparation?.previewProjection;
  return projection?.schemaVersion === 1 && projection.status === "verified" &&
    ownsPublication(preparation, runtime) && preparation.contextDigest === contextDigest &&
    digest.test(projection.digest ?? "") && digest.test(projection.inputDigest ?? "") &&
    projection.inputDigest === preparation.inputDigest;
}
module.exports = { verifiedPreviewProjection };

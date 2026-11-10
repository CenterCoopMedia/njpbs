"use strict";
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
function publicReleasePairStaticTargetClaimPath(pair, claimDigest) {
  if (!protocol.digest(claimDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/staticReceiptClaims/${claimDigest}`;
}
function publicReleasePairStaticTargetProofPath(pair, manifestDigest) {
  if (!protocol.digest(manifestDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/staticReceipts/${manifestDigest}`;
}
function parsePublicReleasePairStaticTargetProof(value, rawPair, rawIdentity, claimDigest, manifestDigest, targetDigest, readbackDigest) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "status", "pairDigest", "taskId", "identity", "claimDigest", "viewManifestDigest", "viewReadbackDigest",
    "inputManifestDigest", "descriptor", "sourcePublicationDigest", "sourceStatusDigest", "targetPublicationDigest", "targetStatusDigest"]);
  protocol.exact(value.descriptor, ["digest", "key", "bytes"]);
  if (value.schemaVersion !== 1 || value.kind !== "pair-static-target-proof" || value.status !== "staged" ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.taskId !== protocol.publicReleaseDigest(identity) || !same(value.identity, identity) ||
      value.claimDigest !== claimDigest || value.viewManifestDigest !== manifestDigest || value.viewReadbackDigest !== readbackDigest ||
      value.inputManifestDigest !== identity.inputManifestDigest || !protocol.digest(targetDigest) || value.descriptor.digest !== targetDigest ||
      value.descriptor.key !== view.publicReleasePairViewObjectKey(pair, identity, claimDigest, targetDigest) ||
      !protocol.positive(value.descriptor.bytes) || value.descriptor.bytes > view.BODY_BYTES_LIMIT ||
      ![value.sourcePublicationDigest, value.sourceStatusDigest, value.targetPublicationDigest, value.targetStatusDigest, readbackDigest].every(protocol.digest)) refuse();
  return protocol.freeze({ ...value, identity });
}
module.exports = { publicReleasePairStaticTargetClaimPath, publicReleasePairStaticTargetProofPath, parsePublicReleasePairStaticTargetProof };

"use strict";
const p = require("./public-release-pair");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
/** Pure validation shared by SDK owners and frozen public projections. */
function parsePairMedia(value, selector) {
  p.exact(value, ["schemaVersion", "epoch", "activeGeneration", "lastReservedGeneration", "newestEligibleGeneration", "references"]);
  const refuse = () => { throw new p.PublicReleaseProtocolError(); };
  if (value.schemaVersion !== 2 || value.epoch !== selector.epoch ||
      [value.activeGeneration, value.lastReservedGeneration, value.newestEligibleGeneration].some(n => n !== selector.activeGeneration) ||
      !Array.isArray(value.references) || value.references.length < 2 || value.references.length > 8) refuse();
  const pairs = value.references.map(ref => {
    p.exact(ref, ["pairId", "manifestDigest"]);
    if (!isPublicDeploymentIdentifier(ref.pairId) || !p.digest(ref.manifestDigest)) refuse();
    return ref.pairId;
  });
  if (new Set(pairs).size !== pairs.length || !pairs.includes(selector.selectedPair.pairId) || !pairs.includes(selector.recoveryPair.pairId)) refuse();
  return value;
}
module.exports = { parsePairMedia };

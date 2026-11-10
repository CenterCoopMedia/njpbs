"use strict";
const p = require("./public-release-pair");
const runtime = require("./cms-publication-runtime-control");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
function refuse() { throw new p.PublicReleaseProtocolError(); }
function publicReleaseSwitchLineagePath(operationId) {
  if (!isPublicDeploymentIdentifier(operationId)) refuse();
  return `system/publicReleaseSwitchLineage/entries/${operationId}`;
}
function parsePublicReleaseSwitchLineage(value, next) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "priorSelectorDigest", "selectorDigest", "previousSelector", "pins"]);
  const selector = p.parsePublicReleaseSelector(next), previous = p.parsePublicReleaseSelector(value.previousSelector);
  const pins = runtime.parseCmsPublicationRuntimeControl(value.pins);
  if (value.schemaVersion !== 2 || value.kind !== "public-release-switch-lineage" || value.operationId !== selector.switchOperationId ||
      value.priorSelectorDigest !== selector.priorSelectorDigest || value.priorSelectorDigest !== p.publicReleaseDigest(previous) ||
      value.selectorDigest !== p.publicReleaseDigest(selector) || previous.epoch + 1 !== selector.epoch ||
      previous.activeGeneration + 1 !== selector.activeGeneration || previous.admittedContractDigest !== selector.admittedContractDigest ||
      [pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== previous.activeCommitSha)) refuse();
  return p.freeze({ ...value, previousSelector: previous, pins });
}
function publicReleaseSwitchLineage(before, pins, after) {
  return parsePublicReleaseSwitchLineage({ schemaVersion: 2, kind: "public-release-switch-lineage", operationId: after.switchOperationId,
    priorSelectorDigest: p.publicReleaseDigest(before), selectorDigest: p.publicReleaseDigest(after), previousSelector: before, pins }, after);
}
module.exports = { publicReleaseSwitchLineagePath, parsePublicReleaseSwitchLineage, publicReleaseSwitchLineage };

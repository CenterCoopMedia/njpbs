"use strict";

const { createHash } = require("node:crypto");
const { assertPublicDeploymentPointer, isPublicDeploymentIdentifier, isCommitSha, timestampMillis } = require("./public-deployment-pointer");

// Deliberately separate from the legacy pointer parser. Importing this module
// never teaches a legacy writer to accept, project or enable schema two.
const PUBLIC_RELEASE_PROTOCOL = 2;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

class PublicReleaseProtocolError extends Error {
  constructor() {
    super("The public release protocol record is invalid");
    this.name = "PublicReleaseProtocolError";
    this.status = 409;
  }
}

function refuse() { throw new PublicReleaseProtocolError(); }
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) refuse();
}
function digest(value) { return typeof value === "string" && DIGEST.test(value); }
function uuid(value) { return typeof value === "string" && UUID.test(value); }
function service(value) { return typeof value === "string" && SERVICE.test(value); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
// Call only after parsing: hashes are receipts, never a replacement for validation.
function publicReleaseDigest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function parsePublicReleasePairReference(value) {
  exact(value, ["pairId", "commitSha", "publicWorkerVersionId"]);
  const parts = typeof value.pairId === "string" ? value.pairId.split(":") : [];
  if (parts.length !== 2 || !service(parts[0]) || !uuid(parts[1]) ||
      !isPublicDeploymentIdentifier(value.pairId) || !isCommitSha(value.commitSha) ||
      !uuid(value.publicWorkerVersionId)) refuse();
  return Object.freeze({ ...value });
}

function parsePublicReleasePair(value) {
  const digests = ["rendererDigest", "environmentDigest", "bindingsDigest", "codeAssetManifestDigest",
    "readerContractDigest", "readerReceiptDigest", "capabilityDigest"];
  exact(value, ["schemaVersion", "pairId", "environment", "commitSha", "publisher", "publicWorker", ...digests]);
  exact(value.publisher, ["application", "workerVersionId", "imageDigest", "journalNamespace"]);
  exact(value.publicWorker, ["service", "incarnation", "versionId"]);
  if (value.schemaVersion !== PUBLIC_RELEASE_PROTOCOL || !["production", "development"].includes(value.environment) ||
      !isCommitSha(value.commitSha) || digests.some(key => !digest(value[key])) ||
      !service(value.publisher.application) || !uuid(value.publisher.workerVersionId) ||
      typeof value.publisher.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.publisher.imageDigest) ||
      !isPublicDeploymentIdentifier(value.publisher.journalNamespace) ||
      !service(value.publicWorker.service) || !uuid(value.publicWorker.incarnation) || !uuid(value.publicWorker.versionId) ||
      value.pairId !== `${value.publicWorker.service}:${value.publicWorker.incarnation}` ||
      !isPublicDeploymentIdentifier(value.pairId)) refuse();
  return freeze({ ...value, publisher: { ...value.publisher }, publicWorker: { ...value.publicWorker } });
}

function publicReleasePairReference(value) {
  const pair = parsePublicReleasePair(value);
  return parsePublicReleasePairReference({ pairId: pair.pairId, commitSha: pair.commitSha,
    publicWorkerVersionId: pair.publicWorker.versionId });
}

function parsePublicReleaseSelector(value) {
  exact(value, ["schemaVersion", "state", "mediaLifecycleReady", "epoch", "activeGeneration", "activeDeploymentId",
    "activeCommitSha", "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId",
    "selectedPair", "recoveryPair", "contentHead", "admittedContractDigest", "priorSelectorDigest",
    "switchOperationId", "proofDigest"]);
  const selectedPair = parsePublicReleasePairReference(value.selectedPair);
  const recoveryPair = parsePublicReleasePairReference(value.recoveryPair);
  exact(value.contentHead, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
  if (value.schemaVersion !== PUBLIC_RELEASE_PROTOCOL || value.state !== "idle" || value.mediaLifecycleReady !== true ||
      !positive(value.epoch) || !positive(value.activeGeneration) || !isPublicDeploymentIdentifier(value.activeDeploymentId) ||
      value.activeCommitSha !== selectedPair.commitSha || value.lastReservedGeneration !== value.activeGeneration ||
      value.newestEligibleGeneration !== value.activeGeneration || !isPublicDeploymentIdentifier(value.newestEligibleBuildBatchId) ||
      selectedPair.pairId === recoveryPair.pairId || selectedPair.publicWorkerVersionId === recoveryPair.publicWorkerVersionId ||
      value.contentHead.pairId !== selectedPair.pairId || !isPublicDeploymentIdentifier(value.contentHead.viewId) || !digest(value.contentHead.manifestDigest) ||
      !Number.isSafeInteger(value.contentHead.contextSequence) || value.contentHead.contextSequence < 0 ||
      !["admittedContractDigest", "priorSelectorDigest", "proofDigest"].every(key => digest(value[key])) ||
      !isPublicDeploymentIdentifier(value.switchOperationId)) refuse();
  return freeze({ ...value, selectedPair, recoveryPair, contentHead: { ...value.contentHead } });
}

// For future read-only consumers only. All existing writers keep calling the
// schema-one assertion, which continues to refuse this protocol.
function parseStoredPublicReleaseSelector(value) {
  if (value && Object.hasOwn(value, "updatedAt")) {
    const { updatedAt, ...selector } = value;
    if (timestampMillis(updatedAt) === null) refuse();
    return parsePublicReleaseSelector(selector);
  }
  return parsePublicReleaseSelector(value);
}
function parseVersionedPublicDeployment(value) {
  return value?.schemaVersion === PUBLIC_RELEASE_PROTOCOL
    ? parseStoredPublicReleaseSelector(value) : assertPublicDeploymentPointer(value);
}

module.exports = { PUBLIC_RELEASE_PROTOCOL, PublicReleaseProtocolError, parsePublicReleasePair,
  parsePublicReleasePairReference, publicReleasePairReference, parsePublicReleaseSelector,
  parseStoredPublicReleaseSelector, parseVersionedPublicDeployment, publicReleaseDigest, exact, digest, positive, freeze };

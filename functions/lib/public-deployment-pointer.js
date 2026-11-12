"use strict";

// Pure pointer contracts shared by Node writers and the private Worker. Keep
// build/static-return dependencies in public-deployment.js, out of this graph.
const { Buffer } = require("node:buffer");
const { publicationRuntime } = require("./publication-runtime-owner");

const PUBLIC_DEPLOYMENT_SCHEMA_VERSION = 1;
class PublicDeploymentFenceError extends Error {
  constructor(message = "Media lifecycle changes are temporarily unavailable.") {
    super(message);
    this.name = "PublicDeploymentFenceError";
    this.status = 503;
  }
}
const PUBLIC_DEPLOYMENT_POINTER_FIELDS = [
  "schemaVersion",
  "mediaLifecycleReady",
  "state",
  "activeGeneration",
  "activeDeploymentId",
  "activeCommitSha",
  "lastReservedGeneration",
  "newestEligibleGeneration",
  "newestEligibleBuildBatchId",
  "updatedAt",
];
const PUBLIC_DEPLOYMENT_IDLE_FIELDS = new Set(PUBLIC_DEPLOYMENT_POINTER_FIELDS);
const PUBLIC_DEPLOYMENT_DEPLOYING_FIELDS = new Set([
  "runtime",
  ...PUBLIC_DEPLOYMENT_POINTER_FIELDS,
  "leaseToken",
  "leaseAcquiredAt",
  "candidateGeneration",
  "candidateBuildBatchId",
  "candidateCommitSha",
  "predecessorGeneration",
  "predecessorDeploymentId",
  "predecessorCommitSha",
]);
const PUBLIC_DEPLOYMENT_RECONCILING_FIELDS = new Set([
  ...PUBLIC_DEPLOYMENT_DEPLOYING_FIELDS,
  "reconcilingAt",
  "cloudflareEvidenceDigest",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const FIRESTORE_RESERVED_IDENTIFIER = /^__.*__$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

class PublicDeploymentStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicDeploymentStateError";
    this.status = 409;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPublicDeploymentIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    SAFE_IDENTIFIER.test(value) &&
    value !== "." &&
    value !== ".." &&
    !FIRESTORE_RESERVED_IDENTIFIER.test(value)
  );
}

function isCommitSha(value) {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((field) => fields.has(field));
}

function validDeploymentReceipt(generation, deploymentId, commitSha) {
  return (
    (generation === 0 && deploymentId === null && commitSha === null) ||
    (generation > 0 &&
      isPublicDeploymentIdentifier(deploymentId) &&
      isCommitSha(commitSha))
  );
}

function initialPublicDeploymentPointer() {
  return {
    schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: 0,
    activeDeploymentId: null,
    activeCommitSha: null,
    lastReservedGeneration: 0,
    newestEligibleGeneration: 0,
    newestEligibleBuildBatchId: null,
  };
}

function assertPublicDeploymentPointer(value) {
  const pointerFields =
    value?.state === "idle"
      ? PUBLIC_DEPLOYMENT_IDLE_FIELDS
      : value?.state === "deploying"
        ? PUBLIC_DEPLOYMENT_DEPLOYING_FIELDS
        : value?.state === "reconciling"
          ? PUBLIC_DEPLOYMENT_RECONCILING_FIELDS
        : null;
  if (
    !plainObject(value) ||
    pointerFields === null ||
    !hasOnlyFields(value, pointerFields) ||
    value.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    typeof value.mediaLifecycleReady !== "boolean" ||
    !Number.isSafeInteger(value.activeGeneration) ||
    value.activeGeneration < 0 ||
    !Number.isSafeInteger(value.lastReservedGeneration) ||
    value.lastReservedGeneration < value.activeGeneration ||
    !Number.isSafeInteger(value.newestEligibleGeneration) ||
    value.newestEligibleGeneration < value.activeGeneration ||
    value.newestEligibleGeneration > value.lastReservedGeneration ||
    (value.newestEligibleGeneration === 0 &&
      value.newestEligibleBuildBatchId !== null) ||
    (value.newestEligibleGeneration > 0 &&
      !isPublicDeploymentIdentifier(value.newestEligibleBuildBatchId)) ||
    (value.activeGeneration === 0 &&
      (value.activeDeploymentId !== null ||
        value.activeCommitSha !== null ||
        value.mediaLifecycleReady !== false)) ||
    !validDeploymentReceipt(
      value.activeGeneration,
      value.activeDeploymentId,
      value.activeCommitSha,
    ) ||
    (Object.prototype.hasOwnProperty.call(value, "updatedAt") &&
      timestampMillis(value.updatedAt) === null)
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment coordinator is invalid",
    );
  }

  if (
    (value.state === "deploying" || value.state === "reconciling") &&
    (!isPublicDeploymentIdentifier(value.leaseToken) ||
      timestampMillis(value.leaseAcquiredAt) === null ||
      !Number.isSafeInteger(value.candidateGeneration) ||
      value.candidateGeneration <= value.activeGeneration ||
      value.candidateGeneration > value.newestEligibleGeneration ||
      !isPublicDeploymentIdentifier(value.candidateBuildBatchId) ||
      (value.candidateGeneration === value.newestEligibleGeneration &&
        value.candidateBuildBatchId !== value.newestEligibleBuildBatchId) ||
      !isCommitSha(value.candidateCommitSha) ||
      value.predecessorGeneration !== value.activeGeneration ||
      value.predecessorDeploymentId !== value.activeDeploymentId ||
      value.predecessorCommitSha !== value.activeCommitSha)
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment coordinator is invalid",
    );
  }
  if (
    value.state === "reconciling" &&
    (timestampMillis(value.reconcilingAt) === null ||
      timestampMillis(value.reconcilingAt) <
        timestampMillis(value.leaseAcquiredAt) ||
      !DIGEST.test(value.cloudflareEvidenceDigest))
  ) {
    throw new PublicDeploymentStateError(
      "The public deployment coordinator is invalid",
    );
  }
  if (value.runtime !== undefined) publicationRuntime(value.runtime);
  return value;
}

/** Read-only compatibility for a converted root. Never use this projection to
 * authorize a lease, reserve a generation or admit source/media writes. Those
 * owners must keep the schema-one assertion or use actual pair authority. */
function readPublicDeploymentPointer(value) {
  if (value?.schemaVersion !== 2) return assertPublicDeploymentPointer(value);
  const selector = require("./public-release-pair").parseStoredPublicReleaseSelector(value);
  const projected = Object.fromEntries(PUBLIC_DEPLOYMENT_POINTER_FIELDS.filter(key => key !== "updatedAt")
    .map(key => [key, key === "schemaVersion" ? PUBLIC_DEPLOYMENT_SCHEMA_VERSION : selector[key]]));
  if (Object.hasOwn(value, "updatedAt")) projected.updatedAt = value.updatedAt;
  return Object.freeze(assertPublicDeploymentPointer(projected));
}

// Immutable uploads stay readable while the next generation is leased.
function assertPublishedMediaReadiness(value) {
  let pointer;
  try { pointer = readPublicDeploymentPointer(value); }
  catch { throw new PublicDeploymentFenceError(); }
  if (pointer.mediaLifecycleReady !== true || pointer.activeGeneration < 1) {
    throw new PublicDeploymentFenceError();
  }
  return pointer;
}

function assertMediaLifecycleDeploymentFence(value) {
  let pointer;
  try {
    pointer = assertPublicDeploymentPointer(value);
  } catch {
    throw new PublicDeploymentFenceError();
  }
  const ready = Boolean(
    pointer.mediaLifecycleReady === true &&
    pointer.state === "idle" &&
    pointer.activeGeneration > 0 &&
    pointer.newestEligibleGeneration === pointer.activeGeneration &&
    pointer.lastReservedGeneration === pointer.activeGeneration,
  );
  if (!ready) throw new PublicDeploymentFenceError();
  return Object.freeze({
    generation: pointer.activeGeneration,
    deploymentId: pointer.activeDeploymentId,
    commitSha: pointer.activeCommitSha,
  });
}

module.exports = { PUBLIC_DEPLOYMENT_SCHEMA_VERSION, PublicDeploymentStateError, PublicDeploymentFenceError, assertPublishedMediaReadiness, assertMediaLifecycleDeploymentFence, plainObject, isPublicDeploymentIdentifier, isCommitSha, timestampMillis, hasOnlyFields, validDeploymentReceipt, initialPublicDeploymentPointer, assertPublicDeploymentPointer, readPublicDeploymentPointer };

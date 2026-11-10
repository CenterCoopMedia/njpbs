"use strict";

// Pure evidence projection for an already-active Cloudflare deployment. This
// module does not authorize or perform a deployment and does not call
// Cloudflare, Firestore, a queue, or a production handler.

const {
  PublicDeploymentStateError,
  assertPublicDeploymentLeaseReceipt,
} = require("./public-deployment");
const {
  projectPublicWorkerCandidate,
} = require("./public-worker-candidate");

const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
const RECONCILE_EVIDENCE = Object.freeze({ action: "reconcile" });
const DEPLOYMENT_SOURCES = Object.freeze({
  api: "api",
  wrangler: "wrangler",
});

class PublicWorkerActivationEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicWorkerActivationEvidenceError";
  }
}

function evidenceError(message) {
  throw new PublicWorkerActivationEvidenceError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validCalendarDateTime(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function canonicalDate(value) {
  const match = typeof value === "string" ? RFC3339_DATE_TIME.exec(value) : null;
  if (match === null || !validCalendarDateTime(match)) {
    evidenceError("The Cloudflare deployment timestamp is invalid");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    evidenceError("The Cloudflare deployment timestamp is invalid");
  }
  return new Date(millis).toISOString();
}

function alignedCandidate(leaseValue, candidateValue, target) {
  const lease = assertPublicDeploymentLeaseReceipt(leaseValue);
  const candidate = projectPublicWorkerCandidate(
    candidateValue,
    lease.buildBatchId,
    { target },
  );
  if (
    candidate.generation !== lease.generation ||
    candidate.commitSha !== lease.commitSha
  ) {
    throw new PublicDeploymentStateError(
      "The public Worker candidate does not match its deployment lease",
    );
  }
  return { lease, candidate };
}

function projectDeploymentStatus(value, expectedSource) {
  if (
    !Object.hasOwn(DEPLOYMENT_SOURCES, expectedSource) ||
    !plainObject(value) ||
    !CLOUDFLARE_UUID.test(value.id) ||
    value.source !== expectedSource ||
    value.strategy !== "percentage" ||
    !plainObject(value.annotations) ||
    value.annotations["workers/triggered_by"] !== "deployment" ||
    !Array.isArray(value.versions) ||
    value.versions.length !== 1
  ) {
    evidenceError("The Cloudflare deployment status is invalid");
  }
  const version = value.versions[0];
  if (
    !plainObject(version) ||
    !CLOUDFLARE_UUID.test(version.version_id) ||
    version.percentage !== 100
  ) {
    evidenceError("The active Cloudflare deployment is ambiguous");
  }
  return Object.freeze({
    deploymentId: value.id.toLowerCase(),
    versionId: version.version_id.toLowerCase(),
    createdOn: canonicalDate(value.created_on),
  });
}

function projectApiDeploymentStatus(value) {
  return projectDeploymentStatus(value, DEPLOYMENT_SOURCES.api);
}

function projectWranglerDeploymentStatus(value) {
  return projectDeploymentStatus(value, DEPLOYMENT_SOURCES.wrangler);
}

function planPublicWorkerActivationEvidence({
  lease: leaseValue,
  candidate: candidateValue,
  deploymentStatus,
  deploymentSource = DEPLOYMENT_SOURCES.wrangler,
  target,
} = {}) {
  const { lease, candidate } = alignedCandidate(leaseValue, candidateValue, target);
  let active;
  try {
    active = projectDeploymentStatus(deploymentStatus, deploymentSource);
  } catch (error) {
    if (error instanceof PublicWorkerActivationEvidenceError) {
      return RECONCILE_EVIDENCE;
    }
    throw error;
  }
  if (active.versionId !== candidate.workerVersionId) {
    return RECONCILE_EVIDENCE;
  }
  return Object.freeze({
    action: "activate",
    buildBatchId: lease.buildBatchId,
    deploymentId: active.deploymentId,
    versionId: active.versionId,
    commitSha: lease.commitSha,
  });
}

module.exports = {
  PublicWorkerActivationEvidenceError,
  planPublicWorkerActivationEvidence,
  projectApiDeploymentStatus,
  projectWranglerDeploymentStatus,
};

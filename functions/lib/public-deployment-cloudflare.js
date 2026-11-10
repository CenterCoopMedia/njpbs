"use strict";

const { createHash } = require("node:crypto");
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
  projectPublicDeploymentRestoreReceipt,
} = require("./public-deployment");

const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
const BUILD_STATUSES = new Set([
  "queued",
  "initializing",
  "running",
  "stopped",
]);
const BUILD_OUTCOMES = new Set([
  "success",
  "fail",
  "skipped",
  "cancelled",
  "terminated",
]);
const TERMINAL_FAILURE_OUTCOMES = new Set([
  "fail",
  "cancelled",
  "terminated",
]);
const LEASE_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "leaseToken",
  "leaseAcquiredAt",
  "predecessorGeneration",
  "predecessorDeploymentId",
  "predecessorCommitSha",
]);
const RECONCILE_FIELDS = new Set(["action"]);
const ACTIVATE_FIELDS = new Set([
  "action",
  "buildBatchId",
  "deploymentId",
  "versionId",
  "commitSha",
]);
const TERMINAL_FAILURE_FIELDS = new Set([
  "action",
  "buildBatchId",
  "outcome",
]);
const RECONCILE_PLAN = Object.freeze({ action: "reconcile" });

class PublicDeploymentCloudflareEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicDeploymentCloudflareEvidenceError";
  }
}

function evidenceError(message) {
  throw new PublicDeploymentCloudflareEvidenceError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every((field) => fields.has(field));
}

function isCloudflareUuid(value) {
  return typeof value === "string" && CLOUDFLARE_UUID.test(value);
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isBoundedExactText(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !hasControlCharacter(value)
  );
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDateTime(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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

function canonicalDate(value, required = true) {
  if (value === undefined || value === null) {
    if (!required) return null;
    evidenceError("The Cloudflare evidence timestamp is missing");
  }
  const match = typeof value === "string" ? RFC3339_DATE_TIME.exec(value) : null;
  if (match === null || !validCalendarDateTime(match)) {
    evidenceError("The Cloudflare evidence timestamp is invalid");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    evidenceError("The Cloudflare evidence timestamp is invalid");
  }
  return new Date(millis).toISOString();
}

function safeTimestampMillis(value) {
  try {
    return timestampMillis(value);
  } catch {
    return null;
  }
}

function responseResult(response, label) {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !plainObject(response.result)
  ) {
    evidenceError(`The Cloudflare ${label} response is invalid`);
  }
  return response.result;
}

function projectCloudflareBuildObservation(response) {
  const result = responseResult(response, "build");
  const metadata = result.build_trigger_metadata;
  const trigger = result.trigger;
  const status = result.status ?? null;
  const outcome = result.build_outcome ?? null;

  if (
    !isCloudflareUuid(result.build_uuid) ||
    !plainObject(metadata) ||
    !isCommitSha(metadata.commit_hash) ||
    !isBoundedExactText(metadata.branch, 255) ||
    !plainObject(trigger) ||
    !isPublicDeploymentIdentifier(trigger.external_script_id) ||
    (status !== null && !BUILD_STATUSES.has(status)) ||
    (outcome !== null && !BUILD_OUTCOMES.has(outcome))
  ) {
    evidenceError("The Cloudflare build evidence is invalid");
  }

  return Object.freeze({
    buildUuid: result.build_uuid,
    commitSha: metadata.commit_hash,
    branch: metadata.branch,
    externalScriptId: trigger.external_script_id,
    status,
    outcome,
    createdOn: canonicalDate(result.created_on),
    stoppedOn: canonicalDate(result.stopped_on, false),
  });
}

function projectCloudflareActiveDeploymentObservation(response) {
  const result = responseResult(response, "deployment");
  if (!Array.isArray(result.deployments)) {
    evidenceError("The Cloudflare deployment list is invalid");
  }
  if (result.deployments.length === 0) return null;

  const active = result.deployments[0];
  if (
    !plainObject(active) ||
    !isCloudflareUuid(active.id) ||
    active.strategy !== "percentage" ||
    !Array.isArray(active.versions) ||
    active.versions.length !== 1
  ) {
    evidenceError("The active Cloudflare deployment is ambiguous");
  }

  const version = active.versions[0];
  if (
    !plainObject(version) ||
    version.percentage !== 100 ||
    !isCloudflareUuid(version.version_id)
  ) {
    evidenceError("The active Cloudflare deployment is ambiguous");
  }

  return Object.freeze({
    deploymentId: active.id,
    versionId: version.version_id,
    percentage: version.percentage,
    createdOn: canonicalDate(active.created_on),
  });
}

function projectCloudflareVersionBuildObservation(response, versionId) {
  if (!isCloudflareUuid(versionId)) {
    evidenceError("The Cloudflare version id is invalid");
  }
  const result = responseResult(response, "version build");
  if (!plainObject(result.builds)) {
    evidenceError("The Cloudflare version build map is invalid");
  }
  const keys = Object.keys(result.builds);
  if (keys.length !== 1 || keys[0] !== versionId) {
    evidenceError("The Cloudflare version build map is ambiguous");
  }
  return projectCloudflareBuildObservation({
    success: true,
    result: result.builds[versionId],
  });
}

function projectCandidate(lease, expectedBranch, expectedExternalScriptId) {
  if (
    !plainObject(lease) ||
    !hasOnlyFields(lease, LEASE_FIELDS) ||
    lease.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    !isCloudflareUuid(lease.buildBatchId) ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1 ||
    !isCommitSha(lease.commitSha) ||
    !isPublicDeploymentIdentifier(lease.leaseToken) ||
    safeTimestampMillis(lease.leaseAcquiredAt) === null ||
    !Number.isSafeInteger(lease.predecessorGeneration) ||
    lease.predecessorGeneration < 0 ||
    lease.predecessorGeneration >= lease.generation ||
    !isBoundedExactText(expectedBranch, 255) ||
    !isPublicDeploymentIdentifier(expectedExternalScriptId) ||
    (lease.predecessorGeneration === 0 &&
      (lease.predecessorDeploymentId !== null ||
        lease.predecessorCommitSha !== null)) ||
    (lease.predecessorGeneration > 0 &&
      (!isCloudflareUuid(lease.predecessorDeploymentId) ||
        !isCommitSha(lease.predecessorCommitSha)))
  ) {
    evidenceError("The leased Cloudflare candidate is invalid");
  }
  return Object.freeze({
    buildBatchId: lease.buildBatchId,
    commitSha: lease.commitSha,
    branch: expectedBranch,
    externalScriptId: expectedExternalScriptId,
    predecessorGeneration: lease.predecessorGeneration,
    predecessorDeploymentId: lease.predecessorDeploymentId,
    predecessorCommitSha: lease.predecessorCommitSha,
  });
}

function sameBuildIdentity(observation, expected) {
  return Boolean(
    observation.buildUuid === expected.buildBatchId &&
      observation.commitSha === expected.commitSha &&
      observation.branch === expected.branch &&
      observation.externalScriptId === expected.externalScriptId,
  );
}

function activeCandidatePlan(candidate, active, activeBuild) {
  if (!sameBuildIdentity(activeBuild, candidate)) return null;
  return Object.freeze({
    action: "activate",
    buildBatchId: candidate.buildBatchId,
    deploymentId: active.deploymentId,
    versionId: active.versionId,
    commitSha: candidate.commitSha,
  });
}

function isExactPredecessor(candidate, active, activeBuild) {
  if (candidate.predecessorGeneration === 0) {
    return active === null;
  }
  return Boolean(
    active !== null &&
      active.deploymentId === candidate.predecessorDeploymentId &&
      activeBuild.buildUuid !== candidate.buildBatchId &&
      activeBuild.commitSha === candidate.predecessorCommitSha &&
      activeBuild.branch === candidate.branch &&
      activeBuild.externalScriptId === candidate.externalScriptId,
  );
}

function planPublicDeploymentCloudflareEvidence({
  lease,
  expectedBranch,
  expectedExternalScriptId,
  buildResponse,
  deploymentsResponse,
  buildsByVersionResponse,
} = {}) {
  try {
    const candidate = projectCandidate(
      lease,
      expectedBranch,
      expectedExternalScriptId,
    );
    const active = projectCloudflareActiveDeploymentObservation(
      deploymentsResponse,
    );
    const activeBuild =
      active === null
        ? null
        : projectCloudflareVersionBuildObservation(
            buildsByVersionResponse,
            active.versionId,
          );

    if (active !== null) {
      const activation = activeCandidatePlan(candidate, active, activeBuild);
      if (activation !== null) return activation;
    }

    const candidateBuild = projectCloudflareBuildObservation(buildResponse);
    if (
      !sameBuildIdentity(candidateBuild, candidate) ||
      candidateBuild.status !== "stopped" ||
      !TERMINAL_FAILURE_OUTCOMES.has(candidateBuild.outcome) ||
      !isExactPredecessor(candidate, active, activeBuild)
    ) {
      return RECONCILE_PLAN;
    }
    return Object.freeze({
      action: "terminal-failure",
      buildBatchId: candidate.buildBatchId,
      outcome: candidateBuild.outcome,
    });
  } catch (error) {
    if (error instanceof PublicDeploymentCloudflareEvidenceError) {
      return RECONCILE_PLAN;
    }
    throw error;
  }
}

function projectPublicDeploymentCloudflareEvidence(
  value,
  expectedBuildBatchId = null,
) {
  if (!plainObject(value)) {
    evidenceError("The Cloudflare evidence plan is invalid");
  }
  if (value.action === "reconcile") {
    if (!hasOnlyFields(value, RECONCILE_FIELDS)) {
      evidenceError("The Cloudflare evidence plan is invalid");
    }
    return Object.freeze({ action: "reconcile" });
  }
  if (value.action === "activate") {
    if (
      !hasOnlyFields(value, ACTIVATE_FIELDS) ||
      Object.keys(value).length !== ACTIVATE_FIELDS.size ||
      !isPublicDeploymentIdentifier(value.buildBatchId) ||
      (expectedBuildBatchId !== null &&
        value.buildBatchId !== expectedBuildBatchId) ||
      !isCloudflareUuid(value.deploymentId) ||
      !isCloudflareUuid(value.versionId) ||
      !isCommitSha(value.commitSha)
    ) {
      evidenceError("The Cloudflare evidence plan is invalid");
    }
    return Object.freeze({
      action: "activate",
      buildBatchId: value.buildBatchId,
      deploymentId: value.deploymentId,
      versionId: value.versionId,
      commitSha: value.commitSha,
    });
  }
  if (value.action === "restore-predecessor") {
    if (Object.keys(value).length !== 3 || !hasOnlyFields(value, new Set(["action", "buildBatchId", "predecessor"])) ||
        !isPublicDeploymentIdentifier(value.buildBatchId) ||
        (expectedBuildBatchId !== null && value.buildBatchId !== expectedBuildBatchId)) {
      evidenceError("The restored predecessor evidence is invalid");
    }
    return Object.freeze({ action: "restore-predecessor", buildBatchId: value.buildBatchId,
      predecessor: projectPublicDeploymentRestoreReceipt(value.predecessor) });
  }
  if (
    value.action !== "terminal-failure" ||
    !hasOnlyFields(value, TERMINAL_FAILURE_FIELDS) ||
    Object.keys(value).length !== TERMINAL_FAILURE_FIELDS.size ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    (expectedBuildBatchId !== null &&
      value.buildBatchId !== expectedBuildBatchId) ||
    !TERMINAL_FAILURE_OUTCOMES.has(value.outcome)
  ) {
    evidenceError("The Cloudflare evidence plan is invalid");
  }
  return Object.freeze({
    action: "terminal-failure",
    buildBatchId: value.buildBatchId,
    outcome: value.outcome,
  });
}

function publicDeploymentCloudflareEvidenceDigest(
  value,
  expectedBuildBatchId = null,
) {
  const projected = projectPublicDeploymentCloudflareEvidence(
    value,
    expectedBuildBatchId,
  );
  return createHash("sha256")
    .update(JSON.stringify(projected), "utf8")
    .digest("hex");
}

module.exports = {
  PublicDeploymentCloudflareEvidenceError,
  planPublicDeploymentCloudflareEvidence,
  projectPublicDeploymentCloudflareEvidence,
  projectCloudflareActiveDeploymentObservation,
  projectCloudflareBuildObservation,
  projectCloudflareVersionBuildObservation,
  publicDeploymentCloudflareEvidenceDigest,
};

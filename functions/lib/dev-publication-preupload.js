"use strict";

const { isDeepStrictEqual } = require("node:util");
const p = require("./public-release-pair");
const { publicationTarget, assertPublicationTarget } = require("./publication-target");
const { assertPublicDeploymentReservedBatch, timestampMillis } = require("./public-deployment");

const REASON = "dev_publish_failed_before_upload";
const FAILURE = "Retained dev renderer source differs";
const refuse = () => { throw new Error("Development pre-upload settlement refused"); };

function parseDevPreuploadSettlement(value) {
  p.exact(value, ["schemaVersion", "target", "identity", "generation", "inputDigest", "failure"]);
  assertPublicationTarget(value.target);
  p.exact(value.identity, ["queueId", "buildBatchId", "commitSha"]);
  p.exact(value.failure, ["runId", "runAttempt", "jobId", "completedAt", "code", "logDigest"]);
  const { identity, failure } = value;
  if (value.schemaVersion !== 1 || !isDeepStrictEqual(value.target, publicationTarget("development")) ||
      !/^[A-Za-z0-9]{20}$/.test(identity.queueId ?? "") || identity.buildBatchId !== `cms-${identity.queueId}` ||
      !/^[a-f0-9]{40}$/.test(identity.commitSha ?? "") || !p.positive(value.generation) || !p.digest(value.inputDigest) ||
      !/^[1-9][0-9]{0,19}$/.test(failure.runId ?? "") || !/^[1-9][0-9]{0,19}$/.test(failure.jobId ?? "") ||
      ![1, 2].includes(failure.runAttempt) || failure.code !== "retained_dev_renderer_source_differs" ||
      typeof failure.completedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(failure.completedAt) ||
      !Number.isFinite(Date.parse(failure.completedAt)) || !p.digest(failure.logDigest)) refuse();
  return value;
}

function assertDevPreuploadRetiredBatch(value, buildBatchId) {
  const { retiredAt, retirementReceipt: receipt, ...original } = value ?? {};
  assertPublicDeploymentReservedBatch({ ...original, status: "reserved" }, buildBatchId);
  p.exact(receipt, ["schemaVersion", "reason", "outcome", "request", "requestDigest",
    "originalQueueDigest", "originalBatchDigest", "originalInputDigest"]);
  const request = parseDevPreuploadSettlement(receipt.request);
  if (value.status !== "retired" || value.noBuildStaticInput !== undefined ||
      value.runtime?.owner !== "cloudflare" || value.runtime.release !== value.commitSha ||
      timestampMillis(retiredAt) === null || timestampMillis(retiredAt) < timestampMillis(value.reservedAt) ||
      receipt.schemaVersion !== 1 || receipt.reason !== REASON || receipt.outcome !== "failed_not_published" ||
      request.identity.buildBatchId !== value.buildBatchId || request.identity.commitSha !== value.commitSha ||
      request.generation !== value.generation || receipt.requestDigest !== p.publicReleaseDigest(request) ||
      ![receipt.originalQueueDigest, receipt.originalBatchDigest, receipt.originalInputDigest].every(p.digest) ||
      receipt.originalBatchDigest !== p.publicReleaseDigest({ ...original, status: "reserved" })) refuse();
  return value;
}

module.exports = { REASON, FAILURE, refuse, parseDevPreuploadSettlement, assertDevPreuploadRetiredBatch };

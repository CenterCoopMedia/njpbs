"use strict";

const { isDeepStrictEqual } = require("node:util");
const p = require("./public-release-pair");
const { publicationTarget } = require("./publication-target");
const { assertPublicDeploymentReservedBatch, timestampMillis } = require("./public-deployment");

const REASON = "dev_publish_failed_before_upload";
// Each accepted failure code names a refusal that precedes any upload, and the queue error it records.
const FAILURES = Object.freeze({
  retained_dev_renderer_source_differs: "Retained dev renderer source differs",
  dev_refresh_frozen_build_failed: "Dev refresh frozen build failed before upload",
  dev_refresh_content_check_failed: "Dev refresh content check failed before upload",
});
const FAILURE = FAILURES.retained_dev_renderer_source_differs;
const refuse = () => { throw new Error("Development pre-upload settlement refused"); };
// Some retired dev rows were sealed by an operator running the unrendered source,
// so their request holds the template development target, not the rendered one
// deployed Functions now carry. This file is not in config/development-inputs.json,
// so the renderer leaves these values as written. The two targets differ only in
// the names below; every other field must still equal the deployed target.
const TEMPLATE_DEVELOPMENT_NAMES = Object.freeze({ workerName: "template-dev-public",
  origin: "https://dev-public.example.org", previewBucket: "template-dev-cms-previews" });
const sealedTargets = () => [publicationTarget("development"),
  { ...publicationTarget("development"), ...TEMPLATE_DEVELOPMENT_NAMES }];

function parseDevPreuploadSettlement(value) {
  p.exact(value, ["schemaVersion", "target", "identity", "generation", "inputDigest", "failure"]);
  p.exact(value.identity, ["queueId", "buildBatchId", "commitSha"]);
  p.exact(value.failure, ["runId", "runAttempt", "jobId", "completedAt", "code", "logDigest"]);
  const { identity, failure } = value;
  if (value.schemaVersion !== 1 || !sealedTargets().some(target => isDeepStrictEqual(value.target, target)) ||
      !/^[A-Za-z0-9]{20}$/.test(identity.queueId ?? "") || identity.buildBatchId !== `cms-${identity.queueId}` ||
      !/^[a-f0-9]{40}$/.test(identity.commitSha ?? "") || !p.positive(value.generation) || !p.digest(value.inputDigest) ||
      !/^[1-9][0-9]{0,19}$/.test(failure.runId ?? "") || !/^[1-9][0-9]{0,19}$/.test(failure.jobId ?? "") ||
      ![1, 2].includes(failure.runAttempt) || typeof failure.code !== "string" || !Object.hasOwn(FAILURES, failure.code) ||
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

const failureMessage = code => typeof code === "string" && Object.hasOwn(FAILURES, code) ? FAILURES[code] : refuse();

module.exports = { REASON, FAILURE, FAILURES, failureMessage, refuse, parseDevPreuploadSettlement, assertDevPreuploadRetiredBatch };

"use strict";

const p = require("./public-release-pair");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const BOOTSTRAP_ADMISSION_FENCE_PATH = "system/publicReleaseAdmissions/controls/bootstrapFence";
const BOOTSTRAP_ADMISSION_ATTEMPTS = "system/publicReleaseAdmissions/bootstrapFences";
class PublicReleaseBootstrapAdmissionPausedError extends Error {
  constructor() {
    super("Publishing paused for an update. Please try again shortly.");
    this.name = "PublicReleaseBootstrapAdmissionPausedError";
    this.code = "public_release_bootstrap_admission_paused";
    this.status = 409;
    this.retryable = true;
    this.scheduleDeferred = true;
  }
}
function refuse() { throw new PublicReleaseBootstrapAdmissionPausedError(); }
function parseBootstrapAdmissionFence(value) {
  try {
    p.exact(value, ["schemaVersion", "operationId", "attemptDigest", "status", "resumeReceiptDigest"]);
    if (value.schemaVersion !== 2 || !isPublicDeploymentIdentifier(value.operationId) || !p.digest(value.attemptDigest) ||
        !["closed", "open"].includes(value.status) || (value.status === "closed" ? value.resumeReceiptDigest !== null : !p.digest(value.resumeReceiptDigest))) refuse();
    return p.freeze({ ...value });
  } catch { refuse(); }
}
/** Called on the already-read snapshot in the source transaction. */
function assertBootstrapAdmissionOpen(value) {
  if (value === undefined || value === null) return;
  if (parseBootstrapAdmissionFence(value).status !== "open") refuse();
}
module.exports = { BOOTSTRAP_ADMISSION_FENCE_PATH, BOOTSTRAP_ADMISSION_ATTEMPTS, PublicReleaseBootstrapAdmissionPausedError,
  parseBootstrapAdmissionFence, assertBootstrapAdmissionOpen };

#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { cert, deleteApp, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const {
  PublicDeploymentBootstrapEvidenceError,
  bootstrapPublicDeployment,
  projectPublicDeploymentBootstrapEvidence,
} = require("../functions/lib/public-deployment-bootstrap");
const {
  PublicDeploymentStateError,
  isCommitSha,
} = require("../functions/lib/public-deployment");
const {
  projectCloudflareActiveDeploymentObservation,
} = require("../functions/lib/public-deployment-cloudflare");

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_ACCOUNT_ID = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const FIREBASE_PROJECT_ID = "njpbs-site";
const PUBLIC_WORKER_NAME = "njpbs-production";
const PUBLIC_WORKER_TAG = (process.env.CLOUDFLARE_PUBLIC_WORKER_TAG ?? "");
const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
const MAX_SERVICE_ACCOUNT_BYTES = 64 * 1024;

class PublicDeploymentBootstrapOperatorError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicDeploymentBootstrapOperatorError";
  }
}

function operatorError(message) {
  throw new PublicDeploymentBootstrapOperatorError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseApplyArguments(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 2 ||
    args[0] !== "--apply" ||
    !isCommitSha(args[1])
  ) {
    operatorError(
      "Usage: node scripts/bootstrap-public-deployment.cjs --apply <40-character-production-commit>",
    );
  }
  return { expectedCommitSha: args[1] };
}

function parseCloudflareToken(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096) {
    operatorError("The Cloudflare credential input is invalid");
  }
  const firstLine = value.split(/\r?\n/, 1)[0];
  if (!CLOUDFLARE_TOKEN.test(firstLine)) {
    operatorError("The Cloudflare credential input is invalid");
  }
  return firstLine;
}

function parseFirebaseServiceAccount(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_SERVICE_ACCOUNT_BYTES
  ) {
    operatorError("The Firebase credential input is invalid");
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(value);
  } catch {
    operatorError("The Firebase credential input is invalid");
  }
  if (
    !plainObject(serviceAccount) ||
    serviceAccount.type !== "service_account" ||
    serviceAccount.project_id !== FIREBASE_PROJECT_ID ||
    typeof serviceAccount.client_email !== "string" ||
    serviceAccount.client_email.length === 0 ||
    typeof serviceAccount.private_key !== "string" ||
    serviceAccount.private_key.length === 0
  ) {
    operatorError("The Firebase credential input is invalid");
  }
  return serviceAccount;
}

function assertCloudflareWorkerIdentity(response) {
  if (
    !plainObject(response) ||
    response.success !== true ||
    !Array.isArray(response.result)
  ) {
    operatorError("The Cloudflare Worker list response is invalid");
  }
  const matches = response.result.filter(
    (worker) => plainObject(worker) && worker.id === PUBLIC_WORKER_NAME,
  );
  if (matches.length !== 1 || matches[0].tag !== PUBLIC_WORKER_TAG) {
    operatorError("The Cloudflare Worker identity is invalid");
  }
  return PUBLIC_WORKER_TAG;
}

async function defaultRequestJson(url, cloudflareApiToken) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${cloudflareApiToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    operatorError("The Cloudflare API request did not complete");
  }
  if (!response.ok) {
    operatorError(`The Cloudflare API returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    operatorError("The Cloudflare API response was not JSON");
  }
}

function workerApiPath(suffix) {
  return `${CLOUDFLARE_API}/accounts/${CLOUDFLARE_ACCOUNT_ID}${suffix}`;
}

async function collectActiveEvidence({
  cloudflareApiToken,
  expectedExternalScriptId,
  requestJson,
}) {
  const deploymentsResponse = await requestJson(
    workerApiPath(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`),
    cloudflareApiToken,
  );
  let active;
  try {
    active = projectCloudflareActiveDeploymentObservation(deploymentsResponse);
  } catch {
    operatorError("The active Cloudflare deployment response is invalid");
  }
  if (active === null) {
    operatorError("The public Worker has no active deployment");
  }
  const buildsByVersionResponse = await requestJson(
    workerApiPath(`/builds/builds?version_ids=${active.versionId}`),
    cloudflareApiToken,
  );
  try {
    return projectPublicDeploymentBootstrapEvidence({
      workerName: PUBLIC_WORKER_NAME,
      expectedExternalScriptId,
      deploymentsResponse,
      buildsByVersionResponse,
    });
  } catch {
    operatorError("The active Cloudflare deployment evidence is invalid");
  }
}

async function runPublicDeploymentBootstrapOperator({
  firestore,
  cloudflareApiToken,
  expectedCommitSha,
  requestJson = defaultRequestJson,
  bootstrapFn = bootstrapPublicDeployment,
} = {}) {
  if (
    !firestore ||
    !CLOUDFLARE_TOKEN.test(cloudflareApiToken) ||
    !isCommitSha(expectedCommitSha) ||
    typeof requestJson !== "function" ||
    typeof bootstrapFn !== "function"
  ) {
    operatorError("The public deployment bootstrap operator input is invalid");
  }

  const workersResponse = await requestJson(
    workerApiPath("/workers/scripts"),
    cloudflareApiToken,
  );
  const expectedExternalScriptId = assertCloudflareWorkerIdentity(workersResponse);
  const before = await collectActiveEvidence({
    cloudflareApiToken,
    expectedExternalScriptId,
    requestJson,
  });
  if (before.commitSha !== expectedCommitSha) {
    operatorError(
      "The active Worker does not match the expected production commit",
    );
  }

  const result = await bootstrapFn({ firestore, evidence: before });
  let after;
  try {
    after = await collectActiveEvidence({
      cloudflareApiToken,
      expectedExternalScriptId,
      requestJson,
    });
  } catch {
    operatorError(
      "The active Cloudflare deployment could not be verified after bootstrap; reconciliation is required",
    );
  }
  if (after.evidenceDigest !== before.evidenceDigest) {
    operatorError(
      "The active Cloudflare deployment changed during bootstrap; reconciliation is required",
    );
  }
  return result;
}

function receiptTimestamp(value) {
  if (value && typeof value.toMillis === "function") {
    const millis = value.toMillis();
    if (Number.isFinite(millis)) return new Date(millis).toISOString();
  }
  operatorError("The public deployment bootstrap receipt timestamp is invalid");
}

function projectOperatorReceipt({ idempotent, receipt } = {}) {
  if (!plainObject(receipt) || typeof idempotent !== "boolean") {
    operatorError("The public deployment bootstrap result is invalid");
  }
  return {
    idempotent,
    generation: receipt.generation,
    workerName: receipt.workerName,
    buildBatchId: receipt.buildBatchId,
    cloudflareBuildUuid: receipt.cloudflareBuildUuid,
    deploymentId: receipt.deploymentId,
    versionId: receipt.versionId,
    commitSha: receipt.commitSha,
    evidenceDigest: receipt.evidenceDigest,
    bootstrappedAt: receiptTimestamp(receipt.bootstrappedAt),
  };
}

function controlledErrorMessage(error) {
  if (
    error instanceof PublicDeploymentBootstrapOperatorError ||
    error instanceof PublicDeploymentBootstrapEvidenceError ||
    error instanceof PublicDeploymentStateError
  ) {
    return error.message;
  }
  return "The operation failed without changing Cloudflare traffic";
}

async function main() {
  let app;
  try {
    const { expectedCommitSha } = parseApplyArguments(process.argv.slice(2));
    const cloudflareApiToken = parseCloudflareToken(readFileSync(3, "utf8"));
    const serviceAccount = parseFirebaseServiceAccount(readFileSync(4, "utf8"));
    app = initializeApp(
      {
        credential: cert(serviceAccount),
        projectId: FIREBASE_PROJECT_ID,
      },
      "public-deployment-bootstrap-operator",
    );
    const result = await runPublicDeploymentBootstrapOperator({
      firestore: getFirestore(app),
      cloudflareApiToken,
      expectedCommitSha,
    });
    process.stdout.write(`${JSON.stringify(projectOperatorReceipt(result))}\n`);
  } catch (error) {
    process.stderr.write(`Bootstrap refused: ${controlledErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        await deleteApp(app);
      } catch {
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  PublicDeploymentBootstrapOperatorError,
  parseApplyArguments,
  parseCloudflareToken,
  parseFirebaseServiceAccount,
  projectOperatorReceipt,
  runPublicDeploymentBootstrapOperator,
};

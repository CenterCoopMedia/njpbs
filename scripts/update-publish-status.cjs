"use strict";

const {
  applicationDefault,
  cert,
  initializeApp,
} = require("firebase-admin/app");
const {
  FieldValue,
  Timestamp,
  getFirestore,
} = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");
const {
  addressedPublishChanges,
  settleBuildQueue,
} = require("../functions/lib/publish-build-state");
const {
  queueIncludesArtifact,
} = require("../functions/lib/cms-publish-artifact");

const VALID_STATUSES = new Set([
  "success",
  "public_unconfirmed",
  "failed",
  "cancelled",
]);
// Accept the v1 identity until the v2 marker is present, then require the Pages
// deployment id in every claim and terminal receipt.
const DEPLOYMENT_IDENTITY_FIELDS_V1 = [
  "buildBatchId",
  "publicUrl",
  "runAttempt",
  "runId",
].sort();
const DEPLOYMENT_IDENTITY_FIELDS_V2 = [
  ...DEPLOYMENT_IDENTITY_FIELDS_V1,
  "pagesDeploymentId",
].sort();

function sameFields(fields, expected) {
  return (
    fields.length === expected.length &&
    fields.every((field, index) => field === expected[index])
  );
}

function deploymentIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployment identity is invalid");
  }
  const fields = Object.keys(value).sort();
  const isV1 = sameFields(fields, DEPLOYMENT_IDENTITY_FIELDS_V1);
  const isV2 = sameFields(fields, DEPLOYMENT_IDENTITY_FIELDS_V2);
  if (!isV1 && !isV2) {
    throw new Error("deployment identity is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.buildBatchId ?? "")) {
    throw new Error("deployment build batch id is invalid");
  }
  if (!/^\d{1,20}$/.test(value.runId ?? "")) {
    throw new Error("deployment run id is invalid");
  }
  if (!Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) {
    throw new Error("deployment run attempt is invalid");
  }
  if (isV2 && !/^[a-f0-9]{40}$/.test(value.pagesDeploymentId ?? "")) {
    throw new Error("Pages deployment id is invalid");
  }
  let publicUrl;
  try {
    publicUrl = new URL(value.publicUrl);
  } catch {
    throw new Error("deployment public URL is invalid");
  }
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hash ||
    publicUrl.toString().length > 2_048
  ) {
    throw new Error("deployment public URL is invalid");
  }
  return {
    buildBatchId: value.buildBatchId,
    runId: value.runId,
    runAttempt: value.runAttempt,
    ...(isV2 ? { pagesDeploymentId: value.pagesDeploymentId } : {}),
    publicUrl: publicUrl.toString(),
  };
}

function deploymentReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployment receipt is invalid");
  }
  const fields = Object.keys(value).sort();
  const v1TimedFields = [...DEPLOYMENT_IDENTITY_FIELDS_V1, "visibleAtMs"].sort();
  const v2TimedFields = [...DEPLOYMENT_IDENTITY_FIELDS_V2, "visibleAtMs"].sort();
  const hasTiming =
    sameFields(fields, v1TimedFields) || sameFields(fields, v2TimedFields);
  const hasIdentityOnly =
    sameFields(fields, DEPLOYMENT_IDENTITY_FIELDS_V1) ||
    sameFields(fields, DEPLOYMENT_IDENTITY_FIELDS_V2);
  if (!hasTiming && !hasIdentityOnly) {
    throw new Error("deployment receipt is invalid");
  }
  const { visibleAtMs, ...identity } = value;
  const projected = deploymentIdentity(identity);
  if (!hasTiming) {
    return {
      ...projected,
      visibleAtMs: null,
    };
  }
  if (!Number.isSafeInteger(visibleAtMs) || visibleAtMs < 0) {
    throw new Error("deployment visible time is invalid");
  }
  return {
    ...projected,
    visibleAtMs,
  };
}

function timestampMillis(value) {
  if (!value || typeof value.toMillis !== "function") return null;
  const millis = value.toMillis();
  return Number.isSafeInteger(millis) && millis >= 0 ? millis : null;
}

// A v2 receipt is self-contained evidence for the exact editorial revisions
// that the artifact contract already proved present before Pages activation.
function exactDeploymentReceiptEvidence(queue, projected, commitSha) {
  if (!Object.hasOwn(projected, "pagesDeploymentId")) return null;
  const artifactBuild = queue?.artifactBuild;
  if (
    !artifactBuild ||
    artifactBuild.buildBatchId !== projected.buildBatchId ||
    artifactBuild.commitSha !== commitSha ||
    !Number.isSafeInteger(artifactBuild.generation) ||
    artifactBuild.generation < 1 ||
    timestampMillis(artifactBuild.cutoffAt) === null
  ) {
    throw new Error("publish queue artifact build is invalid");
  }
  const requested = Array.isArray(queue.changes) ? queue.changes : [];
  const includedRevisions = addressedPublishChanges(requested);
  if (includedRevisions.length !== requested.length) {
    throw new Error("publish queue included revisions are invalid");
  }
  return {
    schemaVersion: 2,
    generation: artifactBuild.generation,
    cutoffAt: artifactBuild.cutoffAt,
    includedRevisions,
  };
}

function deploymentQueueUpdate({
  queueId,
  commitSha,
  deployment,
  status,
  baseUpdate,
}) {
  const projected = deploymentReceipt(deployment);
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? "")) {
    throw new Error("deployed source commit is invalid");
  }
  return (queue) => {
    const triggeredAtMs = timestampMillis(queue.triggeredAt);
    if (triggeredAtMs === null) {
      throw new Error("publish queue trigger time is invalid");
    }
    if (!queueHasDeploymentClaim(queue, {
      queueId,
      commitSha,
      deployment: projected,
    })) {
      throw new Error(`Publish queue ${queueId} deployment claim does not match`);
    }
    const { visibleAtMs, ...identity } = projected;
    const exactEvidence = exactDeploymentReceiptEvidence(
      queue,
      projected,
      commitSha,
    );
    const deploymentReceipt = {
      ...(exactEvidence ?? {}),
      queueId,
      ...identity,
      commitSha,
    };
    if (visibleAtMs === null) {
      deploymentReceipt.timingStatus =
        status === "public_unconfirmed" ? "public_unconfirmed" : "unavailable";
    } else {
      deploymentReceipt.visibleAt = Timestamp.fromMillis(visibleAtMs);
      deploymentReceipt.publishToVisibleMs = Math.max(
        0,
        visibleAtMs - triggeredAtMs,
      );
    }
    return {
      ...baseUpdate,
      deploymentReceipt,
    };
  };
}

function deploymentClaimIdentity({ queueId, commitSha, queue, deployment }) {
  return {
    queueId,
    buildBatchId: deployment.buildBatchId,
    generation: queue.artifactBuild.generation,
    commitSha,
    runId: deployment.runId,
    runAttempt: deployment.runAttempt,
    ...(Object.hasOwn(deployment, "pagesDeploymentId")
      ? { pagesDeploymentId: deployment.pagesDeploymentId }
      : {}),
  };
}

function queueHasDeploymentClaim(queue, { queueId, commitSha, deployment }) {
  const claim = queue?.deploymentClaim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  const expected = deploymentClaimIdentity({
    queueId,
    commitSha,
    queue,
    deployment,
  });
  const fields = Object.keys(claim).sort();
  const expectedFields = [...Object.keys(expected), "claimedAt"].sort();
  if (
    !sameFields(fields, expectedFields) ||
    timestampMillis(claim.claimedAt) === null
  ) {
    return false;
  }
  return Object.entries(expected).every(
    ([field, value]) => claim[field] === value,
  );
}

async function verifyDeploymentWriteback(
  db,
  { queueId, commitSha, artifactReceipt, deployment },
) {
  const projected = deploymentIdentity(deployment);
  const queueRef = db.collection("cmsPublishQueue").doc(queueId);
  const pointerRef = db.collection("system").doc("publicDeployment");
  return db.runTransaction(async (transaction) => {
    const [snapshot, pointerSnapshot] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(pointerRef),
    ]);
    if (!snapshot.exists) throw new Error(`Publish queue ${queueId} was not found`);
    const queue = snapshot.data();
    if (![
      "pending",
      "publishing",
      "public_unconfirmed",
      "failed",
      "cancelled",
    ].includes(queue.status)) {
      throw new Error(`Publish queue ${queueId} is already ${String(queue.status)}`);
    }
    if (!queueIncludesArtifact(queue, artifactReceipt)) {
      throw new Error(`Publish queue ${queueId} artifact receipt does not match`);
    }
    if (queue.artifactBuild.buildBatchId !== projected.buildBatchId) {
      throw new Error(`Publish queue ${queueId} deployment batch does not match`);
    }
    if (
      !/^[a-f0-9]{40}$/.test(commitSha ?? "") ||
      queue.artifactBuild.commitSha !== commitSha
    ) {
      throw new Error(`Publish queue ${queueId} source commit does not match`);
    }
    if (timestampMillis(queue.triggeredAt) === null) {
      throw new Error(`Publish queue ${queueId} trigger time is invalid`);
    }
    const latestGeneration = pointerSnapshot.data()?.lastReservedGeneration;
    if (
      !pointerSnapshot.exists ||
      !Number.isSafeInteger(latestGeneration) ||
      latestGeneration < 1 ||
      latestGeneration !== queue.artifactBuild.generation
    ) {
      throw new Error(
        `Publish queue ${queueId} is not the newest public artifact`,
      );
    }
    if (queueHasDeploymentClaim(queue, {
      queueId,
      commitSha,
      deployment: projected,
    })) {
      return projected;
    }
    if (
      queue.deploymentClaim !== undefined &&
      (queue.status === "pending" || queue.status === "publishing") &&
      queue.artifactBuildRollback === undefined
    ) {
      throw new Error(`Publish queue ${queueId} deployment claim conflicts`);
    }
    transaction.update(queueRef, {
      deploymentClaim: {
        ...deploymentClaimIdentity({
          queueId,
          commitSha,
          queue,
          deployment: projected,
        }),
        claimedAt: FieldValue.serverTimestamp(),
      },
    });
    return projected;
  });
}

function initFirebase() {
  const serviceAccountPath = path.join(__dirname, "..", "service-account.json");

  if (fs.existsSync(serviceAccountPath)) {
    initializeApp({
      credential: cert(require(serviceAccountPath)),
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: applicationDefault(),
    });
  } else {
    throw new Error("No Firebase credentials found");
  }

  return getFirestore();
}

async function updatePublishStatus(
  db,
  {
    queueId,
    status,
    commitSha,
    artifactReceipt = null,
    deployment = null,
  },
) {
  if (!queueId) throw new Error("queueId is required");
  if (!VALID_STATUSES.has(status)) {
    throw new Error(
      "status must be: success | public_unconfirmed | failed | cancelled",
    );
  }

  let update = {
    status,
    completedAt: FieldValue.serverTimestamp(),
  };

  if (commitSha) update.gitCommitSha = commitSha;
  if (status === "success" || status === "public_unconfirmed") {
    update.error = FieldValue.delete();
  } else if (status === "failed") {
    update.error = "Publish build failed - see GitHub Actions logs";
  } else if (status === "cancelled") {
    update.error = "Publish build cancelled - see GitHub Actions logs";
  }
  if (status === "public_unconfirmed" && deployment === null) {
    throw new Error("public_unconfirmed status requires a deployment receipt");
  }
  if (deployment !== null) {
    if (status !== "success" && status !== "public_unconfirmed") {
      throw new Error(
        "deployment receipt requires success or public_unconfirmed status",
      );
    }
    update = deploymentQueueUpdate({
      queueId,
      commitSha,
      deployment,
      status,
      baseUpdate: update,
    });
  }

  const settled = await settleBuildQueue(db, {
    queueId,
    status,
    queueUpdate: update,
    acceptQueue:
      status === "success" || status === "public_unconfirmed"
        ? (queue) =>
            queue.artifactBuild === undefined
              ? artifactReceipt === null
              : queueIncludesArtifact(queue, artifactReceipt)
        : null,
  });
  if (!settled) {
    throw new Error(
      `Publish queue ${queueId} was not found or its artifact receipt does not match`,
    );
  }
  return update;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "verify-deployment") {
    const [, queueId, commitSha, artifactReceiptPath, deploymentPath] = args;
    if (!queueId || !commitSha || !artifactReceiptPath || !deploymentPath) {
      throw new Error(
        "Usage: node scripts/update-publish-status.cjs verify-deployment <queueId> <commitSha> <artifactReceiptPath> <deploymentPath>",
      );
    }
    const db = initFirebase();
    await verifyDeploymentWriteback(db, {
      queueId,
      commitSha,
      artifactReceipt: JSON.parse(fs.readFileSync(artifactReceiptPath, "utf8")),
      deployment: JSON.parse(fs.readFileSync(deploymentPath, "utf8")),
    });
    console.log(`Verified terminal writeback for queue ${queueId}`);
    return;
  }

  const [queueId, status, commitSha, artifactReceiptPath, deploymentPath] = args;

  if (!queueId || !VALID_STATUSES.has(status)) {
    console.error(
      "Usage: node scripts/update-publish-status.cjs <queueId> <success|public_unconfirmed|failed|cancelled> [commitSha] [artifactReceiptPath] [deploymentPath]",
    );
    process.exit(1);
  }

  try {
    const artifactReceipt = artifactReceiptPath
      ? JSON.parse(fs.readFileSync(artifactReceiptPath, "utf8"))
      : null;
    const deployment = deploymentPath
      ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
      : null;
    const db = initFirebase();
    await updatePublishStatus(db, {
      queueId,
      status,
      commitSha,
      artifactReceipt,
      deployment,
    });
    console.log(`Updated queue ${queueId} status to: ${status}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  deploymentIdentity,
  deploymentReceipt,
  updatePublishStatus,
  verifyDeploymentWriteback,
  initFirebase,
  VALID_STATUSES,
};

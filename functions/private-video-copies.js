"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { S3Client } = require("@aws-sdk/client-s3");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { runtimeRegistry, runtimeAwsConfig } = require("./lib/media-source-runtime");
const { createAwsRoleCredentialProvider } = require("./lib/aws-workload-credentials");
const { ENABLED, WRITE_SECRETS, privateVideoStorage } = require("./lib/private-video-runtime");
const { COPIES, currentIdentity, newCopy, enqueueCopy, revokeCopies, claimCopy, saveCopy } = require("./lib/private-video-copy");
const { createPrivateVideoTransfer } = require("./lib/private-video-transfer");

const SERVICE_ACCOUNT = "boardwalk-s3-media@njpbs-site.iam.gserviceaccount.com";
let s3;
function transferFor(source) {
  const config = runtimeAwsConfig();
  const r2 = privateVideoStorage(true);
  if (source?.roleArn) s3 ??= new S3Client({ region: config.region,
    credentials: createAwsRoleCredentialProvider({ ...config, roleArn: source.roleArn }), maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 30000, throwOnRequestTimeout: true } });
  return createPrivateVideoTransfer({ s3, r2: r2.client, bucket: r2.bucket, config });
}

function privateAudioFor(firestore = db) {
  const config = require("./video-transcripts").transcriptConfig();
  const client = config.controlRoleArn ? new S3Client({ region: config.region,
    credentials: createAwsRoleCredentialProvider({ ...config, roleArn: config.controlRoleArn }), maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 30000, throwOnRequestTimeout: true } }) : undefined;
  return require("./lib/private-transcript-audio").createPrivateTranscriptAudio({
    firestore, s3: client, config, storage: privateVideoStorage,
  });
}

async function reconcilePrivateVideo({ firestore = db, source = runtimeRegistry().get("video-library"), assetId,
  remove = (job) => transferFor(source).remove(job) }) {
  const snapshot = await firestore.collection("mediaSourceAssets").doc(assetId).get();
  const binding = currentIdentity(source, snapshot);
  await revokeCopies({ firestore, source, assetId, remove });
  await privateAudioFor(firestore).revoke({ assetId, onlyStale: true });
  if (binding && ENABLED.value() === "true") await enqueueCopy({ firestore, source, assetId });
}

async function processPrivateVideoTick({ firestore = db, source = runtimeRegistry().get("video-library"),
  transfer, now = Date.now, maxSteps = 12, copyEnabled = ENABLED.value() === "true" } = {}) {
  const query = copyEnabled ? firestore.collection(COPIES).where("active", "==", true)
    : firestore.collection(COPIES).where("phase", "==", "revoking");
  const snapshots = await query.limit(20).get();
  for (const snapshot of snapshots.docs) {
    const job = await claimCopy({ firestore, ref: snapshot.ref, source, now: now() });
    if (!job) continue;
    const run = transfer ?? transferFor(source);
    const save = (changes) => saveCopy({ firestore, ref: snapshot.ref, source, job, changes, now: now() });
    try {
      if (job.revoked || job.phase === "repair") {
        await run.remove(job);
        await firestore.runTransaction(async (tx) => {
          const current = (await tx.get(snapshot.ref)).data();
          if (current?.leaseOwner !== job.leaseOwner || current.generation !== job.generation) return;
          const binding = currentIdentity(source, await tx.get(firestore.collection("mediaSourceAssets").doc(job.identity.assetId)));
          if (!current.revoked && binding?.id === job.id) tx.set(snapshot.ref, newCopy(binding, now()));
          else tx.update(snapshot.ref, { phase: "deleted", active: false, leaseUntil: 0 });
        });
      } else {
        for (let step = 0; step < maxSteps && job.active; step++) {
          if (!await save({ leaseUntil: now() + 12 * 60 * 1000 })) break;
          await run.step(job, save);
        }
        await save({ leaseUntil: 0 });
      }
    } catch {
      const failures = (job.failures ?? 0) + 1;
      await save({ failures, leaseUntil: 0, ...(failures >= 5 ? { active: false, phase: "failed" } : {}) });
      logger.warn("Private video copy step failed", { copyId: job.id, failures });
    }
    return { copyId: job.id, phase: job.phase };
  }
  return { idle: true };
}

const options = { region: "us-central1", serviceAccount: SERVICE_ACCOUNT, secrets: WRITE_SECRETS,
  memory: "512MiB", maxInstances: 1, concurrency: 1, timeoutSeconds: 540 };
const onPrivateVideoAssetWrite = onDocumentWritten({ ...options, document: "mediaSourceAssets/{assetId}", retry: true }, async (event) => {
  // Read current state, never the possibly stale event payload.
  await reconcilePrivateVideo({ assetId: event.params.assetId });
});
const onPrivateVideoCopyTick = onSchedule({ ...options, schedule: "every 1 minutes", retryCount: 0 }, async () => {
  const copyEnabled = ENABLED.value() === "true";
  const audio = await privateAudioFor().tick({ copyEnabled });
  if (audio.idle) await processPrivateVideoTick({ copyEnabled });
});
module.exports = { onPrivateVideoAssetWrite, onPrivateVideoCopyTick, reconcilePrivateVideo, processPrivateVideoTick, transferFor, privateAudioFor };

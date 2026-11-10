"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { runtimeRegistry, runtimeAwsConfig, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { objectKeyWithinSource } = require("./lib/media-sources");
const { PREVIEW_JOBS, claimPreview, savePreview, renditionState } = require("./lib/video-preview-job");
const { createVideoPreviewProcessor } = require("./lib/video-preview-processor");
const { safeStorageDiagnostic } = require("./lib/source-original-state");

const ENABLED = defineString("CMS_MEDIA_PREVIEW_PROCESSING_ENABLED", { default: "false" });
const CONTROL_ROLE = defineString("CMS_MEDIA_PREVIEW_CONTROL_ROLE_ARN", { default: "" });
const WORKFLOW = defineString("CMS_MEDIA_PREVIEW_WORKFLOW_ARN", { default: "" });

function previewProcessorConfig() {
  if (ENABLED.value() !== "true") return null;
  const registry = runtimeRegistry();
  const source = registry.get("video-library");
  const aws = runtimeAwsConfig();
  if (!source || !aws.renditionBucket || !CONTROL_ROLE.value() || !WORKFLOW.value()) {
    throw new Error("preview_configuration_incomplete");
  }
  return { ...aws, bucket: aws.renditionBucket, accountId: source.expectedBucketOwner,
    originalBucket: source.bucket, readRoleArn: source.roleArn, source,
    controlRoleArn: CONTROL_ROLE.value(), workflowArn: WORKFLOW.value(),
  };
}

async function processPreviewTick({ firestore = db, config = previewProcessorConfig(),
  processor, now = Date.now } = {}) {
  if (!config) return { enabled: false };
  const snapshots = await firestore.collection(PREVIEW_JOBS).where("active", "==", true).limit(5).get();
  const run = processor ?? createVideoPreviewProcessor(config);
  const jobs = [];
  for (const snapshot of snapshots.docs) {
    const job = await claimPreview(firestore, snapshot.ref, now());
    if (!job) continue;
    const save = async (changes, rendition) => {
      const stored = await savePreview(firestore, snapshot.ref, job, changes, rendition);
      if (stored) Object.assign(job, changes);
      return stored;
    };
    try {
      if (job.sourceId !== "video-library" || !objectKeyWithinSource(config.source, job.sourceObjectKey) ||
          !Number.isSafeInteger(job.sourceSizeBytes) || job.sourceSizeBytes <= 0) {
        await save({ phase: "failed", active: false }, renditionState(job, "failed", { errorCode: "source_unavailable" }));
      } else {
        await run(job, save);
        await save({ failures: 0 });
      }
    } catch (error) {
      // Provider errors may include private URLs. Persist only a fixed diagnostic code.
      if (["original_archived", "original_restoring"].includes(error?.code)) {
        await save({ phase: "failed", active: false }, renditionState(job, "failed", { errorCode: "original_archived" }));
        continue;
      }
      const failures = (job.failures ?? 0) + 1;
      const terminal = failures >= 5;
      await save({ failures, ...(terminal ? { phase: "needs_reconciliation", active: false } : {}) },
        terminal ? renditionState(job, "failed", { errorCode: "processing_failed" }) : undefined);
      logger.warn("Video preview step failed", { jobId: job.id, phase: job.phase,
        failures, status: Number.isInteger(error?.$metadata?.httpStatusCode) ? error.$metadata.httpStatusCode : null });
    } finally {
      await save({ leaseUntil: 0 });
      jobs.push({ jobId: job.id, phase: job.phase });
    }
  }
  return jobs.length ? { enabled: true, jobs } : { enabled: true, idle: true };
}

const onVideoPreviewTick = onSchedule({
  schedule: "every 1 minutes", region: "us-central1", timeoutSeconds: 240,
  memory: "256MiB", maxInstances: 1, concurrency: 1, serviceAccount: FUNCTION_SERVICE_ACCOUNT,
}, async () => {
  const { createOriginalStorage, processOriginalRestores } = require("./lib/source-originals");
  try {
    await processOriginalRestores({ firestore: db, storage: createOriginalStorage(runtimeAwsConfig()),
      registry: runtimeRegistry(), log: logger });
  } catch (error) {
    logger.warn("Original restore pass failed", safeStorageDiagnostic(error));
  }
  await processPreviewTick();
});

module.exports = { onVideoPreviewTick, processPreviewTick, previewProcessorConfig };

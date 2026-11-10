"use strict";

const { createHash } = require("node:crypto");
const { db } = require("./lib/firebase");
const { cmsOnRequest, secretsMatch, requestHeader } = require("./lib/cms-edge");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { assertBillingEnabled } = require("./lib/billing-state");
const { FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { transcriptConfig } = require("./video-transcripts");
const { createVideoTranscriptProcessor } = require("./lib/video-transcript-processor");
const worker = require("./lib/video-transcript-worker");
const alignment = require("./lib/video-transcript-alignment-job");
const orientation = require("./lib/video-orientation-export");

function createWorkerHandler(operation, dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  const alignmentJobs = dependencies.alignment ?? alignment;
  const exportJobs = dependencies.orientation ?? orientation;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const authorization = requestHeader(req, "authorization");
      if (!/^Bearer [A-Za-z0-9]{48}$/.test(authorization ?? "")) {
        return res.status(401).json({ error: "Worker authentication required" });
      }
      const auth = await (dependencies.readAuth ?? (async () =>
        (await firestore.collection("system").doc("videoTranscriptionWorkerAuth").get()).data()))();
      const suppliedHash = createHash("sha256").update(authorization.slice(7)).digest("hex");
      if (auth?.enabled !== true || auth.workerId !== worker.WORKER_ID ||
          !/^[a-f0-9]{64}$/.test(auth.tokenSha256 ?? "") || !secretsMatch(auth.tokenSha256, suppliedHash)) {
        return res.status(401).json({ error: "Worker authentication required" });
      }
      validateBoundedJsonRequest(req, operation === "complete" ? 16 * 1024 * 1024 : 8 * 1024);
      const alignmentOperation = operation !== "claim" && req.body?.kind === "alignment";
      const exportOperation = operation !== "claim" && req.body?.kind === "orientation";
      const request = alignmentOperation
        ? alignmentJobs.parseAlignmentWorkerRequest(operation, req.body)
        : exportOperation ? exportJobs.parseExportWorkerRequest(operation, req.body)
          : worker.parseWorkerRequest(operation, req.body);
      const config = (dependencies.configFn ?? transcriptConfig)();
      const exportEnabled = Boolean(config.bucket && config.accountId &&
        config.controlRoleArn && config.source);
      const transcriptionEnabled = Boolean(config.enabled && (config.localEnabled || config.alignmentEnabled));
      if (exportOperation && !exportEnabled) return res.status(503).json({ error: "Video export is unavailable" });
      if (!exportOperation && !transcriptionEnabled && !(operation === "claim" && exportEnabled)) {
        return res.status(503).json({ error: "Local transcription is unavailable" });
      }
      const clock = dependencies.clock ?? Date.now;
      const args = { firestore, source: config.source, request, now: clock(), clock,
        fallbackEnabled: config.fallbackEnabled, audioRequired: config.audioEnabled };
      const exportStorage = () => ({
        uploader: dependencies.uploader ?? createS3MediaUploader(runtimeAwsConfig()),
        objectKeyFn: dependencies.objectKeyFn ?? require("./source-media-uploads").objectKey,
        completedAssetFn: dependencies.completedAssetFn ?? require("./source-media-uploads").completedAsset,
        assertBillingEnabled: () => (dependencies.assertBillingEnabledFn ?? assertBillingEnabled)(firestore) });
      if (exportOperation) {
        if (operation === "heartbeat") {
          const result = await exportJobs.heartbeatExportJob(args);
          return res.status(200).json({ success: true, leaseUntil: result.leaseUntil ?? 0, completed: result.completed === true });
        }
        if (operation === "fail") return res.status(200).json({ success: true, ...await exportJobs.failExportJob(args) });
        const result = await exportJobs.completeExportJob({ ...args, ...exportStorage() });
        return res.status(200).json({ success: true, ...result });
      }
      if (alignmentOperation) {
        if (!config.alignmentEnabled || !alignmentJobs.alignmentEngine(config)) {
          return res.status(503).json({ error: "Transcript alignment is unavailable" });
        }
        if (operation === "heartbeat") {
          const result = await alignmentJobs.heartbeatAlignmentJob(args);
          return res.status(200).json({ success: true, leaseUntil: result.leaseUntil, completed: result.completed === true });
        }
        if (operation === "fail") {
          const result = await alignmentJobs.failAlignmentJob(args);
          await (dependencies.processor ?? createVideoTranscriptProcessor(config, { firestore })).cleanupAudio?.();
          return res.status(200).json({ success: true, ...result });
        }
        const processor = dependencies.processor ?? createVideoTranscriptProcessor(config, { firestore });
        const result = await alignmentJobs.completeAlignmentJob({ ...args, config,
          readSegments: processor.readAlignment, writeAlignment: processor.align,
          assertBillingEnabled: () => (dependencies.assertBillingEnabledFn ?? assertBillingEnabled)(firestore) });
        await processor.cleanupAudio?.();
        return res.status(200).json({ success: true, ...result });
      }
      if (operation === "heartbeat") {
        const result = await worker.heartbeatLocalJob(args);
        return res.status(200).json({ success: true, leaseUntil: result.job.localLeaseUntil ?? 0, completed: result.completed === true });
      }
      if (operation === "fail") {
        const result = await worker.failLocalJob(args);
        await (dependencies.processor ?? createVideoTranscriptProcessor(config, { firestore })).cleanupAudio?.();
        return res.status(200).json({ success: true, ...result });
      }
      const processor = dependencies.processor ?? createVideoTranscriptProcessor(config, { firestore });
      if (operation === "complete") {
        const result = await worker.completeLocalJob({ ...args, writeExports: processor.writeExports,
          assertBillingEnabled: () => (dependencies.assertBillingEnabledFn ?? assertBillingEnabled)(firestore) });
        await processor.cleanupAudio?.();
        return res.status(200).json({ success: true, ...result });
      }
      await (dependencies.assertBillingEnabledFn ?? assertBillingEnabled)(firestore);
      if (transcriptionEnabled) await processor.prepareLocalInputs?.();
      if (transcriptionEnabled && config.alignmentEnabled && alignmentJobs.alignmentEngine(config)) {
        const claimed = await alignmentJobs.claimAlignmentJob({ ...args, config });
        if (claimed) {
          const built = alignmentJobs.buildAlignmentSnapshot(claimed.transcript,
            await processor.readAlignment(claimed.transcript), config);
          if (built.request.id !== claimed.alignment.id) throw Object.assign(new Error("Transcript alignment changed"), { status: 409 });
          const input = await processor.signInput(claimed.transcript,
            { collection: alignment.ALIGNMENT_JOBS, id: claimed.alignment.id });
          await alignmentJobs.withAlignmentLease({ ...args, now: clock(),
            request: { jobId: claimed.alignment.id, leaseToken: claimed.alignment.leaseToken }, mutate: () => null });
          return res.status(200).json({ success: true, job: {
            kind: "alignment", id: claimed.alignment.id, leaseToken: claimed.alignment.leaseToken,
            leaseUntil: claimed.alignment.leaseUntil, engine: claimed.alignment.engine,
            languageCode: claimed.transcript.languageCode, durationSeconds: claimed.transcript.durationSeconds,
            passages: built.request.passages, input,
          } });
        }
      }
      const job = transcriptionEnabled && config.localEnabled ? await worker.claimLocalJob(args) : null;
      if (!job) {
        // Exports wait behind transcription and alignment work.
        const capable = exportEnabled && request.capabilities.includes("orientation");
        if (capable) {
          await exportJobs.recordExportWorker(args);
          await exportJobs.checkStrayUpload({ ...args, ...exportStorage() });
        }
        const exportJob = capable ? await exportJobs.claimExportJob(args) : null;
        if (!exportJob) return res.status(200).json({ success: true, job: null, retryAfterSeconds: 30 });
        const lease = { jobId: exportJob.id, leaseToken: exportJob.leaseToken };
        // An issued upload past its deadline gets its storage check here.
        if (exportJob.uploadIssued) {
          await exportJobs.settleIssuedUpload({ ...args, now: clock(), request: lease, ...exportStorage() });
          return res.status(200).json({ success: true, job: null, retryAfterSeconds: 30 });
        }
        const input = await processor.signVideoInput(exportJob.input);
        // A source change during signing cannot release a new URL.
        await exportJobs.withExportLease({ ...args, now: clock(), request: { jobId: exportJob.id, leaseToken: exportJob.leaseToken }, mutate: () => null });
        return res.status(200).json({ success: true, job: exportJobs.workerJob(exportJob, input) });
      }
      const input = await processor.signInput(job);
      // A deletion, expiry, or fallback during signing cannot release a new URL.
      await worker.withLocalLease({ ...args, now: clock(), request: { jobId: job.id, leaseToken: job.localLeaseToken }, mutate: () => null });
      return res.status(200).json({ success: true, job: {
        id: job.id, leaseToken: job.localLeaseToken, leaseUntil: job.localLeaseUntil,
        engineRevision: worker.LOCAL_ENGINE, languageCode: job.languageCode, maxSpeakers: job.maxSpeakers,
        durationSeconds: job.durationSeconds, input,
      } });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503;
      // Do not expose provider errors, URLs, input text or credential details.
      return res.status(status).json({ error: status < 500 ? error.message : "Worker request could not be completed" });
    }
  };
}
const { READ_SECRETS, WRITE_SECRETS } = require("./lib/private-video-runtime");
const { createS3MediaUploader } = require("./lib/s3-media-upload");
const { runtimeAwsConfig } = require("./lib/media-source-runtime");

const options = { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", maxInstances: 1,
  concurrency: 10, serviceAccount: FUNCTION_SERVICE_ACCOUNT, cors: false };
const videoTranscriptWorkerClaim = cmsOnRequest({ ...options, secrets: READ_SECRETS }, createWorkerHandler("claim"));
const videoTranscriptWorkerHeartbeat = cmsOnRequest(options, createWorkerHandler("heartbeat"));
const videoTranscriptWorkerComplete = cmsOnRequest({ ...options, secrets: WRITE_SECRETS }, createWorkerHandler("complete"));
const videoTranscriptWorkerFail = cmsOnRequest({ ...options, secrets: WRITE_SECRETS }, createWorkerHandler("fail"));
module.exports = { videoTranscriptWorkerClaim, videoTranscriptWorkerHeartbeat, videoTranscriptWorkerComplete,
  videoTranscriptWorkerFail, createWorkerHandler };

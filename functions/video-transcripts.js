"use strict";

const { randomUUID } = require("node:crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { verifyAppCheckUnlessAutomation } = require("./lib/automation-accounts");
const { assertBillingEnabled } = require("./lib/billing-state");
const { authorizeMediaSource } = require("./lib/media-sources");
const { runtimeRegistry, runtimeAwsConfig, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { MAX_EDIT_REQUEST_BYTES, parseTranscriptEdit, applyTranscriptEdit,
  parseTranscriptRequest, transcriptId, transcriptSummary, transcriptPage } = require("./lib/video-transcript-contract");
const { TRANSCRIPT_JOBS, requestTranscript, getTranscriptJob, claimTranscript, saveTranscript,
  assertTranscriptRevision, assertSameTranscriptOutputs, withTranscriptWriteLease, commitTranscriptEdit, migratePendingTranscriptToLocal, transcriptLogMetadata } = require("./lib/video-transcript-job");
const { createVideoTranscriptProcessor } = require("./lib/video-transcript-processor");
const { PAID_FALLBACK_POLICY } = require("./lib/video-transcript-fallback-policy");
const { routePaidFallback } = require("./lib/video-transcript-paid-fallback");

const LOCAL_ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_LOCAL_ENABLED", { default: "false" });
const FALLBACK_ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_FALLBACK_ENABLED", { default: "false" });
const ALIGNMENT_ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_ALIGNMENT_ENABLED", { default: "false" });
const ALIGNMENT_MODEL_REPOSITORY = defineString("CMS_MEDIA_TRANSCRIPT_ALIGNMENT_MODEL_REPOSITORY", { default: "" });
const ALIGNMENT_MODEL_REVISION = defineString("CMS_MEDIA_TRANSCRIPT_ALIGNMENT_MODEL_REVISION", { default: "" });
const ALIGNMENT_CACHE_SHA256 = defineString("CMS_MEDIA_TRANSCRIPT_ALIGNMENT_CACHE_SHA256", { default: "" });
const { routeLocalFallback } = require("./lib/video-transcript-worker");
const ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_PROCESSING_ENABLED", { default: "false" });
const CONTROL_ROLE = defineString("CMS_MEDIA_TRANSCRIPT_CONTROL_ROLE_ARN", { default: "" });
const DATA_ROLE = defineString("CMS_MEDIA_TRANSCRIPT_DATA_ROLE_ARN", { default: "" });
const AUDIO_ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_AUDIO_ENABLED", { default: "false" });
const AUDIO_FUNCTION = defineString("CMS_MEDIA_TRANSCRIPT_AUDIO_FUNCTION_ARN", { default: "" });
const AUDIO_ARTIFACT = defineString("CMS_MEDIA_TRANSCRIPT_AUDIO_ARTIFACT_SHA256", { default: "" });

function transcriptConfig() {
  const aws = runtimeAwsConfig();
  return { ...aws, enabled: ENABLED.value() === "true", localEnabled: LOCAL_ENABLED.value() === "true",
    fallbackEnabled: FALLBACK_ENABLED.value() === "true", bucket: aws.renditionBucket,
    audioEnabled: AUDIO_ENABLED.value() === "true", audioFunctionArn: AUDIO_FUNCTION.value(),
    audioArtifactSha256: AUDIO_ARTIFACT.value(),
    alignmentEnabled: ALIGNMENT_ENABLED.value() === "true",
    alignmentModelRepository: ALIGNMENT_MODEL_REPOSITORY.value(),
    alignmentModelRevision: ALIGNMENT_MODEL_REVISION.value(), alignmentCacheSha256: ALIGNMENT_CACHE_SHA256.value(),
    accountId: aws.renditionExpectedBucketOwner, source: runtimeRegistry().get("video-library"),
    controlRoleArn: CONTROL_ROLE.value(), dataRoleArn: DATA_ROLE.value() };
}

function configured(config) {
  return config?.bucket && config.accountId && config.controlRoleArn && config.dataRoleArn && config.source;
}

function unavailable() {
  return Object.assign(new Error("Video transcription is not available"), { status: 503 });
}

function requestPolicy(config) {
  const enabled = Boolean(config.enabled && configured(config));
  return { enabled, localEnabled: Boolean(config.localEnabled),
    provider: config.localEnabled ? "local-whisper" : "elevenlabs",
    fallbackEnabled: Boolean(enabled && (!config.localEnabled || config.fallbackEnabled)),
    paidFallbackProviders: ["elevenlabs", "amazon-transcribe"] };
}

async function readCachedTranscript(args) {
  const { operation, request } = args;
  if (operation === "download" && !request.clipId && ["srt", "vtt", "tsv", "avid", "premiere"].includes(request.format)) {
    return withTranscriptWriteLease(args, () => readCachedTranscriptContent(args));
  }
  return readCachedTranscriptContent(args);
}

async function readCachedTranscriptContent({ operation, job, request, processor, firestore, source, renditionBucket }) {
  let content;
  if (operation === "download" && request.clipId) {
    const { readTranscriptClip, clipTranscriptExport } = require("./lib/clip-transcript-export");
    const { asset, clip } = await readTranscriptClip(firestore, source, request);
    content = clipTranscriptExport(await processor.read(job), job, clip, asset, request.format);
    // Recheck the clip after reading private transcript storage, just as the transcript is checked below.
    await readTranscriptClip(firestore, source, request);
  } else if (operation === "download" && ["srt", "tsv", "avid", "premiere"].includes(request.format)) {
    const metadata = await transcriptLogMetadata({ firestore, source, request, job, renditionBucket });
    const current = await getTranscriptJob({ firestore, source, request, renditionBucket });
    assertSameTranscriptOutputs(current, job);
    content = request.format === "tsv" ? await processor.downloadLog(job, metadata)
      : request.format === "srt" ? await processor.downloadSrt(job)
      : await processor.downloadNle(job, request, metadata);
  } else {
    content = operation === "download"
      ? await processor.download(job, request.format)
      : transcriptPage(job, await processor.read(job), request.cursor);
  }
  // Recheck original/lifecycle after storage work, before releasing private data.
  const current = await getTranscriptJob({ firestore, source, request, renditionBucket });
  assertSameTranscriptOutputs(current, job);
  return operation === "download" ? content : { transcript: content, cached: true };
}

async function editCachedTranscript({ job, request, processor, firestore, source, actor, audit, renditionBucket,
  assertBillingEnabledFn = assertBillingEnabled, log = logger }) {
  assertTranscriptRevision(job, request.revision);
  if (request.reviewed === true) {
    const updated = await commitTranscriptEdit({ firestore, source, request, job, actor, audit, renditionBucket });
    const page = transcriptPage(updated, await processor.read(updated));
    const current = await getTranscriptJob({ firestore, source, request, renditionBucket });
    assertTranscriptRevision(current, updated.editRevision, job.id);
    return { transcript: page, cached: true };
  }
  const content = applyTranscriptEdit(job, await processor.read(job), request);
  try { await assertBillingEnabledFn(firestore); }
  catch { throw Object.assign(new Error("Transcript editing is unavailable while billing is stopped"), { status: 503 }); }
  const editedOutputs = await processor.edit(job, content.segments, content.speakerNames);
  // S3 versions are private and unreferenced until this optimistic transaction wins.
  let updated;
  try {
    updated = await commitTranscriptEdit({ firestore, source, request, job, editedOutputs,
      speakerNames: content.speakerNames, speakerRoles: content.speakerRoles, actor, audit, renditionBucket });
  } catch (error) {
    try {
      // A lost commit response can report failure after the transaction wins.
      // Read its stored pointers before deleting any provisional version.
      const current = (await firestore.collection(TRANSCRIPT_JOBS).doc(job.id).get()).data();
      const unused = Object.fromEntries(Object.entries(editedOutputs)
        .filter(([format, version]) => current?.editedOutputs?.[format] !== version));
      await processor.discardEdit(job, unused);
      if (Object.keys(unused).length === 0 && job.editedOutputs) {
        await processor.retireEdit(job, job.editedOutputs);
      }
    } catch {
      log.warn("Transcript edit cleanup failed", { jobId: job.id });
    }
    throw error;
  }
  if (job.editedOutputs) await processor.retireEdit(job, job.editedOutputs);
  const current = await getTranscriptJob({ firestore, source, request, renditionBucket });
  assertTranscriptRevision(current, updated.editRevision, job.id);
  return { transcript: transcriptPage(updated, content.segments), cached: true };
}

function createTranscriptHandler(operation, dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  const registry = dependencies.registryFn ?? runtimeRegistry;
  const configFn = dependencies.configFn ?? transcriptConfig;
  let defaultProcessor;
  const processor = (config) => dependencies.processor ?? (defaultProcessor ??= createVideoTranscriptProcessor(config, { firestore }));
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, operation === "edit" ? MAX_EDIT_REQUEST_BYTES : 8 * 1024);
      const verifyAppCheckFn = dependencies.verifyAppCheckFn ?? verifyAppCheckToken;
      // Only the plain transcript read admits an automation account without App Check (#4950).
      if (operation !== "get") await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
      if (operation === "get") await verifyAppCheckUnlessAutomation(req, actor, { firestore, verifyAppCheckFn });
      let request = operation === "edit" ? parseTranscriptEdit(req.body)
        : parseTranscriptRequest(req.body, { read: operation === "get", download: operation === "download" });
      const source = registry().get(request.sourceId);
      await (dependencies.authorizeFn ?? authorizeMediaSource)({ firestore, actor, source,
        operation: ["request", "edit"].includes(operation) ? "transcript" : "browse" });
      let job;
      let cached = true;
      if (operation === "request") {
        const config = configFn();
        if (!config.enabled || !configured(config)) throw unavailable();
        if (request.provider === "amazon-transcribe" && config.localEnabled && !config.fallbackEnabled) throw unavailable();
        ({ job, cached } = await requestTranscript({ firestore, source, request, actor, audit: dependencies.audit,
          localEnabled: config.localEnabled, paidFallbackEnabled: true }));
      } else {
        job = await getTranscriptJob({ firestore, source, request, renditionBucket: configFn().bucket });
        if (operation === "edit" && job && !request.transcriptId) {
          const legacyId = transcriptId({ sourceId: job.sourceId, objectKey: job.sourceObjectKey,
            objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes }, source.bucket, request);
          const legacy = await getTranscriptJob({ firestore, source, request: { ...request, transcriptId: legacyId }, renditionBucket: configFn().bucket });
          if (legacy?.id !== job.id) throw Object.assign(new Error("Transcript changed. Reload the transcript before saving"), { status: 409 });
        }
        if (operation === "edit" && job) request = { ...request, transcriptId: job.id };
        if (job?.provider === "elevenlabs" && request.transcriptId !== job.id) request = { ...request, transcriptId: job.id };
      }
      if (["download", "edit"].includes(operation) && job?.phase !== "ready") {
        throw Object.assign(new Error("Transcript is not ready"), { status: 409 });
      }
      if (operation !== "request" && job?.phase === "ready") {
        const config = configFn();
        if (!configured(config)) throw unavailable();
        const args = { operation, job, request, processor: processor(config), firestore, source, actor,
          renditionBucket: config.bucket, audit: dependencies.audit, assertBillingEnabledFn: dependencies.assertBillingEnabledFn,
          log: dependencies.log ?? logger };
        const content = operation === "edit" ? await withTranscriptWriteLease(args, () => editCachedTranscript(args)) : await readCachedTranscript(args);
        return res.status(200).json({ success: true, ...content, requestPolicy: requestPolicy(config) });
      }
      return res.status(200).json({ success: true, transcript: transcriptSummary(job), cached: Boolean(job && cached), requestPolicy: requestPolicy(configFn()) });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      // Provider errors can contain signed URLs or private transcript text.
      if (status >= 500) (dependencies.log ?? logger).warn("Video transcript request failed", { operation, status });
      return res.status(status).json({ error: status < 500 || status === 503 ? error.message : "Video transcript request failed" });
    }
  };
}

async function claimTranscriptSweep(firestore, now) {
  const ref = firestore.collection("system").doc("videoTranscriptScheduler");
  const owner = randomUUID();
  return firestore.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current?.leaseUntil > now) return null;
    tx.set(ref, { leaseOwner: owner, leaseUntil: now + 5 * 60 * 1000 }, { merge: true });
    return { ref, owner, after: typeof current?.after === "string" ? current.after : null };
  });
}

async function releaseTranscriptSweep(firestore, sweep, after) {
  return firestore.runTransaction(async (tx) => {
    if ((await tx.get(sweep.ref)).data()?.leaseOwner !== sweep.owner) return;
    tx.set(sweep.ref, { after, leaseOwner: null, leaseUntil: 0 }, { merge: true });
  });
}

async function processTranscriptTick({ firestore = db, config = transcriptConfig(), processor, now = Date.now, paidFallback, uploader } = {}) {
  if (config.bucket && config.accountId && config.controlRoleArn && config.source) {
    try {
      const uploads = require("./source-media-uploads");
      await require("./lib/video-orientation-export").settleExpiredUploads({ firestore, source: config.source, clock: now,
        uploader: uploader ?? require("./lib/s3-media-upload").createS3MediaUploader(runtimeAwsConfig()),
        objectKeyFn: uploads.objectKey, completedAssetFn: uploads.completedAsset,
        assertBillingEnabled: () => assertBillingEnabled(firestore) });
    } catch {
      logger.warn("Video export settlement deferred");
    }
  }
  if (!config.enabled) return { enabled: false };
  if (!configured(config)) throw new Error("transcript_configuration_incomplete");
  const sweep = await claimTranscriptSweep(firestore, now());
  if (!sweep) return { enabled: true, busy: true };
  let cursor = sweep.after;
  try {
    // The document-ID cursor also includes legacy records without provider fields.
    // Reconcile the whole bounded page before spending a single provider step.
    const query = firestore.collection(TRANSCRIPT_JOBS).where("active", "==", true).orderBy("__name__");
    let snapshots = await (cursor ? query.startAfter(cursor) : query).limit(20).get();
    if (cursor && snapshots.docs.length === 0) snapshots = await query.limit(20).get();
    const candidates = [];
    for (const snapshot of snapshots.docs) {
      if (snapshot.data().operatorCanaryId) continue;
      const provider = snapshot.data().provider;
      if (provider !== undefined && !["local", "amazon-transcribe"].includes(provider)) continue;
      try {
        await migratePendingTranscriptToLocal({ firestore, ref: snapshot.ref, source: config.source,
          enabled: config.localEnabled, now: now() });
        if (!await routeLocalFallback({ firestore, ref: snapshot.ref, source: config.source,
          fallbackEnabled: config.fallbackEnabled, audioRequired: config.audioEnabled, now: now() })) continue;
        if (snapshot.data().processingPolicy === PAID_FALLBACK_POLICY) {
          // Load after module initialization: the existing admission handler also
          // reads transcriptConfig, but the scheduler never creates an HTTP call.
          const byok = paidFallback ?? require("./video-transcript-byok");
          if (!await routePaidFallback({ firestore, ref: snapshot.ref, source: config.source,
            settings: { ...byok.config(), amazonFallbackEnabled: !config.localEnabled || config.fallbackEnabled },
            admit: byok.admit, now: now() })) continue;
        }
        candidates.push(snapshot);
      } catch (error) {
        logger.warn("Video transcript routing failed", {
          jobId: snapshot.id, status: Number.isInteger(error?.status) ? error.status : null,
        });
      }
    }
    cursor = snapshots.docs.at(-1)?.id ?? null;
    const run = processor ?? createVideoTranscriptProcessor(config, { firestore });
    await run.prepareLocalInputs?.();
    await run.cleanupAudio?.();
    for (const snapshot of candidates) {
      const job = await claimTranscript(firestore, snapshot.ref, config.source, now());
      if (!job) continue;
      cursor = snapshot.id;
      const save = async (changes) => {
        const stored = await saveTranscript(firestore, snapshot.ref, job, changes);
        if (stored) Object.assign(job, changes);
        return stored;
      };
      try {
        if (now() - Date.parse(job.fallbackAt ?? job.createdAt) > 24 * 60 * 60 * 1000) {
          await save({ phase: "needs_reconciliation", active: false, errorCode: "processing_timeout" });
        } else {
          await run.process(job, save);
          await save({ failures: 0 });
        }
      } catch (error) {
        if (error.code === "audio_preparation_waiting") {
          await save({ processingStage: "preparing", errorCode: null });
          return { enabled: true, jobId: job.id, phase: job.phase };
        }
        if (error.code === "audio_preparation_failed") {
          await save({ active: false, phase: "failed", errorCode: error.failureCode });
          return { enabled: true, jobId: job.id, phase: "failed" };
        }
        const failures = (job.failures ?? 0) + 1;
        await save({ failures, ...(failures >= 5 ? {
          active: false, phase: "needs_reconciliation", errorCode: "processing_failed",
        } : {}) });
        logger.warn("Video transcript step failed", { jobId: job.id, phase: job.phase, failures });
      } finally {
        await save({ leaseUntil: 0 });
        await run.cleanupAudio?.();
      }
      return { enabled: true, jobId: job.id, phase: job.phase };
    }
    return { enabled: true, idle: true };
  } finally {
    // Advance to the job actually processed, never past unprocessed paid jobs.
    // Owner comparison prevents a stale invocation from moving a newer cursor.
    await releaseTranscriptSweep(firestore, sweep, cursor);
  }
}

const options = { cors: true, maxInstances: 10, timeoutSeconds: 60, serviceAccount: FUNCTION_SERVICE_ACCOUNT };
const cmsRequestVideoTranscript = cmsOnRequest(options, createTranscriptHandler("request"));
const cmsGetVideoTranscript = cmsOnRequest(options, createTranscriptHandler("get"));
const cmsCreateVideoTranscriptRead = cmsOnRequest(options, createTranscriptHandler("download"));
const cmsSaveVideoTranscript = cmsOnRequest(options, createTranscriptHandler("edit"));
const { READ_SECRETS, WRITE_SECRETS } = require("./lib/private-video-runtime");
const onVideoTranscriptTick = onSchedule({ schedule: "every 1 minutes", region: "us-central1",
  timeoutSeconds: 240, memory: "256MiB", maxInstances: 1, concurrency: 1,
  serviceAccount: FUNCTION_SERVICE_ACCOUNT, secrets: [...READ_SECRETS, ...WRITE_SECRETS] }, async () => { await processTranscriptTick(); });

module.exports = { cmsRequestVideoTranscript, cmsGetVideoTranscript, cmsCreateVideoTranscriptRead, cmsSaveVideoTranscript,
  onVideoTranscriptTick, createTranscriptHandler, processTranscriptTick, transcriptConfig };

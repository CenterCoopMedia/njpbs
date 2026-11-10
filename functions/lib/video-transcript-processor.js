"use strict";

const { nleExport } = require("./video-transcript-nle");
const { TranscribeClient, GetTranscriptionJobCommand, StartTranscriptionJobCommand } = require("@aws-sdk/client-transcribe");
const { S3Client, CopyObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, PutObjectTaggingCommand } = require("@aws-sdk/client-s3");
const logger = require("firebase-functions/logger");
const { db } = require("./firebase");
const { assertBillingEnabled } = require("./billing-state");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { MAX_RESULT_BYTES, normalizeTranscript, transcriptExports, transcriptLog, transcriptSrt } = require("./video-transcript-contract");
const { createTranscriptAudioRuntime } = require("./video-transcript-audio-runtime");
const { processingChanges } = require("./video-processing-status");
const { releaseLocalQueue } = require("./video-transcript-local-queue");
const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { assertOriginalReadable, mapOriginalStorageError } = require("./source-original-state");

const MAX_UNEXPECTED_PREPARATION_FAILURES = 3;

const PREPARATION_PAUSE_CODES = new Set([
  "audio_preparation_waiting", "failed-precondition", "original_restoring",
  "aborted", "unavailable", "deadline-exceeded", "resource-exhausted", "internal",
  "ABORTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL",
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED",
  4, 8, 10, 13, 14,
]);
const PREPARATION_PAUSE_NAMES = new Set(["SlowDown", "Throttling", "ThrottlingException", "TooManyRequestsException", "RequestTimeout", "TimeoutError"]);
function preparationPaused(error) {
  const status = error?.$metadata?.httpStatusCode ?? error?.status;
  return PREPARATION_PAUSE_CODES.has(error?.code) || PREPARATION_PAUSE_NAMES.has(error?.name) ||
    Boolean(error?.$retryable) || error?.$fault === "server" || status === 408 || status === 429 || status >= 500;
}

const jobName = (job) => `njpbs-boardwalk-transcript-${job.id}`;
function inputKey(job) {
  if (job.providerInputRevision !== "m4a-v1") return `transcripts/inputs/${job.id}/input.mp4`;
  const key = job.amazonAudioInput?.objectKey ?? `transcripts/inputs/amazon/${job.id}/attempts/${job.leaseOwner}/input.m4a`;
  if (!new RegExp(`^transcripts/inputs/amazon/${job.id}/attempts/[a-f0-9-]{36}/input\\.m4a$`).test(key)) {
    throw new Error("transcript_input_identity_invalid");
  }
  return key;
}
const resultKey = (job, format = "json") => `transcripts/results/${job.id}.${format}`;
const editedResultKey = (job, format) => `transcripts/results/${job.id}.edited.${format}`;
const alignedResultKey = (job, requestId, format) =>
  `transcripts/results/${job.id}.aligned.${requestId}.${format}`;

function selectedTranscriptOutputs(job, { base = false, alignmentWork = false } = {}) {
  const revision = job.editRevision ?? 0;
  if (!base && job.alignmentRevision === revision &&
      typeof job.alignmentRequestId === "string" && /^[a-f0-9]{64}$/.test(job.alignmentRequestId) &&
      job.alignedOutputs?.["segments.json"] && (alignmentWork || job.alignmentState === "ready")) {
    const outputRequestId = job.alignedOutputRequestId ?? job.alignmentRequestId;
    if (typeof outputRequestId !== "string" || !/^[a-f0-9]{64}$/.test(outputRequestId)) {
      throw new Error("transcript_alignment_identity_invalid");
    }
    return { outputs: job.alignedOutputs,
      key: (format) => alignedResultKey(job, outputRequestId, format) };
  }
  if (job.editedOutputs?.["segments.json"]) {
    return { outputs: job.editedOutputs, key: (format) => editedResultKey(job, format) };
  }
  return { outputs: job.outputs ?? {}, key: (format) => resultKey(job, format) };
}

function transcriptSegmentsVersion(job, options) {
  return selectedTranscriptOutputs(job, options).outputs["segments.json"] ?? null;
}

async function boundedBody(response) {
  const chunks = [];
  let size = 0;
  try {
    if (response.ContentLength > MAX_RESULT_BYTES) throw new Error("transcript_output_too_large");
    for await (const chunk of response.Body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_RESULT_BYTES) throw new Error("transcript_output_too_large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    response.Body?.destroy?.();
  }
}

function alignmentAudioExpired(job, at) {
  if (!job.audioPreparationStartedAt) return false;
  const started = Date.parse(job.audioPreparationStartedAt);
  return !Number.isFinite(started) || started > at || at - started > 86400000;
}

function createVideoTranscriptProcessor(config, dependencies = {}) {
  const credentials = dependencies.credentials ?? createAwsRoleCredentialProvider({
    roleArn: config.controlRoleArn, audience: config.audience, region: config.region,
  });
  const transcribe = dependencies.transcribe ?? new TranscribeClient({ region: config.region, credentials, maxAttempts: 1 });
  const s3 = dependencies.s3 ?? new S3Client({ region: config.region, credentials, maxAttempts: 3 });
  const sign = dependencies.sign ?? getSignedUrl;
  const firestore = dependencies.firestore ?? db;
  const clock = dependencies.clock ?? Date.now;
  const audio = config.audioEnabled ? dependencies.audio ?? createTranscriptAudioRuntime(config, {
    firestore, s3, credentials, assertBillingEnabled: () => assertBillingEnabled(firestore),
  }) : null;
  const privateAudio = dependencies.privateAudio ?? require("./private-transcript-audio").createPrivateTranscriptAudio({
    firestore, s3, config, storage: require("./private-video-runtime").privateVideoStorage,
  });
  const location = (Key) => ({ Bucket: config.bucket, Key, ExpectedBucketOwner: config.accountId });
  const mediaUri = (job) => `s3://${config.bucket}/${inputKey(job)}`;

  async function existingJob(job) {
    try {
      return (await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName(job) }))).TranscriptionJob;
    } catch (error) {
      // Transcribe uses BadRequestException for a job name that does not exist.
      // Restrict this to the documented missing-job text; other 400s must fail.
      if (error.name === "BadRequestException" && /couldn't be found|cannot be found|not found|does not exist/i.test(error.message ?? "")) return null;
      throw error;
    }
  }

  // Transcribe accepts m4a at start but reports the job's MediaFormat as mp4 (observed October 18, 2026).
  const PREPARED_AUDIO_FORMATS = new Set(["m4a", "mp4"]);
  function validateProviderJob(job, provider) {
    if (provider.TranscriptionJobName !== jobName(job) || provider.LanguageCode !== job.languageCode ||
        provider.Media?.MediaFileUri !== mediaUri(job) || provider.Settings?.ShowSpeakerLabels !== true ||
        provider.Settings?.MaxSpeakerLabels !== job.maxSpeakers ||
        (job.providerInputRevision === "m4a-v1" && !PREPARED_AUDIO_FORMATS.has(provider.MediaFormat))) throw new Error("transcript_job_identity_invalid");
  }

  async function storeResult(job, save) {
    if (!await save({ processingStage: "finalizing", errorCode: null })) return;
    const head = await s3.send(new HeadObjectCommand(location(resultKey(job))));
    if (!head.VersionId || head.ContentLength > MAX_RESULT_BYTES) throw new Error("transcript_output_invalid");
    const raw = await boundedBody(await s3.send(new GetObjectCommand({ ...location(resultKey(job)), VersionId: head.VersionId })));
    const segments = normalizeTranscript(JSON.parse(raw), jobName(job));
    if (!Number.isFinite(job.durationSeconds) || segments.some((segment) => segment.endSeconds > job.durationSeconds + 0.001)) {
      throw new Error("transcript_output_invalid");
    }
    const outputs = await writeExports(job, segments);
    await save({ phase: "ready", active: false, outputs, totalSegments: segments.length });
  }

  async function writeExports(job, segments, speakerNames = {}, edited = false) {
    const formats = { "segments.json": JSON.stringify(segments), ...transcriptExports(segments, speakerNames) };
    // Check every format before the first write; a bound failure leaves no partial exports.
    if (Object.values(formats).some((body) => Buffer.byteLength(body) > MAX_RESULT_BYTES)) {
      throw new Error("transcript_output_too_large");
    }
    const outputs = {};
    try {
      for (const [format, Body] of Object.entries(formats)) {
        const key = edited ? editedResultKey(job, format) : resultKey(job, format);
        const output = await s3.send(new PutObjectCommand({ ...location(key), Body,
          ContentType: format === "segments.json" ? "application/json" : format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8",
          ServerSideEncryption: "AES256", CacheControl: "private, no-store" }));
        if (!output.VersionId) throw new Error("transcript_output_version_missing");
        outputs[format] = output.VersionId;
      }
    } catch (error) {
      if (edited) await discardEdit(job, outputs);
      throw error;
    }
    return outputs;
  }

  async function discardEdit(job, outputs) {
    const results = await Promise.allSettled(Object.entries(outputs).map(([format, VersionId]) =>
      s3.send(new DeleteObjectCommand({ ...location(editedResultKey(job, format)), VersionId }))));
    if (results.some((result) => result.status === "rejected")) {
      (dependencies.log ?? logger).warn("Transcript edit cleanup failed", { jobId: job.id });
    }
  }

  async function retireEdit(job, outputs) {
    const results = await Promise.allSettled(Object.entries(outputs).map(([format, VersionId]) =>
      s3.send(new PutObjectTaggingCommand({ ...location(editedResultKey(job, format)), VersionId,
        Tagging: { TagSet: [{ Key: "transcript-retention", Value: "superseded" }] } }))));
    if (results.some((result) => result.status === "rejected")) {
      (dependencies.log ?? logger).warn("Transcript version retirement failed", { jobId: job.id });
    }
  }

  async function billingReady(save) {
    try { await assertBillingEnabled(dependencies.firestore ?? db); return true; }
    catch { await save({ errorCode: "billing_unavailable" }); return false; }
  }

  async function process(job, save) {
    if (!job || (job.provider !== undefined && job.provider !== "amazon-transcribe")) return;
    const provider = await existingJob(job);
    if (provider) {
      validateProviderJob(job, provider);
      if (provider.TranscriptionJobStatus === "COMPLETED") {
        if (!await save({ audioProviderTerminal: true })) return;
        await deleteProviderAudio(job, save);
        return storeResult(job, save);
      }
      if (provider.TranscriptionJobStatus === "FAILED") {
        if (!await save({ audioProviderTerminal: true })) return;
        await deleteProviderAudio(job, save);
        return save({ phase: "failed", active: false, errorCode: "transcription_failed" });
      }
      if (!["QUEUED", "IN_PROGRESS"].includes(provider.TranscriptionJobStatus)) throw new Error("transcript_status_invalid");
      return save({ phase: "running", processingStage: provider.TranscriptionJobStatus === "QUEUED" ? "queued" : "processing", errorCode: null });
    }
    if (job.phase !== "pending") {
      // A durable start intent can outlive a lost response or provider retention.
      // Only reconcile it. Never issue a second paid start after that boundary.
      if (Date.now() - Date.parse(job.startIntentAt) > 10 * 60 * 1000) {
        await save({ phase: "needs_reconciliation", active: false, errorCode: "start_not_confirmed" });
      }
      return;
    }
    if (!await billingReady(save)) return;
    if (!await save({ processingStage: "preparing", errorCode: null })) return;
    await prepareProviderInput(job, save);
    if (!await billingReady(save)) return;
    if (!await save({ phase: "starting", processingStage: "processing", startIntentAt: new Date().toISOString() })) return;
    // SDK retries are disabled for Transcribe. A timeout is reconciled by GET.
    await transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName(job), LanguageCode: job.languageCode,
      Media: { MediaFileUri: mediaUri(job) }, MediaFormat: job.providerInputRevision === "m4a-v1" ? "m4a" : "mp4",
      Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: job.maxSpeakers },
      OutputBucketName: config.bucket, OutputKey: resultKey(job),
      JobExecutionSettings: { AllowDeferredExecution: true, DataAccessRoleArn: config.dataRoleArn },
    }));
    await save({ phase: "running", processingStage: "processing", errorCode: null });
  }

  async function prepareProviderInput(job, save) {
    const prepared = audio ? await audio.ensure(job) : null;
    const input = prepared?.receipt.output ?? job.input;
    const head = await s3.send(new HeadObjectCommand({ ...location(input.objectKey), VersionId: input.objectVersionId }));
    if (head.VersionId !== input.objectVersionId || head.ContentLength !== input.sizeBytes) throw new Error("transcript_input_changed");
    assertOriginalReadable(head);
    if (job.amazonAudioInput) return;
    const target = prepared ? { ...job, providerInputRevision: "m4a-v1" } : job;
    const copySource = `${config.bucket}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(input.objectVersionId)}`;
    const output = await s3.send(new CopyObjectCommand({ ...location(inputKey(target)), CopySource: copySource,
      ExpectedSourceBucketOwner: config.accountId, ServerSideEncryption: "AES256", MetadataDirective: "REPLACE",
      ContentType: prepared ? "audio/x-m4a" : "video/mp4", Metadata: { "transcript-id": job.id } })).catch(error => { throw mapOriginalStorageError(error); });
    if (prepared) {
      if (!output.VersionId) throw new Error("transcript_input_version_missing");
      const amazonAudioInput = { objectKey: inputKey(target), objectVersionId: output.VersionId };
      if (!await save({ providerInputRevision: "m4a-v1", amazonAudioInput })) {
        await s3.send(new DeleteObjectCommand({ ...location(amazonAudioInput.objectKey), VersionId: output.VersionId }));
        throw new Error("transcript_lease_lost");
      }
      Object.assign(job, { providerInputRevision: "m4a-v1", amazonAudioInput });
    }
  }

  async function deleteProviderAudio(job, save) {
    const input = job.amazonAudioInput;
    if (!input || job.amazonAudioDeleted) return;
    if (job.providerInputRevision !== "m4a-v1") throw new Error("transcript_input_identity_invalid");
    if (input.objectKey !== inputKey(job) || typeof input.objectVersionId !== "string" || !input.objectVersionId) {
      throw new Error("transcript_input_identity_invalid");
    }
    try {
      await s3.send(new DeleteObjectCommand({ ...location(input.objectKey), VersionId: input.objectVersionId }));
      await save({ amazonAudioDeleted: true });
    } catch { (dependencies.log ?? logger).warn("Amazon transcript audio cleanup deferred", { jobId: job.id }); }
  }

  async function readSelected(job, options) {
    const selected = selectedTranscriptOutputs(job, options);
    const VersionId = selected.outputs["segments.json"];
    if (!VersionId) throw new Error("transcript_cache_missing");
    const response = await s3.send(new GetObjectCommand({ ...location(selected.key("segments.json")), VersionId }));
    const segments = JSON.parse(await boundedBody(response));
    if (!Array.isArray(segments) || segments.length !== job.totalSegments) throw new Error("transcript_cache_invalid");
    return segments;
  }

  const read = (job) => readSelected(job);
  const readAlignment = (job) => readSelected(job, { alignmentWork: true });
  const readBase = (job) => readSelected(job, { base: true });

  async function download(job, format) {
    // Rebuild captions from the selected revision so old paragraph caches are never released.
    if (format === "vtt") return storeExport({ key: resultKey(job, `r${job.editRevision ?? 0}.vtt`),
      body: transcriptExports(await read(job), job.speakerNames).vtt,
      contentType: "text/vtt; charset=utf-8", filename: "transcript.vtt" });
    const selected = selectedTranscriptOutputs(job);
    const VersionId = selected.outputs[format];
    if (!["txt", "vtt"].includes(format) || !VersionId) throw new Error("transcript_cache_missing");
    const url = await sign(s3, new GetObjectCommand({ ...location(selected.key(format)), VersionId,
      ResponseContentDisposition: `attachment; filename="transcript.${format}"` }), { expiresIn: 300 });
    return { url, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }
  // Store a generated export privately and return a short-lived download link.
  async function storeExport({ key, body, contentType, filename }) {
    if (Buffer.byteLength(body) > MAX_RESULT_BYTES) throw new Error("transcript_output_too_large");
    try { await assertBillingEnabled(dependencies.firestore ?? db); }
    catch { throw Object.assign(new Error("Transcript export is temporarily unavailable"), { status: 503 }); }
    const output = await s3.send(new PutObjectCommand({ ...location(key), Body: body,
      ContentType: contentType, ServerSideEncryption: "AES256", CacheControl: "private, no-store" }));
    if (!output.VersionId) throw new Error("transcript_output_invalid");
    const url = await sign(s3, new GetObjectCommand({ ...location(key), VersionId: output.VersionId,
      ResponseContentDisposition: `attachment; filename="${filename}"` }), { expiresIn: 300 });
    return { url, expiresAt: new Date(Date.now() + 300000).toISOString() };
  }
  const downloadLog = async (job, metadata) => storeExport({ key: resultKey(job, `r${job.editRevision ?? 0}.tsv`),
    body: transcriptLog(await read(job), job, metadata), contentType: "text/tab-separated-values; charset=utf-8", filename: "transcript-log.tsv" });
  const downloadSrt = async (job) => storeExport({ key: resultKey(job, `r${job.editRevision ?? 0}.srt`),
    body: transcriptSrt(await read(job)), contentType: "application/x-subrip; charset=utf-8", filename: "transcript.srt" });
  const downloadNle = async (job, request) => storeExport(nleExport(await read(job), job, request));
  async function signInput(job, owner) {
    const prepared = audio ? await audio.ensure(job, owner) : null;
    if (prepared) {
      const delivery = await privateAudio.signedInput(prepared.receipt).catch(() => null);
      if (delivery) return delivery;
    }
    return signVideoInput(prepared?.receipt.output ?? job.input, prepared);
  }

  async function signVideoInput(input, prepared = null) {
    const request = { ...location(input.objectKey), VersionId: input.objectVersionId };
    const head = await s3.send(new HeadObjectCommand(request));
    if (head.VersionId !== input.objectVersionId || head.ContentLength !== input.sizeBytes) throw new Error("transcript_input_changed");
    assertOriginalReadable(head);
    const url = await sign(s3, new GetObjectCommand(request), { expiresIn: 300 });
    return { url, expiresAt: new Date(Date.now() + 300000).toISOString(),
      sizeBytes: input.sizeBytes, versionId: input.objectVersionId,
      ...(prepared ? { sha256: input.sha256, mimeType: input.mimeType,
        preparationId: prepared.preparationId, invocationId: prepared.invocationId } : {}) };
  }

  async function failAudioPreparation(snapshot, collection, failureCode, unexpected = false) {
    await firestore.runTransaction(async (tx) => {
      const current = (await tx.get(snapshot.ref)).data();
      const transcriptRef = collection === "mediaSourceTranscriptAlignmentJobs" && current
        ? firestore.collection("mediaSourceTranscriptJobs").doc(current.transcriptId) : null;
      const transcript = transcriptRef ? (await tx.get(transcriptRef)).data() : null;
      if (!current?.active || current.localLeaseToken || current.leaseToken) return;
      const failures = unexpected ? (current.audioPreparationFailures ?? 0) + 1 : null;
      if (unexpected && failures < MAX_UNEXPECTED_PREPARATION_FAILURES) {
        tx.update(snapshot.ref, processingChanges(current, { audioPreparationFailures: failures }, clock()));
        return;
      }
      if (collection === "mediaSourceTranscriptAlignmentJobs" && failureCode === "processing_timeout" &&
          (current.audioInput || !alignmentAudioExpired(current, clock()))) return;
      if (transcriptRef) {
        const updatedAt = new Date(clock()).toISOString();
        tx.update(snapshot.ref, { active: false, phase: "unavailable", errorCode: failureCode, updatedAt });
        if (transcript?.alignmentRequestId === current.id) {
          tx.update(transcriptRef, { alignmentState: "unavailable", alignmentUpdatedAt: updatedAt });
          enqueueVideoSearchShard(tx, firestore, transcript.assetId, transcript.sourceId);
        }
      } else {
        releaseLocalQueue(tx, firestore, current);
        tx.update(snapshot.ref, processingChanges(current,
          { active: false, phase: "failed", errorCode: failureCode,
            ...(unexpected ? { audioPreparationFailures: failures } : {}) }, clock()));
      }
    });
  }

  async function alignmentAudioWaitExpired(snapshot, at) {
    return firestore.runTransaction(async (tx) => {
      const current = (await tx.get(snapshot.ref)).data();
      if (!current?.active || current.audioInput || current.leaseToken) return false;
      if (current.audioPreparationStartedAt) return alignmentAudioExpired(current, at);
      tx.update(snapshot.ref, { audioPreparationStartedAt: new Date(at).toISOString() });
      return false;
    });
  }

  async function resetPreparationFailures(snapshot) {
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(snapshot.ref)).data();
      if (current?.active && current.audioInput && current.audioPreparationFailures) {
        tx.update(snapshot.ref, { audioPreparationFailures: 0 });
      }
    });
  }

  async function prepareLocalInput(snapshot, collection) {
    const { sourceMatches } = require("./video-transcript-worker");
    const row = snapshot.data();
    const job = collection === "mediaSourceTranscriptAlignmentJobs"
      ? (await firestore.collection("mediaSourceTranscriptJobs").doc(row.transcriptId).get()).data() : row;
    if (!job) return;
    const asset = (await firestore.collection("mediaSourceAssets").doc(job.assetId).get()).data();
    if (!sourceMatches(asset, job, config.source)) return;
    // Prepared audio waits for the GPU without a preparation timeout.
    // Alignment retry replaces its row, so its audio-wait clock starts again.
    const expired = collection === "mediaSourceTranscriptJobs"
      ? !row.audioInput && clock() - Date.parse(row.localQueueSlot ? row.audioPreparationStartedAt : row.createdAt) > 86400000
      : await alignmentAudioWaitExpired(snapshot, clock());
    if (expired) {
      return failAudioPreparation(snapshot, collection, "processing_timeout");
    }
    try {
      if (collection === "mediaSourceTranscriptJobs" && row.localQueueSlot && !row.audioPreparationStartedAt) {
        await firestore.runTransaction(async tx => {
          const current = (await tx.get(snapshot.ref)).data();
          if (current?.active && !current.audioPreparationStartedAt) {
            tx.update(snapshot.ref, { audioPreparationStartedAt: new Date(clock()).toISOString() });
          }
        });
      }
      const prepared = await audio.ensure(job, { collection, id: snapshot.id });
      if (collection === "mediaSourceTranscriptJobs" && row.audioPreparationFailures) await resetPreparationFailures(snapshot);
      await privateAudio.read(prepared.receipt).catch(() => null);
    }
    catch (error) {
      // Service pauses keep their existing waits and do not consume input attempts.
      if (preparationPaused(error)) return;
      if (error?.code === "audio_preparation_failed") {
        await failAudioPreparation(snapshot, collection, error.failureCode);
      } else if (collection === "mediaSourceTranscriptJobs" && !row.audioInput) {
        await failAudioPreparation(snapshot, collection, "local_audio_preparation_failed", true);
      } else throw error;
    }
  }

  async function prepareLocalInputs() {
    if (!audio) return;
    for (const collection of ["mediaSourceTranscriptJobs", "mediaSourceTranscriptAlignmentJobs"]) {
      let query = firestore.collection(collection).where("active", "==", true);
      if (collection === "mediaSourceTranscriptJobs") query = query.where("provider", "==", "local");
      const candidates = await query.orderBy("createdAt", "asc").limit(5).get();
      for (const snapshot of candidates.docs) {
        try { await prepareLocalInput(snapshot, collection); }
        catch { (dependencies.log ?? logger).warn("Transcript audio preparation deferred", { jobId: snapshot.id }); }
      }
    }
  }

  async function cleanupAudio() {
    try { await audio?.cleanup(); }
    catch { (dependencies.log ?? logger).warn("Transcript audio cleanup failed"); }
  }
  const edit = (job, segments, speakerNames) => writeExports(job, segments, speakerNames, true);
  async function align(job, segments, speakerNames, requestId) {
    if (typeof requestId !== "string" || !/^[a-f0-9]{64}$/.test(requestId)) {
      throw new Error("transcript_alignment_identity_invalid");
    }
    const formats = { "segments.json": JSON.stringify(segments), ...transcriptExports(segments, speakerNames) };
    if (Object.values(formats).some((body) => Buffer.byteLength(body) > MAX_RESULT_BYTES)) {
      throw new Error("transcript_output_too_large");
    }
    const outputs = {};
    for (const [format, Body] of Object.entries(formats)) {
      const output = await s3.send(new PutObjectCommand({ ...location(alignedResultKey(job, requestId, format)), Body,
        ContentType: format === "segments.json" ? "application/json" : format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8",
        ServerSideEncryption: "AES256", CacheControl: "private, no-store" }));
      if (!output.VersionId) throw new Error("transcript_output_version_missing");
      outputs[format] = output.VersionId;
    }
    return outputs;
  }
  return { process, read, readAlignment, readBase, download, downloadLog, downloadSrt, downloadNle, edit, discardEdit, retireEdit, align, writeExports, signInput, signVideoInput,
    prepareLocalInputs, cleanupAudio };
}

module.exports = { createVideoTranscriptProcessor, jobName, inputKey, resultKey, editedResultKey,
  alignedResultKey, selectedTranscriptOutputs, transcriptSegmentsVersion, boundedBody };

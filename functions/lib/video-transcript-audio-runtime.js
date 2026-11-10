"use strict";

const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { isDeepStrictEqual: same } = require("node:util");
const { GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const audio = require("./video-transcript-audio-input");
const { assertOriginalReadable, mapOriginalStorageError } = require("./source-original-state");

const USES = "mediaTranscriptAudioUses";
const JOBS = "mediaSourceTranscriptJobs";
const ALIGNMENTS = "mediaSourceTranscriptAlignmentJobs";
const problem = (code) => Object.assign(new Error(code), { code });
const waiting = () => problem("audio_preparation_waiting");
const useId = (receipt) => `${receipt.preparationId}-${receipt.invocationId}`;

function configured(config) {
  return config.audioEnabled === true && config.region === "us-east-2" &&
    /^\d{12}$/.test(config.accountId ?? "") && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket ?? "") &&
    config.audioFunctionArn === `arn:aws:lambda:us-east-2:${config.accountId}:function:njpbs-boardwalk-transcript-audio-worker` &&
    /^[a-f0-9]{64}$/.test(config.audioArtifactSha256 ?? "");
}

function finalUse(job, now) {
  if (!job || job.active !== false) return false;
  if (["ready", "failed", "rejected", "complete", "unavailable"].includes(job.phase)) return true;
  // A cancelled/stale local reader can still be stopping after lease loss.
  // An uncertain paid start can still be running at the provider.
  return ["cancelled", "stale", "needs_reconciliation"].includes(job.phase) &&
    (job.audioProviderTerminal === true || (!job.startIntentAt && !job.submissionIntentAt)) &&
    !(job.audioReadLeaseUntil > now);
}

/** All readers register against one version before a URL, stream or copy escapes.
 * A deletion claim fences new readers in the same Firestore transaction.
 */
function createTranscriptAudioRuntime(config, { firestore, s3, credentials, lambda,
  assertBillingEnabled, privateDelivery, clock = Date.now, log = require("firebase-functions/logger") } = {}) {
  if (!configured(config)) throw problem("audio_configuration_incomplete");
  const delivery = privateDelivery ?? require("./private-transcript-audio").createPrivateTranscriptAudio({
    firestore, s3, config, clock, storage: require("./private-video-runtime").privateVideoStorage,
  });
  const invoke = lambda ?? new LambdaClient({ region: config.region, credentials, maxAttempts: 1 });
  const location = (Key, VersionId) => ({ Bucket: config.bucket, Key,
    ExpectedBucketOwner: config.accountId, ...(VersionId ? { VersionId } : {}) });

  async function verify(receipt) {
    const output = receipt.output;
    const head = await s3.send(new HeadObjectCommand(location(output.objectKey, output.objectVersionId)));
    if (head.VersionId !== output.objectVersionId || head.ContentLength !== output.sizeBytes ||
        head.ContentType !== output.mimeType || head.Metadata?.sha256 !== output.sha256 ||
        head.Metadata?.["preparation-id"] !== receipt.preparationId ||
        head.Metadata?.["invocation-id"] !== receipt.invocationId ||
        head.Metadata?.["artifact-sha256"] !== config.audioArtifactSha256) throw problem("audio_input_changed");
    assertOriginalReadable(head);
    return output;
  }

  async function readReceipt(claim) {
    const key = audio.preparationKeys(claim.id, claim.invocationId).receiptKey;
    let response;
    try { response = await s3.send(new GetObjectCommand(location(key))); }
    catch (error) {
      // Missing private keys can return 403 without bucket-list permission.
      // This only means wait; it never permits a provider start or reinvoke.
      if (["NoSuchKey", "NotFound", "AccessDenied"].includes(error.name)) return null;
      throw error;
    }
    let size = 0;
    const chunks = [];
    try {
      if (!response.VersionId || !(response.ContentLength > 0) || response.ContentLength > 16384) {
        throw problem("audio_preparation_receipt_invalid");
      }
      for await (const chunk of response.Body) {
        size += chunk.length;
        if (size > 16384) throw problem("audio_preparation_receipt_invalid");
        chunks.push(Buffer.from(chunk));
      }
      if (size !== response.ContentLength) throw problem("audio_preparation_receipt_invalid");
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { response.Body?.destroy?.(); }
  }

  async function bind(job, receipt, owner) {
    const ref = firestore.collection(USES).doc(useId(receipt));
    const ownerRef = firestore.collection(owner.collection).doc(owner.id);
    const bound = await firestore.runTransaction(async (tx) => {
      const preparation = (await tx.get(firestore.collection(audio.COLLECTION).doc(receipt.preparationId))).data();
      const uses = (await tx.get(ref)).data();
      const current = (await tx.get(ownerRef)).data();
      if (preparation?.state !== "ready" || !same(preparation.receipt, receipt) ||
          (uses && uses.state !== "active")) throw waiting();
      if (!current?.active || (owner.collection === JOBS
        ? audio.preparationId(current, config.bucket, config.audioArtifactSha256) !== receipt.preparationId
        : current.transcriptId !== job.id)) throw problem("audio_job_changed");
      const owners = uses?.owners ?? [];
      if (!owners.some((value) => value.collection === owner.collection && value.id === owner.id)) owners.push(owner);
      if (owners.length > 1000) throw problem("audio_reference_limit");
      const audioInput = { preparationId: receipt.preparationId, invocationId: receipt.invocationId, receipt };
      tx.set(ref, { state: "active", receipt, owners });
      tx.update(ownerRef, { audioInput });
      return audioInput;
    });
    return bound;
  }

  async function ensure(job, owner = { collection: JOBS, id: job.id }) {
    if (![JOBS, ALIGNMENTS].includes(owner.collection) || !/^[a-f0-9]{64}$/.test(owner.id ?? "")) {
      throw problem("audio_job_invalid");
    }
    await assertBillingEnabled();
    const sourceHead = await s3.send(new HeadObjectCommand(location(job.input.objectKey, job.input.objectVersionId)))
      .catch((error) => { throw mapOriginalStorageError(error); });
    if (sourceHead.VersionId !== job.input.objectVersionId || sourceHead.ContentLength !== job.input.sizeBytes) {
      throw problem("audio_input_changed");
    }
    assertOriginalReadable(sourceHead);
    let claim = await audio.claimPreparation({ firestore, job, renditionBucket: config.bucket,
      ffmpegArtifactSha256: config.audioArtifactSha256, now: clock() });
    if (claim.outcome === "invoke") {
      await assertBillingEnabled();
      const payload = { schemaVersion: 1, preparationId: claim.id, invocationId: claim.invocationId,
        revision: audio.PREPARATION_REVISION, ffmpegArtifactSha256: config.audioArtifactSha256,
        input: { bucket: config.bucket, objectKey: job.input.objectKey,
          objectVersionId: job.input.objectVersionId, sizeBytes: job.input.sizeBytes, durationSeconds: job.durationSeconds },
        output: { bucket: config.bucket, ...claim.keys } };
      // Durable lease precedes transport. An uncertain response waits for the
      // receipt or lease expiry; the SDK must never retry this invocation.
      try { await invoke.send(new InvokeCommand({ FunctionName: config.audioFunctionArn,
        InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload)) })); }
      catch (error) {
        const status = error.$metadata?.httpStatusCode;
        if (status >= 400 && status < 500) {
          await audio.rejectInvocation({ firestore, id: claim.id, invocationId: claim.invocationId, now: clock() });
          log.warn("Transcript audio invocation rejected", { preparationId: claim.id, invocationId: claim.invocationId,
            httpStatus: status, errorCode: /^[A-Za-z0-9_.:-]{1,80}$/.test(error.name ?? "") ? error.name : "Error" });
        }
        // Transport loss and server errors remain uncertain; keep their lease.
      }
      throw waiting();
    }
    if (claim.outcome === "waiting") {
      const receipt = await readReceipt(claim);
      if (!receipt) throw waiting();
      const identity = audio.inputIdentity(job, config.bucket, config.audioArtifactSha256);
      audio.validateReceipt(identity, claim.id, claim.invocationId, receipt);
      const verifiedOutput = receipt.outcome === "ready" ? await verify(receipt) : undefined;
      claim = await audio.acceptPreparation({ firestore, id: claim.id, invocationId: claim.invocationId,
        receipt, verifiedOutput, now: clock() });
    }
    if (claim.outcome === "failed") throw Object.assign(problem("audio_preparation_failed"), { failureCode: claim.failureCode });
    if (claim.outcome !== "ready") throw waiting();
    try { await verify(claim.receipt); }
    catch (error) {
      let reason = "output_missing";
      if (!["NoSuchKey", "NoSuchVersion", "NotFound"].includes(error.name) && error.$metadata?.httpStatusCode !== 404) {
        if (!["AccessDenied", "Forbidden"].includes(error.name) && error.$metadata?.httpStatusCode !== 403) throw error;
        const record = (await firestore.collection(audio.COLLECTION).doc(claim.receipt.preparationId).get()).data();
        if (record && (record.state !== "ready" || !same(record.receipt, claim.receipt))) throw waiting();
        // HEAD can hide an expired private version behind 403. Recover after
        // the seven-day backstop; a new permission error must not cause a billing loop.
        if (!record || clock() - record.updatedAt < 7 * 86400000) throw error;
        reason = "output_unreadable";
      }
      await audio.invalidatePreparation({ firestore, id: claim.receipt.preparationId,
        receipt: claim.receipt, reason, now: clock() });
      throw waiting();
    }
    const bound = await bind(job, claim.receipt, owner);
    if (owner.collection === JOBS) job.audioInput = bound;
    return bound;
  }

  async function cleanupReceipt(receipt) {
    const ref = firestore.collection(USES).doc(useId(receipt));
    const deleting = await firestore.runTransaction(async (tx) => {
      const uses = (await tx.get(ref)).data();
      if (!uses || uses.state === "deleted" || !same(uses.receipt, receipt)) return false;
      const preparation = (await tx.get(firestore.collection(audio.COLLECTION).doc(receipt.preparationId))).data();
      if (!preparation || audio.validateReceipt(preparation.identity, receipt.preparationId,
        receipt.invocationId, receipt).outcome !== "ready" || !Array.isArray(uses.owners) || !uses.owners.length ||
        uses.owners.some((owner) => ![JOBS, ALIGNMENTS].includes(owner.collection) || !/^[a-f0-9]{64}$/.test(owner.id))) {
        throw problem("audio_cleanup_identity_invalid");
      }
      if (uses.state === "deleting") return { providerCopies: uses.providerCopies ?? [] };
      const jobs = await Promise.all(uses.owners.map((owner) => tx.get(firestore.collection(owner.collection).doc(owner.id))));
      if (!jobs.every((snapshot) => finalUse(snapshot.data(), clock()))) return false;
      const providerCopies = jobs.map((snapshot) => snapshot.data()).filter((job) =>
        job.amazonAudioInput && !job.amazonAudioDeleted).map((job) => ({ jobId: job.id, ...job.amazonAudioInput }));
      tx.update(ref, { state: "deleting", providerCopies });
      return { providerCopies };
    });
    if (!deleting) return false;
    await delivery.revoke({ receipt });
    // A crash leaves a deleting record. Retrying this exact version is safe.
    for (const copy of deleting.providerCopies) {
      if (!/^[a-f0-9]{64}$/.test(copy.jobId) ||
        !new RegExp(`^transcripts/inputs/amazon/${copy.jobId}/attempts/[a-f0-9-]{36}/input\\.m4a$`).test(copy.objectKey) ||
        typeof copy.objectVersionId !== "string" || !copy.objectVersionId || copy.objectVersionId === "null") {
        throw problem("audio_cleanup_identity_invalid");
      }
      await s3.send(new DeleteObjectCommand(location(copy.objectKey, copy.objectVersionId)));
    }
    await s3.send(new DeleteObjectCommand(location(receipt.output.objectKey, receipt.output.objectVersionId)));
    await audio.invalidatePreparation({ firestore, id: receipt.preparationId, receipt,
      reason: "output_missing", now: clock() });
    await firestore.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current?.state === "deleting" && same(current.receipt, receipt)) tx.update(ref, { state: "deleted" });
    });
    return true;
  }

  async function cleanup() {
    // The bounded sweep repairs a failed immediate delete and handles jobs that
    // became terminal through expiry, source retirement or cancellation.
    let failed = false;
    for (const state of ["deleting", "active"]) {
      const cursorRef = firestore.collection("system").doc(`transcriptAudioCleanup-${state}`);
      const after = (await cursorRef.get()).data()?.after;
      const query = firestore.collection(USES).where("state", "==", state).orderBy("__name__");
      let page = await (after ? query.startAfter(after) : query).limit(20).get();
      if (after && !page.docs.length) page = await query.limit(20).get();
      for (const snapshot of page.docs) {
        try { await cleanupReceipt(snapshot.data().receipt); }
        catch { failed = true; }
      }
      await cursorRef.set({ after: page.docs.at(-1)?.id ?? null });
    }
    if (failed) throw problem("audio_cleanup_failed");
  }

  return { ensure, verify, cleanup, cleanupReceipt };
}

module.exports = { createTranscriptAudioRuntime, configured, finalUse, USES };

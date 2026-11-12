"use strict";

const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { processingChanges, requesterName } = require("./video-processing-status");
const { createHash, randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { sameOriginal } = require("./video-preview-job");
const { parseSourceMediaAsset, SourceMediaValidationError } = require("./source-media-contract");
const { mayChangeSharedTranscripts, objectKeyWithinSource } = require("./media-sources");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { registeredPrincipalFromUserDoc } = require("./principal");
const { ENGINE_REVISION, transcriptId, transcriptInput } = require("./video-transcript-contract");

const { variantId, MODEL: BYOK_MODEL, ADAPTER_REVISION: BYOK_REVISION, AUDIO_ADAPTER_REVISION } = require("./video-transcript-byok-job");
const { LOCAL_ENGINE, sourceMatches, WORKERS, WORKER_ID } = require("./video-transcript-worker");
const { ALIGNMENT_JOBS } = require("./video-transcript-alignment-job");
const { PAID_FALLBACK_POLICY } = require("./video-transcript-fallback-policy");
const { readLocalQueue, reserveLocalQueue, releaseLocalQueue, requeueLocalFallback } = require("./video-transcript-local-queue");
const { admitAmazon, LIMITS: PAID_LIMITS } = require("./video-transcript-paid-budget");
const { transcriptAttempt, readAttemptSlot, assertAttemptProvider,
  readFreeRetryLimits, reserveFreeRetryLimits } = require("./video-transcript-attempt");
const TRANSCRIPT_JOBS = "mediaSourceTranscriptJobs";
const TRANSCRIPT_LIMITS = "mediaSourceTranscriptLimits";
const LEASE_MS = 5 * 60 * 1000;
// Cached-export HTTP functions have a 60-second deadline. Keep a lost writer
// fenced past that deadline; concurrent exports own separate claims.
const EXPORT_WRITE_LEASE_MS = 15 * 60 * 1000;
const ACTOR_DAILY_LIMIT = 5;
const GLOBAL_DAILY_LIMIT = 20;
const GLOBAL_OUTSTANDING_LIMIT = 20;
const LEGACY_DAILY_READ_LIMIT = 500;

function activeAsset(snapshot, source) {
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) {
    throw new SourceMediaValidationError("Video not found", 404);
  }
  return { ...asset, lifecycle: "active" };
}

function occupiesTranscriptSlot(job) {
  return Boolean(job?.active || job?.phase === "needs_reconciliation");
}

function utcDayRange(day) {
  const startMs = Date.parse(`${day}T00:00:00Z`);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function legacyPaidJob(job) {
  return Boolean(job && [undefined, "amazon-transcribe"].includes(job.provider) && !job.localQueueSlot && !job.fallbackAt);
}

async function listLegacyOutstandingIds(tx, firestore) {
  const jobs = firestore.collection(TRANSCRIPT_JOBS);
  const [active, reconciling] = await Promise.all([
    tx.get(jobs.where("active", "==", true).limit(GLOBAL_OUTSTANDING_LIMIT)),
    tx.get(jobs.where("phase", "==", "needs_reconciliation").limit(GLOBAL_OUTSTANDING_LIMIT)),
  ]);
  return [...new Set([
    ...active.docs.filter(doc => legacyPaidJob(doc.data())).map((doc) => doc.id),
    ...reconciling.docs.filter(doc => legacyPaidJob(doc.data())).map((doc) => doc.id),
  ])].slice(0, GLOBAL_OUTSTANDING_LIMIT);
}

async function countLegacyDailyJobs(tx, firestore, day, actorUid) {
  const { start, end } = utcDayRange(day);
  const snapshot = await tx.get(
    firestore.collection(TRANSCRIPT_JOBS)
      .where("createdAt", ">=", start)
      .where("createdAt", "<", end)
      .limit(LEGACY_DAILY_READ_LIMIT),
  );
  const today = snapshot.docs.map((doc) => doc.data()).filter(legacyPaidJob);
  // A full mixed sample cannot prove the paid allowance. Never lower its counter.
  if (snapshot.size === LEGACY_DAILY_READ_LIMIT && today.length < GLOBAL_DAILY_LIMIT) {
    throw new SourceMediaValidationError("The paid transcript allowance cannot be verified. Ask an administrator to check paid limits or enable local processing", 429);
  }
  return {
    actorCount: today.filter((job) => job.requestedBy === actorUid).length,
    globalCount: today.length,
  };
}

async function readReadyLocalAttempt(tx, firestore, asset, source, request) {
  const web = asset.rendition.web;
  const page = await tx.get(firestore.collection(TRANSCRIPT_JOBS)
    .where("assetId", "==", asset.id).where("sourceId", "==", source.id)
    .where("sourceBucket", "==", source.bucket).where("sourceObjectKey", "==", asset.objectKey)
    .where("sourceObjectVersionId", "==", asset.objectVersionId).where("sourceSizeBytes", "==", asset.sizeBytes)
    .where("input.objectKey", "==", web.objectKey).where("input.objectVersionId", "==", web.objectVersionId)
    .where("input.sizeBytes", "==", web.sizeBytes).where("input.durationSeconds", "==", web.durationSeconds)
    .where("languageCode", "==", request.languageCode).where("maxSpeakers", "==", request.maxSpeakers)
    .where("phase", "==", "ready").where("active", "==", false).where("provider", "==", "local")
    .where("engineRevision", "==", ENGINE_REVISION).where("localEngineRevision", "==", LOCAL_ENGINE).limit(20));
  for (const row of page.docs) {
    const job = row.data();
    if (job?.id === row.id && job.durationSeconds === web.durationSeconds &&
        sourceMatches(asset, job, source) && transcriptId(asset, source.bucket, job) === job.id) {
      return job;
    }
  }
  if (page.docs.length === 20) {
    throw new SourceMediaValidationError("Transcript request history needs an administrator's check", 503);
  }
  return null;
}

async function requestTranscript({ firestore, source, request, actor, now = Date.now(), audit = adminLogEntry, localEnabled = false, paidFallbackEnabled = false, operatorCanaryId }) {
  if (request.provider === "local" && !localEnabled) {
    throw new SourceMediaValidationError("Local transcription is unavailable", 503);
  }
  const useLocal = request.provider ? request.provider === "local" : localEnabled;
  if (request.provider) paidFallbackEnabled = false;
  if (operatorCanaryId !== undefined && !/^[a-f0-9]{64}$/.test(operatorCanaryId)) throw new Error("transcript_canary_invalid");
  const actorLimitRef = firestore.collection(TRANSCRIPT_LIMITS).doc(createHash("sha256").update(actor.uid).digest("hex"));
  const day = new Date(now).toISOString().slice(0, 10);
  const dayLimitRef = firestore.collection(TRANSCRIPT_LIMITS).doc(`day-${day}`);
  const outstandingLimitRef = firestore.collection(TRANSCRIPT_LIMITS).doc("outstanding");
  return firestore.runTransaction(async (tx) => {
    const asset = activeAsset(await tx.get(firestore.collection("mediaSourceAssets").doc(request.assetId)), source);
    const attempt = await transcriptAttempt(tx, firestore, asset, source, request.newAttemptOf, request.attemptKey);
    const replaces = (job) => request.newAttemptOf && job?.active === false &&
      (job.id === request.newAttemptOf || job.fallbackTranscriptId === request.newAttemptOf);
    const identity = { ...request, ...(request.provider ? { requestedProvider: request.provider, ...attempt } : {}) };
    const id = transcriptId(asset, source.bucket, identity);
    const ref = firestore.collection(TRANSCRIPT_JOBS).doc(id);
    const previous = (await tx.get(ref)).data();
    if (previous) return { job: previous, cached: true };
    if (request.provider === "local") {
      const ready = await readReadyLocalAttempt(tx, firestore, asset, source, request);
      if (ready) return { job: ready, cached: true };
    }
    const attemptSlot = await readAttemptSlot(tx, firestore, asset, source, request);
    if (attemptSlot?.job) {
      assertAttemptProvider(attemptSlot.job, useLocal ? "local" : "amazon-transcribe");
      return { job: attemptSlot.job, cached: true };
    }
    let freeRetryLimits = null;
    if (request.provider === "local" && request.newAttemptOf) {
      freeRetryLimits = await readFreeRetryLimits(tx, firestore, request.newAttemptOf, actor.uid, day);
    }
    const input = transcriptInput(asset);
    if (!useLocal && Math.ceil(input.durationSeconds) > PAID_LIMITS.requester.audioSeconds) {
      throw new SourceMediaValidationError("Paid transcription supports videos of one hour or less. Ask an administrator about local processing for longer videos", 409);
    }
    const localIds = useLocal ? await readLocalQueue(tx, firestore) : null;
    let actorCount = 0, globalCount = 0, activeIds = [];
    if (!useLocal) {
      const [actorLimitSnapshot, dayLimitSnapshot, outstandingLimitSnapshot] = await Promise.all([
        tx.get(actorLimitRef), tx.get(dayLimitRef), tx.get(outstandingLimitRef),
      ]);
      const actorLimit = actorLimitSnapshot.data() ?? {};
      const outstandingIds = outstandingLimitSnapshot.exists
        ? (Array.isArray(outstandingLimitSnapshot.data()?.activeIds)
          ? outstandingLimitSnapshot.data().activeIds.slice(0, GLOBAL_OUTSTANDING_LIMIT) : [])
        : await listLegacyOutstandingIds(tx, firestore);
      const outstandingJobs = await Promise.all(outstandingIds.map((activeId) =>
        tx.get(firestore.collection(TRANSCRIPT_JOBS).doc(activeId))));
      const outstanding = outstandingIds.map((activeId, index) => ({
        id: activeId,
        job: outstandingJobs[index].data(),
      })).filter(({ job }) => legacyPaidJob(job) && occupiesTranscriptSlot(job) && !replaces(job));
      activeIds = outstanding.map(({ id }) => id);
      const actorJob = actorLimit.activeId
        ? (await tx.get(firestore.collection(TRANSCRIPT_JOBS).doc(actorLimit.activeId))).data() : null;
      const actorWasLocal = Boolean(actorJob && !legacyPaidJob(actorJob));
      const oldQueueHadLocal = outstandingJobs.some(snapshot => snapshot.exists && !legacyPaidJob(snapshot.data()));
      const actorBusy = actorLimitSnapshot.exists && actorLimit.activeId
        ? legacyPaidJob(actorJob) && occupiesTranscriptSlot(actorJob) && !replaces(actorJob)
        : outstanding.some(({ job }) => job?.requestedBy === actor.uid);
      if (actorBusy) {
        const blocking = actorJob ?? outstanding.find(({ job }) => job?.requestedBy === actor.uid)?.job;
        const uncertainForVideo = request.newAttemptOf && blocking?.active === false &&
          blocking.phase === "needs_reconciliation" && blocking.assetId === asset.id && sourceMatches(asset, blocking, source);
        throw new SourceMediaValidationError(uncertainForVideo
          ? "An earlier Amazon request for this video is not confirmed yet. Choose that request in the saved transcript list to try again."
          : "Wait for your current transcript to finish", 429);
      }
      actorCount = actorLimitSnapshot.exists && actorLimit.day === day ? actorLimit.count ?? 0 : 0;
      globalCount = dayLimitSnapshot.exists ? dayLimitSnapshot.data()?.count ?? 0 : 0;
      if (!actorLimitSnapshot.exists || !dayLimitSnapshot.exists || actorWasLocal || oldQueueHadLocal) {
        const legacy = await countLegacyDailyJobs(tx, firestore, day, actor.uid);
        if (!actorLimitSnapshot.exists || actorWasLocal) actorCount = legacy.actorCount;
        if (!dayLimitSnapshot.exists || oldQueueHadLocal) globalCount = legacy.globalCount;
      }
      if (actorCount >= ACTOR_DAILY_LIMIT || globalCount >= GLOBAL_DAILY_LIMIT) {
        throw new SourceMediaValidationError("The daily transcript limit has been reached", 429);
      }
      if (activeIds.length >= GLOBAL_OUTSTANDING_LIMIT) {
        throw new SourceMediaValidationError("The transcript queue is full", 429);
      }
    }
    const job = {
      id, assetId: asset.id, sourceId: source.id, sourceBucket: source.bucket,
      ...(operatorCanaryId ? { operatorCanaryId } : {}),
      sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
      sourceSizeBytes: asset.sizeBytes, languageCode: request.languageCode,
      maxSpeakers: request.maxSpeakers, engineRevision: ENGINE_REVISION,
      ...(request.provider ? { requestedProvider: request.provider, attemptGeneration: 0, ...attempt } : {}),
      provider: useLocal ? "local" : "amazon-transcribe",
      processingPolicy: paidFallbackEnabled ? PAID_FALLBACK_POLICY : useLocal ? "local-first-v1" : "amazon-only-v1",
      ...(paidFallbackEnabled ? { requestedAuthTime: Number.isFinite(actor.authTime) ? actor.authTime : null,
        ...(!useLocal ? { paidFallbackState: "pending" } : {}) } : {}),
      ...(useLocal ? { localEngineRevision: LOCAL_ENGINE, localQueueSlot: true } : {}),
      input, durationSeconds: input.durationSeconds, phase: "pending", active: true,
      requestedBy: actor.uid, requesterDisplayName: requesterName(actor.displayName), createdAt: new Date(now).toISOString(), leaseUntil: 0,
    };
    tx.create(ref, job);
    if (attemptSlot) tx.set(attemptSlot.ref, { activeId: id });
    if (useLocal) {
      reserveLocalQueue(tx, firestore, localIds, id);
      if (freeRetryLimits) reserveFreeRetryLimits(tx, freeRetryLimits, request.newAttemptOf, id);
    }
    else {
      tx.set(actorLimitRef, { day, count: actorCount + 1, activeId: id });
      tx.set(dayLimitRef, { count: globalCount + 1 });
      tx.set(outstandingLimitRef, { activeIds: [...activeIds, id] });
    }
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: "media.transcript.request",
      target: `${TRANSCRIPT_JOBS}/${id}`,
      after: { assetId: asset.id, languageCode: job.languageCode, maxSpeakers: job.maxSpeakers, engineRevision: ENGINE_REVISION,
        ...(request.provider ? { provider: request.provider, attemptGeneration: job.attemptGeneration, previousTranscriptId: request.newAttemptOf ?? null } : {}) },
    }));
    return { job, cached: false };
  });
}

function assertSelectedTranscript(asset, source, request, job, renditionBucket) {
  const selectedId = request.transcriptId ?? job?.id;
  if (!job || job.id !== selectedId || job.assetId !== asset.id || job.sourceId !== source.id ||
      job.sourceBucket !== source.bucket || !sameOriginal(asset, job)) {
    throw new SourceMediaValidationError("Transcript not found for this video", 404);
  }
  if (job.provider === "elevenlabs") {
    let valid = false;
    try {
      valid = request.transcriptId === job.id && variantId(job.identity) === job.id &&
        job.model === BYOK_MODEL && job.adapterRevision === (job.identity.inputRevision ? AUDIO_ADAPTER_REVISION : BYOK_REVISION) &&
        job.languageCode === job.identity.languageCode && job.maxSpeakers === job.identity.maxSpeakers &&
        job.identity.assetId === asset.id && job.identity.sourceId === source.id &&
        job.identity.originalBucket === source.bucket && job.identity.originalKey === asset.objectKey &&
        job.identity.originalVersion === asset.objectVersionId && job.identity.originalSize === asset.sizeBytes &&
        typeof renditionBucket === "string" && job.identity.renditionBucket === renditionBucket &&
        job.identity.durationSeconds === asset.rendition?.web?.durationSeconds &&
        job.identity.durationSeconds === job.durationSeconds && job.input?.durationSeconds === job.durationSeconds &&
        job.identity.renditionKey === job.input?.objectKey && job.identity.renditionVersion === job.input?.objectVersionId &&
        job.identity.renditionSize === job.input?.sizeBytes && sourceMatches(asset, job, source);
    } catch { /* Malformed variants never release private data. */ }
    if (!valid) throw new SourceMediaValidationError("Video changed. Reload the transcript", 409);
  } else if (![undefined, "local", "amazon-transcribe"].includes(job.provider) || transcriptId(asset, source.bucket, job) !== job.id) {
    throw new SourceMediaValidationError("Transcript not found for this video", 404);
  }
}

async function getTranscriptJob({ firestore, source, request, renditionBucket }) {
  return firestore.runTransaction(async (tx) => {
    const asset = activeAsset(await tx.get(firestore.collection("mediaSourceAssets").doc(request.assetId)), source);
    async function selected(job, id) {
      if (!job) return null;
      assertSelectedTranscript(asset, source, { ...request, transcriptId: id }, job, renditionBucket);
      if (job.processingPolicy !== PAID_FALLBACK_POLICY || !["waiting", "ready"].includes(job.paidFallbackState)) return job;
      if (!/^[a-f0-9]{64}$/.test(job.fallbackTranscriptId ?? "")) {
        throw new SourceMediaValidationError("Transcript fallback is unavailable", 409);
      }
      const child = (await tx.get(firestore.collection(TRANSCRIPT_JOBS).doc(job.fallbackTranscriptId))).data();
      assertSelectedTranscript(asset, source, { ...request, transcriptId: job.fallbackTranscriptId }, child, renditionBucket);
      if (child.provider !== "elevenlabs" || child.identity.credentialScope !== "organization" ||
          child.languageCode !== job.languageCode || child.maxSpeakers !== job.maxSpeakers) {
        throw new SourceMediaValidationError("Transcript fallback changed", 409);
      }
      return child;
    }
    const collection = firestore.collection(TRANSCRIPT_JOBS);
    if (request.transcriptId) return selected((await tx.get(collection.doc(request.transcriptId))).data(), request.transcriptId);
    const query = collection.where("assetId", "==", asset.id)
      .where("languageCode", "==", request.languageCode).where("maxSpeakers", "==", request.maxSpeakers);
    let legacy, newest;
    // Ready output remains the default while another provider is queued or failed.
    // Both scans are indexed and bounded; selected variants still use one direct read.
    for (const readyOnly of [true, false]) {
      const page = await tx.get((readyOnly ? query.where("phase", "==", "ready") : query)
        .orderBy("createdAt", "desc").limit(20));
      for (const row of page.docs) {
        const candidate = row.data();
        if (candidate.languageCode !== request.languageCode || candidate.maxSpeakers !== request.maxSpeakers) continue;
        try {
          const result = await selected(candidate, row.id);
          if (result?.phase === "ready" || (!readyOnly && result?.active)) return result;
          if (!readyOnly) newest ??= result;
        } catch (error) {
          if (![404, 409].includes(error.status)) throw error;
        }
      }
      if (readyOnly) {
        // Older rows can lack createdAt and are omitted by an ordered query.
        const legacyId = transcriptId(asset, source.bucket, request);
        legacy = await selected((await tx.get(collection.doc(legacyId))).data(), legacyId);
        if (legacy?.phase === "ready") return legacy;
      }
    }
    // A failed fallback child must not hide its parent while Amazon is still running.
    return legacy?.active ? legacy : newest ?? legacy ?? null;
  });
}

async function transcriptLogMetadata({ firestore, source, request, job, renditionBucket }) {
  const asset = activeAsset(await firestore.collection("mediaSourceAssets").doc(request.assetId).get(), source);
  assertSelectedTranscript(asset, source, request, job, renditionBucket);
  return { title: asset.name || asset.originalName || asset.objectKey.split("/").at(-1),
    assetId: asset.id, sourceVersion: asset.objectVersionId };
}

function assertTranscriptRevision(job, revision, id = job?.id) {
  if (!job || job.phase !== "ready" || job.id !== id || (job.editRevision ?? 0) !== revision) {
    throw new SourceMediaValidationError("Transcript changed. Reload the transcript before saving", 409);
  }
}

// Approving an alignment keeps editRevision, so a read must also keep the same alignment selection.
function assertSameTranscriptOutputs(current, job) {
  assertTranscriptRevision(current, job.editRevision ?? 0, job.id);
  if (["alignmentState", "alignmentRevision", "alignmentRequestId", "alignedOutputRequestId"].some((field) => current[field] !== job[field])) {
    throw new SourceMediaValidationError("Transcript changed. Reload the transcript before saving", 409);
  }
}

async function withTranscriptWriteLease({ firestore, source, request, job, renditionBucket, log = console }, run) {
  const ref = firestore.collection(TRANSCRIPT_JOBS).doc(job.id);
  const owner = randomUUID();
  await firestore.runTransaction(async tx => {
    const asset = activeAsset(await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId)), source);
    const current = (await tx.get(ref)).data();
    assertSelectedTranscript(asset, source, { ...request, transcriptId: job.id }, current, renditionBucket);
    assertSameTranscriptOutputs(current, job);
    const now = Date.now();
    const leases = Object.fromEntries(Object.entries(current.exportWriteLeases ?? {}).filter(([, until]) => until > now));
    // The cleanup transaction reads this same job before claiming its version.
    // Reading the current asset also excludes a writer admitted after promotion.
    tx.update(ref, { exportWriteLeases: { ...leases, [owner]: now + EXPORT_WRITE_LEASE_MS } });
  });
  try { return await run(); }
  finally {
    try {
      await firestore.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (!current?.exportWriteLeases?.[owner]) return;
        const leases = { ...current.exportWriteLeases };
        delete leases[owner];
        tx.update(ref, { exportWriteLeases: Object.keys(leases).length ? leases : FieldValue.delete() });
      });
    } catch {
      // The finite lease still fences cleanup when release is unavailable.
      log.warn("Transcript write lease release failed");
    }
  }
}

async function commitTranscriptEdit({ firestore, source, request, job, editedOutputs, speakerNames, speakerRoles, actor, renditionBucket, audit = adminLogEntry }) {
  return firestore.runTransaction(async (tx) => {
    // Current authority joins the read set so concurrent revocation retries the commit.
    const user = await tx.get(firestore.collection("users").doc(actor.uid));
    const principal = await registeredPrincipalFromUserDoc(firestore, actor.uid, user.data(), tx);
    if (!user.exists || !mayChangeSharedTranscripts(principal)) {
      throw new SourceMediaValidationError("Transcript access denied", 403);
    }
    const asset = activeAsset(await tx.get(firestore.collection("mediaSourceAssets").doc(request.assetId)), source);
    assertSelectedTranscript(asset, source, request, job, renditionBucket);
    const ref = firestore.collection(TRANSCRIPT_JOBS).doc(job.id);
    const current = (await tx.get(ref)).data();
    assertSelectedTranscript(asset, source, request, current, renditionBucket);
    assertTranscriptRevision(current, request.revision, job.id);
    const at = new Date().toISOString();
    const alignmentReview = request.reviewed === true && current.alignmentState === "review_required" &&
      current.alignmentRevision === request.revision && typeof current.alignmentRequestId === "string" &&
      current.alignedOutputs?.["segments.json"];
    const changes = alignmentReview
      ? { editRevision: request.revision, reviewedRevision: request.revision,
        reviewedAt: at, reviewedBy: actor.uid, reviewedByName: requesterName(actor.displayName),
        reviewedAlignmentRequestId: current.alignmentRequestId, alignmentState: "ready", alignmentUpdatedAt: at }
      : request.reviewed === true
        ? { editRevision: request.revision + 1, reviewedRevision: request.revision + 1,
          reviewedAt: at, reviewedBy: actor.uid, reviewedByName: requesterName(actor.displayName),
          reviewedAlignmentRequestId: null }
      : { editedOutputs, speakerNames, speakerRoles: speakerRoles ?? current.speakerRoles ?? {}, editRevision: request.revision + 1,
        editedAt: at, editedBy: actor.uid, reviewedRevision: null, reviewedAt: null, reviewedBy: null,
        reviewedByName: null, reviewedAlignmentRequestId: null };
    if (!alignmentReview) {
      const alignmentRef = typeof current.alignmentRequestId === "string"
        ? firestore.collection(ALIGNMENT_JOBS).doc(current.alignmentRequestId) : null;
      const alignment = alignmentRef ? (await tx.get(alignmentRef)).data() : null;
      if (alignment?.active && alignment.transcriptId === current.id) {
        const slotRef = firestore.collection(WORKERS).doc(WORKER_ID);
        const slot = (await tx.get(slotRef)).data();
        tx.update(alignmentRef, { active: false, phase: "stale", leaseToken: null, leaseUntil: 0,
          errorCode: "alignment_stale", updatedAt: at });
        if (slot?.kind === "alignment" && slot.jobId === alignmentRef.id) {
          tx.set(slotRef, { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: Date.parse(at) });
        }
      }
      Object.assign(changes, { alignmentRequestId: null, alignmentRevision: null,
        alignmentState: null, alignmentEligibleCount: null, alignmentUnavailableCount: null,
        alignmentUpdatedAt: null, alignedOutputs: null, alignedOutputRequestId: null });
    }
    tx.update(ref, changes);
    enqueueVideoSearchShard(tx, firestore, asset.id, source.id);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({
      actorUid: actor.uid, actorEmail: actor.email ?? null, action: "media.transcript.edit",
      target: `${TRANSCRIPT_JOBS}/${job.id}`,
      before: { editRevision: request.revision },
      after: { editRevision: changes.editRevision, segmentEdits: request.segments.length,
        speakerNameEdits: Object.keys(request.speakerNames).length, speakerRoleEdits: Object.keys(request.speakerRoles ?? {}).length,
        reviewed: request.reviewed === true, alignedTimingReview: Boolean(alignmentReview) },
    }));
    return { ...current, ...changes };
  });
}

async function claimTranscript(firestore, ref, source, now = Date.now()) {
  const leaseOwner = randomUUID();
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job?.active || (job.provider !== undefined && job.provider !== "amazon-transcribe") || job.leaseUntil > now) return null;
    if (job.processingPolicy === PAID_FALLBACK_POLICY && job.paidFallbackState !== "amazon") return null;
    const asset = (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data();
    if (!sameOriginal(asset, job) || source.bucket !== job.sourceBucket ||
        job.sourceId !== source.id || !objectKeyWithinSource(source, job.sourceObjectKey)) {
      releaseLocalQueue(tx, firestore, job);
      tx.update(ref, processingChanges(job, { active: false, phase: "stale", leaseUntil: 0, errorCode: "source_unavailable" }, now));
      return null;
    }
    if (now - Date.parse(job.fallbackAt ?? job.createdAt) > 24 * 60 * 60 * 1000) {
      releaseLocalQueue(tx, firestore, job);
      tx.update(ref, processingChanges(job, { active: false, phase: "needs_reconciliation",
        errorCode: "processing_timeout", leaseUntil: 0 }, now));
      return null;
    }
    const amazonBudgetReservation = await admitAmazon({ tx, firestore, job, now });
    if (!amazonBudgetReservation || amazonBudgetReservation.blocked) {
      const requeued = await requeueLocalFallback(tx, firestore, ref, job, now);
      if (requeued) return null;
      if (!job.localQueueSlot && !job.fallbackAt && !job.startIntentAt &&
          Math.ceil(job.durationSeconds) > PAID_LIMITS.requester.audioSeconds) {
        tx.update(ref, processingChanges(job, { active: false, phase: "failed",
          errorCode: "processing_failed", leaseUntil: 0 }, now));
      } else {
        tx.update(ref, processingChanges(job, {
          errorCode: amazonBudgetReservation?.blocked ?? "paid_budget_unavailable",
        }, now));
      }
      return null;
    }
    tx.update(ref, { leaseOwner, leaseUntil: now + LEASE_MS, amazonBudgetReservation });
    return { ...job, leaseOwner, amazonBudgetReservation };
  });
}

async function saveTranscript(firestore, ref, job, changes) {
  return firestore.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (!current?.active || (current.provider !== undefined && current.provider !== "amazon-transcribe") || current.leaseOwner !== job.leaseOwner) return false;
    const asset = (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data();
    if (!sameOriginal(asset, job)) {
      releaseLocalQueue(tx, firestore, current);
      tx.update(ref, processingChanges(current, { active: false, phase: "stale", leaseUntil: 0, errorCode: "source_unavailable" }));
      return false;
    }
    if (changes.active === false) releaseLocalQueue(tx, firestore, current);
    tx.update(ref, processingChanges(current, changes));
    if (changes.phase === "ready") enqueueVideoSearchShard(tx, firestore, job.assetId, job.sourceId);
    return true;
  });
}

async function migratePendingTranscriptToLocal({ firestore, ref, source, enabled, now = Date.now(), audit = adminLogEntry }) {
  if (!enabled) return false;
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    // Only untouched legacy intents may change policy. Preserve cached edits and any paid-start intent.
    if (!job?.active || job.phase !== "pending" || job.provider !== undefined || job.startIntentAt || job.leaseUntil > now) return false;
    const asset = (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data();
    if (!sourceMatches(asset, job, source)) return false;
    const activeIds = await readLocalQueue(tx, firestore);
    reserveLocalQueue(tx, firestore, activeIds, job.id);
    tx.update(ref, processingChanges(job, { provider: "local", processingPolicy: "local-first-v1",
      localQueueSlot: true, localEngineRevision: LOCAL_ENGINE, policyMigrationAt: new Date(now).toISOString(),
      policyMigrationReason: "local_default_enabled", localQueuedAt: new Date(now).toISOString(),
      leaseOwner: null, leaseUntil: 0 }, now));
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({ actorUid: "system:transcript-policy",
      action: "media.transcript.policy", target: `${TRANSCRIPT_JOBS}/${job.id}`,
      before: { processingPolicy: "legacy-amazon" }, after: { processingPolicy: "local-first-v1" } }));
    return true;
  });
}

module.exports = { withTranscriptWriteLease, assertSameTranscriptOutputs, TRANSCRIPT_JOBS, TRANSCRIPT_LIMITS, activeAsset, requestTranscript, getTranscriptJob, claimTranscript, saveTranscript,
  transcriptLogMetadata, assertTranscriptRevision, commitTranscriptEdit, migratePendingTranscriptToLocal };

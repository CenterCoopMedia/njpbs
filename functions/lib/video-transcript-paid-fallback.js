"use strict";

const { releaseLocalQueue, requeueLocalFallback } = require("./video-transcript-local-queue");
const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { PAID_FALLBACK_POLICY, REQUESTER_DAILY_AUDIO_SECONDS,
  paidFallbackDecision } = require("./video-transcript-fallback-policy");
const { sourceMatches } = require("./video-transcript-worker");
const { validJob } = require("./video-transcript-byok-job");
const { credentialIdentity, CREDENTIAL_COLLECTION } = require("./video-transcription-credentials");
const { processingChanges } = require("./video-processing-status");

function reconcile(tx, firestore, ref, job, errorCode, now) {
  releaseLocalQueue(tx, firestore, job);
  tx.update(ref, processingChanges(job, { active: false, phase: "needs_reconciliation",
    processingStage: "needs_attention", errorCode }, now));
  return false;
}

function useAmazon(tx, firestore, ref, job, settings, now) {
  if (settings.amazonFallbackEnabled !== true) {
    return reconcile(tx, firestore, ref, job, "paid_fallback_unavailable", now);
  }
  tx.update(ref, processingChanges(job, { paidFallbackState: "amazon", phase: "pending",
    processingStage: "queued", errorCode: null }, now));
  return true;
}

function validLinkedChild(child, id, job, asset, source, settings) {
  try { validJob(child, id); }
  catch { return false; }
  return child.identity.credentialScope === "organization" &&
    child.identity.renditionBucket === settings.bucket && child.languageCode === job.languageCode &&
    child.maxSpeakers === job.maxSpeakers && sourceMatches(asset, child, source);
}

async function routeLinkedChild({ tx, firestore, ref, job, asset, source, settings, now }) {
  const id = job.fallbackTranscriptId ?? "";
  if (!/^[a-f0-9]{64}$/.test(id)) return reconcile(tx, firestore, ref, job, "byok_admission_invalid", now);
  const child = (await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(id))).data();
  if (!validLinkedChild(child, id, job, asset, source, settings)) {
    return reconcile(tx, firestore, ref, job, "byok_admission_invalid", now);
  }
  const decision = paidFallbackDecision(child);
  if (decision === "wait") return false;
  if (decision === "amazon") return useAmazon(tx, firestore, ref, job, settings, now);
  if (decision !== "ready") {
    return reconcile(tx, firestore, ref, job, child.errorCode ?? "elevenlabs_submission_uncertain", now);
  }
  releaseLocalQueue(tx, firestore, job);
  tx.update(ref, processingChanges(job, { active: false, phase: "ready", paidFallbackState: "ready",
    processingStage: "ready", totalSegments: child.totalSegments, errorCode: null }, now));
  enqueueVideoSearchShard(tx, firestore, job.assetId, job.sourceId);
  return false;
}

function stationCredentialState(key, expected) {
  if (!key || key.enabled === false) return { state: "unavailable" };
  const valid = key.enabled === true && Number.isSafeInteger(key.revision) && key.revision >= 1 &&
    ["id", "scope", "provider", "ownerUid"].every(field => key[field] === expected[field]);
  return valid ? { state: "ready", revision: key.revision } : { state: "invalid" };
}

async function chooseRoute({ tx, firestore, ref, source, settings, now }) {
  const job = (await tx.get(ref)).data();
  if (!job?.active) return false;
  if (job.processingPolicy !== PAID_FALLBACK_POLICY || job.paidFallbackState === "amazon") return true;
  if (job.provider !== "amazon-transcribe" || !["pending", "waiting"].includes(job.paidFallbackState)) return false;
  const [asset, user, billing] = await Promise.all([
    tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId)),
    tx.get(firestore.collection("users").doc(job.requestedBy)),
    tx.get(firestore.doc("system/billing")),
  ]);
  if (!sourceMatches(asset.data(), job, source)) return reconcile(tx, firestore, ref, job, "source_unavailable", now);
  if (billing.data()?.disabled === true && job.paidFallbackState === "pending" &&
      (job.localQueueSlot || job.fallbackAt)) {
    await requeueLocalFallback(tx, firestore, ref, job, now);
    return false;
  }
  if (!user.exists || user.data().active === false || billing.data()?.disabled === true ||
      !Number.isFinite(job.requestedAuthTime) || job.requestedAuthTime <= 0) {
    return reconcile(tx, firestore, ref, job, "byok_admission_invalid", now);
  }
  if (job.paidFallbackState === "waiting") {
    return routeLinkedChild({ tx, firestore, ref, job, asset: asset.data(), source, settings, now });
  }
  if (!job.localQueueSlot && now - Date.parse(job.createdAt) > 24 * 60 * 60 * 1000) {
    return reconcile(tx, firestore, ref, job, "processing_timeout", now);
  }
  if (Math.ceil(job.durationSeconds) > REQUESTER_DAILY_AUDIO_SECONDS) {
    return useAmazon(tx, firestore, ref, job, settings, now);
  }
  if (!settings.enabled) return useAmazon(tx, firestore, ref, job, settings, now);
  const expected = credentialIdentity({ uid: job.requestedBy }, { scope: "organization", provider: "elevenlabs" });
  const key = (await tx.get(firestore.collection(CREDENTIAL_COLLECTION).doc(expected.id))).data();
  const credential = stationCredentialState(key, expected);
  if (credential.state === "unavailable") return useAmazon(tx, firestore, ref, job, settings, now);
  if (credential.state === "invalid") return reconcile(tx, firestore, ref, job, "byok_admission_invalid", now);
  return { job, revision: credential.revision };
}

// Admission creates and links the paid child atomically. A lost transaction
// response is recovered by reading that link on the next scheduler tick.
async function routePaidFallback({ firestore, ref, source, settings, admit, now = Date.now() }) {
  const next = await firestore.runTransaction((tx) =>
    chooseRoute({ tx, firestore, ref, source, settings, now }));
  if (typeof next === "boolean") return next;
  try {
    await admit({ firestore, source, settings, now, fallbackParentId: next.job.id,
      actor: { uid: next.job.requestedBy, displayName: next.job.requesterDisplayName, authTime: next.job.requestedAuthTime },
      request: { sourceId: next.job.sourceId, assetId: next.job.assetId, provider: "elevenlabs",
        credentialScope: "organization", credentialRevision: next.revision,
        languageCode: next.job.languageCode, maxSpeakers: next.job.maxSpeakers } });
  } catch (error) {
    // A changed credential/parent or reserved budget is retried through the
    // same admission gate. It never becomes permission to use Amazon.
    if (![409, 429].includes(error?.status)) throw error;
    if (error?.status === 429 && (next.job.localQueueSlot || next.job.fallbackAt)) {
      await firestore.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (!current?.active || current.paidFallbackState !== "pending" || current.startIntentAt) return;
        await requeueLocalFallback(tx, firestore, ref, current, now);
      });
    }
  }
  return false;
}

module.exports = { routePaidFallback };

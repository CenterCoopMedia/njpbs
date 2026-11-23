"use strict";

const { randomUUID } = require("node:crypto");
const jobs = require("./video-transcript-byok-job");
const { activeAsset } = require("./video-transcript-job");
const { sourceMatches } = require("./video-transcript-worker");
const {
  CREDENTIAL_COLLECTION,
  credentialIdentity,
} = require("./video-transcription-credentials");
const GLOBAL_LEASE_MS = 900_000;
const RUNNER_PATH = "system/videoTranscriptionByokRunner";

// All IO dependencies are supplied by the deployment layer. No provider client,
// credential source, scheduler or endpoint is created by this core.
function createByokRunner({
  firestore,
  getAuthUser,
  source,
  renditionBucket,
  storage,
  loadCredential,
  transcribe,
  retrieveTranscript,
  clock = Date.now,
  onlyJobId,
}) {
  if (
    !firestore ||
    typeof getAuthUser !== "function" ||
    !source ||
    !renditionBucket ||
    !storage ||
    typeof loadCredential !== "function" ||
    typeof transcribe !== "function"
  )
    throw Error("byok_runner_configuration_invalid");
  if (onlyJobId !== undefined && !/^[a-f0-9]{64}$/.test(onlyJobId)) throw Error("byok_runner_configuration_invalid");
  const runnerRef = firestore.doc(RUNNER_PATH);
  const queue = firestore.collection(jobs.COLLECTION);
  async function claimWork() {
    const owner = randomUUID();
    return firestore.runTransaction(async (tx) => {
      const record = (await tx.get(runnerRef)).data();
      const now = clock();
      if (record?.leaseUntil > now) return null;
      let cursor = { after: record?.after ?? null, afterLeaseUntil: record?.afterLeaseUntil ?? null };
      let candidate;
      if (onlyJobId) {
        const row = (await tx.get(queue.doc(onlyJobId))).data();
        if (row?.operatorCanaryId && row.provider === jobs.PROVIDER && row.active &&
          !(row.leaseUntil > now) && !(row.nextAttemptAt > now)) candidate = row;
      } else {
        const query = queue.where("provider", "==", jobs.PROVIDER).where("active", "==", true)
          .where("leaseUntil", "<=", now).orderBy("leaseUntil").orderBy("__name__").limit(20);
        const hasCursor = cursor.after && cursor.afterLeaseUntil !== null;
        let page = await tx.get(hasCursor ? query.startAfter(cursor.afterLeaseUntil, cursor.after) : query);
        if (hasCursor && !page.docs.length) page = await tx.get(query);
        // A retry deadline may be absent from a newly admitted job.
        const selected = page.docs.find((doc) => {
          const job = doc.data();
          return !job.operatorCanaryId && !(job.nextAttemptAt > now);
        });
        candidate = selected?.data();
        const last = selected ?? page.docs.at(-1);
        cursor = { after: last?.id ?? null, afterLeaseUntil: last?.data().leaseUntil ?? null };
      }
      if (candidate) {
        tx.set(runnerRef, { ...record, owner, leaseUntil: clock() + GLOBAL_LEASE_MS });
      } else if (cursor.after !== (record?.after ?? null) || cursor.afterLeaseUntil !== (record?.afterLeaseUntil ?? null)) {
        tx.set(runnerRef, { owner: null, leaseUntil: 0, ...cursor });
      }
      return { owner, candidate, cursor };
    });
  }
  async function release(owner, cursor) {
    await firestore.runTransaction(async (tx) => {
      if ((await tx.get(runnerRef)).data()?.owner === owner)
        tx.set(runnerRef, { owner: null, leaseUntil: 0, ...cursor });
    });
  }
  async function authCurrent(job) {
    let user;
    try { user = await getAuthUser(job.requestedBy); }
    catch (error) {
      if (error?.code === "auth/user-not-found") return false;
      throw error;
    }
    const revokedAt = user?.tokensValidAfterTime
      ? Date.parse(user.tokensValidAfterTime) / 1000
      : 0;
    return (
      user?.uid === job.requestedBy &&
      user.disabled !== true &&
      Number.isFinite(job.requestedAuthTime) &&
      Number.isFinite(revokedAt) &&
      job.requestedAuthTime >= revokedAt
    );
  }
  function current(owner, credential) {
    return async (tx, job, stage) => {
      jobs.validJob(job, job.id);
      const refs = [
        runnerRef,
        firestore.collection("users").doc(job.requestedBy),
        firestore.collection("mediaSourceAssets").doc(job.assetId),
        firestore.doc("system/billing"),
      ];
      const [runner, user, assetRow, billing] = await Promise.all(
        refs.map((ref) => tx.get(ref)),
      );
      if (
        runner.data()?.owner !== owner ||
        runner.data()?.leaseUntil <= clock() ||
        !user.exists ||
        user.data().active === false ||
        source.id !== "video-library" ||
        source.access !== "active_staff" ||
        !source.writable ||
        billing.data()?.disabled === true
      )
        return false;
      let asset;
      try {
        asset = activeAsset(assetRow, source);
      } catch {
        return false;
      }
      if (
        !sourceMatches(asset, job, source) ||
        job.identity.renditionBucket !== renditionBucket ||
        job.durationSeconds !== asset.rendition?.web?.durationSeconds
      )
        return false;
      // Key rotation prevents a new submission; it must not discard an already
      // paid result. Publication still requires current source and staff access.
      if (stage === "publication") return true;
      const expected = credentialIdentity(
        { uid: job.requestedBy },
        { scope: job.identity.credentialScope, provider: jobs.PROVIDER },
      );
      const key = (
        await tx.get(
          firestore.collection(CREDENTIAL_COLLECTION).doc(expected.id),
        )
      ).data();
      return (
        key?.enabled === true &&
        key.revision === job.identity.credentialRevision &&
        ["id", "scope", "provider", "ownerUid"].every(
          (field) => key[field] === expected[field],
        ) &&
        (!credential ||
          (credential.revision === key.revision &&
            credential.keyVersion === key.keyVersion))
      );
    };
  }
  async function publish(owner, claim, recovered) {
    if (
      !(await jobs.attachSpool({
        firestore,
        claim,
        receipt: recovered.receipt,
        now: clock(),
      }))
    )
      return { outcome: "lease_lost" };
    const authorized =
      (await authCurrent(claim)) &&
      (await firestore.runTransaction((tx) =>
        current(owner)(tx, claim, "publication"),
      ));
    if (!authorized) {
      await jobs.finishJob({
        firestore,
        claim,
        result: { outcome: "needs_reconciliation" },
        now: clock(),
      });
      return { outcome: "needs_reconciliation" };
    }
    const result = await storage.finalizeExports(claim, recovered);
    const finished = await jobs.finishJob({
      firestore,
      claim,
      result: { outcome: "ready", ...result },
      validateCurrent: current(owner),
      now: clock(),
    });
    return { outcome: finished ? "ready" : "lease_lost" };
  }
  async function retrieveCompleted(owner, claim, response) {
    const authorized = async credential => (await authCurrent(claim)) && await firestore.runTransaction(async tx => {
      const job = (await tx.get(queue.doc(claim.id))).data();
      const currentResponse = jobs.completedResponse(job);
      return job?.active === true && job.phase === "running" && job.leaseOwner === claim.leaseOwner &&
        job.leaseUntil > clock() && job.requestedBy === claim.requestedBy && job.requestedAuthTime === claim.requestedAuthTime &&
        job.submissionIntentAt === claim.submissionIntentAt && currentResponse?.attemptId === response.attemptId &&
        currentResponse?.transcriptionId === response.transcriptionId && currentResponse?.inputSha256 === response.inputSha256 &&
        await current(owner, credential)(tx, job, "provider_recovery");
    });
    if (!await authorized()) return null;
    const credential = await loadCredential(claim);
    try {
      if (!Buffer.isBuffer(credential?.key) || !await authorized(credential)) return null;
      let result;
      try {
        result = await retrieveTranscript(response, credential.key, {
          durationSeconds: claim.durationSeconds, maxSpeakers: claim.maxSpeakers,
        });
      } catch (error) {
        if (error?.code === "elevenlabs_result_invalid") return null;
        throw error;
      }
      if (result.transcriptionId !== response.transcriptionId || result.inputSha256 !== response.inputSha256) return null;
      const receipt = await storage.persistSpool(claim, claim, result);
      const recovered = await storage.recoverSpool(claim, claim, receipt);
      if (!recovered) throw Error("byok_spool_unavailable");
      return recovered;
    } finally {
      if (Buffer.isBuffer(credential?.key)) credential.key.fill(0);
    }
  }
  async function recover(owner, row) {
    const claim = await jobs.claimRecovery({
      firestore,
      id: row.id,
      now: clock(),
    });
    if (!claim) return { outcome: "busy" };
    let recovered;
    let recoveryError = claim.spoolReceipt ? "byok_spool_missing" : undefined;
    try {
      recovered = await storage.recoverSpool(claim, claim, claim.spoolReceipt);
    } catch (error) {
      if (error?.code === "byok_storage_spool_missing") recoveryError = "byok_spool_missing";
      else {
        if (!["byok_storage_receipt_invalid", "byok_storage_result_invalid", "byok_storage_identity_invalid", "byok_storage_result_too_large"].includes(error?.code)) throw error;
        recoveryError = "byok_spool_invalid";
      }
    }
    const response = jobs.completedResponse(claim);
    if (!recovered && !recoveryError && response && typeof retrieveTranscript === "function") {
      recovered = await retrieveCompleted(owner, claim, response);
    }
    if (recovered) return publish(owner, claim, recovered);
    const finished = await jobs.finishJob({
      firestore,
      claim,
      result: { outcome: "needs_reconciliation", recoveryError },
      now: clock(),
    });
    return { outcome: finished ? "needs_reconciliation" : "lease_lost" };
  }
  async function execute(owner, row) {
    if (row.submissionIntentAt) return recover(owner, row);
    const claim = await jobs.claimJob({
      firestore,
      id: row.id,
      // This preparation lease also permits definitive denial to release its
      // reservation. User/source/key checks below run before input or key IO.
      validateCurrent: async (tx) => {
        const held = (await tx.get(runnerRef)).data();
        return held?.owner === owner && held.leaseUntil > clock();
      },
      now: clock(),
    });
    if (!claim) return { outcome: "busy" };
    let prepared, credential, intent;
    try {
      if (!(await authCurrent(claim)))
        throw Error("byok_requester_unavailable");
      await firestore.runTransaction(async (tx) => {
        if (!(await current(owner)(tx, claim, "claim")))
          throw Error("byok_current_state_denied");
      });
      if (
        !Number.isFinite(Date.parse(claim.createdAt)) ||
        clock() - Date.parse(claim.createdAt) > 86400000
      )
        throw Error("byok_queue_expired");
      prepared = await storage.prepareInput(claim);
      credential = await loadCredential(claim);
      if (!Buffer.isBuffer(credential?.key) || !(await authCurrent(claim)))
        throw Error("byok_credential_unavailable");
      await firestore.runTransaction(async (tx) => {
        const held = (await tx.get(runnerRef)).data();
        if (held?.owner !== owner || held.leaseUntil <= clock())
          throw Error("byok_runner_lease_lost");
        tx.set(runnerRef, { owner, leaseUntil: clock() + GLOBAL_LEASE_MS });
      });
      intent = await jobs.recordIntent({
        firestore,
        claim,
        validateCurrent: current(owner, credential),
        now: clock(),
      });
      if (!intent) return { outcome: "lease_lost" };
      const result = await transcribe(prepared.input, credential.key, {
        languageCode: claim.languageCode,
        maxSpeakers: claim.maxSpeakers,
      }, {
        async recordCompleted(response) {
          if (!await jobs.recordCompletedResponse({ firestore, claim: intent, response, now: clock() })) {
            throw Error("byok_runner_lease_lost");
          }
        },
      });
      const receipt = await storage.persistSpool(intent, intent, result);
      const recovered = await storage.recoverSpool(intent, intent, receipt);
      if (!recovered) throw Error("byok_spool_unavailable");
      return await publish(owner, intent, recovered);
    } catch (error) {
      if (!intent && error.code === "audio_preparation_waiting") {
        await jobs.waitForAudio({ firestore, claim, now: clock() });
        return { outcome: "audio_preparation_pending" };
      }
      if (!intent && !["byok_credential_unavailable", "byok_requester_unavailable", "byok_current_state_denied", "byok_queue_expired", "byok_legacy_input_requires_readmission"].includes(error?.message)) {
        const deferred = await jobs.deferPreparation({ firestore, claim, now: clock() });
        return { outcome: deferred === "failed" ? "rejected_before_submission" : deferred === "deferred" ? "preparation_retry_pending" : "lease_lost" };
      }
      if (!intent) {
        await jobs.cancelBeforeIntent({ firestore, claim, now: clock() });
        return { outcome: "rejected_before_submission" };
      }
      // Only an explicit adapter rejection is terminal here. All other failures
      // leave the intent for exact-spool recovery after lease expiry, never POST.
      if (error?.outcome === "rejected") {
        await jobs.finishJob({
          firestore,
          claim: intent,
          result: { outcome: "rejected" },
          now: clock(),
        });
        return { outcome: "rejected" };
      }
      return { outcome: "recovery_pending" };
    } finally {
      if (Buffer.isBuffer(credential?.key)) credential.key.fill(0);
      await prepared?.cleanup?.();
    }
  }
  return async function runOne() {
    const work = await claimWork();
    if (!work) return { outcome: "busy" };
    const { owner, candidate, cursor } = work;
    if (!candidate) return { outcome: "idle" };
    try {
      return await execute(owner, candidate);
    } finally { await release(owner, cursor); }

  };
}
module.exports = { createByokRunner, GLOBAL_LEASE_MS, RUNNER_PATH };

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
  async function lease() {
    const owner = randomUUID();
    return firestore.runTransaction(async (tx) => {
      const record = (await tx.get(runnerRef)).data();
      if (record?.leaseUntil > clock()) return null;
      tx.set(runnerRef, { ...record, owner, leaseUntil: clock() + GLOBAL_LEASE_MS });
      return owner;
    });
  }
  async function release(owner, after) {
    await firestore.runTransaction(async (tx) => {
      if ((await tx.get(runnerRef)).data()?.owner === owner)
        tx.set(runnerRef, { owner: null, leaseUntil: 0, after });
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
    const owner = await lease();
    if (!owner) return { outcome: "busy" };
    let cursor = (await runnerRef.get()).data()?.after ?? null;
    try {
      if (onlyJobId) {
        const candidate = (await firestore.collection(jobs.COLLECTION).doc(onlyJobId).get()).data();
        if (!candidate?.operatorCanaryId || candidate.provider !== jobs.PROVIDER || !candidate.active ||
          candidate.leaseUntil > clock() || candidate.nextAttemptAt > clock()) return { outcome: "idle" };
        return await execute(owner, candidate);
      }
      let query = firestore.collection(jobs.COLLECTION).where("provider", "==", jobs.PROVIDER).where("active", "==", true).orderBy("__name__");
      let page = await (cursor ? query.startAfter(cursor) : query).limit(20).get();
      if (cursor && !page.docs.length) page = await query.limit(20).get();
      const candidate = page.docs.map((doc) => doc.data()).find((job) => !job.operatorCanaryId && !(job.leaseUntil > clock()) && !(job.nextAttemptAt > clock()));
      cursor = candidate?.id ?? page.docs.at(-1)?.id ?? null;
      return candidate ? await execute(owner, candidate) : { outcome: "idle" };
    } finally { await release(owner, cursor); }

  };
}
module.exports = { createByokRunner, GLOBAL_LEASE_MS, RUNNER_PATH };

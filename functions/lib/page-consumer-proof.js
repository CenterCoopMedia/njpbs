"use strict";

const { randomUUID } = require("node:crypto");
const { digest } = require("./no-build-page-ownership");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");

const { platformLimit } = require("./release-wait");

const publicationIdentity = queue => queue?.settingsPublication ?? queue?.libraryCardPublication ?? queue?.recordPublication;
const proofKey = queue => digest([publicationIdentity(queue),
  ...["settingsRetryAt", "cardRetryAt", "recordRetryAt"].map(field => queue[field]?.toMillis?.() ?? null)]);
const staleProof = (key, attempts) => ({ key, status: "stale", attempts,
  claim: null, leaseUntil: null, nextAttemptAt: null });

const peakRssMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
// Readers of this row know attempts 0 to 4; `tries` is the measured count.
const storedAttempts = tries => Math.min(tries, 4);

/** The queue subdocument does not wake the queue's onDocumentWritten trigger.
 * Every event and scheduled caller shares this claim. A claim left by a killed
 * process is taken over after the platform limit that ended the process. */
async function claimPageConsumerProof({ firestore, operationId, identity, now, log,
  platformSeconds = platformLimit("cloudFunctionsScheduleSeconds") }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const ref = queueRef.collection("confirmation").doc("page-consumers");
  const claim = randomUUID();
  let lost = null;
  const contextMoved = (pointer, context) => pointer?.activeCommitSha !== identity.rendererSha || context?.schemaVersion !== 1 ||
    context.revision !== identity.contextRevision || publicContextDigest(context.revision) !== identity.contextDigest;
  const acquired = await firestore.runTransaction(async transaction => {
    const [queueRow, proofRow, deployment, context] = await transaction.getAll(queueRef, ref,
      firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
    const queue = queueRow.data(), pointer = deployment.data(), current = context.data();
    if (!queue || queue.status === "cancelled" || digest(publicationIdentity(queue) ?? null) !== digest(identity) ||
        pointer?.state !== "idle") return null;
    const key = proofKey(queue), stored = proofRow.data();
    const prior = stored?.key === key ? stored : null;
    if (contextMoved(pointer, current)) {
      if (prior?.status === "stale") return null;
      transaction.set(ref, staleProof(key, prior?.attempts ?? 0));
      return { stale: true };
    }
    const time = now();
    if (prior?.leaseUntil > time) return null;
    // A refused public answer ends this proof until its publication retries.
    if (prior?.status === "failed" && prior.nextAttemptAt == null) return null;
    // A killed process cannot record its own end. Name it at the next claim.
    if (prior?.status === "running") lost = { tries: prior.tries ?? prior.attempts, waitingOn: prior.waitingOn ?? null };
    const tries = (prior?.tries ?? prior?.attempts ?? 0) + 1;
    const postCheckpoint = prior?.postCheckpoint;
    transaction.set(ref, { key, claim, attempts: storedAttempts(tries), tries, status: "running", startedAt: time,
      leaseUntil: time + platformSeconds * 1_000, nextAttemptAt: null, waitingOn: "start",
      ...(lost ? { lostAttempt: lost } : {}), ...(postCheckpoint ? { postCheckpoint } : {}) });
    return { key, tries, postCheckpoint };
  });
  if (!acquired) return null;
  if (acquired.stale) {
    log.warn("Page consumer confirmation skipped for stale context", { operationId, contextRevision: identity.contextRevision });
    return null;
  }
  if (lost !== null) log.warn("Page consumer confirmation attempt ended without a record", { operationId, ...lost });
  const updateOwned = update => firestore.runTransaction(async transaction => {
    const prior = (await transaction.get(ref)).data();
    if (prior?.claim !== claim || prior.key !== acquired.key) return false;
    transaction.update(ref, update);
    return true;
  });
  // The newest state wins while an earlier write is in flight.
  let next = null, writing = null;
  function record(update) {
    next = { ...next, ...update };
    writing ??= (async () => {
      while (next) {
        const write = { ...next, peakRssMb: peakRssMb(), stateAt: now() };
        next = null;
        try { await updateOwned(write); } catch { /* The proof's own result still records below. */ }
      }
      writing = null;
    })();
  }
  return {
    postCheckpoint: acquired.postCheckpoint,
    /** Names what this attempt waits on, so a killed attempt is not silent. */
    waitingOn(state) { record({ waitingOn: state }); },
    recordPostCheckpoint(postCheckpoint) { record({ postCheckpoint }); },
    async assertCurrent(transaction, queue) {
      const prior = (await transaction.get(ref)).data();
      if (prior?.claim !== claim || prior.key !== acquired.key || proofKey(queue) !== acquired.key) {
        throw Object.assign(new Error("Page consumer confirmation claim moved"), { status: 409, code: "proof_claim_moved" });
      }
    },
    /** "verified", "failed" (a public answer refused) or "waiting". */
    async finish(status, failureReason = { code: "confirmation_incomplete" }) {
      while (writing) await writing;
      await firestore.runTransaction(async transaction => {
        const [proofRow, deployment, context] = await transaction.getAll(ref,
          firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
        const prior = proofRow.data();
        if (prior?.claim !== claim || prior.key !== acquired.key) return;
        // The next publication's answer is not this publication's refusal.
        if (status === "failed" && contextMoved(deployment.data(), context.data())) {
          transaction.set(ref, staleProof(acquired.key, prior.attempts));
          return;
        }
        const end = { status, claim: null, leaseUntil: null, nextAttemptAt: null, endedAt: now(), peakRssMb: peakRssMb() };
        if (status === "verified") transaction.update(ref, { ...end, waitingOn: null, ...(prior.postCheckpoint ? { postCheckpoint: null } : {}) });
        else transaction.update(ref, { ...end, failureReason, ...(status === "failed" ? { waitingOn: null } : { waitingOn: failureReason.code }) });
      });
      if (status === "failed") log.error("Page consumer confirmation refused by a public answer", { operationId, failureReason });
    },
  };
}

module.exports = { claimPageConsumerProof, publicationIdentity, proofKey, staleProof };

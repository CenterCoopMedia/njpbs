"use strict";

const { randomUUID } = require("node:crypto");
const { digest } = require("./no-build-page-ownership");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");

const MAX_ATTEMPTS = 4;
const LEASE_MS = 60_000;
const MIN_PROOF_BUDGET_MS = 30_000;
const publicationIdentity = queue => queue?.settingsPublication ?? queue?.libraryCardPublication ?? queue?.recordPublication;
const proofKey = queue => digest([publicationIdentity(queue),
  ...["settingsRetryAt", "cardRetryAt", "recordRetryAt"].map(field => queue[field]?.toMillis?.() ?? null)]);
const staleProof = (key, attempts) => ({ key, status: "stale", attempts,
  claim: null, leaseUntil: null, nextAttemptAt: null });

/** The queue subdocument does not wake the queue's onDocumentWritten trigger.
 * Every event and scheduled caller shares this lease and attempt budget. */
async function claimPageConsumerProof({ firestore, operationId, identity, now, deadline, log }) {
  if (deadline - now() < MIN_PROOF_BUDGET_MS) return null;
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const ref = queueRef.collection("confirmation").doc("page-consumers");
  const claim = randomUUID();
  let lost = null;
  const acquired = await firestore.runTransaction(async transaction => {
    const [queueRow, proofRow, deployment, context] = await transaction.getAll(queueRef, ref,
      firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
    const queue = queueRow.data(), pointer = deployment.data(), current = context.data();
    if (!queue || queue.status === "cancelled" || digest(publicationIdentity(queue) ?? null) !== digest(identity) ||
        pointer?.state !== "idle") return null;
    const key = proofKey(queue), stored = proofRow.data();
    const prior = stored?.key === key ? stored : null;
    if (pointer.activeCommitSha !== identity.rendererSha || current?.schemaVersion !== 1 ||
        current.revision !== identity.contextRevision || publicContextDigest(current.revision) !== identity.contextDigest) {
      if (prior?.status === "stale") return null;
      transaction.set(ref, staleProof(key, prior?.attempts ?? 0));
      return { stale: true };
    }
    const time = now();
    if (deadline - time < MIN_PROOF_BUDGET_MS || prior?.leaseUntil > time) return null;
    if (prior?.attempts >= MAX_ATTEMPTS) {
      if (prior.status !== "running") return null;
      transaction.update(ref, { status: "failed", claim: null, leaseUntil: null, nextAttemptAt: null,
        failureReason: { code: "lease_expired" } });
      return { exhausted: true };
    }
    if (prior?.nextAttemptAt > time) return null;
    // A killed process cannot record its own end. Name it at the next claim.
    if (prior?.status === "running") lost = prior.attempts;
    const attempts = (prior?.attempts ?? 0) + 1;
    const leaseUntil = Math.max(time + LEASE_MS, deadline + 5_000);
    const postCheckpoint = prior?.postCheckpoint;
    transaction.set(ref, { key, claim, attempts, status: "running", leaseUntil,
      nextAttemptAt: leaseUntil + 60_000 * 2 ** (attempts - 1), ...(postCheckpoint ? { postCheckpoint } : {}) });
    return { key, attempts, postCheckpoint };
  });
  if (!acquired) return null;
  if (acquired.exhausted) {
    log.error("Page consumer confirmation retry budget exhausted", { operationId, attempts: MAX_ATTEMPTS });
    return null;
  }
  if (acquired.stale) {
    log.warn("Page consumer confirmation skipped for stale context", { operationId, contextRevision: identity.contextRevision });
    return null;
  }
  if (lost !== null) log.warn("Page consumer confirmation attempt ended without a record", { operationId, attempts: lost });
  let postCheckpoint;
  return {
    postCheckpoint: acquired.postCheckpoint,
    recordPostCheckpoint(checkpoint) { postCheckpoint = checkpoint; },
    async assertCurrent(transaction, queue) {
      const prior = (await transaction.get(ref)).data();
      if (prior?.claim !== claim || prior.key !== acquired.key || proofKey(queue) !== acquired.key || now() >= prior.leaseUntil) {
        throw Object.assign(new Error("Page consumer confirmation lease expired"), { status: 409 });
      }
  }, async finish(confirmed, { waitingForInputs = false, continuingPosts = false,
    failureReason = { code: "confirmation_incomplete" } } = {}) {
    const exhausted = await firestore.runTransaction(async transaction => {
      const prior = (await transaction.get(ref)).data();
      if (prior?.claim !== claim || prior.key !== acquired.key) return false;
      let checkpointUpdate = {};
      if (confirmed && prior.postCheckpoint) checkpointUpdate = { postCheckpoint: null };
      if (!confirmed && postCheckpoint !== undefined) {
        const queue = (await transaction.get(queueRef)).data();
        if (queue && queue.status !== "cancelled" && proofKey(queue) === acquired.key && now() < prior.leaseUntil) {
          checkpointUpdate = { postCheckpoint };
        }
      }
      if (waitingForInputs || (continuingPosts && checkpointUpdate.postCheckpoint)) {
        transaction.update(ref, { status: "waiting", attempts: acquired.attempts - 1,
          claim: null, leaseUntil: null, nextAttemptAt: null, ...checkpointUpdate });
        return false;
      }
      const exhausted = !confirmed && acquired.attempts >= MAX_ATTEMPTS;
      transaction.update(ref, { status: confirmed ? "verified" : "failed", claim: null, leaseUntil: null,
        ...(confirmed ? {} : { failureReason }),
        nextAttemptAt: confirmed || exhausted ? null : now() + 60_000 * 2 ** (acquired.attempts - 1), ...checkpointUpdate });
      return exhausted;
    });
    if (exhausted) log.error("Page consumer confirmation retry budget exhausted", { operationId, attempts: MAX_ATTEMPTS });
  } };
}

module.exports = { claimPageConsumerProof, publicationIdentity, proofKey, staleProof };

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

/** The queue subdocument does not wake the queue's onDocumentWritten trigger.
 * Every event and scheduled caller shares this lease and attempt budget. */
async function claimPageConsumerProof({ firestore, operationId, identity, now, deadline, log }) {
  if (deadline - now() < MIN_PROOF_BUDGET_MS) return null;
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const ref = queueRef.collection("confirmation").doc("page-consumers");
  const claim = randomUUID();
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
      transaction.set(ref, { key, status: "stale", attempts: prior?.attempts ?? 0,
        claim: null, leaseUntil: null, nextAttemptAt: null });
      return { stale: true };
    }
    const time = now();
    if (deadline - time < MIN_PROOF_BUDGET_MS || prior?.leaseUntil > time) return null;
    if (prior?.attempts >= MAX_ATTEMPTS) {
      if (prior.status !== "running") return null;
      transaction.update(ref, { status: "failed", claim: null, leaseUntil: null, nextAttemptAt: null });
      return { exhausted: true };
    }
    if (prior?.nextAttemptAt > time) return null;
    const attempts = (prior?.attempts ?? 0) + 1;
    const leaseUntil = Math.max(time + LEASE_MS, deadline + 5_000);
    transaction.set(ref, { key, claim, attempts, status: "running", leaseUntil,
      nextAttemptAt: leaseUntil + 60_000 * 2 ** (attempts - 1) });
    return { ref, key, claim, attempts };
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
  return { async assertCurrent(transaction, queue) {
    const prior = (await transaction.get(ref)).data();
    if (prior?.claim !== claim || prior.key !== acquired.key || proofKey(queue) !== acquired.key || now() >= prior.leaseUntil) {
      throw Object.assign(new Error("Page consumer confirmation lease expired"), { status: 409 });
    }
  }, async finish(confirmed, { waitingForInputs = false } = {}) {
    const exhausted = await firestore.runTransaction(async transaction => {
      const prior = (await transaction.get(ref)).data();
      if (prior?.claim !== claim || prior.key !== acquired.key) return false;
      if (waitingForInputs) {
        transaction.update(ref, { status: "waiting", attempts: acquired.attempts - 1,
          claim: null, leaseUntil: null, nextAttemptAt: null });
        return false;
      }
      const exhausted = !confirmed && acquired.attempts >= MAX_ATTEMPTS;
      transaction.update(ref, { status: confirmed ? "verified" : "failed", claim: null, leaseUntil: null,
        nextAttemptAt: confirmed || exhausted ? null : now() + 60_000 * 2 ** (acquired.attempts - 1) });
      return exhausted;
    });
    if (exhausted) log.error("Page consumer confirmation retry budget exhausted", { operationId, attempts: MAX_ATTEMPTS });
  } };
}

module.exports = { claimPageConsumerProof };

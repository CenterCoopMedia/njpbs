"use strict";

// A preparation is read only at the context digest it was made for, and the
// public context revision only moves forward. A failed preparation whose digest
// is no longer read ends here, so it keeps no retry time that nothing reads.
const SUPERSEDED = Object.freeze({ status: "superseded", claim: null, nextAttemptAt: null });

const retryLeft = value => value?.status === "failed" && value.claim == null && value.nextAttemptAt != null;

/** Reads first, returns the writes for the caller's transaction. `keep` names
 * the rows a live reader can still select. Other states are left to their owner. */
async function prepareSupersededPreparationsInTransaction({ firestore, transaction, queueIds, keep = () => false }) {
  const rows = [];
  for (const queueId of new Set(queueIds)) {
    const failed = await transaction.get(firestore.collection(`cmsPublishQueue/${queueId}/backgroundPreparation`)
      .where("status", "==", "failed"));
    rows.push(...failed.docs.filter(row => retryLeft(row.data()) && !keep(row, queueId)));
  }
  return () => { for (const row of rows) transaction.update(row.ref, SUPERSEDED); };
}

// The proof of a Post queue follows its current owner only. A newer owner ends
// it with the queue; its claim holder finds the claim gone.
function supersededPostProof(queue) {
  const proof = queue?.postProof;
  return ["pending", "failed"].includes(proof?.status) && proof.nextAttemptAt != null
    ? { postProof: { ...proof, ...SUPERSEDED } } : null;
}

module.exports = { SUPERSEDED, retryLeft, supersededPostProof, prepareSupersededPreparationsInTransaction };

"use strict";

// The receipt for a finished media object that is destroyed rather than
// committed (#205).
//
// Two paths can perform that destruction, and they are two halves of one event.
// `functions/media.js` discards the object when a commit loses the active-media
// cap: it removes the object from the store, then deletes the ownership claim
// and writes this row in the same transaction. If that last transaction never
// runs -- the process dies between the delete and the commit -- the object is
// already gone and nothing is left to describe it, so
// `functions/media-recovery.js` writes the same receipt when it finds a claim
// whose finished object has vanished.
//
// Recording after the irreversible act is deliberate. Writing the row first
// would put "discarded" in the compliance stream for an object that a failed
// delete leaves in place, and that upload can still go on to commit; an audit
// stream that overstates is worse than one that is finished a few minutes late
// by the recovery pass.
//
// One row per attempt is what makes the pair safe. The receipt is keyed by the
// attempt id and created only when it is absent, so whichever path arrives
// second adds nothing, and a claim that is discarded, resumed and discarded
// again still describes one destroyed object.

const { AUDIT_COLLECTIONS } = require("./audit");

const DISCARD_ACTION = "media.upload.discard";
const DISCARD_REASONS = Object.freeze({
  capacity: "active_media_capacity",
  category: "invalid_media_category",
  ugcDecision: "ugc_review_decision_changed",
  objectMissing: "final_object_missing",
});

// A Firestore document id cannot contain a slash and cannot be "." or "..".
// Attempt ids are server-minted, so this only guards against a corrupted claim:
// an unusable id gives up the key rather than the row.
function discardReceiptId(attemptId) {
  return typeof attemptId === "string" &&
    attemptId.length > 0 &&
    attemptId.length < 1_000 &&
    !attemptId.includes("/") &&
    attemptId !== "." &&
    attemptId !== ".."
    ? `media-discard_${attemptId}`
    : null;
}

/**
 * Append the discard receipt for one upload attempt unless it is already there.
 * Reads before it writes, so a caller must not have written in this transaction
 * yet. Returns whether it added the row.
 */
async function appendDiscardReceipt(
  transaction,
  firestore,
  { adminLogEntryFn, contentHash, owner, attemptId, finalKey, reason, source = undefined },
) {
  const logs = firestore.collection(AUDIT_COLLECTIONS.adminLogs);
  const id = discardReceiptId(attemptId);
  const ref = id ? logs.doc(id) : logs.doc();
  if (id) {
    const existing = await transaction.get(ref);
    if (existing.exists) return false;
  }
  transaction.create(
    ref,
    adminLogEntryFn({
      actorUid: owner?.recordSeed?.actor?.uid ?? "system:media",
      actorEmail: owner?.recordSeed?.actor?.email ?? null,
      // Written as a literal rather than through DISCARD_ACTION: the label
      // coverage test reads the codes back out of the writers, and a code
      // hidden behind a constant would reach an administrator unlabeled.
      action: "media.upload.discard",
      target: `media_assets/${owner?.assetId ?? "unknown"}`,
      // The claim is the last record of what this object was, so the row keeps
      // its identity and bounded description; after the delete nothing else
      // holds any of it.
      before: {
        attemptId: attemptId ?? null,
        assetId: owner?.assetId ?? null,
        category: owner?.category ?? null,
        contentHash: contentHash ?? null,
        mimeType: owner?.mimeType ?? null,
        sizeBytes: owner?.sizeBytes ?? null,
        storageKey: finalKey ?? owner?.finalKey ?? null,
        reason,
      },
      after: null,
      source: source === undefined ? (owner?.recordSeed?.source ?? null) : source,
    }),
  );
  return true;
}

module.exports = {
  DISCARD_ACTION,
  DISCARD_REASONS,
  appendDiscardReceipt,
  discardReceiptId,
};

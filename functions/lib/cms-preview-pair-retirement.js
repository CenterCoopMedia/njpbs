"use strict";
const pairs = require("./cms-preview-pair");
const sessions = require("./cms-reader-session");
const closures = require("./cms-preview-pair-reader-closure");
/** Called inside the selection CAS. Closure, scoped expiry, outstanding rows
 * and the original serializer journal are all observed in that transaction. */
async function prepareRecoveryReplacementInTransaction({ firestore, transaction, selector, candidatePair, now }) {
  const pair = pairs.parsePair((await transaction.get(firestore.collection(pairs.PAIRS).doc(selector.recoveryPairId))).data());
  if (pair.pairId !== selector.recoveryPairId || pair.pairId === candidatePair.pairId) throw new Error("Preview replacement identity differs");
  const closure = closures.parseClosure((await transaction.get(firestore.collection(closures.COLLECTION).doc(pair.pairId))).data(), pair);
  if (closure.closedAt > now) throw new Error("Preview recovery closure is in the future");
  const readerFence = await sessions.prepareRecoveryReaderFenceInTransaction({ firestore, transaction });
  const expired = await sessions.assertPairReaderWindowsExpiredInTransaction({ firestore, transaction, pairId: pair.pairId, now });
  const liveReaders = await sessions.assertLiveReaderWindowsSupportInTransaction({ firestore, transaction, candidatePair, now });
  const [queue, journal] = await Promise.all([
    transaction.get(firestore.collection("cmsPreviewQueue").where("serializerId", "==", pair.serializerId).where("status", "in", ["pending", "building"]).limit(1)),
    transaction.get(firestore.collection("cmsPreviewSerializerJournals").doc(pair.serializerId)),
  ]);
  const state = journal.data();
  if (!queue.empty || journal.exists && (!state || Object.keys(state).sort().join() !== "job,schemaVersion,serializerId" ||
      state.schemaVersion !== 1 || state.serializerId !== pair.serializerId || state.job !== null)) throw new Error("Preview recovery still has outstanding work or journal");
  const pairDigest = pairs.digest(pair), closureDigest = pairs.digest(closure);
  // The OLD schema-one journal parser rejects this terminal record. Sharing
  // the original document fences even an old image's transaction retry.
  const retiredJournal = { schemaVersion: 2, serializerId: pair.serializerId, job: null,
    retirement: { pairId: pair.pairId, pairDigest, closureDigest } };
  return { pairId: pair.pairId, pairDigest, closureDigest, expired, liveReaders, readerFence: readerFence.proof, retiredJournal };
}
module.exports = { prepareRecoveryReplacementInTransaction };

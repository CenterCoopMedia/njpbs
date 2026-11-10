"use strict";
const pairs = require("./cms-preview-pair");
const COLLECTION = "cmsPreviewPairReaderWindows";
const ID = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function refuse() { throw new Error("Preview recovery reader closure is invalid"); }
function parseClosure(value, pair) {
  if (!value || Object.keys(value).sort().join() !== "closedAt,pairDigest,pairId,readerFence,request,schemaVersion" || value.schemaVersion !== 2 ||
      value.pairId !== pair.pairId || value.pairDigest !== pairs.digest(pair) || !Number.isSafeInteger(value.closedAt) || value.closedAt < 0 ||
      !value.request || Object.keys(value.request).sort().join() !== "expectedSelectorDigest,operationId,pairId" ||
      !ID.test(value.request.operationId) || !DIGEST.test(value.request.expectedSelectorDigest) || value.request.pairId !== pair.pairId) refuse();
  const fence = value.readerFence;
  if (!fence || Object.keys(fence).sort().join() !== "closedReaderDigests,liveReaderDigests,schemaVersion" || fence.schemaVersion !== 1 ||
      !fence.liveReaderDigests || Object.keys(fence.liveReaderDigests).sort().join() !== "cmsApi,functions" ||
      Object.values(fence.liveReaderDigests).some(identity => typeof identity !== "string" || !DIGEST.test(identity)) ||
      !Array.isArray(fence.closedReaderDigests) || fence.closedReaderDigests.some((identity, index, all) =>
        typeof identity !== "string" || !DIGEST.test(identity) || index && identity <= all[index - 1])) refuse();
  return value;
}
/** Explicit, create-only closure of new dependencies on the current recovery
 * incarnation. Existing leases and OLD work retain their original lifetimes.
 * It never pauses new selected-pair sessions or changes a selector. */
async function closeRecoveryReaderIssuance(firestore, request, now, signal) {
  signal?.throwIfAborted();
  if (!request || Object.keys(request).sort().join() !== "expectedSelectorDigest,operationId,pairId" || !ID.test(request.operationId) ||
      !ID.test(request.pairId) || !DIGEST.test(request.expectedSelectorDigest) || now !== undefined && (!Number.isSafeInteger(now) || now < 0)) refuse();
  const ref = firestore.collection(COLLECTION).doc(request.pairId);
  return firestore.runTransaction(async transaction => {
    const [row, pairRow, selectorRow] = await transaction.getAll(ref, firestore.collection(pairs.PAIRS).doc(request.pairId), firestore.doc(pairs.SELECTOR_PATH));
    const pair = pairs.parsePair(pairRow.data());
    if (row.exists) {
      const original = parseClosure(row.data(), pair);
      if (pairs.digest(original.request) !== pairs.digest(request)) refuse();
      return original;
    }
    const selector = pairs.parseSelector(selectorRow.data());
    if (pairs.digest(selector) !== request.expectedSelectorDigest || selector.recoveryPairId !== pair.pairId || selector.selectedPairId === pair.pairId) refuse();
    const sessions = require("./cms-reader-session");
    const fence = await sessions.prepareRecoveryReaderFenceInTransaction({ firestore, transaction, allowClose: true });
    const frontier = await sessions.preparePairReaderClosureInTransaction({ firestore, transaction, pairId: pair.pairId });
    const closedAt = now ?? selectorRow.readTime.toMillis();
    const value = parseClosure({ schemaVersion: 2, pairId: pair.pairId, pairDigest: pairs.digest(pair), request, closedAt, readerFence: fence.proof }, pair);
    signal?.throwIfAborted();
    for (const entry of [...fence.writes, ...frontier]) transaction.set(entry.ref, entry.value);
    transaction.create(ref, value);
    return value;
  });
}
module.exports = { COLLECTION, parseClosure, closeRecoveryReaderIssuance };

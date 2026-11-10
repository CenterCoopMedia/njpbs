"use strict";
const p = require("./public-release-pair");
const pointers = require("./public-deployment-pointer");
const work = require("./public-release-pair-work");
const { parsePublicReleaseChangeHead } = require("./public-release-change-log");
const { parseCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { publicationTarget } = require("./publication-target");
const ROOT = "system/publicDeployment";
const RECEIPTS = `${ROOT}/bootstrapSelectors`;
const MEDIA = `${ROOT}/pairMedia/current`;
const { parsePairMedia } = require("./public-release-switch");
const equal = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function parseBootstrapAttempt(value) {
  p.exact(value, ["schemaVersion", "operationId", "expectedSourceDigest", "currentPair", "recoveryPair", "admittedContractDigest", "qualifications"]);
  if (value.schemaVersion !== 2 || !pointers.isPublicDeploymentIdentifier(value.operationId) ||
      !p.digest(value.expectedSourceDigest) || !p.digest(value.admittedContractDigest) ||
      !Array.isArray(value.qualifications) || value.qualifications.length !== 2) refuse();
  const currentPair = p.parsePublicReleasePair(value.currentPair), recoveryPair = p.parsePublicReleasePair(value.recoveryPair);
  work.assertPrivatePairResources(currentPair); work.assertPrivatePairResources(recoveryPair);
  if (currentPair.environment !== recoveryPair.environment || currentPair.pairId === recoveryPair.pairId ||
      currentPair.publicWorker.versionId === recoveryPair.publicWorker.versionId) refuse();
  const qualifications = value.qualifications.map(row => {
    p.exact(row, ["qualificationId", "receiptDigest"]);
    if (!pointers.isPublicDeploymentIdentifier(row.qualificationId) || !p.digest(row.receiptDigest)) refuse();
    return { ...row };
  });
  return p.freeze({ ...value, currentPair, recoveryPair, qualifications });
}
/** One original Firestore transaction converts the idle, exact current legacy
 * root. No provider operation, phase/pin write, admission change, enablement or
 * renderer switch occurs. The qualified current live source remains selected.
 * The actual qualifier's opaque outside preparation and shared500-read guard
 * are supplied by the private operator; no serialized success flag is accepted. */
async function bootstrapPublicReleaseSelector({ firestore, attempt: raw, dryRun = true, qualificationGuard, assertInstalledConsumersInTransaction, assertClosedFenceInTransaction }) {
  const attempt = parseBootstrapAttempt(raw), pairs = [attempt.currentPair, attempt.recoveryPair];
  for (const pair of pairs) work.assertPublicReleasePairDatabase(firestore, pair);
  if (typeof dryRun !== "boolean" || typeof qualificationGuard?.begin !== "function" ||
      typeof assertInstalledConsumersInTransaction !== "function" || typeof assertClosedFenceInTransaction !== "function") refuse();
  const attemptDigest = p.publicReleaseDigest(attempt), receiptPath = `${RECEIPTS}/${attempt.operationId}`;
  return firestore.runTransaction(async original => {
    const guard = qualificationGuard.begin(original), transaction = guard.transaction;
    if (!transaction || typeof guard.verify !== "function" || typeof guard.finish !== "function") refuse();
    const [rootRow, receiptRow, pinsRow, changeRow, contractRow, mediaRow, ...pairRows] = await transaction.getAll(
      firestore.doc(ROOT), firestore.doc(receiptPath), firestore.doc("system/cmsPublicationRuntime"),
      firestore.doc("system/publicReleaseChanges"), firestore.doc(`system/publicReleaseAdmissionContracts/entries/${attempt.admittedContractDigest}`), firestore.doc(MEDIA),
      ...pairs.flatMap(pair => { const base = work.publicReleasePairPath(pair.pairId); return [firestore.doc(base),
        firestore.doc(`${base}/controls/runtime`), firestore.doc(`${base}/rollouts/publisher`), firestore.doc(`${base}/heads/current`)]; }));
    const root = rootRow.data(), priorReceipt = receiptRow.data();
    if (priorReceipt) {
      p.exact(priorReceipt, ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
      if (priorReceipt.schemaVersion !== 2 || priorReceipt.kind !== "public-release-bootstrap" || priorReceipt.operationId !== attempt.operationId ||
          priorReceipt.attemptDigest !== attemptDigest || priorReceipt.sourceDigest !== attempt.expectedSourceDigest ||
          p.publicReleaseDigest(root) !== priorReceipt.storedSelectorDigest ||
          p.publicReleaseDigest(p.parseStoredPublicReleaseSelector(root)) !== priorReceipt.selectorDigest ||
          !equal(p.parsePublicReleaseSelector(priorReceipt.selector), p.parseStoredPublicReleaseSelector(root)) ||
          !p.digest(priorReceipt.mediaDigest) || p.publicReleaseDigest(parsePairMedia(mediaRow.data(), p.parseStoredPublicReleaseSelector(root))) !== priorReceipt.mediaDigest) refuse();
      guard.finish();
      return { dryRun, idempotent: true, before: root, after: root, receipt: priorReceipt, receiptPath, headInitializations: [], mediaInitialization: null };
    }
    const before = pointers.assertPublicDeploymentPointer(root);
    await require("./page-reader-compatibility").assertCandidatePageReaders({
      firestore, transaction, candidates: pairs.map(pair => ({ commitSha: pair.commitSha })) });
    if (before.state !== "idle" || before.mediaLifecycleReady !== true || before.activeGeneration < 1 ||
        before.activeCommitSha !== attempt.currentPair.commitSha || before.lastReservedGeneration !== before.activeGeneration ||
        before.newestEligibleGeneration !== before.activeGeneration || p.publicReleaseDigest(before) !== attempt.expectedSourceDigest) refuse();
    const pins = parseCmsPublicationRuntimeControl(pinsRow.data()), serializerId = publicationTarget(attempt.currentPair.environment).serializerId;
    if ([pins, pins.cloud].some(pin => pin?.phase !== "ready" || pin.commitSha !== before.activeCommitSha) || pins.cloud.serializerId !== serializerId) refuse();
    const changes = parsePublicReleaseChangeHead(changeRow.data());
    const contract = contractRow.data(); p.exact(contract, ["schemaVersion", "families", "features"]);
    if (contract.schemaVersion !== 2 || p.publicReleaseDigest(contract) !== attempt.admittedContractDigest ||
        !Array.isArray(contract.families) || !Array.isArray(contract.features)) refuse();
    for (const [index, pair] of pairs.entries()) {
      const [stored, lifecycle, rollout] = pairRows.slice(index * 4, index * 4 + 3).map(row => row.data());
      if (!equal(p.parsePublicReleasePair(stored), pair)) refuse();
      p.exact(lifecycle, ["schemaVersion", "pairId", "status"]);
      if (lifecycle.schemaVersion !== 2 || lifecycle.pairId !== pair.pairId || lifecycle.status !== "retained" ||
          rollout?.schemaVersion !== 2 || rollout.pairId !== pair.pairId || rollout.pairDigest !== p.publicReleaseDigest(pair) ||
          rollout.state !== "verified" || !p.digest(rollout.readbackDigest)) refuse();
    }
    await assertClosedFenceInTransaction({ firestore, transaction, environment: pairs[0].environment,
      before, operationId: attempt.operationId });
    // A private operator must prove the deployed read/admission dispatch stack
    // in this same SDK transaction. No serialized success flag is accepted.
    await assertInstalledConsumersInTransaction({ firestore, transaction, environment: pairs[0].environment,
      contractDigest: attempt.admittedContractDigest, before });
    // Re-run both real late guards in this SAME transaction, sharing the
    // caller's opaque read tracker. Their returned witness chooses the head.
    const proofs = await guard.verify({ firestore, transaction, pairs, qualifications: attempt.qualifications });
    if (!Array.isArray(proofs) || proofs.length !== 2) refuse();
    const heads = proofs.map((proof, index) => {
      const pair = pairs[index], receipt = proof.receipt, witness = proof.witness;
      if (!receipt || receipt.kind !== "private-pair-qualification" || receipt.schemaVersion !== 2 ||
          receipt.qualificationId !== attempt.qualifications[index].qualificationId ||
          p.publicReleaseDigest(receipt) !== attempt.qualifications[index].receiptDigest || receipt.pairDigest !== p.publicReleaseDigest(pair) ||
          receipt.readerReceiptDigest !== pair.readerReceiptDigest || receipt.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
          witness?.pairDigest !== p.publicReleaseDigest(pair) || witness.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
          receipt.witnessDigest !== p.publicReleaseDigest(witness) || receipt.contentViewDigest !== witness.contentViewDigest ||
          !equal(witness.headCursor, { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest })) refuse();
      const contentHead = { pairId: pair.pairId, viewId: receipt.witnessDigest, manifestDigest: witness.contentViewDigest, contextSequence: changes.sequence };
      const storedHead = pairRows[index * 4 + 3].data();
      if (storedHead !== undefined && !equal(storedHead, { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), contentHead })) refuse();
      return contentHead;
    });
    const selector = p.parsePublicReleaseSelector({ ...Object.fromEntries(Object.entries(before).filter(([key]) => key !== "updatedAt")),
      schemaVersion: 2, epoch: 1, selectedPair: p.publicReleasePairReference(attempt.currentPair), recoveryPair: p.publicReleasePairReference(attempt.recoveryPair),
      contentHead: heads[0], admittedContractDigest: attempt.admittedContractDigest, priorSelectorDigest: attempt.expectedSourceDigest,
      switchOperationId: attempt.operationId, proofDigest: p.publicReleaseDigest(proofs.map(proof => proof.receipt)) });
    const after = { ...selector, ...(Object.hasOwn(before, "updatedAt") ? { updatedAt: before.updatedAt } : {}) };
    p.parseStoredPublicReleaseSelector(after);
    // The legacy media readiness and idle counters were checked above under
    // the same closed fence. References come only from BOTH actual late proofs.
    const media = parsePairMedia({ schemaVersion: 2, epoch: selector.epoch, activeGeneration: before.activeGeneration,
      lastReservedGeneration: before.lastReservedGeneration, newestEligibleGeneration: before.newestEligibleGeneration,
      references: pairs.map((pair, index) => ({ pairId: pair.pairId, manifestDigest: heads[index].manifestDigest }))
        .sort((a, b) => a.pairId.localeCompare(b.pairId)) }, selector);
    if (mediaRow.exists && !equal(parsePairMedia(mediaRow.data(), selector), media)) refuse();
    const mediaInitialization = mediaRow.exists ? null : { path: MEDIA, before: null, after: media };
    const receipt = { schemaVersion: 2, kind: "public-release-bootstrap", operationId: attempt.operationId, attemptDigest,
      sourceDigest: attempt.expectedSourceDigest, selectorDigest: p.publicReleaseDigest(selector), storedSelectorDigest: p.publicReleaseDigest(after), mediaDigest: p.publicReleaseDigest(media), selector };
    const headInitializations = pairs.flatMap((pair, index) => pairRows[index * 4 + 3].exists ? [] : [{
      path: pairRows[index * 4 + 3].ref.path, before: null,
      after: { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), contentHead: heads[index] },
    }]);
    guard.finish();
    if (!dryRun) {
      // Qualification seals receipts, not mutable serving heads. First install
      // creates only the missing heads from those exact opaque late proofs in
      // the SAME original CAS; it never invents or advances a witness cursor.
      headInitializations.forEach(head => transaction.create(firestore.doc(head.path), head.after));
      if (mediaInitialization) transaction.create(mediaRow.ref, media);
      transaction.set(firestore.doc(ROOT), after); transaction.create(firestore.doc(receiptPath), receipt);
    }
    return { dryRun, idempotent: false, before, after, receipt, receiptPath, headInitializations, mediaInitialization };
  }, dryRun ? { readOnly: true } : undefined);
}
module.exports = { parseBootstrapAttempt, bootstrapPublicReleaseSelector };

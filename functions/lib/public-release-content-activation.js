"use strict";

// Inert private content writer. No handler, deployed publisher or production
// entrypoint imports it. Canonical proof and original terminal settlement stay
// with the original admission owner, after this atomic head change.
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const replay = require("./public-release-pair-replay");
const log = require("./public-release-change-log");
const admissionCodec = require("./public-release-admission-contract");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { RELEASE_WRITER_FENCE_PATH, parseReleaseWriterFence } = require("./public-release-writer-fence");
const { MEDIA, parsePairMedia } = require("./public-release-switch");
const ROOT = "system/publicDeployment";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }
class ContentActivationConflictError extends p.PublicReleaseProtocolError {
  constructor() { super(); this.code = "content-activation-stale-snapshot"; }
}
function activationPath(pair, operationId) {
  pair = p.parsePublicReleasePair(pair);
  if (!isPublicDeploymentIdentifier(operationId)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/publicationActivations/${operationId}`;
}
function parseContentHead(value, pair) {
  p.exact(value, ["schemaVersion", "pairDigest", "contentHead"]);
  p.exact(value.contentHead, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
  const head = value.contentHead;
  if (value.schemaVersion !== 2 || value.pairDigest !== p.publicReleaseDigest(pair) || head.pairId !== pair.pairId ||
      !isPublicDeploymentIdentifier(head.viewId) || !p.digest(head.manifestDigest) ||
      !Number.isSafeInteger(head.contextSequence) || head.contextSequence < 0) refuse();
  return p.freeze({ ...value, contentHead: { ...head } });
}
function parseContentActivationAttempt(value) {
  p.exact(value, ["schemaVersion", "operationId", "admissionDigest", "pair", "expectedSelectorDigest", "expectedHeadDigest", "witnessDigest", "headCursor", "originalView"]);
  const pair = p.parsePublicReleasePair(value.pair), headCursor = replay.parseReplayCursor(value.headCursor);
  const originalView = replay.parseReplayViewReference(value.originalView, pair);
  if (value.schemaVersion !== 2 || !isPublicDeploymentIdentifier(value.operationId) ||
      ![value.admissionDigest, value.expectedSelectorDigest, value.expectedHeadDigest, value.witnessDigest].every(p.digest)) refuse();
  return p.freeze({ ...value, pair, headCursor, originalView });
}
function parseContentActivationRecord(value, rawAttempt) {
  const attempt = parseContentActivationAttempt(rawAttempt);
  p.exact(value, ["schemaVersion", "kind", "status", "attempt", "attemptDigest", "admission", "headView", "contentHead",
    "codePackOverlayDigest", "selectorDigestBefore", "selectorDigestAfter", "selectedAtActivation", "originalTerminalDigest", "mediaDigestBefore", "mediaDigestAfter"]);
  const storedAttempt = parseContentActivationAttempt(value.attempt), admission = admissionCodec.parseAdmission(value.admission);
  const headView = replay.parseReplayViewReference(value.headView, attempt.pair);
  const expected = { pairId: attempt.pair.pairId, viewId: attempt.witnessDigest,
    manifestDigest: value.contentHead?.manifestDigest, contextSequence: attempt.headCursor.sequence };
  if (value.schemaVersion !== 2 || value.kind !== "pair-content-activation" || value.status !== "activated" ||
      !same(attempt, storedAttempt) || value.attemptDigest !== p.publicReleaseDigest(attempt) ||
      p.publicReleaseDigest(admission) !== attempt.admissionDigest || admission.operationId !== attempt.operationId ||
      admission.changeSequence > attempt.headCursor.sequence ||
      !same(value.contentHead, expected) || !p.digest(expected.manifestDigest) || !p.digest(value.codePackOverlayDigest) ||
      value.selectorDigestBefore !== attempt.expectedSelectorDigest || !p.digest(value.selectorDigestAfter) ||
      ![value.mediaDigestBefore, value.mediaDigestAfter].every(p.digest) ||
      typeof value.selectedAtActivation !== "boolean" || !value.selectedAtActivation && value.selectorDigestBefore !== value.selectorDigestAfter ||
      value.originalTerminalDigest !== null && (!p.digest(value.originalTerminalDigest) || value.selectedAtActivation) ||
      !matchesOriginal(attempt.originalView, admission) || headView.identity.contextSequence !== attempt.headCursor.sequence) refuse();
  return p.freeze({ ...value, attempt: storedAttempt, admission, headView, contentHead: expected });
}
function matchesOriginal(reference, admission) {
  const identity = reference.identity;
  return identity.sourceOperationId === admission.operationId && identity.sourceVersion === admission.source.sourceVersion &&
    identity.snapshotDigest === admission.source.snapshotDigest && identity.contextSequence === admission.changeSequence;
}
function assertOriginalEntry(entry, admission, cursor) {
  const { source } = admission;
  if (entry.operationId !== admission.operationId || !same(entry.pair, admission.pair) || entry.sequence !== admission.changeSequence ||
      cursor.sequence < admission.changeSequence || cursor.sequence === entry.sequence && cursor.lastDigest !== entry.entryDigest ||
      entry.contextRevision !== admission.contextRevision || !same(entry.changes, [{ kind: source.kind, id: source.id,
        action: source.action, sourceVersion: source.sourceVersion, snapshotDigest: source.snapshotDigest }])) refuse();
}

/** The adapter must supply the actual opaque outside preparation and late
 * source/reader/capability guard. There is no default guard or serialized flag.
 * The real replay capsule/namespace/original H/G owner is always checked here,
 * on the same transaction as the switch fence and exact head compare-and-set.
 */
async function activatePublicReleasePairContent({ firestore, attempt: rawAttempt, replayProof, publicationReadOwner,
  assertPublicationCurrentInTransaction, assertOriginalTerminalInTransaction }) {
  const attempt = parseContentActivationAttempt(rawAttempt), pair = attempt.pair, base = work.publicReleasePairPath(pair.pairId);
  work.assertPublicReleasePairDatabase(firestore, pair);
  return firestore.runTransaction(async originalTransaction => {
    if (typeof publicationReadOwner?.trackQualificationTransactionReads !== "function" ||
        typeof publicationReadOwner?.assertQualificationTransactionReadBudget !== "function") refuse();
    const tracker = publicationReadOwner.trackQualificationTransactionReads(originalTransaction), transaction = tracker.transaction;
    const receiptRef = firestore.doc(activationPath(pair, attempt.operationId));
    const prior = await transaction.get(receiptRef);
    if (prior.exists) return { idempotent: true, receipt: parseContentActivationRecord(prior.data(), attempt) };
    const [selectorRow, headRow, fence, logRow, admissionRow, queueRow, pendingRow, pairRow, controlRow, billingRow, mediaRow] =
      await transaction.getAll(firestore.doc(ROOT), firestore.doc(`${base}/heads/current`), firestore.doc(RELEASE_WRITER_FENCE_PATH),
        firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH), firestore.doc(`${admissionCodec.ADMISSIONS}/operations/${attempt.operationId}`),
        firestore.doc(`cmsPublishQueue/${attempt.operationId}`), firestore.doc(`${admissionCodec.ADMISSIONS}/pending/${attempt.operationId}`),
        firestore.doc(base), firestore.doc(`${base}/controls/runtime`), firestore.doc("system/billing"), firestore.doc(MEDIA));
    if (fence.exists) { parseReleaseWriterFence(fence.data()); refuse(); }
    const selector = p.parsePublicReleaseSelector(selectorRow.data()), current = parseContentHead(headRow.data(), pair);
    const media = parsePairMedia(mediaRow.data(), selector);
    if (media.references.find(ref => ref.pairId === pair.pairId)?.manifestDigest !== current.contentHead.manifestDigest) refuse();
    const head = log.parsePublicReleaseChangeHead(logRow.data()), admission = admissionCodec.parseAdmission(admissionRow.data());
    const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
    const selected = same(selector.selectedPair, p.publicReleasePairReference(pair));
    if (p.publicReleaseDigest(selector) !== attempt.expectedSelectorDigest || p.publicReleaseDigest(current) !== attempt.expectedHeadDigest ||
        !same(cursor, attempt.headCursor)) throw new ContentActivationConflictError();
    if ((!selected && !same(selector.recoveryPair, p.publicReleasePairReference(pair))) ||
        !same(p.parsePublicReleasePair(pairRow.data()), pair) || controlRow.data()?.schemaVersion !== 2 ||
        controlRow.data()?.pairId !== pair.pairId || controlRow.data()?.status !== "retained" || billingRow.data()?.disabled === true ||
        selected && !same(selector.contentHead, current.contentHead) ||
        current.contentHead.contextSequence > cursor.sequence || admission.operationId !== attempt.operationId ||
        p.publicReleaseDigest(admission) !== attempt.admissionDigest || admission.changeSequence > cursor.sequence ||
        admission.epoch > selector.epoch || admission.admittedContractDigest !== selector.admittedContractDigest) refuse();
    admissionCodec.assertQueue(queueRow.data(), admission);
    let originalTerminalDigest = null;
    if (pendingRow.exists) {
      p.exact(pendingRow.data(), ["schemaVersion", "operationId", "admissionDigest"]);
      if (!["pending", "publishing", "failed"].includes(queueRow.data().status) || pendingRow.data().schemaVersion !== 2 ||
          pendingRow.data().operationId !== attempt.operationId || pendingRow.data().admissionDigest !== attempt.admissionDigest) refuse();
    } else {
      if (selected || typeof assertOriginalTerminalInTransaction !== "function") refuse();
      const terminal = await assertOriginalTerminalInTransaction({ firestore, transaction,
        operationId: attempt.operationId, admissionDigest: attempt.admissionDigest });
      originalTerminalDigest = p.publicReleaseDigest(terminal);
      if (!["success", "superseded"].includes(queueRow.data().status) || queueRow.data().terminalReceipt !== originalTerminalDigest) refuse();
    }
    const [originalPair, entryRow] = await transaction.getAll(firestore.doc(work.publicReleasePairPath(admission.pair.pairId)),
      firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(admission.changeSequence).padStart(16, "0")}`));
    const original = p.parsePublicReleasePair(originalPair.data());
    if (p.publicReleaseDigest(original) !== admission.pairDigest || !same(p.publicReleasePairReference(original), admission.pair)) refuse();
    const entry = log.parsePublicReleaseChange(entryRow.data());
    assertOriginalEntry(entry, admission, cursor);
    if (!matchesOriginal(attempt.originalView, admission)) refuse();
    const proof = await replay.assertReadReplayWitnessProofInTransaction({ firestore, transaction, pair,
      headCursor: cursor, witnessDigest: attempt.witnessDigest, namespaces: replayProof?.namespaces, headView: replayProof?.headView,
      selectedViews: [attempt.originalView] });
    await replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference: attempt.originalView,
      cursor: { baselineDigest: cursor.baselineDigest, sequence: entry.sequence, lastDigest: entry.entryDigest } });
    if (typeof assertPublicationCurrentInTransaction !== "function") refuse();
    await assertPublicationCurrentInTransaction({ firestore, transaction, tracker, pair, admission, attempt, selector,
      witness: proof.witness, headView: proof.headView });
    const contentHead = { pairId: pair.pairId, viewId: attempt.witnessDigest, manifestDigest: proof.witness.contentViewDigest,
      contextSequence: cursor.sequence };
    const alreadyCurrent = current.contentHead.contextSequence === cursor.sequence;
    if (alreadyCurrent && !same(current.contentHead, contentHead)) refuse();
    const next = selected ? p.parsePublicReleaseSelector({ ...selector, contentHead }) : selector;
    const nextMedia = { ...media, references: media.references.map(ref => ref.pairId === pair.pairId ?
      { ...ref, manifestDigest: contentHead.manifestDigest } : ref) };
    const receipt = parseContentActivationRecord({ schemaVersion: 2, kind: "pair-content-activation", status: "activated", attempt,
      attemptDigest: p.publicReleaseDigest(attempt), admission, headView: proof.headView, contentHead,
      codePackOverlayDigest: proof.witness.codePackOverlayDigest, selectorDigestBefore: p.publicReleaseDigest(selector),
      selectorDigestAfter: p.publicReleaseDigest(next), selectedAtActivation: selected, originalTerminalDigest,
      mediaDigestBefore: p.publicReleaseDigest(media), mediaDigestAfter: p.publicReleaseDigest(nextMedia) }, attempt);
    publicationReadOwner.assertQualificationTransactionReadBudget(tracker);
    if (!alreadyCurrent) transaction.set(headRow.ref, { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), contentHead });
    if (selected && !alreadyCurrent) transaction.set(selectorRow.ref, next);
    if (!alreadyCurrent) transaction.set(mediaRow.ref, nextMedia);
    transaction.create(receiptRef, receipt);
    // No source, log append, pin, code generation, other pair head, original
    // queue, admission pending or terminal outcome is changed by this writer.
    return { idempotent: false, receipt };
  });
}

async function readPublicReleasePairContentActivation({ firestore, attempt: rawAttempt }) {
  const attempt = parseContentActivationAttempt(rawAttempt);
  work.assertPublicReleasePairDatabase(firestore, attempt.pair);
  const row = await firestore.doc(activationPath(attempt.pair, attempt.operationId)).get();
  return row.exists ? parseContentActivationRecord(row.data(), attempt) : null;
}
module.exports = { ContentActivationConflictError, activationPath, parseContentHead, parseContentActivationAttempt, parseContentActivationRecord,
  activatePublicReleasePairContent, readPublicReleasePairContentActivation };

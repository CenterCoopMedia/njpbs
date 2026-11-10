"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const pointer = require("./public-deployment-pointer");
const targets = require("./publication-target");
const admission = require("./public-release-bootstrap-adoption");
const enrollment = require("./public-release-change-enrollment");
const replay = require("./public-release-pair-replay");
const RECEIPTS = "system/publicReleaseAdmissions/bootstrapPairRetentions";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function parseInitialPairRetentionAttempt(raw) {
  p.exact(raw, ["schemaVersion", "operationId", "environment", "expectedSourceDigest", "enrollmentRequestDigest", "currentPair", "recoveryPair", "views"]);
  const pairs = [raw.currentPair, raw.recoveryPair].map(p.parsePublicReleasePair);
  pairs.forEach(work.assertPrivatePairResources);
  if (raw.schemaVersion !== 2 || !pointer.isPublicDeploymentIdentifier(raw.operationId) ||
      ![raw.expectedSourceDigest, raw.enrollmentRequestDigest].every(p.digest) || pairs.some(pair => pair.environment !== raw.environment) ||
      pairs[0].pairId === pairs[1].pairId || !Array.isArray(raw.views) || raw.views.length !== 2) refuse();
  const views = raw.views.map((view, index) => {
    p.exact(view, ["codePackView", "contentView"]);
    return { codePackView: replay.parseReplayViewReference(view.codePackView, pairs[index]),
      contentView: replay.parseReplayViewReference(view.contentView, pairs[index]) };
  });
  return p.freeze({ ...raw, currentPair: pairs[0], recoveryPair: pairs[1], views });
}
function parseReceipt(raw, attempt) {
  p.exact(raw, ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "proofs", "before", "after"]);
  if (raw.schemaVersion !== 2 || raw.kind !== "initial-public-release-pair-retention" || !same(raw.attempt, attempt) ||
      raw.attemptDigest !== p.publicReleaseDigest(attempt) || !p.digest(raw.enrollmentReceiptDigest)) refuse();
  const pairs = [attempt.currentPair, attempt.recoveryPair];
  if (!Array.isArray(raw.proofs) || raw.proofs.length !== 2) refuse();
  raw.proofs.forEach((proof, index) => {
    p.exact(proof, ["pairDigest", "views", "cursor", "codeProofDigest", "contentProofDigest", "sourceCensusDigest"]);
    replay.parseReplayCursor(proof.cursor);
    if (proof.pairDigest !== p.publicReleaseDigest(pairs[index]) || !same(proof.views, attempt.views[index]) ||
        ![proof.codeProofDigest, proof.contentProofDigest, proof.sourceCensusDigest].every(p.digest)) refuse();
  });
  for (const [field, status] of [["before", "candidate"], ["after", "retained"]]) {
    if (!Array.isArray(raw[field]) || raw[field].length !== 2 || raw[field].some((value, i) =>
      !same(value, { schemaVersion: 2, pairId: pairs[i].pairId, status }))) refuse();
  }
  return p.freeze(raw);
}
async function readInitialPairRetentionReceipt({ firestore, attempt: raw }) {
  const attempt = parseInitialPairRetentionAttempt(raw);
  targets.assertPublicationDatabase(firestore, targets.publicationTarget(attempt.environment));
  const row = await firestore.doc(`${RECEIPTS}/${attempt.operationId}`).get();
  if (row.exists && !row.createTime.isEqual(row.updateTime)) refuse();
  return row.exists ? parseReceipt(row.data(), attempt) : null;
}

/** The one first-install retention owner. It changes only candidate lifecycle
 * controls, after both actual complete H/G guards, at the exact original
 * enrolled cutoff under the original closed fences. Live switches retain
 * their existing owner. This does not seed a head or resume any producer. */
async function retainInitialPublicReleasePairs({ firestore, attempt: raw, retentionGuard, dryRun = true }) {
  const attempt = parseInitialPairRetentionAttempt(raw), pairs = [attempt.currentPair, attempt.recoveryPair];
  targets.assertPublicationDatabase(firestore, targets.publicationTarget(attempt.environment));
  if (typeof dryRun !== "boolean") refuse();
  return firestore.runTransaction(async original => {
    const guard = retentionGuard?.begin(original), transaction = guard?.transaction ?? original;
    const paths = ["system/publicDeployment", `${RECEIPTS}/${attempt.operationId}`, "system/publicReleaseChangeLog",
      "system/publicReleaseAdmissions/controls/adoption", ...pairs.flatMap(pair => {
        const base = work.publicReleasePairPath(pair.pairId);
        return [base, `${base}/controls/runtime`, `${base}/rollouts/publisher`, `${base}/heads/current`, `${base}/replay/current`];
      })];
    const rows = await transaction.getAll(...paths.map(name => firestore.doc(name)));
    const root = rows[0].data();
    if (root?.schemaVersion === 2) refuse();
    const before = pointer.assertPublicDeploymentPointer(root);
    if (before.state !== "idle" || before.activeCommitSha !== pairs[0].commitSha || p.publicReleaseDigest(before) !== attempt.expectedSourceDigest ||
        rows[2].exists && rows[2].data().enabled !== false || rows[3].exists && rows[3].data().enabled !== false) refuse();
    await admission.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment: attempt.environment,
      before, operationId: attempt.operationId });
    const enrolled = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction,
      requestDigest: attempt.enrollmentRequestDigest });
    if (!same(enrolled.head, enrolled.receipt.initialHead) || enrolled.receipt.request.operationId !== attempt.operationId ||
        enrolled.receipt.request.expected.liveReleaseSha !== pairs[0].commitSha) refuse();
    const existing = rows[1].exists ? parseReceipt(rows[1].data(), attempt) : null;
    for (const [index, pair] of pairs.entries()) {
      const [registered, control, rollout, head, replayHead] = rows.slice(4 + index * 5, 9 + index * 5);
      if (!same(p.parsePublicReleasePair(registered.data()), pair) || head.exists || replayHead.exists ||
          !same(control.data(), { schemaVersion: 2, pairId: pair.pairId, status: existing ? "retained" : "candidate" }) ||
          rollout.data()?.schemaVersion !== 2 || rollout.data().pairId !== pair.pairId || rollout.data().pairDigest !== p.publicReleaseDigest(pair) ||
          rollout.data().state !== "verified" || !p.digest(rollout.data().readbackDigest)) refuse();
    }
    if (existing) {
      if (existing.enrollmentReceiptDigest !== enrolled.receiptDigest) refuse();
      guard?.finish();
      return { dryRun, idempotent: true, receipt: existing };
    }
    if (!guard || typeof guard.verify !== "function" || typeof guard.finish !== "function") refuse();
    const proofs = await guard.verify();
    if (!Array.isArray(proofs) || proofs.length !== 2) refuse();
    const cursor = { baselineDigest: enrolled.head.baselineDigest, sequence: enrolled.head.sequence, lastDigest: enrolled.head.lastDigest };
    for (const [index, proof] of proofs.entries()) {
      if (proof.pairDigest !== p.publicReleaseDigest(pairs[index]) || !same(proof.views, attempt.views[index]) || !same(proof.cursor, cursor)) refuse();
      const { codePackView, contentView } = attempt.views[index];
      if ([codePackView, contentView].some(view => view.identity.kind !== "qualification" || view.identity.contextSequence !== cursor.sequence) ||
          codePackView.identity.sourceOperationId !== `baseline-codepack-${enrolled.receipt.baseline.logBaselineDigest}` ||
          contentView.identity.sourceOperationId !== `baseline-${enrolled.receipt.baseline.logBaselineDigest}`) refuse();
    }
    guard.finish();
    const receipt = parseReceipt({ schemaVersion: 2, kind: "initial-public-release-pair-retention", attempt,
      attemptDigest: p.publicReleaseDigest(attempt), enrollmentReceiptDigest: enrolled.receiptDigest,
      proofs,
      before: pairs.map(pair => ({ schemaVersion: 2, pairId: pair.pairId, status: "candidate" })),
      after: pairs.map(pair => ({ schemaVersion: 2, pairId: pair.pairId, status: "retained" })) }, attempt);
    if (!dryRun) {
      pairs.forEach((pair, index) => transaction.set(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`), receipt.after[index]));
      transaction.create(firestore.doc(`${RECEIPTS}/${attempt.operationId}`), receipt);
    }
    return { dryRun, idempotent: false, receipt };
  });
}
module.exports = { parseInitialPairRetentionAttempt, parseInitialPairRetentionReceipt: parseReceipt, readInitialPairRetentionReceipt, retainInitialPublicReleasePairs };

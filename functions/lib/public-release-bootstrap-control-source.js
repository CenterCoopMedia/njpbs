"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const enrollment = require("./public-release-change-enrollment");
const admission = require("./public-release-bootstrap-adoption");
const baseline = require("./public-release-change-baseline");
const source = require("./public-release-source-body");
const targets = require("./publication-target");
const retention = require("./public-release-bootstrap-pairs");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const controlPaths = () => ["system/cmsPublicationRuntime", "system/noBuildPostAdmission",
  ...Object.values(require("./public-release-switch").CAPABILITY_PATHS), "system/publicDeployment/noBuildRecordFamilies/current",
  "system/publicReleaseChangeLog", "system/publicReleaseAdmissions/controls/adoption", "system/publicReleaseAdmissions"];
function refuse() { throw new p.PublicReleaseProtocolError(); }

/** Narrow admission for a fresh post-control initial qualification capture. It is
 * unavailable after root conversion or any logged change. Ordinary retained
 * work and live qualification admission keep their existing rules. */
async function assertInitialControlCaptureInTransaction({ firestore, transaction, pair: raw, scope }) {
  const pair = p.parsePublicReleasePair(raw);
  targets.assertPublicationDatabase(firestore, targets.publicationTarget(pair.environment));
  const original = await enrollment.assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction });
  const operationId = original.receipt.request.operationId;
  const paths = controlPaths();
  const [rootRow, retainedRow, controlsRow, headRow, ...rows] = await transaction.getAll(
    firestore.doc('system/publicDeployment'), firestore.doc(`system/publicReleaseAdmissions/bootstrapPairRetentions/${operationId}`),
    firestore.doc(`system/publicReleaseAdmissions/bootstrapControls/${operationId}`),
    firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`), ...paths.map(name => firestore.doc(name)));
  const before = rootRow.data(), retained = retainedRow.data(), controls = controlsRow.data();
  if (before?.schemaVersion === 2 || before?.state !== 'idle' || headRow.exists || !same(original.head, original.receipt.initialHead) ||
      before.activeCommitSha !== original.receipt.request.expected.liveReleaseSha) refuse();
  if (!retainedRow.exists || !controlsRow.exists || !retainedRow.createTime.isEqual(retainedRow.updateTime) ||
      !controlsRow.createTime.isEqual(controlsRow.updateTime)) refuse();
  await admission.assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment: pair.environment, before, operationId });
  const attempt = retention.parseInitialPairRetentionAttempt(retained?.attempt);
  retention.parseInitialPairRetentionReceipt(retained, attempt);
  if (retained.kind !== 'initial-public-release-pair-retention' || retained.schemaVersion !== 2 ||
      retained.attemptDigest !== p.publicReleaseDigest(attempt) || retained.enrollmentReceiptDigest !== original.receiptDigest ||
      attempt.operationId !== operationId || attempt.environment !== pair.environment ||
      attempt.enrollmentRequestDigest !== original.receipt.requestDigest || attempt.expectedSourceDigest !== original.receipt.request.expected.pointerDigest ||
      ![attempt.currentPair, attempt.recoveryPair].some(value => same(value, pair))) refuse();
  p.exact(controls, ['schemaVersion', 'kind', 'attempt', 'attemptDigest', 'enrollmentReceiptDigest', 'installed', 'before', 'after']);
  if (controls.schemaVersion !== 2 || controls.kind !== 'public-release-bootstrap-controls' || controls.attempt?.operationId !== operationId ||
      !same(controls.attempt.pair, attempt.currentPair) || controls.attemptDigest !== p.publicReleaseDigest(controls.attempt) ||
      controls.enrollmentReceiptDigest !== original.receiptDigest || !Array.isArray(controls.before) || controls.before.length !== paths.length ||
      !Array.isArray(controls.after) || !same(controls.after, rows.map(row => row.data() ?? null)) ||
      controls.after[6]?.enabled !== false || controls.after[7]?.enabled !== false) refuse();
  if (scope && (scope.kind !== 'qualification' || scope.sourceOperationId !== `baseline-controls-${p.publicReleaseDigest(controls)}` ||
      scope.contextSequence !== original.head.sequence || scope.sourceVersion !== 1 ||
      scope.snapshotDigest !== original.receipt.baseline.receipt.sourceMemberCensusDigest)) refuse();
  return { original, controls, controlsDigest: p.publicReleaseDigest(controls), paths };
}

/** Read the actual recorded control transition into a NEW H state. The old
 * baseline, source bodies, input scope and completed claim remain immutable.
 * Every other current source must still equal the original frozen source. */
async function captureInitialControlledState({ firestore, pair, state }) {
  return firestore.runTransaction(async transaction => {
    const proof = await assertInitialControlCaptureInTransaction({ firestore, transaction, pair });
    if (state.logBaselineDigest !== proof.original.receipt.baseline.logBaselineDigest || state.event ||
        !same(state.cursor, proof.original.receipt.baseline.receipt.baselineCursor)) refuse();
    const current = await baseline.readPublicReleaseSourceCensusInTransaction({ firestore, transaction });
    const documents = new Map(), sourceMembers = new Map(state.sourceMembers), sourceBodies = new Map(state.sourceBodies);
    for (const value of current.values) for (const document of JSON.parse(value.json).documents) if (document.data !== null) documents.set(document.path, document.data);
    const controlled = new Set(proof.paths.slice(1, 6));
    const support = path => path === 'system/publicReleaseHistoricalCode' || path.startsWith('cmsPreviewPublicContexts/');
    const project = (path, value) => value === undefined ? null : path.startsWith('system/') ? source.publicReleaseAuthorityIdentityDocument(path, value) : value;
    for (const path of new Set([...state.documents.keys(), ...documents.keys()])) {
      if (!controlled.has(path) && !support(path) && !same(project(path, state.documents.get(path)), project(path, documents.get(path)))) refuse();
    }
    const updated = new Map(state.documents);
    for (const [index, path] of proof.paths.entries()) if (controlled.has(path)) {
      if (!same(project(path, state.documents.get(path)), project(path, proof.controls.before[index] ?? undefined))) refuse();
      const value = documents.get(path);
      if (value === undefined) updated.delete(path); else updated.set(path, value);
    }
    for (const value of current.values) {
      const body = JSON.parse(value.json);
      if (!body.documents.some(document => controlled.has(document.path))) continue;
      sourceBodies.set(value.contentDigest, body);
      for (const document of body.documents) if (controlled.has(document.path)) {
        if (document.data === null) sourceMembers.delete(document.path); else sourceMembers.set(document.path, value.contentDigest);
      }
    }
    return { ...state, documents: updated, sourceMembers, sourceBodies, initialControls: proof.controls };
  }, { readOnly: true });
}
module.exports = { assertInitialControlCaptureInTransaction, captureInitialControlledState };

"use strict";
const protocol = require("./public-release-pair");
const log = require("./public-release-change-log");
const pointer = require("./public-deployment-pointer");
const runtime = require("./cms-publication-runtime-control");
const context = require("./public-context-revision");
const CONTROL_PATH = "system/publicReleaseChangeLog";
const ENROLLMENT_PATH = `${log.PUBLIC_RELEASE_CHANGES_PATH}/enrollment/initial`;
const POINTER_PATH = "system/publicDeployment";
class PublicReleaseEnrollmentError extends Error {
  constructor(code) { super(code); this.name = "PublicReleaseEnrollmentError"; this.code = code; }
}
function fail(code) { throw new PublicReleaseEnrollmentError(code); }
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail("invalid-enrollment-request");
}
function parsePublicReleaseChangeEnrollmentRequest(value) {
  exact(value, ["schemaVersion", "operationId", "logEpoch", "baselineDigest", "expected"]);
  const expected = value.expected;
  exact(expected, ["projectId", "liveReleaseSha", "pointerDigest", "runtimeDigest", "contextRevision", "contextDigest", "publicSourceCensusDigest"]);
  if (value.schemaVersion !== 1 || ![value.operationId, value.logEpoch].every(pointer.isPublicDeploymentIdentifier) ||
      !protocol.digest(value.baselineDigest) || !/^[a-z][a-z0-9-]{3,62}$/.test(expected.projectId) ||
      !pointer.isCommitSha(expected.liveReleaseSha) || !protocol.positive(expected.contextRevision) ||
      ![expected.pointerDigest, expected.runtimeDigest, expected.contextDigest, expected.publicSourceCensusDigest].every(protocol.digest) ||
      expected.contextDigest !== context.publicContextDigest(expected.contextRevision)) fail("invalid-enrollment-request");
  return protocol.freeze({ schemaVersion: 1, operationId: value.operationId, logEpoch: value.logEpoch, baselineDigest: value.baselineDigest,
    expected: { projectId: expected.projectId, liveReleaseSha: expected.liveReleaseSha, pointerDigest: expected.pointerDigest,
      runtimeDigest: expected.runtimeDigest, contextRevision: expected.contextRevision, contextDigest: expected.contextDigest,
      publicSourceCensusDigest: expected.publicSourceCensusDigest } });
}
function parsePublicReleaseChangeEnrollmentReceipt(value) {
  exact(value, ["schemaVersion", "kind", "request", "requestDigest", "initialHead", "baseline", "createdAt"]);
  const request = parsePublicReleaseChangeEnrollmentRequest(value.request), initialHead = log.parsePublicReleaseChangeHead(value.initialHead);
  exact(value.baseline, ["receipt", "logBaselineDigest"]);
  const baseline = require("./public-release-change-baseline").parsePublicReleaseChangeBaseline(value.baseline.receipt);
  if (value.schemaVersion !== 1 || value.kind !== "initial-public-release-change-enrollment" ||
      value.requestDigest !== protocol.publicReleaseDigest(request) || !same(initialHead, log.initialPublicReleaseChangeHead(request.baselineDigest)) ||
      value.baseline.logBaselineDigest !== protocol.publicReleaseDigest(baseline) || baseline.logEpoch !== request.logEpoch ||
      baseline.liveReleaseSha !== request.expected.liveReleaseSha || !same(baseline.baselineCursor, { baselineDigest: request.baselineDigest, sequence: 0, lastDigest: request.baselineDigest }) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt) fail("invalid-enrollment-receipt");
  return protocol.freeze({ schemaVersion: 1, kind: value.kind, request, requestDigest: value.requestDigest, initialHead, baseline: { receipt: baseline, logBaselineDigest: value.baseline.logBaselineDigest }, createdAt: value.createdAt });
}
async function readState(firestore, transaction) {
  const [head, receipt, deployment, publicationRuntime, publicContext, control] = await transaction.getAll(
    ...[log.PUBLIC_RELEASE_CHANGES_PATH, ENROLLMENT_PATH, POINTER_PATH, runtime.RUNTIME_DOCUMENT_PATH,
      context.PUBLIC_CONTEXT_PATH, CONTROL_PATH].map(path => firestore.doc(path)));
  return { head, receipt, deployment, publicationRuntime, publicContext, control };
}
function originalReceipt(state, request) {
  if (!state.receipt.exists) {
    if (state.head.exists) fail("enrollment-head-exists");
    return null;
  }
  if (!state.head.exists) fail("enrollment-partial-state");
  const receipt = parsePublicReleaseChangeEnrollmentReceipt(state.receipt.data());
  const head = log.parsePublicReleaseChangeHead(state.head.data());
  if (head.baselineDigest !== receipt.initialHead.baselineDigest || request && receipt.requestDigest !== protocol.publicReleaseDigest(request)) {
    fail("enrollment-conflict");
  }
  return receipt;
}
function observedCutoff(firestore, state, publicSourceCensusDigest) {
  const deployment = pointer.assertPublicDeploymentPointer(state.deployment.data());
  if (deployment.state !== "idle" || !pointer.isCommitSha(deployment.activeCommitSha) || deployment.activeGeneration < 1 ||
      deployment.mediaLifecycleReady !== true) fail("enrollment-source-not-idle");
  const control = runtime.parseCmsPublicationRuntimeControl(state.publicationRuntime.data());
  const cloud = runtime.cloudCmsPublicationRuntimeControl(control);
  if (control.phase !== "paused" || cloud.phase !== "paused" ||
      !["cloudflare-publisher", "cloudflare-dev-publisher"].includes(cloud.serializerId)) fail("enrollment-runtime-not-paused");
  if (state.control.exists) fail("enrollment-producer-control-present");
  const revision = state.publicContext.data();
  if (revision?.schemaVersion !== 1 || !protocol.positive(revision.revision)) fail("enrollment-context-missing");
  return { projectId: firestore.projectId, liveReleaseSha: deployment.activeCommitSha,
    pointerDigest: protocol.publicReleaseDigest(state.deployment.data()), runtimeDigest: protocol.publicReleaseDigest(control),
    contextRevision: revision.revision, contextDigest: context.publicContextDigest(revision.revision), publicSourceCensusDigest };
}
async function sourceCensus(firestore, transaction, state, operationId) {
  if (firestore.projectId === "njpbs-site") {
    if ((await transaction.get(firestore.doc("system/productionPublicReleasePauseRecovery"))).exists)
      fail("enrollment-production-recovery-unreviewed");
    let closed;
    try {
      closed = await require("./public-release-bootstrap-adoption").assertClosedBootstrapFenceInTransaction({
        firestore, transaction, environment: "production", before: state.deployment.data(), operationId });
    } catch (error) {
      if (error instanceof protocol.PublicReleaseProtocolError || error?.name === "PublicReleaseBootstrapAdmissionPausedError")
        fail("enrollment-production-fence-required");
      throw error;
    }
    if ((await transaction.get(firestore.doc(`system/productionPublicReleasePause/failures/${closed.operationId}`))).exists)
      fail("enrollment-production-recovery-unreviewed");
    const original = await transaction.get(firestore.doc(`${require("./public-release-bootstrap-admission").BOOTSTRAP_ADMISSION_ATTEMPTS}/${closed.operationId}`));
    if (!original.exists) fail("enrollment-partial-state");
    await require("./dev-public-release-pause").assertProductionPublicReleaseDrainInTransaction({ firestore, transaction, attempt: original.data() });
  }
  // Reuse the source owner's public-only projection and limits. This is the
  // raw census before the baseline adds its retained CODE member.
  return require("./public-release-change-baseline").readPublicReleaseSourceCensusInTransaction({ firestore, transaction });
}
/** Read-only preparation. Returns digests, never source bodies or credentials. */
async function inspectPublicReleaseChangeEnrollment({ firestore }) {
  return firestore.runTransaction(async transaction => {
    const state = await readState(firestore, transaction);
    if (state.head.exists || state.receipt.exists) fail("enrollment-head-exists");
    // Refuse unsupported admission before the potentially larger census read.
    observedCutoff(firestore, state, "0".repeat(64));
    const census = await sourceCensus(firestore, transaction, state);
    return { schemaVersion: 1, expected: observedCutoff(firestore, state, census.sourceMemberCensusDigest),
      publicSourceMemberCount: census.sourceMembers.length };
  }, { readOnly: true });
}
/** Initial install only. Private source/CODE preparation belongs to the same
 * baseline owner; first head, global baseline and original receipt commit
 * together. Nothing here enables a producer, selector or admission. */
async function enrollPublicReleaseChangeLog({ firestore, request: rawRequest, dryRun = true, currentCodeRequest, readSecret }) {
  const request = parsePublicReleaseChangeEnrollmentRequest(rawRequest);
  if (typeof dryRun !== "boolean" || firestore.projectId !== request.expected.projectId) fail("enrollment-project-mismatch");
  const result = await require("./public-release-change-baseline").capturePublicReleaseChangeBaseline({ firestore,
    logEpoch: request.logEpoch, currentCodeRequest, readSecret, enrollment: request, dryRun });
  if (!result.enrollment) fail("enrollment-partial-state");
  return { status: dryRun && !result.enrollment.idempotent ? "dry-run" : "enrolled", ...result.enrollment };
}
async function originalCapture(firestore, transaction, receipt) {
  const original = await require("./public-release-change-baseline").assertReadPublicReleaseChangeBaselineInTransaction({
    firestore, transaction, logBaselineDigest: receipt.baseline.logBaselineDigest });
  if (!same(original.receipt, receipt.baseline.receipt)) fail("enrollment-partial-state");
  return { ...original, logBaselineDigest: receipt.baseline.logBaselineDigest,
    enrollment: { idempotent: true, receipt, receiptDigest: protocol.publicReleaseDigest(receipt) } };
}
/** Baseline-owner seam, called in its read-only preparation transaction. */
async function preparePublicReleaseChangeEnrollmentInTransaction({ firestore, transaction, request: rawRequest }) {
  const request = parsePublicReleaseChangeEnrollmentRequest(rawRequest);
  if (firestore.projectId !== request.expected.projectId) fail("enrollment-project-mismatch");
  const state = await readState(firestore, transaction), before = originalReceipt(state, request);
  if (before) return { original: await originalCapture(firestore, transaction, before) };
  observedCutoff(firestore, state, request.expected.publicSourceCensusDigest);
  if ((await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/baselines/${request.logEpoch}`))).exists) fail("enrollment-partial-state");
  const census = await sourceCensus(firestore, transaction, state, request.operationId);
  if (!same(observedCutoff(firestore, state, census.sourceMemberCensusDigest), request.expected)) fail("enrollment-cutoff-mismatch");
  return { ...census, cursor: { baselineDigest: request.baselineDigest, sequence: 0, lastDigest: request.baselineDigest },
    liveReleaseSha: request.expected.liveReleaseSha, createdAt: state.deployment.readTime.toDate().toISOString() };
}
/** Baseline-owner seam. Only Firestore reads and pure hashing precede these
 * four atomic creates. All source/CODE bodies were retained outside this tx. */
async function commitPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction, request: rawRequest, receipt,
  sourceMembers, logBaselineDigest, augmentCode, dryRun }) {
  const request = parsePublicReleaseChangeEnrollmentRequest(rawRequest), state = await readState(firestore, transaction);
  const before = originalReceipt(state, request);
  if (before) return originalCapture(firestore, transaction, before);
  observedCutoff(firestore, state, request.expected.publicSourceCensusDigest);
  const baselineRef = firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/baselines/${request.logEpoch}`);
  const indexRef = firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/baselineDigests/${logBaselineDigest}`);
  const [priorBaseline, priorIndex] = await transaction.getAll(baselineRef, indexRef);
  if (priorBaseline.exists || priorIndex.exists) fail("enrollment-partial-state");
  const census = await sourceCensus(firestore, transaction, state, request.operationId);
  if (!same(observedCutoff(firestore, state, census.sourceMemberCensusDigest), request.expected) ||
      augmentCode(census).sourceMemberCensusDigest !== receipt.sourceMemberCensusDigest) fail("enrollment-cutoff-mismatch");
  const enrollment = parsePublicReleaseChangeEnrollmentReceipt({ schemaVersion: 1, kind: "initial-public-release-change-enrollment", request,
    requestDigest: protocol.publicReleaseDigest(request), initialHead: log.initialPublicReleaseChangeHead(request.baselineDigest),
    baseline: { receipt, logBaselineDigest }, createdAt: receipt.createdAt });
  if (!dryRun) {
    transaction.create(firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH), enrollment.initialHead);
    transaction.create(baselineRef, receipt);
    transaction.create(indexRef, { schemaVersion: 2, logEpoch: request.logEpoch });
    transaction.create(firestore.doc(ENROLLMENT_PATH), enrollment);
  }
  return { receipt, sourceMembers, logBaselineDigest,
    enrollment: { idempotent: false, receipt: enrollment, receiptDigest: protocol.publicReleaseDigest(enrollment) } };
}
/** Read-only original identity; later source/control progress never rewrites
 * the original receipt. It does not certify a current baseline or adoption. */
async function assertReadPublicReleaseChangeEnrollmentInTransaction({ firestore, transaction, requestDigest }) {
  const state = await readState(firestore, transaction), receipt = originalReceipt(state);
  if (!receipt || requestDigest !== undefined && requestDigest !== receipt.requestDigest) fail("enrollment-receipt-missing");
  await originalCapture(firestore, transaction, receipt);
  return { receipt, receiptDigest: protocol.publicReleaseDigest(receipt), head: log.parsePublicReleaseChangeHead(state.head.data()) };
}
module.exports = { ENROLLMENT_PATH, PublicReleaseEnrollmentError, parsePublicReleaseChangeEnrollmentRequest,
  parsePublicReleaseChangeEnrollmentReceipt, inspectPublicReleaseChangeEnrollment, enrollPublicReleaseChangeLog,
  assertReadPublicReleaseChangeEnrollmentInTransaction, preparePublicReleaseChangeEnrollmentInTransaction,
  commitPublicReleaseChangeEnrollmentInTransaction };

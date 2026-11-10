"use strict";

const p = require("./public-release-pair");
const pause = require("./dev-public-release-pause");
const adoption = require("./public-release-bootstrap-adoption");
const { exhaustedPostProof } = require("./no-build-post-proof-state");
const i = pause.recoveryInternals;
const ROOT = "system/devPublicReleasePause";
const RECOVERY_EVIDENCE_PATH = "system/devPublicReleasePauseRecovery";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const refuse = () => { throw new p.PublicReleaseProtocolError(); };
function parseDevPublicReleasePauseRecoveryAttempt(value) {
  p.exact(value, ["schemaVersion", "pauseAttempt", "pauseReceiptDigest", "failureReceiptDigest"]);
  if (value.schemaVersion !== 1 || !p.digest(value.pauseReceiptDigest) || !p.digest(value.failureReceiptDigest)) refuse();
  pause.parseDevPublicReleasePauseAttempt(value.pauseAttempt);
  return p.freeze(structuredClone(value));
}
function database(firestore) { if (firestore?.projectId !== "njpbs-site-dev") refuse(); }
function immutable(row, expected) {
  if (!row.exists || !row.createTime.isEqual(row.updateTime) || !same(row.data(), expected)) refuse();
  return row.data();
}
function exhausted(value, runtime) {
  return value?.schemaVersion === 1 && value.status === "failed" && value.attempts === 4 &&
    value.claim == null && value.nextAttemptAt === null && value.runtime && same(value.runtime, runtime);
}
async function rows(firestore, transaction, path) {
  const result = await transaction.get(firestore.collection(path).limit(1001));
  if (result.size > 1000) refuse();
  return result.docs;
}
/** A complete quiescence check, not a retry grant. Every recorded blocker must
 * still be an exact terminal failure; every other task must already be terminal.
 * Missing, pending, claimed, scheduled or changed work refuses before fences. */
async function inspect(firestore, transaction, attempt) {
  const a = attempt.pauseAttempt, s = await i.state(firestore, transaction, a);
  const source = i.readOriginalPause(s, a), failure = i.readOriginalFailure(s, a);
  if (!failure || p.publicReleaseDigest(source) !== attempt.pauseReceiptDigest ||
      p.publicReleaseDigest(failure) !== attempt.failureReceiptDigest) refuse();
  // A later enrolled selector is no longer a legacy pointer. Preserve original
  // recovery readback without feeding it to the schema-one validator.
  if (s.head.exists || s.enrollment.exists || s.producer.exists || s.pointer.data()?.schemaVersion !== 1) refuse();
  i.requireOld(s, a);
  if (!i.current(s, a).ownsPausedRuntime || s.drained.exists) refuse();
  const runtime = { owner: "cloudflare", release: a.oldRuntime.commitSha };
  const allowed = new Set(failure.blockers.map(row => `${row.code}:${row.path}`));
  const documents = new Map(), queues = new Map();
  const save = row => { if (!row.exists) refuse(); documents.set(row.ref.path, row); return row.data(); };
  for (const operationId of failure.operations) {
    const row = await transaction.get(firestore.doc(`cmsPublishQueue/${operationId}`));
    const value = save(row); queues.set(operationId, value);
    if (!["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"].includes(value.transport) ||
        !value.backgroundRuntime || !same(value.backgroundRuntime, runtime) ||
        !["failed", "public_unconfirmed", "success"].includes(value.status) || value.claim != null || value.nextAttemptAt != null ||
        value.artifactBuild !== undefined || value.homeFullBuild !== undefined) refuse();
  }
  for (const blocker of failure.blockers) {
    const row = await transaction.get(firestore.doc(blocker.path)), value = save(row);
    if (blocker.code === "queue-failed") {
      if (!["failed", "public_unconfirmed"].includes(value.status) && !(exhaustedPostProof(value) && value.postProof.claim == null)) refuse();
    } else if (blocker.code === "home-owner-failed") {
      if (value.operationId !== blocker.operationId || !same(value.runtime, runtime) || value.homeRefresh?.status !== "pending" ||
          !allowed.has(`home-refresh-exhausted:${value.homeRefresh.taskPath}`)) refuse();
    } else {
      if (!exhausted(value, runtime)) refuse();
      if (blocker.code === "background-exhausted") {
        const outputRow = await transaction.get(firestore.doc(`cmsBackgroundOutputs/${value.output}`)), output = save(outputRow);
        if (value.owner !== "post-background-v1" || !p.positive(value.revision) || output.status !== "failed" || output.claim != null || output.taskPath !== row.ref.path ||
            output.owner !== value.owner || output.revision !== value.revision || !same(output.runtime, runtime)) refuse();
      } else if (blocker.code === "background-preparation-exhausted") {
        if (value.contextDigest !== row.id) refuse();
      } else if (blocker.code === "home-refresh-exhausted") {
        const homeRow = await transaction.get(firestore.doc("system/publicDeployment/noBuildPageOwners/home")), home = save(homeRow);
        const outputRow = await transaction.get(firestore.doc("cmsBackgroundOutputs/home")), output = save(outputRow);
        require("./no-build-home-confirmation").assertHomeRefreshInput(value.input);
        if (!require("./no-build-home-ownership").isHomePageAuthority(home) ||
            value.owner !== "page-no-build-v1" || !p.positive(value.revision) || value.input?.sourceOperationId !== blocker.operationId ||
            home.homeRefresh?.taskPath !== row.ref.path || home.homeRefresh.status !== "pending" ||
            home.homeRefresh.sourceOperationId !== blocker.operationId ||
            home.homeRefresh.postId !== value.input.postId || home.homeRefresh.sourceVersion !== value.input.sourceVersion ||
            queues.get(blocker.operationId)?.noBuildPost?.postId !== value.input.postId ||
            queues.get(blocker.operationId)?.noBuildPost?.sourceVersion !== value.input.sourceVersion ||
            home.homeRefresh.revision !== value.revision || home.operationId !== value.input.homeOperationId ||
            home.sourceVersion !== value.input.homeSourceVersion || output.operationId !== home.operationId ||
            output.owner !== value.owner || output.claim != null || !same(home.runtime, runtime)) refuse();
      } else refuse();
    }
  }
  // Include all original queue tasks, even ones no longer selected by an output.
  // This is intentionally stricter than the ordinary pause's current-work drain.
  for (const queue of await rows(firestore, transaction, "cmsPublishQueue")) {
    const value = queue.data();
    for (const family of ["backgroundOutputs", "backgroundPreparation", "homePageRefresh"]) {
      for (const row of await rows(firestore, transaction, `${queue.ref.path}/${family}`)) {
        const task = row.data();
        const code = family === "backgroundOutputs" ? "background-exhausted" :
          family === "backgroundPreparation" ? "background-preparation-exhausted" : "home-refresh-exhausted";
        if (task.claim != null || task.nextAttemptAt != null ||
            !["verified", "superseded", "cancelled"].includes(task.status) && !allowed.has(`${code}:${row.ref.path}`)) refuse();
      }
    }
    if (value.postProof && (value.postProof.claim != null || value.postProof.nextAttemptAt != null ||
        !["verified", "superseded"].includes(value.postProof.status) &&
        !(allowed.has(`queue-failed:${queue.ref.path}`) && exhaustedPostProof(value) && value.postProof.attempts === 4))) refuse();
  }
  const counts = await i.drain(firestore, transaction, a, false, source.initialQueueFailures, allowed);
  // The approved source remains intended source, never proof of publication.
  // Record exact affected document IDs, including all public source members for
  // context-wide failures, without copying staff data into the operator result.
  const census = await require("./public-release-change-baseline").readPublicReleaseSourceCensusInTransaction({ firestore, transaction });
  const sourcePaths = census.sourceMembers.filter(row => /^cms(?:Posts|Pages|Settings|AuthorProfilesPublic)\//.test(`${row.collection}/${row.id}`))
    .map(row => `${row.collection}/${row.id}`);
  const failedWork = [...queues].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([operationId, queue]) => {
    let affectedDocuments;
    if (queue.transport === "public-context-no-build-v1") {
      if (queue.publicContext?.operationId !== operationId || !p.positive(queue.publicContext.contextRevision) ||
          queue.publicContext.contextDigest !== require("./public-context-revision").publicContextDigest(queue.publicContext.contextRevision) ||
          !same(queue.publicContext.runtime, runtime)) refuse();
      affectedDocuments = sourcePaths;
    }
    else {
      const collection = queue.transport === "post-no-build-v1" ? "cmsPosts" : "cmsPages";
      const native = queue.transport === "post-no-build-v1" ? queue.noBuildPost : queue.noBuildPage;
      const id = native?.postId ?? native?.pageId;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id ?? "") || native.operationId !== operationId ||
          !p.positive(native.sourceVersion) || native.rendererSha !== runtime.release) refuse();
      affectedDocuments = [`${collection}/${id}`];
    }
    return { operationId, queuePath: `cmsPublishQueue/${operationId}`, outcome: "failed-not-published", originalQueueStatus: queue.status,
      documents: [...new Set(affectedDocuments)].sort(), failureReceiptDigest: attempt.failureReceiptDigest,
      records: [...documents].filter(([path]) => path === `cmsPublishQueue/${operationId}` ||
        path.startsWith(`cmsPublishQueue/${operationId}/`) || failure.blockers.some(row => row.operationId === operationId && row.path === path))
        .map(([path, row]) => ({ path, digest: p.publicReleaseDigest(row.data()) })).sort((a, b) => a.path.localeCompare(b.path, "en")) };
  });
  const evidence = [...documents].map(([path, row]) => ({ path, digest: p.publicReleaseDigest(row.data()) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { s, counts, failedWork, evidence };
}
function receiptFor(attempt, observed) {
  const receipt = { schemaVersion: 1, kind: "dev-public-release-pause-quiescent", attempt,
    attemptDigest: p.publicReleaseDigest(attempt), operationId: attempt.pauseAttempt.operationId,
    projectId: "njpbs-site-dev", originalOutcome: "paused-failed", drainCommitted: false,
    failedWork: observed.failedWork, evidence: observed.evidence, counts: observed.counts,
    remedy: "logged-republish-after-resume", acceptedWorkChanged: 0, providerWrites: 0 };
  require("./public-release-source-body").publicReleaseSnapshotJson(receipt, 800_000);
  // Validate the exact persistent marker before even acquiring fences. Later
  // baseline/qualification readers must accept every byte we seal here.
  parseDevPublicReleasePauseRecoveryEvidence(markerFor(receipt));
  return receipt;
}
function markerFor(receipt) {
  return { schemaVersion: 1, kind: "dev-public-release-failed-not-published", operationId: receipt.operationId,
    projectId: "njpbs-site-dev",
    receiptDigest: p.publicReleaseDigest(receipt), failureReceiptDigest: receipt.attempt.failureReceiptDigest,
    failedWork: receipt.failedWork, remedy: receipt.remedy };
}
function parseDevPublicReleasePauseRecoveryEvidence(value) {
  return require("./dev-public-release-pause-recovery-evidence").parseDevPublicReleasePauseRecoveryEvidence(
    value, p, require("./public-deployment-pointer").isPublicDeploymentIdentifier);
}
async function readState(firestore, transaction, attempt) {
  const [saved, marker] = await transaction.getAll(firestore.doc(`${ROOT}/recoveries/${attempt.pauseAttempt.operationId}`),
    firestore.doc(RECOVERY_EVIDENCE_PATH));
  if (saved.exists) {
    const receipt = saved.data();
    if (!same(receipt.attempt, attempt)) refuse();
    immutable(saved, receiptFor(attempt, receipt)); immutable(marker, markerFor(receipt));
    return { receipt, marker: marker.data() };
  }
  if (marker.exists) refuse();
  return { receipt: null, marker: null };
}
async function readDevPublicReleasePauseRecovery({ firestore, attempt: raw }) {
  const attempt = parseDevPublicReleasePauseRecoveryAttempt(raw); database(firestore);
  return firestore.runTransaction(async transaction => {
    const { receipt } = await readState(firestore, transaction, attempt);
    let canContinue = false;
    try {
      const observed = await inspect(firestore, transaction, attempt);
      canContinue = Boolean(receipt && same(receipt, receiptFor(attempt, observed)) && i.current(observed.s, attempt.pauseAttempt).currentReady);
    } catch (error) { if (!(error instanceof p.PublicReleaseProtocolError)) throw error; }
    return { recoveryCommitted: Boolean(receipt), canContinue, originalOutcome: "paused-failed", drainCommitted: false,
      receipt, receiptDigest: receipt ? p.publicReleaseDigest(receipt) : null };
  }, { readOnly: true });
}
async function recoverDevPublicReleasePause({ firestore, attempt: raw }) {
  const attempt = parseDevPublicReleasePauseRecoveryAttempt(raw); database(firestore);
  // Preserve historical recovery on retry without re-closing a later runtime.
  const before = await readDevPublicReleasePauseRecovery({ firestore, attempt });
  if (before.recoveryCommitted) return { idempotent: true, ...before };
  await firestore.runTransaction(async transaction => receiptFor(attempt, await inspect(firestore, transaction, attempt)), { readOnly: true });
  await adoption.closePublicReleaseBootstrapAdmission({ firestore, attempt: i.bootstrapAttempt(attempt.pauseAttempt) });
  await firestore.runTransaction(async transaction => {
    const existing = await readState(firestore, transaction, attempt);
    if (existing.receipt) return;
    const observed = await inspect(firestore, transaction, attempt);
    if (!i.current(observed.s, attempt.pauseAttempt).currentReady) refuse();
    const receipt = receiptFor(attempt, observed);
    transaction.create(firestore.doc(`${ROOT}/recoveries/${attempt.pauseAttempt.operationId}`), receipt);
    transaction.create(firestore.doc(RECOVERY_EVIDENCE_PATH), markerFor(receipt));
    transaction.create(firestore.collection("admin_logs").doc(), require("./audit").adminLogEntry({
      actorUid: "system:dev-public-release-pause-recovery", action: "public-release.dev-pause-quiescent",
      target: receipt.operationId, before: null, after: { receiptDigest: p.publicReleaseDigest(receipt), originalOutcome: "paused-failed" } }));
  });
  return { idempotent: false, ...await readDevPublicReleasePauseRecovery({ firestore, attempt }) };
}
module.exports = { RECOVERY_EVIDENCE_PATH, parseDevPublicReleasePauseRecoveryAttempt,
  parseDevPublicReleasePauseRecoveryEvidence, recoverDevPublicReleasePause, readDevPublicReleasePauseRecovery };

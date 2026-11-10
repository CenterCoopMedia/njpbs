"use strict";

const p = require("./public-release-pair");
// CLI preflight imports this module before ADC initializes its app. Load the
// shared audit writer only after the operator enters its write transaction.
const adminLogEntry = fields => require("./audit").adminLogEntry(fields);
const { assertPublicDeploymentPointer, isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { publicationTarget, assertPublicationDatabase } = require("./publication-target");
const fence = require("./public-release-bootstrap-admission");
const writer = require("./public-release-writer-fence");
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function database(firestore, environment) {
  const target = publicationTarget(environment);
  if (!/^demo-[a-z0-9-]+$/.test(firestore.projectId ?? "") || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? ""))
    assertPublicationDatabase(firestore, target);
}
function legacyBootstrapPointerDigest(raw) {
  const pointer = assertPublicDeploymentPointer(raw), { updatedAt: ignored, ...core } = pointer;
  void ignored;
  return p.publicReleaseDigest(core);
}
function parseAttempt(value) {
  p.exact(value, ["schemaVersion", "operationId", "environment", "legacyPointerDigest"]);
  if (value.schemaVersion !== 2 || !isPublicDeploymentIdentifier(value.operationId) || !p.digest(value.legacyPointerDigest)) refuse();
  publicationTarget(value.environment);
  return p.freeze({ ...value });
}
/** Operator-only, no HTTP export or scheduled caller. Closing is the first
 * install-pause action; changing ready pins never opens this separate fence. */
async function closePublicReleaseBootstrapAdmission({ firestore, attempt: raw }) {
  const attempt = parseAttempt(raw); database(firestore, attempt.environment);
  const ref = firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH);
  const attemptRef = firestore.doc(`${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${attempt.operationId}`);
  return firestore.runTransaction(async transaction => {
    const writerRef = firestore.doc(writer.RELEASE_WRITER_FENCE_PATH);
    const [row, saved, pointerRow, writerRow] = await transaction.getAll(ref, attemptRef, firestore.doc("system/publicDeployment"), writerRef);
    if (saved.exists) {
      if (!same(parseAttempt(saved.data()), attempt)) refuse();
      const stored = fence.parseBootstrapAdmissionFence(row.data());
      if (stored.status !== "closed" || stored.operationId !== attempt.operationId || stored.attemptDigest !== p.publicReleaseDigest(attempt) ||
          !same(writer.parseReleaseWriterFence(writerRow.data()),
            { schemaVersion: 2, operationId: stored.operationId, attemptDigest: stored.attemptDigest })) refuse();
      return { idempotent: true, fence: stored };
    }
    const previous = row.exists ? fence.parseBootstrapAdmissionFence(row.data()) : null;
    if (previous && previous.status !== "open") refuse();
    if (previous) {
      const abandoned = (await transaction.get(firestore.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${previous.operationId}`))).data();
      if (abandoned?.kind !== "bootstrap-admission-abandoned" || abandoned.operationId !== previous.operationId ||
          abandoned.attemptDigest !== previous.attemptDigest || p.publicReleaseDigest(abandoned) !== previous.resumeReceiptDigest) refuse();
    }
    const pointer = assertPublicDeploymentPointer(pointerRow.data());
    if (writerRow.exists || legacyBootstrapPointerDigest(pointer) !== attempt.legacyPointerDigest || pointer.state !== "idle" ||
        pointer.activeGeneration < 1 || pointer.mediaLifecycleReady !== true ||
        pointer.lastReservedGeneration !== pointer.activeGeneration || pointer.newestEligibleGeneration !== pointer.activeGeneration) refuse();
    // Drain before closing. This transactional query also catches a racing
    // source acceptance, so the writer fence cannot strand an accepted queue.
    const pending = await transaction.get(firestore.collection("cmsPublishQueue")
      .where("status", "in", ["reserved", "pending", "publishing"]).limit(1));
    if (!pending.empty) refuse();
    const stored = fence.parseBootstrapAdmissionFence({ schemaVersion: 2, operationId: attempt.operationId,
      attemptDigest: p.publicReleaseDigest(attempt), status: "closed", resumeReceiptDigest: null });
    transaction.create(attemptRef, attempt);
    if (previous) transaction.set(ref, stored); else transaction.create(ref, stored);
    transaction.create(writerRef, { schemaVersion: 2, operationId: stored.operationId, attemptDigest: stored.attemptDigest });
    transaction.create(firestore.collection("admin_logs").doc(), adminLogEntry({ actorUid: "system:public-release-bootstrap",
      action: "public-release.bootstrap-admission", target: attempt.operationId, before: previous, after: { status: "closed", attemptDigest: stored.attemptDigest },
    }));
    return { idempotent: false, fence: stored };
  });
}
/** Initial-selector CAS uses this same transaction before any writes. The
 * original pointer digest seals the closed pause to that exact first install. */
async function assertClosedBootstrapFenceInTransaction({ firestore, transaction, environment, before, operationId }) {
  database(firestore, environment);
  const [row, writerRow] = await transaction.getAll(firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH),
    firestore.doc(writer.RELEASE_WRITER_FENCE_PATH));
  const stored = fence.parseBootstrapAdmissionFence(row.data());
  if (stored.status !== "closed" || operationId !== undefined && stored.operationId !== operationId) refuse();
  if (!same(writer.parseReleaseWriterFence(writerRow.data()), { schemaVersion: 2, operationId: stored.operationId, attemptDigest: stored.attemptDigest })) refuse();
  const attempt = parseAttempt((await transaction.get(firestore.doc(`${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${stored.operationId}`))).data());
  if (attempt.environment !== environment || p.publicReleaseDigest(attempt) !== stored.attemptDigest ||
      attempt.legacyPointerDigest !== legacyBootstrapPointerDigest(before) || assertPublicDeploymentPointer(before).state !== "idle") refuse();
  return stored;
}
/** Startup may refresh timings after the original ready control is restored.
 * Those operational fields cannot strand return; all pins/capabilities remain
 * exact, and the immutable receipts still seal the complete original bytes. */
function sameBootstrapPreviewIdentity(current, original) {
  if (!current || !original) return false;
  const identity = value => {
    const { checkedAt: ignoredTime, startupTimingsMs: ignoredTimings, ...fields } = value;
    void ignoredTime; void ignoredTimings; return fields;
  };
  return same(identity(current), identity(original));
}
/** A public return cannot open the fence while its original preview remains
 * paused: the preview restore itself requires this same closed fence. */
async function readProductionBootstrapPreviewReturnInTransaction({ firestore, transaction, attempt, rendererSha }) {
  const root = "system/productionPublicReleasePause";
  const [saved, returned, current] = await transaction.getAll(
    firestore.doc(`${root}/previewPauses/${attempt.operationId}`), firestore.doc(`${root}/previewRestores/${attempt.operationId}`),
    firestore.doc("system/cmsPreviewRuntime"));
  if (!saved.exists) return !returned.exists;
  const receipt = saved.data();
  p.exact(receipt, ["schemaVersion", "kind", "attemptDigest", "original"]);
  const original = receipt.original;
  const immutable = row => row.exists && row.createTime.isEqual(row.updateTime);
  if (!immutable(saved) || receipt.schemaVersion !== 1 || receipt.kind !== "production-preview-bootstrap-pause" ||
      original?.schemaVersion !== 1 || original.phase !== "ready" || original.rendererSha !== rendererSha || original.serializerId !== "cloudflare-preview" ||
      receipt.attemptDigest !== p.publicReleaseDigest({ operationId: attempt.operationId, rendererSha,
        expectedRuntimeDigest: p.publicReleaseDigest(original), legacyPointerDigest: attempt.legacyPointerDigest })) return false;
  return immutable(returned) && same(returned.data(), { schemaVersion: 1, kind: "production-preview-bootstrap-restored",
    pauseReceiptDigest: p.publicReleaseDigest(receipt) }) && current.exists && sameBootstrapPreviewIdentity(current.data(), original);
}
/** Safe abort before initial log enrollment. Once retained history exists,
 * reopening without logged-path resume would create an unlogged interval. */
async function abandonPublicReleaseBootstrapAdmission({ firestore, attempt: raw }) {
  const attempt = parseAttempt(raw); database(firestore, attempt.environment);
  const ref = firestore.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH), writerRef = firestore.doc(writer.RELEASE_WRITER_FENCE_PATH);
  const receiptRef = firestore.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${attempt.operationId}`);
  const receipt = { ...attempt, kind: "bootstrap-admission-abandoned", attemptDigest: p.publicReleaseDigest(attempt) };
  const receiptDigest = p.publicReleaseDigest(receipt);
  return firestore.runTransaction(async transaction => {
    const [row, saved, pointerRow, writerRow, pinsRow, original, logHead, enrollment, producerControl] = await transaction.getAll(ref, receiptRef,
      firestore.doc("system/publicDeployment"), writerRef, firestore.doc("system/cmsPublicationRuntime"),
      firestore.doc(`${fence.BOOTSTRAP_ADMISSION_ATTEMPTS}/${attempt.operationId}`), firestore.doc("system/publicReleaseChanges"),
      firestore.doc("system/publicReleaseChanges/enrollment/initial"), firestore.doc("system/publicReleaseChangeLog"));
    if (!same(parseAttempt(original.data()), attempt)) refuse();
    const stored = fence.parseBootstrapAdmissionFence(row.data());
    if (stored.operationId !== attempt.operationId || stored.attemptDigest !== receipt.attemptDigest) refuse();
    if (saved.exists) {
      if (!same(saved.data(), receipt) || stored.status !== "open" || stored.resumeReceiptDigest !== receiptDigest) refuse();
      return { idempotent: true, receipt };
    }
    const cloud = require("./cms-publication-runtime-control").cloudCmsPublicationRuntimeControl(pinsRow.data());
    if (logHead.exists || enrollment.exists || producerControl.exists || stored.status !== "closed" || legacyBootstrapPointerDigest(pointerRow.data()) !== attempt.legacyPointerDigest ||
        assertPublicDeploymentPointer(pointerRow.data()).state !== "idle" || cloud.phase !== "ready" ||
        cloud.commitSha !== pointerRow.data().activeCommitSha || !same(writer.parseReleaseWriterFence(writerRow.data()),
          { schemaVersion: 2, operationId: attempt.operationId, attemptDigest: receipt.attemptDigest })) refuse();
    if (attempt.environment === "production") {
      await require("./dev-public-release-pause").assertProductionPublicReleaseDrainInTransaction({ firestore, transaction, attempt });
      if (!await readProductionBootstrapPreviewReturnInTransaction({ firestore, transaction, attempt,
        rendererSha: pointerRow.data().activeCommitSha })) refuse();
    }
    transaction.create(receiptRef, receipt);
    transaction.set(ref, { ...stored, status: "open", resumeReceiptDigest: receiptDigest });
    transaction.delete(writerRef);
    transaction.create(firestore.collection("admin_logs").doc(), adminLogEntry({ actorUid: "system:public-release-bootstrap",
      action: "public-release.bootstrap-admission", target: attempt.operationId, before: { status: "closed" },
      after: { status: "open", outcome: "abandoned", receiptDigest } }));
    return { idempotent: false, receipt };
  });
}
module.exports = { legacyBootstrapPointerDigest, closePublicReleaseBootstrapAdmission, assertClosedBootstrapFenceInTransaction,
  abandonPublicReleaseBootstrapAdmission, readProductionBootstrapPreviewReturnInTransaction, sameBootstrapPreviewIdentity };

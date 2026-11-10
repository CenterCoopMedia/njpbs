"use strict";

const { HomeSelectionAdmissionError, readPageHomeCatalogIdentityInTransaction } = require("./home-source-selection-admission");
const { readNoBuildPageOwner, readNoBuildPageCapability, assertPageOwnerSnapshot, digest, refuse } = require("./no-build-page-ownership");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { ownsPublication } = require("./publication-runtime-owner");
const { isDeepStrictEqual } = require("node:util");
const { homeRouteReceiptMatches } = require("./no-build-home-confirmation");

// Page confirmation owns the paired public receipt. This adapter consumes its
// existing task/marker contract without creating another Home publication.
async function readPageHomeWithdrawal({ firestore, transaction, accepted }) {
  let identity;
  try { identity = await readPageHomeCatalogIdentityInTransaction({ firestore, transaction }); }
  catch (error) {
    // A code lease or unavailable Home identity cannot prove removal yet.
    // Keep staff status pending; database failures still propagate normally.
    if (!(error instanceof HomeSelectionAdmissionError)) throw error;
    return { latest: null, failed: false, proof: null };
  }
  if (!identity) return null;
  const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: "home" });
  const home = (await transaction.get(firestore.doc("cmsPages/home"))).data();
  assertPageOwnerSnapshot(state, home);
  const original = await transaction.get(accepted.queueRef.collection("homePageRefresh").doc("home"));
  const originalTask = original.data();
  if (original.exists && (originalTask.schemaVersion !== 1 || originalTask.owner !== "page-no-build-v1" ||
      originalTask.input?.sourceOperationId !== accepted.state.operationId ||
      originalTask.input.postId !== accepted.state.postId || originalTask.input.sourceVersion !== accepted.state.sourceVersion ||
      originalTask.input.visible !== false)) refuse("Home removal identity changed.");
  const signal = state.homeRefresh;
  let latest = null;
  if (signal && signal.status !== "superseded") {
    if (signal.schemaVersion !== 1 || !Number.isSafeInteger(signal.revision) || signal.revision < 1 ||
        !/^[A-Za-z0-9]{20}$/.test(signal.sourceOperationId ?? "") ||
        signal.taskPath !== `cmsPublishQueue/${signal.sourceOperationId}/homePageRefresh/home`) refuse();
    latest = await transaction.get(firestore.doc(signal.taskPath));
    const task = latest.data();
    if (task?.schemaVersion !== 1 || task.owner !== "page-no-build-v1" || task.revision !== signal.revision ||
        task.input?.sourceOperationId !== signal.sourceOperationId) refuse();
    const grouped = ["serializer", "github"].includes(task.input.sourceTransport);
    if (grouped ? signal.sourceTransport !== task.input.sourceTransport ||
        !isDeepStrictEqual(signal.postChanges, task.input.postChanges) :
      task.input.postId !== signal.postId || task.input.sourceVersion !== signal.sourceVersion) refuse();
    // Verified historical work can survive a new Home operation, but retry
    // and completion must follow that operation's current paired receipt.
    if (task.input.homeOperationId !== state.operationId || task.input.homeSourceVersion !== state.sourceVersion) latest = null;
  }
  const capability = await readNoBuildPageCapability({ firestore, transaction });
  const admission = await readNoBuildFamilyAdmission({ firestore, transaction });
  const paired = receipt => receipt?.operationId === state.operationId && receipt.sourceVersion === state.sourceVersion &&
    receipt.snapshotDigest === state.snapshotDigest && receipt.visible === state.visible &&
    Array.isArray(receipt.routes) && receipt.routes.length === 2 && state.ownedPaths.every(path =>
      receipt.routes.filter(route => homeRouteReceiptMatches(route, path, state)).length === 1);
  const confirms = receipt => capability?.servingEnabled === true && admission.valid &&
    capability.rendererSha === identity.publication.commitSha &&
    paired(receipt) &&
    receipt.rendererSha === identity.publication.commitSha && receipt.contextDigest === identity.page.contextDigest &&
    receipt.admissionRevision === admission.admissionRevision && receipt.homeRefreshRevision === identity.page.homeRefreshRevision;
  // Confirmation checked this task against the accepted invisible Post. Keep
  // that removal proof across unrelated context/refresh work, just as the other
  // families retain their verified original tasks. A new Home source or owner
  // must still prove its own current paired render.
  const originalReceipt = originalTask?.publicReceipt;
  const retained = originalTask?.status === "verified" && !originalTask.claim &&
    typeof originalTask.completedAt?.toMillis === "function" && Number.isFinite(originalTask.completedAt.toMillis()) &&
    ownsPublication(originalTask, state.runtime) && Number.isSafeInteger(originalTask.revision) && originalTask.revision > 0 &&
    originalTask.input.homeOperationId === state.operationId && originalTask.input.homeSourceVersion === state.sourceVersion &&
    originalReceipt?.homeRefreshRevision === originalTask.revision && /^[a-f0-9]{40}$/.test(originalReceipt.rendererSha ?? "") &&
    /^[a-f0-9]{64}$/.test(originalReceipt.contextDigest ?? "") && paired(originalReceipt);
  const homeQueue = (await transaction.get(firestore.doc(`cmsPublishQueue/${state.operationId}`))).data();
  const task = latest?.data();
  const receipt = retained ? originalReceipt : homeQueue?.transport === "page-no-build-v1" && homeQueue.status === "success" && confirms(homeQueue.publicReceipt)
    ? homeQueue.publicReceipt : signal?.status === "verified" && task?.status === "verified" && !task.claim &&
      confirms(task.publicReceipt) ? task.publicReceipt : null;
  return { latest, runtime: state.runtime, failed: task?.status === "failed",
    proof: receipt ? { digest: digest(receipt), withdrawalRevision: accepted.queue.withdrawalRevision ?? 0 } : null };
}

function preparePageHomeWithdrawalRetry({ transaction, home }) {
  const task = home?.latest?.data();
  if (!task || task.status !== "failed" || task.claim || !ownsPublication(task, home.runtime)) return () => {};
  return () => transaction.update(home.latest.ref, { status: "pending", attempts: 0, nextAttemptAt: 0, error: null });
}

module.exports = { readPageHomeWithdrawal, preparePageHomeWithdrawalRetry };

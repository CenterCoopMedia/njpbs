"use strict";

const { can } = require("./rbac");
const { contentResourceSection } = require("./content-authorization");
const { assertPublishedMediaSafe } = require("./published-media-safety");
const { publiclyVisible } = require("./public-video-references");
const { readNoBuildPostOwner, readNoBuildPostCapability, effectiveNoBuildPostState } = require("./no-build-post-ownership");
const { publicationRuntime, ownsPublication } = require("./publication-runtime-owner");
const { readPublicContextInTransaction, readPublicBackgroundContextInTransaction } = require("./public-context-revision");
const { assertCmsPublicationCloudAdmission, readCmsPublicationRuntimeControlInTransaction } = require("./cms-publication-runtime-control");
const { publicationTarget } = require("./publication-target");
const { OUTPUTS, lastGood } = require("./post-background-outputs");
const { readPageHomeWithdrawal, preparePageHomeWithdrawalRetry } = require("./no-build-post-home-withdrawal");

const HOME_OUTPUT_WITHDRAWAL_WARNING = "Home removal is not confirmed. The previous card can remain visible until the Home update succeeds.";

function refuse(message, status = 409) { throw Object.assign(new Error(message), { status }); }

async function assertWithdrawalReady({ firestore, transaction }) {
  const billing = (await transaction.get(firestore.doc("system/billing"))).data();
  if (billing?.disabled === true) refuse("Billing is disabled. Public removal cannot start.");
  await assertPublishedMediaSafe({ firestore, transaction });
}

async function withdrawalOperation({ firestore, transaction, postId, sourceVersion }) {
  // Legacy Firestore IDs outside the native ownership contract still use their
  // original publication status and recovery path.
  if (typeof postId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(postId)) return null;
  const { state } = await readNoBuildPostOwner({ firestore, transaction, postId });
  if (!state?.operationId || state.mode === "static" || state.visible !== false || state.sourceVersion !== sourceVersion) return null;
  const queueRef = firestore.doc(`cmsPublishQueue/${state.operationId}`);
  const queue = (await transaction.get(queueRef)).data();
  const operation = queue?.noBuildPost;
  if (queue?.transport !== "post-no-build-v1" || operation?.operationId !== state.operationId ||
      operation.postId !== postId || operation.visible !== false || operation.sourceVersion !== sourceVersion ||
      JSON.stringify(operation.ownedSlugs) !== JSON.stringify(state.ownedSlugs)) refuse("Public removal ownership is unavailable.");
  const document = (await transaction.get(firestore.doc(`cmsPosts/${postId}`))).data();
  if (!document || publiclyVisible(document) || document.published?.sourceVersion !== sourceVersion ||
      document.published.metadata.slug !== state.slug) refuse("Public removal changed.");
  // Retained safety work keeps its existing warning, queue and retry owner.
  if (queue.homeFullBuild) {
    if (queue.homeFullBuild.sourceOperationId !== state.operationId || !/^[A-Za-z0-9]{20}$/.test(queue.homeFullBuild.queueId ?? "")) {
      refuse("Retained public removal ownership is unavailable.");
    }
    const legacy = (await transaction.get(firestore.doc(`cmsPublishQueue/${queue.homeFullBuild.queueId}`))).data();
    if (!legacy || !["serializer", "github"].includes(legacy.transport) || legacy.homeFullBuild?.sourceOperationId !== state.operationId) {
      refuse("Retained public removal ownership changed.");
    }
    if (legacy.status !== "success") return null;
    // Admission-only fallback has no family tasks to retry or prove. Its
    // addressed safety build is the convergence owner for this removal.
    if (queue.backgroundAdmissionFailed === true) return null;
  }
  return { state, queue, queueRef };
}

async function withdrawalOutputs({ firestore, transaction, accepted }) {
  const rows = await transaction.get(accepted.queueRef.collection("backgroundOutputs"));
  const homeTask = await transaction.get(accepted.queueRef.collection("homePageRefresh").doc("home"));
  const required = OUTPUTS.filter(output => output !== "home" || accepted.queue.homeAffected === true ||
    rows.docs.some(row => row.id === "home") || homeTask.exists);
  const states = await transaction.getAll(...required.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  const context = await readPublicBackgroundContextInTransaction(transaction, firestore);
  if (!Number.isSafeInteger(context.withdrawalRevision) || context.withdrawalRevision < 0) refuse("Public removal context is unavailable.");
  const digest = await readPublicContextInTransaction(transaction, firestore);
  const preparation = await transaction.get(accepted.queueRef.collection("backgroundPreparation").doc(digest));
  const fence = accepted.queue.withdrawalRevision;
  if (fence !== undefined && (!Number.isSafeInteger(fence) || fence < 1 || fence > context.withdrawalRevision)) refuse("Public removal fence is unavailable.");
  const completed = accepted.queue.withdrawalOutputsReceipt;
  const latched = completed?.schemaVersion === 1 && completed.operationId === accepted.state.operationId &&
    completed.sourceVersion === accepted.state.sourceVersion && required.every(output =>
      /^[a-f0-9]{64}$/.test(completed.outputs?.[output]?.digest ?? ""));
  const pageHome = !latched && states.some(row => row.id === "home" && row.data()?.owner === "page-no-build-v1")
    ? await readPageHomeWithdrawal({ firestore, transaction, accepted }) : null;
  const proofs = new Map();
  const pending = states.filter(row => {
    if (latched) return false;
    if (row.id === "home" && pageHome) {
      if (pageHome.proof) proofs.set("home", pageHome.proof);
      return !pageHome.proof;
    }
    const state = row.data();
    const good = state?.schemaVersion === 1 && state.owner === "post-background-v1" && lastGood(state);
    // A later complete family can include this removal. Superseded task rows
    // alone never prove that its immutable replacement has been verified.
    const original = rows.docs.find(task => task.data().output === row.id && task.data().status === "verified" &&
      task.data().postId === accepted.state.postId && task.data().dependencies?.after?.visible === false &&
      task.data().dependencies?.after?.sourceVersion === accepted.state.sourceVersion &&
      task.data().receipt?.revision === task.data().revision && /^[a-f0-9]{64}$/.test(task.data().receipt?.digest ?? ""));
    const proof = original?.data().receipt ?? (good && Number.isSafeInteger(good.receipt.withdrawalRevision ?? 0) &&
      (good.receipt.withdrawalRevision ?? 0) >= (fence ?? context.withdrawalRevision) ? good.receipt : null);
    if (proof) proofs.set(row.id, { digest: proof.digest, withdrawalRevision: proof.withdrawalRevision ?? 0 });
    return !proof;
  });
  const failed = pending.some(row => row.data()?.status === "failed" || row.id === "home" && pageHome?.failed) ||
    preparation.data()?.status === "failed" || rows.docs.some(row => row.id === "_admission" && row.data().status === "failed");
  return { states, pending, preparation, proofs, latched, pageHome, status: failed ? "failed" : "pending" };
}

async function settlePostWithdrawalOutputs({ firestore, operationId }) {
  return firestore.runTransaction(async transaction => {
    const original = (await transaction.get(firestore.doc(`cmsPublishQueue/${operationId}`))).data();
    if (original?.transport !== "post-no-build-v1" || original.noBuildPost?.visible !== false || original.withdrawalOutputsReceipt) return;
    const accepted = await withdrawalOperation({ firestore, transaction, postId: original.noBuildPost.postId,
      sourceVersion: original.noBuildPost.sourceVersion });
    if (!accepted || accepted.state.operationId !== operationId) return;
    const outputs = await withdrawalOutputs({ firestore, transaction, accepted });
    if (outputs.pending.length || outputs.latched) return;
    transaction.update(accepted.queueRef, { withdrawalOutputsReceipt: { schemaVersion: 1, operationId,
      sourceVersion: accepted.state.sourceVersion, outputs: Object.fromEntries(outputs.proofs) } });
  });
}

async function readPostWithdrawalOutputs({ firestore, postId, sourceVersion }) {
  return firestore.runTransaction(async transaction => {
    const accepted = await withdrawalOperation({ firestore, transaction, postId, sourceVersion });
    if (!accepted) return null;
    const outputs = await withdrawalOutputs({ firestore, transaction, accepted });
    // Legacy operations have no stable removal fence. Confirmation recovery
    // must persist their proof before a read can clear pending feedback.
    if (!outputs.pending.length && (accepted.queue.withdrawalRevision !== undefined || outputs.latched)) return null;
    const homePending = accepted.queue.homeAffected === true && !accepted.queue.homeFullBuild &&
      outputs.pending.some(row => row.id === "home");
    return { queueId: accepted.state.operationId, queueStatus: outputs.status, withdrawalBuildPending: true,
      ...(homePending ? { warning: HOME_OUTPUT_WITHDRAWAL_WARNING } : {}) };
  }, { readOnly: true });
}

// The caller has read the accepted detail queue and composes all writes after
// this preparation. Never replace its operation or its frozen input reservation.
async function prepareWithdrawalOutputRetry({ firestore, transaction, postId, sourceVersion, actor, baseVersion }) {
  const accepted = await withdrawalOperation({ firestore, transaction, postId, sourceVersion });
  if (!accepted) return () => {};
  const document = (await transaction.get(firestore.doc(`cmsPosts/${postId}`))).data();
  const resource = { ownerId: document?.createdBy,
    section: contentResourceSection({ collection: "cmsPosts", documentId: postId, stored: document }) };
  if (!can(actor?.principal, "content.unpublish", resource) && !can(actor?.principal, "content.delete", resource)) {
    refuse("Publication access required.", 403);
  }
  if (!Number.isSafeInteger(baseVersion) || !document || document.version !== baseVersion || document.deleted === true ||
      publiclyVisible(document) || document.published?.sourceVersion !== sourceVersion) refuse("Public removal changed. Reload its status.");
  await assertWithdrawalReady({ firestore, transaction });
  const capability = await readNoBuildPostCapability({ firestore, transaction });
  const effective = effectiveNoBuildPostState(accepted.state, capability);
  const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  if (pointer?.state !== "idle" || pointer.activeCommitSha !== effective.rendererSha) refuse("The public renderer changed. Try removal recovery shortly.");
  const originalRuntime = publicationRuntime(accepted.queue.backgroundRuntime ?? accepted.state.runtime ??
    { owner: "node-compute", release: accepted.state.rendererSha });
  const runtime = publicationRuntime({ owner: originalRuntime.owner, release: effective.rendererSha });
  if (runtime.owner === "cloudflare") {
    const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
    assertCmsPublicationCloudAdmission(control, { commitSha: runtime.release,
      serializerId: publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production").serializerId });
  }
  const outputs = await withdrawalOutputs({ firestore, transaction, accepted });
  const addressed = outputs.pending.filter(row => {
    const state = row.data();
    return state?.schemaVersion === 1 && state.owner === "post-background-v1" &&
      typeof state.taskPath === "string" && state.taskPath.startsWith(`${accepted.queueRef.path}/backgroundOutputs/`) &&
      /^[A-Za-z0-9_-]+$/.test(state.taskPath.split("/").at(-1)) && ownsPublication(state, runtime);
  });
  const tasks = addressed.length ? await transaction.getAll(...addressed.map(row => firestore.doc(row.data().taskPath))) : [];
  const retry = tasks.filter((row, index) => {
    const task = row.data();
    const state = addressed[index].data();
    return task?.schemaVersion === 1 && task.owner === "post-background-v1" && task.status === "failed" &&
      task.output === addressed[index].id && task.revision === state.revision && !task.claim && ownsPublication(task, runtime);
  });
  const preparation = outputs.preparation.data();
  const retryPreparation = preparation?.status === "failed" && !preparation.claim &&
    addressed.length > 0 && ownsPublication(preparation, runtime);
  const writeHome = outputs.pending.some(row => row.id === "home")
    ? preparePageHomeWithdrawalRetry({ transaction, home: outputs.pageHome }) : () => {};
  return () => {
    writeHome();
    for (const row of retry) {
      transaction.update(row.ref, { status: "pending", attempts: 0, claim: null, nextAttemptAt: 0, error: null });
      transaction.update(firestore.doc(`cmsBackgroundOutputs/${row.data().output}`), { status: "pending" });
    }
    if (retryPreparation) transaction.update(outputs.preparation.ref,
      { status: "pending", attempts: 0, claim: null, nextAttemptAt: 0, error: null });
  };
}

module.exports = { HOME_OUTPUT_WITHDRAWAL_WARNING, assertWithdrawalReady, readPostWithdrawalOutputs,
  prepareWithdrawalOutputRetry, settlePostWithdrawalOutputs };

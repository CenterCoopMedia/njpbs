"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { createPublicationReservation, reservePublicationRetry } = require("./publication-recovery");
const { enqueueSerializerBuild } = require("./cms-publish-serializer-queue");
const { samePublicationOwner } = require("./publication-runtime-owner");
const { assertSerializerPublicationAdmissionInTransaction } = require("./cms-publication-runtime-control");
const { readSerializerPublicationControlInTransaction } = require("./serializer-publication-control");

const WITHDRAWAL_REPAIR_MESSAGE = "This Post's public removal needs a background repair that the retired full-site build used to do. Ask an administrator.";
const HOME_FALLBACK_WARNING = "Removal is taking the slower path; the story stays on Home until the full build finishes";
const HOME_WITHDRAWAL_WARNING = "Home may briefly show the previous card if the fast path is unavailable, until the full build finishes.";

// Reuse the normal publication fences at each mutation boundary. Resolve the
// publish module at call time because its recovery path also imports this module.
async function assertPostWithdrawalBuildReady({ firestore }, deps = {}) {
  const readiness = await (deps.assertPublishReadyFn ?? require("../publish").assertPublishReady)({ firestore }, deps);
  await (deps.assertPublishedMediaSafeFn ?? require("./published-media-safety").assertPublishedMediaSafe)({ firestore });
  if (readiness.transport !== "serializer" &&
      !(process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" && readiness.transport === "github")) {
    throw Object.assign(new Error("The Post removal requires the configured serializer transport."), { status: 409 });
  }
  return readiness;
}

// The normal build is reserved with the withdrawal, so an API response loss or
// a paused publisher cannot lose the convergence work. The legacy homeFullBuild
// field is retained for accepted Home jobs; this seam now covers every Post.
async function preparePostWithdrawalBuild({ firestore, actor, change, operationId, runtime, transaction, homeAffected = false }) {
  if (!(await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled) {
    // Only reached when the build-free removal could not prepare its background
    // work; the retired full build was the repair. Name that, not a generic wait.
    throw Object.assign(new Error(WITHDRAWAL_REPAIR_MESSAGE), { status: 409, code: "serializer_publication_unavailable" });
  }
  await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction });
  const readiness = await assertPostWithdrawalBuildReady({ firestore });
  const reservation = createPublicationReservation(firestore, { actor, changes: [change],
    source: "no-build-home-withdrawal", transport: readiness.transport });
  if (readiness.transport === "github") {
    const control = await require("./cms-publication-runtime-control").readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
    Object.assign(reservation.queue, await require("./dev-publication-queue").newDevGithubQueueFields({
      firestore, transaction, control, transport: readiness.transport }));
  }
  const receipt = { schemaVersion: 1, queueId: reservation.queueRef.id, sourceOperationId: operationId,
    transport: readiness.transport,
    runtime, status: "reserved", reason: homeAffected ? "placed_home_withdrawal" : "post_withdrawal_safety", reservedAt: FieldValue.serverTimestamp() };
  Object.assign(reservation.queue, { homeFullBuild: receipt });
  return { ...reservation, receipt };
}

async function checkedWithdrawalReceipt(firestore, receipt) {
  if (receipt?.transport === "github" && receipt.status === "queued") {
    const queue = (await firestore.doc(`cmsPublishQueue/${receipt.queueId}`).get()).data();
    if (queue?.status === "failed") {
      throw Object.assign(new Error("Post removal could not start. Retry removal."), {
        status: 502, queueId: receipt.queueId,
      });
    }
  }
  return receipt;
}

async function enqueuePostWithdrawalBuild({ firestore, operationId }, deps = {}) {
  const originalRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const original = (await originalRef.get()).data();
  if (!original?.homeFullBuild || original.homeFullBuild.status !== "reserved") {
    return checkedWithdrawalReceipt(firestore, original?.homeFullBuild ?? null);
  }
  const receipt = { ...original.homeFullBuild, status: "queued" };
  const reservedQueue = (await firestore.doc(`cmsPublishQueue/${receipt.queueId}`).get()).data();
  try {
    const readiness = await assertPostWithdrawalBuildReady({ firestore }, deps);
    const enqueue = reservedQueue?.transport === "github" ? require("../publish").enqueuePublishBuild : enqueueSerializerBuild;
    const result = await enqueue({ firestore, actor: { uid: reservedQueue?.triggeredBy, email: reservedQueue?.triggeredByEmail },
      changes: original.changes, source: "no-build-home-withdrawal", queueId: receipt.queueId, queueReserved: true,
      ...(reservedQueue?.transport === "github" ? { readiness: { ...readiness, transport: "github" } } : {}),
      assertInTransactionFn: async ({ transaction, queue }) => {
        const { state } = await require("./no-build-post-ownership").readNoBuildPostOwner({
          firestore, transaction, postId: original.noBuildPost.postId });
        const document = (await transaction.get(firestore.doc(`cmsPosts/${original.noBuildPost.postId}`))).data();
        if (!state || !samePublicationOwner(state, receipt.runtime) || state.operationId !== operationId || state.visible !== false ||
            document?.publiclyVisible !== false || document?.published?.sourceVersion !== original.noBuildPost.sourceVersion) {
          throw Object.assign(new Error("The Post withdrawal has been superseded."), { code: "home_withdrawal_superseded" });
        }
        queue.homeFullBuild = receipt;
        return () => transaction.update(originalRef, { homeFullBuild: receipt, homeFullBuildError: FieldValue.delete() });
      } }, { ...deps, firestore });
    if (result.idempotent || result.existingBuild) {
      await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(originalRef)).data();
        const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${receipt.queueId}`))).data();
        if (current?.homeFullBuild?.queueId === receipt.queueId && current.homeFullBuild.status === "reserved" &&
            queue?.status !== "reserved" && queue?.homeFullBuild?.sourceOperationId === operationId) {
          transaction.update(originalRef, { homeFullBuild: { ...receipt,
            status: ["cancelled", "superseded"].includes(queue.status) ? queue.status : "queued" } });
        }
      });
    }
    return await checkedWithdrawalReceipt(firestore, receipt);
  } catch (error) {
    if (error.code === "home_withdrawal_superseded") {
      await firestore.runTransaction(async transaction => {
        const ref = firestore.doc(`cmsPublishQueue/${receipt.queueId}`);
        const reserved = (await transaction.get(ref)).data();
        if (reserved?.status !== "reserved" || reserved.homeFullBuild?.sourceOperationId !== operationId) return;
        transaction.update(ref, { status: "superseded", completedAt: FieldValue.serverTimestamp() });
        transaction.update(originalRef, { homeFullBuild: { ...receipt, status: "superseded" } });
      });
      return null;
    }
    const retained = (await originalRef.get()).data()?.homeFullBuild;
    if (retained?.status === "queued") return checkedWithdrawalReceipt(firestore, retained);
    await originalRef.update({ homeFullBuildError: "home_withdrawal_full_build_enqueue_failed" });
    throw error;
  }
}

// Use the existing exact-version, capability-authorized reservation. The Home
// receipt follows its replacement queue atomically, including after failure
// settlement cleared the Post's ordinary pending pointer.
async function retryPostWithdrawalBuild({ firestore, operationId, actor, changes, baseVersion }, deps = {}) {
  const readiness = await assertPostWithdrawalBuildReady({ firestore }, deps);
  await reservePublicationRetry({ firestore, actor, changes, baseVersion,
    source: "no-build-home-withdrawal-retry", transport: readiness.transport,
    assertInTransactionFn: async ({ transaction, stored, reservation }) => {
      const originalRef = firestore.doc(`cmsPublishQueue/${operationId}`);
      const original = (await transaction.get(originalRef)).data();
      const { state } = await require("./no-build-post-ownership").readNoBuildPostOwner({
        firestore, transaction, postId: changes[0].id });
      const receipt = original?.homeFullBuild;
      if (receipt?.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(receipt.queueId) || receipt.sourceOperationId !== operationId ||
          original.transport !== "post-no-build-v1" || state?.operationId !== operationId || state.visible !== false ||
          state.postId !== changes[0].id || state.sourceVersion !== changes[0].sourceVersion ||
          !samePublicationOwner(state, receipt.runtime) || stored.publiclyVisible !== false ||
          (stored.publishBuildQueueId && stored.publishBuildQueueId !== receipt.queueId)) {
        throw Object.assign(new Error("The Post removal changed. Reload its status before retrying."), { status: 409 });
      }
      const previous = (await transaction.get(firestore.doc(`cmsPublishQueue/${receipt.queueId}`))).data();
      if (!["serializer", "github"].includes(previous?.transport) || previous.homeFullBuild?.sourceOperationId !== operationId ||
          !["reserved", "pending", "publishing", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(previous.status) || previous.changes?.length !== 1 ||
          previous.changes[0].id !== state.postId || previous.changes[0].sourceVersion !== state.sourceVersion ||
          previous.changes[0].collection !== "cmsPosts" || previous.changes[0].operation !== "withdraw") {
        throw Object.assign(new Error("The Post removal no longer needs this retry. Reload its status."), { status: 409 });
      }
      const detailRetry = original.status === "failed" ? { status: "pending", attempts: 0, claim: null, nextAttemptAt: 0, error: null } : {};
      if (["reserved", "pending", "publishing"].includes(previous.status)) {
        if (stored.publishBuildQueueId !== receipt.queueId) throw Object.assign(new Error("The active Post removal needs recovery."), { status: 409 });
        return original.status === "failed" ? () => transaction.update(originalRef, detailRetry) : null;
      }
      const nextReceipt = { ...receipt, transport: readiness.transport, queueId: reservation.queueRef.id, status: "reserved", reservedAt: FieldValue.serverTimestamp() };
      reservation.queue.homeFullBuild = nextReceipt;
      if (original.homeFallback) reservation.queue.homeFallback = original.homeFallback;
      return () => transaction.update(originalRef, { ...detailRetry, homeFullBuild: nextReceipt, homeFullBuildError: FieldValue.delete() });
    } });
  const receipt = await enqueuePostWithdrawalBuild({ firestore, operationId }, deps);
  if (!receipt?.queueId || ["cancelled", "superseded"].includes(receipt.status)) {
    throw Object.assign(new Error("The Post removal changed. Reload its status."), { status: 409 });
  }
  return { success: true, queueId: receipt?.queueId, dispatched: false, status: "pending", transport: receipt.transport ?? "serializer",
    existingBuild: true, message: "Post removal is queued." };
}

async function readPostWithdrawalPublication({ firestore, postId, sourceVersion }) {
  const { state } = await require("./no-build-post-ownership").readNoBuildPostOwner({ firestore, postId });
  if (state?.mode === "static" || state?.visible !== false || state?.postId !== postId || state?.sourceVersion !== sourceVersion ||
      !/^[A-Za-z0-9]{20}$/.test(state?.operationId ?? "")) return null;
  const original = (await firestore.collection("cmsPublishQueue").doc(state.operationId).get()).data();
  const receipt = original?.homeFullBuild;
  if (receipt?.sourceOperationId !== state.operationId || !/^[A-Za-z0-9]{20}$/.test(receipt?.queueId ?? "")) return null;
  const queue = (await firestore.collection("cmsPublishQueue").doc(receipt.queueId).get()).data();
  if (!["serializer", "github"].includes(queue?.transport) || queue.homeFullBuild?.sourceOperationId !== state.operationId ||
      !["reserved", "pending", "publishing", "failed", "cancelled", "superseded", "public_unconfirmed"].includes(queue.status)) return null;
  return { queueId: receipt.queueId, queueStatus: queue.status,
    warning: receipt.reason === "post_withdrawal_safety" ? null :
      queue.homeFallback ? HOME_FALLBACK_WARNING : HOME_WITHDRAWAL_WARNING };
}

async function warnFirstHomeFailure({ firestore, operationId, preparationFailed = false }) {
  const originalRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  await firestore.runTransaction(async transaction => {
    const original = (await transaction.get(originalRef)).data();
    if (!original?.homeFullBuild || original.homeAffected !== true || original.noBuildPost?.visible !== false) return;
    const home = (await transaction.get(firestore.doc("cmsBackgroundOutputs/home"))).data();
    if (require("./post-background-outputs").lastGood(home) || (!preparationFailed && home?.status !== "failed")) return;
    const queueRef = firestore.doc(`cmsPublishQueue/${original.homeFullBuild.queueId}`);
    const queue = (await transaction.get(queueRef)).data();
    if (!queue || !["reserved", "pending", "publishing", "failed"].includes(queue.status)) return;
    const receipt = { schemaVersion: 1, warning: HOME_FALLBACK_WARNING, reason: "first_home_generation_failed" };
    transaction.update(originalRef, { homeFallback: receipt });
    transaction.update(queueRef, { homeFallback: receipt });
  });
}

module.exports = { preparePostWithdrawalBuild, enqueuePostWithdrawalBuild, retryPostWithdrawalBuild, readPostWithdrawalPublication, warnFirstHomeFailure,
  HOME_FALLBACK_WARNING, HOME_WITHDRAWAL_WARNING, WITHDRAWAL_REPAIR_MESSAGE };

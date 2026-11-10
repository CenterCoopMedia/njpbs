"use strict";

const { readHomePageAuthorityInTransaction } = require("./no-build-home-ownership");
const { readNoBuildPageOwner, refuse } = require("./no-build-page-ownership");
const { readPageAuthorityInTransaction } = require("./no-build-page-serving");
const { readNoBuildPostOwner } = require("./no-build-post-ownership");
const { publiclyVisible } = require("./public-video-references");
const { publicationRetry } = require("./background-output-attempt");

function homeRouteReceiptMatches(route, path, state) {
  if (route.path !== path) return false;
  if (!state.visible) return route.status === 410 && route.htmlDigest === null;
  return path === "/" && state.contentRedirectUrl
    ? route.status === 302 && route.location === state.contentRedirectUrl && route.htmlDigest === null
    : route.status === 200 && /^[a-f0-9]{64}$/.test(route.htmlDigest ?? "");
}

function receiptConfirmsHome(receipt, state, authority) {
  return receipt?.operationId === state.operationId && receipt.sourceVersion === state.sourceVersion &&
    receipt.snapshotDigest === state.snapshotDigest && receipt.visible === state.visible &&
    receipt.rendererSha === authority.effective.rendererSha && receipt.contextDigest === authority.contextDigest &&
    receipt.admissionRevision === authority.admission.admissionRevision &&
    receipt.homeRefreshRevision === (state.homeRefresh?.revision ?? 0) &&
    Array.isArray(receipt.routes) && receipt.routes.length === 2 &&
    state.ownedPaths.every(path => receipt.routes.filter(route => homeRouteReceiptMatches(route, path, state)).length === 1);
}

function homeRefreshPostChanges(input) {
  const grouped = ["serializer", "github"].includes(input?.sourceTransport);
  if (input?.sourceTransport !== undefined && !["serializer", "github", "post-no-build-v1"].includes(input.sourceTransport)) refuse();
  const changes = grouped ? input.postChanges : [{ postId: input?.postId, sourceVersion: input?.sourceVersion, visible: input?.visible }];
  if (!Array.isArray(changes) || !changes.length || changes.length > 500 || grouped && (input.postId !== undefined || input.sourceVersion !== undefined) ||
      changes.some((change, index) => !/^[A-Za-z0-9_-]{1,128}$/.test(change?.postId ?? "") ||
        !Number.isSafeInteger(change.sourceVersion) || change.sourceVersion < 1 || typeof change.visible !== "boolean" ||
        index > 0 && changes[index - 1].postId >= change.postId)) refuse();
  return changes;
}

async function assertHomeRefreshSourceInTransaction({ firestore, transaction, input }) {
  const changes = homeRefreshPostChanges(input);
  const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${input.sourceOperationId}`))).data();
  if (["serializer", "github"].includes(input.sourceTransport) && (queue?.status !== "success" || queue.transport !== input.sourceTransport ||
      input.sourceTransport === "github" && queue.runtime?.owner !== "cloudflare" ||
      !Array.isArray(queue.changes) || queue.changes.length > 500)) refuse();
  const rows = await transaction.getAll(...changes.map(change => firestore.doc(`cmsPosts/${change.postId}`)));
  for (const [index, change] of changes.entries()) {
    const document = rows[index].data();
    if (document?.published?.sourceVersion !== change.sourceVersion || publiclyVisible(document) !== change.visible) refuse();
    if (["serializer", "github"].includes(input.sourceTransport)) {
      const queued = queue?.changes?.find(row => row.collection === "cmsPosts" && row.id === change.postId && row.sourceVersion === change.sourceVersion);
      if (!queued ||
          document.publishBuildSettlement?.status !== "success" || document.publishBuildSettlement.sourceVersion !== change.sourceVersion ||
          document.publishBuildSettlement.operation !== (queued.operation ?? "publish") ||
          document.publicSourceVersion !== (queued.operation === "withdraw" ? null : change.sourceVersion)) refuse();
    } else if (queue?.transport !== "post-no-build-v1" || queue.noBuildPost?.operationId !== input.sourceOperationId ||
        queue.noBuildPost.postId !== change.postId || queue.noBuildPost.sourceVersion !== change.sourceVersion || queue.noBuildPost.visible !== change.visible) refuse();
  }
  return changes;
}

async function addressedHomeRefresh({ firestore, transaction, postId, sourceOperationId, sourceVersion }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(postId ?? "") || !/^[A-Za-z0-9]{20}$/.test(sourceOperationId ?? "") ||
      !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) refuse();
  const markerOwner = await readHomePageAuthorityInTransaction({ firestore, transaction });
  if (!markerOwner) return null;
  const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: "home" });
  if (!state || state.operationId !== markerOwner.operationId) refuse();
  const post = (await readNoBuildPostOwner({ firestore, transaction, postId })).state;
  if (!post || post.operationId !== sourceOperationId || post.sourceVersion !== sourceVersion) refuse();
  const postDocument = (await transaction.get(firestore.doc(`cmsPosts/${postId}`))).data();
  const sourceQueue = (await transaction.get(firestore.doc(`cmsPublishQueue/${sourceOperationId}`))).data();
  if (postDocument?.published?.sourceVersion !== sourceVersion || publiclyVisible(postDocument) !== post.visible ||
      sourceQueue?.transport !== "post-no-build-v1" || sourceQueue.noBuildPost?.operationId !== sourceOperationId ||
      sourceQueue.noBuildPost.postId !== postId || sourceQueue.noBuildPost.sourceVersion !== sourceVersion ||
      sourceQueue.noBuildPost.visible !== post.visible) refuse();
  const signal = state.homeRefresh;
  const taskRef = firestore.doc(`cmsPublishQueue/${sourceOperationId}/homePageRefresh/home`);
  const task = (await transaction.get(taskRef)).data();
  const exact = signal?.schemaVersion === 1 && signal.sourceOperationId === sourceOperationId && signal.postId === postId &&
    signal.sourceVersion === sourceVersion && signal.taskPath === taskRef.path &&
    task?.schemaVersion === 1 && task.owner === "page-no-build-v1" && task.revision === signal.revision &&
    task.input?.homeOperationId === state.operationId && task.input.homeSourceVersion === state.sourceVersion &&
    task.input.sourceOperationId === sourceOperationId && task.input.postId === postId &&
    task.input.sourceVersion === sourceVersion && task.input.visible === post.visible;
  return { state, post, signal, task, taskRef, exact };
}

async function currentHomeRefreshTask({ firestore, transaction, state }) {
  const signal = state.homeRefresh;
  if (!signal || signal.status === "superseded") return null;
  if (signal.schemaVersion !== 1 || !Number.isSafeInteger(signal.revision) || signal.revision < 1 ||
      !/^[A-Za-z0-9]{20}$/.test(signal.sourceOperationId ?? "") ||
      signal.taskPath !== `cmsPublishQueue/${signal.sourceOperationId}/homePageRefresh/home`) refuse();
  const ref = firestore.doc(signal.taskPath);
  const task = (await transaction.get(ref)).data();
  if (task?.schemaVersion !== 1 || task.owner !== "page-no-build-v1" || task.revision !== signal.revision ||
      task.input?.sourceOperationId !== signal.sourceOperationId) refuse();
  const grouped = ["serializer", "github"].includes(task.input.sourceTransport);
  if (grouped ? signal.sourceTransport !== task.input.sourceTransport || !require("node:util").isDeepStrictEqual(signal.postChanges, task.input.postChanges) || signal.postId !== undefined || signal.sourceVersion !== undefined :
    !/^[A-Za-z0-9_-]{1,128}$/.test(signal.postId ?? "") || task.input.postId !== signal.postId || task.input.sourceVersion !== signal.sourceVersion) refuse();
  homeRefreshPostChanges(task.input);
  // A verified signal can survive a later Home publication. Its old task is
  // historical proof and must never be retried as work for the new Page owner.
  if (signal.status === "verified" && task?.status === "verified" && !task.claim &&
      task.input?.homeOperationId !== state.operationId &&
      Number.isSafeInteger(task.input?.homeSourceVersion) && task.input.homeSourceVersion <= state.sourceVersion) return null;
  if (task.input.homeOperationId !== state.operationId || task.input.homeSourceVersion !== state.sourceVersion) refuse();
  await assertHomeRefreshSourceInTransaction({ firestore, transaction, input: task.input });
  return { ref, task, signal };
}

async function readConfirmedHomePostRefresh(options) {
  const { firestore, transaction } = options;
  if (!transaction) return firestore.runTransaction(transaction => readConfirmedHomePostRefresh({ ...options, transaction }), { readOnly: true });
  const addressed = await addressedHomeRefresh(options);
  if (!addressed) return null;
  const { state, signal } = addressed;
  const capability = await require("./no-build-page-ownership").readNoBuildPageCapability(options);
  if (!capability) refuse();
  const authority = await readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha: capability.rendererSha });
  const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${state.operationId}`))).data();
  const replacement = queue?.transport === "page-no-build-v1" && queue.status === "success" &&
    receiptConfirmsHome(queue.publicReceipt, state, authority);
  if (replacement) return { confirmed: true, ...(signal ? { revision: signal.revision } : {}) };
  const latest = await currentHomeRefreshTask({ ...options, state });
  // The latest paired Home render includes the complete current Post set. It
  // can prove an earlier removal after another Post advanced the dirty signal.
  const confirmed = latest && latest.signal.status === "verified" && latest.task.status === "verified" && !latest.task.claim &&
    receiptConfirmsHome(latest.task.publicReceipt, state, authority);
  if (confirmed) return { confirmed: true, revision: signal.revision };
  // Historical task success alone cannot prove the current Home owner.
  return { confirmed: false, ...(signal ? { revision: signal.revision } : {}),
    ...(latest ? { status: latest.task.status } : {}) };
}

async function prepareNoBuildHomePostRefreshRetry(options) {
  const addressed = await addressedHomeRefresh(options);
  if (!addressed) return () => {};
  const latest = await currentHomeRefreshTask({ ...options, state: addressed.state });
  if (!latest || !publicationRetry(latest.task, "home")) return () => {};
  return () => options.transaction.update(latest.ref, { status: "pending", attempts: 0, nextAttemptAt: 0, error: null });
}

async function retryNoBuildHomePostRefresh(options) {
  return options.firestore.runTransaction(async transaction => {
    const write = await prepareNoBuildHomePostRefreshRetry({ ...options, transaction });
    write();
  });
}

module.exports = { readConfirmedHomePostRefresh, prepareNoBuildHomePostRefreshRetry, retryNoBuildHomePostRefresh,
  homeRefreshPostChanges, assertHomeRefreshInput: homeRefreshPostChanges, assertHomeRefreshSourceInTransaction, homeRouteReceiptMatches };

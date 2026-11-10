"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { recordIndexPaths } = require("./no-build-record-contract");
const { recordRouteRef } = require("./no-build-record-ownership");
const { readRecordPublication, recordPublicationReceipt } = require("./no-build-record-publication");
const { resumeDeferredRecordPublication, resumeStaleRecordPublication } = require("./no-build-record-retry");
const { readRecordManifest } = require("./post-background-record-manifest");
const { createPostBackgroundStorage } = require("./post-background-storage");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { pagePublicationTarget } = require("./no-build-page-target");
const { assertReadbackTarget, publicReadbackHeaders, withinDeadline, readPublicPostAfterRefresh } = require("./no-build-post-recovery");
const { readSettingsProofs } = require("./no-build-post-settings-confirmation");
function refuse() { throw Object.assign(new Error("The public record receipt is unavailable."), { status: 409 }); }

async function familyAuthority({ firestore, transaction, accepted }) {
  const { queue, state } = accepted, identity = queue.recordPublication;
  const [output, pointer, context, ...claims] = await transaction.getAll(firestore.doc(`cmsBackgroundOutputs/${identity.family}`),
    firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH), ...state.ownedPaths.map(path => recordRouteRef(firestore, path)));
  const value = output.data(), receipt = value?.receipt, aggregate = queue.aggregateReceipt;
  if (queue.status !== "success" || pointer.data()?.state !== "idle" || pointer.data()?.activeCommitSha !== identity.rendererSha ||
      publicContextDigest(context.data()?.revision) !== identity.contextDigest || value?.owner !== "post-background-v1" || value.contextOnly !== true ||
      value.status !== "verified" || receipt?.rendererSha !== identity.rendererSha || receipt.contextDigest !== identity.contextDigest ||
      value.revision !== receipt.revision || !receipt.fileManifest || aggregate?.outputs?.[identity.family]?.digest !== receipt.digest ||
      aggregate.outputs[identity.family].revision !== receipt.revision ||
      claims.some((claim, index) => claim.data()?.schemaVersion !== 1 || claim.data()?.family !== identity.family ||
        claim.data()?.documentId !== identity.documentId || claim.data()?.path !== state.ownedPaths[index])) refuse();
  return receipt;
}
async function readRecordHtml(response, expected, signal) {
  const reader = response.body?.getReader(), hash = createHash("sha256");
  if (!reader) refuse();
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expected.size) refuse();
      hash.update(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (size !== expected.size || hash.digest("hex") !== expected.digest) refuse();
  return expected.digest;
}
function legacyProgramRedirect(response, path, identity, origin) {
  if (identity.family !== "programs" || !path.startsWith("/shows/") || response.status !== 301 ||
      [...response.headers.keys()].some(name => name.startsWith("x-njpbs-"))) return null;
  const destination = path.replace(/^\/shows\//, "/programs/");
  try {
    if (new URL(response.headers.get("location"), `${origin}${path}`).href !== new URL(destination, origin).href) return null;
  } catch { return null; }
  return destination;
}
async function readRoute({ path, file, identity, target, headers, fetchPublic, signal }) {
  const detail = identity.ownedPaths.includes(path), visible = !detail || identity.visible;
  const response = await readPublicPostAfterRefresh(`${target.origin}${path}`, fetchPublic, signal, headers);
  try {
    // The production legacy edge answers /shows/ before the record reader.
    // Its matching /programs/ route is still proved in the same route set.
    const destination = legacyProgramRedirect(response, path, identity, target.origin);
    if (destination) return { path, status: 301, location: destination, legacyRedirect: true };
    if (response.status !== (visible ? 200 : 410) || response.headers.get("cache-control") !== "no-store") refuse();
    const fields = detail ? { "x-njpbs-record-id": identity.documentId, "x-njpbs-record-family": identity.family,
      "x-njpbs-publication-operation": identity.originalOperationId, "x-njpbs-source-version": String(identity.sourceVersion) } : {};
    if (Object.entries(fields).some(([name, value]) => response.headers.get(name) !== value)) refuse();
    if (!visible) {
      if (response.headers.get("x-njpbs-durable-withdrawal-operation") !== identity.originalOperationId ||
          response.headers.get("x-njpbs-withdrawal-revision") !== String(identity.generation)) refuse();
      return { path, status: 410 };
    }
    if (!file || !response.headers.get("content-type")?.startsWith("text/html") ||
        response.headers.get("x-njpbs-background-renderer-sha") !== identity.rendererSha ||
        response.headers.get("x-njpbs-background-context-sha256") !== identity.contextDigest ||
        response.headers.get("x-njpbs-public-context-revision") !== String(identity.contextRevision) ||
        response.headers.get("x-njpbs-background-state") !== "current" ||
        detail && (response.headers.get("x-njpbs-record-generation") !== String(identity.generation) ||
          response.headers.get("x-njpbs-snapshot-sha256") !== identity.snapshotDigest || response.headers.get("x-njpbs-record-visible") !== "true")) refuse();
    return { path, status: 200, digest: await readRecordHtml(response, file, signal) };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** Reuse the context owner and existing bounded public readback pool. A queue's
 * aggregate status cannot confirm staff publication without its public routes. */
async function recoverNoBuildRecordPublication({ firestore, operationId, target, headers = {}, fetchPublic = fetch, artifacts,
  currentCodeRequest, now = Date.now, deadline = now() + 45_000 }) {
  target = pagePublicationTarget({ firestore, target: assertReadbackTarget(firestore, target) });
  headers = publicReadbackHeaders(target, headers);
  if (!operationId) {
    const [pending, deferred, active] = await Promise.all([
      firestore.collection("cmsPublishQueue").orderBy("recordConfirmationPendingAt").limit(10).get(),
      ...["deferred", "active"].map(state => firestore.collection("cmsPublishQueue").where("recordRegeneration", "==", state).limit(10).get())]);
    // Deferred scans retain recovery for queues accepted before the pending index.
    const ids = [...new Set([...pending.docs, ...deferred.docs, ...active.docs].map(row => row.id))];
    let confirmed = false;
    const errors = [];
    for (const id of ids) {
      if (now() >= deadline) break;
      try {
        const result = await recoverNoBuildRecordPublication({ firestore, operationId: id, target, headers, fetchPublic, artifacts,
          currentCodeRequest, now, deadline });
        confirmed ||= result.confirmed;
      } catch (error) { errors.push(error); }
      // Rotate unfinished entries so a stalled or damaged operation cannot
      // hold the bounded first page forever. Never recreate a cleared marker.
      try {
        await firestore.runTransaction(async transaction => {
          const ref = firestore.doc(`cmsPublishQueue/${id}`), row = await transaction.get(ref);
          if (row.data()?.recordConfirmationPendingAt) transaction.update(ref,
            { recordConfirmationPendingAt: FieldValue.serverTimestamp() });
        });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Record publication recovery is unavailable");
    return { confirmed };
  }
  if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "") || now() >= deadline) return { confirmed: false };
  const requested = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  if (!requested?.recordPublication) return { confirmed: false };
  // Retire replaced removal entries before the accepted-owner lookup returns.
  if (["deferred", "active"].includes(requested.recordRegeneration)) {
    const work = await resumeDeferredRecordPublication({ firestore, operationId });
    if (work.paused || work.resumed) return { confirmed: false, ...work };
  }
  const readAccepted = () => readRecordPublication({ firestore, operationId: requested.recordPublication.originalOperationId }).catch(error => {
    if (error.code === "record_publication_replaced") return null;
    throw error;
  });
  // Discovery stays on the accepted operation. Its durable record owner
  // selects the current record retry, independently of the shared pointer.
  let accepted = await readAccepted();
  if (!accepted) return { confirmed: false };
  if (accepted.publication.status !== "success") {
    const work = await resumeStaleRecordPublication({ firestore, operationId: requested.recordPublication.originalOperationId });
    if (work.resumed) return { confirmed: false, ...work };
    if (work.waiting) return { confirmed: false };
  }
  operationId = accepted.ref.id;
  const queue = accepted.queue;
  if (queue.recordRegeneration && queue.recordPublication.operationId !== requested.recordPublication.operationId) {
    const work = await resumeDeferredRecordPublication({ firestore, operationId });
    if (work.paused || work.resumed) return { confirmed: false, ...work };
  }
  if (queue.status !== "success") return { confirmed: false };
  if (accepted.publication.missingConsumers.some(name => ["pages", "home", "posts"].includes(name))) {
    await require("./no-build-page-settings-confirmation").confirmNoBuildPageSettings({ firestore, operationId,
      target, headers, fetchPublic, currentCodeRequest, now, deadline });
    accepted = await readAccepted();
    if (!accepted || accepted.ref.id !== operationId) return { confirmed: false };
  }
  const identity = accepted.queue.recordPublication;
  if (accepted.publication.status === "success") return firestore.runTransaction(async transaction => {
    const current = await readRecordPublication({ firestore, transaction, operationId: identity.originalOperationId });
    if (!current || current.ref.id !== operationId || current.publication.status !== "success") return { confirmed: false };
    transaction.update(firestore.doc(`cmsPublishQueue/${identity.originalOperationId}`),
      { recordConfirmationPendingAt: FieldValue.delete() });
    return { confirmed: true };
  });
  if (accepted.publication.missingConsumers.some(name => name !== "record")) return { confirmed: false };
  return withinDeadline(deadline - now(), async signal => {
    const receipt = await firestore.runTransaction(transaction => familyAuthority({ firestore, transaction, accepted }), { readOnly: true });
    artifacts ??= createPostBackgroundStorage(target.backgroundBucket);
    const files = await readRecordManifest({ receipt, output: identity.family, artifacts, signal, scope: firestore.projectId });
    const paths = [...identity.ownedPaths, ...recordIndexPaths(identity.family)];
    if (identity.ownedPaths.some(path => files.some(file => file.path === path) !== identity.visible)) refuse();
    const routes = await readSettingsProofs(paths, (path, routeSignal) => readRoute({ path, file: files.find(file => file.path === path),
      identity, target, headers, fetchPublic, signal: routeSignal }), { deadline, now });
    if (routes.some(route => route.legacyRedirect && !routes.some(candidate => candidate.path === route.location &&
        candidate.status === (identity.visible || route.path === "/shows/" ? 200 : 410) && !candidate.legacyRedirect))) refuse();
    if (now() >= deadline) return { confirmed: false };
    return firestore.runTransaction(async transaction => {
      const current = await readRecordPublication({ firestore, transaction, operationId: identity.originalOperationId });
      if (!current || current.ref.id !== operationId || !isDeepStrictEqual(current.queue.recordPublication, identity)) refuse();
      const fresh = await familyAuthority({ firestore, transaction, accepted: current });
      if (!isDeepStrictEqual(fresh, receipt) || recordPublicationReceipt(current.queue, now()).missingConsumers.some(name => name !== "record")) refuse();
      const consumer = { rendererSha: identity.rendererSha, contextRevision: identity.contextRevision, contextDigest: identity.contextDigest, verifiedAt: now() };
      transaction.update(current.ref, { "consumerReceipts.record": consumer, recordReceipt: { operationId: identity.originalOperationId,
        sourceVersion: identity.sourceVersion, visible: identity.visible, snapshotDigest: identity.snapshotDigest, routes, ...consumer },
        ...(current.queue.recordRegeneration ? { recordRegeneration: "complete" } : {}) });
      transaction.update(firestore.doc(`cmsPublishQueue/${identity.originalOperationId}`),
        { recordConfirmationPendingAt: FieldValue.delete() });
      transaction.update(firestore.doc(`cmsPosts/${identity.documentId}`), { publishBuildPending: false, publishBuildQueueId: null,
        publicSourceVersion: identity.visible ? identity.sourceVersion : null,
        publishBuildSettlement: { status: "success", sourceVersion: identity.sourceVersion, operation: identity.visible ? "publish" : "withdraw",
          recordQueueId: operationId } });
      return { confirmed: true };
    });
  });
}
module.exports = { recoverNoBuildRecordPublication };

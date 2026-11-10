"use strict";

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { readNoBuildRecordOwner } = require("./no-build-record-ownership");
const { readRecordPublication, readRecordPublicationPrerequisites } = require("./no-build-record-publication");
const { enqueuePublicContextInTransaction, retryPublicContextInTransaction, verifiedPreparation, CURRENT_PATH, TRANSPORT } = require("./public-context-publication");
const { publicContextDigest, bumpPublicContextRevision } = require("./public-context-revision");
const { contextOutputs } = require("./no-build-record-namespace");
const { ownsPublication } = require("./publication-runtime-owner");
const successorId = identity => createHash("sha256").update(JSON.stringify([identity.originalOperationId, identity.contextRevision, identity.rendererSha])).digest("hex").slice(0, 20);
function refuse(message) { throw Object.assign(new Error(message), { status: 409 }); }

/** A retry keeps the accepted record/snapshot. Context and code can advance
 * without approving a later private draft or rewriting a completed receipt. */
async function prepareRecordPublicationRetry({ firestore, transaction, accepted, resume = false }) {
  const tracked = ["deferred", "active"].includes(accepted.queue.recordRegeneration);
  if (accepted.publication.status === "success") return { queueId: accepted.ref.id, write() {
    if (tracked) transaction.update(accepted.ref, { recordRegeneration: "complete" });
  } };
  if (!tracked && !accepted.publication.warning && !resume) return { queueId: accepted.ref.id, write() {} };
  const original = accepted.queue.recordPublication;
  const { revision, runtime, regenerationPaused } = await readRecordPublicationPrerequisites({ firestore, transaction, family: original.family,
    withdrawal: original.visible === false });
  if (regenerationPaused) return { queueId: accepted.ref.id, paused: true, write() {} };
  const deferred = accepted.queue.recordRegeneration === "deferred";
  const contextRevision = deferred ? revision + 1 : revision;
  if (!Number.isSafeInteger(contextRevision)) refuse("The public context revision cannot advance.");
  if (deferred || revision !== original.contextRevision || runtime.release !== original.rendererSha) {
    const identity = { ...original, contextRevision, contextDigest: publicContextDigest(contextRevision), rendererSha: runtime.release };
    identity.operationId = successorId(identity);
    const context = await enqueuePublicContextInTransaction({ firestore, transaction, operationId: identity.operationId,
      runtime, recordFamily: identity.family, reason: "context", contextRevision });
    return { queueId: identity.operationId, resumed: true,
      missingConsumers: ["pages", "home", "posts", "record", ...context.outputs], write() {
      context.write();
      transaction.set(firestore.doc(`cmsPublishQueue/${identity.operationId}`), { recordPublication: identity,
        recordRetryAt: FieldValue.serverTimestamp(), ...(tracked ? { recordRegeneration: "active" } : {}) }, { merge: true });
      if (tracked) transaction.update(accepted.ref, { recordRegeneration: "superseded",
        ...(accepted.queue.status === "success" ? {} : { status: "cancelled",
          error: "record_regeneration_superseded", completedAt: FieldValue.serverTimestamp() }) });
      transaction.update(firestore.doc(`cmsPublishQueue/${identity.originalOperationId}`), { successorOperationId: identity.operationId });
      if (deferred) bumpPublicContextRevision(transaction, firestore, { withdrawal: true });
    } };
  }
  // Recovery never resets an exhausted attempt budget at the same context.
  if (resume || !accepted.publication.warning) return { queueId: accepted.ref.id, write() {} };
  const write = await retryPublicContextInTransaction({ firestore, transaction, operationId: accepted.ref.id, runtime }).catch(error => {
    if (error.message === "Public context publication refused") refuse("Another publication is updating these outputs. Retry shortly.");
    throw error;
  });
  return { queueId: accepted.ref.id, write() {
    write(); transaction.update(accepted.ref, { recordRetryAt: FieldValue.serverTimestamp() });
  } };
}

/** Entry point for the confirmation stack layer; performs no public I/O. */
async function resumeDeferredRecordPublication({ firestore, operationId }) {
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(`cmsPublishQueue/${operationId}`), row = await transaction.get(ref), queue = row.data();
    if (!["deferred", "active"].includes(queue?.recordRegeneration)) return { paused: queue?.recordRegeneration === "superseded" };
    const accepted = await readRecordPublication({ firestore, transaction,
      operationId: queue.recordPublication.originalOperationId }).catch(error => {
      if (error.code === "record_publication_replaced") return null;
      throw error;
    });
    if (!accepted || accepted.ref.id !== operationId) {
      transaction.update(ref, { recordRegeneration: "superseded",
        ...(queue.status === "success" ? {} : { status: "cancelled",
          error: "record_regeneration_superseded", completedAt: FieldValue.serverTimestamp() }) });
      return { paused: true };
    }
    const work = await prepareRecordPublicationRetry({ firestore, transaction, accepted, resume: true });
    work.write();
    return { paused: work.paused === true, resumed: work.resumed === true, queueId: work.queueId };
  });
}

// Reuse only completed bytes. An automatic alias must not restart render work.
async function completedContextInTransaction({ firestore, transaction, revision, runtime }) {
  const selected = (await transaction.get(firestore.doc(CURRENT_PATH))).data();
  if (!selected || !Number.isSafeInteger(revision) || revision < 1 || selected.contextRevision !== revision ||
      selected.contextDigest !== publicContextDigest(revision) || !ownsPublication(selected, runtime) ||
      selected.finalNamespaceOwner !== true || !/^[A-Za-z0-9]{20}$/.test(selected.operationId ?? "") ||
      !/^[A-Za-z0-9]{20}$/.test(selected.preparationOperationId ?? "")) return false;
  const outputs = contextOutputs(selected);
  const [queue, preparation, ...states] = await transaction.getAll(firestore.doc(`cmsPublishQueue/${selected.operationId}`),
    firestore.doc(`cmsPublishQueue/${selected.preparationOperationId}/backgroundPreparation/${selected.contextDigest}`),
    ...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  return queue.data()?.status === "success" && ownsPublication(queue.data(), runtime) &&
    verifiedPreparation(preparation.data(), runtime, selected.contextDigest) && states.every(row => {
      const value = row.data();
      return value?.contextOnly === true && value.taskPath === `cmsPublishQueue/${selected.namespaceOperationId}/backgroundOutputs/${row.id}` &&
        value.status === "verified" && ownsPublication(value, runtime) && value.contextDigest === selected.contextDigest &&
        value.receipt?.revision === value.revision && value.receipt?.rendererSha === runtime.release &&
        value.receipt?.contextDigest === selected.contextDigest;
    });
}

/** A later context can publish the accepted snapshot before its own proof runs.
 * Reuse the normal exact-source retry; never reopen an exhausted current job. */
async function resumeStaleRecordPublication({ firestore, operationId }) {
  return firestore.runTransaction(async transaction => {
    const accepted = await readRecordPublication({ firestore, transaction, operationId }).catch(error => {
      if (error.code === "record_publication_replaced") return null;
      throw error;
    });
    if (!accepted || accepted.publication.status === "success" ||
        !(accepted.queue.status === "success" || accepted.queue.status === "cancelled" &&
          accepted.queue.error === "public_context_superseded")) return { resumed: false };
    const [context, deployment] = await transaction.getAll(firestore.doc("system/publicDeployment/contexts/public"),
      firestore.doc("system/publicDeployment"));
    const identity = accepted.queue.recordPublication;
    if (identity.contextRevision === context.data()?.revision && identity.rendererSha === deployment.data()?.activeCommitSha) {
      return { resumed: false };
    }
    // A recovery alias must not replace an in-flight family's preparation.
    // Bare revision bumps are regenerated by the cloud context owner, whose
    // selector and minute wake also handle a missing current-context job.
    if (!await completedContextInTransaction({ firestore, transaction, revision: context.data()?.revision,
      runtime: { owner: "cloudflare", release: deployment.data()?.activeCommitSha } })) return { resumed: false, waiting: true };
    const work = await prepareRecordPublicationRetry({ firestore, transaction, accepted, resume: true });
    work.write();
    return { resumed: work.resumed === true, queueId: work.queueId };
  });
}

async function existingNoBuildRecordPublication({ firestore, changes, retry = false, baseVersion }) {
  return firestore.runTransaction(async transaction => {
    const selected = changes.filter(change => change.collection === "cmsPosts");
    const owners = await Promise.all(selected.map(change => readNoBuildRecordOwner({ firestore, transaction, documentId: change.id })));
    const state = owners.find(owner => owner.state)?.state;
    if (!state) return null;
    if (changes.length !== 1 || changes[0].id !== state.documentId || changes[0].sourceVersion !== state.sourceVersion ||
        (changes[0].operation === "withdraw") === state.visible) refuse("This record requires its existing publication operation.");
    const document = (await transaction.get(firestore.doc(`cmsPosts/${state.documentId}`))).data();
    const accepted = await readRecordPublication({ firestore, transaction, operationId: state.operationId, document });
    if (!accepted) refuse("The accepted record publication is unavailable.");
    if (retry && baseVersion !== document?.version) refuse("This record changed. Reload before retrying publication.");
    const work = retry ? await prepareRecordPublicationRetry({ firestore, transaction, accepted }) : null;
    work?.write();
    return { success: true, queueId: work?.queueId ?? accepted.ref.id, dispatched: false,
      status: work?.resumed || retry && accepted.publication.status !== "success" ? "pending" : accepted.publication.status,
      missingConsumers: work?.missingConsumers ?? accepted.publication.missingConsumers,
      ...(work?.paused ? { warning: "Record removal is accepted. Card and index updates will resume when publishing resumes." }
        : !retry && accepted.publication.warning ? { warning: accepted.publication.warning } : {}),
      transport: TRANSPORT, existingBuild: true, message: "This record retains its accepted publication operation." };
  });
}
module.exports = { successorId, prepareRecordPublicationRetry, resumeDeferredRecordPublication,
  resumeStaleRecordPublication, existingNoBuildRecordPublication };

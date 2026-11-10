"use strict";

const { preparePublicReleaseProducerInTransaction, publicContentChange } = require("./public-release-producer");

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { publiclyVisible } = require("./public-video-references");
const { readNoBuildFamilyAdmission, selectsNoBuildRecord } = require("./no-build-family-admission");
const { readRecordCapability } = require("./no-build-record-capability");
const { validateNoBuildRecordSnapshot, recordSnapshotDigest } = require("./no-build-record-contract");
const { readNoBuildRecordOwner, prepareRecordRouteClaimsInTransaction } = require("./no-build-record-ownership");
const { readPendingRecordFamilyInTransaction } = require("./no-build-record-source");
const { readPublicationPrerequisites, PUBLICATION_BUDGET_MS } = require("./settings-publication");
const { assertPublicDeploymentPointer } = require("./public-deployment");
const { readCmsPublicationRuntimeControlInTransaction, cloudCmsPublicationRuntimeControl } = require("./cms-publication-runtime-control");
const { publicationTarget } = require("./publication-target");
const { enqueuePublicContextInTransaction, missingPublicContextConsumers, TRANSPORT } = require("./public-context-publication");
const { bumpPublicContextRevision, publicContextDigest, readPublicContextRevisionInTransaction } = require("./public-context-revision");
const { contextOutputs, readRecordNamespace } = require("./no-build-record-namespace");

const recordFamily = document => ({ program: "programs", event: "events" })[document?.type] ?? null;
function refuse(message, scheduleDeferred = false) {
  throw Object.assign(new Error(message), { status: 409, code: "record_publication_unavailable", ...(scheduleDeferred ? { scheduleDeferred: true } : {}) });
}
function prerequisiteFailure(error) {
  if (error.status === 409 || error.code === "failed-precondition") error.scheduleDeferred = true;
  throw error;
}
async function recordPublicationSelected({ firestore, transaction, documentId, family, config }) {
  const { state } = await readNoBuildRecordOwner({ firestore, transaction, documentId });
  config ??= await readNoBuildFamilyAdmission({ firestore, transaction });
  return Boolean(state || selectsNoBuildRecord(config, family, documentId));
}
async function readRecordWithdrawalPrerequisites({ firestore, transaction }) {
  const pointer = assertPublicDeploymentPointer((await transaction.get(firestore.doc("system/publicDeployment"))).data());
  const control = await readCmsPublicationRuntimeControlInTransaction({ firestore, transaction });
  const cloud = cloudCmsPublicationRuntimeControl(control);
  const target = publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production");
  if (cloud.commitSha !== pointer.activeCommitSha || cloud.serializerId !== target.serializerId) {
    refuse("The active record publication owner changed. Retry this removal shortly.", true);
  }
  const revision = await readPublicContextRevisionInTransaction(transaction, firestore);
  const billing = (await transaction.get(firestore.doc("system/billing"))).data();
  return { revision, runtime: { owner: "cloudflare", release: pointer.activeCommitSha }, capability: null,
    regenerationPaused: billing?.disabled === true || cloud.phase !== "ready" };
}
async function readRecordPublicationPrerequisites({ firestore, transaction, family, withdrawal = false }) {
  if (withdrawal) return readRecordWithdrawalPrerequisites({ firestore, transaction }).catch(prerequisiteFailure);
  const { revision, runtime } = await readPublicationPrerequisites(firestore, transaction).catch(prerequisiteFailure);
  const capability = await readRecordCapability({ firestore, transaction }).catch(prerequisiteFailure);
  if (!capability?.servingEnabled || capability.rendererSha !== runtime.release || !capability.families.includes(family) ||
      capability.terminalOwner?.schemaVersion !== 1 || capability.terminalOwner.transport !== TRANSPORT ||
      capability.terminalOwner.rendererSha !== runtime.release) refuse("Record publication requires the serving, confirmation and recovery owner.", true);
  return { revision, runtime, capability };
}

/** Content auth, version/history and media usage remain in the caller's transaction. */
async function prepareNoBuildRecordPublication({ firestore, transaction, collection, documentId, nextDocument, queueRef, actor, config, validationOnly = false }) {
  if (collection !== "cmsPosts") return null;
  const owner = await readNoBuildRecordOwner({ firestore, transaction, documentId });
  const family = recordFamily(nextDocument);
  if (!family) { if (owner.state) refuse("The accepted record kind cannot change."); return null; }
  config ??= await readNoBuildFamilyAdmission({ firestore, transaction });
  const visible = publiclyVisible(nextDocument), withdrawal = !visible;
  const selected = selectsNoBuildRecord(config, family, documentId);
  if (!owner.state && !selected) return null;
  if (owner.state && owner.state.family !== family) refuse("The accepted record kind cannot change.");
  if ((!owner.state || !withdrawal) && (!selected || !config.enabled)) refuse("Build-free record publication is paused.", true);
  // The serializer is retired. A static withdrawal adopts only a compatible
  // snapshot under enabled admission; unsupported inputs keep their refusal.
  const { revision, runtime, capability, regenerationPaused } = await readRecordPublicationPrerequisites({ firestore, transaction, family,
    withdrawal: Boolean(owner.state && withdrawal) });
  const plan = validateNoBuildRecordSnapshot({ family, documentId, snapshot: nextDocument.published });
  const snapshotDigest = recordSnapshotDigest(nextDocument.published);
  const [storedRow, previousQueue] = await transaction.getAll(firestore.doc(`cmsPosts/${documentId}`),
    ...(owner.state ? [firestore.doc(`cmsPublishQueue/${owner.state.operationId}`)] : []));
  const stored = storedRow.data();
  if (!Number.isSafeInteger(nextDocument.version) || nextDocument.version <= (stored?.version ?? 0) ||
      visible && plan.sourceVersion !== nextDocument.version ||
      withdrawal && (snapshotDigest !== recordSnapshotDigest(stored?.published) ||
        owner.state && (owner.state.snapshotDigest !== snapshotDigest || owner.state.sourceVersion !== plan.sourceVersion))) {
    refuse("The accepted record source changed. Reload before publishing.");
  }
  if (visible) {
    const pending = await readPendingRecordFamilyInTransaction({ firestore, transaction, family, rendererSha: runtime.release,
      documentId, nextDocument, now: new Date(nextDocument.published.publishedAt) });
    if (!pending.sources.some(source => source.documentId === documentId && source.sourceVersion === plan.sourceVersion &&
        source.snapshotDigest === snapshotDigest)) refuse("The record is absent from its public family input.");
  }
  const writeRoutes = await prepareRecordRouteClaimsInTransaction({ firestore, transaction, family, documentId, ownedPaths: plan.ownedPaths });
  if (!/^[A-Za-z0-9]{20}$/.test(queueRef?.id ?? "") || queueRef.path !== `cmsPublishQueue/${queueRef.id}` ||
      !Number.isSafeInteger(revision + 1)) refuse("The record operation identity is invalid.");
  const generation = Math.max(owner.state?.generation ?? 0, capability?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) refuse("The record generation is exhausted.");
  const operation = { schemaVersion: 1, documentId, family, operationId: queueRef.id, originalOperationId: queueRef.id,
    sourceVersion: plan.sourceVersion, documentVersion: nextDocument.version, visible, ownedPaths: plan.ownedPaths,
    canonicalPath: plan.canonicalPath, snapshotDigest, generation, rendererSha: runtime.release,
    contextRevision: regenerationPaused ? revision : revision + 1, contextDigest: publicContextDigest(regenerationPaused ? revision : revision + 1) };
  const context = regenerationPaused ? await prepareDeferredRecordRemoval({ firestore, transaction, operation, runtime })
    : await enqueuePublicContextInTransaction({ firestore, transaction, runtime, operationId: queueRef.id,
    recordFamily: family, reason: "context", contextRevision: operation.contextRevision });
  const state = { schemaVersion: 1, family, documentId, operationId: queueRef.id, sourceVersion: plan.sourceVersion,
    snapshotDigest, canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths, visible, rendererSha: runtime.release,
    generation, runtime, contextRevision: operation.contextRevision, contextDigest: operation.contextDigest,
    admissionRevision: config.admissionRevision ?? owner.state?.admissionRevision ?? null,
    ...(owner.state?.durableWithdrawal ? { durableWithdrawal: owner.state.durableWithdrawal } : {}) };
  if (withdrawal) state.durableWithdrawal = { schemaVersion: 1, recordId: documentId, family, operationId: queueRef.id,
    sourceVersion: plan.sourceVersion, revision: generation, ownedPaths: plan.ownedPaths, snapshotDigest, contextRevision: operation.contextRevision };
  const writeReleaseChange = validationOnly ? () => {} : await preparePublicReleaseProducerInTransaction({ firestore, transaction,
    operationId: queueRef.id, contextRevision: operation.contextRevision, changes: [publicContentChange(collection, documentId, nextDocument, visible, { path: owner.ref.path, data: state })] });
  return { operation, transport: TRANSPORT, requiresPrimaryAdmission: false, queueId: queueRef.id, contentQueueId: queueRef.id,
    affectedHomeSections: [], warnings: [], homeFullBuildQueueId: null, write() {
      writeReleaseChange();
      context.write(); writeRoutes(); transaction.set(owner.ref, state);
      // A new accepted operation settles the previous operation as replaced.
      if (previousQueue?.data()?.recordConfirmationPendingAt) transaction.update(previousQueue.ref,
        { recordConfirmationPendingAt: FieldValue.delete() });
      transaction.set(queueRef, { recordPublication: operation, recordConfirmationPendingAt: FieldValue.serverTimestamp(), triggeredBy: actor.uid,
        triggeredByEmail: actor.email ?? null, triggeredAt: FieldValue.serverTimestamp() }, { merge: true });
      if (!regenerationPaused) bumpPublicContextRevision(transaction, firestore, { withdrawal });
    } };
}

/** Accepted removal is metadata-only during a spending/runtime pause.
 * Staff acceptance requires the confirmation/recovery terminal seal.
 * The existing minute sweep resumes or retires these bookkeeping entries. */
async function prepareDeferredRecordRemoval({ firestore, transaction, operation, runtime }) {
  const { families } = await readRecordNamespace({ firestore, transaction });
  const ref = firestore.doc(`cmsPublishQueue/${operation.operationId}`);
  const queue = await transaction.get(ref);
  if (operation.visible || !families.includes(operation.family) || queue.exists) refuse("The deferred record removal is invalid.");
  return { write() {
    transaction.create(ref, { schemaVersion: 1, transport: TRANSPORT, runtime, backgroundRuntime: runtime,
      publicContext: { schemaVersion: 1, operationId: operation.operationId, contextRevision: operation.contextRevision,
        contextDigest: operation.contextDigest, reason: "context", runtime, recordFamilies: families, acceptedAt: Date.now() },
      status: "pending", changes: [], recordRegeneration: "deferred", createdAt: FieldValue.serverTimestamp(), aggregateReceipt: null });
  } };
}

function recordPublicationReceipt(queue, now = Date.now()) {
  const identity = queue?.recordPublication;
  if (queue?.recordRegeneration !== undefined && (identity?.visible !== false ||
      !["deferred", "active", "superseded", "complete"].includes(queue.recordRegeneration))) refuse("The record regeneration receipt is invalid.");
  if (queue?.transport !== TRANSPORT || identity?.schemaVersion !== 1 || !["programs", "events"].includes(identity.family) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(identity.documentId ?? "") || !/^[A-Za-z0-9]{20}$/.test(identity.operationId ?? "") ||
      !/^[A-Za-z0-9]{20}$/.test(identity.originalOperationId ?? "") || !Number.isSafeInteger(identity.sourceVersion) || identity.sourceVersion < 1 ||
      !Number.isSafeInteger(identity.generation) || identity.generation < 1 || typeof identity.visible !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(identity.snapshotDigest ?? "") || !/^[a-f0-9]{40}$/.test(identity.rendererSha ?? "") ||
      !Number.isSafeInteger(identity.contextRevision) || identity.contextRevision < 1 || identity.contextDigest !== publicContextDigest(identity.contextRevision) ||
      queue.runtime?.owner !== "cloudflare" || queue.runtime.release !== identity.rendererSha ||
      queue.publicContext?.operationId !== identity.operationId || queue.publicContext.contextRevision !== identity.contextRevision ||
      queue.publicContext.contextDigest !== identity.contextDigest || !contextOutputs(queue.publicContext).includes(identity.family) ||
      !["pending", "publishing", "success", "failed", "cancelled"].includes(queue.status)) refuse("The record publication receipt is invalid.");
  const required = ["pages", "home", "posts", "record", ...contextOutputs(queue.publicContext)];
  const missingConsumers = missingPublicContextConsumers(queue, identity, required, ["pages", "home", "posts", "record"]);
  const failed = ["failed", "cancelled"].includes(queue.status);
  const started = queue.recordRetryAt?.toMillis?.() ?? queue.createdAt?.toMillis?.() ?? now;
  let warning;
  if (queue.recordRegeneration === "deferred") warning = "Record removal is accepted. Card and index updates will resume when publishing resumes.";
  else if (failed || missingConsumers.length && now - started >= PUBLICATION_BUDGET_MS) warning = "The record update is taking longer than expected. Retry publication.";
  return { queueId: identity.operationId, transport: TRANSPORT, sourceVersion: identity.sourceVersion, withdrawal: !identity.visible,
    status: failed ? "failed" : missingConsumers.length ? "pending" : "success", missingConsumers,
    ...(warning ? { warning } : {}) };
}
async function readRecordPublication({ firestore, transaction, operationId, document }) {
  if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) return null;
  const read = ref => transaction ? transaction.get(ref) : ref.get();
  let ref = firestore.doc(`cmsPublishQueue/${operationId}`), row = await read(ref);
  if (!row.exists || !row.data().recordPublication) return null;
  let queue = row.data(); recordPublicationReceipt(queue);
  if (queue.recordPublication.originalOperationId !== operationId) refuse("The record operation changed.");
  if (queue.successorOperationId) {
    if (!/^[A-Za-z0-9]{20}$/.test(queue.successorOperationId)) refuse("The record successor is invalid.");
    ref = firestore.doc(`cmsPublishQueue/${queue.successorOperationId}`); row = await read(ref);
    if (!row.exists) refuse("The record successor is unavailable.");
    queue = row.data();
  }
  const identity = queue.recordPublication, receipt = recordPublicationReceipt(queue);
  const { state } = await readNoBuildRecordOwner({ firestore, transaction, documentId: identity.documentId });
  const stored = document ?? (await read(firestore.doc(`cmsPosts/${identity.documentId}`))).data();
  if (!state || state.operationId !== operationId || identity.originalOperationId !== operationId || identity.operationId !== ref.id ||
      state.family !== identity.family || state.canonicalPath !== identity.canonicalPath || !isDeepStrictEqual(state.ownedPaths, identity.ownedPaths) ||
      state.sourceVersion !== identity.sourceVersion || state.snapshotDigest !== identity.snapshotDigest || state.generation !== identity.generation ||
      state.visible !== identity.visible || publiclyVisible(stored) !== state.visible || recordSnapshotDigest(stored?.published) !== state.snapshotDigest) {
    throw Object.assign(new Error("This record publication was replaced. Reload before publishing."), { status: 409, code: "record_publication_replaced" });
  }
  return { ref, queue, state, publication: receipt };
}
module.exports = { preparePairRecordPublication: options => require("./public-release-family-admission").preparePairContentPublication({
  ...options, collection: "cmsPosts", kind: "record", family: recordFamily(options.nextDocument) }),
  recordFamily, recordPublicationSelected, readRecordPublicationPrerequisites,
  prepareNoBuildRecordPublication, recordPublicationReceipt, readRecordPublication };

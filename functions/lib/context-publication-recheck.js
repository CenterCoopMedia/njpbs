"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { can } = require("./rbac");
const { adminLogEntry } = require("./audit");
const { contentResourceSection } = require("./content-authorization");
const { CURRENT_PATH, TRANSPORT, verifiedContextOutput, aggregateContextReceipt, verifiedPreparation } = require("./public-context-publication");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { contextOutputs } = require("./no-build-record-namespace");
const { ownsPublication } = require("./publication-runtime-owner");
const { PUBLIC_SETTINGS_IDS, readSettingsPublication, settingsPublicationReceipt } = require("./settings-publication");
const { projectPublishedCmsSettings } = require("./cms-settings-contract");
const { readNoBuildRecordOwner } = require("./no-build-record-ownership");
const { readRecordPublication, recordPublicationReceipt } = require("./no-build-record-publication");
const { libraryCardReceipt, latestLibraryCardPublication } = require("./no-build-library-card-publication");
const paired = require("./public-release-admission");
const { publicReleaseDigest } = require("./public-release-pair");
const { assertPairPublicationTerminalReceiptInTransaction } = require("./public-release-terminal");
const { currentContextCheck } = require("./context-publication-check-state");

const operationId = /^[A-Za-z0-9]{20}$/;
const failed = queue => ["failed", "public_unconfirmed"].includes(queue.status);
const terminalCheck = queue => ["confirmed_late", "superseded"].includes(currentContextCheck(queue)?.outcome);
const handlesContextRecheck = queue => queue?.transport === TRANSPORT || queue?.transport === paired.TRANSPORT;

function refuse(status, message) { throw Object.assign(new Error(message), { status }); }
function requireSettings(actor) {
  if (!can(actor.principal, "settings.manage", {})) refuse(403, "Site settings access is required to check this update.");
}
async function readAuthorizedRecord({ firestore, transaction, actor, id }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id ?? "")) refuse(409, "The publication identity is unavailable.");
  const document = (await transaction.get(firestore.doc(`cmsPosts/${id}`))).data();
  const resource = { ownerId: document?.createdBy, section: contentResourceSection({ collection: "cmsPosts", documentId: id, stored: document }) };
  if (!document || !can(actor.principal, "content.publish", resource)) refuse(403, "Publish access required.");
  return document;
}

function validContext(queue, id) {
  const identity = queue?.publicContext;
  return queue?.schemaVersion === 1 && queue.transport === TRANSPORT && identity?.schemaVersion === 1 &&
    identity.operationId === id && Number.isSafeInteger(identity.contextRevision) && identity.contextRevision > 0 &&
    identity.contextDigest === publicContextDigest(identity.contextRevision) &&
    queue.runtime?.owner === "cloudflare" && /^[a-f0-9]{40}$/.test(queue.runtime.release ?? "") &&
    ownsPublication(identity, queue.runtime) && Array.isArray(queue.changes) && queue.changes.length === 0;
}

// Read the same verified family outputs the publisher uses for aggregate
// settlement. Neither read a previous generation nor install a new owner.
async function readActiveAggregate({ firestore, transaction }) {
  const [pointer, context, owner] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc(CURRENT_PATH));
  const selected = owner.data(), runtime = selected?.runtime;
  if (!operationId.test(selected?.operationId ?? "") || !operationId.test(selected?.namespaceOperationId ?? "") ||
      selected.finalNamespaceOwner !== true || pointer.data()?.state !== "idle" ||
      pointer.data().activeCommitSha !== runtime?.release || context.data()?.schemaVersion !== 1 ||
      context.data().revision !== selected.contextRevision) return null;
  const current = (await transaction.get(firestore.doc(`cmsPublishQueue/${selected.operationId}`))).data();
  if (!validContext(current, selected.operationId) || current.publicContext.contextDigest !== selected.contextDigest ||
      !ownsPublication(current, runtime)) return null;
  if (current.preparationRecoveryOfQueueId) {
    if (selected.preparationOperationId !== selected.operationId) return null;
    const preparation = (await transaction.get(firestore.doc(
      `cmsPublishQueue/${selected.operationId}/backgroundPreparation/${selected.contextDigest}`))).data();
    if (!verifiedPreparation(preparation, runtime, selected.contextDigest)) return null;
  }
  const outputs = contextOutputs(current.publicContext);
  if (!isDeepStrictEqual(outputs, contextOutputs(selected))) return null;
  const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  if (!states.every((row, index) => {
    const output = row.data();
    return verifiedContextOutput(output, runtime, selected.contextDigest) && output.contextOnly === true &&
      output.taskPath === `cmsPublishQueue/${selected.namespaceOperationId}/backgroundOutputs/${outputs[index]}` &&
      Number.isFinite(output.receipt.verifiedAt) && output.receipt.verifiedAt > 0 &&
      /^[a-f0-9]{64}$/.test(output.receipt.digest ?? "") && /^[a-f0-9]{64}$/.test(output.receipt.routeSetDigest ?? "");
  })) return null;
  return { operationId: selected.operationId, receipt: aggregateContextReceipt({ states, outputs, runtime,
    contextRevision: selected.contextRevision, contextDigest: selected.contextDigest,
    preparationOperationId: selected.preparationOperationId ?? null }) };
}

function matchesAggregate(queue, proof) {
  return Boolean(proof && ownsPublication(queue, proof.receipt.runtime) &&
    queue.publicContext.contextDigest === proof.receipt.contextDigest &&
    isDeepStrictEqual(contextOutputs(queue.publicContext), Object.keys(proof.receipt.outputs)));
}

async function readLegacyRecheck(input) {
  const { firestore, transaction, queue, queueId, actor } = input;
  if (!validContext(queue, queueId)) refuse(409, "The publication identity is unavailable.");
  const identity = queue.recordPublication ?? queue.libraryCardPublication ?? queue.settingsPublication;
  if (!identity) {
    requireSettings(actor);
    if (!failed(queue) || !["context", "provider-refresh"].includes(queue.publicContext.reason)) refuse(409, "The site update is not awaiting confirmation.");
    const active = await readActiveAggregate(input);
    if (matchesAggregate(queue, active)) return { operationId: queueId, receipt: active.receipt };
    if (active?.receipt.contextRevision > queue.publicContext.contextRevision) {
      return { operationId: active.operationId, superseded: true, receipt: active.receipt };
    }
    return null;
  }
  let accepted, readReceipt, newer = false;
  if (queue.settingsPublication) {
    requireSettings(actor);
    if (!PUBLIC_SETTINGS_IDS.has(identity.id)) refuse(409, "The publication identity is unavailable.");
    const stored = (await transaction.get(firestore.doc(`cmsSettings/${identity.id}`))).data();
    const published = projectPublishedCmsSettings({ documentId: identity.id, document: stored });
    if (published?.sourceVersion >= identity.sourceVersion) {
      accepted = await readSettingsPublication({ firestore, transaction, id: identity.id,
        sourceVersion: published.sourceVersion, settings: { published } });
      newer = published.sourceVersion > identity.sourceVersion;
    }
    readReceipt = settingsPublicationReceipt;
  } else if (queue.recordPublication) {
    const document = await readAuthorizedRecord({ ...input, id: identity.documentId });
    const { state } = await readNoBuildRecordOwner({ firestore, transaction, documentId: identity.documentId });
    if (state?.family === identity.family && (state.operationId === identity.originalOperationId ||
        state.generation > identity.generation && state.sourceVersion >= identity.sourceVersion)) {
      accepted = await readRecordPublication({ firestore, transaction, operationId: state.operationId, document });
      newer = state.operationId !== identity.originalOperationId;
    }
    readReceipt = recordPublicationReceipt;
  } else {
    const document = await readAuthorizedRecord({ ...input, id: identity.recordId });
    accepted = (await latestLibraryCardPublication({ firestore, transaction, stored: { ...document, id: identity.recordId } })).accepted;
    newer = accepted?.queue.libraryCardPublication.sourceVersion > identity.sourceVersion;
    readReceipt = libraryCardReceipt;
  }
  const original = readReceipt(queue);
  if (!failed(queue) && (queue.status !== "success" || !original.warning || !original.missingConsumers.length)) {
    refuse(409, "The publication is not awaiting confirmation.");
  }
  if (!accepted) return null;
  if (accepted.queue.transport === paired.TRANSPORT) {
    if (accepted.publication.status !== "success" || !newer) return null;
    const receipt = await assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
      operationId: accepted.ref.id, admissionDigest: accepted.queue.admissionDigest });
    return { operationId: accepted.ref.id, superseded: true, receipt };
  }
  const currentIdentity = accepted.queue.recordPublication ?? accepted.queue.libraryCardPublication ?? accepted.queue.settingsPublication;
  if (!newer && currentIdentity?.originalOperationId !== identity.originalOperationId) return null;
  const active = await readActiveAggregate(input);
  if (!validContext(accepted.queue, accepted.ref.id) || !matchesAggregate(accepted.queue, active)) return null;
  if (["cancelled", "pending", "publishing"].includes(accepted.queue.status)) return null;
  const current = { ...accepted, queue: { ...accepted.queue, status: "success", aggregateReceipt: active.receipt } };
  const { missingConsumers } = readReceipt(current.queue);
  const check = { operationId: accepted.ref.id, superseded: accepted.ref.id !== queueId };
  if (queue.recordPublication) {
    if (missingConsumers.some(name => name !== "record")) return null;
    return { ...check, record: { queue: current.queue, state: current.state } };
  }
  if (missingConsumers.length) return null;
  return { ...check, receipt: { aggregate: active.receipt, consumers: current.queue.consumerReceipts } };
}

async function readPairRecheck(input) {
  const { firestore, transaction, queue, queueId, actor } = input;
  const original = paired.parseAdmission((await transaction.get(firestore.doc(`${paired.ADMISSIONS}/operations/${queueId}`))).data());
  paired.assertQueue(queue, original);
  if (original.operationId !== queueId || !["settings", "provider", "record"].includes(original.source.kind)) {
    refuse(409, "This publication cannot be checked here.");
  }
  if (original.source.kind === "record") await readAuthorizedRecord({ ...input, id: original.source.id });
  else requireSettings(actor);
  if (!failed(queue) && queue.status !== "superseded") refuse(409, "The publication is not awaiting confirmation.");
  if (queue.status === "superseded") {
    const receipt = await assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
      operationId: queueId, admissionDigest: queue.admissionDigest });
    return { operationId: receipt.supersededBy.operationId, superseded: true, receipt };
  }
  const owner = (await transaction.get(firestore.doc(paired.ownerPath(original.source)))).data();
  if (owner?.schemaVersion !== 2 || owner.admissionSequence <= original.admissionSequence || !operationId.test(owner.operationId ?? "")) return null;
  const [nextRow, nextQueue] = await transaction.getAll(firestore.doc(`${paired.ADMISSIONS}/operations/${owner.operationId}`),
    firestore.doc(`cmsPublishQueue/${owner.operationId}`));
  if (nextQueue.data()?.status !== "success") return null;
  const next = paired.parseAdmission(nextRow.data());
  if (next.operationId !== owner.operationId || next.admissionSequence !== owner.admissionSequence ||
      publicReleaseDigest(next) !== owner.admissionDigest || paired.ownerPath(next.source) !== paired.ownerPath(original.source) ||
      next.source.family !== original.source.family || next.source.sourceVersion < original.source.sourceVersion) return null;
  const receipt = await assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
    operationId: owner.operationId, admissionDigest: owner.admissionDigest });
  return { operationId: owner.operationId, superseded: true, receipt };
}

async function readContextRecheck(input) {
  const proof = await (input.queue.transport === paired.TRANSPORT ? readPairRecheck : readLegacyRecheck)(input);
  if (terminalCheck(input.queue)) refuse(409, "This publication has already been checked.");
  return { queue: input.queue, proof };
}

async function completeContextRecheck({ firestore, queueId, actor, source, initial, ...network }) {
  const queueRef = firestore.doc(`cmsPublishQueue/${queueId}`);
  let publicProof;
  if (initial.proof?.record) {
    try {
      publicProof = await require("./no-build-record-confirmation").prepareRecordPublicProof({
        firestore, accepted: initial.proof.record, ...network });
    } catch { /* Retain the original publication state on a failed readback. */ }
  }
  const auditRef = firestore.collection("admin_logs").doc();
  return firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    if (!isDeepStrictEqual(queue, initial.queue)) refuse(409, "Publication changed during the check. Reload its status.");
    const current = await readContextRecheck({ firestore, transaction, actor, queueId, queue });
    if (!isDeepStrictEqual(current.proof, initial.proof)) refuse(409, "Publication changed during the check. Reload its status.");
    const record = current.proof && "record" in current.proof ? current.proof.record : null;
    if (publicProof && record) await publicProof.assertCurrent(transaction, record);
    const proof = record ? publicProof?.receipt : current.proof?.receipt;
    const outcome = !proof ? "failed" : current.proof.superseded ? "superseded" : "confirmed_late";
    const message = outcome === "confirmed_late" ? "Publication confirmed on the public site." :
      outcome === "superseded" ? "A newer publication is live. This request no longer needs recovery." :
        "The public check still could not confirm this update. You can try again later.";
    const recordProof = outcome === "confirmed_late" && publicProof?.consumer;
    transaction.update(queueRef, { lastPublicCheck: { outcome, actorUid: actor.uid, checkedAt: FieldValue.serverTimestamp(), message,
      queueStatus: queue.status, alertEpoch: queue.alertEpoch ?? null,
      ...(recordProof ? { recordProof } : {}) } });
    transaction.create(auditRef, adminLogEntry({ actorUid: actor.uid, actorEmail: actor.email ?? null,
      action: "cms.publicationRechecked", target: queueId, source, before: { status: queue.status },
      after: { outcome, ...(proof ? { operationId: current.proof.operationId, receipt: proof } : {}) } }));
    return { success: true, queueId, outcome, message };
  });
}

module.exports = { handlesContextRecheck, readContextRecheck, completeContextRecheck };

"use strict";

const { randomUUID } = require("node:crypto");
const { assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");
const { FieldValue } = require("firebase-admin/firestore");
const { publicationRuntime, ownsPublication, samePublicationOwner } = require("./publication-runtime-owner");
const { publicContextDigest, PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { retryExhausted } = require("./no-build-cloud-work");
const { dependency, lastGood } = require("./post-background-outputs");

const CURRENT_PATH = "system/publicDeployment/aggregateContexts/current";
const TRANSPORT = "public-context-no-build-v1";
const { CONTEXT_OUTPUTS: OUTPUTS, contextOutputs, prepareRecordNamespace } = require("./no-build-record-namespace");
function requireValue(value) { if (!value) throw new Error("Public context publication refused"); }
function missingPublicContextConsumers(queue, identity, requiredConsumers, routeConsumers) {
  const aggregate = queue.aggregateReceipt;
  const exactAggregate = aggregate?.runtime?.owner === "cloudflare" && aggregate.runtime.release === identity.rendererSha &&
    aggregate.contextRevision === identity.contextRevision && aggregate.contextDigest === identity.contextDigest;
  return requiredConsumers.filter(name => {
    const receipt = routeConsumers.includes(name) ? queue.consumerReceipts?.[name] : exactAggregate ? aggregate.outputs?.[name] : null;
    return !(receipt?.rendererSha === identity.rendererSha && receipt.contextRevision === identity.contextRevision &&
      receipt.contextDigest === identity.contextDigest && Number.isFinite(receipt.verifiedAt) && receipt.verifiedAt > 0);
  });
}
function frozenContextMatches(preparation, selected, runtime) {
  const frozen = preparation?.frozenContext;
  return Boolean(frozen && selected && ownsPublication(preparation, runtime) && preparation.contextDigest === selected.contextDigest &&
    frozen?.revision === selected?.contextRevision && Number.isSafeInteger(frozen.revision) && frozen.revision > 0 &&
    [frozen.withdrawalRevision, frozen.homeRevision].every(value => Number.isSafeInteger(value) && value >= 0));
}

// The selected preparation may finish its frozen context while newer changes
// wait. Selection, source and family-task fences still reject obsolete writers.
async function readSelectedPublicContextInTransaction({ transaction, firestore, operationId, runtime }) {
  const { readPublicBackgroundContextInTransaction } = require("./public-context-revision");
  const context = await readPublicBackgroundContextInTransaction(transaction, firestore);
  const selected = (await transaction.get(firestore.doc(CURRENT_PATH))).data();
  requireValue(selected && ownsPublication(selected, runtime) && selected.preparationOperationId === operationId);
  const preparation = (await transaction.get(firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${selected.contextDigest}`))).data();
  requireValue(preparation && ownsPublication(preparation, runtime) && preparation.contextDigest === selected.contextDigest);
  const cutoff = preparation.reservation?.cutoffAt?.toMillis?.();
  const sourceTime = Number.isSafeInteger(cutoff) && cutoff > 0 ? { sourceReadAt: cutoff } : {};
  if (context.digest === selected.contextDigest) return { ...context, ...sourceTime, contextRevision: selected.contextRevision };
  requireValue(frozenContextMatches(preparation, selected, runtime));
  return { ...context, ...sourceTime, digest: selected.contextDigest, contextRevision: preparation.frozenContext.revision,
    withdrawalRevision: preparation.frozenContext.withdrawalRevision, homeRevision: preparation.frozenContext.homeRevision };
}
function verifiedPreparation(value, runtime, contextDigest) {
  return value?.schemaVersion === 1 && value.status === "verified" && ownsPublication(value, runtime) &&
    value.contextDigest === contextDigest && /^[a-f0-9]{64}$/.test(value.preparedDigest ?? "") && value.reservation?.commitSha === runtime.release &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.reservation.buildBatchId ?? "") &&
    Number.isSafeInteger(value.reservation.generation) && value.reservation.generation > 0 &&
    Number.isSafeInteger(value.reservation.cutoffAt?.toMillis?.()) && value.reservation.cutoffAt.toMillis() > 0 &&
    (value.admissionRevision === null || Number.isSafeInteger(value.admissionRevision) && value.admissionRevision > 0);
}

// Aggregate completion does not acknowledge a staff publication until its Page,
// Home and Post consumers have independently confirmed the same identity.
function needsConsumerConfirmation(queue) {
  const identity = queue.settingsPublication ?? queue.libraryCardPublication ?? queue.recordPublication;
  return queue.status !== "cancelled" && Boolean(identity) && ["pages", "home", "posts"].some(name => {
    const receipt = queue.consumerReceipts?.[name];
    return receipt?.rendererSha !== identity.rendererSha || receipt?.contextRevision !== identity.contextRevision ||
      receipt?.contextDigest !== identity.contextDigest || !Number.isFinite(receipt?.verifiedAt) || receipt.verifiedAt <= 0;
  });
}

function canSupersedeFrozenContext(preparation, withdrawalRevision, queues) {
  return withdrawalRevision > preparation.frozenContext.withdrawalRevision && !queues.some(row => {
    const queue = row.data(), identity = queue.settingsPublication ?? queue.libraryCardPublication ?? queue.recordPublication;
    // Staff receipts need their exact aggregate and Page, Home and Post proof.
    return identity && queue.status !== "cancelled" && (queue.status !== "success" || needsConsumerConfirmation(queue));
  });
}

// Equivalent producers share one waiting replacement and keep their individual
// receipts. A cancelled producer is not active work and cannot strand aliases.
async function publicContextFollowUpQueuesInTransaction({ transaction, firestore, selected }) {
  if (!selected?.followUp) return [];
  const next = selected.followUp, ids = next.operationIds ?? [next.operationId];
  requireValue(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length &&
    ids.every(id => /^[A-Za-z0-9]{20}$/.test(id)) && ids.includes(next.operationId) &&
    next.contextDigest === publicContextDigest(next.contextRevision) && ownsPublication(next, selected.runtime));
  const queues = await transaction.getAll(...ids.map(id => firestore.doc(`cmsPublishQueue/${id}`)));
  requireValue(queues.every(row => row.data()?.schemaVersion === 1 && row.data()?.transport === TRANSPORT &&
    ownsPublication(row.data(), selected.runtime) && row.data()?.publicContext?.operationId === row.id &&
    row.data()?.publicContext?.contextRevision === next.contextRevision && row.data()?.publicContext?.contextDigest === next.contextDigest &&
    JSON.stringify(contextOutputs(row.data().publicContext)) === JSON.stringify(contextOutputs(next)) &&
    Array.isArray(row.data()?.changes) && row.data().changes.length === 0));
  return queues;
}

/** Pure aggregate work owns no content or activation lease. Only registered
 * operations with their original matching identity may pass global guards. */
async function retainedPublicContextQueueIdsInTransaction({ transaction, firestore }) {
  const current = (await transaction.get(firestore.doc(CURRENT_PATH))).data();
  if (!current) return new Set();
  publicationRuntime(current.runtime);
  const ids = [...(current.operationIds ?? [current.operationId])];
  requireValue(current.schemaVersion === 1 && current.runtime.owner === "cloudflare" &&
    current.contextDigest === publicContextDigest(current.contextRevision) && Array.isArray(ids) &&
    ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length &&
    ids.every(id => /^[A-Za-z0-9]{20}$/.test(id)) && ids.includes(current.operationId));
  const queues = await transaction.getAll(...ids.map(id => firestore.doc(`cmsPublishQueue/${id}`)));
  requireValue(queues.every(row => row.data()?.schemaVersion === 1 && row.data()?.transport === TRANSPORT &&
    ownsPublication(row.data(), current.runtime) && Array.isArray(row.data()?.changes) && row.data().changes.length === 0 &&
    row.data()?.publicContext?.operationId === row.id && row.data()?.publicContext?.contextRevision === current.contextRevision &&
    row.data()?.publicContext?.contextDigest === current.contextDigest));
  const followUpQueues = await publicContextFollowUpQueuesInTransaction({ transaction, firestore, selected: current });
  ids.push(...followUpQueues.filter(row => row.data().status === "pending").map(row => row.id));
  return new Set(ids);
}

/** Read first, return writes for the caller's atomic settings/content transaction.
 * Admission selects new Posts; it does not grant ownership of public aggregates. */
async function enqueuePublicContextInTransaction({ transaction, firestore, operationId, runtime, reason, contextRevision, preparationRecoveryOfQueueId, recordFamily, activateQueued = false }) {
  publicationRuntime(runtime);
  requireValue(runtime.owner === "cloudflare" && /^[A-Za-z0-9]{20}$/.test(operationId ?? "") &&
    ["settings", "context", "provider-refresh"].includes(reason));
  const contextDigest = publicContextDigest(contextRevision);
  await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const currentRef = firestore.doc(CURRENT_PATH);
  const [queue, current, deployment, context] = await transaction.getAll(queueRef, currentRef, firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const namespace = await prepareRecordNamespace({ firestore, transaction, family: recordFamily });
  const outputs = namespace.outputs;
  const identity = activateQueued ? queue.data()?.publicContext : { schemaVersion: 1, operationId, contextRevision, contextDigest, reason, runtime, acceptedAt: Date.now(),
    ...(namespace.families.length ? { recordFamilies: namespace.families } : {}) };
  const result = { queueId: operationId, contextRevision, contextDigest, outputs: [...outputs] };
  if (queue.exists) {
    const retained = queue.data();
    requireValue(retained.transport === TRANSPORT && ownsPublication(retained, runtime) &&
      retained.publicContext?.contextRevision === contextRevision && retained.publicContext?.reason === reason &&
      retained.publicContext?.contextDigest === contextDigest &&
      JSON.stringify(contextOutputs(retained.publicContext)) === JSON.stringify(outputs));
    if (!activateQueued) return { ...result, write: () => {} };
    requireValue(queue.data().status === "pending" &&
      (current.data()?.followUp?.operationIds ?? [current.data()?.followUp?.operationId]).includes(operationId) &&
      context.data()?.revision === contextRevision);
  }
  requireValue(!activateQueued || queue.exists);
  requireValue(deployment.data()?.activeCommitSha === runtime.release &&
    [context.data()?.revision, context.data()?.revision + 1].includes(contextRevision));
  const baselineWithdrawalRevision = current.data()?.baselineWithdrawalRevision ?? context.data()?.withdrawalRevision ?? 0;
  requireValue(Number.isSafeInteger(baselineWithdrawalRevision) && baselineWithdrawalRevision >= 0);
  const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  requireValue(states.every(row => !row.exists || row.data().owner === "post-background-v1" && row.data().schemaVersion === 1 &&
    /^cmsPublishQueue\/[A-Za-z0-9_-]{1,200}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(row.data().taskPath ?? "")));
  const priorRefs = states.filter(row => row.exists).map(row => firestore.doc(row.data().taskPath));
  const prior = priorRefs.length ? await transaction.getAll(...priorRefs) : [];
  const previous = current.data();
  const sameContext = previous && ownsPublication(previous, runtime) && previous.contextDigest === contextDigest &&
    JSON.stringify(contextOutputs(previous)) === JSON.stringify(outputs);
  const previousIds = previous ? previous.operationIds ?? [previous.operationId] : [];
  requireValue(Array.isArray(previousIds) && previousIds.length <= 100 && previousIds.every(id => /^[A-Za-z0-9]{20}$/.test(id)));
  const priorQueues = previousIds.length ? await transaction.getAll(...previousIds.map(id => firestore.doc(`cmsPublishQueue/${id}`))) : [];
  const preparation = previous && ownsPublication(previous, runtime) && /^[A-Za-z0-9]{20}$/.test(previous.preparationOperationId ?? "")
    ? (await transaction.get(firestore.doc(`cmsPublishQueue/${previous.preparationOperationId}/backgroundPreparation/${previous.contextDigest}`))).data() : null;
  const followUpQueues = await publicContextFollowUpQueuesInTransaction({ transaction, firestore, selected: previous });
  const waiting = followUpQueues.filter(row => row.data().status === "pending");
  const sameFollowUp = previous?.followUp?.contextDigest === contextDigest && ownsPublication(previous, runtime) && waiting.length > 0 &&
    JSON.stringify(contextOutputs(previous.followUp)) === JSON.stringify(outputs);
  // Ordinary changes and exact staff receipts keep their frozen work. A newer
  // withdrawal can supersede pure aggregate work without extending removal grace.
  if (!activateQueued && previous?.contextRevision < contextRevision && ownsPublication(previous, runtime) &&
      previous.finalNamespaceOwner === true && frozenContextMatches(preparation, previous, runtime) &&
      !canSupersedeFrozenContext(preparation, context.data()?.withdrawalRevision ?? 0, priorQueues) &&
      priorQueues.some(row => row.id === previous.operationId && row.data()?.status === "pending")) {
    requireValue(!sameFollowUp || waiting.length < 100);
    return { ...result, write() {
      namespace.write();
      if (!sameFollowUp) for (const row of waiting) transaction.update(row.ref,
        { status: "cancelled", error: "public_context_superseded", completedAt: FieldValue.serverTimestamp() });
      transaction.create(queueRef, { schemaVersion: 1, transport: TRANSPORT, runtime, backgroundRuntime: runtime,
        publicContext: identity, status: "pending", changes: [], createdAt: FieldValue.serverTimestamp(), aggregateReceipt: null });
      transaction.update(currentRef, { followUp: { ...(sameFollowUp ? waiting[0].data().publicContext : identity),
        operationIds: [...(sameFollowUp ? waiting.map(row => row.id) : []), operationId],
        pendingSince: previous.followUp?.pendingSince ?? identity.acceptedAt } });
    } };
  }
  const useWaiting = activateQueued || sameFollowUp;
  const pendingIds = useWaiting ? waiting.filter(row => row.id !== operationId).map(row => row.id) :
    sameContext ? priorQueues.filter(row => row.exists && (!["success", "cancelled"].includes(row.data().status) || needsConsumerConfirmation(row.data()))).map(row => row.id) : [];
  requireValue(pendingIds.length < 100);
  const completeBytes = sameContext && previous.finalNamespaceOwner === true && states.every(row =>
    row.data()?.contextOnly === true && row.data()?.taskPath === `cmsPublishQueue/${previous.namespaceOperationId}/backgroundOutputs/${row.id}` &&
    row.data()?.status === "verified" && ownsPublication(row.data(), runtime) &&
    row.data().contextDigest === contextDigest && row.data().receipt?.revision === row.data().revision && row.data().receipt?.rendererSha === runtime.release && row.data().receipt?.contextDigest === contextDigest);
  const originalId = previous?.preparationOperationId;
  const original = completeBytes && /^[A-Za-z0-9]{20}$/.test(originalId ?? "")
    ? await transaction.get(firestore.doc(`cmsPublishQueue/${originalId}/backgroundPreparation/${contextDigest}`)) : null;
  const complete = completeBytes && verifiedPreparation(original?.data(), runtime, contextDigest);
  requireValue(preparationRecoveryOfQueueId === undefined || /^[A-Za-z0-9]{20}$/.test(preparationRecoveryOfQueueId) && completeBytes && !complete);
  const preparationOperationId = complete ? originalId : operationId;
  const namespaceOperationId = complete || preparationRecoveryOfQueueId ? previous.namespaceOperationId ?? originalId : operationId;
  requireValue(/^[A-Za-z0-9]{20}$/.test(namespaceOperationId ?? ""));
  requireValue(preparationOperationId === null || /^[A-Za-z0-9]{20}$/.test(preparationOperationId));
  return { ...result, write() {
    namespace.write();
    for (const priorQueue of sameContext ? [] : priorQueues) {
      if (priorQueue.exists && priorQueue.data().transport === TRANSPORT && samePublicationOwner(priorQueue.data(), runtime) &&
          priorQueue.data().status !== "success") transaction.update(priorQueue.ref,
        { status: "cancelled", error: "public_context_superseded", completedAt: FieldValue.serverTimestamp() });
    }
    if (!useWaiting) for (const row of waiting) transaction.update(row.ref,
      { status: "cancelled", error: "public_context_superseded", completedAt: FieldValue.serverTimestamp() });
    for (const row of preparationRecoveryOfQueueId ? [] : prior) if (row.exists && row.data().contextOnly === true &&
        ownsPublication(row.data(), runtime) && row.data().status !== "verified") transaction.update(row.ref,
      { status: "superseded", claim: null, nextAttemptAt: null });
    const queueValue = { schemaVersion: 1, transport: TRANSPORT, runtime, backgroundRuntime: runtime,
      publicContext: identity, status: "pending", changes: [], createdAt: FieldValue.serverTimestamp(), aggregateReceipt: null,
      ...(preparationRecoveryOfQueueId ? { preparationRecoveryOfQueueId } : {}) };
    if (activateQueued) transaction.update(queueRef, { status: "pending" });
    else transaction.create(queueRef, queueValue);
    const pendingSince = useWaiting ? previous.followUp.pendingSince : previous?.pendingSince ?? identity.acceptedAt;
    transaction.set(currentRef, { ...identity, baselineWithdrawalRevision, preparationOperationId, namespaceOperationId, finalNamespaceOwner: true,
      pendingSince, servingEstablished: previous?.servingEstablished === true || priorQueues.some(row => row.data()?.status === "success"),
      acceptedAt: useWaiting ? previous.followUp.acceptedAt ?? identity.acceptedAt : pendingIds.length ? previous.acceptedAt ?? identity.acceptedAt : identity.acceptedAt,
      operationIds: [...pendingIds, operationId] });
    if (complete) return; // Reuse already verified bytes at the identical public context.
    outputs.forEach((output, index) => {
      const before = states[index].data();
      const revision = (before?.revision ?? 0) + 1;
      requireValue(Number.isSafeInteger(revision) && revision > 0);
      const after = dependency(null);
      const taskRef = queueRef.collection("backgroundOutputs").doc(output);
      transaction.create(taskRef, { schemaVersion: 1, owner: "post-background-v1", runtime, output, revision,
        contextOnly: true, postId: null, contextDigest, status: "pending", attempts: 0, claim: null,
        nextAttemptAt: Date.now(), dependencies: { before: after, after, slugs: [], authorIds: [], mediaIds: [], homePlacementPaths: [] } });
      if (!preparationRecoveryOfQueueId) transaction.set(states[index].ref, { schemaVersion: 1, owner: "post-background-v1", runtime, output, revision,
        contextOnly: true, postId: null, taskPath: taskRef.path, after, contextDigest, status: "pending", receipt: null,
        lastGood: lastGood(before), previousAssets: before?.previousAssets ?? null,
        pendingSince: Number.isFinite(before?.pendingSince) ? Math.min(before.pendingSince, pendingSince) : pendingSince,
        withdrawalDeadline: before?.withdrawalDeadline ?? null, withdrawalDeadlineRevision: before?.withdrawalDeadlineRevision ?? null });
    });
  } };
}

async function contextAliases(transaction, firestore, operationId, runtime, job, current) {
  const ids = current?.contextDigest === job.publicContext.contextDigest && ownsPublication(current, runtime)
    ? current.operationIds ?? [operationId] : [operationId];
  requireValue(Array.isArray(ids) && ids.length <= 100 && ids.every(id => /^[A-Za-z0-9]{20}$/.test(id)));
  const aliases = await transaction.getAll(...ids.map(id => firestore.doc(`cmsPublishQueue/${id}`)));
  requireValue(aliases.every(row => row.data()?.transport === TRANSPORT && ownsPublication(row.data(), runtime) &&
    row.data()?.publicContext?.contextDigest === job.publicContext.contextDigest &&
    JSON.stringify(contextOutputs(row.data()?.publicContext)) === JSON.stringify(contextOutputs(job.publicContext))));
  return aliases;
}

// Consumer proof can finish after aggregate settlement. Retire only completed
// aliases, without rewriting queue completion receipts or waking queue events.
async function retireConfirmedPublicContextAliases({ firestore }) {
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(CURRENT_PATH), selected = (await transaction.get(ref)).data();
    if (!selected || (selected.operationIds ?? []).length < 2) return;
    const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${selected.operationId}`))).data();
    requireValue(queue?.transport === TRANSPORT && ownsPublication(queue, selected.runtime) &&
      queue.publicContext?.contextDigest === selected.contextDigest);
    const aliases = await contextAliases(transaction, firestore, selected.operationId, selected.runtime, queue, selected);
    const ids = aliases.filter(row => row.id === selected.operationId ||
      !["success", "cancelled"].includes(row.data().status) || needsConsumerConfirmation(row.data())).map(row => row.id);
    if (JSON.stringify(ids) !== JSON.stringify(selected.operationIds)) transaction.update(ref, { operationIds: ids });
  });
}

// Preparation failures and family failures are shared outcomes for unfinished
// operations at the same exact context. Completed history stays completed.
async function failPublicContextPreparation({ firestore, operationId, runtime }) {
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(`cmsPublishQueue/${operationId}`);
    const [queue, current] = await transaction.getAll(ref, firestore.doc(CURRENT_PATH));
    const job = queue.data();
    if (!job || job.transport !== TRANSPORT || !ownsPublication(job, runtime) || job.status === "cancelled") return;
    const preparation = await transaction.get(ref.collection("backgroundPreparation").doc(job.publicContext.contextDigest));
    if (!preparation.exists || !ownsPublication(preparation.data(), runtime) || preparation.data().status !== "failed" || preparation.data().attempts < 4) return;
    const anchor = current.data()?.operationId === operationId ? current.data() : undefined;
    const aliases = await contextAliases(transaction, firestore, operationId, runtime, job, anchor);
    for (const alias of aliases) if (["pending", "failed"].includes(alias.data().status)) transaction.update(alias.ref,
      { status: "failed", error: "background_preparation_failed" });
  });
}

/** Completion means every named family exposes immutable bytes at this exact context. */
async function settlePublicContext({ firestore, operationId, runtime }) {
  return firestore.runTransaction(async transaction => {
    const ref = firestore.doc(`cmsPublishQueue/${operationId}`);
    const [queue, context, deployment, current] = await transaction.getAll(ref, firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc("system/publicDeployment"), firestore.doc(CURRENT_PATH));
    const job = queue.data();
    if (!job || job.transport !== TRANSPORT || !ownsPublication(job, runtime) || job.status === "cancelled") return false;
    const outputs = contextOutputs(job.publicContext);
    const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    const selectedPreparation = current.data()?.preparationOperationId
      ? (await transaction.get(firestore.doc(`cmsPublishQueue/${current.data().preparationOperationId}/backgroundPreparation/${job.publicContext.contextDigest}`))).data() : null;
    const exact = deployment.data()?.state === "idle" && deployment.data().activeCommitSha === runtime.release &&
      (publicContextDigest(context.data()?.revision) === job.publicContext.contextDigest ||
        current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime) &&
        frozenContextMatches(selectedPreparation, current.data(), runtime));
    const anchorId = current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime)
      ? current.data().operationId : operationId;
    const anchor = anchorId === operationId ? queue : await transaction.get(firestore.doc(`cmsPublishQueue/${anchorId}`));
    const recoveryPreparation = anchor.data()?.preparationRecoveryOfQueueId
      ? await transaction.get(firestore.doc(`cmsPublishQueue/${anchorId}/backgroundPreparation/${job.publicContext.contextDigest}`)) : null;
    const completeBytes = exact && states.every(row => row.data()?.owner === "post-background-v1" && ownsPublication(row.data(), runtime) &&
      row.data()?.status === "verified" && row.data()?.contextDigest === job.publicContext.contextDigest && row.data()?.receipt?.revision === row.data()?.revision &&
      row.data()?.receipt?.contextDigest === job.publicContext.contextDigest && row.data()?.receipt?.rendererSha === runtime.release);
    const complete = completeBytes && (!anchor.data()?.preparationRecoveryOfQueueId ||
      verifiedPreparation(recoveryPreparation?.data(), runtime, job.publicContext.contextDigest));
    if (complete) {
      const aliases = await contextAliases(transaction, firestore, operationId, runtime, job, current.data());
      for (const alias of aliases.filter(row => row.data().status !== "cancelled")) transaction.update(alias.ref, { status: "success", completedAt: FieldValue.serverTimestamp(), error: null,
        aggregateReceipt: { runtime, contextRevision: job.publicContext.contextRevision, contextDigest: job.publicContext.contextDigest,
          preparationOperationId: current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime)
            ? current.data().preparationOperationId ?? null : null,
          outputs: Object.fromEntries(states.map((row, index) => [outputs[index], { rendererSha: row.data().receipt.rendererSha, contextRevision: job.publicContext.contextRevision, contextDigest: row.data().receipt.contextDigest, verifiedAt: row.data().receipt.verifiedAt, revision: row.data().receipt.revision, digest: row.data().receipt.digest, routeSetDigest: row.data().receipt.routeSetDigest, taskPath: row.data().taskPath }])) } });
      if (current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime)) {
        transaction.update(current.ref, { operationIds: aliases.filter(row => row.id === current.data().operationId || needsConsumerConfirmation(row.data())).map(row => row.id), servingEstablished: true,
          pendingSince: current.data().followUp?.pendingSince ?? null });
      }
    }
    if (!complete && exact) {
      const tasks = await transaction.getAll(...states.filter(row => row.data()?.taskPath).map(row => firestore.doc(row.data().taskPath)));
      const anchorId = current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime)
        ? current.data().operationId : operationId;
      const preparation = await transaction.get(firestore.doc(`cmsPublishQueue/${anchorId}/backgroundPreparation/${job.publicContext.contextDigest}`));
      const preparationFailed = preparation.exists && ownsPublication(preparation.data(), runtime) && retryExhausted(preparation.data());
      if (preparationFailed || tasks.some(row => ownsPublication(row.data(), runtime) && retryExhausted(row.data()))) {
        const aliases = await contextAliases(transaction, firestore, operationId, runtime, job, current.data());
        for (const alias of aliases) if (["pending", "failed"].includes(alias.data().status)) transaction.update(alias.ref,
          { status: "failed", error: preparationFailed ? "background_preparation_failed" : "background_generation_failed" });
      }
    }
    if (exact && job.status === "pending" && current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime)) {
      const progress = states.filter(row => row.data()?.status === "verified" && ownsPublication(row.data(), runtime) &&
        row.data()?.contextDigest === job.publicContext.contextDigest && row.data()?.receipt?.contextDigest === job.publicContext.contextDigest &&
        row.data()?.receipt?.revision === row.data()?.revision && row.data()?.receipt?.rendererSha === runtime.release)
        .map(row => row.data().receipt.verifiedAt).filter(at => Number.isFinite(at) && at >= 0 && at <= Date.now());
      if (progress.length && Math.max(...progress) > (current.data().progressAt ?? 0)) transaction.update(current.ref, { progressAt: Math.max(...progress) });
    }
    return complete;
  });
}

/** A staff retry keeps context and source. Resume paths retain frozen inputs;
 * an invalid complete reference creates one fresh preparation successor. */
async function retryPublicContextInTransaction({ transaction, firestore, operationId, runtime }) {
  await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const [queue, context, deployment, current] = await transaction.getAll(queueRef, firestore.doc(PUBLIC_CONTEXT_PATH),
    firestore.doc("system/publicDeployment"), firestore.doc(CURRENT_PATH));
  const job = queue.data();
  requireValue(job?.transport === TRANSPORT && ownsPublication(job, runtime) &&
    deployment.data()?.activeCommitSha === runtime.release &&
    job.publicContext.contextDigest === publicContextDigest(context.data()?.revision) && job.status !== "cancelled");
  const outputs = contextOutputs(job.publicContext);
  const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
  const complete = states.every(row => row.data()?.status === "verified" && ownsPublication(row.data(), runtime) &&
    row.data().receipt?.revision === row.data().revision && row.data().receipt?.rendererSha === runtime.release &&
    row.data().contextDigest === job.publicContext.contextDigest && row.data().receipt?.contextDigest === job.publicContext.contextDigest);
  const alertEpoch = randomUUID();
  if (complete) {
    requireValue(current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime));
    const aliases = await contextAliases(transaction, firestore, operationId, runtime, job, current.data());
    const reference = current.data().preparationOperationId;
    const preparation = /^[A-Za-z0-9]{20}$/.test(reference ?? "")
      ? await transaction.get(firestore.doc(`cmsPublishQueue/${reference}/backgroundPreparation/${job.publicContext.contextDigest}`)) : null;
    if (verifiedPreparation(preparation?.data(), runtime, job.publicContext.contextDigest)) return () => {
      for (const alias of aliases) if (alias.data().status !== "cancelled") transaction.update(alias.ref, { status: "pending", error: null, alertEpoch });
    };
    const anchor = aliases.find(row => row.id === current.data().operationId);
    requireValue(anchor && (!preparation?.exists || ownsPublication(preparation.data(), runtime)));
    const held = preparation?.data()?.status === "building" || preparation?.data()?.claim != null;
    requireValue(!held || typeof preparation.data().nextAttemptAt === "number" && Number.isFinite(preparation.data().nextAttemptAt) &&
      preparation.data().nextAttemptAt >= 0 && preparation.data().nextAttemptAt <= Date.now());
    if (anchor.data().preparationRecoveryOfQueueId) {
      requireValue(reference === anchor.id);
      return () => {
        // Public verified families remain current while this same private
        // preparation resumes. Do not re-arm public tasks or create a chain.
        if (preparation?.exists && preparation.data().status !== "verified") transaction.update(preparation.ref,
          { status: "failed", attempts: 0, nextAttemptAt: Date.now(), claim: null, error: null });
        for (const alias of aliases) if (alias.data().status !== "cancelled") transaction.update(alias.ref, { status: "pending", error: null, alertEpoch });
      }; // Resume this successor's own reservation; never create a recovery chain.
    }
    requireValue(deployment.data()?.state === "idle");
    const control = await transaction.get(firestore.doc("system/cmsPublicationRuntime"));
    assertCmsPublicationCloudAdmission(control.data() ?? null, { commitSha: runtime.release });
    const successorId = randomUUID().replaceAll("-", "").slice(0, 20);
    const ids = [...new Set([...aliases.filter(row => ["pending", "failed"].includes(row.data().status)).map(row => row.id), operationId, successorId])];
    requireValue(ids.length <= 100);
    const successor = await enqueuePublicContextInTransaction({ transaction, firestore, operationId: successorId, runtime,
      reason: job.publicContext.reason, contextRevision: job.publicContext.contextRevision,
      preparationRecoveryOfQueueId: operationId });
    return () => {
      if (held) transaction.update(preparation.ref, { status: "failed", claim: null, nextAttemptAt: null });
      successor.write();
      transaction.update(current.ref, { operationIds: ids });
      transaction.update(queueRef, { status: "pending", error: null, aggregateReceipt: null, alertEpoch });
    };
  }
  requireValue(current.data()?.contextDigest === job.publicContext.contextDigest && ownsPublication(current.data(), runtime) &&
    /^[A-Za-z0-9]{20}$/.test(current.data().operationId));
  const anchorId = current.data().operationId;
  const preparationRef = firestore.doc(`cmsPublishQueue/${anchorId}/backgroundPreparation/${job.publicContext.contextDigest}`);
  requireValue(states.every(row => row.data()?.contextOnly && row.data().taskPath.split("/")[1] === anchorId && ownsPublication(row.data(), runtime)));
  const tasks = await transaction.getAll(...states.map(row => firestore.doc(row.data().taskPath)));
  const preparation = await transaction.get(preparationRef);
  const aliases = await contextAliases(transaction, firestore, anchorId, runtime, job, current.data());
  requireValue(tasks.every(row => row.exists && ownsPublication(row.data(), runtime)) && (!preparation.exists || ownsPublication(preparation.data(), runtime)));
  return () => {
    if (preparation.data()?.status === "failed" || preparation.data()?.status === "building" && preparation.data()?.nextAttemptAt <= Date.now()) transaction.update(preparationRef,
      { status: "failed", attempts: 0, nextAttemptAt: Date.now(), claim: null, error: null });
    for (const row of tasks) if (row.data().status === "failed") transaction.update(row.ref,
      { status: "pending", attempts: 0, nextAttemptAt: Date.now(), claim: null, error: null });
    for (const alias of aliases) if (alias.data().status !== "cancelled") transaction.update(alias.ref, { status: "pending", error: null, alertEpoch });
  };
}

module.exports = { preparePairContextPublication: options => require("./public-release-family-admission").preparePairContextPublication(options),
  CURRENT_PATH, TRANSPORT, OUTPUTS, missingPublicContextConsumers, verifiedPreparation, frozenContextMatches, canSupersedeFrozenContext, readSelectedPublicContextInTransaction, retainedPublicContextQueueIdsInTransaction,
  publicContextFollowUpQueuesInTransaction, retireConfirmedPublicContextAliases, enqueuePublicContextInTransaction, settlePublicContext, retryPublicContextInTransaction, failPublicContextPreparation };

"use strict";

const { can } = require("./rbac");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { CURRENT_PATH, TRANSPORT, verifiedPreparation, retryPublicContextInTransaction } = require("./public-context-publication");
const { contextOutputs } = require("./no-build-record-namespace");
const { ownsPublication } = require("./publication-runtime-owner");
const { assertCmsPublicationCloudAdmission } = require("./cms-publication-runtime-control");

function refuse(message = "This site update changed. Refresh Publish activity before retrying.", status = 409) {
  throw Object.assign(new Error(message), { status });
}
function genericJob(job, operationId) {
  return job?.schemaVersion === 1 && job.transport === TRANSPORT && job.runtime?.owner === "cloudflare" &&
    /^[a-f0-9]{40}$/.test(job.runtime.release ?? "") && job.publicContext?.operationId === operationId &&
    job.publicContext.schemaVersion === 1 && ownsPublication(job.publicContext, job.runtime) &&
    Number.isSafeInteger(job.publicContext.contextRevision) && job.publicContext.contextRevision > 0 &&
    job.publicContext.contextDigest === publicContextDigest(job.publicContext.contextRevision) &&
    ["context", "provider-refresh"].includes(job.publicContext.reason) &&
    !job.settingsPublication && !job.libraryCardPublication && !job.recordPublication &&
    Array.isArray(job.changes) && job.changes.length === 0;
}

// Only the explicit activity recovery request reads these two documents. No
// polling or additional browser request is needed to discover the current job.
async function genericContextRetry(firestore) {
  const selected = (await firestore.doc(CURRENT_PATH).get()).data();
  const id = selected?.operationId;
  if (!/^[A-Za-z0-9]{20}$/.test(id ?? "")) return null;
  const job = (await firestore.doc(`cmsPublishQueue/${id}`).get()).data();
  return genericJob(job, id) && job.status === "failed" && ownsPublication(selected, job.runtime) &&
    selected.contextDigest === job.publicContext.contextDigest ? { queueId: id, createdAt: job.createdAt?.toDate?.().toISOString() ?? null } : null;
}

async function retryGenericPublicContext({ firestore, actor, operationId, source = null, now = Date.now() }) {
  if (!actor?.uid || !can(actor.principal, "settings.manage", {})) refuse("Site settings access is required to retry this update.", 403);
  if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) refuse("Choose one site update to retry.", 400);
  return firestore.runTransaction(async transaction => {
    const [queue, current, context, deployment, control, billing] = await transaction.getAll(
      firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(CURRENT_PATH), firestore.doc(PUBLIC_CONTEXT_PATH),
      firestore.doc("system/publicDeployment"), firestore.doc("system/cmsPublicationRuntime"), firestore.doc("system/billing"));
    const job = queue.data(), selected = current.data();
    if (!genericJob(job, operationId) || !["failed", "pending"].includes(job.status) ||
        selected?.operationId !== operationId || !ownsPublication(selected, job.runtime) ||
        selected.contextDigest !== job.publicContext.contextDigest || selected.contextRevision !== job.publicContext.contextRevision || context.data()?.schemaVersion !== 1 ||
        publicContextDigest(context.data()?.revision) !== job.publicContext.contextDigest ||
        deployment.data()?.state !== "idle" || deployment.data()?.activeCommitSha !== job.runtime.release || billing.data()?.disabled === true) refuse();
    assertCmsPublicationCloudAdmission(control.data() ?? null, { commitSha: job.runtime.release });
    const preparationId = selected.preparationOperationId;
    if (!/^[A-Za-z0-9]{20}$/.test(preparationId ?? "")) refuse();
    const preparation = await transaction.get(firestore.doc(`cmsPublishQueue/${preparationId}/backgroundPreparation/${selected.contextDigest}`));
    const outputs = contextOutputs(job.publicContext);
    const states = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    if (states.some(row => !ownsPublication(row.data(), job.runtime) || typeof row.data()?.taskPath !== "string" ||
        !/^cmsPublishQueue\/[A-Za-z0-9]{20}\/backgroundOutputs\/[A-Za-z0-9_-]+$/.test(row.data().taskPath))) refuse();
    const tasks = await transaction.getAll(...states.map(row => firestore.doc(row.data().taskPath)));
    const prepared = preparation.data();
    if (prepared && (!ownsPublication(prepared, job.runtime) || prepared.contextDigest !== selected.contextDigest)) refuse();
    const held = value => value && (value.claim != null || value.status === "building") &&
      !(Number.isFinite(value.nextAttemptAt) && value.nextAttemptAt >= 0 && value.nextAttemptAt <= now);
    if (held(prepared) || tasks.some(row => !ownsPublication(row.data(), job.runtime) || held(row.data()))) {
      refuse("This site update is still running. Refresh Publish activity before retrying.");
    }
    // The generic staff surface resumes existing frozen work. The core's
    // exceptional fresh-preparation successor remains an operator-only choice.
    const complete = states.every(row => row.data().status === "verified" && row.data().receipt?.revision === row.data().revision &&
      row.data().receipt?.rendererSha === job.runtime.release && row.data().contextDigest === job.publicContext.contextDigest &&
      row.data().receipt?.contextDigest === job.publicContext.contextDigest);
    if (complete && !verifiedPreparation(prepared, job.runtime, selected.contextDigest)) refuse("This site update needs an administrator's preparation repair.");
    if (!complete && preparationId !== operationId) refuse("This site update needs an administrator's preparation repair.");
    const result = { success: true, queueId: operationId, status: "pending", message: "Retrying the accepted site update." };
    if (job.status === "pending") return result;
    const write = await retryPublicContextInTransaction({ transaction, firestore, operationId, runtime: job.runtime }).catch(error => {
      if (error.message === "Public context publication refused") refuse();
      throw error;
    });
    write();
    // Join the existing activity history using the original acceptance time.
    // This metadata does not change the operation, source or frozen cutoff.
    if (!job.triggeredAt && job.createdAt) transaction.update(queue.ref, { triggeredAt: job.createdAt });
    for (const row of tasks) if (row.data().claim != null && ["failed", "building"].includes(row.data().status)) {
      transaction.update(row.ref, { status: "pending", attempts: 0, claim: null, nextAttemptAt: now, error: null });
    }
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "cms.siteUpdateRetried", target: operationId, source,
      before: { status: job.status }, after: { status: "pending", contextDigest: selected.contextDigest, preparationOperationId: preparationId } }));
    return result;
  });
}

module.exports = { genericContextRetry, retryGenericPublicContext };

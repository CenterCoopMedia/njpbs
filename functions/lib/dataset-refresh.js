"use strict";
const { DatasetError, validDatasetId } = require("./datasets");
const { digest, figureBlocks, validateFrozenDatasetFigures, readApprovedDatasetProjection } = require("./dataset-dependencies");
const { prepareDatasetUsageWrites, useId } = require("./dataset-usage");
const { assertSameSourceRefresh, editorialSnapshotDigest } = require("./dataset-refresh-identity");
const { hasElectionResults, readElectionEditorialDigest } = require("./election-source-lineage");
const { publiclyVisible } = require("./public-video-references");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const fail = message => { throw new DatasetError(message, 409); };
const ownerPath = (collection, documentId) => collection === "cmsPages"
  ? `system/publicDeployment/noBuildPageOwners/${documentId}` : `system/publicDeployment/noBuildPostOwners/${documentId}`;
const ownerKey = row => digest([row.collection, row.documentId]);
const terminal = task => ["verified", "superseded"].includes(task.status);
const transientCodes = new Set([4, 8, 10, 13, 14,
  "deadline-exceeded", "resource-exhausted", "aborted", "internal", "unavailable"]);
function affectedUse(use, action, releaseId) {
  return action === "archive" || action === "correction" && use.releaseId === releaseId || action === "new_release" && use.releasePolicy === "latestApproved";
}
async function captureDatasetRefresh({ firestore, transaction, datasetId, action, releaseId, revision, approvedDigest, expectedUseCount, requestId }) {
  const uses = await transaction.get(firestore.collection("cmsDatasetUses").where("datasetId", "==", datasetId).limit(501));
  if (uses.size > 500) fail("This dataset exceeds 500 published uses.");
  if (uses.docs.some(row => !["cmsPages", "cmsPosts"].includes(row.data().collection) || !validDatasetId(row.data().documentId) ||
    !validDatasetId(row.data().blockId) || !["pinned", "latestApproved"].includes(row.data().releasePolicy))) fail("A dataset use needs repair before approval.");
  const affected = uses.docs.filter(row => affectedUse(row.data(), action, releaseId));
  if (affected.length !== expectedUseCount) fail("The affected use count changed. Review it again.");
  const owners = new Map();
  const storedEditorialDigests = new Map();
  for (const row of affected) {
    const use = row.data();
    if (!["cmsPages", "cmsPosts"].includes(use.collection) || !validDatasetId(use.documentId) || !validDatasetId(use.blockId) || row.id !== useId(use)) fail("A dataset use needs repair before approval.");
    const key = ownerKey(use);
    if (!owners.has(key)) {
      const owner = (await transaction.get(firestore.doc(ownerPath(use.collection, use.documentId)))).data();
      if (!owner?.visible || !/^[A-Za-z0-9]{20}$/.test(owner.operationId ?? "") || owner.operationId !== use.operationId ||
        use.sourceVersion !== owner.sourceVersion || owner.snapshotDigest !== use.ownerSnapshotDigest) fail("A dataset use has no current compiled publication owner.");
      const content = (await transaction.get(firestore.doc(`${use.collection}/${use.documentId}`))).data();
      const lineageEligible = hasElectionResults(content?.published) && digest(content.published) === use.snapshotDigest;
      // A maintenance rewrite keeps the existing per-owner failure path rather
      // than blocking approval for every use. Only a matching snapshot may
      // capture the lineage proof and its additional working-version anchor.
      const editorialDigest = lineageEligible ? await readElectionEditorialDigest({ firestore, transaction, collection: use.collection,
        documentId: use.documentId, document: content }) : use.editorialSnapshotDigest;
      storedEditorialDigests.set(key, use.editorialSnapshotDigest);
      owners.set(key, { key, collection: use.collection, documentId: use.documentId,
        ownerTitle: use.ownerTitle ?? "Published content", sourceVersion: use.sourceVersion, snapshotDigest: use.snapshotDigest,
        editorialSnapshotDigest: editorialDigest, ...(lineageEligible && Number.isSafeInteger(content.version) ? { workingVersion: content.version } : {}), operationId: owner.operationId, uses: [] });
    }
    const capture = owners.get(key);
    if (capture.snapshotDigest !== use.snapshotDigest || capture.sourceVersion !== use.sourceVersion ||
      !/^[a-f0-9]{64}$/.test(use.editorialSnapshotDigest ?? "") || storedEditorialDigests.get(key) !== use.editorialSnapshotDigest ||
      !/^[a-f0-9]{64}$/.test(use.snapshotDigest ?? "") || !/^[a-f0-9]{64}$/.test(use.approvedDigest ?? "") ||
      !validDatasetId(use.releaseId) || !Number.isSafeInteger(use.revision) || use.revision < 1 ||
      !["pinned", "latestApproved"].includes(use.releasePolicy)) fail("A dataset use changed. Publish or repair it before approval.");
    capture.uses.push({ id: row.id, blockId: use.blockId, releaseId: use.releaseId, revision: use.revision, approvedDigest: use.approvedDigest, releasePolicy: use.releasePolicy });
  }
  const captures = [...owners.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const owner of captures) owner.uses.sort((a, b) => a.blockId.localeCompare(b.blockId));
  const job = { schemaVersion: 1, datasetId, action, releaseId: releaseId ?? null, revision: revision ?? null,
    approvedDigest: approvedDigest ?? null, expectedUseCount, expectedOwnerCount: captures.length,
    captures, captureDigest: digest(captures), status: captures.length ? "preparing" : "success", cursor: 0,
    verifiedOwnerCount: 0, supersededOwnerCount: 0, failedOwnerCount: 0, lastProcessedAt: Date.now(), createdAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(job)) > 750 * 1024) fail("This dataset refresh is too large.");
  const ref = firestore.doc(`cmsDatasetRefreshJobs/${digest([datasetId, requestId]).slice(0, 32)}`);
  if (!captures.length) job.receipt = { schemaVersion: 1, jobId: ref.id, datasetId, captureDigest: job.captureDigest,
    action, releaseId: releaseId ?? null, revision: revision ?? null, approvedDigest: approvedDigest ?? null,
    sortedOwnerReceiptDigests: [], expectedUseCount: 0, expectedOwnerCount: 0, verifiedOwnerCount: 0, supersededOwnerCount: 0, failedOwnerCount: 0,
    ownerReceiptsDigest: digest([]), completedAt: job.createdAt };
  return { ref, job, write: () => transaction.create(ref, job) };
}
function patchFigures(snapshot, job, projection) {
  const affected = new Set(job.capture.uses.map(use => use.blockId));
  const figures = snapshot.datasetFigures.figures.map(binding => {
    if (!affected.has(binding.blockId)) return binding;
    return job.action === "archive" ? { blockId: binding.blockId, datasetId: job.datasetId, withdrawn: true } :
      { blockId: binding.blockId, datasetId: job.datasetId, releaseId: projection.releaseId, revision: projection.revision, digest: projection.digest };
  });
  const releases = [...snapshot.datasetFigures.releases, ...(projection ? [projection] : [])];
  const retained = [...new Map(releases.filter(release => figures.some(binding => !binding.withdrawn && binding.datasetId === release.datasetId &&
    binding.releaseId === release.releaseId && binding.revision === release.revision && binding.digest === release.digest))
    .map(release => [`${release.datasetId}/${release.releaseId}/${release.revision}/${release.digest}`, release])).values()]
    .sort((a, b) => `${a.datasetId}/${a.releaseId}`.localeCompare(`${b.datasetId}/${b.releaseId}`));
  const next = { ...snapshot, datasetFigures: { figures, releases: retained } };
  validateFrozenDatasetFigures(next);
  return next;
}
function carriesTarget(snapshot, job, capture) {
  try { validateFrozenDatasetFigures(snapshot); } catch { return false; }
  return capture.uses.every(use => {
    const block = figureBlocks(snapshot).find(block => block.id === use.blockId);
    if (!block || block.data.datasetId !== job.datasetId || block.data.version.mode !== use.releasePolicy ||
      block.data.version.mode === "pinned" && block.data.version.releaseId !== use.releaseId) return true;
    const binding = snapshot.datasetFigures.figures.find(binding => binding.blockId === use.blockId);
    return job.action === "archive" ? binding?.withdrawn === true : binding && binding.releaseId === job.releaseId &&
      binding.revision === job.revision && binding.digest === job.approvedDigest;
  });
}
function preservesCapturedUse(snapshot, job, capture, editorialDigest = editorialSnapshotDigest(snapshot)) {
  if (editorialDigest !== capture.editorialSnapshotDigest) return false;
  validateFrozenDatasetFigures(snapshot);
  return capture.uses.every(use => snapshot.datasetFigures.figures.some(binding =>
    binding.blockId === use.blockId && binding.datasetId === job.datasetId && binding.releaseId === use.releaseId &&
    binding.revision === use.revision && binding.digest === use.approvedDigest));
}
/** Reserve one same-source publication. Its ordinary owner verifies actual bytes. */
async function reserveOwner({ firestore, jobRef, taskRef }) {
  return firestore.runTransaction(async transaction => {
    const job = (await transaction.get(jobRef)).data();
    const task = (await transaction.get(taskRef)).data();
    // Another processor can fail a task after this run selected its query row.
    // Only the explicit retry action can make that task pending again.
    if (!job || task?.status !== "pending" || task.operationId) return;
    const capture = task.capture;
    const contentRef = firestore.doc(`${capture.collection}/${capture.documentId}`);
    const content = (await transaction.get(contentRef)).data();
    const owner = (await transaction.get(firestore.doc(ownerPath(capture.collection, capture.documentId)))).data();
    if (!content?.published || !owner?.operationId) fail("The published dataset owner is unavailable.");
    const same = digest(content.published) === capture.snapshotDigest && owner.operationId === capture.operationId;
    if (!same) {
      if (!owner.visible || carriesTarget(content.published, job, capture)) {
        transaction.update(taskRef, { status: "pending", operationId: owner.operationId, sourceVersion: owner.sourceVersion,
          snapshotDigest: owner.snapshotDigest, datasetFiguresDigest: owner.datasetFiguresDigest ?? null, superseded: true });
        return;
      }
      // Another dataset may have refreshed this same publication. Merge only
      // when every editorial field and this job's captured bindings are intact.
      const editorialDigest = await readElectionEditorialDigest({ firestore, transaction, collection: capture.collection,
        documentId: capture.documentId, document: content });
      if (hasElectionResults(content.published) && capture.workingVersion !== undefined && capture.workingVersion !== content.version ||
        !preservesCapturedUse(content.published, job, capture, editorialDigest)) fail("The published content changed. Review its current publication before retrying this dataset owner.");
    }
    let projection = null;
    if (job.action !== "archive") {
      projection = await readApprovedDatasetProjection({ firestore, transaction, datasetId: job.datasetId,
        version: { mode: "pinned", releaseId: job.releaseId } });
      if (projection.revision !== job.revision || projection.digest !== job.approvedDigest) fail("The approved dataset target changed.");
    }
    const published = patchFigures(content.published, { ...job, capture }, projection);
    const queueRef = firestore.collection("cmsPublishQueue").doc();
    const nextDocument = { ...content, published, publishBuildPending: true, publishBuildQueueId: queueRef.id };
    assertSameSourceRefresh(content, nextDocument);
    const prepared = await require("./no-build-content-publication").prepareNoBuildContentPublication({ firestore, transaction,
      collection: capture.collection, documentId: capture.documentId, nextDocument, queueRef,
      actor: { uid: "system:dataset-refresh" }, dependencyRefresh: true });
    if (!prepared) fail("The compiled publication owner is unavailable for dataset refresh.");
    // Post's public reader and Page's complete context limits are checked by the
    // existing owners. Enforce the Post frozen input before acceptance as well.
    if (capture.collection === "cmsPosts" && Buffer.byteLength(JSON.stringify(published)) > 2 * 1024 * 1024) fail("The refreshed Post exceeds its public input limit.");
    const writeUsage = await prepareDatasetUsageWrites({ firestore, transaction, collection: capture.collection,
      documentId: capture.documentId, snapshot: published, previousSnapshot: content.published, operationId: prepared.operation.operationId,
      visible: publiclyVisible(content), withdrawalPending: job.action === "archive" });
    prepared.write(); writeUsage();
    transaction.update(queueRef, { datasetRefreshJobId: jobRef.id });
    transaction.update(contentRef, { published, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
    transaction.update(taskRef, { status: "pending", operationId: prepared.operation.operationId,
      sourceVersion: prepared.operation.sourceVersion, snapshotDigest: prepared.operation.snapshotDigest,
      datasetFiguresDigest: prepared.operation.datasetFiguresDigest ?? null, superseded: false, error: null });
  });
}
/** A later context operation can replace a Page's original aggregate job. */
async function readCompletedPageContext({ firestore, transaction, queue, rendererSha, contextDigest, contextRevision }) {
  if (!queue.contextPublication) return null;
  const contexts = require("./public-context-publication");
  let contextJob = (await transaction.get(firestore.doc(`cmsPublishQueue/${queue.contextPublication.queueId}`))).data();
  const current = (await transaction.get(firestore.doc(contexts.CURRENT_PATH))).data();
  if (!/^[A-Za-z0-9]{20}$/.test(current?.operationId ?? "") || current.contextDigest !== contextDigest ||
      current.runtime?.release !== rendererSha || current.runtime?.owner !== "cloudflare") {
    if (contextJob?.status === "success") return contextJob;
    // A superseded waiting producer follows the latest pending context while
    // the selected frozen cohort finishes. Its cancellation is not a failure.
    if (contextJob?.status === "cancelled" && contextJob.error === "public_context_superseded" &&
        current?.schemaVersion === 1 && /^[A-Za-z0-9]{20}$/.test(current.operationId ?? "") &&
        current.runtime?.owner === "cloudflare" && current.runtime.release === rendererSha &&
        Number.isSafeInteger(current.contextRevision) && current.contextRevision > 0 && current.contextRevision < contextRevision &&
        current.contextDigest === publicContextDigest(current.contextRevision)) return null;
    if (["cancelled", "failed"].includes(contextJob?.status)) fail("The Page aggregate check needs a retry.");
    return null;
  }
  contextJob = (await transaction.get(firestore.doc(`cmsPublishQueue/${current.operationId}`))).data();
  if (["cancelled", "failed"].includes(contextJob?.status)) fail("The Page aggregate check failed. Retry this dataset owner.");
  if (contextJob?.status !== "success") return null;
  const aggregate = contextJob.aggregateReceipt;
  if (contextJob.transport !== contexts.TRANSPORT || contextJob.publicContext?.operationId !== current.operationId ||
      contextJob.publicContext.contextDigest !== contextDigest || aggregate?.contextDigest !== contextDigest ||
      aggregate.runtime?.owner !== "cloudflare" || aggregate.runtime.release !== rendererSha ||
      aggregate.contextRevision !== current.contextRevision ||
      JSON.stringify(Object.keys(aggregate.outputs ?? {}).sort()) !== JSON.stringify(require("./no-build-record-namespace").contextOutputs(contextJob.publicContext).sort())) {
    fail("The current Page aggregate receipt does not match its owner.");
  }
  return contextJob;
}
async function verifyOwner({ firestore, jobRef, taskRef }) {
  return firestore.runTransaction(async transaction => {
    const job = (await transaction.get(jobRef)).data();
    const task = (await transaction.get(taskRef)).data();
    if (!job || task?.status !== "pending" || !task.operationId) return;
    const capture = task.capture;
    const retainedOwner = (await transaction.get(firestore.doc(ownerPath(capture.collection, capture.documentId)))).data();
    const ownership = capture.collection === "cmsPages" ? require("./no-build-page-ownership") : require("./no-build-post-ownership");
    const capability = await (capture.collection === "cmsPages" ? ownership.readNoBuildPageCapability : ownership.readNoBuildPostCapability)({ firestore, transaction });
    const owner = (capture.collection === "cmsPages" ? ownership.effectiveNoBuildPageState : ownership.effectiveNoBuildPostState)(retainedOwner, capability);
    const content = (await transaction.get(firestore.doc(`${capture.collection}/${capture.documentId}`))).data();
    if (!owner?.operationId || !content?.published) fail("The published dataset owner is unavailable.");
    if (owner.operationId !== task.operationId) {
      if (owner?.visible && !carriesTarget(content?.published, job, capture)) fail("The refreshed publication changed. Retry this dataset owner.");
      transaction.update(taskRef, { operationId: owner.operationId, sourceVersion: owner.sourceVersion,
        snapshotDigest: owner.snapshotDigest, datasetFiguresDigest: owner.datasetFiguresDigest ?? null, superseded: true });
      return;
    }
    const queue = (await transaction.get(firestore.doc(`cmsPublishQueue/${task.operationId}`))).data();
    const receipt = queue?.publicReceipt;
    if (queue?.status === "failed" || queue?.postProof?.status === "failed" && queue.postProof.nextAttemptAt === null) {
      transaction.update(taskRef, { status: "failed", error: "The public check failed. Retry this dataset owner." }); return;
    }
    if (!receipt || queue.status !== "success" || capture.collection === "cmsPosts" && owner.visible && queue.postProof?.status !== "verified") return;
    if (receipt.visible !== owner.visible || receipt.operationId !== task.operationId || receipt.sourceVersion !== task.sourceVersion || receipt.snapshotDigest !== task.snapshotDigest ||
      (receipt.datasetFiguresDigest ?? null) !== task.datasetFiguresDigest || receipt.rendererSha !== owner.rendererSha ||
      owner.sourceVersion !== task.sourceVersion || owner.visible && !carriesTarget(content?.published, job, capture)) fail("The dataset public receipt does not match its owner.");
    if (capture.collection === "cmsPosts" ? owner.visible && (owner.contentRedirectUrl
      ? receipt.contentRedirectUrl !== owner.contentRedirectUrl || receipt.htmlDigest !== null
      : receipt.contentRedirectUrl || !/^[a-f0-9]{64}$/.test(receipt.htmlDigest ?? "")) :
      owner.visible && owner.contentRedirectUrl && !receipt.routes?.some(route => route.path === owner.path && route.status === 302) ||
      !receipt.routes?.every(route => route.status === 302
        ? owner.visible && owner.contentRedirectUrl && route.location === owner.contentRedirectUrl && route.htmlDigest === null
        : route.status !== 200 || /^[a-f0-9]{64}$/.test(route.htmlDigest ?? ""))) fail("The dataset public receipt is incomplete.");
    const contextRevision = await readPublicContextRevisionInTransaction(transaction, firestore);
    const contextDigest = publicContextDigest(contextRevision);
    const contextJob = await readCompletedPageContext({ firestore, transaction, queue, rendererSha: owner.rendererSha, contextDigest, contextRevision });
    if (queue.contextPublication && !contextJob) return;
    const outputs = require("./no-build-record-namespace").contextOutputs(contextJob?.publicContext);
    const background = await transaction.getAll(...outputs.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    if (!background.every(row => row.data()?.status === "verified" && row.data().receipt?.revision === row.data().revision &&
      row.data().receipt.contextDigest === contextDigest && row.data().receipt.rendererSha === owner.rendererSha &&
      /^[a-f0-9]{64}$/.test(row.data().receipt.routeSetDigest ?? ""))) return;
    const proof = { collection: capture.collection, documentId: capture.documentId, blockIds: capture.uses.map(use => use.blockId),
      sourceVersion: task.sourceVersion, operationId: task.operationId, snapshotDigest: task.snapshotDigest,
      datasetFiguresDigest: task.datasetFiguresDigest, rendererSha: receipt.rendererSha,
      detailReceiptDigest: digest(receipt), contextDigest, backgroundReceiptDigest: digest(background.map(row => row.data().receipt)),
      ...(contextJob ? { aggregateReceiptDigest: digest(contextJob.aggregateReceipt) } : {}), outcome: task.superseded ? "superseded" : "verified" };
    if (job.action === "archive") {
      const uses = await transaction.get(firestore.collection("cmsDatasetUses").where("datasetId", "==", job.datasetId).limit(501));
      const recordRef = firestore.doc(`cmsDatasets/${job.datasetId}`);
      const record = (await transaction.get(recordRef)).data();
      const capturedIds = new Set(capture.uses.map(use => use.id));
      const removed = uses.docs.filter(row => capturedIds.has(row.id) && row.data().state === "withdrawal_pending");
      for (const row of removed) transaction.delete(row.ref);
      if (removed.length && record) transaction.update(recordRef, { publishedUseCount: uses.size - removed.length, usageRevision: (record.usageRevision ?? 0) + 1 });
    }
    transaction.update(taskRef, { status: proof.outcome, receipt: proof, receiptDigest: digest(proof), error: null });
  });
}
async function processDatasetRefreshJob({ firestore, jobId, maxOwners = 5 }) {
  const jobRef = firestore.doc(`cmsDatasetRefreshJobs/${jobId}`);
  await firestore.runTransaction(async transaction => {
    const job = (await transaction.get(jobRef)).data();
    if (!job || job.status === "success") return;
    if (job.captureDigest !== digest(job.captures)) fail("The dataset refresh capture changed.");
    const next = Math.min(job.cursor + 20, job.captures.length);
    if (next === job.cursor) return;
    for (const capture of job.captures.slice(job.cursor, next)) transaction.create(jobRef.collection("owners").doc(capture.key), { capture, status: "pending", operationId: null });
    transaction.update(jobRef, { cursor: next, status: next === job.captures.length ? "pending" : "preparing", lastProcessedAt: Date.now() });
  });
  const tasks = await jobRef.collection("owners").orderBy("__name__").get();
  const pending = tasks.docs.filter(row => row.data().status === "pending");
  const currentJob = (await jobRef.get()).data();
  const offset = (currentJob?.workCursor ?? 0) % Math.max(1, pending.length);
  const selected = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, maxOwners);
  for (const row of selected) {
    try { await reserveOwner({ firestore, jobRef, taskRef: row.ref }); await verifyOwner({ firestore, jobRef, taskRef: row.ref }); }
    catch (error) {
      // The minute recovery resumes temporary publisher fences and exhausted
      // database retries. Identity conflicts still require a staff retry.
      if (error.scheduleDeferred === true || error.code === "failed-precondition" || transientCodes.has(error.code)) continue;
      await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(row.ref)).data();
        if (!current || terminal(current)) return;
        transaction.update(row.ref, { status: "failed", error: error.status === 409 ? error.message : "Dataset refresh is unavailable. Retry this owner." });
      });
    }
  }
  await firestore.runTransaction(async transaction => {
    const job = (await transaction.get(jobRef)).data();
    if (!job || job.status === "success" || job.cursor !== job.captures.length) return;
    const rows = await transaction.get(jobRef.collection("owners").orderBy("__name__"));
    const verifiedOwnerCount = rows.docs.filter(row => row.data().status === "verified").length;
    const supersededOwnerCount = rows.docs.filter(row => row.data().status === "superseded").length;
    const failedOwnerCount = rows.docs.filter(row => row.data().status === "failed").length;
    const success = rows.size === job.expectedOwnerCount && verifiedOwnerCount + supersededOwnerCount === job.expectedOwnerCount;
    const status = success ? "success" : failedOwnerCount ? "partial" : "pending";
    const counts = { verifiedOwnerCount, supersededOwnerCount, failedOwnerCount };
    const workCursor = (offset + selected.length) % Math.max(1, pending.length);
    transaction.update(jobRef, { status, workCursor, lastProcessedAt: Date.now(), ...counts, ...(success ? { receipt: { schemaVersion: 1, jobId, action: job.action,
      datasetId: job.datasetId, releaseId: job.releaseId, revision: job.revision, approvedDigest: job.approvedDigest,
      captureDigest: job.captureDigest, expectedUseCount: job.expectedUseCount, expectedOwnerCount: job.expectedOwnerCount,
      ...counts, sortedOwnerReceiptDigests: rows.docs.map(row => row.data().receiptDigest).sort(),
      ownerReceiptsDigest: digest(rows.docs.map(row => row.data().receiptDigest).sort()), completedAt: new Date().toISOString() } } : {}) });
  });
}
async function retryDatasetRefreshJob({ firestore, jobId, actor }) {
  const jobRef = firestore.doc(`cmsDatasetRefreshJobs/${jobId}`);
  const job = (await jobRef.get()).data();
  if (!job || job.status === "success") return;
  const tasks = await jobRef.collection("owners").where("status", "==", "failed").get();
  for (const row of tasks.docs) {
    const task = row.data();
    if (task.operationId) {
      const content = (await firestore.doc(`${task.capture.collection}/${task.capture.documentId}`).get()).data();
      const owner = (await firestore.doc(ownerPath(task.capture.collection, task.capture.documentId)).get()).data();
      if (owner?.operationId === task.operationId) {
        const change = { collection: task.capture.collection, id: task.capture.documentId, sourceVersion: owner.sourceVersion,
          ...(!owner.visible ? { operation: "withdraw" } : {}) };
        const retry = task.capture.collection === "cmsPages" ? require("./no-build-page-recovery").existingNoBuildPagePublication :
          require("./no-build-post-recovery").existingNoBuildPostPublication;
        await retry({ firestore, changes: [change], retry: true, actor, baseVersion: content.version });
      }
    }
    await firestore.runTransaction(async transaction => {
      const current = (await transaction.get(row.ref)).data();
      if (current?.status === "failed") transaction.update(row.ref, { status: "pending", error: null });
    });
  }
  await firestore.runTransaction(async transaction => {
    const current = (await transaction.get(jobRef)).data();
    if (current && current.status !== "success") transaction.update(jobRef, { status: "pending", lastProcessedAt: 0, retryNonce: new Date().toISOString() });
  });
}
async function recoverDatasetRefreshJobs({ firestore, jobId } = {}) {
  if (jobId) return processDatasetRefreshJob({ firestore, jobId });
  const jobs = await firestore.collection("cmsDatasetRefreshJobs").where("status", "in", ["preparing", "pending", "partial"]).orderBy("lastProcessedAt").limit(5).get();
  for (const job of jobs.docs) await processDatasetRefreshJob({ firestore, jobId: job.id });
}
module.exports = { affectedUse, captureDatasetRefresh, patchFigures, carriesTarget, processDatasetRefreshJob, recoverDatasetRefreshJobs, retryDatasetRefreshJob };

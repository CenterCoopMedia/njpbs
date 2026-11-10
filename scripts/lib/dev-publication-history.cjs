"use strict";

const { createHash } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const h = require("../../functions/lib/dev-publication-history");
const d = require("../../functions/lib/public-deployment");
const { assertPublicWorkerCandidateMatchesBatch } = require("../../functions/lib/public-worker-candidate");
const { parseCmsPublicationRuntimeControl } = require("../../functions/lib/cms-publication-runtime-control");
const target = require("../../functions/lib/publication-target").publicationTarget("development");
const BATCHES = "system/publicDeployment/buildBatches";
const RECEIPTS = "system/devPublicationHistory/operations";
const terminal = ["success", "failure", "failed", "public_unconfirmed", "cancelled", "superseded", "deployed"];
const { refuse, digest } = h;
const { exact } = require("../../functions/lib/public-release-pair");
const dataRows = rows => rows.map(row => ({ id: row.id, data: row.data() })).sort((a, b) => a.id.localeCompare(b.id));
async function rows(db, tx, path) {
  const result = await tx.get(db.collection(path).limit(1001));
  if (result.size > 1000) refuse();
  return result.docs;
}
function unclaimed(value) {
  if (value == null || typeof value !== "object") return;
  // serializerClaim on a terminal queue is retained evidence, not a live claim.
  if (value.claim != null || value.nextAttemptAt != null || value.deploymentClaim != null) refuse();
  for (const [key, child] of Object.entries(value)) {
    if (key !== "serializerClaim" && child && typeof child === "object" && typeof child.toMillis !== "function") unclaimed(child);
  }
}
function originalBatch(batch, row, request, source, saved) {
  if (!saved) return batch;
  if (row.status === "reserved") {
    h.assertDevHistoricalRetiredBatch(batch, row.buildBatchId);
    const { retiredAt, retirementReceipt, ...original } = batch;
    if (digest(retirementReceipt) !== digest(h.retirementReceipt(request, row, source, { ...original, status: "reserved" })) ||
        !retiredAt.isEqual(saved.committedAt)) refuse();
    return { ...original, status: "reserved" };
  }
  d.assertPublicDeploymentLeaseBatch(batch, row.buildBatchId);
  const { supersededAt, supersededReason, supersededByGeneration, supersededByBuildBatchId, ...original } = batch;
  if (batch.status !== "superseded" || supersededReason !== "newer_eligible_generation" ||
      supersededByGeneration !== 125 || supersededByBuildBatchId !== request.active.buildBatchId ||
      !supersededAt.isEqual(saved.committedAt)) refuse();
  return { ...original, status: "ready" };
}
function bind(object, key, value, planning) {
  if (planning && object[key] === null) object[key] = value;
  else if (object[key] !== value) refuse();
}
async function state(db, tx, request, source, planning = false) {
  const a = request.active;
  const paths = [`${RECEIPTS}/${request.operationId}`, auditPath(request), "system/publicDeployment", "system/cmsPublicationRuntime",
    `${BATCHES}/${a.buildBatchId}`, `${BATCHES}/${a.buildBatchId}/candidates/worker`,
    "system/publicDeployment/releaseWriter/fence", "system/publicReleaseChanges", "system/publicReleaseChangeLog",
    "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseAdmissions/controls/bootstrapFence", "system/devPublication"];
  const [receipt, auditRow, pointerRow, pinsRow, activeBatchRow, activeCandidateRow, ...later] = await tx.getAll(...paths.map(path => db.doc(path)));
  const saved = receipt.data();
  if (saved && planning) refuse();
  if (saved) {
    const { committedAt, ...identity } = saved;
    if (!receipt.createTime.isEqual(receipt.updateTime) || d.timestampMillis(committedAt) === null ||
        digest(identity) !== digest(operation(request, source))) refuse();
    const { timestamp, at, ...audit } = auditRow.data() ?? {};
    if (!auditRow.exists || !auditRow.createTime.isEqual(auditRow.updateTime) || !timestamp?.isEqual(committedAt) ||
        !auditRow.createTime.isEqual(receipt.createTime) || !Number.isFinite(Date.parse(at)) || digest(audit) !== digest(auditFields(request, source))) refuse();
  }
  else if (auditRow.exists) refuse();
  const pointer = d.assertPublicDeploymentPointer(pointerRow.data());
  const pins = parseCmsPublicationRuntimeControl(pinsRow.data());
  const activeBatch = d.assertPublicDeploymentTerminalBatchStructure(activeBatchRow.data(), a.buildBatchId);
  const candidate = assertPublicWorkerCandidateMatchesBatch(activeCandidateRow.data(), activeBatch, { target });
  bind(a, "pointerDigest", digest(pointer), planning);
  bind(a, "runtimeDigest", digest(pins), planning);
  bind(a, "batchDigest", digest(activeBatch), planning);
  bind(a, "candidateDigest", digest(candidate), planning);
  if (later.some(row => row.exists) || pointer.state !== "idle" || pointer.mediaLifecycleReady !== true ||
      pointer.activeGeneration !== 125 || pointer.lastReservedGeneration !== 125 || pointer.newestEligibleGeneration !== 125 ||
      pointer.newestEligibleBuildBatchId !== a.buildBatchId || pointer.activeCommitSha !== a.commitSha || pointer.activeDeploymentId !== a.deploymentId ||
      pins.phase !== "ready" || pins.commitSha !== a.commitSha || pins.cloud?.phase !== "ready" || pins.cloud.commitSha !== a.commitSha ||
      pins.cloud.serializerId !== target.serializerId || [target.serializerId, "cloudflare-publisher"].includes(pins.serializerId) ||
      activeBatch.status !== "deployed" || activeBatch.generation !== 125 || activeBatch.commitSha !== a.commitSha ||
      activeBatch.runtime?.owner !== "cloudflare" || activeBatch.deploymentId !== a.deploymentId || activeBatch.deploymentVersionId !== a.versionId ||
      candidate.workerVersionId !== a.versionId || candidate.publicationReceiptDigest !== createHash("sha256").update(a.publicReceiptBytes).digest("hex") ||
      ["buildBatchId", "generation", "commitSha", "artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"]
        .some(key => candidate[key] !== JSON.parse(a.publicReceiptBytes)[key])) refuse();
  for (const owner of [pins.serializerId, pins.cloud.serializerId]) {
    const journalPath = `cmsPublicationSerializerJournals/${owner}`;
    const journal = (await tx.get(db.doc(journalPath))).data();
    if (journal?.job != null) refuse();
    for (const row of await rows(db, tx, `${journalPath}/releases`)) {
      if (!terminal.includes(row.data().status)) refuse();
      unclaimed(row.data());
    }
  }
  const queues = await rows(db, tx, "cmsPublishQueue");
  const batches = await rows(db, tx, BATCHES);
  bind(request, "queuesDigest", digest(dataRows(queues)), planning);
  for (const queue of queues) {
    if (!terminal.includes(queue.data().status)) refuse();
    unclaimed(queue.data());
    if (["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"].includes(queue.data().transport)) {
      for (const sub of ["backgroundPreparation", "backgroundOutputs", "homePageRefresh"]) {
        for (const task of await rows(db, tx, `${queue.ref.path}/${sub}`)) {
          unclaimed(task.data());
          if (!["verified", "superseded", "failed", "cancelled"].includes(task.data().status)) refuse();
        }
      }
    }
  }
  for (const output of await rows(db, tx, "cmsBackgroundOutputs")) unclaimed(output.data());
  const refresh = (await tx.get(db.doc("system/publicDeployment/externalRefresh/current"))).data();
  // Native terminal refresh rows retain their next scheduled poll. Match 09's
  // guard: that schedule is not a live claim or a queue retry.
  if (refresh && (refresh.schemaVersion !== 1 || !["failed", "verified"].includes(refresh.status) || refresh.claim != null ||
      refresh.runtime?.owner !== "cloudflare" || refresh.runtime.release !== a.commitSha ||
      !Number.isSafeInteger(refresh.nextAttemptAt) || refresh.nextAttemptAt < 0 || !/^[A-Za-z0-9]{20}$/.test(refresh.operationId ?? ""))) refuse();
  const originals = new Map(), writes = [];
  for (const row of request.rows) {
    const batchRow = batches.find(b => b.id === row.buildBatchId), queueRow = queues.find(q => q.id === row.queueId);
    if (!batchRow || !queueRow) refuse();
    const batch = originalBatch(batchRow.data(), row, request, source, saved), queue = queueRow.data();
    if (row.status === "reserved") d.assertPublicDeploymentReservedBatch(batch, row.buildBatchId);
    else d.assertPublicDeploymentLeaseBatch(batch, row.buildBatchId);
    if (batch.status !== row.status || batch.generation !== row.generation || batch.noBuildStaticInput !== undefined ||
        (batch.runtime?.owner ?? "node-compute") !== row.owner ||
        digest(batch) !== row.batchDigest || digest(queue) !== row.queueDigest || queue.status !== "failed" ||
        queue.environment !== "development" || queue.projectId !== "njpbs-site-dev" ||
        row.owner === "cloudflare" && queue.runtime === undefined) refuse();
    require("../../functions/lib/publication-runtime-owner").assertPublicationOwner(queue,
      batch.runtime ?? { owner: "node-compute", release: batch.commitSha });
    if (!queue.artifactBuild || queue.artifactBuild.buildBatchId !== row.buildBatchId || queue.artifactBuild.generation !== row.generation ||
        queue.artifactBuild.commitSha !== batch.commitSha || queue.serializerClaim?.buildBatchId !== undefined &&
        queue.serializerClaim.buildBatchId !== row.buildBatchId) refuse();
    const sets = {};
    for (const key of ["inputs", "candidates", "manifests"]) sets[key] = await rows(db, tx, `${BATCHES}/${row.buildBatchId}/${key}`);
    const chunks = await rows(db, tx, `${BATCHES}/${row.buildBatchId}/manifests/publicMedia/chunks`);
    const verifications = await rows(db, tx, `${BATCHES}/${row.buildBatchId}/manifests/publicMedia/verifications`);
    for (const key of ["inputs", "candidates", "manifests"]) bind(row, `${key}Digest`, digest(dataRows(sets[key])), planning);
    bind(row, "verificationsDigest", digest(dataRows(verifications)), planning);
    bind(row, "chunksDigest", digest(dataRows(chunks)), planning);
    if (row.status === "reserved" && sets.candidates.length) refuse();
    if (row.owner === "node-compute" ? sets.inputs.length !== 0 : sets.inputs.length !== 1 || sets.inputs[0].id !== "devFrozen") refuse();
    if (sets.inputs.length) {
      const input = sets.inputs[0].data();
      exact(input, ["schemaVersion", "queueId", "buildBatchId", "commitSha", "inputDigest", "recordedAt"]);
      if (input.schemaVersion !== 1 || input.queueId !== row.queueId || input.buildBatchId !== row.buildBatchId ||
          input.commitSha !== batch.commitSha || !/^[a-f0-9]{64}$/.test(input.inputDigest ?? "") ||
          d.timestampMillis(input.recordedAt) === null || d.timestampMillis(input.recordedAt) < d.timestampMillis(batch.reservedAt)) refuse();
    }
    // These are retained staging receipts, never evidence of a public upload.
    // Read every known chunk/verification, including orphan sets; reject an
    // unknown format rather than assuming an unobserved set is empty.
    if (sets.manifests.length > 1 || sets.manifests.length === 1 && sets.manifests[0].id !== "publicMedia") refuse();
    const header = sets.manifests[0]?.data();
    if (header) {
      exact(header, ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha", "cutoffAt", "coverage", "ownerCount",
        "maxOwnerWritesPerChunk", "maxChunkBytes", "maxVerificationBytes", "chunkCount", "mediaManifestDigest"]);
      if (header.schemaVersion !== 1 || header.digestAlgorithm !== "sha256" || header.buildBatchId !== row.buildBatchId ||
          header.generation !== row.generation || header.commitSha !== batch.commitSha || digest(header.cutoffAt) !== digest(batch.cutoffAt) ||
          !Number.isSafeInteger(header.chunkCount) || header.chunkCount < 0 || header.chunkCount > 100 || chunks.length !== header.chunkCount ||
          !/^[a-f0-9]{64}$/.test(header.mediaManifestDigest ?? "")) refuse();
      const media = require("../../functions/lib/public-media-manifest");
      if (header.maxOwnerWritesPerChunk !== media.MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK ||
          header.maxChunkBytes !== media.MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES ||
          header.maxVerificationBytes !== media.MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES ||
          !Array.isArray(header.coverage) || header.coverage.length !== media.PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length) refuse();
      let owners = 0;
      header.coverage.forEach((entry, index) => {
        exact(entry, ["collection", "complete", "ownerCount", "ownerIdsDigest"]);
        if (entry.collection !== media.PUBLIC_MEDIA_MANIFEST_COLLECTIONS[index] || entry.complete !== true ||
            !Number.isSafeInteger(entry.ownerCount) || entry.ownerCount < 0 || !/^[a-f0-9]{64}$/.test(entry.ownerIdsDigest ?? "")) refuse();
        owners += entry.ownerCount;
      });
      if (owners !== header.ownerCount || owners > media.MAX_PUBLIC_MEDIA_MANIFEST_OWNERS) refuse();
    } else if (chunks.length || verifications.length) refuse();
    let chunkOwners = 0;
    for (const [index, chunkRow] of chunks.entries()) {
      const chunk = chunkRow.data();
      exact(chunk, ["schemaVersion", "buildBatchId", "generation", "mediaManifestDigest", "index", "ownerCount", "ownerKeys", "chunkDigest"]);
      if (chunkRow.id !== String(index).padStart(6, "0") || chunk.schemaVersion !== 1 || chunk.buildBatchId !== row.buildBatchId || chunk.generation !== row.generation ||
          chunk.mediaManifestDigest !== header.mediaManifestDigest || chunk.index !== index || !Number.isSafeInteger(chunk.ownerCount) ||
          chunk.ownerCount < 1 || chunk.ownerCount > 200 || !Array.isArray(chunk.ownerKeys) || chunk.ownerKeys.length !== chunk.ownerCount ||
          !/^[a-f0-9]{64}$/.test(chunk.chunkDigest ?? "")) refuse();
      for (const key of chunk.ownerKeys) {
        exact(key, ["collection", "documentId"]);
        const media = require("../../functions/lib/public-media-manifest");
        if (!media.PUBLIC_MEDIA_MANIFEST_COLLECTIONS.includes(key.collection) || !media.isPublicMediaOwnerId(key.documentId)) refuse();
      }
      chunkOwners += chunk.ownerCount;
    }
    if (header && chunkOwners !== header.ownerCount || verifications.length > 1 ||
        verifications.length === 1 && verifications[0].id !== "complete") refuse();
    if (verifications.length) {
      const verification = verifications[0].data();
      exact(verification, ["schemaVersion", "buildBatchId", "generation", "mediaManifestDigest", "ownerCount", "chunkCount", "verifiedAt"]);
      if (verification.schemaVersion !== 1 || verification.buildBatchId !== row.buildBatchId || verification.generation !== row.generation ||
          verification.mediaManifestDigest !== header.mediaManifestDigest || verification.ownerCount !== header.ownerCount ||
          verification.chunkCount !== header.chunkCount || d.timestampMillis(verification.verifiedAt) === null) refuse();
    }
    if (row.status === "ready") {
      if (sets.candidates.length !== 1 || sets.candidates[0].id !== "worker") refuse();
      const candidate = assertPublicWorkerCandidateMatchesBatch(sets.candidates[0].data(), batch, { target });
      const manifest = require("../../functions/lib/public-deployment-outcome-store").assertManifestCompletion({
        batch, header, verification: verifications[0]?.data() });
      if (candidate.mediaManifestDigest !== manifest.mediaManifestDigest) refuse();
      // Same native plan and persisted fields as acquirePublicDeploymentLease,
      // but this wrapper has no acquire branch and cannot touch the root.
      const plan = d.planPublicDeploymentLeaseAcquisition(pointer, batch);
      if (plan.action !== "supersede" || plan.supersededByGeneration !== 125 || plan.supersededByBuildBatchId !== a.buildBatchId) refuse();
    }
    originals.set(row.buildBatchId, batch);
    writes.push({ ref: batchRow.ref, batch, row });
  }
  const originalRows = dataRows(batches).map(row => ({ ...row, data: originals.get(row.id) ?? row.data }));
  bind(request, "batchesDigest", digest(originalRows), planning);
  if (batches.some(row => !originals.has(row.id) && !["deployed", "failed", "superseded", "cancelled", "retired"].includes(row.data().status))) refuse();
  return { receipt, saved, writes };
}
function operation(request, source) {
  return { schemaVersion: 1, kind: "dev-publication-history-terminalization", request, requestDigest: digest(request),
    plan: h.plan(request, source), planDigest: digest(h.plan(request, source)), operatorCommitSha: source };
}
function auditPath(request) { return `admin_logs/dev-history-${request.operationId}`; }
function auditFields(request, source) {
  return { actorUid: "system:dev-publication-history", actorEmail: null, action: "public-release.dev-historical-terminalization",
    target: request.operationId, source: null, before: { batchesDigest: request.batchesDigest },
    after: { requestDigest: digest(request), planDigest: digest(h.plan(request, source)) } };
}
async function operate({ firestore: db, request, operatorCommitSha: source, readOnly = false }) {
  h.parseRequest(request); h.plan(request, source);
  if (db?.projectId !== "njpbs-site-dev") refuse();
  return db.runTransaction(async tx => {
    const s = await state(db, tx, request, source);
    if (s.saved) return { committed: true, conservationVerified: true, receipt: s.saved };
    if (readOnly) refuse();
    const at = FieldValue.serverTimestamp();
    for (const { ref, batch, row } of s.writes) {
      if (row.status === "reserved") tx.set(ref, { ...batch, status: "retired", retiredAt: at,
        retirementReceipt: h.retirementReceipt(request, row, source, batch) });
      else tx.set(ref, { ...batch, status: "superseded", supersededReason: "newer_eligible_generation", supersededAt: at,
        supersededByGeneration: 125, supersededByBuildBatchId: request.active.buildBatchId });
    }
    tx.create(db.doc(`${RECEIPTS}/${request.operationId}`), { ...operation(request, source), committedAt: at });
    tx.create(db.doc(auditPath(request)), require("../../functions/lib/audit").adminLogEntry(auditFields(request, source)));
    return null;
  }, readOnly ? { readOnly: true } : {}).then(result => result ?? operate({ firestore: db, request, operatorCommitSha: source, readOnly: true }));
}
async function plan({ firestore: db, request: raw, operatorCommitSha: source }) {
  h.parseRequest(raw, { planning: true });
  if (db?.projectId !== "njpbs-site-dev" || !d.isCommitSha(source)) refuse();
  return db.runTransaction(async tx => {
    const request = structuredClone(raw);
    await state(db, tx, request, source, true);
    h.parseRequest(request);
    return { plannedRequest: request, plan: h.plan(request, source), planDigest: digest(h.plan(request, source)), authorityWrites: 0 };
  }, { readOnly: true });
}
module.exports = { operate, plan, dataRows, RECEIPTS };

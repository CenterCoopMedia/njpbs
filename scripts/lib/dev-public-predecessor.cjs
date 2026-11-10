"use strict";

// Operator-only first-install owners. No HTTP, production or scheduled caller.
const { createHash } = require("node:crypto");
const p = require("../../functions/lib/public-release-pair");
const deployment = require("../../functions/lib/public-deployment");
const runtime = require("../../functions/lib/cms-publication-runtime-control");
const { legacyBootstrapPointerDigest } = require("../../functions/lib/public-release-bootstrap-adoption");
const { assertPublicWorkerCandidateMatchesBatch } = require("../../functions/lib/public-worker-candidate");
const { publicationTarget } = require("../../functions/lib/publication-target");
const target = publicationTarget("development");
const ROOT = "system/devPublicPredecessor/initializations";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const refuse = () => { throw new p.PublicReleaseProtocolError(); };

function parseRequest(value) {
  p.exact(value, ["schemaVersion", "operationId", "environment", "projectId", "oldRuntime",
    "legacyPointerDigest", "publicReceiptBytes", "deploymentId", "versionId"]);
  const old = runtime.parseCmsPublicationRuntimeControl(value.oldRuntime);
  if (value.schemaVersion !== 1 || !deployment.isPublicDeploymentIdentifier(value.operationId) ||
      value.environment !== "development" || value.projectId !== target.projectId || !p.digest(value.legacyPointerDigest) ||
      old.phase !== "ready" || old.cloud?.phase !== "ready" || old.cloud.commitSha !== old.commitSha ||
      old.cloud.serializerId !== target.serializerId || ["cloudflare-publisher", target.serializerId].includes(old.serializerId) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.deploymentId ?? "") ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.versionId ?? "") ||
      typeof value.publicReceiptBytes !== "string" || Buffer.byteLength(value.publicReceiptBytes) > 8192) refuse();
  const publicReceipt = JSON.parse(value.publicReceiptBytes);
  p.exact(publicReceipt, ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha",
    "artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"]);
  if (publicReceipt.schemaVersion !== 1 || publicReceipt.digestAlgorithm !== "sha256" ||
      !deployment.isPublicDeploymentIdentifier(publicReceipt.buildBatchId) || !p.positive(publicReceipt.generation) ||
      publicReceipt.commitSha !== old.commitSha ||
      ![publicReceipt.artifactDigest, publicReceipt.artifactReceiptDigest, publicReceipt.mediaManifestDigest].every(p.digest)) refuse();
  return p.freeze(structuredClone(value));
}
function receipt(step, request) {
  return { schemaVersion: 1, kind: `dev-public-predecessor-${step}`, request, requestDigest: p.publicReleaseDigest(request) };
}
function validate(firestore, step, request) {
  if (firestore?.projectId !== target.projectId || !["runtime", "media-lifecycle"].includes(step)) refuse();
  return parseRequest(request);
}
async function state(firestore, tx, step, request) {
  const proof = JSON.parse(request.publicReceiptBytes);
  const paths = [`${ROOT}/${step}`, runtime.RUNTIME_DOCUMENT_PATH, "system/publicDeployment",
    `system/publicDeployment/buildBatches/${proof.buildBatchId}`,
    `system/publicDeployment/buildBatches/${proof.buildBatchId}/candidates/worker`,
    "system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog",
    "system/publicReleaseAdmissions/controls/bootstrapFence", "system/publicDeployment/releaseWriter/fence",
    "system/publicDeployment/mediaLifecycleActivations/enabled"];
  const [saved, pins, pointer, batch, candidate, ...later] = await tx.getAll(...paths.map(path => firestore.doc(path)));
  return { saved, pins, pointer, batch, candidate, later };
}
function assertPredecessor(s, request) {
  const pointer = deployment.assertPublicDeploymentPointer(s.pointer.data());
  const proof = JSON.parse(request.publicReceiptBytes), batch = s.batch.data();
  deployment.assertPublicDeploymentTerminalBatchStructure(batch, proof.buildBatchId);
  const candidate = assertPublicWorkerCandidateMatchesBatch(s.candidate.data(), batch, { target });
  if (s.later.some(row => row.exists) || pointer.state !== "idle" ||
      pointer.activeCommitSha !== request.oldRuntime.commitSha || pointer.activeGeneration !== proof.generation ||
      pointer.activeDeploymentId !== request.deploymentId || pointer.lastReservedGeneration !== proof.generation ||
      pointer.newestEligibleGeneration !== proof.generation || pointer.newestEligibleBuildBatchId !== proof.buildBatchId ||
      legacyBootstrapPointerDigest(pointer) !== request.legacyPointerDigest || batch.status !== "deployed" ||
      batch.deploymentId !== request.deploymentId || batch.deploymentVersionId !== request.versionId ||
      batch.runtime?.owner !== "cloudflare" || batch.runtime.release !== request.oldRuntime.commitSha ||
      candidate.workerVersionId !== request.versionId ||
      candidate.publicationReceiptDigest !== createHash("sha256").update(request.publicReceiptBytes).digest("hex") ||
      ["buildBatchId", "generation", "commitSha", "artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"]
        .some(key => candidate[key] !== proof[key])) refuse();
  return pointer;
}

async function initializeDevPublicPredecessor({ firestore, step, request: raw }) {
  const request = validate(firestore, step, raw);
  await firestore.runTransaction(async tx => {
    const s = await state(firestore, tx, step, request);
    const pointer = assertPredecessor(s, request);
    // A second apply never recreates a deleted control or flips a later fence.
    if (s.saved.exists) refuse();
    if (step === "runtime") {
      if (s.pins.exists) refuse();
      tx.create(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH), request.oldRuntime);
    } else {
      if (!s.pins.exists || !same(s.pins.data(), request.oldRuntime) || pointer.mediaLifecycleReady !== false) refuse();
      tx.update(firestore.doc("system/publicDeployment"), { mediaLifecycleReady: true });
    }
    tx.create(firestore.doc(`${ROOT}/${step}`), receipt(step, request));
    tx.create(firestore.collection("admin_logs").doc(), require("../../functions/lib/audit").adminLogEntry({
      actorUid: "system:dev-public-predecessor", action: `public-release.dev-initialize-${step}`,
      target: step === "runtime" ? runtime.RUNTIME_DOCUMENT_PATH : "system/publicDeployment",
      before: step === "runtime" ? null : { mediaLifecycleReady: false },
      after: { operationId: request.operationId, requestDigest: p.publicReleaseDigest(request),
        ...(step === "runtime" ? { runtime: request.oldRuntime } : { mediaLifecycleReady: true }) } }));
  });
  return readDevPublicPredecessor({ firestore, step, request });
}
async function readDevPublicPredecessor({ firestore, step, request: raw }) {
  const request = validate(firestore, step, raw);
  return firestore.runTransaction(async tx => {
    const s = await state(firestore, tx, step, request), expected = receipt(step, request);
    if (!s.saved.exists || !s.saved.createTime.isEqual(s.saved.updateTime) || !same(s.saved.data(), expected)) refuse();
    let currentReady = false;
    try {
      // Media activation changes only the flag included in the original digest.
      const original = step === "media-lifecycle" ? { ...s.pointer.data(), mediaLifecycleReady: false } : s.pointer.data();
      const checked = { ...s, pointer: { data: () => original } };
      assertPredecessor(checked, request);
      currentReady = s.pins.exists && same(s.pins.data(), request.oldRuntime) &&
        (step !== "media-lifecycle" || s.pointer.data().mediaLifecycleReady === true);
    } catch { /* Original receipt remains readable after later progress. */ }
    return { committed: true, currentReady, receipt: expected };
  }, { readOnly: true });
}
module.exports = { parseRequest, initializeDevPublicPredecessor, readDevPublicPredecessor };

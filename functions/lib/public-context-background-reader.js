"use strict";

const { readPublicDeploymentPointer } = require("./public-deployment-pointer");
const { publicationRuntime } = require("./publication-runtime-owner");
const { CURRENT_PATH, OUTPUTS } = require("./public-context-publication");
const { PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { backgroundOutputForPath: outputForPath, isBackgroundAssetPath, lastGood } = require("./post-background-outputs");
const { contextOutputs, recordOutputForPath, recordFamilyRegistered } = require("./no-build-record-namespace");
const { recordManifestOwnsAsset } = require("./post-background-record-manifest");
const { publicationTarget } = require("./publication-target");

/** The registered aggregate namespaces keep their own cloud authority. Detail Post
 * ownership and new-operation admission do not govern their public readers. */
async function readPublicContextBackgroundInTransaction({ firestore, transaction, path, rendererSha }) {
  const output = outputForPath(path);
  const asset = isBackgroundAssetPath(path);
  const recordFamily = recordOutputForPath(path);
  if (!OUTPUTS.includes(output) && !recordFamily && !asset) return null;
  if (recordFamily && !await recordFamilyRegistered({ firestore, transaction, family: recordFamily })) return null;
  const current = (await transaction.get(firestore.doc(CURRENT_PATH))).data();
  if (!current) {
    if (recordFamily) throw new Error("Record namespace context is unavailable");
    return null;
  }
  const outputs = contextOutputs(current);
  if (recordFamily && !outputs.includes(recordFamily)) throw new Error("Record namespace context is unavailable");
  publicationRuntime(current.runtime);
  if (current.schemaVersion !== 1 || current.runtime.owner !== "cloudflare" ||
      !/^[A-Za-z0-9]{20}$/.test(current.operationId) || !/^[a-f0-9]{64}$/.test(current.contextDigest)) {
    throw new Error("Aggregate publication authority is unavailable");
  }
  const [deployment, context] = await transaction.getAll(firestore.doc("system/publicDeployment"), firestore.doc(PUBLIC_CONTEXT_PATH));
  const pointer = readPublicDeploymentPointer(deployment.data());
  if (rendererSha !== pointer.activeCommitSha && (pointer.state === "idle" || rendererSha !== pointer.candidateCommitSha)) {
    throw new Error("Aggregate reader release is unavailable");
  }
  if (pointer.state !== "idle" && rendererSha === pointer.candidateCommitSha) {
    const candidate = (await transaction.get(firestore.doc(`system/publicDeployment/buildBatches/${pointer.candidateBuildBatchId}/candidates/worker`))).data();
    // The existing static-return candidate verifies these namespaces against
    // its sealed artifact. Its normal reader still validates the lease/proof.
    if (candidate?.noBuildStatic && !recordFamily) return null;
  }
  if (asset) {
    const states = await transaction.getAll(...outputs.map(family => firestore.doc(`cmsBackgroundOutputs/${family}`)));
    const owned = states.some(row => [row.data()?.receipt, row.data()?.lastGood?.receipt, row.data()?.previousAssets?.good?.receipt]
      .some(receipt => receipt?.assets?.some(file => file.path === path) ||
        ["programs", "events", "search"].includes(row.id) && receipt?.fileManifest && recordManifestOwnsAsset(receipt, path)));
    // Bounded path hashes keep unrelated asset misses out of artifact IO.
    if (!owned) return null;
  }
  if (output) {
    const state = (await transaction.get(firestore.doc(`cmsBackgroundOutputs/${output}`))).data();
    const job = current.servingEstablished === true ? null : (await transaction.get(firestore.doc(`cmsPublishQueue/${current.operationId}`))).data();
    const established = current.servingEstablished === true || job?.status === "success";
    const withdrawalRevision = context.data()?.withdrawalRevision ?? 0;
    const unchangedWithdrawals = Number.isSafeInteger(current.baselineWithdrawalRevision) &&
      Number.isSafeInteger(withdrawalRevision) && withdrawalRevision <= current.baselineWithdrawalRevision;
    if (!recordFamily && !lastGood(state) && !established && unchangedWithdrawals) return null;
  }
  const revision = context.data()?.revision;
  const digest = publicContextDigest(revision);
  let record;
  if (recordFamily && /^\/(programs|shows|events)\/[^/]+\/$/.test(path) &&
      require("./no-build-record-contract").recordFamilyForPath(path) === recordFamily) {
    const { recordRouteRef, readNoBuildRecordOwner, assertRecordOwnerSnapshot } = require("./no-build-record-ownership");
    const claim = (await transaction.get(recordRouteRef(firestore, path))).data();
    if (claim) {
      if (claim.schemaVersion !== 1 || claim.family !== recordFamily || claim.path !== path || Object.keys(claim).length !== 4) {
        throw new Error("Record route claim is unavailable");
      }
      const { state } = await readNoBuildRecordOwner({ firestore, transaction, documentId: claim.documentId });
      if (!state || state.family !== recordFamily || !state.ownedPaths.includes(path)) throw new Error("Record route owner is unavailable");
      assertRecordOwnerSnapshot(state, (await transaction.get(firestore.doc(`cmsPosts/${state.documentId}`))).data());
      record = { documentId: state.documentId, family: state.family, operationId: state.operationId,
        sourceVersion: state.sourceVersion, generation: state.generation, snapshotDigest: state.snapshotDigest,
        contextRevision: state.contextRevision, visible: state.visible };
    }
  }
  return { kind: "background", ...(record ? { record } : {}), context: { contextRevision: revision, contextDigest: digest, rendererSha },
    aggregateAuthority: { runtime: current.runtime,
      withdrawalRevision: context.data()?.withdrawalRevision ?? 0, homeRevision: context.data()?.homeRevision ?? 0 },
    backgroundBucket: publicationTarget(firestore.projectId === "njpbs-site-dev" ? "development" : "production").backgroundBucket };
}

module.exports = { readPublicContextBackgroundInTransaction };

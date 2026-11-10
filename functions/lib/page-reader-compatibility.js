"use strict";

const p = require("./public-release-pair");
const contract = require("./page-reader-contract");
const ROOT = "system/pageReaderContracts";
const SHA = /^[a-f0-9]{40}$/;
function refuse() {
  throw Object.assign(new Error("These Page planks are temporarily unavailable. Keep your draft and try again after the site update."),
    { status: 409, code: "page_reader_contract_unavailable", scheduleDeferred: true });
}
function markerPath(role, rendererSha) {
  if (!["public", "preview"].includes(role) || !SHA.test(rendererSha ?? "")) refuse();
  return `${ROOT}/${role}/${rendererSha}`;
}
async function readPageReaderVersion({ firestore, transaction, role, rendererSha }) {
  const row = await transaction.get(firestore.doc(markerPath(role, rendererSha)));
  if (!row.exists) return 0;
  const value = row.data();
  p.exact(value, ["schemaVersion", "rendererSha", "pageReaderVersion"]);
  if (value.schemaVersion !== 1 || value.rendererSha !== rendererSha || value.pageReaderVersion !== contract.PAGE_READER_VERSION) refuse();
  return value.pageReaderVersion;
}
// Call only after verifying the exact compiled renderer's seal/provider bytes.
// Companion documents preserve OLD's strict shared capability key sets.
async function preparePageReaderMarker({ firestore, transaction, role, rendererSha, version }) {
  const ref = firestore.doc(markerPath(role, rendererSha));
  if (version === undefined) return () => {};
  if (version !== contract.PAGE_READER_VERSION) refuse();
  const value = { schemaVersion: 1, rendererSha, pageReaderVersion: version };
  const before = await transaction.get(ref);
  if (before.exists && p.publicReleaseDigest(before.data()) !== p.publicReleaseDigest(value)) refuse();
  return () => { if (!before.exists) transaction.create(ref, value); };
}
function writeApiReaderMarker({ firestore, transaction, receipt }) {
  if (receipt?.component !== "cmsApi" || receipt.state !== "complete" || !SHA.test(receipt.mutation?.sourceSha ?? "")) refuse();
  transaction.set(firestore.doc(`${ROOT}/components/cmsApi`), { schemaVersion: 1,
    sourceSha: receipt.mutation.sourceSha, receiptDigest: p.publicReleaseDigest(receipt), pageReaderVersion: contract.PAGE_READER_VERSION });
}
async function assertApiReader({ firestore, transaction }) {
  const [saved, marker] = await transaction.getAll(firestore.doc("cmsDeploymentReceipts/cmsApi"), firestore.doc(`${ROOT}/components/cmsApi`));
  const receipt = saved.data(), value = marker.data();
  if (value) p.exact(value, ["schemaVersion", "sourceSha", "receiptDigest", "pageReaderVersion"]);
  if (!receipt || receipt.schemaVersion !== 1 || receipt.component !== "cmsApi" || receipt.state !== "complete" ||
      !SHA.test(receipt.mutation?.sourceSha ?? "") || !receipt.mutation.providerIdentities ||
      value?.schemaVersion !== 1 || value.sourceSha !== receipt.mutation.sourceSha ||
      value.receiptDigest !== p.publicReleaseDigest(receipt) || value.pageReaderVersion !== contract.PAGE_READER_VERSION) refuse();
}
async function assertPreviewPageReader({ firestore, transaction, pageId, blocks, rendererSha }) {
  if (!contract.requiredPageReaderVersion(blocks, pageId)) return;
  if (!contract.pageReaderSupports(blocks, pageId, await readPageReaderVersion({ firestore, transaction, role: "preview", rendererSha }))) refuse();
}
async function assertInstalledPageReaders({ firestore, transaction, pageId, blocks, preview = false, requireIdle = true }) {
  if (!contract.requiredPageReaderVersion(blocks, pageId)) return;
  const root = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  const pointer = root?.schemaVersion === 2 ? require("./public-release-media-fence").parseStoredSelector(root)
    : require("./public-deployment-pointer").assertPublicDeploymentPointer(root);
  if (typeof requireIdle !== "boolean" || requireIdle && pointer.state !== "idle") refuse();
  const capability = await require("./no-build-page-ownership").readNoBuildPageCapability({ firestore, transaction });
  if (!capability?.servingEnabled || capability.rendererSha !== pointer.activeCommitSha ||
      !contract.pageReaderSupports(blocks, pageId, await readPageReaderVersion({ firestore, transaction, role: "public", rendererSha: pointer.activeCommitSha }))) refuse();
  await assertApiReader({ firestore, transaction });
  if (preview) {
    const runtime = (await transaction.get(firestore.doc("system/cmsPreviewRuntime"))).data();
    if (!runtime || runtime.phase !== "ready" || ![1, 2].includes(runtime.schemaVersion)) refuse();
    if (runtime.schemaVersion === 2) {
      const pair = require("./cms-preview-pair"), selector = pair.parseSelector(runtime);
      pair.assertProjection(selector, pair.parsePair((await transaction.get(firestore.doc(`${pair.PAIRS}/${selector.selectedPairId}`))).data()));
    }
    await assertPreviewPageReader({ firestore, transaction, pageId, blocks, rendererSha: runtime.rendererSha });
  }
}
async function assertCandidatePageReaders({ firestore, transaction, candidate, candidates = [candidate] }) {
  // Include static/unowned Pages. Owned-route inventory alone misses their
  // snapshots, which the candidate can adopt through its full-build artifact.
  const { Filter } = require("firebase-admin/firestore");
  const pages = await transaction.get(firestore.collection("cmsPages")
    .where(Filter.or(Filter.where("publiclyVisible", "==", true), Filter.where("status", "==", "published"))).limit(1001));
  if (pages.size > 1000) refuse();
  const required = pages.docs.filter(row => {
    const value = row.data();
    return require("./public-video-references").publiclyVisible(value) && contract.requiredPageReaderVersion(value.published?.blocks, row.id);
  });
  if (!required.length) return;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 2) refuse();
  // Preservation does not change the API. Its mutable release receipt gates
  // new content admission, not settlement or recovery of a compatible reader.
  for (const selected of candidates) {
    const version = await readPageReaderVersion({ firestore, transaction, role: "public", rendererSha: selected?.commitSha });
    if (required.some(row => !contract.pageReaderSupports(row.data().published.blocks, row.id, version))) refuse();
  }
}
module.exports = { ROOT, preparePageReaderMarker, writeApiReaderMarker, readPageReaderVersion,
  assertInstalledPageReaders, assertPreviewPageReader, assertCandidatePageReaders };

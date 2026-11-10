"use strict";

// Immutable private cross-pair evidence. Parsing alone grants no publication,
// selection or permission to label another renderer's HTML as the original.
const p = require("./public-release-pair");
const admission = require("./public-release-admission-contract");
const view = require("./public-release-pair-view");
const { isPublicPairRequestPath } = require("./public-release-view-read");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { createHash } = require("node:crypto");
const work = require("./public-release-pair-work");
const INCLUSION_PROOFS = `${admission.ADMISSIONS}/inclusionProofs`;
const INCLUSION_PAGES = `${admission.ADMISSIONS}/inclusionPages`;
const INCLUSION_PAGE_LIMIT = 100;
const EMPTY = createHash("sha256").update("").digest("hex");
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function operation(value) { if (!isPublicDeploymentIdentifier(value)) refuse(); }
const digestFields = ["admissionDigest", "originalPairDigest", "selectedPairDigest", "originalRendererDigest", "selectedRendererDigest",
  "originalExecutionDigest", "originalCompositeProofDigest", "originalEntryDigest", "snapshotDigest", "selectorDigest", "selectedHeadViewDigest",
  "selectedSourceMetadataDigest", "switchReceiptDigest", "switchWitnessDigest", "workCensusDigest", "switchCoverageDigest", "canonicalProofDigest"];

function parsePairPublicationInclusion(value) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "originalPair", "selectedPair", "sourceVersion", "contextSequence",
    "switchOperationId", "outputs", ...digestFields]);
  operation(value.operationId); operation(value.switchOperationId);
  const originalPair = p.parsePublicReleasePairReference(value.originalPair), selectedPair = p.parsePublicReleasePairReference(value.selectedPair);
  const outputs = value.outputs; p.exact(outputs, ["count", "pages"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-publication-inclusion" || originalPair.pairId === selectedPair.pairId ||
      digestFields.some(field => !p.digest(value[field])) || !p.positive(value.sourceVersion) || !p.positive(value.contextSequence) ||
      !p.positive(outputs.count) || outputs.count > view.VIEW_OUTPUT_LIMIT || !Array.isArray(outputs.pages) ||
      outputs.pages.length !== Math.ceil(outputs.count / INCLUSION_PAGE_LIMIT) || outputs.pages.some(page => !p.digest(page)) ||
      new Set(outputs.pages).size !== outputs.pages.length) refuse();
  return p.freeze({ ...value, originalPair, selectedPair, outputs: { count: outputs.count, pages: [...outputs.pages] } });
}

function parsePairPublicationInclusionPage(value) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "originalPairDigest", "selectedPairDigest", "index", "members"]);
  operation(value.operationId);
  if (value.schemaVersion !== 2 || value.kind !== "pair-publication-inclusion-page" ||
      ![value.originalPairDigest, value.selectedPairDigest].every(p.digest) || !Number.isSafeInteger(value.index) || value.index < 0 ||
      value.index >= Math.ceil(view.VIEW_OUTPUT_LIMIT / INCLUSION_PAGE_LIMIT) || !Array.isArray(value.members) ||
      value.members.length < 1 || value.members.length > INCLUSION_PAGE_LIMIT) refuse();
  const members = value.members.map((member, index) => {
    p.exact(member, ["path", "originalStatus", "originalBodyDigest", "selectedStatus", "selectedBodyDigest",
      "selectedOutputLocatorDigest", "selectedProofLocatorDigest"]);
    if (typeof member.path !== "string" || !isPublicPairRequestPath(member.path) ||
        index > 0 && view.comparePrivatePairArtifactPaths(value.members[index - 1].path, member.path) >= 0 ||
        ![200, 302, 308, 410].includes(member.originalStatus) || ![200, 302, 308, 410].includes(member.selectedStatus) ||
        ![member.originalBodyDigest, member.selectedBodyDigest, member.selectedOutputLocatorDigest, member.selectedProofLocatorDigest].every(p.digest) ||
        member.originalStatus !== 200 && member.originalBodyDigest !== EMPTY || member.selectedStatus !== 200 && member.selectedBodyDigest !== EMPTY) refuse();
    return { ...member };
  });
  return p.freeze({ ...value, members });
}

/** Read the exact private transfer fact linked by a cross-pair SUCCESS. This
 * cannot manufacture one, accept caller bytes, or clear a pending marker. */
async function assertPairPublicationInclusionInTransaction({ firestore, transaction, accepted, receipt }) {
  accepted = admission.parseAdmission(accepted);
  if (receipt?.outcome !== "success" || !receipt.originalExecution || same(accepted.pair, receipt.selector.selectedPair)) refuse();
  const coverageRow = await transaction.get(firestore.doc(`${admission.ADMISSIONS}/coverageProofs/${receipt.coverageDigest}`));
  const coverage = coverageRow.data();
  if (!coverageRow.exists || p.publicReleaseDigest(coverage) !== receipt.coverageDigest ||
      !p.digest(coverage.inclusionProofDigest)) refuse();
  const [inclusionRow, canonicalRow, originalRow, selectedRow] = await transaction.getAll(
    firestore.doc(`${INCLUSION_PROOFS}/${coverage.inclusionProofDigest}`),
    firestore.doc(`${admission.ADMISSIONS}/canonicalProofs/${receipt.canonicalProofDigest}`),
    firestore.doc(work.publicReleasePairPath(accepted.pair.pairId)),
    firestore.doc(work.publicReleasePairPath(receipt.selector.selectedPair.pairId)));
  const proof = parsePairPublicationInclusion(inclusionRow.data()), canonical = canonicalRow.data();
  const original = p.parsePublicReleasePair(originalRow.data()), selected = p.parsePublicReleasePair(selectedRow.data());
  work.assertPublicReleasePairDatabase(firestore, original); work.assertPublicReleasePairDatabase(firestore, selected);
  if (p.publicReleaseDigest(proof) !== coverage.inclusionProofDigest || proof.operationId !== accepted.operationId ||
      proof.admissionDigest !== p.publicReleaseDigest(accepted) || proof.admissionDigest !== receipt.admissionDigest ||
      !same(proof.originalPair, accepted.pair) || !same(proof.originalPair, p.publicReleasePairReference(original)) ||
      !same(proof.selectedPair, receipt.selector.selectedPair) || !same(proof.selectedPair, p.publicReleasePairReference(selected)) ||
      original.environment !== selected.environment || proof.originalPairDigest !== accepted.pairDigest ||
      proof.originalPairDigest !== p.publicReleaseDigest(original) || proof.selectedPairDigest !== p.publicReleaseDigest(selected) ||
      proof.originalRendererDigest !== original.rendererDigest || proof.selectedRendererDigest !== selected.rendererDigest ||
      proof.originalExecutionDigest !== p.publicReleaseDigest(receipt.originalExecution) ||
      proof.sourceVersion !== accepted.source.sourceVersion || proof.snapshotDigest !== accepted.source.snapshotDigest ||
      proof.contextSequence !== accepted.changeSequence || proof.selectorDigest !== receipt.selectorDigest ||
      proof.canonicalProofDigest !== receipt.canonicalProofDigest || proof.switchOperationId !== receipt.selector.switchOperationId ||
      proof.switchWitnessDigest !== receipt.selector.proofDigest || coverage.schemaVersion !== 2 ||
      coverage.operationId !== accepted.operationId || coverage.admissionDigest !== proof.admissionDigest ||
      !same(coverage.originalExecution, receipt.originalExecution) || proof.originalCompositeProofDigest !== p.publicReleaseDigest(coverage.originalComposite) ||
      coverage.selectedPairDigest !== proof.selectedPairDigest || proof.selectedHeadViewDigest !== p.publicReleaseDigest(coverage.selectedHeadView) ||
      proof.selectedSourceMetadataDigest !== coverage.metadataDigest || !canonicalRow.exists ||
      p.publicReleaseDigest(canonical) !== proof.canonicalProofDigest || canonical.schemaVersion !== 2 || canonical.operationId !== accepted.operationId ||
      canonical.selectorDigest !== proof.selectorDigest || !Array.isArray(canonical.proofs) || canonical.proofs.length !== proof.outputs.count) refuse();
  const head = coverage.selectedHeadView;
  p.exact(head, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = view.parseViewIdentity(head.identity, selected);
  if (identity.contextSequence !== receipt.selector.contentHead.contextSequence ||
      ![head.claimDigest, head.manifestDigest].every(p.digest) || !p.positive(head.manifestBytes)) refuse();
  const rows = await transaction.getAll(...proof.outputs.pages.map(digest => firestore.doc(`${INCLUSION_PAGES}/${digest}`)));
  let count = 0, previous = "";
  const pages = rows.map((row, index) => {
    const page = parsePairPublicationInclusionPage(row.data());
    if (p.publicReleaseDigest(page) !== proof.outputs.pages[index] || page.index !== index || page.operationId !== proof.operationId ||
        page.originalPairDigest !== proof.originalPairDigest || page.selectedPairDigest !== proof.selectedPairDigest ||
        index < rows.length - 1 && page.members.length !== INCLUSION_PAGE_LIMIT) refuse();
    for (const member of page.members) {
      const output = canonical.proofs[count++], headers = output?.headers;
      if (previous && view.comparePrivatePairArtifactPaths(previous, member.path) >= 0 || output?.path !== member.path ||
          output.status !== member.selectedStatus || output.bodyDigest !== member.selectedBodyDigest ||
          p.publicReleaseDigest(output.locator) !== member.selectedOutputLocatorDigest || headers?.pair !== selected.pairId ||
          headers.renderer !== selected.commitSha || headers.selector !== proof.selectorDigest || headers.epoch !== String(receipt.selector.epoch) ||
          headers.head !== receipt.selector.contentHead.manifestDigest || headers.body !== member.selectedBodyDigest ||
          headers.origin !== (selected.environment === "production" ? "njpbs-production" : "template-dev-public")) refuse();
      previous = member.path;
    }
    return page;
  });
  if (count !== proof.outputs.count) refuse();
  return { proof, coverage, canonical, pages };
}

module.exports = { INCLUSION_PROOFS, INCLUSION_PAGES, INCLUSION_PAGE_LIMIT,
  parsePairPublicationInclusion, parsePairPublicationInclusionPage, assertPairPublicationInclusionInTransaction };

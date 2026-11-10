"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
function refuse() { throw new p.PublicReleaseProtocolError(); }
function pairCodePublicationPath(pair) { return `${work.publicReleasePairPath(pair.pairId)}/codePacks/publication`; }
function parsePairCodeReference(value) {
  p.exact(value, ["schemaVersion", "kind", "side", "commitSha", "codeAssetManifestDigest", "publicationDigest"]);
  const side = p.parsePublicReleasePairReference(value.side);
  if (value.schemaVersion !== 2 || value.kind !== "pair" || side.commitSha !== value.commitSha ||
      ![value.codeAssetManifestDigest, value.publicationDigest].every(p.digest)) refuse();
  return p.freeze({ ...value, side });
}
function parsePairCodePublication(value, pair) {
  p.exact(value, ["schemaVersion", "kind", "pairDigest", "baselineDigest", "codePackManifestDigest", "reference", "historicalCode"]);
  const reference = parsePairCodeReference(value.reference);
  if (value.schemaVersion !== 2 || value.kind !== "pair-code-publication" || value.pairDigest !== p.publicReleaseDigest(pair) ||
      !p.digest(value.baselineDigest) || !p.digest(value.codePackManifestDigest) ||
      p.publicReleaseDigest(reference.side) !== p.publicReleaseDigest(p.publicReleasePairReference(pair)) ||
      reference.codeAssetManifestDigest !== pair.codeAssetManifestDigest) refuse();
  const code = value.historicalCode;
  p.exact(code, ["reference", "qualifiedCodeDigest", "qualifiedCodeBytes", "chunks"]);
  const legacy = require("./current-public-code-source").validateCurrentCodeReference(code.reference);
  if (legacy.publication.commitSha !== pair.commitSha || !p.digest(code.qualifiedCodeDigest) ||
      !p.positive(code.qualifiedCodeBytes) || code.qualifiedCodeBytes > 20 * 1024 * 1024 || !Array.isArray(code.chunks) ||
      !code.chunks.length || code.chunks.length > 53 || code.chunks.some(digest => !p.digest(digest))) refuse();
  return p.freeze({ ...value, reference });
}
async function assertPairCodeReferenceInTransaction({ firestore, transaction, reference: raw }) {
  const reference = parsePairCodeReference(raw), base = work.publicReleasePairPath(reference.side.pairId);
  const [pairRow, baselineRow, publicationRow] = await transaction.getAll(firestore.doc(base),
    firestore.doc(`${base}/codePacks/baseline`), firestore.doc(`${base}/codePacks/publication`));
  const pair = p.parsePublicReleasePair(pairRow.data());
  work.assertPublicReleasePairDatabase(firestore, pair);
  const publication = parsePairCodePublication(publicationRow.data(), pair), baseline = baselineRow.data();
  if (p.publicReleaseDigest(reference) !== p.publicReleaseDigest(publication.reference) ||
      p.publicReleaseDigest(baseline) !== publication.baselineDigest || baseline?.schemaVersion !== 1 || baseline.kind !== "pair-code-pack-baseline" ||
      baseline.pairDigest !== p.publicReleaseDigest(pair) || baseline.commitSha !== pair.commitSha ||
      baseline.codeAssetManifestDigest !== reference.codeAssetManifestDigest || baseline.codePackManifestDigest !== publication.codePackManifestDigest) refuse();
  return { pair, reference, publication, baseline };
}
module.exports = { pairCodePublicationPath, parsePairCodeReference, parsePairCodePublication, assertPairCodeReferenceInTransaction };

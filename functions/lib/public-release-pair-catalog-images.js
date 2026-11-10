"use strict";
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const view = require("./public-release-pair-view");
const input = require("./public-release-pair-input");
const baselineView = require("./public-release-pair-code-pack-view");
const { createHash } = require("node:crypto");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
class PairCatalogImageError extends work.PairExecutionError {
  constructor(reason = "catalog-invalid") { super("byte-mismatch"); this.name = "PairCatalogImageError"; this.reason = reason; }
}
function refuse(reason) { throw new PairCatalogImageError(reason); }
function parsePublicReleasePairCatalogImages(value, rawPair, rawIdentity, expectedCursor) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "pairDigest", "inputManifestDigest", "cursor", "catalogs", "members"]);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-catalog-images" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.inputManifestDigest !== identity.inputManifestDigest || expectedCursor && protocol.publicReleaseDigest(cursor) !== protocol.publicReleaseDigest(expectedCursor) ||
      !Array.isArray(value.catalogs) || value.catalogs.length > 10_000 || !Array.isArray(value.members) || value.members.length > view.VIEW_OUTPUT_LIMIT) refuse();
  let previous = "", total = 0;
  const catalogIds = new Set(), used = new Set();
  const catalogs = value.catalogs.map(row => {
    protocol.exact(row, ["authorityDigest", "catalogDigest", "inputFile", "inputDigest", "provenanceDigest", "originalPairDigest", "rendererSha", "readerContractDigest", "readerReceiptDigest", "sourceSealDigest"]);
    const { authorityDigest, ...authority } = row;
    if (!protocol.digest(authorityDigest) || authorityDigest <= previous || authorityDigest !== protocol.publicReleaseDigest(authority) ||
        ![row.catalogDigest, row.inputDigest, row.provenanceDigest, row.originalPairDigest, row.readerContractDigest, row.readerReceiptDigest, row.sourceSealDigest].every(protocol.digest) ||
        typeof row.rendererSha !== "string" || !/^[a-f0-9]{40}$/.test(row.rendererSha) || typeof row.inputFile !== "string" || row.inputFile.length > 1024 ||
        !/^[A-Za-z0-9_./-]+\.json$/.test(row.inputFile) || row.inputFile.split("/").some(part => ["", ".", ".."].includes(part))) refuse();
    previous = authorityDigest; catalogIds.add(authorityDigest);
    return { authorityDigest, catalogDigest: row.catalogDigest, inputFile: row.inputFile, inputDigest: row.inputDigest,
      provenanceDigest: row.provenanceDigest, originalPairDigest: row.originalPairDigest, rendererSha: row.rendererSha,
      readerContractDigest: row.readerContractDigest, readerReceiptDigest: row.readerReceiptDigest, sourceSealDigest: row.sourceSealDigest };
  });
  previous = "";
  const members = value.members.map(row => {
    protocol.exact(row, ["path", "mime", "size", "sha256", "authorities"]);
    if (!view.isPrivatePairArtifactPath(row.path) || !/^\/_astro\/[A-Za-z0-9._-]+\.(avif|webp|jpeg|jpg|png)$/.test(row.path) || row.path.includes("..") ||
        view.comparePrivatePairArtifactPaths(previous, row.path) >= 0 || !protocol.digest(row.sha256) ||
        row.mime !== `image/${row.path.endsWith(".jpg") ? "jpeg" : row.path.split(".").at(-1)}` ||
        !Number.isSafeInteger(row.size) || row.size < 1 || row.size > 2 * 1024 * 1024 || !Array.isArray(row.authorities) || !row.authorities.length || row.authorities.length > 10_000) refuse();
    let last = "";
    for (const authority of row.authorities) { if (!catalogIds.has(authority) || authority <= last) refuse(); last = authority; used.add(authority); }
    total += row.size; previous = row.path;
    return { path: row.path, mime: row.mime, size: row.size, sha256: row.sha256, authorities: [...row.authorities] };
  });
  if (used.size !== catalogIds.size || total > view.VIEW_TOTAL_BYTES_LIMIT) refuse();
  return protocol.freeze({ schemaVersion: 1, kind: "pair-catalog-images", pairDigest: value.pairDigest, inputManifestDigest: identity.inputManifestDigest,
    cursor: { baselineDigest: cursor.baselineDigest, sequence: cursor.sequence, lastDigest: cursor.lastDigest }, catalogs, members });
}
/** Only exact catalog image names may augment the NEW baseline. Existing
 * names require identical bytes and MIME and cannot take over compiled code. */
function assertPublicReleasePairCatalogBaseline(manifest, baseline) {
  const members = new Map(baseline.members.map(row => [row.path, row]));
  for (const image of manifest.members) {
    const before = members.get(image.path);
    if (before && (before.family === "compiledGraph" || !before.mime.startsWith("image/") ||
        before.sha256 !== image.sha256 || before.size !== image.size || before.mime !== image.mime)) refuse("catalog-baseline-collision");
  }
}
function publicReleasePairCatalogImagesProofPath(pair, digest) {
  pair = protocol.parsePublicReleasePair(pair); if (!protocol.digest(digest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/catalogImages/${digest}`;
}
function parsePublicReleasePairCatalogImagesProof(value, rawPair, rawIdentity, claimDigest, viewManifestDigest) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "status", "pairDigest", "taskId", "identity", "claimDigest", "viewManifestDigest", "viewReadbackDigest",
    "inputManifestDigest", "cursor", "descriptor", "memberCount", "memberBytes", "authority"]);
  protocol.exact(value.descriptor, ["digest", "key", "bytes"]);
  protocol.exact(value.authority, ["baselineInputManifestDigest", "baselineCodePackManifestDigest", "baselineViewManifestDigest", "codeAssetManifestDigest"]);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-catalog-images-proof" || value.status !== "staged" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.taskId !== protocol.publicReleaseDigest(identity) || !same(value.identity, identity) || value.claimDigest !== claimDigest || value.viewManifestDigest !== viewManifestDigest ||
      value.inputManifestDigest !== identity.inputManifestDigest || !protocol.digest(value.viewReadbackDigest) || !protocol.digest(value.descriptor.digest) ||
      value.descriptor.key !== view.publicReleasePairViewObjectKey(pair, identity, claimDigest, value.descriptor.digest) ||
      !Number.isSafeInteger(value.descriptor.bytes) || value.descriptor.bytes < 1 || value.descriptor.bytes > view.BODY_BYTES_LIMIT ||
      !Number.isSafeInteger(value.memberCount) || value.memberCount < 0 || value.memberCount > view.VIEW_OUTPUT_LIMIT ||
      !Number.isSafeInteger(value.memberBytes) || value.memberBytes < 0 || value.memberBytes > view.VIEW_TOTAL_BYTES_LIMIT ||
      !Object.values(value.authority).every(protocol.digest) || value.authority.codeAssetManifestDigest !== pair.codeAssetManifestDigest) refuse();
  return protocol.freeze({ ...value, identity, cursor });
}
async function assertReadPublicReleasePairCatalogImagesInTransaction({ firestore, transaction, pair: rawPair, identity: rawIdentity, claimDigest,
  viewManifestDigest, manifest: rawManifest, manifestDigest }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair), base = work.publicReleasePairPath(pair.pairId);
  const manifest = parsePublicReleasePairCatalogImages(rawManifest, pair, identity);
  if (createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== manifestDigest) refuse();
  const [proofRow, stagedRow, inputRow] = await transaction.getAll(firestore.doc(publicReleasePairCatalogImagesProofPath(pair, viewManifestDigest)),
    firestore.doc(`${base}/views/${viewManifestDigest}`), firestore.doc(`${base}/inputs/${identity.inputManifestDigest}`));
  const proof = parsePublicReleasePairCatalogImagesProof(proofRow.data(), pair, identity, claimDigest, viewManifestDigest), staged = stagedRow.data();
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const captured = input.parsePublicReleasePairInputReceipt(inputRow.data(), pair, scope, identity.inputManifestDigest);
  const baseline = await baselineView.assertReadPublicReleasePairStagedCodePackInTransaction({ firestore, transaction, pair });
  await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair, taskId: proof.taskId, claimDigest, manifestDigest: viewManifestDigest });
  if (proof.descriptor.digest !== manifestDigest || proof.memberCount !== manifest.members.length || proof.memberBytes !== manifest.members.reduce((sum, row) => sum + row.size, 0) ||
      !same(proof.cursor, manifest.cursor) || !same(captured.cursor, manifest.cursor) || staged?.status !== "staged" || staged.claimDigest !== claimDigest ||
      staged.manifestDigest !== viewManifestDigest || staged.readbackDigest !== proof.viewReadbackDigest || !same(staged.identity, identity) || !same(staged.cursor, manifest.cursor) ||
      baseline.inputManifestDigest !== proof.authority.baselineInputManifestDigest || baseline.codePackManifestDigest !== proof.authority.baselineCodePackManifestDigest ||
      baseline.viewManifestDigest !== proof.authority.baselineViewManifestDigest || baseline.cursor.baselineDigest !== manifest.cursor.baselineDigest || baseline.cursor.sequence > manifest.cursor.sequence) refuse();
  return proof;
}
module.exports = { PairCatalogImageError, parsePublicReleasePairCatalogImages, assertPublicReleasePairCatalogBaseline,
  publicReleasePairCatalogImagesProofPath, parsePublicReleasePairCatalogImagesProof, assertReadPublicReleasePairCatalogImagesInTransaction };

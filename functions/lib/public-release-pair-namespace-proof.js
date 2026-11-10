"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const input = require("./public-release-pair-input");
const view = require("./public-release-pair-view");
const baseline = require("./public-release-pair-code-pack-view");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
function config(kind, pair) {
  if (kind === "search") return { namespace: "/pagefind/", collection: "searchNamespaces", kind: "pair-search-namespace-proof", minimum: 2,
    marker: { schemaVersion: 1, kind: "pair-search-namespace-authority", namespace: "/pagefind/", family: "searchIndex", commitSha: pair.commitSha,
      requiredEntries: ["/pagefind/pagefind-entry.json", "/pagefind/pagefind.js"] } };
  if (kind === "content-feed") return { namespace: "/api/v1/content/", collection: "contentFeedNamespaces", kind: "pair-content-feed-namespace-proof", minimum: 0,
    marker: { schemaVersion: 1, kind: "pair-content-feed-namespace-authority", namespace: "/api/v1/content/", family: "contentFeedPages", commitSha: pair.commitSha, indexPath: "/api/v1/content.json" } };
  return refuse();
}
function publicReleasePairNamespaceProofPath(pair, viewManifestDigest, kind) {
  pair = protocol.parsePublicReleasePair(pair);
  if (!protocol.digest(viewManifestDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/${config(kind, pair).collection}/${viewManifestDigest}`;
}
function parsePublicReleasePairNamespaceProof(value, rawPair, rawIdentity, claimDigest, viewManifestDigest, kind) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair), authorityConfig = config(kind, pair);
  protocol.exact(value, ["schemaVersion", "kind", "status", "pairDigest", "taskId", "identity", "claimDigest", "viewManifestDigest",
    "viewReadbackDigest", "inputManifestDigest", "namespace", "cursor", "namespaceRootDigest", "namespaceManifestDigest", "descriptor", "memberCount", "memberBytes", "authority"]);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity), descriptor = value.descriptor, authority = value.authority;
  protocol.exact(descriptor, ["digest", "key", "bytes"]);
  protocol.exact(authority, ["baselineInputManifestDigest", "baselineCodePackManifestDigest", "baselineViewManifestDigest", "codeAssetManifestDigest",
    "namespaceAuthorityDigest", "sourceCensusDigest", "searchInputDigest"]);
  const markerDigest = createHash("sha256").update(JSON.stringify(authorityConfig.marker) + "\n").digest("hex");
  if (value.schemaVersion !== 1 || value.kind !== authorityConfig.kind || value.status !== "staged" ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.taskId !== protocol.publicReleaseDigest(identity) ||
      !same(value.identity, identity) || value.claimDigest !== claimDigest || value.viewManifestDigest !== viewManifestDigest ||
      value.inputManifestDigest !== identity.inputManifestDigest || value.namespace !== authorityConfig.namespace ||
      ![value.viewReadbackDigest, value.namespaceRootDigest, value.namespaceManifestDigest].every(protocol.digest) ||
      descriptor.digest !== value.namespaceManifestDigest || descriptor.key !== view.publicReleasePairViewObjectKey(pair, identity, claimDigest, descriptor.digest) ||
      !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > view.BODY_BYTES_LIMIT ||
      !Number.isSafeInteger(value.memberCount) || value.memberCount < authorityConfig.minimum || value.memberCount > view.VIEW_OUTPUT_LIMIT ||
      !Number.isSafeInteger(value.memberBytes) || value.memberBytes < 0 || value.memberBytes > view.VIEW_TOTAL_BYTES_LIMIT ||
      !Object.values(authority).every(protocol.digest) || authority.codeAssetManifestDigest !== pair.codeAssetManifestDigest || authority.namespaceAuthorityDigest !== markerDigest) refuse();
  return protocol.freeze({ ...value, identity, cursor });
}
/** Final transaction guard; the stage producer previously exhausted G's actual
 * bodies. No R2/network calls occur in this read-only ownership transaction. */
async function assertReadPublicReleasePairNamespaceInTransaction({ firestore, transaction, pair: rawPair, identity: rawIdentity,
  claimDigest, viewManifestDigest, manifest: rawManifest, namespaceRootDigest, namespaceManifestDigest, kind }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair), base = work.publicReleasePairPath(pair.pairId);
  const codec = kind === "search" ? require("./public-release-pair-search-namespace") : require("./public-release-pair-content-feed-namespace");
  const manifest = kind === "search" ? codec.parsePublicReleasePairSearchNamespace(rawManifest, pair, identity) : codec.parsePublicReleasePairContentFeedNamespace(rawManifest, pair, identity);
  const rootDigest = kind === "search" ? codec.publicReleasePairSearchNamespaceRootDigest(manifest.members) : codec.publicReleasePairContentFeedNamespaceRootDigest(manifest.members);
  const manifestDigest = kind === "search" ? codec.publicReleasePairSearchNamespaceManifestDigest(manifest, pair, identity) : codec.publicReleasePairContentFeedNamespaceManifestDigest(manifest, pair, identity);
  if (rootDigest !== namespaceRootDigest || manifestDigest !== namespaceManifestDigest) refuse();
  const [proofRow, stagedRow, inputRow] = await transaction.getAll(firestore.doc(publicReleasePairNamespaceProofPath(pair, viewManifestDigest, kind)),
    firestore.doc(`${base}/views/${viewManifestDigest}`), firestore.doc(`${base}/inputs/${identity.inputManifestDigest}`));
  const proof = parsePublicReleasePairNamespaceProof(proofRow.data(), pair, identity, claimDigest, viewManifestDigest, kind);
  const scope = input.parsePublicReleasePairInputScope({ kind: identity.kind, sourceOperationId: identity.sourceOperationId,
    sourceVersion: identity.sourceVersion, snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence });
  const captured = input.parsePublicReleasePairInputReceipt(inputRow.data(), pair, scope, identity.inputManifestDigest), staged = stagedRow.data();
  const originalBaseline = await baseline.assertReadPublicReleasePairStagedCodePackInTransaction({ firestore, transaction, pair });
  const completed = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
    taskId: protocol.publicReleaseDigest(identity), claimDigest, manifestDigest: viewManifestDigest });
  if (!same(completed.identity, identity) || proof.namespaceRootDigest !== namespaceRootDigest || proof.namespaceManifestDigest !== namespaceManifestDigest ||
      proof.memberCount !== manifest.members.length || proof.memberBytes !== manifest.members.reduce((sum, member) => sum + member.size, 0) ||
      !same(proof.cursor, manifest.cursor) || !same(captured.cursor, manifest.cursor) ||
      staged?.status !== "staged" || staged.pairDigest !== proof.pairDigest || staged.claimDigest !== claimDigest || staged.manifestDigest !== viewManifestDigest ||
      staged.readbackDigest !== proof.viewReadbackDigest || !same(staged.identity, identity) || !same(staged.cursor, manifest.cursor) ||
      originalBaseline.inputManifestDigest !== proof.authority.baselineInputManifestDigest || originalBaseline.codePackManifestDigest !== proof.authority.baselineCodePackManifestDigest ||
      originalBaseline.viewManifestDigest !== proof.authority.baselineViewManifestDigest || originalBaseline.cursor.baselineDigest !== manifest.cursor.baselineDigest ||
      originalBaseline.cursor.sequence > manifest.cursor.sequence) refuse();
  return proof;
}
module.exports = { publicReleasePairNamespaceProofPath, parsePublicReleasePairNamespaceProof, assertReadPublicReleasePairNamespaceInTransaction };

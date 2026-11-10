"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const proofs = require("./public-release-pair-namespace-proof");
const view = require("./public-release-pair-view");
const PAIR_SEARCH_NAMESPACE = "/pagefind/";
const PAIR_SEARCH_REQUIRED_ENTRIES = Object.freeze(["/pagefind/pagefind-entry.json", "/pagefind/pagefind.js"]);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
function members(value) {
  if (!Array.isArray(value) || value.length < PAIR_SEARCH_REQUIRED_ENTRIES.length || value.length > view.VIEW_OUTPUT_LIMIT) refuse();
  let previous = "", total = 0;
  const rows = value.map(item => {
    protocol.exact(item, ["path", "mime", "size", "sha256"]);
    if (!view.isPrivatePairArtifactPath(item.path) || !item.path.startsWith(PAIR_SEARCH_NAMESPACE) ||
        view.comparePrivatePairArtifactPaths(previous, item.path) >= 0 || !protocol.digest(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 0 || item.size > view.BODY_BYTES_LIMIT ||
        typeof item.mime !== "string" || item.mime.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(item.mime)) refuse();
    previous = item.path; total += item.size;
    return Object.freeze({ path: item.path, mime: item.mime, size: item.size, sha256: item.sha256 });
  });
  if (total > view.VIEW_TOTAL_BYTES_LIMIT || PAIR_SEARCH_REQUIRED_ENTRIES.some(path => !rows.some(row => row.path === path))) refuse();
  return Object.freeze(rows);
}
function publicReleasePairSearchNamespaceRootDigest(value) { return hash(members(value)); }
function parsePublicReleasePairSearchNamespace(value, rawPair, rawIdentity, expectedCursor) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  protocol.exact(value, ["schemaVersion", "kind", "namespace", "pairDigest", "inputManifestDigest", "cursor", "members"]);
  const cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-search-namespace" || value.namespace !== PAIR_SEARCH_NAMESPACE ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.inputManifestDigest !== identity.inputManifestDigest ||
      expectedCursor && protocol.publicReleaseDigest(cursor) !== protocol.publicReleaseDigest(view.parsePublicReleasePairViewCursor(expectedCursor, identity))) refuse();
  return protocol.freeze({ schemaVersion: 1, kind: "pair-search-namespace", namespace: PAIR_SEARCH_NAMESPACE,
    pairDigest: value.pairDigest, inputManifestDigest: identity.inputManifestDigest,
    cursor: { baselineDigest: cursor.baselineDigest, sequence: cursor.sequence, lastDigest: cursor.lastDigest }, members: members(value.members) });
}
function publicReleasePairSearchNamespaceManifestDigest(value, pair, identity, cursor) {
  return hash(parsePublicReleasePairSearchNamespace(value, pair, identity, cursor));
}
function publicReleasePairSearchNamespaceProofPath(pair, manifestDigest) {
  pair = protocol.parsePublicReleasePair(pair);
  if (!protocol.digest(manifestDigest)) refuse();
  return `${work.publicReleasePairPath(pair.pairId)}/searchNamespaces/${manifestDigest}`;
}
function parsePublicReleasePairSearchNamespaceProof(value, pair, identity, claimDigest, viewManifestDigest) {
  return proofs.parsePublicReleasePairNamespaceProof(value, pair, identity, claimDigest, viewManifestDigest, "search");
}
async function assertReadPublicReleasePairSearchNamespaceInTransaction(options) {
  const manifest = parsePublicReleasePairSearchNamespace(options.manifest, options.pair, options.identity, options.cursor);
  if (publicReleasePairSearchNamespaceRootDigest(manifest.members) !== options.namespaceRootDigest ||
      publicReleasePairSearchNamespaceManifestDigest(manifest, options.pair, options.identity, options.cursor) !== options.namespaceManifestDigest) refuse();
  return proofs.assertReadPublicReleasePairNamespaceInTransaction({ ...options, manifest, kind: "search" });
}
module.exports = { PAIR_SEARCH_NAMESPACE, PAIR_SEARCH_REQUIRED_ENTRIES, parsePublicReleasePairSearchNamespace,
  publicReleasePairSearchNamespaceRootDigest, publicReleasePairSearchNamespaceManifestDigest, publicReleasePairSearchNamespaceProofPath,
  parsePublicReleasePairSearchNamespaceProof, assertReadPublicReleasePairSearchNamespaceInTransaction };

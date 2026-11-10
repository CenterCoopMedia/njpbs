"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const feed = require("./public-release-pair-content-feed-namespace");
const views = require("./public-release-pair-view");
const PREFIX = feed.PAIR_CONTENT_FEED_NAMESPACE,
  INDEX = feed.PAIR_CONTENT_FEED_INDEX;
const MARKER = "/_pair-compiled/pair-content-feed-namespace.json";
class ReplayContentFeedError extends Error {
  constructor(code = "replay-content-feed-evidence-invalid") {
    super(code);
    this.name = "ReplayContentFeedError";
    this.code = code;
  }
}
function refuse(code) {
  throw new ReplayContentFeedError(code);
}
function replayContentFeedAuthority(pair, artifacts) {
  const marker = artifacts.get(MARKER),
    selected = [...artifacts.values()].filter((row) => row.path.startsWith(PREFIX));
  if (!marker) {
    if (selected.length) refuse();
    return false;
  }
  const bytes =
    JSON.stringify({
      schemaVersion: 1,
      kind: "pair-content-feed-namespace-authority",
      namespace: PREFIX,
      family: "contentFeedPages",
      commitSha: pair.commitSha,
      indexPath: INDEX,
    }) + "\n";
  const index = artifacts.get(INDEX);
  if (
    marker.family !== "compiledGraph" ||
    marker.source !== "compiled" ||
    marker.dynamic ||
    marker.size !== Buffer.byteLength(bytes) ||
    marker.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
    !index ||
    index.family !== "feed" ||
    index.source !== "aggregate" ||
    !index.dynamic ||
    selected.some((row) => row.family !== "contentFeedPages" || row.source !== "aggregate" || !row.dynamic)
  )
    refuse();
  return true;
}
function baselineReplayContentFeedNamespace({ pair, artifacts, codePackView, cursor }) {
  if (!replayContentFeedAuthority(pair, artifacts)) return null;
  const selected = [...artifacts.values()].filter((row) => row.path.startsWith(PREFIX));
  const descriptor = (row) => ({ path: row.path, mime: row.mime, size: row.size, sha256: row.sha256 });
  const index = artifacts.get(INDEX);
  const manifest = feed.parsePublicReleasePairContentFeedNamespace(
    {
      schemaVersion: 1,
      kind: "pair-content-feed-namespace",
      namespace: PREFIX,
      pairDigest: protocol.publicReleaseDigest(pair),
      inputManifestDigest: codePackView.identity.inputManifestDigest,
      cursor,
      index: { ...descriptor(index), pageCount: selected.length },
      members: selected.map(descriptor),
    },
    pair,
    codePackView.identity,
    cursor,
  );
  return {
    manifest,
    view: codePackView,
    priorPaths: new Set(manifest.members.map((member) => member.path)),
    namespaceRootDigest: feed.publicReleasePairContentFeedNamespaceRootDigest(manifest.members),
    namespaceManifestDigest: feed.publicReleasePairContentFeedNamespaceManifestDigest(
      manifest,
      pair,
      codePackView.identity,
      cursor,
    ),
  };
}
/** Complete replacement, including a real index for the zero-page case. The
 * executor-owned guard binds this inventory to original H/G and CODEpack. */
async function applyReplayContentFeedNamespace({
  firestore,
  transaction,
  pair,
  artifacts,
  outputs,
  reference,
  cursor,
  previous,
  overlay,
  retainEqual = false,
}) {
  if (!replayContentFeedAuthority(pair, artifacts)) {
    if (outputs.some((row) => row.path.startsWith(PREFIX))) refuse();
    return { state: previous, proof: null, outputs };
  }
  const descriptor = (row) => {
    if (!row || row.status !== 200) refuse("replay-content-feed-proof-missing");
    return { path: row.path, mime: row.headers["content-type"], size: row.bytes, sha256: row.bodyDigest };
  };
  const members = outputs.filter((row) => row.path.startsWith(PREFIX)).map(descriptor);
  const index = descriptor(outputs.find((row) => row.path === INDEX));
  const manifest = feed.parsePublicReleasePairContentFeedNamespace(
    {
      schemaVersion: 1,
      kind: "pair-content-feed-namespace",
      namespace: PREFIX,
      pairDigest: protocol.publicReleaseDigest(pair),
      inputManifestDigest: reference.identity.inputManifestDigest,
      cursor,
      index: { ...index, pageCount: members.length },
      members,
    },
    pair,
    reference.identity,
    cursor,
  );
  const priorPaths = new Set(previous?.priorPaths ?? []);
  for (const member of members) priorPaths.add(member.path);
  const state = {
    manifest,
    view: reference,
    priorPaths,
    namespaceRootDigest: feed.publicReleasePairContentFeedNamespaceRootDigest(members),
    namespaceManifestDigest: feed.publicReleasePairContentFeedNamespaceManifestDigest(
      manifest,
      pair,
      reference.identity,
      cursor,
    ),
  };
  const proof = await feed.assertReadPublicReleasePairContentFeedNamespaceInTransaction({
    firestore,
    transaction,
    pair,
    identity: reference.identity,
    claimDigest: reference.claimDigest,
    viewManifestDigest: reference.manifestDigest,
    cursor,
    manifest,
    namespaceRootDigest: state.namespaceRootDigest,
    namespaceManifestDigest: state.namespaceManifestDigest,
  });
  if (
    retainEqual &&
    previous &&
    protocol.publicReleaseDigest(previous.manifest.members) === protocol.publicReleaseDigest(manifest.members) &&
    protocol.publicReleaseDigest(previous.manifest.index) === protocol.publicReleaseDigest(manifest.index)
  )
    return {
      state: previous,
      proof,
      outputs: outputs.filter((row) => row.path !== INDEX && !row.path.startsWith(PREFIX)),
    };
  for (const path of overlay.keys()) if (path.startsWith(PREFIX)) overlay.delete(path);
  for (const member of [...members, manifest.index])
    overlay.set(member.path, { path: member.path, view: reference, bodyDigest: member.sha256 });
  return { state, proof, outputs: outputs.filter((row) => row.path !== INDEX && !row.path.startsWith(PREFIX)) };
}
function replayContentFeedNamespaceProof(state, headCursor) {
  if (!state) return [];
  const current = new Set(state.manifest.members.map((member) => member.path));
  const priorPaths = [...state.priorPaths].sort(views.comparePrivatePairArtifactPaths);
  return [
    {
      namespace: PREFIX,
      namespaceRootDigest: state.namespaceRootDigest,
      namespaceManifestDigest: state.namespaceManifestDigest,
      cursor: state.manifest.cursor,
      headCursor,
      view: state.view,
      manifest: state.manifest,
      members: state.manifest.members,
      index: { ...state.manifest.index, view: state.view, cursor: state.manifest.cursor },
      priorPaths,
      withdrawnPaths: priorPaths.filter((path) => !current.has(path)),
    },
  ];
}
module.exports = {
  ReplayContentFeedError,
  replayContentFeedAuthority,
  baselineReplayContentFeedNamespace,
  applyReplayContentFeedNamespace,
  replayContentFeedNamespaceProof,
};

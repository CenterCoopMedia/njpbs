"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const namespace = require("./public-release-pair-search-namespace");
const views = require("./public-release-pair-view");
const { publicReleaseDigest: hash } = protocol;
const PREFIX = namespace.PAIR_SEARCH_NAMESPACE;
const MARKER = "/_pair-compiled/pair-search-namespace.json";
class ReplaySearchNamespaceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReplaySearchNamespaceError";
    this.code = code;
  }
}
function refuse(code = "replay-search-namespace-invalid") {
  throw new ReplaySearchNamespaceError(code);
}
function searchMembers(outputs) {
  return outputs
    .filter((row) => row.path.startsWith(PREFIX))
    .map((row) => {
      if (row.status !== 200) refuse();
      return { path: row.path, mime: row.headers["content-type"], size: row.bytes, sha256: row.bodyDigest };
    });
}
/** Only the compiled marker sealed into the complete baseline authorizes new
 * content-addressed search paths. Other artifacts retain exact-path authority. */
function replaySearchAuthority(pair, artifacts) {
  const marker = artifacts.get(MARKER),
    selected = [...artifacts.values()].filter((row) => row.path.startsWith(PREFIX));
  if (!marker) {
    if (selected.some((row) => row.family === "searchIndex")) refuse();
    return false;
  }
  const bytes =
    JSON.stringify({
      schemaVersion: 1,
      kind: "pair-search-namespace-authority",
      namespace: PREFIX,
      family: "searchIndex",
      commitSha: pair.commitSha,
      requiredEntries: namespace.PAIR_SEARCH_REQUIRED_ENTRIES,
    }) + "\n";
  if (
    marker.family !== "compiledGraph" ||
    marker.source !== "compiled" ||
    marker.dynamic ||
    marker.size !== Buffer.byteLength(bytes) ||
    marker.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
    selected.some((row) => row.family !== "searchIndex" || row.source !== "aggregate" || !row.dynamic) ||
    namespace.PAIR_SEARCH_REQUIRED_ENTRIES.some((path) => !artifacts.has(path))
  )
    refuse();
  return true;
}
function selection(pair, view, cursor, members, priorPaths) {
  const manifest = namespace.parsePublicReleasePairSearchNamespace(
    {
      schemaVersion: 1,
      kind: "pair-search-namespace",
      namespace: PREFIX,
      pairDigest: hash(pair),
      inputManifestDigest: view.identity.inputManifestDigest,
      cursor,
      members,
    },
    pair,
    view.identity,
    cursor,
  );
  for (const member of manifest.members) priorPaths.add(member.path);
  return {
    manifest,
    view,
    priorPaths,
    namespaceRootDigest: namespace.publicReleasePairSearchNamespaceRootDigest(manifest.members),
    namespaceManifestDigest: namespace.publicReleasePairSearchNamespaceManifestDigest(
      manifest,
      pair,
      view.identity,
      cursor,
    ),
  };
}
function baselineReplaySearchNamespace({ pair, artifacts, codePackView, cursor }) {
  if (!replaySearchAuthority(pair, artifacts)) return null;
  const members = [...artifacts.values()]
    .filter((row) => row.path.startsWith(PREFIX))
    .map((row) => ({ path: row.path, mime: row.mime, size: row.size, sha256: row.sha256 }));
  return selection(pair, codePackView, cursor, members, new Set());
}
async function applyReplaySearchNamespace({
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
  if (!replaySearchAuthority(pair, artifacts)) return { state: previous, proof: null, outputs };
  const members = searchMembers(outputs),
    remaining = outputs.filter((row) => !row.path.startsWith(PREFIX));
  if (!members.length) refuse("replay-search-input-evidence-missing");
  const state = selection(pair, reference, cursor, members, new Set(previous?.priorPaths ?? []));
  const proof = await namespace.assertReadPublicReleasePairSearchNamespaceInTransaction({
    firestore,
    transaction,
    pair,
    identity: reference.identity,
    claimDigest: reference.claimDigest,
    viewManifestDigest: reference.manifestDigest,
    cursor,
    manifest: state.manifest,
    namespaceRootDigest: state.namespaceRootDigest,
    namespaceManifestDigest: state.namespaceManifestDigest,
  });
  if (retainEqual && previous && hash(previous.manifest.members) === hash(state.manifest.members))
    return { state: previous, proof, outputs: remaining };
  for (const path of overlay.keys()) if (path.startsWith(PREFIX)) overlay.delete(path);
  for (const member of state.manifest.members)
    overlay.set(member.path, { path: member.path, view: reference, bodyDigest: member.sha256 });
  return { state, proof, outputs: remaining };
}
function replaySearchNamespaceProof(state, headCursor) {
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
      priorPaths,
      withdrawnPaths: priorPaths.filter((path) => !current.has(path)),
    },
  ];
}
module.exports = {
  ReplaySearchNamespaceError,
  replaySearchAuthority,
  baselineReplaySearchNamespace,
  applyReplaySearchNamespace,
  replaySearchNamespaceProof,
};

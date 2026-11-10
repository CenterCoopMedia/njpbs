"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const views = require("./public-release-pair-view");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function replayOwner() {
  // Lazy: schema-one and direct-G requests need no unadopted sibling module.
  let replay;
  try { replay = require("./public-release-pair-replay"); } catch { refuse(); }
  if (typeof replay.assertReadReplayWitnessProofInTransaction !== "function" ||
      typeof replay.openPublicReleasePairReplayWitnessProof !== "function") refuse();
  return replay;
}
async function prepareComposedPairRead({ firestore, pair, activatedOnly = false }) {
  const base = work.publicReleasePairPath(pair.pairId);
  const [headRow, changeRow] = await firestore.getAll(firestore.doc(`${base}/heads/current`), firestore.doc("system/publicReleaseChanges"));
  let head = headRow.data(), changes = require("./public-release-change-log").parsePublicReleaseChangeHead(changeRow.data());
  if (activatedOnly) {
    const activated = await firestore.runTransaction(async transaction => {
      const [root, own, log] = await transaction.getAll(firestore.doc("system/publicDeployment"),
        firestore.doc(`${base}/heads/current`), firestore.doc("system/publicReleaseChanges"));
      return require("./public-release-serving-head").readActivatedPairServingHeadInTransaction({ firestore, transaction, pair,
        current: p.parseStoredPublicReleaseSelector(root.data()), head: own.data(), global: log.data() });
    }, { readOnly: true });
    if (!activated) return null;
    head = { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), contentHead: activated.contentHead };
    changes = activated.changes;
  }
  p.exact(head, ["schemaVersion", "pairDigest", "contentHead"]);
  if (head.schemaVersion !== 2 || head.pairDigest !== p.publicReleaseDigest(pair) || head.contentHead?.pairId !== pair.pairId) refuse();
  // Direct original G remains independent of the composed module.
  if ((await firestore.doc(`${base}/views/${head.contentHead.manifestDigest}`).get()).exists) return null;
  const headCursor = { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest };
  const owner = replayOwner();
  const prepared = await owner.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor, witnessDigest: head.contentHead.viewId });
  return { contentHead: head.contentHead, changes,
    readWitness: options => owner.assertReadReplayWitnessProofInTransaction({ ...options, namespaces: prepared.namespaces, headView: prepared.headView }) };
}
function actualWitnessReader() { refuse(); }
function reference(raw, pair, cursor) {
  p.exact(raw, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(raw.identity, pair);
  if (!p.digest(raw.claimDigest) || !p.digest(raw.manifestDigest) || !Number.isSafeInteger(raw.manifestBytes) ||
      raw.manifestBytes < 1 || raw.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT || identity.contextSequence > cursor.sequence) refuse();
  return { identity, claimDigest: raw.claimDigest, manifestDigest: raw.manifestDigest, manifestBytes: raw.manifestBytes };
}
async function member({ firestore, transaction, pair, cursor, kind, digest, path }) {
  const base = work.publicReleasePairPath(pair.pairId);
  const record = (await transaction.get(firestore.doc(`${base}/replaySelections/${digest}`))).data();
  p.exact(record, ["root", "readbackDigest"]);
  const root = record.root;
  p.exact(root, ["schemaVersion", "kind", "pairDigest", "cursor", "pages", "count"]);
  if (!p.digest(record.readbackDigest) || p.publicReleaseDigest(root) !== digest || root.schemaVersion !== 2 || root.kind !== kind ||
      root.pairDigest !== p.publicReleaseDigest(pair) || !same(root.cursor, cursor) || !Array.isArray(root.pages) || root.pages.length > 391 ||
      !Number.isSafeInteger(root.count) || root.count < 0 || root.count > 100_000) refuse();
  let count = 0, prior = "";
  for (const page of root.pages) {
    p.exact(page, ["digest", "count", "firstPath", "lastPath"]);
    if (!p.digest(page.digest) || !Number.isSafeInteger(page.count) || page.count < 1 || page.count > 256 ||
        typeof page.firstPath !== "string" || typeof page.lastPath !== "string" ||
        views.comparePrivatePairArtifactPaths(page.firstPath, prior) <= 0 || views.comparePrivatePairArtifactPaths(page.firstPath, page.lastPath) > 0) refuse();
    count += page.count; prior = page.lastPath;
  }
  if (count !== root.count) refuse();
  const index = root.pages.findIndex(page => views.comparePrivatePairArtifactPaths(path, page.firstPath) >= 0 &&
    views.comparePrivatePairArtifactPaths(path, page.lastPath) <= 0);
  if (index < 0) return null;
  const descriptor = root.pages[index], page = (await transaction.get(firestore.doc(`${base}/replaySelectionPages/${descriptor.digest}`))).data();
  p.exact(page, ["schemaVersion", "pairDigest", "kind", "cursor", "index", "members"]);
  if (p.publicReleaseDigest(page) !== descriptor.digest || page.schemaVersion !== 2 || page.pairDigest !== root.pairDigest ||
      page.kind !== kind || !same(page.cursor, cursor) || page.index !== index || !Array.isArray(page.members) || page.members.length !== descriptor.count) refuse();
  let previous = "";
  const parsed = page.members.map(value => {
    p.exact(value, ["path", "view", "bodyDigest"]);
    if (typeof value.path !== "string" || !p.digest(value.bodyDigest) || views.comparePrivatePairArtifactPaths(previous, value.path) >= 0 ||
        value.path !== "/" && !views.isPrivatePairArtifactPath(value.path.endsWith("/") ? value.path.slice(0, -1) : value.path) ||
        kind === "content" && !value.path.endsWith("/")) refuse();
    previous = value.path;
    return { ...value, view: reference(value.view, pair, cursor) };
  });
  if (parsed[0].path !== descriptor.firstPath || parsed.at(-1).path !== descriptor.lastPath) refuse();
  return parsed.find(value => value.path === path) ?? null;
}
/** Read exactly the witness selected by heads/current, never a mutable replay
 * checkpoint. Selection roots plus one route page keep Firestore work bounded;
 * original G/H byte verification stays outside this transaction in the slot. */
async function readComposedPairArtifactInTransaction({ firestore, transaction, pair, contentHead, changes, path,
  readWitness = actualWitnessReader }) {
  if (!p.digest(contentHead.viewId)) refuse();
  const cursor = { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest };
  const options = { firestore, transaction, pair, headCursor: cursor, witnessDigest: contentHead.viewId };
  const proof = await readWitness(options), witness = proof.witness;
  if (witness.pairDigest !== p.publicReleaseDigest(pair) || witness.contentViewDigest !== contentHead.manifestDigest ||
      witness.codeAssetManifestDigest !== pair.codeAssetManifestDigest || !same(witness.headCursor, cursor) ||
      p.publicReleaseDigest(witness) !== contentHead.viewId) refuse();
  const baseView = reference(witness.codePackView, pair, cursor);
  let selected, artifactPath = path, absent = false;
  const namespace = ["/pagefind/", "/api/v1/content/"].find(prefix => path.startsWith(prefix));
  if (namespace || path === "/api/v1/content.json") {
    const selectedNamespace = proof.namespaces.find(value => value.namespace === (namespace ?? "/api/v1/content/"));
    if (!selectedNamespace || !same(selectedNamespace.headCursor, cursor)) refuse();
    const row = namespace ? selectedNamespace.members.find(value => value.path === path) : selectedNamespace.index;
    if (!row) absent = true;
    else {
      if (row.path !== path || !p.digest(row.sha256)) refuse();
      selected = { view: namespace ? selectedNamespace.view : selectedNamespace.index.view, bodyDigest: row.sha256 };
    }
  } else {
    if (path.endsWith("/")) selected = await member({ firestore, transaction, pair, cursor, kind: "content", digest: witness.contentViewDigest, path });
    if (!selected) selected = await member({ firestore, transaction, pair, cursor, kind: "code-pack-overlay", digest: witness.codePackOverlayDigest, path });
  }
  if (selected) {
    selected.view = reference(selected.view, pair, cursor);
    // The shared owner proves this original view belongs to the accepted
    // capsule chain; matching a current path alone is not membership proof.
    await readWitness({ ...options, selectedViews: [selected.view] });
  } else if (!absent) {
    artifactPath = path.endsWith("/") ? `${path}index.html` : path;
  }
  const selectedView = selected?.view ?? baseView;
  // Equal-byte replay outputs intentionally retain the selected code-pack G.
  // Its original H has no current ownership plan. The certified current head
  // remains a separate proof reference; the Worker must compare actual bytes.
  const proofLocator = !selected && !absent ? { pairDigest: p.publicReleaseDigest(pair), ...reference(proof.headView, pair, cursor) } : null;
  return { locator: { pairDigest: p.publicReleaseDigest(pair), ...selectedView }, artifactPath,
    expectedBodyDigest: selected?.bodyDigest ?? null, proofLocator, absent, witnessDigest: contentHead.viewId };
}
module.exports = { readComposedPairArtifactInTransaction, prepareComposedPairRead };

"use strict";
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const views = require("./public-release-pair-view");
const output = require("./cms-pair-editorial-context");
const { readPairCodeAuthority } = require("./pair-current-code-source");
const { parsePairCodeRequest } = require("./current-public-code-v2");
const { parsePublicReleaseChangeHead } = require("./public-release-change-log");
const { prepareComposedPairRead } = require("./public-release-serving-replay");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw Object.assign(new Error("Paired editorial context is unavailable"), { status: 409 }); }
function refreshing() { throw Object.assign(new Error("Paired editorial context is refreshing"), { code: "pair_editorial_context_refreshing" }); }

async function selectedContext({ firestore, transaction, request, now, deployedReaders, prepared, observed }) {
  const authority = await readPairCodeAuthority({ firestore, transaction, request, now, deployedReaders, includeCode: false });
  const { pair, publicSelector } = authority;
  // Legacy bootstrap uses the existing aggregate-context reader in the Node
  // consumer. This bridge never substitutes a baseline CODE for current data.
  if (publicSelector.schemaVersion !== 2 || !same(publicSelector.selectedPair, p.publicReleasePairReference(pair))) refuse();
  const base = work.publicReleasePairPath(pair.pairId);
  const [controlRow, headRow, changeRow] = await transaction.getAll(...[`${base}/controls/runtime`, `${base}/heads/current`, "system/publicReleaseChanges"]
    .map(path => firestore.doc(path)));
  const control = controlRow.data(), head = headRow.data(), changes = parsePublicReleaseChangeHead(changeRow.data());
  p.exact(head, ["schemaVersion", "pairDigest", "contentHead"]);
  if (control?.schemaVersion !== 2 || control.pairId !== pair.pairId || control.status !== "retained" ||
      head.schemaVersion !== 2 || head.pairDigest !== p.publicReleaseDigest(pair)) refuse();
  const contentHead = p.parsePublicReleaseSelector({ ...publicSelector, contentHead: head.contentHead }).contentHead;
  if (!same(observed.contentHead, contentHead) || !same(observed.changes, changes)) refreshing();
  if (contentHead.contextSequence !== changes.sequence) refreshing();
  const cursor = { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest };
  let staged = (await transaction.get(firestore.doc(`${base}/views/${contentHead.manifestDigest}`))).data();
  let physicalDigest = contentHead.manifestDigest;
  if (!staged) {
    if (!prepared) refuse();
    if (!same(prepared.contentHead, contentHead) || !same(prepared.changes, changes)) refreshing();
    const proof = await prepared.readWitness({ firestore, transaction, pair, headCursor: cursor, witnessDigest: contentHead.viewId });
    if (p.publicReleaseDigest(proof.witness) !== contentHead.viewId || proof.witness.contentViewDigest !== contentHead.manifestDigest ||
        proof.witness.codeAssetManifestDigest !== pair.codeAssetManifestDigest || !same(proof.witness.headCursor, cursor)) refuse();
    physicalDigest = proof.headView.manifestDigest;
    staged = (await transaction.get(firestore.doc(`${base}/views/${physicalDigest}`))).data();
    if (!staged || !same(staged.identity, proof.headView.identity) || staged.claimDigest !== proof.headView.claimDigest ||
        staged.manifestBytes !== proof.headView.manifestBytes) refuse();
  }
  if (!staged || staged.schemaVersion !== 2 || staged.status !== "staged" || staged.pairDigest !== p.publicReleaseDigest(pair) ||
      staged.manifestDigest !== physicalDigest || !same(staged.cursor, cursor)) refuse();
  const identity = views.parseViewIdentity(staged.identity, pair);
  if (staged.taskId !== p.publicReleaseDigest(identity) || !p.digest(staged.claimDigest) ||
      !Number.isSafeInteger(staged.manifestBytes) || staged.manifestBytes < 1 || staged.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT ||
      staged.manifestKey !== `${views.publicReleasePairViewPrefix(pair, identity, staged.claimDigest)}views/${physicalDigest}.json`) refuse();
  const manifest = await output.readPairEditorialContextManifest({ firestore, transaction, pair, viewManifestDigest: physicalDigest });
  if (!same(manifest.identity, identity) || manifest.claimDigest !== staged.claimDigest || !same(manifest.cursor, cursor)) refuse();
  return { authority, contentHead, manifest };
}
/** Metadata transactions bracket immutable bytes. The head's physical proof
 * selects the output; a same-cursor context or mutable latest row cannot. */
async function readPairCurrentEditorial({ firestore, request: raw, now = Date.now, deployedReaders }) {
  const request = parsePairCodeRequest(raw);
  if (!["current-editorial-v2", "current-editorial-reference-v2"].includes(request.mode)) refuse();
  deployedReaders = deployedReaders === undefined ? undefined : structuredClone(deployedReaders);
  const observe = () => firestore.runTransaction(async transaction => {
    const authority = await readPairCodeAuthority({ firestore, transaction, request, now: now(), deployedReaders, includeCode: false });
    if (authority.publicSelector.schemaVersion !== 2) refuse();
    const [headRow, changeRow] = await transaction.getAll(firestore.doc(`${work.publicReleasePairPath(authority.pair.pairId)}/heads/current`),
      firestore.doc("system/publicReleaseChanges"));
    const head = headRow.data(), changes = parsePublicReleaseChangeHead(changeRow.data());
    p.exact(head, ["schemaVersion", "pairDigest", "contentHead"]);
    if (head.schemaVersion !== 2 || head.pairDigest !== p.publicReleaseDigest(authority.pair)) refuse();
    const contentHead = p.parsePublicReleaseSelector({ ...authority.publicSelector, contentHead: head.contentHead }).contentHead;
    if (contentHead.contextSequence !== changes.sequence) refreshing();
    return { authority, contentHead, changes };
  }, { readOnly: true });
  const observed = await observe();
  let prepared;
  try { prepared = await prepareComposedPairRead({ firestore, pair: observed.authority.pair }); }
  catch (error) {
    // Catch-up can invalidate a composed proof while it opens. Retry only if
    // real metadata moved; an unchanged corrupt/missing proof stays permanent.
    if (!same(observed, await observe())) refreshing();
    throw error;
  }
  const read = () => firestore.runTransaction(transaction => selectedContext({ firestore, transaction, request, now: now(), deployedReaders, prepared, observed }), { readOnly: true });
  const before = await read();
  let bytes;
  if (request.mode === "current-editorial-v2") bytes = (await output.readPairEditorialContextBytes({ firestore, pair: before.authority.pair, manifest: before.manifest })).bytes;
  if (!same(before, await read())) refreshing();
  const reference = { schemaVersion: 2, kind: "pair-current-editorial", rendererSha: request.rendererSha, selection: request.selection,
    pairDigest: p.publicReleaseDigest(before.authority.pair), readerDigests: Object.fromEntries(Object.entries(before.authority.readers)
      .map(([component, reader]) => [component, require("./cms-reader-session").readerSessionDigest(reader)])),
    contentHead: before.contentHead, manifest: before.manifest };
  return request.mode === "current-editorial-reference-v2" ? { schemaVersion: 2, kind: "pair-current-editorial-reference", reference }
    : { schemaVersion: 2, kind: "pair-current-editorial", reference, sourceBase64: bytes.toString("base64") };
}
module.exports = { readPairCurrentEditorial };

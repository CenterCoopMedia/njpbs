"use strict";
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const input = require("./public-release-pair-input");
const view = require("./public-release-pair-view");
const same = (a, b) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse() { throw new work.PairExecutionError("byte-mismatch"); }
const publicReleasePairStagedCodePackPath = pair => `${work.publicReleasePairPath(protocol.parsePublicReleasePair(pair).pairId)}/codePacks/stagedBaseline`;
function parsePublicReleasePairStagedCodePack(value, rawPair) {
  const pair = protocol.parsePublicReleasePair(rawPair);
  protocol.exact(value, ["schemaVersion", "kind", "status", "pairDigest", "taskId", "identity", "claimDigest", "viewManifestDigest",
    "inputManifestDigest", "codePackManifestDigest", "codeAssetManifestDigest", "cursor", "memberCount", "memberBytes", "readbackDigest"]);
  const identity = view.parseViewIdentity(value.identity, pair), cursor = view.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-code-pack-staged-baseline" || value.status !== "staged" ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.taskId !== protocol.publicReleaseDigest(identity) ||
      value.inputManifestDigest !== identity.inputManifestDigest || value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
      ![value.claimDigest, value.viewManifestDigest, value.codePackManifestDigest, value.readbackDigest].every(protocol.digest) ||
      !Number.isSafeInteger(value.memberCount) || value.memberCount < 1 || value.memberCount > view.VIEW_OUTPUT_LIMIT ||
      !Number.isSafeInteger(value.memberBytes) || value.memberBytes < 0 || value.memberBytes > view.VIEW_TOTAL_BYTES_LIMIT ||
      identity.kind !== "qualification" || !identity.sourceOperationId.startsWith("baseline-codepack-")) refuse();
  return protocol.freeze({ ...value, identity, cursor });
}
/** Metadata/owner guard only. Actual bytes are observed outside transactions. */
async function assertReadPublicReleasePairStagedCodePackInTransaction({ firestore, transaction, pair: rawPair }) {
  const pair = protocol.parsePublicReleasePair(rawPair), base = work.publicReleasePairPath(pair.pairId);
  const [stagedRow, baselineRow] = await transaction.getAll(firestore.doc(publicReleasePairStagedCodePackPath(pair)), firestore.doc(`${base}/codePacks/baseline`));
  const record = parsePublicReleasePairStagedCodePack(stagedRow.data(), pair), baseline = baselineRow.data();
  const [inputRow, viewRow] = await transaction.getAll(firestore.doc(`${base}/inputs/${record.inputManifestDigest}`), firestore.doc(`${base}/views/${record.viewManifestDigest}`));
  const scope = input.parsePublicReleasePairInputScope({ kind: record.identity.kind, sourceOperationId: record.identity.sourceOperationId,
    sourceVersion: record.identity.sourceVersion, snapshotDigest: record.identity.snapshotDigest, contextSequence: record.identity.contextSequence });
  const captured = input.parsePublicReleasePairInputReceipt(inputRow.data(), pair, scope, record.inputManifestDigest), staged = viewRow.data();
  if (baseline?.schemaVersion !== 1 || baseline.kind !== "pair-code-pack-baseline" || baseline.pairDigest !== record.pairDigest ||
      baseline.commitSha !== pair.commitSha || baseline.codeAssetManifestDigest !== record.codeAssetManifestDigest ||
      baseline.inputManifestDigest !== record.inputManifestDigest || baseline.codePackManifestDigest !== record.codePackManifestDigest ||
      !same(baseline.cursor, record.cursor) || !same(captured.cursor, record.cursor) || captured.source.kind !== "inventory" ||
      staged?.schemaVersion !== 2 || staged.status !== "staged" || staged.pairDigest !== record.pairDigest || staged.taskId !== record.taskId ||
      staged.claimDigest !== record.claimDigest || staged.manifestDigest !== record.viewManifestDigest || staged.readbackDigest !== record.readbackDigest ||
      staged.outputCount !== record.memberCount || staged.outputBytes !== record.memberBytes || !same(staged.cursor, record.cursor) || !same(staged.identity, record.identity)) refuse();
  const completed = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
    taskId: record.taskId, claimDigest: record.claimDigest, manifestDigest: record.viewManifestDigest });
  if (!same(completed.identity, record.identity)) refuse();
  return record;
}
module.exports = { publicReleasePairStagedCodePackPath, parsePublicReleasePairStagedCodePack, assertReadPublicReleasePairStagedCodePackInTransaction };

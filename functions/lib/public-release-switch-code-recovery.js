"use strict";
const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const log = require("./public-release-change-log");
const bodies = require("./public-release-source-body");
const input = require("./public-release-pair-input");
const code = require("./public-release-pair-code-reference");
const ROOT = "system/publicDeployment";
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }

/** Exact historical switch-CODE capture authority. The immutable event names
 * the pair and input scope; H's create-once inputScope receipt binds its actual
 * manifest digest. It grants no admission, selection, or publication success. */
async function readSwitchCodeSourceInTransaction({ firestore, transaction, pair, scope: rawScope }) {
  const scope = input.parsePublicReleasePairInputScope(rawScope);
  if (scope.kind !== "recovery" || scope.contextSequence < 1) refuse();
  const [entryRow, operationRow, headRow] = await transaction.getAll(
    firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(scope.contextSequence).padStart(16, "0")}`),
    firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${scope.sourceOperationId}`), firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH));
  const entry = log.parsePublicReleaseChange(entryRow.data()), operation = operationRow.data(), head = log.parsePublicReleaseChangeHead(headRow.data());
  p.exact(operation, ["schemaVersion", "sequence", "entryDigest", "inputDigest"]);
  if (entry.operationId !== scope.sourceOperationId || entry.sequence !== scope.contextSequence || entry.changes.length !== 1 ||
      operation.schemaVersion !== 2 || operation.sequence !== entry.sequence || operation.entryDigest !== entry.entryDigest ||
      operation.inputDigest !== p.publicReleaseDigest(log.parsePublicReleaseChangeInput({ operationId: entry.operationId,
        pair: entry.pair, contextRevision: entry.contextRevision, changes: entry.changes })) || head.sequence < entry.sequence ||
      head.sequence === entry.sequence && head.lastDigest !== entry.entryDigest) refuse();
  const change = entry.changes[0];
  if (change.kind !== "provider" || change.id !== "public-code" || change.action !== "dependency" ||
      change.sourceVersion !== scope.sourceVersion || change.snapshotDigest !== scope.snapshotDigest) refuse();
  const key = createHash("sha256").update(JSON.stringify(["provider", "public-code"])).digest("hex");
  const member = (await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${entry.operationId}/members/${key}`))).data();
  p.exact(member, ["schemaVersion", "operationId", "contentDigest", "sequence", "entryDigest", "change", "json"]);
  if (member.schemaVersion !== 2 || member.operationId !== entry.operationId || member.sequence !== entry.sequence ||
      member.entryDigest !== entry.entryDigest || !same(member.change, change) || typeof member.json !== "string" ||
      Buffer.byteLength(member.json) > 800_000 || createHash("sha256").update(member.json).digest("hex") !== change.snapshotDigest) refuse();
  const snapshot = JSON.parse(member.json), body = await bodies.readPublicReleaseSourceBody({ firestore, transaction, contentDigest: member.contentDigest });
  p.exact(snapshot, ["commitSha", "generation", "deploymentId", "codeReference"]);
  if (body.kind !== "provider" || body.id !== "public-code" || body.action !== "dependency" ||
      body.sourceVersion !== change.sourceVersion || !same(body.snapshot, snapshot) || bodies.publicReleaseSnapshotJson(snapshot) !== member.json) refuse();
  const committed = p.parsePublicReleaseSelector(body.documents.find(row => row.path === ROOT)?.data);
  const operationId = committed.switchOperationId;
  if (entry.operationId !== p.publicReleaseDigest({ kind: "public-release-switch", operationId }) ||
      snapshot.commitSha !== pair.commitSha || snapshot.generation !== committed.activeGeneration ||
      snapshot.deploymentId !== committed.activeDeploymentId || change.sourceVersion !== committed.activeGeneration ||
      !same(committed.selectedPair, p.publicReleasePairReference(pair))) refuse();
  const [receiptRow, attemptRow, historyRow] = await transaction.getAll(firestore.doc(`${ROOT}/switchReceipts/${operationId}`),
    firestore.doc(`${ROOT}/switchAttempts/${operationId}`), firestore.doc(`system/publicReleaseSwitches/entries/${operationId}`));
  const receipt = receiptRow.data(), attempt = attemptRow.data(), history = historyRow.data();
  p.exact(attempt, ["schemaVersion", "operationId", "expectedSelectorDigest", "oldPair", "newPair", "witnessDigest"]);
  const oldPair = p.parsePublicReleasePair(attempt.oldPair), nextPair = p.parsePublicReleasePair(attempt.newPair);
  if (receipt?.schemaVersion !== 2 || receipt.operationId !== operationId || receipt.attemptDigest !== p.publicReleaseDigest(attempt) ||
      receipt.selectorDigest !== p.publicReleaseDigest(committed) || !same(receipt.selector, committed) ||
      attempt.schemaVersion !== 2 || attempt.operationId !== operationId || attempt.expectedSelectorDigest !== committed.priorSelectorDigest ||
      attempt.witnessDigest !== committed.proofDigest || !same(nextPair, pair) || !same(entry.pair, p.publicReleasePairReference(oldPair)) ||
      history?.schemaVersion !== 2 || history.operationId !== operationId || !same(history.selector, committed) ||
      !same(body.documents.find(row => row.path === historyRow.ref.path)?.data, history)) refuse();
  const witness = (await transaction.get(firestore.doc(`${ROOT}/switchWitnesses/${attempt.witnessDigest}`))).data();
  const cursor = log.parsePublicReleaseChangeHead(witness?.cursor);
  if (p.publicReleaseDigest(witness) !== attempt.witnessDigest || witness.oldPairDigest !== p.publicReleaseDigest(oldPair) ||
      witness.newPairDigest !== p.publicReleaseDigest(pair) || cursor.baselineDigest !== head.baselineDigest ||
      entry.sequence !== cursor.sequence + 1 || committed.contentHead.contextSequence !== cursor.sequence || entry.previousDigest !== cursor.lastDigest) refuse();
  require("./public-release-pair-media").parsePairMedia(body.documents.find(row => row.path === `${ROOT}/pairMedia/current`)?.data, committed);
  const resolved = await code.assertPairCodeReferenceInTransaction({ firestore, transaction, reference: snapshot.codeReference });
  if (!same(resolved.pair, pair)) refuse();
  return p.freeze({ pairDigest: p.publicReleaseDigest(pair), scopeDigest: p.publicReleaseDigest(scope),
    eventDigest: entry.entryDigest, selector: committed, source: { kind: "provider", id: "public-code", action: "dependency" },
    cursor: { baselineDigest: cursor.baselineDigest, sequence: entry.sequence, lastDigest: entry.entryDigest } });
}
async function assertSwitchCodeRecoveryInTransaction({ firestore, transaction, pair, scope, inputManifestDigest }) {
  if (!p.digest(inputManifestDigest)) refuse();
  const source = await readSwitchCodeSourceInTransaction({ firestore, transaction, pair, scope });
  return Object.freeze({ pairDigest: source.pairDigest, scopeDigest: source.scopeDigest,
    inputManifestDigest, eventDigest: source.eventDigest });
}
module.exports = { assertSwitchCodeRecoveryInTransaction, readSwitchCodeSourceInTransaction };

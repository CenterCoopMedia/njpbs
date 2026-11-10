"use strict";
const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const log = require("./public-release-change-log");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const fail = () => { throw new p.PublicReleaseProtocolError(); };
const code = selector => { const value = { ...selector }; delete value.contentHead; return value; };
const entryPath = sequence => `${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(sequence).padStart(16, "0")}`;
/** Read an ACTUAL historical log anchor, not a cursor stamped onto old G/H. */
async function readServingCursor({ firestore, transaction, global, sequence }) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > global.sequence) fail();
  if (sequence === global.sequence) return global;
  if (sequence === 0) return log.initialPublicReleaseChangeHead(global.baselineDigest);
  const entry = log.parsePublicReleaseChange((await transaction.get(firestore.doc(entryPath(sequence)))).data());
  if (entry.sequence !== sequence) fail();
  return log.parsePublicReleaseChangeHead({ schemaVersion: 2, baselineDigest: global.baselineDigest, sequence, lastDigest: entry.entryDigest });
}
/** CODE is logged by the original pair. Its immutable event names NEW via
 * the actual sealed code reference; never relabel the event as NEW-owned. */
async function assertSwitchCodeEvent({ firestore, transaction, pair, current, cursor, global }) {
  if (current.epoch === 1 || global.sequence <= cursor.sequence) return;
  const [receiptRow, attemptRow, historyRow] = await transaction.getAll(
    firestore.doc(`system/publicDeployment/switchReceipts/${current.switchOperationId}`),
    firestore.doc(`system/publicDeployment/switchAttempts/${current.switchOperationId}`),
    firestore.doc(`system/publicReleaseSwitches/entries/${current.switchOperationId}`));
  const receipt = receiptRow.data(), attempt = attemptRow.data(), history = historyRow.data();
  const committed = p.parsePublicReleaseSelector(receipt?.selector);
  if (receipt?.schemaVersion !== 2 || receipt.operationId !== current.switchOperationId ||
      receipt.selectorDigest !== p.publicReleaseDigest(committed) || !p.digest(receipt.attemptDigest) ||
      !same(code(committed), code(current)) || !same(committed.selectedPair, p.publicReleasePairReference(pair)) ||
      history?.schemaVersion !== 2 || history.operationId !== current.switchOperationId || !same(history.selector, committed)) fail();
  p.exact(attempt, ["schemaVersion", "operationId", "expectedSelectorDigest", "oldPair", "newPair", "witnessDigest"]);
  if (attempt.schemaVersion !== 2 || attempt.operationId !== current.switchOperationId || p.publicReleaseDigest(attempt) !== receipt.attemptDigest ||
      attempt.expectedSelectorDigest !== committed.priorSelectorDigest || attempt.witnessDigest !== committed.proofDigest ||
      !same(p.parsePublicReleasePair(attempt.newPair), pair) || !same(p.publicReleasePairReference(attempt.oldPair), committed.recoveryPair)) fail();
  const atSwitch = committed.contentHead.contextSequence;
  if (cursor.sequence < atSwitch) fail();
  if (cursor.sequence > atSwitch) return; // The activated replay already includes CODE.
  const sequence = atSwitch + 1, operationId = p.publicReleaseDigest({ kind: "public-release-switch", operationId: current.switchOperationId });
  const entry = log.parsePublicReleaseChange((await transaction.get(firestore.doc(entryPath(sequence)))).data());
  if (entry.sequence !== sequence || entry.previousDigest !== cursor.lastDigest || entry.operationId !== operationId ||
      !same(entry.pair, p.publicReleasePairReference(attempt.oldPair)) || entry.changes.length !== 1 ||
      global.sequence === sequence && global.lastDigest !== entry.entryDigest) fail();
  const change = entry.changes[0];
  if (change.kind !== "provider" || change.id !== "public-code" || change.action !== "dependency" || change.sourceVersion !== committed.activeGeneration) fail();
  const key = createHash("sha256").update(JSON.stringify(["provider", "public-code"])).digest("hex");
  const member = (await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${operationId}/members/${key}`))).data();
  p.exact(member, ["schemaVersion", "operationId", "contentDigest", "sequence", "entryDigest", "change", "json"]);
  if (member.schemaVersion !== 2 || member.operationId !== operationId || member.sequence !== sequence || member.entryDigest !== entry.entryDigest ||
      !same(member.change, change) || !p.digest(member.contentDigest) || typeof member.json !== "string" ||
      Buffer.byteLength(member.json) > 800_000 || createHash("sha256").update(member.json).digest("hex") !== change.snapshotDigest) fail();
  const snapshot = JSON.parse(member.json);
  p.exact(snapshot, ["commitSha", "generation", "deploymentId", "codeReference"]);
  if (snapshot.commitSha !== committed.activeCommitSha || snapshot.generation !== committed.activeGeneration || snapshot.deploymentId !== committed.activeDeploymentId) fail();
  const resolved = await require("./public-release-pair-code-reference").assertPairCodeReferenceInTransaction({ firestore, transaction, reference: snapshot.codeReference });
  if (!same(resolved.pair, pair)) fail();
}
/** The actual ACTIVATED root head is the serving commit point. Accepted log
 * suffixes are not activated content and never create a global serving pause.
 * No new settlement watermark, terminal scan or guessed head is introduced. */
async function readActivatedPairServingHeadInTransaction({ firestore, transaction, pair, current, head, global: rawGlobal }) {
  const global = log.parsePublicReleaseChangeHead(rawGlobal);
  p.exact(head, ["schemaVersion", "pairDigest", "contentHead"]);
  if (head.schemaVersion !== 2 || head.pairDigest !== p.publicReleaseDigest(pair) || head.contentHead?.pairId !== pair.pairId) fail();
  const qualified = head.contentHead;
  p.exact(qualified, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
  if (!require("./public-deployment-pointer").isPublicDeploymentIdentifier(qualified.viewId) || !p.digest(qualified.manifestDigest) ||
      !Number.isSafeInteger(qualified.contextSequence) || qualified.contextSequence < 0) fail();
  if (qualified.contextSequence < current.contentHead.contextSequence) return null;
  const selected = same(current.selectedPair, p.publicReleasePairReference(pair));
  const contentHead = selected ? current.contentHead : qualified;
  if (selected && qualified.contextSequence === contentHead.contextSequence && !same(qualified, contentHead)) fail();
  const changes = await readServingCursor({ firestore, transaction, global, sequence: contentHead.contextSequence });
  if (selected) await assertSwitchCodeEvent({ firestore, transaction, pair, current, cursor: changes, global });
  return { contentHead, changes };
}
module.exports = { readServingCursor, readActivatedPairServingHeadInTransaction };

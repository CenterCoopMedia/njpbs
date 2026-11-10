"use strict";
const p = require("./public-release-pair");
const log = require("./public-release-change-log");
const work = require("./public-release-pair-work");
const switches = require("./public-release-switch-code-recovery");
const writer = require("./public-release-writer-fence");
const inputs = require("./public-release-pair-input");
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function refuse() { throw new p.PublicReleaseProtocolError(); }
const switchCodeOperationId = operationId => p.publicReleaseDigest({ kind: "public-release-switch", operationId });
const codePendingPath = (pair, operationId) => `${work.publicReleasePairPath(pair.pairId)}/switchCodePending/${operationId}`;
function parseSwitchCodePending(value, pair, owner) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "pairDigest", "scope", "sourceDigest", "lease", "nextAttemptAt", "failures", "lastFailure"]);
  const scope = inputs.parsePublicReleasePairInputScope(value.scope);
  if (value.schemaVersion !== 2 || value.kind !== "switch-code-pending" || value.operationId !== scope.sourceOperationId ||
      value.pairDigest !== p.publicReleaseDigest(pair) || !same(scope, owner.scope) || value.sourceDigest !== p.publicReleaseDigest(owner.source) ||
      !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 3 ||
      (value.failures === 3 || value.lastFailure === "replay-predecessor-failed" ? value.nextAttemptAt !== null : !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0) ||
      ![null, "temporarily-unavailable", "source-refused", "replay-pending", "work-failed", "replay-predecessor-failed"].includes(value.lastFailure)) refuse();
  if (value.lease !== null) {
    p.exact(value.lease, ["token", "until"]);
    if (!/^[a-f0-9-]{36}$/.test(value.lease.token) || !p.positive(value.lease.until)) refuse();
  }
  return p.freeze({ ...value, scope });
}
/** Actual server-side source discovery; this is no lease, write permission or
 * success fact. The caller must still prove a capture lease or completed G. */
async function readSelectedSwitchCodeSourceInTransaction({ firestore, transaction, pair: rawPair, operationId }) {
  const pair = p.parsePublicReleasePair(rawPair), base = work.publicReleasePairPath(pair.pairId);
  const [root, adoption, billing, registered, control, fence] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc("system/publicReleaseAdmissions/controls/adoption"), firestore.doc("system/billing"), firestore.doc(base),
    firestore.doc(`${base}/controls/runtime`), firestore.doc(writer.RELEASE_WRITER_FENCE_PATH));
  if (root.data()?.schemaVersion !== 2 || adoption.data()?.enabled !== true || billing.data()?.disabled === true) return null;
  const selector = p.parseStoredPublicReleaseSelector(root.data());
  if (selector.epoch === 1) return null; // bootstrap converts the root without a switch CODE append
  if (!same(selector.selectedPair, p.publicReleasePairReference(pair))) return null;
  if (fence.exists) return null; // release serialization never pauses unrelated editorial work
  const codeOperationId = switchCodeOperationId(selector.switchOperationId);
  if (operationId !== undefined && operationId !== codeOperationId) return null;
  p.exact(adoption.data(), ["schemaVersion", "enabled"]);
  if (adoption.data().schemaVersion !== 2 || !same(p.parsePublicReleasePair(registered.data()), pair) ||
      !same(control.data(), { schemaVersion: 2, pairId: pair.pairId, status: "retained" })) refuse();
  const operation = (await transaction.get(firestore.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${codeOperationId}`))).data();
  if (!p.positive(operation?.sequence)) refuse();
  const entry = log.parsePublicReleaseChange((await transaction.get(firestore.doc(
    `${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(operation.sequence).padStart(16, "0")}`))).data());
  if (entry.operationId !== codeOperationId || entry.changes.length !== 1) refuse();
  const change = entry.changes[0], scope = { kind: "recovery", sourceOperationId: codeOperationId, sourceVersion: change.sourceVersion,
    snapshotDigest: change.snapshotDigest, contextSequence: entry.sequence };
  const source = await switches.readSwitchCodeSourceInTransaction({ firestore, transaction, pair, scope });
  if (selector.epoch !== source.selector.epoch || selector.activeGeneration !== source.selector.activeGeneration ||
      selector.switchOperationId !== source.selector.switchOperationId) refuse();
  return p.freeze({ scope, source, selector });
}
async function assertSelectedSwitchCodeCaptureLeaseInTransaction({ firestore, transaction, pair, operationId, token, now }) {
  if (!p.positive(now) || !/^[a-f0-9-]{36}$/.test(token)) refuse();
  const owner = await readSelectedSwitchCodeSourceInTransaction({ firestore, transaction, pair, operationId });
  if (!owner) refuse();
  const pending = parseSwitchCodePending((await transaction.get(firestore.doc(codePendingPath(pair, operationId)))).data(), pair, owner);
  if (pending.nextAttemptAt === null || pending.lease?.token !== token || pending.lease.until <= now) refuse();
  return p.freeze({ owner, pending });
}
async function assertSwitchCodeActivationInTransaction({ firestore, transaction, pair, owner, value }) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "switchOperationId", "pairDigest", "sourceView", "sourceEventDigest",
    "witnessDigest", "headViewDigest", "sourceMetadataDigest", "selectorDigestBefore", "selectorDigestAfter", "selector"]);
  const views = require("./public-release-pair-view");
  p.exact(value.sourceView, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const view = { ...value.sourceView, identity: views.parseViewIdentity(value.sourceView.identity, pair) };
  if (![view.claimDigest, view.manifestDigest].every(p.digest) || !p.positive(view.manifestBytes) || view.manifestBytes > views.VIEW_ROOT_BYTES_LIMIT) refuse();
  const selector = p.parsePublicReleaseSelector(value.selector);
  // Publication may advance the operational head after this CODE activation.
  // Its selector identity remains exact; head sequence and witness are checked below.
  const code = value => { const result = { ...value }; delete result.contentHead; return result; };
  if (value.schemaVersion !== 2 || value.kind !== "pair-switch-code-head" || value.operationId !== owner.scope.sourceOperationId ||
      value.switchOperationId !== owner.selector.switchOperationId || value.pairDigest !== p.publicReleaseDigest(pair) ||
      value.sourceEventDigest !== owner.source.eventDigest || !same(code(selector), code(owner.selector)) ||
      selector.contentHead.contextSequence < owner.scope.contextSequence || selector.contentHead.viewId !== value.witnessDigest ||
      owner.selector.contentHead.contextSequence < selector.contentHead.contextSequence ||
      value.selectorDigestAfter !== p.publicReleaseDigest(selector) ||
      ![value.sourceEventDigest, value.witnessDigest, value.headViewDigest, value.sourceMetadataDigest, value.selectorDigestBefore, value.selectorDigestAfter].every(p.digest) ||
      !same({ kind: view.identity.kind, sourceOperationId: view.identity.sourceOperationId, sourceVersion: view.identity.sourceVersion,
        snapshotDigest: view.identity.snapshotDigest, contextSequence: view.identity.contextSequence }, owner.scope)) refuse();
  const completed = await work.assertPublicReleasePairCompletedReceiptInTransaction({ firestore, transaction, pair,
    taskId: p.publicReleaseDigest(view.identity), claimDigest: view.claimDigest, manifestDigest: view.manifestDigest });
  if (!same(completed.identity, view.identity)) refuse();
  return p.freeze({ ...value, sourceView: view, selector });
}
module.exports = { assertSwitchCodeActivationInTransaction, readSelectedSwitchCodeSourceInTransaction, assertSelectedSwitchCodeCaptureLeaseInTransaction,
  switchCodeOperationId, codePendingPath, parseSwitchCodePending };

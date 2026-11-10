"use strict";

const p = require("./public-release-pair");
const a = require("./public-release-admission-contract");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const TERMINAL_RECEIPTS = `${a.ADMISSIONS}/terminalReceipts`;
const same = (left, right) => p.publicReleaseDigest(left) === p.publicReleaseDigest(right);
function refuse() { throw new p.PublicReleaseProtocolError(); }
function operation(value) { if (!isPublicDeploymentIdentifier(value)) refuse(); }

function parseCompletedPairPublicationExecution(value) {
  p.exact(value, ["schemaVersion", "pair", "pairDigest", "identity", "taskId", "inputManifestDigest", "claimDigest", "manifestDigest"]);
  const pair = p.parsePublicReleasePairReference(value.pair), identity = value.identity;
  p.exact(identity, ["schemaVersion", "pair", "kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence", "inputManifestDigest"]);
  operation(identity.sourceOperationId);
  if (value.schemaVersion !== 2 || identity.schemaVersion !== 2 || identity.kind !== "accepted" ||
      !same(p.parsePublicReleasePairReference(identity.pair), pair) || !p.positive(identity.sourceVersion) ||
      !p.positive(identity.contextSequence) || ![identity.snapshotDigest, identity.inputManifestDigest,
        value.pairDigest, value.taskId, value.inputManifestDigest, value.claimDigest, value.manifestDigest].every(p.digest) ||
      value.inputManifestDigest !== identity.inputManifestDigest || value.taskId !== p.publicReleaseDigest(identity)) refuse();
  return p.freeze({ ...value, pair, identity: { ...identity, pair } });
}
function parsePairPublicationTerminalReceipt(value) {
  p.exact(value, ["schemaVersion", "kind", "operationId", "admissionDigest", "outcome", "selector", "selectorDigest",
    "originalExecution", "activation", "coverageDigest", "canonicalProofDigest", "supersededBy"]);
  operation(value.operationId);
  const selector = p.parsePublicReleaseSelector(value.selector), activation = value.activation;
  p.exact(activation, ["kind", "operationId", "receiptDigest"]); operation(activation.operationId);
  if (value.schemaVersion !== 2 || value.kind !== "pair-publication-terminal" || !["success", "superseded"].includes(value.outcome) ||
      ![value.admissionDigest, value.selectorDigest, value.coverageDigest, value.canonicalProofDigest, activation.receiptDigest].every(p.digest) ||
      value.selectorDigest !== p.publicReleaseDigest(selector) || !["pair-publication", "pair-switch"].includes(activation.kind)) refuse();
  const originalExecution = value.originalExecution === null ? null : parseCompletedPairPublicationExecution(value.originalExecution);
  if (value.outcome === "success") {
    if (!originalExecution || value.supersededBy !== null) refuse();
  } else {
    p.exact(value.supersededBy, ["operationId", "admissionDigest", "terminalReceiptDigest"]);
    operation(value.supersededBy.operationId);
    if (value.supersededBy.operationId === value.operationId ||
        ![value.supersededBy.admissionDigest, value.supersededBy.terminalReceiptDigest].every(p.digest)) refuse();
  }
  return p.freeze({ ...value, selector, originalExecution });
}
function assertExecutionAdmission(execution, admission) {
  if (!execution) return;
  const identity = execution.identity;
  if (!same(execution.pair, admission.pair) || execution.pairDigest !== admission.pairDigest ||
      identity.sourceOperationId !== admission.operationId || identity.sourceVersion !== admission.source.sourceVersion ||
      identity.snapshotDigest !== admission.source.snapshotDigest || identity.contextSequence !== admission.changeSequence) refuse();
}
async function readTerminalFact({ firestore, transaction, operationId, admissionDigest }) {
  operation(operationId); if (!p.digest(admissionDigest)) refuse();
  const [admissionRow, queueRow, receiptRow, pendingRow] = await transaction.getAll(
    firestore.doc(`${a.ADMISSIONS}/operations/${operationId}`), firestore.doc(`cmsPublishQueue/${operationId}`),
    firestore.doc(`${TERMINAL_RECEIPTS}/${operationId}`), firestore.doc(`${a.ADMISSIONS}/pending/${operationId}`));
  const admission = a.parseAdmission(admissionRow.data()), receipt = parsePairPublicationTerminalReceipt(receiptRow.data()), queue = queueRow.data();
  a.assertQueue(queue, admission);
  if (admission.operationId !== operationId || p.publicReleaseDigest(admission) !== admissionDigest ||
      receipt.operationId !== operationId || receipt.admissionDigest !== admissionDigest || queue.status !== receipt.outcome ||
      queue.terminalReceipt !== p.publicReleaseDigest(receipt) || !same(queue.execution, receipt.originalExecution) || pendingRow.exists ||
      receipt.selector.contentHead.contextSequence < admission.changeSequence) refuse();
  assertExecutionAdmission(receipt.originalExecution, admission);
  if (receipt.outcome === "success" && !same(admission.pair, receipt.selector.selectedPair)) {
    await require("./public-release-inclusion").assertPairPublicationInclusionInTransaction({ firestore, transaction, accepted: admission, receipt });
  }
  return { admission, receipt };
}
/** Read an immutable acknowledgement issued by the private terminal owner.
 * This verifies its exact queue/admission links; it neither creates a receipt
 * nor certifies staged, cached or caller-supplied bytes as public success. */
async function assertPairPublicationTerminalReceiptInTransaction(input) {
  const { admission, receipt } = await readTerminalFact(input);
  if (receipt.outcome === "superseded") {
    const successor = receipt.supersededBy, next = await readTerminalFact({ ...input,
      operationId: successor.operationId, admissionDigest: successor.admissionDigest });
    if (next.receipt.outcome !== "success" || p.publicReleaseDigest(next.receipt) !== successor.terminalReceiptDigest ||
        next.admission.admissionSequence <= admission.admissionSequence || next.admission.source.kind !== admission.source.kind ||
        next.admission.source.id !== admission.source.id || next.admission.source.family !== admission.source.family ||
        next.admission.source.sourceVersion < admission.source.sourceVersion) refuse();
  }
  return receipt;
}
module.exports = { TERMINAL_RECEIPTS, parseCompletedPairPublicationExecution, parsePairPublicationTerminalReceipt,
  assertPairPublicationTerminalReceiptInTransaction };

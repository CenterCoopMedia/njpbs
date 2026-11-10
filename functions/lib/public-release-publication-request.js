"use strict";

const p = require("./public-release-pair");
const a = require("./public-release-admission-contract");
const { parseStoredSelector } = require("./public-release-media-fence");
const { AUDIT_COLLECTIONS } = require("./audit");
function refuse() { throw new p.PublicReleaseProtocolError(); }

/** Server-only request identity. It is derived before snapshot timestamps or
 * source versions change. Schema one retains its existing queue allocation. */
async function preparePairPublicationRequestInTransaction({ firestore, transaction, endpoint, actorUid, body, collection, documentId }) {
  if (!["save", "transition"].includes(endpoint) || !actorUid || !["cmsPages", "cmsPosts"].includes(collection)) refuse();
  const root = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
  if (root?.schemaVersion !== 2) return null;
  const selector = parseStoredSelector(root);
  const requestDigest = p.publicReleaseDigest({ schemaVersion: 2, endpoint, actorUid, body });
  const operationId = requestDigest.slice(0, 20);
  const requestRef = firestore.doc(`${a.ADMISSIONS}/requests/${operationId}`);
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const row = await transaction.get(requestRef);
  let replay = null;
  if (row.exists) {
    const receipt = row.data();
    p.exact(receipt, ["schemaVersion", "requestDigest", "operationId", "endpoint", "actorUid", "collection", "documentId", "historyPath", "version", "metadata"]);
    if (receipt.schemaVersion !== 2 || receipt.requestDigest !== requestDigest || receipt.operationId !== operationId ||
        receipt.endpoint !== endpoint || receipt.actorUid !== actorUid || receipt.collection !== collection || receipt.documentId !== documentId ||
        !p.positive(receipt.version) || !new RegExp(`^${AUDIT_COLLECTIONS.versionHistory}/[A-Za-z0-9]{20}$`).test(receipt.historyPath)) refuse();
    const [historyRow, admissionRow, queueRow] = await transaction.getAll(firestore.doc(receipt.historyPath),
      firestore.doc(`${a.ADMISSIONS}/operations/${operationId}`), queueRef);
    const admission = a.parseAdmission(admissionRow.data()), history = historyRow.data();
    a.assertQueue(queueRow.data(), admission);
    if (admission.operationId !== operationId || admission.source.id !== documentId || history?.collection !== collection ||
        history.documentId !== documentId || history.userId !== actorUid || history.after?.version !== receipt.version ||
        history.after?.id !== documentId || !receipt.metadata || typeof receipt.metadata !== "object" || Array.isArray(receipt.metadata)) refuse();
    replay = { action: history.action, before: history.before, after: history.after, metadata: receipt.metadata };
  }
  return { operationId, queueRef, replay, selector, write({ historyRef, version, metadata }) {
    if (row.exists || !p.positive(version) || !new RegExp(`^${AUDIT_COLLECTIONS.versionHistory}/[A-Za-z0-9]{20}$`).test(historyRef.path)) refuse();
    const receipt = { schemaVersion: 2, requestDigest, operationId, endpoint, actorUid, collection, documentId,
      historyPath: historyRef.path, version, metadata };
    if (Buffer.byteLength(JSON.stringify(receipt)) > 64 * 1024) refuse();
    transaction.create(requestRef, receipt);
  } };
}

/** Reuse an already accepted removal while a later private lifecycle action
 * changes the same document. Its original pair and operation stay unchanged. */
async function readPendingPairWithdrawalInTransaction({ firestore, transaction, operationId, collection, documentId, sourceVersion, sourceKind }) {
  const [admissionRow, queueRow, pendingRow] = await transaction.getAll(firestore.doc(`${a.ADMISSIONS}/operations/${operationId}`),
    firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc(`${a.ADMISSIONS}/pending/${operationId}`));
  const admission = a.parseAdmission(admissionRow.data()); a.assertQueue(queueRow.data(), admission);
  if (!["pending", "publishing"].includes(queueRow.data().status)) return null;
  const marker = (await transaction.get(firestore.doc(a.ownerPath(admission.source)))).data(), admissionDigest = p.publicReleaseDigest(admission);
  if (admission.operationId !== operationId || admission.source.id !== documentId || admission.source.kind !== sourceKind ||
      (sourceKind === "page" ? collection !== "cmsPages" : collection !== "cmsPosts") || admission.source.action !== "withdraw" ||
      admission.source.sourceVersion !== sourceVersion || marker?.operationId !== operationId || marker.admissionDigest !== admissionDigest ||
      pendingRow.data()?.admissionDigest !== admissionDigest) refuse();
  return admission;
}
module.exports = { preparePairPublicationRequestInTransaction, readPendingPairWithdrawalInTransaction };

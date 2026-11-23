"use strict";

const { readNoBuildRecordOwner } = require("./no-build-record-ownership");
const { recordFamily, readRecordPublication } = require("./no-build-record-publication");
const { currentContextCheck } = require("./context-publication-check-state");
async function recordPublicationMetadata({ firestore, documentId, stored }) {
  if (!recordFamily(stored)) return null;
  const { state } = await readNoBuildRecordOwner({ firestore, documentId });
  if (!state) return null;
  const accepted = await readRecordPublication({ firestore, operationId: state.operationId, document: stored });
  if (!accepted) throw new Error("The accepted record publication is unavailable");
  const { queue, publication } = accepted;
  const check = currentContextCheck(queue);
  const proof = check?.outcome === "confirmed_late" ? check.recordProof : null;
  // The owner has already checked the accepted record and its exact snapshot.
  // Later changes to other content do not revoke this publication's receipt.
  const checked = proof && proof.rendererSha === queue.recordPublication.rendererSha &&
    proof.contextDigest === queue.recordPublication.contextDigest && proof.contextRevision === queue.recordPublication.contextRevision;
  const receipt = checked ? { ...publication, status: "success", missingConsumers: [] } : publication;
  if (checked) delete receipt.warning;
  const awaitingCheck = !proof && check?.outcome !== "superseded" &&
    queue.recordRegeneration !== "deferred" && publication.warning &&
    (["failed", "public_unconfirmed"].includes(queue.status) || queue.status === "success" && publication.missingConsumers.length > 0);
  const version = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return { workingVersion: version(stored.version), contentVersion: version(stored.contentVersion ?? stored.version),
    publishedContentVersion: version(stored.published?.contentVersion), workingStatus: stored.status ?? "draft",
    publishedSourceVersion: state.sourceVersion, publicSourceVersion: checked ? state.visible ? state.sourceVersion : null : version(stored.publicSourceVersion),
    publiclyVisible: state.visible, publicUpdatePending: receipt.status !== "success", publicBuildQueueId: accepted.ref.id,
    queueStatus: receipt.warning && queue.recordRegeneration !== "deferred" ? "failed" : receipt.status, canResumeReservation: false, recordPublication: receipt,
    ...(awaitingCheck ? { recheckQueueId: accepted.ref.id } : {}) };
}
module.exports = { recordPublicationMetadata };

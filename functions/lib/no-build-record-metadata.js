"use strict";

const { readNoBuildRecordOwner } = require("./no-build-record-ownership");
const { recordFamily, readRecordPublication } = require("./no-build-record-publication");
async function recordPublicationMetadata({ firestore, documentId, stored }) {
  if (!recordFamily(stored)) return null;
  const { state } = await readNoBuildRecordOwner({ firestore, documentId });
  if (!state) return null;
  const accepted = await readRecordPublication({ firestore, operationId: state.operationId, document: stored });
  if (!accepted) throw new Error("The accepted record publication is unavailable");
  const receipt = accepted.publication;
  const version = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return { workingVersion: version(stored.version), contentVersion: version(stored.contentVersion ?? stored.version),
    publishedContentVersion: version(stored.published?.contentVersion), workingStatus: stored.status ?? "draft",
    publishedSourceVersion: state.sourceVersion, publicSourceVersion: version(stored.publicSourceVersion),
    publiclyVisible: state.visible, publicUpdatePending: receipt.status !== "success", publicBuildQueueId: accepted.ref.id,
    queueStatus: receipt.warning && accepted.queue.recordRegeneration !== "deferred" ? "failed" : receipt.status, canResumeReservation: false, recordPublication: receipt };
}
module.exports = { recordPublicationMetadata };

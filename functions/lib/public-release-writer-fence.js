"use strict";
const { PublicReleaseProtocolError, exact, digest } = require("./public-release-pair");
const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const RELEASE_WRITER_FENCE_PATH = "system/publicDeployment/releaseWriter/fence";
function parseReleaseWriterFence(value) {
  exact(value, ["schemaVersion", "operationId", "attemptDigest"]);
  if (value.schemaVersion !== 2 || !isPublicDeploymentIdentifier(value.operationId) || !digest(value.attemptDigest)) {
    throw new PublicReleaseProtocolError();
  }
  return value;
}
// Called by legacy writers as well as the pair switch. The fence never makes
// the serving pointer busy and cannot close editorial admission.
async function assertNoReleaseWriterInTransaction({ firestore, transaction }) {
  const row = await transaction.get(firestore.doc(RELEASE_WRITER_FENCE_PATH));
  if (row.exists) { parseReleaseWriterFence(row.data()); throw new PublicReleaseProtocolError(); }
}
module.exports = { RELEASE_WRITER_FENCE_PATH, parseReleaseWriterFence, assertNoReleaseWriterInTransaction };

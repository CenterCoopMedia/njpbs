"use strict";
const bootstrap = require("./public-release-bootstrap-admission");
class LegacyPublicQueueAdmissionError extends Error {
  constructor() {
    super("This publication needs the retained release workflow. Reload before retrying.");
    this.name = "LegacyPublicQueueAdmissionError";
    this.code = "public_release_legacy_queue_unavailable";
    this.status = 409;
    this.scheduleDeferred = true;
  }
}
/** New legacy queue work must serialize with the initial-install pause and
 * cannot enter the schema-two path. Missing/open fences keep legacy policy. */
async function assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction }) {
  const [fence, root] = await transaction.getAll(firestore.doc(bootstrap.BOOTSTRAP_ADMISSION_FENCE_PATH),
    firestore.doc("system/publicDeployment"));
  bootstrap.assertBootstrapAdmissionOpen(fence.data());
  if (root.data()?.schemaVersion === 2) throw new LegacyPublicQueueAdmissionError();
}
module.exports = { LegacyPublicQueueAdmissionError, assertLegacyPublicQueueAdmissionInTransaction };

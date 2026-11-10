"use strict";

// Inject the existing pure protocol primitives so source/Worker readers never
// import the Node-only recovery owner or acquire its SDK/storage dependencies.
function parseDevPublicReleasePauseRecoveryEvidence(value, p, isPublicDeploymentIdentifier) {
  const refuse = () => { throw new p.PublicReleaseProtocolError(); };
  p.exact(value, ["schemaVersion", "kind", "projectId", "operationId", "receiptDigest", "failureReceiptDigest", "failedWork", "remedy"]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-public-release-failed-not-published" || value.projectId !== "njpbs-site-dev" ||
      !isPublicDeploymentIdentifier(value.operationId) ||
      !p.digest(value.receiptDigest) || !p.digest(value.failureReceiptDigest) || value.remedy !== "logged-republish-after-resume" ||
      !Array.isArray(value.failedWork) || !value.failedWork.length || value.failedWork.length > 1000) refuse();
  let previous = "";
  for (const row of value.failedWork) {
    p.exact(row, ["operationId", "queuePath", "outcome", "originalQueueStatus", "documents", "failureReceiptDigest", "records"]);
    if (!isPublicDeploymentIdentifier(row.operationId) || row.operationId <= previous ||
        !["success", "failed", "public_unconfirmed"].includes(row.originalQueueStatus) ||
        row.queuePath !== `cmsPublishQueue/${row.operationId}` || row.outcome !== "failed-not-published" ||
        row.failureReceiptDigest !== value.failureReceiptDigest || !Array.isArray(row.documents) || row.documents.length > 10000 ||
        row.documents.some((path, index) => !/^cms(?:Posts|Pages|Settings|AuthorProfilesPublic)\/[A-Za-z0-9_-]+$/.test(path) ||
          index > 0 && row.documents[index - 1] >= path) ||
        !Array.isArray(row.records) || !row.records.length || row.records.length > 3002) refuse();
    previous = row.operationId;
    for (const record of row.records) {
      p.exact(record, ["path", "digest"]);
      if (typeof record.path !== "string" || !/^(cmsPublishQueue\/[A-Za-z0-9._:-]+(?:\/(?:backgroundOutputs|backgroundPreparation|homePageRefresh)\/[A-Za-z0-9_-]+)?|system\/publicDeployment\/noBuildPageOwners\/home)$/.test(record.path) ||
          !p.digest(record.digest)) refuse();
    }
  }
  return p.freeze(structuredClone(value));
}

module.exports = { parseDevPublicReleasePauseRecoveryEvidence };

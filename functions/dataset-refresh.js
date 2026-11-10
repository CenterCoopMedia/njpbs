"use strict";
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db } = require("./lib/firebase");
const { processDatasetRefreshJob } = require("./lib/dataset-refresh");
function createDatasetRefreshHandler({ firestore = db } = {}) {
  return async event => {
    const after = event.data?.after.data();
    const before = event.data?.before.data();
    if (!after || after.status === "success" || before && before.retryNonce === after.retryNonce) return;
    await processDatasetRefreshJob({ firestore, jobId: event.params.jobId });
  };
}
const onDatasetRefresh = onDocumentWritten({ document: "cmsDatasetRefreshJobs/{jobId}", retry: true,
  timeoutSeconds: 60, minInstances: 0, maxInstances: 1, concurrency: 1 }, async event => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  return createDatasetRefreshHandler()(event);
});
module.exports = { createDatasetRefreshHandler, onDatasetRefresh };

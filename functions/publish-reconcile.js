"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const {
  reconcileStalePublishRows,
} = require("./lib/publish-reconcile");

const { routePurgeSecretNames, retryPostRoutePurges } = require("./lib/post-route-purge");

const PUBLISH_RECONCILE_SCHEDULE = "every 60 minutes";
const HEALTHCHECKS_PUBLISH_RECONCILE = defineSecret(
  "HEALTHCHECKS_PUBLISH_RECONCILE",
);

async function pingHealthchecks({ url, fetchImpl = fetch }) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("HEALTHCHECKS_PUBLISH_RECONCILE must be an HTTPS URL");
  }

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { "User-Agent": "njpbs-publish-queue-reconcile" },
  });
  if (!response.ok) {
    throw new Error(
      `Healthchecks publish reconcile ping failed: ${response.status}`,
    );
  }
}

function createPublishQueueReconcileRunner(deps = {}) {
  const {
    firestore = db,
    reconcileStaleFn = reconcileStalePublishRows,
    now = () => Date.now(),
    log = logger,
    getHealthchecksUrl = () => HEALTHCHECKS_PUBLISH_RECONCILE.value(),
    fetchImpl = fetch,
  } = deps;

  return async () => {
    const reconciledCount = await reconcileStaleFn({ firestore, now });
    await pingHealthchecks({
      url: getHealthchecksUrl(),
      fetchImpl,
    });
    log.info("publish queue reconcile completed", {
      count: reconciledCount,
    });
    try { await retryPostRoutePurges({ firestore, now, log, ...deps.routePurge }); }
    catch { log.warn("Post route purge retry unavailable", { code: "purge_retry_unavailable" }); }
    return { reconciledCount };
  };
}

// This job has no publish-transport or billing-secret dependency. Its dedicated
// Healthchecks URL is the silent-failure alarm: a failed or missing run never
// sends the success ping.
const onPublishQueueReconcile = onSchedule(
  {
    schedule: PUBLISH_RECONCILE_SCHEDULE,
    secrets: [HEALTHCHECKS_PUBLISH_RECONCILE, ...routePurgeSecretNames()],
  },
  createPublishQueueReconcileRunner(),
);

module.exports = {
  HEALTHCHECKS_PUBLISH_RECONCILE,
  PUBLISH_RECONCILE_SCHEDULE,
  createPublishQueueReconcileRunner,
  onPublishQueueReconcile,
  pingHealthchecks,
};

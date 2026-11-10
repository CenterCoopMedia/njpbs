"use strict";

const { isDeepStrictEqual } = require("node:util");
const logger = require("firebase-functions/logger");
const { defineSecret, defineString } = require("firebase-functions/params");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("./lib/firebase");
const { TRANSPORT } = require("./lib/no-build-post-publication");
const { recoverNoBuildPostDetail } = require("./lib/no-build-post-recovery");
const { postProofDue } = require("./lib/no-build-post-proof-state");
const { confirmationErrorCauses } = require("./lib/confirmation-error-causes");
const { recoverNoBuildPageDetail, recoverNoBuildHomeCatalog, TRANSPORT: PAGE_TRANSPORT } = require("./lib/no-build-page-recovery");

const { publicationTarget } = require("./lib/publication-target");
const { CMS_EDGE_ORIGIN_SECRET } = require("./lib/cms-edge");
const DEVELOPMENT = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
const productionAlerts = DEVELOPMENT ? null : require("./bug-report-delivery");

const PURGE_TOKEN = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");
const ZONE_ID = defineString("CMS_MEDIA_CLOUDFLARE_ZONE_ID", { default: "" });
const DEV_ACCESS_ID = DEVELOPMENT ? defineSecret("CMS_DEV_ACCESS_CLIENT_ID") : null;
const DEV_ACCESS_SECRET = DEVELOPMENT ? defineSecret("CMS_DEV_ACCESS_CLIENT_SECRET") : null;
const confirmationSecrets = [PURGE_TOKEN, CMS_EDGE_ORIGIN_SECRET, ...(DEVELOPMENT ? [DEV_ACCESS_ID, DEV_ACCESS_SECRET] : [])];
const purgeConfigFn = () => ({ zoneId: ZONE_ID.value(), token: PURGE_TOKEN.value() });
const readbackOptions = () => ({ target: publicationTarget(DEVELOPMENT ? "development" : "production"),
  headers: DEVELOPMENT ? { "cf-access-client-id": DEV_ACCESS_ID.value(), "cf-access-client-secret": DEV_ACCESS_SECRET.value() } : {} });

function createNoBuildPostConfirmationHandler(deps = {}) {
  const { firestore = db, config = purgeConfigFn, readback = readbackOptions, ...network } = deps;
  return async event => {
    const queue = event.data?.after.data();
    const before = event.data?.before?.data();
    if (queue?.recordPublication && before) {
      // Reordering the recovery index must not start another public proof.
      const previous = { ...before }, current = { ...queue };
      delete previous.recordConfirmationPendingAt;
      delete current.recordConfirmationPendingAt;
      if (isDeepStrictEqual(previous, current)) return;
    }
    if (queue?.datasetRefreshJobId && ["success", "failed"].includes(queue.status)) {
      await require("./lib/dataset-refresh").processDatasetRefreshJob({ firestore, jobId: queue.datasetRefreshJobId, maxOwners: 2 });
    }
    if (queue?.transport === "public-context-no-build-v1") {
      if (queue.recordPublication && queue.recordRegeneration) {
        const work = await require("./lib/no-build-record-retry").resumeDeferredRecordPublication({ firestore, operationId: event.params.queueId });
        if (work.paused || work.resumed) return;
      }
      if (["pending", "publishing", "success"].includes(queue.status)) {
        // Context acceptance and settlement both give a bounded natural wake.
        // Catalog failure cannot make another owner's context job fail.
        const deadline = Date.now() + 45_000;
        try { await recoverNoBuildHomeCatalog({ firestore, ...readback(), ...network, deadline }); } catch { /* Later context/recovery wake retries. */ }
        // A settings publication proves its Page and Home consumers on this
        // same wake. The minute scheduler remains the recovery path.
        if (queue.settingsPublication || queue.libraryCardPublication || queue.recordPublication) {
          // Loaded here: its import graph declares a secret that the development manifest must not carry.
          try { await require("./lib/no-build-page-settings-confirmation").confirmNoBuildPageSettings({ firestore, operationId: event.params.queueId, ...readback(), ...network, deadline }); }
          catch { /* The minute scheduler repeats the settings consumer proof. */ }
        }
        if (queue.recordPublication && Date.now() < deadline) {
          try { await require("./lib/no-build-record-confirmation").recoverNoBuildRecordPublication({ firestore,
            operationId: event.params.queueId, ...readback(), ...network, deadline }); }
          catch { /* The same bounded recovery wake retains the accepted source. */ }
        }
      }
      return;
    }
    if (queue?.transport === PAGE_TRANSPORT) {
      if (queue.status !== "pending" || queue.claim || queue.nextAttemptAt === null || queue.nextAttemptAt > Date.now()) return;
      await recoverNoBuildPageDetail({ firestore, ...readback(), ...network, operationId: event.params.queueId });
      return;
    }
    if (queue?.transport !== TRANSPORT || (!postProofDue(queue, Date.now()) &&
        (queue.status !== "pending" || queue.claim || queue.nextAttemptAt === null || queue.nextAttemptAt > Date.now()))) return;
    await recoverNoBuildPostDetail({ firestore, ...readback(), ...network, purgeConfig: config(), operationId: event.params.queueId });
  };
}

// Acceptance and explicit retries wake detail confirmation independently of the
// publisher's build lock. The same durable claim deduplicates delivered events.
const onNoBuildPostConfirmation = onDocumentWritten({
  document: "cmsPublishQueue/{queueId}", retry: true, timeoutSeconds: 60,
  minInstances: 0, maxInstances: 2, concurrency: 4, secrets: confirmationSecrets,
}, async event => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  await createNoBuildPostConfirmationHandler()(event);
});

async function recoverNoBuildPublications({ firestore = db, config = purgeConfigFn, readback = readbackOptions,
  now = Date.now, log = logger, ...network } = {}) {
  const deadline = now() + 45_000;
  // Start each independent owner before another can spend the shared budget.
  const outcomes = await Promise.allSettled([
    recoverNoBuildPostDetail({ firestore, ...readback(), ...network, now, purgeConfig: config(), deadline }),
    recoverNoBuildPageDetail({ firestore, ...readback(), ...network, now, deadline }),
    require("./lib/no-build-record-confirmation").recoverNoBuildRecordPublication({ firestore, ...readback(), ...network, now, deadline }),
    require("./lib/dataset-refresh").recoverDatasetRefreshJobs({ firestore }),
  ]);
  const errors = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason);
  if (errors.length) {
    const owners = ["posts", "pages", "records", "datasets"];
    log.error("Public confirmation recovery failed", { failures: outcomes.flatMap((outcome, index) => outcome.status === "rejected"
      ? [{ owner: owners[index], causes: confirmationErrorCauses(outcome.reason) }] : []) });
    throw new AggregateError(errors, "Public confirmation recovery is unavailable");
  }
}


const onNoBuildPostConfirmationRecovery = onSchedule({
  schedule: "every 1 minutes", timeZone: "UTC", timeoutSeconds: 60,
  minInstances: 0, maxInstances: 1, concurrency: 1, retryCount: 0,
  secrets: DEVELOPMENT ? confirmationSecrets : [PURGE_TOKEN, CMS_EDGE_ORIGIN_SECRET, productionAlerts.TELEGRAM_BOT_TOKEN],
}, async () => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  // Alert even when confirmation fails, with no dependency on the build host.
  try {
    await recoverNoBuildPublications();
  }
  finally {
    if (!DEVELOPMENT) await require("./lib/post-background-alerts").checkPostBackgroundAlerts({ firestore: db, send: message => {
      const client = productionAlerts.createTelegramClient({ fetchFn: (url, options) =>
        fetch(url, { ...options, signal: AbortSignal.timeout(5_000) }) });
      return client.sendMessage(productionAlerts.TELEGRAM_CHAT_ID.value(), message);
    } });
  }
});

module.exports = { createNoBuildPostConfirmationHandler, recoverNoBuildPublications, onNoBuildPostConfirmation, onNoBuildPostConfirmationRecovery };

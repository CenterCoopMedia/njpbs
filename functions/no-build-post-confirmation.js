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
const { callOutside, platformLimit } = require("./lib/release-wait");
const { CMS_EDGE_ORIGIN_SECRET } = require("./lib/cms-edge");
const DEVELOPMENT = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
const productionAlerts = DEVELOPMENT ? null : require("./bug-report-delivery");

const PURGE_TOKEN = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");
const ZONE_ID = defineString("CMS_MEDIA_CLOUDFLARE_ZONE_ID", { default: "" });
const DEV_ACCESS_ID = DEVELOPMENT ? defineSecret("CMS_DEV_ACCESS_CLIENT_ID") : null;
const DEV_ACCESS_SECRET = DEVELOPMENT ? defineSecret("CMS_DEV_ACCESS_CLIENT_SECRET") : null;
const confirmationSecrets = [PURGE_TOKEN, CMS_EDGE_ORIGIN_SECRET, ...(DEVELOPMENT ? [DEV_ACCESS_ID, DEV_ACCESS_SECRET] : [])];
// One proof holds every published detail and exceeds the 256 MiB default. The
// platform kills that process before it can record its attempt.
const CONFIRMATION_MEMORY = "1GiB";
const purgeConfigFn = () => ({ zoneId: ZONE_ID.value(), token: PURGE_TOKEN.value() });
const readbackOptions = () => ({ target: publicationTarget(DEVELOPMENT ? "development" : "production"),
  headers: DEVELOPMENT ? { "cf-access-client-id": DEV_ACCESS_ID.value(), "cf-access-client-secret": DEV_ACCESS_SECRET.value() } : {} });

// A claim made by this event cannot outlive the event.
const EVENT_SECONDS = platformLimit("cloudFunctionsEventSeconds");

function createNoBuildPostConfirmationHandler(deps = {}) {
  const { firestore = db, config = purgeConfigFn, readback = readbackOptions, ...network } = deps;
  return async event => {
    const queue = event.data?.after.data();
    const before = event.data?.before?.data();
    if (queue?.transport === "public-context-no-build-v1" && before) {
      // Manual check results and recovery-index ordering never dispatch work.
      const previous = { ...before }, current = { ...queue };
      delete previous.lastPublicCheck;
      delete current.lastPublicCheck;
      if (queue.recordPublication) {
        delete previous.recordConfirmationPendingAt;
        delete current.recordConfirmationPendingAt;
      }
      if (isDeepStrictEqual(previous, current)) return;
    }
    if (queue?.transport === "public-context-no-build-v1" && queue.status === "success" &&
        before?.status !== "success" && queue.aggregateReceipt) {
      // Transient failures keep this event eligible for redelivery before it
      // starts public readback. The minute scheduler can confirm other owners.
      await require("./lib/settings-publication").resumeSupersededSettingsAfterContext({ firestore, operationId: event.params.queueId });
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
        // Context acceptance and settlement both give a natural wake.
        // Catalog failure cannot make another owner's context job fail.
        try { await recoverNoBuildHomeCatalog({ firestore, ...readback(), ...network }); } catch { /* Later context/recovery wake retries. */ }
        // A settings publication proves its Page and Home consumers on this
        // same wake. The minute scheduler remains the recovery path.
        if (queue.settingsPublication || queue.libraryCardPublication || queue.recordPublication) {
          // Loaded here: its import graph declares a secret that the development manifest must not carry.
          try { await require("./lib/no-build-page-settings-confirmation").confirmNoBuildPageSettings({ firestore, operationId: event.params.queueId, ...readback(), ...network,
            platformSeconds: EVENT_SECONDS }); }
          catch { /* The minute scheduler repeats the settings consumer proof. */ }
        }
        if (queue.recordPublication) {
          try { await require("./lib/no-build-record-confirmation").recoverNoBuildRecordPublication({ firestore,
            operationId: event.params.queueId, ...readback(), ...network, platformSeconds: EVENT_SECONDS }); }
          catch { /* The recovery wake retains the accepted source. */ }
        }
      }
      return;
    }
    if (queue?.transport === PAGE_TRANSPORT) {
      if (queue.status !== "pending" || queue.claim || queue.nextAttemptAt === null || queue.nextAttemptAt > Date.now()) return;
      await recoverNoBuildPageDetail({ firestore, ...readback(), ...network, operationId: event.params.queueId, platformSeconds: EVENT_SECONDS });
      return;
    }
    if (queue?.transport !== TRANSPORT || (!postProofDue(queue, Date.now()) &&
        (queue.status !== "pending" || queue.claim || queue.nextAttemptAt === null || queue.nextAttemptAt > Date.now()))) return;
    await recoverNoBuildPostDetail({ firestore, ...readback(), ...network, purgeConfig: config(), operationId: event.params.queueId, platformSeconds: EVENT_SECONDS });
  };
}

// Acceptance and explicit retries wake detail confirmation independently of the
// publisher's build lock. The same durable claim deduplicates delivered events.
const onNoBuildPostConfirmation = onDocumentWritten({
  document: "cmsPublishQueue/{queueId}", retry: true, timeoutSeconds: platformLimit("cloudFunctionsEventSeconds"), memory: CONFIRMATION_MEMORY,
  minInstances: 0, maxInstances: 2, concurrency: 4, secrets: confirmationSecrets,
}, async event => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  await createNoBuildPostConfirmationHandler()(event);
});

async function recoverNoBuildPublications({ firestore = db, config = purgeConfigFn, readback = readbackOptions,
  now = Date.now, log = logger, ...network } = {}) {
  // Start each independent owner together; none waits on another.
  const outcomes = await Promise.allSettled([
    recoverNoBuildPostDetail({ firestore, ...readback(), ...network, now, purgeConfig: config() }),
    recoverNoBuildPageDetail({ firestore, ...readback(), ...network, now }),
    require("./lib/no-build-record-confirmation").recoverNoBuildRecordPublication({ firestore, ...readback(), ...network, now }),
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
  schedule: "every 1 minutes", timeZone: "UTC", timeoutSeconds: platformLimit("cloudFunctionsScheduleSeconds"), memory: CONFIRMATION_MEMORY,
  minInstances: 0, maxInstances: 1, concurrency: 1, retryCount: 0,
  secrets: DEVELOPMENT ? confirmationSecrets : [PURGE_TOKEN, CMS_EDGE_ORIGIN_SECRET, productionAlerts.TELEGRAM_BOT_TOKEN],
}, async () => {
  if (process.env.FUNCTIONS_EMULATOR === "true") return;
  // Alert while confirmation still waits, with no dependency on the build host.
  const alert = async () => {
    if (DEVELOPMENT) return;
    await require("./lib/post-background-alerts").checkPostBackgroundAlerts({ firestore: db, send: message =>
      callOutside("Telegram alert", () => productionAlerts.createTelegramClient({ fetchFn: fetch })
        .sendMessage(productionAlerts.TELEGRAM_CHAT_ID.value(), message)) });
  };
  const failed = (await Promise.allSettled([recoverNoBuildPublications(), alert()])).find(outcome => outcome.status === "rejected");
  if (failed) throw failed.reason;
});

module.exports = { createNoBuildPostConfirmationHandler, recoverNoBuildPublications, onNoBuildPostConfirmation, onNoBuildPostConfirmationRecovery };

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { CMS_EDGE_ORIGIN_SECRET, CMS_EDGE_HEADER } = require("./lib/cms-edge");

const SAVE_URL = "https://us-central1-njpbs-site.cloudfunctions.net/cmsSaveContent";

function createCmsSaveWarmupHandler({
  fetchImpl = fetch,
  readEdgeSecret = () => CMS_EDGE_ORIGIN_SECRET.value(),
  log = logger,
} = {}) {
  return async () => {
    try {
      const response = await fetchImpl(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", [CMS_EDGE_HEADER]: readEdgeSecret() },
        body: JSON.stringify({ mode: "warm" }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Warmup refused");
      const receipt = await response.json();
      if (receipt?.warmed !== true) throw new Error("Warmup receipt missing");
    } catch {
      // Never log the request, headers, secret, or a provider error body.
      log.warn("cmsSaveContent warmup failed");
    }
  };
}

const onCmsSaveWarmup = onSchedule({
  schedule: "*/5 9-20 * * *", timeZone: "America/New_York", region: "us-central1",
  timeoutSeconds: 15, minInstances: 0, maxInstances: 1, concurrency: 1,
  retryCount: 0, maxRetrySeconds: 0, secrets: [CMS_EDGE_ORIGIN_SECRET],
}, createCmsSaveWarmupHandler());

module.exports = { createCmsSaveWarmupHandler, onCmsSaveWarmup };

"use strict";

const QUEUE_COLLECTION = "cmsPublishQueue";
const NON_TERMINAL_STATUSES = ["reserved", "pending", "publishing"];
// Rows a removed 24-hour reconciliation marked failed carry this error.
// Writeback and dev publication still recognize those rows.
const STALE_PUBLISH_ERROR =
  "Publish marked failed during reconciliation because no terminal workflow status was recorded within 24 hours.";

function timestampToMillis(value) {
  let milliseconds = null;
  if (value && typeof value.toMillis === "function") {
    milliseconds = value.toMillis();
  } else if (value instanceof Date) {
    milliseconds = value.getTime();
  }
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

module.exports = {
  NON_TERMINAL_STATUSES,
  QUEUE_COLLECTION,
  STALE_PUBLISH_ERROR,
  timestampToMillis,
};

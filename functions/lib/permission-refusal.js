"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const { isAccessTier } = require("./rbac");
const { usageHash } = require("./usage-person");

const records = new AsyncLocalStorage();

// The caller's stored access level for the log; "none" when it has none.
const accessTierOf = profile => isAccessTier(profile?.accessTier) ? profile.accessTier : "none";

// The outermost CMS edge wrapper opens one record per request; a nested wrapper gets null and
// reuses the outer record, so a refusal is logged once.
function openRefusalRecord() {
  return records.getStore() ? null : {};
}

function runWithRefusalRecord(record, run) {
  return record ? records.run(record, run) : run();
}

/**
 * The shared auth helpers record who is calling and, when they refuse, the level that was
 * required. Only the usage-analytics digest of the uid is kept.
 * @param {{ uid?: string, accessTier?: string, required?: string }} fields
 */
function markCaller({ uid, accessTier, required }) {
  const record = records.getStore();
  if (!record) return;
  if (typeof uid === "string") record.caller = usageHash(uid);
  if (accessTier !== undefined) record.accessTier = accessTier;
  if (required !== undefined) record.required = required;
}

function permissionRefusal(record, functionName, requestId) {
  return {
    event: "permission_refused",
    function: functionName ?? null,
    required: record.required ?? null,
    accessTier: record.accessTier ?? null,
    caller: record.caller ?? null,
    requestId: requestId ?? null,
  };
}

module.exports = { accessTierOf, markCaller, openRefusalRecord, permissionRefusal, runWithRefusalRecord };

"use strict";

const { linkedRequests } = require("./session-refusal");
const { usageHash } = require("./usage-person");

const callers = new WeakMap();

// The shared auth helpers record who is calling and, when they refuse, the level that was
// required. The CMS edge reads it back if the response is a 403 (functions/lib/cms-edge.js).
// Only the usage-analytics digest of the uid is kept.
function markCaller(req, { uid, accessTier, required } = {}) {
  if (!req || typeof req !== "object") return;
  const fields = {
    ...(typeof uid === "string" ? { caller: usageHash(uid) } : {}),
    ...(accessTier !== undefined ? { accessTier } : {}),
    ...(required !== undefined ? { required } : {}),
  };
  for (const target of linkedRequests(req)) callers.set(target, { ...callers.get(target), ...fields });
}

function permissionRefusal(req, functionName, requestId) {
  const caller = callers.get(req) ?? {};
  return {
    event: "permission_refused",
    function: functionName ?? null,
    required: caller.required ?? null,
    accessTier: caller.accessTier ?? null,
    caller: caller.caller ?? null,
    requestId: requestId ?? null,
  };
}

module.exports = { markCaller, permissionRefusal };

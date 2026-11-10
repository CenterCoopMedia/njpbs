"use strict";

// The TVSS schedule proxy endpoint (#185, #187, #188). This file is only the
// Firebase wiring: it reads the secret and deploy params, then hands a fully
// injected handler to onRequest. All behavior worth testing lives in the
// firebase-free modules under lib/ (schedule-proxy.js, schedule-handler.js,
// schedule-day.js, ../lib/http-headers.js).

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { createScheduleHandler } = require("./lib/pbs/schedule-handler");
const { DEFAULT_ALLOWED_ORIGINS } = require("./lib/http-headers");

// #187: the TVSS X-PBSAUTH key lives in Google Secret Manager, never in code or
// config. The live value is blocked on the external PBS-credentials issues (#191,
// #206); until it is set the proxy reads an empty value and reports
// `not-configured`. Set it with:
//   firebase functions:secrets:set PBS_TVSS_AUTH
const PBS_TVSS_AUTH = defineSecret("PBS_TVSS_AUTH");

// The station callsign TVSS listings are scoped to. WNJT is NJ PBS's callsign;
// overridable per deploy.
const TVSS_CALLSIGN = defineString("TVSS_CALLSIGN", { default: "wnjt" });

// Comma-separated extra browser origins allowed to call the proxy, merged with
// the built-in static-front origins. Empty by default.
const PROXY_EXTRA_ORIGINS = defineString("PROXY_EXTRA_ORIGINS", { default: "" });

function resolveAllowlist() {
  const extra = PROXY_EXTRA_ORIGINS.value()
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

function resolveAuthKey() {
  // .value() returns "" when the secret is unset; normalize any falsy or missing
  // value to null. Let a read failure reach the handler's retryable error path.
  const value = PBS_TVSS_AUTH.value();
  return value ? value : null;
}

function resolveTransform() {
  // The checked-in fixture is from the public JAWS providers-feed, not this
  // authenticated endpoint. Keep the proxy honestly not-configured until a
  // sanitized response from the exact URL proves the staged mapper compatible.
  return undefined;
}

const scheduleProxy = onRequest(
  { secrets: [PBS_TVSS_AUTH], region: "us-central1" },
  createScheduleHandler({
    getAuthKey: resolveAuthKey,
    getTransform: resolveTransform,
    getAllowlist: resolveAllowlist,
    getDefaultCallsign: () => TVSS_CALLSIGN.value(),
  }),
);

module.exports = {
  scheduleProxy,
  PBS_TVSS_AUTH,
  TVSS_CALLSIGN,
  PROXY_EXTRA_ORIGINS,
  resolveAllowlist,
  resolveAuthKey,
  resolveTransform,
};

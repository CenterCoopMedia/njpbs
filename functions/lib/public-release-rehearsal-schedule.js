"use strict";

const bindings = new WeakMap();
const CONFIGURATION = "development-public-release-rehearsal-v1";
const refuse = () => { throw new Error("Rehearsal schedule binding refused"); };

function environment(firestore) {
  const env = process.env;
  if (![undefined, "development", "emulator"].includes(env.CMS_DEPLOYMENT_ENVIRONMENT) ||
      // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, GCLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS
      // config-input: GOOGLE_CLOUD_PROJECT
      ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG", "FIREBASE_AUTH_EMULATOR_HOST"].some(key => env[key] !== undefined)) refuse();
  const demo = /^demo-[a-z0-9-]+$/.test(firestore?.projectId ?? "") && /^127\.0\.0\.1:\d+$/.test(env.FIRESTORE_EMULATOR_HOST ?? "");
  const development = firestore?.projectId === "njpbs-site-dev" && env.FIRESTORE_EMULATOR_HOST === undefined && env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, GCLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS
  // config-input: GOOGLE_CLOUD_PROJECT
  if (!demo && !development || ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"].some(key => env[key] !== undefined && env[key] !== firestore.projectId)) refuse();
  return demo ? env.FIRESTORE_EMULATOR_HOST : null;
}

/** Process-local intent for the named private rehearsal. JSON, a runtime flag
 * or a production SDK cannot grant the scoped writer permission. */
function createRehearsalScheduledSourceBinding({ firestore, configuration, runId, pair: rawPair, source, authorized = false }) {
  if (authorized !== true || configuration !== CONFIGURATION || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(runId ?? "")) refuse();
  const host = environment(firestore), protocol = require("./public-release-pair");
  const pair = protocol.parsePublicReleasePair(rawPair);
  if (pair.environment !== "development") refuse();
  require("./public-release-pair-work").assertPrivatePairResources(pair);
  if (!source || Object.keys(source).sort().join(",") !== "collection,id,publishAt,version" ||
      !["cmsPosts", "cmsPages"].includes(source.collection) || !/^[A-Za-z0-9_-]{1,128}$/.test(source.id ?? "") ||
      !Number.isSafeInteger(source.version) || source.version < 1 || typeof source.publishAt !== "string" ||
      !Number.isFinite(Date.parse(source.publishAt)) || new Date(source.publishAt).toISOString() !== source.publishAt) refuse();
  const handle = Object.freeze({});
  bindings.set(handle, { firestore, host, value: protocol.freeze({ configuration, runId,
    source: { ...source }, selectedPair: protocol.publicReleasePairReference(pair) }) });
  return handle;
}

function readRehearsalScheduledSourceBinding(handle, firestore) {
  const binding = bindings.get(handle);
  if (!binding || binding.firestore !== firestore || binding.host !== environment(firestore)) refuse();
  return binding.value;
}

module.exports = { CONFIGURATION, createRehearsalScheduledSourceBinding, readRehearsalScheduledSourceBinding };

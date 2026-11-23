"use strict";

const { isDeepStrictEqual } = require("node:util");
const { PreparedPublicReleaseError } = require("./public-release-error");
const fields = ["PUBLIC_GA4_MEASUREMENT_ID", "PUBLIC_REPORT_ENDPOINT",
  "PUBLIC_SHARE_INTAKE_ENDPOINT", "PUBLIC_TURNSTILE_SITEKEY"];

function refuse() {
  throw new PreparedPublicReleaseError("The prepared public build settings are missing or differ");
}
function exact(value, names) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
// The development compiler gets no analytics, report or share values, so its
// receipt names development and records none. It never matches production values.
function settings(value, environment) {
  if (environment === "development") {
    if (!exact(value, [])) refuse();
    return {};
  }
  if (!exact(value, fields) || fields.some(name => typeof value[name] !== "string" ||
      !value[name] || value[name].length > 2048 || value[name].trim() !== value[name] || /[\r\n]/.test(value[name])) ||
      !/^G-[A-Z0-9]+$/.test(value.PUBLIC_GA4_MEASUREMENT_ID)) refuse();
  for (const name of ["PUBLIC_REPORT_ENDPOINT", "PUBLIC_SHARE_INTAKE_ENDPOINT"]) {
    let url;
    try { url = new URL(value[name]); } catch { refuse(); }
    if (url.protocol !== "https:" || url.username || url.password || url.href !== value[name]) refuse();
  }
  return Object.fromEntries(fields.map(name => [name, value[name]]));
}
function project(value, commitSha) {
  const development = value?.environment === "development";
  if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/.test(commitSha) ||
      !exact(value, ["schemaVersion", "commitSha", "values", "overridesAbsent", ...(development ? ["environment"] : [])]) ||
      value.schemaVersion !== 1 || value.commitSha !== commitSha || typeof value.overridesAbsent !== "boolean") refuse();
  return { schemaVersion: 1, commitSha, ...(development ? { environment: "development" } : {}),
    values: settings(value.values, value.environment), overridesAbsent: value.overridesAbsent };
}

/** Capture the effective compiler allowlist, never the ambient environment. */
function createPublicBuildSettings(commitSha, compilerEnvironment, requestedEnvironment) {
  if (!requestedEnvironment || typeof requestedEnvironment !== "object") refuse();
  const development = compilerEnvironment?.CMS_DEPLOYMENT_ENVIRONMENT === "development";
  return project({ schemaVersion: 1, commitSha, ...(development ? { environment: "development" } : {}),
    values: development ? {} : Object.fromEntries(fields.map(name => [name, compilerEnvironment[name]])),
    overridesAbsent: !Object.keys(requestedEnvironment).some(name => name === "PUBLIC_SHARE_PAGE" ||
      name === "PUBLIC_SHARE_UPLOAD_ORIGIN" || name.startsWith("NO_BUILD_POST_")) }, commitSha);
}

function assertPreparedPublicBuildSettings(value, commitSha, expectedValues) {
  const result = project(value, commitSha);
  if (!result.overridesAbsent || expectedValues !== undefined &&
      !isDeepStrictEqual(result.values, settings(expectedValues, result.environment))) refuse();
  return result;
}

module.exports = { createPublicBuildSettings, assertPreparedPublicBuildSettings };

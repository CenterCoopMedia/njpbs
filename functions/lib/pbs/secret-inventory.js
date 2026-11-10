"use strict";

/**
 * Executable inventory of the PBS credential boundary.
 *
 * Names appear here only after the repository has a real consumer that uses
 * them. An empty names array is deliberate: it prevents a planning label from
 * becoming an accidental deployment contract before PBS provisions the
 * integration and its exact credential shape is verified.
 */
const PBS_SECRET_INVENTORY = Object.freeze([
  Object.freeze({
    id: "tvss",
    label: "TVSS X-PBSAUTH",
    endpoint: "https://tvss.services.pbs.org/tvss/<callsign>/day/<date>/",
    trustTier: "runtime (Cloud Functions)",
    implementation:
      "functions/schedule.js -> functions/lib/pbs/schedule-proxy.js",
    status: "source-defined; export and provisioning deferred",
    runtimeHandles: Object.freeze(["PBS_TVSS_AUTH"]),
    buildEnvironmentNames: Object.freeze([]),
  }),
  Object.freeze({
    id: "media-manager",
    label: "Media Manager key and secret",
    endpoint: "https://media.services.pbs.org/api/v1/",
    trustTier: "build time (GitHub Actions); unexported runtime transport",
    implementation:
      "site/scripts/sync-launch-content.mjs, site/scripts/probe-launch-content.mjs and functions/lib/pbs/media-manager-lookup.js",
    status: "implemented build-time consumer; runtime transport built, not exported",
    runtimeHandles: Object.freeze([]),
    buildEnvironmentNames: Object.freeze([
      "MEDIA_MANAGER_API_KEY",
      "MEDIA_MANAGER_API_SECRET",
    ]),
  }),
  Object.freeze({
    id: "pmsso",
    label: "PMSSO client secret",
    endpoint: "PBS partner-gated PMSSO authorize and token endpoints",
    trustTier: "runtime (Cloud Functions)",
    implementation: "credential-free core only: site/src/lib/pmsso-login.ts",
    status: "unbuilt; external provisioning required",
    runtimeHandles: Object.freeze([]),
    buildEnvironmentNames: Object.freeze([]),
  }),
  Object.freeze({
    id: "mvault",
    label: "MVault keypair",
    endpoint: "https://mvault.services.pbs.org/api/",
    trustTier: "runtime (Cloud Functions)",
    implementation:
      "functions/lib/pbs/mvault-lookup.js and deployable mvault-entitlement.js decision mirror",
    status: "built, not exported; external provisioning required",
    runtimeHandles: Object.freeze([]),
    buildEnvironmentNames: Object.freeze([]),
  }),
  Object.freeze({
    id: "laas",
    label: "PBS Account (LAAS) access key",
    endpoint: "PBS Account / Login-as-a-Service (partner-gated exact endpoint unverified)",
    trustTier: "runtime (Cloud Functions)",
    implementation:
      "no credentialed consumer; VPPA policy is modeled by site/src/lib/member-gated-playback.ts",
    status: "unbuilt; external provisioning required",
    runtimeHandles: Object.freeze([]),
    buildEnvironmentNames: Object.freeze([]),
  }),
]);

module.exports = { PBS_SECRET_INVENTORY };

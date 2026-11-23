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
    trustTier: "build time (GitHub Actions)",
    implementation:
      "site/scripts/sync-launch-content.mjs and site/scripts/probe-launch-content.mjs",
    status: "implemented build-time consumer",
    runtimeHandles: Object.freeze([]),
    buildEnvironmentNames: Object.freeze([
      "MEDIA_MANAGER_API_KEY",
      "MEDIA_MANAGER_API_SECRET",
    ]),
  }),
]);

module.exports = { PBS_SECRET_INVENTORY };

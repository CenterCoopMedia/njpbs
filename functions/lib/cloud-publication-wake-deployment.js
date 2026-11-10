"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { publicationTarget } = require("./publication-target");
const CLOUD_WAKE_FUNCTIONS = Object.freeze(["onNoBuildCloudState", "onNoBuildCloudCandidate", "onNoBuildCloudRelease"]);
const DEPLOYMENT_PATH = join(__dirname, "..", "cloud-publication-wake.generated.json");

// Firebase discovery excludes shell and functions dotenv flags. The same
// target-bound artifact controls discovery and runtime; an absent one is off.
function readCloudPublicationWakeDeployment({ path = DEPLOYMENT_PATH, env = process.env } = {}) {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 512) throw new Error();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 3 ||
        Object.keys(value).some(key => !["schemaVersion", "environment", "enabled"].includes(key)) ||
        value.schemaVersion !== 1 || typeof value.enabled !== "boolean") throw new Error();
    const target = publicationTarget(value.environment);
    if (env.GCLOUD_PROJECT !== target.projectId ||
        env.GOOGLE_CLOUD_PROJECT !== undefined && env.GOOGLE_CLOUD_PROJECT !== target.projectId) throw new Error();
    return Object.freeze({ enabled: value.enabled, environment: target.environment });
  } catch { return Object.freeze({ enabled: false, environment: "production" }); }
}

module.exports = { CLOUD_WAKE_FUNCTIONS, DEPLOYMENT_PATH, readCloudPublicationWakeDeployment };

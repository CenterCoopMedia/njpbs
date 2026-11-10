"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function readPurgeDeployment(path = join(__dirname, "..", "media-purge.generated.json"), env = process.env) {
  try {
    if (env.GCLOUD_PROJECT && env.GCLOUD_PROJECT !== "njpbs-site" ||
        env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== "njpbs-site") throw new Error();
    const raw = readFileSync(path, "utf8");
    const value = raw.length <= 512 ? JSON.parse(raw) : null;
    if (!value || value.schemaVersion !== 1 || value.projectId !== "njpbs-site" ||
        typeof value.enabled !== "boolean" || typeof value.realDeletesEnabled !== "boolean" ||
        Object.keys(value).length !== 4) throw new Error();
    return Object.freeze({ enabled: value.enabled, realDeletesEnabled: value.enabled && value.realDeletesEnabled });
  } catch { return Object.freeze({ enabled: false, realDeletesEnabled: false }); }
}
module.exports = { readPurgeDeployment };

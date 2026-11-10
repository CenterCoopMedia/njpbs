"use strict";

// Firebase source discovery passes only its own variables, not .env values.
// This entry is dev-only, so default the environment before modules read it.
if (process.env.GCLOUD_PROJECT === "njpbs-site-dev") {
  process.env.CMS_DEPLOYMENT_ENVIRONMENT ??= "development";
}
if (process.env.GCLOUD_PROJECT !== "njpbs-site-dev" ||
    process.env.CMS_DEPLOYMENT_ENVIRONMENT !== "development") {
  throw new Error("Dev Functions require the njpbs-site-dev project and development environment");
}

const { setGlobalOptions } = require("firebase-functions/v2");
const { devFunctionManifest } = require("./dev-manifest");
const { readCloudPublicationWakeDeployment } = require("./lib/cloud-publication-wake-deployment");
setGlobalOptions({ region: "us-central1", minInstances: 0, maxInstances: 2 });

for (const [name, modulePath] of Object.entries(devFunctionManifest(readCloudPublicationWakeDeployment()))) {
  const handler = require(modulePath)[name];
  if (typeof handler !== "function") throw new Error(`Missing dev Function ${name}`);
  exports[name] = handler;
}

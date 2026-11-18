"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");

// Firebase resolves deployment params into the environment before cold start.
defineString("CMS_PUBLISH_GITHUB_APP_ID", { default: "" });
const configuredAppId = (process.env.CMS_PUBLISH_GITHUB_APP_ID ?? "").trim();

const publishSecretBindings = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development"
  ? [defineSecret("CMS_DEV_PUBLISH_APP_ID"), defineSecret("CMS_DEV_PUBLISH_APP_PRIVATE_KEY")]
  : [];

function readDevAppCredentials() {
  // Installation identity is configured separately from the approved App credentials.
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT !== "development") {
    throw new Error("Development publication App is unavailable outside development");
  }
  const appId = process.env.CMS_DEV_PUBLISH_APP_ID;
  const privateKey = process.env.CMS_DEV_PUBLISH_APP_PRIVATE_KEY;
  if (!/^[0-9]+$/.test(configuredAppId) || appId !== configuredAppId || !privateKey) {
    throw new Error("Development publication App credentials are not configured");
  }
  return { appId, privateKey };
}

module.exports = { publishSecretBindings, readDevAppCredentials };

"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");

// Firebase resolves deployment params into the environment before cold start.
defineString("CMS_PUBLISH_GITHUB_APP_ID", { default: "" });
const APP_ID = (process.env.CMS_PUBLISH_GITHUB_APP_ID ?? "").trim();

const isDev = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";
const GITHUB_TOKEN = isDev ? null : defineSecret("CMS_PUBLISH_GITHUB_TOKEN");
const DEV_APP_ID = isDev ? defineSecret("CMS_DEV_PUBLISH_APP_ID") : null;
const DEV_APP_PRIVATE_KEY = isDev ? defineSecret("CMS_DEV_PUBLISH_APP_PRIVATE_KEY") : null;
const publishSecretBindings = isDev ? [DEV_APP_ID, DEV_APP_PRIVATE_KEY] : [GITHUB_TOKEN];

function readDevAppCredentials() {
  // Installation identity is configured separately from the approved App credentials.
  if (!isDev || process.env.CMS_PUBLISH_GITHUB_TOKEN) {
    throw new Error("Development publication App configuration is mixed or invalid");
  }
  const appId = DEV_APP_ID.value();
  const privateKey = DEV_APP_PRIVATE_KEY.value();
  if (!/^[0-9]+$/.test(APP_ID) || appId !== APP_ID || !privateKey) {
    throw new Error("Development publication App credentials are not configured");
  }
  return { appId, privateKey };
}

module.exports = { GITHUB_TOKEN, publishSecretBindings, readDevAppCredentials, isDev };

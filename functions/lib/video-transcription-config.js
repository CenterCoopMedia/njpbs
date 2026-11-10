"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");
const KEY = defineSecret("CMS_TRANSCRIPTION_CREDENTIAL_KEY");
const KEY_VERSION = defineString("CMS_TRANSCRIPTION_CREDENTIAL_KEY_VERSION", { default: "" });
const BYOK_ENABLED = defineString("CMS_MEDIA_TRANSCRIPT_BYOK_ENABLED", { default: "false" });
const DATA_ROLE = defineString("CMS_MEDIA_TRANSCRIPT_BYOK_DATA_ROLE_ARN", { default: "" });
const CREDENTIAL_SERVICE_ACCOUNT = "cms-transcription-credentials@njpbs-site.iam.gserviceaccount.com";
const RUNNER_SERVICE_ACCOUNT = "cms-transcription-runner@njpbs-site.iam.gserviceaccount.com";

function isConfigured(config) {
  return config.region === "us-east-2" && /^\d{12}$/.test(config.renditionExpectedBucketOwner ?? "") &&
    config.roleArn === `arn:aws:iam::${config.renditionExpectedBucketOwner}:role/njpbs-boardwalk-transcription-byok-data` &&
    /^[1-9]\d{0,9}$/.test(config.keyVersion ?? "") && config.audience === "njpbs-boardwalk-s3" &&
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.renditionBucket ?? "");
}

module.exports = { KEY, KEY_VERSION, BYOK_ENABLED, DATA_ROLE, CREDENTIAL_SERVICE_ACCOUNT, RUNNER_SERVICE_ACCOUNT, isConfigured };

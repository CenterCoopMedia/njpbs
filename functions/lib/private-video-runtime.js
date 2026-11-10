"use strict";

const { defineSecret, defineString } = require("firebase-functions/params");
const { S3Client } = require("@aws-sdk/client-s3");
const { r2ClientConfig } = require("./r2-media");

const ENABLED = defineString("CMS_PRIVATE_VIDEO_ENABLED", { default: "false" });
const ENDPOINT = defineString("CMS_PRIVATE_VIDEO_R2_ENDPOINT", { default: "" });
const BUCKET = defineString("CMS_PRIVATE_VIDEO_R2_BUCKET", { default: "" });
const READ_ID = defineSecret("CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID");
const READ_KEY = defineSecret("CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY");
const WRITE_ID = defineSecret("CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID");
const WRITE_KEY = defineSecret("CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY");
const READ_SECRETS = [READ_ID, READ_KEY];
const WRITE_SECRETS = [WRITE_ID, WRITE_KEY];

const clients = new Map();
function configuredStorage(mode) {
  const write = mode === "write";
  if (!write && ENABLED.value() !== "true") return null;
  const endpoint = ENDPOINT.value().trim();
  const bucket = BUCKET.value().trim();
  if (!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw Error("private_video_configuration_invalid");
  const accessKeyId = (write ? WRITE_ID : READ_ID).value().trim();
  const secretAccessKey = (write ? WRITE_KEY : READ_KEY).value().trim();
  if (!accessKeyId || !secretAccessKey) throw Error("private_video_configuration_invalid");
  let client = clients.get(mode);
  if (!client) {
    // Streaming reads use the caller's header/body abort deadlines. An idle
    // socket limit could cut off input while the provider upload drains it.
    const requestTimeout = mode === "stream" ? 0 : write ? 30000 : 1500;
    client = new S3Client({ ...r2ClientConfig({ endpoint, accessKeyId, secretAccessKey }), maxAttempts: write ? 2 : 1,
      requestHandler: { connectionTimeout: write ? 3000 : 1000, requestTimeout, throwOnRequestTimeout: true } });
    clients.set(mode, client);
  }
  return { client, bucket };
}
const privateVideoStorage = (write = false) => configuredStorage(write ? "write" : "read");
const privateVideoStreamStorage = () => configuredStorage("stream");
module.exports = { ENABLED, READ_SECRETS, WRITE_SECRETS, privateVideoStorage, privateVideoStreamStorage };

"use strict";

// Written only by the trusted operator. Neither the CMS nor the publisher writes
// this record. Missing or invalid configuration cannot admit dynamic content.
const ADMISSION_PATH = "system/noBuildPostAdmission";
const fields = ["schemaVersion", "revision", "enabled", "postId", "backgroundBucket"];

function projectNoBuildAdmission(value, env = process.env) {
  const closed = { valid: false, enabled: false, postId: "", backgroundBucket: "", admissionRevision: null };
  if (!value || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.enabled !== "boolean" || typeof value.postId !== "string" || typeof value.backgroundBucket !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.postId ?? "") ||
      !/^[a-z0-9][a-z0-9._-]{2,220}$/.test(value.backgroundBucket ?? "")) return closed;
  const config = { valid: true, enabled: value.enabled, postId: value.postId,
    backgroundBucket: value.backgroundBucket, admissionRevision: value.revision };
  // Temporary migration fence: present legacy settings must agree. Removing
  // them is a one-time rollout step; later record changes need no restart.
  const legacy = { NO_BUILD_POST_ENABLED: String(value.enabled), NO_BUILD_POST_ID: value.postId,
    NO_BUILD_POST_BACKGROUND_BUCKET: value.backgroundBucket };
  // config-input: NO_BUILD_POST_BACKGROUND_BUCKET, NO_BUILD_POST_ENABLED, NO_BUILD_POST_ID
  if (Object.entries(legacy).some(([key, expected]) => env[key] !== undefined && env[key] !== expected)) {
    return { ...config, valid: false, enabled: false };
  }
  return config;
}

async function readNoBuildAdmission({ firestore, transaction, env = process.env }) {
  const ref = firestore.doc(ADMISSION_PATH);
  const snapshot = await (transaction ? transaction.get(ref) : ref.get());
  return projectNoBuildAdmission(snapshot.data(), env);
}

module.exports = { ADMISSION_PATH, projectNoBuildAdmission, readNoBuildAdmission };

"use strict";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const isDigest = value => typeof value === "string" && DIGEST.test(value);
function isSupportedNode(value) {
  if (typeof value !== "string" || !/^22\.\d+\.\d+$/.test(value)) return false;
  const [, minor, patch] = value.split(".").map(Number);
  return minor > 23 || (minor === 23 && patch >= 4);
}

function assertSourceSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) throw new TypeError("Invalid connector source revision");
  return value;
}
function manifestKey(sourceSha) {
  return `studio-connectors/${assertSourceSha(sourceSha)}/manifest.json`;
}
function packageKey(sourceSha, sha256) {
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) throw new TypeError("Invalid connector checksum");
  return `studio-connectors/${assertSourceSha(sourceSha)}/${sha256}.zip`;
}
function parseConnectorManifest(value, sourceSha) {
  const fields = ["schemaVersion", "sourceSha", "sha256", "bundleSha256", "sizeBytes", "filename", "nodeVersion", "nodeArchiveSha256"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== fields.sort().join() || value.schemaVersion !== 1 ||
      value.sourceSha !== assertSourceSha(sourceSha) || !isDigest(value.sha256) || !isDigest(value.bundleSha256) ||
      !isDigest(value.nodeArchiveSha256) || !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 1 || value.sizeBytes > MAX_PACKAGE_BYTES ||
      value.filename !== `NJPBS-Studio-connector-${sourceSha.slice(0, 8)}.zip` ||
      !isSupportedNode(value.nodeVersion)) throw new TypeError("Invalid connector package manifest");
  return value;
}

module.exports = { assertSourceSha, manifestKey, packageKey, parseConnectorManifest, MAX_PACKAGE_BYTES };

"use strict";

const { createHash } = require("node:crypto");
const { outputLimits, SEARCH_FILES_MAX, RECORD_FAMILIES } = require("./no-build-record-namespace");
const { backgroundOutputForPath, isBackgroundAssetPath } = require("./post-background-paths");
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const cache = new Map();
// One current and one retained manifest for each reference-backed family.
const MAX_CACHED_MANIFESTS = 2 * (RECORD_FAMILIES.length + 1);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function requireValue(value) { if (!value) throw new Error("Record output manifest is unavailable"); }
const assetPathHashes = files => files.filter(file => file.path.startsWith("/_astro/")).map(file => hash(file.path)).sort();
function recordManifestOwnsAsset(receipt, path) {
  const hashes = receipt?.fileManifest?.assetPathHashes;
  requireValue(Array.isArray(hashes) && hashes.length <= 4096 && new Set(hashes).size === hashes.length &&
    hashes.every(value => /^[a-f0-9]{64}$/.test(value)));
  return hashes.includes(hash(path));
}
function manifestKey(task) { return `post-background-v1/${task.output}/${task.claim}/manifest.json`; }
async function storeRecordManifest({ manifest, task, artifacts, signal, checkpoint }) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  requireValue(bytes.length <= MAX_MANIFEST_BYTES);
  const key = manifestKey(task), digest = hash(bytes);
  await artifacts.put(key, bytes, { contentType: "application/json", signal });
  const stored = await artifacts.get(key, { signal });
  requireValue(stored instanceof Uint8Array && stored.length === bytes.length && hash(stored) === digest);
  return { key, digest, size: bytes.length, count: manifest.length, assetPathHashes: assetPathHashes(manifest), ...(checkpoint ? { checkpoint } : {}) };
}
async function readRecordManifest({ receipt, output, artifacts, signal, scope }) {
  const ref = receipt.fileManifest;
  const claim = /^post-background-v1\/(programs|events|search)\/([a-f0-9-]{36})\/manifest\.json$/.exec(ref?.key ?? "");
  requireValue(ref && (Object.keys(ref).length === 5 && ref.checkpoint === undefined || Object.keys(ref).length === 6 && ref.checkpoint &&
      Object.keys(ref.checkpoint).length === 2 && /^[A-Za-z0-9]{20}$/.test(ref.checkpoint.operationId ?? "") && /^[a-f0-9]{64}$/.test(ref.checkpoint.checkpointDigest ?? "")) && claim?.[1] === output && /^[a-f0-9]{64}$/.test(ref.digest ?? "") &&
    Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= MAX_MANIFEST_BYTES &&
    Number.isSafeInteger(ref.count) && ref.count > 0 && ref.count <= (output === "search" ? SEARCH_FILES_MAX : outputLimits(output).files));
  const identity = `${scope}:${JSON.stringify(ref)}`;
  if (cache.has(identity)) return cache.get(identity);
  const bytes = await artifacts.get(ref.key, { signal });
  requireValue(bytes instanceof Uint8Array && bytes.length === ref.size && hash(bytes) === ref.digest);
  const files = JSON.parse(Buffer.from(bytes).toString("utf8"));
  requireValue(Array.isArray(files) && files.length === ref.count);
  const paths = new Set();
  let size = 0;
  for (const file of files) {
    requireValue(file && Object.keys(file).length === 5 && typeof file.path === "string" && file.path.length <= 512 &&
      !/[%?#\\\s]/.test(file.path) && file.path.startsWith("/") && !file.path.includes("//") && new URL(file.path, "https://background.invalid").pathname === file.path &&
      (backgroundOutputForPath(file.path) === output || isBackgroundAssetPath(file.path)) && !paths.has(file.path) &&
      (ref.checkpoint ? file.key === `post-background-v1/preparation/${ref.checkpoint.operationId}/${receipt.contextDigest}/bytes/${file.digest}`
        : file.key === `post-background-v1/${output}/${claim[2]}/${hash(file.path)}`) && /^[a-f0-9]{64}$/.test(file.digest ?? "") &&
      Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 16 * 1024 * 1024 &&
      typeof file.contentType === "string" && file.contentType.length <= 128 && !/[\r\n]/.test(file.contentType));
    paths.add(file.path); size += file.size;
    requireValue(size <= outputLimits(output).bytes);
    Object.freeze(file);
  }
  requireValue(JSON.stringify(assetPathHashes(files)) === JSON.stringify(ref.assetPathHashes));
  Object.freeze(files);
  cache.set(identity, files);
  while (cache.size > MAX_CACHED_MANIFESTS) cache.delete(cache.keys().next().value);
  return files;
}
module.exports = { storeRecordManifest, readRecordManifest, recordManifestOwnsAsset };

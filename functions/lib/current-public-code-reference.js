"use strict";

const CURRENT_CODE_BYTES = 16 * 1024 * 1024;
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse() { throw Object.assign(new Error("Private current CODE source is unavailable"), { status: 409 }); }
function fields(value, names, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key) && !optional.includes(key)) ||
      names.some(key => !Object.hasOwn(value, key))) refuse();
}

/** Validate a retained CODE reference without a current-source transport. */
function validateCurrentCodeReference(value) {
  fields(value, ["publication", "manifest"]);
  const publication = value.publication, manifest = value.manifest;
  fields(publication, ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha", "artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"]);
  if (publication.schemaVersion !== 1 || publication.digestAlgorithm !== "sha256" || (typeof publication.buildBatchId !== "string" || !/^cms-[A-Za-z0-9]{20}$/.test(publication.buildBatchId)) ||
      Buffer.byteLength(publication.buildBatchId) > 128 || !Number.isSafeInteger(publication.generation) || publication.generation < 1 ||
      (typeof publication.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(publication.commitSha)) || !["artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"].every(key => validDigest(publication[key]))) refuse();
  fields(manifest, ["schemaVersion", "buildBatchId", "artifactReceiptDigest", "sha256", "byteLength", "key"]);
  if (manifest.schemaVersion !== 1 || manifest.buildBatchId !== publication.buildBatchId ||
      !/^cms-[A-Za-z0-9]{20}$/.test(publication.buildBatchId) || manifest.artifactReceiptDigest !== publication.artifactReceiptDigest ||
      !validDigest(manifest.sha256) || !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 1 ||
      manifest.byteLength > CURRENT_CODE_BYTES || manifest.key !== `public-context/${publication.buildBatchId}/${manifest.sha256}.json`) refuse();
  return structuredClone(value);
}

module.exports = { CURRENT_CODE_BYTES, validateCurrentCodeReference };

"use strict";

// Pure receipt validation: library projections must not load the storage SDK or probe R2.
const MASTER_EXTENSIONS = Object.freeze({ "image/jpeg": "jpg", "image/png": "png" });
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

function masterObjectKey({ contentHash, mimeType }) {
  if (!Object.hasOwn(MASTER_EXTENSIONS, mimeType)) {
    throw new Error("This master file type is not supported");
  }
  if (typeof contentHash !== "string" || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error("The master content hash is invalid");
  }
  return `masters/${contentHash.slice(0, 2)}/${contentHash}.${MASTER_EXTENSIONS[mimeType]}`;
}

function retainedOriginal(master) {
  if (!master || master.retained !== true ||
      ![master.sizeBytes, master.width, master.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    return null;
  }
  try {
    return master.key === masterObjectKey(master) ? master : null;
  } catch {
    return null;
  }
}

module.exports = { MASTER_EXTENSIONS, masterObjectKey, retainedOriginal };

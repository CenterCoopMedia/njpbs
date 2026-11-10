"use strict";

const { getStorage } = require("firebase-admin/storage");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const PREFIX = "post-background-v1/";
function createPostBackgroundStorage(bucketName = process.env.NO_BUILD_POST_BACKGROUND_BUCKET, app) {
  function file(key) {
    if (!/^[a-z0-9][a-z0-9._-]{2,220}$/.test(bucketName ?? "") ||
        typeof key !== "string" || !key.startsWith(PREFIX) || key.includes("..")) {
      throw new Error("Private background storage is unavailable");
    }
    return getStorage(app).bucket(bucketName).file(key);
  }
  return {
    async put(key, bytes, { contentType, signal } = {}) {
      signal?.throwIfAborted();
      try {
        await pipeline(Readable.from(bytes), file(key).createWriteStream({ resumable: false, timeout: 10_000,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType, cacheControl: "private, no-store" } }), { signal });
      } catch (error) {
        // An immutable retry must read back and verify the existing bytes.
        if (error.code !== 412) throw error;
      }
      signal?.throwIfAborted();
    },
    async get(key, { signal, maxBytes = 16 * 1024 * 1024 } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024) throw new Error("Invalid background read bound");
      signal?.throwIfAborted();
      const stream = file(key).createReadStream();
      const abort = () => stream.destroy(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > maxBytes) throw new Error("Background artifact is too large");
          chunks.push(chunk);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        stream.destroy();
      }
      signal?.throwIfAborted();
      return Buffer.concat(chunks, size);
    },
  };
}
module.exports = { createPostBackgroundStorage };

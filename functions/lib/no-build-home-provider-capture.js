"use strict";

const { pagePublicationTarget } = require("./no-build-page-target");
const { refuse } = require("./no-build-page-ownership");

/** Capture immutable Home provider bytes before final writes. Sealing removes
 * storage IO; Page callers still re-read native published dependencies. */
function createHomeProviderCapture({ firestore, target, now = Date.now,
  deadline = now() + 45_000 }) {
  target = pagePublicationTarget({ firestore, target });
  const homeBytes = new Map();
  let homeStorage;
  let sealed = false, pending = 0;
  const check = () => {
    if (!Number.isFinite(deadline) || now() >= deadline) refuse("The Home provider deadline expired.");
  };
  async function readHomeSource({ key, bucket }) {
    check();
    if (bucket !== target.backgroundBucket || typeof key !== "string" || key.length > 1024 ||
        !key.startsWith("post-background-v1/") || key.includes("..")) refuse();
    if (homeBytes.has(key)) return Buffer.from(await homeBytes.get(key));
    if (sealed) refuse("The Home provider reference was not captured.");
    if (homeBytes.size >= 8) refuse("The Home provider proof exceeds its bound.");
    homeStorage ??= require("./post-background-storage").createPostBackgroundStorage(bucket);
    pending += 1;
    const promise = homeStorage.get(key, { maxBytes: 16 * 1024 * 1024,
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))) });
    homeBytes.set(key, promise);
    try {
      const bytes = await promise;
      check();
      homeBytes.set(key, Buffer.from(bytes));
      return Buffer.from(bytes);
    } catch (error) {
      homeBytes.delete(key); throw error;
    } finally { pending -= 1; }
  }
  return Object.freeze({ readHomeSource, seal() {
    check();
    if (pending) refuse("The Home provider capture is incomplete.");
    sealed = true;
    homeStorage = null;
  }, assertCurrent: check });
}

module.exports = { createHomeProviderCapture };

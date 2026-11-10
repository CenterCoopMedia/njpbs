"use strict";

const { gzipSync, gunzipSync } = require("node:zlib");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { ADMISSION_PATH } = require("./no-build-post-admission");
const { PAGE_CAPABILITY_PATH } = require("./no-build-page-ownership");
const { CAPABILITY_PATH: POST_CAPABILITY_PATH } = require("./no-build-post-ownership");
const { HOME_PAGE_OWNER_PATH } = require("./no-build-home-ownership");

// Every admitted public dependency advances the public context document in its
// owning transaction. The other documents are operator and release controls
// that can change without it: deployment pointer, runtime admission (the pause),
// both serving capabilities, and the Home owner's provider refresh state.
// A change to any of them makes the next request rebuild its decision.
const VALIDATOR_PATHS = Object.freeze([PUBLIC_CONTEXT_PATH, "system/publicDeployment", ADMISSION_PATH,
  PAGE_CAPABILITY_PATH, POST_CAPABILITY_PATH, HOME_PAGE_OWNER_PATH]);
// Bounds dependencies outside these documents, such as the clock.
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function documentVersion(snapshot) {
  if (!snapshot?.exists) return "missing";
  const time = snapshot.updateTime;
  if (!time) throw new Error("Public decision validator has no update time");
  return `${time.seconds}.${time.nanoseconds}`;
}

/** One small batch read per request. A deployment in progress is never cached. */
async function readPublicDecisionValidator(firestore) {
  const snapshots = await firestore.getAll(...VALIDATOR_PATHS.map(path => firestore.doc(path)));
  const pointer = snapshots[1]?.data();
  return { key: snapshots.map(documentVersion).join("|"), cacheable: pointer?.state === "idle" };
}

/** In-instance reply cache. An entry serves only while every validator
 * document is unchanged and its age is under the TTL. Stores gzip bytes. */
function createPublicDecisionCache({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES, clock = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.gzip.length;
  };
  return {
    get(requestKey, validatorKey) {
      const entry = entries.get(requestKey);
      if (!entry) return null;
      if (entry.validatorKey !== validatorKey || clock() - entry.storedAt >= ttlMs) {
        remove(requestKey);
        return null;
      }
      // Map order is the eviction order; a hit becomes the newest entry.
      entries.delete(requestKey);
      entries.set(requestKey, entry);
      return entry;
    },
    set(requestKey, validatorKey, body, gzip = gzipSync(body)) {
      remove(requestKey);
      if (gzip.length > maxBytes) return;
      const storedAt = clock();
      const entry = { validatorKey, gzip, storedAt, expiresAt: storedAt + ttlMs };
      entries.set(requestKey, entry);
      bytes += gzip.length;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
      return entries.get(requestKey);
    },
    get size() { return entries.size; },
  };
}

function acceptsGzip(req) {
  const header = req?.headers?.["accept-encoding"];
  if (typeof header !== "string") return false;
  return header.split(",").some(part => {
    const [coding, ...params] = part.trim().toLowerCase().split(";").map(value => value.trim());
    if (coding !== "gzip") return false;
    const q = params.find(param => param.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

/** Sends a 200 JSON body. Gzip only when the caller asks for it. */
function sendJson(req, res, body, gzip) {
  res.set("Vary", "Accept-Encoding");
  res.set("Content-Type", "application/json; charset=utf-8");
  if (acceptsGzip(req)) {
    res.set("Content-Encoding", "gzip");
    return res.status(200).send(gzip ?? gzipSync(body));
  }
  return res.status(200).send(body ?? gunzipSync(gzip).toString("utf8"));
}

// Pair decisions still recheck current authority on every request. This key
// namespaces only immutable bytes; it never caches withdrawal/owner authority.
function pairDecisionRequestKey({ environment, epoch, pairId, contentHead, path, method, representation }) {
  return require("./public-release-pair").publicReleaseDigest({ environment, epoch, pairId, contentHead, path, method, representation });
}
module.exports = { pairDecisionRequestKey, VALIDATOR_PATHS, DEFAULT_TTL_MS, readPublicDecisionValidator, createPublicDecisionCache,
  acceptsGzip, sendJson };

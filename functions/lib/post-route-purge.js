"use strict";

const { randomUUID } = require("node:crypto");
const { isServerMintableSlugShape } = require("./post-slug-contract");

const { publicationTarget, publicationPostCacheTag } = require("./publication-target");

const TOKEN_SECRET = "SHADOW_POST_ROUTE_PURGE_TOKEN";
const MAX_ATTEMPTS = 6;
const CLAIM_MS = 60_000;

function routePurgeConfig(env = process.env) {
  return { enabled: env.SHADOW_POST_ROUTE_PURGE_ENABLED === "true", environment: env.SHADOW_POST_ROUTE_PURGE_ENVIRONMENT ?? "dev",
    projectId: env.SHADOW_POST_ROUTE_PURGE_PROJECT_ID ?? "demo-njpbs", zoneId: env.SHADOW_POST_ROUTE_PURGE_ZONE_ID ?? "" };
}
function devEnabled(config) {
  return config.enabled === true && config.environment === "dev" &&
    (/^demo-/.test(config.projectId) || /-dev$/.test(config.projectId)) && /^[a-f0-9]{32}$/.test(config.zoneId);
}
function routePurgeSecretNames(env = process.env) {
  const config = routePurgeConfig(env);
  return devEnabled(config) && env.GCLOUD_PROJECT === config.projectId ? [TOKEN_SECRET] : [];
}
function queueEnabled(firestore, config) {
  return devEnabled(config) && firestore.projectId === config.projectId;
}
function routeTags(slugs) {
  if (!Array.isArray(slugs) || slugs.some(slug => !isServerMintableSlugShape(slug) || slug.length > 1000)) {
    throw new Error("Invalid Post routes");
  }
  return [...new Set(slugs)].map(slug => publicationPostCacheTag(publicationTarget("development"), slug));
}
class RoutePurgeError extends Error {
  constructor(code, retryable) { super(code); this.code = code; this.retryable = retryable; }
}

// Implements the shadow PostRoutePurger interface. It never logs or retains the
// token, provider response body or a fetch exception's message.
// config-input: SHADOW_POST_ROUTE_PURGE_TOKEN
function createCloudflareRoutePurger({ config = routePurgeConfig(), getToken = () => process.env[TOKEN_SECRET], fetchImpl = fetch } = {}) {
  return {
    enabled: devEnabled(config),
    async purge(tags, { signal: budgetSignal } = {}) {
      if (!devEnabled(config)) return;
      let token;
      try { token = getToken(); }
      catch { throw new RoutePurgeError("purge_not_configured", false); }
      if (typeof token !== "string" || token.trim() === "") throw new RoutePurgeError("purge_not_configured", false);
      if (!Array.isArray(tags) || tags.length === 0 || tags.some(tag => typeof tag !== "string" ||
          !/^njpbs-dev-post-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag) || tag.length > 1024)) {
        throw new RoutePurgeError("purge_invalid_tags", false);
      }
      const unique = [...new Set(tags)];
      const timeout = AbortSignal.timeout(10_000);
      const signal = budgetSignal ? AbortSignal.any([timeout, budgetSignal]) : timeout;
      for (let offset = 0; offset < unique.length; offset += 30) {
        let response;
        try {
          response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ tags: unique.slice(offset, offset + 30) }), redirect: "error", signal,
          });
        } catch { throw new RoutePurgeError("purge_network_error", true); }
        if (!response.ok) {
          throw new RoutePurgeError(`purge_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
        }
        let body;
        try { body = await response.json(); }
        catch { throw new RoutePurgeError("purge_invalid_response", true); }
        if (body?.success !== true) throw new RoutePurgeError("purge_refused", false);
      }
    },
  };
}

async function prepareRoutePurgeInTransaction({ firestore, transaction, changes, config, now = Date.now(), publishedSnapshots }) {
  if (!queueEnabled(firestore, config)) return undefined;
  const posts = changes.filter(change => change.collection === "cmsPosts");
  if (posts.length === 0) return undefined;
  const state = { schemaVersion: 1, environment: "dev", zoneId: config.zoneId, tags: [], phase: "pending",
    attempts: 0, nextAttemptAt: now, claim: null, error: null };
  try {
    // Save-and-publish supplies its newly composed snapshots from this same
    // transaction. Other producers read the already committed addressed version.
    const snapshots = publishedSnapshots ?? (await transaction.getAll(...posts.map(change =>
      firestore.collection("cmsPosts").doc(change.id)))).map(record => record.data()?.published);
    if (snapshots.length !== posts.length) throw new Error("Invalid publication snapshots");
    const slugs = [];
    for (const [index, published] of snapshots.entries()) {
      if (published?.metadata?.type && published.metadata.type !== "post") continue;
      if (published?.sourceVersion !== posts[index].sourceVersion || published?.metadata?.type !== "post" ||
          !Array.isArray(published.metadata.previousSlugs)) throw new Error("Invalid publication routes");
      slugs.push(published.metadata.slug, ...published.metadata.previousSlugs);
    }
    if (slugs.length === 0) return undefined;
    state.tags = routeTags(slugs);
  } catch {
    state.phase = "failed";
    state.nextAttemptAt = null;
    state.error = "purge_invalid_routes";
  }
  return state;
}

async function attemptPostRoutePurge({ firestore, queueId, config = routePurgeConfig(), purger = createCloudflareRoutePurger({ config }),
  now = () => Date.now(), log = console, signal }) {
  if (!queueEnabled(firestore, config) || purger.enabled === false || signal?.aborted) return false;
  const ref = firestore.collection("cmsPublishQueue").doc(queueId);
  try {
    const time = now();
    const claimed = await firestore.runTransaction(async tx => {
      const row = await tx.get(ref);
      const state = row.data()?.routePurge;
      if (!row.exists || !["pending", "retry", "processing"].includes(state?.phase) ||
          !Number.isFinite(state.nextAttemptAt) || state.nextAttemptAt > time) return null;
      if (state.schemaVersion !== 1 || state.environment !== "dev" || state.zoneId !== config.zoneId ||
          !Number.isSafeInteger(state.attempts) || state.attempts < 0 || state.attempts >= MAX_ATTEMPTS) {
        tx.update(ref, { routePurge: { ...state, phase: "failed", nextAttemptAt: null, claim: null, error: "purge_retry_refused" } });
        return null;
      }
      const next = { ...state, attempts: state.attempts + 1, phase: "processing", claim: randomUUID(), nextAttemptAt: time + CLAIM_MS };
      tx.update(ref, { routePurge: next });
      return next;
    });
    if (!claimed) return false;
    let failure = null;
    try {
      if (signal?.aborted) throw new RoutePurgeError("purge_network_error", true);
      await purger.purge(claimed.tags, { signal });
    }
    catch (error) {
      // Only our fixed public codes survive CJS/ESM boundaries. Never retain an
      // arbitrary error string, including one supplied by a network client.
      const known = /^(purge_http_[1-5][0-9]{2}|purge_not_configured|purge_invalid_tags|purge_network_error|purge_invalid_response|purge_refused)$/.test(error?.code ?? "");
      failure = known ? new RoutePurgeError(error.code, error.retryable === true) : new RoutePurgeError("purge_network_error", true);
    }
    await firestore.runTransaction(async tx => {
      const row = await tx.get(ref);
      const current = row.data()?.routePurge;
      if (!row.exists || current?.claim !== claimed.claim || current.phase !== "processing") return;
      const retry = failure?.retryable && claimed.attempts < MAX_ATTEMPTS;
      tx.update(ref, { routePurge: { ...current, phase: failure ? (retry ? "retry" : "failed") : "success", claim: null,
        nextAttemptAt: retry ? now() + Math.min(60_000 * 2 ** (claimed.attempts - 1), 3_600_000) : null,
        error: failure?.code ?? null } });
    });
    if (failure) log.warn("Post route purge deferred", { queueId, code: failure.code, attempt: claimed.attempts });
    return true;
  } catch {
    // The committed publication remains accepted. A recorded claim expires into
    // the same bounded retry query if result writeback was interrupted.
    log.warn("Post route purge state unavailable", { queueId });
    return false;
  }
}

async function retryPostRoutePurges({ firestore, config = routePurgeConfig(), purger = createCloudflareRoutePurger({ config }),
  now = () => Date.now(), log = console, budgetMs = 20_000, signal: stopSignal }) {
  if (!queueEnabled(firestore, config)) return 0;
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(budgetMs, 20_000)));
  const signal = stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout;
  if (signal.aborted) throw new RoutePurgeError("purge_retry_budget", true);
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(new RoutePurgeError("purge_retry_budget", true));
    signal.addEventListener("abort", abort, { once: true });
  });
  const run = async () => {
    const rows = await firestore.collection("cmsPublishQueue").where("routePurge.nextAttemptAt", "<=", now())
      .orderBy("routePurge.nextAttemptAt").limit(20).get();
    let count = 0;
    for (const row of rows.docs) {
      if (signal.aborted) break;
      if (await attemptPostRoutePurge({ firestore, queueId: row.id, config, purger, now, log, signal })) count++;
    }
    return count;
  };
  try { return await Promise.race([run(), expired]); }
  finally {
    signal.removeEventListener("abort", abort);
  }
}
module.exports = { TOKEN_SECRET, routePurgeConfig, routeTags, devEnabled, routePurgeSecretNames, createCloudflareRoutePurger,
  prepareRoutePurgeInTransaction, attemptPostRoutePurge, retryPostRoutePurges };

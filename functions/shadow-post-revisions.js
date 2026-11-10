"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("./lib/firebase");
const { readPublishedPost, isPublishedPostRefusal } = require("./published-post-reader");
const { routeTags } = require("./lib/post-route-purge");
const { isServerMintableSlugShape } = require("./lib/post-slug-contract");

const TOKEN_SECRET = "SHADOW_POST_REVISIONS_TOKEN";
const COLLECTION = "cmsShadowPostRevisions";
const LEASE_MS = 120_000;
function revisionConfig(env = process.env) {
  return { enabled: env.SHADOW_POST_REVISIONS_ENABLED === "true", origin: env.SHADOW_POST_REVISIONS_ORIGIN,
    projectId: env.GCLOUD_PROJECT, accountId: env.SHADOW_POST_REVISIONS_ACCOUNT_ID,
    namespaceId: env.SHADOW_POST_REVISIONS_NAMESPACE_ID, zoneId: env.SHADOW_POST_REVISIONS_ZONE_ID,
    slugs: (env.SHADOW_POST_REVISIONS_SLUGS ?? "").split(",").filter(Boolean) };
}
function validateConfig(config, firestore) {
  if (config.origin !== "https://dev-public.example.org" || config.projectId !== firestore.projectId ||
      ![config.accountId, config.namespaceId, config.zoneId].every(value => /^[a-f0-9]{32}$/.test(value ?? "")) ||
      !Array.isArray(config.slugs) || config.slugs.length === 0 || config.slugs.length > 20 ||
      config.slugs.some(slug => !isServerMintableSlugShape(slug) || slug.length > 200)) {
    throw new Error("Shadow revision configuration refused");
  }
}
function isNewerEvent(next, previous) {
  if (!next || !previous) return true;
  if (next.seconds !== previous.seconds) return next.seconds > previous.seconds;
  if (next.nanoseconds !== previous.nanoseconds) return next.nanoseconds > previous.nanoseconds;
  return next.deleted === true && previous.deleted !== true;
}
function revisionRecord(input, previous) {
  if (input.kind === "gone" || input.kind === "not-found") return { schemaVersion: 1, kind: "withdrawn" };
  const sourceRevision = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  if (previous?.kind === "published" && previous.sourceRevision === sourceRevision) return previous;
  // A withdrawal and a later publication can reuse identical source bytes.
  // Each admission needs its own cache identity so old negative entries cannot win.
  return { schemaVersion: 1, kind: "published", sourceRevision,
    revision: createHash("sha256").update(sourceRevision).update(randomUUID()).digest("hex") };
}

// This adapter writes only the separately provisioned dev namespace. No content
// or credentials enter KV; only a public revision digest or a tombstone does.
// config-input: SHADOW_POST_REVISIONS_TOKEN
function createRevisionDelivery({ config, fetchImpl = fetch, getToken = () => process.env[TOKEN_SECRET] }) {
  async function send(path, method, body) {
    try {
      const token = getToken();
      if (typeof token !== "string" || !token.trim()) throw new Error();
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || (await response.json())?.success !== true) throw new Error();
    } catch { throw new Error("Shadow revision delivery failed"); }
  }
  return {
    write(slug, record) {
      return send(`accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(`post:${slug}`)}`, "PUT", record);
    },
    // Same tag contract as purgePublishedPostRoutes. The publisher retains a
    // failed purge independently of its successful revision/tombstone write.
    purge(slugs) { return send(`zones/${config.zoneId}/purge_cache`, "POST", { tags: routeTags(slugs) }); },
  };
}

function createShadowPostRevisionRunner({ firestore = db, config = revisionConfig(), now = () => Date.now(),
  fetchImpl, getToken } = {}) {
  const delivery = createRevisionDelivery({ config, fetchImpl, getToken });
  async function sync(slug, force, eventTime) {
    const ref = firestore.collection(COLLECTION).doc(slug);
    const claim = randomUUID();
    const time = now();
    const state = await firestore.runTransaction(async tx => {
      const previous = (await tx.get(ref)).data() ?? {};
      if (previous.claim && previous.leaseUntil > time) throw new Error("Shadow revision delivery busy");
      // Persist the event watermark with renewal intent before remote work.
      // Repeated or delayed events still read current state but cannot renew it.
      const newEvent = force && isNewerEvent(eventTime, previous.eventTime);
      if (!newEvent && previous.nextAttemptAt > time) throw new Error("Shadow revision retry pending");
      const next = { ...previous, claim, leaseUntil: time + LEASE_MS, phase: "processing",
        refresh: newEvent || previous.refresh === true,
        eventTime: newEvent && eventTime ? eventTime : previous.eventTime ?? null,
        attempts: (previous.attempts ?? 0) + 1, nextAttemptAt: time + LEASE_MS };
      tx.set(ref, next);
      return { ...next, recover: previous.phase === "processing" };
    });
    const target = `${config.accountId}/${config.namespaceId}/${config.zoneId}`;
    let delivered = !state.recover && state.target === target ? state.delivered ?? null : null;
    let purged = !state.recover && state.target === target && state.purged === true;
    let failed = false;
    let refresh = state.refresh || state.recover;
    try {
      // Events can arrive late or twice. Read the current owner and visibility,
      // never the event's old snapshot. The per-slug lease serializes writers.
      let input;
      try { input = await readPublishedPost({ firestore, slug, now: new Date(now()) }); }
      catch (error) {
        if (!isPublishedPostRefusal(error)) throw error;
        input = { kind: "not-found" };
      }
      const record = revisionRecord(input, refresh ? null : delivered);
      if (refresh || !isDeepStrictEqual(delivered, record)) {
        await delivery.write(slug, record);
        delivered = record;
        refresh = false;
        purged = false;
      }
      if (!purged) { await delivery.purge([slug]); purged = true; }
    } catch { failed = true; }
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.claim !== claim) throw new Error("Shadow revision claim lost");
      tx.set(ref, { target, delivered, purged, refresh, eventTime: state.eventTime, claim: null, leaseUntil: null,
        phase: failed ? "retry" : "success", attempts: failed ? state.attempts : 0,
        nextAttemptAt: failed ? now() + Math.min(60_000 * 2 ** Math.min(state.attempts - 1, 4), 960_000) : null,
        error: failed ? "shadow_revision_delivery_failed" : null });
    });
    if (failed) throw new Error("Shadow revision delivery failed");
  }
  return async (slugs = config.slugs, { force = false, eventTime } = {}) => {
    if (!config.enabled) return;
    const admitted = Array.isArray(config.slugs) ? [...new Set(slugs)].filter(value => config.slugs.includes(value)) : [];
    if (admitted.length === 0) return;
    validateConfig(config, firestore);
    let failed = false;
    const started = now();
    for (const slug of admitted) {
      if (now() - started >= 45_000) { failed = true; break; }
      try { await sync(slug, force, eventTime); }
      catch { failed = true; }
    }
    if (failed) throw new Error("Shadow revision follow-up pending");
  };
}

function createShadowPostRevisionFollowup(deps = {}) {
  const run = createShadowPostRevisionRunner(deps);
  return async event => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const publicState = value => JSON.stringify([value?.published, value?.publiclyVisible, value?.deleted]);
    if (publicState(before) === publicState(after)) return;
    const slugs = [before, after].flatMap(value => value?.published?.metadata?.type === "post"
      ? [value.published.metadata.slug, ...(value.published.metadata.previousSlugs ?? [])] : []);
    const time = event.data?.after.updateTime ?? event.data?.before.updateTime;
    // A delete has no after.updateTime. Order it just after its before snapshot.
    const eventTime = time ? { seconds: time.seconds, nanoseconds: time.nanoseconds,
      deleted: event.data.after.exists === false } : undefined;
    await run(slugs, { force: true, eventTime });
  };
}
const secrets = process.env.SHADOW_POST_REVISIONS_ENABLED === "true" ? [TOKEN_SECRET] : [];
const onShadowPostRevisionWrite = onDocumentWritten({ document: "cmsPosts/{postId}", retry: true,
  maxInstances: 1, concurrency: 1, timeoutSeconds: 60, secrets }, createShadowPostRevisionFollowup());
const onShadowPostRevisionRetry = onSchedule({ schedule: "every 1 minutes", maxInstances: 1,
  concurrency: 1, timeoutSeconds: 60, secrets }, () => createShadowPostRevisionRunner()());

module.exports = { createShadowPostRevisionRunner, createShadowPostRevisionFollowup, revisionConfig,
  onShadowPostRevisionWrite, onShadowPostRevisionRetry };

"use strict";

const { randomUUID } = require("node:crypto");
const { FieldPath } = require("firebase-admin/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { assertBillingEnabled } = require("./lib/billing-state");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { MEDIA_RETENTION_MS } = require("./lib/media-bin");
const { mediaReplacementRef } = require("./lib/media-replacement");
const { readRetainedPairMediaHoldInTransaction } = require("./lib/public-release-media-retention");

const { readPurgeDeployment } = require("./lib/media-purge-deployment");
const executor = require("./lib/media-purge-executor");
const { MediaPurgeStorage } = require("./lib/media-purge-storage");
const DEPLOYMENT = readPurgeDeployment();
const REAL_DELETES_ENABLED = DEPLOYMENT.realDeletesEnabled;
const PURGE_SERVICE_ACCOUNT = "cms-media-purge@njpbs-site.iam.gserviceaccount.com";
const PURGE_ACCESS_KEY = DEPLOYMENT.enabled ? defineSecret("CMS_MEDIA_PURGE_R2_ACCESS_KEY_ID") : null;
const PURGE_SECRET_KEY = DEPLOYMENT.enabled ? defineSecret("CMS_MEDIA_PURGE_R2_SECRET_ACCESS_KEY") : null;
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const PUBLIC_BUCKET = defineString("CMS_MEDIA_R2_BUCKET", { default: "" });
const MASTER_BUCKET = defineString("CMS_MEDIA_MASTER_R2_BUCKET", { default: "" });
function defaultStorage() {
  return new MediaPurgeStorage({ endpoint: R2_ENDPOINT.value(), publicBucket: PUBLIC_BUCKET.value(),
    masterBucket: MASTER_BUCKET.value(), accessKeyId: PURGE_ACCESS_KEY.value(), secretAccessKey: PURGE_SECRET_KEY.value() });
}
const RUN_LEASE_MS = 15 * 60 * 1000;
const HEALTHCHECKS_MEDIA_PURGE_SWEEP = DEPLOYMENT.enabled ? defineSecret("HEALTHCHECKS_MEDIA_PURGE_SWEEP") : null;

function readConfig(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const bounded = (value, fallback, max) =>
    Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;
  return {
    enabled: data.enabled === undefined || data.enabled === true,
    configErrors: data.enabled === undefined || typeof data.enabled === "boolean"
      ? [] : ["enabled must be a boolean"],
    dryRun: typeof data.dryRun === "boolean" ? data.dryRun : true,
    maxEntriesPerRun: bounded(data.maxEntriesPerRun, 50, 100),
    maxAttempts: bounded(data.maxAttempts, 5, 100),
  };
}

function millis(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

async function masterSkipReason(transaction, firestore, entryId, entry) {
  const match = /^masters\/[a-f0-9]{2}\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(entry.masterKey);
  if (!match) return "invalid_master_key";
  const lock = await transaction.get(firestore.doc(`system/media/masterLocks/${match[1]}`));
  if (lock.exists && lock.data().state === "purging" && lock.data().purgeEntryId !== entryId) return "master_purging";
  const assets = await transaction.get(firestore.collection("media_assets")
    .where("master.key", "==", entry.masterKey).limit(101));
  if (assets.size > 100) return "master_reference_limit";
  if (assets.docs.some((snapshot) =>
    ["active", "tombstoned", "purging"].includes(snapshot.data().lifecycle) &&
    !(entryId.startsWith("asset:") && snapshot.id === entry.assetId))) {
    return "master_referenced_asset";
  }
  const claims = await transaction.get(firestore.collection("system/media/hashOwners")
    .where("recordSeed.master.key", "==", entry.masterKey).limit(101));
  if (claims.size > 100) return "master_reference_limit";
  if (claims.docs.some((snapshot) =>
    ["reserved", "object_ready", "capacity_cleanup"].includes(snapshot.data().state))) {
    return "master_referenced_claim";
  }
  const others = await transaction.get(firestore.collection("mediaPurgeQueue")
    .where("masterKey", "==", entry.masterKey).limit(101));
  if (others.size > 100) return "master_reference_limit";
  for (const snapshot of others.docs) {
    const other = snapshot.data();
    if (snapshot.id === entryId || !["pending", "purging", "blocked"].includes(other.state)) continue;
    return "master_referenced_queue";
  }
  // Dry run deliberately does not acquire or mutate the master lock.
  return null;
}

async function inspectEntry({ firestore, entryRef, nowMs, config, prepare }) {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(entryRef);
    const entry = snapshot.data() || {};
    const result = {
      entryId: entryRef.id, assetId: entry.assetId ?? null,
      objects: Array.isArray(entry.objects) ? entry.objects : [], wouldDelete: [], skips: [],
    };
    const skip = (reason) => {
      result.skips.push({ reason });
      return result;
    };
    if (!snapshot.exists) return skip("entry_missing");
    if (entry.kind !== "image" || typeof entry.assetId !== "string" ||
        !entry.assetId || entry.assetId.includes("/")) return skip("not_image_entry");
    const assetEntry = entryRef.id === `asset:${entry.assetId}`;
    const versionPrefix = `version:${entry.assetId}:`;
    const oldHash = entryRef.id.startsWith(versionPrefix) ? entryRef.id.slice(versionPrefix.length) : null;
    if (!assetEntry && !/^[a-f0-9]{64}$/.test(oldHash || "")) return skip("invalid_entry_id");
    if (!["pending", "purging"].includes(entry.state)) return skip("entry_not_pending");
    if (!Number.isFinite(millis(entry.eligibleAt)) || millis(entry.eligibleAt) > nowMs ||
        !Number.isFinite(millis(entry.queuedAt)) || nowMs - millis(entry.queuedAt) < MEDIA_RETENTION_MS) {
      return skip("retention_period");
    }
    if (entry.state === "purging" &&
        (!Number.isFinite(millis(entry.leaseExpiresAt)) || millis(entry.leaseExpiresAt) > nowMs)) {
      return skip("entry_lease_active");
    }
    if (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0) return skip("invalid_attempts");
    if (entry.attempts >= config.maxAttempts) return skip("max_attempts");
    const assetRef = firestore.collection("media_assets").doc(entry.assetId);
    const [assetSnapshot, replacement] = await Promise.all([
      transaction.get(assetRef), transaction.get(mediaReplacementRef(firestore, entry.assetId)),
    ]);
    if (!assetSnapshot.exists || assetSnapshot.data().kind !== "image") return skip("asset_missing_or_not_image");
    const asset = assetSnapshot.data();
    // Even an expired replacement claim can recover. Reading its deterministic
    // document in the claim transaction fences a revert reservation and commit.
    if (replacement.exists) return skip("replacement_in_progress");
    if (assetEntry && asset.lifecycle !== "tombstoned" && !(entry.state === "purging" && asset.lifecycle === "purging")) return skip("asset_not_tombstoned");
    if (!assetEntry && asset.contentHash === oldHash) return skip("version_is_current");
    if (!Array.isArray(entry.objects) || entry.objects.length === 0 || entry.objects.some((object) =>
      !object || typeof object.key !== "string" ||
      !((object.store === "public" && object.key.startsWith("cms-media/")) ||
        (object.store === "masters" && object.key === entry.masterKey)))) return skip("invalid_objects");
    for (const object of entry.objects.filter((item) => item.store === "public")) {
      const active = await transaction.get(firestore.collection("media_assets")
        .where("storageKey", "==", object.key).limit(101));
      if (active.size > 100) return skip("public_key_reference_limit");
      if (active.docs.some((doc) => doc.data().lifecycle === "active")) return skip("public_key_referenced");
    }
    // An older reserved build can stage media usage after this transaction.
    // Keep its inputs until it finishes or is explicitly retired, even when
    // its immutable deployed usage rows do not exist yet.
    const building = await transaction.get(firestore.collection("system/publicDeployment/buildBatches")
      .where("status", "in", ["reserved", "ready", "deploying", "reconciling"]).limit(1));
    if (!building.empty) return skip("public_build_in_progress");
    // public-media-manifest-store.js publicMediaUsageRef/stageChunk stores an
    // immutable deployed-{generation} document for every generation. The
    // coordinator does not prune a rollback window: protect ALL retained rows,
    // including staged candidates, rather than checking only activeGeneration.
    for (const state of ["working", "published", "deployed"]) {
      const usage = await transaction.get(firestore.collectionGroup("mediaUsage")
        .where("state", "==", state).where("assetIds", "array-contains", entry.assetId).limit(1));
      if (!usage.empty) return skip(`${state}_usage`);
    }
    const root = await transaction.get(firestore.doc("system/publicDeployment"));
    if (root.data()?.schemaVersion === 2) {
      const pairHold = await readRetainedPairMediaHoldInTransaction({ firestore, transaction,
        root: root.data(), assetId: entry.assetId });
      if (pairHold) return skip(pairHold);
    }
    const masterReason = entry.masterKey
      ? await masterSkipReason(transaction, firestore, entryRef.id, entry) : null;
    for (const object of entry.objects) {
      if (object.store === "masters" && masterReason) {
        result.skips.push({ reason: masterReason, key: object.key });
      } else result.wouldDelete.push(object);
    }
    return prepare ? prepare({ transaction, firestore, entryRef, entry, assetRef, asset, result }) : result;
  });
}

function createMediaPurgeSweepRunner(deps = {}) {
  const {
    firestore = db, now = () => Date.now(), runIdFactory = randomUUID,
    getHealthchecksUrl = () => HEALTHCHECKS_MEDIA_PURGE_SWEEP.value(),
    fetchImpl = fetch, log = logger, deployment = DEPLOYMENT, storageFactory = defaultStorage,
  } = deps;
  return async () => {
    if (!deployment.enabled) return { skipped: "deployment_disabled" };
    const configRef = firestore.doc("system/mediaPurge");
    const nowMs = Number(now());
    const startedAt = new Date(nowMs).toISOString();
    const runId = runIdFactory();
    // Both switches are read before the first write; the transaction rechecks
    // them to cover a switch flipped between the initial read and lease claim.
    const initial = await configRef.get();
    const initialConfig = readConfig(initial.data());
    const configErrorSummary = (config) => {
      const summary = { runId, configErrors: config.configErrors };
      log.error("media purge disabled by invalid config", summary);
      return { skipped: "config_error", summary };
    };
    if (initialConfig.configErrors.length) return configErrorSummary(initialConfig);
    if (!initialConfig.enabled) return { skipped: "disabled" };
    await assertBillingEnabled(firestore);
    const url = getHealthchecksUrl();
    try {
      if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error();
    } catch { throw new Error("HEALTHCHECKS_MEDIA_PURGE_SWEEP must be an HTTPS URL"); }
    const claimed = await firestore.runTransaction(async (transaction) => {
      const [snapshot, billing] = await Promise.all([
        transaction.get(configRef), transaction.get(firestore.doc("system/billing")),
      ]);
      const data = snapshot.data() || {};
      const config = readConfig(data);
      if (config.configErrors.length) return { config };
      if (!config.enabled || billing.data()?.disabled === true) return null;
      if (data.lease && millis(data.lease.expiresAt) > nowMs) return null;
      transaction.set(configRef, {
        lease: { runId, expiresAt: new Date(nowMs + RUN_LEASE_MS).toISOString() },
      }, { merge: true });
      return { config, cursor: data.cursor, inventory: data.inventory };
    });
    if (!claimed) return { skipped: "disabled_or_leased" };
    const { config, cursor } = claimed;
    if (config.configErrors.length) return configErrorSummary(config);
    const effectiveDryRun = !deployment.realDeletesEnabled || config.dryRun;
    let storage;
    const getStorage = () => (storage ??= storageFactory());
    let storageUnavailable = false;
    if (!effectiveDryRun) {
      try { getStorage(); } catch { storageUnavailable = true; }
    }
    let query = firestore.collection("mediaPurgeQueue")
      .where("state", "in", ["pending", "purging"])
      .where("eligibleAt", "<=", startedAt)
      .orderBy("eligibleAt").orderBy(FieldPath.documentId()).limit(config.maxEntriesPerRun);
    if (cursor && Number.isFinite(millis(cursor.eligibleAt)) &&
        typeof cursor.id === "string" && cursor.id.length > 0 &&
        !cursor.id.includes("/") && Buffer.byteLength(cursor.id, "utf8") <= 1500) {
      query = query.startAfter(cursor.eligibleAt, cursor.id);
    }
    const selected = storageUnavailable ? { docs: [], size: 0 } : await query.get();
    const entries = [];
    for (const snapshot of selected.docs) {
      if (Number(now()) - nowMs >= 4 * 60_000) break;
      const inspected = await inspectEntry({ firestore, entryRef: snapshot.ref, nowMs: Number(now()), config,
        prepare: (context) => executor.claimEntry({ ...context, inspectOnly: effectiveDryRun,
          runId, clock: now, configRef, readConfig, runDeadlineMs: nowMs + 7 * 60_000 }),
      });
      if (inspected.claim) {
        const claim = inspected.claim;
        delete inspected.claim;
        inspected.execution = await executor.executeClaim({ firestore, entryRef: snapshot.ref, claim,
          configRef, runId, storage: getStorage(), clock: now, readConfig });
      }
      entries.push(inspected);
    }
    const noProgress = selected.size > 0 && entries.length === 0;
    const summary = {
      runId, entries: entries.length,
      budgetDeferred: selected.size - entries.length,
      wouldDelete: entries.reduce((count, entry) => count + entry.wouldDelete.length, 0),
      skipped: entries.filter((entry) => entry.skips.length > 0).length,
      purged: entries.filter((entry) => entry.execution?.outcome === "purged").length,
      failed: entries.filter((entry) => entry.execution?.outcome === "retry_required").length + Number(storageUnavailable),
      deferred: entries.filter((entry) => entry.deferred).length + Number(noProgress),
      needsReconciliation: entries.filter((entry) => entry.skips.some(({ reason }) => reason === "max_attempts")).length,
    };
    const last = selected.docs[entries.length - 1];
    const nextCursor = storageUnavailable || noProgress ? cursor || null : last && (selected.size === config.maxEntriesPerRun || entries.length < selected.size)
      ? { eligibleAt: last.data().eligibleAt, id: last.id } : null;
    let inventory = null;
    if (!storageUnavailable && Number(now()) - nowMs < 6 * 60_000 &&
        (!claimed.inventory?.completedAt || nowMs - millis(claimed.inventory.completedAt) >= 7 * 86400_000 || claimed.inventory.cursor)) {
      try {
        const abort = new AbortController();
        let timer;
        try {
          inventory = await Promise.race([
            executor.inventoryOrphanMasters({ firestore, storage: getStorage(), cursor: claimed.inventory?.cursor,
              nowMs, clock: now, deadlineMs: nowMs + 7 * 60_000, signal: abort.signal }),
            new Promise((resolve) => { timer = setTimeout(() => {
              abort.abort();
              resolve({ candidates: [], cursor: claimed.inventory?.cursor || null, scanned: 0, reportOnly: true, incomplete: true });
            }, 60_000); }),
          ]);
        } finally { clearTimeout(timer); }
      } catch {
        inventory = { error: "inventory_failed", reportOnly: true };
      }
    }
    const report = {
      startedAt, completedAt: new Date(Number(now())).toISOString(),
      effectiveDryRun,
      configuredDryRun: config.dryRun, realDeletesEnabled: deployment.realDeletesEnabled, entries, summary, inventory,
      startupError: storageUnavailable ? "storage_configuration_unavailable" : null,
    };
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(configRef);
      if (snapshot.data()?.lease?.runId !== runId) throw new Error("Media purge run lease was lost");
      transaction.create(configRef.collection("runs").doc(runId), report);
      transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
        actorUid: "system:mediaPurgeSweep", action: effectiveDryRun ? "media.purge.dry_run" : "media.purge.run",
        target: `system/mediaPurge/runs/${runId}`, after: summary,
      }));
      transaction.update(configRef, { lease: null, cursor: nextCursor, lastRunSummary: summary,
        ...(inventory && !inventory.error ? { inventory: { cursor: inventory.cursor, completedAt: inventory.cursor || inventory.incomplete ? null : report.completedAt } } : {}),
      });
    });
    if (inventory?.error) throw new Error("Media purge inventory failed");
    if (summary.failed || summary.deferred || summary.needsReconciliation) {
      log.error("media purge incomplete", summary);
      throw new Error("Media purge incomplete");
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET", headers: { "User-Agent": "njpbs-media-purge-sweep" }, signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error("Healthchecks media purge ping failed"); }
    if (!response.ok) throw new Error(`Healthchecks media purge ping failed: ${response.status}`);
    log.info("media purge completed", summary);
    return report;
  };
}

const onMediaPurgeSweep = onSchedule({
  schedule: "30 3 * * *", timeZone: "America/New_York", maxInstances: 1, region: "us-central1",
  timeoutSeconds: 540, memory: "256MiB", concurrency: 1, retryCount: 0,
  serviceAccount: DEPLOYMENT.enabled ? PURGE_SERVICE_ACCOUNT : undefined,
  secrets: DEPLOYMENT.enabled ? [HEALTHCHECKS_MEDIA_PURGE_SWEEP, PURGE_ACCESS_KEY, PURGE_SECRET_KEY] : [],
}, createMediaPurgeSweepRunner());

module.exports = {
  REAL_DELETES_ENABLED, HEALTHCHECKS_MEDIA_PURGE_SWEEP, readConfig,
  inspectEntry, createMediaPurgeSweepRunner, onMediaPurgeSweep,
};

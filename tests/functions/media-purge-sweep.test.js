import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import sweep from "../../functions/media-purge-sweep.js";
import bin from "../../functions/lib/media-bin.js";
import immediate from "../../functions/media-purge-now.js";
import cacheModule from "../../functions/lib/media-purge-cache.js";
import storageModule from "../../functions/lib/media-purge-storage.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";

const PROJECT = "demo-njpbs";
const NOW = Date.parse("2026-09-25T07:30:00.000Z");
const OLD = new Date(NOW - bin.MEDIA_RETENTION_MS - 1).toISOString();
const HASH = "a".repeat(64);
const MASTER = `masters/aa/${HASH}.jpg`;
let db;
let ping;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-purge-sweep.test.js");
});
beforeEach(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  ping = vi.fn(async () => ({ ok: true }));
});
afterAll(async () => Promise.all(admin.apps.map((app) => app.delete())));
afterEach(() => vi.restoreAllMocks());

function runner(options = {}) {
  return sweep.createMediaPurgeSweepRunner({
    firestore: db, now: () => NOW, fetchImpl: ping,
    getHealthchecksUrl: () => "https://hc.example.test/purge",
    log: { info: vi.fn(), error: vi.fn() },
    deployment: { enabled: true, realDeletesEnabled: false },
    storageFactory: () => ({ listMasters: async () => ({ objects: [], cursor: null }) }), ...options,
  });
}

async function seed(id = "asset-1", overrides = {}, entryOverrides = {}, version = false) {
  const asset = {
    kind: "image", lifecycle: "tombstoned", contentHash: HASH,
    storageKey: `cms-media/news/${id}/${HASH}.webp`, ...overrides,
  };
  const entryId = version ? `version:${id}:${HASH}` : `asset:${id}`;
  const queuedAsset = { ...asset, contentHash: HASH };
  const entry = { ...bin.createImagePurgeEntry(id, queuedAsset, OLD), ...entryOverrides };
  await db.doc(`media_assets/${id}`).set(asset);
  await db.doc(`mediaPurgeQueue/${entryId}`).set(entry);
  const owner = db.doc(`system/media/hashOwners/${HASH}`);
  const previous = await owner.get();
  if (previous.exists && previous.data().assetId !== id) {
    await owner.collection("superseded").doc(previous.data().attemptId).set(previous.data());
  }
  await owner.set({ state: "committed", assetId: id, attemptId: `attempt-${id}`,
    finalKey: entry.objects.find((object) => object.store === "public")?.key || asset.storageKey,
    recordSeed: { master: asset.master || null } });
  return { entryId, asset, entry };
}

describe("media purge dry run", () => {
  it("defaults real deletes off and schedules a single daily New York run", () => {
    expect(sweep.REAL_DELETES_ENABLED).toBe(false);
    const endpoint = sweep.onMediaPurgeSweep.__endpoint;
    expect(endpoint.scheduleTrigger.schedule).toBe("30 3 * * *");
    expect(endpoint.scheduleTrigger.timeZone).toBe("America/New_York");
    expect(endpoint.maxInstances).toBe(1);
    expect(sweep.readConfig({ enabled: "false", dryRun: "false", maxEntriesPerRun: -1 })).toEqual({
      enabled: false, configErrors: ["enabled must be a boolean"],
      dryRun: true, maxEntriesPerRun: 50, maxAttempts: 5,
    });
  });

  it.each(["owner_receipt_missing", "invalid_object_identity", "master_receipt_mismatch"])(
    "reports %s in dry run before any destructive activation", async (reason) => {
      const fixture = await seed("asset-1", { master: { key: MASTER } });
      const owner = db.doc(`system/media/hashOwners/${HASH}`);
      if (reason === "owner_receipt_missing") await owner.delete();
      if (reason === "invalid_object_identity") await db.doc(`mediaPurgeQueue/${fixture.entryId}`).update({
        objects: [{ store: "public", key: `cms-media/news/other/${HASH}.webp` }], masterKey: null,
      });
      if (reason === "master_receipt_mismatch") await owner.update({ "recordSeed.master.key": `masters/bb/${"b".repeat(64)}.jpg` });
      const beforeQueue = (await db.doc(`mediaPurgeQueue/${fixture.entryId}`).get()).data();
      const beforeOwner = (await owner.get()).data();
      await expect(runner()()).rejects.toThrow("Media purge incomplete");
      const control = (await db.doc("system/mediaPurge").get()).data();
      const report = (await db.doc(`system/mediaPurge/runs/${control.lastRunSummary.runId}`).get()).data();
      expect(report.entries[0].deferred).toBe(reason);
      expect(report.summary.deferred).toBe(1);
      expect((await db.doc(`mediaPurgeQueue/${fixture.entryId}`).get()).data()).toEqual(beforeQueue);
      expect((await owner.get()).data()).toEqual(beforeOwner);
      expect((await db.doc("media_assets/asset-1").get()).data()).toEqual(fixture.asset);
      expect((await db.collection("system/media/masterLocks").get()).empty).toBe(true);
      expect(ping).not.toHaveBeenCalled();
    },
  );

  it("does no work when the deployment is disabled", async () => {
    const storageFactory = vi.fn();
    expect(await runner({ deployment: { enabled: false }, storageFactory })()).toEqual({ skipped: "deployment_disabled" });
    expect(storageFactory).not.toHaveBeenCalled();
    expect((await db.doc("system/mediaPurge").get()).exists).toBe(false);
    expect(ping).not.toHaveBeenCalled();
  });

  it.each(["false", null, 0, {}])("disables invalid enabled value %j without overwriting config", async (enabled) => {
    await seed();
    await db.doc("system/mediaPurge").set({ enabled });
    const log = { info: vi.fn(), error: vi.fn() };
    const report = await runner({ log })();
    expect(report).toMatchObject({ skipped: "config_error",
      summary: { configErrors: ["enabled must be a boolean"] } });
    expect(log.error).toHaveBeenCalledWith("media purge disabled by invalid config", report.summary);
    expect((await db.doc("system/mediaPurge").get()).data()).toEqual({ enabled });
    expect((await db.collection("system/mediaPurge/runs").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports an invalid switch introduced before the lease transaction", async () => {
    const original = db.runTransaction.bind(db);
    vi.spyOn(db, "runTransaction").mockImplementationOnce(async (...args) => {
      await db.doc("system/mediaPurge").set({ enabled: "false" });
      return original(...args);
    });
    expect(await runner()()).toMatchObject({ skipped: "config_error",
      summary: { configErrors: ["enabled must be a boolean"] } });
    expect((await db.doc("system/mediaPurge").get()).data()).toEqual({ enabled: "false" });
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports exact keys, writes one audit per run, and leaves assets, queue and locks unchanged on rerun", async () => {
    const seeded = await seed("asset-1", { master: { key: MASTER }, thumbnails: [480, 960, 1600].map(width => ({ storageKey: `cms-media/news/asset-1/thumbs/${HASH}-w${width}.webp` })) });
    await db.doc("system/mediaPurge").set({ dryRun: false });
    const first = await runner()();
    const second = await runner()();
    expect(first.effectiveDryRun).toBe(true);
    expect(first.configuredDryRun).toBe(false);
    expect(first.entries).toEqual(second.entries);
    expect(first.entries[0].wouldDelete).toEqual(seeded.entry.objects);
    expect(first.entries[0].skips).toEqual([]);
    expect((await db.doc(`mediaPurgeQueue/${seeded.entryId}`).get()).data()).toEqual(seeded.entry);
    expect((await db.doc("media_assets/asset-1").get()).data()).toEqual(seeded.asset);
    expect((await db.collection("system/media/masterLocks").get()).empty).toBe(true);
    expect((await db.collection("system/mediaPurge/runs").get()).size).toBe(2);
    const audits = await db.collection("admin_logs").get();
    expect(audits.size).toBe(2);
    expect(audits.docs.every((doc) => doc.data().action === "media.purge.dry_run")).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it.each(["working", "published", "deployed"])("skips %s usage including a retained old generation", async (state) => {
    await seed();
    await db.doc(`cmsPages/home/mediaUsage/${state}-1`).set({ state, generation: 1, assetIds: ["asset-1"] });
    await db.doc("system/publicDeployment").set({ activeGeneration: 9 });
    const report = await runner()();
    expect(report.entries[0].wouldDelete).toEqual([]);
    expect(report.entries[0].skips).toEqual([{ reason: `${state}_usage` }]);
  });

  it("excludes future eligibility and refuses an early eligibleAt inside the 30-day hold", async () => {
    await seed("future", {}, { eligibleAt: new Date(NOW + 1).toISOString() });
    await seed("young", {}, { queuedAt: new Date(NOW - 1000).toISOString(), eligibleAt: OLD });
    const report = await runner()();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].skips).toEqual([{ reason: "retention_period" }]);
  });

  it("keeps a shared master while reporting the unreferenced public key", async () => {
    await seed("asset-1", { master: { key: MASTER } });
    await db.doc("media_assets/shared").set({ lifecycle: "active", master: { key: MASTER } });
    const report = await runner()();
    expect(report.entries[0].wouldDelete.map((object) => object.store)).toEqual(["public"]);
    expect(report.entries[0].skips).toEqual([{ reason: "master_referenced_asset", key: MASTER }]);
  });

  it("keeps a master reused by the same asset's old and current version", async () => {
    await seed("asset-1", { lifecycle: "active", contentHash: "b".repeat(64), master: { key: MASTER } }, {}, true);
    await db.doc("media_assets/asset-1").update({ storageKey: "cms-media/news/new.webp" });
    const report = await runner()();
    expect(report.entries[0].skips).toEqual([{ reason: "master_referenced_asset", key: MASTER }]);
    expect(report.entries[0].wouldDelete).toHaveLength(1);
  });

  it.each(["reserved", "object_ready", "capacity_cleanup"])("keeps a master referenced by an %s upload claim", async (state) => {
    await seed("asset-1", { master: { key: MASTER } });
    await db.doc(`system/media/hashOwners/${"b".repeat(64)}`).set({ state, recordSeed: { master: { key: MASTER, retained: true } } });
    expect((await runner()()).entries[0].skips).toEqual([{ reason: "master_referenced_claim", key: MASTER }]);
  });

  it("observes a purging master lock without modifying it", async () => {
    await seed("asset-1", { master: { key: MASTER } });
    const lock = db.doc(`system/media/masterLocks/${HASH}`);
    await lock.set({ state: "purging", runId: "other" });
    expect((await runner()()).entries[0].skips).toEqual([{ reason: "master_purging", key: MASTER }]);
    expect((await lock.get()).data()).toEqual({ state: "purging", runId: "other" });
  });

  it.each([OLD, new Date(NOW + 60_000).toISOString()])("blocks the revert reservation race with replacement lease %s", async (leaseExpiresAt) => {
    await seed("asset-1", { contentHash: "b".repeat(64) }, {}, true);
    await db.doc("system/media/replacements/asset-1").set({ contentHash: HASH, leaseExpiresAt });
    const report = await runner()();
    expect(report.entries[0].wouldDelete).toEqual([]);
    expect(report.entries[0].skips).toEqual([{ reason: "replacement_in_progress" }]);
  });

  it("skips a revived current version and another active asset using a queued public key", async () => {
    await seed("revived", { lifecycle: "active" }, {}, true);
    const shared = await seed("shared");
    await db.doc("media_assets/other").set({ kind: "image", lifecycle: "active", storageKey: shared.asset.storageKey });
    const report = await runner()();
    expect(report.entries.find((entry) => entry.assetId === "revived").skips).toEqual([{ reason: "version_is_current" }]);
    expect(report.entries.find((entry) => entry.assetId === "shared").skips).toEqual([{ reason: "public_key_referenced" }]);
    expect(report.summary.wouldDelete).toBe(0);
  });

  it("keeps a master held by another pending version of a restorable asset", async () => {
    await seed("asset-1", { master: { key: MASTER } });
    await db.doc("media_assets/other").set({ kind: "image", lifecycle: "active" });
    await db.doc(`mediaPurgeQueue/version:other:${HASH}`).set({
      assetId: "other", state: "pending", masterKey: MASTER,
      eligibleAt: new Date(NOW + 60_000).toISOString(),
    });
    const report = await runner()();
    expect(report.entries[0].skips).toEqual([{ reason: "master_referenced_queue", key: MASTER }]);
    expect(report.entries[0].wouldDelete.map((object) => object.store)).toEqual(["public"]);
  });

  it("inspects an expired purging entry without changing its recovery state", async () => {
    const seeded = await seed("asset-1", {}, { state: "purging", leaseExpiresAt: OLD, runId: "expired-run" });
    const report = await runner()();
    expect(report.entries[0].wouldDelete).toEqual(seeded.entry.objects);
    expect(report.entries[0].skips).toEqual([]);
    expect((await db.doc(`mediaPurgeQueue/${seeded.entryId}`).get()).data()).toEqual(seeded.entry);
  });

  it("stops before any write when disabled", async () => {
    await db.doc("system/mediaPurge").set({ enabled: false });
    expect(await runner()()).toEqual({ skipped: "disabled" });
    expect((await db.doc("system/mediaPurge").get()).data()).toEqual({ enabled: false });
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("stops before config creation or reports when billing is disabled", async () => {
    await db.doc("system/billing").set({ disabled: true });
    await expect(runner()()).rejects.toThrow("billing is disabled");
    expect((await db.doc("system/mediaPurge").get()).exists).toBe(false);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it.each(["config", "billing"])("rechecks the %s switch inside the lease transaction", async (switchName) => {
    const original = db.runTransaction.bind(db);
    vi.spyOn(db, "runTransaction").mockImplementationOnce(async (...args) => {
      await db.doc(switchName === "config" ? "system/mediaPurge" : "system/billing")
        .set(switchName === "config" ? { enabled: false } : { disabled: true });
      return original(...args);
    });
    expect(await runner()()).toEqual({ skipped: "disabled_or_leased" });
    const config = await db.doc("system/mediaPurge").get();
    expect(config.data()).toEqual(switchName === "config" ? { enabled: false } : undefined);
    expect((await db.collection("system/mediaPurge/runs").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("respects the run lease and rotates the bounded cursor without queue writes", async () => {
    await seed("asset-a");
    await seed("asset-b");
    await db.doc("system/mediaPurge").set({ maxEntriesPerRun: 1 });
    expect((await runner()()).entries[0].assetId).toBe("asset-a");
    expect((await runner()()).entries[0].assetId).toBe("asset-b");
    expect((await runner()()).entries).toEqual([]);
    expect((await runner()()).entries[0].assetId).toBe("asset-a");
    await db.doc("system/mediaPurge").update({ lease: { runId: "busy", expiresAt: new Date(NOW + 1).toISOString() } });
    expect(await runner()()).toEqual({ skipped: "disabled_or_leased" });
  });

  it.each(["", "invalid/path"])("resets malformed cursor %j and safely defaults malformed config and lease", async (id) => {
    await seed();
    await db.doc("system/mediaPurge").set({
      enabled: true, dryRun: "false", maxEntriesPerRun: 101, maxAttempts: null,
      lease: { expiresAt: "invalid" }, cursor: { eligibleAt: OLD, id },
    });
    const report = await runner()();
    expect(report.entries).toHaveLength(1);
    expect(report.configuredDryRun).toBe(true);
    expect(report.effectiveDryRun).toBe(true);
    expect((await db.doc("system/mediaPurge").get()).data()).toMatchObject({
      enabled: true, dryRun: "false", maxEntriesPerRun: 101, maxAttempts: null,
      lease: null, cursor: null,
    });
  });

  it("reports exhausted attempts and live entry leases without changing them", async () => {
    await seed("exhausted", {}, { attempts: 5 });
    await seed("leased", {}, { state: "purging", leaseExpiresAt: new Date(NOW + 1).toISOString() });
    const before = (await db.collection("mediaPurgeQueue").get()).docs.map((doc) => doc.data());
    await expect(runner()()).rejects.toThrow("Media purge incomplete");
    const runId = (await db.doc("system/mediaPurge").get()).data().lastRunSummary.runId;
    const report = (await db.doc(`system/mediaPurge/runs/${runId}`).get()).data();
    expect(report.entries.flatMap((entry) => entry.skips.map((skip) => skip.reason))).toEqual(["max_attempts", "entry_lease_active"]);
    expect(report.summary.needsReconciliation).toBe(1);
    expect((await db.collection("mediaPurgeQueue").get()).docs.map((doc) => doc.data())).toEqual(before);
    expect(ping).not.toHaveBeenCalled();
  });
});

describe("fenced permanent image purge", () => {
  let storage;
  let clock;
  beforeEach(() => {
    clock = NOW;
    storage = { remove: vi.fn(async () => {}), listMasters: vi.fn(async () => ({ objects: [], cursor: null })) };
  });
  function liveRunner(options = {}) {
    return runner({ deployment: { enabled: true, realDeletesEnabled: true },
      now: () => clock, storageFactory: () => storage, ...options });
  }
  async function failedRun() {
    await expect(liveRunner()()).rejects.toThrow("Media purge incomplete");
    const control = (await db.doc("system/mediaPurge").get()).data();
    return (await db.doc(`system/mediaPurge/runs/${control.lastRunSummary.runId}`).get()).data();
  }
  async function eligible(assetOverrides = {}, entryOverrides = {}, version = false) {
    const fixture = await seed("asset-1", { master: { key: MASTER }, ...assetOverrides }, entryOverrides, version);
    await db.doc(`system/media/hashOwners/${HASH}`).set({
      state: "committed", assetId: "asset-1", attemptId: "attempt-1", finalKey: fixture.entry.objects[0].key,
      recordSeed: { master: { key: MASTER } },
    });
    await db.doc("system/mediaPurge").set({ enabled: true, dryRun: false });
    return fixture;
  }

  it("holds schema-two physical deletion when actual retained-H coverage is missing", async () => {
    const fixture = await eligible();
    await db.doc("system/publicDeployment").set(releaseSelector());
    const report = await liveRunner()();
    expect(report.entries[0].skips).toContainEqual({ reason: "pair-retention-unproven" });
    expect(storage.remove).not.toHaveBeenCalled();
    expect((await db.doc(`mediaPurgeQueue/${fixture.entryId}`).get()).data()).toMatchObject({ state: "pending", attempts: 0 });
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("tombstoned");
    expect((await db.doc(`system/media/masterLocks/${HASH}`).get()).exists).toBe(false);
  });

  it("fences restore and reuse before deleting, confirms all objects, then records one purge", async () => {
    const fixture = await eligible({ thumbnails: [480, 960, 1600].map(width => ({
      storageKey: `cms-media/news/asset-1/thumbs/${HASH}-w${width}.webp`,
    })) });
    storage.remove.mockImplementation(async () => {
      expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("purging");
      expect((await db.doc(`system/media/hashOwners/${HASH}`).get()).data().state).toBe("purging");
      expect((await db.doc(`system/media/masterLocks/${HASH}`).get()).data().state).toBe("purging");
    });
    const report = await liveRunner()();
    expect(report.effectiveDryRun).toBe(false);
    expect(report.entries[0].execution.outcome).toBe("purged");
    expect(storage.remove.mock.calls.map(([object]) => object)).toEqual([
      ...[480, 960, 1600].map(width => ({ store: "public", key: `cms-media/news/asset-1/thumbs/${HASH}-w${width}.webp` })),
      { store: "public", key: fixture.asset.storageKey },
      { store: "masters", key: MASTER },
    ]);
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("purged");
    expect((await db.doc(`mediaPurgeQueue/${fixture.entryId}`).get()).data().state).toBe("purged");
    expect((await db.doc(`system/media/hashOwners/${HASH}`).get()).data().state).toBe("purged");
    expect((await db.doc(`system/media/masterLocks/${HASH}`).get()).exists).toBe(false);
    await liveRunner()();
    expect(storage.remove).toHaveBeenCalledTimes(fixture.entry.objects.length);
    expect((await db.collection("admin_logs").where("action", "==", "media.purge").get()).size).toBe(1);
  });

  it("reports storage setup failure before any destructive claim or retry is consumed", async () => {
    const fixture = await eligible();
    const queue = db.doc(`mediaPurgeQueue/${fixture.entryId}`);
    const owner = db.doc(`system/media/hashOwners/${HASH}`);
    const beforeOwner = (await owner.get()).data();
    await expect(liveRunner({ storageFactory: () => { throw new Error("private-provider-detail"); } })())
      .rejects.toThrow("Media purge incomplete");
    const control = (await db.doc("system/mediaPurge").get()).data();
    const report = (await db.doc(`system/mediaPurge/runs/${control.lastRunSummary.runId}`).get()).data();
    expect(report.startupError).toBe("storage_configuration_unavailable");
    expect(report.summary).toMatchObject({ entries: 0, failed: 1, purged: 0 });
    expect(JSON.stringify(report)).not.toContain("private-provider-detail");
    expect((await queue.get()).data()).toEqual(fixture.entry);
    expect((await owner.get()).data()).toEqual(beforeOwner);
    expect((await db.doc("media_assets/asset-1").get()).data()).toEqual(fixture.asset);
    expect((await db.collection("system/media/masterLocks").get()).empty).toBe(true);
    expect(control.lease).toBeNull();
    expect(ping).not.toHaveBeenCalled();
  });

  it("validates the heartbeat URL before any destructive claim", async () => {
    await eligible();
    await expect(liveRunner({ getHealthchecksUrl: () => "invalid-private-ping-value" })()).rejects.toThrow("must be an HTTPS URL");
    expect(storage.remove).not.toHaveBeenCalled();
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("tombstoned");
  });

  it("does not expose a heartbeat transport exception containing the private URL", async () => {
    await db.doc("system/mediaPurge").set({ enabled: true, dryRun: true });
    await expect(liveRunner({ fetchImpl: async () => { throw new Error("private-ping-value"); } })())
      .rejects.toThrow(/^Healthchecks media purge ping failed$/);
  });

  it("purges a superseded version without changing the active asset", async () => {
    await eligible({ lifecycle: "active", contentHash: "b".repeat(64), storageKey: `cms-media/news/asset-1/${"b".repeat(64)}.webp`, master: null }, {}, true);
    // The version queue must retain the former binary's original key.
    await db.doc(`mediaPurgeQueue/version:asset-1:${HASH}`).update({ objects: [{ store: "public", key: `cms-media/news/asset-1/${HASH}.webp` }], masterKey: null });
    await db.doc(`system/media/hashOwners/${HASH}`).update({ finalKey: `cms-media/news/asset-1/${HASH}.webp` });
    expect((await liveRunner()()).entries[0].execution.outcome).toBe("purged");
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("active");
  });

  it("protects a build reserved before its deployed media usage rows exist", async () => {
    await eligible();
    await db.doc("system/publicDeployment/buildBatches/older-build").set({ status: "reserved" });
    const report = await liveRunner()();
    expect(report.entries[0].skips).toContainEqual({ reason: "public_build_in_progress" });
    expect(storage.remove).not.toHaveBeenCalled();
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("tombstoned");
  });

  it("retains a shared master while removing the binned image's public copies", async () => {
    await eligible();
    await db.doc("media_assets/shared").set({ lifecycle: "active", master: { key: MASTER } });
    const report = await liveRunner()();
    expect(report.entries[0].execution.outcome).toBe("purged");
    expect(storage.remove.mock.calls.map(([object]) => object.store)).toEqual(["public"]);
    expect((await db.doc("mediaPurgeQueue/asset:asset-1").get()).data().retainedMasterKey).toBe(MASTER);
    expect((await db.doc("system/media/masterLocks/" + HASH).get()).exists).toBe(false);
  });

  it("retains a master referenced by another historical receipt", async () => {
    await eligible();
    await db.doc(`system/media/hashOwners/${"b".repeat(64)}/superseded/old`).set({ state: "committed", recordSeed: { master: { key: MASTER } } });
    const dry = await runner()();
    expect(dry.entries[0].wouldDelete.map((object) => object.store)).toEqual(["public"]);
    expect(dry.entries[0].skips).toContainEqual({ reason: "master_referenced_receipt", key: MASTER });
    expect((await db.doc("mediaPurgeQueue/asset:asset-1").get()).data().state).toBe("pending");
    await liveRunner()();
    expect(storage.remove.mock.calls.map(([object]) => object.store)).toEqual(["public"]);
  });

  it("keeps durable fences on error and resumes only after the execution lease", async () => {
    await eligible();
    storage.remove.mockRejectedValueOnce(new Error("provider credential must never reach report"));
    const first = await failedRun();
    expect(first.summary.failed).toBe(1);
    expect(ping).not.toHaveBeenCalled();
    expect(first.entries[0].execution.outcome).toBe("retry_required");
    expect((await db.doc(`system/media/masterLocks/${HASH}`).get()).data().state).toBe("purging");
    const entry = (await db.doc("mediaPurgeQueue/asset:asset-1").get()).data();
    expect(entry.lastError).toBe("object_delete_or_receipt_failed");
    expect(JSON.stringify(first)).not.toContain("credential");
    await liveRunner()();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    clock += 2 * 60_000 + 1;
    const resumed = await liveRunner()();
    expect(resumed.entries[0].execution.outcome).toBe("purged");
    expect((await db.doc("mediaPurgeQueue/asset:asset-1").get()).data().attempts).toBe(2);
  });

  it("honors a kill switch between object deletes and never marks partial work purged", async () => {
    await eligible();
    storage.remove.mockImplementationOnce(async () => db.doc("system/mediaPurge").update({ enabled: false }));
    const report = await failedRun();
    expect(report.entries[0].execution.outcome).toBe("retry_required");
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("purging");
    expect((await db.doc(`system/media/masterLocks/${HASH}`).get()).data().state).toBe("purging");
  });

  it("refuses a foreign object's key even if it is in the public prefix", async () => {
    await eligible({}, { objects: [{ store: "public", key: `cms-media/news/other/${HASH}.webp` }], masterKey: null });
    expect((await failedRun()).entries[0].deferred).toBe("invalid_object_identity");
    expect(storage.remove).not.toHaveBeenCalled();
    expect((await db.doc("media_assets/asset-1").get()).data().lifecycle).toBe("tombstoned");
  });

  it("refuses real deletion without a matching immutable owner receipt", async () => {
    await eligible();
    await db.doc(`system/media/hashOwners/${HASH}`).delete();
    expect((await failedRun()).entries[0].deferred).toBe("owner_receipt_missing");
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("stops an expired executor before any subsequent I/O", async () => {
    await eligible();
    storage.remove.mockImplementationOnce(async () => { clock += 2 * 60_000; });
    expect((await failedRun()).entries[0].execution.outcome).toBe("retry_required");
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it("reports no progress without claiming entries when setup has exhausted the time budget", async () => {
    await eligible();
    await expect(liveRunner({ storageFactory: () => { clock += 6 * 60_000; return storage; } })())
      .rejects.toThrow("Media purge incomplete");
    const control = (await db.doc("system/mediaPurge").get()).data();
    const report = (await db.doc(`system/mediaPurge/runs/${control.lastRunSummary.runId}`).get()).data();
    expect(report.summary).toMatchObject({ entries: 0, failed: 0, deferred: 1, budgetDeferred: 1 });
    expect((await db.doc("mediaPurgeQueue/asset:asset-1").get()).data()).toMatchObject({ state: "pending", attempts: 0 });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(report.inventory).toBeNull();
    expect(storage.listMasters).not.toHaveBeenCalled();
    expect(control.lease).toBeNull();
    expect(ping).not.toHaveBeenCalled();
  });

  it("reports orphan masters without queuing or deleting them", async () => {
    const orphan = { key: `masters/bb/${"b".repeat(64)}.jpg`, lastModified: OLD, sizeBytes: 24 };
    storage.listMasters.mockResolvedValue({ objects: [orphan], cursor: null });
    await db.doc("system/mediaPurge").set({ enabled: true, dryRun: false });
    const report = await liveRunner()();
    expect(report.inventory).toMatchObject({ reportOnly: true, candidates: [orphan], scanned: 1 });
    expect((await db.collection("mediaPurgeQueue").get()).empty).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("immediate image purge", () => {
  const origin = "https://media.example.org";
  const assetId = "asset-1";
  const uid = "delegated-admin";
  const key = `cms-media/news/${assetId}/${HASH}.webp`;
  const thumbnailKey = `cms-media/news/${assetId}/thumbs/${HASH}-w480.webp`;
  const neighborKey = `cms-media/news/asset-2/${HASH}.webp`;
  const entryRef = () => db.doc(`mediaPurgeQueue/asset:${assetId}`);
  let clock;
  let objects;
  let cached;
  let fetchImpl;
  let storage;
  let cache;
  let keepCached;

  beforeEach(async () => {
    clock = NOW;
    keepCached = false;
    objects = new Set([key, thumbnailKey, MASTER, neighborKey]);
    cached = new Set([...objects].filter(path => path !== MASTER).map(path => `${origin}/${path}`));
    fetchImpl = vi.fn(async (url, options) => {
      if (options?.method === "POST") {
        for (const prefix of JSON.parse(options.body).prefixes) {
          const target = `https://${prefix}`;
          expect(objects.has(new URL(target).pathname.slice(1))).toBe(false);
          if (!keepCached) cached.delete(target);
        }
        return Response.json({ success: true });
      }
      return new Response(null, { status: cached.has(url) || objects.has(new URL(url).pathname.slice(1)) ? 200 : 404 });
    });
    const client = { send: vi.fn(async (command) => {
      const { Key, Bucket } = command.input;
      expect(Bucket).toBe(Key === MASTER ? "masters-fixture" : "public-fixture");
      if (command.constructor.name === "DeleteObjectCommand") objects.delete(Key);
      else if (!objects.has(Key)) throw Object.assign(new Error("Not found"), { name: "NoSuchKey" });
      return {};
    }) };
    storage = new storageModule.MediaPurgeStorage({ publicBucket: "public-fixture", masterBucket: "masters-fixture",
      client, clock: () => clock });
    storage.listMasters = vi.fn(async () => ({ objects: [], cursor: null }));
    cache = cacheModule.createMediaCacheRetirement({ origin, zoneId: "a".repeat(32), token: "fixture-only",
      fetchImpl, clock: () => clock });
    await seed(assetId, { version: 2, url: `${origin}/${key}`, master: { key: MASTER },
      thumbnails: [{ storageKey: thumbnailKey, url: `${origin}/${thumbnailKey}` }] },
    { queuedAt: new Date(NOW - 10_000).toISOString(), eligibleAt: new Date(NOW + bin.MEDIA_RETENTION_MS - 10_000).toISOString() });
    await Promise.all([
      db.doc(`users/${uid}`).set({ accessTier: "admin" }),
      db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true }),
      db.doc("system/mediaPurge").set({ enabled: true, dryRun: false, immediateDeleteDelegates: [uid] }),
      db.doc("system/publicDeployment").set({ schemaVersion: 1, state: "idle", mediaLifecycleReady: true,
        activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
        activeDeploymentId: "baseline", newestEligibleBuildBatchId: "baseline", activeCommitSha: "b".repeat(40) }),
    ]);
  });

  async function request({ role = "admin", actorUid = uid, confirmed = assetId, version = 2, ...overrides } = {}) {
    const handler = immediate.createCmsPurgeBinnedImageHandler({ firestore: db, realDeletesEnabled: true,
      requirePrincipalFn: async () => ({ uid: actorUid, principal: { grants: [{ role }] } }),
      storageFactory: () => storage, cacheFactory: () => cache, clock: () => clock,
      log: { error: vi.fn() }, ...overrides });
    const res = { set: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await handler({ method: "POST", headers: { "content-type": "application/json",
      "if-match": mediaLibrary.formatMediaEtag(assetId, version) }, body: { assetId, confirmAssetId: confirmed } }, res);
    return { status: res.status.mock.lastCall[0], body: res.json.mock.lastCall[0] };
  }

  it.each([
    [{ role: "editor" }, 403], [{ actorUid: "another-admin" }, 403],
    [{ confirmed: "another-image" }, 400], [{ version: 1 }, 412], [{ realDeletesEnabled: false }, 503],
  ])("refuses invalid admission %j", async (options, status) => {
    expect((await request(options)).status).toBe(status);
    expect((await entryRef().get()).data()).toMatchObject({ state: "pending", attempts: 0 });
    expect(objects.size).toBe(4);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["working", "published", "deployed"])("refuses %s references before claiming or deleting", async (state) => {
    await db.doc(`cmsPages/fixture/mediaUsage/${state}-1`).set({ state, generation: 1, assetIds: [assetId] });
    expect(await request()).toMatchObject({ status: 409, body: { error: expect.stringContaining("in use") } });
    expect((await entryRef().get()).data()).toMatchObject({ state: "pending", attempts: 0 });
    expect(objects.size).toBe(4);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a queue key that does not match the confirmed image", async () => {
    await entryRef().update({ objects: [{ store: "public", key: neighborKey }] });
    expect((await request()).status).toBe(409);
    expect(objects.size).toBe(4);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("removes the confirmed objects and verifies only their public delivery before retention is due", async () => {
    expect((await fetchImpl(`${origin}/${key}`)).status).toBe(200);
    expect(await request()).toEqual({ status: 200, body: { success: true, outcome: "purged" } });
    expect([...objects]).toEqual([neighborKey]);
    const [, purge, imageRead, thumbnailRead] = fetchImpl.mock.calls;
    expect(JSON.parse(purge[1].body).prefixes).toEqual([`media.example.org/${key}`, `media.example.org/${thumbnailKey}`]);
    expect([imageRead[0], thumbnailRead[0]]).toEqual([`${origin}/${key}`, `${origin}/${thumbnailKey}`]);
    expect((await fetchImpl(`${origin}/${neighborKey}`)).status).toBe(200);
    expect((await db.doc(`media_assets/${assetId}`).get()).data()).toMatchObject({ lifecycle: "purged", purgedBy: uid });
    expect((await entryRef().get()).data()).toMatchObject({ state: "purged", cacheRetirement: "verified" });
    const audits = (await db.collection("admin_logs").where("actorUid", "==", uid).get()).docs.map(doc => doc.data());
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "media.purge.request", after: expect.objectContaining({ cacheRetirement: "pending" }) }),
      expect.objectContaining({ action: "media.purge", after: expect.objectContaining({ cacheRetirement: "verified" }) }),
    ]));
  });

  it("keeps restore fenced after cache failure and lets the sweep resume before the original deadline", async () => {
    keepCached = true;
    expect(await request()).toMatchObject({ status: 202, body: { outcome: "retry_required" } });
    expect((await entryRef().get()).data()).toMatchObject({ state: "purging", cacheRetirement: "pending",
      lastError: "public_cache_retirement_failed" });
    expect((await db.doc(`media_assets/${assetId}`).get()).data().lifecycle).toBe("purging");
    expect((await fetchImpl(`${origin}/${key}`)).status).toBe(200);
    clock += 120_000;
    keepCached = false;
    const report = await runner({ deployment: { enabled: true, realDeletesEnabled: true }, now: () => clock,
      storageFactory: () => storage, retirePublicCopies: cache.retire })();
    expect(report.entries[0].execution.outcome).toBe("purged");
    expect((await fetchImpl(`${origin}/${key}`)).status).toBe(404);
    expect((await entryRef().get()).data()).toMatchObject({ state: "purged", cacheRetirement: "verified", attempts: 2 });
    expect((await db.collection("admin_logs").where("action", "==", "media.purge").get()).size).toBe(1);
  });
});

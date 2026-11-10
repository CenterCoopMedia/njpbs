import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";
import consumer from "../../functions/media-master-cleanup-consumer.js";
import cleanup from "../../functions/lib/media-master-cleanup.js";
import masters from "../../functions/lib/r2-media-masters.js";
import r2 from "../../functions/lib/media-contract.js";
import media from "../../functions/media.js";
import replacement from "../../functions/replace-media.js";
import recovery from "../../functions/media-recovery.js";
import purgeDeployment from "../../functions/lib/media-purge-deployment.js";

const START = new Date("2026-10-10T12:00:00.000Z");
const OLD = "2026-10-10T10:00:00.000Z";
const EXPIRED = "2026-10-10T10:15:00.000Z";
const CLAIM = `system/media/hashOwners/${"b".repeat(64)}`;
const LOCK = `system/media/masterLocks/${"a".repeat(64)}`;
const QUEUE = "mediaMasterCleanup/attempt-1";
const CONTROL = "system/mediaMasterCleanup";

function fixture({ queued = true, pending = false } = {}) {
  const f = fakeFirestore();
  const master = { contentHash: "a".repeat(64), mimeType: "image/jpeg", sizeBytes: 10,
    width: 40, height: 20, retained: !pending };
  master.key = masters.masterObjectKey(master);
  if (pending) master.reason = "pending";
  const claim = { state: "reserved", attemptId: "attempt-1", assetId: "asset-1", category: "news",
    mimeType: "image/webp", sizeBytes: 8, createdAt: OLD, updatedAt: OLD, leaseExpiresAt: EXPIRED,
    recordSeed: { metadata: { name: "Studio", category: "news", categories: ["news"], description: "Studio",
      altText: "Studio", license: "NJ PBS owned", credit: "NJ PBS", tags: [] },
    originalName: "studio.jpg", dimensions: { width: 40, height: 20 },
    actor: { uid: "editor", email: null }, source: null, master } };
  claim.finalKey = r2.finalObjectKey({ ...claim, contentHash: "b".repeat(64) });
  claim.stagingKey = r2.stagingObjectKey(claim.attemptId);
  recovery.assertMutableOwner("b".repeat(64), claim);
  f.rows.set(CLAIM, claim);
  if (queued) f.rows.set(QUEUE, cleanup.cleanupIntent({ ref: f.firestore.doc(CLAIM), owner: claim, nowIso: OLD }));
  const objects = new Set([master.key]);
  const state = { now: START, failDelete: false, beforeDelete: null };
  const send = vi.fn(async (command) => {
    expect(command.constructor.name).toBe("DeleteObjectCommand");
    await state.beforeDelete?.();
    if (state.failDelete) throw new Error("provider failure with sensitive details");
    objects.delete(command.input.Key);
    return {};
  });
  const storage = new masters.R2MediaMasterStorage({ bucket: "fake-private", client: { send }, clockMs: () => state.now.getTime() });
  const factory = vi.fn(() => storage);
  const log = { warn: vi.fn(), error: vi.fn() };
  const run = (options = {}) => consumer.runMasterCleanupConsumer({ firestore: f.firestore,
    masterStorageFactory: factory, enabled: true, now: () => state.now, log, ...options });
  const immediate = (options = {}) => cleanup.cleanupUploadMaster({ firestore: f.firestore,
    ref: f.firestore.doc(CLAIM), attemptId: claim.attemptId, leaseExpiresAt: claim.leaseExpiresAt,
    masterStorageFactory: factory, nowIso: state.now.toISOString(), clockMs: () => state.now.getTime(), ...options });
  return { ...f, claim, master, objects, state, send, factory, run, immediate, log };
}
const entryStatus = (report) => report.entries.map((entry) => entry.status);
const advance = (f, milliseconds = cleanup.DELETE_LEASE_MS) => {
  f.state.now = new Date(f.state.now.getTime() + milliseconds);
};

describe("disabled bounded master cleanup consumer", () => {
  it("does no work by default and has no deployment export or scheduler", async () => {
    const f = fixture();
    expect(await f.run({ enabled: undefined })).toEqual({ status: "disabled" });
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.rows.has(CONTROL)).toBe(false);
    expect(readFileSync("functions/index.js", "utf8")).not.toContain("media-master-cleanup-consumer");
    expect(purgeDeployment.readPurgeDeployment("/nonexistent/purge-deployment.json", {}))
      .toEqual({ enabled: false, realDeletesEnabled: false });
  });

  it("deletes an expired unshared master and makes repeated runs harmless", async () => {
    const f = fixture();
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    expect(f.objects.size).toBe(0);
    expect(f.rows.has(QUEUE)).toBe(false);
    expect(f.rows.has(LOCK)).toBe(false);
    expect(f.rows.get(CLAIM).recordSeed.master).toMatchObject({ retained: false, reason: "store-failed" });
    expect(f.rows.get(CLAIM).recordSeed.master.key).toBeUndefined();
    expect(entryStatus(await f.run())).toEqual([]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed delete fenced, backs off, and stops after five attempts", async () => {
    const f = fixture();
    f.state.failDelete = true;
    for (let attempt = 1; attempt <= consumer.MAX_ATTEMPTS; attempt++) {
      const report = await f.run();
      expect(entryStatus(report)).toEqual([attempt === 5 ? "retry_exhausted" : "retry"]);
      expect(report.alerts).toBe(1);
      expect(f.rows.get(QUEUE).attempts).toBe(attempt);
      expect(f.rows.get(LOCK).state).toBe("purging");
      expect(f.rows.get(CLAIM).recordSeed.master.key).toBe(f.master.key);
      expect(JSON.stringify([...f.rows])).not.toContain("sensitive details");
      f.state.now = new Date(f.rows.get(QUEUE).nextAttemptAt);
    }
    expect(entryStatus(await f.run())).toEqual(["retry_exhausted"]);
    expect(f.send).toHaveBeenCalledTimes(5);
    expect(f.objects.has(f.master.key)).toBe(true);
  });

  it("does not retry before its deletion lease or retry deadline", async () => {
    const f = fixture();
    f.state.failDelete = true;
    await f.run();
    expect(entryStatus(await f.run())).toEqual(["delete_busy"]);
    advance(f);
    await f.run();
    advance(f);
    expect(entryStatus(await f.run())).toEqual(["backoff"]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("repairs delete succeeded / receipt missing by replaying under the retained fence", async () => {
    const f = fixture();
    f.hooks.beforeCommit = (writes) => {
      if (writes.some((write) => write.ref.path === LOCK && write.kind === "delete")) {
        f.hooks.beforeCommit = null;
        throw new Error("Receipt commit unavailable");
      }
    };
    expect(entryStatus(await f.run())).toEqual(["retry"]);
    expect(f.objects.size).toBe(0);
    expect(f.rows.has(LOCK)).toBe(true);
    expect(f.rows.get(CLAIM).recordSeed.master.retained).toBe(true);
    advance(f);
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.rows.has(LOCK)).toBe(false);
    expect(f.rows.has(QUEUE)).toBe(false);
  });

  it("recovers a crash after fencing but before issuing DeleteObject", async () => {
    const f = fixture();
    f.rows.set(LOCK, { state: "purging", key: f.master.key, cleanupId: "attempt-1",
      claimPath: CLAIM, leaseExpiresAt: EXPIRED, deleteToken: "dead-worker", deleteLeaseExpiresAt: OLD });
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
  });

  it.each([true, false])("discovers stale pre-write claims with possible object=%s", async (exists) => {
    const f = fixture({ queued: false, pending: true });
    if (!exists) f.objects.clear();
    expect((await f.run()).claims[0].status).toBe("discovered");
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.rows.get(QUEUE).key).toBe(f.master.key);
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    expect(f.objects.size).toBe(0);
  });

  it("does not discover live, replacement, or committed claims", async () => {
    const f = fixture({ queued: false });
    f.rows.get(CLAIM).leaseExpiresAt = "2026-10-11T12:00:00.000Z";
    expect((await f.run()).claims[0].status).toBe("lease_active");
    f.rows.get(CLAIM).operation = "replacement";
    expect((await f.run()).claims[0].status).toBe("not_candidate");
    delete f.rows.get(CLAIM).operation;
    f.rows.get(CLAIM).state = "committed";
    expect((await f.run()).claims[0].status).toBe("not_candidate");
    expect(f.rows.has(QUEUE)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refreshes the same attempt's renewed lease and defers deletion until expiry", async () => {
    const f = fixture();
    const renewed = "2026-10-10T13:00:00.000Z";
    f.rows.get(CLAIM).leaseExpiresAt = renewed;
    expect(entryStatus(await f.run())).toEqual(["lease_refreshed"]);
    expect(f.rows.get(QUEUE).leaseExpiresAt).toBe(renewed);
    expect(entryStatus(await f.run())).toEqual(["lease_active"]);
    expect(f.factory).not.toHaveBeenCalled();
    f.state.now = new Date(renewed);
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
  });

  it("never treats early eligibility as permission to delete an active unfenced claim", async () => {
    const f = fixture();
    f.rows.get(CLAIM).leaseExpiresAt = "2026-10-11T12:00:00.000Z";
    f.rows.get(QUEUE).leaseExpiresAt = f.rows.get(CLAIM).leaseExpiresAt;
    expect(entryStatus(await f.run())).toEqual(["lease_active"]);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("retires a stale intent only when the committed asset retains the exact master", async () => {
    const f = fixture();
    Object.assign(f.rows.get(CLAIM), { state: "committed", committedAt: OLD, objectReadyAt: OLD });
    f.rows.set("media_assets/asset-1", { id: "asset-1", master: f.master });
    expect(entryStatus(await f.run())).toEqual(["retired_committed"]);
    expect(f.rows.has(QUEUE)).toBe(false);
    expect(f.objects.has(f.master.key)).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it.each(["asset", "claim", "replacement", "version", "unknown-version"])(
    "protects a master referenced by %s", async (reference) => {
      const f = fixture();
      const references = {
        asset: ["media_assets/shared", { lifecycle: "tombstoned", master: f.master }],
        claim: [`system/media/hashOwners/${"c".repeat(64)}`, { state: "reserved", recordSeed: { master: f.master } }],
        replacement: [`system/media/hashOwners/${"c".repeat(64)}`,
          { operation: "replacement", state: "reserved", recordSeed: { master: f.master } }],
        version: ["mediaPurgeQueue/version:old", { state: "pending", masterKey: f.master.key }],
        "unknown-version": ["mediaPurgeQueue/version:old", { state: "unknown", masterKey: f.master.key }],
      };
      f.rows.set(...references[reference]);
      expect(entryStatus(await f.run())).toEqual(["shared"]);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.rows.has(LOCK)).toBe(false);
      expect(f.rows.get(QUEUE).attempts).toBeUndefined();
    },
  );

  it.each(["wrong-key", "wrong-path", "wrong-id", "invalid-time", "invalid-attempts", "missing-claim", "different-attempt", "invalid-claim"])(
    "reports %s without deleting or retiring the record", async (fault) => {
      const f = fixture();
      const entry = f.rows.get(QUEUE);
      if (fault === "wrong-key") entry.key = "masters/arbitrary";
      if (fault === "wrong-path") entry.claimPath = "media_assets/asset-1";
      if (fault === "wrong-id") entry.attemptId = "wrong";
      if (fault === "invalid-time") entry.eligibleAt = "yesterday";
      if (fault === "invalid-attempts") entry.attempts = -1;
      if (fault === "missing-claim") f.rows.delete(CLAIM);
      if (fault === "different-attempt") {
        f.rows.get(CLAIM).attemptId = "attempt-new";
        f.rows.get(CLAIM).stagingKey = r2.stagingObjectKey("attempt-new");
      }
      if (fault === "invalid-claim") f.rows.get(CLAIM).leaseExpiresAt = "bad";
      const report = await f.run();
      expect(report.entries[0].alert).toBe(true);
      expect(f.rows.has(QUEUE)).toBe(true);
      expect(f.objects.size).toBe(1);
      expect(f.factory).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign", "lease-changed", "shared", "committed"])("retains and reports a %s fence", async (fault) => {
    const f = fixture();
    f.rows.set(LOCK, { state: "purging", cleanupId: "attempt-1", key: f.master.key });
    if (fault === "foreign") f.rows.get(LOCK).cleanupId = "another-attempt";
    if (fault === "lease-changed") f.rows.get(CLAIM).leaseExpiresAt = "2026-10-11T12:00:00.000Z";
    if (fault === "shared") f.rows.set("media_assets/shared", { master: f.master });
    if (fault === "committed") Object.assign(f.rows.get(CLAIM), {
      state: "committed", committedAt: OLD, objectReadyAt: OLD });
    const fence = structuredClone(f.rows.get(LOCK));
    expect((await f.run()).entries[0].alert).toBe(true);
    expect(f.rows.get(LOCK)).toEqual(fence);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("records unavailable storage as a retry without acquiring a new fence", async () => {
    const f = fixture();
    expect(entryStatus(await f.run({ masterStorageFactory: () => null }))).toEqual(["retry"]);
    expect(f.rows.has(LOCK)).toBe(false);
    expect(f.rows.get(QUEUE).attempts).toBe(1);
  });

  it("bounds both scans and reference reads, advancing past invalid entries", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.rows.set(`mediaMasterCleanup/aaa-${i}`, { invalid: true });
    const first = await f.run({ pageSize: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["aaa-0", "aaa-1"]);
    expect(first.claims).toHaveLength(1);
    await f.run({ pageSize: 2 });
    expect(entryStatus(await f.run({ pageSize: 2 }))).toEqual(["invalid_intent", "deleted"]);
    expect(f.queries.every((query) => query.cap <= 3)).toBe(true);
    await expect(f.run({ pageSize: 51 })).rejects.toThrow("1 to 50");
  });

  it("keeps ownership when a concurrent run tries to start during storage I/O", async () => {
    const f = fixture();
    f.state.beforeDelete = async () => {
      expect(await f.run()).toEqual({ status: "busy" });
      await expect(f.immediate()).rejects.toThrow("busy");
      await expect(f.firestore.runTransaction((transaction) => media.requireMasterAvailable(
        transaction, f.firestore, f.master))).rejects.toThrow("being purged");
    };
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("rechecks a renewal racing storage-client construction", async () => {
    const f = fixture();
    const report = await f.run({ masterStorageFactory: () => {
      f.rows.get(CLAIM).leaseExpiresAt = "2026-10-11T12:00:00.000Z";
      return f.factory();
    } });
    expect(entryStatus(report)).toEqual(["claim_changed"]);
    expect(f.rows.has(LOCK)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("retries the reference transaction when a reservation wins the fence race", async () => {
    const f = fixture();
    f.hooks.beforeCommit = (writes) => {
      if (writes.some((write) => write.ref.path === LOCK && write.kind === "set")) {
        f.hooks.beforeCommit = null;
        f.rows.set(`system/media/hashOwners/${"c".repeat(64)}`, { recordSeed: { master: f.master } });
      }
    };
    expect(entryStatus(await f.run())).toEqual(["shared"]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.has(LOCK)).toBe(false);
  });

  it("refuses a delayed master receipt during and after deletion", async () => {
    const f = fixture({ pending: true });
    const ready = { ...f.master, retained: true };
    delete ready.reason;
    const receipt = () => media.recordMasterResult({ firestore: f.firestore,
      refs: [f.firestore.doc(CLAIM)], attemptId: "attempt-1", leaseExpiresAt: EXPIRED, master: ready });
    f.state.beforeDelete = async () => { await expect(receipt()).rejects.toThrow("being purged"); };
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    await expect(receipt()).rejects.toThrow("reservation changed");
    expect(f.rows.get(CLAIM).recordSeed.master.key).toBeUndefined();
  });

  it("retains the fence when final receipt ownership changes", async () => {
    const f = fixture();
    f.state.beforeDelete = () => { f.rows.get(LOCK).deleteToken = "unexpected-owner"; };
    expect(entryStatus(await f.run())).toEqual(["receipt_changed"]);
    expect(f.rows.get(QUEUE).manualReview).toBe(true);
    expect(f.rows.get(LOCK).deleteToken).toBe("unexpected-owner");
    expect(f.rows.has(QUEUE)).toBe(true);
  });

  it("retains the run lease when report persistence fails and recovers after expiry", async () => {
    const f = fixture();
    f.hooks.beforeCommit = (writes) => {
      if (writes.some((write) => write.ref.path.startsWith(`${CONTROL}/runs/`))) {
        f.hooks.beforeCommit = null;
        throw new Error("Report unavailable");
      }
    };
    await expect(f.run()).rejects.toThrow("report could not be committed");
    expect(f.log.error).toHaveBeenCalledWith("media_master_cleanup_report_failed", expect.any(Object));
    expect(await f.run()).toEqual({ status: "busy" });
    advance(f);
    expect((await f.run()).status).toBe("complete");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("never consumes a replaced queue snapshot after preparing an attempt", async () => {
    const f = fixture();
    expect(entryStatus(await f.run({ masterStorageFactory: () => {
      f.rows.get(QUEUE).eligibleAt = "2026-10-11T12:00:00.000Z";
      return f.factory();
    } }))).toEqual(["intent_changed"]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.has(LOCK)).toBe(false);
  });

  it("stops admitting new work at the time budget and keeps the next cursor", async () => {
    const f = fixture();
    const copy = structuredClone(f.rows.get(QUEUE));
    f.rows.set("mediaMasterCleanup/zzz-invalid", copy);
    f.state.beforeDelete = () => { advance(f, consumer.RUN_BUDGET_MS); };
    const report = await f.run();
    expect(entryStatus(report)).toEqual(["deleted"]);
    expect(report.claims).toEqual([]);
    expect(f.rows.get(CONTROL).intentCursor).toBe("attempt-1");
    expect(entryStatus(await f.run())).toEqual(["invalid_intent"]);
  });

  it("keeps the bounded delete abort signal on the real adapter boundary", async () => {
    const f = fixture();
    await f.run();
    expect(f.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("preserves retry budget when the producer refreshes an intent after renewal", async () => {
    const f = fixture();
    f.rows.get(QUEUE).attempts = 4;
    f.rows.get(QUEUE).nextAttemptAt = "2026-10-10T14:00:00.000Z";
    f.rows.get(CLAIM).leaseExpiresAt = "2026-10-10T13:00:00.000Z";
    await cleanup.queueUploadMasterCleanup({ firestore: f.firestore, ref: f.firestore.doc(CLAIM),
      attemptId: "attempt-1", leaseExpiresAt: f.rows.get(CLAIM).leaseExpiresAt,
      nowIso: START.toISOString() });
    expect(f.rows.get(QUEUE)).toMatchObject({ attempts: 4,
      nextAttemptAt: "2026-10-10T14:00:00.000Z", leaseExpiresAt: "2026-10-10T13:00:00.000Z",
      eligibleAt: "2026-10-10T13:00:00.000Z" });
  });

  it("never overwrites an existing fence when refreshing producer intent", async () => {
    const f = fixture();
    const intent = structuredClone(f.rows.get(QUEUE));
    f.rows.get(CLAIM).leaseExpiresAt = "2026-10-10T13:00:00.000Z";
    f.rows.set(LOCK, { state: "purging", key: f.master.key, cleanupId: "attempt-1" });
    await expect(cleanup.queueUploadMasterCleanup({ firestore: f.firestore, ref: f.firestore.doc(CLAIM),
      attemptId: "attempt-1", leaseExpiresAt: f.rows.get(CLAIM).leaseExpiresAt,
      nowIso: START.toISOString() })).rejects.toThrow("intent_changed");
    expect(f.rows.get(QUEUE)).toEqual(intent);
  });

  it("fences a delayed failed-PUT receipt before it can erase the reserved key", async () => {
    const f = fixture({ pending: true });
    const failed = { ...f.master, retained: false, reason: "store-failed" };
    delete failed.key;
    f.state.beforeDelete = async () => {
      await expect(media.recordMasterResult({ firestore: f.firestore, refs: [f.firestore.doc(CLAIM)],
        attemptId: "attempt-1", leaseExpiresAt: EXPIRED, master: failed })).rejects.toThrow("being purged");
      expect(f.rows.get(CLAIM).recordSeed.master.key).toBe(f.master.key);
    };
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
    expect(f.rows.has(LOCK)).toBe(false);
  });

  it("preserves the last successful heartbeat across acquisition and a failed report", async () => {
    const f = fixture();
    await f.run();
    const previous = structuredClone(f.rows.get(CONTROL));
    f.hooks.beforeCommit = (writes) => {
      if (writes.some((write) => write.ref.path.startsWith(`${CONTROL}/runs/`))) {
        throw new Error("Crash before report");
      }
    };
    advance(f, 60_000);
    await expect(f.run()).rejects.toThrow("report could not be committed");
    expect(f.rows.get(CONTROL)).toMatchObject({ lastCompletedAt: previous.lastCompletedAt,
      lastRunId: previous.lastRunId, lastStatus: previous.lastStatus });
    expect(f.rows.get(CONTROL).runId).toBeDefined();
  });

  it("refuses to send a delete when paused past its execution deadline", async () => {
    const f = fixture();
    f.hooks.beforeCommit = (writes) => {
      if (writes.some((write) => write.ref.path === LOCK && write.kind === "set")) {
        f.hooks.beforeCommit = null;
        advance(f, cleanup.DELETE_LEASE_MS + 1);
      }
    };
    expect(entryStatus(await f.run())).toEqual(["retry"]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.has(LOCK)).toBe(true);
    expect(entryStatus(await f.run())).toEqual(["deleted"]);
  });

  it("uses a fresh fence timestamp after slow storage-client construction", async () => {
    const f = fixture();
    f.state.beforeDelete = () => {
      expect(Date.parse(f.rows.get(LOCK).deleteLeaseExpiresAt)).toBe(f.state.now.getTime() + cleanup.DELETE_LEASE_MS);
    };
    expect(entryStatus(await f.run({ masterStorageFactory: () => {
      advance(f, 60_000);
      return f.factory();
    } }))).toEqual(["deleted"]);
  });

  it("rechecks the fence token before sending DeleteObject", async () => {
    const f = fixture();
    f.hooks.beforeCommit = (writes) => {
      const write = writes.find((write) => write.ref.path === LOCK && write.kind === "set");
      if (write) {
        write.value.deleteToken = "different-executor";
        f.hooks.beforeCommit = null;
      }
    };
    expect(entryStatus(await f.run())).toEqual(["delete_ownership_changed"]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.get(QUEUE).manualReview).toBe(true);
  });

  it("rejects an elapsed absolute deadline at the R2 adapter itself", async () => {
    const send = vi.fn();
    const storage = new masters.R2MediaMasterStorage({ bucket: "fake-private", client: { send },
      clockMs: () => START.getTime() });
    await expect(storage.delete("exact-key", { deadlineMs: START.getTime() - 1 }))
      .rejects.toMatchObject({ code: "delete_deadline_elapsed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("persists bounded report dispositions and alert count", async () => {
    const f = fixture();
    f.rows.get(QUEUE).key = "invalid-key";
    const report = await f.run();
    expect(f.rows.get(`${CONTROL}/runs/${report.runId}`)).toEqual(report);
    expect(report.entries).toEqual([{ id: "attempt-1", status: "invalid_intent", alert: true }]);
    expect(f.rows.get(CONTROL).alerts).toBe(1);
  });

  it.each(["legacy-live", "bad-lease", "committed-mismatch", "abandoned"])("reports %s safely", async (kind) => {
    const f = fixture();
    if (kind === "legacy-live") {
      f.rows.get(QUEUE).queuedAt = START.toISOString();
      f.rows.set(LOCK, { state: "purging", key: f.master.key, cleanupId: "attempt-1" });
    }
    if (kind === "bad-lease") f.rows.set(LOCK, { state: "purging", key: f.master.key,
      cleanupId: "attempt-1", deleteToken: "bad-lease", deleteLeaseExpiresAt: "bad" });
    if (kind === "committed-mismatch") Object.assign(f.rows.get(CLAIM), {
      state: "committed", objectReadyAt: OLD, committedAt: OLD });
    if (kind === "abandoned") f.rows.get(CLAIM).state = "abandoned";
    expect(entryStatus(await f.run())).toEqual([{ "legacy-live": "delete_busy", "bad-lease": "invalid_delete_lease",
      "committed-mismatch": "committed_asset_mismatch", abandoned: "invalid_claim" }[kind]]);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rows.has(QUEUE)).toBe(true);
  });

  it.each([false, true])("records retained replacement masters on both exact leases (resumed=%s)", async (resumed) => {
    const f = fixture({ queued: false });
    const publicOrigin = "https://media.example.test";
    const stored = media.uploadRecordFromClaim({ contentHash: "b".repeat(64), claim: f.claim,
      publicOrigin, nowIso: OLD });
    Object.assign(f.rows.get(CLAIM), { state: "committed", objectReadyAt: OLD, committedAt: OLD });
    f.rows.set("media_assets/asset-1", stored);
    f.rows.set("media_assets_public/asset-1", r2.mediaProjection(stored));
    const master = { ...f.master, contentHash: "d".repeat(64), retained: false, reason: "pending" };
    master.key = masters.masterObjectKey(master);
    const args = { firestore: f.firestore, assetId: "asset-1", baseVersion: 1,
      upload: { buffer: Buffer.from("replacement"), mimeType: "image/webp", originalName: "new.webp", source: null },
      contentHash: "c".repeat(64), dimensions: { width: 40, height: 20 }, master, sourceMaster: master,
      actor: { uid: "editor", email: null, principal: { id: "editor", grants: [{ role: "editor" }] } },
      attemptId: "replacement-attempt", publicOrigin };
    let reserved = await replacement.reserveReplacement({ ...args, nowDate: f.state.now });
    if (resumed) {
      advance(f, 16 * 60_000);
      reserved = await replacement.reserveReplacement({ ...args, nowDate: f.state.now });
      expect(reserved.resumed).toBe(true);
    }
    const refs = [f.firestore.doc("system/media/replacements/asset-1"),
      f.firestore.doc(`system/media/hashOwners/${"c".repeat(64)}`)];
    expect(refs.map((ref) => f.rows.get(ref.path).leaseExpiresAt))
      .toEqual([reserved.claim.leaseExpiresAt, reserved.claim.leaseExpiresAt]);
    const retained = { ...master, retained: true };
    delete retained.reason;
    await media.recordMasterResult({ firestore: f.firestore, refs,
      attemptId: reserved.claim.attemptId, leaseExpiresAt: reserved.claim.leaseExpiresAt, master: retained });
    for (const ref of refs) expect(f.rows.get(ref.path).recordSeed.master).toEqual(retained);
  });

});

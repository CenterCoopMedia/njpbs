import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { backfillMediaBin } from "../../scripts/backfill-media-bin.mjs";

const PROJECT = "demo-njpbs";
const deployDate = "2026-09-25T12:00:00.000Z";
const nowIso = "2026-09-26T12:00:00.000Z";
const purgeAfter = "2026-10-25T12:00:00.000Z";
let db;

function image(overrides = {}) {
  return {
    kind: "image",
    source: "upload",
    lifecycle: "tombstoned",
    tombstonedAt: "2025-01-01T12:00:00.000Z",
    storageKey: "cms-media/news/one/hash.webp",
    thumbnails: [{ storageKey: "cms-media/news/one/thumbs/hash-w320.webp" }],
    master: { key: "masters/ab/original.png", retained: true },
    version: 4,
    ...overrides,
  };
}

function run(overrides = {}) {
  return backfillMediaBin({ firestore: db, deployDate, nowIso, ...overrides });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-bin-backfill.test.js");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("media bin backfill", () => {
  it("defaults to a dry run with no asset, queue, or audit writes", async () => {
    const stored = image();
    await db.collection("media_assets").doc("one").set(stored);
    expect(await run()).toEqual({
      dryRun: true, purgeAfter, scanned: 1, eligible: 1, migrated: 0, skipped: 0, invalidAssetIds: [],
    });
    expect((await db.collection("media_assets").doc("one").get()).data()).toEqual(stored);
    expect((await db.collection("mediaPurgeQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("applies deployment plus 30 days and snapshots exact object keys once", async () => {
    const stored = image();
    await db.collection("media_assets").doc("one").set(stored);
    expect(await run({ apply: true })).toMatchObject({ migrated: 1, eligible: 1 });
    expect((await db.collection("media_assets").doc("one").get()).data())
      .toEqual({ ...stored, purgeAfter });
    const queued = (await db.collection("mediaPurgeQueue").doc("asset:one").get()).data();
    expect(queued).toMatchObject({
      assetId: "one", kind: "image", state: "pending", queuedAt: nowIso,
      eligibleAt: purgeAfter, masterKey: stored.master.key,
      objects: [
        { store: "public", key: stored.storageKey },
        { store: "public", key: stored.thumbnails[0].storageKey },
        { store: "masters", key: stored.master.key },
      ],
    });
    const logs = await db.collection("admin_logs").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data()).toMatchObject({
      actorUid: "system:media-bin-backfill", action: "media.bin.backfill",
      target: "media_assets/one", before: { lifecycle: "tombstoned", purgeAfter: null },
      after: { lifecycle: "tombstoned", purgeAfter, queueId: "asset:one" }, at: nowIso,
    });
    expect(logs.docs[0].data().timestamp).toBeTruthy();
    expect(await run({ apply: true, deployDate: "2026-10-01T00:00:00.000Z" }))
      .toMatchObject({ migrated: 0, skipped: 1 });
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await db.collection("mediaPurgeQueue").doc("asset:one").get()).data()).toEqual(queued);
  });

  it("skips videos, documents, non-upload images, active assets, and existing deadlines", async () => {
    const records = [
      image({ kind: "video" }), image({ kind: "document" }),
      image({ source: "page-seed" }), image({ lifecycle: "active" }),
      image({ purgeAfter: "2026-12-01T00:00:00.000Z" }),
    ];
    await Promise.all(records.map((stored, index) =>
      db.collection("media_assets").doc(String(index)).set(stored)));
    expect(await run({ apply: true })).toMatchObject({ scanned: 4, migrated: 0 });
    expect((await db.collection("mediaPurgeQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it.each(["pending", "purging", "purged", "cancelled", "blocked"])(
    "does not overwrite an existing %s queue entry", async (state) => {
      await db.collection("media_assets").doc("one").set(image());
      const queue = { state, eligibleAt: "2026-10-01T00:00:00.000Z" };
      await db.collection("mediaPurgeQueue").doc("asset:one").set(queue);
      expect(await run({ apply: true })).toMatchObject({ migrated: 0, skipped: 1 });
      expect((await db.collection("media_assets").doc("one").get()).data().purgeAfter).toBeUndefined();
      expect((await db.collection("mediaPurgeQueue").doc("asset:one").get()).data()).toEqual(queue);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    },
  );

  it("re-reads lifecycle after selection and does not backfill a restored image", async () => {
    const ref = db.collection("media_assets").doc("one");
    await ref.set(image());
    const original = db.runTransaction.bind(db);
    vi.spyOn(db, "runTransaction").mockImplementationOnce(async (callback) => {
      await ref.update({ lifecycle: "active" });
      return original(callback);
    });
    expect(await run({ apply: true })).toMatchObject({ migrated: 0, skipped: 1 });
    expect((await ref.get()).data()).toMatchObject({ lifecycle: "active" });
    expect((await ref.get()).data().purgeAfter).toBeUndefined();
    expect((await db.collection("mediaPurgeQueue").get()).empty).toBe(true);
  });

  it("requires an explicit deployment timestamp with timezone", async () => {
    for (const value of [undefined, "garbage", "2026-09-25", "2026-09-25T12:00:00"]) {
      await expect(run({ deployDate: value })).rejects.toThrow("--deploy-date");
    }
  });

  it.each([false, true])("reports invalid image keys and continues (apply: %s)", async (apply) => {
    await db.collection("media_assets").doc("a-invalid").set(image({ storageKey: "" }));
    await db.collection("media_assets").doc("b-invalid").set(image({ thumbnails: [{}] }));
    await db.collection("media_assets").doc("c-valid").set(image());
    expect(await run({ apply })).toEqual({
      dryRun: !apply, purgeAfter, scanned: 3, eligible: 1, migrated: apply ? 1 : 0,
      skipped: 0, invalidAssetIds: ["a-invalid", "b-invalid"],
    });
    for (const id of ["a-invalid", "b-invalid"]) {
      expect((await db.collection("media_assets").doc(id).get()).data().purgeAfter).toBeUndefined();
      expect((await db.collection("mediaPurgeQueue").doc(`asset:${id}`).get()).exists).toBe(false);
    }
    expect((await db.collection("admin_logs").get()).size).toBe(apply ? 1 : 0);
  });

  it("refuses a live project before reading it", async () => {
    const firestore = { projectId: "njpbs-site", collection: vi.fn() };
    await expect(run({ firestore })).rejects.toThrow("demo-");
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("refuses execution without a local emulator", async () => {
    const previous = process.env.FIRESTORE_EMULATOR_HOST;
    try {
      for (const value of ["", "remote.example:8080"]) {
        process.env.FIRESTORE_EMULATOR_HOST = value;
        await expect(run()).rejects.toThrow("local FIRESTORE_EMULATOR_HOST");
      }
    } finally {
      process.env.FIRESTORE_EMULATOR_HOST = previous;
    }
  });
});

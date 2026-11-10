import { createHash } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import sharp from "sharp";
import { memoryMediaStore } from "../helpers/memory-media-store.js";
import mediaContract from "../../functions/lib/media-contract.js";
import { backfillMediaThumbnails, uploadedMediaReleaseReady } from "../../scripts/backfill-media-thumbnails.mjs";

let db;

beforeEach(() => { db = memoryMediaStore(); });

async function seedImage(id, buffer, extra = {}) {
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const storageKey = mediaContract.finalObjectKey({
    category: "news", assetId: id, contentHash, mimeType: "image/png",
  });
  const ref = db.collection("media_assets").doc(id);
  await ref.set({
    category: "news", kind: "image", mimeType: "image/png", lifecycle: "active",
    width: 1, height: 1, contentHash, storageKey, ...extra,
  });
  return ref;
}

it("reports and skips corrupt pixels while backfilling the next valid image", async () => {
  const bad = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2lWAAAAAElFTkSuQmCC", "base64",
  );
  const good = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const badRef = await seedImage("bad", bad);
  const goodRef = await seedImage("good", good);
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: {
      get: async (key) => key.includes("/bad/") ? bad : good,
      putFinal: async () => ({ created: true }),
    },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ unavailable: 1, updated: 1, failed: 0 });
  expect((await badRef.get()).data().thumbnailStatus).toBe("unavailable");
  expect((await goodRef.get()).data().thumbnails).toHaveLength(1);
  const verified = await backfillMediaThumbnails(options);
  expect(verified.eligible).toBe(0);
  expect(uploadedMediaReleaseReady(applied, verified)).toBe(true);
});

it("fills a missing wide size once while retaining the current asset metadata", async () => {
  const buffer = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "blue" } }).png().toBuffer();
  const ref = await seedImage("wide", buffer, { width: 2000, height: 1000, animated: false,
    thumbnailStatus: "ready", altText: "Current description",
    thumbnails: [{ width: 480, height: 240 }, { width: 960, height: 480 }] });
  const writes = [];
  const options = { firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: { get: async () => buffer, putFinal: async (value) => { writes.push(value); return { created: true }; } } };
  expect((await backfillMediaThumbnails(options)).eligible).toBe(1);
  expect(await backfillMediaThumbnails({ ...options, apply: true })).toMatchObject({ updated: 1, failed: 0 });
  expect((await ref.get()).data()).toMatchObject({ altText: "Current description", animated: false,
    thumbnails: [{ width: 480, height: 240 }, { width: 960, height: 480 }, { width: 1600, height: 800 }] });
  expect(writes.map(value => value.metadata.width)).toEqual(["480", "960", "1600"]);
  expect((await backfillMediaThumbnails({ ...options, apply: true })).eligible).toBe(0);
  expect(writes).toHaveLength(3);
});

it.each(["read", "write", "transaction"])("keeps a %s infrastructure failure blocking", async (failure) => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const ref = await seedImage("asset", buffer);
  const unavailable = () => { throw new Error("Service unavailable"); };
  if (failure === "transaction") db.runTransaction = unavailable;
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: {
      get: failure === "read" ? unavailable : async () => buffer,
      putFinal: failure === "write" ? unavailable : async () => ({ created: true }),
    },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ failed: 1, unavailable: 0 });
  expect((await ref.get()).data()).not.toHaveProperty("thumbnailStatus");
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(false);
});

it("keeps missing originals and query failures blocking as possible configuration errors", async () => {
  const ref = await seedImage("missing", Buffer.from("missing original"));
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: { get: async () => { throw Object.assign(new Error("Missing"), { name: "NoSuchKey" }); } },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ unavailable: 0, failed: 1 });
  expect((await ref.get()).data()).not.toHaveProperty("thumbnailStatus");
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(false);
  db.collection = () => { throw new Error("Permission denied"); };
  await expect(backfillMediaThumbnails(options)).rejects.toThrow("Permission denied");
});

it("does not mark a concurrently replaced source unavailable", async () => {
  const ref = await seedImage("replaced", Buffer.from("bad original"));
  const result = await backfillMediaThumbnails({
    firestore: db, publicOrigin: "https://media.njpbs.org", apply: true,
    storage: { get: async () => {
      await ref.update({ contentHash: "a".repeat(64) });
      return Buffer.from("bad original");
    } },
  });
  expect(result).toMatchObject({ skipped: 1, unavailable: 0, failed: 0 });
  expect((await ref.get()).data()).not.toHaveProperty("thumbnailStatus");
});

it("keeps animation classification when an original exceeds the thumbnail pixel budget", async () => {
  const buffer = await sharp({ create: { width: 5_000, height: 5_001, channels: 3, background: "blue" } }).png().toBuffer();
  const ref = await seedImage("large", buffer, { width: 5_000, height: 5_001 });
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: { get: async () => buffer },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ unavailable: 1, failed: 0 });
  expect((await ref.get()).data()).toMatchObject({ animated: false, thumbnailStatus: "unavailable" });
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(true);
});

it.each([
  { code: "ECONNRESET" },
  { name: "TimeoutError" },
  { $metadata: { httpStatusCode: 503 } },
  { $metadata: { httpStatusCode: 429 } },
])("defers a transient source read and retries it on the next run: %j", async (details) => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const ref = await seedImage("retry", buffer, { thumbnailStatus: "retryable" });
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: {
      get: async () => { throw Object.assign(new Error("Temporary failure"), details); },
      putFinal: async () => ({ created: true }),
    },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ retryable: 1, failed: 0, retryableIds: ["retry"] });
  expect((await ref.get()).data().thumbnailStatus).toBe("retryable");
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(true);
  options.storage.get = async () => buffer;
  expect(await backfillMediaThumbnails({ ...options, apply: true })).toMatchObject({ updated: 1, failed: 0 });
  expect((await ref.get()).data()).toMatchObject({ thumbnailStatus: "ready", animated: false });
});

it("defers a transient database write without requiring another successful write", async () => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const ref = await seedImage("retry", buffer);
  db.runTransaction = async () => { throw Object.assign(new Error("Unavailable"), { code: 14 }); };
  const options = {
    firestore: db, publicOrigin: "https://media.njpbs.org",
    storage: { get: async () => buffer, putFinal: async () => ({ created: true }) },
  };
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ retryable: 1, failed: 0 });
  expect((await ref.get()).data()).not.toHaveProperty("thumbnailStatus");
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(true);
  await seedImage("new-unprocessed", buffer);
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(false);
});

it.each([
  [1, 1, true],
  [2, 2, true],
  [3, 3, false],
  [3, 2, true],
])("release with %i candidates and %i transient deferrals is %s", (candidates, deferred, ready) => {
  const ids = Array.from({ length: deferred }, (_, index) => `asset-${index}`);
  expect(uploadedMediaReleaseReady({
    eligible: candidates, retryable: deferred, retryableIds: ids, failed: 0,
  }, { eligible: deferred, eligibleIds: ids, failed: 0 })).toBe(ready);
});

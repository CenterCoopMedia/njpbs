import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import sharp from "sharp";
import admin from "../helpers/firebase-admin.js";
import mediaContract from "../../functions/lib/media-contract.js";
import {
  backfillMediaThumbnails,
  uploadedMediaReleaseReady,
} from "../../scripts/backfill-media-thumbnails.mjs";

const PROJECT = "demo-njpbs";
let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-thumbnails-backfill.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

it("backfills once and marks an asset whose original hash is wrong", async () => {
  const buffer = await sharp({
    create: { width: 600, height: 300, channels: 3, background: "blue" },
  }).png().toBuffer();
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const storageKey = mediaContract.finalObjectKey({
    category: "news", assetId: "asset-one", contentHash, mimeType: "image/png",
  });
  const ref = db.collection("media_assets").doc("asset-one");
  await ref.set({
    category: "news", kind: "image", mimeType: "image/png",
    lifecycle: "active", width: 600, height: 300, contentHash, storageKey,
  });
  const objects = new Map([[storageKey, buffer]]);
  const storage = {
    get: async (key) => objects.get(key),
    putFinal: async ({ key, body }) => {
      if (objects.has(key)) return { created: false };
      objects.set(key, body);
      return { created: true };
    },
    deleteFinal: async (key) => { objects.delete(key); },
  };
  const options = { firestore: db, storage, publicOrigin: "https://media.njpbs.org" };
  expect((await backfillMediaThumbnails(options)).eligible).toBe(1);
  expect((await backfillMediaThumbnails({ ...options, apply: true })).updated).toBe(1);
  expect((await ref.get()).data().thumbnails).toMatchObject([{
    width: 480, height: 240,
  }]);
  expect((await ref.get()).data().animated).toBe(false);
  expect((await backfillMediaThumbnails({ ...options, apply: true })).eligible).toBe(0);

  await ref.update({ thumbnails: [] });
  objects.set(storageKey, Buffer.from("wrong original"));
  const applied = await backfillMediaThumbnails({ ...options, apply: true });
  expect(applied).toMatchObject({ unavailable: 1, failed: 0 });
  expect((await ref.get()).data().thumbnailStatus).toBe("unavailable");
  expect(uploadedMediaReleaseReady(applied, await backfillMediaThumbnails(options))).toBe(true);
  expect((await ref.get()).data().thumbnails).toEqual([]);
});

it("accepts a release only when classification has no failures and nothing remains", () => {
  expect(uploadedMediaReleaseReady({ failed: 0 }, { eligible: 0, failed: 0 })).toBe(true);
  expect(uploadedMediaReleaseReady({ failed: 1 }, { eligible: 0, failed: 0 })).toBe(false);
  expect(uploadedMediaReleaseReady({ failed: 0 }, { eligible: 1, failed: 0 })).toBe(false);
});

it("records animation for a multi-frame image that already has thumbnails", async () => {
  const frame = (background) => sharp({
    create: { width: 2, height: 2, channels: 3, background },
  }).raw().toBuffer();
  const buffer = await sharp(Buffer.concat([
    await frame({ r: 200, g: 0, b: 0 }),
    await frame({ r: 0, g: 0, b: 200 }),
  ]), {
    raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
    animated: true,
    pages: 2,
  }).webp().toBuffer();
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const storageKey = mediaContract.finalObjectKey({
    category: "news", assetId: "asset-motion", contentHash, mimeType: "image/webp",
  });
  const thumbnails = [{
    url: "https://media.njpbs.org/cms-media/news/asset-motion/thumbs/existing.webp",
    width: 2,
    height: 2,
  }];
  const ref = db.collection("media_assets").doc("asset-motion");
  await ref.set({
    category: "news", kind: "image", mimeType: "image/webp",
    lifecycle: "active", width: 2, height: 2, contentHash, storageKey, thumbnails,
  });
  const storage = {
    get: async () => buffer,
    putFinal: async () => { throw new Error("existing thumbnails must stay"); },
    deleteFinal: async () => { throw new Error("existing thumbnails must stay"); },
  };
  const result = await backfillMediaThumbnails({
    firestore: db, storage, publicOrigin: "https://media.njpbs.org", apply: true,
  });
  expect(result.updated).toBe(1);
  expect((await ref.get()).data()).toMatchObject({ animated: true, thumbnails });
  expect((await backfillMediaThumbnails({
    firestore: db, storage, publicOrigin: "https://media.njpbs.org",
  })).eligible).toBe(0);
});

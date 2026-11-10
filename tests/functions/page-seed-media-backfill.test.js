import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { deleteApp } from "firebase-admin/app";
import mediaUsagePkg from "../../functions/lib/media-usage.js";
import {
  PAGE_SEED_MEDIA,
  backfillPageSeedMedia,
  imageDimensions,
} from "../../scripts/backfill-page-seed-media.mjs";
import { readFileSync } from "node:fs";

describe("page seed image dimensions", () => {
  it("reads every seed file at its manifest size", () => {
    for (const seed of PAGE_SEED_MEDIA) {
      expect(
        imageDimensions(readFileSync(new URL(`../../site/public/${seed.path}`, import.meta.url))),
      ).toEqual({ width: seed.width, height: seed.height });
    }
  });

  it("reports a JPEG frame size that differs from the manifest", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 });
  });
});

const admin = adminPkg;
const { prepareMediaUsageWrite } = mediaUsagePkg;
const PROJECT = "demo-njpbs-page-seed-media";
const NOW = "2026-08-14T02:00:00.000Z";

let db;
let app;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
}

beforeAll(() => {
  app = admin.initializeApp({ projectId: PROJECT }, "page-seed-media-tests");
  db = admin.firestore(app);
});

beforeEach(clearFirestore);

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("page seed media backfill", () => {
  it("creates the complete private and public records in one idempotent migration", async () => {
    expect(PAGE_SEED_MEDIA).toHaveLength(12);

    await expect(
      backfillPageSeedMedia({ firestore: db, nowIso: NOW }),
    ).resolves.toEqual({ created: 12, verified: 0 });

    const privateAsset = (
      await db.collection("media_assets").doc("launch-watch").get()
    ).data();
    expect(privateAsset).toMatchObject({
      id: "launch-watch",
      originalName: "watch.jpg",
      category: "site-seed",
      kind: "image",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
      lifecycle: "active",
      source: "site_seed",
      storageKey: null,
      animated: false,
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(privateAsset.sizeBytes).toBeGreaterThan(0);
    expect(privateAsset.contentHash).toMatch(/^[a-f0-9]{64}$/);

    expect(
      (
        await db.collection("media_assets_public").doc("launch-watch").get()
      ).data(),
    ).toEqual({
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      altText: null,
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });
    expect((await db.collection("media_assets").get()).size).toBe(12);
    expect((await db.collection("media_assets_public").get()).size).toBe(12);
    expect((await db.collection("admin_logs").get()).size).toBe(12);

    await expect(
      db.runTransaction((transaction) =>
        prepareMediaUsageWrite({
          firestore: db,
          transaction,
          collection: "cmsPages",
          documentId: "watch",
          state: "working",
          sourceVersion: 1,
          usage: { assetIds: ["launch-watch"], occurrenceCount: 1 },
        }),
      ),
    ).resolves.toMatchObject({
      document: {
        state: "working",
        sourceVersion: 1,
        assetIds: ["launch-watch"],
        occurrenceCount: 1,
      },
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T03:00:00.000Z",
      }),
    ).resolves.toEqual({ created: 0, verified: 12 });
    expect((await db.collection("admin_logs").get()).size).toBe(12);
    expect(
      (await db.collection("media_assets").doc("launch-watch").get()).data(),
    ).toEqual(privateAsset);
  });

  it("fails without partial writes when an existing projection does not match", async () => {
    await db.collection("media_assets_public").doc("launch-watch").set({
      url: "https://example.com/wrong.jpg",
      altText: null,
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });

    await expect(
      backfillPageSeedMedia({ firestore: db, nowIso: NOW }),
    ).rejects.toThrow(/launch-watch.*does not match/i);

    expect((await db.collection("media_assets").get()).size).toBe(0);
    expect((await db.collection("media_assets_public").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
  });

  it("normalizes an exact legacy empty-alt projection while creating its private record", async () => {
    await db.collection("media_assets_public").doc("launch-watch").set({
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      altText: "",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });

    await expect(
      backfillPageSeedMedia({ firestore: db, nowIso: NOW }),
    ).resolves.toEqual({ created: 12, verified: 0 });

    expect(
      (
        await db.collection("media_assets_public").doc("launch-watch").get()
      ).data(),
    ).toEqual({
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      altText: null,
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });
    expect(
      (await db.collection("media_assets").doc("launch-watch").get()).exists,
    ).toBe(true);
    expect((await db.collection("admin_logs").get()).size).toBe(12);
  });

  it("rejects a legacy empty-alt projection when another field does not match", async () => {
    await db.collection("media_assets_public").doc("launch-watch").set({
      url: "https://example.com/wrong.jpg",
      altText: "",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });

    await expect(
      backfillPageSeedMedia({ firestore: db, nowIso: NOW }),
    ).rejects.toThrow(/launch-watch.*does not match/i);

    expect((await db.collection("media_assets").get()).size).toBe(0);
    expect((await db.collection("media_assets_public").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
  });

  it("rejects an existing public record with fields outside the public projection", async () => {
    const seed = PAGE_SEED_MEDIA.find((entry) => entry.id === "launch-watch");
    await db
      .collection("media_assets_public")
      .doc(seed.id)
      .set({
        url: `https://njpbs.org/${seed.path}`,
        altText: null,
        mimeType: seed.mimeType,
        width: seed.width,
        height: seed.height,
        privateNote: "must not be public",
      });

    await expect(
      backfillPageSeedMedia({ firestore: db, nowIso: NOW }),
    ).rejects.toThrow(/launch-watch.*does not match/i);

    expect((await db.collection("media_assets").get()).size).toBe(0);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
  });

  it("records a still flag on an existing page seed that lacks one", async () => {
    await backfillPageSeedMedia({ firestore: db, nowIso: NOW });
    await db.collection("media_assets").doc("home-start-live").update({
      animated: admin.firestore.FieldValue.delete(),
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T04:00:00.000Z",
      }),
    ).resolves.toEqual({ created: 0, verified: 12 });

    expect(
      (await db.collection("media_assets").doc("home-start-live").get()).data(),
    ).toMatchObject({
      animated: false,
      version: 1,
      storageKey: null,
      updatedAt: "2026-08-14T04:00:00.000Z",
      updatedBy: "system:page-seed-backfill",
    });
    expect(
      (await db.collection("media_assets").doc("launch-watch").get()).data().updatedAt,
    ).toBe(NOW);
  });

  it("refreshes stale sizeBytes and contentHash when a repo image changed in place", async () => {
    await backfillPageSeedMedia({ firestore: db, nowIso: NOW });
    const before = (
      await db.collection("media_assets").doc("launch-watch").get()
    ).data();

    await db.collection("media_assets").doc("launch-watch").update({
      sizeBytes: before.sizeBytes + 1,
      contentHash: "0".repeat(64),
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T05:00:00.000Z",
      }),
    ).resolves.toEqual({ created: 0, verified: 12 });

    const after = (
      await db.collection("media_assets").doc("launch-watch").get()
    ).data();
    expect(after).toMatchObject({
      sizeBytes: before.sizeBytes,
      contentHash: before.contentHash,
      version: before.version + 1,
      updatedAt: "2026-08-14T05:00:00.000Z",
      updatedBy: "system:page-seed-backfill",
      createdAt: before.createdAt,
      url: before.url,
      storageKey: null,
    });

    expect(
      (
        await db.collection("media_assets_public").doc("launch-watch").get()
      ).data(),
    ).toEqual({
      url: before.url,
      altText: null,
      mimeType: before.mimeType,
      width: before.width,
      height: before.height,
    });

    const refreshLogs = (await db.collection("admin_logs").get()).docs
      .map((doc) => doc.data())
      .filter((log) => log.action === "media.seed_refresh");
    expect(refreshLogs).toHaveLength(1);
    expect(refreshLogs[0]).toMatchObject({
      target: "media_assets/launch-watch",
      before: { contentHash: "0".repeat(64), sizeBytes: before.sizeBytes + 1 },
      after: { contentHash: before.contentHash, sizeBytes: before.sizeBytes },
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T06:00:00.000Z",
      }),
    ).resolves.toEqual({ created: 0, verified: 12 });
    expect(
      (await db.collection("media_assets").doc("launch-watch").get()).data(),
    ).toEqual(after);
    expect((await db.collection("admin_logs").get()).size).toBe(13);
  });

  it("still rejects a hash mismatch alongside a changed url", async () => {
    await backfillPageSeedMedia({ firestore: db, nowIso: NOW });
    await db.collection("media_assets").doc("launch-watch").update({
      contentHash: "0".repeat(64),
      url: "https://njpbs.org/brand/spotlight/watch-old.jpg",
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T05:00:00.000Z",
      }),
    ).rejects.toThrow(/launch-watch.*does not match/i);
  });

  it("still rejects a hash mismatch alongside a non-null storageKey", async () => {
    await backfillPageSeedMedia({ firestore: db, nowIso: NOW });
    await db.collection("media_assets").doc("launch-watch").update({
      contentHash: "0".repeat(64),
      storageKey: "cms-media/site-seed/launch-watch/deadbeef.jpg",
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T05:00:00.000Z",
      }),
    ).rejects.toThrow(/launch-watch.*does not match/i);
  });

  it("does not refresh over a public projection that no longer matches", async () => {
    await backfillPageSeedMedia({ firestore: db, nowIso: NOW });
    await db.collection("media_assets").doc("launch-watch").update({
      contentHash: "0".repeat(64),
    });
    await db.collection("media_assets_public").doc("launch-watch").update({
      url: "https://njpbs.org/brand/spotlight/elsewhere.jpg",
    });

    await expect(
      backfillPageSeedMedia({
        firestore: db,
        nowIso: "2026-08-14T05:00:00.000Z",
      }),
    ).rejects.toThrow(/launch-watch does not match its private record/i);
    expect(
      (await db.collection("media_assets").doc("launch-watch").get()).data().contentHash,
    ).toBe("0".repeat(64));
  });
});

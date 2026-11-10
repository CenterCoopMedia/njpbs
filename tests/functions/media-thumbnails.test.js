import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { memoryMediaStore } from "../helpers/memory-media-store.js";
import thumbnails from "../../functions/lib/media-thumbnails.js";

const { addMediaThumbnails, createMediaThumbnails, thumbnailWidths } = thumbnails;

describe("media thumbnails", () => {
  it("uses the three target widths only below the source width", () => {
    expect(thumbnailWidths(320)).toEqual([320]);
    expect(thumbnailWidths(480)).toEqual([480]);
    expect(thumbnailWidths(700)).toEqual([480]);
    expect(thumbnailWidths(960)).toEqual([480, 960]);
    expect(thumbnailWidths(1200)).toEqual([480, 960]);
    expect(thumbnailWidths(1600)).toEqual([480, 960, 1600]);
    expect(thumbnailWidths(6000)).toEqual([480, 960, 1600]);
  });

  it("rotates before resizing and stores WebP renditions without enlargement", async () => {
    const buffer = await sharp({
      create: { width: 300, height: 600, channels: 3, background: "red" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const writes = [];
    const result = await createMediaThumbnails({
      buffer,
      width: 600,
      category: "news",
      assetId: "asset-one",
      contentHash: "a".repeat(64),
      publicOrigin: "https://media.njpbs.org",
      storage: {
        async putFinal(value) { writes.push(value); return { created: true }; },
      },
    });
    expect(result).toMatchObject([{ width: 480, height: 240 }]);
    expect(result[0].storageKey).toContain("/thumbs/");
    expect(writes[0].mimeType).toBe("image/webp");
    expect((await sharp(writes[0].body).metadata()).format).toBe("webp");
  });

  it("creates all thumbnails at the 25-megapixel web-copy limit", async () => {
    const buffer = await sharp({
      create: { width: 5_000, height: 5_000, channels: 3, background: "blue" },
    }).png().toBuffer();
    const putFinal = vi.fn(async () => ({ created: true }));
    const result = await createMediaThumbnails({
      buffer,
      width: 5_000,
      category: "news",
      assetId: "asset-at-limit",
      contentHash: "c".repeat(64),
      publicOrigin: "https://media.njpbs.org",
      storage: { putFinal },
    });
    expect(result).toMatchObject([
      { width: 480, height: 480 },
      { width: 960, height: 960 },
      { width: 1600, height: 1600 },
    ]);
    expect(putFinal).toHaveBeenCalledTimes(3);
  });

  it("marks thumbnails unavailable above 25 megapixels and preserves the committed upload", async () => {
    const buffer = await sharp({
      create: { width: 5_000, height: 5_001, channels: 3, background: "blue" },
    }).png().toBuffer();
    const record = {
      id: "asset-over-limit",
      kind: "image",
      width: 5_000,
      height: 5_001,
      category: "news",
      contentHash: "d".repeat(64),
      storageKey: "cms-media/news/asset-over-limit/original.png",
      lifecycle: "active",
      thumbnailStatus: "retryable",
    };
    const putFinal = vi.fn(async () => ({ created: true }));
    const storage = { putFinal };
    await expect(createMediaThumbnails({
      buffer,
      width: record.width,
      category: record.category,
      assetId: record.id,
      contentHash: record.contentHash,
      publicOrigin: "https://media.njpbs.org",
      storage,
    })).rejects.toThrow("The image cannot be rendered as a thumbnail");

    const firestore = memoryMediaStore();
    const ref = firestore.collection("media_assets").doc(record.id);
    await ref.set(record);
    const warn = vi.fn();
    const result = await addMediaThumbnails({
      firestore,
      storage,
      record,
      buffer,
      publicOrigin: "https://media.njpbs.org",
      log: { warn },
    });
    expect(result).toMatchObject({ ...record, thumbnailStatus: "unavailable" });
    expect((await ref.get()).data().thumbnailStatus).toBe("unavailable");
    expect(putFinal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Media thumbnails could not be saved", {
      assetId: "asset-over-limit",
      error: "MediaThumbnailError",
    });
  });

  it("returns the committed document when metadata changed after the upload", async () => {
    const buffer = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "blue" },
    }).png().toBuffer();
    const record = {
      id: "asset-two",
      kind: "image",
      width: 2000,
      category: "news",
      contentHash: "b".repeat(64),
      storageKey: "cms-media/news/asset-two/original.png",
      lifecycle: "active",
      altText: null,
      version: 1,
    };
    const stored = { ...record, altText: "Newer alt text", version: 2,
      thumbnails: [{ width: 480, height: 240 }, { width: 960, height: 480 }] };
    delete stored.id;
    const updates = [];
    const firestore = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async (run) => run({
        get: async () => ({ exists: true, data: () => stored }),
        update: (_ref, value) => updates.push(value),
      }),
    };
    const result = await addMediaThumbnails({
      firestore,
      storage: { async putFinal() { return { created: true }; } },
      record,
      buffer,
      publicOrigin: "https://media.njpbs.org",
      log: { warn() {} },
    });
    expect(updates).toHaveLength(1);
    expect(result).toMatchObject({
      id: "asset-two",
      altText: "Newer alt text",
      version: 2,
      thumbnails: [{ width: 480, height: 240 }, { width: 960, height: 480 }, { width: 1600, height: 800 }],
    });
  });
});

it("preserves the committed retry state through storage and thumbnail persistence failures", async () => {
  const buffer = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
  const record = {
    id: "asset-failed", kind: "image", width: 1, category: "news",
    contentHash: "e".repeat(64), storageKey: "original.png", lifecycle: "active",
    thumbnailStatus: "retryable",
  };
  const firestore = memoryMediaStore();
  const ref = firestore.collection("media_assets").doc(record.id);
  await ref.set(record);
  const options = {
    firestore, record, buffer, publicOrigin: "https://media.njpbs.org", log: { warn() {} },
    storage: { putFinal: async () => { throw new Error("Storage unavailable"); } },
  };
  await expect(addMediaThumbnails(options)).resolves.toMatchObject({ thumbnailStatus: "retryable" });
  options.storage.putFinal = async () => ({ created: true });
  firestore.runTransaction = async () => { throw new Error("Database unavailable"); };
  await expect(addMediaThumbnails(options)).resolves.toMatchObject({ thumbnailStatus: "retryable" });
  expect((await ref.get()).data()).toMatchObject({ lifecycle: "active", thumbnailStatus: "retryable" });
});

import { expect, it } from "vitest";
import sharp from "sharp";
import media from "../../functions/media.js";

// A legacy test PNG whose IHDR is readable but whose compressed pixels are bad.
const MALFORMED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2lWAAAAAElFTkSuQmCC",
  "base64",
);

it("rejects pixels that cannot decode even when the image header is valid", async () => {
  await expect(sharp(MALFORMED_PNG).metadata()).resolves.toMatchObject({ width: 1, height: 1 });
  await expect(media.inspectUpload(MALFORMED_PNG, "image/png")).rejects.toMatchObject({ status: 415 });
});

it.each(["png", "jpeg", "webp", "gif"])("accepts decodable %s pixels", async (format) => {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: "blue" } })
    .toFormat(format).toBuffer();
  await expect(media.inspectUpload(bytes, `image/${format}`)).resolves.toEqual({
    width: 8, height: 6, animated: false,
  });
});

it("decodes all animation frames and preserves frame dimensions", async () => {
  const bytes = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
    raw: { width: 1, height: 2, channels: 3, pageHeight: 1 }, animated: true, pages: 2,
  }).webp({ lossless: true }).toBuffer();
  await expect(media.inspectUpload(bytes, "image/webp")).resolves.toEqual({
    width: 1, height: 1, animated: true,
  });
  // Break only the second frame's compressed payload, leaving container headers
  // intact. First-frame thumbnail decoding must not substitute for full decode.
  const damaged = Buffer.from(bytes);
  const secondFrame = damaged.indexOf("ANMF", damaged.indexOf("ANMF") + 4);
  const payload = damaged.indexOf("VP8L", secondFrame);
  expect(payload).toBeGreaterThan(secondFrame);
  damaged[payload + 14] ^= 0xff;
  await expect(sharp(damaged, { animated: true }).metadata()).resolves.toMatchObject({ pages: 2 });
  await expect(media.inspectUpload(damaged, "image/webp")).rejects.toMatchObject({ status: 415 });
});

it("resets the old binary's thumbnail state before a replacement is committed", async () => {
  const { default: replacement } = await import("../../functions/replace-media.js");
  const record = replacement.replacementRecord({
    name: "Photo", category: "news", categories: ["news"], lifecycle: "active",
    version: 1, thumbnailStatus: "ready", source: "upload", tags: [],
  }, {
    assetId: "photo", mimeType: "image/png", sizeBytes: 100,
    contentHash: "a".repeat(64), finalKey: "original.png", publicUrl: "https://media.njpbs.org/original.png",
    recordSeed: { originalName: "photo.png", dimensions: { width: 1, height: 1 }, animated: false, actor: { uid: "editor" } },
  }, "2026-10-09T12:00:00.000Z");
  expect(record).toHaveProperty("thumbnailStatus", "retryable");
  expect(record).toMatchObject({ version: 2, thumbnails: [], animated: false });
});


it("includes the retry state in the initial image record before its commit", () => {
  const input = {
    contentHash: "b".repeat(64), publicOrigin: "https://media.njpbs.org", nowIso: "2026-10-09T12:00:00.000Z",
    claim: {
      assetId: "photo", mimeType: "image/png", sizeBytes: 100, finalKey: "original.png",
      recordSeed: {
        metadata: { name: "Photo", category: "news", tags: [] }, originalName: "photo.png",
        dimensions: { width: 1, height: 1 }, animated: false, actor: { uid: "editor" },
      },
    },
  };
  expect(media.uploadRecordFromClaim({ ...input, thumbnailAttempt: true }))
    .toMatchObject({ kind: "image", lifecycle: "active", thumbnailStatus: "retryable" });
  // Recovery commits without a synchronous attempt, so backfill must see it.
  expect(media.uploadRecordFromClaim(input)).not.toHaveProperty("thumbnailStatus");
});

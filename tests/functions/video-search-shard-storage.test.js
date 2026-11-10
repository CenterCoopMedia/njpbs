import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import storageModule from "../../functions/lib/video-search-shard-storage.js";
const config = { bucket: "private-renditions", accountId: "123456789012" };
it("writes versioned encrypted private shards within existing transcript permissions", async () => {
  const s3 = { send: vi.fn(async () => ({ VersionId: "stored-v1" })) };
  const store = storageModule.createVideoSearchShardStorage(config, { s3 });
  const content = { schema: 1, chunks: [], asset: { id: "asset" } };
  const descriptor = await store.put(content);
  expect(s3.send.mock.calls[0][0].input).toMatchObject({ Bucket: config.bucket, ExpectedBucketOwner: config.accountId,
    Key: `transcripts/results/search-v1/${descriptor.digest}.json`, ServerSideEncryption: "AES256", CacheControl: "private, no-store" });
  expect(descriptor).toEqual({ digest: createHash("sha256").update(JSON.stringify(content)).digest("hex"), objectVersion: "stored-v1" });
});
it("reads the exact object version and verifies its digest", async () => {
  const body = JSON.stringify({ schema: 1, chunks: [] }); const digest = createHash("sha256").update(body).digest("hex");
  const s3 = { send: vi.fn(async () => ({ Body: Readable.from([body]), ContentLength: body.length })) };
  const store = storageModule.createVideoSearchShardStorage(config, { s3 });
  expect(await store.read({ digest, objectVersion: "v1" })).toEqual({ schema: 1, chunks: [] });
  expect(s3.send.mock.calls[0][0].input.VersionId).toBe("v1");
  await expect(store.read({ digest: "a".repeat(64), objectVersion: "v1" })).rejects.toThrow("digest_mismatch");
});
it("bounds writes and streams and closes rejected response bodies", async () => {
  const body = Readable.from([Buffer.alloc(storageModule.MAX_SHARD_BYTES + 1)]);
  const s3 = { send: vi.fn(async () => ({ Body: body })) };
  const store = storageModule.createVideoSearchShardStorage(config, { s3 });
  await expect(store.put({ schema: 1, chunks: [], text: "x".repeat(storageModule.MAX_SHARD_BYTES) })).rejects.toThrow("too_large");
  expect(s3.send).not.toHaveBeenCalled();
  await expect(store.read({ digest: "a".repeat(64), objectVersion: "v1" })).rejects.toThrow("too_large");
  expect(body.destroyed).toBe(true);
});

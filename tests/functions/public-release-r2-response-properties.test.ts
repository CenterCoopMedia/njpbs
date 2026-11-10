import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
const { readBoundedPairObject } = createRequire(import.meta.url)("../../functions/lib/public-release-view-read.js");
const bytes = new TextEncoder().encode("exact immutable response");
const expected = { schemaversion: "2", pairdigest: "a".repeat(64), taskid: "b".repeat(64), claimdigest: "c".repeat(64),
  bodydigest: createHash("sha256").update(bytes).digest("hex") };
function response(options: { size?: number; body?: Uint8Array; metadata?: Record<string, string> | null; open?: boolean } = {}) {
  const reads = { size: 0, metadata: 0, canceled: 0 };
  const object = {
    get size() { reads.size++; return options.size ?? bytes.length; },
    get customMetadata() { reads.metadata++; return options.metadata === null ? undefined : options.metadata ?? expected; },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(options.body ?? bytes); if (!options.open) controller.close();
    }, cancel() { reads.canceled++; } }),
  };
  return { reads, store: { get: async () => object } };
}
it("reads remote response size and metadata once while proving every byte and all five metadata fields", async () => {
  const { reads, store } = response();
  expect(await readBoundedPairObject(store, "object", 1024, expected, bytes.length)).toEqual(bytes);
  expect(reads).toEqual({ size: 1, metadata: 1, canceled: 0 });
});
it.each([NaN, -1, 1025, bytes.length + 1])("refuses size %s before reading metadata and cancels its body", async size => {
  const { reads, store } = response({ size, open: true });
  await expect(readBoundedPairObject(store, "object", 1024, expected, bytes.length)).rejects.toThrow("Public pair bytes are unavailable");
  expect(reads).toEqual({ size: 1, metadata: 0, canceled: 1 });
});
it.each([null, { ...expected, pairdigest: "f".repeat(64) }])("refuses missing or wrong metadata before consuming bytes", async metadata => {
  const { reads, store } = response({ metadata, open: true });
  await expect(readBoundedPairObject(store, "object", 1024, expected, bytes.length)).rejects.toThrow("Public pair bytes are unavailable");
  expect(reads).toEqual({ size: 1, metadata: 1, canceled: 1 });
});
it.each([bytes.slice(1), new Uint8Array(bytes.length + 1), new Uint8Array(bytes.length).fill(1)])(
  "retains exact stream length and hash refusal", async body => {
    const { reads, store } = response({ body });
    await expect(readBoundedPairObject(store, "object", 1024, expected, bytes.length)).rejects.toThrow("Public pair bytes are unavailable");
    expect(reads.size).toBe(1); expect(reads.metadata).toBe(1);
  });
it("does not fetch metadata when the existing caller does not require it", async () => {
  const { reads, store } = response();
  expect(await readBoundedPairObject(store, "object", 1024)).toEqual(bytes);
  expect(reads.metadata).toBe(0); expect(reads.size).toBe(1);
});
it("still refuses an absent object", async () => {
  await expect(readBoundedPairObject({ get: async () => null }, "object", 1024, expected)).rejects.toThrow("Public pair bytes are unavailable");
});

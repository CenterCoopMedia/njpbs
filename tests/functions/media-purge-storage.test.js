import { describe, expect, it, vi } from "vitest";
import executor from "../../functions/lib/media-purge-executor.js";
import storageModule from "../../functions/lib/media-purge-storage.js";
const { MediaPurgeStorage } = storageModule;
function storage(send, clock = () => 1000) {
  return new MediaPurgeStorage({ publicBucket: "public-test", masterBucket: "master-test", client: { send }, clock });
}
describe("scoped media purge storage", () => {
  it("requires an absence readback after deleting the exact listed key", async () => {
    const missing = Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(missing);
    await storage(send).remove({ store: "masters", key: "masters/aa/test.jpg" }, 20_000);
    expect(send.mock.calls.map(([command]) => [command.constructor.name, command.input])).toEqual([
      ["DeleteObjectCommand", { Bucket: "master-test", Key: "masters/aa/test.jpg" }],
      ["HeadObjectCommand", { Bucket: "master-test", Key: "masters/aa/test.jpg" }],
    ]);
  });
  it("does not treat access denied or a still-present object as deleted", async () => {
    await expect(storage(vi.fn(async () => ({}))).remove({ store: "public", key: "cms-media/test" }, 20_000))
      .rejects.toThrow(/still present/);
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(storage(send).remove({ store: "public", key: "cms-media/test" }, 20_000)).rejects.toThrow("denied");
  });
  it("refuses expired execution deadlines before I/O", async () => {
    const send = vi.fn();
    await expect(storage(send).remove({ store: "public", key: "cms-media/test" }, 1000)).rejects.toThrow(/deadline/);
    expect(send).not.toHaveBeenCalled();
  });
  it("lists at most 100 master keys without deletion and carries a provider cursor", async () => {
    const send = vi.fn(async () => ({ IsTruncated: true, NextContinuationToken: "next", Contents: [] }));
    expect(await storage(send).listMasters("previous")).toEqual({ objects: [], cursor: "next" });
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "master-test", Prefix: "masters/", MaxKeys: 100, ContinuationToken: "previous" });
  });
});

it("preserves the incoming orphan cursor when the read-only inventory budget expires", async () => {
  const firestore = { runTransaction: vi.fn() };
  const inventoryStorage = { listMasters: async () => ({ objects: [{ key: "masters/aa/test.jpg" }], cursor: "next" }) };
  const report = await executor.inventoryOrphanMasters({ firestore, storage: inventoryStorage,
    cursor: "previous", nowMs: 1000, clock: () => 2000, deadlineMs: 2000 });
  expect(report).toMatchObject({ cursor: "previous", reportOnly: true, incomplete: true });
  expect(firestore.runTransaction).not.toHaveBeenCalled();
});

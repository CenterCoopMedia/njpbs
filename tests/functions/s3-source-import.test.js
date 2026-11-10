import { describe, expect, it, vi } from "vitest";
import { importSourcePage } from "../../scripts/import-s3-source-media.mjs";

function fakeFirestore() {
  const records = new Map();
  const committedWrites = [];
  function reference(collection, id) {
    const key = `${collection}/${id}`;
    return {
      id,
      key,
      async get() {
        const data = records.get(key);
        return { id, exists: data !== undefined, data: () => structuredClone(data) };
      },
      async set(data) {
        records.set(key, structuredClone(data));
      },
    };
  }
  return {
    records, committedWrites,
    collection: (name) => ({ doc: (id) => reference(name, id) }),
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: (ref) => ref.get(),
        set(ref, data, options) { writes.push({ ref, data, options }); },
      };
      const result = await callback(transaction);
      for (const { ref, data, options } of writes) {
        committedWrites.push(ref.key);
        const current = records.get(ref.key);
        records.set(
          ref.key,
          options?.merge ? { ...current, ...structuredClone(data) } : structuredClone(data),
        );
      }
      return result;
    },
  };
}

const source = {
  id: "video-library",
  bucket: "njpbs-video-123456789012-us-east-2",
  expectedBucketOwner: "123456789012",
  prefix: "shared/",
};

describe("S3 source metadata import", () => {
  it("checkpoints exact object versions and leaves totals explicitly inexact", async () => {
    const firestore = fakeFirestore();
    const send = vi.fn(async (command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return {
          IsTruncated: false,
          Versions: [{
            Key: "shared/external/master.mxf",
            VersionId: "exact-version",
            IsLatest: true,
            Size: 4096,
            LastModified: new Date("2026-09-14T15:00:00.000Z"),
          }],
        };
      }
      return { ContentType: "application/mxf", ChecksumSHA256: "checksum" };
    });
    const result = await importSourcePage({
      firestore,
      s3: { send },
      source,
      now: "2026-09-14T16:00:00.000Z",
    });
    expect(result).toMatchObject({ indexed: 1, skipped: 0, complete: true });
    const asset = [...firestore.records.entries()]
      .find(([key]) => key.startsWith("mediaSourceAssets/"))[1];
    expect(asset).toMatchObject({
      sourceId: "video-library",
      objectKey: "shared/external/master.mxf",
      objectVersionId: "exact-version",
      mimeType: "application/mxf",
      preview: "download_only",
    });
    expect(firestore.records.get("mediaSourceStats/video-library").exact).toBe(false);
  });

  it("preserves intentional library deletion when the original is imported again", async () => {
    const firestore = fakeFirestore();
    const send = vi.fn(async (command) => command.constructor.name === "ListObjectVersionsCommand"
      ? { IsTruncated: false, Versions: [{ Key: "shared/external/master.mxf",
          VersionId: "original-v1", IsLatest: true, Size: 4096 }] }
      : { ContentType: "application/mxf" });
    await importSourcePage({ firestore, s3: { send }, source });
    const [key, asset] = [...firestore.records.entries()].find(([key]) => key.startsWith("mediaSourceAssets/"));
    const deleted = { ...asset, lifecycle: "deleted", version: 2, deletedBy: "admin-1" };
    firestore.records.set(key, deleted);
    await expect(importSourcePage({ firestore, s3: { send }, source, restart: true }))
      .resolves.toMatchObject({ indexed: 0, skipped: 1 });
    expect(firestore.records.get(key)).toEqual(deleted);
  });

  it.each([true, false])("keeps deletion when a newer object changes Boardwalk metadata (initial: %s)", async (initialBoardwalk) => {
    const firestore = fakeFirestore();
    const assetId = "22222222-2222-4222-8222-222222222222";
    const key = `shared/objects/${assetId}.mp4`;
    let boardwalk = initialBoardwalk;
    let version = "original-version";
    const send = vi.fn(async (command) => command.constructor.name === "ListObjectVersionsCommand"
      ? { IsTruncated: false, Versions: [{ Key: key, VersionId: version,
          IsLatest: true, Size: 4096 }] }
      : { ContentType: "video/mp4", Metadata: boardwalk ? { "boardwalk-asset": assetId } : {} });
    await importSourcePage({ firestore, s3: { send }, source });
    const [recordKey, asset] = [...firestore.records.entries()]
      .find(([key]) => key.startsWith("mediaSourceAssets/"));
    const deleted = { ...asset, lifecycle: "deleted", version: 2, deletedBy: "admin-1" };
    firestore.records.set(recordKey, deleted);
    boardwalk = !initialBoardwalk;
    version = "replacement-version";
    await expect(importSourcePage({ firestore, s3: { send }, source, restart: true }))
      .resolves.toMatchObject({ indexed: 0, skipped: 1 });
    const assets = [...firestore.records.entries()].filter(([key]) => key.startsWith("mediaSourceAssets/"));
    expect(assets).toEqual([[recordKey, deleted]]);
  });

  it("ignores unrelated alternate deletions but still rejects a mismatched primary asset", async () => {
    const firestore = fakeFirestore();
    const assetId = "22222222-2222-4222-8222-222222222222";
    const key = `shared/objects/${assetId}.mp4`;
    const unrelated = { sourceId: "archive-working", objectKey: key, lifecycle: "deleted" };
    firestore.records.set(`mediaSourceAssets/${assetId}`, unrelated);
    const send = vi.fn(async (command) => command.constructor.name === "ListObjectVersionsCommand"
      ? { IsTruncated: false, Versions: [{ Key: key, VersionId: "version-1", IsLatest: true, Size: 4096 }] }
      : { ContentType: "video/mp4" });
    await expect(importSourcePage({ firestore, s3: { send }, source }))
      .resolves.toMatchObject({ indexed: 1 });
    expect(firestore.records.get(`mediaSourceAssets/${assetId}`)).toEqual(unrelated);
    const [recordKey, asset] = [...firestore.records.entries()]
      .find(([key]) => key.startsWith("mediaSourceAssets/") && key !== `mediaSourceAssets/${assetId}`);
    firestore.records.set(recordKey, { ...asset, sourceId: "archive-working" });
    await expect(importSourcePage({ firestore, s3: { send }, source, restart: true }))
      .rejects.toThrow(/conflicts with video-library/);
  });

  it("does not rescan a completed checkpoint unless restart is explicit", async () => {
    const firestore = fakeFirestore();
    firestore.records.set("mediaSourceImports/video-library", {
      sourceId: "video-library",
      status: "complete",
      indexed: 3,
    });
    const send = vi.fn();
    await expect(importSourcePage({
      firestore,
      s3: { send },
      source,
    })).resolves.toMatchObject({ complete: true, indexed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not commit a truncated page without a safe continuation", async () => {
    const firestore = fakeFirestore();
    const send = vi.fn(async () => ({ IsTruncated: true, Versions: [] }));
    await expect(importSourcePage({
      firestore,
      s3: { send },
      source,
    })).rejects.toThrow(/invalid source import continuation/);
    expect(firestore.records.has("mediaSourceStats/video-library")).toBe(false);
  });

  it("reuses an uploaded asset id and preserves staff metadata during a rescan", async () => {
    const firestore = fakeFirestore();
    const assetId = "22222222-2222-4222-8222-222222222222";
    const key = `shared/objects/${assetId}.mp4`;
    firestore.records.set(`mediaSourceAssets/${assetId}`, {
      id: assetId,
      sourceId: "video-library",
      lifecycle: "active",
      name: "Staff title",
      originalName: "upload.mp4",
      description: "Staff description",
      nameSort: "staff title",
      updatedAtSort: "2026-09-14T15:30:00.000Z",
      mimeType: "video/mp4",
      kind: "video",
      sizeBytes: 4096,
      preview: "browser",
      license: "Station owned",
      credit: "NJ PBS",
      tags: ["edited"],
      rightsStatus: "complete",
      version: 3,
      createdAt: "2026-09-14T15:00:00.000Z",
      createdBy: "staff-1",
      updatedAt: "2026-09-14T15:30:00.000Z",
      updatedBy: "staff-2",
      objectKey: key,
      objectVersionId: "old-version",
    });
    const send = vi.fn(async (command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return {
          IsTruncated: false,
          Versions: [{
            Key: key,
            VersionId: "new-version",
            IsLatest: true,
            Size: 4096,
          }],
        };
      }
      return {
        ContentType: "video/mp4",
        Metadata: { "boardwalk-asset": assetId },
      };
    });
    await importSourcePage({
      firestore,
      s3: { send },
      source,
      now: "2026-09-14T16:00:00.000Z",
    });
    const assets = [...firestore.records.entries()]
      .filter(([recordKey]) => recordKey.startsWith("mediaSourceAssets/"));
    expect(assets).toHaveLength(1);
    expect(assets[0][0]).toBe(`mediaSourceAssets/${assetId}`);
    expect(assets[0][1]).toMatchObject({
      name: "Staff title",
      description: "Staff description",
      tags: ["edited"],
      version: 4,
      objectVersionId: "new-version",
    });
  });

  it("tombstones the matching deterministic asset without changing unrelated records", async () => {
    const firestore = fakeFirestore();
    const pathAssetId = "33333333-3333-4333-8333-333333333333";
    const key = `shared/objects/${pathAssetId}.mp4`;
    let deleting = false;
    const send = vi.fn(async (command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return deleting
          ? {
              IsTruncated: false,
              DeleteMarkers: [{
                Key: key,
                VersionId: "delete-version",
                IsLatest: true,
                LastModified: new Date("2026-09-14T17:00:00.000Z"),
              }],
            }
          : {
              IsTruncated: false,
              Versions: [{
                Key: key,
                VersionId: "object-version",
                IsLatest: true,
                Size: 8192,
              }],
            };
      }
      return { ContentType: "video/mp4" };
    });

    await importSourcePage({
      firestore,
      s3: { send },
      source,
      now: "2026-09-14T16:00:00.000Z",
    });
    const indexedEntry = [...firestore.records.entries()]
      .find(([recordKey]) => recordKey.startsWith("mediaSourceAssets/"));
    expect(indexedEntry[0]).not.toBe(`mediaSourceAssets/${pathAssetId}`);
    const deterministicAssetKey = indexedEntry[0];
    firestore.records.set(deterministicAssetKey, {
      ...indexedEntry[1],
      name: "Staff title",
      description: "Staff description",
      nameSort: "staff title",
      tags: ["edited"],
      version: 4,
      updatedAt: "2026-09-14T16:30:00.000Z",
      updatedAtSort: "2026-09-14T16:30:00.000Z",
      updatedBy: "staff-2",
    });
    const unrelated = {
      sourceId: "archive-working",
      objectKey: key,
      lifecycle: "active",
    };
    firestore.records.set(`mediaSourceAssets/${pathAssetId}`, unrelated);

    deleting = true;
    const result = await importSourcePage({
      firestore,
      s3: { send },
      source,
      restart: true,
      now: "2026-09-14T18:00:00.000Z",
    });

    expect(result).toMatchObject({ indexed: 0, tombstoned: 1, skipped: 0, complete: true });
    expect(firestore.records.get(deterministicAssetKey)).toMatchObject({
      lifecycle: "tombstoned",
      name: "Staff title",
      description: "Staff description",
      tags: ["edited"],
      version: 5,
      objectKey: key,
      objectVersionId: "object-version",
      s3DeleteMarkerVersionId: "delete-version",
      tombstonedAt: "2026-09-14T17:00:00.000Z",
    });
    expect(firestore.records.get(`mediaSourceAssets/${pathAssetId}`)).toEqual(unrelated);
    expect(firestore.records.get("mediaSourceImports/video-library")).toMatchObject({
      status: "complete",
      tombstoned: 1,
    });
    expect(send.mock.calls.filter(([command]) =>
      command.constructor.name === "HeadObjectCommand")).toHaveLength(1);
  });

  it("tombstones an uploaded Boardwalk asset by its UUID", async () => {
    const firestore = fakeFirestore();
    const assetId = "44444444-4444-4444-8444-444444444444";
    const key = `shared/objects/${assetId}.mp4`;
    let deleting = false;
    const send = vi.fn(async (command) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return deleting
          ? {
              IsTruncated: false,
              DeleteMarkers: [{
                Key: key,
                VersionId: "delete-version",
                IsLatest: true,
              }],
            }
          : {
              IsTruncated: false,
              Versions: [{
                Key: key,
                VersionId: "object-version",
                IsLatest: true,
                Size: 4096,
              }],
            };
      }
      return {
        ContentType: "video/mp4",
        Metadata: { "boardwalk-asset": assetId },
      };
    });

    await importSourcePage({
      firestore,
      s3: { send },
      source,
      now: "2026-09-14T16:00:00.000Z",
    });
    deleting = true;
    const result = await importSourcePage({
      firestore,
      s3: { send },
      source,
      restart: true,
      now: "2026-09-14T18:00:00.000Z",
    });

    expect(result).toMatchObject({ indexed: 0, tombstoned: 1, skipped: 0, complete: true });
    const assets = [...firestore.records.entries()]
      .filter(([recordKey]) => recordKey.startsWith("mediaSourceAssets/"));
    expect(assets).toHaveLength(1);
    expect(assets[0][0]).toBe(`mediaSourceAssets/${assetId}`);
    expect(assets[0][1]).toMatchObject({
      lifecycle: "tombstoned",
      version: 2,
      objectVersionId: "object-version",
      s3DeleteMarkerVersionId: "delete-version",
      tombstonedAt: "2026-09-14T18:00:00.000Z",
    });
  });
});

it("queues 50 imported video changes with one source epoch write", async () => {
  const firestore = fakeFirestore();
  const versions = Array.from({ length: 50 }, (_, index) => ({ Key: `shared/batch/${index}.mp4`, VersionId: `v-${index}`,
    IsLatest: true, Size: 4096, LastModified: new Date("2026-09-14T15:00:00Z") }));
  const s3 = { send: async command => command.constructor.name === "ListObjectVersionsCommand"
    ? { IsTruncated: false, Versions: versions } : { ContentType: "video/mp4", ChecksumSHA256: "checksum" } };
  const result = await importSourcePage({ firestore, s3, source, now: "2026-09-14T16:00:00Z" });
  expect(result.indexed).toBe(50);
  expect(firestore.committedWrites.filter(path => path === "mediaSourceSearchState/video-library")).toHaveLength(1);
  expect(firestore.committedWrites.filter(path => path.startsWith("mediaSourceSearchShards/"))).toHaveLength(50);
});

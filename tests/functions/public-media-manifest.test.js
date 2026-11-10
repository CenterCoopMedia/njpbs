import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaUsageModule from "../../functions/lib/media-usage.js";
import manifestModule from "../../functions/lib/public-media-manifest.js";

const admin = adminPkg;
const {
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS,
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNERS,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS,
  assertPublicMediaManifest,
  createPublicMediaManifest,
  publicMediaDeployedUsageDocument,
  publicMediaDeployedUsageDocuments,
  publicMediaManifestChunkReceipt,
  publicMediaManifestChunks,
} = manifestModule;
const { MEDIA_USAGE_STATES } = mediaUsageModule;

function reservation(overrides = {}) {
  const cutoffAt = new admin.firestore.Timestamp(1_786_723_200, 123_456_789);
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 8,
    commitSha: "a".repeat(40),
    reservedAgainstGeneration: 7,
    reservedAgainstDeploymentId: "deployment-7",
    reservedAgainstCommitSha: "b".repeat(40),
    cutoffAt,
    reservedAt: cutoffAt,
    ...overrides,
  };
}

function owners() {
  return [
    {
      collection: "cmsSettings",
      documentId: "site",
      sourceVersion: 4,
      assetIds: ["settings-logo"],
      occurrenceCount: 1,
    },
    {
      collection: "cmsPages",
      documentId: "home",
      sourceVersion: 2,
      assetIds: ["page-b", "page-a"],
      occurrenceCount: 3,
    },
    {
      collection: "cmsPosts",
      documentId: "post-one",
      sourceVersion: 3,
      assetIds: [],
      occurrenceCount: 0,
    },
  ];
}

function artifactInventory(ownerValues) {
  return ["cmsPages", "cmsPosts", "cmsSettings", "cmsAuthorProfilesPublic"].map(
    (collection) => ({
    collection,
    complete: true,
    documentIds: ownerValues
      .filter((ownerValue) => ownerValue.collection === collection)
      .map((ownerValue) => ownerValue.documentId),
    }),
  );
}

function ownerIdsDigest(collection, documentIds) {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 1,
      collection,
      documentIds,
    }), "utf8")
    .digest("hex");
}

function createManifest(ownerValues = owners()) {
  return createPublicMediaManifest({
    reservation: reservation(),
    artifactInventory: artifactInventory(ownerValues),
    owners: ownerValues,
  });
}

function ownerValue(documentId) {
  return {
    collection: "cmsPosts",
    documentId,
    sourceVersion: 1,
    assetIds: [],
    occurrenceCount: 0,
  };
}

describe("public media manifest v1", () => {
  it("keeps deployed state outside mutable content and repair writers", () => {
    expect([...MEDIA_USAGE_STATES]).toEqual(["working", "published"]);
  });

  it("canonicalizes all owner classes and binds the exact reservation cutoff", () => {
    const manifest = createManifest();

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      digestAlgorithm: "sha256",
      buildBatchId: "build-one",
      generation: 8,
      commitSha: "a".repeat(40),
      cutoffAt: { seconds: 1_786_723_200, nanoseconds: 123_456_789 },
      coverage: [
        {
          collection: "cmsPages",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsPages", ["home"]),
        },
        {
          collection: "cmsPosts",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsPosts", ["post-one"]),
        },
        {
          collection: "cmsSettings",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsSettings", ["site"]),
        },
        {
          collection: "cmsAuthorProfilesPublic",
          complete: true,
          ownerCount: 0,
          ownerIdsDigest: ownerIdsDigest("cmsAuthorProfilesPublic", []),
        },
      ],
      ownerCount: 3,
    });
    expect(manifest.owners.map(({ collection, documentId }) =>
      `${collection}/${documentId}`)).toEqual([
      "cmsPages/home",
      "cmsPosts/post-one",
      "cmsSettings/site",
    ]);
    expect(manifest.owners[0].assetIds).toEqual(["page-a", "page-b"]);

    const canonicalPayload = JSON.stringify({
      schemaVersion: 1,
      digestAlgorithm: "sha256",
      buildBatchId: "build-one",
      generation: 8,
      commitSha: "a".repeat(40),
      cutoffAt: { seconds: 1_786_723_200, nanoseconds: 123_456_789 },
      coverage: [
        {
          collection: "cmsPages",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsPages", ["home"]),
        },
        {
          collection: "cmsPosts",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsPosts", ["post-one"]),
        },
        {
          collection: "cmsSettings",
          complete: true,
          ownerCount: 1,
          ownerIdsDigest: ownerIdsDigest("cmsSettings", ["site"]),
        },
        {
          collection: "cmsAuthorProfilesPublic",
          complete: true,
          ownerCount: 0,
          ownerIdsDigest: ownerIdsDigest("cmsAuthorProfilesPublic", []),
        },
      ],
      ownerCount: 3,
      owners: [
        {
          collection: "cmsPages",
          documentId: "home",
          sourceVersion: 2,
          assetIds: ["page-a", "page-b"],
          occurrenceCount: 3,
        },
        {
          collection: "cmsPosts",
          documentId: "post-one",
          sourceVersion: 3,
          assetIds: [],
          occurrenceCount: 0,
        },
        {
          collection: "cmsSettings",
          documentId: "site",
          sourceVersion: 4,
          assetIds: ["settings-logo"],
          occurrenceCount: 1,
        },
      ],
    });
    expect(manifest.mediaManifestDigest).toBe(
      createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
    );
    expect(assertPublicMediaManifest(manifest, reservation())).toEqual(manifest);
  });

  it("keeps storage chunks outside the semantic root digest", () => {
    const manifest = createManifest();
    const chunks = publicMediaManifestChunks(manifest, 2);

    expect(MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK).toBe(200);
    expect(MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PUBLIC_MEDIA_MANIFEST_OWNERS).toBe(10_000);
    expect(MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS).toBe(100);
    expect(MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS).toBe(103);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(({ index, ownerCount }) => ({ index, ownerCount })))
      .toEqual([{ index: 0, ownerCount: 2 }, { index: 1, ownerCount: 1 }]);
    expect(chunks[0].chunkDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(chunks[0].ownerKeys).toEqual([
      { collection: "cmsPages", documentId: "home" },
      { collection: "cmsPosts", documentId: "post-one" },
    ]);
    expect(manifest.mediaManifestDigest).toBe(createManifest().mediaManifestDigest);
  });

  it("splits maximum-sized legal owners before the byte limit", () => {
    const assetIds = Array.from({ length: 100 }, (_, index) =>
      `a${String(index).padStart(3, "0")}${"x".repeat(124)}`);
    const ownerValues = Array.from({ length: 200 }, (_, index) => {
      const prefix = `owner-${String(index).padStart(3, "0")}-`;
      return {
        collection: "cmsPosts",
        documentId: `${prefix}${"x".repeat(1_500 - prefix.length)}`,
        sourceVersion: 1,
        assetIds,
        occurrenceCount: 200,
      };
    });
    const manifest = createManifest(ownerValues);
    const chunks = publicMediaManifestChunks(manifest);
    const deployedDocuments = publicMediaDeployedUsageDocuments(manifest);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) =>
      chunk.ownerCount < MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK &&
      chunk.canonicalBytes <= MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES)).toBe(true);
    expect(chunks.reduce((count, chunk) => count + chunk.ownerCount, 0)).toBe(200);
    let ownerOffset = 0;
    for (const chunk of chunks) {
      const deployedBytes = deployedDocuments
        .slice(ownerOffset, ownerOffset + chunk.ownerCount)
        .reduce((total, document) =>
          total + Buffer.byteLength(JSON.stringify(document), "utf8"), 0);
      const receiptBytes = Buffer.byteLength(JSON.stringify(
        publicMediaManifestChunkReceipt(manifest, chunk),
      ), "utf8");
      expect(chunk.canonicalBytes).toBe(deployedBytes + receiptBytes);
      ownerOffset += chunk.ownerCount;
    }
  });

  it("creates deployed usage only through the manifest contract", () => {
    const manifest = createManifest();

    expect(publicMediaDeployedUsageDocument({
      manifest,
      owner: manifest.owners[0],
    })).toEqual({
      schemaVersion: 1,
      state: "deployed",
      generation: 8,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
      mediaManifestDigest: manifest.mediaManifestDigest,
      sourceVersion: 2,
      assetIds: ["page-a", "page-b"],
      occurrenceCount: 3,
    });
  });

  it.each([
    (manifest) => ({ ...manifest, futureField: true }),
    (manifest) => ({ ...manifest, ownerCount: 2 }),
    (manifest) => ({ ...manifest, mediaManifestDigest: "0".repeat(64) }),
    (manifest) => ({ ...manifest, coverage: manifest.coverage.slice(0, 2) }),
    (manifest) => ({ ...manifest, owners: [...manifest.owners].reverse() }),
    (manifest) => ({
      ...manifest,
      owners: manifest.owners.map((owner, index) => index === 0
        ? { ...owner, futureField: true }
        : owner),
    }),
  ])("fails closed when a persisted manifest is not exact", (mutate) => {
    const manifest = createManifest();

    expect(() => assertPublicMediaManifest(mutate(manifest), reservation()))
      .toThrow(/public media manifest.*invalid/i);
  });

  it.each([
    () => [{ ...owners()[0], documentId: "bad/id" }],
    () => [{ ...owners()[0], documentId: "." }],
    () => [{ ...owners()[0], documentId: "__reserved__" }],
    () => [{ ...owners()[0], sourceVersion: 0 }],
    () => [{ ...owners()[0], assetIds: ["not valid"] }],
    () => [{ ...owners()[0], assetIds: [], occurrenceCount: 1 }],
    () => [{
      ...owners()[0],
      assetIds: Array.from({ length: 101 }, (_, index) => `asset-${index}`),
      occurrenceCount: 101,
    }],
    () => [{ ...owners()[0], occurrenceCount: 201 }],
    () => [{ ...owners()[0], assetIds: [], occurrenceCount: -0 }],
    () => [{ ...owners()[0], documentId: "x".repeat(1_501) }],
    () => [owners()[0], owners()[0]],
  ])("rejects invalid owner input before a manifest exists", (invalidOwners) => {
    expect(() => createPublicMediaManifest({
      reservation: reservation(),
      artifactInventory: artifactInventory(invalidOwners()),
      owners: invalidOwners(),
    })).toThrow("public media manifest owner is invalid");
  });

  it.each([
    undefined,
    [
      { collection: "cmsPages", complete: true, documentIds: ["home"] },
      { collection: "cmsPosts", complete: true, documentIds: ["post-one"] },
    ],
    [
      { collection: "cmsPages", complete: false, documentIds: ["home"] },
      { collection: "cmsPosts", complete: true, documentIds: ["post-one"] },
      { collection: "cmsSettings", complete: true, documentIds: ["site"] },
    ],
    [
      { collection: "cmsPages", complete: true, documentIds: [] },
      { collection: "cmsPosts", complete: true, documentIds: ["post-one"] },
      { collection: "cmsSettings", complete: true, documentIds: ["site"] },
    ],
    [
      { collection: "cmsPages", complete: true, documentIds: ["home", "extra"] },
      { collection: "cmsPosts", complete: true, documentIds: ["post-one"] },
      { collection: "cmsSettings", complete: true, documentIds: ["site"] },
    ],
  ])("requires complete independent artifact inventory evidence", (inventory) => {
    expect(() => createPublicMediaManifest({
      reservation: reservation(),
      artifactInventory: inventory,
      owners: owners(),
    })).toThrow(/artifact inventory is invalid/i);
  });

  it("accepts complete zero only when every artifact family says it is complete", () => {
    expect(() => createPublicMediaManifest({
      reservation: reservation(),
      owners: [],
    })).toThrow(/artifact inventory is invalid/i);

    const manifest = createManifest([]);

    expect(manifest.coverage).toEqual([
      {
        collection: "cmsPages",
        complete: true,
        ownerCount: 0,
        ownerIdsDigest: ownerIdsDigest("cmsPages", []),
      },
      {
        collection: "cmsPosts",
        complete: true,
        ownerCount: 0,
        ownerIdsDigest: ownerIdsDigest("cmsPosts", []),
      },
      {
        collection: "cmsSettings",
        complete: true,
        ownerCount: 0,
        ownerIdsDigest: ownerIdsDigest("cmsSettings", []),
      },
      {
        collection: "cmsAuthorProfilesPublic",
        complete: true,
        ownerCount: 0,
        ownerIdsDigest: ownerIdsDigest("cmsAuthorProfilesPublic", []),
      },
    ]);
  });

  it("rejects more than the bounded total owner count", () => {
    const ownerValues = Array.from(
      { length: MAX_PUBLIC_MEDIA_MANIFEST_OWNERS + 1 },
      (_, index) => ownerValue(`post-${index}`),
    );

    expect(() => createManifest(ownerValues))
      .toThrow(/owner limit/i);
  });

  it("keeps 10,000 short owner ids within verification bounds", () => {
    const ownerValues = Array.from(
      { length: MAX_PUBLIC_MEDIA_MANIFEST_OWNERS },
      (_, index) => ownerValue(`p-${String(index).padStart(5, "0")}`),
    );
    const manifest = createManifest(ownerValues);
    const chunks = publicMediaManifestChunks(manifest);
    const verificationBytes = chunks.reduce((total, chunk) =>
      total + Buffer.byteLength(JSON.stringify(
        publicMediaManifestChunkReceipt(manifest, chunk),
      ), "utf8"), 0);

    expect(chunks).toHaveLength(50);
    expect(chunks.length + 3).toBeLessThanOrEqual(
      MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_READS,
    );
    expect(verificationBytes).toBeLessThanOrEqual(
      MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
    );
  });
});

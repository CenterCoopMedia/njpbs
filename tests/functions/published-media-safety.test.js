import { describe, expect, it } from "vitest";
import publishedMediaSafety from "../../functions/lib/published-media-safety.js";

const {
  PUBLIC_PAGE_IDS,
  assertPublishedAssetProjection,
  assertPublishedMediaSafe,
  collectPublishedArtifactMediaOwners,
  hasPotentialPublicSnapshot,
} = publishedMediaSafety;

function snapshot(data, id = "document") {
  return { id, exists: data !== undefined, data: () => data };
}

function fakeFirestore(records) {
  function documentReference(collection, id) {
    return { collection, id };
  }
  return {
    collection(collection) {
      return {
        doc(id) {
          return documentReference(collection, id);
        },
        async get() {
          return {
            docs: Object.entries(records[collection] ?? {}).map(([id, data]) =>
              snapshot(data, id),
            ),
          };
        },
      };
    },
    async getAll(...references) {
      return references.map(({ collection, id }) =>
        snapshot(records[collection]?.[id], id),
      );
    },
  };
}

function publishedPage(overrides = {}) {
  return {
    status: "published",
    publishAt: "2026-08-14T19:00:00.000Z",
    published: {
      metadata: { title: "Published page" },
      sourceVersion: 1,
      publishedAt: "2026-08-14T18:00:00.000Z",
    },
    ...overrides,
  };
}

describe("published media dispatch safety", () => {
  it("includes custom page background media in publication admission", () => {
    const id = `page-${"b".repeat(32)}`;
    const result = collectPublishedArtifactMediaOwners({
      pageSnapshots: [snapshot(publishedPage({ published: {
        blocks: [], metadata: { title: "Community", slug: "community", heroBackgroundImage: "custom-hero" },
        sourceVersion: 1, publishedAt: "2026-08-14T18:00:00.000Z",
      } }), id)], postSnapshots: [], authorSnapshots: [],
    });
    expect(result.assetOwners.has("custom-hero")).toBe(true);
    expect(result.candidatePageCount).toBe(1);
  });

  it("retains the built-in public page registry", () => {
    expect(PUBLIC_PAGE_IDS).toHaveLength(19);
    expect(PUBLIC_PAGE_IDS).toEqual(
      expect.arrayContaining(["home", "watch", "staff", "public-meetings"]),
    );
    expect(PUBLIC_PAGE_IDS).not.toContain("programLanding");
  });

  it("matches public build admission for published and revised pages", () => {
    expect(hasPotentialPublicSnapshot(publishedPage())).toBe(true);
    expect(
      hasPotentialPublicSnapshot(
        publishedPage({
          status: "draft",
          publiclyVisible: true,
          publishAt: "2027-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("includes visible future snapshots and excludes hidden, deleted, and malformed records", () => {
    expect(
      hasPotentialPublicSnapshot(
        publishedPage({ publiclyVisible: false }),
      ),
    ).toBe(false);
    expect(
      hasPotentialPublicSnapshot(publishedPage({ deleted: "legacy" })),
    ).toBe(false);
    expect(
      hasPotentialPublicSnapshot(
        publishedPage({ publishAt: "2027-01-01T00:00:00.000Z" }),
      ),
    ).toBe(true);
    expect(
      hasPotentialPublicSnapshot(
        publishedPage({ publishAt: "2026-02-31T00:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(
      hasPotentialPublicSnapshot(
        publishedPage({
          published: {
            blocks: [],
            publishedAt: "2026-08-14T18:00:00.000Z",
          },
        }),
      ),
    ).toBe(false);
  });

  it("admits an uploaded projection only after coordinated media delivery is ready", () => {
    const privateRecord = {
      lifecycle: "active",
      source: "upload",
      url: "https://media.njpbs.org/cms-media/news/asset-one/hash.webp",
      altText: "Studio",
      mimeType: "image/webp",
      width: 2048,
      height: 1325,
    };
    const publicRecord = {
      url: privateRecord.url,
      altText: privateRecord.altText,
      mimeType: privateRecord.mimeType,
      width: privateRecord.width,
      height: privateRecord.height,
    };
    const input = {
      assetId: "asset-one",
      owner: "published page home",
      privateSnapshot: snapshot(privateRecord),
      publicSnapshot: snapshot(publicRecord),
    };

    expect(() => assertPublishedAssetProjection(input)).toThrow(
      /public deployment coordination/i,
    );
    expect(() =>
      assertPublishedAssetProjection({ ...input, uploadedMediaReady: true })
    ).not.toThrow();
  });

  it("collects media from every public artifact owner family", () => {
    const result = collectPublishedArtifactMediaOwners({
      pageSnapshots: [
        snapshot(
          publishedPage({
            published: {
              metadata: { social: { imageAssetId: "page-image" } },
              sourceVersion: 1,
              publishedAt: "2026-08-14T18:00:00.000Z",
            },
          }),
          "home",
        ),
      ],
      postSnapshots: [
        snapshot(
          publishedPage({
            published: {
              metadata: { type: "post", heroImage: "post-image" },
              sourceVersion: 1,
              publishedAt: "2026-08-14T18:00:00.000Z",
            },
          }),
          "story-one",
        ),
      ],
      authorSnapshots: [
        snapshot({ photo: { assetId: "author-image" } }, "author-one"),
      ],
    });

    expect([...result.assetOwners]).toEqual([
      ["page-image", "published page home"],
      ["post-image", "published post story-one"],
      ["author-image", "public author author-one"],
    ]);
  });

  it.each([
    [
      "published posts",
      {
        cmsPosts: {
          "story-one": publishedPage({
            published: {
              metadata: { type: "post", heroImage: "post-upload" },
              sourceVersion: 1,
              publishedAt: "2026-08-14T18:00:00.000Z",
            },
          }),
        },
        media_assets: {
          "post-upload": { source: "upload" },
        },
      },
      /post-upload.*cannot enter public content/i,
    ],
    [
      "public author profiles",
      {
        cmsAuthorProfilesPublic: {
          "author-one": { photo: { assetId: "author-upload" } },
        },
        media_assets: {
          "author-upload": { source: "upload" },
        },
      },
      /author-upload.*cannot enter public content/i,
    ],
  ])(
    "checks the deployment fence for uploads used by %s",
    async (_label, records, error) => {
      await expect(
        assertPublishedMediaSafe({ firestore: fakeFirestore(records) }),
      ).rejects.toThrow(error);
    },
  );
});


it("keeps empty-credit legacy pairs valid and refuses nonempty private credit until the public pair is repaired", () => {
  const projection = { url: "https://media.njpbs.org/cms-media/news/photo/hash.webp", altText: "Library alt", mimeType: "image/webp", width: 1600, height: 900 };
  const input = { assetId: "photo", owner: "Post", uploadedMediaReady: true, publicSnapshot: snapshot(projection) };
  for (const credit of [undefined, null, "", "  "]) {
    expect(assertPublishedAssetProjection({ ...input, privateSnapshot: snapshot({ ...projection, source: "upload", lifecycle: "active", credit }) })).toEqual(projection);
  }
  const privateSnapshot = snapshot({ ...projection, source: "upload", lifecycle: "active", credit: "Current photographer", description: "Private description" });
  expect(() => assertPublishedAssetProjection({ ...input, privateSnapshot })).toThrow(/projection/);
  const repaired = { ...projection, credit: "Current photographer" };
  expect(assertPublishedAssetProjection({ ...input, privateSnapshot, publicSnapshot: snapshot(repaired) })).toEqual(repaired);
});

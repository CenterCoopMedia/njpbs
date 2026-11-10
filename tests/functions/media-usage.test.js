import { describe, expect, it, vi } from "vitest";
import mediaUsage from "../../functions/lib/media-usage.js";

const {
  MAX_MEDIA_OCCURRENCES,
  MAX_MEDIA_USAGE_ASSETS,
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  mediaUsageDocument,
  prepareMediaUsageWrite,
  prepareMediaUsageWrites,
} = mediaUsage;

const image = (assetId, { visible = true } = {}) => ({
  id: `block-${assetId}`,
  type: "image",
  order: 0,
  visible,
  data: { assetId, alt: "Image" },
});

const FIXTURE_SETTINGS_SCHEMAS = Object.freeze({
  "fixture-settings": Object.freeze({
    currentVersion: 2,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          enabled: Object.freeze({ kind: "boolean", required: true }),
          heroAssetId: Object.freeze({ kind: "assetId" }),
          galleryAssetIds: Object.freeze({ kind: "assetIdList", maxItems: 200 }),
        }),
      }),
      2: Object.freeze({
        schemaVersion: 2,
        fields: Object.freeze({
          enabled: Object.freeze({ kind: "boolean", required: true }),
          replacementAssetId: Object.freeze({ kind: "assetId" }),
        }),
      }),
    }),
  }),
});

describe("CMS media usage", () => {
  it.each(["cmsPages", "cmsPosts"])("tracks frozen hero backgrounds separately from draft changes in %s", (collection) => {
    const document = { type: "post", blocks: [], heroBackgroundImage: "draft-background" };
    const snapshot = { blocks: [], metadata: { type: "post", heroBackgroundImage: "public-background" } };
    expect(collectWorkingMediaUsage({ collection, document }).assetIds).toEqual(["draft-background"]);
    expect(collectPublishedMediaUsage({ collection, snapshot }).assetIds).toEqual(["public-background"]);
  });

  it("counts every working occurrence, including hidden blocks", () => {
    const usage = collectWorkingMediaUsage({
      collection: "cmsPages",
      document: {
        version: 7,
        social: { imageAssetId: "social" },
        blocks: [
          image("hero"),
          image("hero", { visible: false }),
          {
            id: "gallery",
            type: "image_gallery",
            order: 1,
            visible: true,
            data: {
              images: [
                { assetId: "gallery-one", alt: "One" },
                { assetId: "hero", alt: "Again" },
              ],
            },
          },
          {
            id: "cards",
            type: "card_grid",
            order: 2,
            visible: true,
            data: {
              cards: [
                { title: "No image" },
                { title: "With image", imageAssetId: "card" },
              ],
            },
          },
          {
            id: "promotion",
            type: "promotion_playlist",
            order: 3,
            visible: true,
            data: {
              cards: [
                { imageAssetId: "promotion-one" },
                { imageAssetId: "hero" },
              ],
            },
          },
        ],
      },
    });

    expect(usage).toEqual({
      assetIds: ["card", "gallery-one", "hero", "promotion-one", "social"],
      occurrenceCount: 8,
    });
  });

  it("collects only build-admitted references from the published snapshot", () => {
    const usage = collectPublishedMediaUsage({
      collection: "cmsPages",
      snapshot: {
        sourceVersion: 8,
        blocks: [image("visible"), image("hidden", { visible: false })],
        metadata: { social: { imageAssetId: "social" } },
      },
    });

    expect(usage).toEqual({
      assetIds: ["social", "visible"],
      occurrenceCount: 2,
    });
  });

  it("distinguishes station assets from PBS Media Manager ids", () => {
    expect(
      collectWorkingMediaUsage({
        collection: "cmsPosts",
        document: { type: "post", heroImage: "post-lead", blocks: [] },
      }),
    ).toEqual({ assetIds: ["post-lead"], occurrenceCount: 1 });
    expect(
      collectWorkingMediaUsage({
        collection: "cmsPosts",
        document: { type: "sponsor", logoAssetId: "sponsor-logo" },
      }),
    ).toEqual({ assetIds: ["sponsor-logo"], occurrenceCount: 1 });
    expect(collectWorkingMediaUsage({
      collection: "cmsPosts", document: { type: "event", imageAssetId: "event-image" },
    })).toEqual({ assetIds: ["event-image"], occurrenceCount: 1 });
    expect(
      collectWorkingMediaUsage({
        collection: "cmsPosts",
        document: { type: "newsletter", imageAssetId: "newsletter-image" },
      }),
    ).toEqual({ assetIds: ["newsletter-image"], occurrenceCount: 1 });
    expect(
      collectWorkingMediaUsage({
        collection: "cmsPosts",
        document: { type: "article", heroImage: "pbs-article-art", blocks: [] },
      }),
    ).toEqual({ assetIds: [], occurrenceCount: 0 });
    expect(
      collectWorkingMediaUsage({
        collection: "cmsPosts",
        document: { type: "program", keyArt: "pbs-program-art", keyArtAssetId: "program-library-art" },
      }),
    ).toEqual({ assetIds: ["program-library-art"], occurrenceCount: 1 });
    expect(collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: { blocks: [], metadata: { type: "program", keyArt: "pbs-program-art", keyArtAssetId: "program-library-art" } } })).toEqual({ assetIds: ["program-library-art"], occurrenceCount: 1 });
  });

  it("collects settings media only from schema-declared working values", () => {
    expect(collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      document: {
        schemaVersion: 1,
        values: {
          enabled: true,
          heroAssetId: "hero",
          galleryAssetIds: ["gallery", "hero"],
        },
      },
    })).toEqual({
      assetIds: ["gallery", "hero"],
      occurrenceCount: 3,
    });
  });

  it("collects settings media only from the explicit published snapshot", () => {
    expect(collectPublishedMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      documentVersion: 4,
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      snapshot: {
        schemaVersion: 1,
        values: {
          enabled: true,
          heroAssetId: "published-hero",
          galleryAssetIds: [],
        },
        sourceVersion: 4,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
    })).toEqual({
      assetIds: ["published-hero"],
      occurrenceCount: 1,
    });
  });

  it("fails closed when a settings owner has no server-owned schema", () => {
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      document: { values: { enabled: true } },
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
    })).toThrow(/settings document id/i);
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "unknown-settings",
      document: { schemaVersion: 1, values: { enabled: true } },
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
    })).toThrow(/settings schema/i);
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      document: { values: { enabled: true } },
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
    })).toThrow(/schema version/i);
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      document: { schemaVersion: 99, values: { enabled: true } },
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
    })).toThrow(/settings schema/i);
  });

  it("resolves working and published media against their historical schema versions", () => {
    expect(collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      document: {
        schemaVersion: 2,
        values: { enabled: true, replacementAssetId: "replacement" },
      },
    })).toEqual({ assetIds: ["replacement"], occurrenceCount: 1 });

    expect(() => collectPublishedMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      documentVersion: 2,
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      snapshot: {
        schemaVersion: 1,
        values: { enabled: true, galleryAssetIds: [] },
        sourceVersion: 3,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
    })).toThrow(/source version/i);
  });

  it("applies the shared media bounds to settings occurrences", () => {
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      document: {
        schemaVersion: 1,
        values: {
          enabled: true,
          galleryAssetIds: Array.from(
            { length: MAX_MEDIA_USAGE_ASSETS + 1 },
            (_, index) => `asset-${index}`,
          ),
        },
      },
    })).toThrow(/100 unique/i);
    expect(() => collectWorkingMediaUsage({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      settingsSchemas: FIXTURE_SETTINGS_SCHEMAS,
      document: {
        schemaVersion: 1,
        values: {
          enabled: true,
          heroAssetId: "asset-extra-occurrence",
          galleryAssetIds: Array.from(
            { length: MAX_MEDIA_OCCURRENCES },
            () => "asset-reused",
          ),
        },
      },
    })).toThrow(/200 occurrences/i);
  });

  it("refuses invalid ids and bounded-record overflow", () => {
    expect(() =>
      collectWorkingMediaUsage({
        collection: "cmsPages",
        document: { blocks: [image("bad/id")] },
      }),
    ).toThrow(/valid media asset id/i);

    const tooManyAssets = Array.from(
      { length: MAX_MEDIA_USAGE_ASSETS + 1 },
      (_, index) => image(`asset-${index}`),
    );
    expect(() =>
      collectWorkingMediaUsage({
        collection: "cmsPages",
        document: { blocks: tooManyAssets },
      }),
    ).toThrow(/100 unique/i);

    const tooManyOccurrences = Array.from(
      { length: MAX_MEDIA_OCCURRENCES + 1 },
      () => image("reused"),
    );
    expect(() =>
      collectWorkingMediaUsage({
        collection: "cmsPages",
        document: { blocks: tooManyOccurrences },
      }),
    ).toThrow(/200 occurrences/i);
  });

  it("writes the bounded state and source version contract", () => {
    expect(
      mediaUsageDocument({
        state: "published",
        sourceVersion: 11,
        usage: { assetIds: ["asset-one"], occurrenceCount: 2 },
      }),
    ).toEqual({
      state: "published",
      sourceVersion: 11,
      assetIds: ["asset-one"],
      occurrenceCount: 2,
    });
  });

  it("reads and verifies the private record and exact public projection", async () => {
    const privateRecord = {
      lifecycle: "active",
      source: "site_seed",
      url: "https://media.njpbs.org/cms-media/news/asset-one/hash.png",
      altText: "Studio",
      mimeType: "image/png",
      width: 1600,
      height: 900,
    };
    const projection = {
      url: privateRecord.url,
      altText: privateRecord.altText,
      mimeType: privateRecord.mimeType,
      width: privateRecord.width,
      height: privateRecord.height,
    };
    const refs = new Map([
      ["media_assets/asset-one", { exists: true, data: () => privateRecord }],
      [
        "media_assets_public/asset-one",
        { exists: true, data: () => projection },
      ],
    ]);
    const usageRef = { path: "cmsPages/home/mediaUsage/published" };
    const firestore = {
      collection: (collection) => ({
        doc: (id) =>
          collection === "cmsPages/home/mediaUsage"
            ? usageRef
            : { path: `${collection}/${id}` },
      }),
    };
    const transaction = {
      get: vi.fn(async (ref) => refs.get(ref.path)),
    };

    const prepared = await prepareMediaUsageWrite({
      firestore,
      transaction,
      collection: "cmsPages",
      documentId: "home",
      state: "published",
      sourceVersion: 4,
      usage: { assetIds: ["asset-one"], occurrenceCount: 1 },
    });

    expect(transaction.get).toHaveBeenCalledTimes(3);
    expect(prepared).toEqual({
      ref: usageRef,
      document: {
        state: "published",
        sourceVersion: 4,
        assetIds: ["asset-one"],
        occurrenceCount: 1,
      },
    });
  });

  it("prepares working and published states with one read per unioned asset triplet", async () => {
    const records = Object.fromEntries(
      ["shared", "working-only", "published-only"].flatMap((assetId) => {
        const privateRecord = {
          lifecycle: "active",
          source: "site_seed",
          url: `https://media.njpbs.org/${assetId}.png`,
          altText: null,
          mimeType: "image/png",
          width: 1600,
          height: 900,
        };
        return [
          [`media_assets/${assetId}`, { exists: true, data: () => privateRecord }],
          [
            `media_assets_public/${assetId}`,
            {
              exists: true,
              data: () => ({
                url: privateRecord.url,
                altText: privateRecord.altText,
                mimeType: privateRecord.mimeType,
                width: privateRecord.width,
                height: privateRecord.height,
              }),
            },
          ],
        ];
      }),
    );
    const transaction = {
      get: vi.fn(async (ref) => records[ref.path]),
    };
    const firestore = {
      collection: (collection) => ({
        doc: (id) => ({ path: `${collection}/${id}` }),
      }),
    };

    const prepared = await prepareMediaUsageWrites({
      firestore,
      transaction,
      collection: "cmsPages",
      documentId: "home",
      states: [
        {
          state: "working",
          sourceVersion: 8,
          usage: {
            assetIds: ["shared", "working-only"],
            occurrenceCount: 2,
          },
        },
        {
          state: "published",
          sourceVersion: 7,
          usage: {
            assetIds: ["published-only", "shared"],
            occurrenceCount: 2,
          },
        },
      ],
    });

    expect(transaction.get).toHaveBeenCalledTimes(9);
    expect(prepared).toEqual({
      working: {
        ref: { path: "cmsPages/home/mediaUsage/working" },
        document: {
          state: "working",
          sourceVersion: 8,
          assetIds: ["shared", "working-only"],
          occurrenceCount: 2,
        },
      },
      published: {
        ref: { path: "cmsPages/home/mediaUsage/published" },
        document: {
          state: "published",
          sourceVersion: 7,
          assetIds: ["published-only", "shared"],
          occurrenceCount: 2,
        },
      },
    });
  });

  it("keeps the two-state union bounded at 200 assets and 600 reads", async () => {
    const workingIds = Array.from({ length: MAX_MEDIA_USAGE_ASSETS }, (_, index) =>
      `working-${String(index).padStart(3, "0")}`,
    );
    const publishedIds = Array.from(
      { length: MAX_MEDIA_USAGE_ASSETS },
      (_, index) => `published-${String(index).padStart(3, "0")}`,
    );
    const transaction = {
      get: vi.fn(async (ref) => {
        const assetId = ref.path.split("/").at(-1);
        const privateRecord = {
          lifecycle: "active",
          source: "site_seed",
          url: `https://media.njpbs.org/${assetId}.png`,
          altText: null,
          mimeType: "image/png",
          width: 1,
          height: 1,
        };
        if (ref.path.startsWith("system/media/replacements/")) {
          return { exists: false, data: () => undefined };
        }
        return ref.path.startsWith("media_assets_public/")
          ? {
              exists: true,
              data: () => ({
                url: privateRecord.url,
                altText: privateRecord.altText,
                mimeType: privateRecord.mimeType,
                width: privateRecord.width,
                height: privateRecord.height,
              }),
            }
          : { exists: true, data: () => privateRecord };
      }),
    };

    await expect(
      prepareMediaUsageWrites({
        firestore: {
          collection: (collection) => ({
            doc: (id) => ({ path: `${collection}/${id}` }),
          }),
        },
        transaction,
        collection: "cmsPages",
        documentId: "home",
        states: [
          {
            state: "working",
            sourceVersion: 2,
            usage: {
              assetIds: workingIds,
              occurrenceCount: workingIds.length,
            },
          },
          {
            state: "published",
            sourceVersion: 1,
            usage: {
              assetIds: publishedIds,
              occurrenceCount: publishedIds.length,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({
      working: { document: { assetIds: workingIds } },
      published: { document: { assetIds: publishedIds } },
    });
    expect(transaction.get).toHaveBeenCalledTimes(600);
  });

  it("admits uploaded assets only after the coordinated deployment is ready", async () => {
    const privateRecord = {
      lifecycle: "active",
      source: "upload",
      url: "https://media.njpbs.org/cms-media/news/asset-one/hash.png",
      altText: "Studio",
      mimeType: "image/png",
      width: 1600,
      height: 900,
    };
    const projection = {
      url: privateRecord.url,
      altText: privateRecord.altText,
      mimeType: privateRecord.mimeType,
      width: privateRecord.width,
      height: privateRecord.height,
    };
    const refs = new Map([
      ["media_assets/asset-one", { exists: true, data: () => privateRecord }],
      [
        "media_assets_public/asset-one",
        { exists: true, data: () => projection },
      ],
    ]);
    const firestore = {
      collection: (collection) => ({
        doc: (id) => ({ path: `${collection}/${id}` }),
      }),
    };
    const transaction = {
      get: vi.fn(async (ref) => refs.get(ref.path)),
    };
    const input = {
      firestore,
      transaction,
      collection: "cmsPages",
      documentId: "home",
      sourceVersion: 4,
      usage: { assetIds: ["asset-one"], occurrenceCount: 1 },
    };

    await expect(
      prepareMediaUsageWrite({ ...input, state: "working" }),
    ).resolves.toMatchObject({
      document: { state: "working", assetIds: ["asset-one"] },
    });
    await expect(
      prepareMediaUsageWrite({ ...input, state: "published" }),
    ).rejects.toThrow(/public deployment coordination/i);

    refs.set("system/publicDeployment", {
      exists: true,
      data: () => ({
        schemaVersion: 1,
        mediaLifecycleReady: true,
        state: "idle",
        activeGeneration: 7,
        activeDeploymentId: "deployment-7",
        activeCommitSha: "b".repeat(40),
        lastReservedGeneration: 7,
        newestEligibleGeneration: 7,
        newestEligibleBuildBatchId: "build-seven",
      }),
    });
    await expect(
      prepareMediaUsageWrite({ ...input, state: "published" }),
    ).resolves.toMatchObject({
      document: { state: "published", assetIds: ["asset-one"] },
    });
  });

  it("does not add a content reference while the asset binary is being replaced", async () => {
    const privateRecord = {
      lifecycle: "active",
      source: "site_seed",
      url: "https://media.njpbs.org/cms-media/news/asset-one/hash.png",
      altText: "Studio",
      mimeType: "image/png",
      width: 1600,
      height: 900,
    };
    const refs = new Map([
      ["media_assets/asset-one", { exists: true, data: () => privateRecord }],
      [
        "media_assets_public/asset-one",
        {
          exists: true,
          data: () => ({
            url: privateRecord.url,
            altText: privateRecord.altText,
            mimeType: privateRecord.mimeType,
            width: privateRecord.width,
            height: privateRecord.height,
          }),
        },
      ],
      [
        "system/media/replacements/asset-one",
        { exists: true, data: () => ({ state: "object_ready" }) },
      ],
    ]);

    await expect(
      prepareMediaUsageWrite({
        firestore: {
          collection: (collection) => ({
            doc: (id) => ({ path: `${collection}/${id}` }),
          }),
        },
        transaction: {
          get: vi.fn(async (ref) => refs.get(ref.path)),
        },
        collection: "cmsPages",
        documentId: "home",
        state: "working",
        sourceVersion: 4,
        usage: { assetIds: ["asset-one"], occurrenceCount: 1 },
      }),
    ).rejects.toThrow(/file replacement is in progress/i);
  });

  it.each([
    ["missing", undefined],
    ["unknown", "legacy_import"],
  ])("rejects a published asset with a %s source", async (_label, source) => {
    const privateRecord = {
      lifecycle: "active",
      ...(source === undefined ? {} : { source }),
      url: "https://media.njpbs.org/cms-media/news/asset-one/hash.png",
      altText: "Studio",
      mimeType: "image/png",
      width: 1600,
      height: 900,
    };
    const projection = {
      url: privateRecord.url,
      altText: privateRecord.altText,
      mimeType: privateRecord.mimeType,
      width: privateRecord.width,
      height: privateRecord.height,
    };
    const refs = new Map([
      ["media_assets/asset-one", { exists: true, data: () => privateRecord }],
      [
        "media_assets_public/asset-one",
        { exists: true, data: () => projection },
      ],
    ]);

    await expect(
      prepareMediaUsageWrite({
        firestore: {
          collection: (collection) => ({
            doc: (id) => ({ path: `${collection}/${id}` }),
          }),
        },
        transaction: {
          get: vi.fn(async (ref) => refs.get(ref.path)),
        },
        collection: "cmsPages",
        documentId: "home",
        state: "published",
        sourceVersion: 4,
        usage: { assetIds: ["asset-one"], occurrenceCount: 1 },
      }),
    ).rejects.toThrow(/unsupported source/i);
  });

  it.each([
    ["image block", "cmsPages", { blocks: [image("asset-one")] }],
    [
      "image gallery",
      "cmsPages",
      {
        blocks: [
          {
            type: "image_gallery",
            data: { images: [{ assetId: "asset-one" }] },
          },
        ],
      },
    ],
    [
      "card image",
      "cmsPages",
      {
        blocks: [
          {
            type: "card_grid",
            data: { cards: [{ imageAssetId: "asset-one" }] },
          },
        ],
      },
    ],
    ["social image", "cmsPages", { social: { imageAssetId: "asset-one" } }],
    ["post lead image", "cmsPosts", { type: "post", heroImage: "asset-one" }],
    ["sponsor logo", "cmsPosts", { type: "sponsor", logoAssetId: "asset-one" }],
    ["newsletter image", "cmsPosts", { type: "newsletter", imageAssetId: "asset-one" }],
  ])(
    "refuses non-image media in the %s slot",
    async (_label, collection, document) => {
      const privateRecord = {
        lifecycle: "active",
        url: "https://media.njpbs.org/cms-media/general/asset-one/hash.pdf",
        altText: null,
        mimeType: "application/pdf",
        width: null,
        height: null,
      };
      const projection = {
        url: privateRecord.url,
        altText: privateRecord.altText,
        mimeType: privateRecord.mimeType,
        width: privateRecord.width,
        height: privateRecord.height,
      };
      const transaction = {
        get: vi
          .fn()
          .mockResolvedValueOnce({ exists: true, data: () => privateRecord })
          .mockResolvedValueOnce({ exists: true, data: () => projection }),
      };
      const firestore = {
        collection: (name) => ({
          doc: (id) => ({ path: `${name}/${id}` }),
        }),
      };

      await expect(
        prepareMediaUsageWrite({
          firestore,
          transaction,
          collection,
          documentId: "content-one",
          state: "working",
          sourceVersion: 4,
          usage: collectWorkingMediaUsage({ collection, document }),
        }),
      ).rejects.toThrow(/must be an image/i);
    },
  );

  it.each([
    ["missing private record", undefined, undefined],
    [
      "inactive private record",
      { lifecycle: "tombstoned" },
      { url: "https://media.njpbs.org/a.png" },
    ],
    [
      "missing public projection",
      {
        lifecycle: "active",
        url: "https://media.njpbs.org/a.png",
        altText: null,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
      undefined,
    ],
    [
      "inconsistent public projection",
      {
        lifecycle: "active",
        url: "https://media.njpbs.org/a.png",
        altText: null,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
      {
        url: "https://media.njpbs.org/other.png",
        altText: null,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    ],
  ])("refuses a %s", async (_label, privateRecord, projection) => {
    const snapshot = (value) => ({
      exists: value !== undefined,
      data: () => value,
    });
    const transaction = {
      get: vi
        .fn()
        .mockResolvedValueOnce(snapshot(privateRecord))
        .mockResolvedValueOnce(snapshot(projection)),
    };
    const firestore = {
      collection: (collection) => ({
        doc: (id) => ({ path: `${collection}/${id}` }),
      }),
    };

    await expect(
      prepareMediaUsageWrite({
        firestore,
        transaction,
        collection: "cmsPages",
        documentId: "home",
        state: "working",
        sourceVersion: 4,
        usage: { assetIds: ["asset-one"], occurrenceCount: 1 },
      }),
    ).rejects.toBeInstanceOf(MediaUsageError);
  });
});

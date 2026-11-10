import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import updateMedia from "../../functions/update-media.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const { formatMediaEtag } = mediaLibrary;
const {
  createCmsUpdateMediaMetadataHandler,
  validateMediaMetadataPatch,
} = updateMedia;

let db;

function makeReq({
  method = "POST",
  body = {},
  headers = { "content-type": "application/json" },
} = {}) {
  return { method, body, headers, ip: "203.0.113.17" };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLocaleLowerCase(), value);
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

function actor(grants = [{ role: "editor" }]) {
  return {
    uid: "editor-1",
    email: "editor@example.org",
    principal: { id: "editor-1", grants },
  };
}

function record(overrides = {}) {
  return {
    id: "asset-one",
    name: "Studio control room",
    originalName: "studio.png",
    category: "news",
    categories: ["news"],
    tags: ["studio"],
    description: "Old description",
    altText: "Old alt text",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 128,
    width: 1,
    height: 1,
    contentHash: "abc123",
    storageKey: "cms-media/news/asset-one/hash.png",
    url: "https://media.njpbs.org/cms-media/news/asset-one/hash.png",
    lifecycle: "active",
    source: "upload",
    version: 2,
    createdAt: "2026-08-13T12:00:00.000Z",
    createdBy: "editor-before",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "editor-before",
    ...overrides,
  };
}

async function docsIn(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("update-media.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  await Promise.all([
    ["news", true],
    ["arts", true],
    ["archived", false],
  ].map(([id, active], order) =>
    db.collection("mediaCategories").doc(id).set({
      id,
      label: id,
      description: "Test category",
      order,
      active,
      version: 1,
    })),
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("cmsUpdateMediaMetadata", () => {
  it.each(["general", "staff-profile"])("lets a Watch Editor manage %s while denying a Viewer", async (category) => {
    await db.collection("media_assets").doc("asset-one").set(record({ category, categories: [category] }));
    const request = makeReq({
      body: { assetId: "asset-one", metadata: { name: "New name" } },
      headers: { "content-type": "application/json", "if-match": formatMediaEtag("asset-one", 2) },
    });
    const run = (role) => createCmsUpdateMediaMetadataHandler({
      firestore: db, requirePrincipalFn: async () => actor([{ role, sections: ["watch"], registeredMediaSections: ["watch"] }]),
    });
    const viewer = makeRes();
    await run("staff")(request, viewer);
    expect(viewer.statusCode).toBe(404);
    expect((await db.collection("media_assets").doc("asset-one").get()).data().name).toBe("Studio control room");
    const editor = makeRes();
    await run("editor")(request, editor);
    expect(editor.statusCode).toBe(200);
    expect((await db.collection("media_assets").doc("asset-one").get()).data()).toMatchObject({ name: "New name", category });
  });

  it("accepts only a bounded asset id and an explicit partial metadata allowlist", () => {
    expect(validateMediaMetadataPatch({})).toMatch(/assetId/i);
    expect(validateMediaMetadataPatch({ assetId: "bad/path", metadata: { name: "Name" } }))
      .toMatch(/assetId/i);
    expect(validateMediaMetadataPatch({ assetId: "asset-one", metadata: {} }))
      .toMatch(/at least one/i);
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      metadata: { category: "arts" },
    })).toMatch(/unknown metadata field/i);
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      metadata: { name: "New name" },
      lifecycle: "tombstoned",
    })).toMatch(/unknown request field/i);
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      metadata: {
        originalName: "main-control-room.png",
        name: "New name",
        tags: ["studio"],
      },
    })).toBeNull();
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      metadata: { categories: ["news", "news"] },
    })).toMatch(/duplicates/i);
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      metadata: { categories: Array.from({ length: 9 }, (_, index) => `desk-${index}`) },
    })).toMatch(/1 to 8/i);
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      action: "delete",
    })).toBeNull();
    expect(validateMediaMetadataPatch({
      assetId: "asset-one",
      action: "delete",
      metadata: { name: "New name" },
    })).toMatch(/cannot be included/i);
  });

  it("requires a strong If-Match condition before reading the asset", async () => {
    const firestore = { runTransaction: vi.fn() };
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor()),
    });
    const res = makeRes();

    await handler(makeReq({
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect(res.statusCode).toBe(428);
    expect(firestore.runTransaction).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("updates allowed metadata, projection alt text, version, and audit atomically", async () => {
    const before = record();
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(before),
      db.collection("media_assets_public").doc("asset-one").set({
        url: before.url,
        altText: before.altText,
        mimeType: before.mimeType,
        width: before.width,
        height: before.height,
      }),
    ]);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-13T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: {
        assetId: "asset-one",
        metadata: {
          originalName: "main-control-room.png",
          name: "Main control room",
          description: null,
          altText: "Monitors and switchers in the control room",
          credit: null,
          tags: ["studio", "switcher", "Studio"],
        },
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 3));
    expect(res.body).toMatchObject({
      success: true,
      changed: true,
      asset: {
        id: "asset-one",
        originalName: "main-control-room.png",
        name: "Main control room",
        description: null,
        altText: "Monitors and switchers in the control room",
        credit: null,
        tags: ["studio", "switcher"],
        category: "news",
        version: 3,
        updatedBy: "editor-1",
      },
    });
    const stored = (await db.collection("media_assets").doc("asset-one").get()).data();
    expect(stored).toMatchObject({
      originalName: "main-control-room.png",
      contentHash: "abc123",
      storageKey: "cms-media/news/asset-one/hash.png",
      url: before.url,
      category: "news",
      version: 3,
    });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).data())
      .toEqual({
        url: before.url,
        altText: "Monitors and switchers in the control room",
        mimeType: "image/png",
        width: 1,
        height: 1,
      });
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "editor-1",
        action: "media.metadata.update",
        target: "media_assets/asset-one",
        before: expect.objectContaining({
          originalName: "studio.png",
          version: 2,
          name: "Studio control room",
        }),
        after: expect.objectContaining({
          originalName: "main-control-room.png",
          version: 3,
          name: "Main control room",
        }),
      }),
    ]);

    const updatedSearch = mediaLibrary.selectMediaLibrary(
      [res.body.asset],
      mediaLibrary.parseMediaListRequest({ q: "main-control-room.png" }),
    );
    const previousSearch = mediaLibrary.selectMediaLibrary(
      [res.body.asset],
      mediaLibrary.parseMediaListRequest({ q: "studio.png" }),
    );
    expect(updatedSearch.total).toBe(1);
    expect(previousSearch.total).toBe(0);
  });

  it("returns the typed conflict for an active record that remains invalid", async () => {
    const before = record({ sizeBytes: 0 });
    await db.collection("media_assets").doc("asset-one").set(before);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-13T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: {
        assetId: "asset-one",
        metadata: { description: "New description" },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("This media asset record is invalid.");
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toEqual(before);
    expect(await docsIn("admin_logs")).toEqual([]);
  });

  it("edits descriptive assignments without transferring the owning scope or object", async () => {
    const before = record();
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(before),
      db.collection("media_assets_public").doc("asset-one").set({
        url: before.url,
        altText: before.altText,
        mimeType: before.mimeType,
        width: before.width,
        height: before.height,
      }),
    ]);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-13T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: {
        assetId: "asset-one",
        metadata: { categories: ["arts", "news"] },
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.asset).toMatchObject({
      category: "news",
      categories: ["news", "arts"],
      version: 3,
      url: before.url,
    });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({
        category: "news",
        categories: ["news", "arts"],
        storageKey: before.storageKey,
        contentHash: before.contentHash,
      });
  });

  it.each([
    ["an empty filename", "", /required/i],
    ["path separators", "folder/studio.png", /invalid characters/i],
    ["a control character", "studio\u0000.png", /invalid characters/i],
    ["a C1 control character", "studio\u0085.png", /invalid characters/i],
    [
      "an overlong filename",
      `${"a".repeat(252)}.png`,
      /255 characters or fewer/i,
    ],
    ["a MIME mismatch", "studio.jpg", /must use \.png for image\/png/i],
  ])(
    "rejects %s without changing the asset",
    async (_label, originalName, message) => {
      await db.collection("media_assets").doc("asset-one").set(record());
      const handler = createCmsUpdateMediaMetadataHandler({
        firestore: db,
        requirePrincipalFn: async () => actor(),
      });
      const res = makeRes();

      await handler(makeReq({
        headers: {
          "content-type": "application/json",
          "if-match": formatMediaEtag("asset-one", 2),
        },
        body: { assetId: "asset-one", metadata: { originalName } },
      }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(message);
      expect((await db.collection("media_assets").doc("asset-one").get()).data())
        .toMatchObject({ originalName: "studio.png", version: 2 });
      expect(await docsIn("admin_logs")).toHaveLength(0);
    },
  );

  it("keeps station seed filenames read-only", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({
      source: "site_seed",
    }));
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: {
        assetId: "asset-one",
        metadata: { originalName: "renamed-studio.png" },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/only uploaded media filenames/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ originalName: "studio.png", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("returns 412 for a stale uploaded filename edit and writes nothing", async () => {
    await db.collection("media_assets").doc("asset-one").set(record());
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 1),
      },
      body: {
        assetId: "asset-one",
        metadata: { originalName: "main-control-room.png" },
      },
    }), res);

    expect(res.statusCode).toBe(412);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 2));
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ originalName: "studio.png", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("deletes an unused upload from the library while retaining its immutable file", async () => {
    await db.doc("system/mediaDiscovery").set({ revision: 0, admission: { schema: 1, activeCount: 1, revision: 0 } });
    const before = record({
      thumbnails: [{ storageKey: "cms-media/news/asset-one/thumb.webp", url: "https://media.njpbs.org/thumb.webp", width: 100, height: 100 }],
      master: { key: "masters/ab/original.png" },
    });
    const projection = {
      url: before.url,
      altText: before.altText,
      mimeType: before.mimeType,
      width: before.width,
      height: before.height,
    };
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(before),
      db.collection("media_assets_public").doc("asset-one").set(projection),
    ]);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-13T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().withdrawalRevision).toBe(1);
    expect(res.statusCode).toBe(200);
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(0);
    expect(res.body).toEqual({
      success: true,
      changed: true,
      deleted: true,
      asset: {
        id: "asset-one",
        lifecycle: "tombstoned",
        version: 3,
        etag: formatMediaEtag("asset-one", 3),
      },
    });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({
        lifecycle: "tombstoned",
        version: 3,
        tombstonedAt: "2026-08-13T14:00:00.000Z",
        tombstonedBy: "editor-1",
        purgeAfter: "2026-09-12T14:00:00.000Z",
      });
    expect((await db.collection("media_assets_public").doc("asset-one").get()).exists)
      .toBe(false);
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.library.delete",
        before: { lifecycle: "active", version: 2 },
        after: { lifecycle: "tombstoned", version: 3,
          purgeAfter: "2026-09-12T14:00:00.000Z", purgeEntryId: "asset:asset-one" },
      }),
    ]);
    const queued = (await db.collection("mediaPurgeQueue").doc("asset:asset-one").get()).data();
    expect(queued).toMatchObject({ state: "pending", eligibleAt: "2026-09-12T14:00:00.000Z" });
    expect(queued.objects).toContainEqual({ store: "public", key: before.storageKey });
    expect(queued.objects).toContainEqual({ store: "public", key: before.thumbnails[0].storageKey });
    expect(queued.objects).toContainEqual({ store: "masters", key: before.master.key });
  });

  it.each([
    ["a working author profile", "authorProfiles/author-one/mediaUsage/working", "working"],
    ["published content", "cmsPages/page-one/mediaUsage/published", "published"],
    ["a deployed generation", "cmsPages/page-one/mediaUsage/deployed-7", "deployed"],
  ])("refuses to delete an asset used by %s", async (_label, usagePath, state) => {
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(record()),
      db.doc(usagePath).set({
        state,
        assetIds: ["asset-one"],
        occurrenceCount: 1,
        sourceVersion: 2,
      }),
    ]);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/still used by content/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("refuses to delete a seeded station asset", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({
      source: "site_seed",
    }));
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/only uploaded media/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
  });

  it("denies a Viewer for absent and existing assets without an audit write", async () => {
    await db.collection("media_assets").doc("asset-one").set(record());
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor([
        { role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] },
      ]),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const body = { assetId: "asset-one", metadata: { name: "New name" } };
    const headers = {
      "content-type": "application/json",
      "if-match": formatMediaEtag("asset-one", 2),
    };

    const forbidden = makeRes();
    await handler(makeReq({ body, headers }), forbidden);
    const absent = makeRes();
    await handler(makeReq({
      body: { ...body, assetId: "missing" },
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("missing", 2),
      },
    }), absent);

    expect(forbidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(forbidden.body).toEqual(absent.body);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("returns 412 with the current ETag for a stale delete and writes nothing", async () => {
    await db.collection("media_assets").doc("asset-one").set(record());
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 1),
      },
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect(res.statusCode).toBe(412);
    expect(res.headers.get("etag")).toBe(formatMediaEtag("asset-one", 2));
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("does not race a delete with a lease-backed binary replacement", async () => {
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(record()),
      db.collection("system").doc("media").collection("replacements").doc("asset-one").set({
        operation: "replacement",
        state: "object_ready",
        assetId: "asset-one",
        attemptId: "replace-attempt-one",
      }),
    ]);
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", action: "delete" },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/file replacement is in progress/i);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ lifecycle: "active", version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("returns an unchanged current asset without an audit row", async () => {
    await db.collection("media_assets").doc("asset-one").set(record());
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", metadata: { categories: ["news"] } },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.asset.version).toBe(2);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });


  it("clears a completed metadata request atomically while keeping person-edited fields", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({ metadataUpdateRequested: true }));
    const handler = createCmsUpdateMediaMetadataHandler({ firestore: db, requirePrincipalFn: async () => actor() });
    async function complete(version, metadata = { metadataUpdateRequested: false, tags: ["studio", "broadcast"] }) {
      const res = makeRes();
      await handler(makeReq({ body: { assetId: "asset-one", metadata }, headers: { "content-type": "application/json", "if-match": formatMediaEtag("asset-one", version) } }), res);
      return res;
    }
    expect((await complete(2, { metadataUpdateRequested: "false" })).statusCode).toBe(400);
    expect((await complete(1)).statusCode).toBe(412);
    expect((await db.collection("media_assets").doc("asset-one").get()).data().metadataUpdateRequested).toBe(true);
    const completed = await complete(2);
    expect(completed.statusCode).toBe(200);
    expect(completed.body.asset).toMatchObject({ metadataUpdateRequested: false, name: "Studio control room", description: "Old description", altText: "Old alt text", tags: ["studio", "broadcast"], version: 3 });
    expect((await db.collection("media_assets").doc("asset-one").get()).data().metadataUpdateRequested).toBe(false);
    expect((await docsIn("admin_logs"))[0].after.metadataUpdateRequested).toBe(false);
  });

  it("marks sweep alt text as generated until a person changes the text", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({ altText: null }));
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    async function update(version, metadata) {
      const res = makeRes();
      await handler(makeReq({
        headers: {
          "content-type": "application/json",
          "if-match": formatMediaEtag("asset-one", version),
        },
        body: { assetId: "asset-one", metadata },
      }), res);
      return res;
    }

    expect((await update(2, { altTextGenerated: true })).statusCode).toBe(400);
    expect((await update(2, { altTextGenerated: false, altText: "A studio" })).statusCode)
      .toBe(400);

    const generated = await update(2, {
      altText: "Monitors in a studio",
      altTextGenerated: true,
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.body.asset).toMatchObject({ altTextGenerated: true, version: 3 });

    const tagged = await update(3, { tags: ["studio", "control room"] });
    expect(tagged.body.asset).toMatchObject({ altTextGenerated: true, version: 4 });

    const edited = await update(4, { altText: "The main control room" });
    expect(edited.body.asset).toMatchObject({ altTextGenerated: false, version: 5 });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ altTextGenerated: false });
    expect(
      (await db.collection("media_assets_public").doc("asset-one").get()).data(),
    ).not.toHaveProperty("altTextGenerated");
  });

  it("rejects a new archived assignment but permits removing an existing one", async () => {
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    await db.collection("media_assets").doc("asset-one").set(record());
    const rejected = makeRes();
    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: {
        assetId: "asset-one",
        metadata: { categories: ["news", "archived"] },
      },
    }), rejected);
    expect(rejected.statusCode).toBe(400);

    await db.collection("media_assets").doc("asset-one").set(record({
      categories: ["news", "archived"],
    }));
    const removed = makeRes();
    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", metadata: { categories: ["news"] } },
    }), removed);
    expect(removed.statusCode).toBe(200);
    expect(removed.body.asset.categories).toEqual(["news"]);
  });

  it("does not rewrite legacy metadata when the patch is logically unchanged", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({
      tags: [" studio ", "Studio"],
    }));
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", metadata: { name: "Studio control room" } },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.asset.version).toBe(2);
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ tags: [" studio ", "Studio"], version: 2 });
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("allows a patch to repair legacy metadata that fails current validation", async () => {
    await db.collection("media_assets").doc("asset-one").set(record({
      license: null,
    }));
    const handler = createCmsUpdateMediaMetadataHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-13T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      headers: {
        "content-type": "application/json",
        "if-match": formatMediaEtag("asset-one", 2),
      },
      body: { assetId: "asset-one", metadata: { license: "NJ PBS owned" } },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: true, asset: { version: 3 } });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ license: "NJ PBS owned", version: 3 });
    expect(await docsIn("admin_logs")).toHaveLength(1);
  });
});

it("change-log: public media metadata appends with its projection and private metadata does not", async () => {
  const { initialPublicDeploymentPointer } = await import("../../functions/lib/public-deployment.js");
  await db.doc("system/publicDeployment").set({ ...initialPublicDeploymentPointer(), activeCommitSha: "a".repeat(40),
    activeGeneration: 1, activeDeploymentId: "fixture-release", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await enrollPublicReleaseLog(db);
  await db.doc("media_assets/asset-one").set(record());
  const handler = createCmsUpdateMediaMetadataHandler({ firestore: db, requirePrincipalFn: async () => actor() });
  const res = makeRes();
  await handler(makeReq({ body: { assetId: "asset-one", metadata: { altText: "Current public alt" } },
    headers: { "content-type": "application/json", "if-match": formatMediaEtag("asset-one", 2) } }), res);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect((await publicReleaseEntries(db))[0].changes).toMatchObject([{ kind: "media", id: "asset-one", action: "dependency", sourceVersion: 3 }]);
  expect((await db.doc("media_assets_public/asset-one").get()).data().altText).toBe("Current public alt");
  await db.doc("system/publicReleaseChangeLog").set({ enabled: true, malformed: true });
  const privateSave = makeRes();
  await handler(makeReq({ body: { assetId: "asset-one", metadata: { description: "Private library description" } },
    headers: { "content-type": "application/json", "if-match": formatMediaEtag("asset-one", 3) } }), privateSave);
  expect(privateSave.statusCode, JSON.stringify(privateSave.body)).toBe(200);
  expect(await publicReleaseEntries(db)).toHaveLength(1);
});

import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldPath } from "firebase-admin/firestore";
import adminPkg from "../helpers/firebase-admin.js";
import mediaContract from "../../functions/lib/media-contract.js";
import repair from "../../functions/scan-media-usage.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const { mediaProjection } = mediaContract;
const {
  MediaUsageRepairError,
  decodeMediaUsageRepairCursor,
  deriveMediaUsageStates,
  inspectMediaUsageOwner,
  readMediaUsageRepairOwners,
  repairMediaUsageOwner,
  scanMediaUsagePage,
} = repair;

const CURSOR_SECRET = "test-media-usage-cursor-secret";

const SETTINGS_SCHEMAS = Object.freeze({
  "fixture-settings": Object.freeze({
    currentVersion: 2,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          enabled: Object.freeze({ kind: "boolean", required: true }),
          heroAssetId: Object.freeze({ kind: "assetId" }),
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

let db;

function image(assetId, { visible = true } = {}) {
  return {
    id: `block-${assetId}`,
    type: "image",
    order: 0,
    visible,
    data: { assetId, alt: "Image" },
  };
}

function page(overrides = {}) {
  return {
    id: "home",
    title: "Home",
    status: "published",
    publiclyVisible: true,
    version: 8,
    blocks: [image("working-image"), image("hidden-image", { visible: false })],
    published: {
      sourceVersion: 7,
      publishedAt: "2026-08-14T12:30:00.000Z",
      publishedBy: "editor-before",
      blocks: [image("published-image"), image("hidden-image", { visible: false })],
      metadata: { title: "Home" },
    },
    ...overrides,
  };
}

function settings(overrides = {}) {
  return {
    schemaVersion: 2,
    version: 4,
    values: { enabled: true, replacementAssetId: "working-setting" },
    published: {
      schemaVersion: 1,
      values: { enabled: true, heroAssetId: "published-setting" },
      sourceVersion: 3,
      publishedAt: "2026-08-14T12:30:00.000Z",
    },
    ...overrides,
  };
}

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function seedAsset(
  assetId,
  { lifecycle = "active", source = "site_seed", projection = true } = {},
) {
  const stored = {
    id: assetId,
    lifecycle,
    source,
    url: `https://media.njpbs.org/${assetId}.png`,
    altText: null,
    mimeType: "image/png",
    width: 1600,
    height: 900,
  };
  await db.collection("media_assets").doc(assetId).set(stored);
  if (projection) {
    await db
      .collection("media_assets_public")
      .doc(assetId)
      .set(mediaProjection(stored));
  }
}

function testAuditEntry(fields) {
  return {
    ...fields,
    timestamp: "server-time",
    at: "2026-08-14T13:00:00.000Z",
  };
}

function instrumentedFirestore() {
  const collections = [];
  const firestore = {
    collection(name) {
      collections.push(name);
      return db.collection(name);
    },
    runTransaction: vi.fn((callback) => db.runTransaction(callback)),
  };
  return { firestore, collections };
}

async function documents(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("scan-media-usage.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("scanMediaUsage canonical state derivation", () => {
  it("keeps the retained snapshot while a public working revision is a draft", () => {
    const states = deriveMediaUsageStates({
      collection: "cmsPages",
      documentId: "home",
      document: page({ status: "draft" }),
    });

    expect(states).toEqual({
      working: {
        state: "working",
        sourceVersion: 8,
        usage: {
          assetIds: ["hidden-image", "working-image"],
          occurrenceCount: 2,
        },
      },
      published: {
        state: "published",
        sourceVersion: 7,
        usage: { assetIds: ["published-image"], occurrenceCount: 1 },
      },
    });
  });

  it("uses empty published state after unpublish and keeps archived working usage", () => {
    const unpublished = deriveMediaUsageStates({
      collection: "cmsPages",
      documentId: "home",
      document: page({ status: "draft", publiclyVisible: false }),
    });
    const archived = deriveMediaUsageStates({
      collection: "cmsPages",
      documentId: "home",
      document: page({ status: "archived", publiclyVisible: false }),
    });

    expect(unpublished.published).toEqual({
      state: "published",
      sourceVersion: 8,
      usage: { assetIds: [], occurrenceCount: 0 },
    });
    expect(archived.working.usage.assetIds).toEqual([
      "hidden-image",
      "working-image",
    ]);
    expect(archived.published.usage).toEqual({
      assetIds: [],
      occurrenceCount: 0,
    });
  });

  it("clears both mutable states for a canonical soft delete", () => {
    const states = deriveMediaUsageStates({
      collection: "cmsPages",
      documentId: "home",
      document: page({
        deleted: true,
        blocks: [image("bad/id")],
        published: { blocks: [image("bad/id")] },
      }),
    });

    expect(states.working).toEqual({
      state: "working",
      sourceVersion: 8,
      usage: { assetIds: [], occurrenceCount: 0 },
    });
    expect(states.published).toEqual({
      state: "published",
      sourceVersion: 8,
      usage: { assetIds: [], occurrenceCount: 0 },
    });
  });

  it("supports the legacy published visibility fallback", () => {
    const document = page();
    delete document.publiclyVisible;

    expect(
      deriveMediaUsageStates({
        collection: "cmsPages",
        documentId: "home",
        document,
      }).published.sourceVersion,
    ).toBe(7);
  });

  it("advances past a legacy block-only published snapshot without a source version", async () => {
    const legacy = page({
      id: "legacy-page",
      published: { blocks: [image("legacy-published-image")] },
    });
    delete legacy.publiclyVisible;
    await Promise.all([
      db.collection("cmsPages").doc("legacy-page").set(legacy),
      db.collection("cmsPosts").doc("later-post").set(page({
        id: "later-post",
        status: "draft",
        publiclyVisible: false,
      })),
      seedAsset("working-image"),
      seedAsset("hidden-image"),
    ]);

    const result = await scanMediaUsagePage({
      firestore: db,
      mode: "dry-run",
      limit: 1,
      actorUid: "operator-1",
      cursorSecret: CURSOR_SECRET,
      documentIdField: FieldPath.documentId(),
    });

    expect(result).toEqual({
      mode: "dry-run",
      summary: {
        scanned: 1,
        wouldRepair: 1,
        repaired: 0,
        unchanged: 0,
        missing: 0,
      },
      nextCursor: expect.any(String),
    });
    expect(
      decodeMediaUsageRepairCursor(result.nextCursor, CURSOR_SECRET),
    ).toEqual({ v: 1, collection: "cmsPages", documentId: "legacy-page" });
    expect(
      (await db.collection("cmsPages/legacy-page/mediaUsage").doc("published").get()).data(),
    ).toBeUndefined();
  });

  it.each([
    [page({ publiclyVisible: "true" }), /public visibility/i],
    [page({ publiclyVisible: true, published: undefined }), /published snapshot/i],
    [page({ publiclyVisible: false, status: "published" }), /lifecycle/i],
    [page({ publiclyVisible: true, status: "archived" }), /lifecycle/i],
    [
      page({ published: { ...page().published, sourceVersion: 9 } }),
      /source version/i,
    ],
  ])("fails closed on a malformed canonical lifecycle or snapshot", (document, message) => {
    expect(() =>
      deriveMediaUsageStates({
        collection: "cmsPages",
        documentId: "home",
        document,
      }),
    ).toThrow(message);
  });

  it("uses exact working and historical published settings schemas", () => {
    const states = deriveMediaUsageStates({
      collection: "cmsSettings",
      documentId: "fixture-settings",
      document: settings(),
      settingsSchemas: SETTINGS_SCHEMAS,
    });

    expect(states.working).toEqual({
      state: "working",
      sourceVersion: 4,
      usage: { assetIds: ["working-setting"], occurrenceCount: 1 },
    });
    expect(states.published).toEqual({
      state: "published",
      sourceVersion: 3,
      usage: { assetIds: ["published-setting"], occurrenceCount: 1 },
    });
    expect(
      deriveMediaUsageStates({
        collection: "cmsSettings",
        documentId: "fixture-settings",
        document: settings({ published: undefined }),
        settingsSchemas: SETTINGS_SCHEMAS,
      }).published,
    ).toEqual({
      state: "published",
      sourceVersion: 4,
      usage: { assetIds: [], occurrenceCount: 0 },
    });
  });
});

describe("scanMediaUsage bounded owner traversal", () => {
  it("uses document-id cursors across only the fixed owner collections", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("z-page").set({ version: 1 }),
      db.collection("cmsPages").doc("a-page").set({ version: 1 }),
      db.collection("cmsPosts").doc("m-post").set({ version: 1 }),
      db.collection("cmsSettings").doc("x-settings").set({ version: 1 }),
      db.collection("system").doc("publicDeployment").set({ activeId: "live" }),
    ]);
    const first = await readMediaUsageRepairOwners({
      firestore: db,
      cursor: null,
      limit: 2,
      documentIdField: FieldPath.documentId(),
    });
    const second = await readMediaUsageRepairOwners({
      firestore: db,
      cursor: { v: 1, collection: "cmsPages", documentId: "z-page" },
      limit: 2,
      documentIdField: FieldPath.documentId(),
    });

    expect(first).toEqual([
      { collection: "cmsPages", documentId: "a-page" },
      { collection: "cmsPages", documentId: "z-page" },
      { collection: "cmsPosts", documentId: "m-post" },
    ]);
    expect(second).toEqual([
      { collection: "cmsPosts", documentId: "m-post" },
      { collection: "cmsSettings", documentId: "x-settings" },
    ]);
    expect(JSON.stringify([...first, ...second])).not.toContain("system");
    expect(JSON.stringify([...first, ...second])).not.toContain("live");
  });
});

describe("scanMediaUsage owner repair", () => {
  it("reports a dry-run repair without usage or audit writes", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page()),
      seedAsset("working-image"),
      seedAsset("hidden-image"),
      seedAsset("published-image"),
      db.collection("cmsPages/home/mediaUsage").doc("working").set({
        state: "working",
        sourceVersion: 1,
        assetIds: ["stale-image"],
        occurrenceCount: 1,
      }),
    ]);
    const { firestore } = instrumentedFirestore();

    await expect(inspectMediaUsageOwner({
      firestore,
      collection: "cmsPages",
      documentId: "home",
      actorUid: "operator-1",
    })).resolves.toEqual({
      status: "would_repair",
      collection: "cmsPages",
      documentId: "home",
      changedStates: ["working", "published"],
    });

    expect(
      (await db.collection("cmsPages/home/mediaUsage").doc("working").get()).data(),
    ).toMatchObject({ sourceVersion: 1, assetIds: ["stale-image"] });
    expect(
      await db.collection("cmsPages/home/mediaUsage").doc("published").get(),
    ).toMatchObject({ exists: false });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("repairs both states in one transaction with compact atomic audit evidence", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page()),
      seedAsset("working-image"),
      seedAsset("hidden-image"),
      seedAsset("published-image"),
    ]);
    await db.collection("cmsPages/home/mediaUsage").doc("working").set({
      state: "working",
      sourceVersion: 1,
      assetIds: Array.from({ length: 120 }, (_, index) => `stale-${index}`),
      occurrenceCount: 120,
    });
    const { firestore, collections } = instrumentedFirestore();

    const result = await repairMediaUsageOwner({
      firestore,
      collection: "cmsPages",
      documentId: "home",
      actorUid: "operator-1",
      actorEmail: "fixture-d01840273b@example.org",
      source: "203.0.113.40",
      adminLogEntryFn: testAuditEntry,
    });

    expect(firestore.runTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "repaired",
      collection: "cmsPages",
      documentId: "home",
      changedStates: ["working", "published"],
    });
    expect(
      (await db.collection("cmsPages/home/mediaUsage").doc("working").get()).data(),
    ).toEqual({
      state: "working",
      sourceVersion: 8,
      assetIds: ["hidden-image", "working-image"],
      occurrenceCount: 2,
    });
    expect(
      (await db.collection("cmsPages/home/mediaUsage").doc("published").get()).data(),
    ).toEqual({
      state: "published",
      sourceVersion: 7,
      assetIds: ["published-image"],
      occurrenceCount: 1,
    });
    const audits = await documents("admin_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUid: "operator-1",
      actorEmail: "fixture-d01840273b@example.org",
      action: "cms.media-usage-repair",
      target: "cmsPages/home",
      before: {
        working: {
          exists: true,
          valid: false,
          assetCount: 101,
          assetCountOverflow: true,
        },
        published: { exists: false, valid: false },
      },
      after: {
        changedStates: ["working", "published"],
        working: {
          exists: true,
          valid: true,
          sourceVersion: 8,
          assetCount: 2,
          occurrenceCount: 2,
        },
        published: {
          exists: true,
          valid: true,
          sourceVersion: 7,
          assetCount: 1,
          occurrenceCount: 1,
        },
      },
      source: "203.0.113.40",
    });
    expect(JSON.stringify(audits[0])).not.toContain("working-image");
    expect(JSON.stringify(audits[0])).not.toContain("published-image");
    expect(collections).not.toContain("system");
    expect(collections.some((name) => name.includes("deployed"))).toBe(false);
    expect(
      (await db.collection("cmsPages/home/mediaUsage").get()).docs.map((doc) => doc.id).sort(),
    ).toEqual(["published", "working"]);
  });

  it("makes an exact no-op without a second audit write", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page()),
      seedAsset("working-image"),
      seedAsset("hidden-image"),
      seedAsset("published-image"),
    ]);
    const { firestore } = instrumentedFirestore();
    const input = {
      firestore,
      collection: "cmsPages",
      documentId: "home",
      actorUid: "operator-1",
      adminLogEntryFn: testAuditEntry,
    };

    expect(await repairMediaUsageOwner(input)).toMatchObject({ status: "repaired" });
    expect(await repairMediaUsageOwner(input)).toEqual({
      status: "unchanged",
      collection: "cmsPages",
      documentId: "home",
      changedStates: [],
    });
    expect(await documents("admin_logs")).toHaveLength(1);
  });

  it("rolls back both usage states when the atomic audit receipt cannot be built", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page()),
      seedAsset("working-image"),
      seedAsset("hidden-image"),
      seedAsset("published-image"),
    ]);
    const { firestore } = instrumentedFirestore();

    await expect(
      repairMediaUsageOwner({
        firestore,
        collection: "cmsPages",
        documentId: "home",
        actorUid: "operator-1",
        adminLogEntryFn: () => {
          throw new Error("audit unavailable");
        },
      }),
    ).rejects.toThrow(/audit unavailable/i);
    expect(await db.collection("cmsPages/home/mediaUsage").get()).toMatchObject({
      empty: true,
    });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("reports a missing owner without writes", async () => {
    const { firestore } = instrumentedFirestore();

    await expect(
      repairMediaUsageOwner({
        firestore,
        collection: "cmsPages",
        documentId: "missing",
        actorUid: "operator-1",
        adminLogEntryFn: testAuditEntry,
      }),
    ).resolves.toEqual({
      status: "missing",
      collection: "cmsPages",
      documentId: "missing",
      changedStates: [],
    });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("does not clear old usage when a canonical reference is tombstoned", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page({
        publiclyVisible: false,
        status: "draft",
        blocks: [image("working-image")],
      })),
      seedAsset("working-image", { lifecycle: "tombstoned", projection: false }),
      db.collection("cmsPages/home/mediaUsage").doc("working").set({
        state: "working",
        sourceVersion: 7,
        assetIds: ["old-reference"],
        occurrenceCount: 1,
      }),
    ]);
    const { firestore } = instrumentedFirestore();

    const repairPromise = repairMediaUsageOwner({
      firestore,
      collection: "cmsPages",
      documentId: "home",
      actorUid: "operator-1",
      adminLogEntryFn: testAuditEntry,
    });
    await expect(repairPromise).rejects.toBeInstanceOf(MediaUsageRepairError);
    await expect(repairPromise).rejects.toMatchObject({ status: 409 });
    await expect(repairPromise).rejects.toThrow(/not available/i);
    expect(
      (await db.collection("cmsPages/home/mediaUsage").doc("working").get()).data(),
    ).toMatchObject({
      sourceVersion: 7,
      assetIds: ["old-reference"],
    });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it.each([
    ["private record is missing", async () => {}],
    [
      "public projection is missing",
      async () => seedAsset("working-image", { projection: false }),
    ],
  ])("preserves old usage when the canonical %s", async (_case, seed) => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page({
        publiclyVisible: false,
        status: "draft",
        blocks: [image("working-image")],
      })),
      seed(),
      db.collection("cmsPages/home/mediaUsage").doc("working").set({
        state: "working",
        sourceVersion: 7,
        assetIds: ["old-reference"],
        occurrenceCount: 1,
      }),
    ]);
    const { firestore } = instrumentedFirestore();

    const repairPromise = repairMediaUsageOwner({
      firestore,
      collection: "cmsPages",
      documentId: "home",
      actorUid: "operator-1",
      adminLogEntryFn: testAuditEntry,
    });
    await expect(repairPromise).rejects.toBeInstanceOf(MediaUsageRepairError);
    await expect(repairPromise).rejects.toMatchObject({ status: 409 });
    expect(
      (await db.collection("cmsPages/home/mediaUsage").doc("working").get()).data(),
    ).toMatchObject({ sourceVersion: 7, assetIds: ["old-reference"] });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("keeps uploaded assets out of a published repair", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("home").set(page({
        blocks: [image("uploaded-image")],
        published: {
          ...page().published,
          blocks: [image("uploaded-image")],
        },
      })),
      seedAsset("uploaded-image", { source: "upload" }),
    ]);
    const { firestore } = instrumentedFirestore();

    await expect(
      repairMediaUsageOwner({
        firestore,
        collection: "cmsPages",
        documentId: "home",
        actorUid: "operator-1",
        adminLogEntryFn: testAuditEntry,
      }),
    ).rejects.toThrow(/public deployment coordination/i);
    expect(await db.collection("cmsPages/home/mediaUsage").get()).toMatchObject({
      empty: true,
    });
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("rejects invalid core inputs before opening a transaction", async () => {
    const { firestore } = instrumentedFirestore();

    await expect(
      repairMediaUsageOwner({
        firestore,
        collection: "cmsPages",
        documentId: "bad/path",
        actorUid: "operator-1",
      }),
    ).rejects.toBeInstanceOf(MediaUsageRepairError);
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });
});

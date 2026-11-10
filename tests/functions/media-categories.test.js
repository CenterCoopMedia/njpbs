import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import mediaCategories from "../../functions/media-categories.js";
import categoryContract from "../../functions/lib/media-categories.js";
import {
  seedMediaCategories,
  verifyMediaCategoriesRegistered,
} from "../../scripts/seed-media-categories.mjs";
import {
  backfillMediaCategoryAssignments,
  verifyMediaCategoryAssignments,
} from "../../scripts/backfill-media-category-assignments.mjs";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const NOW = "2026-08-28T15:00:00.000Z";
let db;

const {
  createCmsListMediaCategoriesHandler,
  createCmsMutateMediaCategoryHandler,
} = mediaCategories;
const {
  formatMediaCategoryEtag,
  normalizeMediaCategoryCreate,
  parseMediaCategoryDefinition,
} = categoryContract;

function response() {
  const res = { body: null, headers: {}, headersSent: false, statusCode: null };
  res.set = (name, value) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

function request(body = {}, headers = {}) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    rawBody: Buffer.from(JSON.stringify(body)),
    ip: "127.0.0.1",
  };
}

function actor(grants = [{ role: "admin" }], overrides = {}) {
  return {
    uid: "admin-1",
    email: "admin@example.org",
    emailVerified: true,
    approvedActive: true,
    principal: { id: "admin-1", grants },
    ...overrides,
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media-categories.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("media category contract", () => {
  it("normalizes a stable category id separately from its editable label", () => {
    expect(
      normalizeMediaCategoryCreate({
        id: "local-news",
        label: "Local news",
        description: "Reporting from New Jersey communities.",
        order: 30,
      }),
    ).toEqual({
      id: "local-news",
      label: "Local news",
      description: "Reporting from New Jersey communities.",
      order: 30,
    });
  });

  it("refuses malformed ids and stored rows whose payload id disagrees with the document", () => {
    expect(() =>
      normalizeMediaCategoryCreate({
        id: "Local News",
        label: "Local news",
        description: "Reporting",
        order: 1,
      }),
    ).toThrow(/lowercase letters/);

    expect(
      parseMediaCategoryDefinition("news", {
        id: "arts",
        label: "News",
        description: "Reporting",
        order: 1,
        active: true,
        version: 1,
      }),
    ).toBeNull();
  });
});

describe("media category registry seed", () => {
  it("preserves categories from assets and recovery receipts", async () => {
    await db.collection("media_assets").doc("asset-1").set({ category: "news" });
    await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc("a".repeat(64))
      .set({ category: "arts" });

    await expect(
      seedMediaCategories({ firestore: db, nowIso: NOW }),
    ).resolves.toMatchObject({ created: 4, verified: 0 });

    const registry = await db.collection("mediaCategories").get();
    expect(registry.docs.map((doc) => doc.id).sort()).toEqual([
      "arts",
      "general",
      "news",
      "staff-profile",
    ]);
    expect(registry.docs.find((doc) => doc.id === "news").data()).toMatchObject({
      id: "news",
      label: "News",
      active: true,
      version: 1,
    });
  });

  it("is idempotent and verifies the live registry", async () => {
    await seedMediaCategories({ firestore: db, nowIso: NOW });
    await expect(
      seedMediaCategories({ firestore: db, nowIso: NOW }),
    ).resolves.toMatchObject({ created: 0, verified: 2 });
    await expect(
      verifyMediaCategoriesRegistered({ firestore: db }),
    ).resolves.toEqual({ registered: 2 });
  });

  it("seeds more categories than one Firestore commit can contain", async () => {
    const assetWrites = db.batch();
    for (let index = 0; index < 249; index += 1) {
      assetWrites.set(db.collection("media_assets").doc(`asset-${index}`), {
        category: `category-${index}`,
      });
    }
    await assetWrites.commit();

    let transactionRuns = 0;
    let failedTransaction = 2;
    const limitedFirestore = {
      collection: (...args) => db.collection(...args),
      collectionGroup: (...args) => db.collectionGroup(...args),
      runTransaction: (callback) => {
        transactionRuns += 1;
        if (transactionRuns === failedTransaction) {
          return Promise.reject(new Error("Simulated interruption"));
        }
        return db.runTransaction((transaction) => {
          let writes = 0;
          return callback({
            get: (...args) => transaction.get(...args),
            create: (...args) => {
              writes += 1;
              if (writes > 500) {
                throw new Error("A Firestore commit cannot exceed 500 writes");
              }
              return transaction.create(...args);
            },
          });
        });
      },
    };

    await expect(
      seedMediaCategories({ firestore: limitedFirestore, nowIso: NOW }),
    ).rejects.toThrow("Simulated interruption");
    failedTransaction = -1;
    await expect(
      seedMediaCategories({ firestore: limitedFirestore, nowIso: NOW }),
    ).resolves.toEqual({ created: 1, verified: 250 });
    await expect(
      verifyMediaCategoriesRegistered({ firestore: db }),
    ).resolves.toEqual({ registered: 251 });
    await expect(db.collection("admin_logs").get()).resolves.toMatchObject({
      size: 251,
    });
  });
});

describe("media category assignment backfill", () => {
  it("materializes multiple owning categories with one revision and audit per asset", async () => {
    const first = {
      id: "asset-1",
      name: "News image",
      originalName: "news-image.png",
      category: "news",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 1024,
      width: 640,
      height: 360,
      version: 7,
      url: "https://media.njpbs.org/cms-media/news/asset-1/hash.png",
      storageKey: "cms-media/news/asset-1/hash.png",
      contentHash: "a".repeat(64),
      lifecycle: "active",
      createdAt: "2026-08-27T15:00:00.000Z",
      updatedAt: "2026-08-27T16:00:00.000Z",
    };
    const second = {
      ...first,
      id: "asset-2",
      name: "Arts image",
      category: "arts",
      url: "https://media.njpbs.org/cms-media/arts/asset-2/hash.png",
      storageKey: "cms-media/arts/asset-2/hash.png",
      contentHash: "b".repeat(64),
    };
    const records = [first, second];
    const seed = db.batch();
    for (const record of records) {
      seed.set(db.collection("media_assets").doc(record.id), record);
    }
    await seed.commit();

    await expect(
      backfillMediaCategoryAssignments({ firestore: db, nowIso: NOW }),
    ).resolves.toEqual({ migrated: 2, verified: 0 });

    const stored = await db.collection("media_assets").get();
    for (const document of stored.docs) {
      const before = records.find((record) => record.id === document.id);
      const { mediaDiscovery, ...canonical } = document.data();
      expect(canonical).toEqual({ ...before, categories: [before.category] });
      expect(mediaDiscovery).toMatchObject({ schema: 1, eligible: true });
    }
    expect(stored.docs.find((document) => document.id === first.id).data()
      .mediaDiscovery).toMatchObject({
      schema: 1,
      eligible: true,
      nameKey: "news image",
      createdAtKey: Date.parse(first.createdAt),
      updatedAtKey: Date.parse(first.updatedAt),
      sizeBytesKey: 1024,
      terms: expect.arrayContaining(["browse", "006e00650077"]),
    });
    expect((await db.doc("system/mediaDiscovery").get()).data())
      .toEqual({ revision: 2 });
    const logs = await db.collection("admin_logs").get();
    expect(logs.docs.map((document) => {
      const data = document.data();
      return {
        action: data.action,
        target: data.target,
        before: data.before,
        after: data.after,
      };
    }).sort((left, right) => left.target.localeCompare(right.target))).toEqual([
      {
        action: "media.categories.backfill",
        target: "media_assets/asset-1",
        before: { category: "news", categories: null },
        after: { category: "news", categories: ["news"] },
      },
      {
        action: "media.categories.backfill",
        target: "media_assets/asset-2",
        before: { category: "arts", categories: null },
        after: { category: "arts", categories: ["arts"] },
      },
    ]);

    await expect(
      backfillMediaCategoryAssignments({ firestore: db, nowIso: NOW }),
    ).resolves.toEqual({ migrated: 0, verified: 2 });
    await expect(
      verifyMediaCategoryAssignments({ firestore: db }),
    ).resolves.toEqual({ verified: 2 });
    expect((await db.doc("system/mediaDiscovery").get()).data())
      .toEqual({ revision: 2 });
    expect((await db.collection("admin_logs").get()).size).toBe(2);
  });

  it("leaves an invalid active record and revision unchanged when indexing fails", async () => {
    const before = { id: "invalid-1", category: "news", version: 7, lifecycle: "active" };
    await db.collection("media_assets").doc("invalid-1").set(before);

    await expect(backfillMediaCategoryAssignments({ firestore: db, nowIso: NOW }))
      .rejects.toThrow("Invalid summary");

    expect((await db.collection("media_assets").doc("invalid-1").get()).data())
      .toEqual(before);
    expect((await db.doc("system/mediaDiscovery").get()).exists).toBe(false);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });
});

describe("media category endpoints", () => {
  async function seed() {
    await seedMediaCategories({ firestore: db, nowIso: NOW });
  }

  it("lists managed categories with caller-specific upload and management decisions", async () => {
    await seed();
    const run = createCmsListMediaCategoriesHandler({
      firestore: db,
      requirePrincipalFn: async () => actor([{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }]),
    });

    const res = await invoke(run, request());

    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toEqual([
      expect.objectContaining({
        id: "general",
        label: "General",
        canUpload: true,
        canManage: true,
      }),
      expect.objectContaining({
        id: "staff-profile",
        canUpload: true,
        canManage: true,
      }),
    ]);
  });

  it("lists categories for verified active audio readers without write flags", async () => {
    await seed();
    const run = createCmsListMediaCategoriesHandler({
      firestore: db,
      requirePrincipalFn: async () => actor([{ role: "staff", sections: ["general"], registeredMediaSections: ["general"] }]),
    });
    const res = await invoke(run, request());
    expect(res.statusCode).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    expect(res.body.categories.every((category) =>
      category.canUpload === false && category.canManage === false)).toBe(true);
  });

  it("rejects unverified or inactive read-only audio category requests", async () => {
    await seed();
    for (const overrides of [{ emailVerified: false }, { approvedActive: false }]) {
      const run = createCmsListMediaCategoriesHandler({
        firestore: db,
        requirePrincipalFn: async () => actor([{ role: "staff" }], overrides),
      });
      const res = await invoke(run, request());
      expect(res.statusCode).toBe(403);
    }
  });

  it("creates, edits, archives and restores a category with strong version guards", async () => {
    await seed();
    const run = createCmsMutateMediaCategoryHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => NOW,
    });

    const created = await invoke(
      run,
      request({
        action: "create",
        category: {
          id: "local-news",
          label: "Local news",
          description: "Reporting from New Jersey communities.",
          order: 30,
        },
      }),
    );
    expect(created.statusCode).toBe(200);
    expect(created.body.category).toMatchObject({ version: 1, active: true });

    const updated = await invoke(
      run,
      request(
        {
          action: "update",
          id: "local-news",
          changes: { label: "Community news", order: 40 },
        },
        { "if-match": formatMediaCategoryEtag("local-news", 1) },
      ),
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.body.category).toMatchObject({
      label: "Community news",
      order: 40,
      version: 2,
    });

    const archived = await invoke(
      run,
      request(
        { action: "archive", id: "local-news" },
        { "if-match": formatMediaCategoryEtag("local-news", 2) },
      ),
    );
    expect(archived.body.category).toMatchObject({ active: false, version: 3 });

    const restored = await invoke(
      run,
      request(
        { action: "restore", id: "local-news" },
        { "if-match": formatMediaCategoryEtag("local-news", 3) },
      ),
    );
    expect(restored.body.category).toMatchObject({ active: true, version: 4 });
  });

  it("does not write or audit a no-op and protects reserved categories", async () => {
    await seed();
    const run = createCmsMutateMediaCategoryHandler({
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => NOW,
    });

    const noOp = await invoke(
      run,
      request(
        { action: "update", id: "general", changes: { order: 10 } },
        { "if-match": formatMediaCategoryEtag("general", 1) },
      ),
    );
    expect(noOp.body).toMatchObject({ changed: false });

    const refused = await invoke(
      run,
      request(
        { action: "archive", id: "staff-profile" },
        { "if-match": formatMediaCategoryEtag("staff-profile", 1) },
      ),
    );
    expect(refused.statusCode).toBe(409);

    const logs = await db.collection("admin_logs").get();
    expect(logs.docs.filter((doc) => doc.data().action === "media.category.update"))
      .toHaveLength(0);
  });
});

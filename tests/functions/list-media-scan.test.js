import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Query } from "firebase-admin/firestore";
import listMedia from "../../functions/list-media.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import discovery from "../../functions/lib/media-discovery.js";

const {
  INDEX_REQUIRED_MESSAGE,
  MAX_ACTIVE_MEDIA_SCAN,
  MAX_MEDIA_SCAN,
  MEDIA_SCAN_BATCH_SIZE,
  createCmsListMediaHandler,
  readMediaAssetSummaries,
  readSelfProfilePhotoSummaries,
} = listMedia;
const PROJECT = "demo-njpbs";
let app;
let db;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator required");
  app = initializeApp({ projectId: PROJECT }, "list-media-scan");
  db = isolatedFirestore("list-media-scan.test.js");
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  expect(response.ok).toBe(true);
});
afterAll(async () => {
  await db?.terminate();
  if (app) await deleteApp(app);
});

function asset(index, overrides = {}) {
  return {
    name: `Photo ${String(1000 - index).padStart(4, "0")}`,
    originalName: `photo-${index}.png`,
    category: "news",
    tags: [index % 2 ? "odd" : "even"],
    description: "A media scan fixture",
    altText: "A test image",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: index + 1,
    width: 1200,
    height: 800,
    url: `https://media.example.invalid/photo-${index}.png`,
    lifecycle: "active",
    version: 1,
    createdAt: "2026-09-25T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-09-25T12:00:00.000Z",
    updatedBy: "editor-1",
    storageKey: "private-storage-key",
    ...overrides,
  };
}

async function seed(count, overrides = {}) {
  for (let start = 0; start < count; start += 300) {
    const batch = db.batch();
    for (let index = start; index < Math.min(start + 300, count); index++) {
      batch.set(db.collection("media_assets").doc(`asset-${String(index).padStart(4, "0")}`),
        asset(index, overrides));
    }
    await batch.commit();
  }
}

async function request(body = {}, deps = {}) {
  const res = {
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await createCmsListMediaHandler({
    firestore: db,
    requirePrincipalFn: async () => ({
      uid: "editor-1",
      approvedActive: true,
      principal: { id: "editor-1", grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }] },
    }),
    isApprovedActiveAccountFn: async () => true,
    log: { warn() {}, error() {} },
    ...deps,
  })({ method: "POST", body, headers: { "content-type": "application/json" } }, res);
  return res;
}

const selfScope = {
  profilePhotoScope: "self", categories: ["staff-profile"], kinds: ["image"],
};

describe("ordered active media scan", () => {
  it("carries only original availability through selected legacy, corpus, indexed and exact-id list responses", async () => {
    const contentHash = "b".repeat(64);
    const id = "asset-0000";
    await db.collection("media_assets").doc(id).set(discovery.withMediaDiscovery(id, asset(0, {
      source: "upload", mimeType: "image/webp", contentHash,
      master: { retained: true, contentHash, key: `masters/bb/${contentHash}.jpg`,
        mimeType: "image/jpeg", sizeBytes: 8_000_000, width: 6000, height: 4000 },
    })));
    await db.doc(discovery.MEDIA_DISCOVERY_STATE).set({ schema: 1, state: "ready", revision: 1 });
    for (const body of [{}, { corpus: true, limit: 30 }, { paging: "cursor" }, { assetIds: [id] }]) {
      const res = await request(body);
      expect(res.statusCode).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.records[0].originalAvailable).toBe(true);
      expect(res.body.records[0]).not.toHaveProperty("master");
      expect(res.body.records[0]).not.toHaveProperty("storageKey");
      expect(res.body.records[0]).not.toHaveProperty("contentHash");
      expect(JSON.stringify(res.body)).not.toContain(contentHash);
      expect(JSON.stringify(res.body)).not.toContain("masters/");
    }
  });
  it("refuses an oversized legacy list before loading media documents", async () => {
    // #2721: Even malformed active records count toward the 5,000-record ceiling.
    for (let start = 0; start <= MAX_ACTIVE_MEDIA_SCAN; start += 300) {
      const batch = db.batch();
      for (let index = start; index < Math.min(start + 300, MAX_ACTIVE_MEDIA_SCAN + 1); index++) {
        batch.set(db.collection("media_assets").doc(`asset-${String(index).padStart(4, "0")}`),
          index === 0 ? asset(index) : { lifecycle: "active", version: 0 });
      }
      await batch.commit();
    }
    const originalGet = Query.prototype.get;
    let documentsRead = 0;
    Query.prototype.get = async function(...args) {
      const snapshot = await originalGet.apply(this, args);
      documentsRead += snapshot.size;
      return snapshot;
    };
    try {
      const result = await request();
      expect(result.statusCode).toBe(503);
      expect(result.body).toEqual({ error: INDEX_REQUIRED_MESSAGE });
      expect(documentsRead).toBe(0);
    } finally {
      Query.prototype.get = originalGet;
    }
  }, 30000);

  it("pages the bounded corpus through malformed records with a real count query", async () => {
    await seed(605);
    await db.collection("media_assets").doc("asset-0000").update({ category: "invalid/category" });
    await db.collection("media_assets").doc("asset-0001").update({ version: 0 });
    const hidden = await request({ corpus: true, limit: 2 });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.body).toEqual({ success: true, records: [], nextCursor: expect.any(String) });
    const first = await request({ corpus: true, limit: 500, cursor: hidden.body.nextCursor });
    const last = await request({ corpus: true, limit: 500, cursor: first.body.nextCursor });
    expect(first.statusCode).toBe(200);
    expect(last.statusCode).toBe(200);
    expect(first.body.records).toHaveLength(500);
    expect(last.body.records).toHaveLength(103);
    expect(last.body.nextCursor).toBeNull();
    expect([...first.body.records, ...last.body.records].map(row => row.id)).toEqual(
      Array.from({ length: 603 }, (_, i) => `asset-${String(i + 2).padStart(4, "0")}`),
    );
    // Validate the aggregation-limit behavior used by the global 5,001 gate.
    expect((await db.collection("media_assets").where("lifecycle", "==", "active")
      .limit(501).count().get()).data().count).toBe(501);
  }, 30000);

  it("separates the real safety ceiling from paging and legacy consumers", () => {
    expect(MAX_ACTIVE_MEDIA_SCAN).toBe(5000);
    expect(MEDIA_SCAN_BATCH_SIZE).toBe(300);
    expect(mediaLibrary.MAX_MEDIA_LIBRARY_PAGE_SIZE).toBe(500);
    expect(MAX_MEDIA_SCAN).toBe(500);
  });

  it("lists over 500 assets across real batches with complete totals, sorting and paging", async () => {
    await seed(605);
    await db.collection("media_assets").doc("other-category").set(asset(606, { category: "arts" }));
    await db.collection("media_assets").doc("binned").set(asset(607, { lifecycle: "binned" }));
    const first = await request({ sort: "name", direction: "asc", pageSize: 500 });
    const last = await request({ sort: "name", direction: "asc", pageSize: 500, page: 2 });
    expect(first.statusCode).toBe(200);
    expect(last.statusCode).toBe(200);
    expect(last.body).toMatchObject({
      total: 606, allCount: 606, page: 2, pageCount: 2,
      categoryCounts: { news: 605, arts: 1 }, kindCounts: { image: 606, document: 0 },
    });
    const ids = [...first.body.records, ...last.body.records].map((record) => record.id);
    expect(ids).toEqual(["other-category", ...Array.from({ length: 605 }, (_, index) =>
      `asset-${String(604 - index).padStart(4, "0")}`)]);
    expect(first.body.records[0]).not.toHaveProperty("storageKey");
    const filtered = await request({ q: "even", categories: ["news"], sort: "sizeBytes", direction: "desc" });
    expect(filtered.body).toMatchObject({ allCount: 606, total: 303, pageCount: 11 });
    expect(filtered.body.records[0].id).toBe("asset-0604");
  }, 30000);

  it("scans over 500 own profile photos while excluding other owners and categories", async () => {
    await seed(605, { category: "staff-profile" });
    await db.collection("media_assets").doc("other-owner").set(asset(606, {
      category: "staff-profile", createdBy: "editor-2",
    }));
    await db.collection("media_assets").doc("other-category").set(asset(607));
    const result = await request({ ...selfScope, sort: "sizeBytes", direction: "asc", page: 21 });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ total: 605, allCount: 605, page: 21, pageCount: 21 });
    expect(result.body.records.map((record) => record.id)).toEqual([
      "asset-0600", "asset-0601", "asset-0602", "asset-0603", "asset-0604",
    ]);
  }, 30000);

  it.each([false, true])("accepts the exact ceiling and preserves the 503 above it (self=%s)", async (self) => {
    const overrides = self ? { category: "staff-profile" } : {};
    await seed(6, overrides);
    const options = { batchSize: 2, maxAssets: 6 };
    const deps = {
      readRecordsFn: (firestore) => readMediaAssetSummaries(firestore, options),
      readSelfProfileRecordsFn: (firestore, uid) => readSelfProfilePhotoSummaries(firestore, uid, options),
    };
    const body = self ? selfScope : {};
    const exact = await request(body, deps);
    expect(exact.statusCode).toBe(200);
    expect(exact.body.total).toBe(6);
    // Invalid summaries still count toward the raw active-document safety ceiling.
    await db.collection("media_assets").doc("overflow").set(asset(7, { ...overrides, version: 0 }));
    const overflow = await request(body, deps);
    expect(overflow.statusCode).toBe(503);
    expect(overflow.body).toEqual({ error: INDEX_REQUIRED_MESSAGE });
  });

  it("finishes an empty scan", async () => {
    expect(await readMediaAssetSummaries(db)).toEqual({ records: [], overflow: false });
  });
});

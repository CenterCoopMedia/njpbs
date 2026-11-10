import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Query, Timestamp } from "firebase-admin/firestore";
import discovery from "../../functions/lib/media-discovery.js";
import queryApi from "../../functions/lib/media-discovery-query.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import listApi from "../../functions/list-media.js";

const {
  withMediaDiscovery,
  MEDIA_DISCOVERY_STATE,
  OVERFLOW_TERM,
  discoveryTerm,
  discoveryTerms,
} = discovery;
const {
  readIndexedMedia,
  authorizedOwners,
  comparePositions,
  discoveryQueries,
  searchCandidateTerm,
} = queryApi;
const { parseMediaListRequest } = mediaLibrary;
const { SUMMARY_FIELDS } = listApi;
const PROJECT = "demo-njpbs";
let app;
let db;
const editor = {
  uid: "editor-1", approvedActive: true,
  principal: { id: "editor-1", grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }] },
};
const body = (overrides = {}) => parseMediaListRequest({ paging: "cursor", sort: "sizeBytes", direction: "asc", ...overrides });
function asset(index, overrides = {}) {
  return {
    name: `Photo ${String(index).padStart(5, "0")}`, originalName: `photo-${index}.png`,
    category: "news", categories: ["news", "events"], tags: [index % 2 ? "odd" : "even"],
    description: "A discovery fixture", altText: "A test image", license: "NJ PBS owned", credit: "NJ PBS",
    mimeType: "image/png", kind: "image", sizeBytes: index + 1, width: 1200, height: 800,
    url: `https://media.example.invalid/photo-${index}.png`, lifecycle: "active", version: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), createdBy: "editor-1",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), updatedBy: "editor-1",
    storageKey: "private-key", originalStorageKey: "private-original", ...overrides,
  };
}
async function put(id, index, overrides = {}) {
  await db.collection("media_assets").doc(id).set(withMediaDiscovery(id, asset(index, overrides)));
}
async function seed(count) {
  for (let start = 0; start < count; start += 300) {
    const batch = db.batch();
    for (let index = start; index < Math.min(start + 300, count); index++) {
      const id = `asset-${String(index).padStart(5, "0")}`;
      batch.set(db.collection("media_assets").doc(id), withMediaDiscovery(id, asset(index)));
    }
    await batch.commit();
  }
}
async function page(query, user = editor, labels = { news: "News", events: "Events" }) {
  return readIndexedMedia(db, user, query, labels, SUMMARY_FIELDS);
}
async function exhaust(query, user = editor, labels) {
  const rows = [];
  let cursor;
  let last;
  let pages = 0;
  do {
    last = await page({ ...query, ...(cursor ? { cursor } : {}), page: ++pages }, user, labels);
    expect(last.records.length).toBeLessThanOrEqual(30);
    if (last.nextCursor) expect(last.total).toBeNull();
    rows.push(...last.records);
    cursor = last.nextCursor;
    if (pages > 300) throw Error("Continuation did not finish");
  } while (cursor);
  expect(last.total).toBe(rows.length);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  return { rows, last, pages };
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error("Firestore emulator required");
  app = initializeApp({ projectId: PROJECT }, "media-discovery-query");
  db = isolatedFirestore("media-discovery-query.test.js");
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  expect(response.ok).toBe(true);
  await db.doc(MEDIA_DISCOVERY_STATE).set({ schema: 1, state: "ready", revision: 1 });
});
afterAll(async () => { await db?.terminate(); if (app) await deleteApp(app); });

describe("private indexed discovery", () => {
  it("pages uploaded audio separately from Images with the existing discovery schema", async () => {
    await put("image-one", 1);
    for (const [id, index] of [["audio-one", 2], ["audio-two", 3]]) {
      await put(id, index, { kind: "audio", mimeType: "audio/wav", width: null, height: null, originalName: `${id}.wav` });
    }
    await put("arts-audio", 4, { kind: "audio", mimeType: "audio/wav", width: null, height: null,
      originalName: "arts.wav", category: "arts", categories: ["arts"] });
    const images = await page(body());
    expect(images.records.map(record => record.id)).toEqual(["image-one"]);
    const first = await page(body({ kinds: ["audio"], pageSize: 1 }));
    expect(first.records.map(record => record.id)).toEqual(["audio-one"]);
    const next = await page(body({ kinds: ["audio"], pageSize: 1, cursor: first.nextCursor }));
    expect(next.records.map(record => record.id)).toEqual(["audio-two"]);
    expect(next.nextCursor).toEqual(expect.any(String));
    const last = await page(body({ kinds: ["audio"], pageSize: 1, cursor: next.nextCursor }));
    expect(last.records.map(record => record.id)).toEqual(["arts-audio"]);
    expect(last.nextCursor).toBeNull();
  });

  it("confines read-only staff to audio across all categories", async () => {
    const reader = {
      uid: "audio-reader", emailVerified: true, approvedActive: true,
      principal: { id: "audio-reader", grants: [{ role: "staff", sections: ["news"], registeredMediaSections: ["news"] }] },
    };
    await put("news-audio", 1, { kind: "audio", mimeType: "audio/wav", width: null, height: null,
      originalName: "news-audio.wav" });
    await put("news-image", 2);
    await put("arts-audio", 3, { kind: "audio", mimeType: "audio/wav", width: null, height: null,
      originalName: "arts-audio.wav", category: "arts", categories: ["arts"] });

    expect(authorizedOwners(reader.principal, "audio")).toEqual([]);
    expect(authorizedOwners(reader.principal, "audio", true)).toBeNull();
    expect(authorizedOwners(reader.principal)).toEqual([]);
    expect((await exhaust(body({ kinds: ["audio"] }), reader)).rows.map(row => row.id))
      .toEqual(["news-audio", "arts-audio"]);
    expect((await exhaust(body({ kinds: ["audio"] }), {
      ...reader,
      emailVerified: false,
    })).rows).toEqual([]);
    expect((await exhaust(body(), reader)).rows).toEqual([]);
    expect((await exhaust(body({ kinds: ["audio", "image"] }), reader)).rows).toEqual([]);
  });

  it("fills an implicit Images page after more than one page of leading audio candidates", async () => {
    for (let index = 0; index < 35; index++) {
      const id = `audio-${String(index).padStart(5, "0")}`;
      await put(id, index, { kind: "audio", mimeType: "audio/wav", width: null, height: null,
        originalName: `${id}.wav` });
    }
    for (let index = 0; index < 31; index++) {
      await put(`image-${String(index).padStart(5, "0")}`, index + 100);
    }

    const first = await page(body());
    expect(first.records.map(record => record.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `image-${String(index).padStart(5, "0")}`),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.total).toBeNull();

    const second = await page(body({ cursor: first.nextCursor, page: 2 }));
    expect(second.records.map(record => record.id)).toEqual(["image-00030"]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(31);
    expect(second.allCount).toBe(31);
  });

  it("fills the first Audio page after hundreds of leading Images", async () => {
    const batch = db.batch();
    for (let index = 0; index < 200; index++) {
      const id = `image-${String(index).padStart(5, "0")}`;
      batch.set(db.collection("media_assets").doc(id), withMediaDiscovery(id, asset(index)));
    }
    for (let index = 0; index < 30; index++) {
      const id = `audio-${String(index).padStart(5, "0")}`;
      batch.set(db.collection("media_assets").doc(id), withMediaDiscovery(id, asset(index + 1_000, {
        kind: "audio",
        mimeType: "audio/wav",
        width: null,
        height: null,
        originalName: `${id}.wav`,
      })));
    }
    await batch.commit();

    const first = await page(body({ kinds: ["audio"] }));
    expect(first.records.map(record => record.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `audio-${String(index).padStart(5, "0")}`),
    );
    expect(first.nextCursor).toBeNull();
    expect(first.total).toBe(30);
  });

  it("constrains scoped search candidates by one or two requested kinds", () => {
    const owners = ["arts", "education", "events", "general", "news", "programs"];
    function recordedQueries(kinds) {
      const clauses = [];
      const query = {
        where: (...args) => { clauses.push(args); return query; },
        orderBy: () => query,
        select: () => query,
        limit: () => query,
      };
      const firestore = {
        collection: (name) => {
          expect(name).toBe("media_assets");
          return query;
        },
      };
      discoveryQueries(firestore, {
        owners,
        kinds,
        term: discoveryTerm("needle"),
        sort: "updatedAt",
        direction: "desc",
        limit: 31,
        fields: ["name"],
      });
      return clauses;
    }

    expect(recordedQueries(["audio"])).toContainEqual(["kind", "==", "audio"]);
    expect(recordedQueries(["image", "document"]))
      .toContainEqual(["kind", "in", ["image", "document"]]);
    expect(recordedQueries(["audio", "document", "image"])
      .some(([field]) => field === "kind")).toBe(false);
    expect(recordedQueries(["audio"])).toEqual(expect.arrayContaining([
      ["mediaDiscovery.terms", "array-contains-any", [discoveryTerm("needle"), OVERFLOW_TERM]],
      ["category", "in", owners],
    ]));
  });

  it("declares all 16 kind-filtered discovery indexes and two Audio count indexes", () => {
    const indexes = JSON.parse(readFileSync(
      new URL("../../firestore.indexes.json", import.meta.url),
      "utf8",
    )).indexes.filter(index => index.collectionGroup === "media_assets");
    const discoveryIndexes = indexes.filter(index =>
      index.fields.some(field => field.fieldPath === "mediaDiscovery.schema") &&
      index.fields.some(field => field.fieldPath === "kind"));
    const countIndexes = indexes.filter(index => {
      const paths = index.fields.map(field => field.fieldPath);
      return paths[0] === "lifecycle" && paths[1] === "kind" &&
        (paths.length === 2 || (paths.length === 3 && paths[2] === "category"));
    });
    expect(discoveryIndexes).toHaveLength(16);
    expect(countIndexes).toHaveLength(2);

    const sortFields = {
      name: ["mediaDiscovery.nameKey"],
      createdAt: ["mediaDiscovery.createdAtKey", "mediaDiscovery.nameKey"],
      updatedAt: ["mediaDiscovery.updatedAtKey", "mediaDiscovery.nameKey"],
      sizeBytes: ["mediaDiscovery.sizeBytesKey", "mediaDiscovery.nameKey"],
    };
    for (const scoped of [false, true]) {
      for (const fields of Object.values(sortFields)) {
        for (const direction of ["ASCENDING", "DESCENDING"]) {
          expect(discoveryIndexes).toContainEqual({
            collectionGroup: "media_assets",
            queryScope: "COLLECTION",
            fields: [
              { fieldPath: "mediaDiscovery.schema", order: "ASCENDING" },
              { fieldPath: "mediaDiscovery.eligible", order: "ASCENDING" },
              { fieldPath: "kind", order: "ASCENDING" },
              ...(scoped ? [{ fieldPath: "category", order: "ASCENDING" }] : []),
              { fieldPath: "mediaDiscovery.terms", arrayConfig: "CONTAINS" },
              ...fields.map(fieldPath => ({ fieldPath, order: direction })),
              { fieldPath: "__name__", order: direction },
            ],
          });
        }
      }
    }
  });

  it("keeps plain Images browse at 30 candidates plus one sentinel", async () => {
    await seed(130);
    const originalGet = Query.prototype.get;
    const snapshotSizes = [];
    Query.prototype.get = async function(...args) {
      const snapshot = await originalGet.apply(this, args);
      snapshotSizes.push(snapshot.size);
      return snapshot;
    };
    try {
      const result = await page(body());
      expect(result.records).toHaveLength(30);
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(snapshotSizes).toEqual([31]);
    } finally {
      Query.prototype.get = originalGet;
    }
  });

  it("completes a site-wide ordered library above 500 without duplicates, binned records or private fields", async () => {
    await seed(605);
    await put("arts-last", 606, { category: "arts", categories: ["arts", "news"] });
    await put("binned", 607, { lifecycle: "tombstoned" });
    const result = await exhaust(body());
    expect(result.rows.map(row => row.id)).toEqual([...Array.from({ length: 605 }, (_, i) => `asset-${String(i).padStart(5, "0")}`), "arts-last"]);
    expect(result.last.allCount).toBe(606);
    expect(result.pages).toBe(21);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("mediaDiscovery");
      expect(row).not.toHaveProperty("storageKey");
      expect(row).not.toHaveProperty("originalStorageKey");
    }
  }, 30000);

  it.each(["name", "createdAt", "updatedAt", "sizeBytes"])("exhausts both %s directions across 31 owning categories", async sort => {
    const sections = Array.from({ length: 31 }, (_, i) => `section-${i}`);
    const user = { ...editor, principal: { id: editor.uid, grants: [{ role: "editor", sections, registeredMediaSections: sections }] } };
    for (let index = 0; index < 95; index++) await put(`asset-${String(index).padStart(5, "0")}`, index, { category: sections[index % sections.length], categories: [sections[index % sections.length], "events"] });
    for (const direction of ["asc", "desc"]) {
      const result = await exhaust(body({ sort, direction }), user);
      const numbers = Array.from({ length: 95 }, (_, i) => i);
      if (direction === "desc") numbers.reverse();
      expect(result.rows.map(row => row.id)).toEqual(numbers.map(i => `asset-${String(i).padStart(5, "0")}`));
    }
  }, 30000);

  it("keeps substring, joined fields, current labels, Unicode and overflow matches", async () => {
    await put("one", 1, { name: "Coast café 😀", description: "A river", altText: "crossing", tags: ["Coastline"] });
    await put("two", 2, { description: Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ") + " unique-needle", tags: ["odd"] });
    for (const q of ["coast", "astli", "é", "😀", "\ud83d", "river crossing", "harbor studies"]) {
      const result = await exhaust(body({ q }), editor, { news: "Harbor studies", events: "Events" });
      expect(result.rows.map(row => row.id)).toEqual(q === "harbor studies" ? ["one", "two"] : ["one"]);
    }
    expect((await exhaust(body({ q: "unique-needle" }))).rows.map(row => row.id)).toEqual(["two"]);
    expect((await exhaust(body({ q: "harbor studies" }))).rows).toEqual([]);
  });

  it("reports a bounded empty slice as unfinished and verifies descriptive category/kind filters", async () => {
    await seed(151);
    await put("asset-00150", 150, { name: "Zebra needle", categories: ["news", "events"] });
    const first = await page(body({ q: "z" }));
    expect(first.records).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.total).toBeNull();
    const last = await page(body({ q: "z", cursor: first.nextCursor, categories: [] }));
    expect(last.records.map(row => row.id)).toEqual(["asset-00150"]);
    expect(last.nextCursor).toBeNull();
    expect(last.total).toBe(1);
    expect((await exhaust(body({ q: "needle", categories: ["events"], kinds: ["image"] }))).rows.map(row => row.id)).toEqual(["asset-00150"]);
    expect((await exhaust(body({ q: "needle", kinds: ["document"] }))).rows).toEqual([]);
  });

  it("puts the exact ID first, replays immutable cursors and rejects changed caller/query/access/labels/revision", async () => {
    await seed(65);
    await put("one", 100, { name: "Exact ID" });
    for (let i = 0; i < 65; i++) await put(`asset-${String(i).padStart(5, "0")}`, i, { tags: ["one"] });
    const q = body({ q: "one" });
    const first = await page(q);
    expect(first.records[0].id).toBe("one");
    const nextQuery = { ...q, cursor: first.nextCursor, page: 2 };
    const replayA = await page(nextQuery);
    const replayB = await page(nextQuery);
    expect(replayA.records).toEqual(replayB.records);
    expect(replayA.records.map(row => row.id)).not.toContain("one");
    await expect(page(nextQuery, { ...editor, uid: "other" })).rejects.toMatchObject({ status: 409 });
    await expect(page({ ...nextQuery, q: "different" })).rejects.toMatchObject({ status: 409 });
    await expect(page(nextQuery, { ...editor, principal: { id: editor.uid, grants: [{ role: "editor", sections: ["arts"], registeredMediaSections: ["arts"] }] } })).rejects.toMatchObject({ status: 409 });
    await expect(page(nextQuery, editor, { news: "Renamed", events: "Events" })).rejects.toMatchObject({ status: 409 });
    await expect(page(nextQuery, { ...editor, approvedActive: false })).rejects.toMatchObject({ status: 403 });
    await db.doc(MEDIA_DISCOVERY_STATE).update({ revision: FieldValue.increment(1) });
    await expect(page(nextQuery)).rejects.toMatchObject({ status: 409 });
    await expect(page({ ...q, cursor: "A".repeat(32) })).rejects.toMatchObject({ status: 410 });
    await expect(page({ ...q, cursor: "bad" })).rejects.toMatchObject({ status: 400 });
    const fresh = await page(q);
    const cursors = await db.collection("mediaDiscoveryCursors").get();
    const { createHash } = await import("node:crypto");
    const cursorId = createHash("sha256").update(JSON.stringify(fresh.nextCursor)).digest("hex");
    expect(cursors.size).toBeGreaterThan(0);
    await db.collection("mediaDiscoveryCursors").doc(cursorId).update({ expireAt: Timestamp.fromMillis(1) });
    await expect(page({ ...q, cursor: fresh.nextCursor })).rejects.toMatchObject({ status: 410 });
  });

  it("refuses unready discovery and preserves separate bounded ID hydration", async () => {
    await put("one", 1);
    await db.doc(MEDIA_DISCOVERY_STATE).update({ state: "building" });
    await expect(page(body())).rejects.toMatchObject({ status: 503 });
    expect(() => body({ assetIds: ["one"] })).toThrow();
    expect(() => body({ profilePhotoScope: "self" })).toThrow();
    const direct = await listApi.readMediaAssetSummariesByIds(db, ["one", "missing"]);
    expect(direct.records.map(row => row.id)).toEqual(["one"]);
    expect(direct.records[0]).not.toHaveProperty("mediaDiscovery");
  });

  it("uses explicit UTF-8 ordering, normalized legacy dates and bounded fragments", async () => {
    expect(comparePositions(["z", "a"], ["é", "b"], "asc")).toBeLessThan(0);
    expect(discoveryTerm("😀a")).toBe("d83dde000061");
    expect(discoveryTerms("abc" + Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ")).length).toBeLessThanOrEqual(513);
    expect(searchCandidateTerm("river crossing", { news: "River" })).not.toBeNull();
    expect(searchCandidateTerm("é", {})).toBeNull();
    const record = withMediaDiscovery("legacy", asset(1, { createdAt: Timestamp.fromMillis(10), updatedAt: null }));
    expect(record.mediaDiscovery.createdAtKey).toBe(10);
    expect(record.mediaDiscovery.updatedAtKey).toBe(Number.MAX_SAFE_INTEGER);
    // Many content areas still need just one site-wide media branch.
    const fortyNine = Array.from({ length: 49 }, (_, i) => `section-${i}`);

    expect(authorizedOwners({ grants: [{ role: "editor", sections: fortyNine, registeredMediaSections: fortyNine }] })).toBeNull();
    expect(authorizedOwners({ grants: [{ role: "editor", sections: [], registeredMediaSections: [] }] })).toEqual([]);
    await put("stale", 1);
    await db.collection("media_assets").doc("stale").update({ name: "Changed without a writer" });
    await expect(page(body())).rejects.toMatchObject({ status: 503 });
  });
});

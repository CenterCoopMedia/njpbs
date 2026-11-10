import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import sourceMedia from "../../functions/source-media.js";
import contract from "../../functions/lib/source-media-contract.js";

const { parseSourceMediaListRequest: parse, encodeCursor } = contract;
const sourceId = "video-library";
const indexes = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url))).indexes;

function queryRecorder(docs = []) {
  const calls = [];
  const query = {
    where(...args) { calls.push(["where", ...args]); return this; },
    orderBy(...args) { calls.push(["orderBy", ...args]); return this; },
    startAfter(...args) { calls.push(["startAfter", ...args]); return this; },
    limit(...args) { calls.push(["limit", ...args]); return this; },
    async get() { return { docs }; },
  };
  return { calls, firestore: { collection: () => query } };
}

const filters = [{}, { tag: "County" }, { createdBy: "staff-1" }, { rightsStatus: "pending" }];
const sorts = ["updated_desc", "updated_asc", "name_asc", "size_desc", "size_asc"];

describe("source video navigation", () => {
  it.each([
    { tag: 1 }, { tag: "a".repeat(81) }, { createdBy: "a".repeat(129) },
    { tag: "bad\nvalue" }, { rightsStatus: "unknown" }, { sort: "upload_date" },
    { tag: "county", createdBy: "staff-1" }, { tag: "county", rightsStatus: "pending" },
    { createdBy: "staff-1", rightsStatus: "pending" },
  ])("rejects invalid or combined filters: %j", (fields) => {
    expect(() => parse({ sourceId, ...fields })).toThrow();
  });

  it("preserves exact tag case and forces name order for prefix search", () => {
    expect(parse({ sourceId, q: " COUNTY ", tag: " County ", sort: "updated_asc" }))
      .toMatchObject({ q: "county", tag: "County", sort: "name_asc" });
  });

  it("binds cursors to the source, prefix, filter and sort", () => {
    const fields = { sourceId, q: "", tag: "county", sort: "updated_asc" };
    const cursor = encodeCursor({ ...fields, order: fields.sort, sort: "2026-09-15T12:00:00.000Z", id: "asset-1" });
    expect(parse({ ...fields, cursor }).cursor.id).toBe("asset-1");
    for (const changed of [
      { sourceId: "another-source" }, { q: "county" }, { tag: "County" },
      { tag: "", createdBy: "staff-1" }, { tag: "", rightsStatus: "pending" },
      { sort: "updated_desc" },
    ]) {
      expect(() => parse({ ...fields, ...changed, cursor })).toThrow("Cursor is invalid");
    }
  });

  it("round-trips the bounded cursor for long Unicode names and tags", () => {
    const fields = { sourceId, q: "", tag: "県".repeat(80), sort: "name_asc" };
    const name = "会".repeat(500);
    const cursor = encodeCursor({ ...fields, order: fields.sort, sort: name, id: "asset-1" });
    expect(parse({ ...fields, cursor }).cursor.sort).toBe(name);
  });

  it("round-trips a numeric cursor for file-size order", () => {
    const fields = { sourceId, q: "", sort: "size_desc" };
    const cursor = encodeCursor({ ...fields, order: fields.sort, sort: 1_048_576, id: "asset-1" });
    expect(parse({ ...fields, cursor }).cursor).toEqual({ id: "asset-1", sort: 1_048_576 });
    const stringCursor = encodeCursor({ ...fields, order: fields.sort, sort: "1048576", id: "asset-1" });
    expect(() => parse({ ...fields, cursor: stringCursor })).toThrow("Cursor is invalid");
  });

  it("rejects sort keys and cursors beyond the Firestore indexed byte limit", () => {
    expect(contract.normalizeSourceMediaNameSort("会".repeat(500))).toBe("会".repeat(500));
    expect(() => contract.normalizeSourceMediaNameSort("会".repeat(501))).toThrow("indexed text limit");
    const fields = { sourceId, q: "", sort: "name_asc" };
    const cursor = encodeCursor({ ...fields, order: fields.sort, sort: "会".repeat(501), id: "asset-1" });
    expect(() => parse({ ...fields, cursor })).toThrow("Cursor is invalid");
  });

  it.each(filters.slice(1))("combines a prefix with an indexed filter: %j", async (filter) => {
    const { calls, firestore } = queryRecorder();
    await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, parse({ sourceId, ...filter, q: "County", sort: "updated_desc" }), "__name__");
    expect(calls).toContainEqual(["where", "nameSort", ">=", "county"]);
    expect(calls).toContainEqual(["where", "nameSort", "<", "county\uf8ff"]);
    expect(calls).toContainEqual(["orderBy", "nameSort", "asc"]);
    expect(calls).toContainEqual(["limit", 31]);
  });

  it("accepts an existing cursor only for its original unfiltered order", () => {
    const cursor = Buffer.from(JSON.stringify({ sourceId, q: "", id: "asset-1", sort: "2026-09-15T12:00:00.000Z" })).toString("base64url");
    expect(parse({ sourceId, cursor }).cursor.id).toBe("asset-1");
    expect(() => parse({ sourceId, cursor, sort: "updated_asc" })).toThrow();
    expect(() => parse({ sourceId, cursor, tag: "county" })).toThrow();
  });

  for (const filter of filters) {
    for (const sort of sorts) {
      it(`uses a bounded indexed query for ${JSON.stringify(filter)} / ${sort}`, async () => {
        const { calls, firestore } = queryRecorder();
        await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, parse({ sourceId, ...filter, sort, limit: 24 }), "__name__");
        const filterField = filter.tag ? "tags" : filter.createdBy ? "createdBy" : filter.rightsStatus ? "rightsStatus" : null;
        if (filterField) {
          expect(calls).toContainEqual(["where", filterField, filter.tag ? "array-contains" : "==", Object.values(filter)[0]]);
        }
        const sortField = sort === "name_asc" ? "nameSort" : sort.startsWith("size_") ? "sizeBytes" : "updatedAtSort";
        const direction = sort.endsWith("_desc") ? "desc" : "asc";
        expect(calls.filter(([name]) => name === "orderBy")).toEqual([
          ["orderBy", sortField, direction], ["orderBy", "__name__", direction],
        ]);
        expect(calls).toContainEqual(["limit", 25]);
        const fields = [
          { fieldPath: "sourceId", order: "ASCENDING" },
          { fieldPath: "lifecycle", order: "ASCENDING" },
        ];
        if (filterField) fields.push(filter.tag
          ? { fieldPath: filterField, arrayConfig: "CONTAINS" }
          : { fieldPath: filterField, order: "ASCENDING" });
        fields.push({ fieldPath: sortField, order: direction.toUpperCase() + "ENDING" },
          { fieldPath: "__name__", order: direction.toUpperCase() + "ENDING" });
        expect(indexes).toContainEqual({ collectionGroup: "mediaSourceAssets", queryScope: "COLLECTION", fields });
      });
    }
  }

  it("continues after the exact sort value and document id, including rejected records", async () => {
    const date = "2026-09-15T12:00:00.000Z";
    const { calls, firestore } = queryRecorder([
      { id: "asset-1", data: () => ({ updatedAtSort: date }) },
      { id: "asset-2", data: () => ({ updatedAtSort: date }) },
    ]);
    const fields = { sourceId, createdBy: "staff-1", sort: "updated_asc", limit: 1 };
    const page = await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, parse(fields), "__name__");
    expect(page).toMatchObject({ records: [], hasMore: true });
    const next = parse({ ...fields, cursor: page.nextCursor });
    expect(next.cursor).toEqual({ id: "asset-1", sort: date });
    await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, next, "__name__");
    expect(calls).toContainEqual(["startAfter", date, "asset-1"]);
  });

  it("continues file-size order after the exact byte count and document id", async () => {
    const sizeBytes = 1_048_576;
    const { calls, firestore } = queryRecorder([
      { id: "asset-1", data: () => ({ sizeBytes }) },
      { id: "asset-2", data: () => ({ sizeBytes }) },
    ]);
    const fields = { sourceId, sort: "size_desc", limit: 1 };
    const page = await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, parse(fields), "__name__");
    const next = parse({ ...fields, cursor: page.nextCursor });
    expect(next.cursor).toEqual({ id: "asset-1", sort: sizeBytes });
    await sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, next, "__name__");
    expect(calls).toContainEqual(["startAfter", sizeBytes, "asset-1"]);
  });

  for (const filter of filters) {
    for (const sort of ["size_desc", "size_asc"]) {
      it(`returns a default-order page while the size index builds: ${JSON.stringify(filter)} / ${sort}`, async () => {
        const date = "2026-09-15T12:00:00.000Z";
        const documents = ["asset-1", "asset-2"].map(id => ({ id, data: () => ({
          sourceId, lifecycle: "active", kind: "video", name: id, nameSort: id, originalName: `${id}.mp4`,
          mimeType: "video/mp4", sizeBytes: 42, version: 1, preview: "browser", rightsStatus: "pending",
          objectKey: `shared/${id}.mp4`, objectVersionId: "version-1", tags: ["County"],
          updatedAtSort: date, createdAt: date, updatedAt: date, createdBy: "staff-1",
        }) }));
        if (Object.keys(filter).length) documents.splice(1, 0, {
          id: "asset-other", data: () => ({ ...documents[0].data(), name: "Other video",
            nameSort: "other video", tags: ["Other"], createdBy: "other-staff", rightsStatus: "complete" }),
        });
        const firestore = { collection: () => {
          const criteria = [];
          let order;
          let start;
          let pageLimit;
          const query = {
            where(field, operator, value) { criteria.push({ field, operator, value }); return this; },
            orderBy(field) { if (field !== "__name__") order = field; return this; },
            startAfter(value, id) { start = id; return this; },
            limit(value) { pageLimit = value; return this; },
            async get() {
              if (order === "sizeBytes") throw Object.assign(new Error("The query requires an index. That index is currently building."), { code: 9 });
              if (start === "old-size-page") return { docs: [] };
              const matching = documents.filter(document => criteria.every(({ field, operator, value }) => {
                const stored = document.data()[field];
                return operator === "array-contains" ? stored.includes(value) : stored === value;
              }));
              return { docs: matching.slice(start === "asset-1" ? 1 : 0, pageLimit) };
            },
          };
          return query;
        } };
        const source = { id: sourceId, prefix: "shared/" };
        const fields = { sourceId, q: "", ...filter, sort, limit: 1 };
        const cursor = encodeCursor({ ...fields, order: sort, id: "old-size-page", sort: 42 });
        const page = await sourceMedia.readSourceMediaPage(firestore, source, parse({ ...fields, cursor }), "__name__");
        expect(page).toMatchObject({ sortFallback: "updated_desc", hasMore: true, records: [{ id: "asset-1" }] });
        // A size cursor cannot enter update order. The returned cursor starts that order at page 1.
        const next = parse({ ...fields, sort: "updated_desc", cursor: page.nextCursor });
        expect(next.cursor).toEqual({ id: "asset-1", sort: date });
        const second = await sourceMedia.readSourceMediaPage(firestore, source, next, "__name__");
        expect(second).toMatchObject({ records: [{ id: "asset-2" }], hasMore: false });
        expect(second.sortFallback).toBeUndefined();
      });
    }
  }

  it.each([
    { code: 7, message: "Permission denied for index" },
    { code: 9, message: "A different precondition failed" },
  ])("does not hide unrelated size-query errors: %j", async error => {
    const { firestore } = queryRecorder();
    const collection = firestore.collection();
    collection.get = async () => { throw Object.assign(new Error(error.message), { code: error.code }); };
    await expect(sourceMedia.readSourceMediaPage(firestore, { id: sourceId }, parse({ sourceId, sort: "size_desc" }), "__name__"))
      .rejects.toMatchObject(error);
  });

  it.each(filters.slice(1))("does not return the source total as a filtered count: %j", async (filter) => {
    const readTotalFn = vi.fn();
    const handler = sourceMedia.createCmsListSourceMediaHandler({
      firestore: {}, requirePrincipalFn: async () => ({ uid: "staff-1" }),
      registryFn: () => new Map([[sourceId, { id: sourceId }]]), authorizeFn: async () => true,
      readPageFn: async () => ({ records: [], hasMore: false, nextCursor: null }),
      readTotalFn, documentIdField: "__name__", log: { error: vi.fn() },
    });
    const res = { set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    const body = { sourceId, ...filter };
    await handler({ method: "POST", body, headers: { "content-type": "application/json" }, rawBody: Buffer.from(JSON.stringify(body)) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(null);
    expect(readTotalFn).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import listMedia from "../../functions/list-media.js";
import mediaCorpus from "../../functions/lib/media-corpus.js";

const { createCmsListMediaHandler, INDEX_REQUIRED_MESSAGE } = listMedia;
const { encodeMediaCorpusCursor, parseMediaCorpusRequest } = mediaCorpus;
const actor = (sections = ["news"]) => ({
  uid: "editor-1", approvedActive: true,
  principal: { id: "editor-1", grants: [{ role: "editor", sections, registeredMediaSections: sections }] },
});
const asset = (index, overrides = {}) => ({
  id: `asset-${String(index).padStart(5, "0")}`, name: `Photo ${index}`,
  originalName: `photo-${index}.png`, category: "news", tags: [], kind: "image",
  mimeType: "image/png", sizeBytes: 128, width: 1, height: 1,
  url: `https://media.example.invalid/${index}.png`, lifecycle: "active", version: 1,
  storageKey: "private-key", contentHash: "private-hash", ...overrides,
});

// Immutable query double records raw document reads separately from count index entries.
function database(records, failure) {
  const reads = { documents: [], limits: [], countLimits: [], countEntries: [] };
  function query(state = {}) {
    return {
      where(field, op, value) { expect([field, op, value]).toEqual(["lifecycle", "==", "active"]); return query(state); },
      orderBy() { return query(state); },
      select(...fields) { expect(fields).not.toContain("storageKey"); return query(state); },
      startAfter(after) { return query({ ...state, after }); },
      limit(limit) { return query({ ...state, limit }); },
      count() { return { get: async () => {
        reads.countLimits.push(state.limit);
        if (failure) throw failure;
        const count = Math.min(records.length, state.limit);
        reads.countEntries.push(count);
        return { data: () => ({ count }) };
      } }; },
      async get() {
        reads.limits.push(state.limit);
        const found = records.filter(record => !state.after || record.id > state.after).slice(0, state.limit);
        reads.documents.push(found.length);
        return { docs: found.map(record => ({ id: record.id, data: () => record })) };
      },
    };
  }
  return { reads, collection: name => { expect(name).toBe("media_assets"); return query(); } };
}

async function request(db, body, user = actor(), authError) {
  const auth = vi.fn(async () => { if (authError) throw authError; return user; });
  const response = { headersSent: false, headers: {}, set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; this.headersSent = true; } };
  await createCmsListMediaHandler({ firestore: db, requirePrincipalFn: auth, log: { error() {}, warn() {} } })(
    { method: "POST", body, headers: { "content-type": "application/json" } }, response,
  );
  expect(auth).toHaveBeenCalledWith(expect.anything(), { includeAccountStatus: true });
  expect(response.headers["Cache-Control"]).toBe("private, no-store");
  return response;
}

describe("bounded Images corpus", () => {
  it.each([605, 5000])("reads %s records once with bounded lookahead and count work", async size => {
    const db = database(Array.from({ length: size }, (_, i) => asset(i)));
    const ids = [];
    let cursor;
    do {
      const res = await request(db, { corpus: true, limit: 500, ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["nextCursor", "records", "success"]);
      expect(res.body.records.every(row => !Object.hasOwn(row, "storageKey") && !Object.hasOwn(row, "contentHash"))).toBe(true);
      ids.push(...res.body.records.map(row => row.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    const pages = Math.ceil(size / 500);
    expect(ids).toEqual(Array.from({ length: size }, (_, i) => asset(i).id));
    expect(db.reads.documents.reduce((a, b) => a + b, 0)).toBe(size + pages - 1);
    expect(db.reads.limits).toEqual(Array(pages).fill(501));
    expect(db.reads.countLimits).toEqual(Array(pages).fill(5001));
    // Firestore count billing is separate: one read per 1,000 matched index entries.
    expect(db.reads.countEntries.reduce((sum, count) => sum + Math.max(1, Math.ceil(count / 1000)), 0))
      .toBe(size === 605 ? 2 : 50);
  });

  it("refuses 5,001 active records even when the caller supplies a cursor near the end", async () => {
    const db = database(Array.from({ length: 5001 }, (_, i) => asset(i)));
    const res = await request(db, { corpus: true, cursor: encodeMediaCorpusCursor("editor-1", asset(4999).id) });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: INDEX_REQUIRED_MESSAGE });
    expect(db.reads.countEntries).toEqual([5001]);
    expect(db.reads.documents).toEqual([]);
  });

  it("advances past a malformed batch without returning invalid summaries or totals", async () => {
    const db = database([asset(0, { category: "invalid/category" }), asset(1, { version: 0 }), asset(2, { category: "arts" })]);
    const first = await request(db, { corpus: true, limit: 2 });
    expect(first.body).toEqual({ success: true, records: [], nextCursor: expect.any(String) });
    expect(parseMediaCorpusRequest({ corpus: true, cursor: first.body.nextCursor }, "editor-1").after).toBe(asset(1).id);
    const last = await request(db, { corpus: true, limit: 2, cursor: first.body.nextCursor });
    expect(last.body.records.map(row => row.id)).toEqual([asset(2).id]);
    expect(last.body.nextCursor).toBeNull();
    expect(db.reads.documents).toEqual([3, 1]);
  });

  it("checks current grants on a later batch and a forged location hint", async () => {
    const db = database([asset(0), asset(1), asset(2, { category: "arts" })]);
    const first = await request(db, { corpus: true, limit: 1 });
    const second = await request(db, { corpus: true, cursor: first.body.nextCursor }, actor(["arts"]));
    expect(second.body.records.map(row => row.id)).toEqual([asset(1).id, asset(2).id]);
    const forged = await request(db, { corpus: true, cursor: encodeMediaCorpusCursor("editor-1", "a") }, actor(["arts"]));
    expect(forged.body.records.map(row => row.id)).toEqual([asset(0).id, asset(1).id, asset(2).id]);
    const readsBeforeDenial = structuredClone(db.reads);
    const viewer = { ...actor(), principal: { id: "editor-1", grants: [{ role: "staff" }] } };
    for (const user of [viewer, actor([])]) {
      for (const cursor of [first.body.nextCursor, encodeMediaCorpusCursor("editor-1", "a")]) {
        const denied = await request(db, { corpus: true, cursor }, user);
        expect(denied.statusCode).toBe(403);
        expect(denied.body).toEqual({ error: "You do not have permission to list media." });
      }
    }
    expect(db.reads).toEqual(readsBeforeDenial);
  });

  it.each([401, 403])("performs no reads after authentication refuses %s", async status => {
    const db = database([asset(0)]);
    const res = await request(db, { corpus: true }, actor(), Object.assign(new Error("Refused"), { status }));
    expect(res.statusCode).toBe(status);
    expect(db.reads.countLimits).toEqual([]);
  });
  it.each([{ ...actor(), approvedActive: false }, actor([])])("refuses inactive or ungranted callers", async user => {
    const db = database([asset(0)]);
    expect((await request(db, { corpus: true }, user)).statusCode).toBe(403);
    expect(db.reads.countLimits).toEqual([]);
  });
  it.each([9, "failed-precondition", "unavailable"])("fails explicitly on query error %s", async code => {
    const db = database([], Object.assign(new Error("Query failed"), { code }));
    const res = await request(db, { corpus: true });
    expect(res.statusCode).toBe(code === "unavailable" ? 500 : 503);
    expect(res.body).toEqual({ error: "Failed to list media" });
    expect(db.reads.documents).toEqual([]);
  });

  it.each([
    { corpus: false }, { corpus: true, q: "" }, { corpus: true, page: 1 },
    { corpus: true, assetIds: [] }, { corpus: true, counts: true },
    { corpus: true, favorites: true }, { corpus: true, profilePhotoScope: "self" },
    { corpus: true, limit: null }, { corpus: true, limit: 0 }, { corpus: true, limit: 501 }, { corpus: true, limit: 1.5 },
    { corpus: true, cursor: null }, { corpus: true, cursor: "" }, { corpus: true, cursor: "!bad" },
    { corpus: true, cursor: encodeMediaCorpusCursor("other-user", "asset") },
    { corpus: true, cursor: encodeMediaCorpusCursor("editor-1", "bad/path") },
    { corpus: true, cursor: Buffer.from(JSON.stringify({ v: 2, uid: "editor-1", after: "asset" })).toString("base64url") },
    { corpus: true, cursor: Buffer.from(JSON.stringify({ v: 1, uid: "editor-1", after: "asset", total: 10 })).toString("base64url") },
  ])("rejects malformed requests before reading: %j", async body => {
    const db = database([]);
    expect((await request(db, body)).statusCode).toBe(400);
    expect(db.reads.countLimits).toEqual([]);
  });
});

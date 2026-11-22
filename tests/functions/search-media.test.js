import { describe, expect, it, vi } from "vitest";
import searchMedia from "../../functions/search-media.js";

const { createCmsSearchMediaHandler } = searchMedia;
const videos = { id: "video-library", label: "Videos", access: "active_staff", prefix: "station/" };
const originals = { id: "archive-originals", label: "Archive originals", access: "archive", prefix: "original/" };
const working = { id: "archive-working", label: "Archive working files", access: "archive", prefix: "working/" };

function asset(source, id, name = "county meeting", overrides = {}) {
  return { id, data: () => ({
    sourceId: source.id, name, nameSort: name, originalName: `${name}.mp4`,
    lifecycle: "active", kind: "video", mimeType: "video/mp4", sizeBytes: 1024,
    preview: "browser", rightsStatus: "pending", version: 1, tags: [],
    updatedAtSort: "2026-09-14T16:00:00.000Z",
    objectKey: `${source.prefix}${id}.mp4`, objectVersionId: "private-version", ...overrides,
  }) };
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function fixture(documents) {
  const cursors = new Map();
  const reads = [];
  const failedSources = new Set();
  const log = { warn: vi.fn(), error: vi.fn() };
  const actor = {
    uid: "editor-1", approvedActive: true,
    principal: { id: "editor-1", grants: [{ tier: "contributor" }] },
  };
  const firestore = {
    collection(collection) {
      if (collection === "mediaDiscoveryCursors") {
        return { doc: id => ({
          async create(data) { cursors.set(id, data); },
          async get() { return { data: () => cursors.get(id) }; },
        }) };
      }
      if (collection === "mediaCategories") {
        return { doc: id => ({ async get() {
          return { exists: true, data: () => ({ id, active: true, label: "Archive", order: 1, version: 1 }) };
        } }) };
      }
      expect(collection).toBe("mediaSourceAssets");
      const conditions = [];
      const order = [];
      let after;
      let limit;
      const query = {
        where(...condition) { conditions.push(condition); return this; },
        orderBy(...field) { order.push(field); return this; },
        startAfter(...position) { after = position; return this; },
        limit(count) { limit = count; return this; },
        async get() {
          const sourceId = conditions.find(([field]) => field === "sourceId")[2];
          reads.push({ sourceId, limit, after });
          if (failedSources.has(sourceId)) throw new Error("Fixture source read failed");
          expect(order).toEqual([["nameSort", "asc"], ["__name__", "asc"]]);
          const candidates = documents.filter(document => conditions.every(([field, op, value]) => {
            const stored = document.data()[field];
            if (op === "==") return stored === value;
            const comparison = compare(stored, value);
            return op === ">=" ? comparison >= 0 : comparison < 0;
          })).sort((a, b) => compare(a.data().nameSort, b.data().nameSort) || compare(a.id, b.id));
          const next = after ? candidates.filter(document =>
            (compare(document.data().nameSort, after[0]) || compare(document.id, after[1])) > 0) : candidates;
          return { docs: next.slice(0, limit) };
        },
      };
      return query;
    },
  };
  const handler = createCmsSearchMediaHandler({
    firestore, log, documentIdField: "__name__", requirePrincipalFn: async () => actor,
    registryFn: () => new Map([videos, working, originals].map(source => [source.id, source])),
  });
  async function request(body) {
    const res = {
      set: vi.fn(), status(code) { this.code = code; return this; }, json(value) { this.body = value; },
    };
    await handler({ method: "POST", body, headers: { "content-type": "application/json" } }, res);
    return res;
  }
  return { request, actor, reads, failedSources };
}

describe("cross-source media search", () => {
  it("reports only authorized coverage and excludes inactive and out-of-prefix assets", async () => {
    const { request, actor, reads } = fixture([
      asset(videos, "valid"), asset(videos, "wrong-prefix", "county meeting", { objectKey: "unrelated/private.mp4" }),
      asset(videos, "trashed", "county meeting", { lifecycle: "trashed" }),
      asset(originals, "archive"), asset(working, "work"), asset(videos, "different-name", "news"),
    ]);
    actor.principal.grants = [{ tier: "viewer" }];
    const result = await request({ q: "county" });
    expect(result.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(result.code).toBe(200);
    expect(result.body).toEqual({
      success: true, nextCursor: null,
      records: [{ id: "valid", sourceId: videos.id, kind: "video", name: "county meeting" }],
      sources: [{ id: videos.id, label: videos.label, fields: ["name"], status: "searched" }],
    });
    expect(reads.map(read => read.sourceId)).toEqual([videos.id]);
    actor.approvedActive = false;
    expect(await request({ q: "county" })).toMatchObject({ code: 403, body: { error: expect.any(String) } });
    expect(reads).toHaveLength(1);
  });

  it("pages ties and Unicode names in Firestore order across the authorized sources", async () => {
    const { request, reads } = fixture([
      asset(originals, "a"), asset(videos, "b"), asset(working, "c"),
      asset(videos, "clip", "county\u{1F3A5}"), asset(videos, "private-use", "county\uE000"),
    ]);
    const first = await request({ q: " ＣＯＵＮＴＹ ", limit: 2 });
    const second = await request({ q: "county", limit: 2, cursor: first.body.nextCursor });
    const third = await request({ q: "county", limit: 2, cursor: second.body.nextCursor });
    expect([first.code, second.code, third.code]).toEqual([200, 200, 200]);
    expect(first.body.records.map(record => record.id)).toEqual(["a", "b"]);
    expect(second.body.records.map(record => record.id)).toEqual(["c", "private-use"]);
    expect(third.body.records.map(record => record.id)).toEqual(["clip"]);
    expect(third.body.nextCursor).toBeNull();
    expect(first.body.sources.map(source => source.id)).toEqual([originals.id, working.id, videos.id]);
    expect(reads).toHaveLength(9);
    expect(reads.every(read => read.limit === 3)).toBe(true);
    expect(reads.slice(3, 6).map(read => read.after)).toEqual(Array(3).fill(["county meeting", "b"]));
  });

  it("advances past a rejected boundary without disclosing it in a response or cursor", async () => {
    const { request } = fixture([
      asset(originals, "hidden", "county first", { objectKey: "wrong/source.mp4" }), asset(videos, "valid"),
    ]);
    const first = await request({ q: "county", limit: 1 });
    expect(first.body.records).toEqual([]);
    expect(first.body.nextCursor).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(first.body)).not.toContain("hidden");
    const next = await request({ q: "county", limit: 1, cursor: first.body.nextCursor });
    expect(next.body.records.map(record => record.id)).toEqual(["valid"]);
    expect(next.body.nextCursor).toBeNull();
  });

  it("retains healthy results and retries a failed source from the same continuation", async () => {
    const { request, failedSources } = fixture([
      asset(videos, "a"), asset(originals, "b"), asset(working, "c"), asset(videos, "d"),
    ]);
    const first = await request({ q: "county", limit: 1 });
    const body = { q: "county", limit: 1, cursor: first.body.nextCursor };
    failedSources.add(originals.id);
    const partial = await request(body);
    expect(partial.code).toBe(200);
    expect(partial.body.records.map(record => record.id)).toEqual(["c"]);
    expect(partial.body.nextCursor).toBeNull();
    expect(partial.body.sources.map(({ id, status }) => [id, status])).toEqual([
      [originals.id, "unavailable"], [working.id, "searched"], [videos.id, "searched"],
    ]);
    expect(partial.body.sources[0].error).toContain("Retry this page");
    expect(JSON.stringify(partial.body)).not.toContain("Fixture source read failed");
    failedSources.clear();
    const retried = await request(body);
    expect(retried.body.records.map(record => record.id)).toEqual(["b"]);
    expect(retried.body.nextCursor).toEqual(expect.any(String));
  });

  it("rejects a continuation when the caller, query or authorized source set changes", async () => {
    const { request, actor, reads } = fixture([asset(videos, "a"), asset(originals, "b")]);
    const first = await request({ q: "county", limit: 1 });
    const body = { q: "county", limit: 1, cursor: first.body.nextCursor };
    expect((await request({ ...body, q: "different" })).code).toBe(409);
    actor.uid = "editor-2";
    expect((await request(body)).code).toBe(409);
    actor.uid = "editor-1";
    actor.principal.grants = [{ tier: "viewer" }];
    expect((await request(body)).code).toBe(409);
    expect(reads).toHaveLength(3);
  });
});

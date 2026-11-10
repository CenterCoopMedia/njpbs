import { describe, expect, it } from "vitest";
import listContent from "../../functions/list-content.js";
import vocabulary from "../../functions/lib/read-published-vocabulary.js";

const principal = { id: "editor", grants: [{ role: "editor", sections: ["news"] }] };
const published = { type: "post", status: "published", section: "news",
  published: { sourceVersion: 1, metadata: { tags: ["education"], categories: ["Schools"] } } };

// Fake the Firestore boundary only. The real handler, authorization and vocabulary builder run.
function store(records) {
  const counts = { reads: 0 };
  let limit = Infinity;
  const query = {
    where: () => query,
    select: () => query,
    limit: value => { limit = value; return query; },
    get: async () => {
      const docs = records.slice(0, limit).map((value, index) => ({ id: String(index), data: () => value }));
      counts.reads += docs.length;
      return { docs };
    },
  };
  return { counts, collection: () => query };
}

function response() {
  return { statusCode: null, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}

describe("published vocabulary read boundary", () => {
  it("returns only authorized published terms and no draft metadata", async () => {
    const db = store([published, { ...published, tags: ["draft-only"] },
      { ...published, section: "watch", published: { sourceVersion: 1, metadata: { tags: ["private-term"] } } }]);
    const handler = listContent.createCmsListContentHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "editor", principal }), log: {} });
    const res = response();
    await handler({ method: "POST", body: { view: "published-vocabulary" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, tags: ["education"], categories: ["Schools"] });
    expect(db.counts.reads).toBe(3);
  });

  it("refuses an unauthorized caller before reading documents", async () => {
    const db = store([published]);
    const handler = listContent.createCmsListContentHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "guest", principal: { id: "guest", grants: [] } }), log: {} });
    const res = response();
    await handler({ method: "POST", body: { view: "published-vocabulary" } }, res);
    expect(res.statusCode).toBe(403);
    expect(db.counts.reads).toBe(0);
  });

  it("fails closed after the bounded scan instead of returning a partial vocabulary", async () => {
    const db = store(Array(vocabulary.MAX_VOCABULARY_POSTS + 10).fill(published));
    await expect(vocabulary.readPublishedVocabulary(db, principal)).rejects.toMatchObject({ status: 413 });
    expect(db.counts.reads).toBe(5001);
  });
});

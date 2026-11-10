// Capability-aware revision reads for pages and posts (#913).
// The endpoint owns both the current-record authorization check and every
// cmsVersionHistory read. Query fakes keep pagination and response shaping
// deterministic without weakening the emulator coverage for Firestore rules.

import { describe, expect, it, vi } from "vitest";

import revisions from "../../functions/revisions.js";

const {
  REVISION_PAGE_SIZE,
  cmsGetRevision,
  cmsListRevisions,
  createCmsGetRevisionHandler,
  createCmsListRevisionsHandler,
  decodeRevisionCursor,
  encodeRevisionCursor,
} = revisions;

describe("deployed endpoint access", () => {
  it("makes both app-authenticated revision endpoints publicly invokable", () => {
    expect(cmsListRevisions.__endpoint.httpsTrigger.invoker).toEqual(["public"]);
    expect(cmsGetRevision.__endpoint.httpsTrigger.invoker).toEqual(["public"]);
  });
});

function makeReq({ method = "POST", body = {} } = {}) {
  return { method, body, ip: "203.0.113.9" };
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
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

function revisionDoc(id, data) {
  return { id, exists: true, data: () => data };
}

function missingDoc(id) {
  return { id, exists: false, data: () => undefined };
}

function makeFirestore({ content = {}, revisions = [], selected = {} } = {}) {
  const calls = [];
  const query = {
    where(field, operator, value) {
      calls.push(["where", field, operator, value]);
      return this;
    },
    orderBy(field, direction) {
      calls.push(["orderBy", field, direction]);
      return this;
    },
    startAfter(...values) {
      calls.push(["startAfter", ...values]);
      return this;
    },
    limit(value) {
      calls.push(["limit", value]);
      return this;
    },
    async get() {
      calls.push(["query.get"]);
      return { docs: revisions };
    },
  };
  return {
    calls,
    collection(name) {
      calls.push(["collection", name]);
      if (name === "cmsVersionHistory") {
        return {
          ...query,
          doc(id) {
            calls.push(["revision.doc", id]);
            return {
              get: async () => selected[id] ?? missingDoc(id),
            };
          },
        };
      }
      return {
        doc(id) {
          calls.push(["content.doc", name, id]);
          return {
            get: async () => {
              const data = content[`${name}/${id}`];
              return data === undefined
                ? missingDoc(id)
                : { id, exists: true, data: () => data };
            },
          };
        },
      };
    },
  };
}

const userFor = (role, uid = `${role}-1`) => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [{ role }] },
});

const noGrants = {
  uid: "none-1",
  email: "fixture-b1329862dd@example.org",
  principal: { id: "none-1", grants: [] },
};

function silentLog() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

const currentPage = {
  createdBy: "owner-1",
  status: "draft",
  version: 4,
  blocks: [],
};

const row = (number) =>
  revisionDoc(`revision-${number}`, {
    collection: "cmsPages",
    documentId: "home",
    action: "update",
    userId: "editor-1",
    userEmail: "editor-1@example.org",
    at: `2026-08-12T20:${String(number).padStart(2, "0")}:00.000Z`,
    before: {
      title: "Old title",
      status: "draft",
      version: number,
      blocks: [{ id: "block-1", type: "richText", visible: true, data: {} }],
    },
    after: {
      title: "New title",
      status: "in_review",
      version: number + 1,
      blocks: [
        {
          id: "block-1",
          type: "image",
          visible: false,
          data: { assetId: "asset-1" },
        },
      ],
    },
  });

function listHandler({ user, firestore, coverage } = {}) {
  return createCmsListRevisionsHandler({
    firestore,
    requirePrincipalFn: async () => user,
    documentIdField: "__name__",
    verifyRevisionTimestampCoverageFn:
      coverage ?? (async () => ({ total: revisionsLength(firestore), timestamped: revisionsLength(firestore) })),
    log: silentLog(),
  });
}

function revisionsLength(firestore) {
  return firestore.__revisionCount ?? 0;
}

async function callList({
  user = userFor("editor"),
  body = { collection: "cmsPages", id: "home" },
  content = { "cmsPages/home": currentPage },
  revisions = [],
  coverage,
} = {}) {
  const firestore = makeFirestore({ content, revisions });
  firestore.__revisionCount = revisions.length;
  const handler = listHandler({ user, firestore, coverage });
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return { firestore, res };
}

async function callGet({
  user = userFor("editor"),
  body = {
    collection: "cmsPages",
    id: "home",
    revisionId: "revision-1",
  },
  content = { "cmsPages/home": currentPage },
  selected = { "revision-1": row(1) },
} = {}) {
  const firestore = makeFirestore({ content, selected });
  const handler = createCmsGetRevisionHandler({
    firestore,
    requirePrincipalFn: async () => user,
    log: silentLog(),
  });
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return { firestore, res };
}

describe("revision cursors", () => {
  it("round-trips one exact newest-first position", () => {
    const value = { at: "2026-08-12T20:15:00.000Z", id: "revision-15" };
    expect(decodeRevisionCursor(encodeRevisionCursor(value))).toEqual(value);
  });

  it("refuses malformed cursors", () => {
    for (const cursor of ["", "not-base64", Buffer.from("{}").toString("base64url")]) {
      expect(() => decodeRevisionCursor(cursor)).toThrow(/cursor/i);
    }
  });
});

describe("cmsListRevisions", () => {
  it("rejects a non-POST request", async () => {
    const firestore = makeFirestore();
    const handler = listHandler({ user: userFor("admin"), firestore });
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("refuses a caller with no content capability before reading Firestore", async () => {
    const { firestore, res } = await callList({ user: noGrants });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
    expect(firestore.calls).toEqual([]);
  });

  it("returns summary-only rows to a site-wide editor", async () => {
    const revisions = Array.from({ length: REVISION_PAGE_SIZE + 1 }, (_, index) => row(index + 1));
    const { res, firestore } = await callList({ revisions });

    expect(res.statusCode).toBe(200);
    expect(res.body.entries).toHaveLength(REVISION_PAGE_SIZE);
    expect(res.body.nextCursor).toEqual(expect.any(String));
    expect(res.body.entries[0]).toMatchObject({
      id: "revision-1",
      action: "update",
      actorEmail: "editor-1@example.org",
      beforeVersion: 1,
      version: 2,
      beforeStatus: "draft",
      status: "in_review",
      beforeBlockCount: 1,
      blockCount: 1,
      mediaReferenceCount: 1,
      diffAvailable: true,
      changedFields: expect.arrayContaining(["blocks", "status", "title", "version"]),
    });
    expect(res.body.entries[0].before).toBeUndefined();
    expect(res.body.entries[0].after).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("Old title");
    expect(firestore.calls).toContainEqual([
      "where",
      "documentId",
      "==",
      "home",
    ]);
  });

  it("marks an incomplete legacy comparison instead of fabricating deltas", async () => {
    const legacy = row(1);
    const data = legacy.data();
    const partial = revisionDoc("revision-1", {
      ...data,
      beforeTruncated: true,
      before: {
        id: "home",
        status: "draft",
        version: 1,
        beforeTruncated: true,
        beforeEstimatedBytes: 990_000,
      },
    });
    const { res } = await callList({ revisions: [partial] });

    expect(res.statusCode).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      beforeTruncated: true,
      diffAvailable: false,
      changedFields: [],
      changedFieldCount: null,
      changedFieldsTruncated: false,
      mediaReferenceCount: 1,
      mediaReferencesAdded: null,
      mediaReferencesRemoved: null,
    });
  });

  it("lets a contributor inspect their own submitted record", async () => {
    const { res } = await callList({
      user: userFor("contributor", "owner-1"),
      content: {
        "cmsPages/home": { ...currentPage, status: "in_review" },
      },
      revisions: [row(1)],
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a contributor inspecting another person's record", async () => {
    const { firestore, res } = await callList({
      user: userFor("contributor", "other-1"),
      revisions: [row(1)],
    });
    expect(res.statusCode).toBe(403);
    expect(firestore.calls).not.toContainEqual(["collection", "cmsVersionHistory"]);
  });

  it("continues after the exact opaque cursor position", async () => {
    const cursor = encodeRevisionCursor({
      at: "2026-08-12T20:15:00.000Z",
      id: "revision-15",
    });
    const { firestore, res } = await callList({
      body: { collection: "cmsPages", id: "home", cursor },
      revisions: [row(16)],
    });
    expect(res.statusCode).toBe(200);
    expect(firestore.calls).toContainEqual([
      "startAfter",
      "2026-08-12T20:15:00.000Z",
      "revision-15",
    ]);
  });

  it("fails closed when a target history row is missing its sortable timestamp", async () => {
    const { res } = await callList({
      revisions: [row(1)],
      coverage: async () => ({ total: 2, timestamped: 1 }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/timestamp/i);
  });

  it("does not expose history when the current record is absent or deleted", async () => {
    const missing = await callList({ content: {}, revisions: [row(1)] });
    const deleted = await callList({
      content: { "cmsPages/home": { ...currentPage, deleted: true } },
      revisions: [row(1)],
    });
    expect(missing.res.statusCode).toBe(404);
    expect(deleted.res.statusCode).toBe(404);
  });

  it("does not let an own-content caller distinguish a missing post from another owner's post", async () => {
    const user = userFor("contributor", "other-1");
    const missing = await callList({
      user,
      body: { collection: "cmsPosts", id: "post-missing" },
      content: {},
    });
    const denied = await callList({
      user,
      body: { collection: "cmsPosts", id: "post-stored" },
      content: {
        "cmsPosts/post-stored": { ...currentPage, createdBy: "owner-1" },
      },
    });
    expect(missing.res.statusCode).toBe(403);
    expect(missing.res.body).toEqual(denied.res.body);
  });

  it.each([
    null,
    [],
    { collection: "users", id: "home" },
    { collection: "cmsPages", id: "bad/id" },
  ])("rejects malformed request %j", async (body) => {
    const { firestore, res } = await callList({ body });
    expect(res.statusCode).toBe(400);
    expect(firestore.calls).toEqual([]);
  });
});

describe("cmsGetRevision", () => {
  it("returns one complete immutable before/after row after record authorization", async () => {
    const { res } = await callGet();
    expect(res.statusCode).toBe(200);
    expect(res.body.revision).toMatchObject({
      id: "revision-1",
      collection: "cmsPages",
      documentId: "home",
      before: { title: "Old title", version: 1 },
      after: { title: "New title", version: 2 },
    });
  });

  it("does not reveal a revision before current-record authorization", async () => {
    const { firestore, res } = await callGet({
      user: userFor("contributor", "other-1"),
    });
    expect(res.statusCode).toBe(403);
    expect(firestore.calls).not.toContainEqual(["collection", "cmsVersionHistory"]);
  });

  it("returns the same not-found answer for a missing or mismatched revision", async () => {
    const missing = await callGet({ selected: {} });
    const mismatched = await callGet({
      selected: {
        "revision-1": revisionDoc("revision-1", {
          ...row(1).data(),
          documentId: "contact",
        }),
      },
    });
    expect(missing.res.statusCode).toBe(404);
    expect(mismatched.res.statusCode).toBe(404);
    expect(missing.res.body).toEqual(mismatched.res.body);
  });

  it("rejects an invalid revision id before reading Firestore", async () => {
    const { firestore, res } = await callGet({
      body: {
        collection: "cmsPages",
        id: "home",
        revisionId: "bad/id",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(firestore.calls).toEqual([]);
  });
});

describe("section-scoped revision reads (#845)", () => {
  // A revision list is a read of the record's history, so it is authorized against the
  // record itself. A scoped grant that could not open the current document must not be
  // able to read what it used to say -- the history holds the same content.
  const scopedUser = (sections, uid = "scoped-1") => ({
    uid,
    email: `${uid}@example.org`,
    principal: { id: uid, grants: [{ role: "editor", sections }] },
  });

  const watchRecord = { createdBy: "owner-1", status: "draft", version: 2, section: "watch" };
  const stationRecord = { ...watchRecord, section: "station" };
  const legacyRecord = { createdBy: "owner-1", status: "draft", version: 2 };

  it("lists the history of a record in the caller's own desk", async () => {
    const { res } = await callList({
      user: scopedUser(["watch"]),
      body: { collection: "cmsPosts", id: "a-1" },
      content: { "cmsPosts/a-1": watchRecord },
      revisions: [],
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses the history of a record in another desk", async () => {
    const { res } = await callList({
      user: scopedUser(["watch"]),
      body: { collection: "cmsPosts", id: "a-2" },
      content: { "cmsPosts/a-2": stationRecord },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses the history of a record carrying no desk", async () => {
    const { res } = await callList({
      user: scopedUser(["watch"]),
      body: { collection: "cmsPosts", id: "a-3" },
      content: { "cmsPosts/a-3": legacyRecord },
    });
    expect(res.statusCode).toBe(403);
  });

  it("authorizes a page's history against its server-owned public area", async () => {
    const inArea = await callList({
      user: scopedUser(["watch"]),
      body: { collection: "cmsPages", id: "watch" },
      content: { "cmsPages/watch": currentPage },
    });
    expect(inArea.res.statusCode).toBe(200);

    const outOfArea = await callList({
      user: scopedUser(["watch"]),
      body: { collection: "cmsPages", id: "support" },
      content: { "cmsPages/support": currentPage },
    });
    expect(outOfArea.res.statusCode).toBe(403);
  });

  it("leaves a site-wide editor's history reads unchanged", async () => {
    for (const [id, document] of [
      ["a-1", watchRecord],
      ["a-2", stationRecord],
      ["a-3", legacyRecord],
    ]) {
      const { res } = await callList({
        user: userFor("editor"),
        body: { collection: "cmsPosts", id },
        content: { [`cmsPosts/${id}`]: document },
      });
      expect(res.statusCode, id).toBe(200);
    }
  });
});

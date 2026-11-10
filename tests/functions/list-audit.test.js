// cmsListAudit, the admin-only server boundary for the append-only activity log (#205).
// Query fakes keep authorization, pagination, and response-shaping tests deterministic.

import { describe, expect, it, vi } from "vitest";

import listAudit from "../../functions/list-audit.js";

const {
  AUDIT_PAGE_SIZE,
  FORBIDDEN_MESSAGE,
  createCmsListAuditHandler,
  decodeAuditCursor,
  encodeAuditCursor,
} = listAudit;

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

function auditDoc(id, data) {
  return { id, data: () => data };
}

function makeFirestore(docs = [], directory = {}) {
  const calls = [];
  // Read-time name resolution (#1038) reads the directory through the path form,
  // which is recorded separately so the audit query's own call sequence stays
  // exactly assertable.
  const directoryReads = [];
  const writes = [];
  const query = {
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
      calls.push(["get"]);
      return { docs };
    },
  };
  return {
    calls,
    directoryReads,
    writes,
    collection(name) {
      calls.push(["collection", name]);
      return query;
    },
    doc(path) {
      return {
        path,
        set: (...args) => writes.push(["set", path, ...args]),
        update: (...args) => writes.push(["update", path, ...args]),
        async get() {
          directoryReads.push(path);
          const data = directory[path];
          return { id: path, exists: data !== undefined, data: () => data };
        },
      };
    },
    async getAll(...refs) {
      return Promise.all(
        refs.map((ref) => {
          directoryReads.push(ref.path);
          const data = directory[ref.path];
          return { id: ref.path, exists: data !== undefined, data: () => data };
        }),
      );
    },
  };
}

const userFor = (role) => ({
  uid: `${role}-1`,
  email: `${role}fixture-8b84215fb7@example.org`,
  principal: { id: `${role}-1`, grants: [{ role }] },
});

function silentLog() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

async function call({
  user,
  body = {},
  docs = [],
  directory = {},
  log = silentLog(),
  verifyAuditTimestampCoverageFn = async () => ({
    total: docs.length,
    timestamped: docs.length,
  }),
}) {
  const firestore = makeFirestore(docs, directory);
  const handler = createCmsListAuditHandler({
    firestore,
    requirePrincipalFn: async () => user,
    documentIdField: "__name__",
    verifyAuditTimestampCoverageFn,
    log,
  });
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return { res, firestore, log };
}

const entry = (number) =>
  auditDoc(`log-${String(number).padStart(3, "0")}`, {
    actorUid: "editor-1",
    actorEmail: "editor@example.org",
    action: "cms.save",
    target: `cmsPages/page-${number}`,
    before: { status: "draft", count: number - 1 },
    after: { status: "in_review", count: number },
    source: "203.0.113.9",
    at: new Date(Date.UTC(2026, 7, 12, 20, number % 60)).toISOString(),
  });

describe("audit cursors", () => {
  it("round-trips one exact sort position", () => {
    const value = { at: "2026-08-12T20:15:00.000Z", id: "log-1" };
    expect(decodeAuditCursor(encodeAuditCursor(value))).toEqual(value);
  });

  it("refuses malformed or unbounded cursors", () => {
    for (const cursor of ["", "not-base64", Buffer.from("{}").toString("base64url")]) {
      expect(() => decodeAuditCursor(cursor)).toThrow(/cursor/i);
    }
  });
});

describe("cmsListAudit", () => {
  it("rejects non-POST requests", async () => {
    const handler = createCmsListAuditHandler({
      firestore: makeFirestore(),
      requirePrincipalFn: async () => userFor("admin"),
      documentIdField: "__name__",
      log: silentLog(),
    });
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it.each(["staff", "editor", "contributor"])(
    "refuses a %s before reading Firestore",
    async (role) => {
      const { res, firestore } = await call({ user: userFor(role) });
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
      expect(firestore.calls).toEqual([]);
    },
  );

  it.each(["admin", "super_admin"])(
    "returns the newest bounded audit page to a %s",
    async (role) => {
      const docs = Array.from({ length: AUDIT_PAGE_SIZE + 1 }, (_, index) => entry(index + 1));
      const { res, firestore } = await call({ user: userFor(role), docs });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(AUDIT_PAGE_SIZE);
      expect(res.body.entries[0]).toMatchObject({
        id: "log-001",
        actorEmail: "editor@example.org",
        action: "cms.save",
        target: "cmsPages/page-1",
      });
      expect(res.body.nextCursor).toEqual(expect.any(String));
      expect(firestore.calls).toEqual([
        ["collection", "admin_logs"],
        ["orderBy", "at", "desc"],
        ["orderBy", "__name__", "desc"],
        ["limit", AUDIT_PAGE_SIZE + 1],
        ["get"],
      ]);
    },
  );

  it("continues after the exact cursor position", async () => {
    const cursor = encodeAuditCursor({ at: "2026-08-12T20:15:00.000Z", id: "log-015" });
    const { res, firestore } = await call({
      user: userFor("admin"),
      body: { cursor },
      docs: [entry(16)],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(firestore.calls).toContainEqual([
      "startAfter",
      "2026-08-12T20:15:00.000Z",
      "log-015",
    ]);
  });

  it("fails clearly instead of truncating history at an invalid page timestamp", async () => {
    const docs = Array.from({ length: AUDIT_PAGE_SIZE + 1 }, (_, index) => entry(index + 1));
    docs[AUDIT_PAGE_SIZE - 1] = auditDoc("log-invalid", {
      actorUid: "editor-1",
      action: "cms.save",
      at: "not-a-canonical-instant",
    });
    const log = silentLog();

    const { res } = await call({ user: userFor("admin"), docs, log });

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "Administrative activity contains an invalid timestamp",
    });
    expect(log.error).toHaveBeenCalledWith(
      "cmsListAudit found a row with an invalid timestamp",
      { id: "log-invalid" },
    );
  });

  it("rejects a bad cursor before opening the query", async () => {
    const { res, firestore } = await call({
      user: userFor("admin"),
      body: { cursor: "bad" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cursor/i);
    expect(firestore.calls).toEqual([]);
  });

  it("fails closed before the page query when the timestamp index omits a row", async () => {
    const log = silentLog();
    const { res, firestore } = await call({
      user: userFor("admin"),
      docs: [entry(1)],
      log,
      verifyAuditTimestampCoverageFn: async () => ({
        total: 2,
        timestamped: 1,
      }),
    });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/missing.*timestamp/i);
    expect(firestore.calls).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      "cmsListAudit found rows missing from the timestamp index",
      { total: 2, timestamped: 1 },
    );
  });

  it.each([null, [], "cursor"])(
    "rejects a non-object request body before opening the query",
    async (body) => {
      const { res, firestore } = await call({
        user: userFor("admin"),
        body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/object/i);
      expect(firestore.calls).toEqual([]);
    },
  );

  it("returns only bounded evidence", async () => {
    const huge = "x".repeat(20_000);
    const { res } = await call({
      user: userFor("admin"),
      docs: [
        auditDoc("log-large", {
          actorUid: "admin-1",
          action: "cms.save",
          target: "cmsPages/home",
          before: { body: huge },
          after: { status: "draft" },
          at: "2026-08-12T20:15:00.000Z",
        }),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.entries[0].before).toEqual({
      truncated: true,
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(res.body).length).toBeLessThan(20_000);
  });

  it("returns content API attribution only in its exact stored shape", async () => {
    const digest = "a".repeat(64);
    const { res } = await call({
      user: userFor("admin"),
      docs: [
        auditDoc("log-agent", { actorUid: "agent-1", action: "cms.save", at: "2026-11-03T20:00:00.000Z",
          automation: { requestReference: "Slack thread from Emery", planDigest: digest } }),
        auditDoc("log-malformed", { actorUid: "agent-1", action: "cms.save", at: "2026-11-03T19:00:00.000Z",
          automation: { requestReference: "x".repeat(300), planDigest: digest } }),
        auditDoc("log-staff", { actorUid: "editor-1", action: "cms.save", at: "2026-11-03T18:00:00.000Z" }),
      ],
    });
    expect(res.statusCode).toBe(200);
    const [agent, malformed, staff] = res.body.entries;
    expect(agent.automation).toEqual({ requestReference: "Slack thread from Emery", planDigest: digest });
    expect(malformed).not.toHaveProperty("automation");
    expect(staff).not.toHaveProperty("automation");
  });

  it("bounds identity and action strings from a malformed stored row", async () => {
    const huge = "x".repeat(5_000);
    const { res } = await call({
      user: userFor("admin"),
      docs: [
        auditDoc("log-large-fields", {
          actorUid: huge,
          actorEmail: huge,
          action: huge,
          at: "2026-08-12T20:15:00.000Z",
        }),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      actorUid: null,
      actorEmail: null,
      action: "unknown",
    });
  });

  it("replaces blank stored identity and action strings with safe fallbacks", async () => {
    const { res } = await call({
      user: userFor("admin"),
      docs: [
        auditDoc("log-blank-fields", {
          actorUid: "   ",
          actorEmail: "\t",
          action: "  ",
          at: "2026-08-12T20:15:00.000Z",
        }),
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      actorUid: null,
      actorEmail: null,
      action: "unknown",
    });
  });

  // Readable people and content names in Activity (#1038). The stored row is
  // evidence and is returned unchanged; the readable half is joined at read time.
  describe("readable names", () => {
    const directory = {
      "users/editor-1": {
        displayName: "Blake Sutton",
        email: "fixture-66fbd8d9a5@example.org",
        active: true,
      },
      "cmsPages/page-1": { title: "Watch", type: "page" },
    };

    it("returns the current person and record names with the stored row intact", async () => {
      const { res, firestore } = await call({
        user: userFor("admin"),
        docs: [entry(1)],
        directory,
      });

      expect(res.statusCode).toBe(200);
      const [row] = res.body.entries;
      expect(row.resolved).toMatchObject({
        action: { label: "Content saved", known: true },
        actor: {
          label: "Blake Sutton",
          status: "active",
          email: "fixture-66fbd8d9a5@example.org",
          uid: "editor-1",
        },
        target: { label: "Watch", type: "Page", status: "found", id: "cmsPages/page-1" },
        source: { label: "Admin app", detail: "203.0.113.9" },
      });
      // The immutable stored fields are still exactly what the server recorded.
      expect(row).toMatchObject({
        actorUid: "editor-1",
        actorEmail: "editor@example.org",
        action: "cms.save",
        target: "cmsPages/page-1",
      });
      expect(firestore.writes).toEqual([]);
      expect(firestore.directoryReads.sort()).toEqual([
        "cmsPages/page-1",
        "users/editor-1",
      ]);
    });

    it("keeps a deleted account and a deleted record readable with their ids", async () => {
      const { res } = await call({ user: userFor("admin"), docs: [entry(1)] });
      const [row] = res.body.entries;
      expect(row.resolved.actor).toMatchObject({
        label: "Deleted account",
        status: "deleted",
        uid: "editor-1",
      });
      expect(row.resolved.target).toMatchObject({
        label: "Deleted content",
        status: "deleted",
        id: "cmsPages/page-1",
      });
    });

    it("makes an unlabeled action code readable and marks it unknown", async () => {
      const { res } = await call({
        user: userFor("admin"),
        docs: [
          auditDoc("log-unknown-code", {
            actorUid: "editor-1",
            action: "cms.brand_new-thing",
            target: "cmsPages/page-1",
            source: null,
            at: "2026-08-18T20:15:00.000Z",
          }),
        ],
        directory,
      });
      expect(res.body.entries[0].resolved.action).toEqual({
        code: "cms.brand_new-thing",
        label: "Brand new thing",
        known: false,
      });
      expect(res.body.entries[0].resolved.source).toEqual({
        label: "Not recorded",
        detail: null,
      });
    });

    it("reads one directory document per distinct account and record across a page", async () => {
      const docs = Array.from({ length: 5 }, (_, index) => entry(1));
      const { res, firestore } = await call({
        user: userFor("admin"),
        docs: docs.map((doc, index) => auditDoc(`log-${index}`, doc.data())),
        directory,
      });
      expect(res.statusCode).toBe(200);
      expect(firestore.directoryReads.sort()).toEqual([
        "cmsPages/page-1",
        "users/editor-1",
      ]);
    });

    it("still serves the page when the directory read fails, without falling back to raw ids", async () => {
      const log = silentLog();
      const firestore = makeFirestore([entry(1)], directory);
      firestore.getAll = async () => {
        throw new Error("directory unavailable");
      };
      const handler = createCmsListAuditHandler({
        firestore,
        requirePrincipalFn: async () => userFor("admin"),
        documentIdField: "__name__",
        verifyAuditTimestampCoverageFn: async () => ({ total: 1, timestamped: 1 }),
        log,
      });
      const res = makeRes();
      await handler(makeReq({ body: {} }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.entries[0].resolved.actor).toMatchObject({
        label: "Name unavailable",
        status: "unknown",
      });
      expect(log.error).toHaveBeenCalled();
    });
  });
});

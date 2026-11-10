import { describe, expect, it, vi } from "vitest";

import repair from "../../functions/scan-media-usage.js";

const {
  MAX_MEDIA_USAGE_REPAIR_OWNERS,
  createCmsScanMediaUsageHandler,
  decodeMediaUsageRepairCursor,
  encodeMediaUsageRepairCursor,
  scanMediaUsagePage,
  validateMediaUsageScanRequest,
} = repair;

const CURSOR_SECRET = "test-media-usage-cursor-secret";

function makeReq({ method = "POST", body = {}, rawBody } = {}) {
  return {
    method,
    body,
    rawBody: rawBody ?? Buffer.from(JSON.stringify(body)),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.40",
    },
    ip: "198.51.100.8",
  };
}

function makeRes() {
  const res = {
    body: null,
    headers: {},
    headersSent: false,
    statusCode: null,
  };
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

function traversalFirestore(idsByCollection) {
  const calls = [];
  return {
    calls,
    collection(collection) {
      calls.push(["collection", collection]);
      let after = null;
      let maximum = null;
      const query = {
        select() {
          calls.push(["select", collection]);
          return this;
        },
        orderBy(field) {
          calls.push(["orderBy", collection, field]);
          return this;
        },
        startAfter(documentId) {
          calls.push(["startAfter", collection, documentId]);
          after = documentId;
          return this;
        },
        limit(value) {
          calls.push(["limit", collection, value]);
          maximum = value;
          return this;
        },
        async get() {
          calls.push(["get", collection]);
          const ids = idsByCollection[collection] ?? [];
          const start = after === null
            ? 0
            : ids.findIndex((id) => id > after);
          const selected = start < 0
            ? []
            : ids.slice(start, start + maximum);
          return { docs: selected.map((id) => ({ id })) };
        },
      };
      return query;
    },
  };
}

function operator(grants = [{ role: "admin" }]) {
  return {
    uid: "operator-1",
    email: "fixture-d01840273b@example.org",
    principal: { id: "operator-1", grants },
  };
}

function silentLog() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

describe("media usage repair cursors and request contract", () => {
  it("round-trips one server-validated position in the fixed traversal order", () => {
    const value = {
      v: 1,
      collection: "cmsPosts",
      documentId: "story-9",
    };
    expect(decodeMediaUsageRepairCursor(
      encodeMediaUsageRepairCursor(value, CURSOR_SECRET),
      CURSOR_SECRET,
    ))
      .toEqual(value);
  });

  it("refuses a forged cursor position without the server secret", () => {
    const cursor = encodeMediaUsageRepairCursor({
      v: 1,
      collection: "cmsPages",
      documentId: "home",
    }, CURSOR_SECRET);
    const replacement = cursor.at(-1) === "A" ? "B" : "A";

    expect(() => decodeMediaUsageRepairCursor(
      `${cursor.slice(0, -1)}${replacement}`,
      CURSOR_SECRET,
    )).toThrow(/cursor/i);
    expect(() => decodeMediaUsageRepairCursor(cursor, "different-server-secret"))
      .toThrow(/cursor/i);
  });

  it.each([
    "",
    "not+base64",
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({
      v: 1,
      collection: "system",
      documentId: "publicDeployment",
    })).toString("base64url"),
    Buffer.from(JSON.stringify({
      v: 1,
      collection: "cmsPages",
      documentId: "home",
      extra: true,
    })).toString("base64url"),
  ])("refuses an invalid or out-of-scope cursor", (cursor) => {
    expect(() => decodeMediaUsageRepairCursor(cursor, CURSOR_SECRET))
      .toThrow(/cursor/i);
  });

  it("accepts only explicit dry-run or apply input with a bounded page", () => {
    expect(validateMediaUsageScanRequest({ mode: "dry-run" })).toEqual({
      mode: "dry-run",
      cursor: null,
      limit: MAX_MEDIA_USAGE_REPAIR_OWNERS,
    });
    expect(validateMediaUsageScanRequest({ mode: "apply", limit: 1 })).toEqual({
      mode: "apply",
      cursor: null,
      limit: 1,
    });
    for (const body of [
      {},
      { mode: "read" },
      { mode: "apply", limit: 0 },
      { mode: "apply", limit: MAX_MEDIA_USAGE_REPAIR_OWNERS + 1 },
      { mode: "apply", collection: "cmsPages" },
    ]) {
      expect(() => validateMediaUsageScanRequest(body)).toThrow();
    }
  });
});

describe("bounded media usage traversal", () => {
  it("scans ids in fixed collection order and resumes after an exact cursor", async () => {
    const firestore = traversalFirestore({
      cmsPages: ["about", "home"],
      cmsPosts: ["story-1"],
      cmsSettings: ["fixture-settings"],
    });
    const inspectOwnerFn = vi.fn(async ({ documentId }) => ({
      status: documentId === "about" ? "would_repair" : "unchanged",
    }));
    const repairOwnerFn = vi.fn();

    const first = await scanMediaUsagePage({
      firestore,
      mode: "dry-run",
      limit: 2,
      actorUid: "operator-1",
      actorEmail: "fixture-d01840273b@example.org",
      source: "203.0.113.40",
      cursorSecret: CURSOR_SECRET,
      documentIdField: "__name__",
      inspectOwnerFn,
      repairOwnerFn,
    });

    expect(first).toEqual({
      mode: "dry-run",
      summary: {
        scanned: 2,
        wouldRepair: 1,
        repaired: 0,
        unchanged: 1,
        missing: 0,
      },
      nextCursor: expect.any(String),
    });
    expect(decodeMediaUsageRepairCursor(first.nextCursor, CURSOR_SECRET)).toEqual({
      v: 1,
      collection: "cmsPages",
      documentId: "home",
    });
    expect(inspectOwnerFn.mock.calls.map(([input]) => [
      input.collection,
      input.documentId,
    ])).toEqual([
      ["cmsPages", "about"],
      ["cmsPages", "home"],
    ]);
    expect(repairOwnerFn).not.toHaveBeenCalled();

    inspectOwnerFn.mockClear();
    inspectOwnerFn.mockImplementation(async () => ({ status: "unchanged" }));
    const second = await scanMediaUsagePage({
      firestore,
      mode: "dry-run",
      cursor: first.nextCursor,
      limit: 2,
      actorUid: "operator-1",
      cursorSecret: CURSOR_SECRET,
      documentIdField: "__name__",
      inspectOwnerFn,
      repairOwnerFn,
    });

    expect(second.nextCursor).toBeNull();
    expect(inspectOwnerFn.mock.calls.map(([input]) => [
      input.collection,
      input.documentId,
    ])).toEqual([
      ["cmsPosts", "story-1"],
      ["cmsSettings", "fixture-settings"],
    ]);
    expect(firestore.calls).toContainEqual([
      "startAfter",
      "cmsPages",
      "home",
    ]);
    expect(firestore.calls.some(([operation, collection]) =>
      operation === "collection" &&
      (collection === "system" || collection.includes("deployed")),
    )).toBe(false);
  });

  it("applies owners sequentially and returns aggregate evidence only", async () => {
    const firestore = traversalFirestore({
      cmsPages: ["home"],
      cmsPosts: [],
      cmsSettings: [],
    });
    const inspectOwnerFn = vi.fn();
    const repairOwnerFn = vi.fn(async () => ({
      status: "repaired",
      collection: "cmsPages",
      documentId: "home",
      changedStates: ["working"],
    }));

    const result = await scanMediaUsagePage({
      firestore,
      mode: "apply",
      limit: 1,
      actorUid: "operator-1",
      cursorSecret: CURSOR_SECRET,
      documentIdField: "__name__",
      inspectOwnerFn,
      repairOwnerFn,
    });

    expect(result).toEqual({
      mode: "apply",
      summary: {
        scanned: 1,
        wouldRepair: 0,
        repaired: 1,
        unchanged: 0,
        missing: 0,
      },
      nextCursor: null,
    });
    expect(inspectOwnerFn).not.toHaveBeenCalled();
    expect(repairOwnerFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("home");
    expect(JSON.stringify(result)).not.toContain("cmsPages");
  });
});

describe("cmsScanMediaUsage operator boundary", () => {
  it.each(["dry-run", "apply"])("refuses a Watch-scoped Editor in %s mode before traversal", async (mode) => {
    const firestore = { collection: vi.fn() };
    const scanMediaUsagePageFn = vi.fn();
    const readCursorSecretFn = vi.fn(() => CURSOR_SECRET);
    const handler = createCmsScanMediaUsageHandler({
      firestore,
      requirePrincipalFn: async () => operator([{ role: "editor", sections: ["watch"] }]),
      readCursorSecretFn,
      scanMediaUsagePageFn,
      log: silentLog(),
    });
    const res = makeRes();

    await handler(makeReq({ body: { mode } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: repair.FORBIDDEN_MESSAGE });
    expect(readCursorSecretFn).not.toHaveBeenCalled();
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(scanMediaUsagePageFn).not.toHaveBeenCalled();
  });

  it("allows a site-wide Editor and forwards only one validated aggregate page", async () => {
    const page = {
      mode: "apply",
      summary: {
        scanned: 1,
        wouldRepair: 0,
        repaired: 1,
        unchanged: 0,
        missing: 0,
      },
      nextCursor: null,
    };
    const scanMediaUsagePageFn = vi.fn(async () => page);
    const handler = createCmsScanMediaUsageHandler({
      firestore: { collection: vi.fn() },
      requirePrincipalFn: async () => operator([{ role: "editor" }]),
      readCursorSecretFn: () => CURSOR_SECRET,
      scanMediaUsagePageFn,
      log: silentLog(),
    });
    const res = makeRes();

    await handler(makeReq({ body: { mode: "apply", limit: 1 } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, ...page });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(scanMediaUsagePageFn).toHaveBeenCalledWith(expect.objectContaining({
      mode: "apply",
      limit: 1,
      cursor: null,
      actorUid: "operator-1",
      actorEmail: "fixture-d01840273b@example.org",
      source: "203.0.113.40",
      cursorSecret: CURSOR_SECRET,
    }));
  });

  it("rejects a large body, an unknown field, and a non-POST method before traversal", async () => {
    const scanMediaUsagePageFn = vi.fn();
    const requirePrincipalFn = vi.fn(async () => operator());
    const handler = createCmsScanMediaUsageHandler({
      requirePrincipalFn,
      readCursorSecretFn: () => CURSOR_SECRET,
      scanMediaUsagePageFn,
      log: silentLog(),
    });

    const large = makeRes();
    await handler(makeReq({
      body: { mode: "dry-run" },
      rawBody: Buffer.alloc(4_097),
    }), large);
    expect(large.statusCode).toBe(413);

    const unknown = makeRes();
    await handler(makeReq({
      body: { mode: "dry-run", collection: "cmsPages" },
    }), unknown);
    expect(unknown.statusCode).toBe(400);

    const method = makeRes();
    await handler(makeReq({ method: "GET" }), method);
    expect(method.statusCode).toBe(405);
    expect(scanMediaUsagePageFn).not.toHaveBeenCalled();
  });
});

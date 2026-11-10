import { describe, expect, it, vi } from "vitest";
import save from "../../functions/save.js";

// This narrow transaction store exercises the real save handler without cloud
// access. The emulator cases in save.test.js cover the actual Firestore writes.
function memoryStore(initial) {
  const rows = new Map(Object.entries(initial));
  let nextId = 0;
  const ref = (path) => ({ path, id: path.split("/").at(-1),
    async get() { return { id: this.id, ref: this, exists: rows.has(path), data: () => structuredClone(rows.get(path)) }; },
  });
  const firestore = {
    doc: ref,
    collection: (path) => ({ doc: (id = `auto-${++nextId}`) => ref(`${path}/${id}`) }),
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: async (reference) => ({
          id: reference.id, ref: reference, exists: rows.has(reference.path),
          data: () => structuredClone(rows.get(reference.path)),
        }),
        set: (reference, value) => writes.push([reference.path, structuredClone(value)]),
      });
      for (const [path, value] of writes) rows.set(path, value);
      return result;
    },
  };
  return { firestore, rows };
}

async function requestSchedule({ scheduleAt, now = "2026-01-31T15:30:00.000Z", status = "approved", baseVersion = 4, role = "admin", kind = "page" }) {
  const collection = kind === "post" ? "cmsPosts" : "cmsPages";
  const original = { id: "contact", title: "Contact NJ PBS", status, blocks: [], createdBy: "u1", version: 4,
    ...(kind === "post" ? { type: "post", slug: "contact", section: "station", tags: [] } : { template: "genericPage" }),
  };
  const { firestore, rows } = memoryStore({ [`${collection}/contact`]: original });
  const handler = save.createCmsSaveHandler({
    firestore, now: () => now,
    requirePrincipalFn: () => ({ uid: "u1", principal: { id: "u1", grants: [{ role }] } }),
    assertPublishReadyFn: async () => {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const res = { statusCode: null, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: {
    collection, id: "contact", baseVersion, document: {}, scheduleAt,
  } }, res);
  return { res, rows, original };
}

describe("publication schedule save boundary", () => {
  it.each([
    ["2026-02-28T15:30:00.000Z", 200],
    ["2026-02-28T15:30:00.001Z", 400],
  ])("enforces the same boundary for a Post: %s", async (scheduleAt, statusCode) => {
    const { res, rows, original } = await requestSchedule({ kind: "post", scheduleAt });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(statusCode);
    if (statusCode === 200) expect(rows.get("cmsPosts/contact")).toMatchObject({ status: "scheduled", publishAt: scheduleAt, version: 5 });
    else expect([...rows]).toEqual([["cmsPosts/contact", original]]);
  });

  it("accepts the exact month-end ceiling and records only a scheduled version", async () => {
    const { res, rows } = await requestSchedule({ scheduleAt: "2026-02-28T15:30:00.000Z" });
    expect(res.body.error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(rows.get("cmsPages/contact")).toMatchObject({ status: "scheduled", version: 5, publishAt: "2026-02-28T15:30:00.000Z" });
    expect(rows.get("cmsPages/contact").published).toBeUndefined();
    expect([...rows.keys()].some(key => key.startsWith("cmsPublishQueue/"))).toBe(false);
    expect([...rows.values()].some(value => value.action === "cms.schedule")).toBe(true);
  });

  it.each([
    ["2026-02-28T15:30:00.001Z", /one calendar month/],
    ["2026-04-01T12:00:00.000Z", /one calendar month/],
    ["2026-01-31T15:30:00.000Z", /future/],
    ["2026-01-30T15:30:00.000Z", /future/],
  ])("refuses %s without a content or audit write", async (scheduleAt, message) => {
    const { res, rows, original } = await requestSchedule({ scheduleAt });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect([...rows]).toEqual([["cmsPages/contact", original]]);
  });

  it.each([
    [{ status: "published" }, 400],
    [{ baseVersion: 3 }, 409],
    [{ role: "contributor" }, 403],
  ])("preserves stage, version, and permission gates: %j", async (overrides, code) => {
    const { res, rows, original } = await requestSchedule({ scheduleAt: "2026-02-01T15:30:00.000Z", ...overrides });
    expect(res.statusCode).toBe(code);
    expect([...rows]).toEqual([["cmsPages/contact", original]]);
  });

  it("uses the New York month ceiling across a daylight-saving transition", async () => {
    const { res, rows } = await requestSchedule({
      now: "2026-02-16T15:30:00.000Z", scheduleAt: "2026-03-16T14:30:00.001Z",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/one calendar month/);
    expect(rows.size).toBe(1);
  });
});

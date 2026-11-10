import { describe, expect, it, vi } from "vitest";
import { createSiteAccessHandler } from "../../functions/site-access";

async function check(profile, user = {}, failure) {
  const verify = failure ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue({
    uid: "staff-1", email: "staff@example.org", emailVerified: true, ...user,
  });
  const firestore = { collection: () => ({ doc: () => ({ get: async () => ({
    exists: Boolean(profile), data: () => profile,
  }) }) }) };
  const res = { code: null, set: vi.fn(), status(code) { this.code = code; return this; }, end() {} };
  await createSiteAccessHandler({ verify, firestore })({ method: "POST", headers: { authorization: "Bearer token" } }, res);
  return res.code;
}
const profile = { email: "staff@example.org", active: true, grants: [{ role: "editor" }] };
describe("site access uses current staff authority", () => {
  it("admits approved CMS staff", async () => { expect(await check(profile)).toBe(204); });
  it.each([null, { ...profile, active: false }, { ...profile, grants: [] },
    { ...profile, email: "someone@example.org" }, { ...profile, grants: [{ role: "unknown" }] },
  ])("refuses missing, disabled or invalid profiles", async (value) => {
    expect(await check(value)).toBe(403);
  });
  it("requires verified email", async () => { expect(await check(profile, { emailVerified: false })).toBe(403); });
  it("refuses revoked tokens and fails closed on infrastructure errors", async () => {
    expect(await check(profile, {}, { status: 401 })).toBe(401);
    expect(await check(profile, {}, new Error("offline"))).toBe(503);
  });
});

const queueId = "AbCdEfGhIjKlMnOpQrSt";
const now = Date.parse("2026-10-12T12:00:00Z");
const previewBody = { preview: { schemaVersion: 1, queueId, persistent: false } };

function previewHarness() {
  const rows = new Map([
    ["users/staff-1", profile],
    [`cmsPreviewQueue/${queueId}`, { collection: "cmsPosts", pageId: "story", status: "ready",
      expiresAt: { toMillis: () => now + 60_000 } }],
    ["cmsPosts/story", { createdBy: "writer", section: "news", status: "draft" }],
  ]);
  const reads = [];
  const masks = [];
  const snapshot = (key, fields) => {
    reads.push(key);
    const stored = rows.get(key);
    return { exists: rows.has(key), data: () => fields && stored
      ? Object.fromEntries(fields.filter(field => Object.hasOwn(stored, field)).map(field => [field, stored[field]]))
      : stored };
  };
  const firestore = {
    collection: name => ({ doc: id => ({ path: `${name}/${id}`,
      get: async () => snapshot(`${name}/${id}`),
    }) }),
    getAll: async (ref, { fieldMask }) => {
      masks.push({ path: ref.path, fields: fieldMask });
      return [snapshot(ref.path, fieldMask)];
    },
  };
  const verify = vi.fn(async () => ({ uid: "staff-1", email: "staff@example.org", emailVerified: true }));
  const handler = createSiteAccessHandler({ verify, firestore, now: () => now });
  async function run(body = previewBody) {
    const res = { code: null, headers: {}, set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      status(code) { this.code = code; return this; }, end() {} };
    await handler({ method: "POST", headers: { authorization: "Bearer fixture" }, body }, res);
    return res;
  }
  return { rows, reads, masks, verify, run };
}

describe("preview Function record boundary", () => {
  it("acknowledges a current record decision and reads identity only from the queue", async () => {
    const h = previewHarness();
    expect(await h.run()).toMatchObject({ code: 204, headers: { "x-njpbs-preview-access": "1" } });
    expect(h.reads).toEqual(["users/staff-1", `cmsPreviewQueue/${queueId}`, "cmsPosts/story"]);
  });
  it("reads only queue and current record access fields", async () => {
    const h = previewHarness();
    expect((await h.run()).code).toBe(204);
    expect(h.masks).toEqual([
      { path: `cmsPreviewQueue/${queueId}`, fields: ["collection", "pageId", "status", "persistent", "expiresAt", "completedAt"] },
      { path: "cmsPosts/story", fields: ["status", "deleted"] },
    ]);
  });
  it.each([null, { ...profile, active: false }, { ...profile, grants: [] },
    { ...profile, email: "other@example.org" }])("uniformly denies current account changes %j", async value => {
    const h = previewHarness();
    if (value === null) h.rows.delete("users/staff-1"); else h.rows.set("users/staff-1", value);
    expect((await h.run()).code).toBe(404);
  });
  it.each([null, { status: "pending" }, { status: "building" }, { status: "failed" }, { status: "expired" },
    { collection: "users" }, { pageId: "../story" }, { expiresAt: null },
    { expiresAt: { toMillis: () => now } }, { persistent: true }])("uniformly denies invalid queues %j", async value => {
    const h = previewHarness();
    if (value === null) h.rows.delete(`cmsPreviewQueue/${queueId}`);
    else h.rows.set(`cmsPreviewQueue/${queueId}`, { ...h.rows.get(`cmsPreviewQueue/${queueId}`), ...value });
    expect((await h.run()).code).toBe(404);
  });
  it.each([null, {}, { schemaVersion: 2, queueId, persistent: false },
    { schemaVersion: 1, queueId: "../queue", persistent: false },
    { schemaVersion: 1, queueId, persistent: "false" },
  ])("refuses malformed preview identities %j", async preview => {
    expect((await previewHarness().run({ preview })).code).toBe(404);
  });
  it("keeps generic session admission without a preview acknowledgment", async () => {
    expect(await previewHarness().run({})).toMatchObject({ code: 204 });
    expect((await previewHarness().run({})).headers).not.toHaveProperty("x-njpbs-preview-access");
  });
  it("supports existing Page queues without a collection discriminator", async () => {
    const h = previewHarness();
    h.rows.set(`cmsPreviewQueue/${queueId}`, { pageId: "contact", status: "ready", expiresAt: { toMillis: () => now + 1 } });
    h.rows.set("cmsPages/contact", { status: "draft", createdBy: "writer" });
    expect((await h.run()).code).toBe(204);
    expect(h.masks[1]).toEqual({ path: "cmsPages/contact", fields: ["status", "deleted"] });
  });
  it("admits active Editors from either area for legacy Page queues", async () => {
    const h = previewHarness();
    h.rows.set(`cmsPreviewQueue/${queueId}`, { pageId: "contact", status: "ready", expiresAt: { toMillis: () => now + 1 } });
    h.rows.set("cmsPages/contact", { status: "draft", createdBy: "writer", section: "news" });
    h.rows.set("users/staff-1", { ...profile, grants: [{ role: "editor", sections: ["station"] }] });
    expect((await h.run()).code).toBe(204);
    h.rows.set("users/staff-1", { ...profile, grants: [{ role: "editor", sections: ["news"] }] });
    expect((await h.run()).code).toBe(204);
  });
  it.each([false, true])("bounds legacy ready output to 24 hours for persistent=%s", async persistent => {
    const h = previewHarness();
    h.rows.set(`cmsPreviewQueue/${queueId}`, { ...h.rows.get(`cmsPreviewQueue/${queueId}`), persistent,
      completedAt: { toMillis: () => now - 24 * 60 * 60 * 1000 },
      expiresAt: { toMillis: () => now + 6 * 86400000 } });
    expect((await h.run({ preview: { ...previewBody.preview, persistent } })).code).toBe(404);
  });
  it("keeps revocation and infrastructure failures distinct", async () => {
    const h = previewHarness();
    h.verify.mockRejectedValueOnce({ status: 401 });
    expect((await h.run()).code).toBe(401);
    h.verify.mockRejectedValueOnce(new Error("offline"));
    expect((await h.run()).code).toBe(503);
  });
});

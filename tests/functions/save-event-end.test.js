import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import restore from "../../functions/restore-revision.js";

const PROJECT = "demo-njpbs";
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const start = "2026-10-13T18:00:00.000Z";
const end = "2026-10-13T19:00:00.000Z";
const event = { type: "event", title: "Optional end fixture", startsAt: start, description: {
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Event details" }] }],
} };
let db;

async function request(document, fields = {}) {
  const response = { statusCode: null, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; } };
  // Replace only authentication; use the actual save handler, contract,
  // transaction, version history and persistence.
  const handler = save.createCmsSaveHandler({ firestore: db,
    requirePrincipalFn: async () => ({ uid: "event-editor", principal: { id: "event-editor", grants: [{ role: "admin" }] } }),
    now: () => "2026-10-12T18:00:00.000Z" });
  await handler({ method: "POST", headers: {}, body: { collection: "cmsPosts", document, ...fields } }, response);
  return response;
}
function ok(response) {
  expect({ status: response.statusCode, error: response.body?.error ?? null }).toEqual({ status: 200, error: null });
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(HOST ?? "")) throw new Error("A local Firestore emulator is required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("save-event-end.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("sections/station").set({ label: "Station" });
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

describe("Event optional end at the save boundary", () => {
  it("keeps non-save revision restore strict for a legacy blank end", async () => {
    const created = await request({ ...event, endsAt: end }, { section: "station" });
    ok(created);
    const ref = db.doc(`cmsPosts/${created.body.id}`);
    const current = (await ref.get()).data();
    await db.doc("cmsVersionHistory/blank-end").set({ collection: "cmsPosts", documentId: created.body.id,
      restorable: true, after: { ...current, endsAt: "" } });
    const response = { statusCode: null, body: null, headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; this.headersSent = true; return this; } };
    await restore.createCmsRestoreRevisionHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "event-editor", principal: { id: "event-editor", grants: [{ role: "admin" }] } }),
      now: () => "2026-10-12T19:00:00.000Z" })({ method: "POST", headers: {}, body: {
      collection: "cmsPosts", id: created.body.id, revisionId: "blank-end", baseVersion: 1,
    } }, response);
    expect(response).toMatchObject({ statusCode: 400, body: { error: "endsAt must be a valid date" } });
    expect((await ref.get()).data()).toEqual(current);
  });
  it.each(["", "  "])("creates a draft when optional Ends is blank (%j)", async endsAt => {
    const response = await request({ ...event, endsAt }, { section: "station" });
    ok(response);
    const stored = (await db.doc(`cmsPosts/${response.body.id}`).get()).data();
    expect(stored).toMatchObject({ type: "event", startsAt: start, status: "draft", version: 1 });
    expect(stored).not.toHaveProperty("endsAt");
    const history = await db.collection("cmsVersionHistory").where("documentId", "==", response.body.id).get();
    expect(history.docs[0].data().after).not.toHaveProperty("endsAt");
  });
  it("clears a saved end while preserving the prior value in history", async () => {
    const created = await request({ ...event, endsAt: end }, { section: "station" });
    ok(created);
    const cleared = await request({ endsAt: "" }, { id: created.body.id, baseVersion: 1 });
    ok(cleared);
    expect((await db.doc(`cmsPosts/${created.body.id}`).get()).data()).not.toHaveProperty("endsAt");
    const history = await db.collection("cmsVersionHistory").where("documentId", "==", created.body.id).where("after.version", "==", 2).get();
    expect(history.docs[0].data().before.endsAt).toBe(end);
    expect(history.docs[0].data().after).not.toHaveProperty("endsAt");
  });
  it("keeps a saved end when an unrelated partial save omits it", async () => {
    const created = await request({ ...event, endsAt: end }, { section: "station" });
    ok(created);
    ok(await request({ title: "Changed title" }, { id: created.body.id, baseVersion: 1 }));
    expect((await db.doc(`cmsPosts/${created.body.id}`).get()).data().endsAt).toBe(end);
  });
  it.each(["tomorrow", "2026-13-13T19:00:00Z"])("refuses a nonblank invalid end (%s) without creating content", async endsAt => {
    const response = await request({ ...event, endsAt }, { section: "station" });
    expect(response).toMatchObject({ statusCode: 400, body: { error: "endsAt must be a valid date" } });
    expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  });
  it("retains the strict required start and end-after-start checks", async () => {
    expect(await request({ ...event, startsAt: "" }, { section: "station" }))
      .toMatchObject({ statusCode: 400, body: { error: "startsAt must be a valid date" } });
    expect(await request({ ...event, endsAt: start }, { section: "station" }))
      .toMatchObject({ statusCode: 400, body: { error: "endsAt must be after startsAt" } });
    expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  });
});

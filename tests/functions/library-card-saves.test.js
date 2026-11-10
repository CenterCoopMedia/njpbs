import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import restore from "../../functions/restore-revision.js";
import media from "../../functions/lib/media-contract.js";

const richText = text => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const actor = grants => ({ uid: "author", email: "author@example.test", principal: { id: "author", grants } });
const contributor = actor([{ role: "contributor" }]);
const publisher = actor([{ role: "editor", sections: ["watch"] }]);
const outsidePublisher = actor([{ role: "contributor" }, { role: "editor", sections: ["news"] }]);
const fixtures = {
  sponsor: { type: "sponsor", name: "Station sponsor", href: "https://example.test/", logoAssetId: "old-art",
    logoAlt: "Sponsor logo", logoDecorative: false, tier: "Supporter", description: "Station support",
    activeFrom: "2026-01-01", activeUntil: "2026-12-31" },
  newsletter: { type: "newsletter", title: "Station newsletter", body: richText("Station news"),
    signupUrl: "https://example.test/join", frequency: "Weekly", summary: "Station updates",
    imageAssetId: "old-art", imageAlt: "Newsletter art", imageDecorative: false },
};
const changes = {
  sponsor: { name: "Changed sponsor", href: "https://changed.example.test/", logoAssetId: "new-art", logoAlt: "",
    logoDecorative: true, tier: "Partner", description: "New description", activeFrom: "2026-02-01", activeUntil: "2026-11-30" },
  newsletter: { title: "Changed newsletter", body: richText("Changed fallback summary"), signupUrl: "https://changed.example.test/join",
    frequency: "Monthly", summary: "Changed summary", imageAssetId: "new-art", imageAlt: "", imageDecorative: true },
};
const publicFieldCases = Object.entries(changes).flatMap(([kind, fields]) =>
  Object.entries(fields).map(([field, value]) => [kind, field, value]));
const collections = ["cmsPosts", "cmsVersionHistory", "admin_logs", "cmsPosts/sponsor/mediaUsage", "cmsPosts/newsletter/mediaUsage",
  "cmsCreateReceipts", "cmsPublishQueue", "media_assets", "media_assets_public"];
let db;

async function invoke(factory, body, user = contributor) {
  const res = { statusCode: 0, body: null, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  await factory({ firestore: db, requirePrincipalFn: async () => user,
    log: { warn() {}, info() {}, error() {} } })({ method: "POST", body, headers: {} }, res);
  return res;
}
const saveRecord = (kind, document, user, extra = {}) => invoke(save.createCmsSaveHandler,
  { collection: "cmsPosts", id: kind, baseVersion: 3, document, ...extra }, user);
async function databaseState() {
  const state = Object.fromEntries(await Promise.all(collections.map(async collection => {
    const snapshot = await db.collection(collection).get();
    return [collection, snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.id.localeCompare(b.id))];
  })));
  const usage = await db.collectionGroup("mediaUsage").get();
  state.mediaUsage = usage.docs.map(doc => ({ path: doc.ref.path, ...doc.data() })).sort((a, b) => a.path.localeCompare(b.path));
  return state;
}

describe("live library card write authorization", () => {
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator for library save tests.");
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("library-card-saves.test.js");
  });
  beforeEach(async () => {
    const reset = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
    expect(reset.ok).toBe(true);
    await db.doc("sections/watch").set({ label: "Watch", order: 1 });
    await db.doc("sections/news").set({ label: "News", order: 2 });
    for (const [kind, fields] of Object.entries(fixtures)) {
      await db.doc(`cmsPosts/${kind}`).set({ id: kind, ...fields, section: "watch", status: "draft",
        createdBy: "author", version: 3, contentVersion: 3, publiclyVisible: true });
    }
    for (const id of ["old-art", "new-art"]) {
      const asset = { lifecycle: "active", category: "general", source: "site_seed", mimeType: "image/png",
        url: `https://media.example.test/${id}.png`, width: 640, height: 360, altText: null };
      await db.doc(`media_assets/${id}`).set(asset);
      await db.doc(`media_assets_public/${id}`).set(media.mediaProjection(asset));
    }
  });

  it.each(publicFieldCases)("denies a contributor's %s %s change without committing state", async (kind, field, value) => {
    const before = await databaseState();
    const accessibility = field === "logoDecorative" ? { logoAlt: "" } : field === "imageDecorative" ? { imageAlt: "" } : {};
    const result = await saveRecord(kind, { [field]: value, ...accessibility });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
    expect(await databaseState()).toEqual(before);
  });

  it.each(["sponsor", "newsletter"])("allows the stored section's publisher to change %s card fields", async kind => {
    const result = await saveRecord(kind, changes[kind], publisher);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect((await db.doc(`cmsPosts/${kind}`).get()).data()).toMatchObject({ ...changes[kind], version: 4 });
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });

  it.each(["sponsor", "newsletter"])("does not accept another section's publish grant for %s", async kind => {
    const before = await databaseState();
    const field = kind === "sponsor" ? "name" : "title";
    const result = await saveRecord(kind, { [field]: "Out-of-scope edit" }, outsidePublisher);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
    expect(await databaseState()).toEqual(before);
  });

  it.each(["sponsor", "newsletter"])("allows unchanged public %s fields and an unrelated save by its contributor", async kind => {
    const result = await saveRecord(kind, { ...fixtures[kind], publishAt: "2026-10-08T12:00:00.000Z" });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect((await db.doc(`cmsPosts/${kind}`).get()).data()).toMatchObject({ ...fixtures[kind], version: 4 });
  });

  it.each(["sponsor", "newsletter"])("denies contributor creation of an exported %s", async kind => {
    const before = await databaseState();
    const result = await invoke(save.createCmsSaveHandler,
      { collection: "cmsPosts", section: "watch", document: { ...fixtures[kind], status: "draft" } });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
    expect(await databaseState()).toEqual(before);
  });

  it.each(["sponsor", "newsletter"])("allows a publisher to create an exported %s", async kind => {
    const result = await invoke(save.createCmsSaveHandler,
      { collection: "cmsPosts", section: "watch", document: { ...fixtures[kind], status: "draft" } }, publisher);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect((await db.doc(`cmsPosts/${result.body.id}`).get()).data()).toMatchObject(fixtures[kind]);
  });

  it.each(["sponsor", "newsletter"])("rejects library %s records at the Post duplication boundary", async kind => {
    const before = await databaseState();
    const result = await invoke(save.createCmsSaveHandler,
      { collection: "cmsPosts", postSource: { id: kind, version: 3 }, idempotencyKey: `duplicate-${kind}`, document: { type: "post" } });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(400);
    expect(await databaseState()).toEqual(before);
  });

  it.each(["sponsor", "newsletter"])("keeps %s visibility server-owned for a contributor", async kind => {
    const result = await saveRecord(kind, { publiclyVisible: false });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect((await db.doc(`cmsPosts/${kind}`).get()).data().publiclyVisible).toBe(true);
  });

  it.each(["sponsor", "newsletter"])("gates %s revision restores with the same publication capability", async kind => {
    await db.doc("cmsVersionHistory/source").set({ collection: "cmsPosts", documentId: kind,
      after: { ...fixtures[kind], ...changes[kind], version: 1 } });
    const request = { collection: "cmsPosts", id: kind, baseVersion: 3, revisionId: "source" };
    const before = await databaseState();
    const denied = await invoke(restore.createCmsRestoreRevisionHandler, request);
    expect(denied.statusCode, JSON.stringify(denied.body)).toBe(403);
    expect(await databaseState()).toEqual(before);
    const allowed = await invoke(restore.createCmsRestoreRevisionHandler, request, publisher);
    expect(allowed.statusCode, JSON.stringify(allowed.body)).toBe(200);
    expect((await db.doc(`cmsPosts/${kind}`).get()).data()).toMatchObject({ ...changes[kind], version: 4 });
  });

  it("still protects a newsletter's body-derived summary when its explicit summary is empty", async () => {
    await db.doc("cmsPosts/newsletter").update({ summary: "" });
    const before = await databaseState();
    const result = await saveRecord("newsletter", { body: richText("Unauthorized public summary") });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
    expect(await databaseState()).toEqual(before);
  });
});

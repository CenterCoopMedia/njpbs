import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import desktop from "../../functions/lib/premiere-desktop-session.js";
import auth from "../../functions/lib/auth.js";
import content from "../../functions/get-content.js";
import library from "../../functions/list-content.js";
import media from "../../functions/list-media.js";
import archive from "../../functions/bulk-archive.js";
import staffAccess from "../../functions/staff-access.js";
import preview from "../../functions/preview.js";
import templates from "../../functions/post-templates.js";
import authorProfiles from "../../functions/author-profiles.js";
import favorites from "../../functions/media-favorites.js";
import discovery from "../../functions/lib/media-discovery.js";

const project = "demo-njpbs";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const tiers = ["viewer", "contributor", "editor", "publisher", "admin", "owner"];
let database;
let uid;
let token;
let email;
async function signIn(verified = true) {
  await admin.auth().updateUser(uid, { emailVerified: verified });
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "synthetic-emulator-password", returnSecureToken: true }),
  });
  token = (await response.json()).idToken;
  auth.resetAuthTokenCache();
}
async function call(handler, body) {
  const result = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, set() { return this; } };
  await handler({ method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, ip: "127.0.0.1" }, result);
  return result;
}
beforeAll(() => {
  for (const host of [firestoreHost, authHost]) if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Local Auth and Firestore required");
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  database = admin.firestore();
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  email = `tier-${crypto.randomUUID()}@example.test`;
  const signup = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "synthetic-emulator-password", returnSecureToken: true }),
  });
  uid = (await signup.json()).localId;
  await signIn();
  await database.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
  await database.doc(discovery.MEDIA_DISCOVERY_STATE)
    .set({ schema: 1, state: "ready", revision: 1 });
  await database.collection("cmsPosts").doc("other-draft").set({
    type: "post", title: "Other person's draft", section: "news", status: "draft", createdBy: "another-person", version: 1,
    slug: "other-draft", previousSlugs: [], locale: "en", tags: [], categories: [],
    description: "A saved draft.", credits: [{ kind: "custom", name: "NJ PBS staff" }],
    blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }],
    heroImage: "shared-image", heroImageAlt: "Shared image", heroImageDecorative: false,
  });
  const image = {
    name: "Shared image", originalName: "shared.png", kind: "image", category: "news", mimeType: "image/png",
    lifecycle: "active", version: 1, sizeBytes: 1000, width: 800, height: 800, createdBy: "another-person", url: "https://media.example.test/shared.png",
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
  };
  await Promise.all(["media_assets", "media_assets_public"].map((collection) =>
    database.collection(collection).doc("shared-image").set(discovery.withMediaDiscovery("shared-image", image))));
});
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });
async function setTier(tier, extra = {}) {
  await database.collection("users").doc(uid).set({ email, accessTier: tier, active: true,
    role: "super_admin", grants: [{ role: "editor" }], ...extra });
}
describe("tier readers through real Auth and Firestore", () => {
  it.each(tiers)("%s can read another person's content and shared image", async (tier) => {
    await setTier(tier);
    const record = await call(content.createCmsGetContentHandler(), { collection: "cmsPosts", id: "other-draft" });
    expect(record.statusCode).toBe(200);
    const list = await call(library.createCmsListContentHandler(), { view: "library", query: "v=1" });
    expect(list.statusCode).toBe(200);
    expect(list.body.records.map((entry) => entry.id)).toContain("other-draft");
    expect(list.body.records.find((entry) => entry.id === "other-draft")).toMatchObject({
      id: "other-draft", thumbnailUrl: "https://media.example.test/shared.png",
    });
    const image = await call(media.createCmsListMediaHandler(), { assetIds: ["shared-image"] });
    expect(image.statusCode).toBe(200);
    expect(image.body.records.map((entry) => entry.id)).toEqual(["shared-image"]);
    const corpus = await call(media.createCmsListMediaHandler(), { corpus: true });
    expect(corpus.statusCode).toBe(200);
    expect(corpus.body.records.map((entry) => entry.id)).toEqual(["shared-image"]);
    const plain = await call(media.createCmsListMediaHandler(), {});
    expect(plain.statusCode).toBe(200);
    expect(plain.body.records.map((entry) => entry.id)).toEqual(["shared-image"]);
    const cursor = await call(media.createCmsListMediaHandler(), { paging: "cursor" });
    expect(cursor.statusCode).toBe(200);
    expect(cursor.body.records.map((entry) => entry.id)).toEqual(["shared-image"]);
    const counted = await call(media.createCmsListMediaHandler(), { counts: true });
    expect(counted.statusCode).toBe(200);
    expect(counted.body.records.map((entry) => entry.id)).toEqual(["shared-image"]);
    expect(counted.body.counts.images).toBe(1);
  });
  it.each(["viewer", "contributor", "editor"])("%s cannot use stale Owner fields to delete content", async (tier) => {
    await setTier(tier);
    const result = await call(archive.createCmsBulkArchiveHandler(), { items: [{ id: "other-draft", baseVersion: 1 }] });
    expect(result.statusCode).toBe(403);
    expect((await database.collection("cmsPosts").doc("other-draft").get()).data().status).toBe("draft");
  });
  it("Publisher can delete content without administrative authority", async () => {
    await setTier("publisher", { role: null, grants: [] });
    const result = await call(archive.createCmsBulkArchiveHandler(), { items: [{ id: "other-draft", baseVersion: 1 }] });
    expect(result.statusCode).toBe(200);
    expect((await database.collection("cmsPosts").doc("other-draft").get()).data().status).toBe("archived");
    await expect(auth.requireAdmin({ headers: { authorization: `Bearer ${token}` } })).rejects.toMatchObject({ status: 403 });
  });
  it.each([null, "unknown"])("present invalid tier %s cannot recover legacy authority", async (tier) => {
    await setTier(tier);
    expect((await call(content.createCmsGetContentHandler(), { collection: "cmsPosts", id: "other-draft" })).statusCode).toBe(403);
    await expect(auth.requireSuperAdmin({ headers: { authorization: `Bearer ${token}` } })).rejects.toMatchObject({ status: 403 });
  });
  it.each(["viewer", "contributor"])("%s can enqueue another person's preview", async (tier) => {
    await setTier(tier);
    const previewHandler = preview.createCmsPreviewHandler({
      firestore: database,
      getTransport: () => "serializer",
      serializerReady: true,
      getRendererSha: () => "a".repeat(40),
      log: { error() {} },
    });
    const result = await call(previewHandler, { collection: "cmsPosts", pageId: "other-draft" });
    expect(result.statusCode).toBe(202);
    expect((await database.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
  it.each(["viewer", "contributor"])("%s cannot create a shared template from another person's draft", async (tier) => {
    await setTier(tier);
    const template = await call(templates.createCmsPostTemplatesHandler({ firestore: database }), {
      action: "capture", mode: "layout", name: "Read-only capture", sourceId: "other-draft", sourceVersion: 1,
      idempotencyKey: "native-template-denial",
    });
    expect(template.statusCode).toBe(403);
    for (const collection of ["cmsPreviewQueue", "cmsPostTemplates", "admin_logs"]) {
      expect((await database.collection(collection).get()).empty).toBe(true);
    }
  });
  it("Contributor can preview and capture their own saved draft", async () => {
    await setTier("contributor");
    await database.collection("cmsPosts").doc("other-draft").update({ createdBy: uid });
    const handler = preview.createCmsPreviewHandler({
      firestore: database, getTransport: () => "serializer", serializerReady: true,
      getRendererSha: () => "a".repeat(40), log: { error() {}, info() {} },
    });
    const accepted = await call(handler, { collection: "cmsPosts", pageId: "other-draft" });
    expect({ status: accepted.statusCode, error: accepted.body.error }).toEqual({ status: 202, error: undefined });
    const captured = await call(templates.createCmsPostTemplatesHandler({ firestore: database }), {
      action: "capture", mode: "layout", name: "Own draft layout", sourceId: "other-draft", sourceVersion: 1,
      idempotencyKey: "native-template-allow",
    });
    expect(captured.statusCode).toBe(200);
    expect((await database.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect((await database.collection("cmsPostTemplates").get()).size).toBe(1);
  });
  it("Viewer can open a shared template whose hero is a readable shared image", async () => {
    await setTier("contributor");
    await database.collection("cmsPosts").doc("other-draft").update({ createdBy: uid });
    const handler = templates.createCmsPostTemplatesHandler({ firestore: database });
    const captured = await call(handler, {
      action: "capture", mode: "layout", name: "Shared image layout", sourceId: "other-draft", sourceVersion: 1,
      idempotencyKey: "native-template-image",
    });
    expect({ status: captured.statusCode, error: captured.body.error }).toEqual({ status: 200, error: undefined });
    await database.collection("cmsPostTemplates").doc(captured.body.template.id)
      .update({ heroImage: "shared-image", heroImageAlt: "Shared image", heroImageDecorative: false });
    await setTier("viewer");
    const opened = await call(handler, { action: "get", id: captured.body.template.id });
    expect({ status: opened.statusCode, error: opened.body.error }).toEqual({ status: 200, error: undefined });
    expect(opened.body.document.heroImage).toBe("shared-image");
    expect(opened.body.mediaWarning).toBeNull();
  });
  it.each(["viewer", "owner"])("unverified %s cannot read or use an administrative guard", async (tier) => {
    await setTier(tier);
    // Exercise the verification guard with a session later than password creation.
    const user = await admin.auth().getUser(uid);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(user.tokensValidAfterTime) + 1000 - Date.now())));
    await signIn(false);
    expect((await call(content.createCmsGetContentHandler(), { collection: "cmsPosts", id: "other-draft" })).statusCode).toBe(403);
    await expect(auth.requireSuperAdmin({ headers: { authorization: `Bearer ${token}` } })).rejects.toMatchObject({ status: 403 });
    const current = await auth.requireAuth({ headers: { authorization: `Bearer ${token}` } });
    const sessions = desktop.createDesktopSessions({ firestore: database, auth: admin.auth() });
    // One second later, because this fixture can sign in during the account's revocation second.
    await expect(sessions.activeActor(uid, current.authTime + 1)).rejects.toMatchObject({ status: 403 });
    const staff = staffAccess.createStaffAccessHandlers({
      firestore: database,
      verifyAppCheckTokenFn: async () => true,
    });
    expect((await call(staff.list, {})).statusCode).toBe(403);
  });
  it("before activation, a planted tier does not change an unverified legacy Owner's staff list access", async () => {
    await database.doc("system/staffAccessActivation").delete();
    await signIn(false);
    const staff = staffAccess.createStaffAccessHandlers({ firestore: database, verifyAppCheckTokenFn: async () => true });
    await database.collection("users").doc(uid).set({ email, role: "super_admin", active: true });
    expect((await call(staff.list, {})).statusCode).toBe(200);
    await database.collection("users").doc(uid).set({ email, role: "super_admin", active: true, accessTier: "viewer" });
    expect((await call(staff.list, {})).statusCode).toBe(200);
  });
  it.each(["contributor", "editor", "publisher", "admin", "owner"])("unverified %s cannot mint, edit or publish an author profile", async (tier) => {
    await setTier(tier);
    await signIn(false);
    for (const [handler, body] of [
      [authorProfiles.createGetAuthorProfileHandler(), {}],
      [authorProfiles.createUpdateAuthorProfileHandler(), { displayName: "Unverified profile" }],
      [authorProfiles.createSetAuthorProfileVisibilityHandler(), { visibility: "published" }],
    ]) {
      expect((await call(handler, body)).statusCode).toBe(403);
    }
    expect((await database.collection("cmsStaffRecords").get()).size).toBe(0);
    expect((await database.collection("cmsAuthorProfiles").get()).size).toBe(0);
    expect((await database.collection("cmsAuthorProfilesPublic").get()).size).toBe(0);
    expect((await database.collection("admin_logs").get()).size).toBe(0);
  });
  it.each([null, "invalid"])("invalid tier %s cannot pass an account-only media admission gate", async (tier) => {
    await setTier(tier);
    expect((await call(favorites.createCmsListMediaFavoritesHandler(), {})).statusCode).toBe(403);
  });
});

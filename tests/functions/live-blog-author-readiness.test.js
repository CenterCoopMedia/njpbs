import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import authors from "../../functions/author-profiles.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const authorId = `au_${"a".repeat(32)}`;
let db;
const profile = () => ({ authorId, uid: null, lifecycle: "active", displayName: "Ada Reporter", jobTitle: "Reporter",
  bio: "Private working biography text", photo: { assetId: "photo-one", url: "https://media.example.test/ada.jpg", mimeType: "image/jpeg",
    width: 512, height: 512, sizeBytes: 1000, focalX: 0.5, focalY: 0.5, credit: null, rightsBasis: "own-photo", attestedAt: "2026-10-30T15:00:00.000Z" },
  visibility: "published", version: 1, updatedAt: "2026-10-30T15:00:00.000Z" });
async function call(factory, role = "editor", body = {}) {
  const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await factory({ firestore: db, requirePrincipalFn: async () => ({ uid: "reviewer", principal: { id: "reviewer", grants: [{ role }] } }),
    log: { error() {} } })({ method: "POST", body }, response);
  return response;
}

describe("live-blog author completeness in the existing directory", () => {
  beforeAll(() => {
    if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Use a loopback Firestore emulator.");
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("live-blog-author-readiness.test.js");
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
    await db.doc("users/reviewer").set({ displayName: "Reviewer", active: true, role: "admin", grants: [] });
    await db.doc(`cmsAuthorProfiles/${authorId}`).set(profile());
  });
  afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

  it("returns only boolean completeness facts alongside the existing picker fields", async () => {
    const response = await call(authors.createListBylineAuthorsHandler);
    expect(response.statusCode).toBe(200);
    expect(response.body.authors).toEqual([{ authorId, displayName: "Ada Reporter", jobTitle: "Reporter",
      profileReadiness: { hasPhoto: true, hasJobTitle: true, hasBio: true, published: true } }]);
    expect(JSON.stringify(response.body)).not.toContain("Private working biography");
    expect(JSON.stringify(response.body)).not.toContain("ada.jpg");
  });

  it.each([
    ["photo", null, "hasPhoto"], ["jobTitle", " ", "hasJobTitle"], ["bio", " ", "hasBio"], ["visibility", "private", "published"],
  ])("reports incomplete %s without excluding the author", async (field, value, flag) => {
    await db.doc(`cmsAuthorProfiles/${authorId}`).update({ [field]: value });
    const response = await call(authors.createListBylineAuthorsHandler);
    expect(response.statusCode).toBe(200);
    expect(response.body.authors).toHaveLength(1);
    expect(response.body.authors[0].profileReadiness[flag]).toBe(false);
  });

  it("keeps the active-account boundary before any directory response", async () => {
    await db.doc("users/reviewer").update({ active: false });
    const response = await call(authors.createListBylineAuthorsHandler);
    expect(response.statusCode).toBe(403);
    expect(response.body.authors).toBeUndefined();
  });

  it("warns about a stored photo the public reader cannot use", async () => {
    await db.doc(`cmsAuthorProfiles/${authorId}`).update({ "photo.attestedAt": "" });
    const response = await call(authors.createListBylineAuthorsHandler);
    expect(response.statusCode).toBe(200);
    expect(response.body.authors[0].profileReadiness.hasPhoto).toBe(false);
  });

  it("addresses an exact profile for the protected editor link without paging the roster", async () => {
    const other = `au_${"b".repeat(32)}`;
    await db.doc(`cmsAuthorProfiles/${other}`).set({ ...profile(), authorId: other, displayName: "Other reporter" });
    const response = await call(authors.createListAuthorProfilesHandler, "admin", { authorId: other });
    expect(response.statusCode).toBe(200);
    expect(response.body.profiles.map(item => item.authorId)).toEqual([other]);
    expect(response.body.nextCursor).toBeNull();
  });

  it("keeps exact profile links behind profile-manager authorization and validates ids", async () => {
    const refused = await call(authors.createListAuthorProfilesHandler, "editor", { authorId });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.profiles).toBeUndefined();
    const invalid = await call(authors.createListAuthorProfilesHandler, "admin", { authorId: "../invalid" });
    expect(invalid.statusCode).toBe(400);
  });

  it("rechecks stored profile-manager access after reading an exact profile", async () => {
    await db.doc("users/reviewer").update({ role: null, grants: [{ role: "editor" }] });
    const response = await call(authors.createListAuthorProfilesHandler, "admin", { authorId });
    expect(response.statusCode).toBe(403);
    expect(response.body.profiles).toBeUndefined();
  });
});

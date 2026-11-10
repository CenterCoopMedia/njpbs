import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import firebase from "../../functions/lib/firebase.js";
import auth from "../../functions/lib/auth.js";
import save from "../../functions/save.js";

const PROJECT = "demo-njpbs";
let db;

beforeAll(() => { db = admin.firestore(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" });
  auth.resetAuthTokenCache();
  // Only replace external token verification; stored staff and permissions remain real.
  vi.spyOn(firebase.admin.auth(), "verifyIdToken").mockResolvedValue({ uid: "editor", email: "editor@example.test", email_verified: true });
  await db.doc("users/editor").set({ role: "admin", active: true, email: "editor@example.test" });
});
afterEach(() => { vi.restoreAllMocks(); auth.resetAuthTokenCache(); });
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

function collectionBlock(type, count, visible = true) {
  const items = Array.from({ length: count }, (_, index) => type === "image_gallery"
    ? { itemId: `item-${index}`, assetId: "", alt: "" }
    : { itemId: `item-${index}`, title: `Card ${index}` });
  return { id: "collection", type, order: 0, visible,
    data: type === "image_gallery" ? { images: items } : { cards: items } };
}

describe.each(["image_gallery", "card_grid"])("%s at the save boundary", type => {
  const collection = type === "image_gallery" ? "cmsPosts" : "cmsPages";
  const id = type === "image_gallery" ? "gallery-post" : "watch";
  const metadata = type === "image_gallery" ? { type: "post" } : { template: "programLanding" };

  async function seed(count = 0) {
    const document = { ...metadata, title: "Collection fixture", status: "draft", version: 3,
      createdBy: "editor", blocks: count ? [collectionBlock(type, count)] : [] };
    await db.doc(`${collection}/${id}`).set(document);
    return document;
  }

  async function write(count, visible = true) {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await save.createCmsSaveHandler({ firestore: db })({
      method: "POST", headers: { authorization: "Bearer fixture-token" }, ip: "203.0.113.7",
      body: JSON.parse(JSON.stringify({ collection, id, baseVersion: 3,
        document: { ...metadata, blocks: [collectionBlock(type, count, visible)] } })),
    }, res);
    return res;
  }

  it.each([true, false])("refuses thirteen items with visible=%s without changing stored state", async visible => {
    const before = await seed();
    const res = await write(13, visible);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe(`${type === "image_gallery" ? "Images" : "Cards"} can hold at most 12. Remove 1 to save.`);
    expect((await db.doc(`${collection}/${id}`).get()).data()).toEqual(before);
    for (const name of ["cmsVersionHistory", "admin_logs", "cmsPublishQueue"]) {
      expect((await db.collection(name).get()).empty).toBe(true);
    }
    expect((await db.collectionGroup("mediaUsage").get()).empty).toBe(true);
  });

  it.each([0, 13])("saves twelve items when the stored collection has %s", async storedCount => {
    await seed(storedCount);
    const res = await write(12);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await db.doc(`${collection}/${id}`).get()).data()).toMatchObject({
      version: 4, blocks: [{ ...collectionBlock(type, 12), id: expect.any(String) }],
    });
  });
});

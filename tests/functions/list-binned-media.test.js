import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import bin from "../../functions/list-binned-media.js";

const PROJECT = "demo-njpbs";
let db;
beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("list-binned-media.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

async function seed(id, uid, category = "news") {
  await db.collection("media_assets").doc(id).set({
    name: id, originalName: `${id}.png`, category, kind: "image", mimeType: "image/png",
    sizeBytes: 20, width: 100, height: 100, url: `https://media.example/${id}.png`,
    lifecycle: "tombstoned", version: 1, tombstonedBy: uid,
    purgeAfter: "2026-10-01T00:00:00Z", tombstonedAt: "2026-09-01T00:00:00Z",
  });
}

async function list(role = "admin", body = {}, failedUid = null) {
  const userRead = vi.fn(uid => uid === failedUid
    ? Promise.reject(new Error("User read unavailable")) : db.collection("users").doc(uid).get());
  const firestore = { collection: name => name === "users"
    ? { doc: uid => ({ get: () => userRead(uid) }) } : db.collection(name) };
  const res = { set: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const handler = bin.createCmsListBinnedMediaHandler({ firestore,
    requirePrincipalFn: async () => ({ principal: { grants: [role === "admin"
      ? { role } : { role: role === "scoped-admin" ? "admin" : role, sections: ["news"], registeredMediaSections: ["news"] }] } }),
  });
  await handler({ method: "POST", headers: { "content-type": "application/json" }, body }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return { result: res.json.mock.calls[0][0], userRead };
}

it("resolves one display name per unique deletion actor on the authorized page", async () => {
  await seed("a", "actor");
  await seed("b", "actor");
  await seed("c", "off-page");
  await seed("d", "out-of-scope", "arts");
  await db.collection("users").doc("actor").set({ displayName: "  Pat Editor  " });
  const { result, userRead } = await list("admin", { pageSize: 2 });
  expect(result.total).toBe(4);
  expect(result.records.map(row => row.tombstonedByName)).toEqual(["Pat Editor", "Pat Editor"]);
  expect(result.records.every(row => !Object.hasOwn(row, "tombstonedBy"))).toBe(true);
  expect(userRead.mock.calls).toEqual([["actor"]]);
});

it.each(["editor", "scoped-admin"])("withholds names and does no user reads for %s without users.view", async role => {
  await seed("a", "actor");
  await seed("b", "out-of-scope", "arts");
  await db.collection("users").doc("actor").set({ displayName: "Private name" });
  const { result, userRead } = await list(role);
  expect(result.total).toBe(2);
  expect(result.records.every(row => row.tombstonedByName === null)).toBe(true);
  expect(result.records.every(row => !Object.hasOwn(row, "tombstonedBy"))).toBe(true);
  expect(userRead).not.toHaveBeenCalled();
});

it("leaves missing, blank and invalid deletion actors unnamed", async () => {
  for (const [id, uid] of [["a", "missing"], ["b", "blank"], ["c", "bad/path"], ["d", null]]) await seed(id, uid);
  await db.collection("users").doc("blank").set({ displayName: "   " });
  const { result, userRead } = await list();
  expect(result.records.map(row => row.tombstonedByName)).toEqual([null, null, null, null]);
  expect(userRead.mock.calls).toEqual([["missing"], ["blank"]]);
});

it("keeps the bin and other names available when one actor lookup fails", async () => {
  await seed("a", "unavailable");
  await seed("b", "available");
  await db.collection("users").doc("available").set({ displayName: "Pat Editor" });
  const { result, userRead } = await list("admin", {}, "unavailable");
  expect(result.records.map(row => row.tombstonedByName)).toEqual([null, "Pat Editor"]);
  expect(userRead).toHaveBeenCalledTimes(2);
});

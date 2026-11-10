import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import save from "../../functions/save.js";

const db = isolatedFirestore("save-version-required.test.js");
const actor = { uid: "editor", email: "editor@example.test", principal: { id: "editor", grants: [{ role: "editor" }] } };
const quiet = { warn() {}, info() {}, error() {} };
const before = collection => ({ id: "watch", title: "Original", blocks: [], status: "draft", version: 4,
  createdBy: actor.uid, ...(collection === "cmsPages" ? { template: "watch" } : { type: "post", slug: "watch", tags: [] }) });

function response() {
  return { statusCode: null, headersSent: false, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; } };
}
async function request(collection, extra = {}, firestore = db) {
  const res = response();
  const body = { collection, id: "watch", document: { title: "Unsaved text" }, ...extra };
  await save.createCmsSaveHandler({ firestore, requirePrincipalFn: () => actor, log: quiet })(
    { method: "POST", headers: {}, ip: "127.0.0.1", body }, res);
  return { ...res, requestBody: body };
}
async function rows(collection) { return (await db.collection(collection).get()).docs.map(doc => doc.data()); }
async function expectNoWrite(collection) {
  expect((await db.doc(`${collection}/watch`).get()).data()).toEqual(before(collection));
  for (const name of ["cmsVersionHistory", "admin_logs", "cmsPublishQueue"]) expect(await rows(name)).toEqual([]);
}

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});

for (const collection of ["cmsPages", "cmsPosts"]) describe(`${collection} exact save claims`, () => {
  beforeEach(() => db.doc(`${collection}/watch`).set(before(collection)));

  it("refuses a missing baseVersion without changing content, history, audit or the submitted text", async () => {
    const result = await request(collection);
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toMatch(/current saved version.*keep a copy before reloading/i);
    expect(result.requestBody.document).toEqual({ title: "Unsaved text" });
    await expectNoWrite(collection);
  });

  it("refuses a stale claim and preserves the submitted text", async () => {
    const result = await request(collection, { baseVersion: 3 });
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ versionConflict: true, error: expect.stringContaining("changed since you opened it") });
    expect(result.requestBody.document).toEqual({ title: "Unsaved text" });
    await expectNoWrite(collection);
  });

  it("saves at the claimed version and allows the next save only at its returned version", async () => {
    const result = await request(collection, { baseVersion: 4 });
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(result.body.document).toMatchObject({ title: "Unsaved text", version: 5 });
    const next = await request(collection, { baseVersion: 5, document: { title: "Next edit" } });
    expect(next.statusCode).toBe(200);
    expect(next.body.document).toMatchObject({ title: "Next edit", version: 6 });
    expect(await rows("cmsVersionHistory")).toHaveLength(2);
  });

  it("requires an explicit zero for a legacy row and refuses zero after its first save", async () => {
    const legacy = before(collection);
    delete legacy.version;
    await db.doc(`${collection}/watch`).set(legacy);
    expect((await request(collection)).statusCode).toBe(400);
    const first = await request(collection, { baseVersion: 0 });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    expect(first.body.document.version).toBe(1);
    expect((await request(collection, { baseVersion: 0, document: { title: "Stale legacy text" } })).statusCode).toBe(409);
    expect((await db.doc(`${collection}/watch`).get()).data()).toEqual(first.body.document);
    expect(await rows("cmsVersionHistory")).toHaveLength(1);
  });

  it("keeps a legacy no-op unchanged and stamps version one on its first content write", async () => {
    const canonical = await request(collection, { baseVersion: 4 });
    expect(canonical.statusCode).toBe(200);
    const legacy = { ...canonical.body.document };
    delete legacy.version;
    await db.doc(`${collection}/watch`).set(legacy);
    const first = await request(collection, { baseVersion: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.body.document).toEqual(legacy);
    expect(await rows("cmsVersionHistory")).toHaveLength(1);
    const changed = await request(collection, { baseVersion: 0, document: { title: "First legacy change" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.body.document).toMatchObject({ title: "First legacy change", version: 1 });
    expect(await rows("cmsVersionHistory")).toHaveLength(2);
    const unchanged = await request(collection, { baseVersion: 1, document: { title: "First legacy change" } });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.body.document).toEqual(changed.body.document);
    expect(await rows("cmsVersionHistory")).toHaveLength(2);
  });

  it.each([null, "4", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses an invalid claim %s", async baseVersion => {
    expect((await request(collection, { baseVersion })).statusCode).toBe(400);
    await expectNoWrite(collection);
  });

  it.each([0, null, "4"])("does not treat a corrupt stored version %s as an unversioned legacy row", async version => {
    const invalid = { ...before(collection), version };
    await db.doc(`${collection}/watch`).set(invalid);
    expect((await request(collection, { baseVersion: 0 })).statusCode).toBe(409);
    expect((await db.doc(`${collection}/watch`).get()).data()).toEqual(invalid);
    expect(await rows("cmsVersionHistory")).toEqual([]);
  });
});

it("requires an explicit legacy source claim when creating a canonical Page from its old singleton", async () => {
  await db.doc("cmsPages/programLanding").set({ template: "programLanding", title: "Legacy watch", blocks: [], status: "draft" });
  const body = { createOnly: true, document: { template: "programLanding", blocks: [] }, seedFromLegacyPage: { id: "programLanding" } };
  expect((await request("cmsPages", body)).statusCode).toBe(400);
  expect((await db.doc("cmsPages/watch").get()).exists).toBe(false);
  const result = await request("cmsPages", { ...body, seedFromLegacyPage: { id: "programLanding", version: 0 } });
  expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
  expect(result.body.document).toMatchObject({ title: "Legacy watch", version: 1 });
});

const held = [];
afterEach(async () => {
  held.forEach(item => item.release());
  await Promise.allSettled(held.map(item => item.done));
  held.length = 0;
});

function pausedFirestore() {
  let reach, release;
  const barrier = { reads: 0, atRead: new Promise(resolve => { reach = resolve; }),
    release: () => release(), done: null };
  const resumed = new Promise(resolve => { release = resolve; });
  const firestore = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return callback => target.runTransaction(async tx => callback(new Proxy(tx, {
      get(transaction, method) {
        if (method === "get") return async ref => {
          const snapshot = await transaction.get(ref);
          if (ref.path === "cmsPages/watch") {
            barrier.reads++;
            if (barrier.reads === 1) { reach(); await resumed; }
          }
          return snapshot;
        };
        const value = Reflect.get(transaction, method);
        return typeof value === "function" ? value.bind(transaction) : value;
      },
    })));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { firestore, barrier };
}

it.each([4, undefined])("allows exactly one overlapping save when the second claim is %s and audits only the winner", async secondClaim => {
  await db.doc("cmsPages/watch").set(before("cmsPages"));
  const a = pausedFirestore(), b = pausedFirestore();
  held.push(a.barrier, b.barrier);
  a.barrier.done = request("cmsPages", { baseVersion: 4, document: { title: "Editor A text" } }, a.firestore);
  await a.barrier.atRead;
  b.barrier.done = request("cmsPages", { baseVersion: secondClaim, document: { title: "Editor B text" } }, b.firestore);
  await b.barrier.atRead;
  a.barrier.release(); b.barrier.release();
  const results = await Promise.all([a.barrier.done, b.barrier.done]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, secondClaim === undefined ? 400 : 409]);
  if (secondClaim !== undefined) expect(a.barrier.reads + b.barrier.reads).toBeGreaterThanOrEqual(3);
  else { expect(a.barrier.reads).toBeGreaterThanOrEqual(1); expect(b.barrier.reads).toBeGreaterThanOrEqual(1); }
  const winner = results.find(result => result.statusCode === 200);
  const loser = results.find(result => result.statusCode !== 200);
  if (secondClaim !== undefined) expect(loser.body.versionConflict).toBe(true);
  const stored = (await db.doc("cmsPages/watch").get()).data();
  expect(stored).toEqual(winner.body.document);
  expect(stored.version).toBe(5);
  expect(loser.requestBody.document.title).not.toBe(stored.title);
  expect(await rows("cmsVersionHistory")).toEqual([expect.objectContaining({ before: before("cmsPages"), after: stored })]);
  expect(await rows("admin_logs")).toHaveLength(1);
});

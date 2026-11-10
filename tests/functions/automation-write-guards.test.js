import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import save from "../../functions/save.js";
import restoreRevision from "../../functions/restore-revision.js";
import lifecycleTransition from "../../functions/lifecycle-transition.js";

// #4717: an automation account must hold its own live Boardwalk editing lock and echo the
// exact version it read. Staff also need a version claim, but no server-side lease.
const { createCmsSaveHandler } = save;
const { createCmsRestoreRevisionHandler } = restoreRevision;
const { createCmsTransitionContentHandler } = lifecycleTransition;

const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const AGENT = "agent-1";
const STAFF = "editor-1";
const silentLog = { warn() {}, error() {}, info() {} };
const AUTOMATION = { requestReference: "Slack thread 1001 from Emery", planDigest: "a".repeat(64) };

let db;

const principal = (uid) => () => ({
  uid,
  email: `${uid}@example.com`,
  principal: { id: uid, grants: [{ role: "editor" }] },
});

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; res.headersSent = true; return res; };
  return res;
}

const makeReq = (body) => ({ method: "POST", body, headers: {}, ip: "203.0.113.9" });

const storedPage = () => ({
  id: "watch",
  template: "watch",
  title: "Watch NJ PBS",
  status: "draft",
  blocks: [],
  createdBy: STAFF,
  updatedAt: "2026-11-01T12:00:00.000Z",
  updatedBy: STAFF,
  version: 4,
});

async function rows(collection) {
  return (await db.collection(collection).get()).docs.map((doc) => doc.data());
}

async function seedLock({ ownerId = AGENT, ageMs = 1_000, released = false } = {}) {
  const base = {
    surfaceKey: "cmsPages:watch", contentCollection: "cmsPages", contentId: "watch",
    ownerId, sessionId: "session-0123456789abcdef",
  };
  await db.collection("cmsEditorLocks").doc("cmsPages:watch").set(released
    ? { ...base, releasedAt: Timestamp.now() }
    : {
      ...base,
      ownerName: ownerId === AGENT ? "NJ PBS agent" : "Staff editor",
      acquiredAt: Timestamp.fromMillis(Date.now() - ageMs),
      heartbeatAt: Timestamp.fromMillis(Date.now() - ageMs),
    });
}

async function saveAs(uid, body) {
  const handler = createCmsSaveHandler({
    firestore: db,
    requirePrincipalFn: principal(uid),
    log: silentLog,
  });
  const res = makeRes();
  await handler(makeReq({ collection: "cmsPages", id: "watch", document: { title: "Agent title" }, ...body }), res);
  return res;
}

async function expectNothingWritten() {
  const [page] = (await rows("cmsPages")).filter((row) => row.id === "watch");
  expect(page).toMatchObject({ title: "Watch NJ PBS", version: 4 });
  expect(await rows("cmsVersionHistory")).toHaveLength(0);
  expect(await rows("admin_logs")).toHaveLength(0);
}

describe("automation account write guards", () => {
  beforeAll(() => {
    db = isolatedFirestore("automation-write-guards.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await db.collection("cmsPages").doc("watch").set(storedPage());
    await db.collection("cmsAutomationAccounts").doc(AGENT).set({ label: "NJ PBS agent" });
  });

  it("keeps a versioned staff save independent of the courtesy lock", async () => {
    await seedLock({ ownerId: "someone-else" });
    const res = await saveAs(STAFF, { baseVersion: 4 });
    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ title: "Agent title", version: 5 });
  });

  it("refuses an automation create", async () => {
    const handler = createCmsSaveHandler({
      firestore: db, requirePrincipalFn: principal(AGENT), log: silentLog,
    });
    const res = makeRes();
    await handler(makeReq({ collection: "cmsPosts", document: { type: "post", title: "New" },
      idempotencyKey: "automation-create-key-0123456789" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/saved content only/i);
    expect(await rows("cmsPosts")).toHaveLength(0);
  });

  it("refuses an automation save without baseVersion", async () => {
    await seedLock();
    const res = await saveAs(AGENT, {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Automation saves require the exact saved baseVersion.");
    await expectNothingWritten();
  });

  it.each([
    ["no lock", null],
    ["a live lock held by a person", { ownerId: STAFF }],
    ["its own expired lock", { ageMs: 121_000 }],
    ["its own released lock", { released: true }],
  ])("refuses an automation save with %s", async (_label, lock) => {
    if (lock) await seedLock(lock);
    const res = await saveAs(AGENT, { baseVersion: 4 });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ lockRequired: true });
    expect(res.body.error).toMatch(/hold the editing lock/i);
    await expectNothingWritten();
  });

  it("refuses an automation save with a stale baseVersion while it holds the lock", async () => {
    await seedLock();
    const res = await saveAs(AGENT, { baseVersion: 3, automation: AUTOMATION });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ versionConflict: true });
    expect(res.body.error).toMatch(/changed since you opened it/i);
    await expectNothingWritten();
  });

  it("saves an automation change with its own live lock and the exact version", async () => {
    await seedLock();
    const res = await saveAs(AGENT, { baseVersion: 4, automation: AUTOMATION });
    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ title: "Agent title", version: 5, updatedBy: AGENT });
    expect(await rows("cmsVersionHistory")).toHaveLength(1);
    const audit = await rows("admin_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUid: AGENT, automation: AUTOMATION });
  });

  it("refuses an automation save without its request reference and plan digest", async () => {
    await seedLock();
    const res = await saveAs(AGENT, { baseVersion: 4 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/request reference and a plan digest/i);
    await expectNothingWritten();
  });

  it("refuses automation details from a staff account", async () => {
    const res = await saveAs(STAFF, { baseVersion: 4, automation: AUTOMATION });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only automation accounts/i);
    await expectNothingWritten();
  });

  it("refuses a dry run of anything but an ordinary save of saved content", async () => {
    const res = await saveAs(STAFF, { baseVersion: 4, dryRun: true, publish: true, document: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/dry run checks an ordinary save/i);
    await expectNothingWritten();
  });

  it("checks an automation dry run without a lease and writes nothing", async () => {
    const res = await saveAs(AGENT, { baseVersion: 4, automation: AUTOMATION, dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, document: { title: "Agent title", version: 5 } });
    await expectNothingWritten();
  });

  it("keeps a page save group marker when a dry run takes the unchanged-save exit", async () => {
    // The stored shape a save already normalized, so the empty overlay changes nothing.
    await db.collection("cmsPages").doc("watch").set({ ...storedPage(), template: "programLanding", section: "watch",
      createdAt: "2026-11-01T12:00:00.000Z", contentVersion: 4, contentSaveGroup: "group-1" });
    const res = await saveAs(STAFF, { baseVersion: 4, dryRun: true, document: {}, saveGroupId: "group-1" });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(true);
    const [page] = (await rows("cmsPages")).filter((row) => row.id === "watch");
    expect(page.contentSaveGroup).toBe("group-1");
  });

  it("refuses an automation revision restore without its lock", async () => {
    await db.collection("cmsVersionHistory").doc("source-revision").set({
      collection: "cmsPages", documentId: "watch", action: "update", userId: STAFF,
      at: "2026-10-01T12:00:00.000Z", before: { ...storedPage(), version: 2 },
      after: { ...storedPage(), title: "Older title", version: 3 },
    });
    const handler = createCmsRestoreRevisionHandler({
      firestore: db, requirePrincipalFn: principal(AGENT), log: silentLog,
    });
    const res = makeRes();
    await handler(makeReq({ collection: "cmsPages", id: "watch", revisionId: "source-revision", baseVersion: 4 }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ lockRequired: true });
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({ version: 4 });
  });

  it("refuses an automation lifecycle change without its lock", async () => {
    const handler = createCmsTransitionContentHandler({
      firestore: db, requirePrincipalFn: principal(AGENT),
      enqueuePublishBuildFn: vi.fn(), log: silentLog,
    });
    const res = makeRes();
    await handler(makeReq({ collection: "cmsPages", id: "watch", baseVersion: 4, action: "submit" }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ lockRequired: true });
    await expectNothingWritten();
  });
});

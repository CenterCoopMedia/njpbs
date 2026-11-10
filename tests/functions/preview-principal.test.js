import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import auth from "../../functions/lib/auth.js";
import preview from "../../functions/preview.js";
import revisions from "../../functions/revisions.js";
import targetContract from "../../functions/lib/preview-target.js";

const PROJECT = "demo-njpbs";
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const NOW = Date.parse("2026-10-08T12:00:00Z");
const rendererSha = "a".repeat(40);
const targets = [
  { collection: "cmsPages", pageId: `page-${"a".repeat(32)}` },
  { collection: "cmsPosts", pageId: "preview-post" },
];
let db;

function draft(target, overrides = {}) {
  return {
    title: "Saved version seven", description: "Preview fixture", version: 7,
    template: "genericPage", status: "draft", section: "news", createdBy: "writer",
    slug: "preview-fixture", blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }],
    ...(target.collection === "cmsPosts" ? {
      type: "post", previousSlugs: [], locale: "en", tags: [],
      credits: [{ kind: "custom", name: "Fixture author" }],
    } : {}),
    ...overrides,
  };
}

function deps() {
  return {
    firestore: db, getTransport: () => "serializer", serializerReady: true,
    getRendererSha: () => rendererSha, now: () => NOW,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

async function request(handler, uid, body) {
  const response = {
    statusCode: null, body: null, headersSent: false,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await handler({ method: "POST", headers: { authorization: `Bearer ${uid}` }, body }, response);
  return response;
}

const accept = (uid, target) => request(preview.createCmsPreviewHandler(deps()), uid,
  { ...target, sourceVersion: 7 });
const status = (uid, body) => request(preview.createCmsPreviewStatusHandler(deps()), uid, body);
const revision = (uid, target) => request(revisions.createCmsGetRevisionHandler(deps()), uid,
  { collection: target.collection, id: target.pageId, revisionId: "saved-seven" });

async function accepted(target, uid = "admin") {
  const response = await accept(uid, target);
  expect(response.statusCode).toBe(202);
  return response.body.queueId;
}

function statusRequests(target, queueId) {
  return [target, { queueId }, { queueId, waitMs: 5000, observedStatus: "pending" }];
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(HOST ?? "")) throw new Error("A local Firestore emulator is required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  auth.resetAuthTokenCache();
  // Only the external token verifier is replaced. The handlers load real user
  // documents, resolve principals and authorize stored content in the emulator.
  vi.spyOn(admin.auth(), "verifyIdToken").mockImplementation(async uid => ({
    uid, email: `${uid}@example.test`, email_verified: true,
  }));
  const batch = db.batch();
  batch.set(db.doc("users/admin"), { active: true, role: "admin" });
  batch.set(db.doc("users/super-admin"), { active: true, role: "super_admin" });
  batch.set(db.doc("users/site-editor"), { active: true, grants: [{ role: "editor" }] });
  batch.set(db.doc("users/inactive"), { active: false, role: "admin" });
  batch.set(db.doc("users/viewer"), { active: true, grants: [{ role: "staff" }] });
  for (const section of ["news", "watch"]) {
    batch.set(db.doc(`sections/${section}`), { label: section });
    batch.set(db.doc(`users/${section}-editor`), { active: true, grants: [{ role: "editor", sections: [section] }] });
  }
  batch.set(db.doc("users/writer"), { active: true, grants: [{ role: "contributor", sections: ["news"] }] });
  for (const target of targets) batch.set(db.doc(`${target.collection}/${target.pageId}`), draft(target));
  await batch.commit();
  const users = await db.collection("users").get();
  await Promise.all(users.docs.map(row => row.ref.update({ email: `${row.id}@example.test` })));
});

afterEach(() => { vi.restoreAllMocks(); auth.resetAuthTokenCache(); });
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

describe.each(["program", "event"])("saved %s preview through stored principals", kind => {
  it.each(["writer", "news-editor", "site-editor", "admin", "super-admin", "watch-editor"])(
    "admits active staff from any area for %s", async uid => {
      const target = { collection: "cmsPosts", pageId: `${kind}-one` };
      const stored = draft(target, { type: kind, description: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Saved structured details" }] },
      ] }, startsAt: "2026-10-13T18:00:00.000Z" });
      await db.doc(`cmsPosts/${target.pageId}`).set(stored);
      const response = await accept(uid, target);
      expect(response.statusCode).toBe(202);
      {
        const queue = (await db.doc(`cmsPreviewQueue/${response.body.queueId}`).get()).data();
        expect(queue).toMatchObject({ collection: "cmsPosts", pageId: target.pageId, sourceVersion: 7,
          pagePath: `/${kind}s/preview-fixture/`, requestedBy: uid });
      }
      expect((await db.doc(`cmsPosts/${target.pageId}`).get()).data()).toEqual(stored);
    },
  );
});

describe.each(targets)("preview authorization through stored principals: $collection", target => {
  describe.each([
    { persistent: true },
    { automatic: true },
    { persistent: true, automatic: true },
  ])("restricted preview modes: %j", flags => {
    it.each(["writer", "news-editor", "site-editor"])("refuses %s without creating work or a head", async uid => {
      const response = await request(preview.createCmsPreviewHandler(deps()), uid, { ...target, ...flags });
      expect(response).toMatchObject({ statusCode: 403, body: {
        error: "Administrator access is required for retained or automatic previews",
      } });
      for (const collection of ["cmsPreviewQueue", "cmsPreviewHeads", "admin_logs"]) {
        expect((await db.collection(collection).get()).empty).toBe(true);
      }
    });

    it.each(["admin", "super-admin"])("accepts the mode for %s", async uid => {
      const response = await request(preview.createCmsPreviewHandler(deps()), uid, { ...target, ...flags });
      expect(response.statusCode).toBe(202);
      const queue = (await db.doc(`cmsPreviewQueue/${response.body.queueId}`).get()).data();
      expect(queue).toMatchObject({ requestedBy: uid, status: "pending", sourceVersion: 7 });
      expect(queue.persistent === true).toBe(flags.persistent === true);
      if (flags.persistent) {
        const contentKey = targetContract.previewContentKey(target.collection, target.pageId);
        expect(queue.contentKey).toBe(contentKey);
        expect((await db.doc(`cmsPreviewHeads/${contentKey}`).get()).data()).toMatchObject({
          latestQueueId: response.body.queueId,
        });
      }
    });
  });

  it("keeps the retained queue and ready head unchanged when a Writer requests a replacement", async () => {
    const handler = preview.createCmsPreviewHandler(deps());
    const flags = { persistent: true, automatic: true };
    const first = await request(handler, "admin", { ...target, ...flags });
    expect(first.statusCode).toBe(202);
    const queueRef = db.doc(`cmsPreviewQueue/${first.body.queueId}`);
    await queueRef.update({ status: "ready", previewUrl: `https://preview.example.test/s/${first.body.queueId}/` });
    const contentKey = targetContract.previewContentKey(target.collection, target.pageId);
    const headRef = db.doc(`cmsPreviewHeads/${contentKey}`);
    await headRef.update({ readyQueueId: first.body.queueId });
    const previousHead = (await headRef.get()).data();
    const previousQueue = (await queueRef.get()).data();
    await db.doc(`${target.collection}/${target.pageId}`).update({ version: 8 });

    expect((await request(handler, "writer", { ...target, ...flags })).statusCode).toBe(403);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await queueRef.get()).data()).toEqual(previousQueue);
    expect((await headRef.get()).data()).toEqual(previousHead);
  });

  it("keeps a Writer's ordinary exact preview expiring and separate from retained heads", async () => {
    const response = await request(preview.createCmsPreviewHandler(deps()), "writer", {
      ...target, sourceVersion: 7, persistent: false,
    });
    expect(response.statusCode).toBe(202);
    const queue = (await db.doc(`cmsPreviewQueue/${response.body.queueId}`).get()).data();
    expect(queue).toMatchObject({ requestedBy: "writer", sourceVersion: 7, status: "pending" });
    expect(queue.persistent).toBeUndefined();
    expect(queue.contentKey).toBeUndefined();
    expect(queue.expiresAt.toMillis()).toBe(NOW + 24 * 60 * 60 * 1000);
    const contentKey = targetContract.previewContentKey(target.collection, target.pageId);
    const head = (await db.doc(`cmsPreviewHeads/${contentKey}`).get()).data();
    expect(head.exactQueueId).toBe(response.body.queueId);
    expect(head.latestQueueId).toBeUndefined();
    expect(head.readyQueueId).toBeUndefined();
  });

  it.each(["admin", "news-editor", "writer", "watch-editor", "viewer"])("accepts a readable record for the active %s", async uid => {
    const queueId = await accepted(target, uid);
    expect(await status(uid, { queueId })).toMatchObject({ statusCode: 200, body: { queueId, status: "pending" } });
  });

  it.each(["inactive", "nonstaff"])("denies %s at request and every status boundary", async uid => {
    const queueId = await accepted(target);
    const refused = await accept(uid, target);
    expect(refused).toMatchObject({ statusCode: 403, body: { error: "An active, verified staff account is required" } });
    for (const body of statusRequests(target, queueId)) {
      expect(await status(uid, body)).toMatchObject({ statusCode: 403, body: refused.body });
    }
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it.each(["deactivated", "unregistered"])("refuses the same bearer token after the account is %s", async state => {
    const queueId = await accepted(target, "news-editor");
    expect((await status("news-editor", { queueId })).statusCode).toBe(200);
    if (state === "deactivated") await db.doc("users/news-editor").update({ active: false });
    else await db.doc("users/news-editor").delete();
    expect((await accept("news-editor", target)).statusCode).toBe(403);
    for (const body of statusRequests(target, queueId)) {
      const response = await status("news-editor", body);
      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: "An active, verified staff account is required" });
    }
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });

  it("hides an accepted job when its current record is missing", async () => {
    const queueId = await accepted(target);
    expect((await status("admin", { queueId })).statusCode).toBe(200);
    await db.doc(`${target.collection}/${target.pageId}`).delete();
    for (const body of [{ queueId }, { queueId, waitMs: 5000, observedStatus: "pending" }, { queueId: "missingjob" }]) {
      const response = await status("admin", body);
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: "Preview request not found" });
    }
  });

  it.each(["deactivated", "unregistered"])("rechecks an account %s during a real status wait", async state => {
    const queueId = await accepted(target, "news-editor");
    const queueRef = db.doc(`cmsPreviewQueue/${queueId}`);
    let observedInitial;
    const listening = new Promise(resolve => { observedInitial = resolve; });
    // Observe the SDK stream only to synchronize the account change. The real
    // Firestore listener and the default principal loader remain in use.
    const prototype = Object.getPrototypeOf(queueRef);
    const subscribe = prototype.onSnapshot;
    vi.spyOn(prototype, "onSnapshot").mockImplementation(function (next, ...rest) {
      return subscribe.call(this, snapshot => { next(snapshot); observedInitial(); }, ...rest);
    });
    const pending = status("news-editor", { queueId, waitMs: 5000, observedStatus: "pending" });
    await listening;
    if (state === "deactivated") await db.doc("users/news-editor").update({ active: false });
    else await db.doc("users/news-editor").delete();
    await queueRef.update({ status: "ready", previewUrl: `https://preview.example.test/p/${queueId}/` });
    const response = await pending;
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "An active, verified staff account is required" });
  });

  // Jules's October 17 preview rule is separate from revision-history access.
  it.each(["history", "accepted job"])("shares an older preview across areas while preserving history access: %s", async source => {
    let queueId;
    if (source === "accepted job") queueId = await accepted(target, "news-editor");
    await db.doc("cmsVersionHistory/saved-seven").set({
      collection: target.collection, documentId: target.pageId, after: draft(target),
      at: new Date(NOW).toISOString(),
    });
    await db.doc(`${target.collection}/${target.pageId}`).update({ section: "watch", version: 8 });

    const history = await revision("watch-editor", target);
    expect(history.statusCode).toBe(200);
    expect(history.body.revision.after).toMatchObject({ section: "news", version: 7 });
    const current = await accept("watch-editor", target);
    expect(current.statusCode).toBe(202);
    if (queueId) expect(current.body.queueId).toBe(queueId);
    queueId = current.body.queueId;
    const snapshot = (await db.doc(`cmsPreviewQueue/${queueId}`).get()).data().snapshot;
    expect(snapshot.version).toBe(7);
    expect(target.collection === "cmsPosts" ? snapshot.published.metadata.title : snapshot.title).toBe("Saved version seven");
    expect((await status("watch-editor", { queueId })).statusCode).toBe(200);

    expect((await revision("news-editor", target)).statusCode).toBe(403);
    expect((await accept("news-editor", { ...target, section: "news" })).statusCode).toBe(202);
    expect((await status("news-editor", target)).statusCode).toBe(200);
    expect(await status("news-editor", { queueId })).toMatchObject({
      statusCode: 200, body: { queueId, status: "pending" },
    });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
});

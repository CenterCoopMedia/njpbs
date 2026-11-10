import { beforeAll, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { db } = require("../../functions/lib/firebase.js");
const { createCmsSaveHandler } = require("../../functions/save.js");
const { createCmsPublishHandler } = require("../../functions/publish.js");
const { createScheduledPublishRunner } = require("../../functions/scheduled-publish.js");
const { createCmsTransitionContentHandler } = require("../../functions/lifecycle-transition.js");
const { approvedLibraryVersion } = require("../../functions/lib/approved-library-records.js");
const { assertRequestedLibraryPublicationAvailable } = require("../../functions/lib/frozen-library-publication.js");
const release = "a".repeat(40), now = "2026-10-13T12:00:00.000Z";
const actor = { uid: "fixture-editor", email: "editor@example.test", principal: {
  id: "fixture-editor", grants: [{ role: "admin" }],
} };
const quiet = { error() {}, warn() {}, info() {} };
const refusal = type => ["sponsor", "newsletter"].includes(type) ? "Use Approve to publish" : "since the full-site build was retired on October 13, 2026";
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo Firestore only");
});
beforeEach(async () => {
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await Promise.all(["cmsPosts", "cmsPublishQueue", "cmsVersionHistory", "admin_logs"].map(name => db.recursiveDelete(db.collection(name))));
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused", commitSha: release,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" } });
});
async function invoke(handler, body) {
  const res = { statusCode: 0, body: null, headersSent: false,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, body }, res); return res;
}
async function seed(type, status = "approved") {
  const document = { type, title: `Existing ${type}`, name: `Existing ${type}`, version: 1, status,
    publiclyVisible: true, deleted: false, createdBy: actor.uid,
    published: { sourceVersion: 1, publishedAt: "2026-10-10T12:00:00.000Z", metadata: { type, title: `Existing ${type}` }, blocks: [] } };
  await db.doc(`cmsPosts/${type}`).set(document); return document;
}
it.each(["program", "event", "sponsor", "newsletter"])("refuses a new %s publish without changing its retained public document", async type => {
  const before = await seed(type);
  const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
    enablePublishSnapshot: true, assertPublishReadyFn: async () => ({ transport: "serializer" }), now: () => now, log: quiet });
  const response = await invoke(handler, { collection: "cmsPosts", id: type, baseVersion: 1, document: {}, publish: true });
  expect(response.statusCode).toBe(409); expect(response.body.error).toContain(refusal(type));
  expect((await db.doc(`cmsPosts/${type}`).get()).data()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
it.each(["program", "event", "sponsor", "newsletter"])("refuses a %s publish retry before dispatch", async type => {
  const before = await seed(type);
  const handler = createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
  const response = await invoke(handler, { changes: [{ collection: "cmsPosts", id: type, sourceVersion: 1 }], retry: true, baseVersion: 1 });
  expect(response.statusCode).toBe(409); expect(response.body.error).toContain(refusal(type));
  expect((await db.doc(`cmsPosts/${type}`).get()).data()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
it.each(["sponsor", "newsletter"])("refuses %s card approval without active code and preserves history/context", async type => {
  const before = { ...await seed(type, "in_review"), id: type, version: 3, name: "Private reviewed copy",
    ...(type === "sponsor" ? { href: "https://example.test/sponsor" }
      : { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Newsletter summary" }] }] }, signupUrl: "https://example.test/join" }) };
  await db.doc(`cmsPosts/${type}`).set(before);
  const approved = { ...before, version: 1, status: "approved", name: "Retained approved card" };
  const history = { collection: "cmsPosts", documentId: type, action: "approve", after: approved };
  await db.doc(`cmsVersionHistory/retained-${type}`).set(history);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 7 });
  const handler = createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => now, log: quiet });
  const response = await invoke(handler, { collection: "cmsPosts", id: type, baseVersion: 3, action: "approve" });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
  expect((await db.doc(`cmsPosts/${type}`).get()).data()).toEqual(before);
  const retainedHistory = (await db.collection("cmsVersionHistory").get()).docs.map(row => row.data());
  expect(retainedHistory).toEqual([history]);
  expect(approvedLibraryVersion((await db.doc(`cmsPosts/${type}`).get()).data(), retainedHistory)).toEqual(approved);
  expect((await db.collection("admin_logs").get()).size).toBe(0);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data()).toEqual({ schemaVersion: 1, revision: 7 });
});
it.each(["program", "event", "sponsor", "newsletter"])("moves a due %s schedule to an audited refusal while retaining its published copy", async type => {
  const before = await seed(type, "scheduled");
  await db.doc(`cmsPosts/${type}`).update({ publishAt: "2026-10-13T11:00:00.000Z" });
  const run = createScheduledPublishRunner({ firestore: db, now: () => now,
    assertPublishReadyFn: async () => ({ transport: "serializer" }),
    enqueuePublishFn: async () => { throw new Error("A frozen family must not dispatch"); }, log: quiet });
  const result = await run();
  expect(result.publishedCount).toBe(0);
  const after = (await db.doc(`cmsPosts/${type}`).get()).data();
  expect(after.status).toBe("draft"); expect(after.scheduledPublishFailure.reason).toContain(refusal(type));
  expect(after.published).toEqual(before.published); expect(after.publiclyVisible).toBe(true);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
});
it("preserves withdrawal batches that contain frozen records and ordinary Posts", async () => {
  const program = await seed("program"), post = await seed("post");
  await expect(db.runTransaction(transaction => assertRequestedLibraryPublicationAvailable({ firestore: db, transaction,
    changes: [{ collection: "cmsPosts", id: "program", sourceVersion: 1, operation: "withdraw" },
      { collection: "cmsPosts", id: "post", sourceVersion: 1, operation: "withdraw" }],
  }), { readOnly: true })).resolves.toBeUndefined();
  expect((await db.doc("cmsPosts/program").get()).data()).toEqual(program);
  expect((await db.doc("cmsPosts/post").get()).data()).toEqual(post);
});
it.each([{ status: "approved" }, { publishAt: "2026-10-14T11:00:00.000Z" }, { deleted: true }])(
  "does not change a frozen schedule cancelled or moved after the due query: %j", async update => {
    await seed("program", "scheduled");
    await db.doc("cmsPosts/program").update({ publishAt: "2026-10-13T11:00:00.000Z" });
    let moved = false, expected;
    const firestore = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return async (callback, options) => {
        if (!moved) {
          moved = true; await db.doc("cmsPosts/program").update(update);
          expected = (await db.doc("cmsPosts/program").get()).data();
        }
        return target.runTransaction(callback, options);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const run = createScheduledPublishRunner({ firestore, now: () => now,
      assertPublishReadyFn: async () => ({ transport: "serializer" }),
      enqueuePublishFn: async () => { throw new Error("A stale schedule must not dispatch"); }, log: quiet });
    expect((await run()).publishedCount).toBe(0);
    expect((await db.doc("cmsPosts/program").get()).data()).toEqual(expected);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
  },
);

it.each(["sponsor", "newsletter"])("permits %s draft edits and restores while the approved card stays frozen", async type => {
  const before = { ...await seed(type, "draft"), ...(type === "sponsor" ? { href: "https://example.test/sponsor" }
    : { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Draft newsletter" }] }] } }) };
  await db.doc(`cmsPosts/${type}`).set(before);
  const approved = { ...before, id: type, status: "approved", name: "Retained approved sponsor", title: "Retained approved newsletter" };
  await db.doc(`cmsVersionHistory/approved-${type}`).set({ collection: "cmsPosts", documentId: type, action: "approve", after: approved });
  const historical = { ...before, version: 1, name: "Historical draft sponsor", title: "Historical draft newsletter" };
  await db.doc("cmsVersionHistory/restore-fixture").set({ collection: "cmsPosts", documentId: type,
    action: "update", userId: actor.uid, at: now, before: historical, after: historical });
  const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => now, enablePublishSnapshot: true, log: quiet });
  const edited = await invoke(handler, { collection: "cmsPosts", id: type, baseVersion: 1,
    document: type === "sponsor" ? { name: "Working sponsor" } : { title: "Working newsletter" } });
  expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
  const { createCmsRestoreRevisionHandler } = require("../../functions/restore-revision.js");
  const restore = createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: async () => actor, now: () => now, log: quiet });
  const restored = await invoke(restore, { collection: "cmsPosts", id: type, baseVersion: 2, revisionId: "restore-fixture" });
  expect(restored.statusCode, JSON.stringify(restored.body)).toBe(200);
  expect((await db.doc(`cmsPosts/${type}`).get()).data()).toMatchObject({ status: "draft", version: 3 });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  const current = { id: type, ...(await db.doc(`cmsPosts/${type}`).get()).data() };
  const history = (await db.collection("cmsVersionHistory").get()).docs.map(row => row.data());
  expect(approvedLibraryVersion(current, history)).toEqual(approved);
});

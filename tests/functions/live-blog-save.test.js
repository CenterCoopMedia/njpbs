import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import restore from "../../functions/restore-revision.js";
import directory from "../../functions/lib/story-credit-directory.js";
import snapshot from "../../functions/lib/publish-snapshot.js";
import contract from "../../functions/lib/content-document-contract.js";
import compatibility from "../../functions/lib/live-blog-compatibility.js";
import deployment from "../../functions/lib/public-deployment.js";
import { randomUUID } from "node:crypto";

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-njpbs";
const AUTHOR = `au_${"a".repeat(32)}`;
const at = "2026-10-25T15:00:00.000Z";
const later = "2026-10-25T15:01:00.000Z";
let db;
const principal = () => ({ uid: "editor", email: "editor@example.test", principal: { id: "editor", grants: [{ role: "admin" }] } });
function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
const blog = () => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{
  id: "tmp-one", headline: "First report", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original reporting." }] }] },
  credits: [{ kind: "registered", authorId: AUTHOR, displayName: "Forged name", slug: "forged" }], keyUpdate: true,
}] });
const handler = overrides => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: principal,
  now: () => later, assertPublishReadyFn: async () => {}, ...overrides });
async function request(document, extra = {}, overrides) {
  const res = response();
  await handler(overrides)({ method: "POST", headers: {}, body: { collection: "cmsPosts", id: "post-one", baseVersion: 3, document, ...extra } }, res);
  return res;
}
const post = () => db.doc("cmsPosts/post-one").get().then(s => s.data());
const ok = res => expect({ status: res.statusCode, error: res.body?.error }).toEqual({ status: 200, error: undefined });

describe("live blog at the trusted Post boundary", () => {
  beforeAll(() => {
    if (!HOST || !/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) throw new Error("A local Firestore emulator is required.");
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("live-blog-save.test.js");
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
    await db.doc(`cmsAuthorProfiles/${AUTHOR}`).set({ displayName: "Ada Reporter", lifecycle: "active", visibility: "published", slug: "ada-reporter" });
    await db.doc("cmsPosts/post-one").set({ id: "post-one", type: "post", title: "Coverage", tags: [], blocks: [],
      slug: "coverage", previousSlugs: [], locale: "en", status: "draft", createdBy: "editor", version: 3, updatedAt: at });
  });
  afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

  it("stores only canonical ids and unfrozen credits, with a restorable Post revision", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    expect(saved.liveBlog.updates[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.liveBlog.updates[0].credits).toEqual([{ kind: "registered", authorId: AUTHOR }]);
    expect(saved.liveBlog.updates[0]).not.toHaveProperty("publishedAt");
    expect(saved).not.toHaveProperty("published");
    const revisions = await db.collection("cmsVersionHistory").where("documentId", "==", "post-one").get();
    expect(revisions.docs).toHaveLength(1);
    expect(revisions.docs[0].data().after.liveBlog).toEqual(saved.liveBlog);
  });

  it("requires version 1 on the active exact-SHA renderer without changing the draft", async () => {
    const rendererSha = "a".repeat(40);
    const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: rendererSha,
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline" };
    await db.doc("system/publicDeployment").set(pointer);
    const check = () => db.runTransaction(transaction => compatibility.assertLiveBlogRenderer({ firestore: db, transaction }));
    await expect(check()).rejects.toThrow("installed Post renderer");
    const capability = { schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 };
    const ref = db.doc("system/publicDeployment/noBuildPosts/capability");
    await ref.set(capability);
    await expect(check()).rejects.toThrow("installed Post renderer");
    await ref.set({ ...capability, liveBlogVersion: 1 });
    await expect(check()).resolves.toBeUndefined();
    await ref.update({ rendererSha: "b".repeat(40) });
    await expect(check()).rejects.toThrow("installed Post renderer");
    expect((await post()).version).toBe(3);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
  });

  it("refuses stale and unversioned saves, including metadata-only saves", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    const stale = await request({ liveBlog: saved.liveBlog });
    expect(stale.statusCode).toBe(409);
    const forced = await request({ title: "Overwrite" }, { baseVersion: undefined });
    expect(forced.statusCode).toBe(400);
    expect(forced.body.error).toContain("current saved version");
    expect(await post()).toEqual(saved);
  });

  it("clears an unpublished live blog explicitly without discarding other draft edits", async () => {
    ok(await request({ liveBlog: blog() }));
    ok(await request({ liveBlog: null, title: "Retained story edits", date: "2026-10-25" }, { baseVersion: 4 }));
    const saved = await post();
    expect(saved).not.toHaveProperty("liveBlog");
    expect(saved.title).toBe("Retained story edits");
    expect(saved.version).toBe(5);
    expect(() => snapshot.createPublishedSnapshot({ collection: "cmsPosts", document: saved, publishedAt: later, publishedBy: "editor", allowIncompletePresentation: true })).not.toThrow();
  });

  it("refuses one concurrent editor instead of silently overwriting reporting", async () => {
    const first = blog(); const second = blog(); second.updates[0].headline = "Another editor's report";
    const results = await Promise.all([request({ liveBlog: first }), request({ liveBlog: second })]);
    expect(results.map(res => res.statusCode).sort()).toEqual([200, 409]);
    expect((await post()).version).toBe(4);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });

  it("duplicates reporting with fresh entry ids and no borrowed correction lifecycle", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    saved.liveBlog.updates[0].correction = "An earlier count was wrong.";
    await db.doc("cmsPosts/post-one").update({ liveBlog: saved.liveBlog });
    const res = response();
    await handler()({ method: "POST", headers: {}, body: { collection: "cmsPosts", document: { type: "post" },
      postSource: { id: "post-one", version: 4 }, idempotencyKey: randomUUID() } }, res);
    ok(res);
    const copied = res.body.document.liveBlog.updates[0];
    expect(copied.id).not.toBe(saved.liveBlog.updates[0].id);
    expect(copied.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(copied).not.toHaveProperty("correction");
    expect(res.body.document).not.toHaveProperty("published");
  });

  it("permits incomplete draft entries but refuses them at the approval contract", () => {
    const value = blog(); value.updates[0].id = "entry-saved"; value.updates[0].headline = "";
    const doc = { type: "post", title: "Coverage", tags: [], blocks: [], liveBlog: value };
    expect(contract.validateContentFieldValues("cmsPosts", "post", doc)).toBeNull();
    expect(contract.validateContentFieldValues("cmsPosts", "post", doc, { complete: true })).toContain("headline");
  });

  it("isolates a draft from the existing immutable public snapshot", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    const publicBlog = await directory.freezeLiveBlogForPublish({ firestore: db, document: saved, at });
    const published = { blocks: [], metadata: { type: "post", title: "Public coverage", liveBlog: publicBlog }, publishedAt: at, sourceVersion: 4 };
    await db.doc("cmsPosts/post-one").update({ published });
    saved.liveBlog.updates[0].body.content[0].content[0].text = "PRIVATE draft reporting.";
    ok(await request({ liveBlog: saved.liveBlog }, { baseVersion: 4 }));
    const changed = await post();
    expect(changed.liveBlog.updates[0].body.content[0].content[0].text).toContain("PRIVATE");
    expect(changed.published).toEqual(published);
    expect(JSON.stringify(changed.published)).not.toContain("PRIVATE");
    expect(changed.published.metadata.liveBlog.updates[0].credits).toEqual([{ kind: "registered", authorId: AUTHOR, displayName: "Ada Reporter", slug: "ada-reporter" }]);
  });

  it("keeps untouched public entry names after a directory rename", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    const publicBlog = await directory.freezeLiveBlogForPublish({ firestore: db, document: saved, at });
    await db.doc(`cmsAuthorProfiles/${AUTHOR}`).update({ displayName: "Renamed Reporter", slug: "renamed-reporter" });
    const unchanged = await directory.freezeLiveBlogForPublish({ firestore: db, document: { ...saved, published: { metadata: { liveBlog: publicBlog } } }, at: later });
    expect(unchanged).toEqual(publicBlog);
  });

  it("keeps the frozen name of a deleted profile on a correction instead of dropping its credit", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    const publicBlog = await directory.freezeLiveBlogForPublish({ firestore: db, document: saved, at });
    await db.doc(`cmsAuthorProfiles/${AUTHOR}`).delete();
    saved.liveBlog.updates[0].headline = "Corrected report";
    saved.liveBlog.updates[0].correction = "The earlier headline misstated the result.";
    const corrected = await directory.freezeLiveBlogForPublish({ firestore: db,
      document: { ...saved, published: { metadata: { liveBlog: publicBlog } } }, at: later });
    expect(corrected.updates[0].credits).toEqual([{ kind: "registered", authorId: AUTHOR, displayName: "Ada Reporter" }]);
  });

  it("refuses a newly credited inactive author per entry while retaining an existing byline", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    await db.doc(`cmsAuthorProfiles/${AUTHOR}`).update({ lifecycle: "archived" });
    const unchanged = await request({ liveBlog: saved.liveBlog }, { baseVersion: 4 });
    ok(unchanged);
    expect(unchanged.body.document.version).toBe(4);
    saved.liveBlog.updates.push({ ...blog().updates[0], id: "tmp-new" });
    const rejected = await request({ liveBlog: saved.liveBlog }, { baseVersion: unchanged.body.document.version });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error).toContain("no longer active");
  });

  it("rejects an oversized author roster without changing content or history", async () => {
    const value = blog();
    value.updates = Array.from({ length: 200 }, (_, index) => ({ ...value.updates[0], id: `tmp-${index}`,
      credits: Array.from({ length: 12 }, (_, author) => ({ kind: "registered", authorId: `au_${(index * 12 + author).toString(16).padStart(32, "0")}` })),
    }));
    const rejected = await request({ liveBlog: value });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error).toContain("64 distinct registered authors");
    expect((await post()).version).toBe(3);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  });

  it.each(["publishedAt", "updatedAt"])("rejects client-forged %s before any write", async field => {
    const value = blog(); value.updates[0][field] = at;
    expect((await request({ liveBlog: value })).statusCode).toBe(400);
    expect((await post()).version).toBe(3);
  });

  it("keeps content and history atomic on failure and permits a clean retry", async () => {
    const res = await request({ liveBlog: blog() }, {}, { adminLogEntryFn: () => { throw new Error("Synthetic audit failure"); } });
    expect(res.statusCode).toBe(500);
    expect((await post()).version).toBe(3);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    ok(await request({ liveBlog: blog() }));
    expect((await post()).version).toBe(4);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });

  it("lets Firestore retry a directory-read abort and commits the save once", async () => {
    // Fault injection at the vendor transaction boundary; every successful read
    // and the final commit still use the real loopback Firestore emulator.
    let aborted = false;
    const faulted = new Proxy(db, { get(target, property) {
      if (property === "runTransaction") return callback => target.runTransaction(async tx => {
        const readAll = tx.getAll.bind(tx);
        tx.getAll = async (...refs) => {
          if (!aborted && refs.some(ref => ref.path.startsWith("cmsAuthorProfiles/"))) {
            aborted = true;
            throw Object.assign(new Error("Synthetic aborted directory read"), { code: 10 });
          }
          return readAll(...refs);
        };
        return callback(tx);
      });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    ok(await request({ liveBlog: blog() }, {}, { firestore: faulted }));
    expect(aborted).toBe(true);
    expect((await post()).version).toBe(4);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  });

  it("returns 409 and keeps the draft when a restore needs the unavailable follow-up reader", async () => {
    const rendererSha = "a".repeat(40);
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: rendererSha,
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline" });
    await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2, rendererSha,
      servingEnabled: true, generation: 1, liveBlogVersion: 1 });
    const marker = db.doc(`system/publicDeployment/liveBlogContracts/${rendererSha}`);
    await marker.set({ schemaVersion: 1, rendererSha, liveBlogContractVersion: 3 });
    const value = blog(); value.updates[0].followUps = [{ id: "tmp-follow", body: value.updates[0].body, credits: [{ kind: "custom", name: "Reporter" }] }];
    ok(await request({ liveBlog: value }));
    const saved = await post();
    const history = await db.collection("cmsVersionHistory").where("after.version", "==", 4).get();
    await marker.delete();
    const res = response();
    await restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: principal, now: () => later })({ method: "POST", headers: {}, body: {
      collection: "cmsPosts", id: "post-one", revisionId: history.docs[0].id, baseVersion: 4,
    } }, res);
    expect(res.statusCode).toBe(409); expect(res.body.error).toMatch(/follow-up/i); expect(await post()).toEqual(saved);
  });

  it("restores a historical entry edit without rewriting public reporting", async () => {
    ok(await request({ liveBlog: blog() }));
    const original = await post();
    const published = { blocks: [], metadata: { liveBlog: await directory.freezeLiveBlogForPublish({ firestore: db, document: original, at }) }, publishedAt: at, sourceVersion: 4 };
    await db.doc("cmsPosts/post-one").update({ published });
    const edited = structuredClone(original.liveBlog); edited.updates[0].headline = "Draft revision";
    ok(await request({ liveBlog: edited }, { baseVersion: 4 }));
    const history = await db.collection("cmsVersionHistory").where("after.version", "==", 4).get();
    const res = response();
    await restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: principal, now: () => later })({ method: "POST", headers: {}, body: {
      collection: "cmsPosts", id: "post-one", revisionId: history.docs[0].id, baseVersion: 5,
    } }, res);
    ok(res);
    expect((await post()).liveBlog).toEqual(original.liveBlog);
    expect((await post()).published).toEqual(published);
  });

  it("refuses removal of a published entry on save and historical restore", async () => {
    ok(await request({ liveBlog: blog() }));
    const saved = await post();
    const published = { blocks: [], metadata: { liveBlog: await directory.freezeLiveBlogForPublish({ firestore: db, document: saved, at }) }, publishedAt: at, sourceVersion: 4 };
    await db.doc("cmsPosts/post-one").update({ published });
    const rejected = await request({ liveBlog: { ...saved.liveBlog, updates: [] } }, { baseVersion: 4 });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error).toContain("Withdraw");
    const cleared = await request({ liveBlog: null }, { baseVersion: 4 });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.body.error).toContain("Withdraw");
    await db.doc("cmsVersionHistory/pre-blog").set({ collection: "cmsPosts", documentId: "post-one", after: { ...saved, version: 1, liveBlog: { ...saved.liveBlog, updates: [] } } });
    const res = response();
    await restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: principal })({ method: "POST", headers: {}, body: {
      collection: "cmsPosts", id: "post-one", revisionId: "pre-blog", baseVersion: 4,
    } }, res);
    expect(res.statusCode).toBe(400);
    expect((await post()).published).toEqual(published);
  });

  it("refuses unmarked publication and scheduling and raw drafts as public snapshots", async () => {
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline" });
    ok(await request({ liveBlog: blog() }));
    const before = await post();
    for (const action of [{ publish: true }, { scheduleAt: "2026-10-26T15:00:00.000Z" }]) {
      const res = await request({}, { baseVersion: 4, ...action });
      expect({ status: res.statusCode, error: res.body.error }).toMatchObject({ status: 409, error: expect.stringContaining("installed Post renderer") });
      expect(await post()).toEqual(before);
    }
    expect(() => snapshot.createPublishedSnapshot({ collection: "cmsPosts", document: before, publishedAt: later, publishedBy: "editor", allowIncompletePresentation: true })).toThrow(/live blog/i);
  });
});

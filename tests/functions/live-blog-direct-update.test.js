import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import reader from "../../functions/published-post-reader.js";
import deployment from "../../functions/lib/public-deployment.js";
import publisher from "../../functions/publish.js";
import authorContract from "../../functions/lib/author-profile-contract.js";

// Jules's 2026-10-28 rule: Editor access and above may publish live blog entries,
// corrections, withdrawals and coverage state on a published live blog without
// another whole-Post approval. Writers keep the normal review path.
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-njpbs";
const sha = "a".repeat(40);
const first = "2026-11-03T23:00:00.000Z";
const later = "2026-11-03T23:05:00.000Z";
const quiet = { info() {}, warn() {}, error() {} };
const staff = (uid, grant) => ({ uid, email: `${uid}@example.test`, principal: { id: uid, grants: [grant] } });
const manager = staff("manager", { role: "admin" });
const editor = staff("tier-editor", { tier: "editor" });
const writer = staff("writer", { role: "contributor" });
const viewer = staff("viewer", { role: "staff" });
let db;
const text = value => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const blog = () => ({ schemaVersion: 1, branding: "nj-decides-2026", coverageState: "ongoing", updates: [{ id: "entry-one",
  headline: "Polls close", body: text("Polls closed at 8 p.m."), credits: [{ kind: "custom", name: "NJ PBS staff" }], keyUpdate: true }] });
const current = () => db.doc("cmsPosts/post-one").get().then(s => s.data());
function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function call(handler, body) {
  const res = response(); await handler({ method: "POST", headers: {}, body }, res); return res;
}
const ok = res => expect({ status: res.statusCode, error: res.body?.error }).toEqual({ status: 200, error: undefined });
const saveHandler = (actor, at = later) => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: () => actor,
  now: () => at, enablePublishSnapshot: true, assertPublishReadyFn: publisher.assertPublishReady, log: quiet });
async function directUpdate(actor, liveBlog, overrides = {}) {
  return call(saveHandler(actor), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version,
    publish: true, liveBlogUpdate: true, document: { liveBlog }, ...overrides });
}
async function transition(actor, action) {
  return call(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: () => actor, now: () => later, log: quiet }),
    { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, action });
}
async function publishFirst() {
  ok(await call(saveHandler(manager, first), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, document: {}, publish: true }));
}
const ADA = authorContract.mintAuthorId("a".repeat(32));
const BEN = authorContract.mintAuthorId("b".repeat(32));
async function seedAuthor(authorId, uid, displayName) {
  const stamp = { version: 1, createdAt: first, createdBy: "manager", updatedAt: first, updatedBy: "manager" };
  await db.collection(authorContract.AUTHOR_PROFILE_COLLECTIONS.staffRecords).doc(uid).set({
    uid, authorId, email: `${uid}@example.org`, status: "active", ...stamp });
  await db.collection(authorContract.AUTHOR_PROFILE_COLLECTIONS.workingProfiles).doc(authorId).set({
    authorId, uid, displayName, jobTitle: null, bio: null, photoAssetId: null, links: {}, visibility: "private", slug: null,
    previousSlugs: [], publishedAt: null, publishedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawnReason: null, ...stamp });
}
const withNewEntry = stored => {
  const value = structuredClone(stored.liveBlog);
  value.updates.unshift({ id: "", headline: "First results", body: text("Early returns are in."),
    credits: [{ kind: "custom", name: "Election desk" }], keyUpdate: false });
  return value;
};

describe("direct live blog updates on a published live blog Post", () => {
  beforeAll(() => {
    if (!HOST || !/^127\.0\.0\.1:\d+$/.test(HOST)) throw new Error("Use a loopback Firestore emulator.");
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("live-blog-direct-update.test.js");
  });
  beforeEach(async () => {
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
    await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
    await db.doc("sections/news").set({ label: "News" });
    await db.doc("cmsPosts/post-one").set({ id: "post-one", type: "post", title: "Election night", summary: "Live results coverage.",
      status: "draft", createdBy: "writer", section: "news", slug: "election-night", previousSlugs: [], locale: "en", tags: [], categories: [],
      date: "2026-11-03", credits: [{ kind: "custom", name: "NJ PBS staff" }], blocks: [], liveBlog: blog(), version: 3, updatedAt: first });
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
    await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2, rendererSha: sha,
      servingEnabled: true, generation: 1, liveBlogVersion: 1 });
  });
  afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });
  afterEach(() => vi.unstubAllEnvs());

  it("lets an Editor publish presentation alone and preserves entry publication clocks", async () => {
    await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 2 });
    await publishFirst();
    const before = await current();
    const presentation = { reporterPhotos: false, reporterCards: false, playful: true };
    ok(await directUpdate(editor, { ...before.liveBlog, presentation }));
    const after = await current();
    expect(after.published.metadata.liveBlog).toMatchObject({ presentation, updatedAt: later });
    expect(after.published.metadata.liveBlog.updates).toEqual(before.published.metadata.liveBlog.updates);
    expect(after.liveBlog.presentation).toEqual(presentation);
  });

  it("refuses a Writer’s direct presentation publication", async () => {
    await publishFirst();
    const before = await current();
    expect((await directUpdate(writer, { ...before.liveBlog, presentation: { playful: true } })).statusCode).toBe(403);
    expect(await current()).toEqual(before);
  });

  it("leaves a presentation-only direct request unchanged on the old renderer with a staff note", async () => {
    await publishFirst();
    const before = await current();
    const result = await directUpdate(editor, { ...before.liveBlog, presentation: { playful: true } });
    ok(result);
    expect(result.body.publication).toBeUndefined();
    expect(result.body.warnings.join(" ")).toMatch(/appearance settings take effect after the update/);
    expect(await current()).toEqual(before);
  });

  it("can publish other live updates while omitting unsupported presentation", async () => {
    await publishFirst();
    const result = await directUpdate(editor, { ...withNewEntry(await current()), presentation: { playful: true } });
    ok(result);
    expect(result.body.warnings.join(" ")).toMatch(/appearance settings take effect after the update/);
    const stored = await current();
    expect(stored.liveBlog).not.toHaveProperty("presentation");
    expect(stored.published.metadata.liveBlog).not.toHaveProperty("presentation");
    expect(stored.published.metadata.liveBlog.updates[0].headline).toBe("First results");
  });

  it("adds, corrects and withdraws a follow-up through the authorized direct path", async () => {
    await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 3 });
    await publishFirst(); const before = await current();
    const value = structuredClone(before.liveBlog);
    value.updates[0].followUps = [{ id: "tmp-follow", body: text("A short follow-up."), credits: [{ kind: "custom", name: "Reporter" }] }];
    expect((await directUpdate(writer, value)).statusCode).toBe(403);
    ok(await directUpdate(editor, value));
    const added = await current(); const follow = added.published.metadata.liveBlog.updates[0].followUps[0];
    expect(follow).toMatchObject({ publishedAt: later, updatedAt: later });
    expect(follow.id).not.toBe("tmp-follow");
    expect(added.published.metadata.liveBlog.updates[0]).toMatchObject({
      publishedAt: before.published.metadata.liveBlog.updates[0].publishedAt, updatedAt: later, keyUpdate: true,
    });
    expect(added.published.metadata.liveBlog.updatedAt).toBe(later);
    const third = "2026-11-03T23:06:00.000Z", fourth = "2026-11-03T23:07:00.000Z";
    const edit = structuredClone(added.liveBlog); edit.updates[0].followUps[0].body = text("Corrected follow-up.");
    const sendAt = async (liveBlog, at) => call(saveHandler(editor, at), { collection: "cmsPosts", id: "post-one",
      baseVersion: (await current()).version, publish: true, liveBlogUpdate: true, document: { liveBlog } });
    expect((await sendAt(edit, third)).statusCode).toBe(400);
    edit.updates[0].followUps[0].correction = "Corrected the detail.";
    ok(await sendAt(edit, third));
    const corrected = await current();
    expect(corrected.published.metadata.liveBlog.updates[0].followUps[0]).toMatchObject({ id: follow.id, publishedAt: later, updatedAt: third });
    edit.updates[0].followUps[0].withdrawal = "Could not verify the detail.";
    ok(await sendAt(edit, fourth));
    const withdrawn = await current();
    expect(withdrawn.published.metadata.liveBlog.updates[0].followUps[0]).toMatchObject({ id: follow.id, publishedAt: later, updatedAt: fourth, body: { type: "doc", content: [] } });
    expect(JSON.stringify(withdrawn.published.metadata.liveBlog)).not.toContain("Corrected follow-up.");
    const parentWithdrawal = structuredClone(withdrawn.liveBlog); parentWithdrawal.updates[0].withdrawal = "Parent report could not be verified.";
    ok(await sendAt(parentWithdrawal, "2026-11-03T23:08:00.000Z"));
    const hidden = await current();
    expect(hidden.liveBlog.updates[0].followUps).toHaveLength(1);
    expect(hidden.published.metadata.liveBlog.updates[0]).not.toHaveProperty("followUps");
    parentWithdrawal.updates[0].followUps.push({ id: "tmp-hidden", body: text("Must not be saved."), credits: [{ kind: "custom", name: "Reporter" }] });
    const refused = await sendAt(parentWithdrawal, "2026-11-03T23:09:00.000Z");
    expect(refused.statusCode).toBe(400); expect(refused.body.error).toMatch(/withdrawn update/);
    expect(await current()).toEqual(hidden);
  });

  it.each([undefined, 2])("refuses even a draft follow-up write with installed reader contract %s", async version => {
    if (version) await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: version });
    await db.doc(`system/publicDeployment/liveBlogContracts/${"b".repeat(40)}`).set({ schemaVersion: 1, rendererSha: "b".repeat(40), liveBlogContractVersion: 3 });
    await publishFirst(); const before = await current();
    const value = structuredClone(before.liveBlog);
    value.updates[0].followUps = [{ id: "tmp-follow", body: text("A short follow-up."), credits: [{ kind: "custom", name: "Reporter" }] }];
    const result = await call(saveHandler(editor), { collection: "cmsPosts", id: "post-one", baseVersion: before.version, document: { liveBlog: value } });
    expect(result.statusCode).toBe(409); expect(result.body.error).toMatch(/follow-up/i); expect(result.body.code).toBe("live_blog_follow_ups_unavailable");
    expect(await current()).toEqual(before);
  });

  it("lets a Manager publish a new entry and records who posted it", async () => {
    await publishFirst();
    const before = await current();
    const res = await directUpdate(manager, withNewEntry(before));
    ok(res);
    expect(res.body.publication).toMatchObject({ status: "pending", transport: "serializer" });
    const after = await current();
    expect(after).toMatchObject({ status: "published", publiclyVisible: true, version: before.version + 1,
      contentVersion: before.contentVersion + 1, updatedBy: "manager" });
    const [added, kept] = after.published.metadata.liveBlog.updates;
    expect(added).toMatchObject({ headline: "First results", publishedAt: later, updatedAt: later });
    expect(added.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(kept).toEqual(before.published.metadata.liveBlog.updates[0]);
    expect(after.published).toMatchObject({ publishedBy: "manager", publishedAt: later, contentVersion: after.contentVersion,
      metadata: { title: "Election night", summary: "Live results coverage." } });
    const history = (await db.collection("cmsVersionHistory").where("action", "==", "live-blog-update").get()).docs.map(doc => doc.data());
    expect(history).toEqual([expect.objectContaining({ documentId: "post-one", userId: "manager", userEmail: "manager@example.test" })]);
    const logs = (await db.collection("admin_logs").where("action", "==", "cms.live-blog-update").get()).docs.map(doc => doc.data());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ target: "cmsPosts/post-one" });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
    const result = await reader.readPublishedPost({ firestore: db, slug: "election-night", now: new Date(later), includeChrome: false });
    expect(result.document.published.metadata.liveBlog.updates.map(entry => entry.headline)).toEqual(["First results", "Polls close"]);
  });

  it("lets Editor access without Publish access correct, withdraw and end coverage", async () => {
    await publishFirst();
    const stored = await current();
    const edited = withNewEntry(stored);
    edited.updates[1].body = text("Polls closed at 8 p.m. in every county.");
    const refused = await directUpdate(editor, edited);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("new visible correction");
    edited.updates[1].correction = "An earlier version did not say every county.";
    ok(await directUpdate(editor, edited));
    let after = await current();
    expect(after.published.metadata.liveBlog.updates[1]).toMatchObject({ id: "entry-one", publishedAt: first, updatedAt: later,
      correction: "An earlier version did not say every county." });
    const withdrawn = structuredClone(after.liveBlog);
    withdrawn.updates[1].withdrawal = "This update was superseded.";
    withdrawn.coverageState = "ended";
    ok(await call(saveHandler(editor, "2026-11-03T23:10:00.000Z"), { collection: "cmsPosts", id: "post-one",
      baseVersion: after.version, publish: true, liveBlogUpdate: true, document: { liveBlog: withdrawn } }));
    after = await current();
    expect(after.published.metadata.liveBlog).toMatchObject({ coverageState: "ended" });
    expect(after.published.metadata.liveBlog.updates[1]).toMatchObject({ id: "entry-one", headline: "Update withdrawn",
      withdrawal: "This update was superseded." });
    expect(after.published.publishedBy).toBe("tier-editor");
  });

  it("keeps a Writer on the normal review and approval path", async () => {
    await publishFirst();
    const stored = await current();
    const res = await directUpdate(writer, withNewEntry(stored));
    expect(res.statusCode).toBe(403);
    expect(await current()).toEqual(stored);
    // The Writer works in a reopened draft and submits it for review.
    ok(await transition(manager, "revise"));
    ok(await call(saveHandler(writer), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version,
      document: { liveBlog: withNewEntry(stored) } }));
    const publish = await call(saveHandler(writer), { collection: "cmsPosts", id: "post-one",
      baseVersion: (await current()).version, document: {}, publish: true });
    expect(publish.statusCode).toBe(403);
    ok(await transition(writer, "submit"));
    const submitted = await current();
    expect(submitted.status).toBe("in_review");
    expect(submitted.published).toEqual(stored.published);
    // An Editor whose form still holds the published version gets reload recovery first.
    const staleForm = await directUpdate(editor, withNewEntry(stored), { baseVersion: stored.version });
    expect(staleForm.statusCode).toBe(409);
    expect(staleForm.body.versionConflict).toBe(true);
    const direct = await directUpdate(editor, submitted.liveBlog);
    expect(direct.statusCode).toBe(409);
    expect(direct.body.error).toContain("review, approval or schedule");
    expect(direct.body).not.toHaveProperty("versionConflict");
    ok(await transition(manager, "approve"));
    ok(await call(saveHandler(manager), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, document: {}, publish: true }));
    expect((await current()).published.metadata.liveBlog.updates[0].headline).toBe("First results");
  });

  it("refuses staff below Editor access", async () => {
    await publishFirst();
    const stored = await current();
    expect((await directUpdate(viewer, withNewEntry(stored))).statusCode).toBe(403);
    expect(await current()).toEqual(stored);
  });

  it("refuses a live blog that is not yet published", async () => {
    const stored = await current();
    const res = await directUpdate(manager, withNewEntry(stored));
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("before publishing live updates directly");
    expect(await current()).toEqual(stored);
  });

  it("refuses a published Post that is not a live blog", async () => {
    await db.doc("cmsPosts/post-one").update({ liveBlog: admin.firestore.FieldValue.delete() });
    await publishFirst();
    const stored = await current();
    const res = await directUpdate(manager, blog());
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("Only a live blog Post can publish live updates directly.");
    expect(await current()).toEqual(stored);
  });

  it("refuses a withdrawn live blog", async () => {
    await publishFirst();
    await db.doc("cmsPosts/post-one").update({ status: "draft", publiclyVisible: false });
    const stored = await current();
    const res = await directUpdate(manager, withNewEntry(stored));
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("withdrawn");
    expect(await current()).toEqual(stored);
  });

  it("refuses Post changes outside the live updates, including coverage branding", async () => {
    await publishFirst();
    const stored = await current();
    const rebranded = withNewEntry(stored);
    delete rebranded.branding;
    const branding = await directUpdate(manager, rebranded);
    expect(branding.statusCode).toBe(409);
    expect(branding.body.error).toContain("changes outside its live updates");
    const extra = await directUpdate(manager, withNewEntry(stored), { document: { liveBlog: withNewEntry(stored), title: "New title" } });
    expect(extra.statusCode).toBe(400);
    expect(await current()).toEqual(stored);
    // A saved draft title change stays behind review and approval.
    ok(await call(saveHandler(manager), { collection: "cmsPosts", id: "post-one", baseVersion: stored.version, document: { title: "Changed title" } }));
    const draft = await current();
    const parent = await directUpdate(manager, withNewEntry(draft));
    expect(parent.statusCode).toBe(409);
    expect(parent.body.error).toContain("changes outside its live updates");
    expect((await current()).published).toEqual(stored.published);
  });

  it("keeps the published parent byline after an author rename and refuses a byline change", async () => {
    await seedAuthor(ADA, "ada", "Ada Reporter");
    await seedAuthor(BEN, "ben", "Ben Reporter");
    await db.doc("cmsPosts/post-one").update({ credits: [{ kind: "registered", authorId: ADA }] });
    await publishFirst();
    const stored = await current();
    expect(stored.published.metadata.credits).toEqual([expect.objectContaining({ authorId: ADA, displayName: "Ada Reporter" })]);
    await db.doc(`${authorContract.AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${ADA}`).update({ displayName: "Ada Renamed" });
    ok(await directUpdate(editor, withNewEntry(stored)));
    const after = await current();
    expect(after.published.metadata.credits).toEqual(stored.published.metadata.credits);
    expect(after.published.metadata.liveBlog.updates[0].headline).toBe("First results");
    // A saved draft that changes who is credited still needs review and approval.
    ok(await call(saveHandler(manager, "2026-11-03T23:10:00.000Z"), { collection: "cmsPosts", id: "post-one", baseVersion: after.version,
      document: { credits: [{ kind: "registered", authorId: ADA }, { kind: "registered", authorId: BEN }] } }));
    const draft = await current();
    const refused = await call(saveHandler(editor, "2026-11-03T23:15:00.000Z"), { collection: "cmsPosts", id: "post-one",
      baseVersion: draft.version, publish: true, liveBlogUpdate: true, document: { liveBlog: withNewEntry(draft) } });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toContain("changes outside its live updates");
    expect((await current()).published).toEqual(after.published);
  });

  it("accepts a refreshed public copy of the same parent video and still refuses a different video", async () => {
    const copy = (hash) => ({ url: `https://media.njpbs.org/cms-media/video/body-video/${hash.repeat(64)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/body-video/${hash.repeat(63)}f.jpg`, width: 1280, height: 720, mimeType: "video/mp4" });
    await db.doc("cmsPublicVideos/body-video").set({ schemaVersion: 1, sourceId: "video-library", assetId: "body-video", media: copy("a") });
    await db.doc("cmsPublicVideos/other-video").set({ schemaVersion: 1, sourceId: "video-library", assetId: "other-video", media: copy("c") });
    await db.doc("cmsPosts/post-one").update({ blocks: [{ id: "body-video", type: "video", visible: true, order: 0,
      data: { sourceId: "video-library", assetId: "body-video", title: "Results briefing" } }] });
    await publishFirst();
    const stored = await current();
    expect(stored.published.blocks[0].data.public).toEqual(copy("a"));
    // Another publication refreshed the shared copy of the same video.
    await db.doc("cmsPublicVideos/body-video").update({ media: copy("b") });
    ok(await directUpdate(editor, withNewEntry(stored)));
    const after = await current();
    expect(after.published.metadata.liveBlog.updates[0].headline).toBe("First results");
    expect(after.published.blocks[0].data).toEqual({ ...stored.published.blocks[0].data, public: copy("b") });
    // Choosing another video is a parent change and still needs review and approval.
    ok(await call(saveHandler(manager), { collection: "cmsPosts", id: "post-one", baseVersion: after.version,
      document: { blocks: [{ ...after.blocks[0], data: { ...after.blocks[0].data, assetId: "other-video" } }] } }));
    const refused = await directUpdate(editor, withNewEntry(await current()));
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toContain("changes outside its live updates");
  });

  it("refuses a stale baseVersion and an unchanged live blog", async () => {
    await publishFirst();
    const stored = await current();
    const stale = await directUpdate(manager, withNewEntry(stored), { baseVersion: stored.version - 1 });
    expect(stale.statusCode).toBe(409);
    // Boardwalk uses this flag to offer reload or discard instead of a plain refusal.
    expect(stale.body.versionConflict).toBe(true);
    const unchanged = await directUpdate(manager, stored.liveBlog);
    expect(unchanged.statusCode).toBe(409);
    expect(unchanged.body).not.toHaveProperty("versionConflict");
    expect(unchanged.body.error).toBe("There are no live update changes to publish.");
    expect(await current()).toEqual(stored);
  });
});

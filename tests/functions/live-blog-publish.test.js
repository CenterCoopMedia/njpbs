import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import preview from "../../functions/preview.js";
import reader from "../../functions/published-post-reader.js";
import directory from "../../functions/lib/story-credit-directory.js";
import scheduled from "../../functions/scheduled-publish.js";
import deployment from "../../functions/lib/public-deployment.js";
import videos from "../../functions/lib/public-video.js";
import videoReferences from "../../functions/lib/public-video-references.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import mediaContract from "../../functions/lib/media-contract.js";
import postPublication from "../../functions/lib/no-build-post-publication.js";
import publisher from "../../functions/publish.js";

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-njpbs";
const sha = "a".repeat(40);
const first = "2026-10-25T15:00:00.000Z";
const later = "2026-10-25T15:01:00.000Z";
const actor = { uid: "reviewer", email: "reviewer@example.test", principal: { id: "reviewer", grants: [{ role: "admin" }] } };
const quiet = { info() {}, warn() {}, error() {} };
let db;
const blog = () => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{ id: "entry-one", headline: "Council votes",
  body: { type: "doc", attrs: { staffNote: "PRIVATE editor attribute" }, content: [{ type: "paragraph", content: [{ type: "text", text: "The vote was 6 to 1." }] }] },
  credits: [{ kind: "custom", name: "Example newsroom" }], keyUpdate: true,
}] });
function readyEntryVideo() {
  const asset = { sourceId: "video-library", lifecycle: "active", name: "Briefing.mov", originalName: "Briefing.mov",
    nameSort: "briefing.mov", updatedAtSort: first, kind: "video", mimeType: "video/quicktime", sizeBytes: 128,
    objectKey: "objects/briefing.mov", objectVersionId: "original-v1", preview: "download_only", rightsStatus: "complete",
    license: "Station owned", credit: "Example newsroom", tags: [], version: 1 };
  const prefix = renditions.sourceMediaRenditionOutputPrefix({ id: "entry-video", ...asset }, "attempt-1");
  return { ...asset, rendition: { schemaVersion: 1, state: "ready", attemptId: "attempt-1", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes, updatedAt: first,
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 16, mimeType: "video/mp4", width: 1280, height: 720, durationSeconds: 1 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 8, mimeType: "image/jpeg" } } };
}
const current = () => db.doc("cmsPosts/post-one").get().then(s => s.data());
function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function call(handler, body) {
  const res = response(); await handler({ method: "POST", headers: {}, body }, res); return res;
}
const ok = res => expect({ status: res.statusCode, error: res.body?.error }).toEqual({ status: 200, error: undefined });
const saveHandler = (overrides = {}) => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: () => actor,
  now: () => first, enablePublishSnapshot: true, assertPublishReadyFn: publisher.assertPublishReady, log: quiet, ...overrides });
async function transition(action) {
  return call(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: () => actor, now: () => first, log: quiet }),
    { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, action });
}
async function publish(overrides = {}) {
  return call(saveHandler(overrides), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, document: {}, publish: true });
}
const previewFields = () => ({ actor, collection: "cmsPosts", pageId: "post-one", sourceVersion: 3, persistent: false });
const previewDeps = () => ({ firestore: db, now: () => Date.parse(later), getTransport: () => "serializer", serializerReady: true,
  getRendererSha: () => sha, assertBillingEnabledFn: async () => true });

describe("live blogs through the existing Post publication and preview paths", () => {
  beforeAll(() => {
    if (!HOST || !/^127\.0\.0\.1:\d+$/.test(HOST)) throw new Error("Use a loopback Firestore emulator.");
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("live-blog-publish.test.js");
  });
  beforeEach(async () => {
    vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
    await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
    await db.doc("sections/news").set({ label: "News" });
    await db.doc("cmsPosts/post-one").set({ id: "post-one", type: "post", title: "Local coverage", summary: "Synthetic Post reporting.",
      status: "draft", createdBy: "editor", section: "news", slug: "coverage", previousSlugs: [], locale: "en", tags: [], categories: [],
      date: "2026-10-25", credits: [{ kind: "custom", name: "Example newsroom" }], blocks: [], liveBlog: blog(), version: 3, updatedAt: first });
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
    await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2, rendererSha: sha,
      servingEnabled: true, generation: 1, liveBlogVersion: 1 });
  });
  afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });
  afterEach(() => vi.unstubAllEnvs());

  it("creates, previews, publishes, corrects, withdraws and ends a live blog through the Post workflow", async () => {
    let clock = first;
    const handler = saveHandler({ now: () => clock });
    const created = await call(handler, { collection: "cmsPosts", section: "news", document: {
      type: "post", title: "Election night coverage", summary: "Reporting from across New Jersey.",
      section: "news", slug: "election-night", locale: "en", date: "2026-10-25", tags: [], categories: [], blocks: [],
      credits: [{ kind: "custom", name: "Example newsroom" }],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", branding: "nj-decides-2026", updates: [] },
    } });
    ok(created); expect(created.body.created).toBe(true);
    const id = created.body.id;
    const slug = created.body.document.slug;
    const ref = db.doc(`cmsPosts/${id}`);
    const read = () => ref.get().then(s => s.data());
    const saveBlog = async value => {
      const result = await call(handler, { collection: "cmsPosts", id, baseVersion: (await read()).version, document: { liveBlog: value } });
      ok(result);
    };
    await saveBlog(null);
    expect(await read()).not.toHaveProperty("liveBlog");
    await saveBlog({ schemaVersion: 1, coverageState: "ongoing", branding: "nj-decides-2026", updates: [] });
    const approveAndPublish = async () => {
      for (const action of ["submit", "approve"]) {
        ok(await call(lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: () => actor,
          now: () => clock, log: quiet }), { collection: "cmsPosts", id, baseVersion: (await read()).version, action }));
      }
      ok(await call(handler, { collection: "cmsPosts", id, baseVersion: (await read()).version, document: {}, publish: true }));
    };
    const value = { ...blog(), branding: "nj-decides-2026" };
    value.updates[0].id = "tmp-first";
    await saveBlog(value);
    const entryId = (await read()).liveBlog.updates[0].id;
    expect(entryId).not.toBe("tmp-first");
    await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "fixture-preview", liveBlogVersion: 1 });
    const queued = await preview.enqueuePreview({ actor, collection: "cmsPosts", pageId: id,
      sourceVersion: (await read()).version, persistent: false }, previewDeps());
    expect((await db.doc(`cmsPreviewQueue/${queued.queueId}`).get()).data().snapshot.published.metadata.liveBlog.updates[0].id).toBe(entryId);
    expect(await reader.readPublishedPost({ firestore: db, slug, now: new Date(later), includeChrome: false })).toEqual({ kind: "not-found" });
    await approveAndPublish();
    const frozen = structuredClone((await read()).published);
    clock = later;
    const edited = (await read()).liveBlog;
    edited.updates[0].headline = "Council confirms the final vote";
    edited.updates[0].correction = "Corrected the description of the vote.";
    await saveBlog(edited);
    expect((await read()).published).toEqual(frozen);
    await approveAndPublish();
    expect((await read()).published.metadata.liveBlog.updates[0]).toMatchObject({ id: entryId, publishedAt: first,
      updatedAt: later, correction: edited.updates[0].correction });
    clock = "2026-10-25T15:02:00.000Z";
    const withdrawn = (await read()).liveBlog;
    withdrawn.updates[0].withdrawal = "The source withdrew this report.";
    await saveBlog(withdrawn); await approveAndPublish();
    const tombstone = (await read()).published.metadata.liveBlog.updates[0];
    expect(tombstone).toMatchObject({ id: entryId, publishedAt: first, withdrawal: withdrawn.updates[0].withdrawal });
    expect(JSON.stringify(tombstone)).not.toContain("The vote was 6 to 1.");
    clock = "2026-10-25T15:03:00.000Z";
    await saveBlog({ ...(await read()).liveBlog, coverageState: "ended" }); await approveAndPublish();
    const result = await reader.readPublishedPost({ firestore: db, slug, now: new Date(clock), includeChrome: false });
    expect(result.document.published.metadata.liveBlog.coverageState).toBe("ended");
    expect(result.document.published.metadata.liveBlog.updates[0].id).toBe(entryId);
  });

  it("saves presentation as a draft and publishes it through the ordinary Post workflow", async () => {
    await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 2 });
    const presentation = { reporterPhotos: false, reporterCards: false, playful: true };
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation } } }));
    expect((await current()).liveBlog.presentation).toEqual(presentation);
    expect((await current()).published).toBeUndefined();
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    const result = await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false });
    expect(result.document.published.metadata.liveBlog.presentation).toEqual(presentation);
  });

  it("serves an installed presentation snapshot using the companion without adding shared capability keys", async () => {
    const marker = db.doc(`system/publicDeployment/liveBlogContracts/${sha}`);
    await marker.set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 2 });
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation: { playful: true } } } }));
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    const stored = await current();
    await db.doc("system/publicDeployment/noBuildPostOwners/post-one").set({ schemaVersion: 1, postId: "post-one", rendererSha: sha,
      servingEnabled: true, generation: 1, operationId: "a".repeat(20), sourceVersion: stored.published.sourceVersion,
      slug: "coverage", ownedSlugs: ["coverage"], visible: true });
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
    const read = () => postPublication.readNoBuildPostDecision({ firestore: db, path: "/posts/coverage/", rendererSha: sha });
    expect((await read()).kind).toBe("post");
    expect((await db.doc("system/publicDeployment/noBuildPosts/capability").get()).data()).not.toHaveProperty("liveBlogContractVersion");
    await marker.delete();
    await expect(read()).rejects.toThrow("does not support the published live blog");
  });

  it("omits presentation while the installed renderer still has the legacy contract and explains the omission", async () => {
    const response = await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation: { playful: true } } } });
    ok(response);
    expect(response.body.warnings).toContain("Live blog appearance settings take effect after the update. Choose them again after the update.");
    expect((await current()).liveBlog).not.toHaveProperty("presentation");
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    expect((await current()).published.metadata.liveBlog).not.toHaveProperty("presentation");
  });

  it("warns when an appearance-only draft save makes no changes on the legacy renderer", async () => {
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: blog() } }));
    const before = await current();
    const response = await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: before.version,
      document: { liveBlog: { ...before.liveBlog, presentation: { playful: true } } } });
    ok(response);
    expect(response.body.warnings).toContain("Live blog appearance settings take effect after the update. Choose them again after the update.");
    expect(response.body.document.version).toBe(before.version);
    expect(await current()).toEqual(before);
  });

  it.each(["absent", "mismatched"])("preserves stored presentation and refuses an unrelated save while the marker is temporarily %s", async mode => {
    await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 2 });
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation: { reporterPhotos: false, playful: true } } } }));
    if (mode === "absent") await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).delete();
    else await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).update({ rendererSha: "f".repeat(40) });
    const before = await current();
    const result = await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: before.version,
      document: { title: "Unrelated title edit" } });
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toMatch(/saved choices have not changed/);
    expect(result.body.code).toBe("live_blog_presentation_unavailable");
    expect(await current()).toEqual(before);
  });

  it("saves appearance and unrelated draft edits during deployment when the active reader still supports them", async () => {
    await db.doc(`system/publicDeployment/liveBlogContracts/${sha}`).set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 2 });
    await db.doc("system/publicDeployment").update({ state: "deploying" });
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation: { playful: true } } } }));
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version,
      document: { title: "Saved during deployment" } }));
    expect((await current()).liveBlog.presentation).toEqual({ playful: true });
  });

  it("refuses invalid presentation before applying the legacy omission", async () => {
    const before = await current();
    const response = await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3,
      document: { liveBlog: { ...blog(), presentation: { playful: "yes" } } } });
    expect(response.statusCode).toBe(400); expect(await current()).toEqual(before);
  });

  it("keeps normal whole-Post review and freezes an approved live blog for the public reader", async () => {
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    const published = (await current()).published;
    expect(published.metadata.liveBlog.updates[0]).toMatchObject({ id: "entry-one", publishedAt: first, updatedAt: first });
    const result = await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false });
    expect(result.kind).toBe("published-post");
    expect(result.document.published.metadata.liveBlog.updates[0].body.content[0].content[0].text).toBe("The vote was 6 to 1.");
    expect(JSON.stringify(result)).not.toContain("PRIVATE editor attribute");
    const card = await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false, cardsOnly: true });
    expect(card.document.published.metadata).not.toHaveProperty("liveBlog");
    expect((await current()).liveBlog.updates[0]).not.toHaveProperty("publishedAt");
  });

  it("can remove a published empty blog but preserves the current public output until Post publication", async () => {
    const empty = { ...blog(), updates: [] };
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3, document: { liveBlog: empty } }));
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    const before = (await current()).published;
    ok(await call(saveHandler({ now: () => later }), { collection: "cmsPosts", id: "post-one", baseVersion: (await current()).version, document: { liveBlog: null } }));
    expect(await current()).not.toHaveProperty("liveBlog");
    expect((await current()).published).toEqual(before);
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish({ now: () => later }));
    expect((await current()).published.metadata).not.toHaveProperty("liveBlog");
  });

  it("freezes entry images through ordinary media usage and keeps draft previews private", async () => {
    const image = { lifecycle: "active", source: "site_seed", url: "https://media.njpbs.org/cms-media/entry-photo/image.jpg",
      altText: "Library description", mimeType: "image/jpeg", width: 800, height: 600 };
    const imageRef = db.doc("media_assets/entry-photo");
    await imageRef.set(image);
    await db.doc("media_assets_public/entry-photo").set(mediaContract.mediaProjection(image));
    const value = blog(); value.updates[0].media = { kind: "image", data: { assetId: "entry-photo", alt: "People at a polling place", caption: "Example photo credit" } };
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3, document: { liveBlog: value } }));
    expect((await db.doc("cmsPosts/post-one/mediaUsage/working").get()).data()?.assetIds).toEqual(["entry-photo"]);
    await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "fixture-preview", liveBlogVersion: 1 });
    const privateResult = await preview.enqueuePreview({ ...previewFields(), sourceVersion: (await current()).version }, previewDeps());
    const queued = (await db.doc(`cmsPreviewQueue/${privateResult.queueId}`).get()).data();
    expect(queued.snapshot.published.metadata.liveBlog.updates[0].media).toEqual(value.updates[0].media);
    expect(queued.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "entry-photo", url: image.url })]));
    expect((await current()).published).toBeUndefined();
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish());
    expect((await db.doc("cmsPosts/post-one/mediaUsage/published").get()).data()?.assetIds).toEqual(["entry-photo"]);
    const result = await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false });
    expect(result.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "entry-photo" })]));
  });

  it("strips draft video copies and publishes entries only after the existing public-copy gate", async () => {
    const value = blog(); value.updates[0].media = { kind: "library-video", data: { sourceId: "video-library", assetId: "entry-video", title: "Results briefing", public: { url: "PRIVATE client spoof" } } };
    ok(await call(saveHandler(), { collection: "cmsPosts", id: "post-one", baseVersion: 3, document: { liveBlog: value } }));
    expect((await current()).liveBlog.updates[0].media.data).not.toHaveProperty("public");
    ok(await transition("submit")); ok(await transition("approve"));
    const before = await current();
    const refused = await publish(); expect(refused.statusCode).toBe(409); expect(await current()).toEqual(before);
    const media = { url: `https://media.njpbs.org/cms-media/video/entry-video/${"a".repeat(64)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/entry-video/${"b".repeat(64)}.jpg`, width: 1280, height: 720, mimeType: "video/mp4" };
    await db.doc("cmsPublicVideos/entry-video").set({ schemaVersion: 1, sourceId: "video-library", assetId: "entry-video", media });
    ok(await publish());
    expect((await current()).published.metadata.liveBlog.updates[0].media.data.public).toEqual(media);
    expect((await current()).liveBlog.updates[0].media.data).not.toHaveProperty("public");
    const result = await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false });
    expect(result.document.published.metadata.liveBlog.updates[0].media.data.public).toEqual(media);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const stored = await current();
    expect(videoReferences.publicCopies(stored)).toEqual([{ assetId: "entry-video", url: media.url }, { assetId: "entry-video", url: media.posterUrl }]);
    expect(videoReferences.scheduledVideoAssetIds({ ...stored, status: "scheduled" })).toContain("entry-video");
    const withdrawn = structuredClone(stored.liveBlog); withdrawn.updates[0].withdrawal = "This briefing was superseded.";
    ok(await call(saveHandler({ now: () => later }), { collection: "cmsPosts", id: "post-one", baseVersion: stored.version, document: { liveBlog: withdrawn } }));
    ok(await transition("submit")); ok(await transition("approve")); ok(await publish({ now: () => later }));
    const after = await current();
    expect(after.published.metadata.liveBlog.updates[0]).not.toHaveProperty("media");
    expect(after.published.previousVideoCopies).toContainEqual({ assetId: "entry-video", url: media.url });
  });

  it("checks current entry-video renditions in private previews without writing to drafts", async () => {
    const value = blog(); value.updates[0].media = { kind: "library-video", data: { sourceId: "video-library", assetId: "entry-video", title: "Briefing" } };
    await db.doc("cmsPosts/post-one").update({ liveBlog: value });
    const before = await current();
    // A body id cannot make a hidden body video visible by matching an adapted entry id.
    const candidate = { ...before, blocks: [
      { id: "layout-row", type: "row", visible: true, order: 0, data: { columns: [12] } },
      { id: "body-video", type: "video", visible: true, order: 1, layout: { rowId: "layout-row", column: 0 }, data: value.updates[0].media.data },
      { id: "live-blog-video-0", type: "video", order: 0, visible: false,
      data: { sourceId: "video-library", assetId: "hidden-video", title: "Hidden" } }] };
    const stamp = () => db.runTransaction(tx => videos.withPreviewVideos({ tx, firestore: db, document: candidate }));
    expect(videos.previewVideoState(await stamp())).toEqual({ "entry-video": null });
    await expect(db.runTransaction(tx => videos.withPublicVideos({ tx, firestore: db, document: candidate }))).rejects.toMatchObject({ status: 409 });
    const media = { url: `https://media.njpbs.org/cms-media/video/entry-video/${"a".repeat(64)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/entry-video/${"b".repeat(64)}.jpg`, width: 1280, height: 720, mimeType: "video/mp4" };
    await db.doc("cmsPublicVideos/entry-video").set({ schemaVersion: 1, assetId: "entry-video", webVersionId: "web-v1", media });
    await db.doc("mediaSourceAssets/entry-video").set(readyEntryVideo());
    const stamped = await stamp(); const state = videos.previewVideoState(stamped);
    expect(stamped.liveBlog.updates[0].media.data.public).toEqual(media);
    expect(stamped.blocks.find(block => block.id === "body-video").data.public).toEqual(media);
    expect(stamped.blocks.find(block => block.id === "live-blog-video-0").data).not.toHaveProperty("public");
    const published = await db.runTransaction(tx => videos.withPublicVideos({ tx, firestore: db, document: candidate }));
    expect(published.blocks.find(block => block.id === "live-blog-video-0").data).not.toHaveProperty("public");
    expect(published.liveBlog.updates[0].media.data.public).toEqual(media);
    expect(state).toEqual({ "entry-video": media.url });
    expect(await db.runTransaction(tx => videos.previewVideosCurrent({ tx, firestore: db, state }))).toBe(true);
    await db.doc("mediaSourceAssets/entry-video").update({ "rendition.web.objectVersionId": "web-v2" });
    expect(await db.runTransaction(tx => videos.previewVideosCurrent({ tx, firestore: db, state }))).toBe(false);
    expect(videos.previewVideoState(await stamp())).toEqual({ "entry-video": null });
    expect(await current()).toEqual(before);
  });

  it("refuses publication without feature support and leaves the approved Post unchanged", async () => {
    ok(await transition("submit")); ok(await transition("approve"));
    await db.doc("system/publicDeployment/noBuildPosts/capability").update({ liveBlogVersion: admin.firestore.FieldValue.delete() });
    const before = await current(); const res = await publish();
    expect(res.statusCode).toBe(409); expect(res.body.error).toContain("installed Post renderer");
    expect(await current()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  });

  it("refuses an edited published entry at approval until it has a new correction", async () => {
    const stored = await current();
    const frozen = await directory.freezeLiveBlogForPublish({ firestore: db, document: stored, at: first });
    stored.liveBlog.updates[0].body.content[0].content[0].text = "The vote was 5 to 2.";
    await db.doc("cmsPosts/post-one").update({ status: "in_review", liveBlog: stored.liveBlog,
      published: { blocks: [], metadata: { type: "post", liveBlog: frozen }, sourceVersion: 3, publishedAt: first } });
    const refused = await transition("approve");
    expect(refused.statusCode).toBe(400); expect(refused.body.error).toContain("new visible correction");
    expect((await current()).status).toBe("in_review");
  });

  it("admits incomplete saved entries to private preview while refusing approval and public reads", async () => {
    const value = blog(); Object.assign(value.updates[0], { headline: "", body: { type: "doc", content: [] }, credits: [] });
    await db.doc("cmsPosts/post-one").update({ liveBlog: value });
    await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "fixture-preview", liveBlogVersion: 1 });
    const before = await current();
    const result = await preview.enqueuePreview(previewFields(), previewDeps());
    const queued = (await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data();
    expect(queued.snapshot.published.metadata.liveBlog.updates[0]).toMatchObject({ headline: "", credits: [], body: { type: "doc", content: [] } });
    expect(await current()).toEqual(before);
    expect(await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false })).toEqual({ kind: "not-found" });
    const refused = await transition("submit"); expect(refused.statusCode).toBe(400);
  });

  it("freezes only a private queue snapshot and requires the exact preview capability", async () => {
    const before = await current();
    await expect(preview.enqueuePreview(previewFields(), previewDeps())).rejects.toMatchObject({ status: 503 });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(0);
    const runtime = { schemaVersion: 1, phase: "ready", rendererSha: "b".repeat(40), serializerId: "fixture-preview", liveBlogVersion: 1 };
    await db.doc("system/cmsPreviewRuntime").set(runtime);
    await expect(preview.enqueuePreview(previewFields(), previewDeps())).rejects.toMatchObject({ status: 503 });
    await db.doc("system/cmsPreviewRuntime").set({ ...runtime, rendererSha: sha });
    const result = await preview.enqueuePreview(previewFields(), previewDeps());
    const queued = (await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data();
    expect(queued.snapshot.published.metadata.liveBlog.updates[0]).toMatchObject({ publishedAt: later, updatedAt: later });
    expect(await current()).toEqual(before);
    expect((await current()).published).toBeUndefined();
    expect(await reader.readPublishedPost({ firestore: db, slug: "coverage", now: new Date(later), includeChrome: false }))
      .toEqual({ kind: "not-found" });
  });

  it.each(["valid", "future-feed", "invalid-tags", "unsupported-renderer"])("checks the frozen live-blog build retry without using working drafts (%s)", async mode => {
    const document = await current();
    const frozen = await directory.freezeLiveBlogForPublish({ firestore: db, document, at: first });
    const metadata = { type: "post", title: document.title, slug: document.slug, previousSlugs: [], locale: "en",
      date: document.date, categories: [], tags: [], credits: document.credits, liveBlog: frozen };
    if (mode === "future-feed") frozen.updatedAt = later;
    if (mode === "invalid-tags") metadata.tags = "invalid";
    if (mode === "unsupported-renderer") await db.doc("system/publicDeployment/noBuildPosts/capability").update({ liveBlogVersion: admin.firestore.FieldValue.delete() });
    await db.doc("cmsPosts/post-one").update({ status: "published", publishBuildPending: true, publishBuildQueueId: null,
      liveBlog: { ...blog(), updates: [{ ...blog().updates[0], headline: "PRIVATE unfinished newer draft", body: { type: "doc", content: [] } }] },
      published: { metadata, blocks: [], sourceVersion: 3, publishedAt: first, publishedBy: actor.uid } });
    const before = await current();
    const run = scheduled.createScheduledPublishRunner({ firestore: db, now: () => later, log: quiet,
      assertPublishReadyFn: publisher.assertPublishReady,
      enqueuePublishFn: fields => publisher.enqueuePublishBuild(fields, { firestore: db }) });
    const result = await run(); const after = await current();
    expect(after.status).toBe("published"); expect(after.version).toBe(before.version);
    expect(after.published).toEqual(before.published); expect(after.liveBlog).toEqual(before.liveBlog);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
    if (mode === "valid") {
      expect(result.changes).toEqual([{ collection: "cmsPosts", id: "post-one", sourceVersion: 3 }]);
      expect(after.publishBuildQueueId).toBeTruthy();
      expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    } else {
      expect(result.changes).toEqual([]); expect(after.publishBuildQueueId).toBeNull();
      expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
    }
  });

  it("recovers publication after an atomic Firestore write failure without losing the approved draft", async () => {
    ok(await transition("submit")); ok(await transition("approve"));
    const before = await current();
    const historyCount = (await db.collection("cmsVersionHistory").get()).size;
    const faulty = new Proxy(db, { get(target, property) {
      if (property === "runTransaction") return run => target.runTransaction(tx => {
        const set = tx.set.bind(tx);
        tx.set = (ref, ...args) => {
          if (ref.path.startsWith("admin_logs/")) throw Object.assign(new Error("Synthetic write boundary failure"), { code: 14 });
          return set(ref, ...args);
        };
        return run(tx);
      }, { maxAttempts: 1 });
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const failed = await publish({ firestore: faulty });
    expect(failed.statusCode).toBe(500); expect(await current()).toEqual(before);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(historyCount);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
    ok(await publish());
    expect((await current()).published.metadata.liveBlog.updates[0].publishedAt).toBe(first);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
});

import { createRequire } from "node:module";
import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { interruptConfirmation } from "../helpers/interrupt-confirmation.js";
import { publicationTarget } from "../../functions/lib/publication-target.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import baseline from "../../functions/lib/cms-publication-baseline.js";
import artifactOwner from "../../functions/lib/cms-publish-artifact.js";
import serializer from "../../functions/lib/cms-publication-serializer.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import candidateStore from "../../functions/lib/public-worker-candidate-store.js";
import candidateContract from "../../functions/lib/public-worker-candidate.js";
import manifestContract from "../../functions/lib/public-media-manifest.js";
import manifestStore from "../../functions/lib/public-media-manifest-store.js";
import outcomeStore from "../../functions/lib/public-deployment-outcome-store.js";
import writeback from "../../functions/lib/cms-public-deployment-writeback.js";
import context from "../../functions/lib/public-context-revision.js";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { prepareStaticPostProof } from "../../site/scripts/upload-public-worker-candidate";
import * as uploadModule from "../../site/scripts/upload-public-worker-candidate";
import * as checkpointModule from "../../site/scripts/no-build-cloud-release";
import * as sourceModule from "../../site/scripts/cms-publication-runtime-guard";
import * as previewContextModule from "../../site/scripts/cms-preview-cloud-storage";
import * as inventoryModule from "../../site/src/lib/public-artifact-inventory";
import { sealPreparedCloudRelease } from "../../site/scripts/prepared-cloud-release";
import preparation from "../../functions/lib/public-release-preparation.js";
import promotion from "../../functions/lib/public-release-promotion.js";
import { app, db } from "../../functions/lib/firebase.js";
import { backgroundStorageFixture } from "./background-storage-fixture";
import backgroundOutputs from "../../functions/lib/post-background-outputs.js";
import backgroundStorage from "../../functions/lib/post-background-storage.js";
import admission from "../../functions/lib/no-build-post-admission.js";
import familyAdmission from "../../functions/lib/no-build-family-admission.js";
import publication from "../../functions/lib/no-build-post-publication.js";
import ownership from "../../functions/lib/no-build-post-ownership.js";
import recovery from "../../functions/lib/no-build-post-recovery.js";
import postAlerts from "../../functions/lib/post-background-alerts.js";
import confirmation from "../../functions/no-build-post-confirmation.js";
import deployment from "../../functions/lib/public-deployment.js";
import save from "../../functions/save.js";
import scheduledPublish from "../../functions/scheduled-publish.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import publicContent from "../../functions/public-content.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import flourishBlocks from "../../site/tests/fixtures/flourish-post-blocks.json";
import { readPublicContentStatus } from "../../admin/src/lib/public-content-status";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import { restorePublicWorkerPredecessor } from "../../site/scripts/reconcile-public-worker-deployment";
import baselineRecovery from "../../functions/lib/cms-publication-baseline-recovery.js";
import homeFallback from "../../functions/lib/no-build-home-withdrawal.js";
import getContent from "../../functions/get-content.js";
import { servePublicRequest } from "../../workers/src/public-worker";
import buildState from "../../functions/lib/publish-build-state.js";
import publishEndpoint from "../../functions/publish.js";
import bulkArchive from "../../functions/bulk-archive.js";
import retainedWithdrawal from "../../functions/lib/transitional-post-withdrawal.js";
import homeAdmission from "../../functions/lib/home-source-selection-admission.js";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import withdrawal from "../../functions/lib/no-build-post-withdrawal.js";

const purgeConfig = { zoneId: "f".repeat(32), token: "fixture-purge-token" };
const fetchPurge = async () => Response.json({ success: true });
const sha = "a".repeat(40);
// October 11 coordinator policy: expected warning copy is independent of the helper.
const expectedFirstHomeFailureWarning = "Removal is taking the slower path; the story stays on Home until the full build finishes";
const expectedHomeWithdrawalWarning = "Home may briefly show the previous card if the fast path is unavailable, until the full build finishes.";
const config = { enabled: true, postId: "pilot-post" };
const actor = { uid: "admin-fixture", email: "admin@example.test", principal: { id: "admin-fixture", grants: [{ role: "admin" }] } };
const quiet = { info() {}, warn() {}, error() {} };
const pointer = () => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
  activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
  lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
function post(version = 1, slug = "pilot-story") {
  return { id: config.postId, type: "post", title: "Private working title", status: "approved", section: "news",
    slug, previousSlugs: [], version, createdBy: actor.uid, tags: [], categories: [], credits: [], blocks: [] };
}
function leasedPointer() {
  const value = { ...pointer(), state: "deploying", leaseToken: "lease-fixture", lastReservedGeneration: 2,
    newestEligibleGeneration: 2, newestEligibleBuildBatchId: "release", leaseAcquiredAt: Timestamp.now(),
    candidateGeneration: 2, candidateBuildBatchId: "release", candidateCommitSha: "b".repeat(40),
    predecessorGeneration: 1, predecessorDeploymentId: pointer().activeDeploymentId, predecessorCommitSha: sha };
  deployment.assertPublicDeploymentPointer(value);
  return value;
}
function result() {
  return { code: 200, headersSent: false, headers: {}, status(code) { this.code = code; return this; },
    set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
}
async function invoke(handler, body) {
  const response = result();
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, response);
  return response;
}
function saveHandler(principal = actor) {
  return save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => principal,
    now: () => "2026-10-08T12:00:00.000Z", enablePublishSnapshot: true, noBuildConfig: config,
    assertPublishReadyFn: async () => ({ transport: "serializer" }), log: quiet });
}
async function publish() {
  return invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} });
}
async function savePublishedRevision(document) {
  const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
    noBuildConfig: config, now: () => "2026-10-11T19:00:00.000Z", log: quiet });
  expect((await invoke(transition, { collection: "cmsPosts", id: config.postId,
    baseVersion: (await current()).version, action: "revise" })).code).toBe(200);
  expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
    baseVersion: (await current()).version, document })).code).toBe(200);
}
const current = async () => (await db.doc(`cmsPosts/${config.postId}`).get()).data();
const state = async () => (await db.doc(publication.STATE_PATH).get()).data();
async function decision(path, method = "GET", probe) {
  const response = await invoke(publicContent.createCmsGetPublicPageHandler({ firestore: db, log: quiet }),
    { mode: "no-build-post-v1", path, rendererSha: sha, method, probe });
  if (response.code !== 200) throw new Error("Private read refused");
  return JSON.parse(JSON.stringify(response.body));
}
function worker(baseline = { buildBatchId: "baseline", generation: 1, routes: [{ path: "/about/", source: "site" }] }) {
  return createNoBuildPostWorker({ rendererSha: sha, cache: { async match() {}, async put() {} },
    getDecision: decision, render: async () => { throw new Error("Compiled rendering is checked by the retained renderer evidence"); },
    fetchAsset: async request => new Response(JSON.stringify(new URL(request.url).pathname === "/_content-status.json"
      ? { schemaVersion: 1, buildBatchId: baseline.buildBatchId, generation: baseline.generation, commitSha: sha,
          collections: ["cmsPages", "cmsPosts"], routes: baseline.routes }
      : { schemaVersion: 1, buildBatchId: baseline.buildBatchId, generation: baseline.generation, commitSha: sha }), { headers: { "content-type": "application/json" } }),
  });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator");
});
beforeEach(async () => {
  vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 1, revision: 1, enabled: true,
    postId: config.postId, backgroundBucket: "fixture-bucket" });
  await db.doc("system/publicDeployment").set(pointer());
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc(publication.STATE_PATH).set({ schemaVersion: 1, postId: config.postId, rendererSha: sha,
    servingEnabled: true, generation: 0, operationId: null, sourceVersion: null, slug: null, visible: false, ownedSlugs: [] });
  await db.doc(`cmsPosts/${config.postId}`).set(post());
  await db.doc("sections/news").set({ label: "News" });
});

describe("embed publication admission (#4994)", () => {
  const refusedBlocks = () => [{ id: "refused-chart", type: "html", visible: true, order: 0,
    data: { title: "Chart", html: '<script src="https://unapproved.example.test/embed.js?private=value"></script>' } }];
  const message = "Custom HTML plank 1 (Chart): Unreviewed script resource host: unapproved.example.test. Replace or remove the refused embed before publishing.";

  it("keeps metadata-only draft saves successful when retained HTML data is null", async () => {
    const blocks = [{ id: "legacy-html", type: "html", visible: true, order: 0, data: null }];
    for (const collection of ["cmsPosts", "cmsPages"]) {
      const id = collection === "cmsPosts" ? config.postId : "contact";
      const ref = db.doc(`${collection}/${id}`);
      await ref.set({ ...post(), id, status: "draft", blocks,
        ...(collection === "cmsPages" ? { type: "page", section: "contact" } : {}) });
      const response = await invoke(saveHandler(), { collection, id, baseVersion: 1,
        document: { title: "Updated title" } });
      expect(response.code, JSON.stringify(response.body)).toBe(200);
      expect(response.body.warnings).toContain("Custom HTML resources could not be checked. Reopen this content to verify them before publishing.");
      expect((await ref.get()).data()).toMatchObject({ title: "Updated title", version: 2, blocks });
      expect((await db.collection("cmsVersionHistory").where("documentId", "==", id).get()).size).toBe(1);
    }
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("saves a draft with guidance, but refuses metadata-only publish, schedule and approval atomically", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ status: "draft" });
    const saved = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 1,
      document: { status: "draft", blocks: refusedBlocks() } });
    expect(saved.code, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.warnings).toContain(message);
    await db.doc(`cmsPosts/${config.postId}`).update({ status: "approved" });
    const before = await current();
    for (const operation of [{ publish: true }, { scheduleAt: "2026-10-10T12:00:00.000Z" }]) {
      const response = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
        baseVersion: before.version, document: {}, ...operation });
      expect(response.code).toBe(400);
      expect(response.body.error).toBe(message);
      expect(await current()).toEqual(before);
    }
    await db.doc(`cmsPosts/${config.postId}`).update({ status: "in_review" });
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, log: quiet });
    const response = await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: before.version, action: "approve" });
    expect(response.code).toBe(400);
    expect(response.body.error).toBe(message);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await state()).generation).toBe(0);
  });

  it("refuses an already scheduled snapshot when its embed cannot render", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ status: "scheduled", blocks: refusedBlocks(),
      publishAt: "2026-10-10T12:00:00.000Z" });
    const run = scheduledPublish.createScheduledPublishRunner({ firestore: db, log: quiet,
      now: () => "2026-10-10T12:00:00.000Z", assertPublishReadyFn: async () => ({ transport: "serializer" }) });
    await run();
    expect(await current()).toMatchObject({ status: "draft", scheduledPublishFailure: { reason: message } });
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await state()).generation).toBe(0);
  });

  it("publishes the real three-chart post without rewriting its embed code", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ blocks: flourishBlocks });
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await current()).published.blocks).toEqual(flourishBlocks);
  });

  it("reports a refused published plank through queue failure and Boardwalk's publication response", async () => {
    await publish();
    // A snapshot published before admission existed, subsequently refused by the public renderer.
    await db.doc(`cmsPosts/${config.postId}`).update({ "published.blocks": refusedBlocks() });
    const owned = await state();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      operationId: owned.operationId, fetchPublic: async () => new Response("Not found", { status: 404 }) });
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.postProof).toMatchObject({ status: "failed", error: message });
    const endpoint = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const response = await invoke(endpoint, { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect(response.body.publication).toMatchObject({ postServingConfirmed: false, postProofStatus: "failed",
      postProofWarning: `The public page cannot be shown. ${message}` });
    expect(response.body.publication.postProofWarning).not.toContain("private=value");
  });
});

// Model an operation accepted before the cloud reservation cutoff through the
// retained reservation contract. Recovery tests must not depend on new admission.
async function seedRetainedCloudWithdrawal(operationId, { promote = true } = {}) {
  let legacyId;
  await db.runTransaction(async transaction => {
    const queueRef = db.doc(`cmsPublishQueue/${operationId}`);
    const queue = (await transaction.get(queueRef)).data();
    const prepared = await retainedWithdrawal.preparePostWithdrawalBuild({ firestore: db, transaction,
      actor, change: queue.changes[0], operationId, runtime: queue.backgroundRuntime,
      homeAffected: queue.homeAffected });
    legacyId = prepared.queueRef.id;
    transaction.create(prepared.queueRef, prepared.queue);
    transaction.create(prepared.auditRef, prepared.audit);
    transaction.update(queueRef, { homeFullBuild: prepared.receipt });
    transaction.update(db.doc(`cmsPosts/${config.postId}`), { publishBuildQueueId: legacyId });
  });
  if (promote) await retainedWithdrawal.enqueuePostWithdrawalBuild({ firestore: db, operationId });
  return legacyId;
}

describe("cloud Post withdrawal reservation cutoff", () => {
  const transition = () => lifecycle.createCmsTransitionContentHandler({ firestore: db,
    requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet });
  const cloud = { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" };
  async function setup() {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: "cloudflare", release: sha } });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready",
      commitSha: "c".repeat(40), serializerId: "node-compute-primary", cloud });
    expect((await publish()).code).toBe(200);
    await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  }
  const remove = () => invoke(transition(), { collection: "cmsPosts", id: config.postId,
    baseVersion: 2, action: "unpublish" });
  async function snapshot() {
    return { post: await current(), owner: await state(),
      context: (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data(),
      queues: (await db.collection("cmsPublishQueue").get()).docs.map(row => ({ id: row.id, ...row.data() })) };
  }
  it.each(["ready", "paused", "starting"])("removes a cloud Post with serializer disabled and primary %s without a safety job", async phase => {
    await setup();
    await db.doc("system/cmsPublicationRuntime").update({ phase });
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    const response = await remove();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication.homeFullBuildQueueId).toBeNull();
    const queueId = response.body.publication.queueId;
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()).toMatchObject({ transport: "post-no-build-v1",
      noBuildPost: { visible: false, sourceVersion: 2 }, withdrawalRevision: 1 });
    expect((await db.collection(`cmsPublishQueue/${queueId}/backgroundOutputs`).get()).size).toBe(6);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "github").get()).empty).toBe(true);
  });
  it("accepts cloud removal with primary paused and retains the same operation after a lost response", async () => {
    await setup();
    const response = await remove();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const id = response.body.publication.queueId;
    expect(response.body.publication.homeFullBuildQueueId).toBeNull();
    const queue = (await db.doc(`cmsPublishQueue/${id}`).get()).data();
    expect(queue.transport).toBe("post-no-build-v1");
    expect(queue.homeFullBuild).toBeUndefined();
    expect(queue.withdrawalRevision).toBe(1);
    expect(queue.noBuildPost).toMatchObject({ operationId: id, visible: false, sourceVersion: 2,
      ownedSlugs: ["pilot-story"] });
    expect((await current()).publishBuildQueueId).toBe(id);
    expect((await db.collection(`cmsPublishQueue/${id}/backgroundOutputs`).get()).size).toBe(6);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
    // A stale repeat is rejected; a fresh archive reuses the exact in-flight withdrawal.
    expect((await remove()).code).toBe(409);
    const repeat = await invoke(transition(), { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, action: "archive" });
    expect(repeat.code, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body.publication.queueId).toBe(id);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  });
  it.each(["billing", "media", "cloud paused", "cloud release", "cloud serializer", "active renderer"])(
    "refuses %s before cloud removal commits", async gate => {
      await setup();
      if (gate === "billing") await db.doc("system/billing").set({ disabled: true });
      if (gate === "media") await db.doc("cmsPages/about").set({ publiclyVisible: true, status: "published",
        publishAt: "2026-10-11T12:00:00.000Z", published: { sourceVersion: 1, publishedAt: "2026-10-11T12:00:00.000Z",
          metadata: { title: "About", heroBackgroundImage: "unready-media" }, blocks: [] } });
      if (gate === "cloud paused") await db.doc("system/cmsPublicationRuntime").update({ cloud: { ...cloud, phase: "paused" } });
      if (gate === "cloud release") await db.doc("system/cmsPublicationRuntime").update({ cloud: { ...cloud, commitSha: "b".repeat(40) } });
      if (gate === "cloud serializer") await db.doc("system/cmsPublicationRuntime").update({ cloud: { ...cloud, serializerId: "cloudflare-dev-publisher" } });
      if (gate === "active renderer") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
      const before = await snapshot();
      expect((await remove()).code).toBeGreaterThanOrEqual(400);
      expect(await snapshot()).toEqual(before);
    });
  it("keeps fresh cloud Home failure visible through exact output retry and verified immutable convergence", async () => {
    const home = { publiclyVisible: true, published: { sourceVersion: 1, metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } };
    await db.doc("cmsPages/home").set(home);
    await setup();
    const removal = await remove();
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const id = removal.body.publication.queueId;
    const warning = "Home removal is not confirmed. The previous card can remain visible until the Home update succeeds.";
    expect(removal.body.publication.homeFullBuildQueueId).toBeNull();
    expect(removal.body.publication.warnings).toContain(warning);
    const queueRef = db.doc(`cmsPublishQueue/${id}`);
    expect((await queueRef.get()).data().homeFullBuild).toBeUndefined();
    // Detail confirmation cannot clear the independent Home removal feedback.
    await buildState.settleBuildQueue(db, { queueId: id, status: "success", queueUpdate: { status: "success" } });
    const statusHandler = getContent.createCmsGetContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, log: quiet });
    const status = async () => (await invoke(statusHandler, { collection: "cmsPosts", id: config.postId,
      publicationOnly: true })).body.publication;
    expect(await status()).toMatchObject({ homeWarning: warning, publicUpdatePending: true, withdrawalBuildPending: true });
    const paths = { home: ["/", "/_home-sources.json"], listings: ["/posts/"], authors: ["/authors/fixture/"],
      feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"],
      search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
    let failHome = true;
    const artifacts = new Map();
    // Build output and immutable object storage are system boundaries. The real
    // consumer validates, persists, reads and serves their exact source receipts.
    const outputOwner = backgroundOutputs.createPostBackgroundOutputs({ firestore: db, enabled: true, accepting: false,
      postIds: [config.postId], contentApiEnabled: true, runtime: { owner: "cloudflare", release: sha },
      readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
      artifacts: { async put(key, bytes) { artifacts.set(key, bytes); }, async get(key) { return artifacts.get(key); } },
      build: async task => {
        if (task.output === "home" && failHome) throw new Error("Home builder unavailable");
        expect((await current()).publiclyVisible).toBe(false);
        const publication = { buildBatchId: `withdrawal-${task.revision}`, generation: task.revision, commitSha: sha };
        const catalog = homeAdmission.sealHomeCatalog({ schemaVersion: 1, cutoffAt: "2026-10-13T06:00:00Z",
          sources: Object.fromEntries(["home-featured", "home-more", "home-spotlight", "home-posts"].map(section =>
            [section, { status: "ready", checkedAt: "2026-10-13T06:00:00Z", cards: [] }])) }, publication);
        return { input: { kind: "public-background", rendererSha: sha, contextDigest: task.contextDigest, routes: [] },
          files: paths[task.output].map(path => ({ path, contentType: path.endsWith(".json") ? "application/json" : "text/html",
            bytes: path === "/_home-sources.json" ? JSON.stringify({ schemaVersion: 1, publication, editorial: catalog,
              pbs: { source: "manual", checkedAt: "2026-10-13T06:00:00Z", featured: [], more: [] },
              spotlight: { source: "spotlight-rss", checkedAt: "2026-10-13T06:00:00Z", cards: [] } })
              : "Verified family: No withdrawn story" })) };
      } });
    await outputOwner.recover();
    expect(await status()).toMatchObject({ queueStatus: "failed", homeWarning: warning,
      publicUpdatePending: true, withdrawalBuildPending: true, publicBuildQueueId: id });
    const unavailableHome = await outputOwner.serve(new Request("https://njpbs.org/"));
    expect(unavailableHome.status).toBe(503);
    expect(unavailableHome.headers.get("cache-control")).toBe("no-store");
    const staleHome = await servePublicRequest(new Request("https://njpbs.org/"), {
      noBuildPosts: worker(), fetchAsset: async () => new Response("Old Home with withdrawn Post"),
      getPublishedPage: async () => { throw new Error("Unexpected dynamic Home"); },
    });
    expect(staleHome.status).toBe(200);
    expect(await staleHome.text()).toBe("Old Home with withdrawn Post");
    expect((await db.doc(`cmsPublishQueue/${id}/backgroundOutputs/home`).get()).data().status).toBe("failed");
    const retry = publishEndpoint.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const retried = await invoke(retry, { retry: true, baseVersion: (await current()).version,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] });
    expect(retried.code, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.queueId).toBe(id);
    expect((await db.doc(`cmsPublishQueue/${id}/backgroundOutputs/home`).get()).data())
      .toMatchObject({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
    expect((await status()).homeWarning).toBe(warning);
    failHome = false;
    await outputOwner.recover();
    const served = await outputOwner.serve(new Request("https://njpbs.org/"));
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("Verified family: No withdrawn story");
    const source = await (await outputOwner.serve(new Request("https://njpbs.org/_home-sources.json"))).json();
    expect(Object.values(source.editorial.catalog.sources).flatMap(section => section.cards)).toEqual([]);
    const homeState = (await db.doc("cmsBackgroundOutputs/home").get()).data();
    expect(homeState.status).toBe("verified");
    expect(homeState.receipt.homeSourceReceipt).toEqual(source.editorial.receipt);
    expect(homeState.receipt.withdrawalRevision).toBe(1);
    expect((await db.doc(`cmsHomeSourceCatalogs/${source.editorial.receipt.buildBatchId}`).get()).data()).toEqual(source.editorial);
    expect(await status()).toMatchObject({ queueStatus: "success", publicUpdatePending: false, publicBuildQueueId: null });
    expect((await status()).homeWarning).toBeUndefined();
    expect((await status()).withdrawalBuildPending).toBeUndefined();
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(home);
  });
  async function withdrawalStatus() {
    const handler = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const response = await invoke(handler, { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    return response.body.publication;
  }
  async function verifyWithdrawalFamilies(id, except = []) {
    const tasks = await db.collection(`cmsPublishQueue/${id}/backgroundOutputs`).get();
    for (const row of tasks.docs.filter(row => !except.includes(row.id))) {
      const task = row.data();
      await row.ref.update({ status: "verified", receipt: { revision: task.revision,
        digest: "d".repeat(64), withdrawalRevision: 1 } });
    }
  }
  async function pageOwnedWithdrawal(exceptFamilies = []) {
    const home = { publiclyVisible: true, published: { sourceVersion: 1, metadata: { template: "home", homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } };
    await db.doc("cmsPages/home").set(home);
    const homeOperationId = "H".repeat(20);
    const owner = { schemaVersion: 1, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
      operationId: homeOperationId, sourceVersion: 1, generation: 1, rendererSha: sha, servingEnabled: true,
      visible: true, snapshotDigest: pageOwnership.digest(home.published), runtime: { owner: "cloudflare", release: sha } };
    await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).set(owner);
    await db.doc(homeOwner.HOME_BACKGROUND_PATH).set({ schemaVersion: 1, owner: "page-no-build-v1", output: "home",
      pageId: "home", ownerPath: homeOwner.HOME_PAGE_OWNER_PATH, operationId: homeOperationId });
    await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1 });
    await setup();
    const removal = await remove();
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const id = removal.body.publication.queueId;
    expect(removal.body.publication.homeFullBuildQueueId).toBeNull();
    expect((await db.doc(`cmsPublishQueue/${id}/backgroundOutputs/home`).get()).exists).toBe(false);
    await buildState.settleBuildQueue(db, { queueId: id, status: "success", queueUpdate: { status: "success" } });
    await verifyWithdrawalFamilies(id, exceptFamilies);
    const taskRef = db.doc(`cmsPublishQueue/${id}/homePageRefresh/home`);
    return { home, homeOperationId, owner, id, taskRef };
  }
  it("retries Page-owned Home and clears withdrawal feedback only after both Home routes are proved", async () => {
    const { homeOperationId, owner, id, taskRef } = await pageOwnedWithdrawal();
    const before = (await taskRef.get()).data();
    await taskRef.update({ status: "failed", attempts: 4, nextAttemptAt: null, claim: "uncertain" });
    expect(await withdrawalStatus()).toMatchObject({ publicUpdatePending: true, queueStatus: "failed",
      homeWarning: "Home removal is not confirmed. The previous card can remain visible until the Home update succeeds." });
    await db.doc("system/publicDeployment").set(leasedPointer());
    expect(await withdrawalStatus()).toMatchObject({ publicUpdatePending: true,
      homeWarning: "Home removal is not confirmed. The previous card can remain visible until the Home update succeeds." });
    await db.doc("system/publicDeployment").set(pointer());
    const retry = publishEndpoint.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const retryRemoval = async () => invoke(retry, { retry: true, baseVersion: (await current()).version,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] });
    expect((await retryRemoval()).code).toBe(200);
    expect((await taskRef.get()).data()).toMatchObject({ status: "failed", claim: "uncertain" });
    await taskRef.update({ claim: null });
    expect((await retryRemoval()).code).toBe(200);
    expect((await taskRef.get()).data()).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 0,
      revision: before.revision, input: before.input });
    const refresh = (await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).get()).data().homeRefresh;
    const receipt = { operationId: homeOperationId, sourceVersion: 1, snapshotDigest: owner.snapshotDigest,
      visible: true, rendererSha: sha, contextDigest: await db.runTransaction(transaction => context.readPublicContextInTransaction(transaction, db), { readOnly: true }),
      admissionRevision: 1, homeRefreshRevision: refresh.revision,
      routes: [{ path: "/", status: 200, htmlDigest: "e".repeat(64) }] };
    await taskRef.update({ status: "verified", publicReceipt: receipt });
    await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).update({ "homeRefresh.status": "verified" });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    await taskRef.update({ "publicReceipt.routes": [...receipt.routes,
      { path: "/_home-sources.json", status: 200, htmlDigest: "f".repeat(64) }] });
    await taskRef.update({ "publicReceipt.contextDigest": "0".repeat(64) });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    await taskRef.update({ "publicReceipt.contextDigest": receipt.contextDigest });
    expect(await withdrawalStatus()).toMatchObject({ publicUpdatePending: false, publicBuildQueueId: null });
    expect((await withdrawalStatus()).homeWarning).toBeUndefined();
    await withdrawal.settlePostWithdrawalOutputs({ firestore: db, operationId: id });
    expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().withdrawalOutputsReceipt.outputs.home.digest).toMatch(/^[a-f0-9]{64}$/);
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: FieldValue.increment(1) });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
  });
  async function verifyPageRemoval({ owner, taskRef }) {
    const refresh = (await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).get()).data().homeRefresh;
    const receipt = { operationId: owner.operationId, sourceVersion: owner.sourceVersion, snapshotDigest: owner.snapshotDigest,
      visible: true, rendererSha: sha,
      contextDigest: await db.runTransaction(transaction => context.readPublicContextInTransaction(transaction, db), { readOnly: true }),
      admissionRevision: 1, homeRefreshRevision: refresh.revision,
      routes: [{ path: "/", status: 200, htmlDigest: "e".repeat(64) },
        { path: "/_home-sources.json", status: 200, htmlDigest: "f".repeat(64) }] };
    await taskRef.update({ status: "verified", claim: null, publicReceipt: receipt, completedAt: Timestamp.now() });
    await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).update({ "homeRefresh.status": "verified" });
    return receipt;
  }
  it("keeps a verified Page Home removal across unrelated context changes before other families finish", async () => {
    const fixture = await pageOwnedWithdrawal(["search"]);
    await verifyPageRemoval(fixture);
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    expect((await withdrawalStatus()).homeWarning).toBeUndefined();
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: FieldValue.increment(1) });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    expect((await withdrawalStatus()).homeWarning).toBeUndefined();
    expect((await db.doc(`cmsPublishQueue/${fixture.id}`).get()).data().withdrawalOutputsReceipt).toBeUndefined();
    await verifyWithdrawalFamilies(fixture.id);
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
  });
  it("requires a new paired Home proof when the Home owner and published source change", async () => {
    const fixture = await pageOwnedWithdrawal();
    const receipt = await verifyPageRemoval(fixture);
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
    const refresh = (await db.doc(homeOwner.HOME_PAGE_OWNER_PATH).get()).data().homeRefresh;
    const nextHome = { ...fixture.home, published: { ...fixture.home.published, sourceVersion: 2,
      metadata: { ...fixture.home.published.metadata, title: "Updated public Home" } } };
    const nextOwner = { ...fixture.owner, operationId: "N".repeat(20), sourceVersion: 2, generation: 2,
      snapshotDigest: pageOwnership.digest(nextHome.published) };
    await db.runTransaction(async transaction => {
      const plan = await homeOwner.prepareHomePlanInTransaction({ firestore: db, transaction,
        nextDocument: nextHome, operation: nextOwner, runtime: nextOwner.runtime });
      transaction.set(db.doc(homeOwner.HOME_PAGE_OWNER_PATH), { ...nextOwner, homeRefresh: refresh });
      transaction.set(db.doc("cmsPages/home"), nextHome);
      plan.write();
    });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    const nextContext = await db.runTransaction(transaction => context.readPublicContextInTransaction(transaction, db), { readOnly: true });
    await db.doc(`cmsPublishQueue/${nextOwner.operationId}`).set({ transport: "page-no-build-v1", status: "success",
      publicReceipt: { ...receipt, operationId: nextOwner.operationId, sourceVersion: 2, snapshotDigest: nextOwner.snapshotDigest,
        contextDigest: nextContext } });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
  });
  it("refuses cloud admission-only safety work during a primary handoff without committing any removal writes", async () => {
    await setup();
    await db.doc("cmsBackgroundOutputs/listings").update({ schemaVersion: 2 });
    const before = await snapshot();
    const removal = await remove();
    expect(removal.code, JSON.stringify(removal.body)).toBe(503);
    expect(removal.body.error).toContain("paused");
    expect(await snapshot()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
  });
  it("retains a retryable safety reservation when background admission cannot create family tasks", async () => {
    await setup();
    await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
    await db.doc("cmsBackgroundOutputs/listings").update({ schemaVersion: 2 });
    const removal = await remove();
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const id = removal.body.publication.queueId;
    const safetyId = removal.body.publication.homeFullBuildQueueId;
    expect(safetyId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect((await db.collection(`cmsPublishQueue/${id}/backgroundOutputs`).get()).docs.map(row => row.id)).toEqual(["_admission"]);
    expect((await db.doc(`cmsPublishQueue/${id}/backgroundOutputs/_admission`).get()).data().status).toBe("failed");
    expect((await db.doc(`cmsPublishQueue/${safetyId}`).get()).data()).toMatchObject({ transport: "serializer",
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }],
      homeFullBuild: { sourceOperationId: id } });
    expect((await current()).publishBuildQueueId).toBe(safetyId);
    await db.doc(`cmsPublishQueue/${safetyId}`).update({ status: "failed", error: "fixture failure" });
    const retry = publishEndpoint.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const retried = await invoke(retry, { retry: true, baseVersion: (await current()).version,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] });
    expect(retried.code, JSON.stringify(retried.body)).toBe(200);
    const recovered = (await db.doc(`cmsPublishQueue/${id}`).get()).data().homeFullBuild;
    expect(recovered.sourceOperationId).toBe(id);
    expect(recovered.queueId).not.toBe(safetyId);
    expect((await db.doc(`cmsPublishQueue/${recovered.queueId}`).get()).data().status).toBe("pending");
    await buildState.settleBuildQueue(db, { queueId: id, status: "success", queueUpdate: { status: "success" } });
    await buildState.settleBuildQueue(db, { queueId: recovered.queueId, status: "success", queueUpdate: { status: "success" } });
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
  });
  it("tracks catalog-only Home work without warning about a card that was never placed", async () => {
    await setup();
    // The retained Home family keeps its catalog current without a Post placement.
    const publishedId = (await state()).operationId;
    const taskPath = `cmsPublishQueue/${publishedId}/backgroundOutputs/home`;
    await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 1, status: "pending" });
    await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 1,
      taskPath, status: "pending", runtime: { owner: "cloudflare", release: sha } });
    const removal = await remove();
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const id = removal.body.publication.queueId;
    expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().homeAffected).toBe(false);
    await buildState.settleBuildQueue(db, { queueId: id, status: "success", queueUpdate: { status: "success" } });
    await verifyWithdrawalFamilies(id, ["home"]);
    expect((await withdrawalStatus()).publicUpdatePending).toBe(true);
    expect((await withdrawalStatus()).homeWarning).toBeUndefined();
    await verifyWithdrawalFamilies(id);
    expect((await withdrawalStatus()).publicUpdatePending).toBe(false);
  });
  it("keeps node-compute-owned withdrawal behind the primary phase gate", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused",
      commitSha: sha, serializerId: "node-compute-primary", cloud });
    const before = await snapshot();
    expect((await remove()).code).toBeGreaterThanOrEqual(400);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["reserved", "pending"])("preserves accepted cloud safety %s identity during republish", async status => {
    await setup();
    const removal = await remove();
    expect(removal.code).toBe(200);
    // This fixture models a pre-cutoff operation, not fresh safety admission.
    await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
    const originalId = removal.body.publication.queueId;
    const legacyId = await seedRetainedCloudWithdrawal(originalId, { promote: status === "pending" });
    const republished = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, publish: true, document: {} });
    expect(republished.code, JSON.stringify(republished.body)).toBe(200);
    expect((await db.doc(`cmsPublishQueue/${legacyId}`).get()).data().status)
      .toBe(status === "reserved" ? "superseded" : "pending");
    expect((await db.doc(`cmsPublishQueue/${originalId}`).get()).data().status).toBe("cancelled");
    expect((await state()).operationId).toBe(republished.body.publication.queueId);
    expect((await current()).publishBuildQueueId).toBe(republished.body.publication.queueId);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
  });
  it("keeps bulk cloud acceptance and legacy refusal independent while primary is paused", async () => {
    await setup();
    await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin" });
    const legacy = { ...(await current()), id: "legacy-post", slug: "legacy-story" };
    legacy.published = { ...legacy.published, metadata: { ...legacy.published.metadata, slug: "legacy-story" } };
    await db.doc("cmsPosts/legacy-post").set(legacy);
    await db.doc("cmsPosts/already").set({ ...post(), id: "already", status: "archived" });
    await db.doc("cmsPosts/stale").set({ ...post(), id: "stale", version: 3 });
    const response = await invoke(bulkArchive.createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => actor, noBuildConfig: config, log: quiet }),
    { items: [{ id: config.postId, baseVersion: 2 }, { id: "legacy-post", baseVersion: 2 },
      { id: "already", baseVersion: 1 }, { id: "stale", baseVersion: 1 }, { id: "missing", baseVersion: 1 }] });
    expect(response.code).toBe(200);
    expect(response.body.outcomes.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: config.postId, status: "archived" }, { id: "legacy-post", status: "failed" },
      { id: "already", status: "already_archived" }, { id: "stale", status: "conflict" }, { id: "missing", status: "missing" }]);
    expect(response.body.outcomes[0].publication.homeFullBuildQueueId).toBeNull();
    expect((await current()).publishBuildQueueId).toBe(response.body.outcomes[0].publication.queueId);
    expect((await db.doc("cmsPosts/legacy-post").get()).data()).toEqual(legacy);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).empty).toBe(true);
  });
});

describe("one-Post acceptance, ownership and public receipt contracts", () => {
  it.each(["reservation", "promotion", "retry"].flatMap(stage =>
    ["billing", "transport", "media"].map(gate => ({ stage, gate }))))(
    "keeps normal publication gates at Home withdrawal $stage ($gate)", async ({ stage, gate }) => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet });
    let operationId;
    if (stage === "promotion") {
      const originalRef = db.collection("cmsPublishQueue").doc();
      await db.runTransaction(async transaction => {
        const postRef = db.doc(`cmsPosts/${config.postId}`);
        const nextDocument = { ...(await transaction.get(postRef)).data(), publiclyVisible: false };
        const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
          collection: "cmsPosts", documentId: config.postId, nextDocument,
          queueRef: originalRef, actor, config });
        prepared.write();
        transaction.set(postRef, { ...nextDocument, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
      });
      operationId = originalRef.id;
    } else if (stage === "retry") {
      const removal = await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
      expect(removal.code).toBe(200);
      operationId = removal.body.publication.queueId;
      await buildState.settleBuildQueue(db, { queueId: removal.body.publication.homeFullBuildQueueId,
        status: "failed", queueUpdate: { status: "failed", error: "Fixture failure" } });
    }
    if (gate === "billing") await db.doc("system/billing").set({ disabled: true });
    if (gate === "transport") vi.stubEnv("CMS_PUBLISH_TRANSPORT", "invalid");
    if (gate === "media") await db.doc("cmsPages/about").set({ publiclyVisible: true, status: "published",
      publishAt: "2026-10-11T12:00:00.000Z", published: { sourceVersion: 1, publishedAt: "2026-10-11T12:00:00.000Z",
        metadata: { title: "About", heroBackgroundImage: "unready-media" }, blocks: [] } });
    const beforePost = await current();
    const beforeState = await state();
    const beforeQueues = (await db.collection("cmsPublishQueue").get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
    if (stage === "promotion") {
      await expect(homeFallback.enqueueHomeWithdrawalBuild({ firestore: db, operationId })).rejects.toThrow();
      expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().homeFullBuildError)
        .toBe("home_withdrawal_full_build_enqueue_failed");
    } else {
      const response = stage === "reservation"
        ? await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" })
        : await invoke(publishEndpoint.createCmsPublishHandler({ firestore: db,
          requirePrincipalFn: async () => actor, log: quiet }), { retry: true, baseVersion: beforePost.version,
          changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] });
      expect(response.code, JSON.stringify(response.body)).not.toBe(200);
    }
    expect(await current()).toEqual(beforePost);
    expect(await state()).toEqual(beforeState);
    const afterQueues = (await db.collection("cmsPublishQueue").get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
    expect(afterQueues.map(({ homeFullBuildError, ...queue }) => queue)).toEqual(beforeQueues);
  });
  it.each([
    { phase: "paused", commitSha: sha, serializerId: "cloudflare-publisher" },
    { phase: "starting", commitSha: sha, serializerId: "cloudflare-publisher" },
    { phase: "ready", commitSha: "b".repeat(40), serializerId: "cloudflare-publisher" },
    { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" },
  ])("refuses a new cloud-owned Post before snapshot acceptance for mismatched control %j", async cloud => {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: "cloudflare", release: sha } });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready",
      commitSha: "c".repeat(40), serializerId: "node-compute-primary", cloud });
    expect((await publish()).code).toBe(503);
    expect((await current()).published).toBeUndefined();
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(1);
  });
  it.each(["ready", "paused", "starting"])("admits a matching ready cloud Post with the primary publisher %s", async phase => {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: "cloudflare", release: sha } });
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase, commitSha: "c".repeat(40),
      serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    expect((await publish()).code).toBe(200);
    const owned = await state();
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data().backgroundRuntime)
      .toEqual({ owner: "cloudflare", release: sha });
  });
  it("keeps a retained node-compute Post closed while its primary publisher is paused", async () => {
    await publish();
    const retained = await ownership.readNoBuildPostOwner({ firestore: db, postId: config.postId });
    await retained.ref.update({ runtime: { owner: "node-compute", release: sha } });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused", commitSha: sha,
      serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    const before = await current();
    const next = { ...before, version: before.version + 1,
      published: { ...before.published, sourceVersion: before.version + 1 } };
    await expect(db.runTransaction(transaction => publication.prepareNoBuildPostPublication({ firestore: db, transaction,
      collection: "cmsPosts", documentId: config.postId, nextDocument: next,
      queueRef: db.collection("cmsPublishQueue").doc(), actor, config }))).rejects.toThrow("paused for a serializer handoff");
    expect(await current()).toEqual(before);
  });
  it.each(["ready", "paused", "starting"])("publishes a cloud Post with serializer disabled and primary %s", async phase => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: "cloudflare", release: sha } });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase, commitSha: "c".repeat(40),
      serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    expect((await publish()).code).toBe(200);
    expect((await db.collection("cmsPublishQueue").get()).docs.map(row => row.data().transport)).toEqual(["post-no-build-v1"]);
  });
  it.each(["paused", "disabled"].map(mode => ({ owner: "node-compute", mode })))("keeps $owner withdrawals requiring a safety build behind $mode admission", async ({ owner, mode }) => {
    if (owner === "cloudflare") {
      await db.doc(publication.STATE_PATH).update({ runtime: { owner, release: sha } });
      await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
        serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    }
    expect((await publish()).code).toBe(200);
    const beforePost = await current(), beforeState = await state();
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: mode === "paused" ? "paused" : "ready",
      commitSha: sha, serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    if (mode === "disabled") await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, log: quiet });
    const response = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(response.code).toBe(mode === "paused" ? 503 : 409);
    expect(await current()).toEqual(beforePost);
    expect(await state()).toEqual(beforeState);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("does not accept a new cloud withdrawal after its renderer leaves the active release", async () => {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: "cloudflare", release: sha } });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: "c".repeat(40),
      serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    expect((await publish()).code).toBe(200);
    const accepted = await state();
    const original = (await db.doc(`cmsPublishQueue/${accepted.operationId}`).get()).data();
    await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
    const refused = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(refused.code).toBe(503);
    expect(refused.body.error).toContain("Try this removal again shortly");
    expect(await state()).toEqual(accepted);
    expect((await db.doc(`cmsPublishQueue/${accepted.operationId}`).get()).data()).toEqual(original);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("leaves emulator queues to the explicitly driven confirmation owner", async () => {
    await publish();
    const owned = await state();
    vi.stubEnv("FUNCTIONS_EMULATOR", "true");
    const queueRef = db.doc(`cmsPublishQueue/${owned.operationId}`);
    const before = (await queueRef.get()).data();
    await confirmation.onNoBuildPostConfirmation.run({ params: { queueId: owned.operationId },
      data: { after: await queueRef.get() } });
    await confirmation.onNoBuildPostConfirmationRecovery.run({});
    expect((await queueRef.get()).data()).toEqual(before);
  });
  it.each([["without appearance", undefined], ["with appearance", { playful: true }]])(
    "seals a short-pause v3 candidate %s before startup and refuses missing or downgraded markers", async (_label, presentation) => {
    const liveBlogCompatibility = await import("../../functions/lib/live-blog-compatibility.js").then(module => module.default);
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested reporting." }] }] };
    const credits = [{ kind: "custom", name: "Newsroom" }];
    await db.doc(ownership.CAPABILITY_PATH).set({ schemaVersion: 1, postId: config.postId, rendererSha: sha,
      servingEnabled: true, generation: 1, liveBlogVersion: 1 });
    const installedMarker = db.doc(`${liveBlogCompatibility.LIVE_BLOG_CONTRACTS}/${sha}`);
    await installedMarker.set({ schemaVersion: 1, rendererSha: sha, liveBlogContractVersion: 3 });
    await db.doc(`cmsPosts/${config.postId}`).update({ liveBlog: { schemaVersion: 1, coverageState: "ongoing", ...(presentation ? { presentation } : {}), updates: [{
      id: "entry", headline: "Report", body, credits, keyUpdate: false, followUps: [{ id: "follow", body, credits }],
    }] } });
    const response = await publish(); expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await publication.readNoBuildPostDecision({ firestore: db, path: "/posts/pilot-story/", rendererSha: sha })).kind).toBe("post");
    await installedMarker.update({ liveBlogContractVersion: 2 });
    await expect(publication.readNoBuildPostDecision({ firestore: db, path: "/posts/pilot-story/", rendererSha: sha })).rejects.toMatchObject({ status: 409 });
    await installedMarker.update({ liveBlogContractVersion: 3 });
    const candidateSha = "b".repeat(40), candidate = { commitSha: candidateSha, generation: 2, noBuildPost: {
      schemaVersion: 1, postId: config.postId, rendererSha: candidateSha, enabled: true, authoritative: true, liveBlogVersion: 1,
    } };
    const marker = db.doc(`${liveBlogCompatibility.LIVE_BLOG_CONTRACTS}/${candidateSha}`);
    const check = () => db.runTransaction(transaction => publication.assertNoBuildCandidateInTransaction({ firestore: db, transaction, candidate }));
    // OLD's marker cannot attest a new SHA, and v2 cannot preserve follow-ups.
    expect((await marker.get()).exists).toBe(false);
    await expect(check()).rejects.toMatchObject({ status: 409 });
    await marker.set({ schemaVersion: 1, rendererSha: candidateSha, liveBlogContractVersion: 2 });
    await expect(check()).rejects.toMatchObject({ status: 409 });
    await marker.delete();

    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
      serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    const preparationId = "Release0000000000001";
    const reservation = await preparation.preparePublicRelease({ firestore: db, preparationId, commitSha: candidateSha, oldCommitSha: sha });
    const mediaManifest = manifestContract.createPublicMediaManifest({ reservation, owners: [],
      artifactInventory: ["cmsPages", "cmsPosts", "cmsSettings", "cmsAuthorProfilesPublic"]
        .map(collection => ({ collection, complete: true, documentIds: [] })) });
    const fullCandidate = { ...candidate, schemaVersion: 1, runtime: { owner: "cloudflare", release: candidateSha },
      buildBatchId: reservation.buildBatchId, generation: reservation.generation, workerName: "njpbs-production",
      workerVersionId: "22222222-2222-4222-8222-222222222222", versionCreatedOn: "2026-10-30T12:00:00.000Z",
      artifactDigest: "a".repeat(64), artifactReceiptDigest: "b".repeat(64), publicationReceiptDigest: "c".repeat(64),
      mediaManifestDigest: mediaManifest.mediaManifestDigest, artifactFileCount: 2, artifactBytes: 100, wranglerVersion: "4.76.0" };
    fullCandidate.workerVersionTag = candidateContract.publicWorkerCandidateTag(fullCandidate);
    const prepared = promotion.preparedArtifactFromCandidate(fullCandidate);
    const inputBytes = Buffer.from("frozen candidate input");
    const sealInput = { firestore: db, preparationId, commitSha: candidateSha,
      inputSha256: createHash("sha256").update(inputBytes).digest("hex"), artifactCheckpointDigest: "d".repeat(64),
      preparedArtifact: prepared, mediaManifest };
    await preparation.recordPreparedPublicReleaseCheckpoint(sealInput);
    await preparation.recordPreparedPublicWorkerCandidate({ firestore: db, preparationId, candidate: fullCandidate });
    await db.doc(`cmsPreviewPublicContexts/${reservation.buildBatchId}`).set({ schemaVersion: 1,
      buildBatchId: reservation.buildBatchId, artifactReceiptDigest: fullCandidate.artifactReceiptDigest, sha256: "e".repeat(64),
      byteLength: 100, key: `public-context/${reservation.buildBatchId}/${"e".repeat(64)}.json` });
    // The real seal refuses before the producer has attested NEW.
    await expect(promotion.sealPreparedPublicRelease(sealInput)).rejects.toThrow("does not preserve published live blogs");
    const before = await Promise.all([ownership.CAPABILITY_PATH, "system/publicDeployment", "system/cmsPublicationRuntime"]
      .map(name => db.doc(name).get().then(row => row.data())));
    const directory = await mkdtemp(path.join(tmpdir(), "live-blog-seal-"));
    returnDirectories.push(directory);
    const releaseDirectory = path.join(directory, "releases", preparationId);
    await mkdir(releaseDirectory, { recursive: true });
    await writeFile(path.join(releaseDirectory, "artifact-inventory.json"), "{}");
    // Only source/artifact/provider IO is stubbed. The producer, marker writer,
    // real Firestore transaction, seal and published-owner checks run unchanged.
    const spies = [
      vi.spyOn(sourceModule, "assertCmsPublicationSourceCheckout").mockResolvedValue(),
      vi.spyOn(checkpointModule, "checkpointNoBuildCloudRelease").mockResolvedValue({ prepared, artifactCheckpointDigest: sealInput.artifactCheckpointDigest }),
      vi.spyOn(uploadModule, "restoreDetachedReleaseUploadPaths").mockResolvedValue(path.join(releaseDirectory, "dist")),
      vi.spyOn(uploadModule, "uploadPublicWorkerCandidate").mockResolvedValue(fullCandidate),
      vi.spyOn(uploadModule, "manifestFromArtifact").mockReturnValue(mediaManifest),
      vi.spyOn(inventoryModule, "assertPublicArtifactInventoryReceipt").mockReturnValue({}),
      vi.spyOn(previewContextModule, "retainCloudPreviewPublicContext").mockResolvedValue(),
    ];
    try {
      const produce = () => sealPreparedCloudRelease({ firestore: db, queueId: preparationId, commitSha: candidateSha,
        stateDirectory: directory, storage: { readInput: async () => inputBytes, restoreArtifact: async () => true },
        cloudflareApiToken: "fixture", previewStorageCredential: {} });
      spies[0].mockRejectedValueOnce(new Error("Wrong source"));
      await expect(produce()).rejects.toThrow("Wrong source");
      expect((await marker.get()).exists).toBe(false);
      spies[3].mockRejectedValueOnce(new Error("Provider verification failed"));
      await expect(produce()).rejects.toThrow("Provider verification failed");
      expect((await marker.get()).exists).toBe(false);
      const result = await produce();
      expect(result.status).toBe("sealed");
      expect(spies[0].mock.calls).toEqual([[candidateSha], [candidateSha], [candidateSha]]);
      expect((await marker.get()).data()).toEqual({ schemaVersion: 1, rendererSha: candidateSha, liveBlogContractVersion: 3 });
      expect((await db.doc(`system/publicReleasePreparations/entries/${preparationId}/proofs/complete`).get()).exists).toBe(true);
      expect(await Promise.all([ownership.CAPABILITY_PATH, "system/publicDeployment", "system/cmsPublicationRuntime"]
        .map(name => db.doc(name).get().then(row => row.data())))).toEqual(before);
      expect((await check()).owners).toHaveLength(1);
      // Rollback remains fail-closed even after NEW has a valid marker.
      const rollback = { ...candidate, commitSha: "c".repeat(40), noBuildPost: { ...candidate.noBuildPost, rendererSha: "c".repeat(40) } };
      await expect(db.runTransaction(transaction => publication.assertNoBuildCandidateInTransaction({ firestore: db, transaction, candidate: rollback })))
        .rejects.toMatchObject({ status: 409 });
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it("commits published content, history, audit, queue and background fences together", async () => {
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication.transport).toBe("post-no-build-v1");
    const document = await current();
    const owned = await state();
    expect(document.published.sourceVersion).toBe(2);
    expect(document.publishBuildQueueId).toBe(owned.operationId);
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data().transport).toBe("post-no-build-v1");
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(2);
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data().status).toBe("pending");
    expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(1);
  });
  it("removes later-release snapshot seals when republishing a nonfigure Post", async () => {
    expect((await publish()).code).toBe(200);
    const document = await current();
    const datasetFigures = { figures: [], releases: [] };
    const sealedSnapshot = { ...document.published, datasetFigures };
    await db.doc(`cmsPosts/${config.postId}`).update({ published: sealedSnapshot });
    await db.doc(publication.STATE_PATH).update({ snapshotDigest: pageOwnership.digest(sealedSnapshot),
      datasetFiguresDigest: pageOwnership.digest(datasetFigures) });

    await savePublishedRevision({ title: "Nonfigure revision after rollback" });
    const result = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, publish: true, document: {} });

    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect(await state()).not.toHaveProperty("snapshotDigest");
    expect(await state()).not.toHaveProperty("datasetFiguresDigest");
    expect((await decision("/posts/pilot-story/")).kind).toBe("post");
  });
  it("denies unauthorized publish without a snapshot or operation", async () => {
    const editor = { ...actor, principal: { id: "writer", grants: [{ role: "writer" }] } };
    expect((await invoke(saveHandler(editor), { collection: "cmsPosts", id: config.postId, baseVersion: 1,
      publish: true, document: {} })).code).toBe(403);
    expect((await current()).published).toBeUndefined();
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  });
  it("keeps an ordinary draft save outside public context and queue state", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ status: "draft" });
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 1,
      document: { title: "A private revision" } })).code).toBe(200);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(1);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
  });
  it("admits a category-selected Home hero and queues Home in that publication", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ categories: ["News"] });
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { sourceVersion: 1,
      publishedAt: "2026-10-08T12:00:00.000Z", metadata: { title: "Home", homeHero: {
      mode: "category", source: "cms_posts", value: "News" } }, blocks: [] } });
    const homeBefore = (await db.doc("cmsPages/home").get()).data();
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication.transport).toBe("post-no-build-v1");
    expect(response.body.publication.affectedHomeSections).toEqual([
      { blockId: "hero", section: "hero", title: "Home hero", refreshable: true },
    ]);
    expect((await db.doc(`cmsPublishQueue/${response.body.publication.queueId}/backgroundOutputs/home`).get()).data())
      .toMatchObject({ status: "pending", dependencies: { homePlacementPaths: ["/"] } });
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(homeBefore);
    expect((await decision("/posts/pilot-story/")).kind).toBe("post");
    expect(await worker().fetch(new Request("https://njpbs.org/"))).toBeNull();
  });

  it("converges prior category placements on withdrawal after two unplaced edits", async () => {
    await db.doc(`cmsPosts/${config.postId}`).update({ categories: ["News"] });
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { sourceVersion: 1,
      metadata: { title: "Home", homeHero: { mode: "category", source: "cms_posts", value: "News" } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    for (const document of [{ categories: [] }, { title: "Still unplaced" }]) {
      await savePublishedRevision(document);
      const edit = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
        baseVersion: (await current()).version, publish: true, document: {} });
      expect(edit.code, JSON.stringify(edit.body)).toBe(200);
    }
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet });
    const removal = await invoke(transition, { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, action: "unpublish" });
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    expect(removal.body.publication.affectedHomeSections).toEqual([]);
    // Prior category placement still owns a Home task even when the latest
    // saved Post no longer matches that category. Its baseline can retain a card.
    expect(await worker().fetch(new Request("https://njpbs.org/"))).toBeNull();
    await db.doc("cmsBackgroundOutputs/home").delete();
    expect(await worker().fetch(new Request("https://njpbs.org/"))).toBeNull();
    expect((await db.doc(`cmsPublishQueue/${removal.body.publication.homeFullBuildQueueId}`).get()).data())
      .toMatchObject({ status: "pending", transport: "serializer", changes: [{ operation: "withdraw", id: config.postId }] });
  });

  it("keeps static Home during missing authority while warm detail stays withdrawn", async () => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-11T19:00:00.000Z", log: quiet });
    const removal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    for (const missing of ["manifest", "operation"]) {
      if (missing === "manifest") await db.doc("cmsBackgroundOutputs/home").delete();
      else await db.doc(`cmsPublishQueue/${removal.body.publication.queueId}`).delete();
      for (const path of ["/", "/_home-sources.json"]) for (const method of ["GET", "HEAD"]) {
        const response = await servePublicRequest(new Request(`https://njpbs.org${path}`, { method }), {
          noBuildPosts: worker(), fetchAsset: async request => new Response(request.method === "HEAD" ? null : "Static Home copy"),
          getPublishedPage: async () => { throw new Error("Unexpected Page read"); },
        });
        expect(response.status, `${missing}:${path}:${method}`).toBe(200);
        expect(await response.text()).toBe(method === "HEAD" ? "" : "Static Home copy");
      }
      expect((await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    }
  });

  it("advances the Home publication fence only when publishing its saved snapshot", async () => {
    await db.doc("cmsPages/home").set({ id: "home", template: "home", title: "Home", status: "approved",
      section: "news", version: 1, blocks: [] });
    const response = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1,
      publish: true, document: {} });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toMatchObject({ revision: 2, homeRevision: 1 });
    expect((await publish()).code).toBe(200);
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().homeRevision).toBe(1);
  });

  it.each(["none", "other withdrawal", "unplaced removal", "settled legacy placed removal"])(
    "keeps a routine Home publication available with %s history under the kept-static outage contract", async history => {
    if (history === "settled legacy placed removal") await db.doc("cmsPages/home").set({ publiclyVisible: true,
      published: { metadata: { homeHero: { mode: "manual", items: [{ itemId: "placed", source: "cms_posts",
        sourceId: config.postId, title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    if (["unplaced removal", "settled legacy placed removal"].includes(history)) {
      const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
        requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet }),
      { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
      expect(removal.code, JSON.stringify(removal.body)).toBe(200);
      if (history === "settled legacy placed removal") {
        await buildState.settleBuildQueue(db, { queueId: removal.body.publication.homeFullBuildQueueId,
          status: "success", queueUpdate: { status: "success" } });
      }
    } else if (history === "other withdrawal") {
      await db.doc(context.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 3 });
    }
    await db.doc("cmsBackgroundOutputs/home").delete();
    await db.doc("cmsPages/home").set({ id: "home", template: "home", title: "Home", status: "approved", version: 1,
      createdBy: actor.uid, blocks: [], publiclyVisible: false });
    const home = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1, publish: true, document: {} });
    expect(home.code, JSON.stringify(home.body)).toBe(200);
    const result = await servePublicRequest(new Request("https://njpbs.org/"), { noBuildPosts: worker(),
      fetchAsset: async () => new Response("Existing Home without any withdrawn card"),
      getPublishedPage: async () => { throw new Error("Unexpected Page read"); } });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("Existing Home without any withdrawn card");
  });

  it("uses the serializer with a clear reason for a copied legacy Home card", async () => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: {}, blocks: [
      { id: "legacy", visible: true, type: "prose", data: { html: '<a href="/posts/pilot-story">Copied story</a>' } },
    ] } });
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication).toMatchObject({ transport: "serializer", message: expect.stringContaining("legacy Home card") });
    expect((await state()).operationId).toBeNull();
    expect((await db.doc("cmsBackgroundOutputs/home").get()).exists).toBe(false);
  });

  it("returns the native Post owner reason when bulk archive refuses a copied legacy Home card", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin" });
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: {}, blocks: [
      { id: "legacy", visible: true, type: "prose", data: { html: '<a href="/posts/pilot-story">Copied story</a>' } },
    ] } });
    const before = await current();

    const response = await invoke(bulkArchive.createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => actor, noBuildConfig: config, log: quiet }),
    { items: [{ id: config.postId, baseVersion: before.version }] });

    expect(response.code).toBe(200);
    expect(response.body.outcomes).toEqual([{ id: config.postId, status: "failed",
      message: "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again." }]);
    expect(await current()).toEqual(before);
  });

  it("keeps the native withdrawal repair reason when bulk archive needs the retired serializer", async () => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    let refusal;
    try {
      await db.runTransaction(transaction => retainedWithdrawal.preparePostWithdrawalBuild({ firestore: db, transaction,
        actor, change: { collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" },
        operationId: "Repair00000000000001", runtime: { owner: "node-compute", release: sha } }));
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ status: 409, code: "serializer_publication_unavailable",
      message: "This Post's public removal needs a background repair that the retired full-site build used to do. Ask an administrator." });
    const firestore = { collection: db.collection.bind(db),
      runTransaction: async () => { throw refusal; } };

    const response = await invoke(bulkArchive.createCmsBulkArchiveHandler({ firestore,
      requireAdminFn: async () => actor, noBuildConfig: config, log: quiet }),
    { items: [{ id: config.postId, baseVersion: 1 }] });

    expect(response.code).toBe(200);
    expect(response.body.outcomes).toEqual([{ id: config.postId, status: "failed",
      message: "This Post's public removal needs a background repair that the retired full-site build used to do. Ask an administrator." }]);
  });

  it("does not hide a legacy copied card behind a source-bound hero with the same block id", async () => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "bound-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [
      { id: "hero", visible: true, type: "prose", data: { html: '<a href="/posts/pilot-story/">Copied card</a>' } },
    ] } });
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication).toMatchObject({ transport: "serializer", message: expect.stringContaining("legacy Home card") });
    expect((await state()).operationId).toBeNull();
    expect((await db.doc("cmsBackgroundOutputs/home").get()).exists).toBe(false);
  });

  it("keeps an unbound legacy native hero on the serializer boundary", async () => {
    const savedHome = { publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "legacy-hero", title: "Copied hero title", summary: "",
        href: "/posts/pilot-story/" }] } }, blocks: [] } };
    await db.doc("cmsPages/home").set(savedHome);
    const response = await publish();
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.publication).toMatchObject({ transport: "serializer", message: expect.stringContaining("legacy Home card") });
    expect((await state()).operationId).toBeNull();
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(savedHome);
  });

  it("refuses an incompatible legacy hero edit after the pilot owns the Post", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "legacy-hero", title: "Copied hero title", summary: "",
        href: "/posts/pilot-story/" }] } }, blocks: [] } });
    await savePublishedRevision({ title: "Must not partially publish" });
    const before = await current();
    const response = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: before.version,
      publish: true, document: {} });
    expect(response.code, JSON.stringify(response.body)).toBe(409);
    expect(await current()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

  it("returns all affected saved Home sections on a placed Post edit and withdrawal without saving Home", async () => {
    const shelf = (id, title) => ({ id, type: "content_shelf", visible: true, section: "home-posts",
      data: { source: "station_posts", selectedIds: ["other-post", config.postId, "third-post"],
        selectionReceipt: { buildBatchId: "saved-home-fixture", generation: 1, commitSha: sha, digest: "f".repeat(64) },
        title, itemLimit: 6, moreLabel: "More posts", moreHref: "/posts/" } });
    const savedHome = { publiclyVisible: true, version: 7, published: { sourceVersion: 7,
      metadata: { homeCompositionVersion: 2, homeHero: { mode: "manual", items: [
        { itemId: "placed-hero", source: "cms_posts", sourceId: config.postId, title: "", summary: "", href: "" },
      ] } }, blocks: [shelf("station-first", "Station reports")] } };
    await db.doc("cmsPages/home").set(savedHome);
    expect((await publish()).code).toBe(200);
    await savePublishedRevision({ title: "Corrected headline", summary: "Corrected summary" });
    const edit = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 4,
      publish: true, document: {} });
    expect(edit.code, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.publication.affectedHomeSections.map(section => section.blockId)).toEqual(["station-first", "hero"]);
    expect((await current()).published.metadata).toMatchObject({ title: "Corrected headline", summary: "Corrected summary" });
    const owned = await state();
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}/backgroundOutputs/home`).get()).data())
      .toMatchObject({ dependencies: { homePlacementPaths: ["/"], after: { visible: true, sourceVersion: 5 } } });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-11T19:00:00.000Z", log: quiet });
    const withdrawal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 5, action: "unpublish" });
    expect(withdrawal.code, JSON.stringify(withdrawal.body)).toBe(200);
    expect(withdrawal.body.publication.affectedHomeSections.map(section => section.title))
      .toEqual(["Station reports", "Home hero"]);
    expect(withdrawal.body.publication.warnings).toEqual([
      "Home will lose a card in: Station reports, Home hero. Review those sections.",
      expectedHomeWithdrawalWarning,
    ]);
    const fullBuildId = withdrawal.body.publication.homeFullBuildQueueId;
    expect((await db.doc(`cmsPublishQueue/${fullBuildId}`).get()).data()).toMatchObject({ transport: "serializer", status: "pending" });
    expect((await current()).publishBuildQueueId).toBe(fullBuildId);
    expect((await db.doc(`cmsPublishQueue/${withdrawal.body.publication.queueId}/backgroundOutputs/home`).get()).data())
      .toMatchObject({ dependencies: { homePlacementPaths: ["/"], after: { visible: false } } });
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(savedHome);
  });
  it.each([["preparation", "node-compute"], ["manifest", "node-compute"], ["manifest", "cloudflare"]])(
    "queues a normal full build and durable warning when first Home removal %s fails under %s", async (failure, backgroundOwner) => {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: backgroundOwner, release: sha } });
    if (backgroundOwner === "cloudflare") await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1,
      phase: "ready", commitSha: "c".repeat(40), serializerId: "fixture-home-full-build",
      cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    const savedHome = { publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } };
    await db.doc("cmsPages/home").set(savedHome);
    expect((await publish()).code).toBe(200);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-11T19:00:00.000Z", log: quiet });
    const removal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code, JSON.stringify(removal.body)).toBe(200);
    const operationId = removal.body.publication.queueId;
    const legacyQueueId = backgroundOwner === "cloudflare"
      ? await seedRetainedCloudWithdrawal(operationId) : removal.body.publication.homeFullBuildQueueId;
    expect((await db.doc(`cmsPublishQueue/${legacyQueueId}`).get()).data())
      .toMatchObject({ transport: "serializer", status: "pending", homeFullBuild: { reason: "placed_home_withdrawal" } });
    const runtime = { owner: backgroundOwner, release: sha };
    // The same family owner reports its immutable-byte failure, while detail
    // removal retains its own independent receipt.
    if (failure === "manifest") {
      await db.doc("cmsBackgroundOutputs/home").update({ status: "failed" });
      await homeFallback.warnFirstHomeFailure({ firestore: db, operationId });
    }
    else {
      const directory = await mkdtemp(path.join(tmpdir(), "first-home-fallback-"));
      returnDirectories.push(directory);
      // No Storage app models unavailable durable preparation before any build
      // or provider request. Maintenance must still enqueue the normal build.
      await noBuildPostMaintenance({ firestore: db, commitSha: sha, runtime,
        stateDirectory: directory, distDirectory: path.join(directory, "dist"),
        buildEnvironment: { NO_BUILD_POST_ENABLED: "true", NO_BUILD_POST_ID: config.postId,
          NO_BUILD_POST_BACKGROUND_BUCKET: "fixture-bucket" } })();
      expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().homeFallback).toBeDefined();
    }
    const input = { firestore: db, operationId, runtime };
    const receipts = await Promise.all([homeFallback.enqueueHomeWithdrawalBuild(input),
      homeFallback.enqueueHomeWithdrawalBuild(input)]);
    expect(receipts[0]).toEqual(receipts[1]);
    const fallback = (await db.doc(`cmsPublishQueue/${receipts[0].queueId}`).get()).data();
    expect(fallback).toMatchObject({ transport: "serializer", status: "pending",
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }],
      homeFallback: { warning: expectedFirstHomeFailureWarning } });
    expect(await current()).toMatchObject({ publiclyVisible: false, publishBuildPending: true,
      publishBuildQueueId: receipts[0].queueId });
    expect((await decision("/")).kind).toBe("pass");
    const status = await invoke(getContent.createCmsGetContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, log: quiet }), { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect(status.body.publication).toMatchObject({ homeWarning: expectedFirstHomeFailureWarning, queueStatus: "pending" });
    expect((await db.doc("cmsPages/home").get()).data()).toEqual(savedHome);
    expect(await homeFallback.enqueueHomeWithdrawalBuild(input)).toEqual(receipts[0]);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
    expect(fallback.runtime).toBeUndefined();
    const claimed = await serializer.claimCmsPublishQueue({ firestore: db, queueId: receipts[0].queueId,
      buildBatchId: `cms-${receipts[0].queueId}`, commitSha: "c".repeat(40), serializerId: "fixture-home-full-build",
      claimToken: "33333333-3333-4333-8333-333333333333" });
    expect(claimed.outcome).toBe("claimed");
  });
  it("does not duplicate an accepted Home removal full build after a newer Post operation", async () => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, log: quiet });
    const removal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    await db.doc("cmsBackgroundOutputs/home").update({ status: "failed" });
    await db.doc(publication.STATE_PATH).update({ operationId: "newer-operation", visible: true });
    const receipt = await homeFallback.enqueueHomeWithdrawalBuild({ firestore: db, operationId: removal.body.publication.queueId });
    expect(receipt.queueId).toBe(removal.body.publication.homeFullBuildQueueId);
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
  });
  it.each([["pending", "reserved"], ["success", "reserved"], ["pending", "pending"], ["success", "pending"]])(
    "settles a previous Home withdrawal on republish after %s detail publication and %s full-build queue", async (detailStatus, fullStatus) => {
      await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
        mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
          title: "", summary: "", href: "" }] } }, blocks: [] } });
      expect((await publish()).code).toBe(200);
      const originalRef = db.collection("cmsPublishQueue").doc();
      const postRef = db.doc(`cmsPosts/${config.postId}`);
      // Stop at the committed crash boundary, before post-commit promotion.
      const reservation = await db.runTransaction(async transaction => {
        const nextDocument = { ...(await transaction.get(postRef)).data(), publiclyVisible: false, status: "draft", version: 3 };
        const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
          collection: "cmsPosts", documentId: config.postId, nextDocument, queueRef: originalRef, actor, config });
        prepared.write();
        transaction.set(postRef, { ...nextDocument, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
        return prepared.homeFullBuildQueueId;
      });
      if (fullStatus === "pending") await homeFallback.enqueueHomeWithdrawalBuild({ firestore: db, operationId: originalRef.id });
      await originalRef.update({ status: detailStatus });
      const republished = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
        baseVersion: 3, publish: true, document: {} });
      expect(republished.code, JSON.stringify(republished.body)).toBe(200);
      expect((await db.doc(`cmsPublishQueue/${reservation}`).get()).data()).toMatchObject({
        status: fullStatus === "reserved" ? "superseded" : "pending", transport: "serializer" });
      expect((await originalRef.get()).data().homeFullBuild.status).toBe(fullStatus === "reserved" ? "superseded" : "queued");
      expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").where("status", "==", "reserved").get()).empty).toBe(true);
      expect((await current()).publishBuildQueueId).toBe(republished.body.publication.queueId);
    });
  it.each(["promote", "supersede"])("recovers a committed Home withdrawal reservation by %s without another queue", async outcome => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const originalRef = db.collection("cmsPublishQueue").doc();
    const postRef = db.doc(`cmsPosts/${config.postId}`);
    // Model the real crash boundary: the withdrawal and reserved convergence
    // queue committed, but the API process never ran post-commit promotion.
    const reservation = await db.runTransaction(async transaction => {
      const nextDocument = { ...(await transaction.get(postRef)).data(), publiclyVisible: false };
      const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
        collection: "cmsPosts", documentId: config.postId, nextDocument, queueRef: originalRef, actor, config });
      prepared.write();
      transaction.set(postRef, { ...nextDocument, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
      return { operationId: originalRef.id, queueId: prepared.homeFullBuildQueueId };
    });
    const fullRef = db.doc(`cmsPublishQueue/${reservation.queueId}`);
    expect((await fullRef.get()).data()).toMatchObject({ status: "reserved", transport: "serializer" });
    if (outcome === "supersede") await db.doc(publication.STATE_PATH).update({ operationId: "99999999999999999999", visible: true });
    const recovered = await homeFallback.enqueueHomeWithdrawalBuild({ firestore: db, operationId: reservation.operationId });
    const expectedStatus = outcome === "promote" ? "pending" : "superseded";
    expect((await fullRef.get()).data().status).toBe(expectedStatus);
    expect((await originalRef.get()).data().homeFullBuild.status).toBe(outcome === "promote" ? "queued" : "superseded");
    expect(recovered?.queueId ?? null).toBe(outcome === "promote" ? reservation.queueId : null);
    await homeFallback.enqueueHomeWithdrawalBuild({ firestore: db, operationId: reservation.operationId });
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
  });
  it.each(["missing", "invalid", "different-post"])("recovers a committed Home withdrawal after %s admission through maintenance", async admissionChange => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const originalRef = db.collection("cmsPublishQueue").doc();
    const postRef = db.doc(`cmsPosts/${config.postId}`);
    // Model the real crash boundary: the withdrawal and reserved convergence
    // queue committed, but the API process never ran post-commit promotion.
    const reservation = await db.runTransaction(async transaction => {
      const nextDocument = { ...(await transaction.get(postRef)).data(), publiclyVisible: false };
      const prepared = await publication.prepareNoBuildPostPublication({ firestore: db, transaction,
        collection: "cmsPosts", documentId: config.postId, nextDocument, queueRef: originalRef, actor, config });
      prepared.write();
      transaction.set(postRef, { ...nextDocument, publishBuildPending: true, publishBuildQueueId: prepared.contentQueueId });
      return { operationId: originalRef.id, queueId: prepared.homeFullBuildQueueId };
    });
    const fullRef = db.doc(`cmsPublishQueue/${reservation.queueId}`);
    expect((await fullRef.get()).data()).toMatchObject({ status: "reserved", transport: "serializer" });
    const admissionRef = db.doc(admission.ADMISSION_PATH);
    if (admissionChange === "missing") await admissionRef.delete();
    else await admissionRef.update(admissionChange === "invalid" ? { schemaVersion: 99 } : { postId: "different-post" });
    const stateDirectory = path.join(process.cwd(), "scratch/mac-home7/admission-recovery");
    const maintain = noBuildPostMaintenance({ firestore: db, commitSha: sha, stateDirectory,
      distDirectory: path.join(stateDirectory, "dist"), buildEnvironment: {} });
    await maintain();
    expect((await fullRef.get()).data().status).toBe("pending");
    expect((await originalRef.get()).data().homeFullBuild.status).toBe("queued");
    await maintain();
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
  });
  it.each([{ firstFastFailure: false, detailStatus: "success" }, { firstFastFailure: true, detailStatus: "success" },
    { firstFastFailure: false, detailStatus: "failed" }])(
    "drains a retained Home withdrawal build while retaining the static outage copy ($firstFastFailure/$detailStatus)", async ({ firstFastFailure, detailStatus }) => {
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet }),
    { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code).toBe(200);
    const operationId = removal.body.publication.queueId;
    const failedQueueId = removal.body.publication.homeFullBuildQueueId;
    if (firstFastFailure) await homeFallback.warnFirstHomeFailure({ firestore: db, operationId, preparationFailed: true });
    // Detail removal can be confirmed before the independent full build fails.
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: detailStatus });
    await buildState.settleBuildQueue(db, { queueId: failedQueueId, status: "failed",
      queueUpdate: { status: "failed", error: "Fixture full build failure" } });
    expect(await current()).toMatchObject({ publiclyVisible: false, publishBuildPending: true, publishBuildQueueId: null });
    const staleHome = await servePublicRequest(new Request("https://njpbs.org/"), {
      noBuildPosts: worker(), fetchAsset: async () => new Response("Old Home with withdrawn Post"),
      getPublishedPage: async () => { throw new Error("Unexpected dynamic Home"); },
    });
    expect(staleHome.status).toBe(200);
    expect(await staleHome.text()).toBe("Old Home with withdrawn Post");
    const statusHandler = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const readStatus = () => invoke(statusHandler, { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect((await readStatus()).body.publication).toMatchObject({ queueStatus: "failed",
      publicUpdatePending: true, homeWarning: firstFastFailure ? expectedFirstHomeFailureWarning : expectedHomeWithdrawalWarning });
    const retryHandler = publishEndpoint.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const request = { retry: true, baseVersion: (await current()).version,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] };
    expect((await invoke(retryHandler, { ...request, baseVersion: request.baseVersion - 1 })).code).toBe(409);
    const denied = publishEndpoint.createCmsPublishHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: "outside", principal: { id: "outside", grants: [] } }), log: quiet });
    expect((await invoke(denied, request)).code).toBe(403);
    const retries = await Promise.all([invoke(retryHandler, request), invoke(retryHandler, request)]);
    expect(retries.map(result => result.code)).toEqual([200, 200]);
    const queueId = retries[0].body.queueId;
    expect(retries[0].body.transport).toBe("serializer");
    expect(retries[1].body.queueId).toBe(queueId);
    expect(queueId).not.toBe(failedQueueId);
    expect(queueId).not.toBe(operationId);
    expect((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()).toMatchObject({ status: "pending", transport: "serializer",
      changes: request.changes, homeFullBuild: { sourceOperationId: operationId } });
    expect(await current()).toMatchObject({ publishBuildPending: true, publishBuildQueueId: queueId });
    expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().status).toBe(detailStatus === "failed" ? "pending" : "success");
    expect((await readStatus()).body.publication.homeWarning).toBe(firstFastFailure ? expectedFirstHomeFailureWarning : expectedHomeWithdrawalWarning);
    const next = await prepareStaticReturn({ queueId, ordinary: true, enqueue: false });
    const acquired = await next.acquire();
    await next.settle(acquired.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId });
    const home = await servePublicRequest(new Request("https://njpbs.org/"), {
      noBuildPosts: next.handler, fetchAsset: async request => new Response(next.files[new URL(request.url).pathname]),
      getPublishedPage: async () => { throw new Error("Unexpected dynamic page read"); },
    });
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("withdrawn Post");
    expect(await current()).toMatchObject({ publiclyVisible: false, publishBuildPending: false, publishBuildQueueId: null });
    expect((await readStatus()).body.publication).toMatchObject({ queueStatus: "pending", publicUpdatePending: true,
      publicBuildQueueId: operationId, withdrawalBuildPending: true });
    expect((await readStatus()).body.publication.homeWarning).toBeUndefined();
  });

  it.each(["node-compute", "cloudflare"])("retries only current failed withdrawal outputs and preserves the frozen reservation under %s", async backgroundOwner => {
    await db.doc(publication.STATE_PATH).update({ runtime: { owner: backgroundOwner, release: sha } });
    if (backgroundOwner === "cloudflare") await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1,
      phase: "ready", commitSha: sha, serializerId: "fixture-serializer",
      cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { metadata: { homeHero: {
      mode: "manual", items: [{ itemId: "placed-hero", source: "cms_posts", sourceId: config.postId,
        title: "", summary: "", href: "" }] } }, blocks: [] } });
    expect((await publish()).code).toBe(200);
    const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet }),
    { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code).toBe(200);
    const operationId = removal.body.publication.queueId;
    const legacyQueueId = backgroundOwner === "cloudflare"
      ? await seedRetainedCloudWithdrawal(operationId) : removal.body.publication.homeFullBuildQueueId;
    await buildState.settleBuildQueue(db, { queueId: legacyQueueId,
      status: "success", queueUpdate: { status: "success" } });
    const originalRef = db.doc(`cmsPublishQueue/${operationId}`);
    await originalRef.update({ status: "success" });
    const home = (await db.doc("cmsBackgroundOutputs/home").get()).data();
    const homeTask = db.doc(home.taskPath);
    await homeTask.update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
    await db.doc("cmsBackgroundOutputs/home").update({ status: "failed" });
    const digest = await db.runTransaction(transaction => context.readPublicContextInTransaction(transaction, db), { readOnly: true });
    const preparationRef = originalRef.collection("backgroundPreparation").doc(digest);
    const frozen = { reservation: { buildBatchId: "accepted-background", cutoffAt: Timestamp.fromMillis(1234) },
      inputDigest: "a".repeat(64), preparedDigest: "b".repeat(64) };
    await preparationRef.set({ ...frozen, schemaVersion: 1, runtime: { owner: backgroundOwner, release: sha },
      status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
    const statusHandler = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    expect((await invoke(statusHandler, { collection: "cmsPosts", id: config.postId, publicationOnly: true })).body.publication)
      .toMatchObject({ queueStatus: "failed", publicUpdatePending: true, withdrawalBuildPending: true, publicBuildQueueId: operationId });
    const retryHandler = publishEndpoint.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const request = { retry: true, baseVersion: (await current()).version,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] };
    expect((await invoke(retryHandler, { ...request, baseVersion: request.baseVersion - 1 })).code).toBe(409);
    const receipts = await Promise.all([invoke(retryHandler, request), invoke(retryHandler, request)]);
    expect(receipts.map(receipt => receipt.code)).toEqual([200, 200]);
    expect(receipts.map(receipt => receipt.body.queueId)).toEqual([operationId, operationId]);
    expect((await homeTask.get()).data()).toMatchObject({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
    expect((await preparationRef.get()).data()).toMatchObject({ ...frozen, status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
    expect((await originalRef.get()).data().status).toBe("success");
    expect((await db.collection("cmsPublishQueue").where("transport", "==", "serializer").get()).size).toBe(1);
    // Active and foreign work keeps its identity and lease despite another retry.
    await homeTask.update({ status: "failed", claim: "active-owner-claim", attempts: 4, nextAttemptAt: null });
    await preparationRef.update({ status: "failed", claim: "preparation-owner-claim", attempts: 4, nextAttemptAt: null });
    const beforeTask = (await homeTask.get()).data();
    const beforePreparation = (await preparationRef.get()).data();
    expect((await invoke(retryHandler, request)).code).toBe(200);
    expect((await homeTask.get()).data()).toEqual(beforeTask);
    expect((await preparationRef.get()).data()).toEqual(beforePreparation);
    await homeTask.update({ claim: null, runtime: { owner: backgroundOwner === "cloudflare" ? "node-compute" : "cloudflare", release: sha } });
    const foreign = (await homeTask.get()).data();
    expect((await invoke(retryHandler, request)).code).toBe(200);
    expect((await homeTask.get()).data()).toEqual(foreign);
  });

  it.each(["operation fence", "legacy receipt"])("keeps completed withdrawal feedback settled through later work using %s", async mode => {
    expect((await publish()).code).toBe(200);
    const removal = await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet }),
    { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code).toBe(200);
    await buildState.settleBuildQueue(db, { queueId: removal.body.publication.homeFullBuildQueueId,
      status: "success", queueUpdate: { status: "success" } });
    const operationId = removal.body.publication.queueId;
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "success" });
    const statusHandler = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const status = async () => (await invoke(statusHandler, { collection: "cmsPosts", id: config.postId, publicationOnly: true })).body.publication;
    expect(await status()).toMatchObject({ publicUpdatePending: true, withdrawalBuildPending: true });
    const paths = { listings: ["/posts/"], authors: ["/authors/fixture/"], feed: ["/feeds/news.xml"],
      contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
    let failSearch = true;
    const artifacts = new Map();
    const owner = backgroundOutputs.createPostBackgroundOutputs({ firestore: db, enabled: true, accepting: false,
      postIds: [config.postId], contentApiEnabled: true, runtime: { owner: "node-compute", release: sha },
      readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
      artifacts: { async put(key, bytes) { artifacts.set(key, bytes); }, async get(key) { return artifacts.get(key); } },
      build: async task => {
        if (task.output === "search" && failSearch) throw new Error("Search fixture unavailable");
        return { input: { kind: "public-background", rendererSha: sha, contextDigest: task.contextDigest, routes: [] },
          files: paths[task.output].map(path => ({ path, contentType: "text/html", bytes: "Verified family without withdrawn content" })) };
      } });
    await owner.recover();
    expect(await status()).toMatchObject({ queueStatus: "failed", publicUpdatePending: true, withdrawalBuildPending: true });
    failSearch = false;
    const search = (await db.doc("cmsBackgroundOutputs/search").get()).data();
    await db.doc(search.taskPath).update({ nextAttemptAt: 0 });
    await owner.recover();
    expect(await status()).toMatchObject({ queueStatus: "success", publicUpdatePending: false, publicBuildQueueId: null });
    expect((await status()).withdrawalBuildPending).toBeUndefined();
    const queueRef = db.doc(`cmsPublishQueue/${operationId}`);
    expect((await queueRef.get()).data().withdrawalRevision).toBe(1);
    if (mode === "legacy receipt") {
      await queueRef.update({ withdrawalRevision: FieldValue.delete() });
      expect((await queueRef.get()).data().withdrawalOutputsReceipt).toBeUndefined();
      expect(await status()).toMatchObject({ publicUpdatePending: true, withdrawalBuildPending: true });
      await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
        fetchPublic: async () => { throw new Error("Successful detail must not be republished"); } });
      expect((await queueRef.get()).data().withdrawalOutputsReceipt).toMatchObject({ schemaVersion: 1, operationId, sourceVersion: 2 });
      expect(await status()).toMatchObject({ publicUpdatePending: false, publicBuildQueueId: null });
    }
    // Later unrelated removal/regeneration retains the earlier verified bytes.
    // This Post's old tasks are superseded; only its own fence/proof can clear it.
    const originalTasks = await queueRef.collection("backgroundOutputs").get();
    for (const task of originalTasks.docs) await task.ref.update({ status: "superseded", receipt: FieldValue.delete() });
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: FieldValue.increment(1), withdrawalRevision: FieldValue.increment(1) });
    const states = await db.collection("cmsBackgroundOutputs").get();
    for (const row of states.docs) {
      const state = row.data();
      await row.ref.update({ status: "failed", receipt: null, lastGood: { receipt: state.receipt, after: state.after },
        taskPath: `cmsPublishQueue/99999999999999999999/backgroundOutputs/${row.id}` });
    }
    expect(await status()).toMatchObject({ queueStatus: "success", publicUpdatePending: false, publicBuildQueueId: null });
    expect((await status()).withdrawalBuildPending).toBeUndefined();
  });
  it("preserves withdrawal status for a normally published legacy Firestore ID", async () => {
    const id = "legacy:story-é";
    await db.doc(`cmsPosts/${id}`).set({ ...(await current()), id, publiclyVisible: false, status: "draft",
      publishBuildPending: false, publicBuildQueueId: null });
    const handler = getContent.createCmsGetContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, log: quiet });
    const result = await invoke(handler, { collection: "cmsPosts", id, publicationOnly: true });
    expect(result.code).toBe(200);
    expect(result.body.publication.publicUpdatePending).toBe(false);
    expect(result.body.publication.withdrawalBuildPending).toBeUndefined();
  });
  it("reads only the public snapshot and emits exact matching Admin receipts", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc(`cmsPosts/${config.postId}`).update({ title: "Secret draft title", blocks: [{ private: "Secret draft block" }] });
    const read = await decision("/posts/pilot-story/");
    expect(read.kind).toBe("post");
    expect(JSON.stringify(read)).not.toContain("Secret draft");
    const handler = worker();
    const status = await (await handler.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    const receipt = await (await handler.fetch(new Request("https://njpbs.org/_publication.json"))).json();
    const routes = readPublicContentStatus(status, receipt);
    expect(routes.some(route => route.path === "/posts/pilot-story/" && route.sourceVersion === 2)).toBe(true);
    expect(routes.some(route => route.path === "/about/" && route.source === "site")).toBe(true);
  });
  it("withdraws atomically, keeps a tombstone and removes its Admin route", async () => {
    expect((await publish()).code).toBe(200);
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
    const response = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await current()).publiclyVisible).toBe(false);
    expect((await state()).visible).toBe(false);
    const tombstone = await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"));
    expect(tombstone.status).toBe(410);
    expect(tombstone.headers.get("x-njpbs-publication-operation")).toBe((await state()).operationId);
    const handler2 = worker();
    const status = await (await handler2.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    const receipt = await (await handler2.fetch(new Request("https://njpbs.org/_publication.json"))).json();
    expect(readPublicContentStatus(status, receipt).some(route => route.path === "/posts/pilot-story/")).toBe(false);
  });
  it("retains aliases and cancels an older unfinished operation on republish", async () => {
    expect((await publish()).code).toBe(200);
    const original = (await state()).operationId;
    const renamed = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: 2, slug: "pilot-renamed", document: {} });
    expect(renamed.code, JSON.stringify(renamed.body)).toBe(200);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: 3, publish: true, document: {} })).code).toBe(200);
    expect((await db.doc(`cmsPublishQueue/${original}`).get()).data().status).toBe("cancelled");
    const response = await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/posts/pilot-renamed/");
    expect(response.headers.get("x-njpbs-source-version")).toBe("4");
    expect((await decision("/posts/pilot-renamed/")).kind).toBe("post");
    let encoded = "/%70osts/pilot-story/";
    for (let layer = 0; layer < 33; layer++) encoded = encoded.replaceAll("%", "%25");
    expect((await worker().fetch(new Request(`https://njpbs.org${encoded}`))).status).toBe(503);
    expect(await worker().fetch(new Request("https://njpbs.org/about//"))).toBeNull();
    expect(await worker().fetch(new Request("https://njpbs.org/100%25/"))).toBeNull();
  });
  it("serves the leased compatible renderer and refuses a release without ownership", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc("system/publicDeployment").set(leasedPointer());
    const candidate = { commitSha: "b".repeat(40), workerVersionId: "candidate-version",
      noBuildPost: { schemaVersion: 1, rendererSha: "b".repeat(40), postId: config.postId, enabled: true, authoritative: true } };
    const candidateRef = db.doc("system/publicDeployment/buildBatches/release/candidates/worker");
    await candidateRef.set(candidate);
    const read = () => publication.readNoBuildPostDecision({ firestore: db, path: "/posts/pilot-story/", rendererSha: candidate.commitSha });
    expect((await read()).receipt.rendererSha).toBe(candidate.commitSha);
    expect((await publication.readNoBuildPostDecision({ firestore: db, path: "/posts/",
      rendererSha: candidate.commitSha })).kind).toBe("background");
    expect((await publication.readNoBuildPostDecision({ firestore: db, path: "/_publication.json",
      rendererSha: candidate.commitSha, probe: { buildBatchId: "release", versionId: candidate.workerVersionId } })).kind).toBe("baseline-probe");
    await candidateRef.set({ commitSha: candidate.commitSha, workerVersionId: candidate.workerVersionId });
    await expect(read()).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("permits owned withdrawal while admission is paused and a code lease is active", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    await db.doc("system/publicDeployment").set(leasedPointer());
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: { enabled: false, postId: "" }, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
    const response = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect((await current()).publiclyVisible).toBe(false);
    expect((await state()).visible).toBe(false);
    expect((await db.doc(`cmsPublishQueue/${(await state()).operationId}`).get()).data().transport).toBe("post-no-build-v1");
    expect((await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
  });
  it("refuses a scheduled Home placement before it can publish an owned Post", async () => {
    expect((await publish()).code).toBe(200);
    const nextDocument = { published: { metadata: {}, blocks: [{ type: "prose", html: '<p><a href="/posts/pilot-story">Story</a></p>' }] } };
    await expect(db.runTransaction(transaction => publication.assertNoBuildScheduleInTransaction({ firestore: db,
      transaction, collection: "cmsPages", documentId: "home", nextDocument }))).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("changes matching Admin identities when a same-source release changes carried routes", async () => {
    expect((await publish()).code).toBe(200);
    const before = await (await worker().fetch(new Request("https://njpbs.org/_publication.json"))).json();
    const release = worker({ buildBatchId: "ordinary-release", generation: 2,
      routes: [{ path: "/about/", source: "site" }, { path: "/notice/", source: "site" }] });
    const after = await (await release.fetch(new Request("https://njpbs.org/_publication.json"))).json();
    const inventory = await (await release.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    expect(after.buildBatchId).not.toBe(before.buildBatchId);
    expect(readPublicContentStatus(inventory, after).some(route => route.path === "/notice/")).toBe(true);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("exhausts an interrupted final Post confirmation through minute recovery", async () => {
    expect((await publish()).code).toBe(200);
    const owned = await state();
    const ref = db.doc(`cmsPublishQueue/${owned.operationId}`);
    await ref.update({ attempts: 3, nextAttemptAt: 0 });
    const fetchPublic = vi.fn(async () => { throw new Error("No IO after crash"); });
    const fetchPurge = vi.fn(async () => { throw new Error("No IO after crash"); });
    const recover = (firestore, time, operationId) => recovery.recoverNoBuildPostDetail({
      firestore, operationId, fetchPublic, fetchPurge, now: () => time });
    await expect(recover(interruptConfirmation(db, ref), 1_000, ref.id))
      .rejects.toThrow("Process lost after final confirmation claim");
    const claimed = (await ref.get()).data();
    expect(claimed).toMatchObject({ status: "pending", attempts: 4, claim: expect.any(String), nextAttemptAt: 61_000 });
    await recover(db, 60_999);
    expect((await ref.get()).data()).toEqual(claimed);
    await ref.update({ "noBuildPost.sourceVersion": 99 });
    const mismatched = (await ref.get()).data();
    await recover(db, 61_000);
    expect((await ref.get()).data()).toEqual(mismatched);
    await ref.update({ "noBuildPost.sourceVersion": owned.sourceVersion });
    await recover(db, 61_000);
    expect((await ref.get()).data()).toMatchObject({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
    expect(await current()).toMatchObject({ publishBuildPending: true, publishBuildQueueId: ref.id });
    expect(fetchPublic).not.toHaveBeenCalled();
    expect(fetchPurge).not.toHaveBeenCalled();
    const failed = (await ref.get()).data();
    await recover(db, 121_000);
    expect((await ref.get()).data()).toEqual(failed);
    const recheck = require("../../functions/lib/publication-recheck.js");
    expect(await recheck.recheckPublication({ firestore: db, queueId: ref.id, actor, fetchPublic }))
      .toMatchObject({ outcome: "failed" });
    await recovery.existingNoBuildPostPublication({ firestore: db, retry: true, actor, baseVersion: 2,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2 }] });
    expect((await ref.get()).data()).toMatchObject({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
  });
  it("retains successful publication through a slow proof and verifies the same operation on retry", async () => {
    expect((await publish()).code).toBe(200);
    let time = 1_000_000;
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge, now: () => time, fetchPublic: async () => { throw new Error("network unavailable"); } });
    const owned = await state();
    expect(await current()).toMatchObject({ publishBuildQueueId: null, publishBuildPending: false,
      publicSourceVersion: 2, publicPostProof: { operationId: owned.operationId, status: "failed", retryPending: true } });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    time += 60_001;
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge, now: () => time, fetchPublic: async () => {
      const read = await decision("/posts/pilot-story/");
      const html = "<!doctype html><html><head><title>Pilot story</title></head><body>Published story</body></html>";
      return new Response(html, { headers: { "x-njpbs-content-source": "cms-no-build", "cache-control": "no-store",
        "x-njpbs-admission-revision": "1", "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex"),
        "x-njpbs-source-version": "2", "x-njpbs-publication-operation": owned.operationId,
        "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": read.receipt.contextDigest } });
    } });
    expect((await current()).publicSourceVersion).toBe(2);
    expect((await current()).publishBuildPending).toBe(false);
    expect((await current()).publicPostProof.status).toBe("verified");
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("shows success after owner commit and purge while the public proof is still blocked", async () => {
    await publish();
    const owned = await state();
    let enteredProof;
    let finishProof;
    const entered = new Promise(resolve => { enteredProof = resolve; });
    const blocked = new Promise(resolve => { finishProof = resolve; });
    const running = recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      operationId: owned.operationId, fetchPublic: async () => {
        enteredProof();
        await blocked;
        throw new Error("Synthetic public read failure");
      } });
    await entered;
    expect(await current()).toMatchObject({ publicSourceVersion: 2, publishBuildPending: false,
      publishBuildQueueId: null, publicPostProof: { status: "pending" } });
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data()).toMatchObject({
      status: "success", servingReceipt: { operationId: owned.operationId, sourceVersion: 2 },
      purgeReceipt: { acknowledged: true }, postProof: { status: "pending", attempts: 1 } });
    finishProof();
    await running;
    const endpoint = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const status = await invoke(endpoint, { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect(status.body.publication).toMatchObject({ queueStatus: "success", publicUpdatePending: false,
      postServingConfirmed: false, postProofStatus: "failed", postProofPending: true,
      postProofWarning: "The public check failed after publication. The publisher will retry." });
  });
  it("keeps an open editor's save valid after the background public proof changes", async () => {
    await publish();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      fetchPublic: async () => { throw new Error("Synthetic public failure"); } });
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, log: quiet });
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, action: "revise" })).code).toBe(200);
    const loaded = await current();
    await db.doc(`cmsPosts/${config.postId}`).update({ "publicPostProof.status": "verified", "publicPostProof.retryPending": false });
    const saved = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: loaded.version,
      document: { ...loaded, title: "Keep my draft edit" } });
    expect(saved.code).toBe(200);
    expect(await current()).toMatchObject({ title: "Keep my draft edit", publicPostProof: { status: "verified", retryPending: false } });
  });
  it("bounds proof retries without another purge or a failed publication", async () => {
    await publish();
    const owned = await state();
    let time = 1_000_000;
    let purges = 0;
    let reads = 0;
    const recover = () => recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig,
      fetchPurge: async () => { purges += 1; return Response.json({ success: true }); },
      now: () => time, fetchPublic: async () => { reads += 1; throw new Error("Synthetic outage"); } });
    await recover();
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      time += 10 * 60_000;
      await Promise.all([recover(), recover()]);
    }
    time += 10 * 60_000;
    await recover();
    expect(purges).toBe(1);
    expect(reads).toBe(4);
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data()).toMatchObject({
      status: "success", postProof: { status: "failed", attempts: 4, claim: null, nextAttemptAt: null } });
    expect(await current()).toMatchObject({ publishBuildPending: false, publicSourceVersion: 2,
      publicPostProof: { status: "failed", retryPending: false } });
  });
  it("does not mark a newer publication with an older failed proof", async () => {
    await publish();
    const old = await state();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      operationId: old.operationId, fetchPublic: async () => {
        await savePublishedRevision({ title: "Newer Post" });
        const version = (await current()).version;
        await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: version,
          publish: true, document: {} });
        throw new Error("Old proof failed after a new publication");
      } });
    expect((await state()).operationId).not.toBe(old.operationId);
    expect((await current()).publishBuildPending).toBe(true);
    expect((await current()).publicPostProof.status).toBe("pending");
    const endpoint = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const status = await invoke(endpoint, { collection: "cmsPosts", id: config.postId, publicationOnly: true });
    expect(status.body.publication.postProofWarning).toBeUndefined();
  });
  it("settles a lost final proof lease as exhausted without another public read", async () => {
    await publish();
    const owned = await state();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      fetchPublic: async () => { throw new Error("Synthetic outage"); } });
    await db.doc(`cmsPublishQueue/${owned.operationId}`).update({ "postProof.status": "pending",
      "postProof.attempts": 4, "postProof.claim": "lost-process", "postProof.nextAttemptAt": 1_000 });
    await recovery.recoverNoBuildPostDetail({ firestore: db, now: () => 2_000,
      fetchPublic: async () => { throw new Error("An exhausted proof must not read again"); } });
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data()).toMatchObject({
      status: "success", postProof: { status: "failed", claim: null, nextAttemptAt: null, attempts: 4 } });
    expect((await current()).publicPostProof).toMatchObject({ status: "failed", retryPending: false });
  });
  it.each(["owner", "renderer", "admission"])("refuses early success when %s changes before purge completes", async change => {
    await publish();
    const owned = await state();
    let reads = 0;
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig,
      fetchPurge: async () => {
        if (change === "owner") await db.doc(publication.STATE_PATH).update({ sourceVersion: 9 });
        if (change === "renderer") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
        if (change === "admission") await db.doc(admission.ADMISSION_PATH).delete();
        return Response.json({ success: true });
      }, fetchPublic: async () => { reads += 1; throw new Error("Serving must be current before proof"); } });
    expect(reads).toBe(0);
    expect((await current()).publishBuildPending).toBe(true);
    expect((await current()).publicPostProof).toBeUndefined();
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data().status).toBe("pending");
  });
  it("alerts only an exhausted proof through the existing relay with durable delivery retry and deduplication", async () => {
    await publish();
    const owned = await state();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      fetchPublic: async () => { throw new Error("Synthetic outage"); } });
    let time = 1_000_000;
    let sends = 0;
    const messages = [];
    const check = () => postAlerts.checkPostProofAlerts({ firestore: db, now: () => time, log: quiet,
      send: async message => { sends += 1; if (sends === 1) throw new Error("Synthetic delivery failure"); messages.push(message); } });
    await check();
    expect(sends).toBe(0);
    await db.doc(`cmsPublishQueue/${owned.operationId}`).update({ "postProof.attempts": 4, "postProof.nextAttemptAt": null });
    await check();
    await check();
    expect(sends).toBe(1);
    time += 5 * 60_000 + 1;
    await Promise.all([check(), check()]);
    await check();
    expect(messages).toEqual(["NJ PBS Post pilot-story: The public check failed after publication. The publisher needs attention."]);
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}/alerts/public-proof`).get()).data().sentAt).toBe(time);
  });
  it.each(["production", "development"])("awaits only %s tags before event-driven ordinary-path confirmation", async environment => {
    const target = publicationTarget(environment);
    const prefix = environment === "development" ? "njpbs-dev-post" : "njpbs-post";
    const expectedTags = [`${prefix}-pilot-story`, `${prefix}-pilot-renamed`, `${prefix}-background`];
    await publish();
    await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 2,
      slug: "pilot-renamed", document: {} });
    await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 3, publish: true, document: {} });
    const owned = await state();
    // An unresolved aggregate build cannot serialize detail confirmation.
    await db.doc(`cmsPublishQueue/${owned.operationId}/backgroundPreparation/fixture`).set({ status: "building" });
    let releasePurge;
    let enteredPurge;
    const entered = new Promise(resolve => { enteredPurge = resolve; });
    const pendingPurge = new Promise(resolve => { releasePurge = resolve; });
    let readback = false;
    const publicWorker = createNoBuildPostWorker({ target, rendererSha: sha,
      cache: { async match() {}, async put() {} }, getDecision: decision,
      fetchAsset: async () => { throw new Error("Unexpected Assets read"); },
      render: async content => `<!doctype html><html>${content.posts[0].title}</html>` });
    const confirm = confirmation.createNoBuildPostConfirmationHandler({ firestore: db, config: () => purgeConfig,
      readback: () => ({ target, headers: environment === "development" ? { "cf-access-client-id": "fixture-id", "cf-access-client-secret": "fixture-secret" } : {} }),
      fetchPurge: async (url, init) => {
        expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${purgeConfig.zoneId}/purge_cache`);
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({ tags: expectedTags });
        enteredPurge();
        await pendingPurge;
        return Response.json({ success: true });
      },
      fetchPublic: async (url, init) => {
        readback = true;
        expect(url).toBe(`${target.origin}/posts/pilot-renamed/`);
        expect(init.cache).toBeUndefined();
        if (environment === "development") expect(init.headers.get("cf-access-client-id")).toBe("fixture-id");
        else expect(init.headers).toBeUndefined();
        return publicWorker.fetch(new Request(url, init));
      } });
    const running = confirm({ params: { queueId: owned.operationId },
      data: { after: await db.doc(`cmsPublishQueue/${owned.operationId}`).get() } });
    await entered;
    expect(readback).toBe(false);
    expect((await current()).publishBuildPending).toBe(true);
    releasePurge();
    await running;
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.status).toBe("success");
    expect(queue.purgeReceipt).toEqual({ operationId: owned.operationId, acknowledged: true,
      tags: expectedTags });
    expect((await current()).publishBuildPending).toBe(false);
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}/backgroundPreparation/fixture`).get()).data().status).toBe("building");
  });
  it.each(["missing", "http", "body", "timeout"])("retains pending publication when purge fails: %s", async failure => {
    await publish();
    const owned = await state();
    let readback = false;
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig: failure === "missing" ? undefined : purgeConfig,
      fetchPurge: async () => {
        if (failure === "timeout") return new Response(new ReadableStream({ start() {} }));
        return Response.json({ success: false }, { status: failure === "http" ? 429 : 200 });
      }, fetchPublic: async () => { readback = true; throw new Error("Readback must follow successful purge"); } });
    expect(readback).toBe(false);
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.status).toBe("pending");
    expect(queue.claim).toBeNull();
    expect(queue.publicReceipt).toBeUndefined();
    expect(queue.purgeReceipt).toBeUndefined();
    expect((await current()).publishBuildPending).toBe(true);
    expect((await decision("/posts/pilot-story/")).receipt.operationId).toBe(owned.operationId);
  });
  it("bounds the later HTML proof to ten seconds while retaining successful publication", async () => {
    await publish();
    const owned = await state();
    const timer = vi.spyOn(globalThis, "setTimeout");
    let registeredDelay, initiallyAborted, abortedAtDeadline, bodyRead = false;
    try {
      await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
        fetchPublic: async (_url, { signal }) => {
          const [expire, milliseconds] = timer.mock.calls.at(-1) ?? [];
          registeredDelay = milliseconds;
          initiallyAborted = signal.aborted;
          return new Response(new ReadableStream({ pull() {
            bodyRead = true;
            expire();
            abortedAtDeadline = signal.aborted;
          } }, { highWaterMark: 0 }), { headers: {
            "cache-control": "no-store", "x-njpbs-content-source": "cms-no-build",
            "x-njpbs-publication-operation": owned.operationId, "x-njpbs-source-version": "2",
            "x-njpbs-admission-revision": "1", "x-njpbs-html-sha256": "f".repeat(64),
          } });
        } });
    } finally { timer.mockRestore(); }
    expect(registeredDelay).toBe(10_000);
    expect(bodyRead).toBe(true);
    expect(initiallyAborted).toBe(false);
    expect(abortedAtDeadline).toBe(true);
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.status).toBe("success");
    expect(queue.postProof).toMatchObject({ status: "failed", attempts: 1 });
    expect(queue.publicReceipt).toBeUndefined();
    expect((await current()).publishBuildPending).toBe(false);
  });
  it("settles an accepted withdrawal while instant publication admission is paused", async () => {
    expect((await publish()).code).toBe(200);
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: { ...config, enabled: false }, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
    const removal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
    expect(removal.code).toBe(200);
    const owned = await state();
    const confirm = confirmation.createNoBuildPostConfirmationHandler({ firestore: db,
      config: () => purgeConfig, fetchPurge,
      fetchPublic: async (url, init) => worker().fetch(new Request(url, init)) });
    await confirm({ params: { queueId: owned.operationId }, data: {
      after: await db.doc(`cmsPublishQueue/${owned.operationId}`).get() } });
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.status).toBe("success");
    expect(queue.publicReceipt).toMatchObject({ operationId: owned.operationId, visible: false, sourceVersion: 2 });
    expect(await current()).toMatchObject({ publishBuildPending: true,
      publishBuildQueueId: removal.body.publication.homeFullBuildQueueId });
    expect((await db.doc(`cmsPublishQueue/${removal.body.publication.homeFullBuildQueueId}`).get()).data())
      .toMatchObject({ status: "pending", transport: "serializer",
        changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: 2, operation: "withdraw" }] });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(3);
  });
  it("leaves accepted work untouched for an empty or mismatched retained pilot ID or source", async () => {
    expect((await publish()).code).toBe(200);
    const owned = await state();
    const options = { firestore: db, commitSha: sha, stateDirectory: "/tmp/no-build-pause-fixture",
      distDirectory: "/tmp/no-build-pause-dist", buildEnvironment: { NO_BUILD_POST_ENABLED: "false", NO_BUILD_POST_ID: "" } };
    await noBuildPostMaintenance(options)();
    vi.stubGlobal("fetch", async () => { throw new Error("Unexpected public request"); });
    try {
      await noBuildPostMaintenance({ ...options, buildEnvironment: { ...options.buildEnvironment,
        NO_BUILD_POST_ID: "another-post", NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background" } })();
      await noBuildPostMaintenance({ ...options, commitSha: "b".repeat(40), buildEnvironment: { ...options.buildEnvironment,
        NO_BUILD_POST_ID: config.postId, NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background" } })();
    } finally { vi.unstubAllGlobals(); }
    const queue = (await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data();
    expect(queue.status).toBe("pending");
    expect(queue.attempts).toBe(0);
    expect((await current()).publishBuildPending).toBe(true);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("refuses owned scheduling and release-in-progress publication before acceptance", async () => {
    expect((await publish()).code).toBe(200);
    await expect(db.runTransaction(transaction => publication.assertNoBuildScheduleInTransaction({ firestore: db,
      transaction, collection: "cmsPosts", documentId: config.postId }))).rejects.toMatchObject({ status: 409 });
    const previous = await current();
    await db.doc("system/publicDeployment").set(leasedPointer());
    await expect(db.runTransaction(transaction => publication.prepareNoBuildPostPublication({ firestore: db,
      transaction, collection: "cmsPosts", documentId: config.postId, nextDocument: previous,
      queueRef: db.collection("cmsPublishQueue").doc(), actor, config }))).rejects.toThrow();
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
});

const returnDirectories = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(returnDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function confirmDynamicPublication() {
  const owned = await state();
  const receipt = (await decision("/_publication.json")).receipt;
  const html = "<!doctype html><html><body>Current public fixture</body></html>";
  await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge, fetchPublic: async () => new Response(html, { headers: {
    "cache-control": "no-store", "x-njpbs-content-source": "cms-no-build",
    "x-njpbs-publication-operation": owned.operationId, "x-njpbs-source-version": String(owned.sourceVersion),
    "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": receipt.contextDigest,
    "x-njpbs-admission-revision": "1", "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex"),
  } }) });
  expect((await current()).publishBuildPending).toBe(false);
}
async function prepareStaticReturn({ queueId = "11111111111111111111", returnPostId = config.postId, commitSha = "b".repeat(40), enqueue = true,
  ordinary = false, workerVersionId = "33333333-3333-4333-8333-333333333333" } = {}) {
  const buildBatchId = `cms-${queueId}`;
  if (enqueue) await baseline.enqueueCmsPublicationBaseline({ firestore: db, queueId, commitSha, returnPostId: ordinary ? undefined : returnPostId });
  await serializer.claimCmsPublishQueue({ firestore: db, queueId, buildBatchId, commitSha,
    serializerId: "fixture-serializer", claimToken: "22222222-2222-4222-8222-222222222222" });
  await artifactOwner.reserveCmsPublishArtifact({ firestore: db, queueId, buildBatchId, commitSha });
  const batchRef = db.doc(`system/publicDeployment/buildBatches/${buildBatchId}`);
  const batch = (await batchRef.get()).data();
  const document = await current();
  const inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], programs: [], authors: [], settings: [],
    posts: document.publiclyVisible ? [{ kind: "post", documentId: config.postId, sourceVersion: document.published.sourceVersion,
      canonicalPath: `/posts/${document.published.metadata.slug}/`, aliases: (document.published.metadata.previousSlugs ?? []).map(slug => `/posts/${slug}/`),
      publishedSnapshot: document.published }] : [] });
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-static-return-"));
  returnDirectories.push(directory);
  const files = { "/": "<html>Current complete Home after removal</html>",
    "/posts/": "<html>Current complete listing</html>", "/feeds/news.xml": "<feed>Current complete feed</feed>",
    "/api/v1/content.json": "[]", "/pagefind/pagefind.js": "export const current = true;",
    "/search/meaning-index.json": "[]", "/sitemap.xml": "<urlset>Current sitemap</urlset>" };
  if (document.publiclyVisible) files[`/posts/${document.published.metadata.slug}/`] = "<!doctype html><html><body>Current static Post</body></html>";
  const contentKey = createHash("sha256").update(`cmsPosts/${config.postId}`).digest("hex");
  files["/_content-status.json"] = JSON.stringify({ schemaVersion: 1, buildBatchId, generation: batch.generation, commitSha,
    collections: ["cmsPages", "cmsPosts"], routes: document.publiclyVisible ? [{ path: `/posts/${document.published.metadata.slug}/`,
      source: "cms", contentKey, sourceVersion: document.published.sourceVersion }] : [] });
  for (const [route, bytes] of Object.entries(files)) {
    const target = path.join(directory, route.endsWith("/") ? `${route.slice(1)}index.html` : route.slice(1));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: directory, outputPath: `${directory}.json` });
  await rm(`${directory}.json`);
  const proof = batch.noBuildStaticInput ? await prepareStaticPostProof({ input: batch.noBuildStaticInput, artifact: inventory, prepared, distDirectory: directory }) : null;
  files["/_publication.json"] = await readFile(path.join(directory, "_publication.json"), "utf8");
  const manifest = manifestContract.createPublicMediaManifest({ reservation: batch,
    artifactInventory: inventory.families.map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(artifact => artifact.documentId) })), owners: inventory.owners });
  await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
  await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
  const candidate = { schemaVersion: 1, ...prepared, workerName: "njpbs-production",
    workerVersionId, workerVersionTag: candidateContract.publicWorkerCandidateTag(prepared),
    versionCreatedOn: "2026-10-09T04:00:00.000Z", wranglerVersion: "4.123.0",
    noBuildPost: { schemaVersion: 1, rendererSha: commitSha, postId: config.postId, enabled: !proof, authoritative: true },
    ...(proof ? { noBuildStatic: proof } : {}) };
  delete candidate.digestAlgorithm;
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, candidate });
  await writeback.recordCmsPublishArtifactInclusion({ firestore: db, queueId, artifactReceipt: inventory });
  let beforeAssetRead;
  const handler = createNoBuildPostWorker({ rendererSha: commitSha, cache: { async match() {}, async put() {} },
    render: async () => {
      if (!ordinary) throw new Error("Static serving must use sealed Assets");
      return "<!doctype html><html><body>Independent public fixture</body></html>";
    },
    getDecision: (path, method, probe) => publication.readNoBuildPostDecision({ firestore: db, path, rendererSha: commitSha, probe }),
    fetchAsset: async request => { const route = new URL(request.url).pathname;
      if (beforeAssetRead) await beforeAssetRead(route);
      return new Response(files[route] ?? "Old bytes must never leak", { status: files[route] === undefined ? 404 : 200,
        headers: { "content-type": route.endsWith(".json") ? "application/json" : "text/html" } }); },
  });
  const settle = lease => outcomeStore.settlePublicDeploymentOutcome({ firestore: db, lease,
    evidence: { action: "activate", buildBatchId, deploymentId: "44444444-4444-4444-8444-444444444444",
      versionId: candidate.workerVersionId, commitSha } });
  return { queueId, batch, batchRef, inventory, candidate, handler, files, directory, prepared, settle,
    onAssetRead: callback => { beforeAssetRead = callback; },
    acquire: () => coordinator.acquirePublicDeploymentLease({ firestore: db, buildBatchId, commitSha }) };
}

async function staleReturnWithPredecessor({ stale = true, ordinary = false } = {}) {
  const predecessor = await prepareStaticReturn({ queueId: "22222222222222222222", commitSha: sha, ordinary: true,
    workerVersionId: "66666666-6666-4666-8666-666666666666" });
  const previousLease = await predecessor.acquire();
  await predecessor.settle(previousLease.lease);
  await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: predecessor.queueId });
  expect((await publish()).code).toBe(200);
  await confirmDynamicPublication();
  const pending = await prepareStaticReturn({ ordinary });
  const acquired = await pending.acquire();
  if (stale) {
    await db.runTransaction(async transaction => {
      context.bumpPublicContextRevision(transaction, db);
    });
    if (!ordinary) await expect(pending.settle(acquired.lease)).rejects.toMatchObject({ status: 409 });
  }
  await outcomeStore.settlePublicDeploymentOutcome({ firestore: db, lease: acquired.lease, evidence: { action: "reconcile" } });
  return { predecessor, pending, lease: acquired.lease };
}
function restoreNetwork({ predecessor, pending, onPost, beforeRequest }) {
  let activeVersion = pending.candidate.workerVersionId;
  let deploymentId = "77777777-7777-4777-8777-777777777777";
  const input = { firestore: db, cloudflareApiToken: "t".repeat(40), buildBatchId: pending.batch.buildBatchId,
    predecessorBuildBatchId: predecessor.batch.buildBatchId,
    requestPublication: async url => {
      expect(new URL(url).searchParams.get("cms-context")).toBe("code");
      return predecessor.files["/_publication.json"];
    },
    requestJson: async request => {
      if (beforeRequest) await beforeRequest(request);
      const route = new URL(request.url).pathname;
      if (route.endsWith("/workers/scripts")) return { success: true, result: [{ id: "njpbs-production", tag: "d".repeat(32) }] };
      if (route.endsWith("/triggers")) return { success: true, result: [{ trigger_uuid: "11111111-1111-4111-8111-111111111111",
        external_script_id: "d".repeat(32), deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
        root_directory: "/", branch_includes: ["production"], branch_excludes: [] }] };
      if (!route.endsWith("/deployments")) throw new Error("Unexpected provider request");
      if (request.method === "POST") {
        expect(request.body).toEqual({ strategy: "percentage", versions: [{ version_id: predecessor.candidate.workerVersionId, percentage: 100 }] });
        activeVersion = predecessor.candidate.workerVersionId;
        deploymentId = "88888888-8888-4888-8888-888888888888";
        if (onPost) await onPost();
        throw new Error("Lost deployment response");
      }
      return { success: true, result: { deployments: [{ id: deploymentId, source: "api", strategy: "percentage",
        annotations: { "workers/triggered_by": "deployment" }, versions: [{ version_id: activeVersion, percentage: 100 }],
        created_on: "2026-10-09T05:00:00.000Z" }] } };
    } };
  return input;
}

describe("code verification with runtime admission", () => {
  it.each(["paused", "missing", "malformed"])("settles an ordinary code release while visible admission is %s", async mode => {
    await publish();
    await confirmDynamicPublication();
    const result = await prepareStaticReturn({ ordinary: true });
    if (mode === "paused") await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    else if (mode === "missing") await db.doc(admission.ADMISSION_PATH).delete();
    else await db.doc(admission.ADMISSION_PATH).set({ enabled: true });
    const acquired = await result.acquire();
    expect(acquired.outcome).toBe("acquired");
    expect((await publication.readNoBuildPostDecision({ firestore: db, path: "/_publication.json",
      rendererSha: result.candidate.commitSha,
      probe: { buildBatchId: result.batch.buildBatchId, versionId: result.candidate.workerVersionId } })).kind).toBe("baseline-probe");
    const fetchPublic = (url, init) => result.handler.fetch(new Request(url, init));
    expect((await fetchPublic("https://njpbs.org/posts/pilot-story/")).status).toBe(mode === "paused" ? 200 : 503);
    await recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate: result.candidate, fetchPublic });
    expect((await result.settle(acquired.lease)).outcome).toBe("deployed");
    expect((await state()).rendererSha).toBe(sha);
    expect((await db.doc(ownership.CAPABILITY_PATH).get()).data()).toEqual({ schemaVersion: 1,
      postId: config.postId, rendererSha: result.candidate.commitSha, servingEnabled: true, generation: result.candidate.generation });
  });
  it("refuses code evidence when admission changes during public readback", async () => {
    await publish();
    await confirmDynamicPublication();
    const result = await prepareStaticReturn({ ordinary: true });
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    await result.acquire();
    await expect(recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate: result.candidate,
      fetchPublic: async (url, init) => {
        const response = await result.handler.fetch(new Request(url, init));
        await db.doc(admission.ADMISSION_PATH).update({ enabled: true, revision: 3 });
        return response;
      } })).rejects.toThrow("Public admission changed");
  });
});

describe("one-Post static return", () => {
  it("refuses new family acceptance while a visible static owner exists and admits after the approved owner clear", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    expect((await result.settle(acquired.lease)).outcome).toBe("deployed");
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: result.queueId });
    const release = result.candidate.commitSha;
    await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 2, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
    await db.doc(ownership.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: release, servingEnabled: true, generation: result.candidate.generation });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release,
      serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" } });
    await db.doc("cmsPosts/second-post").set({ ...post(), id: "second-post", slug: "second-story" });
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
      now: () => "2026-10-11T19:00:00.000Z", enablePublishSnapshot: true, log: quiet,
      assertPublishReadyFn: async () => { throw new Error("Family acceptance must not use a full build"); } });
    const body = { collection: "cmsPosts", id: "second-post", baseVersion: 1, publish: true, document: {} };
    const retained = await state();
    const before = (await db.doc("cmsPosts/second-post").get()).data();
    const queues = (await db.collection("cmsPublishQueue").get()).size;
    const refused = await invoke(handler, body);
    expect(refused.code, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toContain("retained static Post");
    expect(await state()).toEqual(retained);
    expect((await db.doc("cmsPosts/second-post").get()).data()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(queues);
    // The coordinator clears this exact legacy owner only after its sealed
    // static routes and idle source have passed the cutover precheck.
    await db.doc(ownership.LEGACY_STATE_PATH).delete();
    const accepted = await invoke(handler, body);
    expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.publication.transport).toBe("post-no-build-v1");
    expect((await ownership.readNoBuildPostOwner({ firestore: db, postId: "second-post" })).state.runtime)
      .toEqual({ owner: "cloudflare", release });
  });
  it("restores a cloud-owned predecessor through retries and rejects another owner", async () => {
    const fixture = await staleReturnWithPredecessor();
    const runtime = { owner: "cloudflare", release: fixture.pending.batch.commitSha };
    // Model a retained cloud lease at the persisted boundary. All three owners
    // must agree before any provider traffic or terminal write is allowed.
    await db.doc("system/publicDeployment").update({ runtime });
    await fixture.pending.batchRef.update({ runtime });
    await fixture.pending.batchRef.collection("candidates").doc("worker").update({ runtime });
    const input = { ...restoreNetwork(fixture), runtime };
    const denied = vi.fn(async () => { throw new Error("Unexpected provider request"); });
    for (const wrongRuntime of [undefined, { owner: "node-compute", release: runtime.release },
      { owner: "cloudflare", release: "f".repeat(40) }]) {
      await expect(restorePublicWorkerPredecessor({ ...input, runtime: wrongRuntime,
        requestJson: denied })).rejects.toThrow("Another publication runtime");
    }
    expect(denied).not.toHaveBeenCalled();
    const ambiguous = await restorePublicWorkerPredecessor({ ...input, requestPublication: async () => "{}" });
    expect(ambiguous.outcome).toBe("reconciling");
    expect((await db.doc("system/publicDeployment").get()).data().runtime).toEqual(runtime);
    const restored = await restorePublicWorkerPredecessor(input);
    expect(restored.outcome).toBe("failed");
    expect(restored.receipt.restoredPredecessor.buildBatchId).toBe(fixture.predecessor.batch.buildBatchId);
    expect((await db.doc("system/publicDeployment").get()).data()).toMatchObject({ state: "idle", activeGeneration: 2 });
    const retry = await restorePublicWorkerPredecessor({ ...input, requestJson: denied, requestPublication: denied });
    expect(retry.idempotent).toBe(true);
    expect(retry.receipt).toEqual(restored.receipt);
    expect(denied).not.toHaveBeenCalled();
  });

  it("restores the exact predecessor after context movement and recovers dropped responses before fresh intent", async () => {
    const fixture = await staleReturnWithPredecessor();
    const owned = await state();
    const input = restoreNetwork(fixture);
    const restored = await restorePublicWorkerPredecessor(input);
    expect(restored.outcome).toBe("failed");
    expect(restored.receipt.restoredPredecessor).toMatchObject({ deploymentId: "88888888-8888-4888-8888-888888888888",
      versionId: fixture.predecessor.candidate.workerVersionId, generation: 2 });
    expect(await state()).toEqual(owned);
    const pointer = (await db.doc("system/publicDeployment").get()).data();
    expect(pointer).toMatchObject({ state: "idle", activeGeneration: 2, activeDeploymentId: "88888888-8888-4888-8888-888888888888",
      lastReservedGeneration: 3, newestEligibleGeneration: 2, newestEligibleBuildBatchId: fixture.predecessor.batch.buildBatchId });
    expect((await db.doc(`cmsPublishQueue/${fixture.pending.queueId}`).get()).data().status).toBe("failed");
    expect((await serializer.claimCmsPublishQueue({ firestore: db, queueId: fixture.pending.queueId,
      buildBatchId: fixture.pending.batch.buildBatchId, commitSha: fixture.pending.batch.commitSha,
      serializerId: "fixture-serializer", claimToken: "22222222-2222-4222-8222-222222222222" })).outcome).toBe("terminal");
    const retry = await restorePublicWorkerPredecessor({ ...input, requestJson: async () => { throw new Error("Unexpected retry network"); },
      requestPublication: async () => { throw new Error("Unexpected retry probe"); } });
    expect(retry.idempotent).toBe(true);
    expect(retry.receipt).toEqual(restored.receipt);
    const reorderedReceipt = Object.fromEntries(Object.entries(restored.receipt.restoredPredecessor).reverse());
    const reorderedReplay = await outcomeStore.settlePublicDeploymentOutcome({ firestore: db, lease: fixture.lease,
      evidence: { action: "restore-predecessor", buildBatchId: fixture.pending.batch.buildBatchId, predecessor: reorderedReceipt } });
    expect(reorderedReplay.idempotent).toBe(true);
    expect(reorderedReplay.receipt).toEqual(restored.receipt);
    await baselineRecovery.recoverCmsPublicationBaseline({ firestore: db, queueId: "99999999999999999999", commitSha: "b".repeat(40),
      expected: Object.fromEntries(["activeGeneration", "lastReservedGeneration", "activeDeploymentId", "activeCommitSha"].map(field => [field, pointer[field]])) });
    const recoveryBuild = await prepareStaticReturn({ queueId: "99999999999999999999", ordinary: true, enqueue: false });
    const recoveryLease = await recoveryBuild.acquire();
    await recoveryBuild.settle(recoveryLease.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: recoveryBuild.queueId });
    const renewed = await prepareStaticReturn({ queueId: "77777777777777777777" });
    const renewedLease = await renewed.acquire();
    await renewed.settle(renewedLease.lease);
    expect((await renewed.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
    expect((await state()).mode).toBe("static");
  });
  it.each([
    { ordinary: false, message: "not eligible" },
    { ordinary: true, message: "Only a stale static candidate" },
  ])("refuses predecessor restore for current or ordinary input (ordinary=$ordinary)", async ({ ordinary, message }) => {
    const fixture = await staleReturnWithPredecessor({ stale: false, ordinary });
    const deny = vi.fn(async () => { throw new Error("Unexpected provider request"); });
    await expect(restorePublicWorkerPredecessor({ ...restoreNetwork(fixture), requestJson: deny,
      requestPublication: deny })).rejects.toThrow(message);
    expect(deny).not.toHaveBeenCalled();
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("reconciling");
  });
  it("refuses wrong predecessor evidence and a lease that moves before restore traffic", async () => {
    const fixture = await staleReturnWithPredecessor();
    const deny = async () => { throw new Error("Unexpected provider request"); };
    const input = restoreNetwork(fixture);
    await expect(restorePublicWorkerPredecessor({ ...input, predecessorBuildBatchId: "wrong-predecessor", requestJson: deny })).rejects.toThrow("incomplete");
    const previousRef = db.doc(`system/publicDeployment/buildBatches/${fixture.predecessor.batch.buildBatchId}/candidates/worker`);
    const original = (await previousRef.get()).data();
    await previousRef.update({ workerVersionId: "99999999-9999-4999-8999-999999999999" });
    await expect(restorePublicWorkerPredecessor({ ...input, requestJson: deny })).rejects.toThrow("preserve");
    await previousRef.set(original);
    const missingGuard = { ...original }; delete missingGuard.noBuildPost;
    await previousRef.set(missingGuard);
    await expect(restorePublicWorkerPredecessor({ ...input, requestJson: deny })).rejects.toThrow("preserve");
    await previousRef.set(original);
    const manifestRef = manifestStore.publicMediaManifestRef(db, fixture.predecessor.batch.buildBatchId);
    const manifest = (await manifestRef.get()).data();
    await manifestRef.update({ mediaManifestDigest: "f".repeat(64) });
    await expect(restorePublicWorkerPredecessor({ ...input, requestJson: deny })).rejects.toThrow("completion");
    await manifestRef.set(manifest);
    await expect(outcomeStore.readPublicDeploymentPredecessorRestore({ firestore: db, buildBatchId: fixture.pending.batch.buildBatchId,
      predecessorBuildBatchId: fixture.predecessor.batch.buildBatchId })).resolves.toHaveProperty("predecessor");
    let moved = false; let posts = 0;
    const racing = restoreNetwork({ ...fixture, beforeRequest: async request => {
      if (request.method === "POST") posts++;
      if (!moved && request.url.endsWith("/triggers")) {
        moved = true;
        await db.runTransaction(async transaction => {
          transaction.update(db.doc("system/publicDeployment"), { leaseToken: "another-lease" });
          transaction.update(fixture.pending.batchRef, { leaseToken: "another-lease" });
        });
      }
    } });
    await expect(restorePublicWorkerPredecessor(racing)).rejects.toThrow();
    expect(posts).toBe(0);
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("reconciling");
  });
  it("retains reconciliation on wrong restored bytes and keeps withdrawal absent during predecessor restore", async () => {
    const fixture = await staleReturnWithPredecessor();
    const input = restoreNetwork(fixture);
    const ambiguous = await restorePublicWorkerPredecessor({ ...input, requestPublication: async () => "{}" });
    expect(ambiguous.outcome).toBe("reconciling");
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("reconciling");
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-09T05:00:00.000Z", log: quiet });
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" })).code).toBe(200);
    expect((await fixture.pending.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    const withdrawn = await state();
    await db.doc(`cmsPublishQueue/${fixture.pending.queueId}`).update({ status: "failed" });
    const restored = await restorePublicWorkerPredecessor(input);
    expect(restored.outcome).toBe("failed");
    expect(await state()).toEqual(withdrawn);
    expect((await db.doc(`cmsPublishQueue/${fixture.pending.queueId}`).get()).data().status).toBe("failed");
    expect((await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
  });
  it.each(["pending", "failed"])("clears the dynamic proof projection when static return activates (%s)", async proofStatus => {
    await publish();
    const owned = await state();
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
      fetchPublic: async () => { throw new Error("Synthetic public failure"); } });
    await db.doc(`cmsPublishQueue/${owned.operationId}`).update({ "postProof.status": proofStatus });
    await db.doc(`cmsPosts/${config.postId}`).update({ "publicPostProof.status": proofStatus });
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    await result.settle(acquired.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: result.queueId });
    expect((await state()).mode).toBe("static");
    expect((await current()).publicPostProof).toBeUndefined();
    const endpoint = getContent.createCmsGetContentHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet });
    const metadata = (await invoke(endpoint, { collection: "cmsPosts", id: config.postId, publicationOnly: true })).body.publication;
    expect(metadata.postProofPending).toBeUndefined();
    expect(metadata.postProofWarning).toBeUndefined();
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
  });
  it("defers a due static Post during the code lease without losing its schedule", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    await result.settle(acquired.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: result.queueId });
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-09T04:10:00.000Z", log: quiet });
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "revise" })).code).toBe(200);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 3,
      scheduleAt: "2026-10-10T12:00:00.000Z", document: {} })).code).toBe(200);
    const scheduled = await current();
    const revision = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision;
    await db.doc("system/publicDeployment").set(leasedPointer());
    const run = scheduledPublish.createScheduledPublishRunner({ firestore: db, now: () => "2026-10-10T12:00:00.000Z",
      assertPublishReadyFn: async () => ({ transport: "serializer" }), log: quiet });
    await expect(run()).resolves.toMatchObject({ publishedCount: 0, queueId: null, changes: [] });
    expect(await current()).toEqual(scheduled);
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(revision);
    expect((await db.collection("cmsPublishQueue").where("status", "==", "reserved").get()).empty).toBe(true);
    await db.doc("cmsPosts/earlier-post").set({ ...scheduled, id: "earlier-post", slug: "earlier-story",
      status: "scheduled", publishAt: "2026-10-10T11:00:00.000Z" });
    await db.doc("cmsPosts/z-later-post").set({ ...scheduled, id: "z-later-post", slug: "later-story",
      status: "scheduled", publishAt: "2026-10-10T12:00:00.000Z" });
    const queued = await run();
    expect((await db.doc("cmsPosts/earlier-post").get()).data().scheduledPublishFailure).toBeUndefined();
    expect((await db.doc("cmsPosts/z-later-post").get()).data().scheduledPublishFailure).toBeUndefined();
    expect(queued.publishedCount).toBe(2);
    expect(queued.changes.map(change => change.id)).toEqual(["earlier-post", "z-later-post"]);
    expect(await current()).toEqual(scheduled);
    expect((await db.doc(`cmsPublishQueue/${queued.queueId}`).get()).data()).toMatchObject({ status: "pending",
      transport: "serializer", changes: queued.changes });
    await db.doc("system/publicDeployment").set({ ...pointer(), activeGeneration: 2, lastReservedGeneration: 2,
      newestEligibleGeneration: 2 });
    await expect(run()).resolves.toMatchObject({ publishedCount: 1 });
    const published = await current();
    expect(published.status).toBe("published");
    expect(published.scheduledPublishFailure).toBeUndefined();
    expect((await db.doc(`cmsPublishQueue/${published.publishBuildQueueId}`).get()).data().transport).toBe("serializer");
  });
  beforeEach(() => vi.stubEnv("CMS_PUBLISH_TRANSPORT", "serializer"));
  it("retains exact operator intent and idempotent queue identity without treating pause as return", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const input = { firestore: db, queueId: "11111111111111111111", commitSha: "b".repeat(40), returnPostId: config.postId };
    const first = await baseline.enqueueCmsPublicationBaseline(input);
    expect(first.idempotent).toBe(false);
    expect((await baseline.enqueueCmsPublicationBaseline(input)).idempotent).toBe(true);
    await expect(baseline.enqueueCmsPublicationBaseline({ ...input, returnPostId: undefined })).rejects.toThrow("another request");
    const queue = (await db.doc(`cmsPublishQueue/${input.queueId}`).get()).data();
    expect(queue.noBuildStaticReturn).toMatchObject({ operationId: (await state()).operationId, sourceVersion: 2, visible: true });
    expect((await state()).mode).toBeUndefined();
    await db.doc("system/publicDeployment/contexts/public").update({ revision: 99 });
    await expect(artifactOwner.reserveCmsPublishArtifact({ ...input, buildBatchId: `cms-${input.queueId}` })).rejects.toMatchObject({ status: 409 });
    expect((await db.doc(`system/publicDeployment/buildBatches/cms-${input.queueId}`).get()).exists).toBe(false);
  });
  it("serves sealed static routes before settlement, commits the next context and recovers a lost response", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    // An established cloud aggregate authority must not preempt the existing
    // static candidate's complete artifact proof before activation.
    const publicContext = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
    await db.doc("system/publicDeployment/aggregateContexts/current").set({ schemaVersion: 1,
      operationId: "E".repeat(20), runtime: { owner: "cloudflare", release: sha },
      contextRevision: publicContext.revision, contextDigest: context.publicContextDigest(publicContext.revision),
      servingEstablished: true, baselineWithdrawalRevision: publicContext.withdrawalRevision ?? 0 });
    await db.doc(`cmsPublishQueue/${"E".repeat(20)}`).set({ schemaVersion: 1, transport: "public-context-no-build-v1",
      status: "success", runtime: { owner: "cloudflare", release: sha }, changes: [],
      publicContext: { operationId: "E".repeat(20), contextRevision: publicContext.revision,
        contextDigest: context.publicContextDigest(publicContext.revision) } });
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    expect(acquired.outcome).toBe("acquired");
    const served = await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"));
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("Current static Post");
    expect(served.headers.get("x-njpbs-content-source")).toBe("cms-static-return");
    expect((await result.handler.fetch(new Request("https://njpbs.org/pagefind/retired.pf_fragment"))).status).toBe(404);
    await recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate: result.candidate,
      fetchPublic: (url, init) => result.handler.fetch(new Request(url, init)) });
    const beforeRevision = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision;
    const first = await result.settle(acquired.lease);
    const retry = await result.settle(acquired.lease);
    expect(first.outcome).toBe("deployed");
    expect(retry.idempotent).toBe(true);
    const owned = await state();
    expect(owned.mode).toBe("static");
    expect(owned.servingEnabled).toBe(false);
    expect(owned.staticProof.contextDigest).toBe(context.publicContextDigest(beforeRevision + 1));
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(beforeRevision + 1);
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
    const publicationReceipt = await (await result.handler.fetch(new Request("https://njpbs.org/_publication.json"))).json();
    const contentStatus = await (await result.handler.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    expect(readPublicContentStatus(contentStatus, publicationReceipt)).toMatchObject([{ path: "/posts/pilot-story/", sourceVersion: 2 }]);
    expect((await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: result.queueId })).outcome).toBe("success");
    expect((await state()).operationId).toBe(owned.operationId);
  });
  it("retains the same proof through reconciliation and leaves dynamic ownership after terminal failure", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    const reconciling = await outcomeStore.settlePublicDeploymentOutcome({ firestore: db, lease: acquired.lease,
      evidence: { action: "reconcile" } });
    expect(reconciling.outcome).toBe("reconciling");
    expect((await result.batchRef.get()).data().noBuildStaticInput).toEqual(result.batch.noBuildStaticInput);
    const resumed = await result.acquire();
    expect(resumed.idempotent).toBe(true);
    expect(resumed.lease.leaseToken).toBe(acquired.lease.leaseToken);
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
    const failed = await outcomeStore.settlePublicDeploymentOutcome({ firestore: db, lease: acquired.lease,
      evidence: { action: "terminal-failure", buildBatchId: result.batch.buildBatchId, outcome: "fail" } });
    expect(failed.outcome).toBe("failed");
    expect((await state()).mode).toBeUndefined();
    expect((await state()).operationId).toBe(result.candidate.noBuildStatic.operationId);
    expect((await decision("/posts/pilot-story/")).kind).toBe("post");
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(503);
  });

  it("rejects changed context, malformed proof and stale bytes through the existing owners", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    expect(() => staticReturn.projectStaticProof({ ...result.candidate.noBuildStatic, untrusted: true })).toThrow();
    expect(() => staticReturn.projectStaticProof({ ...result.candidate.noBuildStatic, files: result.candidate.noBuildStatic.files.slice(1) })).toThrow();
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 77 });
    await expect(result.acquire()).rejects.toMatchObject({ status: 409 });
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
    await result.acquire();
    result.files["/posts/pilot-story/"] = "<!doctype html><html><body>Stale bytes</body></html>";
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(503);
    await expect(prepareStaticPostProof({ input: result.batch.noBuildStaticInput, artifact: result.inventory,
      prepared: result.prepared, distDirectory: result.directory })).resolves.toBeDefined();
    await writeFile(path.join(result.directory, "feeds/news.xml"), "stale complete feed");
    await expect(prepareStaticPostProof({ input: result.batch.noBuildStaticInput, artifact: result.inventory,
      prepared: result.prepared, distDirectory: result.directory })).rejects.toThrow();
  });
  it("gives a concurrent withdrawal immediate absence and refuses terminal restoration", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: { enabled: false, postId: "" }, now: () => "2026-10-09T04:00:00.000Z", log: quiet });
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" })).code).toBe(200);
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    expect((await result.handler.fetch(new Request("https://njpbs.org/feeds/news.xml"))).status).toBe(503);
    await expect(result.settle(acquired.lease)).rejects.toMatchObject({ status: 409 });
    expect((await state()).mode).toBeUndefined();
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("deploying");
  });
  it("keeps retained aliases and gives a withdrawal during Assets fetch immediate absence", async () => {
    expect((await publish()).code).toBe(200);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: 2, slug: "pilot-renamed", document: {} })).code).toBe(200);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: 3, publish: true, document: {} })).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    const alias = await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"));
    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/posts/pilot-renamed/");
    result.onAssetRead(async route => {
      if (route !== "/posts/pilot-renamed/") return;
      const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
        noBuildConfig: { enabled: false, postId: "" }, now: () => "2026-10-09T04:00:00.000Z", log: quiet });
      expect((await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 4, action: "unpublish" })).code).toBe(200);
    });
    const withdrawn = await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-renamed/"));
    expect(withdrawn.status).toBe(410);
    expect(await withdrawn.text()).toBe("");
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    await expect(result.settle(acquired.lease)).rejects.toMatchObject({ status: 409 });
  });

  it("resumes ordinary serializer publish and withdrawal without re-enabling stale true flags", async () => {
    expect((await publish()).code).toBe(200);
    await confirmDynamicPublication();
    const result = await prepareStaticReturn();
    const acquired = await result.acquire();
    await result.settle(acquired.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: result.queueId });
    const originalOperation = (await state()).operationId;
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
      noBuildConfig: config, now: () => "2026-10-09T04:10:00.000Z", log: quiet });
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "revise" })).code).toBe(200);
    expect((await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 3,
      document: { title: "Next normal publication" } })).code).toBe(200);
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
    const normalPublish = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 4,
      publish: true, document: {} });
    expect(normalPublish.code, JSON.stringify(normalPublish.body)).toBe(200);
    const document = await current();
    expect((await db.doc(`cmsPublishQueue/${document.publishBuildQueueId}`).get()).data().transport).toBe("serializer");
    expect((await state()).operationId).toBe(originalOperation);
    expect((await result.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(503);
    const next = await prepareStaticReturn({ queueId: document.publishBuildQueueId, returnPostId: undefined,
      commitSha: "b".repeat(40), enqueue: false });
    const nextLease = await next.acquire();
    await next.settle(nextLease.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: next.queueId });
    expect((await next.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(200);
    await expect(db.runTransaction(transaction => publication.assertNoBuildScheduleInTransaction({ firestore: db,
      transaction, collection: "cmsPosts", documentId: config.postId }))).resolves.toBeUndefined();
    expect(await recovery.existingNoBuildPostPublication({ firestore: db,
      changes: [{ collection: "cmsPosts", id: config.postId, sourceVersion: (await current()).published.sourceVersion }] })).toBeNull();
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, action: "revise" })).code).toBe(200);
    const scheduled = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, scheduleAt: "2026-10-10T12:00:00.000Z", document: {} });
    expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
    expect((await current()).status).toBe("scheduled");
    expect((await invoke(transition, { collection: "cmsPosts", id: config.postId,
      baseVersion: (await current()).version, action: "unpublish" })).code).toBe(200);
    expect((await next.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    expect((await db.doc(`cmsPublishQueue/${(await current()).publishBuildQueueId}`).get()).data().transport).toBe("serializer");
    expect((await state()).operationId).toBe(originalOperation);
    expect((await state()).ownedSlugs).toContain("pilot-story");
    const withdrawn = await prepareStaticReturn({ queueId: (await current()).publishBuildQueueId,
      returnPostId: undefined, commitSha: "b".repeat(40), enqueue: false });
    const withdrawnLease = await withdrawn.acquire();
    await recovery.verifyNoBuildPostPublicRoute({ firestore: db, candidate: withdrawn.candidate,
      fetchPublic: (url, init) => withdrawn.handler.fetch(new Request(url, init)) });
    await withdrawn.settle(withdrawnLease.lease);
    await writeback.settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: withdrawn.queueId });
    expect((await state()).staticProof.visible).toBe(false);
    expect((await withdrawn.handler.fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    expect((await withdrawn.handler.fetch(new Request("https://njpbs.org/feeds/news.xml"))).status).toBe(200);
    const inventory = await (await withdrawn.handler.fetch(new Request("https://njpbs.org/_content-status.json"))).json();
    expect(inventory.routes).toEqual([]);
  });
});

describe("operator runtime admission", () => {
  function runtimeSave() {
    return save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
      now: () => "2026-10-08T12:00:00.000Z", enablePublishSnapshot: true,
      assertPublishReadyFn: async () => ({ transport: "serializer" }), log: quiet });
  }
  it("rejects a Firestore byte value in place of the families map", async () => {
    await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 2, enabled: true,
      families: Buffer.alloc(0), backgroundBucket: "fixture-bucket" });
    const projected = await familyAdmission.readNoBuildFamilyAdmission({ firestore: db, env: {} });
    expect(projected).toEqual({ valid: false, enabled: false, families: {}, backgroundBucket: "", admissionRevision: null });
    expect(familyAdmission.admitsNoBuildPost(projected, "second-post")).toBe(false);
  });

  it("reads changed family admission in the same running legacy handler", async () => {
    const handler = runtimeSave();
    expect((await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 1,
      publish: true, document: {} })).code).toBe(200);
    const retained = await state();
    const pilot = await familyAdmission.readNoBuildFamilyAdmission({ firestore: db, env: {} });
    expect(pilot.families).toEqual({ posts: { mode: "ids", ids: [config.postId] } });
    expect((await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2,
      publish: false, slug: "pilot-renamed", document: {} })).code).toBe(200);
    await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 2, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
    const all = await db.runTransaction(transaction => familyAdmission.readNoBuildFamilyAdmission({
      firestore: db, transaction, env: {} }), { readOnly: true });
    expect(all).toMatchObject({ valid: true, enabled: true, admissionRevision: 2 });
    expect(familyAdmission.admitsNoBuildPost(all, config.postId)).toBe(true);
    expect(familyAdmission.admitsNoBuildPost(all, "second-post")).toBe(true);
    expect((await admission.readNoBuildAdmission({ firestore: db, env: {} })).valid).toBe(false);
    expect((await decision("/posts/pilot-story/")).receipt).toMatchObject({ operationId: retained.operationId, admissionRevision: 2 });
    expect((await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 3,
      publish: true, document: {} })).code).toBe(200);
    expect(await state()).toMatchObject({ postId: config.postId, slug: "pilot-renamed", sourceVersion: 4, admissionRevision: 2 });
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 3 });
    const paused = await familyAdmission.readNoBuildFamilyAdmission({ firestore: db, env: {} });
    expect(paused).toMatchObject({ valid: true, enabled: false, admissionRevision: 3 });
    expect(familyAdmission.admitsNoBuildPost(paused, "second-post")).toBe(false);
    await db.doc(admission.ADMISSION_PATH).delete();
    expect(await familyAdmission.readNoBuildFamilyAdmission({ firestore: db, env: {} })).toMatchObject({
      valid: false, enabled: false, admissionRevision: null });
  });

  it("reads changes without rebuilding the handler and retains each admission revision", async () => {
    const handler = runtimeSave();
    const request = { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} };
    expect((await invoke(handler, request)).code).toBe(200);
    expect((await invoke(handler, { ...request, publish: false, baseVersion: 2, slug: "pilot-renamed" })).code).toBe(200);
    const first = await state();
    expect(first.admissionRevision).toBe(1);
    expect((await decision("/posts/pilot-story/")).receipt.admissionRevision).toBe(1);
    await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
    const paused = await invoke(handler, { ...request, baseVersion: 3 });
    expect(paused.code, JSON.stringify(paused.body)).toBe(409);
    expect(await decision("/posts/pilot-story/")).toMatchObject({ kind: "post",
      receipt: { operationId: first.operationId, admissionRevision: 2 } });
    expect((await state()).operationId).toBe(first.operationId);
    await db.doc(admission.ADMISSION_PATH).update({ enabled: true, revision: 3 });
    expect((await invoke(handler, { ...request, baseVersion: 3 })).code).toBe(200);
    const next = await state();
    expect(next.admissionRevision).toBe(3);
    expect(next.operationId).not.toBe(first.operationId);
    expect((await db.doc(`cmsPublishQueue/${first.operationId}`).get()).data().noBuildPost.admissionRevision).toBe(1);
    expect((await decision("/posts/pilot-story/")).receipt.admissionRevision).toBe(3);
  });

  it("atomically refuses admission appearing after a save reserved no publication queue", async () => {
    expect((await publish()).code).toBe(200);
    expect((await invoke(runtimeSave(), { collection: "cmsPosts", id: config.postId, baseVersion: 2,
      publish: false, slug: "pilot-renamed", document: {} })).code).toBe(200);
    const beforeDocument = await current();
    const beforeState = await state();
    const beforeContext = (await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data();
    const beforeQueues = (await db.collection("cmsPublishQueue").get()).size;
    const second = { ...post(), id: "second-post", slug: "second-story" };
    await db.doc("cmsPosts/second-post").set(second);
    await db.doc(ownership.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
      serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    await db.doc(admission.ADMISSION_PATH).delete();
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
      now: () => "2026-10-08T12:00:00.000Z", enablePublishSnapshot: true, log: quiet,
      assertPublishReadyFn: async () => {
        // Admission changes while the external publication transport is checked.
        await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 2, enabled: true,
          families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
        return { transport: "github" };
      } });
    const response = await invoke(handler, { collection: "cmsPosts", id: "second-post", baseVersion: 1,
      publish: true, document: {} });
    expect(response.code, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error).toBe("Publication admission changed. Retry this save.");
    expect(await current()).toEqual(beforeDocument);
    expect((await db.doc("cmsPosts/second-post").get()).data()).toEqual(second);
    expect(await state()).toEqual(beforeState);
    expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data()).toEqual(beforeContext);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(beforeQueues);
  });

  it.each(["missing", "invalid", "legacy mismatch"])("protects owned routes and permits withdrawal with %s admission", async failure => {
    expect((await invoke(runtimeSave(), { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} })).code).toBe(200);
    if (failure === "missing") await db.doc(admission.ADMISSION_PATH).delete();
    if (failure === "invalid") await db.doc(admission.ADMISSION_PATH).update({ revision: "2" });
    if (failure === "legacy mismatch") vi.stubEnv("NO_BUILD_POST_ID", "other-post");
    try {
      await expect(decision("/posts/pilot-story/")).rejects.toThrow("Private read refused");
      const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db,
        requirePrincipalFn: async () => actor, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
      const removal = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
      expect(removal.code).toBe(200);
      const response = await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"));
      expect(response.status).toBe(410);
      expect(response.headers.get("x-njpbs-admission-revision")).toBe(failure === "legacy mismatch" ? "1" : "unavailable");
      await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge,
        fetchPublic: async (url, init) => worker().fetch(new Request(url, init)) });
      expect(await current()).toMatchObject({ publishBuildPending: true,
        publishBuildQueueId: removal.body.publication.homeFullBuildQueueId });
      expect((await db.doc(`cmsPublishQueue/${(await state()).operationId}`).get()).data().status).toBe("success");
      expect((await db.doc(`cmsPublishQueue/${removal.body.publication.homeFullBuildQueueId}`).get()).data())
        .toMatchObject({ status: "pending", transport: "serializer" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses a legacy environment mismatch and then observes its removal without a restart", async () => {
    const handler = runtimeSave();
    const request = { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} };
    expect((await invoke(handler, request)).code).toBe(200);
    expect((await invoke(handler, { ...request, publish: false, baseVersion: 2, slug: "pilot-renamed" })).code).toBe(200);
    vi.stubEnv("NO_BUILD_POST_ENABLED", "false");
    try {
      const paused = await invoke(handler, { ...request, baseVersion: 3 });
      expect(paused.code, JSON.stringify(paused.body)).toBe(409);
      await expect(decision("/posts/pilot-story/")).rejects.toThrow("Private read refused");
    } finally { vi.unstubAllEnvs(); }
    expect((await invoke(handler, { ...request, baseVersion: 3 })).code).toBe(200);
    expect((await state()).admissionRevision).toBe(1);
  });

  it("serves verified withdrawal families and public receipts while admission stays paused", async () => {
    expect((await invoke(runtimeSave(), { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} })).code).toBe(200);
    await db.doc(admission.ADMISSION_PATH).update({ revision: 2, enabled: false });
    const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db,
      requirePrincipalFn: async () => actor, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
    expect((await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" })).code).toBe(200);
    const boundary = await backgroundStorageFixture("fixture-bucket");
    try {
      const paths = { listings: ["/posts/"], authors: [], feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json"],
        sitemap: ["/sitemap.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
      const owner = backgroundOutputs.createPostBackgroundOutputs({ firestore: db,
        runtime: { owner: "node-compute", release: sha }, enabled: true, accepting: false,
        postIds: [config.postId], contentApiEnabled: true,
        artifacts: backgroundStorage.createPostBackgroundStorage("fixture-bucket", app),
        readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
        build: async task => ({ input: { kind: "public-background", rendererSha: sha, contextDigest: task.contextDigest, routes: [] },
          files: paths[task.output].map(path => ({ path, contentType: "text/html; charset=utf-8", bytes: Buffer.from("Current output without withdrawn content") })) }) });
      await owner.recover();
      expect((await decision("/posts/")).headers["x-njpbs-background-purge-tag"]).toBe("njpbs-post-background");
      vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
      try {
        expect((await decision("/posts/")).headers["x-njpbs-background-purge-tag"]).toBe("njpbs-dev-post-background");
        vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "emulator");
        expect((await decision("/posts/")).headers["x-njpbs-background-purge-tag"]).toBe("njpbs-post-background");
        vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
        const invalidTarget = await invoke(publicContent.createCmsGetPublicPageHandler({ firestore: db, log: quiet }),
          { mode: "no-build-post-v1", path: "/posts/", rendererSha: sha });
        expect(invalidTarget.code).toBe(503);
      } finally { vi.unstubAllEnvs(); }
      for (const path of ["/posts/", "/feeds/news.xml", "/sitemap.xml", "/api/v1/content.json", "/pagefind/pagefind.js"]) {
        const response = await worker().fetch(new Request(`https://njpbs.org${path}`));
        expect(response.status, path).toBe(200);
        expect(response.headers.get("x-njpbs-admission-revision")).toBe("2");
        expect(await response.text()).toBe("Current output without withdrawn content");
      }
      const receipts = await worker().fetch(new Request("https://njpbs.org/_content-status.json"));
      expect(receipts.status).toBe(200);
      expect((await receipts.json()).routes).not.toContainEqual(expect.objectContaining({ path: "/posts/pilot-story/" }));
      expect((await worker().fetch(new Request("https://njpbs.org/posts/pilot-story/"))).status).toBe(410);
    } finally { await boundary.close(); }
  });

  it("refuses the later proof if admission changes after publication success", async () => {
    expect((await invoke(runtimeSave(), { collection: "cmsPosts", id: config.postId, baseVersion: 1, publish: true, document: {} })).code).toBe(200);
    const owned = await state();
    const before = await decision("/posts/pilot-story/");
    const html = "<!doctype html><html><body>Current Post</body></html>";
    await recovery.recoverNoBuildPostDetail({ firestore: db, purgeConfig, fetchPurge, fetchPublic: async () => {
      await db.doc(admission.ADMISSION_PATH).update({ revision: 2, enabled: false });
      return new Response(html, { headers: { "cache-control": "no-store", "x-njpbs-content-source": "cms-no-build",
        "x-njpbs-publication-operation": owned.operationId, "x-njpbs-source-version": String(owned.sourceVersion),
        "x-njpbs-renderer-sha": sha, "x-njpbs-context-sha256": before.receipt.contextDigest,
        "x-njpbs-admission-revision": "1", "x-njpbs-html-sha256": createHash("sha256").update(html).digest("hex") } });
    } });
    expect((await current()).publishBuildPending).toBe(false);
    expect((await current()).publicPostProof.status).toBe("failed");
    expect((await db.doc(`cmsPublishQueue/${owned.operationId}`).get()).data().publicReceipt).toBeUndefined();
  });
});


describe("uploaded Post media admission", () => {
  const uploaded = { lifecycle: "active", source: "upload", mimeType: "image/webp", width: 1600, height: 900,
    url: "https://media.njpbs.org/cms-media/news/shared/hash.webp", altText: "Library suggestion", credit: "Current photographer" };
  const projection = { url: uploaded.url, altText: uploaded.altText, mimeType: uploaded.mimeType,
    width: uploaded.width, height: uploaded.height, credit: uploaded.credit };
  async function setup() {
    await db.doc(publication.STATE_PATH).delete();
    await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 2, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
    await db.doc(ownership.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
      serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
    await db.doc("media_assets/shared-upload").set(uploaded);
    await db.doc("media_assets_public/shared-upload").set(projection);
    await db.doc(`cmsPosts/${config.postId}`).update({ heroImage: "shared-upload", heroImageAlt: "Context written on Post",
      heroImageCaption: "Frozen Post caption" });
  }
  const editor = { ...actor, principal: { id: actor.uid, grants: [{ role: "editor" }] } };
  function handler() {
    return save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => editor,
      now: () => "2026-10-08T12:00:00.000Z", enablePublishSnapshot: true, log: quiet,
      assertPublishReadyFn: async () => { throw new Error("Ready uploads must not require a serializer"); } });
  }
  const request = id => ({ collection: "cmsPosts", id, baseVersion: 1, publish: true, document: {} });
  it("lets an ordinary Editor publish two Posts sharing one ready upload through independent existing owners", async () => {
    await setup();
    await db.doc("cmsPosts/second-upload-post").set({ ...(await current()), id: "second-upload-post", slug: "second-upload-story" });
    for (const id of [config.postId, "second-upload-post"]) {
      const response = await invoke(handler(), request(id));
      expect(response.code, JSON.stringify(response.body)).toBe(200);
      const doc = (await db.doc(`cmsPosts/${id}`).get()).data();
      expect(doc.published.metadata).toMatchObject({ heroImage: "shared-upload", heroImageCaption: "Frozen Post caption" });
      for (const state of ["working", "published"]) {
        expect((await db.doc(`cmsPosts/${id}/mediaUsage/${state}`).get()).data()).toMatchObject({ assetIds: ["shared-upload"], state });
      }
      const owner = await ownership.readNoBuildPostOwner({ firestore: db, postId: id });
      expect(owner.state).toMatchObject({ postId: id, visible: true });
      expect((await db.doc(`cmsPublishQueue/${owner.state.operationId}`).get()).data()).toMatchObject({ transport: "post-no-build-v1" });
      expect((await db.collection(`cmsPublishQueue/${owner.state.operationId}/backgroundOutputs`).get()).size).toBe(6);
    }
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  });
  it("keeps a published upload readable through the next real reservation, lease, candidate probe and activation", async () => {
    await db.doc("media_assets/shared-upload").set(uploaded);
    await db.doc("media_assets_public/shared-upload").set(projection);
    await db.doc(`cmsPosts/${config.postId}`).update({ heroImage: "shared-upload", heroImageAlt: "Context written on Post" });
    expect((await invoke(saveHandler(editor), request(config.postId))).code).toBe(200);
    await confirmDynamicPublication();
    const pending = await prepareStaticReturn({ ordinary: true });
    expect((await decision("/posts/pilot-story/")).kind).toBe("post");
    const acquired = await pending.acquire();
    expect((await db.doc("system/publicDeployment").get()).data().state).toBe("deploying");
    const read = path => publication.readNoBuildPostDecision({ firestore: db, path, rendererSha: pending.candidate.commitSha });
    expect((await read("/posts/pilot-story/")).published.assets[0].credit).toBe(uploaded.credit);
    expect((await publication.readNoBuildPostDecision({ firestore: db, path: "/_publication.json", rendererSha: pending.candidate.commitSha,
      probe: { buildBatchId: pending.batch.buildBatchId, versionId: pending.candidate.workerVersionId } })).kind).toBe("baseline-probe");
    expect((await pending.settle(acquired.lease)).outcome).toBe("deployed");
    expect((await read("/posts/pilot-story/")).published.assets[0].credit).toBe(uploaded.credit);
  });
  it.each(["missing private", "missing public", "stale credit", "tombstone", "purging", "MIME", "origin", "dimensions",
    "replacement", "not ready", "deploying", "generation"])("refuses %s upload without partial content, usage, owner or queue writes", async kind => {
    await setup();
    if (kind === "missing private") await db.doc("media_assets/shared-upload").delete();
    if (kind === "missing public") await db.doc("media_assets_public/shared-upload").delete();
    if (kind === "stale credit") await db.doc("media_assets/shared-upload").update({ credit: "Changed current credit" });
    if (kind === "tombstone" || kind === "purging") await db.doc("media_assets/shared-upload").update({ lifecycle: kind === "tombstone" ? "tombstoned" : "purging" });
    for (const [name, patch] of [["MIME", { mimeType: "application/pdf" }], ["origin", { url: "https://unapproved.example/photo.jpg" }], ["dimensions", { width: 0 }]]) {
      if (kind === name) for (const collection of ["media_assets", "media_assets_public"]) await db.doc(`${collection}/shared-upload`).update(patch);
    }
    if (kind === "replacement") await db.doc("system/media/replacements/shared-upload").set({ version: 1 });
    if (kind === "not ready") await db.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
    if (kind === "deploying") await db.doc("system/publicDeployment").set(leasedPointer());
    if (kind === "generation") await db.doc("system/publicDeployment").update({ newestEligibleGeneration: 2, lastReservedGeneration: 2 });
    const before = await current();
    const response = await invoke(handler(), request(config.postId));
    expect(response.code, JSON.stringify(response.body)).toBe(409);
    expect(await current()).toEqual(before);
    expect((await db.collection(`cmsPosts/${config.postId}/mediaUsage`).get()).empty).toBe(true);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await ownership.readNoBuildPostOwner({ firestore: db, postId: config.postId })).state).toBeNull();
  });
});

it("change-log: Post publication appends with acceptance; draft saves never read enrollment", async () => {
  await enrollPublicReleaseLog(db, sha);
  const response = await publish();
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  const [entry] = await publicReleaseEntries(db);
  expect(entry.operationId).toBe(response.body.publication.queueId);
  expect(entry.changes).toMatchObject([{ kind: "post", id: config.postId, action: "publish", sourceVersion: 2 }]);
  // Invalid enrollment would refuse any public mutation, but cannot block drafts.
  await db.doc("system/publicReleaseChangeLog").set({ enabled: true, malformed: true });
  await savePublishedRevision({ title: "Private working revision" });
  expect(await publicReleaseEntries(db)).toHaveLength(1);
  expect((await current()).published.metadata.title).toBe("Private working title");
});

it("change-log: enrolled owned withdrawal remains available during an active code lease", async () => {
  await enrollPublicReleaseLog(db, sha);
  expect((await publish()).code).toBe(200);
  await db.doc(admission.ADMISSION_PATH).update({ enabled: false, revision: 2 });
  await db.doc("system/publicDeployment").set(leasedPointer());
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => actor,
    noBuildConfig: { enabled: false, postId: "" }, now: () => "2026-10-08T13:00:00.000Z", log: quiet });
  const response = await invoke(handler, { collection: "cmsPosts", id: config.postId, baseVersion: 2, action: "unpublish" });
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  expect((await current()).publiclyVisible).toBe(false);
  const entries = await publicReleaseEntries(db);
  expect(entries).toHaveLength(2);
  expect(entries[1].changes).toMatchObject([{ kind: "post", id: config.postId, action: "withdraw", sourceVersion: 2 }]);
});

it("change-log: Post schedule validation never reads even malformed enrollment", async () => {
  expect((await publish()).code).toBe(200);
  await db.doc("system/publicReleaseChangeLog").set({ enabled: true, malformed: true });
  const document = await current();
  const result = await db.runTransaction(transaction => publication.assertNoBuildScheduleInTransaction({ firestore: db,
    transaction, collection: "cmsPosts", documentId: config.postId, nextDocument: document }));
  expect(result).toBe("post-no-build-v1");
  expect(await publicReleaseEntries(db)).toEqual([]);
});

it("change-log: enrollment infrastructure refusal leaves a due fast Post scheduled for retry", async () => {
  const response = await invoke(saveHandler(), { collection: "cmsPosts", id: config.postId, baseVersion: 1,
    scheduleAt: "2026-10-10T12:00:00.000Z", document: {} });
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  const scheduled = await current();
  await db.doc("system/publicReleaseChangeLog").set({ enabled: true, malformed: true });
  const deferred = [];
  const run = scheduledPublish.createScheduledPublishRunner({ firestore: db, now: () => "2026-10-10T12:00:00.000Z",
    assertPublishReadyFn: async () => ({ transport: "serializer" }), log: { ...quiet, info: message => deferred.push(message) } });
  await expect(run()).resolves.toMatchObject({ publishedCount: 0, queueId: null, changes: [] });
  expect(await current()).toEqual(scheduled);
  expect(deferred).toContain("scheduled publish deferred while publication is unavailable");
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect(await publicReleaseEntries(db)).toEqual([]);
});

it.each(["unpublish", "archive"])("reports a first-attempt %s dispatch failure while preserving withdrawal recovery", async action => {
  expect((await publish()).code).toBe(200);
  // Commit the public visibility that provider confirmation normally records.
  await db.doc(`cmsPosts/${config.postId}`).update({ publiclyVisible: true });
  const published = (await current()).published;
  await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin" });
  const dispatch = vi.spyOn(createRequire(import.meta.url)("../../functions/lib/transitional-post-withdrawal.js"), "enqueuePostWithdrawalBuild")
    .mockRejectedValue(new Error("Post removal could not start. Retry removal."));
  try {
    const response = action === "unpublish"
      ? await invoke(lifecycle.createCmsTransitionContentHandler({ firestore: db,
        requirePrincipalFn: async () => actor, noBuildConfig: config, log: quiet }),
        { collection: "cmsPosts", id: config.postId, baseVersion: 2, action })
      : await invoke(bulkArchive.createCmsBulkArchiveHandler({ firestore: db,
        requireAdminFn: async () => actor, noBuildConfig: config, log: quiet }),
        { items: [{ id: config.postId, baseVersion: 2 }] });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const receipt = action === "unpublish" ? response.body.publication : response.body.outcomes[0].publication;
    expect(receipt).toMatchObject({ status: "failed", queueId: receipt.homeFullBuildQueueId });
    expect(receipt.queueId).toBeTruthy();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await current()).published).toEqual(published);
    expect(await current()).toMatchObject({ publiclyVisible: false, publishBuildPending: true,
      publishBuildQueueId: receipt.queueId, status: action === "archive" ? "archived" : "draft" });
    expect((await db.doc(`cmsPublishQueue/${receipt.queueId}`).get()).data()).toMatchObject({
      status: "reserved", homeFullBuild: { status: "reserved", sourceOperationId: (await state()).operationId } });
  } finally { dispatch.mockRestore(); }
});

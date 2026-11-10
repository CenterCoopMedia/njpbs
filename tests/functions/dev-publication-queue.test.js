import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { enqueuePublishBuild } from "../../functions/publish.js";
import recovery from "../../functions/lib/publication-recovery.js";
import deployment from "../../functions/lib/public-deployment.js";
import scheduledPublish from "../../functions/scheduled-publish.js";
import fallback from "../../functions/lib/transitional-post-withdrawal.js";
import ownership from "../../functions/lib/no-build-post-ownership.js";
import buildState from "../../functions/lib/publish-build-state.js";
import audit from "../../functions/lib/audit.js";

const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const sha = "a".repeat(40);
const now = "2026-10-11T14:00:00.000Z";
const due = "2026-10-11T13:00:00.000Z";
const actor = { uid: "dev-editor", principal: { id: "dev-editor", grants: [{ role: "admin" }] } };
const control = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "office-publisher",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
let db;
const writeAudit = fields => db.collection(audit.AUDIT_COLLECTIONS.adminLogs).add(audit.adminLogEntry(fields));
const enqueue = (extra = {}) => enqueuePublishBuild({ actor, changes: [], readiness: { transport: "github" }, ...extra }, { firestore: db, logAdminActionFn: writeAudit });

async function expectPublishAudit(queueId, actorUid = actor.uid) {
  const rows = await db.collection("admin_logs").where("action", "==", "cms.publish")
    .where("target", "==", queueId).get();
  expect(rows.docs.map(row => row.data())).toEqual([expect.objectContaining({
    actorUid, action: "cms.publish", target: queueId,
    after: { status: "pending", dispatchRequested: false },
  })]);
}

function scheduledPage() {
  // The existing about Page's programLanding editor contract admits this block.
  return { id: "about", title: "Scheduled about page", description: "About NJ PBS.", template: "programLanding",
    status: "scheduled", publishAt: due, blocks: [{ id: "scheduled-divider", type: "divider", order: 0, visible: true, data: {} }],
    version: 7, contentVersion: 7, createdBy: actor.uid, updatedBy: actor.uid };
}

function frozenPendingPage() {
  return { ...scheduledPage(), status: "published", publiclyVisible: true, version: 9,
    title: "A newer private draft", blocks: [], publishBuildPending: true, publishBuildQueueId: null,
    published: { metadata: { title: "Published about page", description: "Frozen public summary." },
      blocks: [{ id: "frozen-divider", type: "divider", order: 0, visible: true, data: {} }],
      sourceVersion: 8, publishedAt: due, publishedBy: "previous-editor" } };
}

function runScheduler(accepted = []) {
  return scheduledPublish.createScheduledPublishRunner({ firestore: db, now: () => now,
    // Observe the persisted acceptance contract, then use the real queue opener.
    async enqueuePublishFn(fields) {
      accepted.push((await db.doc(`cmsPublishQueue/${fields.queueId}`).get()).data());
      return enqueuePublishBuild(fields, { firestore: db, logAdminActionFn: writeAudit,
        async fetchImpl() { throw new Error("The emulator proof must not dispatch to GitHub"); } });
    },
  });
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !project.startsWith("demo-")) throw new Error("Loopback demo emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  db = isolatedFirestore("dev-publication-queue.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  vi.stubEnv("CMS_PUBLISH_TRANSPORT", "github");
  vi.stubEnv("GCLOUD_PROJECT", "njpbs-site-dev");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "njpbs-site-dev");
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  vi.stubEnv("CMS_PUBLISH_GITHUB_TOKEN", "");
  vi.stubEnv("CMS_DEV_PUBLISH_APP_ID", "");
  vi.stubEnv("CMS_DEV_PUBLISH_APP_PRIVATE_KEY", "");
  await db.doc("system/cmsPublicationRuntime").set(control);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeDeploymentId: "active-dev", activeCommitSha: sha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "active-dev" });
  await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2,
    rendererSha: sha, servingEnabled: true, generation: 1 });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

it("stamps new direct dev jobs with the ready renderer's exact cloud owner", async () => {
  const result = await enqueue();
  await expectPublishAudit(result.queueId);
  expect((await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data()).toMatchObject({
    environment: "development", projectId: "njpbs-site-dev", transport: "github",
    runtime: { owner: "cloudflare", release: sha }, status: "pending" });
});

it.each(["missing cloud", "starting cloud", "different source", "production owner", "different active renderer"])(
  "refuses %s before accepting any dev job", async mode => {
    if (mode === "missing cloud") await db.doc("system/cmsPublicationRuntime").set({ ...control, cloud: admin.firestore.FieldValue.delete() }, { merge: true });
    if (mode === "starting cloud") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "starting" });
    if (mode === "different source") await db.doc("system/cmsPublicationRuntime").update({ "cloud.commitSha": "b".repeat(40) });
    if (mode === "production owner") await db.doc("system/cmsPublicationRuntime").update({ "cloud.serializerId": "cloudflare-publisher" });
    if (mode === "different active renderer") await db.doc("system/publicDeployment/noBuildPosts/capability").update({ rendererSha: "b".repeat(40) });
    await expect(enqueue()).rejects.toThrow();
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  },
);

it("stamps only a newly reserved dev retry and preserves the accepted reservation on resume", async () => {
  const change = { collection: "cmsPages", id: "home", sourceVersion: 7 };
  await db.doc("cmsPages/home").set({ status: "published", version: 8, createdBy: actor.uid,
    published: { sourceVersion: 7 }, publishBuildPending: true });
  const request = { firestore: db, actor, changes: [change], baseVersion: 8, source: null, transport: "github" };
  const first = await recovery.reservePublicationRetry(request);
  const before = (await db.doc(`cmsPublishQueue/${first.queueId}`).get()).data();
  expect(before).toMatchObject({ status: "reserved", runtime: { owner: "cloudflare", release: sha }, projectId: "njpbs-site-dev" });
  await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
  const resumed = await recovery.reservePublicationRetry(request);
  expect(resumed).toMatchObject({ queueId: first.queueId, existing: true });
  expect((await db.doc(`cmsPublishQueue/${first.queueId}`).get()).data()).toEqual(before);
});

it("keeps a retained dev reservation's original runtime through enqueue", async () => {
  const queueId = "B1b2C3d4E5f6G7h8I9j0";
  const retained = { status: "reserved", transport: "github", changes: [], triggeredBy: actor.uid,
    runtime: { owner: "node-compute", release: "b".repeat(40) } };
  await db.doc(`cmsPublishQueue/${queueId}`).set(retained);
  await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
  await enqueue({ queueId, queueReserved: true });
  const queued = (await db.doc(`cmsPublishQueue/${queueId}`).get()).data();
  expect(queued.runtime).toEqual(retained.runtime);
  expect(queued).not.toHaveProperty("environment");
  expect(queued).not.toHaveProperty("projectId");
  await expectPublishAudit(queueId);
});

it("accepts a due ordinary dev Page with the exact cloud runtime before actual enqueue", async () => {
  await db.doc("cmsPages/about").set(scheduledPage());
  const accepted = [];
  const result = await runScheduler(accepted)();
  expect(result).toEqual({ publishedCount: 1, queueId: expect.any(String),
    changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  expect(accepted).toHaveLength(1);
  await expectPublishAudit(result.queueId, "system:scheduler");
  expect(accepted[0]).toMatchObject({ status: "reserved", transport: "github", triggeredBy: "system:scheduler",
    environment: "development", projectId: "njpbs-site-dev", runtime: { owner: "cloudflare", release: sha },
    changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  const queue = (await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data();
  expect(queue).toMatchObject({ status: "pending", transport: "github", triggeredBy: "system:scheduler",
    environment: "development", projectId: "njpbs-site-dev", runtime: { owner: "cloudflare", release: sha },
    changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  const page = (await db.doc("cmsPages/about").get()).data();
  expect(page).toMatchObject({ status: "published", publiclyVisible: true, version: 8, contentVersion: 7,
    updatedBy: "system:scheduler", updatedAt: now, publishBuildPending: true, publishBuildQueueId: result.queueId,
    published: { metadata: { title: "Scheduled about page", description: "About NJ PBS." },
      blocks: scheduledPage().blocks, sourceVersion: 8, publishedAt: now, publishedBy: "system:scheduler" } });
  const history = (await db.collection("cmsVersionHistory").get()).docs.map(row => row.data());
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ collection: "cmsPages", documentId: "about", action: "publish",
    userId: "system:scheduler", source: "scheduler", before: { status: "scheduled", version: 7 },
    after: { status: "published", version: 8, published: { sourceVersion: 8 } } });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("accepts a new dev scheduler retry without changing the frozen published snapshot or newer draft", async () => {
  const before = frozenPendingPage();
  await db.doc("cmsPages/about").set(before);
  const accepted = [];
  const result = await runScheduler(accepted)();
  expect(result).toEqual({ publishedCount: 0, queueId: expect.any(String),
    changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  expect(accepted).toHaveLength(1);
  await expectPublishAudit(result.queueId, "system:scheduler");
  expect(accepted[0]).toMatchObject({ status: "reserved", transport: "github", triggeredBy: "system:scheduler",
    environment: "development", projectId: "njpbs-site-dev", runtime: { owner: "cloudflare", release: sha },
    changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  const queue = (await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data();
  expect(queue).toMatchObject({ status: "pending", environment: "development", projectId: "njpbs-site-dev",
    runtime: { owner: "cloudflare", release: sha }, changes: [{ collection: "cmsPages", id: "about", sourceVersion: 8 }] });
  expect((await db.doc("cmsPages/about").get()).data()).toEqual({ ...before, publishBuildQueueId: result.queueId });
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it.each(["due Page", "frozen pending retry"].flatMap(kind => ["missing cloud", "starting cloud", "different source", "production owner", "different active renderer"]
  .map(mode => ({ kind, mode }))))("refuses a $kind with $mode before snapshot, history or queue writes", async ({ kind, mode }) => {
  const before = kind === "due Page" ? scheduledPage() : frozenPendingPage();
  await db.doc("cmsPages/about").set(before);
  if (mode === "missing cloud") await db.doc("system/cmsPublicationRuntime").update({ cloud: admin.firestore.FieldValue.delete() });
  if (mode === "starting cloud") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "starting" });
  if (mode === "different source") await db.doc("system/cmsPublicationRuntime").update({ "cloud.commitSha": "b".repeat(40) });
  if (mode === "production owner") await db.doc("system/cmsPublicationRuntime").update({ "cloud.serializerId": "cloudflare-publisher" });
  if (mode === "different active renderer") await db.doc("system/publicDeployment/noBuildPosts/capability").update({ rendererSha: "b".repeat(40) });
  await expect(runScheduler()()).rejects.toThrow();
  expect((await db.doc("cmsPages/about").get()).data()).toEqual(before);
  for (const collection of ["cmsPublishQueue", "cmsVersionHistory", "admin_logs"]) {
    expect((await db.collection(collection).get()).empty).toBe(true);
  }
  expect((await db.doc("cmsPages/about/mediaUsage/working").get()).exists).toBe(false);
  expect((await db.doc("cmsPages/about/mediaUsage/published").get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).exists).toBe(false);
});

async function reserveWithdrawal() {
  const originalRef = db.collection("cmsPublishQueue").doc();
  const change = { collection: "cmsPosts", id: "dev-post", sourceVersion: 8, operation: "withdraw" };
  const runtime = { owner: "cloudflare", release: sha };
  const state = { schemaVersion: 1, postId: change.id, rendererSha: sha, servingEnabled: true,
    generation: 1, operationId: originalRef.id, sourceVersion: 8, slug: "dev-story", visible: false,
    ownedSlugs: ["dev-story"], runtime };
  await db.doc(`${ownership.OWNER_COLLECTION}/${change.id}`).set(state);
  const postRef = db.doc(`cmsPosts/${change.id}`);
  const fullQueueId = await db.runTransaction(async transaction => {
    const reserved = await fallback.preparePostWithdrawalBuild({ firestore: db, transaction,
      actor, change, operationId: originalRef.id, runtime });
    transaction.create(reserved.queueRef, reserved.queue);
    transaction.create(reserved.auditRef, reserved.audit);
    transaction.create(originalRef, { status: "success", transport: "post-no-build-v1", triggeredBy: actor.uid,
      noBuildPost: state, backgroundRuntime: runtime, changes: [change], homeAffected: false, homeFullBuild: reserved.receipt });
    transaction.set(postRef, { id: change.id, version: 9, createdBy: actor.uid, section: "news", publiclyVisible: false,
      published: { sourceVersion: 8, metadata: { type: "post", slug: "dev-story" }, blocks: [] },
      publishBuildPending: true, publishBuildQueueId: reserved.queueRef.id });
    return reserved.queueRef.id;
  });
  return { originalRef, change, runtime, postRef, fullQueueId };
}

it("keeps every Post withdrawal safety reservation and retry on the exact dev GitHub owner", async () => {
  const { originalRef, change, runtime, postRef, fullQueueId } = await reserveWithdrawal();
  const request = vi.fn(async () => { throw new Error("The emulator must not dispatch to GitHub"); });
  const receipt = await fallback.enqueuePostWithdrawalBuild({ firestore: db, operationId: originalRef.id }, { fetchImpl: request, logAdminActionFn: writeAudit });
  expect(receipt.queueId).toBe(fullQueueId);
  await expectPublishAudit(fullQueueId);
  expect((await db.doc(`cmsPublishQueue/${fullQueueId}`).get()).data()).toMatchObject({
    status: "pending", transport: "github", environment: "development", projectId: "njpbs-site-dev", runtime,
    homeFullBuild: { status: "queued", reason: "post_withdrawal_safety" }, changes: [change],
  });
  await buildState.settleBuildQueue(db, { queueId: fullQueueId, status: "failed", queueUpdate: { status: "failed" } });
  const retries = await Promise.all([1, 2].map(() => fallback.retryPostWithdrawalBuild({ firestore: db,
    operationId: originalRef.id, actor, changes: [change], baseVersion: 9 }, { fetchImpl: request, logAdminActionFn: writeAudit })));
  expect(retries[0].queueId).not.toBe(fullQueueId);
  expect(retries[1].queueId).toBe(retries[0].queueId);
  expect(retries[0].transport).toBe("github");
  await expectPublishAudit(retries[0].queueId);
  expect((await db.doc(`cmsPublishQueue/${retries[0].queueId}`).get()).data()).toMatchObject({
    status: "pending", transport: "github", environment: "development", projectId: "njpbs-site-dev", runtime,
  });
  expect((await postRef.get()).data().publishBuildQueueId).toBe(retries[0].queueId);
  expect(request).not.toHaveBeenCalled();
});

it.each(["rejected", "unavailable"])("reports a %s dev withdrawal dispatch and retains exact retry", async mode => {
  const { originalRef, change, runtime, postRef, fullQueueId } = await reserveWithdrawal();
  const request = vi.fn(async () => {
    if (mode === "unavailable") throw new Error("Dispatch fixture unavailable");
    return new Response("Dispatch fixture rejected", { status: 503 });
  });
  const deps = { fetchImpl: request, logAdminActionFn: writeAudit,
    assertPublishReadyFn: async () => ({ transport: "github", token: "dispatch-fixture" }),
    log: { info() {}, error() {} } };
  const expected = { status: 502, queueId: fullQueueId, message: "Post removal could not start. Retry removal." };
  await expect(fallback.enqueuePostWithdrawalBuild({ firestore: db, operationId: originalRef.id }, deps))
    .rejects.toMatchObject(expected);
  expect(request).toHaveBeenCalledTimes(1);
  expect((await db.doc(`cmsPublishQueue/${fullQueueId}`).get()).data()).toMatchObject({ status: "failed", runtime, changes: [change] });
  expect(await fallback.readPostWithdrawalPublication({ firestore: db, postId: change.id, sourceVersion: 8 }))
    .toMatchObject({ queueId: fullQueueId, queueStatus: "failed" });
  await expect(fallback.enqueuePostWithdrawalBuild({ firestore: db, operationId: originalRef.id }, deps))
    .rejects.toMatchObject(expected);
  expect(request).toHaveBeenCalledTimes(1);
  const failedPost = (await postRef.get()).data();
  expect(failedPost).toMatchObject({ version: 9, publiclyVisible: false, publishBuildPending: true, publishBuildQueueId: null });

  request.mockImplementation(async () => new Response(null, { status: 204 }));
  const retry = await fallback.retryPostWithdrawalBuild({ firestore: db,
    operationId: originalRef.id, actor, changes: [change], baseVersion: 9 }, deps);
  expect(retry).toMatchObject({ success: true, transport: "github" });
  expect(retry.queueId).not.toBe(fullQueueId);
  expect((await db.doc(`cmsPublishQueue/${retry.queueId}`).get()).data()).toMatchObject({ status: "publishing", runtime, changes: [change] });
  expect((await postRef.get()).data()).toEqual({ ...failedPost, publishBuildQueueId: retry.queueId });
  const repeated = await fallback.retryPostWithdrawalBuild({ firestore: db,
    operationId: originalRef.id, actor, changes: [change], baseVersion: 9 }, deps);
  expect(repeated.queueId).toBe(retry.queueId);
  expect(request).toHaveBeenCalledTimes(2);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(3);
});

import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createCmsSaveHandler } from "../../functions/save.js";
import { createCmsTransitionContentHandler } from "../../functions/lifecycle-transition.js";
import { createCmsPublishHandler } from "../../functions/publish.js";
import { createScheduledPublishRunner } from "../../functions/scheduled-publish.js";
import { createCmsBulkArchiveHandler } from "../../functions/bulk-archive.js";
import { publicationMetadata } from "../../functions/get-content.js";
import deployment from "../../functions/lib/public-deployment.js";
import capability from "../../functions/lib/no-build-record-capability.js";
import admission from "../../functions/lib/no-build-post-admission.js";
import media from "../../functions/lib/media-contract.js";
import { recordDocument, asset } from "../../site/tests/fixtures/published-records/fixtures";

const sha = "a".repeat(40), at = "2026-10-23T16:00:00.000Z", id = "record-one";
const actor = { uid: "editor", email: "editor@example.test", principal: { id: "editor", grants: [{ role: "admin" }] } };
const quiet = { warn() {}, error() {}, info() {} };
const app = initializeApp({ projectId: "njpbs-site-dev" }, "record-lifecycle-proof"), db = getFirestore(app);
const oldEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
const deps = { firestore: db, requirePrincipalFn: async () => actor, requireAdminFn: async () => actor, now: () => at, log: quiet };
async function invoke(handler: any, body: any) {
  const response: any = { statusCode: 0, body: null, headersSent: false, status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, body }, response); return response;
}
async function seed(kind: "program" | "event" = "program") {
  const template = recordDocument(kind, id);
  await db.doc(`cmsPosts/${id}`).set({ ...template.published.metadata, blocks: [], version: 1, contentVersion: 1,
    status: "approved", publiclyVisible: false, deleted: false, createdBy: actor.uid });
}
async function save(patch: any = {}, baseVersion = 1, publish = true) {
  const { slug, ...document } = patch;
  return invoke(createCmsSaveHandler({ ...deps, enablePublishSnapshot: true }), { collection: "cmsPosts", id, baseVersion, document, publish,
    ...(slug === undefined ? {} : { slug }) });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sha,
    activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release", newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" });
  await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 2, revision: 7, enabled: true,
    backgroundBucket: "njpbs-dev-public-artifacts", families: { programs: { mode: "all" }, events: { mode: "all" } } });
  await db.doc(capability.CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 3, families: ["programs", "events"],
    terminalOwner: { schemaVersion: 1, rendererSha: sha, transport: "public-context-no-build-v1" } });
  const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType, width: asset.width, height: asset.height, altText: "Public art" };
  await db.doc("media_assets/record-art").set(art); await db.doc("media_assets_public/record-art").set(media.mediaProjection(art));
  await db.doc(`users/${actor.uid}`).set({ role: "admin", grants: [] });
  await seed();
});
afterAll(async () => { await deleteApp(app); if (oldEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT; else process.env.CMS_DEPLOYMENT_ENVIRONMENT = oldEnvironment; });

it.each(["program", "event"] as const)("publishes a %s through the normal staff save without the retired build", async kind => {
  await seed(kind);
  const response = await save();
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  expect(stored).toMatchObject({ version: 2, publiclyVisible: true, published: { sourceVersion: 2, metadata: { type: kind } }, publishBuildPending: true });
  const queue = (await db.doc(`cmsPublishQueue/${stored.publishBuildQueueId}`).get()).data();
  expect(queue).toMatchObject({ transport: "public-context-no-build-v1", changes: [], recordPublication: { family: kind === "program" ? "programs" : "events", sourceVersion: 2 } });
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
  expect((await publicationMetadata(db, stored, "cmsPosts", id)).recordPublication.status).toBe("pending");
});
it("publishes an update, retains the previous slug and keeps ordinary draft edits private", async () => {
  expect((await save()).statusCode).toBe(200);
  const draft = await save({ title: "Later reviewed title", slug: "new-name" }, 2, false);
  expect(draft.statusCode, JSON.stringify(draft.body)).toBe(200);
  const old = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  expect(old.published.sourceVersion).toBe(2);
  const response = await save({}, 3);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  const current = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  expect(current.published.sourceVersion).toBe(4);
  expect(current.published.metadata.previousSlugs).toContain("current-record-one");
  const owner = (await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data();
  expect(owner.ownedPaths).toEqual(expect.arrayContaining(["/programs/current-record-one/", "/shows/current-record-one/", "/programs/new-name/", "/shows/new-name/"]));
});
it.each(["program", "event"].flatMap(kind => ["unpublish", "archive"].map(action => ({ kind, action }))))(
  "accepts $action for $kind and retries the same frozen source after a private edit", async ({ kind, action }) => {
  await seed(kind as "program" | "event");
  expect((await save()).statusCode).toBe(200);
  expect((await save({ title: "Private later title" }, 2, false)).statusCode).toBe(200);
  await db.doc("media_assets/record-art").delete(); await db.doc("media_assets_public/record-art").delete();
  const response = await invoke(createCmsTransitionContentHandler(deps), { collection: "cmsPosts", id, baseVersion: 3, action });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  expect(stored).toMatchObject({ publiclyVisible: false, published: { sourceVersion: 2 }, publishBuildPending: true });
  const queueId = stored.publishBuildQueueId;
  await db.doc(`cmsPublishQueue/${queueId}`).update({ status: "failed" });
  const retry = await invoke(createCmsPublishHandler(deps), { changes: [{ collection: "cmsPosts", id, sourceVersion: 2, operation: "withdraw" }], retry: true, baseVersion: 4 });
  expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200); expect(retry.body.queueId).toBe(queueId);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(3);
  expect((await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data()?.durableWithdrawal).toMatchObject({ sourceVersion: 2, operationId: queueId });
});
it("archives an owned Program through the normal bulk endpoint", async () => {
  expect((await save()).statusCode).toBe(200);
  const response = await invoke(createCmsBulkArchiveHandler(deps), { items: [{ id, baseVersion: 2 }] });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect(response.body.outcomes, JSON.stringify(response.body)).toEqual([expect.objectContaining({ id, status: "archived" })]);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ publiclyVisible: false, status: "archived" });
});
it.each(["program", "event"].flatMap(kind => ["deployment", "billing", "runtime", "capability"].map(pause => ({ kind, pause }))))(
  "unpublishes an accepted $kind during a $pause pause", async ({ kind, pause }) => {
  await seed(kind as "program" | "event");
  expect((await save()).statusCode).toBe(200);
  if (pause === "billing") await db.doc("system/billing").set({ disabled: true });
  if (pause === "runtime") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  if (pause === "capability") await db.doc(capability.CAPABILITY_PATH).delete();
  if (pause === "deployment") {
    const pointer = (await db.doc("system/publicDeployment").get()).data();
    await db.doc("system/publicDeployment").set({ ...pointer, state: "deploying", lastReservedGeneration: 4,
      newestEligibleGeneration: 4, newestEligibleBuildBatchId: "pending-release", candidateGeneration: 4,
      candidateBuildBatchId: "pending-release", candidateCommitSha: "b".repeat(40), leaseToken: "fixture-lease",
      leaseAcquiredAt: Timestamp.fromMillis(Date.now()), predecessorGeneration: 3,
      predecessorDeploymentId: "fixture-release", predecessorCommitSha: sha });
  }
  const previousContext = (await db.doc("system/publicDeployment/contexts/public").get()).data();
  const response = await invoke(createCmsTransitionContentHandler(deps), { collection: "cmsPosts", id, baseVersion: 2, action: "unpublish" });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  expect(stored).toMatchObject({ publiclyVisible: false, version: 3, published: { sourceVersion: 2 }, publishBuildPending: true });
  const owner = (await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data();
  expect(owner).toMatchObject({ visible: false, sourceVersion: 2, durableWithdrawal: { operationId: stored.publishBuildQueueId, sourceVersion: 2 } });
  if (["billing", "runtime"].includes(pause)) {
    const ref = db.doc(`cmsPublishQueue/${stored.publishBuildQueueId}`);
    expect((await ref.get()).data()).toMatchObject({ recordRegeneration: "deferred", recordPublication: { sourceVersion: 2 } });
    expect((await ref.collection("backgroundOutputs").get()).empty).toBe(true);
    expect((await ref.collection("backgroundPreparation").get()).empty).toBe(true);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()).toEqual(previousContext);
    const metadata = await publicationMetadata(db, stored, "cmsPosts", id);
    expect(metadata.recordPublication).toMatchObject({ status: "pending", warning: expect.stringContaining("will resume") });
    expect(metadata.queueStatus).toBe("pending");
  }
});
it("keeps the exact frozen refusal for an unselected record family", async () => {
  await db.doc(admission.ADMISSION_PATH).update({ families: {} });
  await db.doc(capability.CAPABILITY_PATH).delete();
  const response = await save();
  expect(response.statusCode).toBe(409); expect(response.body.error).toContain("full-site build was retired");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.version).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});
it.each(["capability", "admission"])("preserves the selected record %s refusal for staff", async pause => {
  if (pause === "capability") await db.doc(capability.CAPABILITY_PATH).delete();
  else await db.doc(admission.ADMISSION_PATH).update({ enabled: false });
  const response = await save();
  expect(response.statusCode).toBe(409);
  expect(response.body.error).toBe(pause === "capability"
    ? "Record publication requires the serving, confirmation and recovery owner." : "Build-free record publication is paused.");
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.version).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});
it.each(["program", "event"].flatMap(kind => ["capability", "admission", "release"].map(pause => ({ kind, pause }))))(
  "keeps a due $kind scheduled through a temporary $pause refusal", async ({ kind, pause }) => {
  await seed(kind as "program" | "event");
  const publishAt = "2026-10-23T17:00:00.000Z";
  const scheduled = await invoke(createCmsSaveHandler({ ...deps, enablePublishSnapshot: true }), {
    collection: "cmsPosts", id, baseVersion: 1, document: {}, scheduleAt: publishAt });
  expect(scheduled.statusCode, JSON.stringify(scheduled.body)).toBe(200);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()?.scheduledPublicationTransport).toBe("public-context-no-build-v1");
  if (pause === "admission") await db.doc(admission.ADMISSION_PATH).update({ enabled: false });
  else await db.doc(capability.CAPABILITY_PATH).update(pause === "capability" ? { servingEnabled: false }
    : { rendererSha: "b".repeat(40), "terminalOwner.rendererSha": "b".repeat(40) });
  const runner = createScheduledPublishRunner({ firestore: db, now: () => "2026-10-23T18:00:00.000Z", log: quiet,
    enqueuePublishFn: async () => { throw new Error("The retired build must not run"); } });
  expect((await runner()).publishedCount).toBe(0);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ status: "scheduled", publishAt, version: 2, publiclyVisible: false });
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  await db.doc(admission.ADMISSION_PATH).update({ enabled: true });
  await db.doc(capability.CAPABILITY_PATH).update({ servingEnabled: true, rendererSha: sha, "terminalOwner.rendererSha": sha });
  expect((await runner()).publishedCount).toBe(1);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ status: "published", publiclyVisible: true, published: { sourceVersion: 3 } });
});
it.each(["program", "event"] as const)("schedules and publishes a %s through the existing due runner without full-build dispatch", async kind => {
  await seed(kind);
  const scheduled = await invoke(createCmsSaveHandler({ ...deps, enablePublishSnapshot: true }), {
    collection: "cmsPosts", id, baseVersion: 1, document: {}, scheduleAt: "2026-10-23T17:00:00.000Z" });
  expect(scheduled.statusCode, JSON.stringify(scheduled.body)).toBe(200);
  const result = await createScheduledPublishRunner({ firestore: db, now: () => "2026-10-23T18:00:00.000Z", log: quiet,
    enqueuePublishFn: async () => { throw new Error("The retired build must not run"); } })();
  expect(result.publishedCount, JSON.stringify(result)).toBe(1);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data();
  expect(stored).toMatchObject({ status: "published", publiclyVisible: true, published: { sourceVersion: 3 }, publishBuildPending: true });
  expect((await db.doc(`cmsPublishQueue/${stored.publishBuildQueueId}`).get()).data()?.transport).toBe("public-context-no-build-v1");
});


it.each(["program", "event"] as const)("returns settled %s proof through the real library field projection", async kind => {
  await seed(kind); expect((await save()).statusCode).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  await db.doc(`cmsPosts/${id}`).update({ publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 2,
    publishBuildSettlement: { status: "success", sourceVersion: 2, operation: "publish", recordQueueId: stored.publishBuildQueueId } });
  const { createCmsListContentHandler } = await import("../../functions/list-content.js");
  const response = await invoke(createCmsListContentHandler(deps), { query: `?type=${kind}` });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect(response.body.records.find((record: any) => record.id === id)?.recordPublication).toEqual({
    queueId: stored.publishBuildQueueId, sourceVersion: 2, withdrawal: false, status: "success", missingConsumers: [] });
});


it.each(["program", "event"].flatMap(kind => ["single", "bulk"].flatMap(action => ["pending", "successor"].map(state => ({ kind, action, state })))))(
  "retains the $state $kind removal when archived through $action", async ({ kind, action, state }) => {
  await seed(kind as "program" | "event"); expect((await save()).statusCode).toBe(200);
  if (state === "successor") await db.doc("system/billing").set({ disabled: true });
  const removed = await invoke(createCmsTransitionContentHandler(deps), { collection: "cmsPosts", id, baseVersion: 2, action: "unpublish" });
  expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
  const stored = (await db.doc(`cmsPosts/${id}`).get()).data()!;
  if (state === "successor") {
    await db.doc("system/billing").set({ disabled: false });
    const retry = (await import("../../functions/lib/no-build-record-retry.js")).default;
    await retry.resumeDeferredRecordPublication({ firestore: db, operationId: stored.publishBuildQueueId });
    expect((await db.doc(`cmsPublishQueue/${stored.publishBuildQueueId}`).get()).data()?.status).toBe("cancelled");
  }
  const owner = (await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data();
  const contextBefore = (await db.doc("system/publicDeployment/contexts/public").get()).data();
  const count = (await db.collection("cmsPublishQueue").get()).size;
  const response = action === "bulk" ? await invoke(createCmsBulkArchiveHandler(deps), { items: [{ id, baseVersion: 3 }] })
    : await invoke(createCmsTransitionContentHandler(deps), { collection: "cmsPosts", id, baseVersion: 3, action: "archive" });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
  expect((await db.doc(`cmsPosts/${id}`).get()).data()).toMatchObject({ status: "archived", version: 4,
    publiclyVisible: false, publishBuildPending: true, publishBuildQueueId: stored.publishBuildQueueId });
  expect((await db.doc(`system/publicDeployment/noBuildRecordOwners/${id}`).get()).data()).toEqual(owner);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data()).toEqual(contextBefore);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(count);
});

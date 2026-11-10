import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import a from "../../functions/lib/public-release-admission.js";
import p from "../../functions/lib/public-release-pair.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import scheduler from "../../functions/scheduled-publish.js";
import media from "../../functions/lib/media-contract.js";
import legacyRecords from "../../functions/lib/no-build-record-publication.js";
import pointer from "../../functions/lib/public-deployment-pointer.js";
import bulk from "../../functions/bulk-archive.js";
import { recordDocument, asset } from "../../site/tests/fixtures/published-records/fixtures";
const db = isolatedFirestore("public-release-publication-request.test.ts");
const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
const actor = { uid: "pair-editor", email: "editor@example.test", principal: { id: "pair-editor", grants: [{ role: "admin" }] } };
const contract = { schemaVersion: 2, families: ["posts", "pages", "programs", "events", "settings", "context"], features: [] };
const quiet = { info() {}, warn() {}, error(...args: unknown[]) { console.error(...args); } };
let time = "2026-10-28T12:00:00.000Z";
const state = async (path: string) => (await db.doc(path).get()).data();
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await seedSwitch(firestore, { admittedContract: contract });
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, enabled: true, revision: 1,
    backgroundBucket: "njpbs-dev-public-artifacts", families: { pages: { mode: "all" }, posts: { mode: "all" },
      programs: { mode: "all" }, events: { mode: "all" } } });
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1, title: "Contact", blocks: [] },
    publishedAt: "2026-10-12T12:00:00.000Z", publishedBy: actor.uid });
  await db.doc("cmsPages/contact").set({ id: "contact", version: 1, title: "Contact", blocks: [], status: "draft", publiclyVisible: true, published });
  time = "2026-10-28T12:00:00.000Z";
});
async function invoke(handler: any, body: any) {
  const res: any = { code: 200, headersSent: false, status(code: number) { this.code = code; return this; },
    set() { return this; }, json(value: any) { this.body = value; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, res); return res;
}
function saveHandler(user = actor) {
  return save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => user, enablePublishSnapshot: true,
    now: () => time, assertPublishReadyFn: async () => { throw new Error("Legacy readiness must not run"); }, log: quiet });
}
function transitionHandler(user = actor) {
  return lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => user, now: () => time,
    enqueuePublishBuildFn: async () => { throw new Error("Legacy build must not run"); }, log: quiet });
}
it("dispatches schema-two Save and returns the original acceptance after time and admission selection change", async () => {
  const body = { collection: "cmsPages", id: "contact", baseVersion: 1, publish: true, document: {} };
  const first = await invoke(saveHandler(), body);
  expect(first.code).toBe(200); expect(first.body.publication.transport).toBe(a.TRANSPORT);
  const operationId = first.body.publication.queueId, historyCount = (await db.collection("cmsVersionHistory").get()).size;
  const queueBefore = await state(`cmsPublishQueue/${operationId}`);
  time = "2026-10-28T13:00:00.000Z";
  await db.doc("system/noBuildPostAdmission").update({ enabled: false, families: {} });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  const retry = await invoke(saveHandler(), body);
  expect(retry.code).toBe(200); expect(retry.body.document).toEqual(first.body.document);
  expect(retry.body.publication).toEqual(first.body.publication);
  expect(await state(`cmsPublishQueue/${operationId}`)).toEqual(queueBefore);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(historyCount);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(1);
  const changed = await invoke(saveHandler(), { ...body, document: { title: "A different request" } });
  expect(changed.code).toBe(409);
});
it("dispatches an owned schema-two withdrawal and retries it without another history, admission or queue", async () => {
  const publish = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1, publish: true, document: {} });
  expect(publish.code).toBe(200);
  const body = { collection: "cmsPages", id: "contact", baseVersion: 2, action: "unpublish" };
  const first = await invoke(transitionHandler(), body);
  expect(first.code).toBe(200); expect(first.body.publication.transport).toBe(a.TRANSPORT);
  expect(first.body.document.publiclyVisible).toBe(false);
  const head = await state(a.ADMISSIONS), history = (await db.collection("cmsVersionHistory").get()).size;
  time = "2026-10-28T13:00:00.000Z";
  const retry = await invoke(transitionHandler(), body);
  expect(retry.code).toBe(200); expect(retry.body).toEqual(first.body);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(history);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
});
it("reauthorizes a replay before returning the original history", async () => {
  const body = { collection: "cmsPages", id: "contact", baseVersion: 1, publish: true, document: {} };
  expect((await invoke(saveHandler(), body)).code).toBe(200);
  const denied = { ...actor, principal: { id: actor.uid, grants: [{ role: "writer" }] } };
  expect((await invoke(saveHandler(denied), body)).code).toBe(403);
});
it("requires the saved baseVersion before any schema-two publish acceptance", async () => {
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", publish: true, document: {} });
  expect(result.code).toBe(400);
  expect(result.body.error).toBe("Publishing requires the exact saved baseVersion");
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
});
it("saves a pair schedule, fires once at its time and makes a retried fire a no-op", async () => {
  const saved = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    scheduleAt: "2026-10-28T15:00:00.000Z", document: {} });
  expect(saved.code, JSON.stringify(saved.body)).toBe(200);
  expect(await state("cmsPages/contact")).toMatchObject({ status: "scheduled", scheduledPublicationTransport: a.TRANSPORT });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
  const run = scheduler.createScheduledPublishRunner({ firestore, now: () => time, log: quiet,
    assertPublishReadyFn: async () => { throw new Error("Legacy readiness must not run"); },
    enqueuePublishFn: async () => { throw new Error("Legacy build must not run"); }, reconcileStaleFn: async () => {} });
  expect((await run()).publishedCount).toBe(0);
  time = "2026-10-28T15:00:00.000Z";
  const fired = await run();
  expect(fired.publishedCount).toBe(1);
  expect(await state("cmsPages/contact")).toMatchObject({ status: "published", version: 3 });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  const head = await state(a.ADMISSIONS), count = (await db.collection("cmsVersionHistory").get()).size;
  expect((await run()).publishedCount).toBe(0);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(count);
});
it("creates a canonical Page from a published legacy source through the pair owner", async () => {
  const legacy = { id: "programLanding", template: "programLanding", title: "Legacy landing", status: "published",
    blocks: [{ id: "legacy-divider", type: "divider", order: 0, visible: true, data: {} }], createdBy: actor.uid, version: 7 };
  await db.doc("cmsPages/programLanding").set(legacy);
  const body = { collection: "cmsPages", id: "watch", createOnly: true,
    seedFromLegacyPage: { id: "programLanding", version: 7 }, document: { template: "programLanding", blocks: legacy.blocks } };
  const result = await invoke(saveHandler(), body);
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.publication.transport).toBe(a.TRANSPORT);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect((await invoke(saveHandler(), body)).code).toBe(200);
});
async function seedRecord(kind: "program" | "event") {
  const id = `${kind}-one`, original = recordDocument(kind, id);
  await db.doc(`cmsPosts/${id}`).set({ ...original.published.metadata, id, version: 9, type: kind, blocks: [], status: "draft",
    publiclyVisible: false, published: { ...original.published, blocks: [], publishedBy: actor.uid }, createdBy: actor.uid,
    publicSourceVersion: null, publishBuildPending: false, publishBuildQueueId: null });
  const art = { ...asset, lifecycle: "active", source: "site_seed", altText: "Record art" };
  await db.doc(`media_assets/${asset.id}`).set(art); await db.doc(`media_assets_public/${asset.id}`).set(media.mediaProjection(art));
  await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
  return id;
}
it.each(["program", "event"] as const)("publishes and withdraws a real %s through the HTTP pair dispatcher", async kind => {
  const id = await seedRecord(kind);
  const body = { collection: "cmsPosts", id, baseVersion: 9, publish: true, document: {} };
  const accepted = await invoke(saveHandler(), body);
  expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body.publication.transport).toBe(a.TRANSPORT);
  expect(accepted.body.document.version).toBe(10);
  expect((await invoke(saveHandler(), body)).body.document).toEqual(accepted.body.document);
  const withdrawal = { collection: "cmsPosts", id, baseVersion: 10, action: "unpublish" };
  const removed = await invoke(transitionHandler(), withdrawal);
  expect(removed.code, JSON.stringify(removed.body)).toBe(200);
  expect(removed.body.publication.transport).toBe(a.TRANSPORT);
  expect((await invoke(transitionHandler(), withdrawal)).body).toEqual(removed.body);
  const archive = await invoke(transitionHandler(), { collection: "cmsPosts", id, baseVersion: 11, action: "archive" });
  expect(archive.code, JSON.stringify(archive.body)).toBe(200);
  expect(archive.body.publication.queueId).toBe(removed.body.publication.queueId);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(2);
});
it.each(["program", "event"] as const)("reuses the pending %s pair withdrawal in Bulk Archive", async kind => {
  const id = await seedRecord(kind);
  expect((await invoke(saveHandler(), { collection: "cmsPosts", id, baseVersion: 9, publish: true, document: {} })).code).toBe(200);
  const removed = await invoke(transitionHandler(), { collection: "cmsPosts", id, baseVersion: 10, action: "unpublish" });
  expect(removed.code, JSON.stringify(removed.body)).toBe(200);
  const before = await state(`cmsPublishQueue/${removed.body.publication.queueId}`), head = await state(a.ADMISSIONS);
  const handler = bulk.createCmsBulkArchiveHandler({ firestore, requireAdminFn: async () => actor, now: () => time, log: quiet,
    enqueuePublishBuildFn: async () => { throw new Error("Legacy build must not run"); } });
  const archived = await invoke(handler, { items: [{ id, baseVersion: 11 }] });
  expect(archived.code, JSON.stringify(archived.body)).toBe(200);
  expect(await state(`cmsPosts/${id}`)).toMatchObject({ status: "archived", publishBuildQueueId: removed.body.publication.queueId });
  expect(await state(`cmsPublishQueue/${removed.body.publication.queueId}`)).toEqual(before);
  expect(await state(a.ADMISSIONS)).toEqual(head);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(2);
});
it.each(["program", "event"] as const)("schedules a real %s and admits it once when the schedule fires", async kind => {
  const id = await seedRecord(kind);
  const saved = await invoke(saveHandler(), { collection: "cmsPosts", id, baseVersion: 9,
    scheduleAt: "2026-10-28T15:00:00.000Z", document: {} });
  expect(saved.code, JSON.stringify(saved.body)).toBe(200);
  expect(await state(`cmsPosts/${id}`)).toMatchObject({ version: 10, status: "scheduled", scheduledPublicationTransport: a.TRANSPORT });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
  time = "2026-10-28T15:00:00.000Z";
  const run = scheduler.createScheduledPublishRunner({ firestore, now: () => time, log: quiet,
    assertPublishReadyFn: async () => { throw new Error("Legacy readiness must not run"); },
    enqueuePublishFn: async () => { throw new Error("Legacy build must not run"); }, reconcileStaleFn: async () => {} });
  expect((await run()).publishedCount).toBe(1);
  expect(await state(`cmsPosts/${id}`)).toMatchObject({ version: 11, status: "published" });
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect((await run()).publishedCount).toBe(0);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});
it.each(["program", "event"] as const)("keeps an accepted legacy %s removal when Archive runs after root conversion", async kind => {
  const id = await seedRecord(kind), selected = await state("system/publicDeployment");
  await db.doc("system/publicDeployment").set(pointer.readPublicDeploymentPointer(selected));
  const previousEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
  const publishId = "L".repeat(20), withdrawalId = "W".repeat(20);
  try {
    const current = (await state(`cmsPosts/${id}`))!;
    const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...current, version: 10 },
      publishedAt: time, publishedBy: actor.uid });
    const live = { ...current, version: 10, status: "published", publiclyVisible: true, publishAt: time, published };
    const config = { valid: true, enabled: true, admissionRevision: 1, families: { programs: { mode: "all" }, events: { mode: "all" } } };
    const acceptLegacy = (nextDocument: any, operationId: string) => db.runTransaction(async transaction => {
      const prepared = await legacyRecords.prepareNoBuildRecordPublication({ firestore, transaction, collection: "cmsPosts",
        documentId: id, nextDocument, queueRef: db.doc(`cmsPublishQueue/${operationId}`), actor, config });
      prepared!.write(); transaction.set(db.doc(`cmsPosts/${id}`), nextDocument);
    });
    await acceptLegacy(live, publishId);
    await acceptLegacy({ ...live, version: 11, status: "draft", publiclyVisible: false,
      publishBuildPending: true, publishBuildQueueId: withdrawalId }, withdrawalId);
  } finally {
    if (previousEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT;
    else process.env.CMS_DEPLOYMENT_ENVIRONMENT = previousEnvironment;
  }
  await db.doc("system/publicDeployment").set(selected!);
  const before = await state(`cmsPublishQueue/${withdrawalId}`);
  const archived = await invoke(transitionHandler(), { collection: "cmsPosts", id, baseVersion: 11, action: "archive" });
  expect(archived.code, JSON.stringify(archived.body)).toBe(200);
  expect(archived.body.publication.queueId).toBe(withdrawalId);
  expect(await state(`cmsPublishQueue/${withdrawalId}`)).toEqual(before);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

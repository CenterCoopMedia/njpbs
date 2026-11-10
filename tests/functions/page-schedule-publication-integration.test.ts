import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createRequire } from "node:module";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";

const require = createRequire(import.meta.url);
const source = require("../../functions/lib/no-build-page-publication.js");
const ownership = require("../../functions/lib/no-build-page-ownership.js");
const snapshots = require("../../functions/lib/publish-snapshot.js");
const deployment = require("../../functions/lib/public-deployment.js");
const save = require("../../functions/save.js");
const scheduler = require("../../functions/scheduled-publish.js");
const sha = "a".repeat(40), instant = "2026-10-12T12:00:00.000Z";
const actor = { uid: "watch-editor", principal: { id: "watch-editor", grants: [{ role: "editor", sections: ["watch"] }] } };
let app: any, firestore: any, fixture: any, boundary: any;
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "page-schedule-publication-fixture"); firestore = getFirestore(app);
  boundary = await backgroundStorageFixture("njpbs-dev-public-artifacts");
});
afterAll(async () => { await fixture?.close(); await boundary?.close(); await firestore?.terminate(); await deleteApp(app); });
beforeEach(async () => {
  await fixture?.close(); fixture = null;
  boundary.objects.clear(); boundary.reads.length = 0; boundary.writes.length = 0; boundary.refuseReads(false); boundary.onRead(null);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  const batch = firestore.batch();
  batch.set(firestore.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture", activeCommitSha: sha, activeDeploymentId: "fixture" });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  batch.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "ids", ids: ["live", "schedule"] } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  batch.set(firestore.doc(ownership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  batch.set(firestore.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" });
  for (const id of ["schedule", "live"]) batch.set(firestore.doc(`cmsPages/${id}`), {
    id, template: "programLanding", section: "watch", version: 1, title: id, status: "draft", blocks: [], createdBy: actor.uid });
  await batch.commit();
  fixture = await schedulePacketFixture({ firestore, rendererSha: sha, generation: 1, boundary });
});
async function invoke(id: string, user = actor, publish = true, document = {}) {
  const handler = save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => user, currentCodeRequest: fixture.request,
    now: () => instant, enablePublishSnapshot: true, assertPublishReadyFn: async () => { throw new Error("Full build forbidden"); },
    log: { info() {}, warn() {}, error() {} } });
  const res = { code: 200, headersSent: false, body: undefined as any, set() { return this; },
    status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: { collection: "cmsPages", id, baseVersion: 1, publish, document } }, res);
  return res;
}
it.each(["schedule", "live"])("publishes qualified %s with the actual default CODE factory and SDK transaction", async id => {
  const res = await invoke(id);
  expect(res.code, JSON.stringify(res.body)).toBe(200);
  expect(res.body.publication.transport).toBe("page-no-build-v1");
  expect(fixture.codeReads()).toBe(2); expect(fixture.referenceReads()).toBe(2); expect(fixture.boundary.writes).toEqual([]);
  const accepted = (await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).data();
  expect(accepted).toMatchObject({ sourceVersion: 2, visible: true, rendererSha: sha });
  expect((await firestore.doc(`cmsPages/${id}`).get()).data().published.sourceVersion).toBe(2);
});
it("denies a wrong fixed Watch grant before private IO and keeps an ordinary draft save private", async () => {
  const wrong = { ...actor, principal: { id: actor.uid, grants: [{ role: "editor", sections: ["about"] }] } };
  expect((await invoke("schedule", wrong)).code).toBe(403);
  expect(fixture.codeRequests()).toBe(0); expect(fixture.boundary.reads).toEqual([]);
  const draft = await invoke("schedule", actor, false, { title: "Private Schedule draft" });
  expect(draft.code, JSON.stringify(draft.body)).toBe(200);
  expect(fixture.codeRequests()).toBe(0); expect(fixture.boundary.reads).toEqual([]);
  expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/schedule`).get()).exists).toBe(false);
  expect((await firestore.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(1);
});
it("refuses an expired capture on an actual SDK retry without renewing it or writing a Page", async () => {
  let clock = Date.now();
  const capture = await source.capturePageScheduleForPublication({ firestore, collection: "cmsPages", documentId: "schedule",
    publishing: true, currentCodeRequest: fixture.request, now: () => clock, deadline: clock + 45_000 });
  const next = { id: "schedule", template: "programLanding", section: "watch", version: 2, title: "Qualified candidate",
    blocks: [], status: "published", publiclyVisible: true, publishAt: instant } as any;
  next.published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: next, publishedAt: instant, publishedBy: actor.uid });
  const queueRef = firestore.collection("cmsPublishQueue").doc();
  const requests = fixture.codeRequests(), reads = fixture.boundary.reads.length;
  fixture.refuseCode(); fixture.boundary.refuseReads(true);
  let attempts = 0;
  await expect(firestore.runTransaction(async (transaction: any) => {
    attempts++;
    if (attempts === 2) clock += 45_001;
    const prepared = await source.prepareNoBuildPagePublication({ firestore, transaction, collection: "cmsPages",
      documentId: "schedule", nextDocument: next, queueRef, actor, pageScheduleCapture: capture });
    if (attempts === 1) throw Object.assign(new Error("Fixture SDK abort"), { code: 10 });
    prepared.write(); transaction.set(firestore.doc("cmsPages/schedule"), next);
  }, { maxAttempts: 2 })).rejects.toThrow("capture is unavailable");
  expect(attempts).toBe(2); expect(fixture.codeRequests()).toBe(requests); expect(fixture.boundary.reads.length).toBe(reads);
  expect((await queueRef.get()).exists).toBe(false);
  expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/schedule`).get()).exists).toBe(false);
  expect((await firestore.doc("cmsPages/schedule").get()).data().version).toBe(1);
});
it.each(["schedule", "live"])("publishes due %s through the real scheduler with a wall-clock source budget", async id => {
  await firestore.doc(`cmsPages/${id}`).update({ status: "scheduled", publishAt: instant,
    scheduledPublicationTransport: "page-no-build-v1" });
  let fullBuildCalls = 0;
  const fullBuildForbidden = async () => { fullBuildCalls++; throw new Error("Full build forbidden"); };
  const run = scheduler.createScheduledPublishRunner({ firestore, currentCodeRequest: fixture.request,
    now: () => instant, assertPublishReadyFn: fullBuildForbidden, enqueuePublishFn: fullBuildForbidden,
    log: { info() {}, warn() {}, error() {} } });
  const result = await run();
  expect(result).toMatchObject({ publishedCount: 1, queueId: null,
    changes: [{ collection: "cmsPages", id, sourceVersion: 2 }],
    publications: [{ collection: "cmsPages", id, transport: "page-no-build-v1" }] });
  expect(fullBuildCalls).toBe(0); expect(fixture.codeReads()).toBe(2); expect(fixture.referenceReads()).toBe(2);
  expect(fixture.boundary.writes).toEqual([]);
  const accepted = (await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).data();
  expect(accepted).toMatchObject({ sourceVersion: 2, visible: true, rendererSha: sha });
  expect((await firestore.doc(`cmsPages/${id}`).get()).data()).toMatchObject({ status: "published",
    version: 2, published: { sourceVersion: 2, publishedAt: instant } });
});
it.each(["schedule", "live"])("dispositions malformed %s scheduling without private CODE or packet IO", async id => {
  await firestore.doc(`cmsPages/${id}`).update({ status: "scheduled", publishAt: "2026-10-12T10:00:00.000+00:00",
    scheduledPublicationTransport: "page-no-build-v1" });
  fixture.refuseCode(); boundary.refuseReads(true);
  let enqueues = 0;
  const run = scheduler.createScheduledPublishRunner({ firestore, currentCodeRequest: fixture.request,
    now: () => instant, assertPublishReadyFn: async () => ({ transport: "github" }),
    enqueuePublishFn: async () => { enqueues++; throw new Error("Malformed rows cannot build"); },
    log: { info() {}, warn() {}, error() {} } });
  expect(await run()).toEqual({ publishedCount: 0, queueId: null, changes: [] });
  const document = (await firestore.doc(`cmsPages/${id}`).get()).data();
  expect(document).toMatchObject({ status: "draft", version: 2,
    scheduledPublishFailure: { failedAt: instant, failedBy: scheduler.SCHEDULER_ACTOR } });
  expect(document).not.toHaveProperty("publishAt");
  expect(fixture.codeRequests()).toBe(0); expect(boundary.reads).toEqual([]); expect(enqueues).toBe(0);
  expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).exists).toBe(false);
  expect((await firestore.collection("cmsPublishQueue").get()).size).toBe(0);
});
it("refuses a Schedule row that becomes valid after skipped source capture instead of publishing without proof", async () => {
  const ref = firestore.doc("cmsPages/schedule");
  await ref.update({ status: "scheduled", publishAt: "2026-10-12T10:00:00.000+00:00",
    scheduledPublicationTransport: "page-no-build-v1" });
  fixture.refuseCode(); boundary.refuseReads(true);
  const realTransaction = firestore.runTransaction.bind(firestore);
  let changed = false;
  const changeBeforeSnapshot = vi.spyOn(firestore, "runTransaction").mockImplementation(async (...args: any[]) => {
    changeBeforeSnapshot.mockRestore();
    await ref.update({ publishAt: instant });
    changed = true;
    return realTransaction(...args);
  });
  try {
    const run = scheduler.createScheduledPublishRunner({ firestore, currentCodeRequest: fixture.request, now: () => instant,
      assertPublishReadyFn: async () => { throw new Error("No full build substitute"); },
      log: { info() {}, warn() {}, error() {} } });
    expect(await run()).toEqual({ publishedCount: 0, queueId: null, changes: [] });
    expect(changed).toBe(true);
    const document = (await ref.get()).data();
    expect(document).toMatchObject({ status: "draft", version: 2 });
    expect(document).not.toHaveProperty("publishAt");
    const audits = await firestore.collection("admin_logs").where("target", "==", "cmsPages/schedule").get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0].data().after.detail).toBe("Build-free Page context: Schedule and Live require qualified sealed schedule authority.");
    expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/schedule`).get()).exists).toBe(false);
    expect((await firestore.collection("cmsPublishQueue").get()).size).toBe(0);
    expect(fixture.codeRequests()).toBe(0); expect(boundary.reads).toEqual([]);
  } finally { changeBeforeSnapshot.mockRestore(); }
});

async function exportWorker() {
  const handler = require("../../functions/public-content.js").createCmsGetPublicPageHandler({ firestore,
    currentCodeRequest: fixture.request, log: { error() {} } });
  return createNoBuildPageWorker({ rendererSha: sha, rendererReady: true,
    getDecision: async (path, method) => {
      const res = { code: 200, body: undefined as any, set() { return this; }, status(code: number) { this.code = code; return this; },
        json(body: unknown) { this.body = body; return this; } };
      await handler({ method: "POST", body: { mode: "no-build-page-v1", path, rendererSha: sha, method } }, res);
      if (res.code !== 200) throw new Error("Private Page authority unavailable");
      return res.body;
    }, fetchAsset: async () => { throw new Error("Cloud export cannot use Assets"); }, render: async () => "",
    cache: { async match() {}, async put() {} } });
}
it("reuses verified immutable bytes across HTTP decisions and concurrent requests with fresh metadata fences", async () => {
  const worker = await exportWorker();
  const url = "https://dev-public.example.org/_schedule-sources.json";
  const first = await worker.fetch(new Request(url));
  expect(first!.status).toBe(200);
  expect(fixture.codeReads()).toBe(2); expect(boundary.reads).toHaveLength(2);
  const references = fixture.referenceReads();
  const concurrent = await Promise.all([worker.fetch(new Request(url)), worker.fetch(new Request(url))]);
  expect(concurrent.map(response => response!.status)).toEqual([200, 200]);
  expect(fixture.codeReads()).toBe(2); expect(boundary.reads).toHaveLength(2);
  expect(fixture.referenceReads()).toBe(references + 8);
  expect(await concurrent[0]!.text()).toBe(await first!.text());
  fixture.refuseCode();
  expect(await worker.fetch(new Request(url))).toBeNull();
  expect(fixture.codeReads()).toBe(2); expect(boundary.reads).toHaveLength(2);
});
it("deduplicates concurrent cold HTTP loads for the same freshly selected immutable identity", async () => {
  const worker = await exportWorker();
  const responses = await Promise.all([worker.fetch(new Request("https://dev-public.example.org/_schedule-sources.json")),
    worker.fetch(new Request("https://dev-public.example.org/schedule/downloads/nj-pbs-schedule.pdf"))]);
  expect(responses.map(response => response!.status)).toEqual([200, 200]);
  expect(fixture.codeReads()).toBe(2); expect(boundary.reads).toHaveLength(2);
  expect(Buffer.from(await responses[1]!.arrayBuffer())).toEqual(fixture.pdf);
});
it.each(["context", "capability", "CODE"])("invalidates cached HTTP bytes when %s identity changes", async change => {
  const worker = await exportWorker(), url = "https://dev-public.example.org/_schedule-sources.json";
  expect((await worker.fetch(new Request(url)))!.status).toBe(200);
  if (change === "context") await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
  if (change === "capability") await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ generation: 2 });
  if (change === "CODE") fixture.reference.publication.artifactDigest = "e".repeat(64);
  expect((await worker.fetch(new Request(url)))!.status).toBe(200);
  expect(fixture.codeReads()).toBe(4); expect(boundary.reads).toHaveLength(4);
});
it.each(["capability disabled", "packet source moved"])("never returns cached bytes with %s", async change => {
  const worker = await exportWorker(), url = "https://dev-public.example.org/_schedule-sources.json";
  expect((await worker.fetch(new Request(url)))!.status).toBe(200);
  if (change === "capability disabled") await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: false });
  else await firestore.doc("system/publicDeployment/contexts/public").update({ "externalInputs.schedulePacket.source.runtime.release": "f".repeat(40) });
  expect(await worker.fetch(new Request(url))).toBeNull();
});
it.each(["schedule", "live"].flatMap(id => ["missing packet", "CODE unavailable"].map(failure => ({ id, failure }))))(
  "defers due $id with $failure and publishes the later cloud Post", async ({ id, failure }) => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  try {
    const dueAt = "2026-10-12T11:00:00.000Z";
    await firestore.doc(`cmsPages/${id}`).update({ status: "scheduled", publishAt: dueAt,
      scheduledPublicationTransport: "page-no-build-v1" });
    const original = (await firestore.doc(`cmsPages/${id}`).get()).data();
    await firestore.doc("system/noBuildPostAdmission").update({ "families.posts": { mode: "ids", ids: ["later-cloud-post"] } });
    await firestore.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2, rendererSha: sha,
      servingEnabled: true, generation: 1 });
    await firestore.doc("cmsPosts/later-cloud-post").set({ id: "later-cloud-post", type: "post", title: "Later cloud story",
      section: "news", slug: "later-cloud-story", previousSlugs: [], locale: "en", version: 1, status: "scheduled", publishAt: instant,
      tags: [], categories: [], credits: [], blocks: [], createdBy: actor.uid });
    await firestore.doc("sections/news").set({ label: "News" });
    if (failure === "missing packet") boundary.objects.delete(fixture.packet.files.pdf.key);
    else fixture.refuseCode();
    let fullBuildCalls = 0;
    const forbidden = async () => { fullBuildCalls++; throw new Error("Full build forbidden"); };
    const run = scheduler.createScheduledPublishRunner({ firestore, currentCodeRequest: fixture.request, now: () => instant,
      assertPublishReadyFn: forbidden, enqueuePublishFn: forbidden, log: { info() {}, warn() {}, error() {} } });
    expect(await run()).toMatchObject({ publishedCount: 1, queueId: null,
      changes: [{ collection: "cmsPosts", id: "later-cloud-post", sourceVersion: 2 }],
      publications: [{ collection: "cmsPosts", id: "later-cloud-post", transport: "post-no-build-v1" }] });
    expect(fullBuildCalls).toBe(0);
    expect((await firestore.doc(`cmsPages/${id}`).get()).data()).toEqual(original);
    expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).exists).toBe(false);
    const post = (await firestore.doc("cmsPosts/later-cloud-post").get()).data();
    expect(post).toMatchObject({ status: "published", version: 2, published: { sourceVersion: 2, publishedAt: instant } });
    const queue = await firestore.collection("cmsPublishQueue").get();
    expect(queue.docs.some((row: any) => row.data().transport === "page-no-build-v1")).toBe(false);
    expect(queue.docs.find((row: any) => row.data().transport === "post-no-build-v1").data().backgroundRuntime)
      .toEqual({ owner: "cloudflare", release: sha });
  } finally { vi.unstubAllEnvs(); }
});
it("keeps unexpected pretransaction errors visible to the scheduler", async () => {
  await firestore.doc("cmsPages/schedule").update({ status: "scheduled", publishAt: instant, scheduledPublicationTransport: "page-no-build-v1" });
  const run = scheduler.createScheduledPublishRunner({ firestore,
    currentCodeRequest: async () => { throw new ReferenceError("Unexpected source implementation error"); }, now: () => instant,
    log: { info() {}, warn() {}, error() {} } });
  await expect(run()).rejects.toThrow("Unexpected source implementation error");
  expect((await firestore.doc("cmsPages/schedule").get()).data()).toMatchObject({ status: "scheduled", version: 1, publishAt: instant });
});

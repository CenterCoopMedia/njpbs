import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import admission from "../../functions/lib/public-release-admission.js";
import pair from "../../functions/lib/public-release-pair.js";
import save from "../../functions/save.js";
import scheduled from "../../functions/scheduled-publish.js";
import deployment from "../../functions/lib/public-deployment.js";

// Save calls the CommonJS module; observe that same instance without replacing its guard.
const require = createRequire(import.meta.url);
const compatibility = require("../../functions/lib/live-blog-compatibility.js");

const db = isolatedFirestore("live-blog-scheduled-pair.test.ts");
const firestore = new Proxy(db, {
  get(target, key) {
    if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const id = "scheduled-coverage";
const savedAt = "2026-11-03T23:00:00.000Z";
const dueAt = "2026-11-03T23:30:00.000Z";
const contract = { schemaVersion: 2, families: ["posts"], features: ["liveBlogVersion:1"] };
const actor = { uid: "schedule-publisher", email: "publisher@example.test", principal: {
  id: "schedule-publisher", grants: [{ role: "admin" }],
} };
const quiet = { info() {}, warn() {}, error() {} };
const legacy = vi.fn(async () => { throw new Error("A pair schedule must not enter legacy publication"); });
const current = async () => (await db.doc(`cmsPosts/${id}`).get()).data()!;
const run = () => scheduled.createScheduledPublishRunner({ firestore, now: () => dueAt, log: quiet,
  assertPublishReadyFn: legacy, assertPublishedMediaSafeFn: legacy, enqueuePublishFn: legacy,
  reconcileStaleFn: async () => {},
})();
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  legacy.mockClear();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await seedSwitch(firestore, { admittedContract: contract });
  await db.doc(`${admission.CONTRACTS}/${pair.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("sections/news").set({ label: "News" });
  await db.doc(`cmsPosts/${id}`).set({ id, type: "post", title: "Live election coverage", summary: "Updates from the election desk.",
    status: "draft", createdBy: actor.uid, section: "news", slug: "live-election-coverage", previousSlugs: [],
    locale: "en", tags: [], categories: [], date: "2026-11-03", credits: [{ kind: "custom", name: "Election desk" }],
    blocks: [], version: 1, updatedAt: savedAt, liveBlog: { schemaVersion: 1, coverageState: "ongoing", updates: [{
      id: "opening-report", headline: "Coverage begins", keyUpdate: true, credits: [{ kind: "custom", name: "Election desk" }],
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Reporting from polling places." }] }] },
    }] } });
});

async function assertPairPublication(sourceVersion: number) {
  const result = await run();
  expect(result.publishedCount).toBe(1);
  expect(result.publications).toEqual([expect.objectContaining({ collection: "cmsPosts", id, sourceVersion, transport: admission.TRANSPORT })]);
  const publication = result.publications[0];
  const document = await current();
  expect(document).toMatchObject({ status: "published", publiclyVisible: true, version: sourceVersion,
    publishBuildQueueId: publication.queueId, published: { sourceVersion, publishedAt: dueAt,
      metadata: { liveBlog: { schemaVersion: 1, updates: [{ id: "opening-report", publishedAt: dueAt, updatedAt: dueAt }] } } } });
  const accepted = (await db.doc(`${admission.ADMISSIONS}/operations/${publication.queueId}`).get()).data();
  expect(accepted?.source.requiredFeatures).toContain("liveBlogVersion:1");
  expect((await db.doc(`cmsPublishQueue/${publication.queueId}`).get()).data()).toMatchObject({ status: "pending", transport: admission.TRANSPORT });
  expect((await db.doc(`system/publicDeployment/noBuildPostOwners/${id}`).get()).data()).toMatchObject({ operationId: publication.queueId, visible: true });
  expect(legacy).not.toHaveBeenCalled();
}

async function requestSchedule() {
  const handler = save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => actor, enablePublishSnapshot: true,
    now: () => savedAt, assertPublishReadyFn: legacy, log: quiet });
  const response = { code: 200, headersSent: false, body: undefined as unknown, status(code: number) { this.code = code; return this; },
    set() { return this; }, json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: {
    collection: "cmsPosts", id, baseVersion: 1, scheduleAt: dueAt, document: {},
  } }, response);
  return response;
}

it("saves a pair-mode live blog schedule and publishes its due revision through pair admission", async () => {
  const response = await requestSchedule();
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  const document = await current();
  expect(document).toMatchObject({ status: "scheduled", publishAt: dueAt, scheduledPublicationTransport: admission.TRANSPORT });
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
  await assertPairPublication(document.version + 1);
});

it("keeps the installed renderer gate when saving a non-pair live blog schedule", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: "a".repeat(40),
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "legacy", mediaLifecycleReady: true });
  const ref = db.doc("system/publicDeployment/noBuildPosts/capability");
  const capability = (await ref.get()).data()!;
  delete capability.liveBlogVersion;
  await ref.set(capability);
  const check = vi.spyOn(compatibility, "assertLiveBlogRenderer");
  const before = await current();
  const response = await requestSchedule();
  expect(response.code, JSON.stringify(response.body)).toBe(409);
  expect(response.body).toMatchObject({ error: expect.stringContaining("installed Post renderer") });
  expect(check, JSON.stringify(response.body)).toHaveBeenCalledOnce();
  expect(await current()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});

it("publishes an already-scheduled live blog without parsing the schema-two root as a legacy pointer", async () => {
  await db.doc(`cmsPosts/${id}`).update({ status: "scheduled", publishAt: dueAt, scheduledPublicationTransport: admission.TRANSPORT });
  await assertPairPublication(2);
});

it.each(["contract", "renderer"])("preserves a scheduled live blog when pair %s feature support is missing", async missing => {
  if (missing === "contract") {
    const unsupported = { ...contract, features: [] };
    await db.doc("system/publicDeployment").update({ admittedContractDigest: pair.publicReleaseDigest(unsupported) });
    await db.doc(`${admission.CONTRACTS}/${pair.publicReleaseDigest(unsupported)}`).set(unsupported);
  } else {
    const ref = db.doc("system/publicDeployment/noBuildPosts/capability");
    const capability = (await ref.get()).data()!;
    delete capability.liveBlogVersion;
    await ref.set(capability);
  }
  await db.doc(`cmsPosts/${id}`).update({ status: "scheduled", publishAt: dueAt, scheduledPublicationTransport: admission.TRANSPORT });
  const before = await current();
  expect((await run()).publishedCount).toBe(0);
  expect(await current()).toEqual(before);
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
});

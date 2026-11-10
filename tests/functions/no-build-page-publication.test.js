import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import composition from "../../functions/lib/data-hub-composition.js";
import pageCandidate from "../../functions/lib/no-build-page-candidate.js";
import pageServing from "../../functions/lib/no-build-page-serving.js";
import previewService from "../../functions/preview.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../functions/lib/firebase.js";
import homeFixture from "../../site/tests/fixtures/home-composition-v1.json";
import scheduler from "../../functions/scheduled-publish.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import pagePublication from "../../functions/lib/no-build-page-publication.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import admission from "../../functions/lib/no-build-family-admission.js";
import reconcile from "../../functions/lib/publish-reconcile.js";
import reporting from "../../functions/lib/data-hub-reporting.js";
const db = isolatedFirestore("no-build-page-publication.test.js");

const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const sha = "a".repeat(40);
const oldQueueId = "A".repeat(20);
const instant = "2026-10-12T12:00:00.000Z";
// Only the target hint is dev; every SDK method remains bound to the local demo
// emulator. The test never opens a development or production database.
const firestore = new Proxy(db, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
const actor = { uid: "page-editor", email: "editor@example.test" };
const config = enabled => ({ schemaVersion: 2, revision: 7, enabled,
  families: { pages: { mode: "ids", ids: ["contact"] } }, backgroundBucket: "njpbs-dev-public-artifacts" });
const pointer = () => ({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
  activeCommitSha: sha, activeDeploymentId: "11111111-1111-4111-8111-111111111111", lastReservedGeneration: 1,
  newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
async function prepare(nextDocument, { pageId = "contact", queueRef = db.collection("cmsPublishQueue").doc(), write = false } = {}) {
  return firestore.runTransaction(async transaction => {
    const prepared = await pagePublication.prepareNoBuildPagePublication({ firestore, transaction,
      collection: "cmsPages", documentId: pageId, nextDocument, queueRef, actor });
    if (write && prepared) {
      prepared.write();
      transaction.set(db.doc(`cmsPages/${pageId}`), nextDocument);
    }
    return prepared;
  });
}
async function current() { return (await db.doc("cmsPages/contact").get()).data(); }
async function withdraw() { return { ...await current(), version: 2, publiclyVisible: false, status: "draft" }; }
async function seedOwner() {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages",
    document: { id: "contact", version: 1, title: "Contact", previousSlugs: ["former"], blocks: [] },
    publishedAt: instant, publishedBy: actor.uid });
  const state = { schemaVersion: 1, pageId: "contact", operationId: oldQueueId, rendererSha: sha,
    sourceVersion: 1, generation: 1, path: "/contact/", ownedPaths: ["/contact/", "/former/"], visible: true,
    snapshotDigest: ownership.digest(published), servingEnabled: true, admissionRevision: 6,
    runtime: { owner: "cloudflare", release: sha } };
  await db.doc("cmsPages/contact").set({ id: "contact", version: 1, status: "draft", publiclyVisible: true,
    title: "Private draft", blocks: [], published });
  await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).set(state);
  await db.doc(`cmsPublishQueue/${oldQueueId}`).set({ status: "pending", transport: pagePublication.TRANSPORT,
    noBuildPage: state, backgroundRuntime: state.runtime });
  for (const path of state.ownedPaths) await ownership.pageRouteRef(db, path).set({ schemaVersion: 1, pageId: "contact", path });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(project)) throw new Error("Use the local demo Firestore emulator");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/noBuildPostAdmission").set(config(true));
  await db.doc("system/publicDeployment").set(pointer());
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 7 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused", commitSha: sha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } });
  await db.doc(ownership.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  await seedOwner();
});

describe("Page withdrawal acceptance and protected transport", () => {
  it.each(["paused", "unselected", "invalid"])("accepts an owned removal with admission %s while retaining all routes", async mode => {
    const record = mode === "invalid" ? { broken: true } : config(mode !== "paused");
    if (mode === "unselected") record.families = {};
    await db.doc("system/noBuildPostAdmission").set(record);
    const removal = await prepare(await withdraw(), { write: true });
    expect(removal.transport).toBe("page-no-build-v1");
    const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data();
    expect(owner).toMatchObject({ visible: false, ownedPaths: ["/contact/", "/former/"], sourceVersion: 1,
      operationId: removal.queueId, generation: 2, contextRevision: 8,
      durableWithdrawal: { schemaVersion: 1, pageId: "contact", operationId: removal.queueId,
        sourceVersion: 1, revision: 2, ownedPaths: ["/contact/", "/former/"], contextRevision: 8 } });
    expect((await db.doc(`cmsPublishQueue/${removal.queueId}`).get()).data().changes)
      .toEqual([{ collection: "cmsPages", id: "contact", sourceVersion: 1, operation: "withdraw" }]);
    expect((await db.doc(`cmsPublishQueue/${oldQueueId}`).get()).data().status).toBe("cancelled");
    expect((await db.collection(ownership.PAGE_ROUTE_COLLECTION).get()).size).toBe(2);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(8);
    expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(1);
    expect((await current()).title).toBe("Private draft");
  });
  it("prepares without committing any acceptance writes", async () => {
    const before = await current();
    await prepare(await withdraw());
    expect(await current()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
  });
  it("rejects a paused owned publication without falling back", async () => {
    await db.doc("system/noBuildPostAdmission").set(config(false));
    await expect(prepare({ ...await current(), version: 2 })).rejects.toMatchObject({ status: 409, scheduleDeferred: true });
  });
  it.each(["capability missing", "cloud paused", "renderer changed", "original queue replaced"])("fences removal when %s", async fault => {
    if (fault === "capability missing") await db.doc(ownership.PAGE_CAPABILITY_PATH).delete();
    if (fault === "cloud paused") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
    if (fault === "renderer changed") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
    if (fault === "original queue replaced") await db.doc(`cmsPublishQueue/${oldQueueId}`).update({ transport: "serializer" });
    await expect(prepare(await withdraw(), { write: true })).rejects.toThrow();
    expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data().operationId).toBe(oldQueueId);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("accepts only one duplicate removal at the same saved version", async () => {
    const next = await withdraw();
    const results = await Promise.allSettled([prepare(next, { write: true }), prepare(next, { write: true })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(3);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(8);
  });
  it("keeps an unselected static Page from taking an owned alias", async () => {
    const pageId = `page-${"2".repeat(32)}`;
    await expect(prepare({ version: 2, published: { sourceVersion: 2, metadata: { slug: "former" } } }, { pageId }))
      .rejects.toThrow("owns this public route");
  });
  it("cannot apply a production target to the development database", async () => {
    await expect(firestore.runTransaction(transaction => pagePublication.prepareNoBuildPagePublication({ firestore, transaction,
      collection: "cmsPages", documentId: "contact", nextDocument: { version: 2, publiclyVisible: false },
      queueRef: db.collection("cmsPublishQueue").doc(), actor,
      target: require("../../functions/lib/publication-target.js").publicationTarget("production") }))).rejects.toThrow();
  });
});


async function invoke(handler, body) {
  const response = { code: 200, headersSent: false, status(code) { this.code = code; return this; },
    set() { return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, response);
  return response;
}
const pageActor = { ...actor, principal: { id: actor.uid, grants: [{ role: "admin" }] } };
const quiet = { info() {}, warn() {}, error() {} };
const offlineBuild = vi.fn(async () => { throw new Error("The full-build transport is offline"); });
function saveHandler(user = pageActor, deps = {}) {
  return save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => user,
    now: () => instant, enablePublishSnapshot: true, assertPublishReadyFn: offlineBuild, log: quiet, ...deps });
}

describe("Data Hub first publication", () => {
  const document = { title: "New Jersey by the Numbers", description: "State figures",
    dataHubReporting: { ...reporting.emptyDataHubReporting(), figures: {
      minimumwage: { ...reporting.emptyReportingMapping(), posts: { tags: ["minimum wage"], categories: [] } },
    } } };
  beforeEach(async () => {
    await db.doc("system/noBuildPostAdmission").update({ "families.pages.ids": ["contact", "data-hub"] });
    await db.doc(ownership.PAGE_CAPABILITY_PATH).update({ dataHubReportingVersion: 1 });
  });
  it.each(["new draft", "legacy draft"])("publishes reporting without blocks from a %s", async mode => {
    const ref = db.doc("cmsPages/data-hub");
    expect((await ref.get()).exists).toBe(false);
    let baseVersion;
    if (mode === "new draft") {
      const draft = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", document });
      expect(draft.code, JSON.stringify(draft.body)).toBe(200);
      baseVersion = 1;
    } else {
      // The saved version from the failed first publication has no blocks field.
      await ref.set({ ...document, id: "data-hub", template: "genericPage", status: "draft", version: 4 });
      baseVersion = 4;
    }
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion,
      publish: true, document: {} });
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect(result.body.publication.transport).toBe("page-no-build-v1");
    const stored = (await ref.get()).data();
    expect(stored).toMatchObject({ status: "published", blocks: [], published: { blocks: [],
      sourceVersion: baseVersion + 1, metadata: document } });
    const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/data-hub`).get()).data();
    expect(owner).toMatchObject({ path: "/data-hub/", ownedPaths: ["/data-hub/"], visible: true });
    expect((await db.doc(`cmsPublishQueue/${result.body.publication.queueId}`).get()).data().transport)
      .toBe("page-no-build-v1");
  });
  it("keeps blocks required for an ordinary Page", async () => {
    await db.doc("cmsPages/contact").delete();
    const draft = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", document: { title: "Contact" } });
    expect(draft.code, JSON.stringify(draft.body)).toBe(200);
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
      publish: true, document: {} });
    expect(result).toMatchObject({ code: 400, body: { error: "blocks is required" } });
    expect((await db.doc("cmsPages/contact").get()).data()).toMatchObject({ version: 1, status: "draft" });
  });
  it.each([
    [{ document: { ...document, blocks: [composition.defaultDataHubBlocks()[0]] } }, /explicit composition version/],
    [{ slug: "new-data-hub" }, /address stays fixed/],
    [{ document: { ...document, dataHubReporting: { ...document.dataHubReporting, surprise: true } } }, /Check the Data Hub reporting terms/],
    [{ document: { ...document, blocks: null } }, /blocks must be an array/],
  ])("refuses forbidden Data Hub input (%j)", async (override, error) => {
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub",
      document, ...override });
    expect(result.code).toBe(400);
    expect(result.body.error).toMatch(error);
    expect((await db.doc("cmsPages/data-hub").get()).exists).toBe(false);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("preserves retained ordinary legacy blocks without activating composition during metadata publication", async () => {
    const blocks = [{ id: "legacy-divider", type: "divider", order: 0, visible: true, data: {} }];
    await db.doc("cmsPages/data-hub").set({ ...document, blocks, id: "data-hub", template: "genericPage", status: "draft", version: 4 });
    const saved = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 4,
      document: { description: "Updated browser summary" } });
    expect(saved.code, JSON.stringify(saved.body)).toBe(200);
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 5,
      publish: true, document: {} });
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    const stored = (await db.doc("cmsPages/data-hub").get()).data();
    expect(stored.blocks).toEqual(blocks);
    expect(stored.published.blocks).toEqual(blocks);
    expect(stored.dataHubCompositionVersion).toBeUndefined();
    expect(stored.published.metadata.dataHubCompositionVersion).toBeUndefined();
  });
  it("keeps the Data Hub renderer gate closed", async () => {
    const ref = db.doc(ownership.PAGE_CAPABILITY_PATH);
    const capability = (await ref.get()).data();
    delete capability.dataHubReportingVersion;
    await ref.set(capability);
    const draft = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", document });
    expect(draft.code, JSON.stringify(draft.body)).toBe(200);
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 1,
      publish: true, document: {} });
    expect(result).toMatchObject({ code: 409, body: { error: "The Data Hub publication gate is closed." } });
    expect((await db.doc("cmsPages/data-hub").get()).data()).toMatchObject({ version: 1, status: "draft" });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
});

it("keeps a Page draft save private without advancing accepted ownership or context", async () => {
  const before = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data();
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    document: { title: "New private draft" } });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect((await current()).title).toBe("New private draft");
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
});
it("denies ordinary-role Page publication before any acceptance", async () => {
  const writer = { ...pageActor, principal: { id: actor.uid, grants: [{ role: "writer" }] } };
  const result = await invoke(saveHandler(writer), { collection: "cmsPages", id: "contact", baseVersion: 1,
    publish: true, document: {} });
  expect(result.code).toBe(403);
  expect((await current()).version).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});
it("withdraws an owned Page through the authenticated lifecycle while the serializer is paused", async () => {
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet });
  const result = await invoke(handler, { collection: "cmsPages", id: "contact", baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.publication.transport).toBe("page-no-build-v1");
  expect((await current()).publishBuildQueueId).toBe(result.body.publication.queueId);
  expect((await current()).publiclyVisible).toBe(false);
});
it.each(["paused", "unavailable", "legacy_snapshot"])("removes a selected Page before ownership through its existing owner when %s", async mode => {
  await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).delete();
  await db.doc(`cmsPublishQueue/${oldQueueId}`).delete();
  for (const path of ["/contact/", "/former/"]) await ownership.pageRouteRef(db, path).delete();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  if (mode === "paused") await db.doc("system/noBuildPostAdmission").set(config(false));
  if (mode === "unavailable") await db.doc(ownership.PAGE_CAPABILITY_PATH).delete();
  if (mode === "legacy_snapshot") await db.doc("cmsPages/contact").update({ "published.metadata.template": "legacy-page" });
  const enqueue = vi.fn(async () => ({ queueId: "L".repeat(20) }));
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet, enqueuePublishBuildFn: enqueue });
  const result = await invoke(handler, { collection: "cmsPages", id: "contact", baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.publication).toEqual({ status: "queued", queueId: "L".repeat(20) });
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0][0].changes).toEqual([{ collection: "cmsPages", id: "contact", sourceVersion: 1, operation: "withdraw" }]);
  expect((await current()).publiclyVisible).toBe(false);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).exists).toBe(false);
  expect((await db.collection(ownership.PAGE_ROUTE_COLLECTION).get()).size).toBe(0);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(0);
});
it("defers an owned Page publish when the renderer is unavailable without invoking legacy dispatch", async () => {
  offlineBuild.mockClear();
  await db.doc(ownership.PAGE_CAPABILITY_PATH).delete();
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect(offlineBuild).not.toHaveBeenCalled();
  expect((await current()).version).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("publishes the exact Page draft and owner atomically with the full-build owner paused", async () => {
  offlineBuild.mockClear();
  expect((await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    document: { title: "Accepted Page" } })).code).toBe(200);
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 2,
    publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.publication.transport).toBe("page-no-build-v1");
  const saved = await current();
  const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data();
  const queue = (await db.doc(`cmsPublishQueue/${result.body.publication.queueId}`).get()).data();
  expect(saved.published).toMatchObject({ sourceVersion: 3, metadata: { title: "Accepted Page" } });
  expect(owner.snapshotDigest).toBe(ownership.digest(saved.published));
  expect(owner).toMatchObject({ operationId: result.body.publication.queueId, sourceVersion: 3, contextRevision: 8 });
  expect(queue.noBuildPage.contextDigest).toBe(owner.contextDigest);
  expect(saved.publishBuildQueueId).toBe(owner.operationId);
  expect(offlineBuild).not.toHaveBeenCalled();
});

it("replaces a later-release figure seal when republishing a nonfigure Page", async () => {
  const ownerRef = db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`);
  await ownerRef.update({ datasetFiguresDigest: ownership.digest({ figures: [], releases: [] }) });
  expect((await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    document: { title: "Nonfigure revision after rollback" } })).code).toBe(200);
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 2,
    publish: true, document: {} });

  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const saved = await current();
  const owner = (await ownerRef.get()).data();
  expect(owner.snapshotDigest).toBe(ownership.digest(saved.published));
  expect(owner).not.toHaveProperty("datasetFiguresDigest");
  expect(() => ownership.assertPageOwnerSnapshot(owner, saved)).not.toThrow();
});

it("accepts two independent Pages with distinct durable operations and shared generations", async () => {
  await db.doc("system/noBuildPostAdmission").set({ ...config(true), families: { pages: { mode: "all" } } });
  const pageId = `page-${"2".repeat(32)}`;
  await db.doc(`cmsPages/${pageId}`).set({ id: pageId, version: 1, title: "Second Page", slug: "second-page",
    previousSlugs: [], template: "genericPage", section: "station", status: "draft", blocks: [], createdBy: actor.uid });
  const first = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1, publish: true, document: {} });
  const second = await invoke(saveHandler(), { collection: "cmsPages", id: pageId, baseVersion: 1, publish: true, document: {} });
  expect([first.code, second.code], JSON.stringify([first.body, second.body])).toEqual([200, 200]);
  expect(first.body.publication.queueId).not.toBe(second.body.publication.queueId);
  const owners = await ownership.listNoBuildPageOwners({ firestore });
  // Content operations have distinct IDs and share the same next code-generation
  // bound; only a code build reserves the coordinator counter.
  expect(owners.map(owner => owner.state.generation).sort()).toEqual([2, 2]);
  expect(owners).toHaveLength(2);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(9);
});

it("accepts only one duplicate Page publish at the same saved version", async () => {
  const body = { collection: "cmsPages", id: "contact", baseVersion: 1, publish: true, document: {} };
  const results = await Promise.all([invoke(saveHandler(), body), invoke(saveHandler(), body)]);
  expect(results.map(result => result.code).sort()).toEqual([200, 409]);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(3);
  expect((await current()).version).toBe(2);
});

it("retains canonical and former routes through a rename and withdrawal", async () => {
  expect((await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    slug: "contact-us", document: {} })).code).toBe(200);
  const renamed = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 2,
    publish: true, document: {} });
  expect(renamed.code, JSON.stringify(renamed.body)).toBe(200);
  const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data();
  expect(owner.path).toBe("/contact-us/");
  expect([...owner.ownedPaths].sort()).toEqual(["/contact-us/", "/contact/", "/former/"]);
  const transition = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet });
  const removed = await invoke(transition, { collection: "cmsPages", id: "contact", baseVersion: 3, action: "unpublish" });
  expect(removed.code, JSON.stringify(removed.body)).toBe(200);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data())
    .toMatchObject({ visible: false, path: owner.path, ownedPaths: owner.ownedPaths, sourceVersion: 3 });
  const marker = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data().durableWithdrawal;
  const republished = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 4,
    publish: true, document: {} });
  expect(republished.code, JSON.stringify(republished.body)).toBe(200);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data()).toMatchObject({
    visible: true, generation: marker.revision + 1, durableWithdrawal: marker });
});

it("accepts a compatible release successor without relabeling the original operation", async () => {
  const successor = "b".repeat(40);
  await db.doc(ownership.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: successor, servingEnabled: true, generation: 3,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: successor } });
  await db.doc("system/publicDeployment").update({ activeCommitSha: successor, activeGeneration: 3,
    lastReservedGeneration: 3, newestEligibleGeneration: 3, newestEligibleBuildBatchId: "successor" });
  await db.doc("system/cmsPublicationRuntime").update({ "cloud.commitSha": successor });
  expect((await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    document: { title: "Compatible Page" } })).code).toBe(200);
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 2,
    publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data()).toMatchObject({
    rendererSha: successor, runtime: { owner: "cloudflare", release: successor }, generation: 4 });
  expect((await db.doc(`cmsPublishQueue/${oldQueueId}`).get()).data().backgroundRuntime)
    .toEqual({ owner: "cloudflare", release: sha });
});

const due = "2026-10-13T12:00:00.000Z";
function runScheduler(deps = {}) {
  return scheduler.createScheduledPublishRunner({ firestore, now: () => due, log: quiet,
    assertPublishReadyFn: offlineBuild, assertPublishedMediaSafeFn: offlineBuild,
    enqueuePublishFn: offlineBuild, reconcileStaleFn: async () => {}, ...deps })();
}
it("retains a legacy Page schedule selected during a pause until build-free admission resumes", async () => {
  const id = "faq";
  await db.doc(`cmsPages/${id}`).set({ id, version: 1, title: "FAQ", template: "genericPage", section: "support",
    slug: id, blocks: [], status: "draft", createdBy: actor.uid });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  const legacy = { assertPublishReadyFn: async () => ({ transport: "github" }),
    assertPublishedMediaSafeFn: async () => {}, enqueuePublishFn: vi.fn(async () => ({ queueId: "L".repeat(20) })) };
  const scheduled = await invoke(saveHandler(pageActor, legacy), { collection: "cmsPages", id, baseVersion: 1,
    scheduleAt: due, document: {} });
  expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
  expect(scheduled.body.document.scheduledPublicationTransport).toBeUndefined();
  await db.doc("system/noBuildPostAdmission").set({ ...config(false), families: { pages: { mode: "all" } } });
  expect((await runScheduler(legacy)).publishedCount).toBe(0);
  const deferred = (await db.doc(`cmsPages/${id}`).get()).data();
  expect(deferred).toMatchObject({ status: "scheduled", version: 2, publishAt: due });
  expect(deferred.scheduledPublishFailure).toBeUndefined();
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
  expect(legacy.enqueuePublishFn).not.toHaveBeenCalled();
  await db.doc("system/noBuildPostAdmission").set({ ...config(true), families: { pages: { mode: "all" } } });
  expect((await runScheduler(legacy)).publications[0]).toMatchObject({ id, sourceVersion: 3, transport: "page-no-build-v1" });
});
it("schedules a future Page without an operation, then accepts its exact due version build-free", async () => {
  offlineBuild.mockClear();
  const scheduled = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    scheduleAt: due, document: {} });
  expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
  expect(await current()).toMatchObject({ status: "scheduled", version: 2, scheduledPublicationTransport: "page-no-build-v1" });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data().operationId).toBe(oldQueueId);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
  const result = await runScheduler();
  expect(result.publishedCount).toBe(1);
  expect(result.publications[0]).toMatchObject({ collection: "cmsPages", id: "contact", transport: "page-no-build-v1", sourceVersion: 3 });
  expect(await current()).toMatchObject({ status: "published", version: 3, published: { sourceVersion: 3 } });
  expect((await current()).scheduledPublicationTransport).toBeUndefined();
  expect(offlineBuild).not.toHaveBeenCalled();
});
it("defers a due Page across a cloud handoff without losing the schedule or falling back", async () => {
  const scheduled = await invoke(saveHandler(), { collection: "cmsPages", id: "contact", baseVersion: 1,
    scheduleAt: due, document: {} });
  expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
  await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
  expect((await runScheduler()).publishedCount).toBe(0);
  expect(await current()).toMatchObject({ status: "scheduled", version: 2, publishAt: due });
  expect((await current()).scheduledPublishFailure).toBeUndefined();
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "ready" });
  expect((await runScheduler()).publishedCount).toBe(1);
});
it("keeps accepted Page confirmation failures out of the serializer pending scan", async () => {
  await db.doc("cmsPages/contact").update({ status: "published", publishBuildPending: true, publishBuildQueueId: null });
  offlineBuild.mockClear();
  expect((await runScheduler()).publishedCount).toBe(0);
  expect(offlineBuild).not.toHaveBeenCalled();
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).get()).data().operationId).toBe(oldQueueId);
});


it.each(["unpublish", "archive"])("refuses owned Home %s without altering root authority", async action => {
  const home = { ...structuredClone(homeFixture), id: "home", version: 1, status: "published", publiclyVisible: true };
  home.published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: home,
    publishedAt: instant, publishedBy: actor.uid });
  const owner = { schemaVersion: 1, pageId: "home", operationId: "H".repeat(20), rendererSha: sha,
    sourceVersion: 1, generation: 1, path: "/", ownedPaths: ["/", "/_home-sources.json"], visible: true,
    snapshotDigest: ownership.digest(home.published), servingEnabled: true, runtime: { owner: "cloudflare", release: sha } };
  await db.doc("cmsPages/home").set(home);
  await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).set(owner);
  await db.doc(`cmsPublishQueue/${owner.operationId}`).set({ transport: "page-no-build-v1", status: "success",
    noBuildPage: owner, backgroundRuntime: owner.runtime });
  const transition = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet });
  const result = await invoke(transition, { collection: "cmsPages", id: "home", baseVersion: 1, action });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect(result.body.error).toMatch(/homepage can't be unpublished/);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data()).toEqual(owner);
  expect((await db.doc("cmsPages/home").get()).data().publiclyVisible).toBe(true);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
});


it("accepts aggregate context work at the same Page revision with zero Post owners", async () => {
  expect((await db.collection("system/publicDeployment/noBuildPostOwners").get()).empty).toBe(true);
  const next = await withdraw();
  const result = await prepare(next, { write: true });
  const parent = (await db.doc(`cmsPublishQueue/${result.queueId}`).get()).data();
  const childId = pagePublication.pageAggregateOperationId(result.queueId);
  expect(childId).not.toBe(result.queueId);
  expect(parent.noBuildPage.contextQueueId).toBe(childId);
  expect(parent.contextPublication).toEqual({ queueId: childId, contextRevision: 8,
    contextDigest: parent.noBuildPage.contextDigest,
    outputs: ["listings", "authors", "feed", "contentApi", "sitemap", "search"] });
  const child = (await db.doc(`cmsPublishQueue/${childId}`).get()).data();
  expect(child).toMatchObject({ transport: "public-context-no-build-v1", status: "pending",
    publicContext: { operationId: childId, contextRevision: 8, contextDigest: parent.noBuildPage.contextDigest } });
  const tasks = await db.collection(`cmsPublishQueue/${childId}/backgroundOutputs`).get();
  expect(tasks.docs.map(row => row.id).sort()).toEqual(["authors", "contentApi", "feed", "listings", "search", "sitemap"]);
  expect((await db.doc("cmsBackgroundOutputs/home").get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(8);
});

async function seedHomeForAcceptance({ claim = null, compositionVersion = 1 } = {}) {
  const home = { ...structuredClone(homeFixture), id: "home", version: 1, status: "draft", publiclyVisible: false,
    homeCompositionVersion: compositionVersion };
  home.published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: home,
    publishedAt: instant, publishedBy: actor.uid });
  await db.doc("cmsPages/home").set(home);
  await db.doc("system/noBuildPostAdmission").set({ ...config(true), families: { pages: { mode: "all" } } });
  const taskPath = "cmsPublishQueue/legacy-home-post/backgroundOutputs/home";
  await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 1,
    status: "pending", claim, nextAttemptAt: 0 });
  await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", output: "home", revision: 1,
    status: "pending", taskPath });
  return taskPath;
}
it.each([1, 2])("accepts Home v%s and both root routes while atomically retiring only unclaimed legacy work", async compositionVersion => {
  const taskPath = await seedHomeForAcceptance({ compositionVersion });
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1, publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data();
  const marker = (await db.doc("cmsBackgroundOutputs/home").get()).data();
  expect(owner).toMatchObject({ pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"], visible: true,
    operationId: result.body.publication.queueId, sourceVersion: 2 });
  expect(marker).toMatchObject({ owner: "page-no-build-v1", operationId: owner.operationId });
  const operation = (await db.doc(`cmsPublishQueue/${result.body.publication.queueId}`).get()).data();
  expect(result.body.publication.transport).toBe("page-no-build-v1");
  expect(operation).toMatchObject({ transport: "page-no-build-v1", noBuildPage: { pageId: "home", sourceVersion: 2 } });
  expect((await db.doc(taskPath).get()).data()).toMatchObject({ status: "superseded", claim: null });
  for (const path of owner.ownedPaths) expect((await ownership.pageRouteRef(db, path).get()).data()).toMatchObject({ pageId: "home", path });
  const child = (await db.doc(`cmsPublishQueue/${owner.contextQueueId}`).get()).data();
  expect(child.publicContext.contextRevision).toBe(owner.contextRevision);
});
it("converts a published v1 privately, then publishes its exact editorial draft through the Page owner", async () => {
  await seedHomeForAcceptance();
  const original = (await db.doc("cmsPages/home").get()).data();
  await db.doc("cmsPages/home").update({ status: "published", publishAt: instant, publiclyVisible: true });
  const converted = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1,
    convertHomeV2: "editorial-home-from-live", document: {} });
  expect(converted.code, JSON.stringify(converted.body)).toBe(200);
  expect(converted.body.document).toMatchObject({ status: "draft", homeCompositionVersion: 2, version: 2,
    published: original.published, publiclyVisible: true });
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).exists).toBe(false);
  const published = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 2, publish: true, document: {} });
  expect(published.code, JSON.stringify(published.body)).toBe(200);
  expect(published.body.publication.transport).toBe("page-no-build-v1");
  expect(published.body.warnings).toContain("The standard newsletter band appears until a newsletter is chosen.");
  const operation = (await db.doc(`cmsPublishQueue/${published.body.publication.queueId}`).get()).data();
  expect(operation).toMatchObject({ transport: "page-no-build-v1", noBuildPage: { pageId: "home", sourceVersion: 3 } });
  expect(published.body.document.published).toMatchObject({ sourceVersion: 3, metadata: { homeCompositionVersion: 2 },
    blocks: converted.body.document.blocks });
});

it.each(["unpublish", "archive"])("refuses a selected Home without accepted ownership on %s", async action => {
  await seedHomeForAcceptance();
  await db.doc("cmsPages/home").update({ status: "published", publiclyVisible: true });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  const enqueue = vi.fn();
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet, enqueuePublishBuildFn: enqueue });
  const result = await invoke(handler, { collection: "cmsPages", id: "home", baseVersion: 1, action });
  expect(result.code).toBe(409);
  expect(result.body.error).toMatch(/homepage can't be unpublished/);
  expect((await db.doc("cmsPages/home").get()).data().publiclyVisible).toBe(true);
  expect(enqueue).not.toHaveBeenCalled();
});
it("schedules Home v2 without transferring either root route before its exact due publication", async () => {
  offlineBuild.mockClear();
  const taskPath = await seedHomeForAcceptance({ compositionVersion: 2 });
  const scheduled = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1,
    scheduleAt: due, document: {} });
  expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
  expect((await db.doc("cmsPages/home").get()).data()).toMatchObject({ status: "scheduled", version: 2,
    homeCompositionVersion: 2, scheduledPublicationTransport: "page-no-build-v1" });
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).exists).toBe(false);
  expect((await db.doc(taskPath).get()).data().status).toBe("pending");
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
  const result = await runScheduler();
  expect(result.publishedCount).toBe(1);
  expect(result.publications[0]).toMatchObject({ id: "home", transport: "page-no-build-v1", sourceVersion: 3 });
  const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data();
  expect(owner).toMatchObject({ sourceVersion: 3, ownedPaths: ["/", "/_home-sources.json"], visible: true });
  expect((await db.doc(taskPath).get()).data().status).toBe("superseded");
  expect(offlineBuild).not.toHaveBeenCalled();
});
it("cannot transfer Home while the legacy background claim is uncertain", async () => {
  const taskPath = await seedHomeForAcceptance({ claim: "uncertain-legacy-claim" });
  const result = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1, publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(409);
  expect((await db.doc(taskPath).get()).data().claim).toBe("uncertain-legacy-claim");
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).exists).toBe(false);
  expect((await db.doc("cmsPages/home").get()).data().version).toBe(1);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
});
it("republishes Home with monotonic dirty revision and preserves an older refresh claim", async () => {
  await seedHomeForAcceptance();
  const first = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1, publish: true, document: {} });
  expect(first.code, JSON.stringify(first.body)).toBe(200);
  const firstOwner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data();
  const sourceOperationId = "P".repeat(20);
  const taskPath = `cmsPublishQueue/${sourceOperationId}/homePageRefresh/home`;
  const refresh = { schemaVersion: 1, revision: 4, sourceOperationId, postId: "placed-post", sourceVersion: 2, status: "pending", taskPath };
  await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).update({ homeRefresh: refresh });
  await db.doc(taskPath).set({ schemaVersion: 1, owner: "page-no-build-v1", revision: 4,
    input: { homeOperationId: firstOwner.operationId, homeSourceVersion: firstOwner.sourceVersion },
    status: "pending", claim: "refresh-preparing-claim" });
  // Reopen as a draft while retaining the public snapshot, like the lifecycle's
  // revise action; acceptance must not replay the old dirty Home operation.
  await db.doc("cmsPages/home").update({ status: "draft" });
  const next = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 2, publish: true, document: {} });
  expect(next.code, JSON.stringify(next.body)).toBe(200);
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data().homeRefresh)
    .toMatchObject({ revision: 4, status: "superseded", supersededBy: next.body.publication.queueId });
  expect((await db.doc(taskPath).get()).data())
    .toMatchObject({ revision: 4, status: "superseded", claim: "refresh-preparing-claim" });
});

it.each([
  { id: "public-meetings", template: "genericPage", section: "compliance",
    path: "/meeting-notices/", routes: ["/meeting-notices/", "/public-meetings/"] },
  { id: "give", template: "programLanding", section: "support",
    path: "/give/", routes: ["/donate/", "/give/"] },
])("claims the canonical and frozen legacy routes for $id", async ({ id, template, section, path, routes }) => {
  const document = { id, version: 1, title: "Public Page", template, status: "draft",
    section, slug: id, previousSlugs: [], blocks: [], createdBy: actor.uid };
  await db.doc(`cmsPages/${id}`).set(document);
  await db.doc("system/noBuildPostAdmission").set({ ...config(true), families: { pages: { mode: "all" } } });
  const result = await invoke(saveHandler(), { collection: "cmsPages", id, baseVersion: 1, publish: true, document: {} });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const owner = (await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).data();
  expect(owner.path).toBe(path);
  expect([...owner.ownedPaths].sort()).toEqual(routes);
  for (const route of routes) {
    expect((await ownership.pageRouteRef(db, route).get()).data()).toMatchObject({ pageId: id, path: route });
  }
});


it("keeps an accepted Page withdrawal and its queue link owned after the serializer reconciliation cutoff", async () => {
  const handler = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
    now: () => instant, log: quiet });
  const result = await invoke(handler, { collection: "cmsPages", id: "contact", baseVersion: 1, action: "unpublish" });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const ownerRef = db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`);
  const owner = await ownerRef.get();
  const queueRef = db.doc(`cmsPublishQueue/${owner.data().operationId}`);
  const pageRef = db.doc("cmsPages/contact");
  const before = await db.getAll(queueRef, pageRef, ownerRef);
  expect(before[0].data()).toMatchObject({ status: "pending", transport: "page-no-build-v1" });
  expect(before[1].data()).toMatchObject({ publishBuildQueueId: queueRef.id });
  const staleNow = before[0].data().triggeredAt.toMillis() + 25 * 60 * 60 * 1000;
  expect(await reconcile.reconcileStalePublishRows({ firestore: db, now: () => staleNow })).toBe(0);
  const after = await db.getAll(queueRef, pageRef, ownerRef);
  for (let index = 0; index < before.length; index++) {
    expect(after[index].data()).toEqual(before[index].data());
    expect(after[index].updateTime).toEqual(before[index].updateTime);
  }
});


it.each([
  ["schedule", "all"], ["schedule", "ids"], ["live", "all"], ["live", "ids"],
])("requires a qualified packet for unowned %s under %s Page admission", async (pageId, mode) => {
  await db.doc("system/noBuildPostAdmission").set({ ...config(true), families: {
    pages: mode === "all" ? { mode } : { mode, ids: [pageId] },
  } });
  const selected = await db.runTransaction(transaction => pagePublication.pagePublicationSelected({ firestore,
    transaction, documentId: pageId }));
  expect(selected).toBe(true);
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages",
    document: { id: pageId, version: 2, title: pageId, blocks: [] }, publishedAt: instant, publishedBy: actor.uid });
  const next = { id: pageId, version: 2, title: pageId, status: "published", publiclyVisible: true, blocks: [], published };
  await expect(prepare(next, { pageId, write: true })).rejects.toThrow("Schedule and Live require qualified sealed schedule authority");
  expect((await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/${pageId}`).get()).exists).toBe(false);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(7);
});


it.each(["old", "foreign", "malformed"])("refuses Page acceptance with %s terminal owner support and no writes", async mode => {
  const capRef = db.doc(ownership.PAGE_CAPABILITY_PATH);
  const capability = (await capRef.get()).data();
  if (mode === "old") delete capability.terminalOwner;
  if (mode === "foreign") capability.terminalOwner.rendererSha = "b".repeat(40);
  if (mode === "malformed") capability.terminalOwner = { schemaVersion: 1, transport: "page-no-build-v1" };
  await capRef.set(capability);
  const refs = [capRef, db.doc("cmsPages/contact"), db.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`),
    db.doc("system/publicDeployment"), db.doc("system/publicDeployment/contexts/public"), db.doc(`cmsPublishQueue/${oldQueueId}`)];
  const snapshot = async () => (await db.getAll(...refs)).map(row => ({ data: row.data(), updateTime: row.updateTime }));
  const before = await snapshot();
  await expect(prepare(await withdraw(), { write: true })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});


it("keeps uploaded-media deployment coordination ready after a Page acceptance", async () => {
  const pointerRef = db.doc("system/publicDeployment");
  const before = await pointerRef.get();
  const ready = deployment.assertMediaLifecycleDeploymentFence(before.data());
  await prepare(await withdraw(), { write: true });
  const after = await pointerRef.get();
  expect(deployment.assertMediaLifecycleDeploymentFence(after.data())).toEqual(ready);
  expect(after.data()).toEqual(before.data());
  expect(after.updateTime).toEqual(before.updateTime);
});

it("requires the Data Hub capability before accepting its fixed compiled Page",async()=>{
  const published=snapshots.createPublishedSnapshot({collection:"cmsPages",document:{id:"data-hub",version:1,title:"Data Hub",slug:"data-hub",blocks:[]},publishedAt:instant,publishedBy:actor.uid});
  const document={id:"data-hub",version:1,status:"published",publiclyVisible:true,publishAt:instant,published};
  await db.doc("system/noBuildPostAdmission").update({"families.pages.ids":["data-hub"]});
  await expect(prepare(document,{pageId:"data-hub"})).rejects.toThrow(/Data Hub publication gate is closed/);
  await db.doc(ownership.PAGE_CAPABILITY_PATH).update({dataHubReportingVersion:1});
  const accepted=await prepare(document,{pageId:"data-hub"});
  expect(accepted).not.toBeNull();
  expect(accepted.operation.pageId).toBe("data-hub");
});

describe("Data Hub Page composition", () => {
  const document = () => ({ title: "New Jersey by the Numbers", description: "State figures",
    dataHubCompositionVersion: 1, blocks: composition.defaultDataHubBlocks(), dataHubReporting: reporting.emptyDataHubReporting() });
  beforeEach(async () => {
    await db.doc("system/noBuildPostAdmission").update({ "families.pages.ids": ["contact", "data-hub"] });
    await db.doc(ownership.PAGE_CAPABILITY_PATH).update({ dataHubReportingVersion: 1, dataHubCompositionVersion: 1 });
    await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha: sha,
      serializerId: "cloudflare-preview", dataHubCompositionVersion: 1 });
  });
  async function draft(blocks = composition.defaultDataHubBlocks()) {
    const result = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", document: { ...document(), blocks } });
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    return (await db.doc("cmsPages/data-hub").get()).data();
  }
  async function publish() {
    const saved = (await db.doc("cmsPages/data-hub").get()).data();
    return invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: saved.version, publish: true, document: {} });
  }
  it("uses the standard draft, review, approval and build-free Page publication flow", async () => {
    offlineBuild.mockClear();
    const saved = await draft();
    expect(saved.blocks).toHaveLength(25);
    const transition = lifecycle.createCmsTransitionContentHandler({ firestore, requirePrincipalFn: async () => pageActor,
      now: () => instant, log: quiet });
    const submitted = await invoke(transition, { collection: "cmsPages", id: "data-hub", baseVersion: 1, action: "submit" });
    expect(submitted.code, JSON.stringify(submitted.body)).toBe(200);
    const approved = await invoke(transition, { collection: "cmsPages", id: "data-hub", baseVersion: 2, action: "approve" });
    expect(approved.code, JSON.stringify(approved.body)).toBe(200);
    const result = await publish();
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    expect(result.body.publication.transport).toBe("page-no-build-v1");
    const stored = (await db.doc("cmsPages/data-hub").get()).data();
    expect(stored.published.metadata.dataHubCompositionVersion).toBe(1);
    expect(stored.published.blocks.map(block => block.data)).toEqual(saved.blocks.map(block => block.data));
    expect(stored.published.metadata.dataHubReporting).toEqual(document().dataHubReporting);
    expect(offlineBuild).not.toHaveBeenCalled();
  });
  it("retains the draft and refuses publication before an accepting renderer", async () => {
    await draft();
    const ref = db.doc(ownership.PAGE_CAPABILITY_PATH);
    const capability = (await ref.get()).data(); delete capability.dataHubCompositionVersion; await ref.set(capability);
    const result = await publish();
    expect(result).toMatchObject({ code: 409, body: { error: "The installed Page renderer does not support Data Hub composition yet." } });
    expect((await db.doc("cmsPages/data-hub").get()).data()).toMatchObject({ version: 1, status: "draft" });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
  it("publishes an explicitly empty staff composition without reviving legacy figures", async () => {
    await draft([]);
    const result = await publish();
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    const stored = (await db.doc("cmsPages/data-hub").get()).data();
    expect(stored.published).toMatchObject({ blocks: [], metadata: { dataHubCompositionVersion: 1 } });
  });
  it("preserves an owned composition in candidate qualification and serving", async () => {
    await draft();
    const result = await publish();
    expect(result.code, JSON.stringify(result.body)).toBe(200);
    const candidate = { commitSha: sha, noBuildPage: { schemaVersion: 1, rendererSha: sha,
      enabled: true, authoritative: true, dataHubReportingVersion: 1 } };
    const qualify = () => firestore.runTransaction(transaction => pageCandidate.assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate }));
    await expect(qualify()).rejects.toThrow(/preserve the Data Hub Page composition/);
    candidate.noBuildPage.dataHubCompositionVersion = 1;
    await expect(qualify()).resolves.toMatchObject({ contract: { dataHubCompositionVersion: 1 } });
    const capability = (await db.doc(ownership.PAGE_CAPABILITY_PATH).get()).data();
    delete capability.dataHubCompositionVersion; await db.doc(ownership.PAGE_CAPABILITY_PATH).set(capability);
    await expect(pageServing.readNoBuildPageDecision({ firestore, path: "/data-hub/", rendererSha: sha })).rejects.toThrow(/does not support Data Hub composition/);
  });
  it("refuses a private preview on an unmarked renderer before writing queue work", async () => {
    await draft();
    const runtime = (await db.doc("system/cmsPreviewRuntime").get()).data();
    delete runtime.dataHubCompositionVersion; await db.doc("system/cmsPreviewRuntime").set(runtime);
    await expect(previewService.enqueuePreview({ actor: pageActor, pageId: "data-hub", sourceVersion: 1 }, {
      firestore, now: () => Date.parse(instant), getTransport: () => "serializer", serializerReady: true, getRendererSha: () => sha,
    })).rejects.toMatchObject({ status: 503, code: "preview-renderer-updating" });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("checks a historical private preview after the current Page returns to legacy content", async () => {
    await draft();
    const legacy = (await db.doc("cmsPages/data-hub").get()).data();
    delete legacy.dataHubCompositionVersion;
    await db.doc("cmsPages/data-hub").set({ ...legacy, version: 2, blocks: [] });
    const runtime = (await db.doc("system/cmsPreviewRuntime").get()).data();
    delete runtime.dataHubCompositionVersion; await db.doc("system/cmsPreviewRuntime").set(runtime);
    await expect(previewService.enqueuePreview({ actor: pageActor, pageId: "data-hub", sourceVersion: 1 }, {
      firestore, now: () => Date.parse(instant), getTransport: () => "serializer", serializerReady: true, getRendererSha: () => sha,
    })).rejects.toMatchObject({ status: 503 });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("previews composition with its own marked runtime at a different public renderer revision", async () => {
    await draft();
    const previewSha = "b".repeat(40);
    await db.doc("system/cmsPreviewRuntime").update({ rendererSha: previewSha });
    const capability = (await db.doc(ownership.PAGE_CAPABILITY_PATH).get()).data();
    delete capability.dataHubCompositionVersion; await db.doc(ownership.PAGE_CAPABILITY_PATH).set(capability);
    const options = { firestore, now: () => Date.parse(instant), getTransport: () => "serializer",
      serializerReady: true, getRendererSha: () => previewSha };
    const accepted = await previewService.enqueuePreview({ actor: pageActor, pageId: "data-hub", sourceVersion: 1 }, options);
    expect(accepted).toMatchObject({ sourceVersion: 1, status: "pending" });
    expect((await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()).toMatchObject({ rendererSha: previewSha,
      snapshot: { dataHubCompositionVersion: 1 } });
    await db.doc("system/cmsPreviewRuntime").update({ dataHubCompositionVersion: 0 });
    const changed = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 1,
      document: { description: "Updated draft" } });
    expect(changed.code, JSON.stringify(changed.body)).toBe(200);
    await expect(previewService.enqueuePreview({ actor: pageActor, pageId: "data-hub", sourceVersion: 2 }, options))
      .rejects.toMatchObject({ status: 503 });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
  it.each(["pending", "ready"])("reuses an admitted %s composition while runtime admission is paused or starting", async status => {
    await draft();
    const options = { firestore, now: () => Date.parse(instant), getTransport: () => "serializer",
      serializerReady: true, getRendererSha: () => sha };
    const request = { actor: pageActor, pageId: "data-hub", sourceVersion: 1 };
    const accepted = await previewService.enqueuePreview(request, options);
    const previewUrl = `https://preview.njpbs.org/p/${accepted.queueId}/`;
    if (status === "ready") await db.doc(`cmsPreviewQueue/${accepted.queueId}`).update({ status, previewUrl });
    await db.doc("system/cmsPreviewRuntime").update({ phase: "paused" });
    await expect(previewService.enqueuePreview(request, options)).resolves.toMatchObject({
      queueId: accepted.queueId, status, reused: true, dispatched: false,
      ...(status === "ready" ? { previewUrl } : {}),
    });
    await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "starting", rendererSha: sha, serializerId: "cloudflare-preview" });
    await expect(previewService.enqueuePreview(request, options)).resolves.toMatchObject({ queueId: accepted.queueId, status, reused: true });
    const changed = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 1,
      document: { description: "Updated draft" } });
    expect(changed.code, JSON.stringify(changed.body)).toBe(200);
    await expect(previewService.enqueuePreview({ ...request, sourceVersion: 2 }, options)).rejects.toMatchObject({ status: 503 });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
  it("previews and reuses a historical legacy snapshot when the current draft is composed", async () => {
    const first = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub",
      document: { title: "Legacy Data Hub", description: "State figures", blocks: [] } });
    expect(first.code, JSON.stringify(first.body)).toBe(200);
    const next = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 1, document: document() });
    expect(next.code, JSON.stringify(next.body)).toBe(200);
    expect((await db.doc("cmsPages/data-hub").get()).data()).toMatchObject({ version: 2, dataHubCompositionVersion: 1 });
    const capability = (await db.doc(ownership.PAGE_CAPABILITY_PATH).get()).data();
    delete capability.dataHubCompositionVersion; await db.doc(ownership.PAGE_CAPABILITY_PATH).set(capability);
    const runtime = (await db.doc("system/cmsPreviewRuntime").get()).data();
    delete runtime.dataHubCompositionVersion; await db.doc("system/cmsPreviewRuntime").set(runtime);
    const options = { firestore, now: () => Date.parse(instant), getTransport: () => "serializer",
      serializerReady: true, getRendererSha: () => sha };
    const request = { actor: pageActor, pageId: "data-hub", sourceVersion: 1 };
    const accepted = await previewService.enqueuePreview(request, options);
    expect(accepted).toMatchObject({ sourceVersion: 1, status: "pending" });
    expect((await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data().snapshot.dataHubCompositionVersion).toBeUndefined();
    await expect(previewService.enqueuePreview(request, options)).resolves.toMatchObject({ queueId: accepted.queueId, reused: true });
  });
  it("schedules the exact composed Page through build-free publication", async () => {
    await draft();
    const scheduled = await invoke(saveHandler(), { collection: "cmsPages", id: "data-hub", baseVersion: 1,
      scheduleAt: due, document: {} });
    expect(scheduled.code, JSON.stringify(scheduled.body)).toBe(200);
    const result = await runScheduler();
    expect(result.publications[0]).toMatchObject({ id: "data-hub", sourceVersion: 3, transport: "page-no-build-v1" });
    const stored = (await db.doc("cmsPages/data-hub").get()).data();
    expect(stored.published).toMatchObject({ metadata: { dataHubCompositionVersion: 1 } });
    expect(stored.published.blocks).toHaveLength(25);
  });
});

it("change-log: appends Page withdrawal with protected source and routes", async () => {
  await enrollPublicReleaseLog(db, sha);
  const removal = await prepare(await withdraw(), { write: true });
  const [entry] = await publicReleaseEntries(db);
  expect(entry.operationId).toBe(removal.queueId);
  expect(entry.changes).toMatchObject([{ kind: "page", id: "contact", action: "withdraw", sourceVersion: 1 }]);
  expect((await current()).publiclyVisible).toBe(false);
  expect(entry.contextRevision).toBe(8);
});

it.each([false, true])("change-log: reconstructs Home authority and its retained source after publication (republish=%s)", async republish => {
  await seedHomeForAcceptance();
  const receipt = { revision: 1, contextDigest: "b".repeat(64), rendererSha: sha,
    manifest: [{ path: "/_home-sources.json", key: `post-background-v1/home/old-claim/${"c".repeat(64)}`,
      digest: "d".repeat(64), size: 1024, contentType: "application/json; charset=utf-8" }],
    homeSourceReceipt: { buildBatchId: "original-home-catalog", commitSha: sha, generation: 1, digest: "e".repeat(64) } };
  await db.doc("cmsBackgroundOutputs/home").update({ status: "verified", receipt, contextDigest: receipt.contextDigest, after: { sourceVersion: 1 } });
  await enrollPublicReleaseLog(db, sha);
  const first = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 1, publish: true, document: {} });
  expect(first.code, JSON.stringify(first.body)).toBe(200);
  if (republish) {
    await db.doc("cmsPages/home").update({ status: "draft" });
    const next = await invoke(saveHandler(), { collection: "cmsPages", id: "home", baseVersion: 2, publish: true, document: {} });
    expect(next.code, JSON.stringify(next.body)).toBe(200);
  }
  const marker = (await db.doc("cmsBackgroundOutputs/home").get()).data();
  expect(marker.retainedSource.file.key).toBe(receipt.manifest[0].key);
  await db.doc("cmsBackgroundOutputs/home").delete();
  await db.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).delete();
  const { default: historical } = await import("../../functions/lib/public-release-historical-state.js");
  const { createHistoricalPublicReleaseReader } = await import("../../site/scripts/public-release-pair-historical-reader");
  const { default: home } = await import("../../functions/lib/no-build-home-ownership.js");
  const state = await historical.reconstructPublicReleaseState({ firestore: db, sourceOperationId: marker.operationId });
  expect(state.documents.get("cmsBackgroundOutputs/home")).toEqual(marker);
  const reader = createHistoricalPublicReleaseReader({ firestore, documents: state.documents, cursor: state.cursor, renderedAt: state.renderedAt });
  const owner = await reader.runTransaction(transaction => home.readHomePageAuthorityInTransaction({ firestore: reader, transaction }), { readOnly: true });
  expect(owner.operationId).toBe(marker.operationId);
  expect(owner.sourceVersion).toBe(republish ? 3 : 2);
});

it("change-log: failed enrollment/head validation aborts the Page mutation and queue", async () => {
  await enrollPublicReleaseLog(db, sha);
  const before = await current();
  await db.doc("system/publicReleaseChanges").delete();
  await expect(prepare(await withdraw(), { write: true })).rejects.toThrow();
  expect(await current()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect(await publicReleaseEntries(db)).toEqual([]);
});

import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { interruptConfirmation } from "../helpers/interrupt-confirmation.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import recovery from "../../functions/lib/no-build-page-recovery.js";
import recheckEndpoint from "../../functions/recheck-publication.js";
import serving from "../../functions/lib/no-build-page-serving.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import publicContext from "../../functions/lib/public-context-publication.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import targetContract from "../../functions/lib/publication-target.js";
import getContent from "../../functions/get-content.js";
import listContent from "../../functions/list-content.js";
import confirmation from "../../functions/no-build-post-confirmation.js";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
import homeWithdrawal from "../../functions/lib/no-build-post-home-withdrawal.js";
import homeConfirmation from "../../functions/lib/no-build-home-confirmation.js";
import publishEndpoint from "../../functions/publish.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import { retainedHomeSources, pageDocument } from "../../site/tests/fixtures/published-pages/fixtures";
import settingsConfirmation from "../../functions/lib/no-build-page-settings-confirmation.js";
import pageProof from "../../functions/lib/page-consumer-proof.js";
import postSettingsConfirmation from "../../functions/lib/no-build-post-settings-confirmation.js";
import postPublication from "../../functions/lib/no-build-post-publication.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import { createTransitionalPostReadWorker } from "../../workers/src/transitional-post-read-worker";
import aggregateConfirmation from "../../functions/lib/no-build-page-aggregate-confirmation.js";
import homeSelection from "../../functions/lib/home-source-selection-admission.js";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { projectPublicPageContextRead } from "../../site/src/lib/public-page-context-render";
import { createRequire } from "node:module";
import { backgroundStorageFixture } from "./background-storage-fixture";

const require = createRequire(import.meta.url);

const sha = "a".repeat(40);
const operationId = "A".repeat(20);
const pageId = `page-${"1".repeat(32)}`;
const target = targetContract.publicationTarget("development");
const headers = { "cf-access-client-id": "fixture-id", "cf-access-client-secret": "fixture-secret" };
const actor = { uid: "editor-fixture", principal: { id: "editor-fixture", grants: [{ role: "editor", sections: ["about"] }] } };
let app, firestore, state, document, scheduleFixture, homeCodeFixture, pageStorageBoundary;
const ownerRef = () => firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${pageId}`);
const queueRef = () => firestore.doc(`cmsPublishQueue/${operationId}`);
async function seed(visible = true) {
  const working = { version: 7, title: "Published fixture", slug: "proof-page", section: "about", previousSlugs: ["old-proof"], blocks: [] };
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: working,
    publishedAt: "2026-10-12T10:00:00.000Z", publishedBy: "fixture" });
  document = { ...working, version: 8, title: "Private later draft", blocks: [], status: "draft", publiclyVisible: visible,
    published, publishBuildQueueId: operationId, publishBuildPending: true };
  state = { schemaVersion: 1, pageId, operationId, sourceVersion: 7, path: "/proof-page/", ownedPaths: ["/proof-page/", "/old-proof/"],
    visible, rendererSha: sha, generation: 2, snapshotDigest: ownership.digest(published),
    admissionRevision: 2, contextRevision: 3, contextDigest: context.publicContextDigest(3),
    servingEnabled: true, runtime: { owner: "cloudflare", release: sha } };
  if (!visible) state.durableWithdrawal = { schemaVersion: 1, pageId, operationId, sourceVersion: 7,
    revision: state.generation, ownedPaths: state.ownedPaths, snapshotDigest: state.snapshotDigest, contextRevision: 3 };
  const batch = firestore.batch();
  batch.set(firestore.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 2,
    lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "fixture", activeCommitSha: sha, activeDeploymentId: "fixture" });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 3 });
  batch.set(firestore.doc(ownership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 2 });
  batch.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 2, enabled: true,
    families: { pages: { mode: "ids", ids: [pageId] } }, backgroundBucket: target.backgroundBucket });
  batch.set(firestore.doc(`cmsPages/${pageId}`), document);
  batch.set(ownerRef(), state);
  const { servingEnabled, runtime, durableWithdrawal, ...operation } = state;
  batch.set(queueRef(), { status: "pending", transport: "page-no-build-v1", noBuildPage: operation, backgroundRuntime: runtime,
    changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7, ...(visible ? {} : { operation: "withdraw" }) }],
    attempts: 0, claim: null, nextAttemptAt: 0 });
  for (const path of state.ownedPaths) batch.set(ownership.pageRouteRef(firestore, path), { schemaVersion: 1, pageId, path });
  await batch.commit();
}
function worker(options = {}) {
  const cache = new Map();
  return createNoBuildPageWorker({ rendererSha: options.rendererSha ?? sha, rendererReady: true,
    readWithdrawal: options.readWithdrawal ?? (async path => {
      // The fixture R2 catalog is independent of the serving route claims.
      const rows = await firestore.collection(ownership.PAGE_OWNER_COLLECTION)
        .where("durableWithdrawal.ownedPaths", "array-contains", path).get();
      const marker = rows.docs[0]?.data()?.durableWithdrawal;
      return marker?.ownedPaths.includes(path) ? { pageId: marker.pageId, operationId: marker.operationId,
        sourceVersion: marker.sourceVersion, revision: marker.revision, ownedPaths: marker.ownedPaths, verifiedAt: 1234 } : null;
    }),
    now: options.now,
    lastGood: options.lastGood,
    cache: { async match(request) { return cache.get(request.url)?.clone(); }, async put(request, response) { cache.set(request.url, response.clone()); } },
    getDecision: options.getDecision ?? (path => serving.readNoBuildPageDecision({ firestore, path, rendererSha: options.rendererSha ?? sha,
      currentCodeRequest: scheduleFixture?.request })),
    fetchAsset: options.fetchAsset ?? (async () => new Response("Static active Page fixture", { headers: {
      "x-njpbs-publication-operation": "stale-asset-operation", "x-njpbs-content-source": "cms-page-no-build" } })),
    renderContext: async content => {
      if (options.renderContext) await options.renderContext(content);
      return options.contextHtml?.(content) ?? `<!doctype html><html><body>${content.target.documentId}</body></html>`;
    },
    render: async content => {
      if (options.render) await options.render(content);
      return options.pageHtml?.(content) ?? options.html ?? `<!doctype html><html><body><h1>${content.pages[0].title}</h1></body></html>`;
    } });
}
const fetchPublic = instance => async (url, options) => instance.fetch(new Request(url, options));
const recover = options => recovery.recoverNoBuildPageDetail({ firestore, operationId, target, headers, fetchPublic: fetchPublic(worker()), ...options });
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use a local demo Firestore emulator");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "page-recovery-emulator");
  firestore = getFirestore(app);
  await firestore.doc("system/publicDeployment").get();
  pageStorageBoundary = await backgroundStorageFixture(target.backgroundBucket);
});
afterAll(async () => { await scheduleFixture?.close(); await homeCodeFixture?.close(); await pageStorageBoundary?.close(); await firestore.terminate(); await deleteApp(app); });
beforeEach(async () => {
  await scheduleFixture?.close(); scheduleFixture = null;
  await homeCodeFixture?.close(); homeCodeFixture = null;
  pageStorageBoundary.objects.clear(); pageStorageBoundary.reads.length = 0; pageStorageBoundary.writes.length = 0;
  pageStorageBoundary.refuseReads(false); pageStorageBoundary.onRead(null);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await seed();
});
it("refuses a production target with the development database before accessing authority", async () => {
  await expect(recovery.recoverNoBuildPageDetail({ firestore,
    target: targetContract.publicationTarget("production") })).rejects.toThrow("mixed publication database");
});
it("confirms canonical bytes and every manual redirect, then exposes exact completion without touching a draft", async () => {
  await recover();
  const queue = (await queueRef().get()).data();
  expect(queue.status).toBe("success");
  expect(queue.publicReceipt.routes).toMatchObject([{ path: "/proof-page/", status: 200 }, { path: "/old-proof/", status: 308 }]);
  expect(queue.publicReceipt.routes[0].htmlDigest).toMatch(/^[a-f0-9]{64}$/);
  const stored = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  expect(stored).toMatchObject({ title: "Private later draft", version: 8, publicSourceVersion: 7, publishBuildPending: false, publishBuildQueueId: null });
  const metadata = await getContent.publicationMetadata(firestore, stored, "cmsPages", pageId);
  expect(metadata).toMatchObject({ queueStatus: "success", publicationTransport: "page-no-build-v1",
    pageReceipt: { operationId, sourceVersion: 7, visible: true } });
  const response = { code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await listContent.createCmsListContentHandler({ firestore, requirePrincipalFn: async () => actor, log: { warn() {}, error() {} } })(
    { method: "POST", body: { view: "pages" } }, response);
  expect(response.code).toBe(200);
  expect(response.body.pages[0]).toMatchObject({ pageReceipt: metadata.pageReceipt, publicationTransport: "page-no-build-v1" });
});
it("retains exact operation after lost public response and resumes with an empty render cache", async () => {
  await recover({ fetchPublic: async () => { throw new Error("Lost response"); } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "pending", attempts: 1, claim: null });
  await recover({ now: () => Date.now() + 120_000 });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", attempts: 2 });
  expect((await firestore.collection("cmsPublishQueue").get()).size).toBe(1);
});
it("exposes only the check stage of a pending Page queue to the Admin", async () => {
  const state = async () => (await getContent.publicationMetadata(firestore,
    (await firestore.doc(`cmsPages/${pageId}`).get()).data(), "cmsPages", pageId)).pageConfirmation;
  expect(await state()).toEqual({ checking: false, attempts: 0, nextAttemptAt: 0 });
  let during;
  await recover({ fetchPublic: async () => { during = await state(); throw new Error("Lost response"); } });
  expect(during).toEqual({ checking: true, attempts: 1, nextAttemptAt: expect.any(Number) });
  expect(await state()).toEqual({ checking: false, attempts: 1, nextAttemptAt: expect.any(Number) });
  await recover({ now: () => Date.now() + 120_000 });
  expect(await state()).toBeUndefined();
});
it("deduplicates duplicate wakes with the durable queue claim", async () => {
  await Promise.all([recover(), recover()]);
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", attempts: 1 });
});
it("refuses a stale alias even when the canonical route is exact", async () => {
  const real = fetchPublic(worker());
  await recover({ fetchPublic: async (url, options) => url.includes("old-proof") ? new Response(null, { status: 404 }) : real(url, options) });
  expect((await queueRef().get()).data().status).toBe("pending");
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBeUndefined();
});
it("rerenders current authority and refuses recovery when it changes after the last route receipt", async () => {
  const renderedContexts = [];
  const changed = worker({ render: async content => {
    renderedContexts.push(content.target.contextRevision);
    await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
  } });
  const response = await changed.fetch(new Request(`${target.origin}/proof-page/`));
  expect(response.status).toBe(200);
  expect(renderedContexts).toEqual([3, 4]);
  expect(await response.text()).toBe("<!doctype html><html><body><h1>Published fixture</h1></body></html>");
  expect(response.headers.get("x-njpbs-content-source")).toBe("cms-page-no-build");
  expect(response.headers.get("x-njpbs-context-sha256")).toBe(context.publicContextDigest(4));
  expect(response.headers.get("x-njpbs-publication-operation")).toBe(operationId);
  expect(response.headers.get("x-njpbs-source-version")).toBe("7");
  await seed();
  const real = fetchPublic(worker());
  await recover({ fetchPublic: async (url, options) => {
    const response = await real(url, options);
    if (url.includes("old-proof")) await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
    return response;
  } });
  expect((await queueRef().get()).data().status).toBe("pending");
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBeUndefined();
});
it("keeps every accepted Page route readable from Assets during an authority outage without completing the operation", async () => {
  const outage = worker({ getDecision: async () => { throw new Error("Private authority unavailable"); } });
  for (const path of state.ownedPaths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await outage.fetch(new Request(`${target.origin}${path}`, { method }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-njpbs-publication-refresh")).toBe("pending");
      expect(response.headers.get("x-njpbs-publication-operation")).toBeNull();
      expect(await response.text()).toBe(method === "HEAD" ? "" : "Static active Page fixture");
    }
  }
  await recover({ fetchPublic: fetchPublic(outage), deadline: Date.now() + 2_000 });
  expect((await queueRef().get()).data()).toMatchObject({ status: "pending", attempts: 1 });
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBeUndefined();
});
it("completes an original operation on a compatible release and current context without relabeling provenance", async () => {
  const successor = "b".repeat(40);
  await firestore.doc("system/publicDeployment").update({ activeCommitSha: successor });
  await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ rendererSha: successor, generation: 3 });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
  await recover({ fetchPublic: fetchPublic(worker({ rendererSha: successor })) });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", backgroundRuntime: { release: sha },
    publicReceipt: { rendererSha: successor, contextDigest: context.publicContextDigest(4) } });
  expect((await ownerRef().get()).data()).toEqual(state);
});
it("withdraws every canonical and retained path with invalid admission or a disabled serving capability", async () => {
  await seed(false);
  await firestore.doc("system/noBuildPostAdmission").delete();
  await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ servingEnabled: false });
  await recover();
  expect((await queueRef().get()).data()).toMatchObject({ status: "success",
    publicReceipt: { admissionRevision: null, visible: false, routes: [{ status: 410 }, { status: 410 }] } });
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBeNull();
});
it("does not complete a Page withdrawal until its exact durable marker has reached the reader", async () => {
  await seed(false);
  await recover({ fetchPublic: fetchPublic(worker({ readWithdrawal: async () => null })) });
  expect((await queueRef().get()).data()).toMatchObject({ status: "pending", attempts: 1 });
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBeUndefined();
  await recover({ now: () => Date.now() + 120_000 });
  expect((await queueRef().get()).data().status).toBe("success");
});
it.each(["deploying", "mismatch", "missing claim", "timeout"])("a confirmed Page withdrawal cannot resurface during %s", async reason => {
  await seed(false);
  await recover();
  expect((await queueRef().get()).data().status).toBe("success");
  if (reason === "deploying") await firestore.doc("system/publicDeployment").update({ state: "deploying" });
  if (reason === "mismatch") await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ rendererSha: "b".repeat(40) });
  if (reason === "missing claim") await ownership.pageRouteRef(firestore, state.ownedPaths[1]).delete();
  const instance = worker(reason === "timeout" ? { getDecision: async () => { throw new Error("RPC deadline"); } } : {});
  for (const path of state.ownedPaths) for (const method of ["GET", "HEAD"]) {
    const response = await instance.fetch(new Request(`${target.origin}${path}`, { method }));
    expect(response.status).toBe(410);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-njpbs-content-source")).toBe("durable-page-withdrawal");
  }
});
it("serves a newer Page republish without deleting the durable withdrawal and refuses its subsequent outage", async () => {
  await seed(false);
  const marker = { pageId, operationId, sourceVersion: 7, revision: 2, ownedPaths: state.ownedPaths, verifiedAt: 1234 };
  const published = { ...document.published, sourceVersion: 9 };
  await ownerRef().update({ visible: true, generation: 3, operationId: "B".repeat(20), sourceVersion: 9,
    snapshotDigest: ownership.digest(published) });
  await firestore.doc(`cmsPages/${pageId}`).update({ publiclyVisible: true, published, version: 10 });
  const instance = worker({ readWithdrawal: async () => marker });
  expect((await instance.fetch(new Request(`${target.origin}/proof-page/`))).status).toBe(200);
  expect((await instance.fetch(new Request(`${target.origin}/old-proof/`))).status).toBe(308);
  await firestore.doc("system/publicDeployment").update({ state: "deploying" });
  expect((await instance.fetch(new Request(`${target.origin}/proof-page/`))).status).toBe(410);
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().title).toBe("Private later draft");
});
it("bounds failed attempts, and an authorized retry resumes only the exact original operation", async () => {
  for (let attempt = 0; attempt < 4; attempt++) await recover({ now: () => Date.now() + attempt * 600_000,
    fetchPublic: async () => new Response(null, { status: 503 }) });
  expect((await queueRef().get()).data()).toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null });
  const request = { firestore, actor, retry: true, baseVersion: 8, changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7 }] };
  await expect(recovery.existingNoBuildPagePublication({ ...request, baseVersion: 7 })).rejects.toThrow("Publication changed");
  await expect(recovery.existingNoBuildPagePublication({ ...request, actor: { principal: { grants: [{ role: "contributor" }] } } })).rejects.toThrow("access");
  expect(await recovery.existingNoBuildPagePublication(request)).toMatchObject({ queueId: operationId, transport: "page-no-build-v1" });
  await recover();
  expect((await queueRef().get()).data().status).toBe("success");
  expect((await firestore.collection("cmsPublishQueue").get()).size).toBe(1);
});
it("routes accepted Page events through the existing independent confirmation trigger", async () => {
  const handler = confirmation.createNoBuildPostConfirmationHandler({ firestore, readback: () => ({ target, headers }), fetchPublic: fetchPublic(worker()) });
  await handler({ params: { queueId: operationId }, data: { after: { data: () => ({ transport: "page-no-build-v1", status: "pending", nextAttemptAt: 0 }) } } });
  expect((await queueRef().get()).data().status).toBe("success");
});
it("fails closed on a missing retained claim and releases only authoritative unowned paths to Assets", async () => {
  await ownership.pageRouteRef(firestore, "/old-proof/").delete();
  const instance = worker();
  expect(await (await instance.fetch(new Request(`${target.origin}/old-proof/`))).text()).toBe("Static active Page fixture");
  expect(await instance.fetch(new Request(`${target.origin}/unowned-page/`))).toBeNull();
});
it("a corrupt Page owner or queue cannot starve another accepted Page's minute recovery", async () => {
  await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/contact`).set({ schemaVersion: 9, pageId: "contact", operationId: "C".repeat(20) });
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, fetchPublic: fetchPublic(worker()) });
  expect((await queueRef().get()).data().status).toBe("success");
});

async function seedHomeRefresh(custom = false) {
  const homeOperationId = "H".repeat(20), postOperationId = "P".repeat(20), postId = "withdrawn-post";
  const published = pageDocument("home").published;
  if (custom) Object.assign(published.metadata, { contentLinkMode: "custom", contentLinkUrl: "https://example.test/election-results" });
  const homeRefresh = { schemaVersion: 1, revision: 1, status: "pending", postId,
    sourceVersion: 4, sourceOperationId: postOperationId, taskPath: `cmsPublishQueue/${postOperationId}/homePageRefresh/home` };
  const homeState = { ...state, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"], operationId: homeOperationId,
    sourceVersion: published.sourceVersion,
    snapshotDigest: ownership.digest(published), homeRefresh,
    ...(custom ? { contentRedirectUrl: "https://example.test/election-results" } : {}) };
  const batch = firestore.batch();
  batch.set(firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`), homeState);
  batch.set(firestore.doc("cmsPages/home"), { version: 8, title: "Private Home draft", publiclyVisible: true,
    status: "draft", published, publishBuildPending: true, publishBuildQueueId: homeOperationId });
  const { servingEnabled, runtime, homeRefresh: dirty, ...operation } = homeState;
  batch.set(firestore.doc(`cmsPublishQueue/${homeOperationId}`), { transport: "page-no-build-v1", status: "pending",
    noBuildPage: operation, backgroundRuntime: runtime, changes: [{ collection: "cmsPages", id: "home", sourceVersion: published.sourceVersion }],
    attempts: 0, nextAttemptAt: 0, claim: null });
  batch.set(firestore.doc("cmsBackgroundOutputs/home"), { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home",
    ownerPath: `${ownership.PAGE_OWNER_COLLECTION}/home`, operationId: homeOperationId, retainedSource: null });
  for (const path of homeState.ownedPaths) batch.set(ownership.pageRouteRef(firestore, path), { schemaVersion: 1, pageId: "home", path });
  batch.set(firestore.doc(homeRefresh.taskPath), { schemaVersion: 1, owner: "page-no-build-v1", status: "pending", revision: 1,
    runtime,
    input: { homeOperationId, homeSourceVersion: published.sourceVersion, postId, sourceOperationId: postOperationId, sourceVersion: 4, visible: false } });
  batch.set(firestore.doc(`cmsPosts/${postId}`), { publiclyVisible: false, published: { sourceVersion: 4, metadata: { type: "post", slug: "withdrawn-post" }, blocks: [] } });
  batch.set(firestore.doc(`${postOwnership.OWNER_COLLECTION}/${postId}`), { schemaVersion: 1, postId, rendererSha: sha,
    servingEnabled: true, generation: 2, operationId: postOperationId, sourceVersion: 4, visible: false,
    slug: "withdrawn-post", ownedSlugs: ["withdrawn-post"], runtime: { owner: "cloudflare", release: sha } });
  batch.set(firestore.doc(`cmsPublishQueue/${postOperationId}`), { transport: "post-no-build-v1", status: "success",
    noBuildPost: { postId, operationId: postOperationId, sourceVersion: 4, visible: false } });
  await batch.commit();
  homeCodeFixture = await schedulePacketFixture({ firestore, rendererSha: sha, boundary: pageStorageBoundary,
    includeHomeSources: true, attachExternalInputs: false });
  const sources = homeCodeFixture.homeSources;
  const fetchAsset = async request => Response.json(request.url.endsWith("/_publication.json")
    ? { schemaVersion: 1, ...sources.publication } : sources);
  return { homeState, fetchAsset, postId, postOperationId };
}
it.each(["Page", "Home"])("exhausts an interrupted final %s confirmation through minute recovery", async family => {
  const home = family === "Home" ? await seedHomeRefresh() : null;
  const ref = home ? firestore.doc(home.homeState.homeRefresh.taskPath) : queueRef();
  await ref.update({ attempts: 3, nextAttemptAt: 0 });
  const fetchPublic = vi.fn(async () => { throw new Error("No IO after crash"); });
  const options = { firestore: interruptConfirmation(firestore, ref), target, headers, fetchPublic, now: () => 1_000 };
  await expect(home ? recovery.recoverNoBuildHomeRefresh(options) : recover(options))
    .rejects.toThrow("Process lost after final confirmation claim");
  expect((await ref.get()).data()).toMatchObject({ status: "pending", attempts: 4, claim: expect.any(String), nextAttemptAt: 61_000 });
  const claimed = (await ref.get()).data();
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, fetchPublic, now: () => 60_999 });
  expect((await ref.get()).data()).toEqual(claimed);
  const sourceField = home ? "input.sourceVersion" : "noBuildPage.sourceVersion";
  await ref.update({ [sourceField]: 99 });
  const mismatched = (await ref.get()).data();
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, fetchPublic, now: () => 61_000 });
  expect((await ref.get()).data()).toEqual(mismatched);
  await ref.update({ [sourceField]: home ? 4 : 7 });
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, fetchPublic, now: () => 61_000 });
  expect((await ref.get()).data()).toMatchObject({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
  if (home) expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).data().homeRefresh.status).toBe("pending");
  else expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publishBuildPending).toBe(true);
  // The Home sweep also checks its independently owned public catalog.
  if (!home) expect(fetchPublic).not.toHaveBeenCalled();
  const failed = (await ref.get()).data();
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, fetchPublic, now: () => 121_000 });
  expect((await ref.get()).data()).toEqual(failed);
  if (home) {
    await homeConfirmation.retryNoBuildHomePostRefresh({ firestore, postId: home.postId,
      sourceOperationId: home.postOperationId, sourceVersion: 4 });
    expect((await ref.get()).data()).toMatchObject({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
    await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request,
      fetchPublic: (url, options) => worker({ fetchAsset: home.fetchAsset }).fetch(new Request(url, options)) });
    expect((await ref.get()).data()).toMatchObject({ status: "verified", attempts: 1, claim: null });
  } else {
    expect((await checkAgain({ fetchPublic })).body.outcome).toBe("failed");
    await recovery.existingNoBuildPagePublication({ firestore, actor, retry: true, baseVersion: 8,
      changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7 }] });
    expect((await ref.get()).data()).toMatchObject({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0 });
    await recover();
    expect((await ref.get()).data()).toMatchObject({ status: "success", attempts: 1, claim: null });
  }
});
it("proves the first Home root/catalog from sealed Assets and settles only the exact Post refresh", async () => {
  const home = await seedHomeRefresh();
  const fetch = fetchPublic(worker({ fetchAsset: home.fetchAsset }));
  await recovery.recoverNoBuildPageDetail({ firestore, operationId: home.homeState.operationId, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetch });
  expect((await firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`).get()).data().status).toBe("success");
  const catalog = (await firestore.doc(`cmsHomeSourceCatalogs/${home.homeState.operationId}`).get()).data();
  expect(catalog.page).toMatchObject({ operationId: home.homeState.operationId, contextRevision: 3, homeRefreshRevision: 1 });
  expect((await firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`).get()).data().publicReceipt.homeCatalog).toBeUndefined();
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetch });
  const task = (await firestore.doc(home.homeState.homeRefresh.taskPath).get()).data();
  expect(task).toMatchObject({ status: "verified", attempts: 1, claim: null, publicReceipt: {
    homeRefreshRevision: 1, routes: [{ path: "/", status: 200 }, { path: "/_home-sources.json", status: 200 }] } });
  expect(await homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 })).toMatchObject({ confirmed: true, revision: 1 });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
  expect(await homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 })).toMatchObject({ confirmed: false });
});
it.each(["matching", "destination", "root status", "catalog digest"])("binds linked Home withdrawal and refresh proofs: %s", async fault => {
  const home = await seedHomeRefresh(true);
  const fetch = fetchPublic(worker({ fetchAsset: home.fetchAsset }));
  await recovery.recoverNoBuildPageDetail({ firestore, operationId: home.homeState.operationId, target, headers,
    currentCodeRequest: homeCodeFixture.request, fetchPublic: fetch });
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetch });
  const homeQueue = firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`);
  const refreshTask = firestore.doc(home.homeState.homeRefresh.taskPath);
  for (const ref of [homeQueue, refreshTask]) {
    const stored = (await ref.get()).data();
    expect(stored.publicReceipt.routes).toMatchObject([
      { path: "/", status: 302, htmlDigest: null, location: "https://example.test/election-results" },
      { path: "/_home-sources.json", status: 200, htmlDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    if (fault === "destination") stored.publicReceipt.routes[0].location = "https://example.test/wrong";
    if (fault === "root status") Object.assign(stored.publicReceipt.routes[0], { status: 200, htmlDigest: "e".repeat(64) });
    if (fault === "catalog digest") stored.publicReceipt.routes[1].htmlDigest = null;
    if (fault !== "matching") await ref.update({ publicReceipt: stored.publicReceipt });
  }
  expect(await homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 })).toMatchObject({ confirmed: fault === "matching" });
  const proof = await firestore.runTransaction(transaction => homeWithdrawal.readPageHomeWithdrawal({ firestore, transaction,
    accepted: { state: { postId: home.postId, operationId: home.postOperationId, sourceVersion: 4 },
      queue: {}, queueRef: firestore.doc(`cmsPublishQueue/${home.postOperationId}`) } }));
  expect(proof.proof).toEqual(fault === "matching" ? { digest: expect.stringMatching(/^[a-f0-9]{64}$/), withdrawalRevision: 0 } : null);
});
it("keeps the transferred Home catalog seal stable across request clocks and admits its proved selection receipt", async () => {
  const home = await seedHomeRefresh();
  const read = now => worker({ fetchAsset: home.fetchAsset, now: () => new Date(now) }).fetch(new Request(`${target.origin}/_home-sources.json`));
  const first = await (await read("2026-10-12T12:00:00.000Z")).json();
  const second = await (await read("2026-10-12T13:00:00.000Z")).json();
  expect(second.editorial).toEqual(first.editorial);
  await recovery.recoverNoBuildPageDetail({ firestore, operationId: home.homeState.operationId, target, headers, currentCodeRequest: homeCodeFixture.request,
    fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  const row = (await firestore.doc(`cmsHomeSourceCatalogs/${home.homeState.operationId}`).get()).data();
  expect(row.receipt).toEqual(first.editorial.receipt);
  const block = { id: "selected", type: "content_shelf", section: "home-posts",
    data: { source: "station_posts", moreHref: "/posts/", itemLimit: 4, selectedIds: [], selectionReceipt: row.receipt } };
  await firestore.runTransaction(transaction => homeSelection.verifyHomeSelections({ firestore, transaction, blocks: [block] }));
  await expect(firestore.runTransaction(transaction => homeSelection.verifyHomeSelections({ firestore, transaction,
    blocks: [{ ...block, data: { ...block.data, selectedIds: ["unpublished-card"] } }] }))).rejects.toThrow();
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  const homeQueue = (await firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`).get()).data();
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
  const handler = confirmation.createNoBuildPostConfirmationHandler({ firestore, readback: () => ({ target, headers }),
    fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  await handler({ data: { after: { data: () => ({ transport: "public-context-no-build-v1", status: "pending" }) } } });
  expect((await firestore.doc(`cmsHomeSourceCatalogs/${home.homeState.operationId}`).get()).data().page.contextRevision).toBe(4);
  expect((await firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`).get()).data()).toEqual(homeQueue);
  await queueRef().update({ status: "success" });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 5 });
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  expect((await firestore.doc(`cmsHomeSourceCatalogs/${home.homeState.operationId}`).get()).data().page.contextRevision).toBe(5);
  expect((await firestore.doc(`cmsPublishQueue/${home.homeState.operationId}`).get()).data()).toEqual(homeQueue);
});
it("a lost Home response retains the task and an exact retry cannot clear an uncertain claim", async () => {
  const home = await seedHomeRefresh();
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request,
    fetchPublic: async () => { throw new Error("Lost Home response"); } });
  const taskRef = firestore.doc(home.homeState.homeRefresh.taskPath);
  expect((await taskRef.get()).data()).toMatchObject({ status: "pending", attempts: 1, claim: null });
  await taskRef.update({ status: "failed", attempts: 4, nextAttemptAt: null, claim: "uncertain" });
  const retry = { firestore, postId: home.postId, sourceOperationId: home.postOperationId, sourceVersion: 4 };
  await homeConfirmation.retryNoBuildHomePostRefresh(retry);
  expect((await taskRef.get()).data().claim).toBe("uncertain");
  await taskRef.update({ claim: null });
  await homeConfirmation.retryNoBuildHomePostRefresh(retry);
  expect((await taskRef.get()).data()).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 0 });
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  expect((await taskRef.get()).data().status).toBe("verified");
});
it("the authorized Post retry resumes a failed Home refresh without replacing either operation", async () => {
  const home = await seedHomeRefresh();
  const postRef = firestore.doc(`cmsPosts/${home.postId}`);
  const postQueueRef = firestore.doc(`cmsPublishQueue/${home.postOperationId}`);
  const taskRef = firestore.doc(home.homeState.homeRefresh.taskPath);
  await postRef.update({ publiclyVisible: true, section: "about", version: 8 });
  await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${home.postId}`).update({ visible: true });
  await postQueueRef.update({ "noBuildPost.visible": true, status: "failed", attempts: 4, nextAttemptAt: null });
  await taskRef.update({ "input.visible": true, status: "failed", attempts: 4, nextAttemptAt: null, claim: "uncertain" });
  const before = (await firestore.collection("cmsPublishQueue").get()).size;
  async function retry(principal = actor, sourceVersion = 4) {
    const handler = publishEndpoint.createCmsPublishHandler({ firestore, requirePrincipalFn: async () => principal,
      log: { info() {}, warn() {}, error() {} } });
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", body: { retry: true, baseVersion: 8,
      changes: [{ collection: "cmsPosts", id: home.postId, sourceVersion }] } }, response);
    return response;
  }
  expect((await retry({ uid: "other", principal: { grants: [{ role: "contributor", sections: ["about"] }] } })).code).toBe(403);
  expect((await taskRef.get()).data()).toMatchObject({ status: "failed", attempts: 4, claim: "uncertain" });
  expect((await retry(actor, 5)).code).toBe(409);
  expect((await taskRef.get()).data()).toMatchObject({ status: "failed", attempts: 4, claim: "uncertain" });
  expect((await retry()).code).toBe(200);
  expect((await taskRef.get()).data()).toMatchObject({ status: "failed", attempts: 4, claim: "uncertain" });
  await postQueueRef.update({ status: "failed", attempts: 4, nextAttemptAt: null });
  await taskRef.update({ claim: null });
  const response = await retry();
  expect(response.code).toBe(200);
  expect(response.body).toMatchObject({ queueId: home.postOperationId, transport: "post-no-build-v1" });
  expect((await taskRef.get()).data()).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 0, claim: null });
  expect((await postQueueRef.get()).data()).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 0 });
  expect((await firestore.collection("cmsPublishQueue").get()).size).toBe(before);
  expect((await firestore.doc("cmsPages/home").get()).data().title).toBe("Private Home draft");
});
it.each(["exact", "github", "github-foreign", "not-success", "changed-member", "missing-member", "settled-subset",
  "mixed-case", "punctuation", "github-mixed-case", "github-punctuation", "unsorted", "duplicate"])("proves a grouped serializer Home refresh only against its complete settled Post set: %s", async variant => {
  const home = await seedHomeRefresh();
  const serializerId = "S".repeat(20);
  const sourceTransport = variant.startsWith("github") ? "github" : "serializer";
  const taskPath = `cmsPublishQueue/${serializerId}/homePageRefresh/home`;
  const ids = variant.endsWith("mixed-case") ? ["Bx", "ax"] : variant.endsWith("punctuation") ? ["0x", "_x"] :
    variant === "unsorted" ? ["ax", "Bx"] : variant === "duplicate" ? ["post-a", "post-a"] : ["post-a", "post-b"];
  const changes = ids.map(postId => ({ postId, sourceVersion: 4, visible: false }));
  const batch = firestore.batch();
  for (const change of changes) batch.set(firestore.doc(`cmsPosts/${change.postId}`), {
    publiclyVisible: false, status: "draft", published: { sourceVersion: 4, blocks: [], metadata: { type: "post", slug: `grouped-post-${changes.indexOf(change)}` } },
    publicSourceVersion: null, publishBuildPending: false, publishBuildQueueId: null,
    publishBuildSettlement: { status: "success", sourceVersion: 4, operation: "withdraw" } });
  batch.set(firestore.doc(`cmsPublishQueue/${serializerId}`), { transport: sourceTransport, status: variant === "not-success" ? "public_unconfirmed" : "success",
    ...(sourceTransport === "github" ? { transport: "github", runtime: { owner: variant === "github-foreign" ? "node-compute" : "cloudflare", release: sha } } : {}),
    changes: changes.map(change => ({ collection: "cmsPosts", id: change.postId, sourceVersion: 4, operation: "withdraw" })) });
  batch.set(firestore.doc(taskPath), { schemaVersion: 1, owner: "page-no-build-v1", status: "pending", revision: 2,
    input: { sourceTransport, sourceOperationId: serializerId,
      postChanges: ["missing-member", "settled-subset"].includes(variant) ? changes.slice(0, 1) : changes,
      homeOperationId: home.homeState.operationId, homeSourceVersion: home.homeState.sourceVersion } });
  batch.update(firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`), { homeRefresh: {
    schemaVersion: 1, revision: 2, status: "pending", sourceOperationId: serializerId, sourceTransport,
    postChanges: variant === "settled-subset" ? changes.slice(0, 1) : changes, taskPath } });
  await batch.commit();
  if (variant === "changed-member") await firestore.doc("cmsPosts/post-b").update({ "published.sourceVersion": 5 });
  if (variant === "settled-subset") await firestore.doc("cmsPosts/post-b").update({ publishBuildPending: true, publishBuildQueueId: "new-owner", publishBuildSettlement: { status: "failed", sourceVersion: 4, operation: "withdraw" } });
  const proof = recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  if (["missing-member", "unsorted", "duplicate"].includes(variant)) await expect(proof).rejects.toThrow();
  else await proof;
  const confirmed = ["exact", "github", "settled-subset", "mixed-case", "punctuation", "github-mixed-case", "github-punctuation"].includes(variant);
  expect((await firestore.doc(taskPath).get()).data().status).toBe(confirmed ? "verified" : "pending");
  if (confirmed) {
    expect(await homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
      sourceOperationId: home.postOperationId, sourceVersion: 4 })).toMatchObject({ confirmed: true, revision: 2 });
    expect((await firestore.doc(`cmsPublishQueue/${serializerId}`).get()).data().status).toBe("success");
  }
});
it("uses a later complete Home publication when its inherited verified refresh belongs to the previous owner", async () => {
  const home = await seedHomeRefresh();
  const publicFetch = fetchPublic(worker({ fetchAsset: home.fetchAsset }));
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: publicFetch });
  const taskBefore = (await firestore.doc(home.homeState.homeRefresh.taskPath).get()).data();
  const ref = firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`);
  const old = (await ref.get()).data();
  const newOperationId = "R".repeat(20);
  const source = (await firestore.doc("cmsPages/home").get()).data();
  source.version = 9; source.published.sourceVersion = 8;
  const next = { ...old, operationId: newOperationId, sourceVersion: 8, snapshotDigest: ownership.digest(source.published),
    contextRevision: 4, contextDigest: context.publicContextDigest(4) };
  await ref.set(next);
  await firestore.doc("cmsBackgroundOutputs/home").update({ operationId: newOperationId });
  await firestore.doc("cmsPages/home").set({ ...source, publishBuildQueueId: newOperationId, publishBuildPending: true });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
  const { homeRefresh, runtime, servingEnabled, ...operation } = next;
  await firestore.doc(`cmsPublishQueue/${newOperationId}`).set({ status: "pending", transport: "page-no-build-v1",
    noBuildPage: operation, backgroundRuntime: runtime, attempts: 0, nextAttemptAt: 0,
    changes: [{ collection: "cmsPages", id: "home", sourceVersion: 8 }] });
  const read = () => homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 });
  expect(await read()).toMatchObject({ confirmed: false });
  await homeConfirmation.retryNoBuildHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 });
  expect((await firestore.doc(home.homeState.homeRefresh.taskPath).get()).data()).toEqual(taskBefore);
  await recovery.recoverNoBuildPageDetail({ firestore, operationId: newOperationId, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: publicFetch });
  expect(await read()).toMatchObject({ confirmed: true, revision: 1 });
  expect((await firestore.doc(home.homeState.homeRefresh.taskPath).get()).data()).toEqual(taskBefore);
});
it("lets a later complete Home refresh prove an earlier bulk removal without relabeling its source", async () => {
  const home = await seedHomeRefresh();
  const secondPostId = "second-withdrawn", secondOperationId = "B".repeat(20);
  const currentRef = firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`);
  const nextSignal = { ...home.homeState.homeRefresh, revision: 2, sourceOperationId: secondOperationId,
    postId: secondPostId, taskPath: `cmsPublishQueue/${secondOperationId}/homePageRefresh/home` };
  await currentRef.update({ homeRefresh: nextSignal });
  await firestore.doc(nextSignal.taskPath).set({ schemaVersion: 1, owner: "page-no-build-v1", status: "pending", revision: 2,
    input: { homeOperationId: home.homeState.operationId, homeSourceVersion: home.homeState.sourceVersion,
      sourceOperationId: secondOperationId, postId: secondPostId, sourceVersion: 4, visible: false } });
  const post = (await firestore.doc(`cmsPosts/${home.postId}`).get()).data();
  const owner = (await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${home.postId}`).get()).data();
  await firestore.doc(`cmsPosts/${secondPostId}`).set(post);
  await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${secondPostId}`).set({ ...owner, postId: secondPostId, operationId: secondOperationId });
  await firestore.doc(`cmsPublishQueue/${secondOperationId}`).set({ transport: "post-no-build-v1", status: "success",
    noBuildPost: { postId: secondPostId, operationId: secondOperationId, sourceVersion: 4, visible: false } });
  const read = () => homeConfirmation.readConfirmedHomePostRefresh({ firestore, postId: home.postId,
    sourceOperationId: home.postOperationId, sourceVersion: 4 });
  expect(await read()).toMatchObject({ confirmed: false, status: "pending", revision: 2 });
  await recovery.recoverNoBuildHomeRefresh({ firestore, target, headers, currentCodeRequest: homeCodeFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  expect(await read()).toMatchObject({ confirmed: true, revision: 2 });
  expect((await firestore.doc(home.homeState.homeRefresh.taskPath).get()).data().status).toBe("pending");
  expect((await firestore.doc(`cmsPublishQueue/${home.postOperationId}`).get()).data().noBuildPost.operationId).toBe(home.postOperationId);
});
it("serves unowned committed frames and Home catalog with context authority, without editorial receipts", async () => {
  const sources = retainedHomeSources(sha);
  sources.publication.generation = 2; sources.editorial.receipt.generation = 2;
  const instance = worker({ fetchAsset: async request => Response.json(request.url.endsWith("/_publication.json")
    ? { schemaVersion: 1, ...sources.publication } : sources) });
  const baseline = homeSelection.sealHomeCatalog(sources.editorial.catalog, sources.publication);
  await firestore.doc(`cmsHomeSourceCatalogs/${sources.publication.buildBatchId}`).set(baseline);
  for (const path of ["/contact/", "/donate/", "/"]) {
    const reply = await serving.readNoBuildPageDecision({ firestore, path, rendererSha: sha });
    expect(reply.contextReceipt).toMatchObject({ source: "site", rendererSha: sha, contextRevision: 3 });
    expect(reply.receipt).toBeUndefined();
    const response = await instance.fetch(new Request(`${target.origin}${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-publication-operation")).toBeNull();
    expect(response.headers.get("x-njpbs-source-version")).toBeNull();
    const receipt = await settingsConfirmation.readContextReceipt({ path, decision: {
      kind: reply.kind, receipt: reply.contextReceipt }, target, headers,
      fetchPublic: fetchPublic(instance) });
    expect(receipt.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
  }
  const catalogResponse = await instance.fetch(new Request(`${target.origin}/_home-sources.json`));
  expect(catalogResponse.headers.get("x-njpbs-content-source")).toBe("assets");
  expect((await catalogResponse.json()).editorial).toEqual(baseline);
  expect((await firestore.doc(`cmsHomeSourceCatalogs/${sources.publication.buildBatchId}`).get()).data()).toEqual(baseline);
  const alias = await instance.fetch(new Request(`${target.origin}/public-meetings/`));
  expect(alias.status).toBe(308); expect(alias.headers.get("location")).toBe("/meeting-notices/");
  for (const path of ["/schedule/", "/live/"]) {
    const fallback = await instance.fetch(new Request(`${target.origin}${path}`));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(fallback.headers.get("x-njpbs-publication-operation")).toBeNull();
  }
  const reply = await serving.readNoBuildPageDecision({ firestore, path: "/contact/", rendererSha: sha });
  await expect(settingsConfirmation.readContextReceipt({ path: "/contact/", decision: { kind: reply.kind, receipt: reply.contextReceipt },
    target, headers, fetchPublic: async () => new Response("<!doctype html><html></html>", { headers: {
      "x-njpbs-content-source": "cms-page-context", "x-njpbs-renderer-sha": sha,
      "x-njpbs-context-sha256": reply.contextReceipt.contextDigest, "x-njpbs-public-context-revision": "2" } }) })).rejects.toThrow();
});
it("keeps both settings Page/Home consumers pending while fallback or Schedule coverage is incomplete", async () => {
  const settingsOperationId = "S".repeat(20);
  await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).set({ transport: "public-context-no-build-v1", status: "pending",
    settingsPublication: { id: "site-navigation", sourceVersion: 1, operationId: settingsOperationId } });
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId, target, headers,
    fetchPublic: async () => { throw new Error("Incomplete families must stay pending before proof"); } });
  expect(result).toMatchObject({ confirmed: false });
  expect(result.missingPages).toContain("schedule");
  expect(result.missingPages).toContain("staff");
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

async function seedAggregateChild({ revision = 4, successor = "N".repeat(20) } = {}) {
  const original = "O".repeat(20), rendererSha = "b".repeat(40);
  const contextDigest = context.publicContextDigest(revision);
  const runtime = { owner: "cloudflare", release: rendererSha };
  await ownerRef().update({ contextQueueId: original });
  await queueRef().update({ "noBuildPage.contextQueueId": original, contextPublication: {
    queueId: original, contextRevision: 3, contextDigest: state.contextDigest, outputs: aggregateConfirmation.FAMILIES } });
  await firestore.doc(`cmsPublishQueue/${original}`).set({ transport: "public-context-no-build-v1", status: "cancelled", runtime: state.runtime });
  await firestore.doc("system/publicDeployment").update({ activeCommitSha: rendererSha });
  await firestore.doc(ownership.PAGE_CAPABILITY_PATH).update({ rendererSha, generation: 3 });
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision });
  const identity = { schemaVersion: 1, operationId: successor, contextRevision: revision, contextDigest, runtime, reason: "context" };
  await firestore.doc("system/publicDeployment/aggregateContexts/current").set(identity);
  const outputs = {};
  for (const family of aggregateConfirmation.FAMILIES) {
    const taskPath = `cmsPublishQueue/${successor}/backgroundOutputs/${family}`;
    const receipt = { rendererSha, contextDigest, verifiedAt: 123456, revision: 2, digest: "d".repeat(64), routeSetDigest: "e".repeat(64), runtime };
    outputs[family] = { ...receipt, contextRevision: revision, taskPath };
    await firestore.doc(`cmsBackgroundOutputs/${family}`).set({ schemaVersion: 1, owner: "post-background-v1", output: family,
      runtime, status: "verified", contextDigest, revision: 2, taskPath, receipt });
    await firestore.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", output: family, runtime,
      status: "verified", revision: 2, claim: null, receipt });
  }
  await firestore.doc(`cmsPublishQueue/${successor}`).set({ transport: "public-context-no-build-v1", runtime,
    publicContext: identity, status: "success", aggregateReceipt: { runtime, contextRevision: revision, contextDigest, outputs } });
  return { original, successor, rendererSha };
}
it("completes a served Page on its first check while the paired aggregate job is still pending", async () => {
  const child = await seedAggregateChild();
  const ref = firestore.doc(`cmsPublishQueue/${child.successor}`);
  await ref.update({ status: "pending", aggregateReceipt: null });
  for (const family of aggregateConfirmation.FAMILIES) {
    await firestore.doc(`cmsBackgroundOutputs/${family}`).update({ status: "pending", receipt: null });
    await firestore.doc(`cmsPublishQueue/${child.successor}/backgroundOutputs/${family}`).update({ status: "pending", receipt: null });
  }
  await recover({ fetchPublic: fetchPublic(worker({ rendererSha: child.rendererSha })) });
  const queue = (await queueRef().get()).data();
  expect(queue).toMatchObject({ status: "success", attempts: 1, claim: null, nextAttemptAt: null,
    noBuildPage: { contextQueueId: child.original }, publicReceipt: { rendererSha: child.rendererSha, contextDigest: context.publicContextDigest(4) } });
  expect(queue.publicAggregateReceipt).toBeUndefined();
  expect(queue.awaitingAggregateProof).toBeUndefined();
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data()).toMatchObject({ publicSourceVersion: 7, publishBuildPending: false });
  // The context job keeps its own pending work, settlement and retry budget.
  expect((await ref.get()).data()).toMatchObject({ status: "pending", aggregateReceipt: null });
  expect((await firestore.doc(`cmsPublishQueue/${child.successor}/backgroundOutputs/search`).get()).data().status).toBe("pending");
});
it("completes a served Page when the public context has advanced past the accepted aggregate revision", async () => {
  const child = await seedAggregateChild();
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 5 });
  await recover({ fetchPublic: fetchPublic(worker({ rendererSha: child.rendererSha })) });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", attempts: 1,
    noBuildPage: { contextQueueId: child.original }, publicReceipt: { contextDigest: context.publicContextDigest(5) } });
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publicSourceVersion).toBe(7);
});
it("confirms against a later compatible aggregate context while preserving the original cancelled child", async () => {
  const child = await seedAggregateChild();
  await recover({ fetchPublic: fetchPublic(worker({ rendererSha: child.rendererSha })) });
  const queue = (await queueRef().get()).data();
  expect(queue).toMatchObject({ status: "success", noBuildPage: { contextQueueId: child.original }, backgroundRuntime: { release: sha } });
  expect(queue.publicAggregateReceipt).toBeUndefined();
  expect((await firestore.doc(`cmsPublishQueue/${child.original}`).get()).data().status).toBe("cancelled");
});
it("retries the current failed aggregate child atomically while retaining the cancelled original and Page operation", async () => {
  const child = await seedAggregateChild();
  await queueRef().update({ status: "failed", attempts: 4, nextAttemptAt: null });
  await firestore.doc(`cmsPublishQueue/${child.successor}`).update({ status: "failed", aggregateReceipt: null });
  for (const family of aggregateConfirmation.FAMILIES) {
    await firestore.doc(`cmsBackgroundOutputs/${family}`).update({ contextOnly: true, status: "pending" });
    await firestore.doc(`cmsPublishQueue/${child.successor}/backgroundOutputs/${family}`).update({ status: "failed", attempts: 4 });
  }
  await firestore.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused", commitSha: child.rendererSha,
    serializerId: target.serializerId });
  const request = { firestore, actor, retry: true, baseVersion: 8, changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7 }] };
  await expect(recovery.existingNoBuildPagePublication(request)).rejects.toThrow("paused");
  expect((await queueRef().get()).data().status).toBe("failed");
  await firestore.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  expect(await recovery.existingNoBuildPagePublication(request)).toMatchObject({ queueId: operationId });
  expect((await queueRef().get()).data()).toMatchObject({ status: "pending", attempts: 0, backgroundRuntime: { release: sha } });
  expect((await firestore.doc(`cmsPublishQueue/${child.original}`).get()).data().status).toBe("cancelled");
  expect((await firestore.doc(`cmsPublishQueue/${child.successor}`).get()).data().status).toBe("pending");
  expect((await firestore.doc(`cmsPublishQueue/${child.successor}/backgroundOutputs/search`).get()).data())
    .toMatchObject({ status: "pending", attempts: 0, claim: null });
});

async function seedFullPageCoverage({ includeHomeSources = false, dataHubPublic = false } = {}) {
  const { PUBLIC_PAGE_DEFINITIONS } = await import("../../functions/lib/public-page-contract.js");
  const { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } = await import("../../packages/content-core/src/cms-settings");
  const settingsContract = (await import("../../functions/lib/cms-settings-contract.js")).default;
  const settingsOwner = (await import("../../functions/lib/settings-publication.js")).default;
  const { createHash } = await import("node:crypto");
  const home = await seedHomeRefresh();
  scheduleFixture = await schedulePacketFixture({ firestore, rendererSha: sha, boundary: pageStorageBoundary, includeHomeSources });
  const batch = firestore.batch();
  if (dataHubPublic) batch.update(firestore.doc(ownership.PAGE_CAPABILITY_PATH),{dataHubReportingVersion:1});
  // Schedule/Live stay unowned and exercise their actual qualified packet
  // frames; retained invisible owners keep all other withdrawal proofs.
  for (const [id, definition] of Object.entries(PUBLIC_PAGE_DEFINITIONS)) {
    if (["home", "schedule", "live"].includes(id) || id === "data-hub" && !dataHubPublic) continue;
    const row = pageDocument(id); row.publiclyVisible = false;
    const current = { ...state, pageId: id, operationId: ownership.digest(id).slice(0, 20),
      sourceVersion: row.published.sourceVersion, snapshotDigest: ownership.digest(row.published),
      path: definition.path, ownedPaths: [definition.path, ...(definition.aliases ?? [])], visible: false };
    current.durableWithdrawal = { schemaVersion: 1, pageId: id, operationId: current.operationId,
      sourceVersion: current.sourceVersion, revision: current.generation, ownedPaths: current.ownedPaths,
      snapshotDigest: current.snapshotDigest, contextRevision: 3 };
    batch.set(firestore.doc(`cmsPages/${id}`), row);
    batch.set(firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`), current);
    for (const path of current.ownedPaths) batch.set(ownership.pageRouteRef(firestore, path), { schemaVersion: 1, pageId: id, path });
  }
  const id = "public-site-chrome";
  const published = settingsContract.createCmsSettingsPublishedSnapshot({ schema: settingsContract.currentCmsSettingsSchemaFor(id),
    values: DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, sourceVersion: 1, publishedAt: "2026-10-12T10:00:00.000Z" });
  const settingsDocument = { version: 2, schemaVersion: 1, values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
    newsletterLabel: "Private later draft" }, published };
  batch.set(firestore.doc(`cmsSettings/${id}`), settingsDocument);
  const settingsOperationId = settingsOwner.settingsOperationId(id, 1);
  const identity = { id, sourceVersion: 1, operationId: settingsOperationId, originalOperationId: settingsOperationId,
    rendererSha: sha, contextRevision: 3, contextDigest: state.contextDigest,
    snapshotDigest: createHash("sha256").update(JSON.stringify(published)).digest("hex"), requiredConsumers: settingsOwner.REQUIRED_CONSUMERS };
  batch.set(firestore.doc(`cmsPublishQueue/${settingsOperationId}`), { transport: "public-context-no-build-v1", status: "pending",
    runtime: state.runtime, publicContext: { operationId: settingsOperationId, contextRevision: 3, contextDigest: state.contextDigest },
    settingsPublication: identity });
  await batch.commit();
  return { home, id, settingsOperationId, settingsDocument };
}

async function seedSettingsPosts(count = 2) {
  const batch = firestore.batch();
  batch.set(firestore.doc(postOwnership.CAPABILITY_PATH), { schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 2 });
  for (let index = 0; index < count; index++) {
    const postId = `settings-post-${index}`, slug = `settings-story-${index}`;
    const working = { type: "post", version: 1, title: `Published story ${index}`, slug, locale: "en-US",
      previousSlugs: [`old-settings-story-${index}`], blocks: [], credits: [], tags: [], categories: [], date: "2026-10-12" };
    const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: working,
      publishedAt: "2026-10-12T10:00:00.000Z", publishedBy: "fixture" });
    batch.set(firestore.doc(`cmsPosts/${postId}`), { ...working, title: "Private later draft", version: 2,
      status: "draft", publiclyVisible: true, published });
    batch.set(firestore.doc(`${postOwnership.OWNER_COLLECTION}/${postId}`), { schemaVersion: 1, postId,
      rendererSha: sha, servingEnabled: true, generation: 2, operationId: String(index + 1).padStart(20, "0"),
      sourceVersion: 1, visible: true, slug, ownedSlugs: [slug, ...working.previousSlugs] });
  }
  // #3452's two extra published cmsPosts are Programs, not Post detail pages.
  batch.set(firestore.doc("cmsPosts/program-fixture"), { status: "published", publiclyVisible: true,
    published: { metadata: { type: "program", slug: "state-of-the-arts" }, sourceVersion: 1 } });
  await batch.commit();
}

function settingsPublicFetch(home) {
  const pageWorker = worker({ fetchAsset: home.fetchAsset });
  const postWorker = createNoBuildPostWorker({ target, rendererSha: sha,
    // Cache.put consumes its input body; dropping a tee branch makes cancellation hang.
    cache: { async match() {}, async put(_request, response) { await response.arrayBuffer(); } }, fetchAsset: home.fetchAsset,
    getDecision: path => postPublication.readNoBuildPostDecision({ firestore, path, rendererSha: sha }),
    render: async content => `<!doctype html><html><body>${content.posts[0].title}</body></html>` });
  return (url, options) => (new URL(url).pathname.startsWith("/posts/") ? postWorker : pageWorker).fetch(new Request(url, options));
}

it.each(["owner", "context"].flatMap(lane => [false, true].map(stale => ({ lane, stale }))))(
  "retries a pending Page after a settings change and refuses stale settings (%j)", async ({ lane, stale }) => {
  const { home, id, settingsOperationId, settingsDocument } = await seedFullPageCoverage();
  const settingsOwner = require("../../functions/lib/settings-publication.js");
  const settingsContract = require("../../functions/lib/cms-settings-contract.js");
  if (lane === "context") {
    await ownerRef().delete();
    for (const path of state.ownedPaths) await ownership.pageRouteRef(firestore, path).delete();
  }
  const pageHtml = content => `<!doctype html><html><body>${content.settings.find(setting => setting.settingId === id).newsletterLabel}</body></html>`;
  const oldResponse = await worker({ pageHtml, contextHtml: pageHtml }).fetch(new Request(`${target.origin}/proof-page/`));
  const oldHtml = await oldResponse.clone().text();
  const published = settingsContract.createCmsSettingsPublishedSnapshot({ schema: settingsContract.currentCmsSettingsSchemaFor(id),
    values: { ...settingsDocument.published.values, newsletterLabel: "Current newsletter label" }, sourceVersion: 2,
    publishedAt: "2026-11-08T21:39:00.000Z" });
  const nextOperationId = settingsOwner.settingsOperationId(id, 2);
  const previousQueue = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  const nextIdentity = { ...previousQueue.settingsPublication, sourceVersion: 2, operationId: nextOperationId,
    originalOperationId: nextOperationId, snapshotDigest: require("node:crypto").createHash("sha256").update(JSON.stringify(published)).digest("hex"),
    contextRevision: 4, contextDigest: context.publicContextDigest(4) };
  await firestore.doc(`cmsSettings/${id}`).set({ ...settingsDocument, version: 3, published });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 4 });
  await firestore.doc(`cmsPublishQueue/${nextOperationId}`).set({ ...previousQueue, settingsPublication: nextIdentity,
    publicContext: { operationId: nextOperationId, contextRevision: 4, contextDigest: nextIdentity.contextDigest } });
  let decisions = 0;
  const page = worker({ pageHtml, contextHtml: pageHtml, fetchAsset: home.fetchAsset,
    // The R2 boundary shape is recorded in #4988 and public-content-last-good.ts.
    lastGood: { async read() { return new Response(oldHtml, { headers: {
      "cache-control": "no-store", "content-type": "text/html; charset=utf-8",
      "x-njpbs-content-source": "r2-last-good", "x-njpbs-publication-refresh": "pending", "retry-after": "1" } }); } },
    getDecision: async path => {
      if (decisions++ === 0) throw new Error("Page request budget exhausted");
      return serving.readNoBuildPageDecision({ firestore, path, rendererSha: sha });
    } });
  const otherPages = settingsPublicFetch(home), responses = [];
  const proof = settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: nextOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      if (new URL(url).pathname !== "/proof-page/") return otherPages(url, options);
      const response = stale && responses.length ? oldResponse.clone() : await page.fetch(new Request(url, options));
      responses.push({ source: response.headers.get("x-njpbs-content-source"),
        context: response.headers.get("x-njpbs-context-sha256"), html: await response.clone().text() });
      return response;
    } });
  expect(await proof).toEqual(stale ? { confirmed: false, missingPages: [pageId] } : { confirmed: true });
  expect(responses).toHaveLength(2);
  expect(responses[0]).toEqual({ source: "r2-last-good", context: null, html: oldHtml });
  expect(responses[1].source).toBe(lane === "owner" ? "cms-page-no-build" : "cms-page-context");
  expect(responses[1].context).toBe(context.publicContextDigest(stale ? 3 : 4));
  expect(responses[1].html.includes("Current newsletter label")).toBe(!stale);
  const queue = (await firestore.doc(`cmsPublishQueue/${nextOperationId}`).get()).data();
  if (stale) expect(queue.consumerReceipts).toBeUndefined();
  else expect(queue.consumerReceipts.pages).toMatchObject({ contextRevision: 4, contextDigest: nextIdentity.contextDigest });
});

it.each(["context", "provider-refresh"])("confirms every settings alias behind an anonymous %s follow-up", async reason => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts(2);
  const settingsOwner = require("../../functions/lib/settings-publication.js");
  const settingsContract = require("../../functions/lib/cms-settings-contract.js");
  const { DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS } = await import("../../packages/content-core/src/cms-settings");
  const firstIdentity = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().settingsPublication;
  const id = "public-homepage-banner", bannerId = settingsOwner.settingsOperationId(id, 1);
  const published = settingsContract.createCmsSettingsPublishedSnapshot({ schema: settingsContract.currentCmsSettingsSchemaFor(id),
    values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, sourceVersion: 1, publishedAt: "2026-10-12T10:00:00.000Z" });
  await firestore.doc(`cmsSettings/${id}`).set({ version: 1, schemaVersion: 1, values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, published });
  const identities = [firstIdentity, { ...firstIdentity, id, operationId: bannerId, originalOperationId: bannerId,
    snapshotDigest: require("node:crypto").createHash("sha256").update(JSON.stringify(published)).digest("hex") }];
  await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).delete();
  const frozenId = "F".repeat(20), anonymousId = "M".repeat(20), runtime = state.runtime;
  const enqueue = async (operationId, revision, reason, identity, activateQueued = false) => firestore.runTransaction(async transaction => {
    const accepted = await publicContext.enqueuePublicContextInTransaction({ firestore, transaction,
      operationId, runtime, reason, contextRevision: revision, activateQueued });
    accepted.write();
    if (identity) transaction.set(firestore.doc(`cmsPublishQueue/${operationId}`), { settingsPublication: identity }, { merge: true });
    transaction.update(firestore.doc(context.PUBLIC_CONTEXT_PATH), { revision });
  });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await enqueue(frozenId, 2, "context");
  await firestore.doc(`cmsPublishQueue/${frozenId}/backgroundPreparation/${context.publicContextDigest(2)}`).set({
    runtime, contextDigest: context.publicContextDigest(2), status: "building",
    frozenContext: { revision: 2, withdrawalRevision: 0, homeRevision: 0 } });
  await enqueue(anonymousId, 3, reason);
  for (const identity of identities) await enqueue(identity.operationId, 3, "settings", identity);
  await firestore.doc(`cmsPublishQueue/${frozenId}`).update({ status: "success" });
  await enqueue(anonymousId, 3, reason, undefined, true);
  const batch = firestore.batch();
  for (const output of publicContext.OUTPUTS) {
    const ref = firestore.doc(`cmsBackgroundOutputs/${output}`), outputState = (await ref.get()).data();
    const receipt = { rendererSha: sha, revision: outputState.revision, contextDigest: context.publicContextDigest(3),
      verifiedAt: Date.now(), digest: "d".repeat(64), routeSetDigest: "e".repeat(64) };
    batch.update(ref, { status: "verified", receipt });
    batch.update(firestore.doc(outputState.taskPath), { status: "verified", receipt });
  }
  await batch.commit();
  expect(await publicContext.settlePublicContext({ firestore, operationId: anonymousId, runtime })).toBe(true);
  await recovery.recoverNoBuildPageDetail({ firestore, target, headers, currentCodeRequest: scheduleFixture.request,
    fetchPublic: settingsPublicFetch(home) });
  for (const identity of identities) {
    const queue = (await firestore.doc(`cmsPublishQueue/${identity.operationId}`).get()).data();
    expect(settingsOwner.settingsPublicationReceipt(queue)).toMatchObject({ status: "success", missingConsumers: [] });
  }
  expect((await firestore.doc(publicContext.CURRENT_PATH).get()).data().operationIds).toEqual([anonymousId]);
});

it("refuses repeated stale-context Page sweeps before CODE or public reads", async () => {
  const { settingsOperationId } = await seedFullPageCoverage();
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 4 });
  const before = scheduleFixture.codeRequests();
  const fetchPublic = vi.fn(() => { throw new Error("A stale proof must not fetch a public route"); });
  for (let wake = 0; wake < 12; wake++) {
    expect(await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
      target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic })).toEqual({ confirmed: false });
  }
  expect(fetchPublic).not.toHaveBeenCalled();
  expect(scheduleFixture.codeRequests()).toBe(before);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

it("shares a durable Page proof lease, backs off four failures and stops until staff retry", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  const queueRef = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  const proofRef = queueRef.collection("confirmation").doc("page-consumers");
  const log = { warn: vi.fn(), error: vi.fn() };
  let offset = 0, calls = 0, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const options = { firestore, operationId: settingsOperationId, target, headers, log,
    currentCodeRequest: scheduleFixture.request, now: () => Date.now() + offset,
    fetchPublic: async () => { calls++; entered(); await held; return new Response("Unavailable", { status: 503 }); } };
  const first = settingsConfirmation.confirmNoBuildPageSettings(options);
  await started;
  const inFlight = calls;
  expect(await settingsConfirmation.confirmNoBuildPageSettings(options)).toEqual({ confirmed: false });
  expect(calls).toBe(inFlight);
  release();
  expect((await first).confirmed).toBe(false);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const prior = (await proofRef.get()).data();
    expect(prior).toMatchObject({ attempts: attempt, status: "failed", claim: null });
    const before = calls;
    expect(await settingsConfirmation.confirmNoBuildPageSettings(options)).toEqual({ confirmed: false });
    expect(calls).toBe(before);
    if (attempt < 4) {
      expect(prior.nextAttemptAt - options.now()).toBeGreaterThan(60_000 * 2 ** (attempt - 1) - 5_000);
      offset += 60_000 * 2 ** (attempt - 1) + 1;
      expect((await settingsConfirmation.confirmNoBuildPageSettings(options)).confirmed).toBe(false);
    }
  }
  expect((await proofRef.get()).data().nextAttemptAt).toBeNull();
  const exhausted = calls;
  offset += 24 * 60 * 60_000;
  expect(await settingsConfirmation.confirmNoBuildPageSettings(options)).toEqual({ confirmed: false });
  expect(calls).toBe(exhausted);
  expect(log.error).toHaveBeenCalledTimes(1);
  expect((await queueRef.get()).data().consumerReceipts).toBeUndefined();
  await queueRef.update({ settingsRetryAt: Timestamp.now() });
  offset = 0;
  expect(await settingsConfirmation.confirmNoBuildPageSettings({ ...options, fetchPublic: settingsPublicFetch(home) }))
    .toEqual({ confirmed: true });
  expect((await proofRef.get()).data()).toMatchObject({ attempts: 1, status: "verified" });
}, 45_000);

it("retains the delay after a crashed Page proof and fences its late receipt", async () => {
  const { settingsOperationId } = await seedFullPageCoverage();
  const ref = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  const queue = (await ref.get()).data(), identity = queue.settingsPublication;
  let time = Date.now();
  const log = { warn: vi.fn(), error: vi.fn() };
  const claim = () => pageProof.claimPageConsumerProof({ firestore, operationId: settingsOperationId,
    identity, now: () => time, deadline: time + 45_000, log });
  const first = await claim();
  const stored = (await ref.collection("confirmation").doc("page-consumers").get()).data();
  time = stored.leaseUntil + 1;
  expect(await claim()).toBeNull();
  time = stored.nextAttemptAt;
  const successor = await claim();
  expect(successor).not.toBeNull();
  await expect(firestore.runTransaction(transaction => first.assertCurrent(transaction, queue),
    { readOnly: true })).rejects.toThrow("Page consumer confirmation lease expired");
  await first.finish(false);
  await firestore.runTransaction(transaction => successor.assertCurrent(transaction, { settingsPublication: identity }), { readOnly: true });
  await successor.finish(false);
  expect((await ref.collection("confirmation").doc("page-consumers").get()).data()).toMatchObject({ attempts: 2, status: "failed" });
  for (let attempt = 3; attempt <= 4; attempt++) {
    const prior = (await ref.collection("confirmation").doc("page-consumers").get()).data();
    time = prior.nextAttemptAt;
    const crashed = await claim();
    expect(crashed).not.toBeNull();
    if (attempt === 3) await crashed.finish(false);
  }
  time = (await ref.collection("confirmation").doc("page-consumers").get()).data().leaseUntil;
  expect(await claim()).toBeNull();
  expect(await claim()).toBeNull();
  expect(log.error).toHaveBeenCalledTimes(1);
  expect((await ref.collection("confirmation").doc("page-consumers").get()).data()).toMatchObject({ attempts: 4, status: "failed", nextAttemptAt: null });
});

it("does not spend the Page proof budget on wakes with too little shared deadline left", async () => {
  const { settingsOperationId } = await seedFullPageCoverage();
  const ref = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  const identity = (await ref.get()).data().settingsPublication;
  const time = Date.now(), log = { warn: vi.fn(), error: vi.fn() };
  for (let wake = 0; wake < 6; wake++) {
    expect(await pageProof.claimPageConsumerProof({ firestore, operationId: settingsOperationId,
      identity, now: () => time, deadline: time + 29_999, log })).toBeNull();
  }
  expect((await ref.collection("confirmation").doc("page-consumers").get()).exists).toBe(false);
  const ready = await pageProof.claimPageConsumerProof({ firestore, operationId: settingsOperationId,
    identity, now: () => time, deadline: time + 45_000, log });
  expect(ready).not.toBeNull();
  expect((await ref.collection("confirmation").doc("page-consumers").get()).data().attempts).toBe(1);
  await ready.finish(false);
});

it("refuses a Page receipt if its shared proof lease changes during public reads", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  const ref = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  const fetchPublic = settingsPublicFetch(home);
  const log = { warn: vi.fn(), error: vi.fn() };
  let replaced = false;
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, log, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      if (!replaced) {
        replaced = true;
        await ref.collection("confirmation").doc("page-consumers").update({ claim: "replacement-fixture-claim" });
      }
      return fetchPublic(url, options);
    } })).rejects.toThrow("Page consumer confirmation lease expired");
  expect(log.warn).toHaveBeenCalledWith("Page consumer confirmation refused", expect.objectContaining({
    operationId: settingsOperationId, causes: expect.arrayContaining([expect.objectContaining({ status: 409 })]) }));
  expect((await ref.get()).data().consumerReceipts).toBeUndefined();
});

it("proves all 62 canonical Post details with Page/Home in one settings receipt, preserving private drafts", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts(62);
  const before = (await firestore.doc("cmsPosts/settings-post-0").get()).data();
  const visited = new Set(), publicFetch = settingsPublicFetch(home);
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: (url, options) => {
      visited.add(new URL(url).pathname); return publicFetch(url, options);
    } });
  expect(result).toEqual({ confirmed: true });
  for (let index = 0; index < 62; index++) {
    expect(visited.has(`/posts/settings-story-${index}/`)).toBe(true);
    expect(visited.has(`/posts/old-settings-story-${index}/`)).toBe(false);
  }
  expect(visited.has("/posts/state-of-the-arts/")).toBe(false);
  const queue = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  expect(queue.consumerReceipts.posts).toEqual(queue.consumerReceipts.pages);
  expect(queue.consumerReceipts.posts).toEqual(queue.consumerReceipts.home);
  expect(queue.consumerReceipts.posts).toMatchObject({ rendererSha: sha, contextRevision: 3, contextDigest: context.publicContextDigest(3) });
  expect((await firestore.doc("cmsPosts/settings-post-0").get()).data()).toEqual(before);
}, 45_000);

it("confirms settings with a published custom-link Post while ignoring its later private link draft", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts(1);
  const ref = firestore.doc("cmsPosts/settings-post-0");
  await ref.update({ "published.metadata.contentLinkMode": "custom", "published.metadata.contentLinkUrl": "https://example.test/published-story",
    contentLinkMode: "custom", contentLinkUrl: "https://example.test/private-draft" });
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: settingsPublicFetch(home) });
  expect(result).toEqual({ confirmed: true });
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts.posts)
    .toMatchObject({ rendererSha: sha, contextRevision: 3 });
});

it("keeps an admitted subset pending and identifies a static Post even when Page/Home were already proved", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts();
  await firestore.doc(`${postOwnership.OWNER_COLLECTION}/settings-post-1`).delete();
  const exact = { rendererSha: sha, contextRevision: 3, contextDigest: state.contextDigest, verifiedAt: 1234 };
  const ref = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  await ref.update({ consumerReceipts: { pages: exact, home: exact } });
  const before = (await ref.get()).data();
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: settingsPublicFetch(home) });
  expect(result).toEqual({ confirmed: false, missingPosts: ["settings-post-1"] });
  expect((await ref.get()).data()).toEqual(before);
});

it("waits through production Post authority refresh before confirming the complete settings family", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts();
  const cached = new Map(), background = [], observed = [];
  let refused = false;
  const postWorker = createTransitionalPostReadWorker({ target, rendererSha: sha, rendererReady: true,
    cache: { async match(request) { return cached.get(request.url)?.clone(); },
      async put(request, response) { cached.set(request.url, response.clone()); } },
    waitUntil: task => background.push(task), fetchAsset: home.fetchAsset,
    getDecision: path => {
      if (path === "/posts/settings-story-0/" && !refused) {
        refused = true; throw new Error("Fixture authority network outage");
      }
      return postPublication.readNoBuildPostDecision({ firestore, path, rendererSha: sha });
    },
    render: async content => `<!doctype html><html><body>${content.posts[0].title}</body></html>` });
  const pageWorker = worker({ fetchAsset: home.fetchAsset });
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const response = await (new URL(url).pathname.startsWith("/posts/") ? postWorker : pageWorker).fetch(new Request(url, options));
      if (new URL(url).pathname === "/posts/settings-story-0/") observed.push({ source: response.headers.get("x-njpbs-content-source"),
        pending: response.headers.get("x-njpbs-publication-refresh"), retry: response.headers.get("retry-after") });
      return response;
    } });
  await Promise.all(background);
  expect(observed[0]).toMatchObject({ pending: "pending", retry: "1" });
  expect(observed.at(-1)).toEqual({ source: "cms-no-build", pending: null, retry: null });
  expect(result).toEqual({ confirmed: true });
  const consumers = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts;
  expect(consumers.posts).toEqual(consumers.pages); expect(consumers.posts).toEqual(consumers.home);
});

it.each(["renderer", "context", "redirect", "bytes", "static"])("refuses a %s Post response without writing any consumer receipt", async change => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts();
  const publicFetch = settingsPublicFetch(home);
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const observed = await publicFetch(url, options);
      if (!new URL(url).pathname.endsWith("settings-story-1/")) return observed;
      // Drain the real Worker transport before changing its receipt. Cancelling
      // its unread transform would otherwise wait for the ten-second IO bound.
      const response = new Response(await observed.arrayBuffer(), { status: observed.status, headers: observed.headers });
      if (change === "renderer") response.headers.set("x-njpbs-renderer-sha", "b".repeat(40));
      if (change === "context") response.headers.set("x-njpbs-context-sha256", "f".repeat(64));
      if (change === "redirect") { await response.body?.cancel(); return new Response(null, { status: 308, headers: response.headers }); }
      if (change === "bytes" && response.status === 200) response.headers.set("x-njpbs-html-sha256", "f".repeat(64));
      if (change === "static") response.headers.delete("x-njpbs-content-source");
      return response;
    } })).rejects.toThrow(change === "bytes" ? "Public Post bytes changed" : "has an unavailable public receipt");
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

it.each(["new Post", "withdrawal", "snapshot", "owner"])("refuses %s movement after public reads without acknowledging a subset", async change => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  await seedSettingsPosts();
  const publicFetch = settingsPublicFetch(home);
  let moved = false;
  const proof = settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const response = await publicFetch(url, options);
      if (!moved && new URL(url).pathname === "/posts/settings-story-1/") {
        moved = true;
        if (change === "new Post") {
          const next = (await firestore.doc("cmsPosts/settings-post-0").get()).data();
          next.published.metadata.slug = "new-settings-story";
          next.published.metadata.previousSlugs = [];
          await firestore.doc("cmsPosts/new-static-post").set(next);
        }
        if (change === "withdrawal") await firestore.doc("cmsPosts/settings-post-0").update({ publiclyVisible: false });
        if (change === "snapshot") await firestore.doc("cmsPosts/settings-post-0").update({ "published.metadata.title": "Changed public title" });
        if (change === "owner") await firestore.doc(`${postOwnership.OWNER_COLLECTION}/settings-post-0`).update({ operationId: "Z".repeat(20) });
      }
      return response;
    } });
  if (change === "new Post") await expect(proof).rejects.toThrow("The published Post roster or its public dependencies changed during the settings proof.");
  else await expect(proof).rejects.toThrow();
  expect(moved).toBe(true);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

it.each([[20, 22_800], [52, 42_800]])("models CODE IO and shared public-readback time for 20 Pages and %i cold Posts", async (posts, elapsed) => {
  vi.useFakeTimers();
  try {
    let active = 0, maximum = 0;
    const start = Date.now();
    // Coordinator production evidence, 2026-10-14: four CODE reads at 0.7 s,
    // 20 Page reads at up to 2.5 s (Home 2 s). A settings change makes
    // every Post a render-cache MISS: allow 5 s for each complete response.
    // Authority work is excluded. At 52 Posts the IO-only margin is 2.2 s;
    // that count is not a claim that the full confirmation can complete.
    await vi.advanceTimersByTimeAsync(4 * 700);
    const requests = [...Array.from({ length: 20 }, (_, id) => ({ id, latency: id === 0 ? 2_000 : 2_500 })),
      ...Array.from({ length: posts }, (_, id) => ({ id: id + 20, latency: 5_000 }))];
    const proof = postSettingsConfirmation.readSettingsProofs(requests, ({ id, latency }) =>
      new Promise(resolve => {
        maximum = Math.max(maximum, ++active);
        setTimeout(() => { active--; resolve(id); }, latency);
      }), { now: Date.now, deadline: start + 45_000 });
    await vi.advanceTimersByTimeAsync(elapsed - 2_800);
    expect(await proof).toEqual(Array.from({ length: posts + 20 }, (_, id) => id));
    expect(maximum).toBe(8); expect(Date.now() - start).toBe(elapsed);
  } finally { vi.useRealTimers(); }
});

it("refuses when the shared public readback reaches its deadline", async () => {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    const proof = postSettingsConfirmation.readSettingsProofs(["last-post"], (_post, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted public read")))),
    { now: Date.now, deadline: start + 200 });
    const refused = expect(proof).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    await refused;
    expect(Date.now() - start).toBe(200);
  } finally { vi.useRealTimers(); }
});

it("reports a timed-out pending Page and continues the next settings proof batch", async () => {
  vi.useFakeTimers();
  try {
    const entries = Array.from({ length: 9 }, (_, index) => ({ pageId: index === 0 ? "schedule" : `page-${index}` }));
    const visited = [], failures = [];
    const proof = postSettingsConfirmation.readSettingsProofs(entries, (entry, signal) => {
      visited.push(entry.pageId);
      if (entry.pageId !== "schedule") return Promise.resolve({ kind: "page" });
      return recovery.readPublicPageReceipt({ state: { ...state, ownedPaths: [state.path] }, target, headers, signal,
        fetchPublic: async () => new Response("Pending Schedule", { headers: {
          "x-njpbs-content-source": "assets", "x-njpbs-publication-refresh": "pending", "retry-after": "1" } }) });
    }, { now: Date.now, deadline: Date.now() + 45_000, onFailure(entry, error) {
      failures.push({ pageId: entry.pageId, message: error.message });
      return { kind: "missing" };
    } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await proof).toEqual([{ kind: "missing" }, ...Array.from({ length: 8 }, () => ({ kind: "page" }))]);
    expect(failures).toEqual([{ pageId: "schedule", message: "Public Post confirmation timed out" }]);
    expect(visited).toContain("page-8");
  } finally { vi.useRealTimers(); }
});

it.each(["missing", "disabled", "another renderer"])("keeps settings pending before immutable IO with %s Page capability", async mode => {
  const { settingsOperationId } = await seedFullPageCoverage();
  const ref = firestore.doc(ownership.PAGE_CAPABILITY_PATH);
  if (mode === "missing") await ref.delete();
  if (mode === "disabled") await ref.update({ servingEnabled: false });
  if (mode === "another renderer") await ref.update({ rendererSha: "f".repeat(40),
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: "f".repeat(40) } });
  const queueBefore = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request,
    fetchPublic: async () => { throw new Error("A closed Page lane cannot confirm settings"); } });
  expect(result).toMatchObject({ confirmed: false });
  expect(result.missingPages).toContain("home");
  expect(result.missingPages).toContain("schedule");
  expect(scheduleFixture.codeRequests()).toBe(0); expect(pageStorageBoundary.reads).toEqual([]);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data()).toEqual(queueBefore);
});

it("repairs the owned Home picker while a missing Schedule packet leaves settings pending without CODE reads", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  const { FieldValue } = await import("firebase-admin/firestore");
  await firestore.doc("system/publicDeployment/contexts/public").update({ "externalInputs.schedulePacket": FieldValue.delete() });
  const queueBefore = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })) });
  expect(result).toEqual({ confirmed: false, missingPages: ["live", "schedule"] });
  expect(scheduleFixture.codeRequests()).toBe(0);
  expect(pageStorageBoundary.reads.some(key => key.includes("/schedule-packets/"))).toBe(false);
  expect((await firestore.doc(`cmsHomeSourceCatalogs/${home.homeState.operationId}`).get()).data().page.contextRevision).toBe(3);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data()).toEqual(queueBefore);
});

it("keeps cheap missing-input waits outside the Page proof budget and confirms when the packet arrives", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  const { FieldValue } = await import("firebase-admin/firestore");
  const contextRef = firestore.doc(context.PUBLIC_CONTEXT_PATH);
  const packet = (await contextRef.get()).data().externalInputs.schedulePacket;
  await contextRef.update({ "externalInputs.schedulePacket": FieldValue.delete() });
  const proofRef = firestore.doc(`cmsPublishQueue/${settingsOperationId}/confirmation/page-consumers`);
  const log = { warn() {}, error() {} };
  let offset = 0;
  const options = { firestore, operationId: settingsOperationId, target, headers, log, now: () => Date.now() + offset,
    currentCodeRequest: scheduleFixture.request, fetchPublic: settingsPublicFetch(home) };
  for (let wake = 0; wake < 6; wake++) {
    expect(await settingsConfirmation.confirmNoBuildPageSettings(options))
      .toEqual({ confirmed: false, missingPages: ["live", "schedule"] });
    expect((await proofRef.get()).data()).toMatchObject({ status: "waiting", attempts: 0, nextAttemptAt: null });
    offset += 5 * 60_000;
  }
  expect(scheduleFixture.codeRequests()).toBe(0);
  await contextRef.update({ "externalInputs.schedulePacket": packet });
  offset = 0;
  expect(await settingsConfirmation.confirmNoBuildPageSettings(options)).toEqual({ confirmed: true });
  expect((await proofRef.get()).data()).toMatchObject({ status: "verified", attempts: 1 });
});

it("confirms full Page/Home settings through the actual settings owner reader", async () => {
  const { home, id, settingsOperationId, settingsDocument } = await seedFullPageCoverage();
  for (const path of ["/schedule/", "/live/"]) {
    const decision = await serving.readNoBuildPageDecision({ firestore, path, rendererSha: sha, currentCodeRequest: scheduleFixture.request });
    await expect(projectPublicPageContextRead(decision.renderContext, sha, new Date())).resolves.toMatchObject({
      target: { pagePath: path, source: "site" } });
    const response = await worker({ fetchAsset: home.fetchAsset }).fetch(new Request(`${target.origin}${path}`));
    expect({ path, status: response.status, source: response.headers.get("x-njpbs-content-source") })
      .toEqual({ path, status: 200, source: "cms-page-context" });
  }
  let finalPhase = false, finalAttempts = 0, finalCodeReads, finalStorageReads;
  const guardedFirestore = new Proxy(firestore, { get(object, key) {
    if (key === "runTransaction") return (callback, options) => object.runTransaction(async transaction => {
      const final = finalPhase && options?.readOnly !== true;
      if (final) finalAttempts++;
      const result = await callback(transaction);
      if (final && finalAttempts === 1) throw Object.assign(new Error("Fixture final SDK abort"), { code: 10 });
      // Lease settlement follows the completed receipt transaction.
      if (final) finalPhase = false;
      return result;
    }, options);
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } });
  const publicFetchForProof = fetchPublic(worker({ fetchAsset: home.fetchAsset }));
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore: guardedFirestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const response = await publicFetchForProof(url, options);
      if (new URL(url).pathname === "/schedule/") {
        finalPhase = true; finalCodeReads = scheduleFixture.codeReads(); finalStorageReads = scheduleFixture.boundary.reads.length;
        scheduleFixture.refuseCode(); scheduleFixture.boundary.refuseReads(true);
      }
      return response;
    } });
  expect(result).toEqual({ confirmed: true });
  expect(finalAttempts).toBe(2);
  expect(scheduleFixture.codeReads()).toBe(finalCodeReads);
  expect(scheduleFixture.boundary.reads.length).toBe(finalStorageReads);
  expect(scheduleFixture.codeReads()).toBeGreaterThanOrEqual(2);
  expect(scheduleFixture.boundary.writes).toEqual([]);
  const accepted = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  expect(accepted.consumerReceipts).toMatchObject({ pages: { rendererSha: sha, contextRevision: 3 }, home: { rendererSha: sha, contextRevision: 3 } });
  expect((await firestore.doc(`cmsSettings/${id}`).get()).data()).toEqual(settingsDocument);
  expect(await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async () => { throw new Error("An exact completed consumer must not repeat public proof"); } }))
    .toEqual({ confirmed: true });
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data()).toEqual(accepted);
  scheduleFixture.allowCode(); scheduleFixture.boundary.refuseReads(false);
  await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).update({ consumerReceipts: {} });
  const ownerRows = await firestore.collection(ownership.PAGE_OWNER_COLLECTION).get();
  const expectedReads = ownerRows.docs.reduce((count, row) => count + row.data().ownedPaths.length, 0) + 2;
  let reads = 0;
  const publicFetch = fetchPublic(worker({ fetchAsset: home.fetchAsset }));
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const response = await publicFetch(url, options);
      if (++reads === expectedReads) await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
      return response;
    } })).rejects.toThrow();
  expect(reads).toBe(expectedReads);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toEqual({});
});

it("proves settings Page/Home consumers on the context queue event without waiting for the minute scheduler", async () => {
  const { home, settingsOperationId } = await seedFullPageCoverage();
  const ref = firestore.doc(`cmsPublishQueue/${settingsOperationId}`);
  const handler = confirmation.createNoBuildPostConfirmationHandler({ firestore, readback: () => ({ target, headers }),
    fetchPublic: fetchPublic(worker({ fetchAsset: home.fetchAsset })), currentCodeRequest: scheduleFixture.request });
  const written = (await ref.get()).data();
  await handler({ params: { queueId: settingsOperationId }, data: { after: { data: () => written } } });
  const accepted = (await ref.get()).data();
  expect(accepted.consumerReceipts).toMatchObject({ pages: { rendererSha: sha, contextRevision: 3 }, home: { rendererSha: sha, contextRevision: 3 } });
  expect(accepted.status).toBe("pending");
});

it.each([false,true])("captures complete Page coverage with Data Hub gate %s and repeats the SDK snapshot without private IO", async dataHubPublic => {
  await seedFullPageCoverage({dataHubPublic});
  const readers = require("../../functions/lib/no-build-page-consumer-coverage.js");
  const capture = await readers.capturePageConsumerCoverage({ firestore, target, rendererSha: sha,
    currentCodeRequest: scheduleFixture.request, deadline: Date.now() + 20_000 });
  const requests = scheduleFixture.codeRequests(), reads = pageStorageBoundary.reads.length;
  scheduleFixture.refuseCode(); pageStorageBoundary.refuseReads(true);
  let attempts = 0, result;
  await firestore.runTransaction(async transaction => {
    attempts++;
    result = await readers.readCompletePageConsumerCoverageInTransaction({ firestore, transaction, target, rendererSha: sha, capture });
    if (attempts === 1) throw Object.assign(new Error("Fixture final SDK abort"), { code: 10 });
    transaction.set(firestore.doc("proof/complete-page-coverage"), { digest: result.selectionDigest });
  }, { maxAttempts: 2 });
  expect(attempts).toBe(2); expect(result).toMatchObject({ schemaVersion: 1, complete: true });
  const { PUBLIC_PAGE_DEFINITIONS } = require("../../functions/lib/public-page-contract.js");
  const expected = Object.entries(PUBLIC_PAGE_DEFINITIONS).filter(([id]) => id !== "data-hub" || dataHubPublic)
    .flatMap(([,page]) => [page.path, ...(page.aliases ?? [])]);
  expected.push("/_home-sources.json", "/proof-page/", "/old-proof/", "/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf");
  expect(result.entries.map(entry => entry.path).sort()).toEqual(expected.sort());
  expect(result.entries.find(entry => entry.path === "/_schedule-sources.json").seal.digest).not.toBe(scheduleFixture.packet.files.json.digest);
  expect(result.entries.find(entry => entry.path.endsWith(".pdf")).seal.digest).toBe(scheduleFixture.packet.files.pdf.digest);
  expect(scheduleFixture.codeRequests()).toBe(requests); expect(pageStorageBoundary.reads.length).toBe(reads);
  expect((await firestore.doc(`cmsPublishQueue/${"R".repeat(20)}`).get()).exists).toBe(false);
});
it.each(["forged", "expired", "context", "roster", "renderer", "packet", "home"])("refuses %s complete Page coverage and never emits partial completion", async change => {
  await seedFullPageCoverage();
  const readers = require("../../functions/lib/no-build-page-consumer-coverage.js");
  let clock = Date.now();
  const capture = change === "forged" ? {} : await readers.capturePageConsumerCoverage({ firestore, target, rendererSha: sha,
    currentCodeRequest: scheduleFixture.request, now: () => clock, deadline: clock + 20_000 });
  const requests = scheduleFixture.codeRequests(), reads = pageStorageBoundary.reads.length;
  scheduleFixture.refuseCode(); pageStorageBoundary.refuseReads(true);
  if (change === "expired") clock += 20_001;
  if (change === "context") await firestore.doc("system/publicDeployment/contexts/public").update({ changedAt: "Moved context" });
  if (change === "renderer") await firestore.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
  if (change === "packet") await firestore.doc("system/publicDeployment/contexts/public").update({ "externalInputs.schedulePacket.files.pdf.digest": "f".repeat(64) });
  if (change === "home") await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).delete();
  if (change === "roster") {
    const id = `page-${"3".repeat(32)}`, next = { id, version: 1, title: "New published Page", slug: "new-page", blocks: [] };
    await firestore.doc(`cmsPages/${id}`).set({ ...next, publiclyVisible: true, status: "draft",
      published: snapshots.createPublishedSnapshot({ collection: "cmsPages", document: next, publishedAt: "2026-10-12T10:00:00.000Z", publishedBy: actor.uid }) });
  }
  await expect(firestore.runTransaction(async transaction => {
    const coverage = await readers.readCompletePageConsumerCoverageInTransaction({ firestore, transaction, target, rendererSha: sha, capture });
    transaction.set(firestore.doc("proof/partial-page-coverage"), { complete: coverage.complete });
  })).rejects.toThrow();
  expect((await firestore.doc("proof/partial-page-coverage").get()).exists).toBe(false);
  expect(scheduleFixture.codeRequests()).toBe(requests); expect(pageStorageBoundary.reads.length).toBe(reads);
});
it("refuses complete Page coverage when unowned Home has no qualified CODE source", async () => {
  await seedFullPageCoverage();
  await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).delete();
  await expect(require("../../functions/lib/no-build-page-consumer-coverage.js").capturePageConsumerCoverage({
    firestore, target, rendererSha: sha, currentCodeRequest: scheduleFixture.request })).rejects.toThrow();
});

it.each(["published", "committed"])("covers an unowned %s Home frame and original CODE catalog without an invented Page operation", async frame => {
  const { settingsOperationId } = await seedFullPageCoverage({ includeHomeSources: true });
  const batch = firestore.batch();
  batch.delete(firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`));
  batch.delete(firestore.doc("cmsBackgroundOutputs/home"));
  for (const path of ["/", "/_home-sources.json"]) batch.delete(ownership.pageRouteRef(firestore, path));
  if (frame === "committed") batch.delete(firestore.doc("cmsPages/home"));
  await batch.commit();
  const readers = require("../../functions/lib/no-build-page-consumer-coverage.js");
  const capture = await readers.capturePageConsumerCoverage({ firestore, target, rendererSha: sha,
    currentCodeRequest: scheduleFixture.request });
  const requests = scheduleFixture.codeRequests(), storageReads = pageStorageBoundary.reads.length;
  const sources = scheduleFixture.homeSources;
  const instance = worker({ fetchAsset: async request => new Response(JSON.stringify(
    new URL(request.url).pathname === "/_publication.json" ? { schemaVersion: 1, ...sources.publication } : sources)) });
  const fetchPublic = async url => {
    const response = await instance.fetch(new Request(url));
    if (response) return response;
    throw new Error("The complete Page roster must own this fixture route.");
  };
  scheduleFixture.refuseCode(); pageStorageBoundary.refuseReads(true);
  const coverage = await firestore.runTransaction(transaction => readers.readCompletePageConsumerCoverageInTransaction({
    firestore, transaction, target, rendererSha: sha, capture }), { readOnly: true });
  const home = coverage.entries.find(entry => entry.path === "/");
  const catalog = coverage.entries.find(entry => entry.path === "/_home-sources.json");
  expect(home).toMatchObject({ kind: "page-context", decision: { kind: "context-page", receipt: { source: frame === "published" ? "cms" : "site" },
    codeSource: scheduleFixture.reference } });
  expect(catalog).toMatchObject({ kind: "page-context", decision: { kind: "code-home-sources", codeSource: scheduleFixture.reference } });
  expect(home.decision.receipt.operationId).toBeUndefined();
  expect(catalog.decision.homeSources.publication).toEqual(sources.publication);
  const confirmation = require("../../functions/lib/no-build-page-settings-confirmation.js");
  for (const entry of [home, catalog]) {
    await expect(confirmation.readContextReceipt({ path: entry.path, decision: entry.decision, target, headers, fetchPublic }))
      .resolves.toMatchObject({ path: entry.path, identity: entry.decision.receipt });
  }
  expect(scheduleFixture.codeRequests()).toBe(requests); expect(pageStorageBoundary.reads.length).toBe(storageReads);
  expect((await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).get()).exists).toBe(false);
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

async function seedLibraryCardConsumerProof() {
  const fixture = await seedFullPageCoverage();
  await seedSettingsPosts(2);
  const cardOwner = (await import("../../functions/lib/no-build-library-card-publication.js")).default;
  const { shapeJoinedRecord } = await import("../../functions/lib/joined-records.js");
  const { createHash } = await import("node:crypto");
  const id = "newsletter-consumer-proof";
  const approved = { id, type: "newsletter", status: "approved", version: 3,
    title: "Approved newsletter", signupUrl: "https://example.test/join", publiclyVisible: true };
  const entry = { collection: "cmsPosts", documentId: id, action: "approve", after: approved };
  await firestore.doc(`cmsPosts/${id}`).set(approved);
  await firestore.doc("cmsVersionHistory/card-consumer-proof").set(entry);
  const blocks = [{ id: "approved-card", type: "record_card", order: 0, visible: true,
    data: { recordKind: "newsletter", recordId: id, variant: "card" } }];
  const page = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  page.published.blocks = blocks;
  await firestore.doc(`cmsPages/${pageId}`).update({ published: page.published });
  const snapshotDigest = ownership.digest(page.published);
  await ownerRef().update({ snapshotDigest });
  await queueRef().update({ "noBuildPage.snapshotDigest": snapshotDigest });
  await firestore.doc("cmsPosts/settings-post-0").update({ "published.blocks": blocks });
  const projection = shapeJoinedRecord(id, approved, [entry]);
  const operationId = cardOwner.operationIdFor(id, 3, "approve");
  const identity = { schemaVersion: 1, kind: "newsletter", recordId: id, action: "approve", sourceVersion: 3,
    withdrawal: false, operationId, originalOperationId: operationId, rendererSha: sha,
    contextRevision: 3, contextDigest: context.publicContextDigest(3),
    cardDigest: createHash("sha256").update(JSON.stringify(projection.approvedLibraryVersion)).digest("hex") };
  await firestore.doc(`cmsPublishQueue/${operationId}`).set({ transport: "public-context-no-build-v1", status: "pending",
    runtime: state.runtime, publicContext: { operationId, contextRevision: 3, contextDigest: identity.contextDigest }, libraryCardPublication: identity });
  return { ...fixture, id, operationId };
}

it("proves Page/Home/Post library card consumers at the same exact public context", async () => {
  const { home, operationId } = await seedLibraryCardConsumerProof();
  const page = await serving.readNoBuildPageDecision({ firestore, path: "/proof-page/", rendererSha: sha });
  const post = await postPublication.readNoBuildPostDecision({ firestore, path: "/posts/settings-story-0/", rendererSha: sha });
  expect(page.published.joinedRecords[0].approvedLibraryVersion.title).toBe("Approved newsletter");
  expect(post.published.joinedRecords[0].approvedLibraryVersion.title).toBe("Approved newsletter");
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: settingsPublicFetch(home) });
  expect(result).toEqual({ confirmed: true });
  const queue = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  expect(queue.consumerReceipts.pages).toEqual(queue.consumerReceipts.home);
  expect(queue.consumerReceipts.pages).toEqual(queue.consumerReceipts.posts);
  expect(queue.consumerReceipts.posts).toMatchObject({ rendererSha: sha, contextRevision: 3, contextDigest: context.publicContextDigest(3) });
  expect(queue.settingsPublication).toBeUndefined();
}, 45_000);

it("refuses library card confirmation when approval is revoked during public reads", async () => {
  const { home, id, operationId } = await seedLibraryCardConsumerProof();
  const read = settingsPublicFetch(home);
  let revoked = false;
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      if (!revoked) {
        revoked = true;
        await firestore.doc(`cmsPosts/${id}`).update({ status: "archived", version: 4, publiclyVisible: false });
      }
      return read(url, options);
    } })).rejects.toThrow("replaced");
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data().consumerReceipts).toBeUndefined();
}, 45_000);

async function seedCodeCardConsumerProof(customLink = false) {
  const fixture = await seedLibraryCardConsumerProof();
  if (customLink) await firestore.doc("cmsPosts/settings-post-0").update({ "published.metadata.contentLinkMode": "custom",
    "published.metadata.contentLinkUrl": "https://example.test/code-story" });
  const post = (await firestore.doc("cmsPosts/settings-post-0").get()).data();
  await firestore.doc(`${postOwnership.OWNER_COLLECTION}/settings-post-0`).delete();
  await scheduleFixture.close();
  scheduleFixture = await schedulePacketFixture({ firestore, rendererSha: sha, boundary: pageStorageBoundary,
    includeHomeSources: true, postDocuments: [{ ...post, id: "settings-post-0" }] });
  const consumer = (await import("../../functions/lib/no-build-code-post-consumer.js")).default;
  const { createNoBuildCodePostWorker } = await import("../../workers/src/no-build-code-post-worker");
  const code = createNoBuildCodePostWorker({ rendererSha: sha, target, readWithdrawal: async () => null,
    getDecision: path => consumer.readCodePostConsumer({ firestore, path, rendererSha: sha, currentCodeRequest: scheduleFixture.request }),
    render: async content => `<!doctype html><html><body>${content.recordCards[0].title}</body></html>` });
  const other = settingsPublicFetch(fixture.home);
  const read = async (url, options) => new URL(url).pathname === "/posts/settings-story-0/"
    ? code.fetch(new Request(url, options)) : other(url, options);
  return { ...fixture, read };
}

it("confirms library card consumers in genuine retained CODE Post frames without a Post owner", async () => {
  const { operationId, read } = await seedCodeCardConsumerProof();
  const post = await read(`${target.origin}/posts/settings-story-0/`);
  expect(post.headers.get("x-njpbs-content-source")).toBe("cms-code-post-context");
  expect(await post.text()).toContain("Approved newsletter");
  const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: read });
  expect(result).toEqual({ confirmed: true });
  const queue = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  expect(queue.consumerReceipts.posts).toEqual(queue.consumerReceipts.pages);
  expect((await firestore.doc(`${postOwnership.OWNER_COLLECTION}/settings-post-0`).get()).exists).toBe(false);
}, 45_000);

it("confirms settings consumers in a custom-link CODE Post frame", async () => {
  const { operationId, read } = await seedCodeCardConsumerProof(true);
  const response = await read(`${target.origin}/posts/settings-story-0/`);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://example.test/code-story");
  expect(await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: read })).toEqual({ confirmed: true });
});

it("rejects a mismatched CODE card input seal without partial consumer receipts", async () => {
  const { operationId, read } = await seedCodeCardConsumerProof();
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: async (url, options) => {
      const response = await read(url, options);
      if (new URL(url).pathname !== "/posts/settings-story-0/") return response;
      const changed = new Headers(response.headers);
      changed.set("x-njpbs-input-source-sha256", "f".repeat(64));
      return new Response(response.body, { status: response.status, headers: changed });
    } })).rejects.toThrow("CODE receipt");
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data().consumerReceipts).toBeUndefined();
}, 45_000);


it.each(["program", "event"].flatMap(kind => ["/proof-page/", "/", "/posts/settings-story-0/"].map(failedPath => ({ kind, failedPath }))))(
  "recovers $kind consumers after a preparation successor loses $failedPath confirmation", async ({ kind, failedPath }) => {
  const previousEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
  try {
    const { home } = await seedFullPageCoverage();
    await seedSettingsPosts(1);
    await firestore.doc("cmsPosts/program-fixture").delete();
    const recordPublication = require("../../functions/lib/no-build-record-publication");
    const recordConfirmation = require("../../functions/lib/no-build-record-confirmation");
    const recordCapability = require("../../functions/lib/no-build-record-capability");
    const aggregate = require("../../functions/lib/public-context-publication");
    const background = require("../../functions/lib/post-background-outputs");
    const publicContent = require("../../functions/public-content");
    const media = require("../../functions/lib/media-contract");
    const { recordDocument, asset } = await import("../../site/tests/fixtures/published-records/fixtures");
    const recordId = "record-recovery", recordOperationId = "R".repeat(20), runtime = state.runtime;
    await firestore.doc("cmsPosts/settings-post-0").update({ "published.blocks": [{ id: "record-card", type: "record_card", order: 0, visible: true,
      data: { recordKind: kind, recordId } }] });
    const original = recordDocument(kind, recordId);
    const next = { ...original, version: 10, status: "published", publiclyVisible: true, publishAt: "2026-10-23T12:00:00.000Z",
      published: snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...original.published.metadata, version: 10 },
        publishedBy: "editor", publishedAt: "2026-10-23T12:00:00.000Z" }),
      publicSourceVersion: null, publishBuildPending: true, publishBuildQueueId: recordOperationId };
    await firestore.doc(recordCapability.CAPABILITY_PATH).set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 2,
      families: ["programs", "events"], terminalOwner: { schemaVersion: 1, rendererSha: sha, transport: "public-context-no-build-v1" } });
    await firestore.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: target.serializerId });
    // Acceptance advances to the context already qualified by the Page fixtures.
    await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
    const art = { lifecycle: "active", source: "site_seed", url: asset.url, mimeType: asset.mimeType,
      width: asset.width, height: asset.height, altText: "Public art" };
    await firestore.doc("media_assets/record-art").set(art);
    await firestore.doc("media_assets_public/record-art").set(media.mediaProjection(art));
    const identity = await firestore.runTransaction(async transaction => {
      const work = await recordPublication.prepareNoBuildRecordPublication({ firestore, transaction, collection: "cmsPosts", documentId: recordId,
        nextDocument: next, queueRef: firestore.doc(`cmsPublishQueue/${recordOperationId}`), actor,
        config: { valid: true, enabled: true, admissionRevision: 2, families: { programs: { mode: "all" }, events: { mode: "all" } } } });
      transaction.set(firestore.doc(`cmsPosts/${recordId}`), next); work.write(); return work.operation;
    });
    const joinedPage = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
    joinedPage.published.blocks.push({ id: "pending-record-card", type: "record_card", order: joinedPage.published.blocks.length,
      visible: true, data: { recordKind: kind, recordId } });
    await firestore.doc(`cmsPages/${pageId}`).update({ published: joinedPage.published });
    await ownerRef().update({ snapshotDigest: ownership.digest(joinedPage.published) });
    const objects = new Map();
    const artifacts = { async put(key, bytes) { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); }, async get(key) { return objects.get(key) ?? null; } };
    const paths = { listings: ["/posts/"], authors: ["/authors/example/"], feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json"],
      sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"],
      [identity.family]: [...(kind === "program" ? ["/programs/", "/shows/"] : ["/events/"]), ...identity.ownedPaths] };
    const outputs = background.createPostBackgroundOutputs({ firestore, runtime, enabled: true, postIds: [], recoveryOutputs: Object.keys(paths), artifacts,
      readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, firestore),
      build: async task => ({ input: { kind: "public-background", rendererSha: sha, contextDigest: identity.contextDigest, routes: [] },
        files: paths[task.output].map(path => ({ path, bytes: `<!doctype html><html><main>${path}</main></html>`, contentType: "text/html; charset=utf-8" })) }) });
    await outputs.recover();
    expect(await aggregate.settlePublicContext({ firestore, operationId: recordOperationId, runtime })).toBe(true);
    await firestore.runTransaction(async transaction => { (await aggregate.retryPublicContextInTransaction({ firestore, transaction, operationId: recordOperationId, runtime }))(); });
    const pointer = (await firestore.doc(aggregate.CURRENT_PATH).get()).data();
    expect(pointer.operationId).not.toBe(recordOperationId);
    await firestore.doc(`cmsPublishQueue/${pointer.operationId}/backgroundPreparation/${identity.contextDigest}`).set({
      schemaVersion: 1, status: "verified", runtime, contextDigest: identity.contextDigest, preparedDigest: "b".repeat(64), admissionRevision: null,
      reservation: { commitSha: sha, buildBatchId: "fixture", generation: 2, cutoffAt: new Date() } });
    expect(await aggregate.settlePublicContext({ firestore, operationId: pointer.operationId, runtime })).toBe(true);
    let fail = true;
    const visited = new Set(), pageAndPost = settingsPublicFetch(home);
    const read = async (url, options) => {
      const path = new URL(url).pathname; visited.add(path);
      if (fail && path === failedPath) throw new Error("Transient consumer response loss");
      if (!path.startsWith("/programs/") && !path.startsWith("/shows/") && !path.startsWith("/events/")) return pageAndPost(url, options);
      const reply = { body: null, statusCode: 0, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await publicContent.createCmsGetPublicPageHandler({ firestore, backgroundArtifacts: artifacts, log: { error() {}, warn() {} } })({ method: "POST",
        body: { mode: "no-build-post-v1", path, rendererSha: sha } }, reply);
      expect(reply.statusCode).toBe(200);
      return new Response(Buffer.from(reply.body.bytes, "base64"), { status: reply.body.status, headers: reply.body.headers });
    };
    const options = { firestore, target, headers, artifacts, fetchPublic: read, currentCodeRequest: scheduleFixture.request };
    const handler = confirmation.createNoBuildPostConfirmationHandler({ firestore, readback: () => ({ target, headers }),
      fetchPublic: read, currentCodeRequest: scheduleFixture.request, artifacts });
    const ref = firestore.doc(`cmsPublishQueue/${recordOperationId}`);
    await handler({ params: { queueId: ref.id }, data: { after: await ref.get() } });
    expect(visited.has(failedPath)).toBe(true);
    expect((await firestore.doc(`cmsPosts/${recordId}`).get()).data().publishBuildPending).toBe(true);
    fail = false; visited.clear();
    expect(await recordConfirmation.recoverNoBuildRecordPublication({ ...options, now: () => Date.now() + 60_001 })).toEqual({ confirmed: true });
    expect(visited.has(failedPath)).toBe(true);
    expect(recordPublication.recordPublicationReceipt((await ref.get()).data())).toMatchObject({ status: "success", missingConsumers: [] });
    expect((await firestore.doc(`cmsPosts/${recordId}`).get()).data()).toMatchObject({ publishBuildPending: false, publishBuildQueueId: null,
      publishBuildSettlement: { recordQueueId: recordOperationId, sourceVersion: 10, status: "success" } });
  } finally {
    if (previousEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT;
    else process.env.CMS_DEPLOYMENT_ENVIRONMENT = previousEnvironment;
  }
}, 45_000);

async function seedProductionSweep() {
  const seeded = await seedFullPageCoverage();
  for (const id of ["public-meetings", "schedule"]) {
    const row = pageDocument(id);
    row.publiclyVisible = true;
    const old = (await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).get()).data();
    const current = { ...(old ?? state), pageId: id, operationId: ownership.digest(id).slice(0, 20),
      sourceVersion: row.published.sourceVersion, snapshotDigest: ownership.digest(row.published),
      path: id === "schedule" ? "/schedule/" : "/meeting-notices/",
      ownedPaths: id === "schedule" ? ["/schedule/"] : ["/meeting-notices/", "/public-meetings/"], visible: true };
    delete current.durableWithdrawal;
    await firestore.doc(`cmsPages/${id}`).set(row);
    await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/${id}`).set(current);
    for (const path of current.ownedPaths) await ownership.pageRouteRef(firestore, path).set({ schemaVersion: 1, pageId: id, path });
  }
  // Production has settled queues, retained owners and a context wake. The
  // owner revisions predate the currently served public context.
  await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 660 });
  await firestore.doc("system/noBuildPostAdmission").update({ revision: 7 });
  const identity = { contextRevision: 660, contextDigest: context.publicContextDigest(660) };
  await firestore.doc(`cmsPublishQueue/${seeded.settingsOperationId}`).update({ status: "success",
    "settingsPublication.contextRevision": identity.contextRevision, "settingsPublication.contextDigest": identity.contextDigest,
    "publicContext.contextRevision": identity.contextRevision, "publicContext.contextDigest": identity.contextDigest });
  await firestore.doc("system/publicDeployment/aggregateContexts/current").set({ reason: "context",
    operationId: seeded.settingsOperationId, ...identity, servingEstablished: true });
  await queueRef().update({ status: "success" });
  await firestore.doc(`cmsPublishQueue/${seeded.home.homeState.operationId}`).update({ status: "success" });
  await firestore.doc(`${ownership.PAGE_OWNER_COLLECTION}/home`).update({ "homeRefresh.status": "verified" });
  return seeded;
}

it("repairs the minute context sweep through the production legacy owned Page redirect", async () => {
  const { home, settingsOperationId } = await seedProductionSweep();
  const publicFetch = settingsPublicFetch(home), visited = [];
  await confirmation.recoverNoBuildPublications({ firestore, readback: () => ({ target, headers }),
    config: () => ({ zoneId: "f".repeat(32), token: "fixture-token" }), currentCodeRequest: scheduleFixture.request,
    fetchPublic: async (url, options) => {
      const path = new URL(url).pathname; visited.push(path);
      return path === "/public-meetings/" ? new Response(null, { status: 301,
        headers: { location: `${target.origin}/meeting-notices/` } }) : publicFetch(url, options);
    } });
  expect(visited).toContain("/meeting-notices/");
  expect(visited).toContain("/public-meetings/");
  const queue = (await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data();
  expect(queue.consumerReceipts).toMatchObject({ pages: { ...contextIdentity() }, home: { ...contextIdentity() }, posts: { ...contextIdentity() } });
});

function contextIdentity() {
  return { rendererSha: sha, contextRevision: 660, contextDigest: context.publicContextDigest(660) };
}

it("reports the refusing Schedule owner and continues later Page proofs in a production-shaped sweep", async () => {
  const { home, settingsOperationId } = await seedProductionSweep();
  const publicFetch = settingsPublicFetch(home), visited = [], warnings = [];
  const fetchObserved = async (url, options) => {
    const path = new URL(url).pathname; visited.push(path);
    if (path === "/public-meetings/") return new Response(null, { status: 301,
      headers: { location: `${target.origin}/meeting-notices/` } });
    // October 26 production GET: Assets has no publication, snapshot, renderer
    // or context receipt. A readable static Schedule cannot confirm its owner.
    // Fail the repeat GET to keep this diagnostic test below half its timeout;
    // the fake-clock case above covers a permanently pending fallback.
    if (path === "/schedule/") return visited.filter(path => path === "/schedule/").length % 2 === 0
      ? new Response("Unavailable", { status: 503 })
      : new Response("<!doctype html><html>Static Schedule</html>", { headers: {
        "cache-control": "no-store", "content-type": "text/html", "x-njpbs-content-source": "assets",
        "x-njpbs-publication-refresh": "pending", "retry-after": "1" } });
    return publicFetch(url, options);
  };
  expect(await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, fetchPublic: fetchObserved,
    log: { warn(message, fields) { warnings.push({ message, ...fields }); } } }))
    .toEqual({ confirmed: false, missingPages: ["schedule"] });
  expect(warnings).toEqual([{ message: "Page consumer confirmation is unavailable", missingPages: ["schedule"], missingPageCount: 1,
    failures: [{ pageId: "schedule", causes: [{ name: "Error", source: expect.stringMatching(/^lib\/no-build-page-recovery\.js:\d+:\d+$/) }] }] },
    { message: "Page consumer confirmation incomplete", operationId: settingsOperationId, missingPageCount: 1, missingPostCount: 0 }]);
  expect(visited).toContain("/watch/");
  await expect(confirmation.recoverNoBuildPublications({ firestore, readback: () => ({ target, headers }),
    config: () => ({ zoneId: "f".repeat(32), token: "fixture-token" }), currentCodeRequest: scheduleFixture.request,
    fetchPublic: fetchObserved })).resolves.toBeUndefined();
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
  // A later Post failure must retain the earlier bounded Schedule diagnosis.
  await seedSettingsPosts(1);
  warnings.length = 0;
  await expect(settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
    target, headers, currentCodeRequest: scheduleFixture.request, now: () => Date.now() + 60_001,
    log: { warn(message, fields) { warnings.push({ message, ...fields }); } },
    fetchPublic: (url, options) => {
      if (new URL(url).pathname.startsWith("/posts/")) throw new Error("Unreported private network detail");
      return fetchObserved(url, options);
    } })).rejects.toThrow("Unreported private network detail");
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toMatchObject({ missingPages: ["schedule"], failures: [{ pageId: "schedule", causes: [{ name: "Error" }] }] });
  expect(JSON.stringify(warnings)).not.toContain("Unreported private network detail");
  expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
});

function pageHtmlOfSize(size) {
  const prefix = "<!doctype html><html><body>", suffix = "</body></html>";
  return prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
}

it.each([2 * 1024 * 1024 + 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1])(
  "keeps Page publication and byte verification bounded at %i HTML bytes", async size => {
    const html = pageHtmlOfSize(size);
    const read = fetchPublic(worker({ html }));
    let oversizedFallback = false;
    await recover({ ...(size > 4 * 1024 * 1024 ? { deadline: Date.now() + 2_000 } : {}),
      fetchPublic: async (url, options) => {
        const response = await read(url, options);
        if (size > 4 * 1024 * 1024 && new URL(url).pathname === state.path) {
          expect(response.headers.get("x-njpbs-content-source")).toBe("assets");
          expect(response.headers.get("x-njpbs-publication-refresh")).toBe("pending");
          oversizedFallback = true;
        }
        return response;
      } });
    const queue = (await queueRef().get()).data();
    if (size <= 4 * 1024 * 1024) {
      expect(queue.status).toBe("success");
      expect(queue.publicReceipt.routes[0].status).toBe(200);
      expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publishBuildPending).toBe(false);
    } else {
      expect(oversizedFallback).toBe(true);
      expect(queue.status).toBe("pending");
      expect(queue.publicReceipt).toBeUndefined();
      expect((await firestore.doc(`cmsPages/${pageId}`).get()).data().publishBuildPending).toBe(true);
    }
  });

it.each([4 * 1024 * 1024, 4 * 1024 * 1024 + 1])(
  "keeps an unowned Schedule context and settings proof bounded at %i HTML bytes", async size => {
    const { home, settingsOperationId } = await seedFullPageCoverage();
    const html = pageHtmlOfSize(size);
    const read = fetchPublic(worker({ fetchAsset: home.fetchAsset, contextHtml: content =>
      content.target.documentId === "schedule" ? html : "<!doctype html><html>Other context</html>" }));
    let scheduleReads = 0;
    const result = await settingsConfirmation.confirmNoBuildPageSettings({ firestore, operationId: settingsOperationId,
      target, headers, currentCodeRequest: scheduleFixture.request,
      fetchPublic: async (url, options) => {
        const schedule = new URL(url).pathname === "/schedule/";
        // After observing the real oversized fallback, fail the repeat network
        // read. The short-deadline tests cover a permanently pending response.
        if (schedule && ++scheduleReads > 1) throw new Error("Schedule refresh unavailable");
        const response = await read(url, options);
        if (schedule && size > 4 * 1024 * 1024) {
          expect(response.headers.get("x-njpbs-content-source")).toBe("assets");
          expect(response.headers.get("x-njpbs-publication-refresh")).toBe("pending");
        }
        return response;
      } });
    if (size <= 4 * 1024 * 1024) {
      expect(result).toEqual({ confirmed: true });
      expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts.pages).toBeDefined();
    } else {
      expect(result).toEqual({ confirmed: false, missingPages: ["schedule"] });
      expect(scheduleReads).toBe(2);
      expect((await firestore.doc(`cmsPublishQueue/${settingsOperationId}`).get()).data().consumerReceipts).toBeUndefined();
    }
  });

// #4105: manual recovery uses the same public Worker and real emulator authority.
async function checkAgain(options = {}) {
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const handler = recheckEndpoint.createCmsRecheckPublicationHandler({ firestore,
    requirePrincipalFn: async () => ({ ...actor, emailVerified: true }),
    readbackFn: () => ({ target, headers }), fetchPublic: fetchPublic(worker()), ...options });
  await handler({ method: "POST", body: { queueId: operationId }, headers: {} }, response);
  return response;
}
async function failPage(status = "failed") {
  await queueRef().update({ status, attempts: 4, nextAttemptAt: null, error: "Public Page confirmation is unavailable" });
}
it.each(["failed", "public_unconfirmed"])("Check again confirms a %s Page late and audits once", async status => {
  await failPage(status);
  const before = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  expect(await checkAgain()).toMatchObject({ code: 200, body: { outcome: "confirmed_late" } });
  const record = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  expect(record).toMatchObject({ title: before.title, version: before.version, published: before.published,
    publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 7,
    publishBuildSettlement: { status: "success", pageReceipt: { operationId, sourceVersion: 7, visible: true } } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "success", attempts: 4, nextAttemptAt: null,
    lastPublicCheck: { outcome: "confirmed_late", actorUid: actor.uid } });
  expect(await checkAgain()).toMatchObject({ code: 409 });
  const audits = await firestore.collection("admin_logs").get();
  expect(audits.size).toBe(1);
  expect(audits.docs[0].data()).toMatchObject({ action: "cms.publicationRechecked", actorUid: actor.uid,
    target: operationId, after: { outcome: "confirmed_late", operationId, sourceVersion: 7 } });
});
it("Check again supersedes an old Page only after proving the newer publication live", async () => {
  await failPage();
  const successor = "B".repeat(20);
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { ...document, version: 8 },
    publishedAt: "2026-10-27T10:00:00.000Z", publishedBy: "fixture" });
  const newer = { ...state, operationId: successor, sourceVersion: 8, snapshotDigest: ownership.digest(published), generation: 3 };
  const { servingEnabled, runtime, ...operation } = newer;
  await ownerRef().set(newer);
  await firestore.doc(`cmsPages/${pageId}`).update({ published, version: 9, publishBuildQueueId: successor });
  await firestore.doc("system/publicDeployment").update({ activeGeneration: 3, lastReservedGeneration: 3, newestEligibleGeneration: 3 });
  await firestore.doc(`cmsPublishQueue/${successor}`).set({ ...(await queueRef().get()).data(), noBuildPage: operation,
    status: "pending", changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 8 }] });
  const before = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  expect(await checkAgain()).toMatchObject({ code: 200, body: { outcome: "superseded" } });
  expect((await queueRef().get()).data()).toMatchObject({ status: "superseded", supersededBy: successor });
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data()).toEqual(before);
});
it.each(["wrong operation", "wrong digest", "network", "broken body"])("Check again retains a Page failure for %s", async mode => {
  await failPage();
  const before = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  const request = fetchPublic(worker());
  const response = await checkAgain({ fetchPublic: async (url, options) => {
    if (mode === "network") throw new Error("Private provider detail must not escape");
    const result = await request(url, options);
    if (mode === "wrong operation") result.headers.set("x-njpbs-publication-operation", "C".repeat(20));
    if (mode === "wrong digest") result.headers.set("x-njpbs-snapshot-sha256", "d".repeat(64));
    if (mode === "broken body") return new Response("broken", { status: result.status, headers: result.headers });
    return result;
  } });
  expect(response).toMatchObject({ code: 200, body: { outcome: "failed",
    message: "The public site could not confirm this publication. Open the record to retry publication." } });
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
});
it.each(["pending", "publishing", "reserved", "success", "superseded", "cancelled"])("Check again refuses a %s Page without writing", async status => {
  await queueRef().update({ status });
  const before = (await queueRef().get()).data();
  expect(await checkAgain()).toMatchObject({ code: 409 });
  expect((await queueRef().get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});
it("Check again names removal when a Page withdrawal is still unconfirmed", async () => {
  await failPage();
  await ownerRef().update({ visible: false });
  await firestore.doc(`cmsPages/${pageId}`).update({ publiclyVisible: false });
  await queueRef().update({ "noBuildPage.visible": false,
    changes: [{ collection: "cmsPages", id: pageId, sourceVersion: 7, operation: "withdraw" }] });
  const before = (await firestore.doc(`cmsPages/${pageId}`).get()).data();
  expect(await checkAgain({ fetchPublic: async () => { throw new Error("Unavailable"); } }))
    .toMatchObject({ code: 200, body: { outcome: "failed",
      message: "The public site could not confirm this removal. Open the record to retry removal." } });
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await firestore.doc(`cmsPages/${pageId}`).get()).data()).toEqual(before);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
});
it.each(["unverified", "contributor", "other desk", "deactivated"])("Check again denies %s staff", async mode => {
  await failPage();
  const principal = mode === "contributor" ? { id: actor.uid, grants: [{ role: "contributor" }] }
    : mode === "other desk" ? { id: actor.uid, grants: [{ role: "editor", sections: ["news"] }] }
    : mode === "deactivated" ? { id: actor.uid, grants: [] } : actor.principal;
  expect(await checkAgain({ requirePrincipalFn: async () => ({ ...actor, principal, emailVerified: mode !== "unverified" }) }))
    .toMatchObject({ code: 403 });
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});
it("Check again allows only one concurrent settlement and audit", async () => {
  await failPage();
  const results = await Promise.all([checkAgain(), checkAgain()]);
  expect(results.map(result => result.code).sort()).toEqual([200, 409]);
  expect((await firestore.collection("admin_logs").get()).size).toBe(1);
});
it("Check again refuses authority that moves during the public read", async () => {
  await failPage();
  let changed = false;
  const request = fetchPublic(worker());
  const response = await checkAgain({ fetchPublic: async (url, options) => {
    const result = await request(url, options);
    if (!changed) { changed = true; await ownerRef().update({ generation: 3 }); }
    return result;
  } });
  expect(response.code).toBe(409);
  expect((await queueRef().get()).data().status).toBe("failed");
  expect((await firestore.collection("admin_logs").get()).size).toBe(0);
});

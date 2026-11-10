import { afterAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import compatibility from "../../functions/lib/page-reader-compatibility.js";
import deployment from "../../functions/lib/public-deployment.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import publication from "../../functions/lib/no-build-page-publication.js";
import candidateOwner from "../../functions/lib/no-build-page-candidate.js";
import save from "../../functions/save.js";
import previewOwner from "../../functions/preview.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import { completeReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { execFileSync } from "node:child_process";
import queueOwner from "../../functions/lib/publish-build-state.js";
import scheduler from "../../functions/scheduled-publish.js";
import { trackQualificationTransactionReads } from "../../site/scripts/public-release-pair-qualification-source";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "page-reader-contract-sdk");
const db = getFirestore(app), sha = "a".repeat(40), old = "b".repeat(40);
const instant = "2026-11-04T12:00:00.000Z";
const actor = { uid: "page-reader-editor", principal: { id: "page-reader-editor", grants: [{ role: "editor", sections: ["station"] }] } };
const ap = { id: "ap-map", type: "embed", order: 0, visible: false,
  data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html" } };
const town = { id: "town", type: "town_lookup", order: 0, visible: false,
  data: { heading: "Past results", introduction: "", sourceLine: "NJ Spotlight News" } };
const county = { id: "county", type: "county_comparison", order: 0, visible: false,
  data: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "", intro: "", source: "" } };
const marker = async (role: string, rendererSha = sha, version = 1) => db.runTransaction(async transaction => {
  const write = await compatibility.preparePageReaderMarker({ firestore: db, transaction, role, rendererSha, version }); write();
});
async function api(version = 1) {
  await db.doc("cmsDeploymentReceipts/cmsApi").set({ schemaVersion: 1, component: "cmsApi", state: "in_progress",
    mutation: { sourceSha: sha, runId: "1", runAttempt: 1 } });
  await completeReceipt(db, { component: "cmsApi", sourceSha: sha, runId: "1", runAttempt: 1,
    providerIdentities: { workerName: "fixture-api", workerVersionId: "fixture-version" } },
  { readPageReaderSource: async () => version === 0 ? null : JSON.stringify({ schemaVersion: 1, pageReaderVersion: version }) });
}
async function ready() { await marker("public"); await marker("preview"); await api(); }
async function invoke(blocks: unknown[], document: Record<string, unknown> = {}) {
  const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor,
    now: () => instant, log: { info() {}, warn() {}, error() {} } });
  const res = { code: 200, headersSent: false, body: undefined as any, set() { return this; },
    status(code: number) { this.code = code; return this; }, json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: { collection: "cmsPages", id: "contact", baseVersion: 1,
    document: { blocks, ...document } } }, res);
  return res;
}
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeCommitSha: sha, activeDeploymentId: "fixture", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture", mediaLifecycleReady: true });
  batch.set(db.doc(ownership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1 });
  batch.set(db.doc("system/cmsPreviewRuntime"), { schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "cloudflare-preview" });
  batch.set(db.doc("cmsPages/contact"), { id: "contact", template: "genericPage", section: "station", version: 1,
    title: "Contact", status: "draft", blocks: [], createdBy: actor.uid });
  await batch.commit();
});
afterAll(async () => { await db.terminate(); await deleteApp(app); });
it.each([ap, town, county])("refuses hidden $type at the real save owner until all installed readers support it", async block => {
  const before = (await db.doc("cmsPages/contact").get()).data();
  const refused = await invoke([block]);
  expect(refused.code).toBe(409);
  expect(refused.body.code).toBe("page_reader_contract_unavailable");
  expect((await db.doc("cmsPages/contact").get()).data()).toEqual(before);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  await ready();
  const result = await invoke([block]);
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  const minted = result.body.mintedIds[block.id];
  expect(minted).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  expect(result.body.document.blocks).toEqual([{ ...block, id: minted }]);
  expect((await db.doc("cmsPages/contact").get()).data()?.blocks).toEqual([{ ...block, id: minted }]);
});
it.each(["public", "preview", "api", "api-releasing", "api-changed", "preview-sha", "public-sha", "unknown"])("refuses %s reader drift without changing saved content", async kind => {
  await ready();
  await db.doc("cmsPages/contact").update({ blocks: [ap] });
  if (kind === "public" || kind === "preview") await db.doc(`${compatibility.ROOT}/${kind}/${sha}`).delete();
  if (kind === "api") await api(0);
  if (kind === "api-releasing") await db.doc("cmsDeploymentReceipts/cmsApi").update({ state: "in_progress" });
  if (kind === "api-changed") await db.doc("cmsDeploymentReceipts/cmsApi").update({ "mutation.providerIdentities.workerVersionId": "another-version" });
  if (kind === "preview-sha") await db.doc("system/cmsPreviewRuntime").update({ rendererSha: old });
  if (kind === "public-sha") await db.doc("system/publicDeployment").update({ activeCommitSha: old });
  if (kind === "unknown") await db.doc(`${compatibility.ROOT}/public/${sha}`).update({ pageReaderVersion: 2 });
  const before = (await db.doc("cmsPages/contact").get()).data();
  expect((await invoke([ap], { title: "Changed" })).code).toBe(409);
  expect((await db.doc("cmsPages/contact").get()).data()).toEqual(before);
});
it("checks legacy serializer queue admission and retains its original pending source on refusal", async () => {
  await db.doc("cmsPages/contact").update({ status: "published", publiclyVisible: true, publishBuildPending: true,
    published: { sourceVersion: 1, blocks: [ap] } });
  const mark = () => db.runTransaction(transaction => queueOwner.markBuildEnqueuedInTransaction(db, transaction,
    { queueId: "reader-window-queue", changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 1 }] }));
  await expect(mark()).rejects.toMatchObject({ code: "page_reader_contract_unavailable" });
  expect((await db.doc("cmsPages/contact").get()).data()?.publishBuildQueueId).toBeUndefined();
  await ready();
  expect(await mark()).toBe(1);
  expect((await db.doc("cmsPages/contact").get()).data()?.publishBuildQueueId).toBe("reader-window-queue");
});
it("defers a legacy scheduled Page through its native owner when the installed reader window is unavailable", async () => {
  const before = { id: "contact", title: "Contact", template: "genericPage", section: "station", version: 1,
    status: "scheduled", publishAt: "2026-11-04T11:00:00.000Z", blocks: [ap], createdBy: actor.uid };
  await db.doc("cmsPages/contact").set(before);
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "fixture" });
  await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: true });
  let deferred = false;
  await scheduler.createScheduledPublishRunner({ firestore: db, now: () => instant, log: {
    info(message: string) { if (message === "scheduled publish deferred while publication is unavailable") deferred = true; }, warn() {}, error() {} },
    assertPublishReadyFn: async () => ({ transport: "github" }), assertPublishedMediaSafeFn: async () => {},
    enqueuePublishFn: async () => { throw new Error("Unsupported scheduled publication reached dispatch"); }, reconcileStaleFn: async () => {} })();
  expect((await db.doc("cmsPages/contact").get()).data()).toEqual(before);
  expect(deferred).toBe(true);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});
it("uses one published census for both candidates and excludes private drafts from the shared read budget", async () => {
  await ready(); await marker("public", old);
  const batch = db.batch();
  for (let index = 0; index < 201; index++) batch.set(db.doc(`cmsPages/draft-${index}`), { status: "draft", blocks: [] });
  // Legacy published rows can omit publiclyVisible; they remain in the census.
  batch.set(db.doc("cmsPages/contact"), { status: "published", published: { blocks: [ap] } });
  await batch.commit();
  await db.runTransaction(async original => {
    const tracker = trackQualificationTransactionReads(original);
    await compatibility.assertCandidatePageReaders({ firestore: db, transaction: tracker.transaction, candidates: [{ commitSha: sha }, { commitSha: old }] });
    expect(tracker.readCount()).toBe(3); // One census and two immutable reader markers.
  });
});
it("reads the actual completed Git source and refuses an unavailable object instead of advertising completion", async () => {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const complete = async (source: string) => {
    await db.doc("cmsDeploymentReceipts/cmsApi").set({ schemaVersion: 1, component: "cmsApi", state: "in_progress",
      mutation: { sourceSha: source, runId: "1", runAttempt: 1 } });
    return completeReceipt(db, { component: "cmsApi", sourceSha: source, runId: "1", runAttempt: 1,
      providerIdentities: { workerName: "fixture-api", workerVersionId: "fixture-version" } });
  };
  await complete(sourceSha);
  expect((await db.doc(`${compatibility.ROOT}/components/cmsApi`).get()).data()?.sourceSha).toBe(sourceSha);
  await expect(complete("0".repeat(40))).rejects.toThrow("CMS API Page reader source could not be verified");
  expect((await db.doc("cmsDeploymentReceipts/cmsApi").get()).data()?.state).toBe("in_progress");
});
it("keeps legacy saves available and allows removing unsupported planks without rewriting their old saved version", async () => {
  await db.doc("cmsPages/contact").update({ blocks: [ap] });
  const result = await invoke([]);
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.document.blocks).toEqual([]);
});
it.each(["deploying", "reconciling"])("keeps draft saves available during an unrelated %s deployment while publication remains fenced", async state => {
  await ready();
  const before = (await db.doc("system/publicDeployment").get()).data()!;
  const busy = { ...before, state, lastReservedGeneration: 2, newestEligibleGeneration: 2,
    newestEligibleBuildBatchId: "unrelated-content", leaseToken: "original-lease", leaseAcquiredAt: Timestamp.fromMillis(1000),
    candidateGeneration: 2, candidateBuildBatchId: "unrelated-content", candidateCommitSha: sha,
    predecessorGeneration: 1, predecessorDeploymentId: before.activeDeploymentId, predecessorCommitSha: sha,
    ...(state === "reconciling" ? { reconcilingAt: Timestamp.fromMillis(2000), cloudflareEvidenceDigest: "c".repeat(64) } : {}) };
  deployment.assertPublicDeploymentPointer(busy);
  await db.doc("system/publicDeployment").set(busy);
  const result = await invoke([ap], { title: "Editing during publication" });
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.document.title).toBe("Editing during publication");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(busy);
  const nextDocument = { version: 3, status: "published", publiclyVisible: true,
    published: snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { version: 3, title: "Contact", blocks: [ap] },
      publishedAt: instant, publishedBy: actor.uid }) };
  await expect(db.runTransaction(transaction => publication.prepareNoBuildPagePublication({ firestore: db, transaction,
    collection: "cmsPages", documentId: "contact", nextDocument, queueRef: db.collection("cmsPublishQueue").doc(), actor })))
    .rejects.toMatchObject({ code: "page_reader_contract_unavailable" });
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});
it("admits a private preview only through its own exact-source versioned reader, without dropping hidden planks", async () => {
  await db.doc("cmsPages/contact").update({ blocks: [ap] });
  const request = () => previewOwner.enqueuePreview({ actor, pageId: "contact", sourceVersion: 1 }, {
    firestore: db, now: () => Date.parse(instant), getTransport: () => "serializer", serializerReady: true, getRendererSha: () => sha });
  await expect(request()).rejects.toMatchObject({ status: 503, code: "preview-renderer-updating" });
  expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  await marker("preview");
  const accepted = await request();
  expect(accepted).toMatchObject({ status: "pending", sourceVersion: 1, rendererSha: sha });
  expect((await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()?.snapshot.blocks).toEqual([ap]);
});
it("checks unselected publication at the native owner before falling back to a serializer", async () => {
  const nextDocument = { id: "contact", version: 2, title: "Contact", status: "published", publiclyVisible: true,
    published: snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { version: 2, title: "Contact", blocks: [ap] },
      publishedAt: instant, publishedBy: actor.uid }) };
  const prepare = () => db.runTransaction(transaction => publication.prepareNoBuildPagePublication({ firestore: db, transaction,
    collection: "cmsPages", documentId: "contact", nextDocument, queueRef: db.collection("cmsPublishQueue").doc(), actor }));
  await expect(prepare()).rejects.toMatchObject({ code: "page_reader_contract_unavailable" });
  await ready();
  expect(await prepare()).toBe(null);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});
it("blocks rollback over a static/unowned published Page, including hidden planks, while permitting a compatible candidate", async () => {
  await db.doc("cmsPages/contact").update({ status: "published", publiclyVisible: true, published: { blocks: [ap] } });
  const check = (commitSha: string) => db.runTransaction(transaction => candidateOwner.assertNoBuildPageCandidateInTransaction({
    firestore: db, transaction, candidate: { commitSha } }));
  await expect(check(old)).rejects.toMatchObject({ code: "page_reader_contract_unavailable" });
  await ready();
  await expect(check(sha)).resolves.toMatchObject({ contract: null });
  await db.doc("cmsPages/contact").update({ "published.blocks": [] });
  await expect(check(old)).resolves.toMatchObject({ contract: null });
});
it.each(["missing", "releasing", "changed"])("preserves compatible candidates during a %s API receipt while refusing new content admission", async state => {
  await ready();
  await db.doc("cmsPages/contact").update({ status: "published", publiclyVisible: true, published: { blocks: [ap] } });
  const apiRef = db.doc("cmsDeploymentReceipts/cmsApi");
  if (state === "missing") await apiRef.delete();
  if (state === "releasing") await apiRef.update({ state: "in_progress" });
  if (state === "changed") await apiRef.update({ "mutation.providerIdentities.workerVersionId": "another-version" });
  const before = (await db.doc("cmsPages/contact").get()).data(), receipt = (await apiRef.get()).data();
  const check = (commitSha: string) => db.runTransaction(transaction => candidateOwner.assertNoBuildPageCandidateInTransaction({
    firestore: db, transaction, candidate: { commitSha } }));
  await expect(check(sha)).resolves.toMatchObject({ contract: null });
  await expect(check(old)).rejects.toMatchObject({ code: "page_reader_contract_unavailable" });
  expect((await invoke([ap], { title: "New content" })).code).toBe(409);
  expect((await db.doc("cmsPages/contact").get()).data()).toEqual(before);
  expect((await apiRef.get()).data()).toEqual(receipt);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
});
it("binds API support to its actual completed source descriptor and rejects future descriptors", async () => {
  await api(0);
  expect((await db.doc(`${compatibility.ROOT}/components/cmsApi`).get()).exists).toBe(false);
  await expect(api(2)).rejects.toThrow("Unsupported CMS API Page reader contract");
  expect((await db.doc("cmsDeploymentReceipts/cmsApi").get()).data()?.state).toBe("in_progress");
  await api(1);
  expect((await db.doc(`${compatibility.ROOT}/components/cmsApi`).get()).data()).toMatchObject({ sourceSha: sha, pageReaderVersion: 1 });
});

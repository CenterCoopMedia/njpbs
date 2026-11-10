import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createRequire } from "node:module";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
import homeFixture from "../../site/tests/fixtures/home-composition-v1.json";
const require = createRequire(import.meta.url);
const deployment = require("../../functions/lib/public-deployment.js");
const { publicationTarget } = require("../../functions/lib/publication-target.js");
const target = publicationTarget("production"), sha = "a".repeat(40);
let app: any, firestore: any, boundary: any, fixture: any, handlerFactory: Function;
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Only the local demo emulator may serve this production-shaped fixture");
  }
  app = initializeApp({ projectId: target.projectId }); firestore = getFirestore(app);
  boundary = await backgroundStorageFixture(target.backgroundBucket);
  handlerFactory = require("../../functions/public-content.js").createCmsGetPublicPageHandler;
});
afterAll(async () => { await fixture?.close(); await boundary?.close(); await firestore?.terminate(); await deleteApp(app); });
beforeEach(async () => {
  await fixture?.close(); fixture = null;
  boundary.objects.clear(); boundary.reads.length = 0; boundary.writes.length = 0; boundary.refuseReads(false);
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`, { method: "DELETE" });
  await firestore.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture", activeCommitSha: sha, activeDeploymentId: "fixture" });
  await firestore.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await firestore.doc("system/publicDeployment/noBuildPages/capability").set({ schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1 });
  fixture = await schedulePacketFixture({ firestore, rendererSha: sha, generation: 1, boundary, target });
});
async function decision(path: string, override?: any) {
  const errors: string[] = [];
  const handler = handlerFactory({ target: override, currentCodeRequest: fixture.request,
    log: { error: (_: any, details: any) => errors.push(details.errorMessage), warn() {} } });
  const response = { code: 0, headersSent: false, body: undefined as any, set() { return this; },
    status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
  await handler({ method: "POST", body: { mode: "no-build-page-v1", path, rendererSha: sha } }, response);
  return { ...response, errors };
}
it.each(["/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"])("binds the actual production-shaped default reader and Worker at %s", async path => {
  const result = await decision(path); expect(result.code, result.errors.join("; ")).toBe(200); expect(result.body.kind).toBe("schedule-export");
  const worker = createNoBuildPageWorker({ target, rendererSha: sha, rendererReady: true, getDecision: async () => result.body,
    fetchAsset: async () => { throw new Error("No Assets substitute"); }, render: async () => "", cache: { async match() {}, async put() {} } });
  const response = await worker.fetch(new Request(`${target.origin}${path}`));
  expect(response!.status).toBe(200); expect(response!.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
  if (path.endsWith(".pdf")) expect(Buffer.from(await response!.arrayBuffer()).equals(fixture.pdf)).toBe(true);
  expect(await worker.fetch(new Request(`https://dev-public.example.org${path}`))).toBeNull();
  expect(boundary.writes).toEqual([]);
});
it("refuses mixed project/environment and leaves the production Page feature closed without runtime capability", async () => {
  expect((await decision("/_schedule-sources.json", publicationTarget("development"))).code).toBe(503);
  expect(fixture.codeRequests()).toBe(0); expect(boundary.reads).toEqual([]);
  const worker = createNoBuildPageWorker({ target, rendererSha: sha, rendererReady: false,
    getDecision: async () => { throw new Error("Disabled capability cannot read private source"); },
    fetchAsset: async () => { throw new Error("Missing proof cannot use Assets"); }, render: async () => "",
    cache: { async match() {}, async put() {} } });
  expect(await worker.fetch(new Request(`${target.origin}/schedule/downloads/nj-pbs-schedule.pdf`))).toBeNull();
});

it.each(["ready", "paused", "starting"].flatMap(phase => ["contact", "home"].map(id => ({ phase, id }))))(
  "publishes production-shaped $id through the cloud pin with serializer disabled and primary $phase", async ({ phase, id }) => {
  const { publicPageDefinition } = require("../../functions/lib/public-page-contract.js");
  const pages = require("../../functions/lib/no-build-page-ownership.js");
  const save = require("../../functions/save.js");
  const actor = { uid: "page-editor-fixture", principal: { id: "page-editor-fixture",
    grants: [{ role: "editor", sections: ["station"] }] } };
  const batch = firestore.batch();
  batch.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "all" } }, backgroundBucket: target.backgroundBucket });
  batch.set(firestore.doc(pages.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha, servingEnabled: true, generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  batch.set(firestore.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase, commitSha: sha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: target.serializerId } });
  batch.set(firestore.doc("system/publicDeployment/controls/serializer"), { schemaVersion: 1, enabled: false });
  batch.set(firestore.doc(`cmsPages/${id}`), { ...(id === "home" ? homeFixture : {}), id,
    version: 1, title: "Published fixture", template: publicPageDefinition(id).template, status: "draft", createdBy: actor.uid,
    ...(id === "contact" ? { blocks: [] } : {}) });
  await batch.commit();
  const handler = save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => actor,
    now: () => "2026-10-12T12:00:00.000Z", enablePublishSnapshot: true,
    assertPublishReadyFn: async () => { throw new Error("The retired full-build publisher must not run."); },
    log: { info() {}, warn() {}, error() {} } });
  const response = { code: 200, headersSent: false, body: undefined as any, set() { return this; },
    status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: { collection: "cmsPages", id, baseVersion: 1, publish: true, document: {} } }, response);
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  expect(response.body.publication.transport).toBe("page-no-build-v1");
  expect((await firestore.doc("system/cmsPublicationRuntime").get()).data().phase).toBe(phase);
  expect((await firestore.doc(`${pages.PAGE_OWNER_COLLECTION}/${id}`).get()).data()).toMatchObject({ visible: true, sourceVersion: 2, runtime: { owner: "cloudflare", release: sha } });
  if (id === "contact") {
    const read = await require("../../functions/lib/no-build-page-serving.js").readNoBuildPageDecision({ firestore, path: "/contact/", rendererSha: sha });
    expect(read.kind).toBe("page"); expect(read.published.joinedRecords).toEqual([]);
    const instance = createNoBuildPageWorker({ target, rendererSha: sha, rendererReady: true, getDecision: async () => read,
      fetchAsset: async () => { throw new Error("A supported Page must use its cloud renderer."); },
      render: async () => "<!doctype html><html><body>Published fixture</body></html>", cache: { async match() {}, async put() {} } });
    expect((await instance.fetch(new Request(`${target.origin}/contact/`)))!.status).toBe(200);
  }
  expect((await firestore.doc("system/publicDeployment/noBuildRecords/programs").get()).exists).toBe(false);
});

import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import capability from "../../functions/lib/no-build-record-capability.js";
import ownership from "../../functions/lib/no-build-record-ownership.js";
import contract from "../../functions/lib/no-build-record-contract.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import publication from "../../functions/lib/public-context-publication.js";
import background from "../../functions/lib/post-background-outputs.js";
import post from "../../functions/lib/no-build-post-publication.js";
import publicContent from "../../functions/public-content.js";
import { recordDocument } from "../../site/tests/fixtures/published-records/fixtures";

const sha = "a".repeat(40), operationId = "A".repeat(20), runtime = { owner: "cloudflare", release: sha };
const app = initializeApp({ projectId: "demo-njpbs-record-serving" }, "record-serving-proof"), db = getFirestore(app);
const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
const originalEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
const objects = new Map<string, Buffer>();
let duringRead: (() => Promise<void>) | undefined;
const artifacts = { async put(key: string, bytes: Buffer) { if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
  async get(key: string) { const bytes = objects.get(key); if (duringRead) { const task = duringRead; duringRead = undefined; await task(); } return bytes ?? null; } };
const html = (path: string) => `<!doctype html><html><main>Frozen ${path}</main></html>`;
function fixture() {
  const document = recordDocument("program", "program-one");
  document.published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...document.published.metadata, version: 7 },
    publishedAt: "2026-10-10T12:00:00.000Z", publishedBy: "editor" });
  const plan = contract.validateNoBuildRecordSnapshot({ family: "programs", documentId: document.id, snapshot: document.published });
  const state = { schemaVersion: 1, family: "programs", documentId: document.id, sourceVersion: 7, operationId,
    snapshotDigest: contract.recordSnapshotDigest(document.published), canonicalPath: plan.canonicalPath, ownedPaths: plan.ownedPaths,
    visible: true, rendererSha: sha, generation: 3, runtime, contextRevision: 4, contextDigest: context.publicContextDigest(4), admissionRevision: 7 };
  return { document, state };
}
async function admit(visible = true) {
  const { document, state } = fixture(); state.visible = visible; document.publiclyVisible = visible;
  await db.doc("cmsPosts/program-one").set(document);
  await db.runTransaction(async transaction => {
    const claims = await ownership.prepareRecordRouteClaimsInTransaction({ firestore, transaction, family: "programs", documentId: "program-one", ownedPaths: state.ownedPaths });
    const work = await publication.enqueuePublicContextInTransaction({ firestore, transaction, runtime, operationId,
      recordFamily: "programs", reason: "context", contextRevision: 4 });
    claims(); work.write(); transaction.set(db.doc(`${ownership.RECORD_OWNER_COLLECTION}/program-one`), state);
  });
  return state;
}
async function prepare(revision = 4) {
  const { state } = fixture();
  const paths = ["/programs/", "/shows/", ...state.ownedPaths];
  const owner = background.createPostBackgroundOutputs({ firestore, runtime, enabled: true, postIds: [], recoveryOutputs: ["programs"],
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, firestore), artifacts,
    build: async () => ({ input: { kind: "public-background", rendererSha: sha, contextDigest: context.publicContextDigest(revision), routes: [] },
      files: paths.map(path => ({ path, bytes: Buffer.from(html(path)), contentType: "text/html; charset=utf-8" })) }) });
  await owner.recover();
}
async function request(path: string) {
  const response: any = { statusCode: 0, body: null, headers: {}, set(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; }, json(value: any) { this.body = value; return this; } };
  await publicContent.createCmsGetPublicPageHandler({ firestore, backgroundArtifacts: artifacts,
    log: { error() {}, warn() {} } })({ method: "POST", body: { mode: "no-build-post-v1", path, rendererSha: sha } }, response);
  return response;
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs-record-serving/databases/(default)/documents`, { method: "DELETE" });
  objects.clear(); duringRead = undefined;
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sha,
    activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release", newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 4 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" });
});
afterAll(async () => { await deleteApp(app); if (originalEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT;
  else process.env.CMS_DEPLOYMENT_ENVIRONMENT = originalEnvironment; });

it("returns fresh pass before record ownership exists", async () => {
  expect(await post.readNoBuildPostDecision({ firestore, path: "/programs/example/", rendererSha: sha })).toEqual({ kind: "pass" });
});
it("serves the exact prepared detail, indexes, retained aliases and shows files through the existing RPC", async () => {
  const state = await admit(); await prepare();
  for (const path of ["/programs/", "/shows/", ...state.ownedPaths]) {
    const result = await request(path);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200); expect(result.body.status).toBe(200);
    expect(Buffer.from(result.body.bytes, "base64").toString()).toBe(html(path));
  }
  const result = await request(state.canonicalPath);
  expect(result.body.headers).toMatchObject({ "x-njpbs-record-id": "program-one", "x-njpbs-record-visible": "true",
    "x-njpbs-publication-operation": operationId, "x-njpbs-source-version": "7", "x-njpbs-record-generation": "3" });
});
it("returns absence before any replacement preparation or artifact is available", async () => {
  const state = await admit(false);
  for (const path of state.ownedPaths) {
    const result = await request(path);
    expect(result.statusCode).toBe(200); expect(result.body.status).toBe(410); expect(result.body.bytes).toBe("");
    expect(result.body.headers).toMatchObject({ "x-njpbs-record-visible": "false", "x-njpbs-background-renderer-sha": sha,
      "x-njpbs-background-context-sha256": context.publicContextDigest(4) });
  }
  expect(objects.size).toBe(0);
});
it("does not label pre-withdrawal bytes as a newer republication", async () => {
  const state = await admit(); await prepare();
  const removed = { ...state, visible: false, operationId: "B".repeat(20), generation: 4,
    contextRevision: 5, contextDigest: context.publicContextDigest(5), durableWithdrawal: { schemaVersion: 1,
      recordId: state.documentId, family: state.family, operationId: "B".repeat(20), sourceVersion: 7,
      revision: 4, ownedPaths: state.ownedPaths, snapshotDigest: state.snapshotDigest, contextRevision: 5 } };
  await db.doc("cmsPosts/program-one").update({ publiclyVisible: false });
  await db.doc(`${ownership.RECORD_OWNER_COLLECTION}/program-one`).set(removed);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 5, withdrawalRevision: 1 });
  expect((await request(state.canonicalPath)).body.status).toBe(410);
  const next = fixture().document;
  next.version = 8;
  next.published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document: { ...next.published.metadata, version: 8 },
    publishedAt: "2026-10-23T12:00:00.000Z", publishedBy: "editor" });
  const operationId = "C".repeat(20);
  await db.runTransaction(async transaction => {
    const work = await publication.enqueuePublicContextInTransaction({ firestore, transaction, runtime, operationId,
      recordFamily: "programs", reason: "context", contextRevision: 6 });
    work.write(); transaction.set(db.doc("cmsPosts/program-one"), next);
    transaction.set(db.doc(`${ownership.RECORD_OWNER_COLLECTION}/program-one`), { ...removed, visible: true,
      operationId, sourceVersion: 8, generation: 5, snapshotDigest: contract.recordSnapshotDigest(next.published),
      contextRevision: 6, contextDigest: context.publicContextDigest(6) });
    transaction.update(db.doc(context.PUBLIC_CONTEXT_PATH), { revision: 6 });
  });
  const pending = await request(state.canonicalPath);
  expect(pending.statusCode).toBe(503); expect(JSON.stringify(pending.body)).not.toContain("Frozen");
  await prepare(6);
  const current = await request(state.canonicalPath);
  expect(current.statusCode).toBe(200); expect(current.body.status).toBe(200);
  expect(current.body.headers).toMatchObject({ "x-njpbs-source-version": "8", "x-njpbs-record-generation": "5",
    "x-njpbs-background-context-revision": "6" });
});
it("refuses a withdrawal that races an old artifact read", async () => {
  const state = await admit(); await prepare();
  duringRead = async () => {
    await db.doc("cmsPosts/program-one").update({ publiclyVisible: false });
    await db.doc(`${ownership.RECORD_OWNER_COLLECTION}/program-one`).update({ visible: false });
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 5, withdrawalRevision: 1 });
  };
  const result = await request(state.canonicalPath);
  expect(result.statusCode).toBe(503); expect(JSON.stringify(result.body)).not.toContain("Frozen");
});
it("refuses corrupt ownership and immutable snapshots instead of selecting static Assets", async () => {
  const state = await admit(); await prepare();
  await db.doc("cmsPosts/program-one").update({ "published.metadata.title": "Changed immutable title" });
  const result = await request(state.canonicalPath);
  expect(result.statusCode).toBe(503); expect(JSON.stringify(result.body)).not.toContain("Changed immutable title");
});


it("seals the complete record terminal and preserves all owned routes on release", async () => {
  const state = await admit(false);
  const contract = { schemaVersion: 1, rendererSha: sha, authoritative: true, enabled: true, families: ["programs", "events"] };
  const candidate = { commitSha: sha, generation: 4, noBuildRecord: contract };
  await db.runTransaction(async transaction => {
    const accepted = await capability.assertRecordCandidateInTransaction({ firestore, transaction, candidate });
    capability.writeRecordCandidateActivation(transaction, firestore, accepted, candidate);
  });
  const accepted = await capability.readRecordCapability({ firestore });
  expect(accepted).toMatchObject({ rendererSha: sha, generation: 4, servingEnabled: true, families: ["programs", "events"] });
  expect(accepted.terminalOwner).toEqual({ schemaVersion: 1, transport: "public-context-no-build-v1", rendererSha: sha });
  await expect(db.runTransaction(transaction => capability.assertRecordCandidateInTransaction({ firestore, transaction,
    candidate: { commitSha: sha, generation: 4 } }))).rejects.toThrow("preserve registered record families");
  await ownership.recordRouteRef(db, state.ownedPaths[0]).delete();
  await expect(db.runTransaction(transaction => capability.assertRecordCandidateInTransaction({ firestore, transaction, candidate }))).rejects.toThrow();
});
it("rejects incomplete and mixed-source record capabilities", async () => {
  const contract = { schemaVersion: 1, rendererSha: sha, authoritative: true, enabled: true, families: ["programs", "events"] };
  expect(capability.candidateNoBuildRecordContract(contract)).toEqual(contract);
  for (const patch of [{ families: ["events", "programs"] }, { families: ["programs", "programs"] }, { families: ["sponsors"] },
    { authoritative: false }, { rendererSha: "invalid" }, { extra: true }]) {
    expect(() => capability.candidateNoBuildRecordContract({ ...contract, ...patch })).toThrow();
  }
  await expect(db.runTransaction(transaction => capability.assertRecordCandidateInTransaction({ firestore, transaction,
    candidate: { commitSha: "c".repeat(40), generation: 4, noBuildRecord: contract } }))).rejects.toThrow("does not match");
});


it("returns namespace 404 for non-mintable slugs without a claim lookup error", async () => {
  await admit(); await prepare();
  for (const path of ["/programs/Foo_Bar/", "/programs/2024.10/", "/shows/x.html/"]) {
    const result = await request(path);
    expect(result.statusCode).toBe(200); expect(result.body.kind).toBe("background"); expect(result.body.status).toBe(404);
  }
});

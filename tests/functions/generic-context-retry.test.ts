import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { createNoBuildPreparationStorage, backgroundOutputFiles } from "../../site/scripts/no-build-preparation-storage";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import retry from "../../functions/lib/generic-context-retry.js";
import publication from "../../functions/lib/public-context-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import deployment from "../../functions/lib/public-deployment.js";
import background from "../../functions/lib/post-background-outputs.js";
import storage from "../../functions/lib/post-background-storage.js";
import publish from "../../functions/publish.js";
import listContent from "../../functions/list-content.js";

const db = isolatedFirestore("generic-context-retry.test.ts");
const operationId = "G".repeat(20), sha = "a".repeat(40), digest = context.publicContextDigest(1);
const runtime = { owner: "cloudflare", release: sha };
const actor = { uid: "site-owner", principal: { id: "site-owner", grants: [{ role: "admin" }] } };
const paths = { listings: ["/posts/"], authors: ["/authors/example/"], feed: ["/feeds/news.xml"],
  contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
const queueRef = () => db.doc(`cmsPublishQueue/${operationId}`);
const prepRef = () => queueRef().collection("backgroundPreparation").doc(digest);
let app, boundary, directory;
beforeAll(async () => {
  app = firebaseAdminRuntime.initializeApp({ projectId: db.projectId }, "generic-retry-storage");
  boundary = await backgroundStorageFixture("generic-retry-fixture");
  directory = await mkdtemp(path.join(tmpdir(), "generic-retry-"));
});
afterAll(async () => {
  await boundary.close(); await firebaseAdminRuntime.deleteApp(app);
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  boundary.objects.clear();
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeCommitSha: sha, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" });
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ firestore: db, transaction, operationId, runtime,
      reason: "context", contextRevision: 1 });
    accepted.write();
  });
  await prepRef().set({ schemaVersion: 1, runtime, contextDigest: digest, status: "failed", attempts: 4, nextAttemptAt: null,
    claim: null, inputDigest: "b".repeat(64), frozenContext: { revision: 1, withdrawalRevision: 0, homeRevision: 0 },
    reservation: { cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1700000000000), commitSha: sha, generation: 2, buildBatchId: "original-cutoff" } });
  const batch = db.batch();
  batch.update(queueRef(), { status: "failed" });
  for (const output of publication.OUTPUTS) {
    batch.update(queueRef().collection("backgroundOutputs").doc(output), { status: "failed", attempts: 4, nextAttemptAt: null });
    batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: "failed" });
  }
  await batch.commit();
});
async function invoke(body, user = actor) {
  const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
  await publish.createCmsPublishHandler({ firestore: db, requirePrincipalFn: async () => user, log: { error() {} } })(
    { method: "POST", headers: {}, body }, response);
  return response;
}
const request = () => ({ retry: true, aggregateRetryQueueId: operationId });
const snapshot = async () => (await db.collection("cmsPublishQueue").get()).docs.map(row => row.data());

it("discovers only the current failed generic operation with at most two document reads", async () => {
  const doc = vi.fn(key => db.doc(key));
  expect(await retry.genericContextRetry({ doc })).toMatchObject({ queueId: operationId, createdAt: expect.any(String) });
  expect(doc.mock.calls.map(([key]) => key)).toEqual([publication.CURRENT_PATH, `cmsPublishQueue/${operationId}`]);
  await queueRef().update({ settingsPublication: { id: "siteNavigation" } });
  expect(await retry.genericContextRetry(db)).toBeNull();
});

it("retries the same frozen operation once, retains the cutoff/checkpoint, and audits without a queue chain", async () => {
  const frozen = (await prepRef().get()).data();
  expect(await invoke(request())).toMatchObject({ code: 200, body: { success: true, queueId: operationId, status: "pending" } });
  const after = (await prepRef().get()).data();
  expect(after).toEqual({ ...frozen, attempts: 0, claim: null, nextAttemptAt: expect.any(Number), error: null });
  expect((await queueRef().get()).data().triggeredAt).toEqual((await queueRef().get()).data().createdAt);
  expect(await invoke(request())).toMatchObject({ code: 200, body: { queueId: operationId } });
  expect((await prepRef().get()).data()).toEqual(after);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.collection("admin_logs").get()).docs.map(row => row.data())).toMatchObject([
    { actorUid: actor.uid, action: "cms.siteUpdateRetried", target: operationId,
      after: { contextDigest: digest, preparationOperationId: operationId } },
  ]);
  expect(await retry.genericContextRetry(db)).toBeNull();
});

it.each(["writer", "editor", "publisher"])("refuses an ordinary %s without changing accepted work", async role => {
  const before = await snapshot();
  expect(await invoke(request(), { uid: role, principal: { id: role, grants: [{ role }] } })).toMatchObject({ code: 403 });
  expect(await snapshot()).toEqual(before);
});

it.each(["context", "source", "owner", "pause", "billing", "preparation claim", "task claim", "uncertain claim", "settings"])(
  "refuses %s changes before writes", async mode => {
    if (mode === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
    if (mode === "source") await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
    if (mode === "owner") await db.doc(publication.CURRENT_PATH).update({ runtime: { owner: "node-compute", release: sha } });
    if (mode === "pause") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
    if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
    if (mode === "preparation claim") await prepRef().update({ status: "building", claim: "foreign", nextAttemptAt: Date.now() + 60000 });
    if (["task claim", "uncertain claim"].includes(mode)) await queueRef().collection("backgroundOutputs").doc("listings").update({
      status: "building", claim: "foreign", nextAttemptAt: mode === "task claim" ? Date.now() + 60000 : null });
    if (mode === "settings") await queueRef().update({ settingsPublication: { id: "siteNavigation" } });
    const before = await snapshot(), prep = (await prepRef().get()).data();
    // Runtime-control refusals retain CmsPublicationRuntimeControlError's 503.
    expect((await invoke(request())).code).toBe(mode === "pause" ? 503 : 409);
    expect(await snapshot()).toEqual(before);
    expect((await prepRef().get()).data()).toEqual(prep);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

it("returns an actionable conflict when the core refuses changed family ownership", async () => {
  await db.doc("cmsBackgroundOutputs/listings").update({ contextOnly: false });
  const before = await snapshot(), prep = (await prepRef().get()).data();
  expect(await invoke(request())).toMatchObject({ code: 409,
    body: { error: "This site update changed. Refresh Publish activity before retrying." } });
  expect(await snapshot()).toEqual(before);
  expect((await prepRef().get()).data()).toEqual(prep);
  expect((await db.collection("admin_logs").get()).empty).toBe(true);
});

it("rejects mixed or malformed retry requests", async () => {
  for (const body of [{ ...request(), changes: [{ collection: "cmsPosts", id: "post", sourceVersion: 1 }] },
    { ...request(), runtimeFirst: true }, { ...request(), retry: false }, { ...request(), aggregateRetryQueueId: "bad/id" }]) {
    expect((await invoke(body)).code).toBe(400);
  }
  expect((await queueRef().get()).data().status).toBe("failed");
});

it("releases only an expired task claim while retaining the accepted operation", async () => {
  const task = queueRef().collection("backgroundOutputs").doc("listings");
  await task.update({ status: "building", claim: "expired", nextAttemptAt: Date.now() - 1 });
  expect((await invoke(request())).code).toBe(200);
  expect((await task.get()).data()).toMatchObject({ status: "pending", claim: null, attempts: 0, runtime });
});

it("refuses the operator-only fresh preparation successor when complete bytes have no verified preparation", async () => {
  const batch = db.batch();
  for (const output of publication.OUTPUTS) batch.update(db.doc(`cmsBackgroundOutputs/${output}`), {
    status: "verified", receipt: { revision: 1, rendererSha: sha, contextDigest: digest } });
  await batch.commit();
  expect(await invoke(request())).toMatchObject({ code: 409, body: { error: "This site update needs an administrator's preparation repair." } });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await queueRef().get()).data().status).toBe("failed");
});

it("cold-restores the original verified checkpoint and confirms the exact six families without a new build", async () => {
  const retained = path.join(directory, "sealed");
  await mkdir(retained, { recursive: true, mode: 0o700 });
  const records = [];
  for (const [output, routes] of Object.entries(paths)) for (const publicPath of routes) {
    const bytes = Buffer.from(`Original frozen ${output}`), file = `${output}-${routes.indexOf(publicPath)}.txt`;
    await mkdir(path.join(retained, "files"), { recursive: true });
    await writeFile(path.join(retained, "files", file), bytes);
    records.push({ path: publicPath, file, outputs: [output], contentType: "text/plain", size: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify({ schemaVersion: 2, contextDigest: digest, routes: [], files: records }));
  await writeFile(path.join(retained, "artifact-inventory.json"), "{}");
  await writeFile(path.join(retained, "public-context.json"), "{}");
  const store = createNoBuildPreparationStorage("generic-retry-fixture", app, { operationId, contextDigest: digest,
    commitSha: sha, owner: "cloudflare", cutoffMillis: 1700000000000, admissionRevision: null });
  const preparedDigest = await store.checkpoint("prepared", retained, [...backgroundOutputFiles, ...records.map(file => `files/${file.file}`)]);
  await prepRef().update({ status: "verified", attempts: 1, preparedDigest, backgroundBucket: "generic-retry-fixture", admissionRevision: null });
  const frozen = (await prepRef().get()).data();
  await rm(retained, { recursive: true });
  expect((await invoke(request())).code).toBe(200);
  const build = vi.fn(async () => { throw new Error("Cold retry must restore the sealed preparation"); });
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, runtime, commitSha: sha,
    stateDirectory: path.join(directory, "empty-cache"), distDirectory: path.join(directory, "unused"), buildEnvironment: {},
    backgroundBucket: "generic-retry-fixture", buildPublication: build })();
  expect(build).not.toHaveBeenCalled();
  expect((await prepRef().get()).data()).toEqual(frozen);
  for (const output of publication.OUTPUTS) {
    expect((await queueRef().collection("backgroundOutputs").doc(output).get()).data(), output)
      .toMatchObject({ status: "verified" });
  }
  const queue = (await queueRef().get()).data();
  expect(queue).toMatchObject({ status: "success", aggregateReceipt: { runtime, contextRevision: 1, contextDigest: digest } });
  expect(Object.keys(queue.aggregateReceipt.outputs)).toEqual(publication.OUTPUTS);
  const reader = background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime,
    artifacts: storage.createPostBackgroundStorage("generic-retry-fixture", app),
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db) });
  for (const [output, routes] of Object.entries(paths)) for (const publicPath of routes) {
    const response = await reader.serve(new Request(`https://example.test${publicPath}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`Original frozen ${output}`);
  }
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  const summary = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await listContent.createCmsListContentHandler({ firestore: db, requirePrincipalFn: async () => actor })(
    { method: "POST", body: { view: "publish_activity", includePostProofRecovery: true } }, summary);
  expect(summary.body.contextRetry).toBeNull();
});

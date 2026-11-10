import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Agent, get } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "../../functions/lib/firebase.js";
import context from "../../functions/lib/public-context-revision.js";
import publication from "../../functions/lib/public-context-publication.js";
import background from "../../functions/lib/post-background-outputs.js";
import manifests from "../../functions/lib/post-background-record-manifest.js";
import publicContent from "../../functions/public-content.js";
import deployment from "../../functions/lib/public-deployment.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import targets from "../../functions/lib/publication-target.js";
import postPublication from "../../functions/lib/no-build-post-publication.js";
import work from "../../functions/lib/no-build-cloud-work.js";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { createNoBuildPreparationStorage, backgroundOutputFiles } from "../../site/scripts/no-build-preparation-storage";
import { backgroundStorageFixture } from "./background-storage-fixture";

const runtime = { owner: "cloudflare" as const, release: "a".repeat(40) };
const operationId = "A".repeat(20);
const contextDigest = "6d0fea235ddd2bea4b171dc6ff77ba0f9e9abf2e23e687edb39d49a8847bfffc";
const paths = { listings: ["/posts/"], authors: ["/authors/public-author/"], feed: ["/feeds/news.xml"],
  contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"],
  search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
let directory: string;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use a local demo Firestore emulator");
  }
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "context-publication-")));
  boundary = await backgroundStorageFixture("fixture-bucket");
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT }, "context-publication");
});
afterAll(async () => {
  await boundary?.close();
  if (app) await firebaseAdminRuntime.deleteApp(app);
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await Promise.all(["cmsPublishQueue", "cmsBackgroundOutputs", "cmsPosts"].map(name => db.recursiveDelete(db.collection(name))));
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await db.doc("system/noBuildPostAdmission").delete();
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: runtime.release,
    activeGeneration: 1, activeDeploymentId: "fixture-deployment" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: runtime.release,
    serializerId: "cloudflare-publisher" });
  boundary.objects.clear();
  boundary.onRead(null);
});
async function enqueue(id = operationId, options = {}) {
  return db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId: id, runtime, reason: "settings", contextRevision: 1, ...options });
    accepted.write();
    return { ...accepted, write: undefined };
  });
}
async function verifiedInput(id: string) {
  await db.doc(`cmsPublishQueue/${id}/backgroundPreparation/${contextDigest}`).set({ schemaVersion: 1, runtime,
    contextDigest, status: "verified", preparedDigest: "e".repeat(64), admissionRevision: null,
    reservation: { commitSha: runtime.release, buildBatchId: "fixture-original", generation: 2,
      cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1700000000000) } });
}
async function readWork(now = Date.now()) {
  return work.readNoBuildCloudWork({ runtime, now, read: async document => (await db.doc(document).get()).data() ?? null });
}
function reader() {
  return background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime,
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: { get: key => readFile(path.join(directory, key)), async put(key, bytes) {
      await mkdir(path.dirname(path.join(directory, key)), { recursive: true });
      await writeFile(path.join(directory, key), bytes);
    } },
    build: async task => ({ input: { kind: "public-background", rendererSha: runtime.release, contextDigest, routes: [] },
      assets: [], files: paths[task.output].map(publicPath => ({ path: publicPath, bytes: `Exact context: ${contextDigest}`,
        contentType: "text/plain" })) }),
  });
}

it("atomically accepts six families without any Post owner or admission, deduplicates, and rejects identity reuse", async () => {
  const accepted = await enqueue();
  expect(accepted).toMatchObject({ queueId: operationId, contextRevision: 1, contextDigest,
    outputs: ["listings", "authors", "feed", "contentApi", "sitemap", "search"] });
  const queue = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  await enqueue();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toEqual(queue);
  expect((await db.doc("cmsBackgroundOutputs/home").get()).exists).toBe(false);
  expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  expect(await readWork()).toEqual({ maintenance: true, reconcile: false });
  await expect(enqueue(operationId, { reason: "context" })).rejects.toThrow("refused");
  await expect(enqueue("B".repeat(20), { runtime: { owner: "node-compute", release: runtime.release } })).rejects.toThrow("refused");
  await expect(db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId: "C".repeat(20), runtime, reason: "context", contextRevision: 1 });
    accepted.write();
    throw new Error("abort settings write");
  })).rejects.toThrow("abort");
  expect((await db.doc(`cmsPublishQueue/${"C".repeat(20)}`).get()).exists).toBe(false);
});

async function retainedOfficeNamespaces() {
  const id = "O".repeat(20), office = { owner: "node-compute", release: runtime.release };
  const rows = [];
  await db.doc(`cmsPublishQueue/${id}`).set({ schemaVersion: 1, transport: "post-no-build-v1", runtime: office,
    backgroundRuntime: office, status: "pending", noBuildPost: { postId: "retained-post", operationId: id } });
  await db.doc("system/publicDeployment/noBuildPostOwners/retained-post").set({ schemaVersion: 1, runtime: office,
    postId: "retained-post", operationId: id, mode: "dynamic", rendererSha: runtime.release, sourceVersion: 1,
    generation: 1, visible: true, servingEnabled: true, slug: "retained-post", ownedSlugs: ["retained-post"] });
  for (const output of publication.OUTPUTS) {
    const taskPath = `cmsPublishQueue/${id}/backgroundOutputs/${output}`;
    const receipt = { runtime: office, revision: 1, rendererSha: runtime.release, contextDigest,
      verifiedAt: Date.now(), digest: "d".repeat(64), routeSetDigest: "e".repeat(64), manifest: [], assets: [] };
    await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", runtime: office,
      postId: "retained-post", output, revision: 2, status: "building", attempts: 2, claim: "retained-claim", nextAttemptAt: 1234 });
    await db.doc(`cmsBackgroundOutputs/${output}`).set({ schemaVersion: 1, owner: "post-background-v1", runtime: office,
      output, revision: 2, postId: "retained-post", taskPath, after: background.dependency(null), contextDigest,
      status: "pending", receipt: null, lastGood: { receipt, after: background.dependency(null) }, pendingSince: 1000 });
    rows.push({ output, taskPath, task: (await db.doc(taskPath).get()).data(), state: (await db.doc(`cmsBackgroundOutputs/${output}`).get()).data() });
  }
  return { id, rows, queue: (await db.doc(`cmsPublishQueue/${id}`).get()).data(),
    owner: (await db.doc("system/publicDeployment/noBuildPostOwners/retained-post").get()).data() };
}

it("hands off all six selected pointers while preserving retained OFJ queue, task, owner and last-good provenance", async () => {
  const old = await retainedOfficeNamespaces();
  await enqueue();
  expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({
    finalNamespaceOwner: true, namespaceOperationId: operationId, preparationOperationId: operationId });
  expect((await db.doc(`cmsPublishQueue/${old.id}`).get()).data()).toEqual(old.queue);
  expect((await db.doc("system/publicDeployment/noBuildPostOwners/retained-post").get()).data()).toEqual(old.owner);
  const priorOwner = background.createPostBackgroundOutputs({ firestore: db, enabled: true, accepting: false,
    runtime: { owner: "node-compute", release: runtime.release }, contentApiEnabled: true,
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
    build: () => { throw new Error("The old owner must not compile the new selection"); },
    artifacts: { put: () => { throw new Error("The old owner must not write artifacts"); }, get: () => { throw new Error("The old owner must not read artifacts"); } } });
  await priorOwner.recover();
  for (const row of old.rows) {
    expect((await db.doc(row.taskPath).get()).data()).toEqual(row.task);
    expect((await db.doc(`cmsBackgroundOutputs/${row.output}`).get()).data()).toMatchObject({ runtime,
      contextOnly: true, revision: 3, taskPath: `cmsPublishQueue/${operationId}/backgroundOutputs/${row.output}`,
      lastGood: row.state.lastGood, pendingSince: 1000 });
  }
});

it("concurrent final-owner handoffs select one complete cohort and keep the original OFJ tasks", async () => {
  const old = await retainedOfficeNamespaces();
  await Promise.all([enqueue(), enqueue("B".repeat(20))]);
  const current = (await db.doc(publication.CURRENT_PATH).get()).data();
  expect(current.finalNamespaceOwner).toBe(true);
  expect(current.namespaceOperationId).toBe(current.operationId);
  expect(new Set(current.operationIds)).toEqual(new Set([operationId, "B".repeat(20)]));
  for (const row of old.rows) {
    expect((await db.doc(row.taskPath).get()).data()).toEqual(row.task);
    expect((await db.doc(`cmsBackgroundOutputs/${row.output}`).get()).data()).toMatchObject({ runtime,
      taskPath: `cmsPublishQueue/${current.operationId}/backgroundOutputs/${row.output}`, contextOnly: true, revision: 4 });
  }
});

it("an aborted final-owner handoff leaves every selected predecessor unchanged", async () => {
  const old = await retainedOfficeNamespaces();
  await expect(db.runTransaction(async transaction => {
    (await publication.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId, runtime, reason: "context", contextRevision: 1 })).write();
    throw new Error("abort namespace handoff");
  })).rejects.toThrow("abort namespace handoff");
  expect((await db.doc(publication.CURRENT_PATH).get()).exists).toBe(false);
  for (const row of old.rows) expect((await db.doc(`cmsBackgroundOutputs/${row.output}`).get()).data()).toEqual(row.state);
});

it("changed and unchanged retained Posts cannot create a parallel selected-six replacement after final ownership", async () => {
  await enqueue();
  const before = await Promise.all(publication.OUTPUTS.map(async output => (await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()));
  const post = { version: 1, publiclyVisible: true, published: { sourceVersion: 1,
    metadata: { type: "post", slug: "retained-post", previousSlugs: [], title: "Published story" }, blocks: [] } };
  await db.doc("cmsPosts/retained-post").set(post);
  const owner = background.createPostBackgroundOutputs({ firestore: db, enabled: true, accepting: true, postIds: ["retained-post"],
    runtime, contentApiEnabled: true, readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db) });
  for (const [index, next] of [post, { ...post, version: 2, published: { ...post.published, sourceVersion: 2 } }].entries()) {
    const queueId = String(index).repeat(20);
    await db.runTransaction(async transaction => (await owner.prepareInTransaction({ transaction, queueId,
      postId: "retained-post", nextDocument: next, homePlacementPaths: [] }))());
    for (const output of publication.OUTPUTS) expect((await db.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/${output}`).get()).exists).toBe(false);
  }
  expect(await Promise.all(publication.OUTPUTS.map(async output => (await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()))).toEqual(before);
});

it("a paused legacy accepted aggregate can settle exhaustion without admitting a new final-owner operation", async () => {
  await enqueue();
  await db.doc(publication.CURRENT_PATH).update({ finalNamespaceOwner: firebaseAdminRuntime.FieldValue.delete(),
    namespaceOperationId: firebaseAdminRuntime.FieldValue.delete() });
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ schemaVersion: 1, runtime, contextDigest,
    status: "failed", attempts: 4, nextAttemptAt: null, reservation: { commitSha: runtime.release, cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1000) } });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  await noBuildPostMaintenance({ firestore: db, commitSha: runtime.release, runtime, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket", serializerId: "cloudflare-publisher" })();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "failed", error: "background_preparation_failed" });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).data().attempts).toBe(4);
});

it.each([[2, "ready"], [2, "paused"], [4, "ready"], [4, "paused"]])(
  "adopts an existing cloud namespace owner without resetting its %i-attempt budget while %s", async (attempts, phase) => {
    await enqueue();
    const preparation = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
    await preparation.set({ schemaVersion: 1, runtime, contextDigest, status: "failed", attempts,
      nextAttemptAt: attempts === 4 ? null : Date.now() + 600_000, inputDigest: "b".repeat(64),
      reservation: { commitSha: runtime.release, cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1000) } });
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed" });
    await db.doc(publication.CURRENT_PATH).update({ finalNamespaceOwner: firebaseAdminRuntime.FieldValue.delete(),
      namespaceOperationId: firebaseAdminRuntime.FieldValue.delete() });
    await db.doc("system/cmsPublicationRuntime").update({ phase });
    const before = await preparation.get(), accepted = (await db.doc(publication.CURRENT_PATH).get()).data();
    const states = await db.getAll(...publication.OUTPUTS.map(output => db.doc(`cmsBackgroundOutputs/${output}`)));
    const tasks = await db.getAll(...publication.OUTPUTS.map(output => db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/${output}`)));
    await noBuildPostMaintenance({ firestore: db, commitSha: runtime.release, runtime, stateDirectory: directory,
      distDirectory: path.join(directory, "dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket", serializerId: "cloudflare-publisher" })();
    expect((await db.doc(publication.CURRENT_PATH).get()).data()).toEqual({ ...accepted, finalNamespaceOwner: true, namespaceOperationId: operationId });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await preparation.get()).data()).toEqual(before.data());
    expect((await preparation.get()).updateTime).toEqual(before.updateTime);
    for (const old of [...states, ...tasks]) {
      const current = await old.ref.get(); expect(current.data()).toEqual(old.data()); expect(current.updateTime).toEqual(old.updateTime);
    }
    expect((await readWork()).maintenance).toBe(false);
  });

it.each(["missing preparation", "foreign preparation", "partial tasks", "foreign task context"])(
  "refuses legacy marker adoption with %s without creating another budget", async mode => {
    await enqueue(); await verifiedInput(operationId);
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed" });
    await db.doc(publication.CURRENT_PATH).update({ finalNamespaceOwner: firebaseAdminRuntime.FieldValue.delete(),
      namespaceOperationId: firebaseAdminRuntime.FieldValue.delete() });
    const preparation = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
    if (mode === "missing preparation") await preparation.delete();
    if (mode === "foreign preparation") await preparation.update({ runtime: { owner: "node-compute", release: runtime.release } });
    if (mode === "partial tasks") await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).delete();
    if (mode === "foreign task context") await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ contextDigest: "f".repeat(64) });
    const before = (await db.doc(publication.CURRENT_PATH).get()).data();
    await expect(noBuildPostMaintenance({ firestore: db, commitSha: runtime.release, runtime, stateDirectory: directory,
      distDirectory: path.join(directory, "dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket", serializerId: "cloudflare-publisher" })())
      .rejects.toThrow("Legacy aggregate namespace ownership refused");
    expect((await db.doc(publication.CURRENT_PATH).get()).data()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

it("serves verified exact bytes and settles only the six named outputs, preserving settings identity", async () => {
  await enqueue();
  await db.doc(`cmsPublishQueue/${operationId}`).update({ settingsPublication: { id: "siteNavigation", sourceVersion: 2 } });
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  const worker = reader();
  await worker.recover();
  for (const family of publication.OUTPUTS) for (const publicPath of paths[family]) {
    const response = await worker.serve(new Request(`https://example.test${publicPath}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-njpbs-background-context-sha256")).toBe(contextDigest);
  }
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(true);
  const queue = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  expect(queue).toMatchObject({ status: "success", settingsPublication: { id: "siteNavigation", sourceVersion: 2 },
    aggregateReceipt: { runtime, contextRevision: 1, contextDigest } });
  expect(Object.keys(queue.aggregateReceipt.outputs)).toEqual(publication.OUTPUTS);
  expect(queue.consumerReceipts).toBeUndefined();
  expect(await readWork()).toEqual({ maintenance: false, reconcile: false, previewContext: true });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect(await readWork()).toEqual({ maintenance: true, reconcile: false });
});

it("keeps preparation backoff and exhaustion asleep and retries under the original immutable reservation", async () => {
  await enqueue();
  const preparation = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  const reservation = { cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1700000000000) };
  await preparation.set({ runtime, status: "failed", attempts: 4, nextAttemptAt: null, reservation, inputDigest: "b".repeat(64) });
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed" });
  expect((await readWork()).maintenance).toBe(false);
  await db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime });
    write();
  });
  expect((await preparation.get()).data()).toMatchObject({ attempts: 0, reservation, inputDigest: "b".repeat(64) });
  expect((await readWork()).maintenance).toBe(true);
  await preparation.update({ nextAttemptAt: Date.now() + 600_000 });
  expect((await readWork()).maintenance).toBe(false);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await expect(db.runTransaction(transaction => publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime }))).rejects.toThrow("refused");
});

it("does not starve retained Post Home maintenance while context preparation is in backoff", async () => {
  await enqueue();
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ runtime,
    status: "failed", attempts: 1, nextAttemptAt: Date.now() + 600_000 });
  const postOperation = "D".repeat(20);
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: false,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await db.doc("system/publicDeployment/noBuildPosts/current").set({ schemaVersion: 1, runtime,
    mode: "dynamic", servingEnabled: true, postId: "retained-post", operationId: postOperation,
    rendererSha: runtime.release, generation: 1, visible: true, sourceVersion: 1,
    slug: "retained-post", ownedSlugs: ["retained-post"] });
  await db.doc(`cmsPublishQueue/${postOperation}`).set({ transport: "post-no-build-v1", backgroundRuntime: runtime,
    noBuildPost: { postId: "retained-post", operationId: postOperation, sourceVersion: 1 } });
  const taskPath = `cmsPublishQueue/${postOperation}/backgroundOutputs/home`;
  await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", runtime,
    postId: "retained-post", output: "home", revision: 1, status: "pending", attempts: 0, nextAttemptAt: 0 });
  await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", runtime,
    postId: "retained-post", taskPath, status: "pending", contextDigest });
  await noBuildPostMaintenance({ firestore: db, commitSha: runtime.release, runtime,
    stateDirectory: directory, distDirectory: path.join(directory, "dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  expect((await db.doc(`cmsPublishQueue/${postOperation}/backgroundPreparation/${contextDigest}`).get()).data()).toMatchObject({
    runtime, status: "failed", attempts: 1, error: "background_preparation_failed",
  });
  expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).data().attempts).toBe(1);
});

it("marks exhausted exact-context family work failed without claiming a successful receipt", async () => {
  await enqueue();
  const task = db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`);
  await task.update({ status: "failed", attempts: 4, nextAttemptAt: null });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "failed" });
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({
    status: "failed", error: "background_generation_failed", aggregateReceipt: null,
  });
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "pending" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().status).toBe("pending");
});

it("shares exact completion across same-context settings operations and prunes settled aliases", async () => {
  const second = "B".repeat(20);
  await enqueue();
  await enqueue(second);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().status).toBe("pending");
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId: second, runtime });
  for (const id of [operationId, second]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data()).toMatchObject({
    status: "success", aggregateReceipt: { contextRevision: 1, contextDigest, preparationOperationId: second },
  });
  expect((await db.doc(publication.CURRENT_PATH).get()).data().operationIds).toEqual([second]);
  const before = (await db.doc("cmsBackgroundOutputs/search").get()).data();
  await verifiedInput(second);
  await enqueue("C".repeat(20));
  expect((await db.doc("cmsBackgroundOutputs/search").get()).data()).toEqual(before);
  await publication.settlePublicContext({ firestore: db, operationId: "C".repeat(20), runtime });
  expect((await db.doc(`cmsPublishQueue/${"C".repeat(20)}`).get()).data()).toMatchObject({ status: "success",
    aggregateReceipt: { preparationOperationId: second } });
  expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({ operationId: "C".repeat(20), preparationOperationId: second });
});

it("accepts another operation after 100 settled same-context aliases without growing history", async () => {
  await enqueue();
  await reader().recover();
  await verifiedInput(operationId);
  const prototype = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  const ids = Array.from({ length: 100 }, (_, index) => String(index).padStart(20, "0"));
  const batch = db.batch();
  for (const id of ids) batch.set(db.doc(`cmsPublishQueue/${id}`), { ...prototype, status: "success" });
  batch.update(db.doc(publication.CURRENT_PATH), { operationIds: ids });
  await batch.commit();
  await enqueue("Z".repeat(20));
  expect((await db.doc(publication.CURRENT_PATH).get()).data().operationIds).toEqual(["Z".repeat(20)]);
  expect(await publication.settlePublicContext({ firestore: db, operationId: "Z".repeat(20), runtime })).toBe(true);
});

it.each(["pending", "failed"])("cancels a %s cloud aggregate predecessor when a new release takes the context", async status => {
  await enqueue();
  const successfulId = "B".repeat(20);
  await enqueue(successfulId);
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status });
  await db.doc(`cmsPublishQueue/${successfulId}`).update({ status: "success" });
  const nextRuntime = { owner: "cloudflare", release: "c".repeat(40) };
  await db.doc("system/publicDeployment").update({ activeCommitSha: nextRuntime.release });
  await enqueue("C".repeat(20), { runtime: nextRuntime });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "cancelled",
    error: "public_context_superseded", runtime });
  expect((await db.doc(`cmsPublishQueue/${successfulId}`).get()).data()).toMatchObject({ status: "success", runtime });
  expect((await db.doc(`cmsPublishQueue/${"C".repeat(20)}`).get()).data()).toMatchObject({ status: "pending", runtime: nextRuntime });
});
it("preserves the unfinished aggregate predecessor of a foreign owner", async () => {
  await enqueue();
  const foreign = { owner: "node-compute", release: runtime.release };
  await db.doc(`cmsPublishQueue/${operationId}`).update({ runtime: foreign, backgroundRuntime: foreign });
  await db.doc(publication.CURRENT_PATH).update({ runtime: foreign });
  const before = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  await enqueue("C".repeat(20));
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toEqual(before);
});

it("cancels every unfinished same-context sibling when public context advances", async () => {
  await enqueue();
  await enqueue("B".repeat(20));
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await enqueue("C".repeat(20), { contextRevision: 2 });
  for (const id of [operationId, "B".repeat(20)]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().status).toBe("cancelled");
});

it.each(["preparation", "family"])("exposes shared %s exhaustion and resumes it through the original alias", async stage => {
  await enqueue();
  const second = "B".repeat(20);
  await enqueue(second);
  const preparation = db.doc(`cmsPublishQueue/${second}/backgroundPreparation/${contextDigest}`);
  const reservation = { cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1700000000000) };
  if (stage === "preparation") {
    await preparation.set({ runtime, status: "failed", attempts: 4, nextAttemptAt: null, reservation, inputDigest: "b".repeat(64) });
    await publication.failPublicContextPreparation({ firestore: db, operationId: second, runtime });
  } else {
    await db.doc(`cmsPublishQueue/${second}/backgroundOutputs/search`).update({ status: "failed", attempts: 4, nextAttemptAt: null });
    await publication.settlePublicContext({ firestore: db, operationId: second, runtime });
  }
  for (const id of [operationId, second]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().status).toBe("failed");
  await db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime });
    write();
  });
  for (const id of [operationId, second]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().status).toBe("pending");
  expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).exists).toBe(false);
  if (stage === "preparation") expect((await preparation.get()).data()).toMatchObject({ attempts: 0, reservation, inputDigest: "b".repeat(64) });
  else expect((await db.doc(`cmsPublishQueue/${second}/backgroundOutputs/search`).get()).data()).toMatchObject({ attempts: 0, status: "pending" });
});

it("recovers a cloud-verified complete preparation onto empty disk with no Post owner, historical read or compiler", async () => {
  await enqueue();
  const retained = path.join(directory, "retained");
  await mkdir(retained, { recursive: true, mode: 0o700 });
  const records = [];
  for (const output of publication.OUTPUTS) for (const publicPath of paths[output]) {
    const file = `${output}/${publicPath.split("/").filter(Boolean).join("-")}`;
    const bytes = Buffer.from(`Retained exact ${output}`);
    await mkdir(path.dirname(path.join(retained, "files", file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(retained, "files", file), bytes);
    records.push({ path: publicPath, file, outputs: [output], contentType: "text/plain", size: bytes.length, digest: hash(bytes) });
  }
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files: records }));
  await writeFile(path.join(retained, "artifact-inventory.json"), "{}");
  await writeFile(path.join(retained, "public-context.json"), "{}");
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const store = createNoBuildPreparationStorage("fixture-bucket", app, { operationId, contextDigest, commitSha: runtime.release,
    owner: "cloudflare", cutoffMillis: cutoffAt.toMillis(), admissionRevision: null });
  const preparedDigest = await store.checkpoint("prepared", retained, [...backgroundOutputFiles, ...records.map(file => `files/${file.file}`)]);
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ schemaVersion: 1, runtime,
    contextDigest, status: "verified", attempts: 1, nextAttemptAt: null, preparedDigest, admissionRevision: null,
    backgroundBucket: "fixture-bucket", reservation: { cutoffAt } });
  await rm(retained, { recursive: true });
  const stateDirectory = path.join(directory, "empty-cloud-cache");
  await rm(stateDirectory, { recursive: true, force: true });
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime, stateDirectory,
    distDirectory: path.join(directory, "unused-dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket",
    buildPublication: async () => { throw new Error("Restored preparation must never compile"); } })();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", aggregateReceipt: { contextDigest } });
  expect((await db.doc("cmsBackgroundOutputs/search").get()).data()).toMatchObject({ status: "verified" });
});


it("wakes interrupted family/preparation exhaustion once to converge the terminal queue", async () => {
  await enqueue();
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ runtime, status: "verified" });
  await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "failed", attempts: 4, nextAttemptAt: null });
  expect((await readWork()).maintenance).toBe(true);
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  expect((await readWork()).maintenance).toBe(false);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().status).toBe("failed");
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "pending" });
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ runtime,
    status: "building", attempts: 4, nextAttemptAt: Date.now() - 1 });
  expect((await readWork()).maintenance).toBe(true);
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "failed", error: "background_preparation_failed" });
  expect((await readWork()).maintenance).toBe(false);
});

it("stores compact exact receipts even when complete family manifests together exceed the queue document limit", async () => {
  await enqueue();
  await reader().recover();
  let originalBytes = 0;
  const batch = db.batch();
  for (const output of publication.OUTPUTS) {
    const ref = db.doc(`cmsBackgroundOutputs/${output}`);
    const state = (await ref.get()).data();
    const assets = Array.from({ length: 255 }, (_, index) => ({
      path: "/_astro/" + "x".repeat(490) + index + ".css", key: `post-background-v1/${output}/` + "y".repeat(130) + index,
      digest: "d".repeat(64), size: 1, contentType: "text/css",
    }));
    const receipt = { ...state.receipt, assets };
    originalBytes += Buffer.byteLength(JSON.stringify(receipt));
    batch.update(ref, { receipt });
  }
  expect(originalBytes).toBeGreaterThan(1024 * 1024);
  await batch.commit();
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(true);
  const queue = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  expect(Buffer.byteLength(JSON.stringify(queue.aggregateReceipt))).toBeLessThan(16 * 1024);
  for (const output of publication.OUTPUTS) {
    expect(queue.aggregateReceipt.outputs[output]).toMatchObject({ contextDigest, contextRevision: 1, rendererSha: runtime.release,
      taskPath: `cmsPublishQueue/${operationId}/backgroundOutputs/${output}` });
    expect(queue.aggregateReceipt.outputs[output].assets).toBeUndefined();
    expect(queue.aggregateReceipt.outputs[output].manifest).toBeUndefined();
  }
});


it("initializes independent cloud aggregates without modifying an inactive OFJ Post owner", async () => {
  const retained = { schemaVersion: 1, mode: "dynamic", servingEnabled: false, runtime: { owner: "node-compute", release: runtime.release },
    postId: "retained-post", operationId: "D".repeat(20), rendererSha: runtime.release, sourceVersion: 1,
    slug: "retained-post", ownedSlugs: ["retained-post"], generation: 1, visible: true };
  const ref = db.doc("system/publicDeployment/noBuildPostOwners/retained-post");
  await ref.set(retained);
  expect((await work.readNoBuildCloudWork({ runtime,
    read: async document => (await db.doc(document).get()).data() ?? null,
    listOwners: async () => (await db.collection("system/publicDeployment/noBuildPostOwners").get()).docs.map(row => row.data()),
  })).maintenance).toBe(true);
  await noBuildPostMaintenance({ firestore: db, commitSha: runtime.release, runtime, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({ contextRevision: 1, contextDigest, runtime });
  expect((await ref.get()).data()).toEqual(retained);
});

it("serves every context-only aggregate through the real public decision and RPC handler without Post admission", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeCommitSha: runtime.release, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "context-baseline" });
  await enqueue();
  const artifacts = { get: key => readFile(path.join(directory, key)) };
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  const handler = publicContent.createCmsGetPublicPageHandler({ firestore: db, backgroundArtifacts: artifacts });
  for (const output of publication.OUTPUTS) for (const publicPath of paths[output]) {
    const decision = await postPublication.readNoBuildPostDecision({ firestore: db, path: publicPath, rendererSha: runtime.release });
    expect(decision).toMatchObject({ kind: "background", context: { contextRevision: 1, contextDigest } });
    const response = { statusCode: null, body: null, headersSent: false,
      set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", body: { mode: "no-build-post-v1", path: publicPath, rendererSha: runtime.release } }, response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ kind: "background", status: 200,
      headers: { "x-njpbs-public-context-revision": "1", "x-njpbs-background-context-sha256": contextDigest } });
    expect(Buffer.from(response.body.bytes, "base64").toString()).toContain("Exact context");
    const edge = createNoBuildPostWorker({ rendererSha: runtime.release, target: targets.publicationTarget(),
      getDecision: async () => response.body,
      cache: { match: async () => undefined, put: async () => {} },
      fetchAsset: async () => new Response(null, { status: 404 }),
      render: async () => { throw new Error("Aggregate path cannot render a detail Post"); },
    } as Parameters<typeof createNoBuildPostWorker>[0]);
    const served = await edge.fetch(new Request(`https://njpbs.org${publicPath}`));
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("Exact context");
  }
  await db.doc("cmsBackgroundOutputs/search").delete();
  expect(await postPublication.readNoBuildPostDecision({ firestore: db, path: "/pagefind/pagefind.js", rendererSha: runtime.release })).toMatchObject({ kind: "background" });
  expect(await postPublication.readNoBuildPostDecision({ firestore: db, path: "/", rendererSha: runtime.release })).toEqual({ kind: "pass" });
});


it.each(["unrelated context", "same-revision enqueue", "new-revision enqueue", "withdrawal", "Home publication", "aggregate owner", "renderer"])(
  "fences aggregate RPC bytes across a concurrent %s change", async change => {
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
      activeGeneration: 1, activeCommitSha: runtime.release, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "context-baseline" });
    await enqueue();
    await reader().recover();
    await publication.settlePublicContext({ firestore: db, operationId, runtime });
    let reads = 0;
    const handler = publicContent.createCmsGetPublicPageHandler({ firestore: db,
      backgroundArtifacts: { get: key => readFile(path.join(directory, key)) },
      // Place the race after the sealed owner has checked the actual bytes,
      // immediately before the RPC's final real Firestore decision.
      readNoBuildPostFn: async fields => {
        if (++reads === 2) {
          if (change === "aggregate owner") await db.doc(publication.CURRENT_PATH).update({
            runtime: { owner: "node-compute", release: runtime.release } });
          else if (change === "renderer") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
          else if (change === "same-revision enqueue" || change === "new-revision enqueue") {
            const nextRevision = change === "new-revision enqueue" ? 2 : 1;
            if (nextRevision === 2) await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: nextRevision });
            await enqueue("B".repeat(20), { contextRevision: nextRevision });
            expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({
              operationId: "B".repeat(20), contextDigest: context.publicContextDigest(nextRevision) });
          }
          else await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2,
            ...(change === "withdrawal" ? { withdrawalRevision: 1 } : {}),
            ...(change === "Home publication" ? { homeRevision: 1 } : {}) });
        }
        return postPublication.readNoBuildPostDecision(fields);
      },
      log: { error() {} },
    });
    const response = { statusCode: null, body: null, headersSent: false,
      set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", body: { mode: "no-build-post-v1", path: "/posts/", rendererSha: runtime.release } }, response);
    expect(reads).toBe(2);
    if (["unrelated context", "same-revision enqueue", "new-revision enqueue"].includes(change)) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ kind: "background", status: 200,
        headers: { "x-njpbs-background-context-sha256": contextDigest, "x-njpbs-background-state": "current" } });
      expect(Buffer.from(response.body.bytes, "base64").toString()).toBe(`Exact context: ${contextDigest}`);
    } else {
      expect(response.statusCode).toBe(503);
      expect(response.body.bytes).toBeUndefined();
    }
  });

it("keeps the existing baseline only before verified handoff and refuses withdrawal or lost owned bytes", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeCommitSha: runtime.release, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "context-baseline" });
  // The deployed Assets baseline already contains these historical removals.
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 7 });
  await enqueue();
  expect((await db.doc(publication.CURRENT_PATH).get()).data().baselineWithdrawalRevision).toBe(7);
  const decision = () => postPublication.readNoBuildPostDecision({ firestore: db, path: "/posts/", rendererSha: runtime.release });
  expect(await decision()).toEqual({ kind: "pass" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 8 });
  expect(await decision()).toMatchObject({ kind: "background" });
  // A successor before handoff cannot erase the removal fence for the baseline.
  const successor = "B".repeat(20);
  await enqueue(successor);
  expect((await db.doc(publication.CURRENT_PATH).get()).data().baselineWithdrawalRevision).toBe(7);
  expect(await decision()).toMatchObject({ kind: "background" });
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId: successor, runtime });
  expect((await db.doc(publication.CURRENT_PATH).get()).data().servingEstablished).toBe(true);
  await db.doc("cmsBackgroundOutputs/listings").delete();
  expect(await decision()).toMatchObject({ kind: "background" });
});

it.each(["paused", "starting", "missing", "wrong-source", "wrong-serializer", "invalid"])("refuses aggregate bootstrap under %s control without taking OFJ families", async mode => {
  const runtimeRef = db.doc("system/cmsPublicationRuntime");
  if (["paused", "starting"].includes(mode)) await runtimeRef.update({ phase: mode });
  if (mode === "missing") await runtimeRef.delete();
  if (mode === "wrong-source") await runtimeRef.update({ commitSha: "b".repeat(40) });
  if (mode === "wrong-serializer") await runtimeRef.update({ serializerId: "cloudflare-dev-publisher" });
  if (mode === "invalid") await runtimeRef.update({ schemaVersion: 99 });
  const oldId = "F".repeat(20);
  const batch = db.batch();
  for (const output of publication.OUTPUTS) {
    const taskPath = `cmsPublishQueue/${oldId}/backgroundOutputs/${output}`;
    batch.set(db.doc(taskPath), { status: "pending", runtime: { owner: "node-compute", release: runtime.release } });
    batch.set(db.doc(`cmsBackgroundOutputs/${output}`), { schemaVersion: 1, owner: "post-background-v1",
      runtime: { owner: "node-compute", release: runtime.release }, revision: 1, taskPath, status: "pending" });
  }
  await batch.commit();
  const refs = publication.OUTPUTS.flatMap(output => [db.doc(`cmsBackgroundOutputs/${output}`),
    db.doc(`cmsPublishQueue/${oldId}/backgroundOutputs/${output}`)]);
  const snapshot = async () => (await db.getAll(...refs)).map(row => ({ data: row.data(), updateTime: row.updateTime }));
  const before = await snapshot();
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    serializerId: "cloudflare-publisher", stateDirectory: directory, distDirectory: path.join(directory, "dist"),
    buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  expect(await snapshot()).toEqual(before);
  expect((await db.doc(publication.CURRENT_PATH).get()).exists).toBe(false);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
});

it("drains an already accepted aggregate while cloud admission is paused", async () => {
  await enqueue();
  await reader().recover();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    serializerId: "cloudflare-publisher", stateDirectory: directory, distDirectory: path.join(directory, "dist"),
    buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success" });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("initializes only through the ready cloud identity of a split runtime control", async () => {
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "paused", commitSha: "b".repeat(40),
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: runtime.release, serializerId: "cloudflare-publisher" } });
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    serializerId: "cloudflare-publisher", stateDirectory: directory, distDirectory: path.join(directory, "dist"),
    buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({ runtime, contextRevision: 1 });
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("keeps the fresh shared anchor pending when a superseded sibling preparation exhausts", async () => {
  await enqueue();
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ runtime,
    status: "failed", attempts: 4, nextAttemptAt: null });
  const second = "B".repeat(20);
  await enqueue(second);
  await publication.failPublicContextPreparation({ firestore: db, operationId, runtime });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().status).toBe("failed");
  expect((await db.doc(`cmsPublishQueue/${second}`).get()).data().status).toBe("pending");
  expect((await db.doc(`cmsPublishQueue/${second}/backgroundPreparation/${contextDigest}`).get()).exists).toBe(false);
});

it("never returns an established aggregate namespace to Assets after a complete-byte alias is accepted", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeCommitSha: runtime.release, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "context-alias" });
  await enqueue();
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  await enqueue("B".repeat(20));
  await db.doc("cmsBackgroundOutputs/listings").delete();
  const decision = await postPublication.readNoBuildPostDecision({ firestore: db, path: "/posts/", rendererSha: runtime.release });
  expect(decision).toMatchObject({ kind: "background" });
});


it("recovers failed siblings after their exact bytes verified before interrupted settlement", async () => {
  await enqueue();
  const second = "B".repeat(20);
  await enqueue(second);
  await reader().recover();
  await verifiedInput(second);
  const batch = db.batch();
  for (const id of [operationId, second]) batch.update(db.doc(`cmsPublishQueue/${id}`), { status: "failed" });
  await batch.commit();
  const state = (await db.doc("cmsBackgroundOutputs/search").get()).data();
  await db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime });
    write();
  });
  for (const id of [operationId, second]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().status).toBe("pending");
  expect((await db.doc("cmsBackgroundOutputs/search").get()).data()).toEqual(state);
  expect(await publication.settlePublicContext({ firestore: db, operationId: second, runtime })).toBe(true);
  for (const id of [operationId, second]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data().status).toBe("success");
});

it.each(["missing", "failed", "foreign-context", "foreign-source"])("creates fresh alias work when Post-completed families have %s original preparation", async mode => {
  await enqueue();
  await reader().recover();
  const postId = "P".repeat(20);
  for (const output of publication.OUTPUTS) await db.doc(`cmsBackgroundOutputs/${output}`).update({
    taskPath: `cmsPublishQueue/${postId}/backgroundOutputs/${output}`, contextOnly: false });
  await verifiedInput(operationId);
  const prep = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  if (mode === "missing") await prep.delete();
  if (mode === "failed") await prep.update({ status: "failed", attempts: 4, nextAttemptAt: null });
  if (mode === "foreign-context") await prep.update({ contextDigest: "f".repeat(64) });
  if (mode === "foreign-source") await prep.update({ runtime: { ...runtime, release: "f".repeat(40) } });
  const before = await prep.get();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  const alias = "B".repeat(20);
  await enqueue(alias);
  expect((await db.doc(publication.CURRENT_PATH).get()).data()).toMatchObject({ operationId: alias, preparationOperationId: alias });
  for (const output of publication.OUTPUTS) expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()).toMatchObject({
    taskPath: `cmsPublishQueue/${alias}/backgroundOutputs/${output}`, status: "pending", contextOnly: true });
  expect((await prep.get()).data()).toEqual(before.data());
  expect((await prep.get()).updateTime).toEqual(before.updateTime);
});

it("creates one guarded preparation-recovery successor, preserves caller acceptance and refuses a parallel Post replacement", async () => {
  await enqueue();
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  const before = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!.publicContext;
  const retry = () => db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime }); write();
  });
  await retry();
  const current = (await db.doc(publication.CURRENT_PATH).get()).data()!;
  expect(current.operationId).not.toBe(operationId);
  expect(current.preparationOperationId).toBe(current.operationId);
  expect(current.namespaceOperationId).toBe(operationId);
  expect(current.operationIds).toContain(operationId);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!.publicContext).toEqual(before);
  expect((await db.doc(`cmsPublishQueue/${current.operationId}`).get()).data()).toMatchObject({ preparationRecoveryOfQueueId: operationId });
  await reader().recover();
  for (const output of publication.OUTPUTS) {
    const taskPath = `cmsPublishQueue/${"P".repeat(20)}/backgroundOutputs/${output}`;
    await db.doc(taskPath).set({ runtime, status: "verified" });
    await db.doc(`cmsBackgroundOutputs/${output}`).update({ taskPath, contextOnly: false });
  }
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect((await db.doc(publication.CURRENT_PATH).get()).data()!.operationId).toBe(current.operationId);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  for (const output of publication.OUTPUTS) expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()).toMatchObject({
    contextOnly: false, taskPath: `cmsPublishQueue/${"P".repeat(20)}/backgroundOutputs/${output}`, status: "verified" });
  const maintain = () => noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    serializerId: "cloudflare-publisher", stateDirectory: directory, distDirectory: path.join(directory, "dist"),
    buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  await expect(maintain()).rejects.toThrow("Final aggregate namespace ownership refused");
  expect((await db.doc(`cmsPublishQueue/${current.operationId}/backgroundPreparation/${contextDigest}`).get()).exists).toBe(false);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  // Restore only this test's corrupted pointer. Recovery keeps the original
  // aggregate byte owner A while the private preparation successor is B.
  for (const output of publication.OUTPUTS) await db.doc(`cmsBackgroundOutputs/${output}`).update({
    taskPath: `cmsPublishQueue/${operationId}/backgroundOutputs/${output}`, contextOnly: true });
  await maintain();
  expect((await db.doc(`cmsPublishQueue/${current.operationId}/backgroundPreparation/${contextDigest}`).get()).data())
    .toMatchObject({ attempts: 1, reservation: { commitSha: runtime.release } });
  await verifiedInput(current.operationId);
  await reader().recover();
  expect(await publication.settlePublicContext({ firestore: db, operationId: current.operationId, runtime })).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", publicContext: before,
    aggregateReceipt: { preparationOperationId: current.operationId } });
});


it.each([2, 4])("preserves preparation backoff and the %i-attempt budget during automatic recovery", async attempts => {
  await enqueue();
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  await db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime }); write();
  });
  const current = (await db.doc(publication.CURRENT_PATH).get()).data()!;
  await reader().recover();
  await verifiedInput(current.operationId);
  const prep = db.doc(`cmsPublishQueue/${current.operationId}/backgroundPreparation/${contextDigest}`);
  await prep.update({ status: "failed", attempts, nextAttemptAt: attempts === 4 ? null : Date.now() + 60_000 });
  const before = await prep.get();
  const taskBefore = await db.doc(`cmsPublishQueue/${current.operationId}/backgroundOutputs/listings`).get();
  for (const output of publication.OUTPUTS) {
    const taskPath = `cmsPublishQueue/${"P".repeat(20)}/backgroundOutputs/${output}`;
    await db.doc(taskPath).set({ runtime, status: "verified" });
    await db.doc(`cmsBackgroundOutputs/${output}`).update({ taskPath, contextOnly: false });
  }
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect((await prep.get()).data()).toEqual(before.data());
  expect((await prep.get()).updateTime).toEqual(before.updateTime);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  if (attempts === 4) {
    for (const id of [operationId, current.operationId]) expect((await db.doc(`cmsPublishQueue/${id}`).get()).data())
      .toMatchObject({ status: "failed", error: "background_preparation_failed" });
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()).toMatchObject({ contextOnly: false, status: "verified" });
  } else {
    expect((await db.doc(`cmsPublishQueue/${current.operationId}/backgroundOutputs/listings`).get()).data())
      .toMatchObject({ status: taskBefore.data()!.status, attempts: taskBefore.data()!.attempts });
    expect((await db.doc("cmsBackgroundOutputs/listings").get()).data())
      .toMatchObject({ contextOnly: false, status: "verified", taskPath: `cmsPublishQueue/${"P".repeat(20)}/backgroundOutputs/listings` });
    expect((await readWork()).maintenance).toBe(false);
  }
});


it("fences an obsolete verified preparation before it can feed a newly accepted alias", async () => {
  await enqueue();
  const retained = path.join(directory, "obsolete-preparation");
  await mkdir(retained, { recursive: true, mode: 0o700 });
  const records = [];
  for (const output of publication.OUTPUTS) for (const publicPath of paths[output]) {
    const file = `${output}/${publicPath.split("/").filter(Boolean).join("-")}`;
    const bytes = Buffer.from(`Original A ${output}`);
    await mkdir(path.dirname(path.join(retained, "files", file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(retained, "files", file), bytes);
    records.push({ path: publicPath, file, outputs: [output], contentType: "text/plain", size: bytes.length, digest: hash(bytes) });
  }
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files: records }));
  await writeFile(path.join(retained, "artifact-inventory.json"), "{}");
  await writeFile(path.join(retained, "public-context.json"), "{}");
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const store = createNoBuildPreparationStorage("fixture-bucket", app, { operationId, contextDigest, commitSha: runtime.release,
    owner: "cloudflare", cutoffMillis: cutoffAt.toMillis(), admissionRevision: null });
  const preparedDigest = await store.checkpoint("prepared", retained, [...backgroundOutputFiles, ...records.map(file => `files/${file.file}`)]);
  const prep = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await prep.set({ schemaVersion: 1, runtime, contextDigest, status: "verified", attempts: 1, nextAttemptAt: null, preparedDigest,
    admissionRevision: null, backgroundBucket: "fixture-bucket", reservation: { cutoffAt, commitSha: runtime.release,
      buildBatchId: "fixture-original-A", generation: 2 } });
  const before = await prep.get();
  await rm(retained, { recursive: true });
  const stateDirectory = path.join(directory, "obsolete-empty-cache");
  await rm(stateDirectory, { recursive: true, force: true });
  let entered!: () => void;
  let release!: () => void;
  const restoring = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  boundary.onRead(async key => { if (key.endsWith(`/${operationId}/${contextDigest}/prepared.json`)) { entered(); await resume; } });
  const maintenance = noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    stateDirectory, distDirectory: path.join(directory, "unused-dist"), buildEnvironment: {}, backgroundBucket: "fixture-bucket" })();
  const second = "B".repeat(20);
  try { await restoring; await enqueue(second); }
  finally { boundary.onRead(null); release(); await maintenance; }
  for (const output of publication.OUTPUTS) expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()).toMatchObject({
    taskPath: `cmsPublishQueue/${second}/backgroundOutputs/${output}`, status: "pending", receipt: null });
  expect((await db.doc(`cmsPublishQueue/${second}`).get()).data()).toMatchObject({ status: "pending", aggregateReceipt: null });
  expect((await db.doc(`cmsPublishQueue/${second}/backgroundPreparation/${contextDigest}`).get()).exists).toBe(false);
  expect((await prep.get()).data()).toEqual(before.data());
  expect((await prep.get()).updateTime).toEqual(before.updateTime);
});


it.each(["valid", "missing operation id", "different context", "invalid preparation id"])(
  "restores only a valid sealed selection for slow output retry (%s)", async selection => {
  await enqueue();
  await reader().recover();
  const retained = path.join(directory, "slow-output-preparation");
  await mkdir(retained, { recursive: true, mode: 0o700 });
  const records = [];
  for (const output of publication.OUTPUTS) for (const publicPath of paths[output]) {
    const file = `${output}/${publicPath.split("/").filter(Boolean).join("-")}`;
    const bytes = Buffer.from(`Frozen ${output}`);
    await mkdir(path.dirname(path.join(retained, "files", file)), { recursive: true });
    await writeFile(path.join(retained, "files", file), bytes);
    records.push({ path: publicPath, file, outputs: [output], contentType: "text/plain", size: bytes.length, digest: hash(bytes) });
  }
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files: records }));
  await writeFile(path.join(retained, "artifact-inventory.json"), "{}");
  await writeFile(path.join(retained, "public-context.json"), "{}");
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const store = createNoBuildPreparationStorage("fixture-bucket", app, { operationId, contextDigest, commitSha: runtime.release,
    owner: "cloudflare", cutoffMillis: cutoffAt.toMillis(), admissionRevision: null });
  const preparedDigest = await store.checkpoint("prepared", retained, [...backgroundOutputFiles, ...records.map(file => `files/${file.file}`)]);
  const preparation = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await preparation.set({ schemaVersion: 1, runtime, contextDigest, status: "verified", attempts: 1, nextAttemptAt: null, preparedDigest,
    admissionRevision: null, backgroundBucket: "fixture-bucket", reservation: { cutoffAt, commitSha: runtime.release,
      buildBatchId: "fixture-original", generation: 2 } });
  const before = await preparation.get();
  await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "failed", attempts: 4, receipt: null,
    nextAttemptAt: null, slowRetryAt: Date.now() + 600_000, lastAttempt: { failureClass: "timeout", retryable: true } });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "failed", receipt: null });
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("failed");
  await rm(retained, { recursive: true });
  const maintain = noBuildPostMaintenance({ firestore: db, firebaseApp: app, commitSha: runtime.release, runtime,
    stateDirectory: path.join(directory, "slow-empty-cache"), distDirectory: path.join(directory, "unused-dist"),
    buildEnvironment: {}, backgroundBucket: "fixture-bucket", buildPublication: async () => { throw new Error("A sealed retry must not build"); } });
  const readsBeforeDue = boundary.reads.length;
  if (selection !== "valid") {
    const queueRef = db.doc(`cmsPublishQueue/${operationId}`);
    const identity = (await queueRef.get()).data()!.publicContext;
    if (selection === "missing operation id") delete identity.operationId;
    if (selection === "different context") identity.contextDigest = "f".repeat(64);
    if (selection === "invalid preparation id") await db.doc(publication.CURRENT_PATH).update({ preparationOperationId: "invalid" });
    await queueRef.update({ publicContext: identity });
    await expect(maintain()).rejects.toThrow(selection === "invalid preparation id" ? "Aggregate preparation selection refused" : "Aggregate context selection");
    expect(boundary.reads).toHaveLength(readsBeforeDue);
    expect((await preparation.get()).data()).toEqual(before.data());
    expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).get()).data()).toMatchObject({ status: "failed", attempts: 4, receipt: null });
    return;
  }
  await maintain();
  expect(boundary.reads.length).toBe(readsBeforeDue);
  expect((await readWork()).maintenance).toBe(false);
  await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ slowRetryAt: Date.now() - 1 });
  expect((await readWork()).maintenance).toBe(true);
  await maintain();
  const task = (await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).get()).data()!;
  expect(task).toMatchObject({ status: "verified", attempts: 5, slowRetryAt: null, receipt: { contextDigest } });
  const files = await manifests.readRecordManifest({ receipt: task.receipt, output: "search",
    artifacts: { get: async key => boundary.objects.get(key) }, signal: new AbortController().signal, scope: operationId });
  expect(files.map(file => file.path).sort()).toEqual([...paths.search].sort());
  for (const file of files) {
    const bytes = boundary.objects.get(file.key);
    expect(bytes).toEqual(Buffer.from("Frozen search"));
    expect(file.size).toBe(bytes!.length);
    expect(file.digest).toBe(hash(bytes!));
  }
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", aggregateReceipt: { contextDigest } });
  expect((await preparation.get()).data()).toEqual(before.data());
  expect((await preparation.get()).updateTime).toEqual(before.updateTime);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("keeps all verified aggregate bytes current after recovery preparation exhausts", async () => {
  await enqueue();
  await reader().recover();
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  await db.runTransaction(async transaction => {
    const write = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime }); write();
  });
  const current = (await db.doc(publication.CURRENT_PATH).get()).data()!;
  await reader().recover();
  for (const output of publication.OUTPUTS) {
    const taskPath = `cmsPublishQueue/${"P".repeat(20)}/backgroundOutputs/${output}`;
    await db.doc(taskPath).set({ runtime, status: "verified" });
    await db.doc(`cmsBackgroundOutputs/${output}`).update({ taskPath, contextOnly: false });
  }
  const refs = publication.OUTPUTS.map(output => db.doc(`cmsBackgroundOutputs/${output}`));
  const snapshot = async () => (await db.getAll(...refs)).map(row => ({ data: row.data(), updateTime: row.updateTime }));
  const before = await snapshot();
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
  expect(await snapshot()).toEqual(before);
  await db.doc(`cmsPublishQueue/${current.operationId}/backgroundPreparation/${contextDigest}`).set({ runtime,
    contextDigest, status: "failed", attempts: 4, nextAttemptAt: null });
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
  expect((await db.doc(`cmsPublishQueue/${current.operationId}`).get()).data()).toMatchObject({ status: "failed" });
  expect(await snapshot()).toEqual(before);
  const late = background.createPostBackgroundOutputs({ firestore: db, enabled: true, runtime,
    now: () => Date.now() + 25 * 60 * 60 * 1000,
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: { get: key => readFile(path.join(directory, key)) } });
  for (const output of publication.OUTPUTS) for (const publicPath of paths[output]) {
    const response = await late.serve(new Request(`https://example.test${publicPath}`));
    expect(response.status).toBe(200);
  }
});

it("closes fixture responses so later transfers cannot reuse an expiring idle socket", async () => {
  const agent = new Agent({ keepAlive: true });
  const bytes = Buffer.from("Exact fixture bytes");
  const key = "post-background-v1/connection-lifetime";
  boundary.objects.set(key, bytes);
  const read = () => new Promise<{ bytes: Buffer; connection?: string; reused: boolean }>((resolve, reject) => {
    const request = get(`${process.env.STORAGE_EMULATOR_HOST}/b/fixture-bucket/o/${encodeURIComponent(key)}`, { agent }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({ bytes: Buffer.concat(chunks),
        connection: response.headers.connection, reused: request.reusedSocket }));
    });
    request.once("error", reject);
  });
  try {
    const first = await read();
    const second = await read();
    for (const response of [first, second]) {
      expect(response.bytes).toEqual(bytes);
      expect(response.connection).toBe("close");
      expect(response.reused).toBe(false);
    }
  } finally { agent.destroy(); }
});

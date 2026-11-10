import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import { createHash } from "node:crypto";
import { backgroundInputFiles, backgroundOutputFiles, createNoBuildPreparationStorage } from "../../site/scripts/no-build-preparation-storage";
import { backgroundStorageFixture } from "./background-storage-fixture";
import publication from "../../functions/lib/no-build-post-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import background from "../../functions/lib/post-background-outputs.js";
import { BackgroundPreparationError, backgroundPreparationDiagnostic } from "../../site/scripts/background-preparation-diagnostic";

const commitSha = "a".repeat(40);
const operationId = "11111111111111111111";
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>;
let directory: string;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use a local demo Firestore emulator");
  }
  boundary = await backgroundStorageFixture("fixture-bucket");
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-njpbs" }, "background-runtime-test");
  firestore = firebaseAdminRuntime.getFirestore(app);
  directory = await mkdtemp(path.join(tmpdir(), "post-background-runtime-"));
});
afterAll(async () => {
  if (app) await firebaseAdminRuntime.deleteApp(app);
  if (boundary) await boundary.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  boundary.objects.clear();
  boundary.writes.length = 0;
  boundary.reads.length = 0;
  boundary.refuseReads(false);
  boundary.reject(null);
  await rm(path.join(directory, "jobs"), { recursive: true, force: true });
  await firestore.recursiveDelete(firestore.doc("system/publicDeployment"));
  await firestore.recursiveDelete(firestore.collection("cmsBackgroundOutputs"));
  await firestore.recursiveDelete(firestore.collection("cmsPosts"));
  await firestore.recursiveDelete(firestore.collection("cmsPublishQueue"));
  await firestore.doc("system/noBuildPostAdmission").set({ schemaVersion: 1, revision: 1, enabled: true,
    postId: "pilot-post", backgroundBucket: "fixture-bucket" });
  await firestore.doc("system/publicDeployment").set({
    state: "idle", activeCommitSha: commitSha, activeGeneration: 278,
    activeDeploymentId: "deployed-generation-278",
  });
  await firestore.doc("system/publicDeployment/noBuildPosts/current").set({
    schemaVersion: 1, mode: "dynamic", servingEnabled: true, postId: "pilot-post",
    operationId, sourceVersion: 3, slug: "test-post", visible: true,
    rendererSha: commitSha, ownedSlugs: ["test-post"], generation: 278,
  });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await firestore.doc(`cmsPublishQueue/${operationId}`).set({ transport: "post-no-build-v1",
    noBuildPost: { postId: "pilot-post", operationId, sourceVersion: 3 } });
  const taskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/listings`;
  await firestore.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", postId: "pilot-post",
    revision: 1, output: "listings", status: "pending", attempts: 0, nextAttemptAt: 0 });
  await firestore.doc("cmsBackgroundOutputs/listings").set({ schemaVersion: 1, owner: "post-background-v1",
    revision: 1, postId: "pilot-post", status: "pending", taskPath });
});

it("persists background reservation timestamps with the publisher SDK and retains bounded preparation failure", async () => {
  // No artifact build can start: the preparation destination is a file.
  // The database must still accept its reservation and retain bounded failure.
  const stateDirectory = path.join(directory, "not-a-directory");
  await writeFile(stateDirectory, "fixture");
  const maintain = noBuildPostMaintenance({
    firestore, commitSha, stateDirectory, distDirectory: path.join(directory, "dist"),
    buildEnvironment: { NO_BUILD_POST_ID: "pilot-post", NO_BUILD_POST_BACKGROUND_BUCKET: "fixture-bucket" },
  })!;
  await expect(maintain()).resolves.toBeUndefined();
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${context.publicContextDigest(1)}`);
  const stored = (await preparation.get()).data()!;
  expect(stored).toMatchObject({ runtime: { owner: "node-compute", release: commitSha }, status: "failed", attempts: 1, claim: null, error: "background_preparation_failed" });
  expect(stored.reservation.cutoffAt).toBeInstanceOf(firebaseAdminRuntime.Timestamp);
  expect(stored.reservation.reservedAt.isEqual(stored.reservation.cutoffAt)).toBe(true);
  expect(stored.nextAttemptAt).toBeGreaterThan(stored.reservation.cutoffAt.toMillis());
  await expect(maintain()).resolves.toBeUndefined();
  expect((await preparation.get()).data()).toEqual(stored);
});


it("does not prepare a cloud-owned job on OFJ even before its first preparation exists", async () => {
  await firestore.doc(`cmsPublishQueue/${operationId}`).set({
    transport: "post-no-build-v1", backgroundRuntime: { owner: "cloudflare", release: commitSha },
    noBuildPost: { postId: "pilot-post", operationId, sourceVersion: 3 },
  });
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${context.publicContextDigest(1)}`);
  await preparation.delete();
  const maintain = noBuildPostMaintenance({ firestore, commitSha, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: { NO_BUILD_POST_ID: "pilot-post" } })!;
  await maintain();
  expect((await preparation.get()).exists).toBe(false);
});

it("prepares the global family's addressed Post rather than the first enumerated owner", async () => {
  const state = (await firestore.doc(publication.STATE_PATH).get()).data()!;
  const secondOperation = "22222222222222222222";
  await firestore.doc(publication.STATE_PATH).delete();
  await firestore.doc("system/publicDeployment/noBuildPostOwners/a-post").set({ ...state, postId: "a-post" });
  await firestore.doc("system/publicDeployment/noBuildPostOwners/z-post").set({ ...state,
    postId: "z-post", operationId: secondOperation, slug: "second-post", ownedSlugs: ["second-post"] });
  await firestore.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 2, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  const taskPath = `cmsPublishQueue/${secondOperation}/backgroundOutputs/listings`;
  await firestore.doc(`cmsPublishQueue/${secondOperation}`).set({ transport: "post-no-build-v1",
    noBuildPost: { operationId: secondOperation, postId: "z-post", sourceVersion: 3 } });
  await firestore.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", postId: "z-post",
    revision: 1, output: "listings", status: "pending", attempts: 0, nextAttemptAt: 0 });
  await firestore.doc("cmsBackgroundOutputs/listings").update({ postId: "z-post", taskPath });
  await noBuildPostMaintenance({ firestore, commitSha, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {} })();
  const digest = context.publicContextDigest(1);
  expect((await firestore.doc(`cmsPublishQueue/${secondOperation}/backgroundPreparation/${digest}`).get()).data())
    .toMatchObject({ status: "failed", error: "background_preparation_failed", attempts: 1 });
  expect((await firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`).get()).exists).toBe(false);
});

it("keeps a context successor under its old queue after a shared renderer activation", async () => {
  const nextRelease = "b".repeat(40);
  const latestOperation = "33333333333333333333";
  const oldRuntime = { owner: "cloudflare" as const, release: commitSha };
  const activeRuntime = { owner: "cloudflare" as const, release: nextRelease };
  await firestore.doc(publication.STATE_PATH).update({ runtime: oldRuntime, operationId: latestOperation });
  await firestore.doc(`cmsPublishQueue/${operationId}`).update({ backgroundRuntime: oldRuntime });
  await firestore.doc(`cmsPublishQueue/${latestOperation}`).set({ transport: "post-no-build-v1", backgroundRuntime: oldRuntime,
    noBuildPost: { operationId: latestOperation, postId: "pilot-post", sourceVersion: 3 } });
  await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/listings`).update({ runtime: oldRuntime });
  await firestore.doc("cmsBackgroundOutputs/listings").update({ runtime: oldRuntime });
  await firestore.doc("system/publicDeployment").update({ activeCommitSha: nextRelease });
  await firestore.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2,
    rendererSha: nextRelease, servingEnabled: true, generation: 279 });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  const maintain = noBuildPostMaintenance({ firestore, commitSha: nextRelease, runtime: activeRuntime,
    stateDirectory: directory, distDirectory: path.join(directory, "dist"), buildEnvironment: {} });
  await maintain();
  const digest = context.publicContextDigest(2);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`);
  expect((await preparation.get()).data()).toMatchObject({ runtime: activeRuntime, attempts: 1, status: "failed" });
  expect((await firestore.doc(`cmsPublishQueue/${latestOperation}/backgroundPreparation/${digest}`).get()).exists).toBe(false);
  expect((await firestore.doc(publication.STATE_PATH).get()).data()).toMatchObject({ runtime: oldRuntime, rendererSha: commitSha });
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()?.backgroundRuntime).toEqual(oldRuntime);
  const original = { ...(await preparation.get()).data()!, runtime: oldRuntime };
  await preparation.set(original);
  await maintain();
  expect((await preparation.get()).data()).toEqual(original);
});


it("retains a configured runtime owner when activating before the first Post operation", async () => {
  const nextRelease = "b".repeat(40);
  const ref = firestore.doc(publication.STATE_PATH);
  await ref.update({ operationId: null, runtime: { owner: "cloudflare", release: commitSha } });
  const original = (await ref.get()).data();
  await firestore.runTransaction(async transaction => {
    const state = (await transaction.get(ref)).data();
    publication.writeNoBuildCandidateActivation(transaction, firestore, {
      state, contract: { schemaVersion: 1, postId: "pilot-post", rendererSha: nextRelease, enabled: true, authoritative: true },
    }, { commitSha: nextRelease, generation: 279 });
  });
  expect((await ref.get()).data()).toEqual(original);
  expect((await firestore.doc("system/publicDeployment/noBuildPosts/capability").get()).data()).toEqual({
    schemaVersion: 1, postId: "pilot-post", rendererSha: nextRelease, servingEnabled: true, generation: 279,
  });
});


it.each((["node-compute", "cloudflare"] as const).flatMap(owner =>
  ["verified", "failed", "verified-final-attempt", "missing-family", "slow-output"].map(status => ({ owner, status }))))(
  "recovers $status preparation and retained assets onto empty disk for $owner without reading an expired cutoff", async ({ owner, status }) => {
  const contextDigest = context.publicContextDigest(1);
  const retained = path.join(directory, "jobs", operationId, `background-${contextDigest}`);
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  const runtime = { owner, release: commitSha };
  await firestore.doc(publication.STATE_PATH).update({ runtime });
  await firestore.doc(`cmsPublishQueue/${operationId}`).update({ backgroundRuntime: runtime });
  await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/listings`).update({ runtime });
  await firestore.doc("cmsBackgroundOutputs/listings").update({ runtime });
  if (status === "missing-family") {
    await firestore.recursiveDelete(firestore.collection("cmsBackgroundOutputs"));
    await firestore.recursiveDelete(firestore.collection(`cmsPublishQueue/${operationId}/backgroundOutputs`));
    const nextDocument = { version: 3, publiclyVisible: true, published: { sourceVersion: 3, publishedAt: "2026-10-08T12:00:00.000Z",
      metadata: { type: "post", title: "Public Post", slug: "test-post", previousSlugs: [] }, blocks: [], authorIds: [] } };
    const owner = background.createPostBackgroundOutputs({ firestore, runtime, enabled: true, postIds: ["pilot-post"], contentApiEnabled: true,
      readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, firestore) });
    await firestore.runTransaction(async transaction => {
      const write = await owner.prepareInTransaction({ transaction, queueId: operationId, postId: "pilot-post", nextDocument, homePlacementPaths: [] });
      transaction.set(firestore.doc("cmsPosts/pilot-post"), nextDocument); write();
    });
  }
  await mkdir(path.join(retained, "files/posts"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(retained, "files/_astro"), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from('<link rel="stylesheet" href="/_astro/retained.css">Retained listing from the original operation');
  const asset = Buffer.from(".listing { color: navy; }");
  const receipt = { schemaVersion: 2, contextDigest, routes: [], files: [{ path: "/posts/", file: "posts/index.html", outputs: ["listings"],
    contentType: "text/html; charset=utf-8", size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") },
  { path: "/_astro/retained.css", file: "_astro/retained.css", outputs: ["listings"],
    contentType: "text/css; charset=utf-8", size: asset.length, digest: createHash("sha256").update(asset).digest("hex") }] };
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify(receipt));
  await writeFile(path.join(retained, "artifact-inventory.json"), "{}");
  await writeFile(path.join(retained, "public-context.json"), "{}");
  await writeFile(path.join(retained, "files/posts/index.html"), bytes);
  await writeFile(path.join(retained, "files/_astro/retained.css"), asset);
  const cloud = createNoBuildPreparationStorage("fixture-bucket", app, {
    operationId, contextDigest, commitSha, owner: runtime.owner, cutoffMillis: cutoffAt.toMillis(), admissionRevision: 1 });
  const preparedDigest = await cloud.checkpoint("prepared", retained, [...backgroundOutputFiles, "files/posts/index.html", "files/_astro/retained.css"]);
  const attempts = status === "verified-final-attempt" ? 4 : 1;
  await preparation.set({ runtime, schemaVersion: 1, contextDigest, status: status === "failed" ? "failed" : "verified", attempts, nextAttemptAt: 0,
    admissionRevision: 1, backgroundBucket: "fixture-bucket", preparedDigest,
    reservation: { buildBatchId: `post-background-${operationId}-${contextDigest}`, commitSha, cutoffAt } });
  if (status === "slow-output") {
    const after = background.dependency(null);
    await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/listings`).update({ contextDigest,
      dependencies: { after, slugs: [] }, status: "failed", attempts: 4, nextAttemptAt: null,
      slowRetryAt: Date.now() - 1, lastAttempt: { failureClass: "timeout", retryable: true } });
    await firestore.doc("cmsBackgroundOutputs/listings").update({ contextDigest, after, status: "failed" });
  }
  await rm(retained, { recursive: true, force: true });
  const maintain = noBuildPostMaintenance({ firestore, firebaseApp: app, commitSha, runtime, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {} });
  if (status === "verified-final-attempt") {
    const verified = (await preparation.get()).data();
    boundary.refuseReads(true);
    await maintain();
    expect((await preparation.get()).data()).toEqual(verified);
    await expect(readFile(path.join(retained, "files/posts/index.html"))).rejects.toMatchObject({ code: "ENOENT" });
    boundary.refuseReads(false);
  }
  await maintain();
  expect(await readFile(path.join(retained, "files/posts/index.html"))).toEqual(bytes);
  expect(await readFile(path.join(retained, "files/_astro/retained.css"))).toEqual(asset);
  expect(JSON.parse(await readFile(path.join(retained, "receipt.json"), "utf8"))).toEqual(receipt);
  expect((await preparation.get()).data()).toMatchObject({ status: "verified", attempts: status === "failed" ? 2 : attempts, preparedDigest });
  if (status === "slow-output") {
    const task = (await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/listings`).get()).data()!;
    expect(task).toMatchObject({ status: "verified", attempts: 5, slowRetryAt: null, receipt: { contextDigest } });
    for (const file of [...task.receipt.manifest, ...task.receipt.assets]) {
      expect(boundary.objects.get(file.key)).toEqual(file.path === "/posts/" ? bytes : asset);
    }
    expect((await preparation.get()).data()!.reservation.cutoffAt.isEqual(cutoffAt)).toBe(true);
    const reads = boundary.reads.length;
    await maintain();
    expect(boundary.reads).toHaveLength(reads);
    return;
  }
  if (status === "missing-family") {
    const missing = await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/feed`).get();
    expect(missing.data()).toMatchObject({ status: "failed", attempts: 1, error: "background_generation_failed" });
  }
  const cloudReads = boundary.reads.length;
  await maintain();
  expect(boundary.reads).toHaveLength(cloudReads);
  // A changed local family file is repaired from the verified cloud manifest.
  await writeFile(path.join(retained, "files/posts/index.html"), "changed cache");
  if (status === "missing-family") await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/feed`).update({ nextAttemptAt: 0 });
  await maintain();
  expect(boundary.reads.length).toBeGreaterThan(cloudReads);
  expect(await readFile(path.join(retained, "files/posts/index.html"))).toEqual(bytes);
  expect((await preparation.get()).data()!.reservation.cutoffAt.isEqual(cutoffAt)).toBe(true);
  // Change admission without rebuilding this maintenance closure. Withdrawal
  // work remains recoverable while new publication admission is paused.
  await firestore.doc("system/noBuildPostAdmission").update({ enabled: false, revision: 2 });
  await firestore.doc(publication.STATE_PATH).update({ visible: false });
  await rm(retained, { recursive: true, force: true });
  if (status === "missing-family") await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/feed`).update({ nextAttemptAt: 0 });
  await maintain();
  expect(await readFile(path.join(retained, "files/posts/index.html"))).toEqual(bytes);
  // A valid object CRC and schema do not override the digest in Firestore.
  await preparation.update({ preparedDigest: "f".repeat(64) });
  await rm(retained, { recursive: true, force: true });
  if (status === "missing-family") await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/feed`).update({ nextAttemptAt: 0 });
  await maintain();
  expect((await preparation.get()).data()).toMatchObject({ status: "failed", error: "background_preparation_failed" });
});

it.each(["checkpoint", "object", "bucket", "legacy-receipt"])("records permanent verified preparation failure for missing or changed %s", async failure => {
  const contextDigest = context.publicContextDigest(1);
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const retained = path.join(directory, "jobs", operationId, `background-${contextDigest}`);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await mkdir(retained, { recursive: true, mode: 0o700 });
  for (const name of backgroundOutputFiles) await writeFile(path.join(retained, name), "{}");
  if (failure === "legacy-receipt") await writeFile(path.join(retained, "receipt.json"),
    JSON.stringify({ schemaVersion: 1, contextDigest, routes: [], files: [] }));
  const cloud = createNoBuildPreparationStorage("fixture-bucket", app, {
    operationId, contextDigest, commitSha, owner: "node-compute", cutoffMillis: cutoffAt.toMillis(), admissionRevision: 1 });
  const preparedDigest = await cloud.checkpoint("prepared", retained, backgroundOutputFiles);
  await preparation.set({ runtime: { owner: "node-compute", release: commitSha }, schemaVersion: 1, contextDigest,
    status: "verified", attempts: 4, nextAttemptAt: null, admissionRevision: 1, backgroundBucket: "fixture-bucket", preparedDigest,
    reservation: { buildBatchId: `post-background-${operationId}-${contextDigest}`, commitSha, cutoffAt } });
  await rm(retained, { recursive: true, force: true });
  if (failure === "bucket") await firestore.doc("system/noBuildPostAdmission").update({ backgroundBucket: "migrated-bucket", revision: 2 });
  else if (failure !== "legacy-receipt") {
    const key = [...boundary.objects.keys()].find(key => failure === "checkpoint" ? key.endsWith("/prepared.json") : key.includes("/bytes/"))!;
    expect(key).toBeTruthy();
    boundary.objects.delete(key);
  }
  await noBuildPostMaintenance({ firestore, firebaseApp: app, commitSha, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {} })();
  expect((await preparation.get()).data()).toMatchObject({ status: "failed", attempts: 4,
    nextAttemptAt: null, error: "background_preparation_failed" });
});

it("keeps the original cutoff when retrying failed preparation", async () => {
  const contextDigest = context.publicContextDigest(1);
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await preparation.set({ runtime: { owner: "node-compute", release: commitSha }, schemaVersion: 1, contextDigest,
    status: "failed", attempts: 1, nextAttemptAt: 0, admissionRevision: 1, backgroundBucket: "fixture-bucket",
    reservation: { buildBatchId: `post-background-${operationId}-${contextDigest}`, commitSha, cutoffAt } });
  await noBuildPostMaintenance({ firestore, commitSha, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {} })();
  const stored = (await preparation.get()).data()!;
  expect(stored.status).toBe("failed");
  expect(stored.attempts).toBe(2);
  expect(stored.reservation.cutoffAt.isEqual(cutoffAt)).toBe(true);
});


it("restores frozen inputs before retrying a build instead of rereading an expired cutoff", async () => {
  const contextDigest = context.publicContextDigest(1);
  const retained = path.join(directory, "jobs", operationId, `background-${contextDigest}`);
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await mkdir(retained, { recursive: true, mode: 0o700 });
  for (const name of backgroundInputFiles) await writeFile(path.join(retained, name), `original ${name}`);
  const cloud = createNoBuildPreparationStorage("fixture-bucket", app, {
    operationId, contextDigest, commitSha, owner: "node-compute", cutoffMillis: cutoffAt.toMillis(), admissionRevision: 1 });
  const inputDigest = await cloud.checkpoint("input", retained, backgroundInputFiles);
  await preparation.set({ runtime: { owner: "node-compute", release: commitSha }, schemaVersion: 1,
    contextDigest, status: "failed", attempts: 1, nextAttemptAt: 0,
    admissionRevision: 1, backgroundBucket: "fixture-bucket",
    reservation: { buildBatchId: `post-background-${operationId}-${contextDigest}`, commitSha, cutoffAt } });
  await rm(retained, { recursive: true, force: true });
  await noBuildPostMaintenance({ firestore, firebaseApp: app, commitSha, stateDirectory: directory,
    distDirectory: path.join(directory, "dist"), buildEnvironment: {} })();
  expect(await readFile(path.join(retained, "input.json"), "utf8")).toBe("original input.json");
  // The input receipt is persisted only after cloud restoration. The unrelated
  // source-checkout gate then refuses this fixture SHA before invoking Astro.
  const stored = (await preparation.get()).data()!;
  expect(stored).toMatchObject({ inputDigest, status: "failed", attempts: 2 });
  expect(stored.reservation.cutoffAt.isEqual(cutoffAt)).toBe(true);
});

it("persists and logs the same sanitized renderer diagnostic without altering the retry budget", async () => {
  const runtime = { owner: "cloudflare" as const, release: commitSha };
  await firestore.doc(publication.STATE_PATH).update({ runtime });
  await firestore.doc(`cmsPublishQueue/${operationId}`).update({ backgroundRuntime: runtime });
  await firestore.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/listings`).update({ runtime });
  await firestore.doc("cmsBackgroundOutputs/listings").update({ runtime });
  const contextDigest = context.publicContextDigest(1);
  const retained = path.join(directory, "jobs", operationId, `background-${contextDigest}`);
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(1700000000000);
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await mkdir(retained, { recursive: true, mode: 0o700 });
  for (const name of backgroundInputFiles) await writeFile(path.join(retained, name), `original ${name}`);
  const cloud = createNoBuildPreparationStorage("fixture-bucket", app, {
    operationId, contextDigest, commitSha, owner: runtime.owner, cutoffMillis: cutoffAt.toMillis(), admissionRevision: 1 });
  const inputDigest = await cloud.checkpoint("input", retained, backgroundInputFiles);
  await preparation.set({ runtime, schemaVersion: 1, contextDigest, status: "failed", attempts: 3, nextAttemptAt: 0,
    inputDigest, admissionRevision: 1, backgroundBucket: "fixture-bucket",
    reservation: { buildBatchId: `post-background-${operationId}-${contextDigest}`, commitSha, cutoffAt } });
  const diagnostic = backgroundPreparationDiagnostic(Object.assign(new Error("child failed"), { code: 1 }),
    "astro_build", {}, "EROFS: read-only file system; password=synthetic-password");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const build = vi.fn(async () => { throw new BackgroundPreparationError(diagnostic); });
  try {
    await noBuildPostMaintenance({ firestore, firebaseApp: app, commitSha, runtime, stateDirectory: directory,
      distDirectory: path.join(directory, "dist"), buildEnvironment: {}, buildPublication: build })();
    const stored = (await preparation.get()).data()!;
    expect(stored).toMatchObject({ status: "failed", attempts: 4, claim: null,
      nextAttemptAt: null, error: "background_preparation_failed", diagnostic, inputDigest });
    expect(log).toHaveBeenCalledWith(`No-build background preparation failed: ${stored.diagnostic}`);
    expect(stored.diagnostic).not.toContain("synthetic-password");
    expect(JSON.parse(stored.diagnostic)).toMatchObject({ stage: "astro_build", exitCode: 1 });
    expect(build).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

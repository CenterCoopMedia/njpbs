import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import admission from "../../functions/lib/public-release-bootstrap-admission.js";
import p from "../../functions/lib/public-release-pair.js";
import owner from "../../functions/lib/dev-public-release-pause.js";
import contextOwner from "../../functions/lib/public-context-publication.js";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";
import { publicContextDigest } from "../../functions/lib/public-context-revision.js";
import { parseDevPublicReleasePausePacket, runDevPublicReleasePauseOperator } from "../../scripts/lib/dev-public-release-pause-operator.mjs";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-public-release-pause-sdk");
const db = getFirestore(app);
afterAll(() => deleteApp(app));
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: "a".repeat(40),
  activeDeploymentId: "original-old", lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: "original-build", mediaLifecycleReady: true };
const oldRuntime = { schemaVersion: 1, phase: "ready", commitSha: pointer.activeCommitSha, serializerId: "original-primary",
  cloud: { phase: "ready", commitSha: pointer.activeCommitSha, serializerId: "cloudflare-dev-publisher" } };
const attempt = { schemaVersion: 1, operationId: "dev-first-pause", environment: "development", projectId: "njpbs-site-dev",
  oldRuntime, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const identity = { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
  privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap-operator" };
const packet = () => ({ schemaVersion: 1, kind: "dev-public-release-pause-operator", operatorCommitSha:
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: identity, attempt });
const apply = () => owner.pauseDevPublicRelease({ firestore: db, attempt });
const read = () => owner.readDevPublicReleasePause({ firestore: db, attempt });
const pausedRuntime = { ...oldRuntime, phase: "paused", cloud: { ...oldRuntime.cloud, phase: "paused" } };
const acceptedQueue = (status = "pending") => ({ status, transport: "post-no-build-v1",
  backgroundRuntime: { owner: "cloudflare", release: oldRuntime.commitSha }, commitSha: oldRuntime.commitSha, serializerId: oldRuntime.serializerId });
const nativeOperationId = "N".repeat(20);
const contextDigest = publicContextDigest(1);
const preparation = (status = "building", attempts = 1) => ({ schemaVersion: 1, contextDigest,
  runtime: { owner: "cloudflare", release: oldRuntime.commitSha }, status, attempts,
  claim: status === "building" ? "11111111-1111-4111-8111-111111111111" : null,
  nextAttemptAt: status === "verified" || attempts === 4 && status === "failed" ? null : Date.now() + 60_000,
  ...(status === "verified" ? { preparedDigest: "c".repeat(64) } : {}), admissionRevision: 1,
  reservation: { buildBatchId: "original-background", generation: 2, commitSha: oldRuntime.commitSha, cutoffAt: Timestamp.fromMillis(1000) } });
async function acceptNativeContext() {
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.runTransaction(async transaction => {
    const accepted = await contextOwner.enqueuePublicContextInTransaction({ firestore: db, transaction,
      operationId: nativeOperationId, runtime: { owner: "cloudflare", release: oldRuntime.commitSha }, reason: "settings", contextRevision: 1 });
    accepted.write();
  });
}
// Only the original accepted owner's terminal writes are simulated. The
// acceptance, task/output identities and pause/drain all use their real owners.
async function finishNativeContext() {
  const batch = db.batch();
  for (const output of contextOwner.OUTPUTS) {
    batch.update(db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundOutputs/${output}`), { status: "verified", claim: null, nextAttemptAt: null });
    batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: "verified" });
  }
  batch.update(db.doc(`cmsPublishQueue/${nativeOperationId}`), { status: "success" });
  await batch.commit();
}
async function acceptNativeHome() {
  const operationId = "H".repeat(20), runtime = { owner: "cloudflare", release: oldRuntime.commitSha };
  const operation = { schemaVersion: 1, operationId, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
    rendererSha: oldRuntime.commitSha, generation: 1, sourceVersion: 1, visible: true };
  const nextDocument = { status: "published", publiclyVisible: true, published: { sourceVersion: 1, metadata: {}, blocks: [] } };
  await db.runTransaction(async transaction => {
    const plan = await homeOwner.prepareHomePlanInTransaction({ firestore: db, transaction, nextDocument, operation, runtime });
    transaction.set(db.doc("system/publicDeployment/noBuildPageOwners/home"), { ...operation, runtime });
    transaction.set(db.doc(`cmsPublishQueue/${operationId}`), { status: "pending", transport: "page-no-build-v1", backgroundRuntime: runtime, noBuildPage: operation });
    transaction.set(db.doc("cmsPages/home"), nextDocument);
    plan!.write();
  });
  return operationId;
}
async function acceptNativeHomeRefresh() {
  await acceptNativeContext();
  const homeId = await acceptNativeHome(), sourceId = "P".repeat(20);
  await db.doc(`cmsPublishQueue/${homeId}`).update({ status: "success" });
  const post = { status: "published", publiclyVisible: true, published: { sourceVersion: 1, metadata: { slug: "native-post" } } };
  await db.doc(`cmsPublishQueue/${sourceId}`).set({ ...acceptedQueue(), noBuildPost: { postId: "native-post", operationId: sourceId, sourceVersion: 1 } });
  await db.runTransaction(async transaction => {
    const write = await homeOwner.prepareHomePostRefreshInTransaction({ firestore: db, transaction,
      postId: "native-post", nextDocument: post, queueId: sourceId, affectedSections: [] });
    write();
  });
  return { homeId, sourceId, ref: db.doc(`cmsPublishQueue/${sourceId}/homePageRefresh/home`) };
}
async function failNativeContext() {
  const task = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundOutputs/search`);
  await task.update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null, error: "background_retry_exhausted" });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "failed" });
  await db.doc(`cmsPublishQueue/${nativeOperationId}`).update({ status: "failed", error: "background_retry_exhausted" });
}
async function acceptPostProof(postProof: any) {
  await acceptNativeContext(); await finishNativeContext();
  const operationId = "R".repeat(20), ref = db.doc(`cmsPublishQueue/${operationId}`);
  await ref.set({ ...acceptedQueue("success"), claim: null, nextAttemptAt: null, postProof,
    noBuildPost: { postId: "proof-post", operationId, sourceVersion: 1, rendererSha: oldRuntime.commitSha, generation: 2, visible: true,
      slug: "proof-post", ownedSlugs: ["proof-post"] } });
  await db.doc("system/publicDeployment/noBuildPostOwners/proof-post").set({ schemaVersion: 1, servingEnabled: true,
    ...(await ref.get()).data()!.noBuildPost, runtime: { owner: "cloudflare", release: oldRuntime.commitSha } });
  return ref;
}
async function withPacket(run: (args: string[]) => Promise<void>, change = (value: any) => value) {
  const dir = await mkdtemp(join(tmpdir(), "dev-pause-"));
  try {
    const bytes = JSON.stringify(change(packet())), file = join(dir, "packet.json"); await writeFile(file, bytes);
    await run(["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc("system/cmsPublicationRuntime").set(oldRuntime);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
});
it("runs the exact source-pinned plan process before credentials or SDK authority", async () => {
  await withPacket(async args => {
    const output = execFileSync(process.execPath, ["scripts/pause-dev-public-release.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output)).toMatchObject({ kind: "dev-public-release-pause-result", mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0 });
    const readServiceAccount = vi.fn(), openDatabase = vi.fn();
    expect(await runDevPublicReleasePauseOperator(args, { readServiceAccount, openDatabase })).toMatchObject({ mode: "plan" });
    expect(readServiceAccount).not.toHaveBeenCalled(); expect(openDatabase).not.toHaveBeenCalled();
    expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  });
});
it.each(["njpbs-site", "demo-njpbs", "unrelated-project"])("refuses target %s before SDK use even on an emulator", async projectId => {
  const wrongApp = initializeApp({ projectId }, `refused-${projectId}`), wrongDb = getFirestore(wrongApp);
  const runTransaction = vi.spyOn(wrongDb, "runTransaction");
  try {
    await expect(owner.pauseDevPublicRelease({ firestore: wrongDb, attempt })).rejects.toThrow();
    await expect(owner.readDevPublicReleasePause({ firestore: wrongDb, attempt })).rejects.toThrow();
    expect(runTransaction).not.toHaveBeenCalled();
  } finally { runTransaction.mockRestore(); await deleteApp(wrongApp); }
  await withPacket(async args => {
    const readServiceAccount = vi.fn(), openDatabase = vi.fn();
    await expect(runDevPublicReleasePauseOperator([...args, "--apply"], { readServiceAccount, openDatabase })).rejects.toThrow();
    expect(readServiceAccount).not.toHaveBeenCalled(); expect(openDatabase).not.toHaveBeenCalled();
    try {
      execFileSync(process.execPath, ["scripts/pause-dev-public-release.mjs", ...args, "--apply"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      throw new Error("Expected refusal");
    } catch (error: any) { expect(error.status).toBe(1); expect(error.stdout).toBe(""); expect(error.stderr).toMatch(/^Development public pause\/drain was not confirmed;/); }
  }, value => ({ ...value, credentialIdentity: { ...identity, projectId }, attempt: { ...attempt, projectId } }));
});
it.each(["source", "cloud-source", "primary-identity", "cloud-identity", "pointer", "phase", "missing-cloud"])("refuses changed OLD %s with no pause or fence writes", async change => {
  const pins: any = structuredClone(oldRuntime);
  if (change === "source") pins.commitSha = "c".repeat(40);
  if (change === "cloud-source") pins.cloud.commitSha = "c".repeat(40);
  if (change === "primary-identity") pins.serializerId = "another-primary";
  if (change === "cloud-identity") pins.cloud.serializerId = "cloudflare-publisher";
  if (change === "phase") pins.phase = "starting";
  if (change === "missing-cloud") delete pins.cloud;
  await db.doc("system/cmsPublicationRuntime").set(pins);
  if (change === "pointer") await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pins);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  expect((await db.collection("system/devPublicReleasePause/attempts").get()).empty).toBe(true);
});
it("pauses both OLD controls, drains accepted work and acquires the original first-install fences", async () => {
  await db.doc("cmsPublishQueue/accepted-old").set({ status: "success", claim: null, commitSha: oldRuntime.commitSha, serializerId: oldRuntime.serializerId });
  await db.doc("cmsBackgroundOutputs/feed").set({ status: "verified", claim: null });
  const beforeQueue = (await db.doc("cmsPublishQueue/accepted-old").get()).data();
  const result = await apply();
  expect(result).toMatchObject({ idempotent: false, pauseCommitted: true, drainCommitted: true,
    ownsPausedRuntime: true, ownsClosedFence: true, currentReady: true,
    receipt: { acceptedWorkChanged: 0, counts: { queues: 1, outputs: 1 } } });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pausedRuntime);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
  expect((await db.doc("cmsPublishQueue/accepted-old").get()).data()).toEqual(beforeQueue);
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).data()).toMatchObject({ operationId: attempt.operationId,
    attemptDigest: result.receipt.bootstrapAttemptDigest });
  await db.runTransaction(transaction => adoption.assertClosedBootstrapFenceInTransaction({ firestore: db, transaction,
    environment: "development", before: pointer, operationId: attempt.operationId }));
  expect((await db.doc("system/publicReleaseChanges").get()).exists).toBe(false);
});
it.each(["public_unconfirmed", "failure", "deployed"])("preserves canonical settled %s GitHub history without inventing public success", async status => {
  const queue = { status, transport: "github", claim: null, environment: "development", projectId: "njpbs-site-dev",
    runtime: { owner: "cloudflare", release: oldRuntime.commitSha }, commitSha: oldRuntime.commitSha };
  await db.doc("cmsPublishQueue/historical-github").set(queue);
  expect(await apply()).toMatchObject({ pauseCommitted: true, drainCommitted: true, currentReady: true,
    receipt: { counts: { queues: 1 }, acceptedWorkChanged: 0 } });
  expect((await db.doc("cmsPublishQueue/historical-github").get()).data()).toEqual(queue);
});
it.each([
  ["cmsPublishQueue/pending", acceptedQueue()],
  ["cmsPublishQueue/retry", { status: "failed", nextAttemptAt: 123 }],
  ["system/publicDeployment/buildBatches/pending", { status: "reserved" }],
  ["system/publicDeployment/buildBatches/retired", { status: "retired", retirementReceipt: {} }],
  ["cmsPublicationSerializerJournals/original-primary", { job: { queueId: "original" } }],
  ["cmsPublicationSerializerJournals/cloudflare-dev-publisher", { job: { queueId: "original-cloud" } }],
  ["cmsPublicationSerializerJournals/cloudflare-dev-publisher/releases/pending", { status: "pending" }],
  ["system/publicDeployment/externalRefresh/current", { schemaVersion: 1, status: "pending" }],
  ["cmsBackgroundOutputs/search", { status: "building" }],
  ["cmsBackgroundOutputs/feed", { status: "verified", claim: "original-claim" }],
  ["cmsBackgroundOutputs/home", { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home", operationId: "x".repeat(20) }],
])("preserves work at %s, preflights blockers and acquires no fences", async (path, value) => {
  await db.doc(path).set(value);
  await expect(apply()).rejects.toThrow();
  expect((await db.doc(path).get()).data()).toEqual(value);
  const didPause = path === "cmsPublishQueue/pending";
  expect(await read()).toMatchObject({ pauseCommitted: didPause, drainCommitted: false, ownsPausedRuntime: didPause, ownsClosedFence: false });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(didPause ? pausedRuntime : oldRuntime);
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
});
it("lets the original accepted owner finish after pause, then completes the same attempt", async () => {
  await acceptNativeContext();
  const ref = db.doc(`cmsPublishQueue/${nativeOperationId}`), before = (await ref.get()).data();
  const outputs = (await db.collection("cmsBackgroundOutputs").get()).docs.map(row => row.data());
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, ownsPausedRuntime: true });
  expect((await ref.get()).data()).toEqual(before);
  expect((await db.collection("cmsBackgroundOutputs").get()).docs.map(row => row.data())).toEqual(outputs);
  await finishNativeContext();
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true });
  expect((await ref.get()).data()).toEqual({ ...before, status: "success" });
  expect((await db.collection("admin_logs").get()).size).toBe(2);
});
it.each(["exhausted", "expired-final-claim", "wrong-runtime", "wrong-context", "missing-attempts", "invalid-checkpoint"])("refuses %s background preparation before pausing", async change => {
  await acceptNativeContext();
  const ref = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundPreparation/${contextDigest}`), value: any = preparation();
  if (change === "exhausted") Object.assign(value, preparation("failed", 4));
  if (change === "expired-final-claim") Object.assign(value, preparation("building", 4), { nextAttemptAt: 0 });
  if (change === "wrong-runtime") value.runtime.release = "d".repeat(40);
  if (change === "wrong-context") value.contextDigest = "d".repeat(64);
  if (change === "missing-attempts") delete value.attempts;
  if (change === "invalid-checkpoint") Object.assign(value, preparation("verified"), { preparedDigest: "invalid" });
  await ref.set(value);
  await expect(apply()).rejects.toThrow();
  expect((await ref.get()).data()).toEqual(value);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, stop: false });
});
it.each([["building", 1], ["failed", 1], ["pending", 0], ["building", 4]])("preserves retryable %s preparation attempt %s and waits for its original completion", async (status, attempts) => {
  await acceptNativeContext();
  const ref = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundPreparation/${contextDigest}`), value = preparation(status as string, attempts as number);
  await ref.set(value);
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, stop: false });
  expect((await ref.get()).data()).toEqual(value);
  await finishNativeContext();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ drainCommitted: false, stop: false, ownsClosedFence: false });
  await ref.set(preparation("verified", attempts as number));
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true, stop: false });
});
it.each(["context-failed", "post-failed", "post-expired-claim"])("records %s preparation exhaustion after pause as an immutable named STOP", async kind => {
  let operationId = nativeOperationId;
  if (kind.startsWith("post")) {
    const post = await acceptPostProof({ status: "verified", attempts: 1, claim: null, nextAttemptAt: null });
    operationId = post.id;
    await post.update({ status: "pending", attempts: 0, claim: null, nextAttemptAt: 0, postProof: FieldValue.delete() });
  } else await acceptNativeContext();
  await expect(apply()).rejects.toThrow();
  const ref = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`), value = kind === "post-expired-claim"
    ? { ...preparation("building", 4), nextAttemptAt: 0 } : preparation("failed", 4);
  await ref.set(value);
  const result = await apply();
  expect(result).toMatchObject({ stop: true, drainCommitted: false, currentReady: false, recoveryIssue: 4471 });
  expect(result.failureReceipt.blockers).toContainEqual({ code: "background-preparation-exhausted", operationId, path: ref.path });
  expect((await ref.get()).data()).toEqual(value);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pausedRuntime);
  expect(await apply()).toMatchObject({ idempotent: true, failureReceiptDigest: result.failureReceiptDigest });
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
});
it("ignores an exhausted historical preparation for a different public context", async () => {
  await acceptNativeContext(); await finishNativeContext();
  const ref = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundPreparation/${"d".repeat(64)}`);
  const value = { ...preparation("failed", 4), contextDigest: "d".repeat(64) }; await ref.set(value);
  expect(await apply()).toMatchObject({ drainCommitted: true, stop: false });
  expect((await ref.get()).data()).toEqual(value);
});
it.each(["missing-task", "missing-attempts", "missing-retry", "wrong-runtime", "wrong-revision", "foreign-queue", "exhausted-task", "expired-final-claim"])("refuses a native acceptance's %s before pause", async change => {
  await acceptNativeContext();
  const task = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundOutputs/search`);
  if (change === "missing-task") await task.delete();
  if (["missing-attempts", "missing-retry"].includes(change)) {
    const data = (await task.get()).data()!; delete data[change === "missing-attempts" ? "attempts" : "nextAttemptAt"];
    await task.set(data);
  }
  if (change === "wrong-runtime") await task.update({ "runtime.release": "c".repeat(40) });
  if (change === "wrong-revision") await task.update({ revision: 99 });
  if (change === "foreign-queue") await db.doc("cmsBackgroundOutputs/search").update({ taskPath: "cmsPublishQueue/foreign/backgroundOutputs/search" });
  if (change === "exhausted-task") await task.update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
  if (change === "expired-final-claim") await task.update({ status: "pending", attempts: 4,
    claim: "11111111-1111-4111-8111-111111111111", nextAttemptAt: 0 });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false });
});
it.each([1, 4])("preserves an original native output claim on attempt %s while pausing admission", async attempts => {
  await acceptNativeContext();
  const ref = db.doc(`cmsPublishQueue/${nativeOperationId}/backgroundOutputs/search`);
  await ref.update({ claim: "11111111-1111-4111-8111-111111111111", attempts, nextAttemptAt: Date.now() + 60_000 });
  const task = (await ref.get()).data();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, ownsClosedFence: false });
  expect((await ref.get()).data()).toEqual(task);
});
it("pauses with a real Home marker and pending original Home Page queue", async () => {
  await acceptNativeContext();
  const homeId = await acceptNativeHome();
  const marker = (await db.doc("cmsBackgroundOutputs/home").get()).data();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false });
  expect((await db.doc("cmsBackgroundOutputs/home").get()).data()).toEqual(marker);
  await finishNativeContext();
  await db.doc(`cmsPublishQueue/${homeId}`).update({ status: "success" });
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true });
});
it("retains native Home refresh work under its original Post and Page identities", async () => {
  const { sourceId, ref } = await acceptNativeHomeRefresh(), original = (await ref.get()).data();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false });
  expect((await ref.get()).data()).toEqual(original);
  await finishNativeContext();
  await db.doc(`cmsPublishQueue/${sourceId}`).update({ status: "success" });
  await ref.update({ status: "verified", claim: null, nextAttemptAt: null });
  await db.doc("system/publicDeployment/noBuildPageOwners/home").update({ "homeRefresh.status": "verified" });
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true });
});
it("records an immutable paused/failed STOP when native work exhausts after pause", async () => {
  await acceptNativeContext(); await expect(apply()).rejects.toThrow(); await failNativeContext();
  const before = (await db.doc(`cmsPublishQueue/${nativeOperationId}`).get()).data();
  const result = await apply();
  expect(result).toMatchObject({ stop: true, outcome: "paused-failed", recoveryIssue: 4471,
    pauseCommitted: true, drainCommitted: false, currentReady: false, ownsPausedRuntime: true, ownsClosedFence: false,
    failureReceipt: { kind: "dev-public-release-pause-failed", operations: [nativeOperationId], acceptedWorkChanged: 0 } });
  expect(result.failureReceipt.blockers).toContainEqual({ code: "background-exhausted", operationId: nativeOperationId,
    path: `cmsPublishQueue/${nativeOperationId}/backgroundOutputs/search` });
  expect((await db.doc(`cmsPublishQueue/${nativeOperationId}`).get()).data()).toEqual(before);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pausedRuntime);
  expect((await db.doc("system/publicReleaseChanges").get()).exists).toBe(false);
  expect((await db.doc("system/devPublicReleasePause/drains/dev-first-pause").get()).exists).toBe(false);
  expect(await apply()).toMatchObject({ idempotent: true, failureReceipt: result.failureReceipt, failureReceiptDigest: result.failureReceiptDigest });
  expect(await read()).toMatchObject({ stop: true, drainCommitted: false, failureReceiptDigest: result.failureReceiptDigest });
  expect((await db.collection("admin_logs").get()).size).toBe(2);
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e",
      "import {writePauseResult} from './scripts/pause-dev-public-release.mjs';writePauseResult(JSON.parse(process.argv[1]));", JSON.stringify(result)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    throw new Error("Expected STOP exit");
  } catch (error: any) {
    expect(error.status).toBe(2); expect(JSON.parse(error.stdout)).toMatchObject({ stop: true, drainCommitted: false });
    expect(error.stderr).toContain("#4471"); expect(error.stderr).toContain("STOP:");
  }
});
it.each(["pending", "failed"])("waits for an original Post's nested %s public check despite queue success", async status => {
  const ref = await acceptPostProof({ status, attempts: 1, claim: status === "pending" ? "11111111-1111-4111-8111-111111111111" : null,
    nextAttemptAt: Date.now() + 60_000 });
  const original = (await ref.get()).data();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, stop: false, ownsClosedFence: false });
  expect((await ref.get()).data()).toEqual(original);
  await ref.update({ postProof: { status: "verified", attempts: 1, claim: null, nextAttemptAt: null } });
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true, stop: false });
});
it("refuses an already exhausted Post public check before pausing", async () => {
  await acceptPostProof({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, stop: false });
});
it.each(["missing", "superseded", "aggregate-alias", "duplicate-legacy"])("refuses an unfinished Post proof with a %s owner before pausing", async change => {
  const ref = await acceptPostProof({ status: "pending", attempts: 1, claim: null, nextAttemptAt: Date.now() + 60_000 });
  const ownerRef = db.doc("system/publicDeployment/noBuildPostOwners/proof-post"), original = (await ref.get()).data();
  if (change === "duplicate-legacy") await db.doc("system/publicDeployment/noBuildPosts/current").set((await ownerRef.get()).data()!);
  else if (change === "superseded") await ownerRef.update({ operationId: "S".repeat(20), sourceVersion: 2 });
  else {
    await ownerRef.delete();
    if (change === "aggregate-alias") await db.doc("system/publicDeployment/aggregateContexts/current").set({ operationId: ref.id });
  }
  await expect(apply()).rejects.toThrow();
  expect((await ref.get()).data()).toEqual(original);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, stop: false });
});
it("lets a legacy current Post owner finish its original proof after pause", async () => {
  const ref = await acceptPostProof({ status: "failed", attempts: 1, claim: null, nextAttemptAt: Date.now() + 60_000 });
  const ownerRef = db.doc("system/publicDeployment/noBuildPostOwners/proof-post");
  await db.doc("system/publicDeployment/noBuildPosts/current").set((await ownerRef.get()).data()!);
  await ownerRef.delete();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, stop: false });
  await ref.update({ postProof: { status: "verified", attempts: 1, claim: null, nextAttemptAt: null } });
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true, stop: false });
});
it("records an exhausted Post public check after pause as a named STOP", async () => {
  const ref = await acceptPostProof({ status: "pending", attempts: 1, claim: null, nextAttemptAt: Date.now() + 60_000 });
  await expect(apply()).rejects.toThrow();
  await ref.update({ postProof: { status: "failed", attempts: 4, claim: null, nextAttemptAt: null } });
  const failed = await apply();
  expect(failed).toMatchObject({ stop: true, drainCommitted: false, currentReady: false, failureReceipt: { operations: [ref.id] } });
  expect(failed.failureReceipt.blockers).toEqual([{ code: "queue-failed", operationId: ref.id, path: ref.path }]);
  expect((await ref.get()).data()?.status).toBe("success");
});
it("accepts a Post proof superseded by its native recheck owner without relabeling it", async () => {
  const ref = await acceptPostProof({ status: "superseded", attempts: 4, claim: null, nextAttemptAt: null });
  const original = (await ref.get()).data();
  expect(await apply()).toMatchObject({ drainCommitted: true, stop: false });
  expect((await ref.get()).data()).toEqual(original);
});
it.each(["other-pending", "other-finished", "transient-error"])("stops deterministically for a new queue-only failure with %s", async timing => {
  await acceptNativeContext();
  const pageId = "Q".repeat(20), page = { ...acceptedQueue(), transport: "page-no-build-v1",
    noBuildPage: { pageId: "about", operationId: pageId, sourceVersion: 1, rendererSha: oldRuntime.commitSha,
      path: "/about", ownedPaths: ["/about"], generation: 2, visible: true, snapshotDigest: "e".repeat(64), contextQueueId: nativeOperationId } };
  await db.doc(`cmsPublishQueue/${pageId}`).set(page);
  await expect(apply()).rejects.toThrow();
  await db.doc(`cmsPublishQueue/${pageId}`).update({ status: "failed", nextAttemptAt: null, claim: null });
  if (timing !== "other-pending") await finishNativeContext();
  let calls = 0;
  const boundary = timing !== "transient-error" ? db : new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      if (++calls === 2) throw new Error("synthetic unrelated transport failure");
      return (target.runTransaction as any)(...args);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = await owner.pauseDevPublicRelease({ firestore: boundary, attempt });
  expect(result).toMatchObject({ stop: true, drainCommitted: false, currentReady: false, failureReceipt: { operations: [pageId] } });
  expect(result.failureReceipt.blockers).toEqual([{ code: "queue-failed", operationId: pageId, path: `cmsPublishQueue/${pageId}` }]);
  expect((await db.doc("system/devPublicReleasePause/drains/dev-first-pause").get()).exists).toBe(false);
});
it.each(["failed", "public_unconfirmed"])("keeps pre-pause native %s history terminal while other work drains", async status => {
  await acceptNativeContext();
  const history = { ...acceptedQueue(), status, transport: "page-no-build-v1", nextAttemptAt: null, claim: null };
  await db.doc("cmsPublishQueue/historical-page").set(history);
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ stop: false, pauseCommitted: true, drainCommitted: false });
  await finishNativeContext();
  expect(await apply()).toMatchObject({ stop: false, drainCommitted: true });
  expect((await db.doc("cmsPublishQueue/historical-page").get()).data()).toEqual(history);
});
it.each(["failed", "public_unconfirmed"])("keeps historical %s terminal after staff recheck metadata changes", async status => {
  await acceptNativeContext();
  const ref = db.doc("cmsPublishQueue/historical-rechecked-page");
  await ref.set({ ...acceptedQueue(), status, transport: "page-no-build-v1", nextAttemptAt: null, claim: null });
  await expect(apply()).rejects.toThrow();
  const original = await read();
  expect(original.pauseReceipt.initialQueueFailures).toEqual([{ operationId: ref.id, status }]);
  // The native staff recheck writes this metadata even when the check still fails.
  await ref.update({ lastPublicCheck: { outcome: "failed", actorUid: "staff-check", checkedAt: FieldValue.serverTimestamp() } });
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ stop: false, drainCommitted: false, pauseReceipt: original.pauseReceipt });
  await finishNativeContext();
  await ref.update({ lastPublicCheck: { outcome: "failed", actorUid: "staff-check", checkedAt: FieldValue.serverTimestamp() } });
  const drained = await apply();
  expect(drained).toMatchObject({ stop: false, drainCommitted: true, pauseReceipt: original.pauseReceipt,
    receipt: { pauseReceiptDigest: p.publicReleaseDigest(original.pauseReceipt) } });
  expect((await ref.get()).data()?.status).toBe(status);
});
it.each(["post", "legacy-post", "page", "aggregate"])("refuses a retryable current %s failure before the pause", async kind => {
  await acceptNativeContext(); await finishNativeContext();
  const operationId = kind === "aggregate" ? nativeOperationId : "S".repeat(20), ref = db.doc(`cmsPublishQueue/${operationId}`);
  if (kind === "aggregate") await ref.update({ status: "failed", nextAttemptAt: null, claim: null });
  else {
    await ref.set({ ...acceptedQueue(), status: "failed", attempts: 4, nextAttemptAt: null, claim: null,
      transport: kind === "page" ? "page-no-build-v1" : "post-no-build-v1" });
    const path = kind === "page" ? "system/publicDeployment/noBuildPageOwners/contact"
      : kind === "legacy-post" ? "system/publicDeployment/noBuildPosts/current" : "system/publicDeployment/noBuildPostOwners/retryable-post";
    await db.doc(path).set({ schemaVersion: 1, operationId, mode: "dynamic" });
  }
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false });
  // Original staff retry/failure can occur while ready, never under this pause.
  await ref.update({ status: "pending", attempts: 0, nextAttemptAt: 0 });
  await ref.update({ status: "failed", attempts: 4, nextAttemptAt: null });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  await ref.update({ status: "success" });
  expect(await apply()).toMatchObject({ stop: false, drainCommitted: true });
});
it("refuses a failed alias retained by the current aggregate owner before pause", async () => {
  await acceptNativeContext(); await finishNativeContext();
  const alias = "A".repeat(20), original = (await db.doc(`cmsPublishQueue/${nativeOperationId}`).get()).data()!;
  await db.doc(`cmsPublishQueue/${alias}`).set({ ...original, status: "failed", publicContext: { ...original.publicContext, operationId: alias } });
  await db.doc("system/publicDeployment/aggregateContexts/current").update({ operationIds: [nativeOperationId, alias] });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false });
});
it("recovers a lost failure receipt response without repeating any original-work write", async () => {
  await acceptNativeContext(); await expect(apply()).rejects.toThrow(); await failNativeContext();
  let dropped = false;
  const lostResponseDb = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const value = await (target.runTransaction as any)(...args);
      if (value?.receipt?.kind === "dev-public-release-pause-failed" && !dropped) { dropped = true; throw new Error("lost failure receipt reply"); }
      return value;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(owner.pauseDevPublicRelease({ firestore: lostResponseDb, attempt })).rejects.toThrow("lost failure receipt reply");
  const first = await read(), row = await db.doc("system/devPublicReleasePause/failures/dev-first-pause").get();
  expect(first).toMatchObject({ stop: true, drainCommitted: false });
  expect(await apply()).toMatchObject({ idempotent: true, failureReceiptDigest: first.failureReceiptDigest });
  expect((await db.doc("system/devPublicReleasePause/failures/dev-first-pause").get()).updateTime).toEqual(row.updateTime);
});
it("keeps a failed attempt stopped even if original tasks later finish", async () => {
  await acceptNativeContext(); await expect(apply()).rejects.toThrow(); await failNativeContext();
  const failed = await apply(); await finishNativeContext();
  expect(await apply()).toMatchObject({ idempotent: true, stop: true, drainCommitted: false, failureReceipt: failed.failureReceipt });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pausedRuntime);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
});
it("names both original Home refresh and Home owner operations in the STOP", async () => {
  const { homeId, sourceId, ref } = await acceptNativeHomeRefresh();
  await expect(apply()).rejects.toThrow();
  await ref.update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
  const failed = await apply();
  expect(failed).toMatchObject({ stop: true, drainCommitted: false, failureReceipt: { operations: [homeId, sourceId] } });
  expect(failed.failureReceipt.blockers).toContainEqual({ code: "home-refresh-exhausted", operationId: sourceId, path: ref.path });
  expect((await ref.get()).data()?.status).toBe("failed");
});
it("refuses an overwritten immutable failure outcome", async () => {
  await acceptNativeContext(); await expect(apply()).rejects.toThrow(); await failNativeContext(); await apply();
  await db.doc("system/devPublicReleasePause/failures/dev-first-pause").update({ recoveryIssue: 1 });
  await expect(read()).rejects.toThrow(); await expect(apply()).rejects.toThrow();
});
it("reconciles lost replies after the pause, fence close and final commit without repeating writes", async () => {
  await acceptNativeContext();
  await expect(apply()).rejects.toThrow();
  const firstPause = (await db.doc("system/devPublicReleasePause/attempts/dev-first-pause").get()).updateTime;
  await finishNativeContext();
  // Crash after the existing close owner committed but before drain receipt.
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: { schemaVersion: 2, operationId: attempt.operationId,
    environment: "development", legacyPointerDigest: attempt.legacyPointerDigest } });
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: false, ownsClosedFence: true });
  let dropped = false;
  const lostResponseDb = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const result = await (target.runTransaction as any)(...args);
      if (result?.drainCommitted && !dropped) { dropped = true; throw new Error("synthetic lost response after commit"); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(owner.pauseDevPublicRelease({ firestore: lostResponseDb, attempt })).rejects.toThrow("synthetic lost response after commit");
  expect(dropped).toBe(true);
  const saved = await read();
  expect(await apply()).toMatchObject({ idempotent: true, receipt: saved.receipt, receiptDigest: saved.receiptDigest });
  expect(await read()).toEqual(saved);
  expect((await db.doc("system/devPublicReleasePause/attempts/dev-first-pause").get()).updateTime).toEqual(firstPause);
  expect((await db.collection("admin_logs").get()).size).toBe(2);
});
it("keeps immutable original receipts separate from later runtime/fence progress and never reopens or re-pauses", async () => {
  const first = await apply();
  await db.doc("system/cmsPublicationRuntime").update({ commitSha: "c".repeat(40), "cloud.commitSha": "c".repeat(40), phase: "ready", "cloud.phase": "ready" });
  const fenceRef = db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH), fence = (await fenceRef.get()).data()!;
  await fenceRef.set({ ...fence, status: "open", resumeReceiptDigest: "d".repeat(64) });
  await db.doc("system/publicDeployment/releaseWriter/fence").delete();
  expect(await read()).toMatchObject({ pauseCommitted: true, drainCommitted: true, ownsPausedRuntime: false,
    ownsClosedFence: false, currentReady: false, receipt: first.receipt });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()?.phase).toBe("ready");
  expect((await fenceRef.get()).data()?.status).toBe("open");
});
it("refuses changed original attempts and overwritten immutable receipts", async () => {
  await apply();
  await expect(owner.readDevPublicReleasePause({ firestore: db, attempt: { ...attempt, legacyPointerDigest: "e".repeat(64) } })).rejects.toThrow();
  const ref = db.doc("system/devPublicReleasePause/attempts/dev-first-pause"), value = (await ref.get()).data()!;
  await ref.set({ ...value, extra: true });
  await expect(read()).rejects.toThrow(); await expect(apply()).rejects.toThrow();
});
it("reuses the original close owner after a valid pre-enrollment abandonment", async () => {
  const previous = { schemaVersion: 2, operationId: "previous-owned-attempt", environment: "development", legacyPointerDigest: attempt.legacyPointerDigest };
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: previous });
  await adoption.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: previous });
  expect(await apply()).toMatchObject({ drainCommitted: true, currentReady: true });
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.operationId).toBe(attempt.operationId);
});
it("refuses an opened fence without its original abandonment receipt before pausing", async () => {
  await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).set({ schemaVersion: 2, operationId: "unproven-open",
    attemptDigest: "e".repeat(64), status: "open", resumeReceiptDigest: "f".repeat(64) });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false });
});
it("refuses an exhausted failed background output before pausing either control", async () => {
  const taskPath = "cmsPublishQueue/accepted/backgroundOutputs/search-1";
  await db.doc(taskPath).set({ owner: "post-no-build-v1", schemaVersion: 1, status: "failed", attempts: 4,
    claim: null, nextAttemptAt: null, error: "background_retry_exhausted" });
  const output = { owner: "post-no-build-v1", schemaVersion: 1, status: "failed", taskPath };
  await db.doc("cmsBackgroundOutputs/search").set(output);
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect((await db.doc("cmsBackgroundOutputs/search").get()).data()).toEqual(output);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, currentReady: false });
});
it("refuses oversized immutable queue history before pausing either control", async () => {
  for (let start = 0; start < 1001; start += 400) {
    const batch = db.batch();
    for (let index = start; index < Math.min(start + 400, 1001); index++) batch.create(db.doc(`cmsPublishQueue/terminal-${index}`), { status: "success" });
    await batch.commit();
  }
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, currentReady: false });
});
it.each([
  { ...acceptedQueue(), transport: "github", environment: "development", projectId: "njpbs-site-dev", runtime: { owner: "cloudflare", release: oldRuntime.commitSha } },
  { ...acceptedQueue("reserved"), transport: "serializer" },
  { ...acceptedQueue("publishing"), transport: "github" },
  { ...acceptedQueue(), homeFullBuild: { status: "reserved", queueId: "original-home-build" } },
  { ...acceptedQueue(), artifactBuild: { buildBatchId: "original-build" } },
  { ...acceptedQueue(), backgroundRuntime: { owner: "node-compute", release: oldRuntime.commitSha } },
  { ...acceptedQueue(), backgroundRuntime: { owner: "cloudflare", release: "c".repeat(40) } },
  { ...acceptedQueue(), transport: "unknown" },
])("refuses pointer-mutating or non-OLD accepted queue before pausing: %j", async queue => {
  await db.doc("cmsPublishQueue/pointer-mutating-accepted").set(queue);
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
  expect((await db.doc("cmsPublishQueue/pointer-mutating-accepted").get()).data()).toEqual(queue);
  expect(await read()).toMatchObject({ pauseCommitted: false, drainCommitted: false, currentReady: false });
});
it.each(["system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog"])("refuses preexisting enrollment/producer authority at %s", async path => {
  await db.doc(path).set({ schemaVersion: 1 });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
});
it("validates the explicit target and original split runtime in the packet", () => {
  expect(parseDevPublicReleasePausePacket(packet()).attempt).toEqual(attempt);
  for (const bad of [{ ...attempt, environment: "production" }, { ...attempt, oldRuntime: { ...oldRuntime, cloud: { ...oldRuntime.cloud, serializerId: "cloudflare-publisher" } } }]) {
    expect(() => parseDevPublicReleasePausePacket({ ...packet(), attempt: bad })).toThrow();
  }
  expect(p.publicReleaseDigest(attempt)).toMatch(/^[a-f0-9]{64}$/);
});

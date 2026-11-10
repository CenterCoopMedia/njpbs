import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import owner from "../../scripts/lib/dev-public-predecessor.cjs";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import manifests from "../../functions/lib/public-media-manifest.js";
import manifestStore from "../../functions/lib/public-media-manifest-store.js";
import candidateStore from "../../functions/lib/public-worker-candidate-store.js";
import candidates from "../../functions/lib/public-worker-candidate.js";
import outcomes from "../../functions/lib/public-deployment-outcome-store.js";
import targets from "../../functions/lib/publication-target.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-public-predecessor-test");
const db = getFirestore(app), target = targets.publicationTarget("development");
const sha = "a".repeat(40), runtime = { owner: "cloudflare", release: sha };
const oldRuntime = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "original-dev-primary",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
const buildBatchId = "original-dev-baseline", batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const deploymentId = "33333333-3333-4333-8333-333333333333", versionId = "22222222-2222-4222-8222-222222222222";
const savedPath = "system/devPublicPredecessor/initializations/";
let retained: any, request: any;
const apply = (step = "runtime", value = request) => owner.initializeDevPublicPredecessor({ firestore: db, step, request: value });
const read = (step = "runtime", value = request) => owner.readDevPublicPredecessor({ firestore: db, step, request: value });
const clear = () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
afterAll(() => deleteApp(app));
beforeAll(async () => {
  await clear();
  // The predecessor is produced by the real reservation/manifest/candidate/
  // activation owners; the initializer cannot manufacture a deployed baseline.
  const { batch } = await coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId, commitSha: sha, runtime, target });
  const inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const manifest = manifests.createPublicMediaManifest({ reservation: batch,
    artifactInventory: inventory.families.map(f => ({ collection: f.collection, complete: true, documentIds: f.artifacts.map(a => a.documentId) })), owners: inventory.owners });
  await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
  await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
  const publicReceiptBytes = JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId, generation: batch.generation,
    commitSha: sha, artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest }) + "\n";
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, runtime, target, candidate: {
    schemaVersion: 1, runtime, buildBatchId, generation: batch.generation, commitSha: sha, workerName: "template-dev-public",
    workerVersionId: versionId, workerVersionTag: candidates.publicWorkerCandidateTag({ generation: batch.generation, artifactDigest: "b".repeat(64) }),
    versionCreatedOn: "2026-11-01T12:00:00.000Z", artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64),
    publicationReceiptDigest: createHash("sha256").update(publicReceiptBytes).digest("hex"), mediaManifestDigest: manifest.mediaManifestDigest,
    artifactFileCount: 2, artifactBytes: 1000, wranglerVersion: "4.123.0" } });
  const acquisition = await coordinator.acquirePublicDeploymentLease({ firestore: db, buildBatchId, commitSha: sha, runtime, target });
  expect(acquisition.outcome).toBe("acquired");
  await outcomes.settlePublicDeploymentOutcome({ firestore: db, lease: acquisition.lease, runtime, target,
    evidence: { action: "activate", buildBatchId, deploymentId, versionId, commitSha: sha } });
  const paths = ["system/publicDeployment", batchPath, `${batchPath}/candidates/worker`];
  retained = await Promise.all(paths.map(async path => ({ path, data: (await db.doc(path).get()).data() })));
  request = { schemaVersion: 1, operationId: "original-dev-init", environment: "development", projectId: "njpbs-site-dev",
    oldRuntime, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(retained[0].data), publicReceiptBytes, deploymentId, versionId };
});
beforeEach(async () => {
  await clear();
  const batch = db.batch(); retained.forEach(row => batch.create(db.doc(row.path), row.data)); await batch.commit();
});
it("creates both exact ready OLD pins, then separately activates media with one audit per owner", async () => {
  const before = (await db.doc("system/publicDeployment").get()).data();
  expect(before!.mediaLifecycleReady).toBe(false); // R0 does not open the media fence.
  expect(await apply()).toMatchObject({ committed: true, currentReady: true });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(oldRuntime);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect(await apply("media-lifecycle")).toMatchObject({ committed: true, currentReady: true });
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual({ ...before, mediaLifecycleReady: true });
  expect((await db.doc(batchPath).get()).data()).toEqual(retained[1].data);
  expect((await db.doc(`${batchPath}/candidates/worker`).get()).data()).toEqual(retained[2].data);
  expect((await db.collection("admin_logs").get()).docs.map(d => d.data().action).sort()).toEqual([
    "public-release.dev-initialize-media-lifecycle", "public-release.dev-initialize-runtime"]);
  const pointer = (await db.doc("system/publicDeployment").get()).data();
  // Result satisfies the actual row09 packet and pointer prerequisites.
  expect(deployment.assertPublicDeploymentPointer(pointer).mediaLifecycleReady).toBe(true);
});
it.each(["njpbs-site", "demo-njpbs"])("refuses database %s before a transaction", async projectId => {
  const wrongApp = initializeApp({ projectId }, `wrong-${projectId}`);
  try {
    await expect(owner.initializeDevPublicPredecessor({ firestore: getFirestore(wrongApp), step: "runtime", request })).rejects.toThrow();
    await expect(owner.readDevPublicPredecessor({ firestore: getFirestore(wrongApp), step: "runtime", request })).rejects.toThrow();
  } finally { await deleteApp(wrongApp); }
});
it.each(["primary-source", "cloud-source", "cloud-serializer", "primary-cloud", "phase", "project", "environment", "receipt-source"])("rejects invalid requested %s", async field => {
  const changed = structuredClone(request);
  if (field === "primary-source") changed.oldRuntime.commitSha = "d".repeat(40);
  if (field === "cloud-source") changed.oldRuntime.cloud.commitSha = "d".repeat(40);
  if (field === "cloud-serializer") changed.oldRuntime.cloud.serializerId = "cloudflare-publisher";
  if (field === "primary-cloud") changed.oldRuntime.serializerId = "cloudflare-dev-publisher";
  if (field === "phase") changed.oldRuntime.cloud.phase = "starting";
  if (field === "project") changed.projectId = "njpbs-site";
  if (field === "environment") changed.environment = "production";
  if (field === "receipt-source") changed.publicReceiptBytes = changed.publicReceiptBytes.replace(sha, "d".repeat(40));
  await expect(apply("runtime", changed)).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
  expect((await db.collection("admin_logs").get()).empty).toBe(true);
});
it.each(["source", "reserved", "generation", "deployment", "candidate", "batch", "public-bytes", "head", "fence"])("refuses predecessor drift %s without initialization", async field => {
  let changed = request;
  if (field === "source") await db.doc("system/publicDeployment").update({ activeCommitSha: "d".repeat(40) });
  if (field === "reserved") await db.doc("system/publicDeployment").update({ lastReservedGeneration: 2 });
  if (field === "generation") await db.doc("system/publicDeployment").update({ activeGeneration: 2, newestEligibleGeneration: 2, lastReservedGeneration: 2 });
  if (field === "deployment") await db.doc("system/publicDeployment").update({ activeDeploymentId: "another-deployment" });
  if (field === "candidate") await db.doc(`${batchPath}/candidates/worker`).update({ workerName: "njpbs-production" });
  if (field === "batch") await db.doc(batchPath).update({ status: "ready" });
  if (field === "public-bytes") changed = { ...request, publicReceiptBytes: request.publicReceiptBytes + " " };
  if (field === "head") await db.doc("system/publicReleaseChanges").set({ schemaVersion: 2 });
  if (field === "fence") await db.doc("system/publicDeployment/releaseWriter/fence").set({ operationId: "another" });
  await expect(apply("runtime", changed)).rejects.toThrow();
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
  expect((await db.collection(savedPath.slice(0, -1)).get()).empty).toBe(true);
});
it("refuses existing controls, repeated applies and deleted-original recreation", async () => {
  await db.doc("system/cmsPublicationRuntime").set(oldRuntime);
  await expect(apply()).rejects.toThrow();
  await db.doc("system/cmsPublicationRuntime").delete();
  await apply(); await expect(apply()).rejects.toThrow();
  await db.doc("system/cmsPublicationRuntime").delete();
  await expect(apply()).rejects.toThrow();
  expect(await read()).toMatchObject({ committed: true, currentReady: false });
});
it("requires exact ready pins for media and never reopens a later false flag", async () => {
  await expect(apply("media-lifecycle")).rejects.toThrow();
  await apply();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  await expect(apply("media-lifecycle")).rejects.toThrow();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  await apply("media-lifecycle"); await expect(apply("media-lifecycle")).rejects.toThrow();
  await db.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
  await expect(apply("media-lifecycle")).rejects.toThrow();
  expect(await read("media-lifecycle")).toMatchObject({ committed: true, currentReady: false });
  expect((await db.collection("admin_logs").get()).size).toBe(2);
});
it("preserves original readback after pause, refuses rewritten receipts", async () => {
  await apply();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  expect(await read()).toMatchObject({ committed: true, currentReady: false });
  await db.doc(savedPath + "runtime").update({ requestDigest: "f".repeat(64) });
  await expect(read()).rejects.toThrow();
});
it("runs the clean pinned plan without SDK credentials and fails closed on tamper/wrong project before fd3", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-predecessor-cli-"));
  const env = { ...process.env };
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "FIREBASE_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[key];
  const packet: any = { schemaVersion: 1, kind: "dev-public-predecessor-operator", step: "runtime", operatorCommitSha:
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: { projectId: "njpbs-site-dev",
      clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev" }, request };
  const run = (value: any, extra: string[] = []) => {
    const bytes = JSON.stringify(value), file = join(dir, "packet.json"); writeFileSync(file, bytes);
    return spawnSync(process.execPath, ["scripts/initialize-dev-public-predecessor.mjs", "--packet", file,
      "--packet-digest", createHash("sha256").update(bytes).digest("hex"), ...extra], { env, encoding: "utf8" });
  };
  try {
    const plan = run(packet); expect(plan.status, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ mode: "plan", step: "runtime", authorityReads: 0, authorityWrites: 0, providerWrites: 0 });
    const wrong = structuredClone(packet); wrong.request.projectId = "njpbs-site";
    const refused = run(wrong, ["--apply"]); expect(refused.status).toBe(1); expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/^Development predecessor initialization was not confirmed;/);
    expect(run({ ...packet, operatorCommitSha: "f".repeat(40) }, ["--apply"]).status).toBe(1);
    expect(run(packet, ["--apply"]).status).toBe(1); // No inherited SDK pipe.
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

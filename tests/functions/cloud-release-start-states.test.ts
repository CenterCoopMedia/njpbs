import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { PreparedPublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { loseAnswer, releaseWrites } from "../helpers/lost-answer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact, verifyPreparedPublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { runNoBuildCloudRelease } from "../../site/scripts/no-build-cloud-release";
import { openCmsPublicationCloudTokenJournal } from "../../site/scripts/cms-publication-cloud-token-journal";
import * as sourceGuard from "../../site/scripts/cms-publication-runtime-guard";

const load = createRequire(import.meta.url);
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = load("../../functions/lib/public-deployment-coordinator.js");
const { assertMediaLifecycleDeploymentFence, assertPublicDeploymentPointer, initialPublicDeploymentPointer } = load("../../functions/lib/public-deployment-pointer.js");
const { assertPublicDeploymentRefusedCloudReleaseBatch } = load("../../functions/lib/public-deployment.js");
const { settlePublicDeploymentOutcome } = load("../../functions/lib/public-deployment-outcome-store.js");
const bootstrap = load("../../functions/lib/public-deployment-bootstrap.js");
const manifests = load("../../functions/lib/public-media-manifest.js");
const manifestStore = load("../../functions/lib/public-media-manifest-store.js");
const candidates = load("../../functions/lib/public-worker-candidate.js");
const candidateStore = load("../../functions/lib/public-worker-candidate-store.js");

const commitSha = "c".repeat(40), runtime = { owner: "cloudflare" as const, release: commitSha };
const queueId = "66666666666666666666", buildBatchId = `cms-${queueId}`, nextId = "77777777777777777777";
const pointerPath = "system/publicDeployment", batchPath = `${pointerPath}/buildBatches/${buildBatchId}`;
const requestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${queueId}`;
let db: ReturnType<typeof isolatedFirestore>, scratch: string;
beforeAll(async () => { db = isolatedFirestore("cloud-release-start-states.test.ts"); scratch = await mkdtemp(path.join(tmpdir(), "start-states-")); });
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  vi.spyOn(sourceGuard, "assertCmsPublicationSourceCheckout").mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The real reservation, media manifest and Worker candidate of one release. */
async function stageCandidate(id = queueId) {
  const { batch } = await reservePublicBuildBatch({ firestore: db, buildBatchId: `cms-${id}`, commitSha, runtime });
  const inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], programs: [], authors: [], settings: [], posts: [] } as never);
  const dist = path.join(scratch, randomUUID());
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<html>Release</html>");
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: dist, outputPath: `${dist}.json` } as never) as unknown as PreparedPublicWorkerArtifact & { digestAlgorithm?: string };
  const manifest = manifests.createPublicMediaManifest({ reservation: batch, owners: inventory.owners,
    artifactInventory: (inventory.families as { collection: string; artifacts: { documentId: string }[] }[]).map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(artifact => artifact.documentId) })) });
  await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
  await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
  const candidate: Record<string, unknown> = { schemaVersion: 1, runtime, ...prepared, workerName: "njpbs-production", workerVersionId: "33333333-3333-4333-8333-333333333333",
    workerVersionTag: candidates.publicWorkerCandidateTag(prepared), versionCreatedOn: "2026-10-09T04:00:00.000Z", wranglerVersion: "4.123.0" };
  delete candidate.digestAlgorithm;
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, candidate, runtime });
  expect(await pointer()).toMatchObject({ newestEligibleGeneration: batch.generation, newestEligibleBuildBatchId: `cms-${id}` });
  if (id === queueId) await db.doc(requestPath).set({ schemaVersion: 1, queueId, buildBatchId, runtime, commitSha, inputSha256: "c".repeat(64),
    artifactCheckpointDigest: "d".repeat(64), status: "pending", attempts: 0, nextAttemptAt: 0 });
  return { generation: batch.generation as number, prepared, dist };
}
const pointer = async () => (await db.doc(pointerPath).get()).data();
const journal = () => openCmsPublicationCloudTokenJournal({ firestore: db, serializerId: "cloudflare-publisher", runtime });
const run = (storage: object = { readInput: async () => Buffer.from("other bytes") }) => runNoBuildCloudRelease({ firestore: db,
  serializerId: "cloudflare-publisher", commitSha, stateDirectory: scratch, cloudflareApiToken: "fixture-token",
  previewStorageCredential: {} as never, storage: storage as never });
async function expectSettled(generation: number, eligibility: object) {
  expect(await (await journal()).read()).toBeNull();
  expect((await db.doc(requestPath).get()).data()).toMatchObject({ status: "failed", nextAttemptAt: null, refusalReceipt: { reason: "cloud_release_input_refused" } });
  const batch = (await db.doc(batchPath).get()).data();
  expect(assertPublicDeploymentRefusedCloudReleaseBatch(batch, buildBatchId)).toEqual(batch);
  expect(await pointer()).toMatchObject({ ...eligibility, lastReservedGeneration: generation });
  assertPublicDeploymentPointer(await pointer());
  const { batch: next } = await reservePublicBuildBatch({ firestore: db, buildBatchId: `cms-${nextId}`, commitSha, runtime });
  expect(next.generation).toBe(generation + 1);
}

it("ends a refused first release of an empty project and leaves the pointer at zero", async () => {
  expect((await db.doc(pointerPath).get()).exists).toBe(false);
  const { generation } = await stageCandidate();
  expect(await pointer()).toMatchObject({ activeGeneration: 0, activeCommitSha: null, activeDeploymentId: null });
  await run();
  await expectSettled(generation, { activeGeneration: 0, activeCommitSha: null, activeDeploymentId: null,
    newestEligibleGeneration: 0, newestEligibleBuildBatchId: null });
});

it("returns eligibility to a bootstrapped release that has no deployed batch", async () => {
  const buildUuid = "11111111-1111-4111-8111-111111111111", version = "22222222-2222-4222-8222-222222222222", script = "d".repeat(32);
  const evidence = bootstrap.projectPublicDeploymentBootstrapEvidence({ workerName: "njpbs-production", expectedExternalScriptId: script,
    deploymentsResponse: { success: true, result: { deployments: [{ id: "44444444-4444-4444-8444-444444444444", source: "wrangler", strategy: "percentage",
      created_on: "2026-08-27T17:56:07.218Z", annotations: { "workers/triggered_by": "deployment" }, versions: [{ version_id: version, percentage: 100 }] }] } },
    buildsByVersionResponse: { success: true, result: { builds: { [version]: { build_uuid: buildUuid, created_on: "2026-08-27T17:54:04.891Z", status: "stopped",
      build_outcome: "success", stopped_on: "2026-08-27T17:56:11.043Z", build_trigger_metadata: { branch: "production", commit_hash: "a".repeat(40) },
      trigger: { external_script_id: script } } } } } });
  await db.doc(pointerPath).set(initialPublicDeploymentPointer());
  await bootstrap.bootstrapPublicDeployment({ firestore: db, evidence });
  const active = await pointer();
  const { generation } = await stageCandidate();
  await run();
  const settledPointer = await pointer();
  await expectSettled(generation, { activeGeneration: active.activeGeneration, newestEligibleGeneration: active.activeGeneration,
    newestEligibleBuildBatchId: evidence.buildBatchId });
  // The admitted ordinary release, through its real candidate, lease and activation.
  await db.doc(pointerPath).update({ mediaLifecycleReady: true }); // A separate media activation does this after a bootstrap.
  expect(() => assertMediaLifecycleDeploymentFence({ ...settledPointer, mediaLifecycleReady: true })).toThrow();
  const next = await stageCandidate(nextId);
  const acquired = await acquirePublicDeploymentLease({ firestore: db, buildBatchId: `cms-${nextId}`, commitSha, runtime });
  expect(acquired.outcome).toBe("acquired");
  const outcome = await settlePublicDeploymentOutcome({ firestore: db, lease: acquired.lease, runtime, evidence: { action: "activate",
    buildBatchId: `cms-${nextId}`, deploymentId: "55555555-5555-4555-8555-555555555555", versionId: "33333333-3333-4333-8333-333333333333", commitSha } });
  expect(outcome.outcome).toBe("deployed");
  expect(assertMediaLifecycleDeploymentFence(await pointer())).toMatchObject({ generation: next.generation, commitSha });
});

const journalPath = "cmsPublicationSerializerJournals/cloudflare-publisher";
const refusedBytes = { readInput: async () => Buffer.from("other bytes") };
const providerFault = { readInput: async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); } };
it.each([
  ["claim", refusedBytes, "settled"], ["settlement", refusedBytes, "settled"], ["claim", providerFault, "retry"], ["retry", providerFault, "retry"],
  ["close", refusedBytes, "closed"], ["journal clear", refusedBytes, "closed"],
] as const)("keeps the %s write that landed without an answer (%#)", async (write, storage, end) => {
  const { generation } = await stageCandidate();
  if (end === "closed") {
    await (await journal()).reserve({ queueId, buildBatchId, commitSha });
    await db.doc(batchPath).update({ status: "failed" });
    await db.doc(requestPath).update({ failureReason: "activation: refused." });
  }
  const lost = await loseAnswer(db, { requestPath, journalPath, matches: releaseWrites[write] }, () => run(storage));
  expect(lost, `${write} landed`).not.toBeNull();
  // The same write again changes nothing that landed.
  const landed = (await db.doc(requestPath).get()).data();
  if (write !== "journal clear") expect(landed).toEqual(lost!.request);
  await run(storage);
  if (end !== "closed") expect((await db.doc(requestPath).get()).data()).toEqual(landed);
  if (write === "claim") { await db.doc(requestPath).update({ nextAttemptAt: 0 }); await run(storage); }
  if (end === "settled") return expectSettled(generation, { newestEligibleGeneration: 0, newestEligibleBuildBatchId: null });
  const request = (await db.doc(requestPath).get()).data()!;
  if (end === "closed") {
    expect(request).toMatchObject({ status: "failed", nextAttemptAt: null, failureReason: "activation: refused." });
    expect(await (await journal()).read()).toBeNull();
  } else {
    expect(request).toMatchObject({ status: "failed", attempts: write === "claim" ? 2 : 1 });
    expect(request.nextAttemptAt).toBeGreaterThan(Date.now());
    expect((await (await journal()).read())?.queueId).toBe(queueId);
  }
});

it("makes no release state without a pointer: the reservation writes both or neither", async () => {
  const begin = db.runTransaction.bind(db);
  (db as { runTransaction: unknown }).runTransaction = async (work: (tx: never) => Promise<unknown>) => (begin as (w: unknown) => Promise<unknown>)(
    async (tx: { set(ref: { path: string }, data: unknown): unknown }) => {
      const result = await work(tx as never);
      throw Object.assign(new Error(`aborted ${String(result)}`), { name: "Aborted" });
    });
  try { await expect(reservePublicBuildBatch({ firestore: db, buildBatchId, commitSha, runtime })).rejects.toThrow("aborted"); }
  finally { delete (db as { runTransaction?: unknown }).runTransaction; }
  expect((await db.doc(pointerPath).get()).exists).toBe(false);
  expect((await db.doc(batchPath).get()).exists).toBe(false);
  // Without its pointer the settlement decides nothing and the request stays with its owner.
  await stageCandidate();
  await db.doc(pointerPath).delete();
  await run();
  expect((await (await journal()).read())?.queueId).toBe(queueId);
  expect((await db.doc(batchPath).get()).data()).toMatchObject({ status: "ready" });
});

it("reads a local file fault inside the artifact check as a fault, not as refused bytes", async () => {
  const { prepared, dist } = await stageCandidate();
  await rm(dist, { recursive: true, force: true });
  await expect(verifyPreparedPublicWorkerArtifact({ preparedArtifact: prepared, distDirectory: dist }))
    .rejects.toMatchObject({ name: "PublicWorkerArtifactError", cause: { code: "ENOENT" } });
  const input = Buffer.from("sealed input");
  await db.doc(requestPath).update({ inputSha256: createHash("sha256").update(input).digest("hex") });
  await run({ readInput: async () => input, restoreArtifact: async (_identity: unknown, directory: string) => {
    await writeFile(path.join(directory, "prepared-worker.json"), JSON.stringify(prepared));
    return true;
  } });
  const request = (await db.doc(requestPath).get()).data();
  expect(request.refusalReceipt).toBeUndefined();
  expect(request.nextAttemptAt).toBeGreaterThan(Date.now());
  expect((await (await journal()).read())?.queueId).toBe(queueId);
});

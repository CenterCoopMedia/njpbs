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
import { supersedeUploadExhaustedCloudRelease } from "../../site/scripts/stage-cms-publication-cloud-release";
import * as sourceGuard from "../../site/scripts/cms-publication-runtime-guard";

const load = createRequire(import.meta.url);
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = load("../../functions/lib/public-deployment-coordinator.js");
const { assertMediaLifecycleDeploymentFence, assertPublicDeploymentPointer, initialPublicDeploymentPointer } = load("../../functions/lib/public-deployment-pointer.js");
const { assertPublicDeploymentRefusedCloudReleaseBatch, assertPublicDeploymentRetiredCloudReleaseBatch } = load("../../functions/lib/public-deployment.js");
const { settlePublicDeploymentOutcome } = load("../../functions/lib/public-deployment-outcome-store.js");
const { activatePublicMediaLifecycle, PUBLIC_RECEIPT_URL } = load("../../functions/lib/public-media-lifecycle-activation.js");
const { recoverCmsPublicationBaseline } = load("../../functions/lib/cms-publication-baseline-recovery.js");
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

const versionId = "33333333-3333-4333-8333-333333333333";
const activeId = "88888888888888888888", activeDeploymentId = "66666666-6666-4666-8666-666666666666";
/** The real reservation, media manifest and Worker candidate of one release,
 * or the state after a crash between them. Only the request row of the refused
 * release is written here: its writer stages a complete artifact first. */
async function stage(id = queueId, until: "reserved" | "manifest" | "candidate" = "candidate") {
  const { batch } = await reservePublicBuildBatch({ firestore: db, buildBatchId: `cms-${id}`, commitSha, runtime });
  if (id === queueId) await db.doc(requestPath).set({ schemaVersion: 1, queueId, buildBatchId, runtime, commitSha, inputSha256: "c".repeat(64),
    artifactCheckpointDigest: "d".repeat(64), status: "pending", attempts: 0, nextAttemptAt: 0 });
  const generation = batch.generation as number, inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], programs: [], authors: [], settings: [], posts: [] } as never);
  const dist = path.join(scratch, randomUUID());
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<html>Release</html>");
  const prepared = await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: dist, outputPath: `${dist}.json` } as never) as unknown as PreparedPublicWorkerArtifact & { digestAlgorithm?: string };
  if (until === "reserved") return { generation, prepared, dist };
  const manifest = manifests.createPublicMediaManifest({ reservation: batch, owners: inventory.owners,
    artifactInventory: (inventory.families as { collection: string; artifacts: { documentId: string }[] }[]).map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(artifact => artifact.documentId) })) });
  await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
  await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
  if (until === "manifest") return { generation, prepared, dist };
  const candidate: Record<string, unknown> = { schemaVersion: 1, runtime, ...prepared, workerName: "njpbs-production", workerVersionId: versionId,
    workerVersionTag: candidates.publicWorkerCandidateTag(prepared), versionCreatedOn: "2026-10-09T04:00:00.000Z", wranglerVersion: "4.123.0" };
  delete candidate.digestAlgorithm;
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, candidate, runtime });
  expect(await pointer()).toMatchObject({ newestEligibleGeneration: generation, newestEligibleBuildBatchId: `cms-${id}` });
  return { generation, prepared, dist };
}
const stageCandidate = (id = queueId) => stage(id);
async function acquire(id: string) {
  const acquired = await acquirePublicDeploymentLease({ firestore: db, buildBatchId: `cms-${id}`, commitSha, runtime });
  expect(acquired.outcome).toBe("acquired");
  return acquired.lease;
}
const settle = (lease: unknown, evidence: object) => settlePublicDeploymentOutcome({ firestore: db, lease, runtime, evidence });
const activate = async (id: string, deploymentId: string) => expect((await settle(await acquire(id), { action: "activate",
  buildBatchId: `cms-${id}`, deploymentId, versionId, commitSha })).outcome).toBe("deployed");
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

async function bootstrapActive() {
  const buildUuid = "11111111-1111-4111-8111-111111111111", version = "22222222-2222-4222-8222-222222222222", script = "d".repeat(32);
  const evidence = bootstrap.projectPublicDeploymentBootstrapEvidence({ workerName: "njpbs-production", expectedExternalScriptId: script,
    deploymentsResponse: { success: true, result: { deployments: [{ id: "44444444-4444-4444-8444-444444444444", source: "wrangler", strategy: "percentage",
      created_on: "2026-08-27T17:56:07.218Z", annotations: { "workers/triggered_by": "deployment" }, versions: [{ version_id: version, percentage: 100 }] }] } },
    buildsByVersionResponse: { success: true, result: { builds: { [version]: { build_uuid: buildUuid, created_on: "2026-08-27T17:54:04.891Z", status: "stopped",
      build_outcome: "success", stopped_on: "2026-08-27T17:56:11.043Z", build_trigger_metadata: { branch: "production", commit_hash: "a".repeat(40) },
      trigger: { external_script_id: script } } } } } });
  await db.doc(pointerPath).set(initialPublicDeploymentPointer());
  await bootstrap.bootstrapPublicDeployment({ firestore: db, evidence });
  return evidence;
}

it("ends a refused first release of an empty project and leaves the pointer at zero", async () => {
  expect((await db.doc(pointerPath).get()).exists).toBe(false);
  const { generation } = await stageCandidate();
  expect(await pointer()).toMatchObject({ activeGeneration: 0, activeCommitSha: null, activeDeploymentId: null });
  await runTwice();
  await expectSettled(generation, { activeGeneration: 0, activeCommitSha: null, activeDeploymentId: null,
    newestEligibleGeneration: 0, newestEligibleBuildBatchId: null });
});

it("returns eligibility to a bootstrapped release that has no deployed batch", async () => {
  const evidence = await bootstrapActive();
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
  await activate(nextId, "55555555-5555-4555-8555-555555555555");
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

// The active release when the refused bytes are met: a real activation with its
// media lifecycle, or a real bootstrap, which has a receipt and no batch.
const origins = {
  "deployed batch": async () => {
    const { generation, prepared } = await stage(activeId);
    await activate(activeId, activeDeploymentId);
    await activatePublicMediaLifecycle({ firestore: db, proof: { schemaVersion: 1, buildBatchId: `cms-${activeId}`, generation, commitSha,
      deploymentId: activeDeploymentId, versionId, publicationReceiptDigest: prepared.publicationReceiptDigest, publicReceiptUrl: PUBLIC_RECEIPT_URL } });
    return `cms-${activeId}`;
  },
  "bootstrap receipt": async () => (await bootstrapActive()).buildBatchId as string,
};
type Origin = keyof typeof origins;
const park = () => db.doc(requestPath).update({ status: "failed", attempts: 4, nextAttemptAt: null });
const reserveJournal = async () => (await journal()).reserve({ queueId, buildBatchId, commitSha });
const uncertain = async () => { await settle(await acquire(queueId), { action: "reconcile" }); };
type Row = { state: string; arrange(origin: Origin): Promise<unknown>; settles: boolean; batch: string; only?: Origin;
  /** Where eligibility ends: at the active release, or where it was. */
  eligibility?: "active" | "unchanged"; logs?: string };
// Each state is reached through its own writers. A row says so when no writer makes it.
const states: Row[] = [
  { state: "batch reserved", arrange: () => stage(queueId, "reserved"), settles: true, batch: "retired", eligibility: "unchanged" },
  { state: "candidate eligible", arrange: () => stage(), settles: true, batch: "retired", eligibility: "active" },
  { state: "crash after the media manifest and before the candidate", arrange: () => stage(queueId, "manifest"), settles: true, batch: "retired", eligibility: "unchanged" },
  { state: "another candidate deploys", arrange: async () => { await stage(); await stage(nextId); await acquire(nextId); }, settles: false, batch: "ready" },
  { state: "its own activation is uncertain", arrange: async () => { await stage(); await uncertain(); }, settles: false, batch: "reconciling" },
  { state: "crash after its lease was acquired", arrange: async () => { await stage(); await acquire(queueId); }, settles: false, batch: "deploying" },
  { state: "crash after a claim and before settlement", settles: true, batch: "retired", eligibility: "active", arrange: async () => {
    await stage();
    expect(await loseAnswer(db, { requestPath, journalPath, matches: releaseWrites.claim }, () => run())).not.toBeNull();
    expect((await (await journal()).read())?.queueId).toBe(queueId);
    const claimed = (await db.doc(requestPath).get()).data()!;
    vi.spyOn(Date, "now").mockReturnValue(claimed.nextAttemptAt); // The claim time passes.
  } },
  // No current writer parks a request: main's attempt limit did.
  { state: "parked by main, candidate eligible", arrange: async () => { await stage(); await reserveJournal(); await park(); }, settles: true, batch: "retired", eligibility: "active" },
  { state: "parked by main, batch reserved", arrange: async () => { await stage(queueId, "reserved"); await reserveJournal(); await park(); }, settles: true, batch: "retired", eligibility: "unchanged" },
  { state: "a newer candidate is eligible", arrange: async () => { await stage(); await stage(nextId); }, settles: true, batch: "retired", eligibility: "unchanged" },
  { state: "an earlier candidate failed and is still eligible", settles: true, batch: "retired", eligibility: "unchanged", arrange: async () => {
    await stage(nextId);
    const lease = await acquire(nextId);
    await settle(lease, { action: "terminal-failure", buildBatchId: `cms-${nextId}`, outcome: "fail" });
    await stage(queueId, "reserved");
  } },
  { state: "a later release is active", settles: false, batch: "ready", arrange: async () => {
    await stage(); await stage(nextId); await activate(nextId, "55555555-5555-4555-8555-555555555555");
  } },
  // A bootstrap never opens the media lifecycle, so its rows all run with it closed.
  { state: "media lifecycle closed by a baseline recovery", only: "deployed batch", settles: true, batch: "retired", eligibility: "unchanged", arrange: async () => {
    await stage(queueId, "reserved");
    const { activeGeneration, lastReservedGeneration, activeCommitSha, ...row } = (await pointer())!;
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: true });
    await recoverCmsPublicationBaseline({ firestore: db, queueId: "99999999999999999999", commitSha,
      expected: { activeGeneration, lastReservedGeneration, activeCommitSha, activeDeploymentId: row.activeDeploymentId } });
    expect((await pointer())!.mediaLifecycleReady).toBe(false);
  } },
  // No writer makes it: every activation leaves a deployed batch and every bootstrap a receipt.
  { state: "no record identifies the active release", settles: true, batch: "retired", eligibility: "unchanged",
    logs: "the active release has no deployed batch or bootstrap receipt", arrange: async () => {
      await stage();
      await db.recursiveDelete(db.doc(`${pointerPath}/buildBatches/cms-${activeId}`));
      await db.recursiveDelete(db.collection(`${pointerPath}/bootstrapReceipts`));
    } },
];
const durable = () => Promise.all([requestPath, batchPath, pointerPath, journalPath].map(async name => (await db.doc(name).get()).data()));
async function runTwice() {
  await run();
  const once = await durable();
  await run();
  expect(await durable()).toEqual(once);
}
// Not in this table, with the reason:
// - a verified or unsettled restore: no-build-post-integration.test.js runs the restore operator. A restore needs a deployed predecessor batch, so none follows a bootstrap.
// - the schema-two selector: no writer makes it, because the selector and an open reservation refuse each other (public-release-bootstrap.test.ts).
// - the first deployment, a missing pointer and a superseded request: their own tests below and above.
const matrix = (Object.keys(origins) as Origin[]).flatMap(origin => states.filter(row => !row.only || row.only === origin).map(row => ({ origin, ...row })));
it.each(matrix)("refused bytes, active release with a $origin, $state: settles $settles", async ({ origin, arrange, settles, batch, eligibility, logs }) => {
  const activeBuild = await origins[origin]();
  const active = (await pointer())!;
  await arrange(origin);
  const before = (await pointer())!;
  await runTwice();
  const after = (await pointer())!, stored = (await db.doc(batchPath).get()).data()!, request = (await db.doc(requestPath).get()).data()!;
  expect(after.lastReservedGeneration).toBe(before.lastReservedGeneration);
  expect(stored.status).toBe(batch);
  if (logs) expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(logs);
  if (!settles) {
    expect(after).toEqual(before);
    expect((await (await journal()).read())?.queueId).toBe(queueId);
    expect(request.refusalReceipt).toBeUndefined();
    expect(request.nextAttemptAt).toBeGreaterThan(Date.now());
    return;
  }
  expect(await (await journal()).read()).toBeNull();
  expect(request).toMatchObject({ status: "failed", nextAttemptAt: null, refusalReceipt: { reason: "cloud_release_input_refused" } });
  expect([after.newestEligibleGeneration, after.newestEligibleBuildBatchId]).toEqual(eligibility === "active"
    ? [active.activeGeneration, activeBuild] : [before.newestEligibleGeneration, before.newestEligibleBuildBatchId]);
  // The same validators the pause drain applies.
  const validate = stored.readyAt ? assertPublicDeploymentRefusedCloudReleaseBatch : assertPublicDeploymentRetiredCloudReleaseBatch;
  expect(validate(stored, buildBatchId)).toEqual(stored);
  // The counter is ahead, so a prepared release is refused; an ordinary release is admitted and activates.
  expect(() => assertMediaLifecycleDeploymentFence(after)).toThrow();
  const admitted = "12121212121212121212", next = await stage(admitted);
  expect(next.generation).toBe(before.lastReservedGeneration + 1);
  await activate(admitted, "55555555-5555-4555-8555-555555555555");
  expect(await pointer()).toMatchObject({ activeGeneration: next.generation, mediaLifecycleReady: before.mediaLifecycleReady });
  if (before.mediaLifecycleReady) expect(assertMediaLifecycleDeploymentFence(await pointer())).toMatchObject({ generation: next.generation });
});

it.each(Object.keys(origins) as Origin[])("leaves no journal job behind a request the operator superseded after it was read (%s)", async origin => {
  await origins[origin]();
  await stage(queueId, "reserved");
  // The state the operator requires: a failed upload and paused publication.
  await db.doc(requestPath).update({ status: "failed", attempts: 1, failureReason: "candidate upload: refused." });
  await db.doc("system/cmsPublicationRuntime").set({ phase: "paused", commitSha, cloud: { phase: "paused", commitSha, serializerId: "cloudflare-publisher" } });
  const begin = db.runTransaction.bind(db);
  // The operator commits between the runner's read and its claim.
  const raced = vi.spyOn(db, "runTransaction").mockImplementationOnce((async (...args: Parameters<typeof begin>) => {
    expect((await supersedeUploadExhaustedCloudRelease({ firestore: db as never, queueId, commitSha, apply: true })).written).toBe(true);
    return begin(...args);
  }) as never);
  const readInput = vi.fn();
  await run({ readInput });
  raced.mockRestore();
  const once = await durable();
  await run({ readInput });
  expect(await durable()).toEqual(once);
  expect(readInput).not.toHaveBeenCalled();
  expect((await db.doc(requestPath).get()).data()).toMatchObject({ status: "superseded", nextAttemptAt: null });
  expect((await db.doc(batchPath).get()).data()).toMatchObject({ status: "retired" });
  expect(await (await journal()).read()).toBeNull();
  expect((await (await journal()).reserve({ queueId: nextId, buildBatchId: `cms-${nextId}`, commitSha })).job.queueId).toBe(nextId);
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
  // No writer deletes the pointer: this is an incident, not a start state.
  await db.doc(pointerPath).delete();
  await runTwice();
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

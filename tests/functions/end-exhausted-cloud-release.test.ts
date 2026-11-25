import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endExhaustedCloudRelease } from "../../site/scripts/stage-cms-publication-cloud-release";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";

const requireModule = createRequire(import.meta.url);
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = requireModule("../../functions/lib/public-deployment-coordinator.js");
const { assertPublicDeploymentTerminalBatchStructure } = requireModule("../../functions/lib/public-deployment.js");
const { createPublicMediaManifest } = requireModule("../../functions/lib/public-media-manifest.js");
const { markPublicMediaManifestReady, stagePublicMediaManifest } = requireModule("../../functions/lib/public-media-manifest-store.js");
const { recordPublicWorkerCandidate } = requireModule("../../functions/lib/public-worker-candidate-store.js");
const { publicWorkerCandidateTag } = requireModule("../../functions/lib/public-worker-candidate.js");
const { publicationTarget } = requireModule("../../functions/lib/publication-target.js");

const TARGET = publicationTarget("production");
const QUEUE_ID = "Q".repeat(20);
const BATCH = `cms-${QUEUE_ID}`;
const COMMIT = "a".repeat(40);
const RUNTIME = { owner: "cloudflare", release: COMMIT };
const PREDECESSOR = "44444444-4444-4444-8444-444444444444";
const MINUTE = 60_000;
let db: Firestore;

const POINTER = { schemaVersion: 1, mediaLifecycleReady: true, state: "idle", activeGeneration: 7, activeDeploymentId: PREDECESSOR,
  activeCommitSha: "b".repeat(40), lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "cms-predecessor" };

const pointerRef = () => db.doc("system/publicDeployment");
const batchRef = () => db.doc(`system/publicDeployment/buildBatches/${BATCH}`);
const requestRef = () => db.doc(`cmsPublicationSerializerJournals/${TARGET.serializerId}/releases/${QUEUE_ID}`);
const journalRef = () => db.doc(`cmsPublicationSerializerJournals/${TARGET.serializerId}`);

/** Reserve a release and record its candidate. */
async function recordRelease(buildBatchId: string) {
  const { batch } = await reservePublicBuildBatch({ firestore: db, buildBatchId, commitSha: COMMIT, runtime: RUNTIME });
  const artifact = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const manifest = createPublicMediaManifest({ reservation: batch, owners: artifact.owners,
    artifactInventory: artifact.families.map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(({ documentId }) => documentId) })) });
  await stagePublicMediaManifest({ firestore: db, manifest });
  await markPublicMediaManifestReady({ firestore: db, manifest });
  const sealed = { schemaVersion: 1, buildBatchId, generation: batch.generation, commitSha: COMMIT, artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest,
    publicationReceiptDigest: createHash("sha256").update("receipt").digest("hex"), artifactFileCount: 2, artifactBytes: 1_000 };
  await recordPublicWorkerCandidate({ firestore: db, runtime: RUNTIME, candidate: { ...sealed, runtime: RUNTIME, workerName: "njpbs-production",
    workerVersionId: "22222222-2222-4222-8222-222222222222", workerVersionTag: publicWorkerCandidateTag(sealed),
    versionCreatedOn: "2026-08-27T20:00:00.000Z", wranglerVersion: "4.123.0" } });
}

const at = (minutes: number) => Timestamp.fromMillis(Date.now() - minutes * MINUTE);

/** A release that is uploaded and ready; its four attempts failed before a lease. */
async function exhaustedRelease() {
  await pointerRef().set(POINTER);
  await db.doc("system/publicDeployment/buildBatches/cms-predecessor").set({ schemaVersion: 1, status: "deployed", buildBatchId: "cms-predecessor",
    generation: 7, commitSha: "b".repeat(40), runtime: { owner: "cloudflare", release: "b".repeat(40) }, reservedAgainstGeneration: 0,
    reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt: at(9), reservedAt: at(9), readyAt: at(8),
    leaseToken: "88888888-8888-4888-8888-888888888888", leaseAcquiredAt: at(7), predecessorGeneration: 0, predecessorDeploymentId: null,
    predecessorCommitSha: null, mediaManifestDigest: "1".repeat(64), cloudflareEvidenceDigest: "2".repeat(64), deployedAt: at(6),
    deploymentId: PREDECESSOR, deploymentVersionId: "66666666-6666-4666-8666-666666666666" });
  await recordRelease(BATCH);
  await requestRef().set({ schemaVersion: 1, runtime: RUNTIME, queueId: QUEUE_ID, buildBatchId: BATCH, commitSha: COMMIT, inputSha256: "d".repeat(64),
    artifactCheckpointDigest: "e".repeat(64), status: "failed", attempts: 4, nextAttemptAt: null,
    failureReason: "context retention: Automatic retry attempts exhausted" });
  await journalRef().set({ schemaVersion: 1, serializerId: TARGET.serializerId, runtime: RUNTIME, job: { queueId: QUEUE_ID, buildBatchId: BATCH,
    commitSha: COMMIT, claimToken: "55555555-5555-4555-8555-555555555555", createdAt: "2026-11-25T20:00:00.000Z" } });
}

const everything = async () => Promise.all([pointerRef(), batchRef(), requestRef(), journalRef()].map(async ref => (await ref.get()).data()));
const end = (options: Record<string, unknown> = {}) => endExhaustedCloudRelease({ firestore: db, queueId: QUEUE_ID, commitSha: COMMIT, apply: true, ...options });

beforeAll(() => { db = isolatedFirestore("end-exhausted-cloud-release.test.ts") as unknown as Firestore; });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await exhaustedRelease();
});

describe("end of an exhausted release that never took a lease", () => {
  it("ends the batch as failed, clears the journal and frees the pointer, so the next release goes on", async () => {
    const [, batchBefore, request, journal] = await everything();
    expect(await end()).toMatchObject({ batchStatus: "failed", generation: 8, newestEligibleBuildBatchId: "cms-predecessor", journalCleared: true, written: true });
    const [pointer, batch, requestAfter, journalAfter] = await everything();
    expect({ ...pointer, updatedAt: null }).toEqual({ ...POINTER, lastReservedGeneration: 8, updatedAt: null });
    expect(batch).toMatchObject({ ...batchBefore, status: "failed", terminalOutcome: "cancelled", predecessorGeneration: 7,
      predecessorDeploymentId: PREDECESSOR, predecessorCommitSha: "b".repeat(40) });
    expect(() => assertPublicDeploymentTerminalBatchStructure(batch, BATCH)).not.toThrow();
    expect(requestAfter).toEqual(request);
    expect(journalAfter).toEqual({ ...journal, job: null });
    await expect(acquirePublicDeploymentLease({ firestore: db, buildBatchId: BATCH, commitSha: COMMIT, runtime: RUNTIME })).rejects.toThrow();
    await expect(end()).rejects.toThrow();
    const next = `cms-${"N".repeat(20)}`;
    await recordRelease(next);
    expect(await acquirePublicDeploymentLease({ firestore: db, buildBatchId: next, commitSha: COMMIT, runtime: RUNTIME }))
      .toMatchObject({ outcome: "acquired", lease: { generation: 9, predecessorDeploymentId: PREDECESSOR } });
  });

  it("writes nothing without --apply", async () => {
    const before = await everything();
    expect(await end({ apply: false })).toMatchObject({ written: false, dryRun: true });
    expect(await everything()).toEqual(before);
  });

  const refusals: [string, RegExp, () => Promise<unknown>][] = [
    ["a scheduled attempt", /not in the exhausted failed state/, () => requestRef().update({ nextAttemptAt: Date.now() })],
    ["a remaining attempt", /not in the exhausted failed state/, () => requestRef().update({ attempts: 3 })],
    ["a pending request", /not in the exhausted failed state/, () => requestRef().update({ status: "pending" })],
    ["another source", /does not belong to this cloud release/, () => requestRef().update({ commitSha: "c".repeat(40) })],
    ["another journal job", /journal does not belong/, () => journalRef().update({ "job.queueId": "R".repeat(20) })],
    ["a held lease", /lease is held/, () => acquirePublicDeploymentLease({ firestore: db, buildBatchId: BATCH, commitSha: COMMIT, runtime: RUNTIME })],
    ["a newer eligible release", /newer release is eligible/, () => recordRelease(`cms-${"N".repeat(20)}`)],
    ["no batch of the active release", /batch of the active release/, () => db.doc("system/publicDeployment/buildBatches/cms-predecessor").delete()],
    ["no candidate", /candidate/, () => batchRef().collection("candidates").doc("worker").delete()],
  ];
  it.each(refusals)("refuses %s and writes nothing", async (_label, message, change) => {
    await change();
    const before = await everything();
    await expect(end()).rejects.toThrow(message);
    expect(await everything()).toEqual(before);
  });
});

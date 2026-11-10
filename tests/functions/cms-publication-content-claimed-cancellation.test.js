import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firebaseAdminRuntime as admin } from "../../site/scripts/firebase-admin-runtime";
import { openCmsPublicationTokenJournal } from "../../site/scripts/cms-publication-token-journal";
import { runCmsPublicationContentClaimedCancellation } from "../../site/scripts/cancel-claimed-cms-publication-content";

const requireModule = createRequire(import.meta.url);
const { cmsPublicationSerializerTokenDigest } = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
);
const { cancelClaimedCmsPublicationContent } = requireModule(
  "../../functions/lib/cms-publication-content-claimed-cancellation.js",
);
const PROJECT = "demo-njpbs-content-cancellation";
const QUEUE_ID = "NG9gDQubg5lOQj7D6PJD";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const SOURCE = "5e5ad5e7942a5078d5e9c885c34a03a1d23d2ab4";
const OPERATOR = "f".repeat(40);
const SERIALIZER = "node-compute-primary";
const time = admin.Timestamp.fromMillis(1_791_405_289_650);
const claimedAt = admin.Timestamp.fromMillis(time.toMillis() + 1_000);
const cutoffAt = admin.Timestamp.fromMillis(time.toMillis() + 2_000);
const reservedAt = admin.Timestamp.fromMillis(time.toMillis() + 3_000);
const GENERATION = 249;
let app;
let db;
let directory;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
    throw new Error("These tests require the local Firestore emulator");
  }
  app = admin.initializeApp({ projectId: PROJECT }, PROJECT);
  db = admin.getFirestore(app);
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = await mkdtemp(path.join(tmpdir(), "njpbs-content-cancellation-"));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  if (app) await admin.deleteApp(app);
});

async function fixture() {
  const journal = await openCmsPublicationTokenJournal({
    stateDirectory: directory, serializerId: SERIALIZER,
  });
  const { job } = await journal.reserve({
    queueId: QUEUE_ID, buildBatchId: BUILD_BATCH_ID, commitSha: SOURCE,
  });
  const intent = {
    operatorCommitSha: OPERATOR, queueId: QUEUE_ID, buildBatchId: BUILD_BATCH_ID,
    queueCommitSha: SOURCE, serializerId: SERIALIZER, journalPath: journal.journalPath,
  };
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
  const candidateRef = batchRef.collection("candidates").doc("worker");
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  const manifestChunkRef = manifestRef.collection("chunks").doc("000000");
  const verificationRef = manifestRef.collection("verifications").doc("complete");
  const changes = [
    { collection: "cmsPosts", id: "published", sourceVersion: 3 },
    { collection: "cmsPosts", id: "recycled", sourceVersion: 4 },
    { collection: "cmsPosts", id: "withdrawn", sourceVersion: 5, operation: "withdraw" },
    { collection: "cmsPages", id: "newer", sourceVersion: 6 },
    { collection: "cmsPages", id: "other-queue", sourceVersion: 7 },
    { collection: "cmsPosts", id: "missing", sourceVersion: 8 },
  ];
  await pointerRef.set({
    schemaVersion: 1, state: "idle", mediaLifecycleReady: true,
    activeGeneration: 248, activeDeploymentId: "deployment-248",
    activeCommitSha: "a".repeat(40), lastReservedGeneration: GENERATION,
    newestEligibleGeneration: 248, newestEligibleBuildBatchId: "cms-PxnvpPXVH8aG1tycQRmF",
    updatedAt: time,
  });
  await batchRef.set({
    schemaVersion: 1, buildBatchId: BUILD_BATCH_ID, generation: GENERATION,
    status: "reserved", commitSha: SOURCE, cutoffAt, reservedAt,
    reservedAgainstGeneration: 248, reservedAgainstDeploymentId: "deployment-248",
    reservedAgainstCommitSha: "a".repeat(40),
  });
  await queueRef.set({
    status: "publishing", transport: "serializer", triggeredBy: "staff-fixture",
    triggeredByEmail: "staff@example.test", triggeredAt: time, completedAt: null,
    error: null, changes,
    serializerClaim: {
      schemaVersion: 1, serializerId: SERIALIZER, buildBatchId: BUILD_BATCH_ID,
      commitSha: SOURCE, tokenDigest: cmsPublicationSerializerTokenDigest(job.claimToken),
      claimedAt,
    },
    artifactBuild: {
      buildBatchId: BUILD_BATCH_ID, generation: GENERATION, commitSha: SOURCE, cutoffAt,
    },
  });
  for (const change of changes.filter((item) => item.id !== "missing")) {
    await db.collection(change.collection).doc(change.id).set({
      status: change.id === "recycled" ? "draft" : "published",
      publiclyVisible: !["recycled", "withdrawn"].includes(change.id),
      ...(change.id === "recycled" ? { deletedAt: time } : {}),
      published: {
        sourceVersion: change.id === "newer" ? 9 : change.sourceVersion,
        blocks: [{ type: "video", id: "native-video-fixture" }],
      },
      publishBuildPending: true,
      publishBuildQueueId: change.id === "other-queue" ? "another-queue" : QUEUE_ID,
      publicSourceVersion: 2,
    });
  }
  const snapshotRef = db.collection("cmsPostRevisions").doc("retained-snapshot");
  await snapshotRef.set({ sourceVersion: 3, title: "Retained snapshot" });
  const tracked = [queueRef, batchRef, pointerRef, candidateRef, snapshotRef,
    ...changes.map((change) => db.collection(change.collection).doc(change.id)),
    manifestRef, manifestChunkRef, verificationRef];
  return { journal, job, intent, queueRef, batchRef, pointerRef, candidateRef,
    manifestRef, manifestChunkRef, verificationRef, tracked };
}

function run(state, { intent = state.intent, serviceState = "inactive", journal = state.journal } = {}) {
  return runCmsPublicationContentClaimedCancellation({
    firestore: db, journal, intent,
    dependencies: { readServiceState: async () => serviceState },
  });
}

async function durableState(state) {
  const snapshots = await db.getAll(...state.tracked);
  return {
    documents: snapshots.map((snapshot) => ({ data: snapshot.data(), updateTime: snapshot.updateTime })),
    logs: (await db.collection("admin_logs").get()).docs.map((doc) => doc.data()),
    journal: await readFile(state.journal.journalPath, "utf8"),
    journalModifiedAt: (await stat(state.journal.journalPath)).mtimeMs,
  };
}

describe("claimed content cancellation", () => {
  it("cancels one reservation, clears its journal, and preserves revisions and generation", async () => {
    const state = await fixture();
    const before = await durableState(state);
    const result = await run(state);
    const after = await durableState(state);
    expect(result).toMatchObject({ outcome: "cancelled", idempotent: false });
    const queue = (await state.queueRef.get()).data();
    const batch = (await state.batchRef.get()).data();
    expect(queue.status).toBe("cancelled");
    expect(batch.status).toBe("cancelled");
    expect(batch.cancellationReceipt).toEqual(queue.claimedContentCancellationReceipt);
    expect(batch.cancellationReceipt).toMatchObject({
      schemaVersion: 2, queueId: QUEUE_ID, buildBatchId: BUILD_BATCH_ID,
      queueCommitSha: SOURCE, operatorCommitSha: OPERATOR, serializerId: SERIALIZER,
      claimTokenDigest: cmsPublicationSerializerTokenDigest(state.job.claimToken),
      artifactReceiptDigest: null, artifactInclusionRecordedAt: null,
    });
    expect(batch.cancelledAt.toMillis()).toBeGreaterThan(0);
    expect(after.documents[2]).toEqual(before.documents[2]);
    expect(after.documents[4]).toEqual(before.documents[4]);
    await expect(state.journal.read()).resolves.toBeNull();
    expect(JSON.parse(after.journal).job).toBeNull();
    for (const [collection, id] of [["cmsPosts", "published"], ["cmsPosts", "withdrawn"]]) {
      expect((await db.collection(collection).doc(id).get()).data()).toMatchObject({
        publishBuildPending: true, publishBuildQueueId: null, publicSourceVersion: 2,
      });
    }
    // Cancellation does not rewrite an unpublished/recycled record or a newer revision.
    for (const index of [6, 8, 9, 10]) expect(after.documents[index]).toEqual(before.documents[index]);
    expect(after.logs).toHaveLength(1);
    expect(JSON.stringify({ result, queue, batch, logs: after.logs })).not.toContain(state.job.claimToken);
  });

  it.each(["manifestRef", "manifestChunkRef", "verificationRef"])(
    "refuses persisted media evidence at %s without database or journal writes",
    async (field) => {
      const state = await fixture();
      // Chunks and verification can survive without their parent manifest.
      await state[field].set({ buildBatchId: BUILD_BATCH_ID });
      const before = await durableState(state);
      await expect(run(state)).rejects.toThrow("media");
      expect(await durableState(state)).toEqual(before);
    },
  );

  it("binds a renewed reservation and artifact inclusion in both durable receipts", async () => {
    const state = await fixture();
    const renewedCutoff = admin.Timestamp.fromMillis(time.toMillis() + 10_000);
    const renewedReservation = admin.Timestamp.fromMillis(time.toMillis() + 11_000);
    const recordedAt = admin.Timestamp.fromMillis(time.toMillis() + 12_000);
    const artifactReceiptDigest = "d".repeat(64);
    await state.batchRef.update({ cutoffAt: renewedCutoff, reservedAt: renewedReservation });
    await state.queueRef.update({
      "artifactBuild.cutoffAt": renewedCutoff,
      artifactInclusion: {
        schemaVersion: 1, buildBatchId: BUILD_BATCH_ID, generation: GENERATION,
        commitSha: SOURCE, cutoffAt: renewedCutoff, recordedAt, artifactReceiptDigest,
      },
    });
    const first = await run(state);
    expect(first.receipt).toMatchObject({
      schemaVersion: 2, cutoffAt: renewedCutoff,
      artifactReceiptDigest, artifactInclusionRecordedAt: recordedAt,
    });
    expect((await state.queueRef.get()).data().claimedContentCancellationReceipt).toEqual(first.receipt);
    expect((await state.batchRef.get()).data().cancellationReceipt).toEqual(first.receipt);
    const beforeRetry = await durableState(state);
    await expect(run(state)).resolves.toMatchObject({ idempotent: true, receipt: first.receipt });
    expect(await durableState(state)).toEqual(beforeRetry);
    await state.queueRef.update({ "artifactInclusion.artifactReceiptDigest": "e".repeat(64) });
    const beforeConflict = await durableState(state);
    await expect(run(state)).rejects.toThrow("receipt conflicts");
    expect(await durableState(state)).toEqual(beforeConflict);
  });

  it("preserves the real unpublished record with a cleared queue id", async () => {
    const state = await fixture();
    const recycledRef = db.collection("cmsPosts").doc("recycled");
    await recycledRef.update({
      publiclyVisible: false, publishBuildPending: true, publishBuildQueueId: null,
    });
    const before = (await recycledRef.get());
    await run(state);
    const after = await recycledRef.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime).toEqual(before.updateTime);
    expect(after.data().published.sourceVersion).toBe(4);
  });

  it("accepts an existing v1 cancellation without inclusion on a write-free retry", async () => {
    const state = await fixture();
    const result = await run(state);
    const legacy = { ...result.receipt, schemaVersion: 1 };
    delete legacy.artifactReceiptDigest;
    delete legacy.artifactInclusionRecordedAt;
    await state.queueRef.update({ claimedContentCancellationReceipt: legacy });
    await state.batchRef.update({ cancellationReceipt: legacy });
    const before = await durableState(state);
    await expect(run(state)).resolves.toMatchObject({ idempotent: true, receipt: legacy });
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    ["reserved batch", (state) => state.batchRef.update({ schemaVersion: 0 }), "The claimed content build batch is invalid"],
    ["coordinator", (state) => state.pointerRef.update({ schemaVersion: 0 }), "The public deployment coordinator is invalid"],
    ["serializer claim", (state) => state.queueRef.update({ serializerClaim: {} }), "The claimed content serializer claim is invalid"],
    ["artifact inclusion", (state) => state.queueRef.update({ artifactInclusion: {} }), "The claimed content artifact inclusion is invalid"],
  ])("reports a controlled refusal for malformed %s at the operator boundary", async (_name, alter, message) => {
    const state = await fixture();
    await alter(state);
    const before = await durableState(state);
    await expect(run(state)).rejects.toMatchObject({
      name: "CmsPublicationContentClaimedCancellationError", message,
    });
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    ["queue id", { queueId: "Other0903Cutover0000" }],
    ["batch id", { buildBatchId: "cms-Other0903Cutover0000" }],
    ["serializer id", { serializerId: "another-serializer" }],
    ["source commit", { queueCommitSha: "b".repeat(40) }],
    ["journal path", { journalPath: "/tmp/other/claim-journal.json" }],
    ["operator commit", { operatorCommitSha: SOURCE }],
  ])("refuses a mismatched %s without writes", async (_name, mismatch) => {
    const state = await fixture();
    const before = await durableState(state);
    await expect(run(state, { intent: { ...state.intent, ...mismatch } })).rejects.toThrow();
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    ["claim token", async (state) => state.queueRef.update({ "serializerClaim.tokenDigest": "0".repeat(64) })],
    ["batch source", async (state) => state.batchRef.update({ commitSha: "b".repeat(40) })],
    ["batch cutoff", async (state) => state.batchRef.update({ cutoffAt: new admin.Timestamp(time.seconds, time.nanoseconds + 1_000) })],
    ["activated batch", async (state) => state.batchRef.update({ status: "deployed", deployedAt: time, deploymentId: "activated" })],
    ["activation evidence", async (state) => state.batchRef.update({ activatedAt: time })],
    ["changed public generation", async (state) => state.pointerRef.update({ activeGeneration: GENERATION })],
    ["candidate", async (state) => state.candidateRef.set({ deploymentId: "activated" })],
    ["deployment claim", async (state) => state.queueRef.update({ deploymentClaim: { deploymentId: "activated" } })],
    ["missing journal job", async (state) => state.journal.clear({ queueId: QUEUE_ID, claimToken: state.job.claimToken })],
  ])("refuses conflicting %s without writes", async (_name, alter) => {
    const state = await fixture();
    await alter(state);
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow();
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["active", "activating", "deactivating", "failed", "unknown"])(
    "refuses service state %s at the process boundary without writes",
    async (serviceState) => {
      const state = await fixture();
      const before = await durableState(state);
      await expect(run(state, { serviceState })).rejects.toThrow("must be stopped");
      expect(await durableState(state)).toEqual(before);
    },
  );

  it("reports the existing receipt on rerun without database or journal writes", async () => {
    const state = await fixture();
    const first = await run(state);
    const before = await durableState(state);
    const second = await run(state);
    expect(second).toMatchObject({ idempotent: true, receipt: first.receipt });
    expect(await durableState(state)).toEqual(before);
    expect(JSON.stringify(second)).not.toContain(state.job.claimToken);
  });

  it("recovers a transaction committed before journal clear", async () => {
    const state = await fixture();
    await cancelClaimedCmsPublicationContent({
      firestore: db,
      expected: { ...state.intent, claimTokenDigest: cmsPublicationSerializerTokenDigest(state.job.claimToken) },
      serverTimestamp: () => admin.FieldValue.serverTimestamp(),
    });
    const databaseBefore = (await durableState(state)).documents;
    await expect(state.journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });
    const result = await run(state);
    expect(result).toMatchObject({ queueIdempotent: true, journalIdempotent: false });
    expect((await durableState(state)).documents).toEqual(databaseBefore);
    await expect(state.journal.read()).resolves.toBeNull();
  });

  it("retains the real journal on a filesystem clear failure, then completes on retry", async () => {
    const state = await fixture();
    await expect(run(state, { journal: {
      ...state.journal, clear: async () => { throw new Error("Filesystem unavailable"); },
    } })).rejects.toThrow("Filesystem unavailable");
    expect((await state.queueRef.get()).data().status).toBe("cancelled");
    await expect(state.journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });
    await run(state);
    await expect(state.journal.read()).resolves.toBeNull();
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("refuses a changed terminal receipt or journal path on retry", async () => {
    const state = await fixture();
    await run(state);
    await state.queueRef.update({ claimedContentCancellationJournalPath: "/tmp/different/claim-journal.json" });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("receipt conflicts");
    expect(await durableState(state)).toEqual(before);
  });
});

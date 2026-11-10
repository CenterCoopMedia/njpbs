import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firebaseAdminRuntime as admin } from "../../site/scripts/firebase-admin-runtime";
import {
  parseSettlementArguments,
  runCmsContentUnpublishedWithdrawalSettlement,
} from "../../site/scripts/settle-unpublished-cms-content-withdrawal";
import contextPublication from "../../functions/lib/public-context-publication.js";

const requireModule = createRequire(import.meta.url);
const { cancelClaimedCmsPublicationContent } = requireModule("../../functions/lib/cms-publication-content-claimed-cancellation.js");
const { recoverCmsPublicationBaseline } = requireModule("../../functions/lib/cms-publication-baseline-recovery.js");
const { claimCmsPublishQueue } = requireModule("../../functions/lib/cms-publication-serializer.js");
const { reserveCmsPublishArtifact } = requireModule("../../functions/lib/cms-publish-artifact.js");
const PROJECT = "demo-njpbs-withdrawal-settlement";
const QUEUE = "NG9gDQubg5lOQj7D6PJD";
const RECORD = "c5bebc4c4fa53053767300956cdf5eda";
const ACTIVE_BATCH = "cms-PxnvpPXVH8aG1tycQRmF";
const SOURCE = "5e5ad5e7942a5078d5e9c885c34a03a1d23d2ab4";
const OPERATOR = "f".repeat(40);
const REPLACEMENT = "bfbe625eadb42978b1ba35d96625a2e7acf258f1";
const time = admin.Timestamp.fromMillis(1_791_405_289_650);
let app;
let db;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
    throw new Error("These tests require the local Firestore emulator");
  }
  app = admin.initializeApp({ projectId: PROJECT }, PROJECT);
  db = admin.getFirestore(app);
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  if (!response.ok) throw new Error("The emulator reset failed");
});
afterAll(async () => { if (app) await admin.deleteApp(app); });

async function fixture(collection = "cmsPosts", artifactInclusion) {
  const pointerRef = db.doc("system/publicDeployment");
  const queueRef = db.doc(`cmsPublishQueue/${QUEUE}`);
  const batchRef = pointerRef.collection("buildBatches").doc(`cms-${QUEUE}`);
  const recordRef = db.doc(`${collection}/${RECORD}`);
  const snapshotRef = db.doc("cmsPostRevisions/retained-snapshot");
  const unrelatedRef = db.doc("cmsPages/retained-page");
  const intent = {
    operatorCommitSha: OPERATOR, collection, recordId: RECORD, sourceVersion: 4,
    queueId: QUEUE, activeGeneration: 248, activeBuildBatchId: ACTIVE_BATCH,
  };
  await pointerRef.set({
    schemaVersion: 1, state: "idle", mediaLifecycleReady: true,
    activeGeneration: 248, activeDeploymentId: "deployment-248",
    activeCommitSha: "a".repeat(40), lastReservedGeneration: 249,
    newestEligibleGeneration: 248, newestEligibleBuildBatchId: ACTIVE_BATCH,
    updatedAt: time,
  });
  await batchRef.set({
    schemaVersion: 1, buildBatchId: `cms-${QUEUE}`, generation: 249,
    status: "reserved", commitSha: SOURCE, cutoffAt: time, reservedAt: time,
    reservedAgainstGeneration: 248, reservedAgainstDeploymentId: "deployment-248",
    reservedAgainstCommitSha: "a".repeat(40),
  });
  await queueRef.set({
    status: "publishing", transport: "serializer", triggeredBy: "staff-fixture",
    triggeredByEmail: "staff@example.test", triggeredAt: time, completedAt: null, error: null,
    changes: [{ collection, id: RECORD, sourceVersion: 4 }],
    serializerClaim: {
      schemaVersion: 1, serializerId: "node-compute-primary", buildBatchId: `cms-${QUEUE}`,
      commitSha: SOURCE, tokenDigest: "1".repeat(64), claimedAt: time,
    },
    artifactBuild: { buildBatchId: `cms-${QUEUE}`, generation: 249, commitSha: SOURCE, cutoffAt: time },
    ...(artifactInclusion ? { artifactInclusion } : {}),
  });
  await recordRef.set({
    status: "draft", deleted: true, deletedAt: time, publiclyVisible: false,
    published: { sourceVersion: 4, blocks: [{ type: "video", id: "native-video-fixture" }] },
    publishBuildPending: true, publishBuildQueueId: QUEUE,
    title: "Internal test post", version: 7,
  });
  await snapshotRef.set({ sourceVersion: 4, title: "Retained snapshot" });
  await unrelatedRef.set({ status: "draft", title: "Retained page", published: null });
  // Produce the cancellation evidence through the real #2773 transaction.
  await cancelClaimedCmsPublicationContent({
    firestore: db,
    expected: {
      operatorCommitSha: "e".repeat(40), queueId: QUEUE, buildBatchId: `cms-${QUEUE}`,
      queueCommitSha: SOURCE, serializerId: "node-compute-primary",
      journalPath: "/tmp/withdrawal-fixture/claim-journal.json", claimTokenDigest: "1".repeat(64),
    },
    serverTimestamp: () => admin.FieldValue.serverTimestamp(),
  });
  return { intent, pointerRef, queueRef, batchRef, recordRef,
    tracked: [pointerRef, queueRef, batchRef, recordRef, snapshotRef, unrelatedRef] };
}

function run(state, intent = state.intent, readState = async () => "inactive") {
  return runCmsContentUnpublishedWithdrawalSettlement({ firestore: db, intent, readState });
}

async function durableState(state) {
  const tracked = [...state.tracked, db.doc("cmsPublishQueue/other-live-queue")];
  const snapshots = await db.getAll(...tracked);
  const logs = await db.collection("admin_logs").orderBy("at").get();
  return {
    documents: snapshots.map((doc) => ({ data: doc.data(), updateTime: doc.updateTime })),
    logs: logs.docs.map((doc) => ({ id: doc.id, data: doc.data(), updateTime: doc.updateTime })),
  };
}

describe("unpublished content withdrawal settlement", () => {
  async function acceptContext() {
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    await db.runTransaction(async transaction => {
      const accepted = await contextPublication.enqueuePublicContextInTransaction({ transaction, firestore: db,
        operationId: "A".repeat(20), runtime: { owner: "cloudflare", release: "a".repeat(40) }, reason: "context", contextRevision: 1 });
      accepted.write();
    });
  }

  it("settles an unpublished withdrawal while preserving registered pending aggregates", async () => {
    const state = await fixture();
    await acceptContext();
    const ref = db.doc(`cmsPublishQueue/${"A".repeat(20)}`);
    const before = (await ref.get()).data();
    await run(state);
    expect((await state.recordRef.get()).data().publishBuildPending).toBe(false);
    expect((await ref.get()).data()).toEqual(before);
  });

  it.each(["serializer", "post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"])("refuses unregistered pending %s beside registered aggregates without writes", async transport => {
    const state = await fixture();
    await acceptContext();
    await db.doc("cmsPublishQueue/other-live-queue").set({ status: "pending", transport });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("live publication queue guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each([1, 2])("binds the v%s cancellation receipt without changing legacy digests", async (schemaVersion) => {
    const recordedAt = admin.Timestamp.fromMillis(time.toMillis() + 1_000);
    const artifactInclusion = schemaVersion === 2 ? {
      schemaVersion: 1, buildBatchId: `cms-${QUEUE}`, generation: 249,
      commitSha: SOURCE, cutoffAt: time, recordedAt, artifactReceiptDigest: "d".repeat(64),
    } : undefined;
    const state = await fixture("cmsPosts", artifactInclusion);
    const receipt = (await state.batchRef.get()).data().cancellationReceipt;
    if (schemaVersion === 1) {
      delete receipt.artifactReceiptDigest;
      delete receipt.artifactInclusionRecordedAt;
      receipt.schemaVersion = 1;
      await state.batchRef.update({ cancellationReceipt: receipt });
      await state.queueRef.update({ claimedContentCancellationReceipt: receipt });
    }
    await state.recordRef.update({ publicSourceVersion: null });
    const result = await run(state);
    const expectedCancellation = {
      schemaVersion, reason: "source_superseded_before_candidate",
      queueId: QUEUE, buildBatchId: `cms-${QUEUE}`, generation: 249,
      queueCommitSha: SOURCE, operatorCommitSha: "e".repeat(40),
      serializerId: "node-compute-primary", claimTokenDigest: "1".repeat(64),
      cutoffAt: { seconds: time.seconds, nanoseconds: time.nanoseconds },
      ...(schemaVersion === 2 ? {
        artifactReceiptDigest: "d".repeat(64),
        artifactInclusionRecordedAt: { seconds: recordedAt.seconds, nanoseconds: recordedAt.nanoseconds },
      } : {}),
      cancelledAt: { seconds: receipt.cancelledAt.seconds, nanoseconds: receipt.cancelledAt.nanoseconds },
    };
    expect(result.receipt.cancellationReceiptDigest).toBe(
      createHash("sha256").update(JSON.stringify(expectedCancellation)).digest("hex"),
    );
  });

  it.each([
    ["cmsPosts", null, null], ["cmsPosts", QUEUE, undefined],
    ["cmsPages", null, undefined], ["cmsPages", QUEUE, null],
  ])("settles recycled %s with queue %s and public version %s", async (collection, queueId, publicSourceVersion) => {
    const state = await fixture(collection);
    await state.recordRef.update({ publishBuildQueueId: queueId,
      ...(publicSourceVersion === null ? { publicSourceVersion } : {}) });
    const before = await durableState(state);
    const result = await run(state);
    expect(result).toMatchObject({ outcome: "settled", idempotent: false,
      receipt: { schemaVersion: 1, collection, recordId: RECORD, sourceVersion: 4,
        queueId: QUEUE, activeGeneration: 248, activeBuildBatchId: ACTIVE_BATCH,
        operatorCommitSha: OPERATOR } });
    const { receiptDigest, settledAt, ...identity } = result.receipt;
    expect(receiptDigest).toBe(createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
    expect(identity.cancellationReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(settledAt.toMillis()).toBeGreaterThan(0);
    const after = await durableState(state);
    for (const index of [0, 1, 2, 4, 5, 6]) expect(after.documents[index]).toEqual(before.documents[index]);
    expect(after.documents[3].data).toEqual({ ...before.documents[3].data,
      publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: null,
      unpublishedWithdrawalSettlementReceipt: result.receipt });
    expect(after.logs).toHaveLength(before.logs.length + 1);
    expect(after.logs.at(-1).data).toMatchObject({ action: "cms-content.settle-unpublished-withdrawal",
      target: `${collection}/${RECORD}`, after: { receipt: result.receipt } });
  });

  it.each([
    ["visible content", { publiclyVisible: true }, "visibility guard"],
    ["legacy visibility", { publiclyVisible: admin.FieldValue.delete(), status: "published" }, "visibility guard"],
    ["confirmed public version", { publicSourceVersion: 2 }, "confirmed public version guard"],
    ["invalid public marker", { publicSourceVersion: 0 }, "confirmed public version guard"],
    ["wrong source version", { "published.sourceVersion": 5 }, "source version guard"],
    ["no pending withdrawal", { publishBuildPending: false }, "pending withdrawal guard"],
    ["another queue", { publishBuildQueueId: "another-queue" }, "queue ownership guard"],
    ["absent queue owner", { publishBuildQueueId: admin.FieldValue.delete() }, "queue ownership guard"],
  ])("refuses %s without writes", async (_name, update, message) => {
    const state = await fixture();
    await state.recordRef.update(update);
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow(message);
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["reserved", "pending", "publishing"])("refuses a %s queue without writes", async (status) => {
    const state = await fixture();
    await db.doc("cmsPublishQueue/other-live-queue").set({ status });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("live publication queue guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    { state: "deploying" }, { activeGeneration: 247 },
    { newestEligibleBuildBatchId: "different-batch" }, { newestEligibleGeneration: 249 },
  ])("refuses a changed coordinator %j without writes", async (update) => {
    const state = await fixture();
    await state.pointerRef.update(update);
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow(/coordinator/);
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    ["not cancelled", { status: "failed" }],
    ["missing receipt", { claimedContentCancellationReceipt: admin.FieldValue.delete() }],
    ["wrong receipt queue", { "claimedContentCancellationReceipt.queueId": "22222222222222222222" }],
    ["wrong receipt version", { "claimedContentCancellationReceipt.schemaVersion": 3 }],
    ["changed receipt digest", { "claimedContentCancellationReceipt.claimTokenDigest": "2".repeat(64) }],
  ])("refuses %s without writes", async (_name, update) => {
    const state = await fixture();
    await state.queueRef.update(update);
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow(/queue|cancellation receipt/);
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["reserved", "public_unconfirmed"])("refuses a later %s publication attempt for the same revision", async (status) => {
    const state = await fixture();
    await state.recordRef.update({ publishBuildQueueId: null });
    // Model a retry followed by unpublish: the marker is still absent, while
    // the original cancellation and retained source version remain unchanged.
    await db.doc("cmsPublishQueue/other-live-queue").set({
      status, transport: "serializer",
      changes: [{ collection: "cmsPosts", id: RECORD, sourceVersion: 4 }],
      artifactBuild: { buildBatchId: "cms-other-live-queue", generation: 250,
        commitSha: REPLACEMENT, cutoffAt: time },
    });
    const advanced = status === "public_unconfirmed";
    await state.pointerRef.update({
      lastReservedGeneration: 250,
      ...(advanced ? { activeGeneration: 250, newestEligibleGeneration: 250,
        newestEligibleBuildBatchId: "cms-other-live-queue",
        activeDeploymentId: "deployment-250", activeCommitSha: REPLACEMENT } : {}),
    });
    const intent = advanced ? { ...state.intent, activeGeneration: 250,
      activeBuildBatchId: "cms-other-live-queue" } : state.intent;
    const before = await durableState(state);
    await expect(run(state, intent)).rejects.toThrow("predecessor or last reservation guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["success", "public_unconfirmed"])("refuses a prior %s publication of the same revision in the active predecessor", async (status) => {
    const state = await fixture();
    await state.recordRef.update({ publishBuildQueueId: null });
    // The earlier attempt already exposed v4 in generation 248. Its retry was
    // cancelled at 249, then staff withdrew the record without a public marker.
    await db.doc("cmsPublishQueue/other-live-queue").set({
      status, transport: status === "success" ? "serializer" : "github",
      changes: [{ collection: "cmsPosts", id: RECORD, sourceVersion: 4, extra: "retained-legacy-field" }],
      artifactBuild: { buildBatchId: ACTIVE_BATCH, generation: 248,
        commitSha: "a".repeat(40), cutoffAt: time },
    });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("prior public publication attempt guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    { collection: "cmsPages", id: RECORD, sourceVersion: 4 },
    { collection: "cmsPosts", id: "another-record", sourceVersion: 4 },
    { collection: "cmsPosts", id: RECORD, sourceVersion: 3 },
    { collection: "cmsPosts", id: RECORD, sourceVersion: 4, operation: "withdraw" },
  ])("settles with unrelated terminal history %j", async (change) => {
    const state = await fixture();
    await db.doc("cmsPublishQueue/other-live-queue").set({ status: "success", changes: [change] });
    const unrelatedBefore = await db.doc("cmsPublishQueue/other-live-queue").get();
    await expect(run(state)).resolves.toMatchObject({ outcome: "settled", idempotent: false });
    const unrelatedAfter = await db.doc("cmsPublishQueue/other-live-queue").get();
    expect(unrelatedAfter.data()).toEqual(unrelatedBefore.data());
    expect(unrelatedAfter.updateTime).toEqual(unrelatedBefore.updateTime);
  });

  it.each([
    { activeDeploymentId: "replacement-at-same-generation" },
    { activeCommitSha: REPLACEMENT },
  ])("refuses changed predecessor identity %j without writes", async (update) => {
    const state = await fixture();
    await state.pointerRef.update(update);
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("predecessor or last reservation guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["recordRef", "queueRef", "batchRef", "pointerRef"])("refuses missing %s without writes", async (key) => {
    const state = await fixture();
    await state[key].delete();
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow(/missing|invalid/);
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    ["no addressed content", []],
    ["another collection", [{ collection: "cmsPages", id: RECORD, sourceVersion: 4 }]],
    ["another record", [{ collection: "cmsPosts", id: "another-record", sourceVersion: 4 }]],
    ["another revision", [{ collection: "cmsPosts", id: RECORD, sourceVersion: 5 }]],
    ["a withdrawal", [{ collection: "cmsPosts", id: RECORD, sourceVersion: 4, operation: "withdraw" }]],
    ["an invalid operation", [{ collection: "cmsPosts", id: RECORD, sourceVersion: 4, operation: "publish" }]],
  ])("refuses a cancelled queue for %s with a null owner and no writes", async (_name, changes) => {
    const state = await fixture();
    await state.recordRef.update({ publishBuildQueueId: null });
    await state.queueRef.update({ changes });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("original content publication guard");
    expect(await durableState(state)).toEqual(before);
  });

  it.each(["active", "activating", "failed", "unknown"])("refuses publisher state %s without writes", async (serviceState) => {
    const state = await fixture();
    const before = await durableState(state);
    await expect(run(state, state.intent, async () => serviceState)).rejects.toThrow("must be stopped");
    expect(await durableState(state)).toEqual(before);
  });

  it("deduplicates concurrent settlement and reports the persisted receipt without writes on retry", async () => {
    const state = await fixture();
    const results = await Promise.all([run(state), run(state)]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    const before = await durableState(state);
    await expect(run(state)).resolves.toEqual({ outcome: "settled", idempotent: true, receipt: results[0].receipt });
    expect(await durableState(state)).toEqual(before);
  });

  it.each([
    { operatorCommitSha: "d".repeat(40) }, { activeGeneration: 247 },
    { activeBuildBatchId: "different-batch" },
  ])("refuses a retry with changed receipt identity %j", async (update) => {
    const state = await fixture();
    await run(state);
    const before = await durableState(state);
    await expect(run(state, { ...state.intent, ...update })).rejects.toThrow("receipt or end state conflicts");
    expect(await durableState(state)).toEqual(before);
  });

  it("refuses a tampered settlement receipt without writes", async () => {
    const state = await fixture();
    await run(state);
    await state.recordRef.update({ "unpublishedWithdrawalSettlementReceipt.receiptDigest": "0".repeat(64) });
    const before = await durableState(state);
    await expect(run(state)).rejects.toThrow("receipt or end state conflicts");
    expect(await durableState(state)).toEqual(before);
  });

  it("admits the real baseline recovery after settlement and reserves generation 250", async () => {
    const state = await fixture();
    const queueId = "44444444444444444444";
    const input = { firestore: db, queueId, commitSha: REPLACEMENT, expected: {
      activeGeneration: 248, lastReservedGeneration: 249,
      activeDeploymentId: "deployment-248", activeCommitSha: "a".repeat(40),
    } };
    const before = await durableState(state);
    await expect(recoverCmsPublicationBaseline(input)).rejects.toThrow("Resolve pending content publication");
    expect(await durableState(state)).toEqual(before);
    const settled = await run(state);
    await expect(recoverCmsPublicationBaseline(input)).resolves.toMatchObject({ status: "pending", idempotent: false });
    // Exact retries remain safe after baseline admission changes coordinator and queue state.
    const afterRecovery = await durableState(state);
    await expect(run(state)).resolves.toEqual({ outcome: "settled", idempotent: true, receipt: settled.receipt });
    expect(await durableState(state)).toEqual(afterRecovery);
    await claimCmsPublishQueue({ firestore: db, queueId, buildBatchId: `cms-${queueId}`,
      commitSha: REPLACEMENT, serializerId: "test-owner",
      claimToken: "11111111-1111-4111-8111-111111111111" });
    await expect(reserveCmsPublishArtifact({ firestore: db, queueId,
      buildBatchId: `cms-${queueId}`, commitSha: REPLACEMENT })).resolves.toMatchObject({ generation: 250 });
    expect((await state.recordRef.get()).data()).toMatchObject({ deleted: true, deletedAt: time, publiclyVisible: false });
  });

  it("parses the incident command and refuses ambiguous or unsafe arguments", () => {
    const args = ["--apply", OPERATOR, "cmsPosts", RECORD, "4", QUEUE, "248", ACTIVE_BATCH];
    expect(parseSettlementArguments(args)).toMatchObject({ sourceVersion: 4, activeGeneration: 248, recordId: RECORD });
    for (const [index, value] of [[2, "media_assets"], [3, "nested/id"], [4, "4.0"],
      [4, "0"], [5, "wrong"], [6, "9007199254740992"], [7, "../batch"]]) {
      const invalid = [...args];
      invalid[index] = value;
      expect(() => parseSettlementArguments(invalid)).toThrow("Usage:");
    }
  });
});

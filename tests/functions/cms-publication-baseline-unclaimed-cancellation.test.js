import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firebaseAdminRuntime } from
  "../../site/scripts/firebase-admin-runtime";
import { openCmsPublicationTokenJournal } from
  "../../site/scripts/cms-publication-token-journal";
import { runCmsPublicationBaselineUnclaimedCancellation } from
  "../../site/scripts/cancel-unclaimed-cms-publication-baseline";

const requireModule = createRequire(import.meta.url);
const cancellationModule = requireModule(
  "../../functions/lib/cms-publication-baseline-unclaimed-cancellation.js",
);
const baselineModule = requireModule(
  "../../functions/lib/cms-publication-baseline.js",
);
const serializerModule = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
);
const { cancelUnclaimedCmsPublicationBaseline } = cancellationModule;
const { enqueueCmsPublicationBaseline } = baselineModule;
const { cmsPublicationSerializerTokenDigest } = serializerModule;

const PROJECT = "demo-njpbs-unclaimed-baseline-cancellation";
const QUEUE_ID = "Apex0902Cutover00004";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const QUEUE_COMMIT_SHA = "d".repeat(40);
const OPERATOR_COMMIT_SHA = "e".repeat(40);
const SERIALIZER_ID = "node-compute-primary";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const CLAIM_TOKEN_DIGEST = cmsPublicationSerializerTokenDigest(CLAIM_TOKEN);

let app;
let db;

function pointer(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: 4,
    activeDeploymentId: "deployment-4",
    activeCommitSha: "c".repeat(40),
    lastReservedGeneration: 4,
    newestEligibleGeneration: 4,
    newestEligibleBuildBatchId: "cms-previous-build",
    updatedAt: firebaseAdminRuntime.Timestamp.fromMillis(1_788_000_000_000),
    ...overrides,
  };
}

function pendingQueue(overrides = {}) {
  return {
    status: "pending",
    transport: "serializer",
    triggeredBy: "system:publication-baseline",
    triggeredByEmail: null,
    triggeredAt: firebaseAdminRuntime.Timestamp.fromMillis(1_788_000_000_001),
    completedAt: null,
    error: null,
    changes: [],
    commitSha: QUEUE_COMMIT_SHA,
    ...overrides,
  };
}

function refs() {
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  return {
    pointerRef,
    batchRef,
    candidateRef: batchRef.collection("candidates").doc("worker"),
    manifestRef: batchRef.collection("manifests").doc("publicMedia"),
    verificationRef: batchRef.collection("manifests").doc("publicMedia")
      .collection("verifications").doc("complete"),
    manifestChunkRef: batchRef.collection("manifests").doc("publicMedia")
      .collection("chunks").doc("000000"),
    queueRef: db.collection("cmsPublishQueue").doc(QUEUE_ID),
  };
}

function intent() {
  return {
    operatorCommitSha: OPERATOR_COMMIT_SHA,
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    queueCommitSha: QUEUE_COMMIT_SHA,
    serializerId: SERIALIZER_ID,
  };
}

function expected(claimTokenDigest = CLAIM_TOKEN_DIGEST) {
  return { ...intent(), claimTokenDigest };
}

function storeCancel(expectedValue = expected()) {
  return cancelUnclaimedCmsPublicationBaseline({
    firestore: db,
    expected: expectedValue,
    serverTimestamp: () => firebaseAdminRuntime.FieldValue.serverTimestamp(),
  });
}

async function journalDirectory() {
  return mkdtemp(path.join(tmpdir(), "njpbs-unclaimed-baseline-"));
}

async function retainedJournal(stateDirectory) {
  const journal = await openCmsPublicationTokenJournal({
    stateDirectory,
    serializerId: SERIALIZER_ID,
  });
  const reservation = await journal.reserve({
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    commitSha: QUEUE_COMMIT_SHA,
  });
  return { journal, job: reservation.job };
}

beforeAll(() => {
  app = firebaseAdminRuntime.initializeApp(
    { projectId: PROJECT },
    PROJECT,
  );
  db = firebaseAdminRuntime.getFirestore(app);
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
});

afterAll(async () => {
  await firebaseAdminRuntime.deleteApp(app);
});

describe("unclaimed CMS publication baseline cancellation", () => {
  it("cancels the real pending baseline and clears only its retained journal", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const state = refs();
      await state.pointerRef.set(pointer());
      await enqueueCmsPublicationBaseline(
        {
          firestore: db,
          queueId: QUEUE_ID,
          commitSha: QUEUE_COMMIT_SHA,
        },
        { assertPublishedMediaSafeFn: async () => ({ safe: true }) },
      );
      const pointerBefore = (await state.pointerRef.get()).data();
      const { journal, job } = await retainedJournal(stateDirectory);

      const result = await runCmsPublicationBaselineUnclaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      });
      const [queue, pointerAfter, batch, candidate, manifest, verification] =
        await Promise.all([
          state.queueRef.get(),
          state.pointerRef.get(),
          state.batchRef.get(),
          state.candidateRef.get(),
          state.manifestRef.get(),
          state.verificationRef.get(),
        ]);
      const cancellationLogs = (await db.collection("admin_logs")
        .where("action", "==", "cms-publication-baseline.cancel-unclaimed")
        .get()).docs;

      expect(result).toMatchObject({
        outcome: "cancelled",
        idempotent: false,
        queueIdempotent: false,
        journalIdempotent: false,
      });
      expect(JSON.stringify(result)).not.toContain(job.claimToken);
      expect(JSON.stringify(result)).not.toContain(
        cmsPublicationSerializerTokenDigest(job.claimToken),
      );
      expect(queue.data()).toMatchObject({
        status: "cancelled",
        error:
          "Unclaimed publication baseline cancelled after its source was superseded.",
        unclaimedBaselineCancellationReceipt: {
          schemaVersion: 1,
          reason: "source_superseded_before_serializer_claim",
          queueId: QUEUE_ID,
          buildBatchId: BUILD_BATCH_ID,
          queueCommitSha: QUEUE_COMMIT_SHA,
          operatorCommitSha: OPERATOR_COMMIT_SHA,
          serializerId: SERIALIZER_ID,
          claimTokenDigest: cmsPublicationSerializerTokenDigest(job.claimToken),
        },
      });
      expect(pointerAfter.data()).toEqual(pointerBefore);
      expect([batch.exists, candidate.exists, manifest.exists, verification.exists])
        .toEqual([false, false, false, false]);
      await expect(journal.read()).resolves.toBeNull();
      expect(cancellationLogs).toHaveLength(1);
      expect(cancellationLogs[0].data()).toMatchObject({
        action: "cms-publication-baseline.cancel-unclaimed",
        actorUid: "system:publication-baseline",
        source: "cms-publication-baseline-unclaimed-cancellation",
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("retains bounded static-return intent through cancellation and lost-response replay", async () => {
    const state = refs();
    const noBuildStaticReturn = { schemaVersion: 1, postId: "pilot-post", operationId: "11111111111111111111",
      sourceVersion: 2, visible: true, slug: "pilot-story", ownedSlugs: ["pilot-story"],
      snapshotDigest: "a".repeat(64), contextDigest: "b".repeat(64) };
    await state.pointerRef.set(pointer());
    await state.queueRef.set({ ...pendingQueue(), noBuildStaticReturn });
    const first = await storeCancel();
    const retry = await storeCancel();
    expect(first.outcome).toBe("cancelled");
    expect(retry.idempotent).toBe(true);
    expect((await state.queueRef.get()).data().noBuildStaticReturn).toEqual(noBuildStaticReturn);
    expect((await state.pointerRef.get()).data()).toEqual(pointer());
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("recovers both journal-clear crash windows without another write", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const state = refs();
      await Promise.all([
        state.pointerRef.set(pointer()),
        state.queueRef.set(pendingQueue()),
      ]);
      const { journal, job } = await retainedJournal(stateDirectory);

      await storeCancel(expected(
        cmsPublicationSerializerTokenDigest(job.claimToken),
      ));
      await expect(journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });

      await expect(runCmsPublicationBaselineUnclaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).resolves.toMatchObject({
        outcome: "cancelled",
        queueIdempotent: true,
        journalIdempotent: false,
      });
      await expect(journal.read()).resolves.toBeNull();

      await Promise.all([
        state.pointerRef.set(pointer({ mediaLifecycleReady: true })),
        state.batchRef.set({ later: true }),
      ]);
      await expect(runCmsPublicationBaselineUnclaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).resolves.toMatchObject({
        outcome: "cancelled",
        idempotent: true,
        queueIdempotent: true,
        journalIdempotent: true,
      });
      expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("refuses a first mutation without the exact retained journal", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const state = refs();
      await Promise.all([
        state.pointerRef.set(pointer()),
        state.queueRef.set(pendingQueue()),
      ]);
      const journal = await openCmsPublicationTokenJournal({
        stateDirectory,
        serializerId: SERIALIZER_ID,
      });
      await expect(runCmsPublicationBaselineUnclaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow("no retained journal token");
      expect((await state.queueRef.get()).data()).toEqual(pendingQueue());
      expect((await db.collection("admin_logs").get()).empty).toBe(true);

      await journal.reserve({
        queueId: "Other0902Cutover0000",
        buildBatchId: "cms-Other0902Cutover0000",
        commitSha: QUEUE_COMMIT_SHA,
      });
      await expect(runCmsPublicationBaselineUnclaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow("belongs to another job");
      expect((await state.queueRef.get()).data()).toEqual(pendingQueue());
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["serializer claim", { serializerClaim: { claim: true } }],
    ["artifact build", { artifactBuild: { build: true } }],
    ["artifact inclusion", { artifactInclusion: { inclusion: true } }],
    ["deployment receipt", { deploymentReceipt: { deployment: true } }],
    ["content changes", { changes: ["cmsPosts/post-1"] }],
    ["completed timestamp", { completedAt: firebaseAdminRuntime.Timestamp.fromMillis(2) }],
    ["error", { error: "failed" }],
    ["publishing status", { status: "publishing" }],
  ])("refuses pending queue evidence: %s", async (_label, evidence) => {
    const state = refs();
    await Promise.all([
      state.pointerRef.set(pointer()),
      state.queueRef.set(pendingQueue(evidence)),
    ]);

    await expect(storeCancel()).rejects.toThrow();
    expect((await state.queueRef.get()).data()).toEqual(pendingQueue(evidence));
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it.each([
    ["busy pointer", "pointer", pointer({
      state: "deploying",
      leaseToken: "lease-5",
      leaseAcquiredAt: firebaseAdminRuntime.Timestamp.fromMillis(3),
      candidateGeneration: 5,
      candidateBuildBatchId: "cms-later-build",
      candidateCommitSha: "f".repeat(40),
      predecessorGeneration: 4,
      predecessorDeploymentId: "deployment-4",
      predecessorCommitSha: "c".repeat(40),
      lastReservedGeneration: 5,
      newestEligibleGeneration: 5,
      newestEligibleBuildBatchId: "cms-later-build",
    })],
    ["media-ready pointer", "pointer", pointer({ mediaLifecycleReady: true })],
    ["build batch", "batch", { evidence: true }],
    ["Worker candidate", "candidate", { evidence: true }],
    ["media manifest", "manifest", { evidence: true }],
    ["orphan media manifest chunk", "manifestChunk", { evidence: true }],
    ["media verification", "verification", { evidence: true }],
  ])("refuses first-mutation deployment evidence: %s", async (
    _label,
    evidenceType,
    evidence,
  ) => {
    const state = refs();
    await state.queueRef.set(pendingQueue());
    if (evidenceType === "pointer") {
      await state.pointerRef.set(evidence);
    } else {
      await Promise.all([
        state.pointerRef.set(pointer()),
        state[`${evidenceType}Ref`].set(evidence),
      ]);
    }

    await expect(storeCancel()).rejects.toThrow();
    expect((await state.queueRef.get()).data()).toEqual(pendingQueue());
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });
});

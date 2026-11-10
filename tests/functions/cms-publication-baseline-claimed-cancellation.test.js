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
import { runCmsPublicationBaselineClaimedCancellation } from
  "../../site/scripts/cancel-claimed-cms-publication-baseline";

const requireModule = createRequire(import.meta.url);
const cancellationModule = requireModule(
  "../../functions/lib/cms-publication-baseline-claimed-cancellation.js",
);
const serializerModule = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
);
const deploymentModule = requireModule(
  "../../functions/lib/public-deployment.js",
);
const { cancelClaimedCmsPublicationBaseline } = cancellationModule;
const { cmsPublicationSerializerTokenDigest } = serializerModule;
const { assertPublicDeploymentReservedBatch } = deploymentModule;

const PROJECT = "demo-njpbs-claimed-baseline-cancellation";
const QUEUE_ID = "Apex0903Cutover00001";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const GENERATION = 37;
const QUEUE_COMMIT_SHA = "e".repeat(40);
const OPERATOR_COMMIT_SHA = "f".repeat(40);
const ACTIVE_COMMIT_SHA = "a".repeat(40);
const SERIALIZER_ID = "node-compute-primary";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const CLAIM_TOKEN_DIGEST = cmsPublicationSerializerTokenDigest(CLAIM_TOKEN);
const ARTIFACT_RECEIPT_DIGEST = "b".repeat(64);

const triggeredAt = firebaseAdminRuntime.Timestamp.fromMillis(1_788_000_000_000);
const claimedAt = new firebaseAdminRuntime.Timestamp(
  triggeredAt.seconds,
  triggeredAt.nanoseconds + 1_000,
);
const cutoffAt = new firebaseAdminRuntime.Timestamp(
  triggeredAt.seconds,
  triggeredAt.nanoseconds + 2_000,
);
const reservedAt = new firebaseAdminRuntime.Timestamp(
  triggeredAt.seconds,
  triggeredAt.nanoseconds + 3_000,
);
const inclusionRecordedAt = new firebaseAdminRuntime.Timestamp(
  triggeredAt.seconds,
  triggeredAt.nanoseconds + 4_000,
);

let app;
let db;

function pointer(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: 33,
    activeDeploymentId: "deployment-33",
    activeCommitSha: ACTIVE_COMMIT_SHA,
    lastReservedGeneration: GENERATION,
    newestEligibleGeneration: 33,
    newestEligibleBuildBatchId: "cms-Apex0902Cutover00003",
    updatedAt: triggeredAt,
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    schemaVersion: 1,
    serializerId: SERIALIZER_ID,
    buildBatchId: BUILD_BATCH_ID,
    commitSha: QUEUE_COMMIT_SHA,
    tokenDigest: CLAIM_TOKEN_DIGEST,
    claimedAt,
    ...overrides,
  };
}

function artifactBuild(overrides = {}) {
  return {
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: QUEUE_COMMIT_SHA,
    cutoffAt,
    ...overrides,
  };
}

function publishingQueue(overrides = {}) {
  return {
    status: "publishing",
    transport: "serializer",
    triggeredBy: "system:publication-baseline",
    triggeredByEmail: null,
    triggeredAt,
    completedAt: null,
    error: null,
    changes: [],
    commitSha: QUEUE_COMMIT_SHA,
    serializerClaim: claim(),
    artifactBuild: artifactBuild(),
    ...overrides,
  };
}

function artifactInclusion(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: QUEUE_COMMIT_SHA,
    cutoffAt,
    artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
    recordedAt: inclusionRecordedAt,
    ...overrides,
  };
}

function reservedBatch(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    status: "reserved",
    commitSha: QUEUE_COMMIT_SHA,
    reservedAgainstGeneration: 33,
    reservedAgainstDeploymentId: "deployment-33",
    reservedAgainstCommitSha: ACTIVE_COMMIT_SHA,
    cutoffAt,
    reservedAt,
    ...overrides,
  };
}

function refs() {
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  return {
    pointerRef,
    batchRef,
    queueRef: db.collection("cmsPublishQueue").doc(QUEUE_ID),
    candidateRef: batchRef.collection("candidates").doc("worker"),
    manifestRef,
    manifestChunkRef: manifestRef.collection("chunks").doc("000000"),
    verificationRef: manifestRef.collection("verifications").doc("complete"),
  };
}

async function seed(overrides = {}) {
  const state = refs();
  await Promise.all([
    state.pointerRef.set(overrides.pointer ?? pointer()),
    state.queueRef.set(overrides.queue ?? publishingQueue()),
    state.batchRef.set(overrides.batch ?? reservedBatch()),
  ]);
  return state;
}

function intent() {
  return {
    operatorCommitSha: OPERATOR_COMMIT_SHA,
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    queueCommitSha: QUEUE_COMMIT_SHA,
    serializerId: SERIALIZER_ID,
  };
}

function expected(claimTokenDigest = CLAIM_TOKEN_DIGEST) {
  return { ...intent(), claimTokenDigest };
}

function storeCancel(expectedValue = expected()) {
  return cancelClaimedCmsPublicationBaseline({
    firestore: db,
    expected: expectedValue,
    serverTimestamp: () => firebaseAdminRuntime.FieldValue.serverTimestamp(),
  });
}

async function journalDirectory() {
  return mkdtemp(path.join(tmpdir(), "njpbs-claimed-baseline-"));
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

async function seedIncludedOperatorState(
  stateDirectory,
  {
    inclusion = artifactInclusion(),
    batch = reservedBatch(),
  } = {},
) {
  const { journal, job } = await retainedJournal(stateDirectory);
  const tokenDigest = cmsPublicationSerializerTokenDigest(job.claimToken);
  const state = await seed({
    queue: publishingQueue({
      serializerClaim: claim({ tokenDigest }),
      artifactInclusion: inclusion,
    }),
    batch,
  });
  return { journal, job, state };
}

beforeAll(() => {
  app = firebaseAdminRuntime.initializeApp({ projectId: PROJECT }, PROJECT);
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

describe("claimed CMS publication baseline cancellation", () => {
  it("atomically cancels the queue and reserved batch before journal clear", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const { journal, job } = await retainedJournal(stateDirectory);
      const tokenDigest = cmsPublicationSerializerTokenDigest(job.claimToken);
      const state = await seed({
        queue: publishingQueue({
          serializerClaim: claim({
            tokenDigest,
          }),
        }),
      });
      const pointerBefore = (await state.pointerRef.get()).data();

      const result = await runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      });
      const [queue, batch, pointerAfter, logs] = await Promise.all([
        state.queueRef.get(),
        state.batchRef.get(),
        state.pointerRef.get(),
        db.collection("admin_logs").get(),
      ]);

      expect(result).toMatchObject({
        outcome: "cancelled",
        idempotent: false,
        queueIdempotent: false,
        journalIdempotent: false,
      });
      expect(JSON.stringify(result)).not.toContain(job.claimToken);
      expect(JSON.stringify(result)).not.toContain(tokenDigest);
      expect(queue.data()).toMatchObject({
        status: "cancelled",
        error:
          "Claimed publication baseline cancelled before a public candidate was created.",
        claimedBaselineCancellationReceipt: {
          schemaVersion: 2,
          reason: "source_superseded_before_candidate",
          queueId: QUEUE_ID,
          buildBatchId: BUILD_BATCH_ID,
          generation: GENERATION,
          queueCommitSha: QUEUE_COMMIT_SHA,
          operatorCommitSha: OPERATOR_COMMIT_SHA,
          serializerId: SERIALIZER_ID,
          claimTokenDigest: tokenDigest,
          artifactReceiptDigest: null,
          artifactInclusionRecordedAt: null,
        },
      });
      expect(batch.data()).toMatchObject({
        status: "cancelled",
        cancelledReason: "source_superseded_before_candidate",
        cancellationReceipt: queue.data().claimedBaselineCancellationReceipt,
      });
      expect(pointerAfter.data()).toEqual(pointerBefore);
      await expect(journal.read()).resolves.toBeNull();
      expect(logs.docs).toHaveLength(1);
      expect(logs.docs[0].data()).toMatchObject({
        action: "cms-publication-baseline.cancel-claimed",
        actorUid: "system:publication-baseline",
        source: "cms-publication-baseline-claimed-cancellation",
        before: { queueStatus: "publishing", batchStatus: "reserved" },
        after: { queueStatus: "cancelled", batchStatus: "cancelled" },
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("cancels an included artifact and preserves its exact queue evidence", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const { journal, job, state } = await seedIncludedOperatorState(
        stateDirectory,
      );
      const tokenDigest = cmsPublicationSerializerTokenDigest(job.claimToken);
      const inclusion = artifactInclusion();
      const pointerBefore = (await state.pointerRef.get()).data();

      const first = await runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      });
      expect(first).toMatchObject({
        outcome: "cancelled",
        idempotent: false,
        queueIdempotent: false,
        journalIdempotent: false,
      });
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).resolves.toMatchObject({
        outcome: "cancelled",
        idempotent: true,
        queueIdempotent: true,
        journalIdempotent: true,
      });

      const [queue, batch, pointerAfter, logs] = await Promise.all([
        state.queueRef.get(),
        state.batchRef.get(),
        state.pointerRef.get(),
        db.collection("admin_logs").get(),
      ]);
      expect(queue.data().artifactInclusion).toEqual(inclusion);
      expect(queue.data()).toMatchObject({
        status: "cancelled",
        claimedBaselineCancellationReceipt: {
          schemaVersion: 2,
          queueId: QUEUE_ID,
          buildBatchId: BUILD_BATCH_ID,
          generation: GENERATION,
          cutoffAt,
          artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
          artifactInclusionRecordedAt: inclusionRecordedAt,
        },
      });
      expect(batch.data()).toMatchObject({
        status: "cancelled",
        cancellationReceipt: queue.data().claimedBaselineCancellationReceipt,
      });
      expect(pointerAfter.data()).toEqual(pointerBefore);
      await expect(journal.read()).resolves.toBeNull();
      expect(logs.docs).toHaveLength(1);
      expect(logs.docs[0].data()).toMatchObject({
        before: { artifactInclusionPresent: true },
        after: { artifactInclusionPresent: true },
      });
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("retries an included cancellation without changing evidence or audit", async () => {
    const state = await seed({
      queue: publishingQueue({ artifactInclusion: artifactInclusion() }),
    });
    const first = await storeCancel();
    const storedAfterFirst = (await state.queueRef.get()).data();
    const includedAfterFirst = storedAfterFirst.artifactInclusion;
    const retry = await storeCancel(expected(null));

    expect(first.idempotent).toBe(false);
    expect(retry).toMatchObject({ outcome: "cancelled", idempotent: true });
    expect(retry.receipt.cancelledAt.toMillis())
      .toBe(storedAfterFirst.completedAt.toMillis());
    expect((await state.queueRef.get()).data().artifactInclusion)
      .toEqual(includedAfterFirst);
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it("recovers both journal-clear crash windows after later pointer progress", async () => {
    const stateDirectory = await journalDirectory();
    try {
      const { journal, job } = await retainedJournal(stateDirectory);
      const tokenDigest = cmsPublicationSerializerTokenDigest(job.claimToken);
      const state = await seed({
        queue: publishingQueue({
          serializerClaim: claim({ tokenDigest }),
        }),
      });
      await storeCancel(expected(
        tokenDigest,
      ));

      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).resolves.toMatchObject({
        queueIdempotent: true,
        journalIdempotent: false,
      });
      await state.pointerRef.set(pointer({
        activeGeneration: 38,
        activeDeploymentId: "deployment-38",
        activeCommitSha: OPERATOR_COMMIT_SHA,
        lastReservedGeneration: 38,
        newestEligibleGeneration: 38,
        newestEligibleBuildBatchId: "cms-Apex0903Cutover00002",
      }));
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).resolves.toMatchObject({
        idempotent: true,
        queueIdempotent: true,
        journalIdempotent: true,
      });
      expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("refuses a missing or conflicting retained journal on first mutation", async () => {
    const stateDirectory = await journalDirectory();
    try {
      await seed();
      const journal = await openCmsPublicationTokenJournal({
        stateDirectory,
        serializerId: SERIALIZER_ID,
      });
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow("no retained journal token");

      await journal.reserve({
        queueId: "Other0903Cutover0000",
        buildBatchId: "cms-Other0903Cutover0000",
        commitSha: QUEUE_COMMIT_SHA,
      });
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow("belongs to another job");
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["content changes", { queue: publishingQueue({ changes: [{ id: "post" }] }) }],
    ["wrong transport", { queue: publishingQueue({ transport: "github" }) }],
    ["wrong source", { queue: publishingQueue({ commitSha: "0".repeat(40) }) }],
    ["wrong serializer", {
      queue: publishingQueue({
        serializerClaim: claim({ serializerId: "another-serializer" }),
      }),
    }],
    ["wrong claim token", {
      queue: publishingQueue({
        serializerClaim: claim({ tokenDigest: "0".repeat(64) }),
      }),
    }],
    ["another generation", {
      queue: publishingQueue({ artifactBuild: artifactBuild({ generation: 38 }) }),
    }],
    ["another cutoff", {
      queue: publishingQueue({
        artifactBuild: artifactBuild({
          cutoffAt: new firebaseAdminRuntime.Timestamp(
            cutoffAt.seconds,
            cutoffAt.nanoseconds + 1_000,
          ),
        }),
      }),
    }],
    ["progressed batch", { batch: reservedBatch({ status: "ready", readyAt: reservedAt }) }],
    ["unsafe pointer", { pointer: pointer({ mediaLifecycleReady: true }) }],
    ["eligible target generation", {
      pointer: pointer({
        newestEligibleGeneration: GENERATION,
        newestEligibleBuildBatchId: "cms-different-build",
      }),
    }],
    ["claim before trigger", {
      queue: publishingQueue({
        serializerClaim: claim({
          claimedAt: new firebaseAdminRuntime.Timestamp(
            triggeredAt.seconds - 1,
            triggeredAt.nanoseconds,
          ),
        }),
      }),
    }],
    ["cutoff before claim", {
      batch: reservedBatch({ cutoffAt: triggeredAt }),
      queue: publishingQueue({ artifactBuild: artifactBuild({ cutoffAt: triggeredAt }) }),
    }],
  ])("refuses unsafe first-mutation state: %s", async (_label, overrides) => {
    await seed(overrides);
    await expect(storeCancel()).rejects.toThrow();
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it.each([
    ["missing inclusion field", () => {
      const missingRecordedAt = artifactInclusion();
      delete missingRecordedAt.recordedAt;
      return missingRecordedAt;
    }],
    ["unknown inclusion field", () => artifactInclusion({ unknown: true })],
    ["another build", () => artifactInclusion({
      buildBatchId: "cms-Other0903Cutover0000",
    })],
    ["another generation", () => artifactInclusion({
      generation: GENERATION + 1,
    })],
    ["another commit", () => artifactInclusion({
      commitSha: "0".repeat(40),
    })],
    ["another cutoff", () => artifactInclusion({
      cutoffAt: new firebaseAdminRuntime.Timestamp(
        cutoffAt.seconds,
        cutoffAt.nanoseconds + 1_000,
      ),
    })],
    ["invalid artifact digest", () => artifactInclusion({
      artifactReceiptDigest: "invalid",
    })],
    ["recorded before reservation", () => artifactInclusion({
      recordedAt: cutoffAt,
    })],
    ["recorded before cutoff", () => artifactInclusion({
      recordedAt: triggeredAt,
    })],
  ])("refuses %s evidence on an included artifact", async (_label, inclusion) => {
    const stateDirectory = await journalDirectory();
    try {
      const { journal } = await seedIncludedOperatorState(stateDirectory, {
        inclusion: inclusion(),
      });
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow(/inclusion|evidence|conflict/i);
      await expect(journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each(["candidate", "manifest", "manifestChunk", "verification"])(
    "refuses existing %s evidence after artifact inclusion",
    async (evidence) => {
      const stateDirectory = await journalDirectory();
      try {
        const { journal, state } = await seedIncludedOperatorState(
          stateDirectory,
        );
        await state[`${evidence}Ref`].set({ evidence: true });
        await expect(runCmsPublicationBaselineClaimedCancellation({
          firestore: db,
          journal,
          intent: intent(),
        })).rejects.toThrow();
        await expect(journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });
        expect((await db.collection("admin_logs").get()).empty).toBe(true);
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["readiness", { status: "ready", readyAt: inclusionRecordedAt }],
    ["lease", { leaseToken: "existing-lease" }],
    ["deployment", { deploymentId: "existing-deployment" }],
  ])("refuses existing %s state after artifact inclusion", async (_label, fields) => {
    const stateDirectory = await journalDirectory();
    try {
      const { journal } = await seedIncludedOperatorState(stateDirectory, {
        batch: reservedBatch(fields),
      });
      await expect(runCmsPublicationBaselineClaimedCancellation({
        firestore: db,
        journal,
        intent: intent(),
      })).rejects.toThrow();
      await expect(journal.read()).resolves.toMatchObject({ queueId: QUEUE_ID });
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("never hides a changed stored claim after the journal is empty", async () => {
    const state = await seed();
    await storeCancel();
    await state.queueRef.update({
      "serializerClaim.tokenDigest": "0".repeat(64),
    });
    await expect(storeCancel(expected(null))).rejects.toThrow(/claim|receipt/i);
  });

  it("never hides changed inclusion evidence after the journal is empty", async () => {
    const state = await seed({
      queue: publishingQueue({ artifactInclusion: artifactInclusion() }),
    });
    await storeCancel();
    await state.queueRef.update({
      "artifactInclusion.artifactReceiptDigest": "0".repeat(64),
    });

    await expect(storeCancel(expected(null))).rejects.toThrow(
      /inclusion|receipt/i,
    );
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it("requires queue and batch receipts to keep the same inclusion binding", async () => {
    const state = await seed({
      queue: publishingQueue({ artifactInclusion: artifactInclusion() }),
    });
    await storeCancel();
    await state.batchRef.update({
      "cancellationReceipt.artifactReceiptDigest": "0".repeat(64),
    });

    await expect(storeCancel(expected(null))).rejects.toThrow(/batch|receipt/i);
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it("serializes cancellation against a competing readiness transition", async () => {
    const state = await seed();
    const readiness = db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(state.batchRef);
      assertPublicDeploymentReservedBatch(snapshot.data(), BUILD_BATCH_ID);
      transaction.update(state.batchRef, {
        status: "ready",
        readyAt: firebaseAdminRuntime.FieldValue.serverTimestamp(),
      });
      return "ready";
    });
    const cancellation = storeCancel();
    const results = await Promise.allSettled([readiness, cancellation]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const batch = (await state.batchRef.get()).data();
    const queue = (await state.queueRef.get()).data();
    if (batch.status === "cancelled") {
      expect(queue.status).toBe("cancelled");
    } else {
      expect(batch.status).toBe("ready");
      expect(queue.status).toBe("publishing");
    }
  });
});

import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { canonicalPublicationReceipt } from
  "../../site/src/lib/public-publication-receipt";
import { openCmsPublicationTokenJournal } from
  "../../site/scripts/cms-publication-token-journal";
import { runCmsPublicationBaselineRetirement } from
  "../../site/scripts/retire-cms-publication-baseline";

const requireModule = createRequire(import.meta.url);
const requireSiteModule = createRequire(
  new URL("../../site/package.json", import.meta.url),
);
const siteAppModule = requireSiteModule("firebase-admin/app");
const siteFirestoreModule = requireSiteModule("firebase-admin/firestore");
const retirementModule = requireModule(
  "../../functions/lib/cms-publication-baseline-retirement.js",
);
const serializerModule = requireModule(
  "../../functions/lib/cms-publication-serializer.js",
);
const cloudflareEvidenceModule = requireModule(
  "../../functions/lib/public-deployment-cloudflare.js",
);
const {
  readCmsPublicationBaselineRetirementState,
  retireCmsPublicationBaseline,
} = retirementModule;
const { cmsPublicationSerializerTokenDigest } = serializerModule;
const { publicDeploymentCloudflareEvidenceDigest } = cloudflareEvidenceModule;

const admin = adminPkg;
const PROJECT = "demo-njpbs-baseline-retirement";
const QUEUE_ID = "Apex0902Cutover00003";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const GENERATION = 33;
const COMMIT_SHA = "f".repeat(40);
const PREDECESSOR_COMMIT_SHA = "a".repeat(40);
const DEPLOYMENT_ID = "8a30d4d0-3119-44ba-8239-5c60d053384f";
const VERSION_ID = "a3ccb239-88e5-43aa-8643-01c6616704a1";
const PREDECESSOR_DEPLOYMENT_ID =
  "11111111-1111-4111-8111-111111111111";
const LEASE_TOKEN = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const SERIALIZER_ID = "node-compute-primary";
const MANIFEST_DIGEST = "b".repeat(64);
const ARTIFACT_DIGEST = "c".repeat(64);
const ARTIFACT_RECEIPT_DIGEST = "d".repeat(64);
const PUBLICATION_RECEIPT_DIGEST = "e".repeat(64);
const CLOUDFLARE_EVIDENCE_DIGEST = publicDeploymentCloudflareEvidenceDigest({
  action: "activate",
  buildBatchId: BUILD_BATCH_ID,
  deploymentId: DEPLOYMENT_ID,
  versionId: VERSION_ID,
  commitSha: COMMIT_SHA,
}, BUILD_BATCH_ID);
const WORKER_TAG = "d".repeat(32);
const WORKER_TOKEN = "w".repeat(40);
const ROUTE_TOKEN = "r".repeat(40);

const cutoffAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:28:59.000Z"),
);
const reservedAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:29:00.000Z"),
);
const readyAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:31:00.000Z"),
);
const leaseAcquiredAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:31:01.000Z"),
);
const deployedAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:32:00.000Z"),
);
const conflictingCutoffAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:29:01.000Z"),
);
const verifiedAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-09-02T23:30:00.000Z"),
);
const nanosecondCutoffConflict = new admin.firestore.Timestamp(
  cutoffAt.seconds,
  cutoffAt.nanoseconds + 1_000,
);
const nanosecondLeaseConflict = new admin.firestore.Timestamp(
  leaseAcquiredAt.seconds,
  leaseAcquiredAt.nanoseconds + 1_000,
);

let db;
let app;
let siteDb;
let siteApp;

function expected(overrides = {}) {
  return {
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
    serializerId: SERIALIZER_ID,
    claimTokenDigest: cmsPublicationSerializerTokenDigest(CLAIM_TOKEN),
    ...overrides,
  };
}

function pointer(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: GENERATION,
    activeDeploymentId: DEPLOYMENT_ID,
    activeCommitSha: COMMIT_SHA,
    lastReservedGeneration: GENERATION,
    newestEligibleGeneration: GENERATION,
    newestEligibleBuildBatchId: BUILD_BATCH_ID,
    updatedAt: deployedAt,
    ...overrides,
  };
}

function reconcilingPointer(overrides = {}) {
  return {
    ...pointer(),
    state: "reconciling",
    activeGeneration: 11,
    activeDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    activeCommitSha: PREDECESSOR_COMMIT_SHA,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    candidateGeneration: GENERATION,
    candidateBuildBatchId: BUILD_BATCH_ID,
    candidateCommitSha: COMMIT_SHA,
    predecessorGeneration: 11,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    reconcilingAt: deployedAt,
    cloudflareEvidenceDigest: CLOUDFLARE_EVIDENCE_DIGEST,
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 11,
    reservedAgainstDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    reservedAgainstCommitSha: PREDECESSOR_COMMIT_SHA,
    cutoffAt,
    reservedAt,
    readyAt,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    predecessorGeneration: 11,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    status: "deployed",
    mediaManifestDigest: MANIFEST_DIGEST,
    cloudflareEvidenceDigest: CLOUDFLARE_EVIDENCE_DIGEST,
    deployedAt,
    deploymentId: DEPLOYMENT_ID,
    deploymentVersionId: VERSION_ID,
    ...overrides,
  };
}

function reconcilingBatch(overrides = {}) {
  const {
    deployedAt: _deployedAt,
    deploymentId: _deploymentId,
    deploymentVersionId: _deploymentVersionId,
    mediaManifestDigest: _mediaManifestDigest,
    ...leased
  } = batch();
  return {
    ...leased,
    status: "reconciling",
    reconcilingAt: deployedAt,
    cloudflareEvidenceDigest: CLOUDFLARE_EVIDENCE_DIGEST,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    workerName: "njpbs-production",
    workerVersionId: VERSION_ID,
    workerVersionTag: `cms-g${GENERATION}-${ARTIFACT_DIGEST.slice(0, 16)}`,
    versionCreatedOn: "2026-09-02T23:31:30.000Z",
    artifactDigest: ARTIFACT_DIGEST,
    artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
    publicationReceiptDigest: PUBLICATION_RECEIPT_DIGEST,
    mediaManifestDigest: MANIFEST_DIGEST,
    artifactFileCount: 2,
    artifactBytes: 1_000,
    wranglerVersion: "4.123.0",
    recordedAt: readyAt,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    digestAlgorithm: "sha256",
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    cutoffAt,
    coverage: [
      ["cmsPages", "1"],
      ["cmsPosts", "2"],
      ["cmsSettings", "3"],
      ["cmsAuthorProfilesPublic", "4"],
    ].map(([collection, digestStart]) => ({
      collection,
      complete: true,
      ownerCount: 0,
      ownerIdsDigest: digestStart.repeat(64),
    })),
    ownerCount: 0,
    maxOwnerWritesPerChunk: 200,
    maxChunkBytes: 2 * 1024 * 1024,
    maxVerificationBytes: 2 * 1024 * 1024,
    chunkCount: 0,
    mediaManifestDigest: MANIFEST_DIGEST,
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    mediaManifestDigest: MANIFEST_DIGEST,
    ownerCount: 0,
    chunkCount: 0,
    verifiedAt,
    ...overrides,
  };
}

function queue(overrides = {}) {
  return {
    status: "publishing",
    transport: "serializer",
    triggeredBy: "system:publication-baseline",
    triggeredByEmail: null,
    triggeredAt: cutoffAt,
    completedAt: null,
    error: null,
    changes: [],
    commitSha: COMMIT_SHA,
    serializerClaim: {
      schemaVersion: 1,
      serializerId: SERIALIZER_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
      tokenDigest: cmsPublicationSerializerTokenDigest(CLAIM_TOKEN),
      claimedAt: leaseAcquiredAt,
    },
    artifactBuild: {
      buildBatchId: BUILD_BATCH_ID,
      generation: GENERATION,
      commitSha: COMMIT_SHA,
      cutoffAt,
    },
    artifactInclusion: {
      schemaVersion: 1,
      buildBatchId: BUILD_BATCH_ID,
      generation: GENERATION,
      commitSha: COMMIT_SHA,
      cutoffAt,
      artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
      recordedAt: readyAt,
    },
    ...overrides,
  };
}

function refs(firestore = db) {
  const pointerRef = firestore.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  return {
    pointerRef,
    batchRef,
    candidateRef: batchRef.collection("candidates").doc("worker"),
    manifestRef: batchRef.collection("manifests").doc("publicMedia"),
    verificationRef: batchRef.collection("manifests").doc("publicMedia")
      .collection("verifications").doc("complete"),
    queueRef: firestore.collection("cmsPublishQueue").doc(QUEUE_ID),
  };
}

async function seed(overrides = {}, firestore = db) {
  const state = refs(firestore);
  await Promise.all([
    state.pointerRef.set(overrides.pointer ?? pointer()),
    state.batchRef.set(overrides.batch ?? batch()),
    state.candidateRef.set(overrides.candidate ?? candidate()),
    state.manifestRef.set(overrides.manifest ?? manifest()),
    state.verificationRef.set(overrides.verification ?? verification()),
    state.queueRef.set(overrides.queue ?? queue()),
  ]);
  return state;
}

beforeAll(() => {
  app = admin.initializeApp({ projectId: PROJECT }, PROJECT);
  db = admin.firestore(app);
  siteApp = siteAppModule.initializeApp(
    { projectId: PROJECT },
    `${PROJECT}-site-sdk`,
  );
  siteDb = siteFirestoreModule.getFirestore(siteApp);
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
});

afterAll(async () => {
  await Promise.all([
    app.delete(),
    siteAppModule.deleteApp(siteApp),
  ]);
});

describe("CMS publication baseline retirement store", () => {
  it("settles, retires, and clears the real journal from reconciling state", async () => {
    const stateDirectory = await mkdtemp(
      path.join(tmpdir(), "njpbs-baseline-retirement-integration-"),
    );
    try {
      const journal = await openCmsPublicationTokenJournal({
        stateDirectory,
        serializerId: SERIALIZER_ID,
      });
      const reservation = await journal.reserve({
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        commitSha: COMMIT_SHA,
      });
      const state = await seed({
        pointer: reconcilingPointer(),
        batch: reconcilingBatch(),
        queue: queue({
          serializerClaim: {
            ...queue().serializerClaim,
            tokenDigest: cmsPublicationSerializerTokenDigest(
              reservation.job.claimToken,
            ),
          },
        }),
      });
      const requestJson = vi.fn(async ({ url }) => {
        if (url.endsWith("/workers/scripts")) {
          return {
            success: true,
            result: [{ id: "njpbs-production", tag: WORKER_TAG }],
          };
        }
        if (url.endsWith("/triggers")) {
          return {
            success: true,
            result: [{
              trigger_uuid: "11111111-1111-4111-8111-111111111111",
              external_script_id: WORKER_TAG,
              deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
              root_directory: "/",
              branch_includes: ["production"],
              branch_excludes: [],
            }],
          };
        }
        if (url.endsWith("/workers/domains")) {
          return {
            success: true,
            result: [
              { hostname: "contact.njpbs.org" },
              { hostname: "preview.njpbs.org" },
            ],
            result_info: {
              count: 2,
              page: 1,
              total_count: 2,
            },
          };
        }
        if (url.endsWith("/workers/routes")) {
          return {
            success: true,
            result: [
              { pattern: "https://njpbs.org/contact" },
              { pattern: "https://njpbs.org/contact/*" },
            ],
          };
        }
        if (url.endsWith("/deployments")) {
          return {
            success: true,
            result: {
              deployments: [{
                id: DEPLOYMENT_ID,
                source: "api",
                strategy: "percentage",
                annotations: { "workers/triggered_by": "deployment" },
                versions: [{ version_id: VERSION_ID, percentage: 100 }],
                created_on: "2026-09-02T23:32:00.000Z",
              }],
            },
          };
        }
        throw new Error("unexpected provider request");
      });
      const requestApex = vi.fn(async () => ({
        body: `${JSON.stringify(canonicalPublicationReceipt({
          schemaVersion: 1,
          digestAlgorithm: "sha256",
          buildBatchId: "older-baseline",
          generation: 32,
          commitSha: PREDECESSOR_COMMIT_SHA,
          artifactDigest: "1".repeat(64),
          artifactReceiptDigest: "2".repeat(64),
          mediaManifestDigest: "3".repeat(64),
        }), null, 2)}\n`,
        publicationOrigin: null,
      }));

      const result = await runCmsPublicationBaselineRetirement({
        firestore: db,
        journal,
        intent: {
          operatorCommitSha: "b".repeat(40),
          queueId: QUEUE_ID,
          buildBatchId: BUILD_BATCH_ID,
          generation: GENERATION,
          commitSha: COMMIT_SHA,
          deploymentId: DEPLOYMENT_ID,
          versionId: VERSION_ID,
          serializerId: SERIALIZER_ID,
        },
        workerApiToken: WORKER_TOKEN,
        routeApiToken: ROUTE_TOKEN,
        dependencies: { requestJson, requestApex },
      });
      const [storedPointer, storedBatch, storedQueue, logs] =
        await Promise.all([
          state.pointerRef.get(),
          state.batchRef.get(),
          state.queueRef.get(),
          db.collection("admin_logs").get(),
        ]);

      expect(result).toMatchObject({
        outcome: "retired",
        idempotent: false,
        queueIdempotent: false,
        journalIdempotent: false,
      });
      expect(storedPointer.data()).toMatchObject({
        state: "idle",
        mediaLifecycleReady: false,
        activeGeneration: GENERATION,
        activeDeploymentId: DEPLOYMENT_ID,
        activeCommitSha: COMMIT_SHA,
      });
      expect(storedBatch.data()).toMatchObject({
        status: "deployed",
        deploymentId: DEPLOYMENT_ID,
        deploymentVersionId: VERSION_ID,
      });
      expect(storedQueue.data()).toMatchObject({
        status: "cancelled",
        baselineRetirementReceipt: {
          reason: "source_superseded_before_apex_cutover",
        },
      });
      await expect(journal.read()).resolves.toBeNull();
      expect(logs.docs.map((document) => document.data().action).sort())
        .toEqual([
          "cms-publication-baseline.retire",
          "public-deployment.activate",
        ]);
      expect(requestJson).toHaveBeenCalledTimes(15);
      expect(requestApex).toHaveBeenCalledTimes(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("projects the exact retained reconciling lease before provider work", async () => {
    await seed({
      pointer: reconcilingPointer(),
      batch: reconcilingBatch(),
    });

    const state = await readCmsPublicationBaselineRetirementState({
      firestore: db,
      expected: expected(),
    });

    expect(state).toMatchObject({
      phase: "reconciling",
      lease: {
        buildBatchId: BUILD_BATCH_ID,
        generation: GENERATION,
        commitSha: COMMIT_SHA,
        leaseToken: LEASE_TOKEN,
      },
      candidate: { workerVersionId: VERSION_ID },
      queue: { queue: { status: "publishing" }, receipt: null },
    });
  });

  it("cancels only the active empty baseline and writes one audit receipt", async () => {
    const state = await seed();

    const result = await retireCmsPublicationBaseline({
      firestore: db,
      expected: expected(),
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    });
    const [queueSnapshot, pointerSnapshot, logs] = await Promise.all([
      state.queueRef.get(),
      state.pointerRef.get(),
      db.collection("admin_logs").get(),
    ]);

    expect(result).toMatchObject({
      outcome: "cancelled",
      idempotent: false,
      receipt: {
        schemaVersion: 1,
        reason: "source_superseded_before_apex_cutover",
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        generation: GENERATION,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
    expect(queueSnapshot.data()).toMatchObject({
      status: "cancelled",
      error: "Pre-cutover baseline retired before apex publication.",
      gitCommitSha: COMMIT_SHA,
      baselineRetirementReceipt: result.receipt,
    });
    expect(queueSnapshot.data()).not.toHaveProperty("deploymentReceipt");
    expect(pointerSnapshot.data()).toMatchObject({
      state: "idle",
      mediaLifecycleReady: false,
      activeGeneration: GENERATION,
      activeDeploymentId: DEPLOYMENT_ID,
      activeCommitSha: COMMIT_SHA,
    });
    expect(logs.docs).toHaveLength(1);
    expect(logs.docs[0].data()).toMatchObject({
      actorUid: "system:publication-baseline",
      action: "cms-publication-baseline.retire",
      target: `cmsPublishQueue/${QUEUE_ID}`,
      before: { status: "publishing", generation: GENERATION },
      after: {
        status: "cancelled",
        reason: "source_superseded_before_apex_cutover",
        activeGeneration: GENERATION,
      },
    });
  });

  it("uses the supplied Firestore SDK for retirement timestamps", async () => {
    await seed();
    const state = refs(siteDb);

    await expect(retireCmsPublicationBaseline({
      firestore: siteDb,
      expected: expected(),
      serverTimestamp: () => siteFirestoreModule.FieldValue.serverTimestamp(),
    })).resolves.toMatchObject({
      outcome: "cancelled",
      idempotent: false,
    });
    await expect(state.queueRef.get()).resolves.toMatchObject({ exists: true });
    expect((await state.queueRef.get()).data()).toMatchObject({
      status: "cancelled",
      baselineRetirementReceipt: {
        reason: "source_superseded_before_apex_cutover",
      },
    });
  });

  it("validates an exact retry without changing its receipt or audit", async () => {
    const state = await seed();
    const first = await retireCmsPublicationBaseline({
      firestore: db,
      expected: expected(),
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    });
    const firstStoredQueue = (await state.queueRef.get()).data();
    const retry = await retireCmsPublicationBaseline({
      firestore: db,
      expected: expected({ claimTokenDigest: null }),
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    });
    const storedQueue = (await state.queueRef.get()).data();

    expect(retry).toMatchObject({ outcome: "cancelled", idempotent: true });
    expect(retry.receipt.retiredAt.toMillis())
      .toBe(firstStoredQueue.baselineRetirementReceipt.retiredAt.toMillis());
    expect(storedQueue.completedAt.toMillis())
      .toBe(firstStoredQueue.completedAt.toMillis());
    expect(first.idempotent).toBe(false);
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it.each([
    ["content changes", { queue: queue({ changes: [{ id: "post-one" }] }) }],
    ["another transport", { queue: queue({ transport: "github" }) }],
    ["another commit", { queue: queue({ commitSha: "0".repeat(40) }) }],
    ["another serializer", {
      queue: queue({
        serializerClaim: {
          ...queue().serializerClaim,
          serializerId: "another-serializer",
        },
      }),
    }],
    ["another journal token", {}, {
      claimTokenDigest: "0".repeat(64),
    }],
    ["enabled media lifecycle", {
      pointer: pointer({ mediaLifecycleReady: true }),
    }],
    ["another generation", {
      pointer: pointer({ lastReservedGeneration: GENERATION + 1 }),
    }],
    ["another candidate", {
      candidate: candidate({
        workerVersionId: "44444444-4444-4444-8444-444444444444",
      }),
    }],
    ["another manifest", {
      manifest: manifest({ mediaManifestDigest: "0".repeat(64) }),
    }],
    ["another deployed evidence", {
      batch: batch({ cloudflareEvidenceDigest: "0".repeat(64) }),
    }],
    ["another inclusion", {
      queue: queue({
        artifactInclusion: {
          ...queue().artifactInclusion,
          artifactReceiptDigest: "0".repeat(64),
        },
      }),
    }],
    ["queue cutoffs that differ from the deployment batch", {
      queue: queue({
        artifactBuild: {
          ...queue().artifactBuild,
          cutoffAt: conflictingCutoffAt,
        },
        artifactInclusion: {
          ...queue().artifactInclusion,
          cutoffAt: conflictingCutoffAt,
        },
      }),
    }],
    ["queue cutoffs that differ below milliseconds", {
      queue: queue({
        artifactBuild: {
          ...queue().artifactBuild,
          cutoffAt: nanosecondCutoffConflict,
        },
        artifactInclusion: {
          ...queue().artifactInclusion,
          cutoffAt: nanosecondCutoffConflict,
        },
      }),
    }],
  ])("refuses %s", async (_label, seeded, expectedOverrides = {}) => {
    await seed(seeded);

    await expect(retireCmsPublicationBaseline({
      firestore: db,
      expected: expected(expectedOverrides),
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    })).rejects.toThrow();
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("refuses lease timestamps that differ below milliseconds", async () => {
    await seed({
      pointer: reconcilingPointer({
        leaseAcquiredAt: nanosecondLeaseConflict,
      }),
      batch: reconcilingBatch(),
    });

    await expect(readCmsPublicationBaselineRetirementState({
      firestore: db,
      expected: expected(),
    })).rejects.toThrow(/lease conflicts/i);
  });

  it("refuses a cancelled queue without the exact retirement receipt", async () => {
    await seed({
      queue: queue({
        status: "cancelled",
        completedAt: deployedAt,
        error: "another cancellation",
      }),
    });

    await expect(readCmsPublicationBaselineRetirementState({
      firestore: db,
      expected: expected({ claimTokenDigest: null }),
    })).rejects.toThrow(/receipt/i);
  });
});

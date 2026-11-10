import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import coordinatorModule from "../../functions/lib/public-deployment-coordinator.js";
import outcomeStoreModule from "../../functions/lib/public-deployment-outcome-store.js";
import manifestModule from "../../functions/lib/public-media-manifest.js";
import storeModule from "../../functions/lib/public-media-manifest-store.js";
import candidateStoreModule from "../../functions/lib/public-worker-candidate-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const {
  acquirePublicDeploymentLease,
  reservePublicBuildBatch,
} = coordinatorModule;
const { settlePublicDeploymentOutcome } = outcomeStoreModule;
const {
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNERS,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
  createPublicMediaManifest,
} = manifestModule;
const {
  publicMediaManifestChunkRef,
  publicMediaManifestRef,
  publicMediaManifestVerificationRef,
  markPublicMediaManifestReady,
  stagePublicMediaManifest,
  verifyStagedPublicMediaManifest,
} = storeModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;
const { publicWorkerCandidateTag } = candidateModule;
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

function artifactInventory(owners) {
  return ["cmsPages", "cmsPosts", "cmsSettings", "cmsAuthorProfilesPublic"].map(
    (collection) => ({
    collection,
    complete: true,
    documentIds: owners
      .filter((ownerValue) => ownerValue.collection === collection)
      .map((ownerValue) => ownerValue.documentId),
    }),
  );
}

async function reservedManifest(
  owners,
  { buildBatchId = "build-one", commitSha = "a".repeat(40) } = {},
) {
  const { batch } = await reservePublicBuildBatch({
    firestore: db,
    buildBatchId,
    commitSha,
  });
  return createPublicMediaManifest({
    reservation: batch,
    artifactInventory: artifactInventory(owners),
    owners,
  });
}

function owner(collection, documentId, sourceVersion = 1, assetIds = []) {
  return {
    collection,
    documentId,
    sourceVersion,
    assetIds,
    occurrenceCount: assetIds.length,
  };
}

function usageRef(ownerValue, generation = 1) {
  return db
    .collection(ownerValue.collection)
    .doc(ownerValue.documentId)
    .collection("mediaUsage")
    .doc(`deployed-${generation}`);
}

function prepareCandidate(manifest) {
  const artifactDigest = manifest.generation.toString(16).padStart(64, "0");
  return recordPublicWorkerCandidate({
    firestore: db,
    candidate: {
      schemaVersion: 1,
      buildBatchId: manifest.buildBatchId,
      generation: manifest.generation,
      commitSha: manifest.commitSha,
      workerName: "njpbs-production",
      workerVersionId: "11111111-1111-4111-8111-111111111111",
      workerVersionTag: publicWorkerCandidateTag({
        generation: manifest.generation,
        artifactDigest,
      }),
      versionCreatedOn: "2026-08-27T20:00:00.000Z",
      artifactDigest,
      artifactReceiptDigest: "e".repeat(64),
      publicationReceiptDigest: "f".repeat(64),
      mediaManifestDigest: manifest.mediaManifestDigest,
      artifactFileCount: 100,
      artifactBytes: 1_000_000,
      wranglerVersion: "4.123.0",
    },
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-media-manifest-store.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public media manifest staging", () => {
  it("verifies an exact empty owner set", async () => {
    const manifest = await reservedManifest([]);

    const result = await stagePublicMediaManifest({ firestore: db, manifest });

    expect(result.idempotent).toBe(false);
    expect((await publicMediaManifestRef(db, "build-one").get()).data())
      .toMatchObject({
        coverage: [
          { collection: "cmsPages", complete: true, ownerCount: 0 },
          { collection: "cmsPosts", complete: true, ownerCount: 0 },
          { collection: "cmsSettings", complete: true, ownerCount: 0 },
          { collection: "cmsAuthorProfilesPublic", complete: true, ownerCount: 0 },
        ],
        ownerCount: 0,
        chunkCount: 0,
      });
    expect((await publicMediaManifestVerificationRef(db, "build-one").get()).exists)
      .toBe(true);
  });

  it("stages and verifies page, post, and settings owners without activation", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
      owner("cmsPosts", "post-one", 3),
      owner("cmsSettings", "site", 4, ["settings-asset"]),
    ]);

    const injectedTimestamp = vi.fn(() => "client-time");
    const result = await stagePublicMediaManifest({
      firestore: db,
      manifest,
      serverTimestamp: injectedTimestamp,
    });

    expect(result.idempotent).toBe(false);
    expect(injectedTimestamp).not.toHaveBeenCalled();
    const header = (await publicMediaManifestRef(db, "build-one").get()).data();
    expect(header).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      ownerCount: 3,
      maxOwnerWritesPerChunk:
        MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
      maxChunkBytes: MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
      maxVerificationBytes: MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
      chunkCount: 1,
      mediaManifestDigest: manifest.mediaManifestDigest,
    });
    expect((await publicMediaManifestChunkRef(db, "build-one", 0).get()).data())
      .toMatchObject({ index: 0, ownerCount: 3 });
    const verification = (
      await publicMediaManifestVerificationRef(db, "build-one").get()
    ).data();
    expect(verification).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      ownerCount: 3,
      chunkCount: 1,
      mediaManifestDigest: manifest.mediaManifestDigest,
    });
    expect(verification.verifiedAt.toMillis()).toBeGreaterThan(0);
    expect((await usageRef(manifest.owners[0]).get()).data()).toEqual({
      schemaVersion: 1,
      state: "deployed",
      generation: 1,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
      mediaManifestDigest: manifest.mediaManifestDigest,
      sourceVersion: 2,
      assetIds: ["page-asset"],
      occurrenceCount: 1,
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ activeGeneration: 0, mediaLifecycleReady: false });
  });

  it("uses at most 200 owner writes plus one receipt in a chunk", async () => {
    const owners = Array.from({ length: 201 }, (_, index) =>
      owner("cmsPosts", `post-${String(index).padStart(3, "0")}`));
    const manifest = await reservedManifest(owners);

    await stagePublicMediaManifest({ firestore: db, manifest });

    expect((await publicMediaManifestChunkRef(db, "build-one", 0).get()).data())
      .toMatchObject({
        index: 0,
        ownerCount: MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
      });
    expect((await publicMediaManifestChunkRef(db, "build-one", 1).get()).data())
      .toMatchObject({ index: 1, ownerCount: 1 });
    expect((await publicMediaManifestVerificationRef(db, "build-one").get()).exists)
      .toBe(true);
  });

  it("accepts an exact retry without replacing the server verification time", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    const first = await stagePublicMediaManifest({ firestore: db, manifest });
    const firstTime = first.verification.verifiedAt.toMillis();

    const retry = await stagePublicMediaManifest({ firestore: db, manifest });

    expect(retry.idempotent).toBe(true);
    expect(retry.verification.verifiedAt.toMillis()).toBe(firstTime);
  });

  it("serializes concurrent exact staging attempts", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);

    const results = await Promise.all([
      stagePublicMediaManifest({ firestore: db, manifest }),
      stagePublicMediaManifest({ firestore: db, manifest }),
    ]);

    expect(results.map((result) => result.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect((await publicMediaManifestVerificationRef(db, "build-one").get()).exists)
      .toBe(true);
  }, 20_000);

  it("leaves a partial stage inert when a later chunk conflicts", async () => {
    const owners = Array.from({ length: 201 }, (_, index) =>
      owner("cmsPosts", `post-${String(index).padStart(3, "0")}`));
    const manifest = await reservedManifest(owners);
    await usageRef(manifest.owners[200]).set({ forged: true });

    await expect(stagePublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow("deployed media usage conflicts");

    expect((await publicMediaManifestChunkRef(db, "build-one", 0).get()).exists)
      .toBe(true);
    expect((await publicMediaManifestChunkRef(db, "build-one", 1).get()).exists)
      .toBe(false);
    expect((await publicMediaManifestVerificationRef(db, "build-one").get()).exists)
      .toBe(false);
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ activeGeneration: 0, mediaLifecycleReady: false });
  });

  it("revalidates every stored owner before accepting a complete receipt", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await usageRef(manifest.owners[0]).update({ occurrenceCount: 2 });

    await expect(verifyStagedPublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow("deployed media usage conflicts");
  });

  it("revalidates every immutable chunk receipt", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await publicMediaManifestChunkRef(db, "build-one", 0)
      .update({ chunkDigest: "0".repeat(64) });

    await expect(verifyStagedPublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow("chunk conflicts");
  });

  it("fails closed on unknown header and verification fields", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await publicMediaManifestRef(db, "build-one").update({ futureField: true });

    await expect(verifyStagedPublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow("header conflicts");

    await publicMediaManifestRef(db, "build-one")
      .update({ futureField: admin.firestore.FieldValue.delete() });
    await publicMediaManifestVerificationRef(db, "build-one")
      .update({ futureField: true });
    await expect(verifyStagedPublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow("verification conflicts");
  });

  it("rejects a manifest that does not match its stored reservation", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    const foreign = createPublicMediaManifest({
      reservation: {
        ...(await reservePublicBuildBatch({
          firestore: db,
          buildBatchId: "build-two",
          commitSha: "b".repeat(40),
        })).batch,
      },
      artifactInventory: artifactInventory(manifest.owners),
      owners: manifest.owners,
    });

    await expect(stagePublicMediaManifest({
      firestore: db,
      manifest: { ...foreign, commitSha: "a".repeat(40) },
    })).rejects.toThrow("public media manifest is invalid");
    expect((await publicMediaManifestRef(db, "build-two").get()).exists)
      .toBe(false);
  });

  it("rejects MAX_OWNERS plus one before any Firestore write", async () => {
    const ownerValues = Array.from(
      { length: MAX_PUBLIC_MEDIA_MANIFEST_OWNERS + 1 },
      (_, index) => owner("cmsPosts", `post-${index}`),
    );
    const cutoffAt = new admin.firestore.Timestamp(1_786_723_200, 0);

    await expect(async () => {
      const manifest = createPublicMediaManifest({
        reservation: {
          schemaVersion: 1,
          buildBatchId: "build-overflow",
          generation: 1,
          commitSha: "a".repeat(40),
          reservedAgainstGeneration: 0,
          reservedAgainstDeploymentId: null,
          reservedAgainstCommitSha: null,
          cutoffAt,
          reservedAt: cutoffAt,
        },
        artifactInventory: artifactInventory(ownerValues),
        owners: ownerValues,
      });
      await stagePublicMediaManifest({ firestore: db, manifest });
    }).rejects.toThrow(/owner limit/i);

    expect((await db.collection("system").get()).empty).toBe(true);
    expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  });

  it("rejects excessive verification receipt bytes before writing a header", async () => {
    const ownerValues = Array.from(
      { length: MAX_PUBLIC_MEDIA_MANIFEST_OWNERS },
      (_, index) => {
        const prefix = `owner-${String(index).padStart(5, "0")}-`;
        return owner(
          "cmsPosts",
          `${prefix}${"x".repeat(1_500 - prefix.length)}`,
        );
      },
    );
    const cutoffAt = new admin.firestore.Timestamp(1_786_723_200, 0);
    const manifest = createPublicMediaManifest({
      reservation: {
        schemaVersion: 1,
        buildBatchId: "build-receipt-overflow",
        generation: 1,
        commitSha: "a".repeat(40),
        reservedAgainstGeneration: 0,
        reservedAgainstDeploymentId: null,
        reservedAgainstCommitSha: null,
        cutoffAt,
        reservedAt: cutoffAt,
      },
      artifactInventory: artifactInventory(ownerValues),
      owners: ownerValues,
    });

    await expect(stagePublicMediaManifest({ firestore: db, manifest }))
      .rejects.toThrow(/verification byte limit/i);

    expect((await publicMediaManifestRef(
      db,
      "build-receipt-overflow",
    ).get()).exists).toBe(false);
    expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  }, 20_000);
});

describe("public media manifest readiness", () => {
  it("marks one exact verified manifest ready without activating it", async () => {
    const manifest = await reservedManifest([
      owner("cmsPages", "home", 2, ["page-asset"]),
    ]);
    await stagePublicMediaManifest({ firestore: db, manifest });

    const result = await markPublicMediaManifestReady({
      firestore: db,
      manifest,
    });

    expect(result.idempotent).toBe(false);
    expect(result.readiness).toMatchObject({
      buildBatchId: "build-one",
      generation: 1,
      commitSha: "a".repeat(40),
    });
    expect(result.readiness.readyAt.toMillis()).toBeGreaterThan(0);
    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({
      status: "ready",
      readyAt: result.readiness.readyAt,
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "idle",
        activeGeneration: 0,
        mediaLifecycleReady: false,
        lastReservedGeneration: 1,
        newestEligibleGeneration: 0,
        newestEligibleBuildBatchId: null,
      });
  });

  it("accepts an exact readiness retry without replacing readyAt", async () => {
    const manifest = await reservedManifest([]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    const first = await markPublicMediaManifestReady({ firestore: db, manifest });

    const retry = await markPublicMediaManifestReady({ firestore: db, manifest });

    expect(retry).toEqual({
      idempotent: true,
      readiness: first.readiness,
    });
  });

  it.each([1, 5])("refuses a reserved manifest at or below active generation %s", async activeGeneration => {
    const manifest = await reservedManifest([]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await db.collection("system").doc("publicDeployment").update({
      mediaLifecycleReady: true,
      activeGeneration,
      activeDeploymentId: "deploy-five",
      activeCommitSha: "c".repeat(40),
      lastReservedGeneration: activeGeneration,
      newestEligibleGeneration: activeGeneration,
      newestEligibleBuildBatchId: "build-later",
    });

    await expect(markPublicMediaManifestReady({ firestore: db, manifest }))
      .rejects.toThrow(/readiness state is invalid/i);

    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({ status: "reserved" });
  });

  it("refuses readiness before exact manifest completion without a write", async () => {
    const manifest = await reservedManifest([]);
    const pointerBefore = (await db
      .collection("system")
      .doc("publicDeployment")
      .get()).data();

    await expect(markPublicMediaManifestReady({ firestore: db, manifest }))
      .rejects.toThrow(/incomplete/i);

    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({ status: "reserved" });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toEqual(pointerBefore);
  });

  it("refuses a conflicting completion receipt without advancing readiness", async () => {
    const manifest = await reservedManifest([]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await publicMediaManifestVerificationRef(db, "build-one")
      .update({ futureField: true });

    await expect(markPublicMediaManifestReady({ firestore: db, manifest }))
      .rejects.toThrow(/verification conflicts/i);

    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({ status: "reserved" });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ newestEligibleGeneration: 0 });
  });

  it("refuses a conflicting manifest header without advancing readiness", async () => {
    const manifest = await reservedManifest([]);
    await stagePublicMediaManifest({ firestore: db, manifest });
    await publicMediaManifestRef(db, "build-one")
      .update({ futureField: true });

    await expect(markPublicMediaManifestReady({ firestore: db, manifest }))
      .rejects.toThrow(/header conflicts/i);

    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({ status: "reserved" });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ newestEligibleGeneration: 0 });
  });

  it("keeps a newer ready manifest inert while preserving an older active lease", async () => {
    const firstManifest = await reservedManifest([], {
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    await stagePublicMediaManifest({ firestore: db, manifest: firstManifest });
    const firstReady = await markPublicMediaManifestReady({
      firestore: db,
      manifest: firstManifest,
    });
    await prepareCandidate(firstManifest);
    const firstLease = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    const secondManifest = await reservedManifest([], {
      buildBatchId: "build-two",
      commitSha: "b".repeat(40),
    });
    await stagePublicMediaManifest({ firestore: db, manifest: secondManifest });

    await markPublicMediaManifestReady({
      firestore: db,
      manifest: secondManifest,
    });

    const firstRetry = await markPublicMediaManifestReady({
      firestore: db,
      manifest: firstManifest,
    });

    expect(firstRetry).toEqual({
      idempotent: true,
      readiness: firstReady.readiness,
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "deploying",
        leaseToken: firstLease.lease.leaseToken,
        candidateGeneration: 1,
        candidateBuildBatchId: "build-one",
        lastReservedGeneration: 2,
        newestEligibleGeneration: 1,
        newestEligibleBuildBatchId: "build-one",
      });
  });

  it("reserves and readies a newer batch while preserving an older reconciling lease", async () => {
    const firstManifest = await reservedManifest([], {
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    await stagePublicMediaManifest({ firestore: db, manifest: firstManifest });
    await markPublicMediaManifestReady({ firestore: db, manifest: firstManifest });
    await prepareCandidate(firstManifest);
    const firstLease = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    const settlement = await settlePublicDeploymentOutcome({
      firestore: db,
      lease: firstLease.lease,
      evidence: { action: "reconcile" },
    });
    const reconcilingPointer = (await db
      .collection("system")
      .doc("publicDeployment")
      .get()).data();

    const secondManifest = await reservedManifest([], {
      buildBatchId: "build-two",
      commitSha: "b".repeat(40),
    });

    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "reconciling",
        leaseToken: firstLease.lease.leaseToken,
        candidateGeneration: 1,
        candidateBuildBatchId: "build-one",
        candidateCommitSha: "a".repeat(40),
        predecessorGeneration: reconcilingPointer.predecessorGeneration,
        predecessorDeploymentId: reconcilingPointer.predecessorDeploymentId,
        predecessorCommitSha: reconcilingPointer.predecessorCommitSha,
        reconcilingAt: reconcilingPointer.reconcilingAt,
        cloudflareEvidenceDigest: reconcilingPointer.cloudflareEvidenceDigest,
        lastReservedGeneration: 2,
        newestEligibleGeneration: 1,
        newestEligibleBuildBatchId: "build-one",
      });

    await stagePublicMediaManifest({ firestore: db, manifest: secondManifest });
    await markPublicMediaManifestReady({
      firestore: db,
      manifest: secondManifest,
    });

    expect(settlement).toMatchObject({
      outcome: "reconciling",
      idempotent: false,
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "reconciling",
        leaseToken: firstLease.lease.leaseToken,
        candidateGeneration: 1,
        candidateBuildBatchId: "build-one",
        reconcilingAt: reconcilingPointer.reconcilingAt,
        cloudflareEvidenceDigest: reconcilingPointer.cloudflareEvidenceDigest,
        lastReservedGeneration: 2,
        newestEligibleGeneration: 1,
        newestEligibleBuildBatchId: "build-one",
      });
  });

  it("refuses readiness for a reserved batch claimed by an older reconciling lease", async () => {
    const firstManifest = await reservedManifest([], {
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    await stagePublicMediaManifest({ firestore: db, manifest: firstManifest });
    await markPublicMediaManifestReady({ firestore: db, manifest: firstManifest });
    await prepareCandidate(firstManifest);
    const firstLease = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    await settlePublicDeploymentOutcome({
      firestore: db,
      lease: firstLease.lease,
      evidence: { action: "reconcile" },
    });
    const secondManifest = await reservedManifest([], {
      buildBatchId: "build-two",
      commitSha: "b".repeat(40),
    });
    await stagePublicMediaManifest({ firestore: db, manifest: secondManifest });
    await markPublicMediaManifestReady({
      firestore: db,
      manifest: secondManifest,
    });

    const firstBatchRef = db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one");
    const reconcilingBatch = (await firstBatchRef.get()).data();
    await firstBatchRef.set({
      schemaVersion: reconcilingBatch.schemaVersion,
      buildBatchId: reconcilingBatch.buildBatchId,
      generation: reconcilingBatch.generation,
      status: "reserved",
      commitSha: reconcilingBatch.commitSha,
      reservedAgainstGeneration: reconcilingBatch.reservedAgainstGeneration,
      reservedAgainstDeploymentId:
        reconcilingBatch.reservedAgainstDeploymentId,
      reservedAgainstCommitSha: reconcilingBatch.reservedAgainstCommitSha,
      cutoffAt: reconcilingBatch.cutoffAt,
      reservedAt: reconcilingBatch.reservedAt,
    });
    const pointerBefore = (await db
      .collection("system")
      .doc("publicDeployment")
      .get()).data();
    const batchBefore = (await firstBatchRef.get()).data();

    await expect(markPublicMediaManifestReady({
      firestore: db,
      manifest: firstManifest,
    })).rejects.toThrow(/readiness state is invalid/i);

    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toEqual(pointerBefore);
    expect((await firstBatchRef.get()).data()).toEqual(batchBefore);
  });

  it("keeps concurrent manifest completions inert until candidates exist", async () => {
    const firstManifest = await reservedManifest([], {
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });
    const secondManifest = await reservedManifest([], {
      buildBatchId: "build-two",
      commitSha: "b".repeat(40),
    });
    await Promise.all([
      stagePublicMediaManifest({ firestore: db, manifest: firstManifest }),
      stagePublicMediaManifest({ firestore: db, manifest: secondManifest }),
    ]);

    const [secondReady, firstReady] = await Promise.all([
      markPublicMediaManifestReady({ firestore: db, manifest: secondManifest }),
      markPublicMediaManifestReady({ firestore: db, manifest: firstManifest }),
    ]);
    const [secondRetry, firstRetry] = await Promise.all([
      markPublicMediaManifestReady({ firestore: db, manifest: secondManifest }),
      markPublicMediaManifestReady({ firestore: db, manifest: firstManifest }),
    ]);

    expect(firstRetry).toEqual({
      idempotent: true,
      readiness: firstReady.readiness,
    });
    expect(secondRetry).toEqual({
      idempotent: true,
      readiness: secondReady.readiness,
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        lastReservedGeneration: 2,
        newestEligibleGeneration: 0,
        newestEligibleBuildBatchId: null,
      });
    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-one")
      .get()).data()).toMatchObject({ status: "ready" });
    expect((await db
      .collection("system/publicDeployment/buildBatches")
      .doc("build-two")
      .get()).data()).toMatchObject({ status: "ready" });
  });
});

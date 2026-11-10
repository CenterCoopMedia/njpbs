import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import artifactModule from "../../functions/lib/cms-publish-artifact.js";
import writeback from "../../scripts/update-publish-status.cjs";

const admin = adminPkg;
const {
  queueIncludesArtifact,
  reserveCmsPublishArtifact,
  timestampParts,
} = artifactModule;
const { updatePublishStatus } = writeback;
const PROJECT = "demo-njpbs";
const QUEUE_ID = "A1b2C3d4E5f6G7h8I9j0";
const COMMIT_SHA = "a".repeat(40);
let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

function receipt(artifact, artifacts = [
  { documentId: "watch", sourceVersion: 4 },
], postArtifacts = [], settingsArtifacts = []) {
  return {
    buildBatchId: artifact.buildBatchId,
    generation: artifact.generation,
    commitSha: artifact.commitSha,
    cutoffAt: {
      seconds: artifact.cutoffAt.seconds,
      nanoseconds: artifact.cutoffAt.nanoseconds,
    },
    families: [
      { collection: "cmsPages", complete: true, artifacts },
      { collection: "cmsPosts", complete: true, artifacts: postArtifacts },
      {
        collection: "cmsSettings",
        complete: true,
        artifacts: settingsArtifacts,
      },
    ],
  };
}

describe("CMS publish artifact reservation", () => {
  it("preserves the reservation's sub-millisecond cutoff precision", () => {
    const cutoff = new admin.firestore.Timestamp(1_755_792_000, 456_789_000);

    expect(timestampParts(cutoff)).toEqual({
      seconds: 1_755_792_000,
      nanoseconds: 456_789_000,
    });
  });

  it("binds one queue to one monotonic cutoff and source", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    await queueRef.set({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4 }],
    });

    const first = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
    });
    const second = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
    });

    expect(second).toEqual(first);
    expect((await queueRef.get()).data().artifactBuild).toEqual(first);
    expect(
      (
        await db
          .collection("system/publicDeployment/buildBatches")
          .doc(QUEUE_ID)
          .get()
      ).data(),
    ).toMatchObject({
      status: "reserved",
      buildBatchId: QUEUE_ID,
      generation: 1,
      commitSha: COMMIT_SHA,
    });
  });

  it("treats an already successful queue as an idempotent no-op", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    await queueRef.set({ status: "success", changes: [] });
    await expect(reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-2`,
      commitSha: COMMIT_SHA,
    })).resolves.toBeNull();
    expect(
      await db
        .collection("system/publicDeployment/buildBatches")
        .doc(`${QUEUE_ID}-2`)
        .get(),
    ).toMatchObject({ exists: false });
  });

  it("rebinds a failed queue to a fresh attempt and accepts its late success", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    const pageRef = db.collection("cmsPages").doc("watch");
    await queueRef.set({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: QUEUE_ID,
      published: { sourceVersion: 4 },
    });
    const first = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-1`,
      commitSha: COMMIT_SHA,
    });
    await updatePublishStatus(db, {
      queueId: QUEUE_ID,
      status: "failed",
    });

    const second = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-2`,
      commitSha: COMMIT_SHA,
    });
    expect(second.generation).toBe(first.generation + 1);
    expect((await queueRef.get()).data()).toMatchObject({
      status: "failed",
      artifactBuild: { buildBatchId: `${QUEUE_ID}-2` },
    });

    await updatePublishStatus(db, {
      queueId: QUEUE_ID,
      status: "success",
      commitSha: COMMIT_SHA,
      artifactReceipt: receipt(second),
    });
    expect((await queueRef.get()).data()).toMatchObject({ status: "success" });
    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
    });
  });

  it("restores an unconfirmed artifact binding when its retry fails", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    const triggeredAt = admin.firestore.Timestamp.fromMillis(1_775_000_000_000);
    await queueRef.set({
      status: "publishing",
      triggeredAt,
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4 }],
    });
    const first = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-1`,
      commitSha: COMMIT_SHA,
    });
    await queueRef.update({
      status: "public_unconfirmed",
      completedAt: admin.firestore.Timestamp.fromMillis(1_775_000_010_000),
      deploymentReceipt: { id: "original-deployment" },
    });
    const deployedReceipt = (await queueRef.get()).data().deploymentReceipt;

    const second = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-2`,
      commitSha: COMMIT_SHA,
    });
    expect((await queueRef.get()).data()).toMatchObject({
      status: "publishing",
      artifactBuild: second,
      artifactBuildRollback: { artifactBuild: first },
    });

    await updatePublishStatus(db, { queueId: QUEUE_ID, status: "failed" });
    const restored = (await queueRef.get()).data();
    expect(restored).toMatchObject({
      status: "public_unconfirmed",
      artifactBuild: first,
      deploymentReceipt: deployedReceipt,
    });
    expect(restored).not.toHaveProperty("artifactBuildRollback");

    await updatePublishStatus(db, {
      queueId: QUEUE_ID,
      status: "success",
      commitSha: COMMIT_SHA,
      artifactReceipt: receipt(first),
    });
    expect((await queueRef.get()).data()).toMatchObject({ status: "success" });
  });

  it("refuses a concurrent artifact or unknown queue state", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    await queueRef.set({ status: "publishing", changes: [] });
    await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-1`,
      commitSha: COMMIT_SHA,
    });
    await expect(reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-2`,
      commitSha: COMMIT_SHA,
    })).rejects.toThrow(/another artifact/);
    await queueRef.update({ status: "unknown" });
    await expect(reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: `${QUEUE_ID}-3`,
      commitSha: COMMIT_SHA,
    })).rejects.toThrow(/already unknown/);
  });
});

describe("queue-to-artifact receipt binding", () => {
  it("settles only the exact page revision proved by the receipt", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    const pageRef = db.collection("cmsPages").doc("watch");
    await queueRef.set({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: QUEUE_ID,
      published: { sourceVersion: 4 },
    });
    const artifact = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
    });

    await updatePublishStatus(db, {
      queueId: QUEUE_ID,
      status: "success",
      commitSha: COMMIT_SHA,
      artifactReceipt: receipt(artifact),
    });

    expect((await queueRef.get()).data()).toMatchObject({
      status: "success",
      gitCommitSha: COMMIT_SHA,
    });
    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
    });
  });

  it("refuses a missing or newer revision and accepts an exact Post revision", async () => {
    const queueRef = db.collection("cmsPublishQueue").doc(QUEUE_ID);
    await queueRef.set({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4 }],
    });
    const artifact = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
    });
    const queue = (await queueRef.get()).data();

    expect(queueIncludesArtifact(queue, receipt(artifact, []))).toBe(false);
    expect(
      queueIncludesArtifact(
        queue,
        receipt(artifact, [{ documentId: "watch", sourceVersion: 5 }]),
      ),
    ).toBe(false);
    await queueRef.update({
      changes: [{ collection: "cmsPosts", id: "post-1", sourceVersion: 1 }],
    });
    expect(
      queueIncludesArtifact((await queueRef.get()).data(), receipt(artifact)),
    ).toBe(false);
    expect(
      queueIncludesArtifact(
        (await queueRef.get()).data(),
        receipt(artifact, [], [{ documentId: "post-1", sourceVersion: 1 }]),
      ),
    ).toBe(true);
  });

  it("requires the exact public homepage banner source version", async () => {
    const queue = {
      artifactBuild: {
        buildBatchId: QUEUE_ID,
        generation: 1,
        commitSha: COMMIT_SHA,
        cutoffAt: { seconds: 1_755_792_000, nanoseconds: 456_789_000 },
      },
      changes: [{
        collection: "cmsSettings",
        id: "public-homepage-banner",
        sourceVersion: 3,
      }],
    };
    const artifact = queue.artifactBuild;

    expect(queueIncludesArtifact(queue, receipt(artifact))).toBe(false);
    expect(queueIncludesArtifact(
      queue,
      receipt(artifact, [], [], [
        { documentId: "public-homepage-banner", sourceVersion: 4 },
      ]),
    )).toBe(false);
    expect(queueIncludesArtifact(
      queue,
      receipt(artifact, [], [], [
        { documentId: "public-homepage-banner", sourceVersion: 3 },
      ]),
    )).toBe(true);
  });

  it("activates a navigation-only publication from a published or seed-fallback artifact", () => {
    const artifactBuild = { buildBatchId: QUEUE_ID, generation: 1, commitSha: COMMIT_SHA,
      cutoffAt: { seconds: 1_755_792_000, nanoseconds: 456_789_000 } };
    const queue = {
      artifactBuild,
      changes: [{ collection: "cmsSettings", id: "site-navigation", sourceVersion: 6 }],
    };
    // A published snapshot and a snapshot rendered from the seed both leave the
    // exact version in the complete settings family.
    expect(queueIncludesArtifact(queue, receipt(artifactBuild, undefined, [], [
      { documentId: "site-navigation", sourceVersion: 6 },
    ]))).toBe(true);
    expect(queueIncludesArtifact(queue, receipt(artifactBuild, undefined, [], [
      { documentId: "site-navigation", sourceVersion: 5 },
    ]))).toBe(false);
    expect(queueIncludesArtifact(queue, receipt(artifactBuild))).toBe(false);
  });

  it("confirms withdrawal only through a complete artifact family without the record", () => {
    const artifactBuild = { buildBatchId: QUEUE_ID, generation: 1, commitSha: COMMIT_SHA,
      cutoffAt: { seconds: 1_755_792_000, nanoseconds: 456_789_000 } };
    const queue = { artifactBuild, changes: [{ collection: "cmsPosts", id: "post-1", sourceVersion: 4, operation: "withdraw" }] };
    expect(queueIncludesArtifact(queue, receipt(artifactBuild, [], []))).toBe(true);
    expect(queueIncludesArtifact(queue, receipt(artifactBuild, [], [{ documentId: "post-1", sourceVersion: 4 }]))).toBe(false);
    expect(queueIncludesArtifact(queue, receipt(artifactBuild, [], [{ documentId: "post-1", sourceVersion: 8 }]))).toBe(false);
    const incomplete = receipt(artifactBuild, [], []);
    incomplete.families = incomplete.families.filter((family) => family.collection !== "cmsPosts");
    expect(queueIncludesArtifact(queue, incomplete)).toBe(false);
  });
});

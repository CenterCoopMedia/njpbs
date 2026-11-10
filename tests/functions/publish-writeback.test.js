import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import writeback from "../../scripts/update-publish-status.cjs";

const { updatePublishStatus, verifyDeploymentWriteback } = writeback;
const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("publish-writeback.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("update-publish-status writeback", () => {
  it("records one exact live deployment receipt and elapsed time", async () => {
    const triggeredAt = admin.firestore.Timestamp.fromMillis(1_775_000_000_000);
    const cutoffAt = admin.firestore.Timestamp.fromMillis(1_775_000_001_000);
    const artifactBuild = {
      buildBatchId: "cms-batch-1",
      generation: 1,
      commitSha: "a".repeat(40),
      cutoffAt,
    };
    const artifactReceipt = {
      ...artifactBuild,
      cutoffAt: {
        seconds: cutoffAt.seconds,
        nanoseconds: cutoffAt.nanoseconds,
      },
      families: [
        {
          collection: "cmsPages",
          complete: true,
          artifacts: [{ documentId: "home", sourceVersion: 4 }],
        },
        { collection: "cmsPosts", complete: true, artifacts: [] },
        { collection: "cmsSettings", complete: true, artifacts: [] },
      ],
    };
    const deployment = {
      buildBatchId: "cms-batch-1",
      runId: "32915404273",
      runAttempt: 2,
      pagesDeploymentId: "c".repeat(40),
      publicUrl: "https://njpbs.org/",
    };
    const completedDeployment = {
      ...deployment,
      visibleAtMs: triggeredAt.toMillis() + 8_250,
    };
    const pageRef = db.collection("cmsPages").doc("home");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      triggeredAt,
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 4 }],
      artifactBuild,
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: ref.id,
      published: { sourceVersion: 4 },
    });
    const pointerRef = db.collection("system").doc("publicDeployment");
    await pointerRef.set({ lastReservedGeneration: 1 });
    await expect(verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "a".repeat(40),
      artifactReceipt,
      deployment,
    })).resolves.toEqual(deployment);
    expect((await ref.get()).data().deploymentClaim).toMatchObject({
      queueId: ref.id,
      buildBatchId: "cms-batch-1",
      generation: 1,
      commitSha: "a".repeat(40),
      runId: "32915404273",
      runAttempt: 2,
      pagesDeploymentId: "c".repeat(40),
    });
    expect((await ref.get()).data().deploymentClaim.claimedAt).toBeDefined();
    await pointerRef.update({ lastReservedGeneration: 2 });
    await expect(verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "a".repeat(40),
      artifactReceipt,
      deployment,
    })).rejects.toThrow(/newest public artifact/);
    await pointerRef.update({ lastReservedGeneration: 1 });
    await expect(verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "a".repeat(40),
      artifactReceipt,
      deployment: { ...deployment, runAttempt: 3 },
    })).rejects.toThrow(/deployment claim conflicts/);
    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "a".repeat(40),
      artifactReceipt,
      deployment: completedDeployment,
    });

    const queue = (await ref.get()).data();
    expect(queue).toMatchObject({
      status: "success",
      deploymentReceipt: {
        schemaVersion: 2,
        queueId: ref.id,
        buildBatchId: "cms-batch-1",
        generation: 1,
        commitSha: "a".repeat(40),
        runId: "32915404273",
        runAttempt: 2,
        pagesDeploymentId: "c".repeat(40),
        publicUrl: "https://njpbs.org/",
        includedRevisions: [
          { collection: "cmsPages", id: "home", sourceVersion: 4 },
        ],
        publishToVisibleMs: 8_250,
      },
    });
    expect(queue.deploymentReceipt.cutoffAt.toMillis()).toBe(cutoffAt.toMillis());
    expect(queue.deploymentReceipt.visibleAt.toMillis()).toBe(
      completedDeployment.visibleAtMs,
    );
    expect((await pageRef.get()).data()).toMatchObject({
      status: "published",
      publishBuildPending: false,
      publishBuildQueueId: null,
      published: { sourceVersion: 4 },
    });
  });

  it("keeps public-unconfirmed monotonic, then upgrades on an exact receipt", async () => {
    const triggeredAt = admin.firestore.Timestamp.fromMillis(1_775_000_000_000);
    const cutoffAt = admin.firestore.Timestamp.fromMillis(1_775_000_001_000);
    const artifactBuild = {
      buildBatchId: "cms-batch-v2-no-timing",
      generation: 1,
      commitSha: "e".repeat(40),
      cutoffAt,
    };
    const artifactReceipt = {
      ...artifactBuild,
      cutoffAt: {
        seconds: cutoffAt.seconds,
        nanoseconds: cutoffAt.nanoseconds,
      },
      families: [
        {
          collection: "cmsPages",
          complete: true,
          artifacts: [{ documentId: "home", sourceVersion: 4 }],
        },
        { collection: "cmsPosts", complete: true, artifacts: [] },
        { collection: "cmsSettings", complete: true, artifacts: [] },
      ],
    };
    const deployment = {
      buildBatchId: "cms-batch-v2-no-timing",
      runId: "32915404274",
      runAttempt: 1,
      pagesDeploymentId: "f".repeat(40),
      publicUrl: "https://njpbs.org/",
    };
    const pageRef = db.collection("cmsPages").doc("home");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      triggeredAt,
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 4 }],
      artifactBuild,
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: ref.id,
      published: { sourceVersion: 4 },
    });
    await db.collection("system").doc("publicDeployment").set({
      lastReservedGeneration: 1,
    });
    await verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "e".repeat(40),
      artifactReceipt,
      deployment,
    });

    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "public_unconfirmed",
      commitSha: "e".repeat(40),
      artifactReceipt,
      deployment,
    });

    const queue = (await ref.get()).data();
    const receipt = queue.deploymentReceipt;
    expect(queue.status).toBe("public_unconfirmed");
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      queueId: ref.id,
      buildBatchId: "cms-batch-v2-no-timing",
      generation: 1,
      commitSha: "e".repeat(40),
      runId: "32915404274",
      runAttempt: 1,
      pagesDeploymentId: "f".repeat(40),
      publicUrl: "https://njpbs.org/",
      includedRevisions: [
        { collection: "cmsPages", id: "home", sourceVersion: 4 },
      ],
      timingStatus: "public_unconfirmed",
    });
    expect(receipt.cutoffAt.toMillis()).toBe(cutoffAt.toMillis());
    expect(receipt.visibleAt).toBeUndefined();
    expect(receipt.publishToVisibleMs).toBeUndefined();
    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
    });

    await updatePublishStatus(db, { queueId: ref.id, status: "failed" });
    await updatePublishStatus(db, { queueId: ref.id, status: "cancelled" });
    const preserved = (await ref.get()).data();
    expect(preserved.status).toBe("public_unconfirmed");
    expect(preserved.error).toBeUndefined();
    expect(preserved.deploymentReceipt).toEqual(receipt);

    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "e".repeat(40),
      artifactReceipt,
      deployment: {
        ...deployment,
        visibleAtMs: triggeredAt.toMillis() + 7_500,
      },
    });
    const confirmed = (await ref.get()).data();
    expect(confirmed.status).toBe("success");
    expect(confirmed.deploymentReceipt.publishToVisibleMs).toBe(7_500);
    expect(confirmed.deploymentReceipt.timingStatus).toBeUndefined();
    expect(confirmed.deploymentReceipt.visibleAt.toMillis()).toBe(
      triggeredAt.toMillis() + 7_500,
    );
  });

  it("keeps the version-one deployment receipt compatible during promotion", async () => {
    const triggeredAt = admin.firestore.Timestamp.fromMillis(1_775_000_000_000);
    const cutoffAt = admin.firestore.Timestamp.fromMillis(1_775_000_001_000);
    const artifactBuild = {
      buildBatchId: "cms-batch-no-timing",
      generation: 1,
      commitSha: "b".repeat(40),
      cutoffAt,
    };
    const artifactReceipt = {
      ...artifactBuild,
      cutoffAt: {
        seconds: cutoffAt.seconds,
        nanoseconds: cutoffAt.nanoseconds,
      },
      families: [
        { collection: "cmsPages", complete: true, artifacts: [] },
        { collection: "cmsPosts", complete: true, artifacts: [] },
        { collection: "cmsSettings", complete: true, artifacts: [] },
      ],
    };
    const deployment = {
      buildBatchId: "cms-batch-no-timing",
      runId: "32915404274",
      runAttempt: 1,
      publicUrl: "https://njpbs.org/",
    };
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      triggeredAt,
      changes: [],
      artifactBuild,
    });
    await db.collection("system").doc("publicDeployment").set({
      lastReservedGeneration: 1,
    });
    await verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "b".repeat(40),
      artifactReceipt,
      deployment,
    });

    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "b".repeat(40),
      artifactReceipt,
      deployment,
    });

    const receipt = (await ref.get()).data().deploymentReceipt;
    expect(receipt).toMatchObject({
      queueId: ref.id,
      buildBatchId: "cms-batch-no-timing",
      commitSha: "b".repeat(40),
      runId: "32915404274",
      runAttempt: 1,
      publicUrl: "https://njpbs.org/",
      timingStatus: "unavailable",
    });
    expect(receipt.schemaVersion).toBeUndefined();
    expect(receipt.pagesDeploymentId).toBeUndefined();
    expect(receipt.visibleAt).toBeUndefined();
    expect(receipt.publishToVisibleMs).toBeUndefined();
  });

  it("rejects a malformed Pages deployment id before claiming transport", async () => {
    const triggeredAt = admin.firestore.Timestamp.fromMillis(1_775_000_000_000);
    const cutoffAt = admin.firestore.Timestamp.fromMillis(1_775_000_001_000);
    const artifactBuild = {
      buildBatchId: "cms-batch-bad-pages-id",
      generation: 1,
      commitSha: "d".repeat(40),
      cutoffAt,
    };
    const artifactReceipt = {
      ...artifactBuild,
      cutoffAt: {
        seconds: cutoffAt.seconds,
        nanoseconds: cutoffAt.nanoseconds,
      },
      families: [
        { collection: "cmsPages", complete: true, artifacts: [] },
        { collection: "cmsPosts", complete: true, artifacts: [] },
        { collection: "cmsSettings", complete: true, artifacts: [] },
      ],
    };
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      triggeredAt,
      changes: [],
      artifactBuild,
    });
    await db.collection("system").doc("publicDeployment").set({
      lastReservedGeneration: 1,
    });

    await expect(verifyDeploymentWriteback(db, {
      queueId: ref.id,
      commitSha: "d".repeat(40),
      artifactReceipt,
      deployment: {
        buildBatchId: "cms-batch-bad-pages-id",
        runId: "32915404275",
        runAttempt: 1,
        pagesDeploymentId: "not-a-pages-deployment-id",
        publicUrl: "https://njpbs.org/",
      },
    })).rejects.toThrow(/Pages deployment id/);
    expect((await ref.get()).data().deploymentClaim).toBeUndefined();
  });

  it("marks a queue success and clears its exact published revision", async () => {
    const pageRef = db.collection("cmsPages").doc("home");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 4 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: ref.id,
      published: { sourceVersion: 4 },
    });
    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "abc1234",
    });
    const doc = (await db.collection("cmsPublishQueue").doc(ref.id).get()).data();
    expect(doc.status).toBe("success");
    expect(doc.gitCommitSha).toBe("abc1234");
    expect(doc.completedAt).toBeDefined();
    expect((await pageRef.get()).data()).toMatchObject({
      status: "published",
      publishBuildPending: false,
      publishBuildQueueId: null,
      published: { sourceVersion: 4 },
    });
  });

  it("clears a stale error note when marking a queue doc success", async () => {
    const ref = await db.collection("cmsPublishQueue").add({
      status: "failed",
      error: "Previous publish failed",
    });
    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
    });
    const doc = (await db.collection("cmsPublishQueue").doc(ref.id).get()).data();
    expect(doc.status).toBe("success");
    expect(doc.error).toBeUndefined();
    expect(Object.hasOwn(doc, "error")).toBe(false);
  });

  it("marks a queue doc failed with an error note", async () => {
    const pageRef = db.collection("cmsPages").doc("contact");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 2 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: ref.id,
      published: { sourceVersion: 2 },
    });
    await updatePublishStatus(db, { queueId: ref.id, status: "failed" });
    const doc = (await db.collection("cmsPublishQueue").doc(ref.id).get()).data();
    expect(doc.status).toBe("failed");
    expect(doc.error).toBeTruthy();
    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 2 },
    });
  });

  it("marks a queue doc cancelled with an error note", async () => {
    const ref = await db.collection("cmsPublishQueue").add({ status: "publishing" });
    await updatePublishStatus(db, { queueId: ref.id, status: "cancelled" });
    const doc = (await db.collection("cmsPublishQueue").doc(ref.id).get()).data();
    expect(doc.status).toBe("cancelled");
    expect(doc.completedAt).toBeDefined();
    expect(doc.error).toBe(
      "Publish build cancelled - see GitHub Actions logs",
    );
  });

  it("leaves a newer or differently claimed revision untouched", async () => {
    const pageRef = db.collection("cmsPages").doc("contact");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 2 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: "newer-queue",
      published: { sourceVersion: 3 },
    });

    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "old-build",
    });

    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: "newer-queue",
      published: { sourceVersion: 3 },
    });
  });

  it("does not regress a successful queue on duplicate terminal writeback", async () => {
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      changes: [],
    });
    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "successful-build",
    });

    await updatePublishStatus(db, { queueId: ref.id, status: "failed" });
    await updatePublishStatus(db, { queueId: ref.id, status: "cancelled" });

    expect((await ref.get()).data()).toMatchObject({
      status: "success",
      gitCommitSha: "successful-build",
    });
    expect((await ref.get()).data().error).toBeUndefined();
  });

  it("clears an unclaimed exact revision when a failed queue later succeeds", async () => {
    const pageRef = db.collection("cmsPages").doc("contact");
    const ref = await db.collection("cmsPublishQueue").add({
      status: "publishing",
      changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 5 }],
    });
    await pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: ref.id,
      published: { sourceVersion: 5 },
    });

    await updatePublishStatus(db, { queueId: ref.id, status: "failed" });
    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: null,
    });
    await updatePublishStatus(db, {
      queueId: ref.id,
      status: "success",
      commitSha: "rerun-success",
    });

    expect((await pageRef.get()).data()).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
      published: { sourceVersion: 5 },
    });
    expect((await ref.get()).data()).toMatchObject({
      status: "success",
      gitCommitSha: "rerun-success",
    });
  });

  it("rejects an invalid status", async () => {
    await expect(
      updatePublishStatus(db, { queueId: "x", status: "bogus" }),
    ).rejects.toThrow(/success \| public_unconfirmed \| failed/);
  });
});

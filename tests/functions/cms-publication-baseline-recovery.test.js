import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import recovery from "../../functions/lib/cms-publication-baseline-recovery.js";
import safety from "../../functions/lib/published-media-safety.js";
import serializer from "../../functions/lib/cms-publication-serializer.js";
import artifact from "../../functions/lib/cms-publish-artifact.js";

const queueId = "44444444444444444444";
const commitSha = "a".repeat(40);
const expected = {
  activeGeneration: 47,
  lastReservedGeneration: 54,
  activeDeploymentId: "deployment-47",
  activeCommitSha: "b".repeat(40),
};
let db;
let pointerRef;
let queueRef;
let batchRef;
const recover = (overrides = {}) =>
  recovery.recoverCmsPublicationBaseline({
    firestore: db,
    queueId,
    commitSha,
    expected,
    ...overrides,
  });

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  db = isolatedFirestore("cms-publication-baseline-recovery.test.js");
  pointerRef = db.doc("system/publicDeployment");
  queueRef = db.doc(`cmsPublishQueue/${queueId}`);
  batchRef = pointerRef.collection("buildBatches").doc(`cms-${queueId}`);
});
beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  await pointerRef.set({
    schemaVersion: 1,
    ...expected,
    state: "idle",
    mediaLifecycleReady: true,
    newestEligibleGeneration: 47,
    newestEligibleBuildBatchId: "previous-build",
  });
  await db.doc("cmsPosts/post-one").set({
    status: "draft",
    publiclyVisible: true,
    version: 3,
    published: {
      sourceVersion: 2,
      publishedAt: "2026-08-14T18:00:00.000Z",
      metadata: { type: "post", heroImage: "upload-one" },
      blocks: [],
    },
  });
  const projection = {
    url: "https://media.njpbs.org/uploads/upload-one.jpg",
    altText: "Photo",
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
  };
  await db
    .doc("media_assets/upload-one")
    .set({ ...projection, lifecycle: "active", source: "upload" });
  await db.doc("media_assets_public/upload-one").set(projection);
});
afterAll(async () => Promise.all(admin.apps.map((app) => app.delete())));

describe("guarded baseline recovery", () => {
  it.each([true, false])("honors serializer enabled=%s before new recovery closes the media fence", async enabled => {
    const control = db.doc("system/publicDeployment/controls/serializer");
    await control.set({ schemaVersion: 1, enabled });
    const before = (await pointerRef.get()).data();
    if (enabled) {
      await expect(recover()).resolves.toMatchObject({ status: "pending", idempotent: false });
      expect((await pointerRef.get()).data().mediaLifecycleReady).toBe(false);
      expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
      expect((await db.collection("admin_logs").get()).size).toBe(1);
    } else {
      await expect(recover()).rejects.toMatchObject({
        code: "serializer_publication_unavailable", status: 409,
        message: "The full-site build was retired on October 13, 2026. This change has no build-free publication path yet. Ask an administrator.",
      });
      expect((await pointerRef.get()).data()).toEqual(before);
      expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
      expect((await queueRef.collection("recovery").doc("baseline").get()).exists).toBe(false);
    }
    expect((await control.get()).data()).toEqual({ schemaVersion: 1, enabled });
  });

  it("reports an exact accepted recovery retry after serializer cutoff without new writes", async () => {
    const control = db.doc("system/publicDeployment/controls/serializer");
    await control.set({ schemaVersion: 1, enabled: true });
    await recover();
    const pointerBefore = (await pointerRef.get()).data();
    const queueBefore = (await queueRef.get()).data();
    const receiptRef = queueRef.collection("recovery").doc("baseline");
    const receiptBefore = (await receiptRef.get()).data();
    await control.set({ schemaVersion: 1, enabled: false });
    await expect(recover()).resolves.toMatchObject({ status: "pending", idempotent: true });
    expect((await pointerRef.get()).data()).toEqual(pointerBefore);
    expect((await queueRef.get()).data()).toEqual(queueBefore);
    expect((await receiptRef.get()).data()).toEqual(receiptBefore);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await control.get()).data()).toEqual({ schemaVersion: 1, enabled: false });
  });

  const pilotId = "pilot-post", pilotQueueId = "22222222222222222222";
  async function seedPendingPilot(status) {
    const state = { schemaVersion: 1, postId: pilotId, operationId: pilotQueueId,
      rendererSha: expected.activeCommitSha, generation: 48, sourceVersion: 4, visible: true,
      servingEnabled: true, slug: "pilot-post", ownedSlugs: ["pilot-post"] };
    await db.doc("system/publicDeployment/noBuildPosts/current").set(state);
    await db.doc(`cmsPosts/${pilotId}`).set({ version: 4, status: "published", publiclyVisible: true,
      publishBuildPending: true, publishBuildQueueId: pilotQueueId,
      published: { sourceVersion: 4, publishedAt: "2026-10-10T18:37:04.196Z",
        metadata: { type: "post", slug: "pilot-post", title: "Pilot Post" }, blocks: [] } });
    await db.doc(`cmsPublishQueue/${pilotQueueId}`).set({ status, transport: "post-no-build-v1",
      changes: [{ collection: "cmsPosts", id: pilotId, sourceVersion: 4 }], noBuildPost: state,
      attempts: status === "failed" ? 4 : 0, nextAttemptAt: status === "failed" ? null : 0 });
    await db.doc("cmsPublishQueue/failed-repair").set({ status: "failed", transport: "serializer", changes: [] });
  }

  it.each(["pending", "failed"])("recovers a failed code repair while retaining its %s Post operation", async status => {
    await seedPendingPilot(status);
    const postBefore = (await db.doc(`cmsPosts/${pilotId}`).get()).data();
    const queueBefore = (await db.doc(`cmsPublishQueue/${pilotQueueId}`).get()).data();
    await expect(recover()).resolves.toMatchObject({ status: "pending", idempotent: false });
    expect((await pointerRef.get()).data()).toMatchObject({ ...expected, mediaLifecycleReady: false });
    expect((await queueRef.get()).data()).toMatchObject({ changes: [], transport: "serializer", commitSha });
    expect((await db.doc(`cmsPosts/${pilotId}`).get()).data()).toEqual(postBefore);
    expect((await db.doc(`cmsPublishQueue/${pilotQueueId}`).get()).data()).toEqual(queueBefore);
  });

  it.each([
    [`cmsPosts/${pilotId}`, { publishBuildQueueId: "33333333333333333333" }],
    ["cmsPosts/another-pending", { publishBuildPending: true }],
    ["cmsPublishQueue/another-pending", { status: "pending", transport: "serializer" }],
  ])("keeps recovery fenced when retained ownership or other work changes: %s", async (path, data) => {
    await seedPendingPilot("pending");
    await db.doc(path).set(data, { merge: true });
    await expect(recover()).rejects.toThrow(/publication (queues|before a source baseline)/);
    expect((await pointerRef.get()).data().mediaLifecycleReady).toBe(true);
    expect((await queueRef.get()).exists).toBe(false);
  });

  it("preserves content and live identity, closes media mutation, and reserves one normal serializer batch", async () => {
    const contentBefore = (await db.doc("cmsPosts/post-one").get()).data();
    const mediaBefore = (await db.doc("media_assets/upload-one").get()).data();
    await expect(
      safety.assertPublishedMediaSafe({ firestore: db }),
    ).rejects.toThrow("cannot enter public content");
    await expect(recover()).resolves.toMatchObject({
      status: "pending",
      idempotent: false,
    });
    expect((await pointerRef.get()).data()).toMatchObject({
      ...expected,
      lastReservedGeneration: 54,
      newestEligibleGeneration: 47,
      mediaLifecycleReady: false,
      state: "idle",
    });
    expect((await queueRef.get()).data()).toMatchObject({
      status: "pending",
      changes: [],
      commitSha,
      triggeredBy: "system:publication-baseline",
    });
    expect((await db.doc("cmsPosts/post-one").get()).data()).toEqual(
      contentBefore,
    );
    expect((await db.doc("media_assets/upload-one").get()).data()).toEqual(
      mediaBefore,
    );
    await expect(
      safety.assertPublishedMediaSafe({ firestore: db }),
    ).rejects.toThrow("cannot enter public content");
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await batchRef.get()).exists).toBe(false);
    await expect(recover()).resolves.toMatchObject({
      status: "pending",
      idempotent: true,
    });

    await serializer.claimCmsPublishQueue({
      firestore: db,
      queueId,
      buildBatchId: `cms-${queueId}`,
      commitSha,
      serializerId: "test-owner",
      claimToken: "11111111-1111-4111-8111-111111111111",
    });
    await expect(
      artifact.reserveCmsPublishArtifact({
        firestore: db,
        queueId,
        buildBatchId: `cms-${queueId}`,
        commitSha,
      }),
    ).resolves.toMatchObject({ generation: 55 });
    await expect(recover()).resolves.toMatchObject({
      status: "publishing",
      idempotent: true,
    });
    expect((await pointerRef.get()).data().lastReservedGeneration).toBe(55);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it.each([
    { mediaLifecycleReady: false },
    { activeGeneration: 46 },
    { newestEligibleGeneration: 48 },
    { lastReservedGeneration: 55 },
    { activeDeploymentId: "another-deployment" },
    { activeCommitSha: "c".repeat(40) },
  ])(
    "refuses changed predecessor evidence %j without partial writes",
    async (change) => {
      await pointerRef.update(change);
      const before = (await pointerRef.get()).data();
      await expect(recover()).rejects.toThrow();
      expect((await pointerRef.get()).data()).toEqual(before);
      expect((await queueRef.get()).exists).toBe(false);
      expect((await batchRef.get()).exists).toBe(false);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    },
  );

  it.each(["reserved", "pending", "publishing"])(
    "refuses another %s queue",
    async (status) => {
      await db.doc("cmsPublishQueue/other").set({ status });
      await expect(recover()).rejects.toThrow(
        "Finish existing publication queues",
      );
      expect((await pointerRef.get()).data().mediaLifecycleReady).toBe(true);
    },
  );

  it.each([
    ["cmsPages", "failed", true],
    ["cmsPages", "cancelled", false],
    ["cmsPosts", "failed", true],
    ["cmsPosts", "cancelled", false],
  ])(
    "refuses pending %s content owned by a %s queue",
    async (collection, status, publiclyVisible) => {
      const contentRef = db.doc(`${collection}/pending-content`);
      const content = {
        publishBuildPending: true,
        publishBuildQueueId: "old-queue",
        publiclyVisible,
        publicSourceVersion: 1,
        published: { sourceVersion: 2 },
      };
      await contentRef.set(content);
      await db.doc("cmsPublishQueue/old-queue").set({ status });
      const pointerBefore = (await pointerRef.get()).data();
      await expect(recover()).rejects.toThrow(
        "Resolve pending content publication",
      );
      expect((await pointerRef.get()).data()).toEqual(pointerBefore);
      expect((await contentRef.get()).data()).toEqual(content);
      expect((await queueRef.get()).exists).toBe(false);
      expect((await batchRef.get()).exists).toBe(false);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    },
  );

  it.each([
    "missing-private",
    "missing-public",
    "projection-mismatch",
    "deleting",
    "wrong-source",
    "not-image",
  ])("rejects unsafe media: %s", async (fault) => {
    const privateRef = db.doc("media_assets/upload-one");
    const publicRef = db.doc("media_assets_public/upload-one");
    if (fault === "missing-private") await privateRef.delete();
    if (fault === "missing-public") await publicRef.delete();
    if (fault === "projection-mismatch")
      await publicRef.update({ altText: "Changed" });
    if (fault === "deleting")
      await privateRef.update({ lifecycle: "deleting" });
    if (fault === "wrong-source")
      await privateRef.update({ source: "unknown" });
    if (fault === "not-image")
      await privateRef.update({ mimeType: "application/pdf" });
    await expect(recover()).rejects.toThrow();
    expect((await queueRef.get()).exists).toBe(false);
    expect((await pointerRef.get()).data().lastReservedGeneration).toBe(54);
  });

  it("does not treat an existing ordinary or receiptless queue as a recovery retry", async () => {
    await queueRef.set({
      status: "pending",
      transport: "serializer",
      triggeredBy: "editor",
      changes: [],
    });
    await expect(recover()).rejects.toThrow();
    expect((await batchRef.get()).exists).toBe(false);
  });

  it("deduplicates concurrent exact requests and refuses a second queue for the same predecessor", async () => {
    const results = await Promise.all([recover(), recover()]);
    expect(results.map((r) => r.idempotent).sort()).toEqual([false, true]);
    await expect(
      recover({ queueId: "55555555555555555555" }),
    ).rejects.toThrow();
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("returns an exact terminal receipt after later coordinator progress without changing it", async () => {
    await recover();
    await queueRef.update({
      status: "success",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await pointerRef.update({ lastReservedGeneration: 60 });
    const before = (await pointerRef.get()).data();
    await expect(recover()).resolves.toMatchObject({
      status: "success",
      idempotent: true,
    });
    expect((await pointerRef.get()).data()).toEqual(before);
    await expect(
      recover({ expected: { ...expected, lastReservedGeneration: 60 } }),
    ).rejects.toThrow("receipt conflicts");
  });
});

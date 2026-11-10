import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import baselineModule from
  "../../functions/lib/cms-publication-baseline.js";
import serializerQueueModule from
  "../../functions/lib/cms-publish-serializer-queue.js";
import contextPublication from "../../functions/lib/public-context-publication.js";
import { cmsPublicationBaselineRuntime } from
  "../../site/scripts/enqueue-cms-publication-baseline";

const admin = adminPkg;
const {
  CmsPublicationBaselineError,
  enqueueCmsPublicationBaseline,
} = baselineModule;
const { enqueueSerializerBuild } = serializerQueueModule;
const PROJECT = "demo-njpbs";
const QUEUE_ID = "11111111111111111111";
const COMMIT_SHA = "a".repeat(40);
const OTHER_COMMIT_SHA = "b".repeat(40);

let db;
let operatorApp;
let operatorDb;
let startedEnqueues = [];
let acceptingEnqueues = false;

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
    updatedAt: admin.firestore.Timestamp.fromMillis(1_788_000_000_000),
    ...overrides,
  };
}

async function seedPointer(overrides = {}, firestore = db) {
  await firestore.collection("system").doc("publicDeployment").set(
    pointer(overrides),
  );
}

const PILOT_POST = "pilot-post";
const PILOT_QUEUE = "22222222222222222222";
async function seedPendingPilot(status = "failed") {
  await seedPointer({ mediaLifecycleReady: true });
  const state = { schemaVersion: 1, postId: PILOT_POST, operationId: PILOT_QUEUE,
    rendererSha: "c".repeat(40), generation: 5, sourceVersion: 4, visible: true,
    servingEnabled: true, slug: "pilot-post", ownedSlugs: ["pilot-post"] };
  await db.doc("system/publicDeployment/noBuildPosts/current").set(state);
  await db.doc(`cmsPosts/${PILOT_POST}`).set({ version: 4, status: "published", publiclyVisible: true,
    publishBuildPending: true, publishBuildQueueId: PILOT_QUEUE,
    published: { sourceVersion: 4, publishedAt: "2026-10-10T18:37:04.196Z",
      metadata: { type: "post", slug: "pilot-post", title: "Pilot Post" }, blocks: [] } });
  await db.doc(`cmsPublishQueue/${PILOT_QUEUE}`).set({ status, transport: "post-no-build-v1",
    changes: [{ collection: "cmsPosts", id: PILOT_POST, sourceVersion: 4 }], noBuildPost: state,
    attempts: status === "failed" ? 4 : 0, nextAttemptAt: status === "failed" ? null : 0 });
}

function track(start) {
  if (!acceptingEnqueues) {
    throw new Error("An enqueue started after its test ended");
  }
  const started = start();
  startedEnqueues.push(started);
  return started;
}

function enqueue(overrides = {}, dependencies = {}) {
  return track(() => enqueueCmsPublicationBaseline(
    {
      firestore: db,
      queueId: QUEUE_ID,
      commitSha: COMMIT_SHA,
      ...overrides,
    },
    dependencies,
  ));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
  operatorApp = cmsPublicationBaselineRuntime.initializeApp(
    { projectId: PROJECT },
    `${PROJECT}-baseline-operator`,
  );
  operatorDb = cmsPublicationBaselineRuntime.getFirestore(operatorApp);
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  acceptingEnqueues = true;
});

// A timed-out test does not stop its enqueue calls. Refuse new calls from the
// ended test, then let started calls settle before the next test clears and
// seeds the emulator. The Admin SDK stops a transaction after five attempts,
// so the wait is finite.
afterEach(async () => {
  acceptingEnqueues = false;
  const started = startedEnqueues;
  startedEnqueues = [];
  await Promise.allSettled(started);
}, 60_000);

afterAll(async () => {
  await cmsPublicationBaselineRuntime.deleteApp(operatorApp);
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("CMS publication baseline", () => {
  it.each([true, false])("honors serializer enabled=%s for new baseline admission", async enabled => {
    await seedPointer();
    const control = db.doc("system/publicDeployment/controls/serializer");
    await control.set({ schemaVersion: 1, enabled });
    const before = (await db.doc("system/publicDeployment").get()).data();
    if (enabled) {
      await expect(enqueue()).resolves.toMatchObject({ status: "pending", idempotent: false });
      expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
      expect((await db.collection("admin_logs").get()).size).toBe(1);
    } else {
      await expect(enqueue()).rejects.toMatchObject({
        code: "serializer_publication_unavailable", status: 409,
        message: "The full-site build was retired on October 13, 2026. This change has no build-free publication path yet. Ask an administrator.",
      });
      expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
    }
    expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
    expect((await control.get()).data()).toEqual({ schemaVersion: 1, enabled });
  });

  it.each(["reserved", "pending"])("finishes an exact accepted %s baseline retry after serializer cutoff", async status => {
    await seedPointer();
    const control = db.doc("system/publicDeployment/controls/serializer");
    await control.set({ schemaVersion: 1, enabled: true });
    if (status === "reserved") {
      await baselineModule.reserveBaselineQueue({ firestore: db, queueId: QUEUE_ID, commitSha: COMMIT_SHA });
    } else await enqueue();
    await control.set({ schemaVersion: 1, enabled: false });
    await expect(enqueue()).resolves.toMatchObject({ queueId: QUEUE_ID, status: "pending" });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await control.get()).data()).toEqual({ schemaVersion: 1, enabled: false });
  });

  async function acceptContext() {
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    await db.runTransaction(async transaction => {
      const accepted = await contextPublication.enqueuePublicContextInTransaction({ transaction, firestore: db,
        operationId: "A".repeat(20), runtime: { owner: "cloudflare", release: pointer().activeCommitSha }, reason: "context", contextRevision: 1 });
      accepted.write();
    });
  }

  it("admits a source release without cancelling registered pending aggregate work", async () => {
    await seedPointer();
    await acceptContext();
    const ref = db.doc(`cmsPublishQueue/${"A".repeat(20)}`);
    const before = (await ref.get()).data();
    await expect(enqueue()).resolves.toMatchObject({ status: "pending", transport: "serializer" });
    expect((await ref.get()).data()).toEqual(before);
  });

  it.each(["serializer", "post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"])("blocks unrelated pending %s work even with registered aggregate work", async transport => {
    await seedPointer();
    await acceptContext();
    await db.doc("cmsPublishQueue/unregistered-queue").set({ status: "pending", transport });
    await expect(enqueue()).rejects.toThrow("Finish existing publication queues");
    expect((await db.doc(`cmsPublishQueue/${QUEUE_ID}`).get()).exists).toBe(false);
  });

  it.each(["pending", "failed"])("admits a code repair while retaining %s owned detail work", async status => {
    await seedPendingPilot(status);
    const postBefore = (await db.doc(`cmsPosts/${PILOT_POST}`).get()).data();
    const queueBefore = (await db.doc(`cmsPublishQueue/${PILOT_QUEUE}`).get()).data();
    await expect(enqueue()).resolves.toMatchObject({ status: "pending", transport: "serializer" });
    expect((await db.doc(`cmsPublishQueue/${QUEUE_ID}`).get()).data().changes).toEqual([]);
    expect((await db.doc(`cmsPosts/${PILOT_POST}`).get()).data()).toEqual(postBefore);
    expect((await db.doc(`cmsPublishQueue/${PILOT_QUEUE}`).get()).data()).toEqual(queueBefore);
  });

  it.each([
    ["another Post", `cmsPosts/another-post`, { publishBuildPending: true }],
    ["a Page", "cmsPages/home", { publishBuildPending: true }],
    ["a different queue owner", `cmsPosts/${PILOT_POST}`, { publishBuildQueueId: "33333333333333333333" }],
    ["a different source version", `cmsPosts/${PILOT_POST}`, { published: { sourceVersion: 5 } }],
    ["a serializer queue", `cmsPublishQueue/${PILOT_QUEUE}`, { transport: "serializer" }],
    ["a different queue version", `cmsPublishQueue/${PILOT_QUEUE}`, { changes: [{ collection: "cmsPosts", id: PILOT_POST, sourceVersion: 5 }] }],
    ["an unrelated active queue", "cmsPublishQueue/33333333333333333333", { status: "pending", transport: "serializer" }],
    ["a different renderer", "system/publicDeployment/noBuildPosts/current", { rendererSha: "d".repeat(40) }],
  ])("keeps the baseline gate for %s", async (_name, path, data) => {
    await seedPendingPilot();
    await db.doc(path).set(data, { merge: true });
    await expect(enqueue()).rejects.toThrow(/publication (queues|before a source baseline)/);
    expect((await db.doc(`cmsPublishQueue/${QUEUE_ID}`).get()).exists).toBe(false);
  });

  it("still requires detail settlement before return to static", async () => {
    await seedPendingPilot();
    await expect(enqueue({ returnPostId: PILOT_POST })).rejects.toThrow("pending content publication");
  });

  it("rechecks retained ownership before promoting the baseline reservation", async () => {
    await seedPendingPilot();
    await expect(enqueue({}, { enqueueSerializerBuildFn: async options => {
      await db.doc(`cmsPosts/${PILOT_POST}`).update({ publishBuildQueueId: "33333333333333333333" });
      return enqueueSerializerBuild(options);
    } })).rejects.toThrow("pending content publication");
    expect((await db.doc(`cmsPublishQueue/${QUEUE_ID}`).get()).data().status).toBe("reserved");
  });

  it("uses one Firebase Admin runtime for the operator and queue", async () => {
    await seedPointer({}, operatorDb);

    await expect(
      track(() => cmsPublicationBaselineRuntime.enqueueCmsPublicationBaseline({
        firestore: operatorDb,
        queueId: QUEUE_ID,
        commitSha: COMMIT_SHA,
      })),
    ).resolves.toMatchObject({
      success: true,
      queueId: QUEUE_ID,
      status: "pending",
      idempotent: false,
    });
    expect(
      (await operatorDb.collection("cmsPublishQueue").doc(QUEUE_ID).get())
        .data().triggeredAt.toMillis(),
    ).toBeGreaterThan(0);
  });

  it("creates one commit-bound no-change serializer queue and normal audit", async () => {
    await seedPointer();
    const mediaPreflight = vi.fn().mockResolvedValue({
      pageCount: 3,
      assetCount: 2,
    });

    const result = await enqueue({}, {
      assertPublishedMediaSafeFn: mediaPreflight,
    });
    const queue = (
      await db.collection("cmsPublishQueue").doc(QUEUE_ID).get()
    ).data();
    const audits = await db.collection("admin_logs").get();

    expect(result).toEqual({
      success: true,
      queueId: QUEUE_ID,
      dispatched: false,
      status: "pending",
      transport: "serializer",
      idempotent: false,
      message: "Publication baseline queue confirmed.",
    });
    expect(queue).toMatchObject({
      status: "pending",
      transport: "serializer",
      triggeredBy: "system:publication-baseline",
      triggeredByEmail: null,
      completedAt: null,
      error: null,
      changes: [],
      commitSha: COMMIT_SHA,
    });
    expect(queue.triggeredAt.toMillis()).toBeGreaterThan(0);
    expect(audits.docs).toHaveLength(1);
    expect(audits.docs[0].data()).toMatchObject({
      actorUid: "system:publication-baseline",
      action: "cms.publish",
      target: QUEUE_ID,
      after: {
        status: "pending",
        transport: "serializer",
        changesCount: 0,
        commitSha: COMMIT_SHA,
      },
      source: "publication-baseline",
    });
    expect(mediaPreflight).toHaveBeenCalledOnce();
  });

  it("returns one exact queue for sequential and concurrent retries", { timeout: 20_000 }, async () => {
    await seedPointer();
    const [first, second] = await Promise.all([enqueue(), enqueue()]);
    const retry = await enqueue();
    const queues = await db.collection("cmsPublishQueue").get();
    const audits = await db.collection("admin_logs").get();

    expect([first.idempotent, second.idempotent].sort()).toEqual([false, true]);
    expect(retry).toMatchObject({
      queueId: QUEUE_ID,
      status: "pending",
      idempotent: true,
    });
    expect(queues.docs).toHaveLength(1);
    expect(audits.docs).toHaveLength(1);
  });

  it("refuses a reused queue id with another immutable identity", async () => {
    await seedPointer();
    await enqueue();

    await expect(enqueue({ commitSha: OTHER_COMMIT_SHA })).rejects.toThrow(
      "belongs to another request",
    );
    expect((await db.collection("cmsPublishQueue").get()).docs).toHaveLength(1);
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it("returns one exact queue for concurrent retries while media publishing is enabled", async () => {
    await seedPointer({ mediaLifecycleReady: true });
    const [first, second] = await Promise.all([enqueue(), enqueue()]);
    expect([first.idempotent, second.idempotent].sort()).toEqual([false, true]);
    expect((await db.collection("cmsPublishQueue").get()).docs).toHaveLength(1);
  });

  it("refuses a media-enabled source baseline while content is still pending", async () => {
    await seedPointer({ mediaLifecycleReady: true });
    await db.collection("cmsPages").doc("home").set({
      publishBuildPending: true,
    });

    await expect(enqueue()).rejects.toThrow(
      "pending content publication before a source baseline",
    );
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it.each(["reserved", "pending", "publishing"])(
    "refuses a source baseline while another queue is %s with media off",
    async (status) => {
      await seedPointer();
      await db.collection("cmsPublishQueue").doc("22222222222222222222").set({ status });

      await expect(enqueue()).rejects.toThrow(
        "Finish existing publication queues before a source baseline",
      );
      expect((await db.collection("cmsPublishQueue").doc(QUEUE_ID).get()).exists)
        .toBe(false);
    },
  );

  it("refuses pending content with media publishing off", async () => {
    await seedPointer();
    await db.collection("cmsPages").doc("home").set({ publishBuildPending: true });

    await expect(enqueue()).rejects.toThrow(
      "Resolve pending content publication before a source baseline",
    );
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("creates a no-change queue while media publishing is enabled and generations agree", async () => {
    await seedPointer({ mediaLifecycleReady: true });
    const mediaPreflight = vi.fn().mockResolvedValue({
      pageCount: 3,
      assetCount: 2,
    });

    const result = await enqueue({}, {
      assertPublishedMediaSafeFn: mediaPreflight,
    });

    expect(result).toMatchObject({
      success: true,
      queueId: QUEUE_ID,
      status: "pending",
      idempotent: false,
    });
    expect(mediaPreflight).toHaveBeenCalledOnce();
  });

  it("points media-enabled divergence at recovery instead of a source baseline", async () => {
    await seedPointer({
      mediaLifecycleReady: true,
      lastReservedGeneration: 5,
      newestEligibleGeneration: 4,
    });

    await expect(enqueue()).rejects.toThrow(
      "Use --apply-recovery; last reserved generation is ahead of active",
    );
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("refuses a source baseline when newest eligible is ahead of active", async () => {
    await seedPointer({
      mediaLifecycleReady: true,
      lastReservedGeneration: 5,
      newestEligibleGeneration: 5,
    });

    await expect(enqueue()).rejects.toThrow(
      "Newest eligible generation is ahead of active",
    );
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("refuses promotion when pending content appears after reservation", async () => {
    await seedPointer({ mediaLifecycleReady: true });

    await expect(
      enqueue({}, {
        enqueueSerializerBuildFn: async (args) => {
          await db.collection("cmsPages").doc("home").set({
            publishBuildPending: true,
          });
          return enqueueSerializerBuild(args);
        },
      }),
    ).rejects.toThrow("pending content publication before a source baseline");
    expect(
      (await db.collection("cmsPublishQueue").doc(QUEUE_ID).get()).data().status,
    ).toBe("reserved");
  });

  it("refuses promotion when another queue appears after reservation", async () => {
    await seedPointer({ mediaLifecycleReady: true });

    await expect(
      enqueue({}, {
        enqueueSerializerBuildFn: async (args) => {
          await db.collection("cmsPublishQueue").doc("22222222222222222222").set({
            status: "pending",
            transport: "serializer",
            triggeredBy: "editor",
            triggeredByEmail: null,
            triggeredAt: admin.firestore.Timestamp.fromMillis(1_788_000_000_000),
            completedAt: null,
            error: null,
            changes: [{ collection: "cmsPages", id: "home", sourceVersion: 1 }],
          });
          return enqueueSerializerBuild(args);
        },
      }),
    ).rejects.toThrow("existing publication queues before a source baseline");
    expect(
      (await db.collection("cmsPublishQueue").doc(QUEUE_ID).get()).data().status,
    ).toBe("reserved");
  });

  it.each([
    ["a busy coordinator", { state: "deploying" }],
  ])("refuses %s before queue creation", async (_label, overrides) => {
    const value = pointer(overrides);
    if (overrides.state === "deploying") {
      Object.assign(value, {
        leaseToken: "22222222-2222-4222-8222-222222222222",
        leaseAcquiredAt: admin.firestore.Timestamp.fromMillis(
          1_788_000_000_001,
        ),
        candidateGeneration: 5,
        candidateBuildBatchId: "cms-candidate-build",
        candidateCommitSha: "d".repeat(40),
        predecessorGeneration: 4,
        predecessorDeploymentId: "deployment-4",
        predecessorCommitSha: "c".repeat(40),
        lastReservedGeneration: 5,
        newestEligibleGeneration: 5,
        newestEligibleBuildBatchId: "cms-candidate-build",
      });
    }
    await db.collection("system").doc("publicDeployment").set(value);

    await expect(enqueue()).rejects.toThrow(
      "not idle with media publishing disabled",
    );
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("does not reserve a queue when the published media preflight fails", async () => {
    await seedPointer();
    const mediaPreflight = vi.fn().mockRejectedValue(
      new Error("Published media is unsafe"),
    );

    await expect(enqueue({}, {
      assertPublishedMediaSafeFn: mediaPreflight,
    })).rejects.toThrow("Published media is unsafe");
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("requires an exact queue id, commit, and coordinator document", async () => {
    for (const fields of [
      { queueId: "short" },
      { commitSha: "short" },
    ]) {
      await expect(enqueue(fields)).rejects.toThrow(
        CmsPublicationBaselineError,
      );
    }
    await expect(enqueue()).rejects.toThrow(
      "public deployment coordinator is missing",
    );
  });
});

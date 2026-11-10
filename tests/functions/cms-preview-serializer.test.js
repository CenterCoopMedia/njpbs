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
import serializerModule from "../../functions/lib/cms-preview-serializer.js";
import previewBuildPolicyModule from "../../functions/lib/preview-build-policy.js";

const admin = adminPkg;
const { claimCmsPreviewQueue, finishCmsPreviewQueue, setCmsPreviewContextRefreshing, startCmsPreviewSerializerListener } =
  serializerModule;
const { PREVIEW_BUILD_TIMEOUT_MS, PREVIEW_BUILD_TIMEOUT_ERROR } =
  previewBuildPolicyModule;

const PROJECT = "demo-njpbs";
const QUEUE_ID = "11111111111111111111";
const RENDERER_SHA = "a".repeat(40);
const SERIALIZER_ID = "node-compute-preview-primary";
const CLAIM_TOKEN = "22222222-2222-4222-8222-222222222222";
const OTHER_TOKEN = "33333333-3333-4333-8333-333333333333";
const LISTENER_QUEUE_ONE = "44444444444444444444";
const LISTENER_QUEUE_TWO = "55555555555555555555";
const REQUESTED_AT = 1_787_000_000_000;
const EXPIRES_AT = REQUESTED_AT + 7 * 24 * 60 * 60 * 1000;

let db;

function queueRef(queueId = QUEUE_ID) {
  return db.collection("cmsPreviewQueue").doc(queueId);
}

async function seedQueue(overrides = {}) {
  await queueRef().set({
    status: "pending",
    transport: "serializer",
    pageId: "contact",
    sourceVersion: 7,
    rendererSha: RENDERER_SHA,
    requestedAt: admin.firestore.Timestamp.fromMillis(REQUESTED_AT),
    expiresAt: admin.firestore.Timestamp.fromMillis(EXPIRES_AT),
    completedAt: null,
    previewUrl: null,
    error: null,
    snapshot: { id: "contact", version: 7 },
    assets: [],
    ...overrides,
  });
}

function claim(overrides = {}) {
  return claimCmsPreviewQueue({
    firestore: db,
    queueId: QUEUE_ID,
    rendererSha: RENDERER_SHA,
    serializerId: SERIALIZER_ID,
    claimToken: CLAIM_TOKEN,
    now: () => REQUESTED_AT + 1_000,
    ...overrides,
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("cms-preview-serializer.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("CMS preview serializer claim", () => {
  it("claims one pending serializer queue without storing the claim token", async () => {
    await seedQueue();

    const result = await claim();
    const queue = (await queueRef().get()).data();

    expect(result).toMatchObject({
      outcome: "claimed",
      idempotent: false,
      receipt: {
        schemaVersion: 1,
        serializerId: SERIALIZER_ID,
        rendererSha: RENDERER_SHA,
        tokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(result.receipt.claimedAt).toBeDefined();
    expect(queue).toMatchObject({
      status: "building",
      serializerClaim: result.receipt,
    });
    expect(JSON.stringify(queue)).not.toContain(CLAIM_TOKEN);
  });

  it("returns the same claim for an exact retry", async () => {
    await seedQueue();
    const first = await claim();

    await expect(claim()).resolves.toEqual({ ...first, idempotent: true });
  });

  it.each([
    ["another token", { claimToken: OTHER_TOKEN }],
    ["another owner", { serializerId: "node-offsite-preview-fallback" }],
  ])("keeps an existing claim busy for %s", async (_label, overrides) => {
    await seedQueue();
    const first = await claim();

    await expect(claim(overrides)).resolves.toEqual({
      outcome: "busy",
      idempotent: false,
    });
    expect((await queueRef().get()).data().serializerClaim).toEqual(
      first.receipt,
    );
  });

  it.each(["ready", "failed", "expired"])(
    "does not claim a terminal %s queue",
    async (status) => {
      await seedQueue({ status });

      await expect(claim()).resolves.toEqual({
        outcome: "terminal",
        idempotent: true,
        status,
      });
      expect((await queueRef().get()).data()).not.toHaveProperty(
        "serializerClaim",
      );
    },
  );

  it("fails a queue at the shared build deadline without claiming it", async () => {
    await seedQueue();

    await expect(
      claim({ now: () => REQUESTED_AT + PREVIEW_BUILD_TIMEOUT_MS }),
    ).resolves.toEqual({
      outcome: "terminal",
      idempotent: false,
      status: "failed",
    });
    expect((await queueRef().get()).data()).toMatchObject({
      status: "failed",
      previewUrl: null,
      error: PREVIEW_BUILD_TIMEOUT_ERROR,
    });
    expect((await queueRef().get()).data()).not.toHaveProperty(
      "serializerClaim",
    );
  });

  it("fails an owned restart claim after the shared build deadline", async () => {
    await seedQueue();
    await claim();

    await expect(
      claim({ now: () => REQUESTED_AT + PREVIEW_BUILD_TIMEOUT_MS }),
    ).resolves.toEqual({
      outcome: "terminal",
      idempotent: false,
      status: "failed",
    });
    expect((await queueRef().get()).data()).toMatchObject({
      status: "failed",
      previewUrl: null,
      error: PREVIEW_BUILD_TIMEOUT_ERROR,
    });
  });

  it("expires a queue whose artifact lifetime ends before its build deadline", async () => {
    const earlyExpiry = REQUESTED_AT + 30 * 60 * 1000;
    await seedQueue({
      expiresAt: admin.firestore.Timestamp.fromMillis(earlyExpiry),
    });

    await expect(claim({ now: () => earlyExpiry })).resolves.toEqual({
      outcome: "terminal",
      idempotent: false,
      status: "expired",
    });
    expect((await queueRef().get()).data()).toMatchObject({
      status: "expired",
      previewUrl: null,
      error: null,
    });
  });

  it("refuses a GitHub queue and a renderer mismatch", async () => {
    await seedQueue({ transport: "github" });
    await expect(claim()).rejects.toThrow(/not owned/);

    await seedQueue({ transport: "serializer" });
    await expect(claim({ rendererSha: "b".repeat(40) })).rejects.toThrow(
      /identity is invalid/,
    );
    expect((await queueRef().get()).data()).toMatchObject({
      status: "pending",
      rendererSha: RENDERER_SHA,
    });
  });
});

describe("CMS preview serializer completion", () => {
  function finish(overrides = {}) {
    return finishCmsPreviewQueue({
      firestore: db, queueId: QUEUE_ID, rendererSha: RENDERER_SHA,
      serializerId: SERIALIZER_ID, claimToken: CLAIM_TOKEN,
      pageId: "contact", sourceVersion: 7, expiresAtMs: EXPIRES_AT,
      status: "ready", now: () => REQUESTED_AT + 2_000,
      ...overrides,
    });
  }

  it("marks refresh progress only for the exact building claim", async () => {
    await seedQueue();
    await claim();
    const input = { firestore: db, queueId: QUEUE_ID, rendererSha: RENDERER_SHA, refreshing: true,
      serializerId: SERIALIZER_ID, claimToken: CLAIM_TOKEN };
    await expect(setCmsPreviewContextRefreshing({ ...input, claimToken: OTHER_TOKEN })).rejects.toThrow(/does not own/);
    expect((await queueRef().get()).data().contextRefreshing).toBeUndefined();
    await setCmsPreviewContextRefreshing(input);
    expect((await queueRef().get()).data()).toMatchObject({ status: "building", contextRefreshing: true });
    await setCmsPreviewContextRefreshing({ ...input, refreshing: false });
    expect((await queueRef().get()).data()).toMatchObject({ status: "building", contextRefreshing: false });
    await finish();
    const before = (await queueRef().get()).data();
    await expect(setCmsPreviewContextRefreshing(input)).rejects.toThrow(/does not own/);
    expect((await queueRef().get()).data()).toEqual(before);
  });

  it("gives staff a refresh message only for a context readiness failure", async () => {
    await seedQueue();
    await claim();
    await expect(finish({ status: "failed", failureReason: "preview_context_refreshing" }))
      .resolves.toMatchObject({ status: "failed" });
    expect((await queueRef().get()).data()).toMatchObject({
      status: "failed", previewUrl: null,
      error: "Previews are refreshing after a recent publish. Try again in a minute.",
    });
  });

  it.each(["raw private error", "other_code"])("refuses an unrecognized failure reason %s", async failureReason => {
    await seedQueue();
    await claim();
    const before = (await queueRef().get()).data();
    await expect(finish({ status: "failed", failureReason })).rejects.toThrow(/completion input is invalid/);
    expect((await queueRef().get()).data()).toEqual(before);
  });

  it("refuses a development completion for another Firestore project without changing the queue", async () => {
    await seedQueue();
    await claim();
    const before = (await queueRef().get()).data();
    await expect(finish({ deploymentEnvironment: "development" }))
      .rejects.toThrow("Dev preview completion refused for another project");
    expect((await queueRef().get()).data()).toEqual(before);
  });

  it("finalizes a saved post only at the route frozen in its exact queue", async () => {
    await seedQueue({ collection: "cmsPosts", pageId: "post-1", persistent: true,
      pagePath: "/posts/new-report/", snapshot: { id: "post-1", version: 7,
        published: { metadata: { slug: "new-report" } } } });
    await claim();
    await expect(finish({ collection: "cmsPosts", pageId: "post-1", persistent: false }))
      .rejects.toThrow(/does not match/);
    await expect(finish({ collection: "cmsPosts", pageId: "post-1", persistent: true }))
      .resolves.toMatchObject({ status: "ready", previewUrl: `https://preview.njpbs.org/s/${QUEUE_ID}/` });
  });

  it.each(["ready", "failed"])("persists sanitized totals once for %s without changing claims or terminal retries", async status => {
    await seedQueue();
    await claim();
    const before = (await queueRef().get()).data();
    const timingsMs = { "source-check": 22, render: 17, upload: 0, pack: -1, claim: 0.5,
      finish: 86_400_001, "queue-read": NaN, "input-read": Infinity, token: "secret", snapshot: { render: 123 } };
    const startup = { startupId: "44444444-4444-4444-8444-444444444444", processStartedAtMs: REQUESTED_AT, timingsMs, token: "secret" };
    await expect(finish({ status, timingsMs, startup })).resolves.toMatchObject({ changed: true, status });
    const completed = (await queueRef().get()).data();
    expect(completed.timingsMs).toEqual({ "source-check": 22, render: 17, upload: 0 });
    expect(completed.startup).toEqual({ startupId: startup.startupId, processStartedAtMs: REQUESTED_AT,
      timingsMs: { "source-check": 22, render: 17, upload: 0 } });
    expect(completed.serializerClaim).toEqual(before.serializerClaim);
    expect(completed.snapshot).toEqual(before.snapshot);
    await expect(finish({ status, timingsMs: { render: 999 } })).resolves.toMatchObject({ changed: false, status });
    expect((await queueRef().get()).data()).toEqual(completed);
  });

  it("records the queue-prefixed URL once and preserves the frozen snapshot", async () => {
    await seedQueue();
    await claim();
    const before = (await queueRef().get()).data();
    const previewUrl = `https://preview.njpbs.org/p/${QUEUE_ID}/`;
    await expect(finish()).resolves.toEqual({ changed: true, status: "ready", previewUrl });
    const completed = (await queueRef().get()).data();
    expect(completed).toMatchObject({
      status: "ready", previewUrl, gitCommitSha: RENDERER_SHA, error: null,
      snapshot: before.snapshot, assets: before.assets, serializerClaim: before.serializerClaim,
    });
    expect(completed.completedAt).toBeDefined();
    await expect(finish()).resolves.toEqual({ changed: false, status: "ready", previewUrl });
    expect((await queueRef().get()).data()).toEqual(completed);
    await expect(finish({ status: "failed" })).rejects.toThrow(/different terminal result/);
  });

  it.each([
    ["claim token", { claimToken: OTHER_TOKEN }],
    ["serializer owner", { serializerId: "other-preview-owner" }],
    ["renderer", { rendererSha: "b".repeat(40) }],
    ["page", { pageId: "home" }],
    ["saved version", { sourceVersion: 8 }],
    ["artifact expiry", { expiresAtMs: EXPIRES_AT + 1 }],
  ])("refuses a mismatched %s without a write", async (_name, overrides) => {
    await seedQueue();
    await claim();
    const before = (await queueRef().get()).data();
    await expect(finish(overrides)).rejects.toThrow(/does not match|does not own/);
    expect((await queueRef().get()).data()).toEqual(before);
  });

  it("refuses unclaimed, other-transport and changed-snapshot queues", async () => {
    await seedQueue();
    await expect(finish()).rejects.toThrow(/claim is invalid/);
    await claim();
    await queueRef().update({ transport: "github" });
    await expect(finish()).rejects.toThrow(/does not match/);
    await queueRef().update({ transport: "serializer", "snapshot.version": 8 });
    await expect(finish()).rejects.toThrow(/does not match/);
    expect((await queueRef().get()).data().status).toBe("building");
  });

  it("records failure and never revives it with a late success", async () => {
    await seedQueue();
    await claim();
    await expect(finish({ status: "failed" })).resolves.toMatchObject({ changed: true, status: "failed", previewUrl: null });
    await expect(finish({ status: "failed" })).resolves.toMatchObject({ changed: false, status: "failed" });
    await expect(finish()).rejects.toThrow(/different terminal result/);
    expect((await queueRef().get()).data()).not.toHaveProperty("gitCommitSha");
  });

  it("allows only one of competing terminal results", async () => {
    await seedQueue();
    await claim();
    const results = await Promise.allSettled([finish(), finish({ status: "failed" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("records expiry or the build deadline instead of exposing a late artifact", async () => {
    await seedQueue();
    await claim();
    await expect(finish({ now: () => REQUESTED_AT + PREVIEW_BUILD_TIMEOUT_MS })).resolves.toMatchObject({ status: "failed", previewUrl: null });
    expect((await queueRef().get()).data().error).toBe(PREVIEW_BUILD_TIMEOUT_ERROR);
    const expiry = REQUESTED_AT + 10_000;
    await seedQueue({ expiresAt: admin.firestore.Timestamp.fromMillis(expiry) });
    await claim();
    await expect(finish({ expiresAtMs: expiry, now: () => expiry })).resolves.toMatchObject({ status: "expired", previewUrl: null });
    await expect(finish({ expiresAtMs: expiry })).rejects.toThrow(/different terminal result/);
  });

  it.each(["failed", "expired"])("retries a ready completion normalized to %s without rewriting it", async status => {
    const expiry = status === "expired" ? REQUESTED_AT + 10_000 : EXPIRES_AT;
    const completionTime = status === "expired" ? expiry : REQUESTED_AT + PREVIEW_BUILD_TIMEOUT_MS;
    await seedQueue({ expiresAt: admin.firestore.Timestamp.fromMillis(expiry) });
    await claim();
    const completion = { expiresAtMs: expiry, now: () => completionTime };
    await expect(finish(completion)).resolves.toEqual({ changed: true, status, previewUrl: null });
    const stored = (await queueRef().get()).data();

    await expect(finish(completion)).resolves.toEqual({ changed: false, status, previewUrl: null });
    await expect(finish({ ...completion, now: () => EXPIRES_AT + 1 })).resolves.toEqual({ changed: false, status, previewUrl: null });
    expect((await queueRef().get()).data()).toEqual(stored);
  });
});

function listenerHarness(recoveryIds = []) {
  let next;
  let fail;
  const unsubscribe = vi.fn();
  const liveLimit = vi.fn(() => ({
    onSnapshot(nextHandler, errorHandler) {
      next = nextHandler;
      fail = errorHandler;
      return unsubscribe;
    },
  }));
  const recoveryGet = vi.fn(async () => ({
    docs: recoveryIds.map((id) => ({ id })),
  }));
  const recoveryLimit = vi.fn(() => ({ get: recoveryGet }));
  const recoveryOwnerWhere = vi.fn(() => ({ limit: recoveryLimit }));
  const liveTransportWhere = vi.fn(() => ({ limit: liveLimit }));
  const where = vi.fn((field, operator, value) => {
    if (field === "status" && operator === "==" && value === "building") {
      return { where: recoveryOwnerWhere };
    }
    if (field === "status" && operator === "==" && value === "pending") {
      return { where: liveTransportWhere };
    }
    throw new Error("unexpected listener query");
  });
  const collection = vi.fn(() => ({ where }));
  return {
    firestore: { collection },
    emit(ids) {
      next({
        docChanges: () =>
          ids.map((id) => ({
            type: "added",
            doc: { id },
          })),
      });
    },
    fail(error) {
      fail(error);
    },
    collection,
    where,
    liveLimit,
    liveTransportWhere,
    recoveryOwnerWhere,
    recoveryLimit,
    unsubscribe,
  };
}

describe("CMS preview serializer listener", () => {
  it("uses one bounded pending query and processes ids in sequence", async () => {
    const harness = listenerHarness();
    const started = [];
    const releases = [];
    const processQueue = vi.fn(
      (queueId) =>
        new Promise((resolve) => {
          started.push(queueId);
          releases.push(resolve);
        }),
    );
    const listener = await startCmsPreviewSerializerListener({
      firestore: harness.firestore,
      serializerId: SERIALIZER_ID,
      processQueue,
    });

    expect(harness.collection).toHaveBeenCalledWith("cmsPreviewQueue");
    expect(harness.where).toHaveBeenCalledWith("status", "==", "building");
    expect(harness.recoveryOwnerWhere).toHaveBeenCalledWith(
      "serializerClaim.serializerId",
      "==",
      SERIALIZER_ID,
    );
    expect(harness.recoveryLimit).toHaveBeenCalledWith(10);
    expect(harness.where).toHaveBeenCalledWith("status", "==", "pending");
    expect(harness.liveTransportWhere).toHaveBeenCalledWith(
      "transport",
      "==",
      "serializer",
    );
    expect(harness.liveLimit).toHaveBeenCalledWith(10);

    harness.emit([LISTENER_QUEUE_ONE, LISTENER_QUEUE_TWO, LISTENER_QUEUE_ONE]);
    await vi.waitFor(() => expect(started).toEqual([LISTENER_QUEUE_ONE]));
    releases.shift()();
    await vi.waitFor(() =>
      expect(started).toEqual([LISTENER_QUEUE_ONE, LISTENER_QUEUE_TWO]),
    );
    releases.shift()();
    await vi.waitFor(() => expect(processQueue).toHaveBeenCalledTimes(2));

    listener.stop();
    await expect(listener.closed).resolves.toEqual({ reason: "stopped" });
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("recovers owned building work before new pending rows", async () => {
    const harness = listenerHarness([LISTENER_QUEUE_ONE]);
    const processed = [];
    const listener = await startCmsPreviewSerializerListener({
      firestore: harness.firestore,
      serializerId: SERIALIZER_ID,
      processQueue: vi.fn(async (queueId) => {
        processed.push(queueId);
      }),
    });

    harness.emit([LISTENER_QUEUE_TWO]);
    await vi.waitFor(() =>
      expect(processed).toEqual([LISTENER_QUEUE_ONE, LISTENER_QUEUE_TWO]),
    );

    listener.stop();
    await expect(listener.closed).resolves.toEqual({ reason: "stopped" });
  });

  it("stops and rejects when processing or the listener fails", async () => {
    const processHarness = listenerHarness();
    const processListener = await startCmsPreviewSerializerListener({
      firestore: processHarness.firestore,
      serializerId: SERIALIZER_ID,
      processQueue: vi.fn(async () => {
        throw new Error("build failed");
      }),
    });
    processHarness.emit([LISTENER_QUEUE_ONE]);
    await expect(processListener.closed).rejects.toThrow(/build failed/);
    expect(processHarness.unsubscribe).toHaveBeenCalledTimes(1);

    const listenHarness = listenerHarness();
    const listenListener = await startCmsPreviewSerializerListener({
      firestore: listenHarness.firestore,
      serializerId: SERIALIZER_ID,
      processQueue: vi.fn(),
    });
    listenHarness.fail(new Error("listen failed"));
    await expect(listenListener.closed).rejects.toThrow(/listen failed/);
    expect(listenHarness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

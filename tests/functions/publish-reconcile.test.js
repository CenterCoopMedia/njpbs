import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Query } from "firebase-admin/firestore";
import adminPkg from "../helpers/firebase-admin.js";
import publishReconcile from "../../functions/publish-reconcile.js";
import reconcileCore from "../../functions/lib/publish-reconcile.js";

const {
  HEALTHCHECKS_PUBLISH_RECONCILE,
  PUBLISH_RECONCILE_SCHEDULE,
  createPublishQueueReconcileRunner,
  onPublishQueueReconcile,
} = publishReconcile;
const {
  STALE_PUBLISH_ERROR,
  reconcileStalePublishRows,
} = reconcileCore;
const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = Date.parse("2026-07-09T16:00:00.000Z");
const ONE_DAY = 24 * 60 * 60 * 1000;

let db;

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("publish-reconcile.test.js");
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

afterEach(() => vi.restoreAllMocks());

describe("publish queue reconciliation schedule", () => {
  it("runs hourly with only its dedicated Healthchecks secret", () => {
    expect(PUBLISH_RECONCILE_SCHEDULE).toBe("every 60 minutes");
    expect(onPublishQueueReconcile.__endpoint.scheduleTrigger.schedule).toBe(
      PUBLISH_RECONCILE_SCHEDULE,
    );
    expect(
      onPublishQueueReconcile.__endpoint.secretEnvironmentVariables,
    ).toEqual([
      { key: "HEALTHCHECKS_PUBLISH_RECONCILE" },
    ]);
    expect(HEALTHCHECKS_PUBLISH_RECONCILE.name).toBe(
      "HEALTHCHECKS_PUBLISH_RECONCILE",
    );
  });

  it("fails stale rows and then reports a successful scheduled run", async () => {
    const staleTriggeredAt = admin.firestore.Timestamp.fromMillis(NOW - ONE_DAY);
    const freshTriggeredAt = admin.firestore.Timestamp.fromMillis(
      NOW - ONE_DAY + 1,
    );
    const terminalCompletedAt = admin.firestore.Timestamp.fromMillis(
      NOW - ONE_DAY + 1000,
    );
    const stalePublishingRef = db
      .collection("cmsPublishQueue")
      .doc("stale-publishing");
    const stalePendingRef = db
      .collection("cmsPublishQueue")
      .doc("stale-pending");
    const staleReservedRef = db
      .collection("cmsPublishQueue")
      .doc("stale-reserved");
    const freshPublishingRef = db
      .collection("cmsPublishQueue")
      .doc("fresh-publishing");
    const successRef = db.collection("cmsPublishQueue").doc("success");
    const staleContentRef = db.collection("cmsPages").doc("contact");
    const successData = {
      status: "success",
      triggeredAt: staleTriggeredAt,
      completedAt: terminalCompletedAt,
      gitCommitSha: "success-sha",
    };

    await Promise.all([
      stalePublishingRef.set({
        status: "publishing",
        triggeredAt: staleTriggeredAt,
        completedAt: null,
        error: null,
        changes: [
          { collection: "cmsPages", id: "contact", sourceVersion: 3 },
        ],
      }),
      stalePendingRef.set({
        status: "pending",
        triggeredAt: staleTriggeredAt,
        completedAt: null,
        error: null,
      }),
      staleReservedRef.set({
        status: "reserved",
        triggeredAt: staleTriggeredAt,
        completedAt: null,
        error: null,
      }),
      freshPublishingRef.set({
        status: "publishing",
        triggeredAt: freshTriggeredAt,
        completedAt: null,
        error: null,
      }),
      successRef.set(successData),
      staleContentRef.set({
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: "stale-publishing",
        published: { sourceVersion: 3 },
      }),
    ]);

    const log = { info: vi.fn() };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const run = createPublishQueueReconcileRunner({
      firestore: db,
      now: () => NOW,
      log,
      getHealthchecksUrl: () => "https://hc-ping.com/example-check",
      fetchImpl: fetchMock,
    });

    await expect(run()).resolves.toEqual({ reconciledCount: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hc-ping.com/example-check",
      {
        method: "GET",
        headers: { "User-Agent": "njpbs-publish-queue-reconcile" },
      },
    );
    expect(log.info).toHaveBeenCalledWith(
      "publish queue reconcile completed",
      { count: 3 },
    );
    expect((await stalePublishingRef.get()).data()).toMatchObject({
      status: "failed",
      error: STALE_PUBLISH_ERROR,
    });
    expect(
      (await stalePublishingRef.get()).data().completedAt,
    ).toBeInstanceOf(admin.firestore.Timestamp);
    expect((await stalePendingRef.get()).data()).toMatchObject({
      status: "failed",
      error: STALE_PUBLISH_ERROR,
    });
    expect((await staleReservedRef.get()).data()).toMatchObject({
      status: "failed",
      error: STALE_PUBLISH_ERROR,
    });
    expect((await freshPublishingRef.get()).data().status).toBe("publishing");
    expect((await successRef.get()).data()).toEqual(successData);
    expect((await staleContentRef.get()).data()).toMatchObject({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 3 },
    });
  });

  it("does not report success when reconciliation fails", async () => {
    const fetchMock = vi.fn();
    const run = createPublishQueueReconcileRunner({
      reconcileStaleFn: vi.fn(async () => {
        throw new Error("Firestore unavailable");
      }),
      getHealthchecksUrl: () => "https://hc-ping.com/example-check",
      fetchImpl: fetchMock,
    });

    await expect(run()).rejects.toThrow("Firestore unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns after one empty query without reading fresh or terminal jobs", async () => {
    const batch = db.batch();
    for (let index = 0; index < 150; index++) {
      batch.set(db.collection("cmsPublishQueue").doc(`fresh-${index}`), {
        status: ["reserved", "pending", "publishing"][index % 3],
        triggeredAt: new Date(NOW - ONE_DAY + 1),
      });
    }
    batch.set(db.collection("cmsPublishQueue").doc("finished"), {
      status: "success", triggeredAt: new Date(NOW - ONE_DAY),
    });
    batch.set(db.collection("cmsPublishQueue").doc("undated"), { status: "pending" });
    await batch.commit();
    const get = vi.spyOn(Query.prototype, "get");
    const transaction = vi.spyOn(db, "runTransaction");

    expect(await reconcileStalePublishRows({ firestore: db, now: () => NOW })).toBe(0);

    expect(get).toHaveBeenCalledOnce();
    expect((await get.mock.results[0].value).empty).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts the ISO clock passed through lifecycle withdrawal enqueue", async () => {
    const stale = db.collection("cmsPublishQueue").doc("stale-withdrawal");
    const fresh = db.collection("cmsPublishQueue").doc("fresh-withdrawal");
    await Promise.all([
      stale.set({ status: "pending", triggeredAt: new Date(NOW - ONE_DAY) }),
      fresh.set({ status: "pending", triggeredAt: new Date(NOW - ONE_DAY + 1) }),
    ]);

    expect(await reconcileStalePublishRows({
      firestore: db, now: () => new Date(NOW).toISOString(),
    })).toBe(1);

    expect((await stale.get()).data().status).toBe("failed");
    expect((await fresh.get()).data().status).toBe("pending");
  });

  it("pages past durable no-build jobs without starving stale legacy jobs at the same timestamp", async () => {
    const batch = db.batch();
    const timestamp = new Date(NOW - ONE_DAY);
    const transports = ["post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1"];
    for (let index = 0; index < 100; index++) {
      batch.set(db.collection("cmsPublishQueue").doc(`z-durable-${String(index).padStart(3, "0")}`), {
        status: "pending", triggeredAt: timestamp, transport: transports[index % 3],
      });
    }
    const legacy = ["a-github", "a-serializer", "a-without-transport"];
    legacy.forEach((id, index) => batch.set(db.collection("cmsPublishQueue").doc(id), {
      status: ["reserved", "pending", "publishing"][index], triggeredAt: timestamp,
      ...(index < 2 ? { transport: ["github", "serializer"][index] } : {}),
    }));
    await batch.commit();
    const get = vi.spyOn(Query.prototype, "get");

    expect(await reconcileStalePublishRows({ firestore: db, now: () => NOW })).toBe(3);

    const pages = await Promise.all(get.mock.results.map(result => result.value));
    expect(pages.map(page => page.size)).toEqual([100, 3]);
    const rows = await db.collection("cmsPublishQueue").get();
    expect(rows.docs.filter(row => row.id.startsWith("z-durable-")).every(row => row.data().status === "pending")).toBe(true);
    expect(legacy.every(id => rows.docs.find(row => row.id === id).data().status === "failed")).toBe(true);
  });

  it.each([
    { status: "success" },
    { status: "pending", transport: "post-no-build-v1" },
    { status: "pending", transport: "page-no-build-v1" },
    { status: "pending", transport: "public-context-no-build-v1" },
  ])("rechecks a candidate that became $status/$transport before failing it", async current => {
    const ref = db.collection("cmsPublishQueue").doc("already-finished");
    await ref.set({ status: "publishing", triggeredAt: new Date(NOW - ONE_DAY) });
    const runTransaction = db.runTransaction.bind(db);
    vi.spyOn(db, "runTransaction").mockImplementationOnce(async (...args) => {
      await ref.update(current);
      return runTransaction(...args);
    });

    await expect(
      reconcileStalePublishRows({ firestore: db, now: () => NOW }),
    ).resolves.toBe(0);
    expect((await ref.get()).data()).toMatchObject(current);
    expect((await ref.get()).data().error).toBeUndefined();
  });
});

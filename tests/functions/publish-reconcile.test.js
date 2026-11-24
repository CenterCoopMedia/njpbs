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
import adminPkg from "../helpers/firebase-admin.js";
import publishReconcile from "../../functions/publish-reconcile.js";

const {
  HEALTHCHECKS_PUBLISH_RECONCILE,
  PUBLISH_RECONCILE_SCHEDULE,
  createPublishQueueReconcileRunner,
  onPublishQueueReconcile,
} = publishReconcile;
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

  it("fails no row by age and reports a successful scheduled run", async () => {
    const oldTriggeredAt = admin.firestore.Timestamp.fromMillis(NOW - 30 * ONE_DAY);
    const statuses = ["reserved", "pending", "publishing"];
    const refs = statuses.map(status => db.collection("cmsPublishQueue").doc(`old-${status}`));
    await Promise.all(refs.map((ref, index) => ref.set({
      status: statuses[index], triggeredAt: oldTriggeredAt, completedAt: null, error: null })));
    const contentRef = db.collection("cmsPages").doc("contact");
    const content = { status: "published", publishBuildPending: true, publishBuildQueueId: "old-publishing",
      published: { sourceVersion: 3 } };
    await contentRef.set(content);

    const log = { info: vi.fn() };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    const run = createPublishQueueReconcileRunner({
      firestore: db,
      now: () => NOW,
      log,
      getHealthchecksUrl: () => "https://hc-ping.com/example-check",
      fetchImpl: fetchMock,
    });

    await run();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hc-ping.com/example-check",
      {
        method: "GET",
        headers: { "User-Agent": "njpbs-publish-queue-reconcile" },
      },
    );
    expect(log.info).toHaveBeenCalledWith("publish queue reconcile completed");
    for (const [index, ref] of refs.entries()) {
      expect((await ref.get()).data()).toMatchObject({ status: statuses[index], error: null });
    }
    expect((await contentRef.get()).data()).toEqual(content);
    expect((await refs[2].get()).data().status).toBe("publishing");
  });

  it("does not report success when the health ping fails", async () => {
    const run = createPublishQueueReconcileRunner({
      firestore: db,
      getHealthchecksUrl: () => "https://hc-ping.com/example-check",
      fetchImpl: vi.fn(async () => ({ ok: false, status: 503 })),
      log: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(run()).rejects.toThrow("Healthchecks publish reconcile ping failed: 503");
  });
});

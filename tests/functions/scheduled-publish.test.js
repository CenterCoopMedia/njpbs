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
import scheduledPublish from "../../functions/scheduled-publish.js";
import runtimePublication from "../../functions/lib/public-runtime-publication.js";
import { parsePublishInstant } from "../../packages/content-core/src/publish-instant";

const {
  MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
  MAX_SCHEDULED_CHANGES_PER_RUN,
  SCHEDULER_ACTOR,
  canonicalInstant,
  createScheduledPublishRunner,
  isDue,
  onScheduledPublish,
  samePublishAtValue,
} = scheduledPublish;
const { settleRuntimePublication } = runtimePublication;
const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = "2026-07-15T12:00:00.000Z";

let db;

const divider = (id = "divider") => ({
  id,
  type: "divider",
  order: 0,
  visible: true,
  data: {},
});

const image = (id, assetId, { order = 0, visible = true } = {}) => ({
  id,
  type: "image",
  order,
  visible,
  data: { assetId, alt: "Scheduled image" },
});

async function seedMediaAsset(
  assetId,
  { lifecycle = "active", source = "site_seed" } = {},
) {
  const record = {
    lifecycle,
    source,
    url: `https://media.njpbs.org/cms-media/general/${assetId}/hash.png`,
    altText: null,
    mimeType: "image/png",
    width: 1600,
    height: 900,
  };
  await db.collection("media_assets").doc(assetId).set(record);
  if (lifecycle === "active") {
    await db.collection("media_assets_public").doc(assetId).set({
      url: record.url,
      altText: record.altText,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
    });
  }
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("scheduled-publish.test.js");
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

describe("scheduled publish snapshot", () => {
  it.each([
    "2026-07-15T11:00:00Z",
    "2026-07-15T11:00:00.1Z",
    "2026-07-15T11:00:00.12Z",
    "2026-07-15T11:00:00.123Z",
  ])("accepts the shared strict UTC instant form %s", (publishAt) => {
    const parsed = parsePublishInstant(publishAt);
    expect(parsed).not.toBeNull();
    expect(canonicalInstant(publishAt)).toBe(parsed);
    expect(
      isDue(
        { status: "scheduled", publishAt },
        Date.parse("2026-07-15T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it.each([
    "0099-07-14T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-07-15T11:00:00.0000Z",
    "2026-07-15T11:00:00.000+00:00",
    "2026-07-15T11:00:00.000z",
    "2026-07-15T11:00:00",
  ])("rejects the shared invalid UTC instant form %s", (publishAt) => {
    expect(parsePublishInstant(publishAt)).toBeNull();
    expect(canonicalInstant(publishAt)).toBeNull();
    expect(
      isDue(
        { status: "scheduled", publishAt },
        Date.parse("2026-07-15T12:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("selects an abbreviated instant due in the current second", async () => {
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      title: "Due now",
      status: "scheduled",
      publishAt: "2026-07-15T12:00:00Z",
      blocks: [divider()],
      version: 1,
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 2 }],
    });
  });

  it("does not publish a fractional instant later in the current second", async () => {
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      title: "Due in one millisecond",
      status: "scheduled",
      publishAt: "2026-07-15T12:00:00.001Z",
      blocks: [divider()],
      version: 1,
    });
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    expect((await db.collection("cmsPages").doc("home").get()).data().status)
      .toBe("scheduled");
  });

  it("does not let later fractional rows hide a due abbreviated instant", async () => {
    await Promise.all([
      ...Array.from(
        { length: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN },
        (_unused, index) => {
          const id = `future-${String(index).padStart(3, "0")}`;
          return db.collection("cmsPosts").doc(id).set({
            id,
            type: "post",
            title: id,
            date: "2026-07-15",
            tags: [],
            slug: id,
            previousSlugs: [],
            locale: "en",
            status: "scheduled",
            publishAt: "2026-07-15T12:00:00.001Z",
            blocks: [],
            version: 1,
          });
        },
      ),
      db.collection("cmsPosts").doc("due-now").set({
        id: "due-now",
        type: "post",
        title: "Due now",
        date: "2026-07-15",
        tags: [],
        slug: "due-now",
        previousSlugs: [],
        locale: "en",
        status: "scheduled",
        publishAt: "2026-07-15T12:00:00Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPosts", id: "due-now", sourceVersion: 2 }],
    });
    expect(
      await db.collection("cmsPosts").where("status", "==", "scheduled").get(),
    ).toMatchObject({ size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN });
  }, 20_000);

  it("selects every abbreviated form due at a nonzero fractional boundary", async () => {
    const rows = [
      ["due-bare", "2026-07-15T12:00:00Z"],
      ["due-tenth", "2026-07-15T12:00:00.5Z"],
      ["due-hundredth", "2026-07-15T12:00:00.50Z"],
      ["future-tenth", "2026-07-15T12:00:00.6Z"],
      ["future-hundredth", "2026-07-15T12:00:00.51Z"],
      ["future-thousandth", "2026-07-15T12:00:00.501Z"],
    ];
    await Promise.all(
      rows.map(([id, publishAt]) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: id,
          date: "2026-07-15",
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt,
          blocks: [],
          version: 1,
        }),
      ),
    );
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => "2026-07-15T12:00:00.500Z",
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 3,
      queueId: "queue-1",
    });
    expect(
      (await db.collection("cmsPosts").where("status", "==", "published").get())
        .docs.map((document) => document.id).sort(),
    ).toEqual(["due-bare", "due-hundredth", "due-tenth"]);
    expect(
      (await db.collection("cmsPosts").where("status", "==", "scheduled").get())
        .docs.map((document) => document.id).sort(),
    ).toEqual(["future-hundredth", "future-tenth", "future-thousandth"]);
  });

  it("compares independent Firestore Timestamp reads by value", () => {
    const observed = admin.firestore.Timestamp.fromMillis(1_786_790_400_000);
    const reread = admin.firestore.Timestamp.fromMillis(1_786_790_400_000);
    const changed = admin.firestore.Timestamp.fromMillis(1_786_790_400_001);

    expect(observed).not.toBe(reread);
    expect(samePublishAtValue(observed, reread)).toBe(true);
    expect(samePublishAtValue(observed, changed)).toBe(false);
    expect(samePublishAtValue("2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z"))
      .toBe(true);
  });

  it("serializes the minute trigger to one request in one instance", () => {
    expect(onScheduledPublish.__endpoint).toMatchObject({
      concurrency: 1,
      maxInstances: 1,
      scheduleTrigger: { schedule: "every 1 minutes" },
    });
  });

  it("bounds one scheduler run and drains the remainder on the next tick", async () => {
    expect(MAX_SCHEDULED_CHANGES_PER_RUN).toBe(100);
    expect(MAX_SCHEDULED_CANDIDATE_READS_PER_RUN).toBe(200);
    const total = MAX_SCHEDULED_CHANGES_PER_RUN + 1;
    await Promise.all(
      Array.from({ length: total }, (_, index) => {
        const id = `post-${String(index).padStart(3, "0")}`;
        return db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: `Post ${index}`,
          date: "2026-07-15",
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt: "2026-07-15T11:00:00.000Z",
          blocks: [],
          version: 1,
        });
      }),
    );
    let queueNumber = 0;
    const enqueuePublishFn = vi.fn(async ({ changes }) => {
      queueNumber += 1;
      await Promise.all(
        changes.map(({ collection, id }) =>
          db
            .collection(collection)
            .doc(id)
            .update({ publishBuildQueueId: `queue-${queueNumber}` }),
        ),
      );
      return { queueId: `queue-${queueNumber}` };
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    const first = await run();

    expect(first).toMatchObject({
      publishedCount: MAX_SCHEDULED_CHANGES_PER_RUN,
      queueId: "queue-1",
    });
    expect(first.changes).toHaveLength(MAX_SCHEDULED_CHANGES_PER_RUN);
    expect(
      (
        await db.collection("cmsPosts").where("status", "==", "scheduled").get()
      ).docs.map((document) => document.id),
    ).toEqual(["post-100"]);

    const second = await run();

    expect(second).toEqual({
      publishedCount: 1,
      queueId: "queue-2",
      changes: [
        { collection: "cmsPosts", id: "post-100", sourceVersion: 2 },
      ],
    });
    expect(
      await db.collection("cmsPosts").where("status", "==", "scheduled").get(),
    ).toMatchObject({ empty: true });
    expect((await db.collection("cmsVersionHistory").get()).docs).toHaveLength(
      total,
    );
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(total);
  }, 20_000);

  it("snapshots every due document before it enqueues one static build", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Scheduled contact",
      description: "The scheduled revision.",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      updatedBy: "editor-1",
      version: 3,
    });
    await db.collection("cmsPosts").doc("future-post").set({
      id: "future-post",
      type: "post",
      title: "Tomorrow",
      date: "2026-07-16",
      tags: [],
      slug: "tomorrow",
      previousSlugs: [],
      locale: "en",
      status: "scheduled",
      publishAt: "2026-07-16T11:00:00.000Z",
      blocks: [],
      version: 1,
    });

    const events = [];
    const assertPublishReadyFn = vi.fn(async () => {
      events.push("preflight");
    });
    const enqueuePublishFn = vi.fn(async ({ changes }) => {
      events.push("enqueue");
      const stored = (
        await db.collection("cmsPages").doc("contact").get()
      ).data();
      expect(stored.status).toBe("published");
      expect(stored.published.blocks).toEqual(stored.blocks);
      return { queueId: "queue-1" };
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn,
      enqueuePublishFn,
      now: () => NOW,
    });

    const result = await run();

    expect(result).toEqual({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [
        { collection: "cmsPages", id: "contact", sourceVersion: 4 },
      ],
    });
    expect(events).toEqual(["preflight", "enqueue"]);
    expect(assertPublishReadyFn).toHaveBeenCalledOnce();
    expect(enqueuePublishFn).toHaveBeenCalledOnce();

    const page = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(page).toMatchObject({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: expect.any(String),
      publishAt: "2026-07-15T11:00:00.000Z",
      updatedAt: NOW,
      updatedBy: "system:scheduler",
      version: 4,
      published: {
        metadata: {
          title: "Scheduled contact",
          description: "The scheduled revision.",
        },
        publishedAt: NOW,
        publishedBy: "system:scheduler",
        sourceVersion: 4,
      },
    });
    expect(
      (await db.collection("cmsPosts").doc("future-post").get()).data().status,
    ).toBe("scheduled");
    const versions = await db.collection("cmsVersionHistory").get();
    expect(versions.docs).toHaveLength(1);
    expect(versions.docs[0].data()).toMatchObject({
      action: "publish",
      collection: "cmsPages",
      documentId: "contact",
    });
    const logs = await db.collection("admin_logs").get();
    expect(logs.docs).toHaveLength(1);
    expect(logs.docs[0].data()).toMatchObject({
      action: "cms.schedule-publish",
      target: "cmsPages/contact",
    });
  });

  it("validates media and replaces working and published usage", async () => {
    await Promise.all([
      seedMediaAsset("visible-image"),
      seedMediaAsset("hidden-image"),
      seedMediaAsset("social-image"),
      db.collection("cmsPages").doc("about").set({
        id: "about",
        title: "Scheduled about page",
        template: "programLanding",
        status: "scheduled",
        publishAt: "2026-07-15T10:00:00.000Z",
        social: { imageAssetId: "social-image" },
        blocks: [
          image("visible", "visible-image"),
          image("hidden", "hidden-image", { order: 1, visible: false }),
        ],
        version: 3,
      }),
    ]);
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({ publishedCount: 1 });
    expect((await db.collection("cmsPages/about/mediaUsage").doc("working").get()).data())
      .toEqual({
        state: "working",
        sourceVersion: 4,
        assetIds: ["hidden-image", "social-image", "visible-image"],
        occurrenceCount: 3,
      });
    expect((await db.collection("cmsPages/about/mediaUsage").doc("published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 4,
        assetIds: ["social-image", "visible-image"],
        occurrenceCount: 2,
      });
  });

  it("skips an unavailable media reference without blocking later due content", async () => {
    await Promise.all([
      seedMediaAsset("retired-image", { lifecycle: "tombstoned" }),
      db.collection("cmsPages").doc("contact").set({
        id: "contact",
        title: "Blocked contact",
        template: "genericPage",
        status: "scheduled",
        publishAt: "2026-07-15T10:00:00.000Z",
        blocks: [image("retired", "retired-image")],
        version: 1,
      }),
      db.collection("cmsPages").doc("home").set({
        id: "home",
        title: "Valid home",
        template: "home",
        status: "scheduled",
        publishAt: "2026-07-15T10:30:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const errors = [];
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
      log: {
        info: () => {},
        warn: () => {},
        error: (message, metadata) => errors.push({ message, metadata }),
      },
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 2 }],
    });
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "A media file is missing or is not ready to publish.",
      },
    });
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toMatchObject({ status: "published", version: 2 });
    expect(errors).toEqual([
      expect.objectContaining({
        message: "scheduled publish moved a blocked document to failure",
        metadata: expect.objectContaining({
          collection: "cmsPages",
          documentId: "contact",
          detail: expect.stringMatching(/not available/i),
        }),
      }),
    ]);
  });

  it("blocks uploaded media without starving later due content", async () => {
    await Promise.all([
      seedMediaAsset("uploaded-image", { source: "upload" }),
      db.collection("cmsPages").doc("contact").set({
        id: "contact",
        title: "Blocked contact",
        template: "genericPage",
        status: "scheduled",
        publishAt: "2026-07-15T10:00:00.000Z",
        blocks: [image("uploaded", "uploaded-image")],
        version: 1,
      }),
      db.collection("cmsPages").doc("home").set({
        id: "home",
        title: "Valid home",
        template: "home",
        status: "scheduled",
        publishAt: "2026-07-15T10:30:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const errors = [];
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "queue-1" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
      log: {
        info: () => {},
        warn: () => {},
        error: (message, metadata) => errors.push({ message, metadata }),
      },
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 2 }],
    });
    expect(enqueuePublishFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 2 }],
    }));
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        reason: "A media file is missing or is not ready to publish.",
      },
    });
    expect(
      (
        await db
          .collection("cmsPages/contact/mediaUsage")
          .doc("published")
          .get()
      ).exists,
    ).toBe(false);
    expect(errors).toEqual([
      expect.objectContaining({
        message: "scheduled publish moved a blocked document to failure",
        metadata: expect.objectContaining({
          collection: "cmsPages",
          documentId: "contact",
          detail: expect.stringMatching(/public deployment coordination/i),
        }),
      }),
    ]);
  });

  it("measures version history at the auto-generated document path it writes", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Scheduled contact",
      description: "The scheduled revision.",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      version: 3,
    });
    const measuredHistoryPaths = [];
    const documentSizeErrorFn = vi.fn((_document, path, context) => {
      if (context?.label?.includes("version-history")) {
        measuredHistoryPaths.push(path);
      }
      return null;
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      documentSizeErrorFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({ publishedCount: 1 });

    const [history] = (await db.collection("cmsVersionHistory").get()).docs;
    expect(measuredHistoryPaths).toEqual([history.ref.path]);
  });

  it("does not preflight or enqueue when nothing is due", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Later",
      status: "scheduled",
      publishAt: "2026-07-16T12:00:00.000Z",
      blocks: [],
      version: 1,
    });
    const assertPublishReadyFn = vi.fn();
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn,
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(assertPublishReadyFn).not.toHaveBeenCalled();
    expect(enqueuePublishFn).not.toHaveBeenCalled();
  });

  it("runs the global published-media preflight before freezing due content", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Keep scheduled",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      version: 2,
    });
    const assertPublishedMediaSafeFn = vi
      .fn()
      .mockRejectedValue(new Error("Legacy public media is blocked"));
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(async () => ({ token: "configured" })),
      assertPublishedMediaSafeFn,
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).rejects.toThrow("Legacy public media is blocked");

    expect(assertPublishedMediaSafeFn).toHaveBeenCalledExactlyOnceWith({
      firestore: db,
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toMatchObject({ status: "scheduled", version: 2 });
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  // A run stamps when each post actually published, so a slow run has to read the
  // clock again for every candidate. Reusing the instant the run started with dates
  // a post published at 12:05 a.m. to the day before, which is a day the newsroom
  // never published on and the wrong day on the page (#1041).
  it("stamps each candidate with the instant its own publish completed", async () => {
    const rows = [
      ["before-midnight", "2026-07-15T12:00:00.000Z"],
      ["after-midnight", "2026-07-15T12:00:00.000Z"],
    ];
    await Promise.all(
      rows.map(([id, publishAt]) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: id,
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt,
          blocks: [],
          version: 1,
        }),
      ),
    );
    // 11:59 p.m. EDT on Aug. 13 at the run's entry, then a candidate a minute either
    // side of station midnight. Every later call keeps the last instant, so the run's
    // own bookkeeping stays put.
    const instants = [
      "2026-08-14T03:59:00.000Z",
      "2026-08-14T03:59:30.000Z",
      "2026-08-14T04:00:30.000Z",
    ];
    let call = 0;
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => instants[Math.min(call++, instants.length - 1)],
    });

    await expect(run()).resolves.toMatchObject({ publishedCount: 2 });
    const published = await Promise.all(
      rows.map(async ([id]) => (await db.collection("cmsPosts").doc(id).get()).data()),
    );
    const stamps = published.map((post) => post.firstPublishedAt).sort();
    expect(stamps).toEqual([instants[1], instants[2]]);
    expect(stamps).not.toContain(instants[0]);
    // The two land on different station days, which is the whole point of reading the
    // clock per candidate.
    expect(published.map((post) => post.date).sort()).toEqual([
      "2026-08-13",
      "2026-08-14",
    ]);
    for (const post of published) {
      expect(post.updatedAt).toBe(post.firstPublishedAt);
      expect(post.published.publishedAt).toBe(post.firstPublishedAt);
    }
  });

  it("freezes a due post's routing and discovery metadata with its blocks", async () => {
    await seedMediaAsset("station-update-lead");
    await db.collection("cmsPosts").doc("station-update").set({
      id: "station-update",
      type: "post",
      title: "Station update",
      date: "2026-07-15",
      tags: ["station", "programming"],
      summary: "What viewers need to know.",
      slug: "station-update",
      previousSlugs: ["old-update"],
      locale: "en",
      seo: { title: "NJ PBS station update" },
      heroImage: "station-update-lead",
      heroImageAlt: "A reporter in the NJ PBS newsroom.",
      heroImageDecorative: false,
      status: "scheduled",
      publishAt: "2026-07-15T11:30:00.000Z",
      blocks: [divider("post-divider")],
      version: 6,
    });
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "post-queue" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "post-queue",
    });
    const post = (
      await db.collection("cmsPosts").doc("station-update").get()
    ).data();
    expect(post.published).toMatchObject({
      metadata: {
        type: "post",
        title: "Station update",
        date: "2026-07-15",
        tags: ["station", "programming"],
        summary: "What viewers need to know.",
        slug: "station-update",
        previousSlugs: ["old-update"],
        locale: "en",
        seo: { title: "NJ PBS station update" },
        heroImage: "station-update-lead",
        heroImageAlt: "A reporter in the NJ PBS newsroom.",
        heroImageDecorative: false,
      },
      sourceVersion: 7,
    });
    expect(post.published.blocks).toEqual(post.blocks);
    expect(post.publishBuildPending).toBe(true);
    expect(post.publishBuildQueueId).toEqual(expect.any(String));
    expect(
      (
        await db
          .collection("cmsPosts/station-update/mediaUsage")
          .doc("published")
          .get()
      ).data(),
    ).toMatchObject({
      assetIds: ["station-update-lead"],
      occurrenceCount: 1,
      sourceVersion: 7,
    });
  });

  it("does not publish a lead image that is described and marked decorative", async () => {
    await Promise.all([
      seedMediaAsset("legacy-lead"),
      db.collection("cmsPosts").doc("legacy-post").set({
        id: "legacy-post",
        type: "post",
        title: "Legacy post",
        date: "2026-07-15",
        tags: [],
        heroImage: "legacy-lead",
        heroImageAlt: "A reporter in the NJ PBS newsroom.",
        heroImageDecorative: true,
        slug: "legacy-post",
        previousSlugs: [],
        locale: "en",
        status: "scheduled",
        publishAt: "2026-07-15T10:00:00.000Z",
        blocks: [],
        version: 1,
      }),
      db.collection("cmsPages").doc("home").set({
        id: "home",
        title: "Valid home",
        template: "home",
        status: "scheduled",
        publishAt: "2026-07-15T10:30:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const errors = [];
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
      log: {
        info: () => {},
        warn: () => {},
        error: (message, metadata) => errors.push({ message, metadata }),
      },
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 2 }],
    });
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("legacy-post").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "Some required content is missing or incorrect.",
      },
    });
    expect(errors).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          documentId: "legacy-post",
          detail: "heroImageAlt must be empty when heroImageDecorative is true",
        }),
      }),
    ]);
  });

  it("normalizes a legacy post instant before scheduled publish snapshots it", async () => {
    await db.collection("cmsPosts").doc("legacy-station-update").set({
      id: "legacy-station-update",
      type: "post",
      title: "Legacy station update",
      date: "2026-07-24 23:30:00-04:00",
      tags: ["station"],
      slug: "legacy-station-update",
      previousSlugs: [],
      locale: "en",
      status: "scheduled",
      publishAt: "2026-07-15T11:30:00.000Z",
      blocks: [],
      version: 2,
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "legacy-post-queue" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "legacy-post-queue",
    });
    const post = (
      await db.collection("cmsPosts").doc("legacy-station-update").get()
    ).data();
    expect(post.date).toBe("2026-07-24");
    expect(post.published.metadata.date).toBe("2026-07-24");
    const history = (await db.collection("cmsVersionHistory").get()).docs[0].data();
    expect(history.before.date).toBe("2026-07-24 23:30:00-04:00");
    expect(history.after.date).toBe("2026-07-24");
  });

  it("retries an already-frozen snapshot when enqueue fails", async () => {
    await seedMediaAsset("retry-image");
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Retry me",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [image("retry-image-block", "retry-image")],
      version: 2,
    });
    const enqueuePublishFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce({ queueId: "retry-queue" });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(async () => ({ token: "configured" })),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).rejects.toThrow(/GitHub unavailable/);
    const frozen = (
      await db.collection("cmsPages").doc("contact").get()
    ).data();
    expect(frozen).toMatchObject({
      status: "published",
      publishBuildPending: true,
      version: 3,
      published: { sourceVersion: 3 },
    });
    await db
      .collection("cmsPages/contact/mediaUsage")
      .doc("published")
      .delete();

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: "retry-queue",
      changes: [
        { collection: "cmsPages", id: "contact", sourceVersion: 3 },
      ],
    });
    const retried = (
      await db.collection("cmsPages").doc("contact").get()
    ).data();
    expect(retried).toMatchObject({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: expect.any(String),
      version: 3,
      published: { sourceVersion: 3 },
    });
    expect(enqueuePublishFn).toHaveBeenCalledTimes(2);
    expect(
      (
        await db
          .collection("cmsPages/contact/mediaUsage")
          .doc("published")
          .get()
      ).data(),
    ).toEqual({
      state: "published",
      sourceVersion: 3,
      assetIds: ["retry-image"],
      occurrenceCount: 1,
    });
    expect((await db.collection("cmsVersionHistory").get()).docs).toHaveLength(
      1,
    );
    expect((await db.collection("admin_logs").get()).docs).toHaveLength(1);
  });

  it.each([
    ["private asset", "media_assets", /not available/i],
    ["public projection", "media_assets_public", /not ready/i],
  ])(
    "blocks an already-frozen retry when its %s was removed",
    async (_label, removedCollection, expectedDetail) => {
      await seedMediaAsset("blocked-retry-image");
      await db.collection("cmsPages").doc("contact").set({
        id: "contact",
        title: "Blocked retry",
        template: "genericPage",
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: null,
        published: {
          blocks: [image("retry-image-block", "blocked-retry-image")],
          metadata: { title: "Blocked retry" },
          publishedAt: NOW,
          publishedBy: "system:scheduler",
          sourceVersion: 3,
        },
        blocks: [image("retry-image-block", "blocked-retry-image")],
        version: 3,
      });
      await db
        .collection(removedCollection)
        .doc("blocked-retry-image")
        .delete();
      const errors = [];
      const enqueuePublishFn = vi.fn(async () => ({ queueId: "unsafe-queue" }));
      const run = createScheduledPublishRunner({
        firestore: db,
        assertPublishReadyFn: vi.fn(async () => ({ token: "configured" })),
        reconcileStaleFn: vi.fn(),
        enqueuePublishFn,
        now: () => NOW,
        log: {
          info: () => {},
          warn: () => {},
          error: (message, metadata) => errors.push({ message, metadata }),
        },
      });

      await expect(run()).resolves.toEqual({
        publishedCount: 0,
        queueId: null,
        changes: [],
      });
      expect(enqueuePublishFn).not.toHaveBeenCalled();
      expect(errors).toEqual([
        {
          message: "scheduled publish skipped a blocked document",
          metadata: {
            collection: "cmsPages",
            documentId: "contact",
            detail: expect.stringMatching(expectedDetail),
          },
        },
      ]);
      expect((await db.collection("cmsPages").doc("contact").get()).data())
        .toMatchObject({
          status: "published",
          publishBuildPending: true,
          publishBuildQueueId: null,
          version: 3,
          published: { sourceVersion: 3 },
        });
      expect(
        (
          await db
            .collection("cmsPages/contact/mediaUsage")
            .doc("published")
            .get()
        ).exists,
      ).toBe(false);
    },
  );

  it("blocks a frozen build retry that references uploaded media", async () => {
    await seedMediaAsset("uploaded-retry-image", { source: "upload" });
    const before = {
      id: "contact",
      title: "Blocked retry",
      template: "genericPage",
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: {
        blocks: [image("retry-image-block", "uploaded-retry-image")],
        metadata: { title: "Blocked retry" },
        publishedAt: NOW,
        publishedBy: "system:scheduler",
        sourceVersion: 3,
      },
      blocks: [image("retry-image-block", "uploaded-retry-image")],
      version: 3,
    };
    await db.collection("cmsPages").doc("contact").set(before);
    const errors = [];
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "unsafe-queue" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(async () => ({ token: "configured" })),
      reconcileStaleFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
      log: {
        info: () => {},
        warn: () => {},
        error: (message, metadata) => errors.push({ message, metadata }),
      },
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toEqual(before);
    expect(errors).toEqual([
      {
        message: "scheduled publish skipped a blocked document",
        metadata: {
          collection: "cmsPages",
          documentId: "contact",
          detail: expect.stringMatching(/public deployment coordination/i),
        },
      },
    ]);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("blocks a frozen post retry when its published image is described and marked decorative", async () => {
    await Promise.all([
      seedMediaAsset("legacy-retry-lead"),
      db.collection("cmsPosts").doc("legacy-retry").set({
        id: "legacy-retry",
        type: "post",
        title: "Legacy frozen post",
        date: "2026-07-15",
        tags: [],
        heroImage: "legacy-retry-lead",
        slug: "legacy-retry",
        previousSlugs: [],
        locale: "en",
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: null,
        blocks: [],
        version: 3,
        published: {
          blocks: [],
          metadata: {
            type: "post",
            title: "Legacy frozen post",
            date: "2026-07-15",
            tags: [],
            heroImage: "legacy-retry-lead",
            heroImageAlt: "A reporter in the NJ PBS newsroom.",
            heroImageDecorative: true,
            slug: "legacy-retry",
            previousSlugs: [],
            locale: "en",
          },
          publishedAt: NOW,
          publishedBy: "system:scheduler",
          sourceVersion: 3,
        },
      }),
    ]);
    const errors = [];
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "unsafe-queue" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(async () => ({ token: "configured" })),
      reconcileStaleFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
      log: {
        info: () => {},
        warn: () => {},
        error: (message, metadata) => errors.push({ message, metadata }),
      },
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    expect(errors).toEqual([
      {
        message: "scheduled publish skipped a blocked document",
        metadata: {
          collection: "cmsPosts",
          documentId: "legacy-retry",
          detail: "heroImageAlt must be empty when heroImageDecorative is true",
        },
      },
    ]);
    expect((await db.collection("cmsPosts").doc("legacy-retry").get()).data())
      .toMatchObject({
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: null,
        version: 3,
        published: { sourceVersion: 3 },
      });
  });

  it("does not retry a snapshot already claimed by an in-flight build", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Already queued",
      template: "genericPage",
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: "queue-in-flight",
      published: {
        blocks: [divider()],
        metadata: { title: "Already queued" },
        publishedAt: NOW,
        publishedBy: "editor-1",
        sourceVersion: 3,
      },
      blocks: [divider()],
      version: 3,
    });
    const assertPublishReadyFn = vi.fn();
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn,
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(assertPublishReadyFn).not.toHaveBeenCalled();
    expect(enqueuePublishFn).not.toHaveBeenCalled();
  });

  it("claims a due revision before runtime settlement can clear it", async () => {
    const contactRef = db.collection("cmsPages").doc("contact");
    await contactRef.set({
      id: "contact",
      title: "Scheduled contact",
      description: "The scheduled revision.",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      version: 3,
    });

    let continueEnqueue;
    let enqueueStarted;
    const started = new Promise((resolve) => {
      enqueueStarted = resolve;
    });
    const enqueuePublishFn = vi.fn(({ queueId }) => {
      enqueueStarted(queueId);
      return new Promise((resolve) => {
        continueEnqueue = () => resolve({ queueId });
      });
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    const runPromise = run();
    const queueId = await started;
    const settlement = await settleRuntimePublication({
      firestore: db,
      actor: { uid: "editor-1", email: "editor@example.com" },
      change: { collection: "cmsPages", id: "contact", sourceVersion: 4 },
      surface: { label: "Contact" },
    });

    expect(settlement).toEqual({ status: "claimed", queueId });
    expect((await contactRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: queueId,
      published: { sourceVersion: 4 },
    });
    expect(
      (await db.collection("cmsPublishQueue").doc(queueId).get()).data(),
    ).toMatchObject({
      status: "reserved",
      changes: [
        { collection: "cmsPages", id: "contact", sourceVersion: 4 },
      ],
    });
    expect(
      (await db.collection("cmsPublishQueue")
        .where("status", "==", "pending")
        .where("transport", "==", "serializer")
        .get()).size,
    ).toBe(0);
    continueEnqueue();
    await expect(runPromise).resolves.toMatchObject({ queueId });
  });

  it("does not freeze a due snapshot while admission is paused", async () => {
    const contactRef = db.collection("cmsPages").doc("contact");
    const before = {
      id: "contact",
      title: "Scheduled contact",
      description: "The scheduled revision.",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      version: 3,
    };
    await Promise.all([
      contactRef.set(before),
      db.collection("system").doc("cmsPublicationRuntime").set({
        schemaVersion: 1,
        phase: "paused",
        commitSha: "a".repeat(40),
        serializerId: "cloud-publication-primary",
      }),
    ]);
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(async () => ({ transport: "serializer" })),
      assertPublishedMediaSafeFn: vi.fn(async () => {}),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).rejects.toThrow(/paused for a serializer handoff/i);
    expect((await contactRef.get()).data()).toEqual(before);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect(enqueuePublishFn).not.toHaveBeenCalled();
  });

  it("moves an invalid document to visible failure and still publishes another due document", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("contact").set({
        id: "contact",
        title: "Valid",
        template: "genericPage",
        status: "scheduled",
        publishAt: "2026-07-15T10:00:00.000Z",
        blocks: [],
        version: 1,
      }),
      db.collection("cmsPosts").doc("broken").set({
        id: "broken",
        type: "post",
        status: "scheduled",
        publishAt: "2026-07-15T10:30:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "queue-1" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 2 }],
    });
    expect(enqueuePublishFn).toHaveBeenCalledOnce();
    expect(
      (await db.collection("cmsPages").doc("contact").get()).data().status,
    ).toBe("published");
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("broken").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "Some required content is missing or incorrect.",
      },
    });
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(2);
    expect(
      (await db.collection("cmsVersionHistory").where("action", "==", "schedule-publish-failed").get())
        .docs.map((entry) => entry.data()),
    ).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ status: "scheduled", publishAt: "2026-07-15T10:30:00.000Z" }),
        after: expect.objectContaining({ status: "draft", publishAt: null, version: 2 }),
        restorable: false,
      }),
    ]);
    expect(
      (await db.collection("admin_logs").get()).docs.map((entry) => entry.data()),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "cms.schedule-publish-failed",
          target: "cmsPosts/broken",
          after: expect.objectContaining({
            status: "draft",
            publishAt: null,
            version: 2,
            reason: "Some required content is missing or incorrect.",
            detail: "title is required",
          }),
        }),
      ]),
    );
  });

  it("records a visible failure for an incomplete scheduled Interactive/Data Lab Post", async () => {
    await db.collection("cmsPosts").doc("interactive-post").set({
      id: "interactive-post",
      type: "post",
      title: "Interactive report",
      tags: ["format:interactive"],
      slug: "interactive-report",
      previousSlugs: [],
      locale: "en",
      status: "scheduled",
      publishAt: "2026-07-15T10:30:00.000Z",
      blocks: [],
      version: 1,
    });
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("interactive-post").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "Some required content is missing or incorrect.",
      },
    });
    expect(
      (await db.collection("admin_logs").get()).docs.map((entry) => entry.data()),
    ).toEqual([
      expect.objectContaining({
        action: "cms.schedule-publish-failed",
        target: "cmsPosts/interactive-post",
        after: expect.objectContaining({
          reason: "Some required content is missing or incorrect.",
          detail:
            "An Interactive/Data Lab Post must include at least one complete data figure or table, custom HTML block, or approved media or interactive link.",
        }),
      }),
    ]);
  });

  it("records a visible failure when a page violates its editor template", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Off-brand contact",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      // card_grid is a valid ADR 0013 block, but the generic-page template
      // deliberately excludes it. Parsing alone must not promote this row.
      blocks: [
        {
          id: "cards",
          type: "card_grid",
          order: 0,
          visible: true,
          data: { cards: [] },
        },
      ],
      version: 1,
    });
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "Some required content is missing or incorrect.",
      },
    });
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("refuses a scheduled page the publish snapshot would push over the size limit", async () => {
    // The unattended half of #531. The stored draft is inside the limit; the
    // snapshot this runner composes is what doubles it. Left unguarded the write
    // fails with Firestore's opaque INVALID_ARGUMENT in a scheduler log, on
    // content whose author was told days ago it would go live.
    const fat = "x".repeat(40000);
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Very long contact page",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      blocks: Array.from({ length: 13 }, (_unused, index) => ({
        id: `block-${index}`,
        type: "prose",
        order: index,
        visible: true,
        data: {
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: fat }] },
            ],
          },
        },
      })),
      version: 1,
    });
    // A second, ordinary page due in the same tick. The oversized one must move
    // to visible failure without taking down the valid publication.
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      title: "Ordinary home",
      template: "home",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      blocks: [divider()],
      version: 4,
    });
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "queue-1" }));
    const errors = [];
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: (_m, meta) => errors.push(meta) },
    });

    await expect(run()).resolves.toMatchObject({ publishedCount: 1 });

    // The oversized page returns to draft and leaves the due query.
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "This content is too large to publish.",
      },
    });
    // The ordinary one published in the same tick.
    expect(
      (await db.collection("cmsPages").doc("home").get()).data(),
    ).toMatchObject({ status: "published", publiclyVisible: true, version: 5 });
    // The failure is logged and names the document.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ collection: "cmsPages", documentId: "contact" });
    expect(errors[0].detail).toMatch(/over the/);
  });

  it("scans past a full window of oversized rows to publish later due content", async () => {
    const blocked = Array.from(
      { length: MAX_SCHEDULED_CHANGES_PER_RUN },
      (_unused, index) => `blocked-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      [...blocked, "z-valid"].map((id) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: id,
          date: "2026-07-15",
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt: "2026-07-15T10:00:00.000Z",
          blocks: [],
          version: 1,
        }),
      ),
    );
    const documentSizeErrorFn = vi.fn((_document, path) =>
      path.includes("blocked-")
        ? { reason: "too large", detail: `${path} is oversized` }
        : null,
    );
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      documentSizeErrorFn,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPosts", id: "z-valid", sourceVersion: 2 }],
    });
    expect(
      (await db.collection("cmsPosts").doc("z-valid").get()).data(),
    ).toMatchObject({ status: "published", publiclyVisible: true, version: 2 });
    expect(
      await db.collection("cmsPosts").where("status", "==", "scheduled").get(),
    ).toMatchObject({ size: 0 });
    expect(
      await db.collection("cmsPosts").where("status", "==", "draft").get(),
    ).toMatchObject({ size: MAX_SCHEDULED_CHANGES_PER_RUN });
  });

  it("moves a blocked read window to audited failure so later due content publishes next tick", async () => {
    const blocked = Array.from(
      { length: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN },
      (_unused, index) => `blocked-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      [...blocked, "z-valid"].map((id) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: id,
          date: "2026-07-15",
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          publishAt: "2026-07-15T10:00:00.000Z",
          blocks: [],
          version: 1,
        }),
      ),
    );
    const documentSizeErrorFn = vi.fn((_document, path) =>
      path.includes("blocked-")
        ? { reason: "too large", detail: `${path} is oversized` }
        : null,
    );
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      documentSizeErrorFn,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(documentSizeErrorFn).toHaveBeenCalledTimes(
      MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
    );
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("blocked-000").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "This content is too large to publish.",
      },
    });
    expect(
      await db
        .collection("cmsPosts")
        .where("status", "==", "scheduled")
        .get(),
    ).toMatchObject({ size: 1 });
    expect(await db.collection("cmsVersionHistory").get()).toMatchObject({
      size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
    });
    expect(await db.collection("admin_logs").get()).toMatchObject({
      size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
    });

    enqueuePublishFn.mockResolvedValue({ queueId: "queue-2" });
    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-2",
      changes: [{ collection: "cmsPosts", id: "z-valid", sourceVersion: 2 }],
    });
    expect(
      (await db.collection("cmsPosts").doc("z-valid").get()).data(),
    ).toMatchObject({ status: "published", publiclyVisible: true, version: 2 });
  });

  it("dispositions a full malformed publishAt window before a later due record", async () => {
    const malformed = Array.from(
      { length: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN },
      (_unused, index) => `malformed-${String(index).padStart(3, "0")}`,
    );
    await Promise.all([
      ...malformed.map((id) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "post",
          title: id,
          date: "2026-07-15",
          tags: [],
          slug: id,
          previousSlugs: [],
          locale: "en",
          status: "scheduled",
          // Firestore selects this string as due, but the scheduler contract
          // rejects the offset form because it is not canonical UTC.
          publishAt: "2026-07-15T10:00:00.000+00:00",
          blocks: [],
          version: 1,
        }),
      ),
      db.collection("cmsPosts").doc("z-valid").set({
        id: "z-valid",
        type: "post",
        title: "Valid after malformed window",
        date: "2026-07-15",
        tags: [],
        slug: "z-valid",
        previousSlugs: [],
        locale: "en",
        status: "scheduled",
        publishAt: "2026-07-15T11:00:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const enqueuePublishFn = vi.fn();
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    expect(
      await db.collection("cmsPosts").where("status", "==", "draft").get(),
    ).toMatchObject({ size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN });
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("malformed-000").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "Some required content is missing or incorrect.",
      },
    });
    const failureHistory = await db.collection("cmsVersionHistory").get();
    expect(failureHistory).toMatchObject({
      size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN,
    });
    expect(
      failureHistory.docs.every((document) => document.data().restorable === false),
    ).toBe(true);

    enqueuePublishFn.mockResolvedValue({ queueId: "queue-2" });
    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-2",
      changes: [{ collection: "cmsPosts", id: "z-valid", sourceVersion: 2 }],
    });
    expect(
      (await db.collection("cmsPosts").doc("z-valid").get()).data(),
    ).toMatchObject({ status: "published", publiclyVisible: true, version: 2 });
  }, 20_000);

  it("does not let Timestamp schedules occupy the string due-query window", async () => {
    const legacyTimestamp = admin.firestore.Timestamp.fromDate(
      new Date("2026-07-15T10:00:00.000Z"),
    );
    await Promise.all([
      ...Array.from(
        { length: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN },
        (_unused, index) => {
          const id = `legacy-timestamp-${String(index).padStart(3, "0")}`;
          return db.collection("cmsPosts").doc(id).set({
            id,
            type: "post",
            title: id,
            date: "2026-07-15",
            tags: [],
            slug: id,
            previousSlugs: [],
            locale: "en",
            status: "scheduled",
            publishAt: legacyTimestamp,
            blocks: [],
            version: 1,
          });
        },
      ),
      db.collection("cmsPosts").doc("z-valid").set({
        id: "z-valid",
        type: "post",
        title: "Valid string schedule",
        date: "2026-07-15",
        tags: [],
        slug: "z-valid",
        previousSlugs: [],
        locale: "en",
        status: "scheduled",
        publishAt: "2026-07-15T11:00:00.000Z",
        blocks: [],
        version: 1,
      }),
    ]);
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "queue-1" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPosts", id: "z-valid", sourceVersion: 2 }],
    });
    expect(
      await db.collection("cmsPosts").where("status", "==", "scheduled").get(),
    ).toMatchObject({ size: MAX_SCHEDULED_CANDIDATE_READS_PER_RUN });
  });

  it("infers and backfills the registry template for a legacy scheduled page", async () => {
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      title: "Legacy scheduled home",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      blocks: [divider()],
      version: 4,
      // Older home documents predate the separate stored template field.
    });
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn: vi.fn(async () => ({ queueId: "legacy-queue" })),
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "legacy-queue",
    });
    expect(
      (await db.collection("cmsPages").doc("home").get()).data(),
    ).toMatchObject({
      template: "home",
      status: "published",
      version: 5,
      published: { sourceVersion: 5 },
    });
  });

  it("publishes a due scheduled program into its /programs/ snapshot", async () => {
    // Program is the first non-post record kind the scheduler can complete
    // (#923). It has no block layout, so the runner must neither refuse it for a
    // missing blocks array nor invent one on the stored document.
    await db.collection("cmsPosts").doc("due-process").set({
      id: "due-process",
      type: "program",
      title: "Due Process",
      genre: "public affairs",
      description: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Law and policy in New Jersey." }],
          },
        ],
      },
      slug: "due-process",
      previousSlugs: [],
      locale: "en",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      version: 2,
    });
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "queue-1" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPosts", id: "due-process", sourceVersion: 3 }],
    });
    const stored = (await db.collection("cmsPosts").doc("due-process").get()).data();
    expect(stored).toMatchObject({
      status: "published",
      publiclyVisible: true,
      version: 3,
      published: {
        blocks: [],
        sourceVersion: 3,
        metadata: { type: "program", title: "Due Process", slug: "due-process" },
      },
    });
    expect(stored.blocks).toBeUndefined();
    expect(stored.scheduledPublishFailure).toBeUndefined();
  });

  it("moves a scheduled library-only record to failure without aborting the batch", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Valid page",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T11:00:00.000Z",
      blocks: [divider()],
      version: 1,
    });
    // cmsPosts also stores kinds with no public route (staff and sponsors).
    // A legacy scheduled row of one must leave the due query with a
    // visible reason, and the due page must still publish.
    await db.collection("cmsPosts").doc("open-house").set({
      id: "open-house",
      type: "sponsor",
      name: "NJ Foundation",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      blocks: [divider("event-divider")],
      version: 2,
    });
    const enqueuePublishFn = vi.fn(async () => ({ queueId: "queue-1" }));
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toMatchObject({
      publishedCount: 1,
      queueId: "queue-1",
      changes: [{ collection: "cmsPages", id: "contact", sourceVersion: 2 }],
    });
    expect(enqueuePublishFn).toHaveBeenCalledOnce();
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPosts").doc("open-house").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 3,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "This content type cannot be published on a schedule.",
      },
    });
    expect(
      (await db.collection("admin_logs").where("action", "==", "cms.schedule-publish-failed").get())
        .docs[0]
        .data().after,
    ).toMatchObject({
      reason: "This content type cannot be published on a schedule.",
      detail: "Unsupported scheduled record type sponsor in cmsPosts",
    });
  });

  it("keeps the empty-tick fallback until the dedicated scheduler is enabled", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Later",
      status: "scheduled",
      publishAt: "2026-07-16T12:00:00.000Z",
      blocks: [],
      version: 1,
    });
    const assertPublishReadyFn = vi.fn();
    const enqueuePublishFn = vi.fn();
    const reconcileStaleFn = vi.fn(async () => 0);
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn,
      enqueuePublishFn,
      reconcileStaleFn,
      now: () => NOW,
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(reconcileStaleFn).toHaveBeenCalledOnce();
    expect(reconcileStaleFn).toHaveBeenCalledWith({ firestore: db });
    expect(assertPublishReadyFn).not.toHaveBeenCalled();
    expect(enqueuePublishFn).not.toHaveBeenCalled();
  });

  it("keeps reconciling when the only due page moves to failure", async () => {
    // A rejected page must not prevent stale build reconciliation during the
    // same tick that records its visible failure.
    const fat = "x".repeat(40000);
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Very long contact page",
      template: "genericPage",
      status: "scheduled",
      publishAt: "2026-07-15T10:00:00.000Z",
      blocks: Array.from({ length: 13 }, (_unused, index) => ({
        id: `block-${index}`,
        type: "prose",
        order: index,
        visible: true,
        data: {
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: fat }] },
            ],
          },
        },
      })),
      version: 1,
    });
    const enqueuePublishFn = vi.fn();
    const reconcileStaleFn = vi.fn(async () => 0);
    const run = createScheduledPublishRunner({
      firestore: db,
      assertPublishReadyFn: vi.fn(),
      enqueuePublishFn,
      reconcileStaleFn,
      now: () => NOW,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(run()).resolves.toEqual({
      publishedCount: 0,
      queueId: null,
      changes: [],
    });
    expect(reconcileStaleFn).toHaveBeenCalledOnce();
    expect(enqueuePublishFn).not.toHaveBeenCalled();
    // #2761: scheduling is not approval; blockers return to draft and clear the time.
    const failedDocument = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(failedDocument).not.toHaveProperty("publishAt");
    expect(failedDocument).toMatchObject({
      status: "draft",
      version: 2,
      scheduledPublishFailure: {
        failedAt: NOW,
        failedBy: SCHEDULER_ACTOR,
        reason: "This content is too large to publish.",
      },
    });
  });
});

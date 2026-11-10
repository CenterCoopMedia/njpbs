import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { readFileSync } from "node:fs";
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
import restoreRevision from "../../functions/restore-revision.js";
import save from "../../functions/save.js";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { planSupportPageComposition } from "../../packages/content-core/src/support-page-composition";

const legacySupport = JSON.parse(readFileSync(new URL(
  "../fixtures/support-page-before.json", import.meta.url,
), "utf8"));
const composedSupport = JSON.parse(readFileSync(new URL(
  "../fixtures/support-page-after.json", import.meta.url,
), "utf8"));

const {
  cmsRestoreRevision,
  createCmsRestoreRevisionHandler,
} = restoreRevision;
const { createCmsSaveHandler } = save;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

function makeReq({ method = "POST", body = {} } = {}) {
  return {
    method,
    body,
    headers: { "x-forwarded-for": "203.0.113.21" },
    ip: "203.0.113.21",
  };
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

const editor = () => ({
  uid: "editor-1",
  email: "editor@example.com",
  principal: { id: "editor-1", grants: [{ role: "editor" }] },
});

const divider = (id, order) => ({
  id,
  type: "divider",
  order,
  visible: true,
  data: {},
});

const image = (id, assetId, { visible = true } = {}) => ({
  id,
  type: "image",
  order: 0,
  visible,
  data: { assetId, alt: "Historical image" },
});

const richTextDoc = (text) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function currentPage(overrides = {}) {
  return {
    id: "home",
    template: "home",
    title: "Current working title",
    description: "Current description",
    seo: { title: "Current SEO title" },
    social: { title: "Current social title" },
    blocks: [divider("current-block", 0)],
    status: "draft",
    slug: "current-route",
    assignee: "producer-1",
    approvalState: "approved",
    published: { title: "Currently live title", blocks: [] },
    createdAt: "2026-07-01T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-12T14:00:00.000Z",
    updatedBy: "editor-before",
    version: 8,
    ...overrides,
  };
}

function historicalPage(overrides = {}) {
  return {
    id: "forged-id",
    template: "genericPage",
    title: "Historical working title",
    seo: { title: "Historical SEO title" },
    social: { title: "Historical social title" },
    blocks: [divider("old-second", 1), divider("old-first", 0)],
    status: "draft",
    publishAt: "2026-07-10T12:00:00.000Z",
    slug: "historical-route",
    assignee: "historical-producer",
    approvalState: "changes_requested",
    published: { title: "Historical live title", blocks: [] },
    createdAt: "2026-06-01T12:00:00.000Z",
    createdBy: "another-user",
    updatedAt: "2026-07-10T12:00:00.000Z",
    updatedBy: "another-user",
    version: 3,
    ...overrides,
  };
}

async function rows(db, collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function seedTarget(db, { id = "home", current = currentPage(), after = historicalPage() } = {}) {
  await Promise.all([
    db.collection("cmsPages").doc(id).set(current),
    db.collection("cmsVersionHistory").doc("source-revision").set({
      collection: "cmsPages",
      documentId: id,
      action: "update",
      userId: "editor-before",
      userEmail: "editor-before@example.com",
      at: "2026-07-10T12:00:00.000Z",
      before: { ...after, title: "Earlier title", version: 2 },
      after,
    }),
  ]);
  if (id === "support") {
    await Promise.all(["launch-give", "launch-passport", "launch-contact"].map(assetId => seedMediaAsset(db, assetId)));
  }
}

async function seedMediaAsset(db, assetId, { lifecycle = "active" } = {}) {
  const record = {
    lifecycle,
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

async function restore(db, body = {}, deps = {}) {
  const handler = createCmsRestoreRevisionHandler({
    firestore: db,
    requirePrincipalFn: editor,
    now: () => "2026-08-12T20:00:00.000Z",
    ...deps,
  });
  const res = makeRes();
  await handler(makeReq({
    body: {
      collection: "cmsPages",
      id: "home",
      revisionId: "source-revision",
      baseVersion: 8,
      ...body,
    },
  }), res);
  return res;
}

function sequentialMinter(prefix = "home") {
  let index = 0;
  return () => `${prefix}-${index++}`;
}

async function convertHome(db, body = {}, deps = {}) {
  const handler = createCmsSaveHandler({
    firestore: db,
    requirePrincipalFn: editor,
    mintId: sequentialMinter(),
    now: () => "2026-08-12T18:00:00.000Z",
    ...deps,
  });
  const request = {
    collection: "cmsPages",
    id: "home",
    baseVersion: 4,
    convertHome: "stable-request-nonce",
    document: { blocks: homeCompositionDefaults() },
    ...body,
  };
  const res = makeRes();
  await handler(makeReq({ body: request }), res);
  return res;
}

describe("cmsRestoreRevision", () => {
  let db;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("restore-revision.test.js");
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

  it("is publicly invokable so application authentication can return an honest 401", () => {
    expect(cmsRestoreRevision.__endpoint.httpsTrigger.invoker).toEqual(["public"]);
  });

  it.each([
    { currentFlag: true, historicalFlag: undefined },
    { currentFlag: true, historicalFlag: false },
    { currentFlag: false, historicalFlag: true },
    { currentFlag: undefined, historicalFlag: true },
  ])("preserves current childDirected=$currentFlag when restoring childDirected=$historicalFlag", async ({ currentFlag, historicalFlag }) => {
    const current = currentPage(currentFlag === undefined ? {} : { childDirected: currentFlag });
    const after = historicalPage(historicalFlag === undefined ? {} : { childDirected: historicalFlag });
    await seedTarget(db, { current, after });

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).toMatchObject({ title: after.title, version: 9 });
    expect(stored.published).toEqual(current.published);
    const history = await rows(db, "cmsVersionHistory");
    const restored = history.find(row => row.action === "restore");
    expect(restored.after).toEqual(stored);
    expect(history.find(row => row.id === "source-revision").after).toEqual(after);
    for (const document of [res.body.document, stored, restored.after]) {
      if (currentFlag === undefined) expect(document).not.toHaveProperty("childDirected");
      else expect(document.childDirected).toBe(currentFlag);
    }
  });

  it("restores a legacy Home revision without changing the current published snapshot", async () => {
    const published = {
      metadata: { title: "Currently live title", homeCompositionVersion: 1 },
      blocks: homeCompositionDefaults(),
      publishedAt: "2026-08-11T20:00:00.000Z",
      publishedBy: "publisher-1",
    };
    await seedTarget(db, {
      current: currentPage({
        homeCompositionVersion: 1,
        blocks: homeCompositionDefaults(),
        published,
      }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).not.toHaveProperty("homeCompositionVersion");
    expect(stored.blocks).toEqual([
      divider("old-second", 0),
      divider("old-first", 1),
    ]);
    expect(stored.published).toEqual(published);
  });

  it.each(["named slots", "inserted defaults"])("refuses a pre-migration support revision with %s without changing content or receipts", async source => {
    const after = { ...legacySupport, version: 3 };
    if (source === "inserted defaults") after.blocks = after.blocks.filter(block => block.id === "fixture-daf");
    const current = {
      ...legacySupport, status: "draft", version: 8, serviceCompositionVersion: 1,
      blocks: planSupportPageComposition(after).blocks,
    };
    await seedTarget(db, { id: "support", current, after });
    const usageRef = db.collection("cmsPages").doc("support").collection("mediaUsage").doc("working");
    const usage = { state: "working", sourceVersion: 8, assetIds: [], occurrenceCount: 0 };
    await usageRef.set(usage);
    const historyBefore = await rows(db, "cmsVersionHistory");

    const res = await restore(db, { id: "support" });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "That revision was saved before this page's layout was migrated. Restore a revision saved after the layout migration." });
    expect((await db.collection("cmsPages").doc("support").get()).data()).toEqual(current);
    expect((await usageRef.get()).data()).toEqual(usage);
    expect(await rows(db, "cmsVersionHistory")).toEqual(historyBefore);
    expect(await rows(db, "admin_logs")).toEqual([]);
  });

  it.each(["reordered", "empty"])("restores a composed support revision with %s content", async content => {
    const current = { ...composedSupport, status: "draft", version: 8 };
    const blocks = content === "empty" ? [] : [...composedSupport.blocks].reverse().map((block, order) => ({ ...block, order }));
    const after = { ...composedSupport, version: 3, title: "Historical support title", blocks };
    await seedTarget(db, { id: "support", current, after });

    const res = await restore(db, { id: "support" });

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("support").get()).data();
    expect(stored).toMatchObject({ title: after.title, version: 9, serviceCompositionVersion: 1 });
    expect(stored.blocks).toEqual(blocks);
    expect(stored.published).toEqual(current.published);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(2);
    expect(await rows(db, "admin_logs")).toHaveLength(1);
  });

  it("restores an unmarked support revision on an unmarked page with its named slots intact", async () => {
    const current = { ...legacySupport, status: "draft", version: 8, blocks: [] };
    const after = { ...legacySupport, version: 3, title: "Historical support title" };
    await seedTarget(db, { id: "support", current, after });

    const res = await restore(db, { id: "support" });

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("support").get()).data();
    expect(stored.title).toBe(after.title);
    expect(stored.blocks).toEqual(after.blocks);
    expect(stored).not.toHaveProperty("serviceCompositionVersion");
    expect(stored.published).toEqual(current.published);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(2);
    expect(await rows(db, "admin_logs")).toHaveLength(1);
  });

  it("retains the Home composition marker from a valid converted revision", async () => {
    const historicalBlocks = homeCompositionDefaults();
    historicalBlocks.find(({ section }) => section === "home-featured").data.title =
      "Historical featured programs";
    await seedTarget(db, {
      current: currentPage({
        homeCompositionVersion: 1,
        blocks: homeCompositionDefaults(),
      }),
      after: historicalPage({
        homeCompositionVersion: 1,
        blocks: historicalBlocks,
      }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.homeCompositionVersion).toBe(1);
    expect(stored.blocks).toEqual(historicalBlocks);
  });

  it("keeps the current conversion receipt through a legacy restore and refuses its old replay", async () => {
    const current = currentPage({
      blocks: [divider("legacy-copy", 0)],
      version: 4,
    });
    await db.collection("cmsPages").doc("home").set(current);
    const converted = await convertHome(db);
    expect(converted.statusCode).toBe(200);
    const receipt = converted.body.document.homeConversionReceipt;
    expect(receipt).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      version: 5,
      mintedIds: expect.any(Object),
    });
    await db.collection("cmsVersionHistory").doc("source-revision").set({
      collection: "cmsPages",
      documentId: "home",
      action: "update",
      userId: "editor-before",
      at: "2026-07-10T12:00:00.000Z",
      before: historicalPage({ title: "Earlier legacy Home", version: 2 }),
      after: historicalPage({ blocks: [divider("historical-copy", 0)] }),
    });

    const restored = await restore(db, { baseVersion: 5 });

    expect(restored.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).not.toHaveProperty("homeCompositionVersion");
    expect(stored.homeConversionReceipt).toEqual(receipt);
    expect(stored).toMatchObject({
      blocks: [divider("historical-copy", 0)],
      version: 6,
    });
    const beforeReplay = {
      page: stored,
      history: await rows(db, "cmsVersionHistory"),
      audit: await rows(db, "admin_logs"),
    };

    const replay = await convertHome(db);

    expect(replay.statusCode).toBe(409);
    expect(replay.body.error).toMatch(/Home changed after conversion/i);
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toEqual(beforeReplay.page);
    expect(await rows(db, "cmsVersionHistory")).toEqual(beforeReplay.history);
    expect(await rows(db, "admin_logs")).toEqual(beforeReplay.audit);
  });

  it("does not renew a conversion receipt from a historical snapshot", async () => {
    const historicalReceipt = {
      fingerprint: "f".repeat(64),
      version: 3,
      mintedIds: { "new-home-start": "historical-home-start" },
    };
    await seedTarget(db, {
      current: currentPage({ blocks: [divider("current-copy", 0)] }),
      after: historicalPage({
        homeCompositionVersion: 1,
        homeConversionReceipt: historicalReceipt,
        blocks: homeCompositionDefaults(),
      }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.homeCompositionVersion).toBe(1);
    expect(stored).not.toHaveProperty("homeConversionReceipt");
  });

  it("rejects a malformed converted Home revision atomically", async () => {
    const current = currentPage({
      homeCompositionVersion: 1,
      blocks: homeCompositionDefaults(),
    });
    const malformedBlocks = homeCompositionDefaults().filter(
      ({ section }) => section !== "home-spotlight",
    );
    await seedTarget(db, {
      current,
      after: historicalPage({
        homeCompositionVersion: 1,
        blocks: malformedBlocks,
      }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/seven named regions/i);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
    expect(await rows(db, "cmsPages/home/mediaUsage")).toHaveLength(0);
  });

  it("refuses to restore a retired generic Staff record", async () => {
    const current = {
      id: "legacy-staff",
      type: "staff",
      status: "draft",
      name: "Pat Lee",
      role: "Reporter",
      bio: richTextDoc("Current biography."),
      createdAt: "2026-07-01T12:00:00.000Z",
      createdBy: "editor-1",
      updatedAt: "2026-08-01T12:00:00.000Z",
      updatedBy: "editor-1",
      version: 4,
    };
    await Promise.all([
      db.collection("cmsPosts").doc("legacy-staff").set(current),
      db.collection("cmsVersionHistory").doc("staff-revision").set({
        collection: "cmsPosts",
        documentId: "legacy-staff",
        action: "update",
        after: {
          ...current,
          bio: richTextDoc("Historical biography."),
          version: 3,
        },
      }),
    ]);

    const res = await restore(db, {
      collection: "cmsPosts",
      id: "legacy-staff",
      revisionId: "staff-revision",
      baseVersion: 4,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/generic Staff record was retired/i);
    expect((await db.collection("cmsPosts").doc("legacy-staff").get()).data())
      .toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("restores editor-owned content as a new immutable revision", async () => {
    await seedTarget(db);

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      collection: "cmsPages",
      id: "home",
      sourceRevisionId: "source-revision",
      sourceVersion: 3,
      version: 9,
      revisionId: expect.any(String),
      document: {
        title: "Historical working title",
        seo: { title: "Historical SEO title" },
        social: { title: "Historical social title" },
        blocks: [divider("old-second", 0), divider("old-first", 1)],
        version: 9,
      },
    });

    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).toMatchObject({
      id: "home",
      template: "home",
      title: "Historical working title",
      status: "draft",
      slug: "current-route",
      assignee: "producer-1",
      approvalState: "approved",
      published: { title: "Currently live title", blocks: [] },
      createdAt: "2026-07-01T12:00:00.000Z",
      createdBy: "editor-1",
      updatedAt: "2026-08-12T20:00:00.000Z",
      updatedBy: "editor-1",
      version: 9,
    });
    expect(stored).not.toHaveProperty("description");

    const versions = await rows(db, "cmsVersionHistory");
    expect(versions).toHaveLength(2);
    expect(versions.find(({ id }) => id === "source-revision")).toMatchObject({
      after: {
        title: "Historical working title",
        version: 3,
        blocks: [divider("old-second", 1), divider("old-first", 0)],
      },
    });
    const receipt = versions.find(({ id }) => id === res.body.revisionId);
    expect(receipt).toMatchObject({
      collection: "cmsPages",
      documentId: "home",
      action: "restore",
      sourceRevisionId: "source-revision",
      sourceVersion: 3,
      restoredVersion: 9,
      newRevisionId: res.body.revisionId,
      before: { title: "Current working title", version: 8 },
      after: { title: "Historical working title", version: 9 },
    });

    expect(await rows(db, "admin_logs")).toEqual([
      expect.objectContaining({
        action: "cms.restore-revision",
        target: "cmsPages/home",
        after: expect.objectContaining({
          sourceRevisionId: "source-revision",
          sourceVersion: 3,
          newRevisionId: res.body.revisionId,
          version: 9,
        }),
      }),
    ]);
  });

  it("requires Edit before restoring a revision during review", async () => {
    await seedTarget(db, {
      current: currentPage({ status: "in_review" }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Select Edit before restoring a revision.");
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toMatchObject({ status: "in_review", version: 8 });
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("refuses a bounded scheduled-publish failure receipt marked as nonrestorable", async () => {
    const current = currentPage({ version: 9 });
    await Promise.all([
      db.collection("cmsPages").doc("home").set(current),
      db.collection("cmsVersionHistory").doc("source-revision").set({
        collection: "cmsPages",
        documentId: "home",
        action: "schedule-publish-failed",
        userId: "system:scheduler",
        at: "2026-08-12T19:00:00.000Z",
        restorable: false,
        before: {
          id: "home",
          status: "scheduled",
          version: 7,
          publishAt: "2026-08-12T19:00:00.000Z",
        },
        after: {
          id: "home",
          status: "approved",
          version: 8,
          publishAt: "2026-08-12T19:00:00.000Z",
          scheduledPublishFailure: {
            failedAt: "2026-08-12T19:00:00.000Z",
            failedBy: "system:scheduler",
            reason: "invalid-content",
          },
        },
      }),
    ]);

    const res = await restore(db, { baseVersion: 9 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/complete restorable snapshot/i);
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("replaces working media usage and preserves published usage", async () => {
    await Promise.all([
      seedTarget(db, {
        after: historicalPage({
          social: { imageAssetId: "social-image" },
          blocks: [image("visible", "restored-image")],
        }),
      }),
      seedMediaAsset(db, "restored-image"),
      seedMediaAsset(db, "social-image"),
      db.collection("cmsPages/home/mediaUsage").doc("published").set({
        state: "published",
        sourceVersion: 5,
        assetIds: ["live-image"],
        occurrenceCount: 1,
      }),
    ]);

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages/home/mediaUsage").doc("working").get()).data())
      .toEqual({
        state: "working",
        sourceVersion: 9,
        assetIds: ["restored-image", "social-image"],
        occurrenceCount: 2,
      });
    expect((await db.collection("cmsPages/home/mediaUsage").doc("published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 5,
        assetIds: ["live-image"],
        occurrenceCount: 1,
      });
  });

  it("rejects a restored media reference that is no longer active", async () => {
    const current = currentPage();
    await Promise.all([
      seedTarget(db, {
        current,
        after: historicalPage({
          blocks: [image("retired", "retired-image")],
        }),
      }),
      seedMediaAsset(db, "retired-image", { lifecycle: "tombstoned" }),
    ]);

    const res = await restore(db);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/not available/i);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("rejects a stale base without changing content or audit history, then permits a fresh retry", async () => {
    const current = currentPage();
    await seedTarget(db, { current });

    const stale = await restore(db, { baseVersion: 7 });

    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened/i);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);

    const retried = await restore(db, { baseVersion: 8 });
    expect(retried.statusCode).toBe(200);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(2);
    expect(await rows(db, "admin_logs")).toHaveLength(1);
  });

  it.each(["approved", "scheduled", "published"])(
    "refuses a revision restore while %s content is frozen",
    async (status) => {
      const current = currentPage({
        status,
        ...(status === "scheduled"
          ? { publishAt: "2026-08-20T14:00:00.000Z" }
          : {}),
      });
      await seedTarget(db, { current });

      const res = await restore(db);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(
        status === "approved"
          ? /reopen approved/i
          : status === "scheduled"
            ? /cancel scheduled/i
            : /start a revision/i,
      );
      expect((await db.collection("cmsPages").doc("home").get()).data())
        .toEqual(current);
      expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
      expect(await rows(db, "admin_logs")).toHaveLength(0);
    },
  );

  it("rejects a historical snapshot that fails the current block schema without writing", async () => {
    const current = currentPage();
    await seedTarget(db, {
      current,
      after: historicalPage({
        blocks: [{
          id: "bad-block",
          type: "not-a-block",
          order: 0,
          visible: true,
          data: {},
        }],
      }),
    });

    const res = await restore(db);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/block/i);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("normalizes trusted Firestore timestamps before validating the restored record", async () => {
    const publishAt = admin.firestore.Timestamp.fromDate(
      new Date("2026-08-20T14:00:00.000Z"),
    );
    await seedTarget(db, { current: currentPage({ publishAt }) });

    const res = await restore(db);

    expect(res.statusCode).toBe(200);
    expect(res.body.document.publishAt).toBe("2026-08-20T14:00:00.000Z");
    expect((await db.collection("cmsPages").doc("home").get()).data().publishAt)
      .toBe("2026-08-20T14:00:00.000Z");
  });

  it("normalizes historical event timestamps before restoring editor-owned dates", async () => {
    const richText = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Event details" }],
      }],
    };
    await Promise.all([
      db.collection("cmsPosts").doc("event-1").set({
        id: "event-1",
        type: "event",
        title: "Current event",
        startsAt: "2026-08-20T14:00:00.000Z",
        description: richText,
        status: "draft",
        publishAt: null,
        createdBy: "editor-1",
        version: 8,
      }),
      db.collection("cmsVersionHistory").doc("source-revision").set({
        collection: "cmsPosts",
        documentId: "event-1",
        action: "update",
        after: {
          type: "event",
          title: "Historical event",
          startsAt: admin.firestore.Timestamp.fromDate(
            new Date("2026-08-21T18:00:00.000Z"),
          ),
          endsAt: admin.firestore.Timestamp.fromDate(
            new Date("2026-08-21T20:00:00.000Z"),
          ),
          description: richText,
          status: "draft",
          version: 3,
        },
      }),
    ]);

    const res = await restore(db, { collection: "cmsPosts", id: "event-1" });

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      startsAt: "2026-08-21T18:00:00.000Z",
      endsAt: "2026-08-21T20:00:00.000Z",
    });
  });

  it("rejects inherited object keys as unknown content types instead of throwing", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("legacy-bad-kind").set({
        id: "legacy-bad-kind",
        type: "constructor",
        status: "draft",
        createdBy: "editor-1",
        version: 8,
      }),
      db.collection("cmsVersionHistory").doc("source-revision").set({
        collection: "cmsPosts",
        documentId: "legacy-bad-kind",
        action: "update",
        after: { type: "constructor", status: "draft", version: 3 },
      }),
    ]);

    const res = await restore(db, {
      collection: "cmsPosts",
      id: "legacy-bad-kind",
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/unknown content type constructor/i);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("uses a bounded before receipt when a smaller restore repairs a large legacy document", async () => {
    await seedTarget(db, {
      current: currentPage({ description: "x".repeat(4_000) }),
      after: historicalPage({ description: "short" }),
    });
    const documentSizeErrorFn = vi.fn((document, _path, context = {}) =>
      context.label === "the version-history row for this restore" &&
      document.before?.beforeTruncated !== true
        ? {
            reason: "this page could not be saved because it is too large.",
            detail: "full history exceeds the test budget",
          }
        : null,
    );

    const res = await restore(db, {}, { documentSizeErrorFn });

    expect(res.statusCode).toBe(200);
    const receipt = (await db.collection("cmsVersionHistory").doc(res.body.revisionId).get()).data();
    expect(receipt).toMatchObject({
      beforeTruncated: true,
      beforeEstimatedBytes: expect.any(Number),
      before: {
        id: "home",
        status: "draft",
        version: 8,
        beforeTruncated: true,
        beforeEstimatedBytes: expect.any(Number),
      },
      after: { description: "short", version: 9 },
    });
    expect(documentSizeErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({ beforeTruncated: true }),
      expect.any(String),
      expect.objectContaining({ label: "the bounded version-history row for this repair" }),
    );
  });

  // A revision written before the ordered byline existed (#1040) carries the
  // free-text `author` and no `credits`. `author` is no longer a contract field,
  // so nothing copies it forward, while `credits` is one and would be deleted for
  // being absent from the historical snapshot. Without the conversion the restore
  // silently drops the byline off a story that had one.
  async function seedLegacyBylinePost(db, { current = {}, historical = {} } = {}) {
    const post = {
      id: "story-1",
      type: "post",
      title: "Current headline",
      slug: "current-headline",
      tags: [],
      blocks: [],
      status: "draft",
      credits: [{ kind: "custom", name: "Newsroom staff" }],
      createdAt: "2026-07-01T12:00:00.000Z",
      createdBy: "editor-1",
      updatedAt: "2026-08-12T14:00:00.000Z",
      updatedBy: "editor-1",
      version: 4,
      ...current,
    };
    const after = {
      id: "story-1",
      type: "post",
      title: "Historical headline",
      slug: "historical-headline",
      tags: [],
      blocks: [],
      status: "draft",
      author: "  Sasha   Mercer ",
      createdAt: "2026-06-01T12:00:00.000Z",
      createdBy: "editor-1",
      updatedAt: "2026-06-01T12:00:00.000Z",
      updatedBy: "editor-1",
      version: 2,
      ...historical,
    };
    await Promise.all([
      db.collection("cmsPosts").doc("story-1").set(post),
      db.collection("cmsVersionHistory").doc("legacy-revision").set({
        collection: "cmsPosts",
        documentId: "story-1",
        action: "update",
        userId: "editor-1",
        userEmail: "editor@example.com",
        at: "2026-06-01T12:00:00.000Z",
        before: { ...after, title: "Even earlier headline", version: 1 },
        after,
      }),
    ]);
  }

  async function restoreLegacyBylinePost(db) {
    return restore(db, {
      collection: "cmsPosts",
      id: "story-1",
      revisionId: "legacy-revision",
      baseVersion: 4,
    });
  }

  it("converts a pre-contract free-text byline into one custom credit on restore", async () => {
    await seedLegacyBylinePost(db);

    const res = await restoreLegacyBylinePost(db);

    expect(res.statusCode).toBe(200);
    const restored = (
      await db.collection("cmsPosts").doc("story-1").get()
    ).data();
    expect(restored.title).toBe("Historical headline");
    // Sanitized the same way the save boundary sanitizes it: one custom credit,
    // no name matching against staff, and no guessed registered identity.
    expect(restored.credits).toEqual([
      { kind: "custom", name: "Sasha Mercer" },
    ]);
    // One byline, not two that can disagree on the next edit.
    expect(Object.prototype.hasOwnProperty.call(restored, "author")).toBe(false);
  });

  it("keeps a legacy byline out of the way of a historical byline that already used credits", async () => {
    await seedLegacyBylinePost(db, {
      current: { author: "Stale legacy string" },
      historical: {
        author: "Stale legacy string",
        credits: [{ kind: "custom", name: "Jules Avery" }],
      },
    });

    const res = await restoreLegacyBylinePost(db);

    expect(res.statusCode).toBe(200);
    const restored = (
      await db.collection("cmsPosts").doc("story-1").get()
    ).data();
    expect(restored.credits).toEqual([{ kind: "custom", name: "Jules Avery" }]);
    expect(Object.prototype.hasOwnProperty.call(restored, "author")).toBe(false);
  });

  it("restores an empty byline when the historical snapshot genuinely had none", async () => {
    await seedLegacyBylinePost(db, { historical: { author: "   " } });

    const res = await restoreLegacyBylinePost(db);

    expect(res.statusCode).toBe(200);
    const restored = (
      await db.collection("cmsPosts").doc("story-1").get()
    ).data();
    // A blank legacy string is not a byline, so the current one comes off rather
    // than being kept as a byline the restored revision never carried.
    expect(restored.credits ?? []).toEqual([]);
  });

  it("does not reveal or read a target for a caller with no content-write capability", async () => {
    let transactionStarted = false;
    const handler = createCmsRestoreRevisionHandler({
      firestore: {
        runTransaction: async () => {
          transactionStarted = true;
        },
      },
      requirePrincipalFn: async () => ({
        uid: "viewer-1",
        principal: { id: "viewer-1", grants: [{ role: "viewer" }] },
      }),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        revisionId: "source-revision",
        baseVersion: 8,
      },
    }), res);

    expect(res.statusCode).toBe(403);
    expect(transactionStarted).toBe(false);
  });
});

describe("cmsRestoreRevision section scoping (#845)", () => {
  // Restoring is an edit, so it is authorized against the live record's owner and its
  // editorial desk -- and both the history read and the write use the same resolved desk,
  // so a scoped editor can never open a restore they could not save, or save one they
  // could not open.
  let db;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("restore-revision.test.js");
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

  const scopedEditor = (sections) => async () => ({
    uid: "scoped-1",
    email: "scoped-1@example.com",
    principal: { id: "scoped-1", grants: [{ role: "editor", sections }] },
  });

  async function seedRecord(section) {
    const record = {
      id: "a-1",
      type: "post",
      title: "Current title",
      date: "2026-08-21",
      tags: [],
      blocks: [],
      status: "draft",
      createdBy: "editor-1",
      version: 4,
      ...(section === undefined ? {} : { section }),
    };
    await Promise.all([
      db.collection("cmsPosts").doc("a-1").set(record),
      db.collection("cmsVersionHistory").doc("source-revision").set({
        collection: "cmsPosts",
        documentId: "a-1",
        action: "update",
        userId: "editor-1",
        userEmail: "editor-1@example.com",
        at: "2026-07-10T12:00:00.000Z",
        before: { ...record, title: "Older title", version: 2 },
        after: { ...record, title: "Historical title", version: 3 },
      }),
    ]);
  }

  const restoreRecord = (deps) =>
    restore(db, { collection: "cmsPosts", id: "a-1", baseVersion: 4 }, deps);

  it("restores a record in the caller's own desk", async () => {
    await seedRecord("watch");
    const res = await restoreRecord({ requirePrincipalFn: scopedEditor(["watch"]) });
    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPosts").doc("a-1").get()).data();
    expect(stored.title).toBe("Historical title");
    // The restore does not move the record: its desk is still the one it was created in.
    expect(stored.section).toBe("watch");
  });

  it("refuses a restore of a record in another desk and writes nothing", async () => {
    await seedRecord("station");
    const res = await restoreRecord({ requirePrincipalFn: scopedEditor(["watch"]) });
    expect(res.statusCode).toBe(403);
    const stored = (await db.collection("cmsPosts").doc("a-1").get()).data();
    expect(stored.title).toBe("Current title");
    expect(stored.version).toBe(4);
  });

  it("refuses a restore of a record carrying no desk", async () => {
    await seedRecord(undefined);
    const res = await restoreRecord({ requirePrincipalFn: scopedEditor(["watch"]) });
    expect(res.statusCode).toBe(403);
    expect((await db.collection("cmsPosts").doc("a-1").get()).data().version).toBe(4);
  });

  it("leaves a site-wide editor's restore unchanged", async () => {
    await seedRecord("station");
    const res = await restoreRecord({});
    expect(res.statusCode).toBe(200);
  });
});

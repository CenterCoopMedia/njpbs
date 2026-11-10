import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
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
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";
import lifecycleTransition from "../../functions/lifecycle-transition.js";
import reviewQueue from "../../functions/lib/review-queue.js";

const {
  cmsTransitionContent,
  createCmsTransitionContentHandler,
  validateTransitionRequest,
} = lifecycleTransition;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return {
    method,
    body,
    headers: { "x-forwarded-for": "203.0.113.24", ...headers },
    ip: "203.0.113.24",
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

const editor = (overrides = {}) => ({
  uid: "editor-1",
  email: "editor@example.com",
  principal: { id: "editor-1", grants: [{ role: "editor" }] },
  ...overrides,
});

const adminUser = (overrides = {}) => ({
  uid: "admin-1",
  email: "admin@example.com",
  principal: { id: "admin-1", grants: [{ role: "admin" }] },
  ...overrides,
});

async function rows(db, collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

function publishedPage(overrides = {}) {
  return {
    id: "watch",
    template: "watch",
    title: "Watch NJ PBS",
    status: "published",
    publishAt: "2026-08-10T12:00:00.000Z",
    blocks: [],
    published: {
      sourceVersion: 4,
      title: "Watch NJ PBS",
      blocks: [],
    },
    createdBy: "author-1",
    updatedAt: "2026-08-10T12:00:00.000Z",
    updatedBy: "editor-before",
    version: 4,
    ...overrides,
  };
}

function publishedRecord(overrides = {}) {
  return {
    id: "record-1",
    type: "post",
    title: "Shore report",
    status: "published",
    publishAt: "2026-08-11T12:00:00.000Z",
    blocks: [],
    published: {
      sourceVersion: 3,
      title: "Shore report",
      blocks: [],
    },
    createdBy: "author-1",
    updatedAt: "2026-08-11T12:00:00.000Z",
    updatedBy: "editor-before",
    version: 3,
    ...overrides,
  };
}

// A record stored before the Article retirement (#1039). It is a cmsPosts document
// whose type is the retired kind; nothing else distinguishes it in storage.
function storedArticle(overrides = {}) {
  return publishedRecord({
    type: "article",
    body: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
    },
    slug: "shore-report",
    previousSlugs: [],
    locale: "en",
    ...overrides,
  });
}

const liveMediaUsage = (sourceVersion) => ({
  state: "published",
  sourceVersion,
  assetIds: ["live-image"],
  occurrenceCount: 1,
});

async function transition(db, body, deps = {}) {
  const handler = createCmsTransitionContentHandler({
    firestore: db,
    requirePrincipalFn: editor,
    now: () => "2026-08-13T04:00:00.000Z",
    enqueuePublishBuildFn: vi.fn(async () => ({ queueId: "withdrawal-queue" })),
    ...deps,
  });
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

describe("cmsTransitionContent", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "lifecycle-transition-test",
    );
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, { disableWarnings: true });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: "DELETE",
    });
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("is publicly invokable so application authentication can return an honest 401", () => {
    expect(cmsTransitionContent.__endpoint.httpsTrigger.invoker).toEqual(["public"]);
  });

  it("rejects unsupported methods before authentication", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsTransitionContentHandler({ requirePrincipalFn });
    const res = makeRes();

    await handler(makeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
  });

  it("validates a collection, bounded id, exact version, and admitted action", () => {
    expect(validateTransitionRequest({})).toBe("collection must be cmsPages or cmsPosts");
    expect(validateTransitionRequest({
      collection: "cmsPages",
      id: "bad/path",
      baseVersion: 1,
      action: "unpublish",
    })).toMatch(/document id/);
    expect(validateTransitionRequest({
      collection: "cmsPages",
      id: "watch",
      baseVersion: 0,
      action: "unpublish",
    })).toMatch(/positive safe integer/);
    expect(validateTransitionRequest({
      collection: "cmsPages",
      id: "watch",
      baseVersion: 1,
      action: "publish",
    })).toMatch(/admitted lifecycle action/);
    expect(validateTransitionRequest({
      collection: "cmsPages",
      id: "watch",
      baseVersion: 1,
      action: "unpublish",
    })).toBeNull();
    expect(validateTransitionRequest({
      collection: "cmsPages",
      id: "watch",
      baseVersion: 1,
      action: "submit",
    })).toBeNull();
  });

  it("moves a draft through review and approval, then reopens it explicitly", async () => {
    await db.collection("cmsPages").doc("watch").set(publishedPage({
      status: "draft",
      version: 4,
    }));

    const submitted = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "submit",
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.body.document).toMatchObject({
      status: "in_review",
      version: 5,
      reviewRequest: {
        collection: "cmsPages",
        recordId: "watch",
        state: "in_review",
        sourceVersion: 5,
        requestedBy: "editor-1",
        requestedAt: "2026-08-13T04:00:00.000Z",
      },
    });
    expect(submitted.body.reviewRequest).toEqual(
      submitted.body.document.reviewRequest,
    );
    expect(submitted.body.reviewRequest.requestId).toMatch(
      /^review_[a-f0-9]{64}$/,
    );

    const approved = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 5,
      action: "approve",
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body.document).toMatchObject({ status: "approved", version: 6 });
    expect(approved.body.document.reviewRequest).toBeUndefined();
    await db.collection("cmsPages").doc("watch").update({
      scheduledPublishFailure: {
        failedAt: "2026-08-13T18:30:00.000Z",
        failedBy: "system:scheduler",
        reason: "The scheduled publication failed.",
      },
    });

    const reopened = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 6,
      action: "reopen",
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.body.document).toMatchObject({ status: "draft", version: 7 });
    expect(reopened.body.document.scheduledPublishFailure).toBeUndefined();
    const historyActions = (await rows(db, "cmsVersionHistory"))
      .map((row) => row.action);
    expect(historyActions).toHaveLength(3);
    expect(historyActions).toEqual(
      expect.arrayContaining(["submit", "approve", "reopen"]),
    );
  });

  it("makes a lost submit response safe to retry without duplicating an active request", async () => {
    await db.collection("cmsPages").doc("watch").set(
      publishedPage({ status: "draft", version: 4 }),
    );

    const submitted = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "submit",
    });
    expect(submitted.statusCode).toBe(200);
    const firstRequest = submitted.body.document.reviewRequest;

    const replay = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 5,
      action: "submit",
    });
    expect(replay.statusCode).toBe(409);
    const stored = (
      await db.collection("cmsPages").doc("watch").get()
    ).data();
    expect(stored).toMatchObject({
      status: "in_review",
      version: 5,
      reviewRequest: firstRequest,
    });
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await rows(db, "admin_logs")).toHaveLength(1);
  });

  it("cannot leave review state behind when a submit transaction fails", async () => {
    const before = publishedPage({ status: "draft", version: 4 });
    await db.collection("cmsPages").doc("watch").set(before);

    const staleSubmit = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 3,
      action: "submit",
    });

    expect(staleSubmit.statusCode).toBe(409);
    const stored = (
      await db.collection("cmsPages").doc("watch").get()
    ).data();
    expect(stored).toEqual(before);
    expect(stored.reviewRequest).toBeUndefined();
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("starts a draft revision while the last published snapshot remains live", async () => {
    const before = publishedPage();
    await Promise.all([
      db.collection("cmsPages").doc("watch").set(before),
      db.collection("cmsPages/watch/mediaUsage").doc("published")
        .set(liveMediaUsage(4)),
    ]);

    const res = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "revise",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      status: "draft",
      publiclyVisible: true,
      published: before.published,
      version: 5,
    });
    expect(await rows(db, "cmsVersionHistory")).toEqual([
      expect.objectContaining({ action: "revise" }),
    ]);
    expect(await rows(db, "admin_logs")).toEqual([
      expect.objectContaining({ action: "cms.revise" }),
    ]);
    expect((await db.collection("cmsPages/watch/mediaUsage").doc("published").get()).data())
      .toEqual(liveMediaUsage(4));
  });

  it.each(["in_review", "approved", "scheduled", "published"])(
    "opens %s content with one edit action",
    async (status) => {
      const before = publishedPage({
        status,
        publiclyVisible: status === "published",
        ...(status === "scheduled"
          ? { publishAt: "2026-08-20T12:00:00.000Z" }
          : {}),
      });
      await db.collection("cmsPages").doc("watch").set(before);

      const res = await transition(db, {
        collection: "cmsPages",
        id: "watch",
        baseVersion: 4,
        action: "edit",
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.document).toMatchObject({ status: "draft", version: 5 });
      expect(res.body.document.publishAt).toBeUndefined();
      if (status === "published") {
        expect(res.body.document.publiclyVisible).toBe(true);
      }
    },
  );

  it.each([
    ["draft", "submit"], ["in_review", "edit"], ["approved", "edit"],
    ["scheduled", "edit"], ["published", "edit"],
  ])("refuses a Writer's %s Home transition without changing its schedule or version", async (status, action) => {
    const before = publishedPage({ id: "home", template: "home", status, createdBy: "writer-1" });
    await db.collection("cmsPages").doc("home").set(before);
    const res = await transition(db, { collection: "cmsPages", id: "home", baseVersion: 4, action }, {
      requirePrincipalFn: async () => ({ uid: "writer-1", principal: { id: "writer-1", grants: [{ role: "contributor" }] } }),
    });
    expect(res.statusCode).toBe(403);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(before);
    expect(await rows(db, "cmsVersionHistory")).toEqual([]);
  });

  it.each([
    [{ role: "editor", sections: ["station"] }, 200],
    [{ role: "editor", sections: ["watch"] }, 403],
    [{ role: "admin" }, 200],
    [{ role: "super_admin" }, 200],
  ])("requires Station editing authority for Home lifecycle changes: %j", async (grant, expected) => {
    const before = publishedPage({ id: "home", template: "home", status: "scheduled" });
    await db.collection("cmsPages").doc("home").set(before);
    const res = await transition(db, { collection: "cmsPages", id: "home", baseVersion: 4, action: "edit" }, {
      requirePrincipalFn: async () => ({ uid: "editor-1", principal: { id: "editor-1", grants: [grant] } }),
    });
    expect(res.statusCode).toBe(expected);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    if (expected === 200) expect(stored).toMatchObject({ status: "draft", version: 5 });
    else expect(stored).toEqual(before);
  });

  it("keeps a legacy published snapshot live when Edit opens its draft", async () => {
    const before = publishedPage({ status: "published" });
    delete before.publiclyVisible;
    await db.collection("cmsPages").doc("watch").set(before);

    const res = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "edit",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      status: "draft",
      publiclyVisible: true,
      published: before.published,
      version: 5,
    });
  });

  it.each([
    [publishedPage({ status: "in_review", blocks: [{ id: "bad", type: "unknown", order: 0, visible: true, data: {} }] }), /block/i],
    [publishedPage({ status: "in_review", social: { imageAssetId: 42 } }), /social\.imageAssetId/i],
  ])("refuses approval when the reviewed content is not publishable", async (current, message) => {
    await db.collection("cmsPages").doc("watch").set(current);

    const res = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: current.version,
      action: "approve",
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect((await db.collection("cmsPages").doc("watch").get()).data())
      .toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("refuses approval when an Interactive/Data Lab Post has no interactive content", async () => {
    const current = publishedRecord({
      status: "in_review",
      tags: ["format:interactive"],
      slug: "shore-report",
      previousSlugs: [],
      locale: "en",
    });
    await db.collection("cmsPosts").doc("record-1").set(current);

    const res = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "approve",
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "An Interactive/Data Lab Post must include at least one complete data figure or table, custom HTML block, or approved media or interactive link.",
    );
    expect((await db.collection("cmsPosts").doc("record-1").get()).data())
      .toEqual(current);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  // Every lifecycle action except archive writes a retired record back into the
  // editorial workflow, and nothing downstream can edit, approve or publish it. The
  // approval gate alone was not enough: restore in particular would move an archived
  // Article back to draft, contradicting the retirement it was archived under.
  it.each([
    ["submit", "draft", "in_review"],
    ["sendBack", "in_review", "draft"],
    ["approve", "in_review", "approved"],
    ["reopen", "approved", "draft"],
    ["revise", "published", "draft"],
    ["unschedule", "scheduled", "draft"],
    ["unpublish", "published", "draft"],
    ["restore", "archived", "draft"],
  ])("refuses the %s transition for a record of a retired kind", async (action, from) => {
    const current = storedArticle({ status: from });
    await db.collection("cmsPosts").doc("record-1").set(current);

    const res = await transition(
      db,
      {
        collection: "cmsPosts",
        id: "record-1",
        baseVersion: 3,
        action,
        ...(action === "sendBack" ? { comment: "Needs another pass." } : {}),
      },
      { requirePrincipalFn: adminUser },
    );

    expect(res.statusCode, action).toBe(400);
    expect(res.body.error).toBe(
      "The Article type was retired. This record can only be archived.",
    );
    expect((await db.collection("cmsPosts").doc("record-1").get()).data()).toEqual(
      current,
    );
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("still archives a record of a retired kind, which is the supported way out", async () => {
    // The deliberate exception. Archiving is how staff take a stored Article out of
    // circulation, so it is the one lifecycle move the retirement keeps open.
    await db
      .collection("cmsPosts")
      .doc("record-1")
      .set(storedArticle({ status: "published" }));

    const res = await transition(
      db,
      {
        collection: "cmsPosts",
        id: "record-1",
        baseVersion: 3,
        action: "archive",
      },
      { requirePrincipalFn: adminUser },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ status: "archived", version: 4 });
    // And it cannot come back: the archive is terminal for a retired kind.
    const restored = await transition(
      db,
      {
        collection: "cmsPosts",
        id: "record-1",
        baseVersion: 4,
        action: "restore",
      },
      { requirePrincipalFn: adminUser },
    );
    expect(restored.statusCode).toBe(400);
    expect((await db.collection("cmsPosts").doc("record-1").get()).data().status).toBe(
      "archived",
    );
  });

  it("accepts a legacy post date when approving retained content", async () => {
    const current = publishedRecord({
      status: "in_review",
      date: "2026-08-11T15:30:00.000Z",
      tags: [],
      slug: "shore-report",
      previousSlugs: [],
      locale: "en",
    });
    await db.collection("cmsPosts").doc("record-1").set(current);

    const res = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "approve",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      status: "approved",
      date: "2026-08-11T15:30:00.000Z",
      version: 4,
    });
  });

  it("records the required send-back note with the transition evidence", async () => {
    await db.collection("cmsPosts").doc("record-1").set(publishedRecord({
      status: "in_review",
      version: 3,
    }));

    const missing = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "sendBack",
    });
    expect(missing.statusCode).toBe(400);

    const sentBack = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "sendBack",
      comment: "  Add a second source.  ",
    });
    expect(sentBack.statusCode).toBe(200);
    expect(sentBack.body.document).toMatchObject({ status: "draft", version: 4 });
    expect(await rows(db, "cmsVersionHistory")).toEqual([
      expect.objectContaining({ action: "sendBack", comment: "Add a second source." }),
    ]);
    expect(await rows(db, "admin_logs")).toEqual([
      expect.objectContaining({
        action: "cms.sendBack",
        after: { status: "draft", version: 4, comment: "Add a second source." },
      }),
    ]);
  });

  it("lets an owner submit a draft but does not let that contributor approve it", async () => {
    await db.collection("cmsPosts").doc("record-1").set(publishedRecord({
      status: "draft",
      tags: [],
      createdBy: "contributor-1",
      version: 3,
    }));
    const contributor = async () => ({
      uid: "contributor-1",
      principal: {
        id: "contributor-1",
        grants: [{ role: "contributor" }],
      },
    });

    const submitted = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "submit",
    }, { requirePrincipalFn: contributor });
    expect(submitted.statusCode).toBe(200);

    const refused = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 4,
      action: "approve",
    }, { requirePrincipalFn: contributor });
    expect(refused.statusCode).toBe(403);
    expect((await db.collection("cmsPosts").doc("record-1").get()).data())
      .toMatchObject({ status: "in_review", version: 4 });
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
  });

  it.each([
    ["cmsPages", "watch", publishedPage()],
    ["cmsPosts", "record-1", publishedRecord()],
  ])("returns cancelled scheduled %s content to draft", async (collection, id, current) => {
    // #2761: cancelling returns to editable draft and supersedes an old failure.
    await db.collection(collection).doc(id).set({
      ...current,
      status: "scheduled",
      version: 4,
      scheduledPublishFailure: {
        failedAt: "2026-08-12T04:00:00.000Z",
        failedBy: "system:scheduler",
        reason: "An earlier schedule could not publish.",
      },
    });

    const res = await transition(db, {
      collection,
      id,
      baseVersion: 4,
      action: "unschedule",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      fromStatus: "scheduled",
      toStatus: "draft",
      version: 5,
      document: { status: "draft", version: 5, published: current.published },
    });
    expect(res.body.document.publishAt).toBeUndefined();
    const stored = (await db.collection(collection).doc(id).get()).data();
    expect(stored.publishAt).toBeUndefined();
    expect(res.body.document.scheduledPublishFailure).toBeUndefined();
    expect(stored.scheduledPublishFailure).toBeUndefined();
  });

  it("refuses a caller with no action capability before reading content", async () => {
    const firestore = { runTransaction: vi.fn() };
    const handler = createCmsTransitionContentHandler({
      firestore,
      requirePrincipalFn: async () => ({
        uid: "contributor-1",
        principal: { id: "contributor-1", grants: [{ role: "contributor" }] },
      }),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "watch",
        baseVersion: 4,
        action: "unpublish",
      },
    }), res);

    expect(res.statusCode).toBe(403);
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });

  it.each(["archive", "restore"])(
    "refuses an editor attempting to %s before reading content",
    async (action) => {
      const firestore = { runTransaction: vi.fn() };
      const handler = createCmsTransitionContentHandler({
        firestore,
        requirePrincipalFn: editor,
      });
      const res = makeRes();

      await handler(makeReq({
        body: {
          collection: "cmsPosts",
          id: "record-1",
          baseVersion: 3,
          action,
        },
      }), res);

      expect(res.statusCode).toBe(403);
      expect(firestore.runTransaction).not.toHaveBeenCalled();
    },
  );

  it("unpublishes a page and commits complete history plus compact audit evidence", async () => {
    const before = publishedPage();
    await Promise.all([
      db.collection("cmsPages").doc("watch").set(before),
      db.collection("cmsPages/watch/mediaUsage").doc("published")
        .set(liveMediaUsage(4)),
    ]);

    const res = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "unpublish",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      collection: "cmsPages",
      id: "watch",
      action: "unpublish",
      fromStatus: "published",
      toStatus: "draft",
      version: 5,
      document: {
        status: "draft",
        version: 5,
        updatedAt: "2026-08-13T04:00:00.000Z",
        updatedBy: "editor-1",
        published: before.published,
      },
    });
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toEqual(
      expect.objectContaining({
        title: before.title,
        blocks: before.blocks,
        published: before.published,
        status: "draft",
        version: 5,
      }),
    );
    expect(await rows(db, "cmsVersionHistory")).toEqual([
      expect.objectContaining({
        collection: "cmsPages",
        documentId: "watch",
        action: "unpublish",
        before,
        after: expect.objectContaining({ status: "draft", version: 5 }),
      }),
    ]);
    expect(await rows(db, "admin_logs")).toEqual([
      expect.objectContaining({
        action: "cms.unpublish",
        target: "cmsPages/watch",
        before: { status: "published", version: 4 },
        after: { status: "draft", version: 5 },
      }),
    ]);
    expect((await db.collection("cmsPages/watch/mediaUsage").doc("published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 5,
        assetIds: [],
        occurrenceCount: 0,
      });
  });

  it("requests an exact withdrawal and preserves recovery when dispatch fails", async () => {
    await db.collection("cmsPages").doc("watch").set(publishedPage());
    const enqueuePublishBuildFn = vi.fn(async () => { throw new Error("Dispatch unavailable"); });
    const log = { error: vi.fn(), warn: vi.fn() };
    const res = await transition(db, {
      collection: "cmsPages", id: "watch", baseVersion: 4, action: "unpublish",
    }, { enqueuePublishBuildFn, log });
    expect(res.statusCode).toBe(200);
    expect(res.body.publication).toEqual({ status: "failed", queueId: null,
      errorId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(log.error.mock.calls).toEqual([
      ["Public withdrawal was not queued", { errorId: res.body.publication.errorId,
        errorType: "Error", errorCode: null }],
    ]);
    expect(enqueuePublishBuildFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ collection: "cmsPages", id: "watch", sourceVersion: 4, operation: "withdraw" }],
    }), expect.any(Object));
    const stored = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(stored).toMatchObject({ publiclyVisible: false, publishBuildPending: true, publishBuildQueueId: null });
    expect(stored.published).toEqual(publishedPage().published);
  });

  it.each([
    [{}, 500, "Error", null],
    [{ code: "failed-precondition" }, 503, "Error", "failed-precondition"],
    [{ status: 503, name: "Private request text", code: "provider /internal/request-fragment" }, 503, "unknown", null],
  ])("masks unexpected lifecycle errors with %j while keeping status %i", async (fields, status, errorType, errorCode) => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const failure = Object.assign(new Error("Provider detail: /internal/request-fragment"), fields);
    const handler = createCmsTransitionContentHandler({
      requirePrincipalFn: async () => { throw failure; },
      log,
    });
    const res = makeRes();
    await handler(makeReq({ body: { comment: "Private request text" } }), res);

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual({
      error: "The lifecycle change could not be completed.",
      errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(log.error.mock.calls).toEqual([
      ["cmsTransitionContent failed", { errorId: res.body.errorId, status, errorType, errorCode }],
    ]);
  });

  it.each(["draft", "in_review", "approved", "scheduled"])("withdraws an older public snapshot from working %s", async (status) => {
    const reviewRequest = reviewQueue.createReviewRequest({
      collection: "cmsPages", id: "watch",
      sourceVersion: 4, requestedBy: "original-writer",
      requestedAt: "2026-08-01T12:00:00.000Z",
    });
    const before = publishedPage({ status, publiclyVisible: true, title: "New working title",
      ...(status === "in_review" ? { reviewRequest } : {}),
      ...(status === "scheduled" ? { publishAt: "2030-01-01T00:00:00.000Z" } : {}),
    });
    await db.collection("cmsPages").doc("watch").set(before);
    const res = await transition(db, { collection: "cmsPages", id: "watch", baseVersion: 4, action: "unpublish" });
    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ status: status === "scheduled" ? "draft" : status, publiclyVisible: false,
      version: 5, title: "New working title", published: before.published });
    if (status === "in_review") {
      expect(res.body.document.reviewRequest).toEqual({ ...reviewRequest, sourceVersion: 5 });
    }
    expect(res.body.document.publishAt).toBeUndefined();
    expect(res.body.publication.status).toBe("queued");
  });

  it.each([
    ["cmsPages", "watch", publishedPage()],
    ["cmsPosts", "record-1", publishedRecord()],
  ])("unpublishes scheduled %s content to draft without implying approval", async (collection, id, current) => {
    // #2761: a scheduled working version may never have been approved.
    const before = {
      ...current,
      status: "scheduled",
      publiclyVisible: true,
      publishAt: "2030-01-01T00:00:00.000Z",
      version: 4,
    };
    await db.collection(collection).doc(id).set(before);
    const enqueuePublishBuildFn = vi.fn(async () => ({ queueId: "withdrawal-queue" }));

    const res = await transition(db, {
      collection, id, baseVersion: 4, action: "unpublish",
    }, { enqueuePublishBuildFn });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      fromStatus: "scheduled", toStatus: "draft", version: 5,
      document: { status: "draft", publiclyVisible: false, version: 5, published: before.published },
      publication: { status: "queued", queueId: "withdrawal-queue" },
    });
    expect(res.body.document).not.toHaveProperty("publishAt");
    const stored = (await db.collection(collection).doc(id).get()).data();
    expect(stored).toMatchObject({ status: "draft", publiclyVisible: false, version: 5, published: before.published });
    expect(stored).not.toHaveProperty("publishAt");
    expect(await rows(db, "cmsVersionHistory")).toEqual([
      expect.objectContaining({
        action: "unpublish", before,
        after: expect.objectContaining({ status: "draft", version: 5 }),
      }),
    ]);
    expect((await rows(db, "cmsVersionHistory"))[0].after).not.toHaveProperty("publishAt");
    expect(await rows(db, "admin_logs")).toEqual([
      expect.objectContaining({
        action: "cms.unpublish",
        before: { status: "scheduled", version: 4 },
        after: { status: "draft", version: 5 },
      }),
    ]);
    expect(enqueuePublishBuildFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ collection, id, sourceVersion: before.published.sourceVersion, operation: "withdraw" }],
    }), expect.any(Object));
  });

  it("keeps a safe bounded receipt when complete lifecycle history would be too large", async () => {
    const before = publishedPage({ legacyPayload: "x".repeat(600_000) });
    await db.collection("cmsPages").doc("watch").set(before);

    const res = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "unpublish",
    });

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages").doc("watch").get()).data())
      .toMatchObject({ status: "draft", version: 5, legacyPayload: before.legacyPayload });
    const [history] = await rows(db, "cmsVersionHistory");
    expect(history).toMatchObject({
      action: "unpublish",
      beforeTruncated: true,
      before: {
        id: "watch",
        status: "published",
        version: 4,
        beforeTruncated: true,
      },
      after: { status: "draft", version: 5, legacyPayload: before.legacyPayload },
    });
    expect(history.before.legacyPayload).toBeUndefined();
  });

  it.each(["draft", "in_review", "approved"])(
    "archives saved %s content",
    async (status) => {
      const reviewRequest = reviewQueue.createReviewRequest({
        collection: "cmsPosts",
        id: "record-1",
        sourceVersion: 3,
        requestedBy: "original-writer",
        requestedAt: "2026-08-01T12:00:00.000Z",
      });
      await db.collection("cmsPosts").doc("record-1").set(publishedRecord({
        status,
        ...(status === "in_review" ? { reviewRequest } : {}),
      }));

      const archived = await transition(db, {
        collection: "cmsPosts",
        id: "record-1",
        baseVersion: 3,
        action: "archive",
      }, { requirePrincipalFn: adminUser });

      expect(archived.statusCode).toBe(200);
      expect(archived.body).toMatchObject({
        fromStatus: status,
        toStatus: "archived",
        document: { status: "archived", version: 4 },
      });
      expect(archived.body.document.reviewRequest).toBeUndefined();
    },
  );

  it("preserves a confirmed public removal when archiving its draft", async () => {
    const record = publishedRecord({
      status: "draft",
      publiclyVisible: false,
      publicSourceVersion: null,
      publishBuildPending: false,
      publishBuildQueueId: null,
    });
    await db.collection("cmsPosts").doc("record-1").set(record);
    const enqueuePublishBuildFn = vi.fn(async () => ({ queueId: "new-removal" }));

    const archived = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "archive",
    }, { requirePrincipalFn: adminUser, enqueuePublishBuildFn });

    expect(archived.statusCode).toBe(200);
    expect(archived.body.document).toMatchObject({
      status: "archived",
      version: 4,
      publiclyVisible: false,
      publicSourceVersion: null,
      publishBuildPending: false,
      publishBuildQueueId: null,
      published: record.published,
    });
    expect(archived.body.publication).toBeUndefined();
    expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
  });

  it.each(["reserved", "pending", "publishing"])(
    "preserves the exact %s public withdrawal when archiving its draft",
    async (status) => {
      const queueId = "existing-removal";
      const record = publishedRecord({
        status: "draft",
        publiclyVisible: false,
        publicSourceVersion: 3,
        publishBuildPending: true,
        publishBuildQueueId: queueId,
      });
      await Promise.all([
        db.collection("cmsPosts").doc("record-1").set(record),
        db.collection("cmsPublishQueue").doc(queueId).set({
          status,
          changes: [{
            collection: "cmsPosts",
            id: "record-1",
            sourceVersion: 3,
            operation: "withdraw",
          }],
        }),
      ]);
      const enqueuePublishBuildFn = vi.fn(async () => ({ queueId: "new-removal" }));

      const archived = await transition(db, {
        collection: "cmsPosts",
        id: "record-1",
        baseVersion: 3,
        action: "archive",
      }, { requirePrincipalFn: adminUser, enqueuePublishBuildFn });

      expect(archived.statusCode).toBe(200);
      expect(archived.body.document).toMatchObject({
        status: "archived",
        version: 4,
        publiclyVisible: false,
        publicSourceVersion: 3,
        publishBuildPending: true,
        publishBuildQueueId: queueId,
        published: record.published,
      });
      expect(archived.body.publication).toEqual({ status: "queued", queueId });
      expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "an unrelated active queue",
      status: "pending",
      changes: [{
        collection: "cmsPosts",
        id: "another-record",
        sourceVersion: 3,
        operation: "withdraw",
      }],
    },
    {
      label: "a terminal queue",
      status: "failed",
      changes: [{
        collection: "cmsPosts",
        id: "record-1",
        sourceVersion: 3,
        operation: "withdraw",
      }],
    },
  ])("queues a new public withdrawal after $label", async ({ status, changes }) => {
    const record = publishedRecord({
      status: "draft",
      publiclyVisible: false,
      publicSourceVersion: 3,
      publishBuildPending: true,
      publishBuildQueueId: "existing-removal",
    });
    await Promise.all([
      db.collection("cmsPosts").doc("record-1").set(record),
      db.collection("cmsPublishQueue").doc("existing-removal").set({
        status,
        changes,
      }),
    ]);
    const enqueuePublishBuildFn = vi.fn(async () => ({ queueId: "new-removal" }));

    const archived = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "archive",
    }, { requirePrincipalFn: adminUser, enqueuePublishBuildFn });

    expect(archived.statusCode).toBe(200);
    expect(enqueuePublishBuildFn).toHaveBeenCalledOnce();
    expect(enqueuePublishBuildFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{
        collection: "cmsPosts",
        id: "record-1",
        sourceVersion: 3,
        operation: "withdraw",
      }],
    }), expect.any(Object));
    expect(archived.body.publication).toEqual({
      status: "queued",
      queueId: "new-removal",
    });
    expect(archived.body.document).toMatchObject({
      status: "archived",
      version: 4,
      publiclyVisible: false,
      publicSourceVersion: 3,
      publishBuildPending: true,
      publishBuildQueueId: "new-removal",
      published: record.published,
    });
  });

  it("archives scheduled content without restoring its schedule metadata", async () => {
    await db.collection("cmsPosts").doc("record-1").set(publishedRecord({
      status: "scheduled",
      scheduledPublishFailure: {
        failedAt: "2026-08-13T18:30:00.000Z",
        failedBy: "system:scheduler",
        reason: "The scheduled publication failed.",
      },
    }));

    const archived = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "archive",
    }, { requirePrincipalFn: adminUser });

    expect(archived.statusCode).toBe(200);
    expect(archived.body.document).toMatchObject({ status: "archived", version: 4 });
    expect(archived.body.document.publishAt).toBeUndefined();
    expect(archived.body.document.scheduledPublishFailure).toBeUndefined();

    const restored = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 4,
      action: "restore",
    }, { requirePrincipalFn: adminUser });

    expect(restored.statusCode).toBe(200);
    expect(restored.body.document).toMatchObject({ status: "draft", version: 5 });
    expect(restored.body.document.publishAt).toBeUndefined();
    expect(restored.body.document.scheduledPublishFailure).toBeUndefined();
  });

  it("archives a published record and restores the archived record to draft", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("record-1").set(publishedRecord()),
      db.collection("cmsPosts/record-1/mediaUsage").doc("published")
        .set(liveMediaUsage(3)),
    ]);

    const archived = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 3,
      action: "archive",
    }, { requirePrincipalFn: adminUser });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.document).toMatchObject({ status: "archived", version: 4 });
    expect((await db.collection("cmsPosts/record-1/mediaUsage").doc("published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 4,
        assetIds: [],
        occurrenceCount: 0,
      });

    const restored = await transition(db, {
      collection: "cmsPosts",
      id: "record-1",
      baseVersion: 4,
      action: "restore",
    }, { requirePrincipalFn: adminUser });
    expect(restored.statusCode).toBe(200);
    expect(restored.body.document).toMatchObject({ status: "draft", version: 5 });
    expect((await db.collection("cmsPosts").doc("record-1").get()).data())
      .toMatchObject({ status: "draft", version: 5 });
    expect((await rows(db, "cmsVersionHistory")).map((row) => row.action).sort())
      .toEqual(["archive", "restore"]);
    expect((await rows(db, "admin_logs")).map((row) => row.action).sort())
      .toEqual(["cms.archive", "cms.restore"]);
    expect((await db.collection("cmsPosts/record-1/mediaUsage").doc("published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 4,
        assetIds: [],
        occurrenceCount: 0,
      });
  });

  it("rejects stale, missing, deleted, malformed, and illegal transitions without writes", async () => {
    await Promise.all([
      db.collection("cmsPages").doc("watch").set(publishedPage()),
      db.collection("cmsPages").doc("home").set(publishedPage({
        id: "home",
        template: "home",
        deleted: true,
        version: 2,
      })),
      db.collection("cmsPosts").doc("draft-record").set(publishedRecord({
        id: "draft-record",
        status: "draft",
        version: 7,
      })),
      db.collection("cmsPosts").doc("bad-version").set(publishedRecord({
        id: "bad-version",
        version: "3",
      })),
      db.collection("cmsPosts").doc("bad-kind").set(publishedRecord({
        id: "bad-kind",
        type: "mystery",
      })),
    ]);

    const cases = [
      [{ collection: "cmsPages", id: "watch", baseVersion: 3, action: "unpublish" }, 409],
      [{ collection: "cmsPages", id: "missing", baseVersion: 1, action: "unpublish" }, 404],
      [{ collection: "cmsPages", id: "home", baseVersion: 2, action: "unpublish" }, 404],
      [{ collection: "cmsPosts", id: "draft-record", baseVersion: 7, action: "unpublish" }, 409],
      [
        { collection: "cmsPages", id: "watch", baseVersion: 3, action: "archive" },
        409,
        { requirePrincipalFn: adminUser },
      ],
      [
        { collection: "cmsPosts", id: "draft-record", baseVersion: 7, action: "restore" },
        409,
        { requirePrincipalFn: adminUser },
      ],
      [
        { collection: "cmsPosts", id: "bad-version", baseVersion: 3, action: "archive" },
        409,
        { requirePrincipalFn: adminUser },
      ],
      [
        { collection: "cmsPosts", id: "bad-kind", baseVersion: 3, action: "archive" },
        404,
        { requirePrincipalFn: adminUser },
      ],
    ];

    for (const [body, expectedStatus, deps] of cases) {
      const res = await transition(db, body, deps);
      expect(res.statusCode, JSON.stringify(body)).toBe(expectedStatus);
    }

    expect((await db.collection("cmsPages").doc("watch").get()).data()).toEqual(
      publishedPage(),
    );
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });

  it("scopes a lifecycle transition to the page's own public area (#845)", async () => {
    // A canonical page's editorial desk is server-owned: /watch/ is the watch desk and
    // /support/ is the support desk, whatever the stored document says. Before section
    // enforcement a scoped grant could not transition any page at all, because the
    // resource stated no desk to match. It can now transition the pages in its own area
    // and still nothing else -- and a page id nobody may reach answers the same way
    // whether or not it exists, so the endpoint stays a non-oracle.
    await db.collection("cmsPages").doc("watch").set(publishedPage());
    await db
      .collection("cmsPages")
      .doc("support")
      .set(publishedPage({ id: "support", template: "support" }));
    const scopedEditor = async () => ({
      uid: "editor-1",
      principal: {
        id: "editor-1",
        grants: [{ role: "editor", sections: ["watch"] }],
      },
    });

    const outOfArea = await transition(db, {
      collection: "cmsPages",
      id: "support",
      baseVersion: 4,
      action: "unpublish",
    }, { requirePrincipalFn: scopedEditor });
    expect(outOfArea.statusCode, "support").toBe(403);

    const missing = await transition(db, {
      collection: "cmsPages",
      id: "missing",
      baseVersion: 4,
      action: "unpublish",
    }, { requirePrincipalFn: scopedEditor });
    expect(missing.statusCode, "missing").toBe(403);

    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);

    const inArea = await transition(db, {
      collection: "cmsPages",
      id: "watch",
      baseVersion: 4,
      action: "unpublish",
    }, { requirePrincipalFn: scopedEditor });
    expect(inArea.statusCode, "watch").toBe(200);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
  });

  it("refuses a scoped grant a record that carries no desk", async () => {
    // A record stored before the registry existed is outside every scope until a backfill
    // puts it in one. Deny-by-default, not "available to everyone".
    await db.collection("cmsPosts").doc("a-1").set({
      id: "a-1",
      type: "article",
      title: "Legacy",
      status: "published",
      published: { sourceVersion: 2, title: "Legacy" },
      createdBy: "author-1",
      version: 2,
    });
    const scopedEditor = async () => ({
      uid: "editor-1",
      principal: {
        id: "editor-1",
        grants: [{ role: "editor", sections: ["watch"] }],
      },
    });

    const res = await transition(db, {
      collection: "cmsPosts",
      id: "a-1",
      baseVersion: 2,
      action: "unpublish",
    }, { requirePrincipalFn: scopedEditor });

    expect(res.statusCode).toBe(403);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
  });

  it("serves the exported endpoint through real auth and Firestore wiring", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "lifecycle-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "lifecycle-editor@example.com", "password123",
    );
    const uid = credential.user.uid;
    await Promise.all([
      db.collection("users").doc(uid).set({
        role: null,
        grants: [{ role: "editor" }],
      }),
      db.collection("cmsPages").doc("watch").set(publishedPage()),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsTransitionContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        collection: "cmsPages",
        id: "watch",
        baseVersion: 4,
        action: "unpublish",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      action: "unpublish",
      document: { status: "draft", updatedBy: uid, version: 5 },
    });
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(1);
    expect((await rows(db, "admin_logs")).map((entry) => entry.action).sort()).toEqual([
      "cms.publish", "cms.unpublish",
    ]);
    expect(await rows(db, "cmsPublishQueue")).toEqual([
      expect.objectContaining({ changes: [
        { collection: "cmsPages", id: "watch", sourceVersion: 4, operation: "withdraw" },
      ] }),
    ]);
  }, 20_000);

  it("rejects an unauthenticated exported request without changing content", async () => {
    const before = publishedPage();
    await db.collection("cmsPages").doc("watch").set(before);

    const response = await fetch(fnUrl("cmsTransitionContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collection: "cmsPages",
        id: "watch",
        baseVersion: 4,
        action: "unpublish",
      }),
    });

    expect(response.status).toBe(401);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toEqual(before);
    expect(await rows(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await rows(db, "admin_logs")).toHaveLength(0);
  });
});

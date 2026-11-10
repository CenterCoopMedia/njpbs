import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { inspect } from "node:util";
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
import bulkArchive from "../../functions/bulk-archive.js";
import audit from "../../functions/lib/audit.js";
import reviewQueue from "../../functions/lib/review-queue.js";

const {
  createCmsBulkArchiveHandler,
  validateBulkArchiveItems,
} = bulkArchive;
const { adminLogEntry } = audit;
const { reviewRequestId } = reviewQueue;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, ip: "203.0.113.11" };
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

async function docsIn(db, collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

describe("cmsBulkArchiveContent", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "bulk-archive-test",
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
    await db.collection("users").doc("admin-1").set({
      role: "admin",
      active: true,
    });
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("archives a record of a retired kind, which is the triage path the retirement keeps", async () => {
    // The counterpart to the lifecycle refusals: a record stored before the Article
    // retirement (#1039) is still selectable and still archivable, so staff can take
    // it out of circulation without an editor route.
    await db.collection("cmsPosts").doc("legacy-article").set({
      id: "legacy-article",
      type: "article",
      title: "A story saved before the retirement",
      status: "draft",
      version: 2,
    });
    const handler = createCmsBulkArchiveHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      now: () => "2026-08-01T12:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({ body: { items: [{ id: "legacy-article", baseVersion: 2 }] } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.outcomes).toEqual([
      { id: "legacy-article", status: "archived", version: 3 },
    ]);
    expect((await db.collection("cmsPosts").doc("legacy-article").get()).data())
      .toMatchObject({ status: "archived", version: 3 });
  });

  it("rejects unsupported methods without authenticating", async () => {
    const requireAdminFn = vi.fn();
    const handler = createCmsBulkArchiveHandler({ requireAdminFn });
    const res = makeRes();

    await handler(makeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(requireAdminFn).not.toHaveBeenCalled();
  });

  it("queues one removal batch and reports dispatch failure without undoing archive", async () => {
    for (const id of ["first", "second"]) {
      await db.collection("cmsPosts").doc(id).set({ type: "post", status: "draft", version: 7,
        publiclyVisible: true, title: "New draft", published: { sourceVersion: 4 } });
    }
    const enqueuePublishBuildFn = vi.fn(async () => { throw new Error("Dispatch unavailable"); });
    const handler = createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }), enqueuePublishBuildFn,
      log: { error: vi.fn() } });
    const res = makeRes();
    await handler(makeReq({ body: { items: ["first", "second"].map((id) => ({ id, baseVersion: 7 })) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.counts.archived).toBe(2);
    expect(enqueuePublishBuildFn).toHaveBeenCalledOnce();
    expect(enqueuePublishBuildFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: ["first", "second"].map((id) => ({ collection: "cmsPosts", id, sourceVersion: 4, operation: "withdraw" })),
    }), expect.any(Object));
    for (const outcome of res.body.outcomes) {
      expect(outcome.publication).toEqual({ status: "failed", queueId: null });
      expect((await db.collection("cmsPosts").doc(outcome.id).get()).data()).toMatchObject({
        status: "archived", publiclyVisible: false, version: 8, title: "New draft",
        published: { sourceVersion: 4 }, publishBuildPending: true, publishBuildQueueId: null,
      });
    }
  });

  it("returns the safe publication refusal for one item while another archives", async () => {
    await db.doc("system/cmsPublicationRuntime").set({
      schemaVersion: 1, phase: "paused", commitSha: "a".repeat(40), serializerId: "node-compute-primary",
    });
    await db.doc("cmsPosts/live").set({ type: "post", title: "Live story", status: "published", version: 7,
      publiclyVisible: true, published: { sourceVersion: 7 } });
    await db.doc("cmsPosts/draft").set({ type: "post", title: "Draft story", status: "draft", version: 2 });
    const handler = createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }), log: { error: vi.fn() } });
    const res = makeRes();

    await handler(makeReq({ body: { items: [{ id: "live", baseVersion: 7 }, { id: "draft", baseVersion: 2 }] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.outcomes).toEqual([
      { id: "live", status: "failed", message: "CMS publication is paused for a serializer handoff" },
      { id: "draft", status: "archived", version: 3 },
    ]);
    expect(res.body.counts).toMatchObject({ failed: 1, archived: 1 });
    expect((await db.doc("cmsPosts/live").get()).data()).toMatchObject({ status: "published", version: 7, publiclyVisible: true });
    expect((await db.doc("cmsPosts/draft").get()).data()).toMatchObject({ status: "archived", version: 3 });
  });

  it("returns a controlled build-free 409 refusal without changing the live item", async () => {
    await db.doc("system/publicDeployment/controls/serializer").set({ schemaVersion: 1, enabled: false });
    await db.doc("cmsPosts/live").set({ type: "post", title: "Live story", status: "published", version: 7,
      publiclyVisible: true, published: { sourceVersion: 7 } });
    const handler = createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }), log: { error: vi.fn() } });
    const res = makeRes();

    await handler(makeReq({ body: { items: [{ id: "live", baseVersion: 7 }] } }), res);

    expect(res.body.outcomes).toEqual([{ id: "live", status: "failed",
      message: "This Post's public removal has no build-free path. The full-site build was retired on October 13, 2026. Ask an administrator." }]);
    expect((await db.doc("cmsPosts/live").get()).data()).toMatchObject({ status: "published", version: 7, publiclyVisible: true });
  });

  it.each([
    { providerCode: undefined, diagnosticCode: "unknown", causes: [{ name: "Error", status: 409 }] },
    { providerCode: 14, diagnosticCode: 14, causes: [{ name: "Error", code: 14, status: 409 }] },
  ])("keeps provider details private and records bounded diagnostic code $diagnosticCode", async ({ providerCode, diagnosticCode, causes }) => {
    for (const id of ["refused", "draft"]) await db.doc(`cmsPosts/${id}`).set({ type: "post", status: "draft", version: 1 });
    const privateDetail = "synthetic-provider-secret-do-not-disclose";
    let first = true;
    const firestore = { collection: db.collection.bind(db),
      runTransaction: async (run) => {
        if (first) {
          first = false;
          throw Object.assign(new Error(privateDetail), { status: 409,
            ...(providerCode === undefined ? {} : { code: providerCode }) });
        }
        return db.runTransaction(run);
      } };
    const log = { error: vi.fn() };
    const handler = createCmsBulkArchiveHandler({ firestore,
      requireAdminFn: async () => ({ uid: "admin-1" }), log });
    const res = makeRes();

    await handler(makeReq({ body: { items: [{ id: "refused", baseVersion: 1 }, { id: "draft", baseVersion: 1 }] } }), res);

    expect(res.body.outcomes).toEqual([
      { id: "refused", status: "failed" },
      { id: "draft", status: "archived", version: 2 },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(privateDetail);
    expect(inspect(log.error.mock.calls, { depth: null })).not.toContain(privateDetail);
    expect(log.error).toHaveBeenCalledWith("cmsBulkArchiveContent item failed",
      { recordId: "refused", code: diagnosticCode, causes });
    expect((await db.doc("cmsPosts/refused").get()).data()).toMatchObject({ status: "draft", version: 1 });
  });

  it.each([
    { code: "library_card_publication_replaced", cause: { name: "Error", status: 409 } },
    { code: "library_card_publication_unavailable", cause: { name: "Error", status: 409 } },
    { code: "library_publication_unavailable", cause: { name: "Error", status: 409 } },
    { code: "post_publication_unavailable", cause: { name: "Error", status: 409 } },
    { code: "record_publication_replaced",
      cause: { name: "Error", code: "record_publication_replaced", status: 409 } },
    { code: "record_publication_unavailable",
      cause: { name: "Error", code: "record_publication_unavailable", status: 409 } },
  ])("returns the controlled $code owner refusal", async ({ code, cause }) => {
    const message = `Safe ${code} refusal`;
    const firestore = { collection: db.collection.bind(db),
      runTransaction: async () => { throw Object.assign(new Error(message), { status: 409, code }); } };
    const log = { error: vi.fn() };
    const handler = createCmsBulkArchiveHandler({ firestore,
      requireAdminFn: async () => ({ uid: "admin-1" }), log });
    const res = makeRes();

    await handler(makeReq({ body: { items: [{ id: "refused", baseVersion: 1 }] } }), res);

    expect(res.body.outcomes).toEqual([{ id: "refused", status: "failed", message }]);
    expect(log.error).toHaveBeenCalledWith("cmsBulkArchiveContent item failed",
      { recordId: "refused", code, causes: [cause] });
  });

  it("keeps the specific withdrawal repair message and hides a spoofed serializer message", async () => {
    const repair = "This Post's public removal needs a background repair that the retired full-site build used to do. Ask an administrator.";
    const privateDetail = "synthetic-provider-secret-do-not-disclose";
    const failures = [repair, privateDetail];
    const firestore = { collection: db.collection.bind(db),
      runTransaction: async () => { throw Object.assign(new Error(failures.shift()), {
        status: 409, code: "serializer_publication_unavailable",
      }); } };
    const log = { error: vi.fn() };
    const handler = createCmsBulkArchiveHandler({ firestore,
      requireAdminFn: async () => ({ uid: "admin-1" }), log });
    const res = makeRes();

    await handler(makeReq({ body: { items: [
      { id: "repair", baseVersion: 1 }, { id: "spoofed", baseVersion: 1 },
    ] } }), res);

    expect(res.body.outcomes).toEqual([
      { id: "repair", status: "failed", message: repair },
      { id: "spoofed", status: "failed" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(privateDetail);
    expect(inspect(log.error.mock.calls, { depth: null })).not.toContain(privateDetail);
  });

  it.each(["offline", "reserved", "pending", "publishing", "failed"])("preserves %s removal state while archiving", async (state) => {
    const pending = state !== "offline";
    const record = { type: "post", status: "draft", version: 7, publiclyVisible: false,
      published: { sourceVersion: 4 }, publicSourceVersion: pending ? 4 : null,
      publishBuildPending: pending, publishBuildQueueId: pending ? "existing-removal" : null };
    await db.collection("cmsPosts").doc("removed").set(record);
    if (pending) await db.collection("cmsPublishQueue").doc("existing-removal").set({
      status: state, changes: [{ collection: "cmsPosts", id: "removed", sourceVersion: 4, operation: "withdraw" }],
    });
    const enqueuePublishBuildFn = vi.fn(async () => ({ queueId: "new-removal" }));
    const handler = createCmsBulkArchiveHandler({ firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }), enqueuePublishBuildFn,
      log: { error: vi.fn() } });
    const res = makeRes();
    await handler(makeReq({ body: { items: [{ id: "removed", baseVersion: 7 }] } }), res);
    expect(res.statusCode).toBe(200);
    expect(enqueuePublishBuildFn).toHaveBeenCalledTimes(state === "failed" ? 1 : 0);
    const stored = (await db.collection("cmsPosts").doc("removed").get()).data();
    expect(stored).toMatchObject({ status: "archived", version: 8, publiclyVisible: false, published: record.published,
      publishBuildQueueId: state === "failed" ? null : record.publishBuildQueueId });
    if (pending) expect(res.body.outcomes[0].publication).toEqual({ status: "queued",
      queueId: state === "failed" ? "new-removal" : "existing-removal" });
    else expect(res.body.outcomes[0].publication).toBeUndefined();
  });

  it("validates a unique, page-bounded set of exact record versions", () => {
    expect(validateBulkArchiveItems(undefined)).toBe("items must be an array");
    expect(validateBulkArchiveItems([])).toBe("items must contain at least one record");
    expect(
      validateBulkArchiveItems(
        Array.from({ length: 26 }, (_, index) => ({
          id: `record-${index}`,
          baseVersion: 1,
        })),
      ),
    ).toBe("items cannot contain more than 25 records");
    expect(validateBulkArchiveItems([{ id: "bad/path", baseVersion: 1 }])).toMatch(
      /document id/,
    );
    expect(validateBulkArchiveItems([{ id: " padded", baseVersion: 1 }])).toMatch(
      /document id/,
    );
    expect(validateBulkArchiveItems([{ id: "__reserved__", baseVersion: 1 }])).toMatch(
      /document id/,
    );
    expect(
      validateBulkArchiveItems([{ id: "é".repeat(751), baseVersion: 1 }]),
    ).toMatch(/document id/);
    expect(validateBulkArchiveItems([{ id: "record", baseVersion: 0 }])).toMatch(
      /positive safe integer/,
    );
    expect(
      validateBulkArchiveItems([
        { id: "record", baseVersion: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toMatch(/positive safe integer/);
    expect(
      validateBulkArchiveItems([
        { id: "record", baseVersion: 1 },
        { id: "record", baseVersion: 1 },
      ]),
    ).toBe("items contains duplicate record id record");
    expect(validateBulkArchiveItems([{ id: "record", baseVersion: 1 }])).toBeNull();
  });

  it("archives current rows atomically while reporting stale, hidden, and already archived rows", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("current").set({
        id: "current",
        type: "article",
        title: "Current draft",
        status: "draft",
        publiclyVisible: true,
        version: 2,
      }),
      db
        .collection("cmsPosts/current/mediaUsage")
        .doc("published")
        .set({
          state: "published",
          sourceVersion: 2,
          assetIds: ["live-image"],
          occurrenceCount: 1,
        }),
      db.collection("cmsPosts").doc("stale").set({
        id: "stale",
        type: "program",
        title: "Changed program",
        status: "published",
        version: 4,
      }),
      db.collection("cmsPosts").doc("archived").set({
        id: "archived",
        type: "post",
        title: "Archived post",
        status: "archived",
        version: 5,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      db.collection("cmsPosts").doc("deleted").set({
        id: "deleted",
        type: "article",
        title: "Deleted article",
        status: "draft",
        deleted: true,
        version: 1,
      }),
      db.collection("cmsPosts").doc("unknown-kind").set({
        id: "unknown-kind",
        type: "mystery",
        title: "Unknown",
        status: "draft",
        version: 1,
      }),
      db.collection("cmsPosts").doc("legacy").set({
        id: "legacy",
        type: "article",
        title: "Legacy article",
        status: "draft",
      }),
      db.collection("cmsPosts").doc("malformed-archived").set({
        id: "malformed-archived",
        type: "post",
        title: "Malformed archived post",
        status: "archived",
        version: "5",
      }),
    ]);
    const handler = createCmsBulkArchiveHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      now: () => "2026-07-22T22:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          items: [
            { id: "current", baseVersion: 2 },
            { id: "stale", baseVersion: 3 },
            // The record was archived after this caller loaded version 4. Reaching the requested
            // terminal state is idempotent, not a conflict, even though its version advanced.
            { id: "archived", baseVersion: 4 },
            { id: "deleted", baseVersion: 1 },
            { id: "unknown-kind", baseVersion: 1 },
            { id: "missing", baseVersion: 1 },
            { id: "legacy", baseVersion: 1 },
            { id: "malformed-archived", baseVersion: 5 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      outcomes: [
        { id: "current", status: "archived", version: 3 },
        { id: "stale", status: "conflict" },
        { id: "archived", status: "already_archived", version: 5 },
        { id: "deleted", status: "missing" },
        { id: "unknown-kind", status: "missing" },
        { id: "missing", status: "missing" },
        { id: "legacy", status: "conflict" },
        { id: "malformed-archived", status: "conflict" },
      ],
      counts: {
        archived: 1,
        already_archived: 1,
        conflict: 3,
        missing: 3,
        failed: 0,
      },
    });
    await expect(db.collection("cmsPosts").doc("current").get()).resolves.toMatchObject({
      exists: true,
    });
    expect((await db.collection("cmsPosts").doc("current").get()).data()).toMatchObject({
      status: "archived",
      publiclyVisible: false,
      version: 3,
      updatedAt: "2026-07-22T22:00:00.000Z",
      updatedBy: "admin-1",
    });
    expect((await db.collection("cmsPosts").doc("stale").get()).data()).toMatchObject({
      status: "published",
      version: 4,
    });
    expect((await db.collection("cmsPosts").doc("archived").get()).data()).toMatchObject({
      version: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const versions = await docsIn(db, "cmsVersionHistory");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      collection: "cmsPosts",
      documentId: "current",
      action: "archive",
      before: { status: "draft", version: 2 },
      after: { status: "archived", version: 3 },
    });
    const logs = await docsIn(db, "admin_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorUid: "admin-1",
      action: "cms.bulk_archive",
      target: "cmsPosts/current",
      before: { status: "draft", version: 2 },
      after: { status: "archived", version: 3 },
    });
    expect(
      (
        await db
          .collection("cmsPosts/current/mediaUsage")
          .doc("published")
          .get()
      ).data(),
    ).toEqual({
      state: "published",
      sourceVersion: 3,
      assetIds: [],
      occurrenceCount: 0,
    });
  });

  // The reviewRequest envelope is server-owned lifecycle state that only exists while a record is
  // in review, and archiving ends the review. cmsTransitionContent already drops it on the way
  // out; bulk archive spreads the stored document, so without this it carries a request past the
  // review it belongs to. A later restore starts from `archived`, so nothing downstream would
  // ever clear it.
  it("clears the review request envelope when it archives an in-review record", async () => {
    await db
      .collection("cmsPosts")
      .doc("submitted")
      .set({
        id: "submitted",
        type: "article",
        title: "Submitted article",
        status: "in_review",
        publiclyVisible: false,
        version: 3,
        reviewRequest: {
          requestId: reviewRequestId("cmsPosts", "submitted"),
          collection: "cmsPosts",
          recordId: "submitted",
          state: "in_review",
          sourceVersion: 3,
          requestedBy: "editor-1",
          requestedAt: "2026-07-21T12:00:00.000Z",
        },
      });
    const handler = createCmsBulkArchiveHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      now: () => "2026-07-22T22:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({ body: { items: [{ id: "submitted", baseVersion: 3 }] } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.outcomes).toEqual([
      { id: "submitted", status: "archived", version: 4 },
    ]);
    const stored = (
      await db.collection("cmsPosts").doc("submitted").get()
    ).data();
    expect(stored.status).toBe("archived");
    expect(stored.version).toBe(4);
    expect(stored.reviewRequest).toBeUndefined();
    // The audit trail keeps the evidence the record no longer carries: the before snapshot still
    // shows the request that was open when the archive happened.
    const [history] = await docsIn(db, "cmsVersionHistory");
    expect(history.before.reviewRequest).toMatchObject({
      requestedBy: "editor-1",
      sourceVersion: 3,
    });
    expect(history.after.reviewRequest).toBeUndefined();
  });

  it("isolates an unexpected per-record failure and continues the remaining transactions", async () => {
    await Promise.all(
      ["fails", "succeeds"].map((id) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "article",
          title: id,
          status: "draft",
          version: 1,
        }),
      ),
    );
    const log = { error: vi.fn() };
    const handler = createCmsBulkArchiveHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }),
      adminLogEntryFn: (fields) => {
        if (fields.target === "cmsPosts/fails") throw new Error("audit unavailable");
        return adminLogEntry(fields);
      },
      now: () => "2026-07-22T22:00:00.000Z",
      log,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          items: [
            { id: "fails", baseVersion: 1 },
            { id: "succeeds", baseVersion: 1 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.outcomes).toEqual([
      { id: "fails", status: "failed" },
      { id: "succeeds", status: "archived", version: 2 },
    ]);
    expect((await db.collection("cmsPosts").doc("fails").get()).data()).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect((await db.collection("cmsPosts").doc("succeeds").get()).data()).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect(log.error).toHaveBeenCalledWith(
      "cmsBulkArchiveContent item failed",
      expect.objectContaining({ recordId: "fails" }),
    );
  });

  it("rechecks the administrator role in each record transaction", async () => {
    await Promise.all([
      ...["first", "second"].map((id) =>
        db.collection("cmsPosts").doc(id).set({
          id,
          type: "article",
          title: id,
          status: "draft",
          version: 1,
        }),
      ),
    ]);
    let transactionCount = 0;
    const firestore = {
      collection: db.collection.bind(db),
      runTransaction: async (updateFunction) => {
        transactionCount += 1;
        if (transactionCount === 2) {
          await db.collection("users").doc("admin-1").update({ role: null });
        }
        return db.runTransaction(updateFunction);
      },
    };
    const log = { error: vi.fn() };
    const handler = createCmsBulkArchiveHandler({
      firestore,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      log,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          items: [
            { id: "first", baseVersion: 1 },
            { id: "second", baseVersion: 1 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.outcomes).toEqual([
      { id: "first", status: "archived", version: 2 },
      { id: "second", status: "failed" },
    ]);
    expect((await db.collection("cmsPosts").doc("first").get()).data()).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect((await db.collection("cmsPosts").doc("second").get()).data()).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn(db, "admin_logs")).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith("cmsBulkArchiveContent item failed", {
      recordId: "second",
      code: "unknown",
      causes: [{ name: "Error", status: 403 }],
    });
    expect(inspect(log.error.mock.calls, { depth: null })).not.toContain("Content deletion access is required");
  });

  it("serves the exported endpoint with real auth, Firestore, and audit writes", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "bulk-admin@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "bulk-admin@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({ role: "admin", grants: [] });
    await db.collection("cmsPosts").doc("record").set({
      id: "record",
      type: "article",
      title: "Record",
      status: "draft",
      version: 7,
    });
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsBulkArchiveContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [{ id: "record", baseVersion: 7 }] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      outcomes: [{ id: "record", status: "archived", version: 8 }],
    });
    expect((await db.collection("cmsPosts").doc("record").get()).data()).toMatchObject({
      status: "archived",
      updatedBy: uid,
      version: 8,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn(db, "admin_logs")).toHaveLength(1);
  }, 20_000);

  it("rejects an unauthenticated request at the exported endpoint", async () => {
    const response = await fetch(fnUrl("cmsBulkArchiveContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: "record", baseVersion: 1 }] }),
    });

    expect(response.status).toBe(401);
    expect(await docsIn(db, "cmsPosts")).toHaveLength(0);
  }, 20_000);

  it("rejects a signed-in non-admin at the exported endpoint", async () => {
    await admin.auth().createUser({
      email: "bulk-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "bulk-editor@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({ role: "editor", grants: [] });
    await db.collection("cmsPosts").doc("record").set({
      id: "record",
      type: "article",
      title: "Record",
      status: "draft",
      version: 1,
    });
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsBulkArchiveContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [{ id: "record", baseVersion: 1 }] }),
    });

    expect(response.status).toBe(403);
    expect((await db.collection("cmsPosts").doc("record").get()).data()).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn(db, "admin_logs")).toHaveLength(0);
  }, 20_000);
});

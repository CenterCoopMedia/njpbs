import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";
import assignment from "../../functions/assign-content.js";
import reviewQueue from "../../functions/lib/review-queue.js";

const {
  createCmsAssignContentHandler,
  isAssignableUser,
  validateAssignmentRequest,
} = assignment;
const { createReviewRequest } = reviewQueue;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, ip: "203.0.113.17" };
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

describe("cmsAssignContent", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "assign-content-test",
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

  it("rejects unsupported methods before authentication", async () => {
    let authenticated = false;
    const handler = createCmsAssignContentHandler({
      requireAdminFn: async () => {
        authenticated = true;
        return { uid: "admin-1" };
      },
    });
    const res = makeRes();

    await handler(makeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(authenticated).toBe(false);
  });

  it("validates one exact record version and an assignee uid or null", () => {
    expect(validateAssignmentRequest({})).toBe("id must be a bounded Firestore document id");
    expect(validateAssignmentRequest({ id: "bad/path", baseVersion: 1, assignee: null }))
      .toBe("id must be a bounded Firestore document id");
    expect(validateAssignmentRequest({ id: "record", baseVersion: 0, assignee: null }))
      .toBe("baseVersion must be a positive safe integer");
    expect(validateAssignmentRequest({ id: "record", baseVersion: 1 }))
      .toBe("assignee must be a bounded Firestore document id or null");
    expect(validateAssignmentRequest({ id: "record", baseVersion: 1, assignee: "" }))
      .toBe("assignee must be a bounded Firestore document id or null");
    expect(validateAssignmentRequest({
      id: "record",
      baseVersion: 1,
      assignee: "editor-1",
    })).toBeNull();
    expect(validateAssignmentRequest({
      id: "record",
      baseVersion: 1,
      assignee: null,
    })).toBeNull();
  });

  it("recognizes only CMS users who hold a content role", () => {
    expect(isAssignableUser({ role: "admin", grants: [] })).toBe(true);
    expect(isAssignableUser({ role: "super_admin", grants: [] })).toBe(true);
    expect(isAssignableUser({ active: false, role: "admin", grants: [] })).toBe(false);
    expect(isAssignableUser({ role: null, grants: [{ role: "editor", sections: ["news"] }] }))
      .toBe(true);
    expect(isAssignableUser({ role: null, grants: [{ role: "contributor" }] })).toBe(true);
    expect(isAssignableUser({ role: "editor", grants: [] })).toBe(false);
    expect(isAssignableUser({ role: null, grants: [{ role: "viewer" }] })).toBe(false);
    expect(isAssignableUser(null)).toBe(false);
  });

  it("refuses to change the assignment of a record of a retired kind", async () => {
    // Assignment routes work to a person. A retired kind (#1039) has no editor route,
    // so an assignee could never open it: accepting the write would promise someone
    // work they cannot do. The record keeps whatever assignee it already had.
    await Promise.all([
      db.collection("cmsPosts").doc("record").set({
        id: "record",
        type: "article",
        title: "Shore report",
        status: "draft",
        assignee: "editor-2",
        updatedAt: "2026-07-20T15:00:00.000Z",
        updatedBy: "editor-before",
        version: 3,
      }),
      db.collection("users").doc("editor-1").set({
        email: "editor@example.com",
        displayName: "Editorial User",
        role: null,
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    ]);
    const handler = createCmsAssignContentHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      now: () => "2026-07-23T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({ body: { id: "record", baseVersion: 3, assignee: "editor-1" } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "The Article type was retired. This record can only be archived.",
    );
    const stored = (await db.collection("cmsPosts").doc("record").get()).data();
    expect(stored.assignee).toBe("editor-2");
    expect(stored.version).toBe(3);
  });

  it("assigns a current record and commits its history and audit rows atomically", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("record").set({
        id: "record",
        type: "post",
        title: "Shore report",
        status: "draft",
        updatedAt: "2026-07-20T15:00:00.000Z",
        updatedBy: "editor-before",
        version: 3,
      }),
      db.collection("users").doc("editor-1").set({
        email: "editor@example.com",
        displayName: "Editorial User",
        role: null,
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    ]);
    const handler = createCmsAssignContentHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1", email: "admin@example.com" }),
      now: () => "2026-07-23T14:00:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      body: { id: "record", baseVersion: 3, assignee: "editor-1" },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      id: "record",
      document: {
        assignee: "editor-1",
        updatedAt: "2026-07-23T14:00:00.000Z",
        updatedBy: "admin-1",
        version: 4,
      },
    });
    expect((await db.collection("cmsPosts").doc("record").get()).data()).toMatchObject({
      assignee: "editor-1",
      updatedBy: "admin-1",
      version: 4,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toEqual([
      expect.objectContaining({
        collection: "cmsPosts",
        documentId: "record",
        action: "assign",
        before: expect.objectContaining({ version: 3 }),
        after: expect.objectContaining({ assignee: "editor-1", version: 4 }),
      }),
    ]);
    expect(await docsIn(db, "admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "admin-1",
        action: "cms.assign",
        target: "cmsPosts/record",
        before: { assignee: null, version: 3 },
        after: { assignee: "editor-1", version: 4 },
      }),
    ]);
  });

  it("unassigns with null instead of overloading last-editor metadata", async () => {
    await db.collection("cmsPosts").doc("record").set({
      id: "record",
      type: "program",
      title: "Garden State",
      status: "in_review",
      assignee: "editor-1",
      updatedBy: "editor-before",
      version: 5,
      reviewRequest: createReviewRequest({
        collection: "cmsPosts",
        id: "record",
        sourceVersion: 5,
        requestedBy: "author-1",
        requestedAt: "2026-07-23T13:00:00.000Z",
      }),
    });
    const handler = createCmsAssignContentHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }),
      now: () => "2026-07-23T14:30:00.000Z",
    });
    const res = makeRes();

    await handler(makeReq({
      body: { id: "record", baseVersion: 5, assignee: null },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      assignee: null,
      updatedBy: "admin-1",
      version: 6,
      reviewRequest: {
        sourceVersion: 6,
        requestedBy: "author-1",
        requestedAt: "2026-07-23T13:00:00.000Z",
      },
    });
  });

  it("refuses stale, missing, hidden, malformed, and ineligible targets without writes", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("stale").set({
        type: "post",
        status: "draft",
        version: 4,
      }),
      db.collection("cmsPosts").doc("deleted").set({
        type: "post",
        status: "draft",
        deleted: true,
        version: 1,
      }),
      db.collection("cmsPosts").doc("malformed").set({
        type: "post",
        status: "draft",
        version: "1",
      }),
      db.collection("cmsPosts").doc("published").set({
        type: "post",
        status: "published",
        assignee: null,
        version: 2,
      }),
      db.collection("cmsPosts").doc("archived").set({
        type: "program",
        status: "archived",
        assignee: "editor-1",
        version: 6,
      }),
      db.collection("users").doc("viewer-1").set({
        role: null,
        grants: [],
      }),
    ]);
    const handler = createCmsAssignContentHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "admin-1" }),
    });

    const cases = [
      [{ id: "stale", baseVersion: 3, assignee: null }, 409],
      [{ id: "missing", baseVersion: 1, assignee: null }, 404],
      [{ id: "deleted", baseVersion: 1, assignee: null }, 404],
      [{ id: "malformed", baseVersion: 1, assignee: null }, 409],
      [{ id: "published", baseVersion: 2, assignee: "editor-1" }, 409],
      [{ id: "archived", baseVersion: 6, assignee: null }, 409],
      [{ id: "stale", baseVersion: 4, assignee: "missing-user" }, 400],
      [{ id: "stale", baseVersion: 4, assignee: "viewer-1" }, 400],
    ];
    for (const [body, status] of cases) {
      const res = makeRes();
      await handler(makeReq({ body }), res);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
    }

    expect((await db.collection("cmsPosts").doc("stale").get()).data()).toMatchObject({
      version: 4,
    });
    expect((await db.collection("cmsPosts").doc("published").get()).data()).toMatchObject({
      assignee: null,
      version: 2,
    });
    expect((await db.collection("cmsPosts").doc("archived").get()).data()).toMatchObject({
      assignee: "editor-1",
      version: 6,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn(db, "admin_logs")).toHaveLength(0);
  });

  it("serves the exported endpoint through real auth and Firestore wiring", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "assignment-admin@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "assignment-admin@example.com", "password123",
    );
    const uid = credential.user.uid;
    await Promise.all([
      db.collection("users").doc(uid).set({ role: "admin", grants: [] }),
      db.collection("users").doc("editor-1").set({
        role: null,
        grants: [{ role: "editor", sections: ["news"] }],
      }),
      db.collection("cmsPosts").doc("record").set({
        id: "record",
        type: "post",
        title: "Record",
        status: "draft",
        version: 2,
      }),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsAssignContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "record",
        baseVersion: 2,
        assignee: "editor-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      id: "record",
      changed: true,
      document: {
        assignee: "editor-1",
        updatedBy: uid,
        version: 3,
      },
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn(db, "admin_logs")).toHaveLength(1);
  }, 20_000);

  it("rejects an unauthenticated exported request without changing the record", async () => {
    await db.collection("cmsPosts").doc("record").set({
      id: "record",
      type: "post",
      title: "Record",
      status: "draft",
      version: 2,
    });

    const response = await fetch(fnUrl("cmsAssignContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "record",
        baseVersion: 2,
        assignee: null,
      }),
    });

    expect(response.status).toBe(401);
    expect((await db.collection("cmsPosts").doc("record").get()).data()).toMatchObject({
      version: 2,
    });
    expect(await docsIn(db, "cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn(db, "admin_logs")).toHaveLength(0);
  }, 20_000);
});

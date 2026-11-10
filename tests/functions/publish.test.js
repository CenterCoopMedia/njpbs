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
import { createRequire } from "node:module";
import { declaredParams } from "firebase-functions/params";
import adminPkg from "../helpers/firebase-admin.js";
import { initializeApp as initClient, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import publish from "../../functions/publish.js";
import runtimePublication from "../../functions/lib/public-runtime-publication.js";

const {
  createCmsPublishHandler,
  buildDispatchPayload,
  dispatchPublish,
  enqueuePublishBuild,
  defaultDispatchUrl,
  EVENT_TYPE,
  INVALID_PUBLISH_TRANSPORT_ERROR,
  PUBLISH_TRANSPORT,
  PUBLISH_TOKEN_NOT_CONFIGURED_ERROR,
} = publish;
const { tryRuntimePublication } = runtimePublication;

const nodeRequire = createRequire(import.meta.url);
const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

let db;
let clientApp;
let clientAuth;

async function signInAs(email, { verified = true, password = "password123" } = {}) {
  // Finish account creation before signing in: the emulator can record validSince
  // a second after sign-up's auth_time, and a token refresh keeps that auth_time.
  await admin.auth().createUser({ email, password, emailVerified: verified });
  const cred = await signInWithEmailAndPassword(clientAuth, email, password);
  const uid = cred.user.uid;
  const token = await cred.user.getIdToken();
  await signOut(clientAuth);
  return { uid, email, token };
}

async function seedUser(uid, data) {
  await db
    .collection("users")
    .doc(uid)
    .set({
      email: null,
      displayName: null,
      role: null,
      grants: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    });
}

async function callFn(name, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(fnUrl(name), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, ip: "203.0.113.7" };
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

async function withPublishEnv(env, callback) {
  const keys = [
    "CMS_PUBLISH_GITHUB_REPOSITORY",
    "CMS_PUBLISH_TRANSPORT",
    "CMS_WRITEBACK_CONFIGURED",
    "FUNCTIONS_EMULATOR",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const modulePath = nodeRequire.resolve("../../functions/publish.js");

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  delete nodeRequire.cache[modulePath];
  const isolatedPublish = nodeRequire(modulePath);

  try {
    await callback(isolatedPublish);
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    delete nodeRequire.cache[modulePath];
  }
}

async function queueDocs() {
  const snap = await db.collection("cmsPublishQueue").get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function adminLogs() {
  const snap = await db.collection("admin_logs").get();
  return snap.docs.map((doc) => doc.data());
}

function publishedPageWithAsset(assetId, overrides = {}) {
  return {
    status: "published",
    publishAt: "2026-01-01T00:00:00.000Z",
    publiclyVisible: true,
    deleted: false,
    published: {
      blocks: [
        {
          id: "published-image",
          type: "image",
          order: 0,
          visible: true,
          data: { assetId, alt: "Published image" },
        },
      ],
      metadata: { title: "Published page" },
      publishedAt: "2026-01-01T00:00:00.000Z",
      publishedBy: "publisher",
      sourceVersion: 1,
    },
    ...overrides,
  };
}

function privateSiteSeedImage(assetId) {
  return {
    lifecycle: "active",
    source: "site_seed",
    url: `https://njpbs.org/brand/${assetId}.png`,
    altText: null,
    mimeType: "image/png",
    width: 1200,
    height: 675,
  };
}

function publicSiteSeedImage(assetId) {
  const { url, altText, mimeType, width, height } =
    privateSiteSeedImage(assetId);
  return { url, altText, mimeType, width, height };
}

describe("cms publish deploy parameters", () => {
  it("declares the transport selector as a runtime parameter", () => {
    expect(
      declaredParams.map((param) => param.toSpec?.() ?? param),
    ).toContainEqual({
      name: "CMS_PUBLISH_TRANSPORT",
      type: "string",
      default: "github",
    });
    expect(PUBLISH_TRANSPORT.toSpec()).toMatchObject({
      name: "CMS_PUBLISH_TRANSPORT",
      default: "github",
    });
  });

  it("uses GitHub when the parameter API returns an empty absent value", async () => {
    await withPublishEnv({ CMS_PUBLISH_TRANSPORT: "" }, (isolatedPublish) => {
      expect(isolatedPublish.defaultPublishTransport()).toBe("github");
    });
  });

  it("declares the writeback guard as a runtime parameter", () => {
    expect(
      declaredParams.map((param) => param.toSpec?.() ?? param),
    ).toContainEqual({
      name: "CMS_WRITEBACK_CONFIGURED",
      type: "string",
      default: "false",
    });
  });
});

describe("cms publish function", () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient({ apiKey: "demo-key", projectId: PROJECT });
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
      { method: "DELETE" },
    );
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
    await deleteApp(clientApp);
  });

  it("buildDispatchPayload shapes the repository_dispatch body", () => {
    expect(
      buildDispatchPayload({ queueId: "q1", triggeredBy: "a@x" }),
    ).toEqual({
      event_type: "cms_publish",
      client_payload: { queueId: "q1", triggeredBy: "a@x" },
    });
    expect(EVENT_TYPE).toBe("cms_publish");
  });

  it("dispatchPublish skips without a token", async () => {
    const result = await dispatchPublish({ token: "", payload: {} });

    expect(result).toMatchObject({ dispatched: false, skipped: true });
  });

  it("dispatchPublish posts the payload with a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const payload = buildDispatchPayload({ queueId: "q9", triggeredBy: "e@x" });

    const result = await dispatchPublish({
      token: "tok",
      url: defaultDispatchUrl(),
      payload,
      fetchImpl: fetchMock,
    });

    expect(result).toMatchObject({ dispatched: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(defaultDispatchUrl());
    expect(options).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer tok",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "njpbs-cms-publish",
      }),
    });
    expect(JSON.parse(options.body)).toEqual(payload);
  });

  it("rejects an unauthenticated caller", async () => {
    const staleRef = db.collection("cmsPublishQueue").doc("stale");
    const staleData = {
      status: "publishing",
      triggeredAt: admin.firestore.Timestamp.fromMillis(0),
      completedAt: null,
      error: null,
    };
    await staleRef.set(staleData);

    const res = await callFn("cmsPublish", null, {});

    expect(res.status).toBe(401);
    expect(await queueDocs()).toHaveLength(1);
    expect((await staleRef.get()).data()).toEqual(staleData);
  });

  it("rejects a non-admin caller", async () => {
    const user = await signInAs("nonadmin@example.com");
    await seedUser(user.uid, { email: user.email, role: null });

    const res = await callFn("cmsPublish", user.token, {});

    expect(res.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
  });

  it("lets an editor with publish capability enqueue a build", async () => {
    const user = await signInAs("editor@example.com");
    await seedUser(user.uid, {
      email: user.email,
      grants: [{ role: "editor" }],
    });

    const res = await callFn("cmsPublish", user.token, { changes: [] });

    expect(res.status).toBe(200);
    expect(await queueDocs()).toHaveLength(1);
  });

  it("admin enqueues a pending doc and skips dispatch when no token is configured", async () => {
    const adminUser = await signInAs("admin@example.com");
    await seedUser(adminUser.uid, { email: adminUser.email, role: "admin" });

    const res = await callFn("cmsPublish", adminUser.token, {
      changes: [{ id: "home" }],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ dispatched: false, status: "pending" });
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: "pending",
      triggeredBy: adminUser.uid,
    });
    expect(docs[0].changes).toHaveLength(1);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("cms.publish");
  });

  it("advances to publishing on a successful dispatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dispatched: true, status: "publishing" });
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: "publishing",
      transport: "github",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      event_type: "cms_publish",
      client_payload: { queueId: docs[0].id },
    });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
  });

  it("dispatches a reserved retry once and preserves completion before a late acknowledgement", async () => {
    const actor = { uid: "retry-editor", email: null };
    const changes = [{ collection: "cmsPosts", id: "post-one", sourceVersion: 4 }];
    const queueRef = db.collection("cmsPublishQueue").doc("reserved-retry");
    await queueRef.set({ status: "reserved", transport: "github", triggeredBy: actor.uid,
      triggeredByEmail: null, changes });
    const fetchImpl = vi.fn(async () => {
      await queueRef.update({ status: "success", completedAt: "2026-09-04T21:00:00.000Z" });
      return { ok: true, status: 204 };
    });
    const fields = { actor, changes, queueId: queueRef.id, queueReserved: true,
      readiness: { transport: "github", token: "test-token" } };
    const deps = { firestore: db, fetchImpl, assertPublishedMediaSafeFn: async () => {} };
    await Promise.all([enqueuePublishBuild(fields, deps), enqueuePublishBuild(fields, deps)]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await queueRef.get()).data().status).toBe("success");
  });

  it("retries a working draft through the endpoint without saving it", async () => {
    const principal = { id: "retry-editor", grants: [{ role: "admin" }] };
    const ref = db.collection("cmsPosts").doc("post-one");
    await ref.set({ type: "post", version: 7, status: "draft", title: "Unsaved elsewhere",
      publiclyVisible: true, published: { sourceVersion: 4 }, createdBy: principal.id });
    const enqueuePublishBuildFn = vi.fn(async (fields) => ({
      success: true, queueId: fields.queueId, status: "pending", dispatched: false,
    }));
    const handler = createCmsPublishHandler({ firestore: db,
      requirePrincipalFn: async () => ({ uid: principal.id, principal }),
      assertPublishReadyFn: async () => ({ transport: "serializer" }),
      assertPublishedMediaSafeFn: async () => {}, enqueuePublishBuildFn });
    const request = { retry: true, baseVersion: 7,
      changes: [{ collection: "cmsPosts", id: ref.id, sourceVersion: 4 }] };
    const res = makeRes();
    await handler(makeReq({ body: request }), res);
    expect(res.statusCode).toBe(200);
    expect(enqueuePublishBuildFn).toHaveBeenCalledWith(expect.objectContaining({
      queueReserved: true, changes: request.changes,
    }), expect.any(Object));
    expect((await ref.get()).data()).toMatchObject({ version: 7, status: "draft", title: "Unsaved elsewhere", published: { sourceVersion: 4 } });
    const stale = makeRes();
    await handler(makeReq({ body: { ...request, baseVersion: 6 } }), stale);
    expect(stale.statusCode).toBe(409);
    expect(enqueuePublishBuildFn).toHaveBeenCalledOnce();
  });

  it("uses the queue reserved by scheduled publication", async () => {
    const queueId = "scheduled-queue";
    const changes = [
      { collection: "cmsPages", id: "contact", sourceVersion: 4 },
    ];
    await db.collection("cmsPublishQueue").doc(queueId).set({
      status: "reserved",
      transport: "github",
      triggeredBy: "system:scheduler",
      triggeredByEmail: null,
      triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: null,
      error: null,
      changes,
    });

    await expect(
      enqueuePublishBuild(
        {
          actor: { uid: "system:scheduler", email: null },
          changes,
          source: "scheduler",
          readiness: { transport: "github", token: null },
          queueId,
          queueReserved: true,
        },
        {
          firestore: db,
          assertPublishedMediaSafeFn: vi.fn(),
          logAdminActionFn: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ queueId, status: "pending" });
    expect(await queueDocs()).toMatchObject([
      { id: queueId, status: "pending", changes },
    ]);
  });

  it("settles an exact runtime receipt without a queue or scheduled retry", async () => {
    const contactRef = db.collection("cmsPages").doc("contact");
    await contactRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 7 },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            "x-njpbs-content-source": "cms-runtime",
            "x-njpbs-source-version": "6",
          },
        }),
      )
      .mockResolvedValue(
        new Response(null, {
          headers: {
            "x-njpbs-content-source": "cms-runtime",
            "x-njpbs-source-version": "7",
          },
        }),
      );
    const fields = {
      firestore: db,
      actor: { uid: "u1", email: "u1@x" },
      changes: [
        { collection: "cmsPages", id: "contact", sourceVersion: 7 },
      ],
      source: "203.0.113.7",
    };

    await expect(
      tryRuntimePublication(fields, { fetchImpl, nonce: "exact-runtime" }),
    ).resolves.toMatchObject({
      confirmed: true,
      publicReceipt: {
        collection: "cmsPages",
        id: "contact",
        label: "Contact",
        sourceVersion: 7,
        status: "confirmed",
      },
    });
    expect((await contactRef.get()).data()).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
      published: { sourceVersion: 7 },
    });
    expect(await queueDocs()).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await adminLogs()).toMatchObject([
      {
        action: "cms.publish",
        target: "cmsPages/contact",
        after: {
          status: "runtime_confirmed",
          sourceVersion: 7,
          buildQueued: false,
        },
      },
    ]);

    // A lost response can retry the exact receipt without another write or log.
    await expect(
      tryRuntimePublication(fields, { fetchImpl, nonce: "exact-retry" }),
    ).resolves.toMatchObject({ confirmed: true });
    expect(await adminLogs()).toHaveLength(1);
  });

  it("returns an honest runtime miss without changing the pending fallback", async () => {
    const contactRef = db.collection("cmsPages").doc("contact");
    await contactRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 7 },
    });
    const fetchImpl = vi.fn();

    await expect(
      tryRuntimePublication(
        {
          firestore: db,
          actor: { uid: "u1", email: "u1@x" },
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
        { fetchImpl, maxWaitMs: 0 },
      ),
    ).resolves.toMatchObject({
      confirmed: false,
      publicReceipt: { status: "unconfirmed", sourceVersion: 7 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await contactRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: null,
    });
    expect(await adminLogs()).toHaveLength(0);
  });

  it("does not probe a surface that is not active in the runtime registry", async () => {
    const fetchImpl = vi.fn();

    await expect(
      tryRuntimePublication(
        {
          firestore: db,
          actor: { uid: "u1", email: "u1@x" },
          changes: [
            { collection: "cmsPages", id: "watch", sourceVersion: 4 },
          ],
        },
        { fetchImpl },
      ),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not clear a pending marker claimed while the receipt is checked", async () => {
    const contactRef = db.collection("cmsPages").doc("contact");
    await contactRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: "scheduler-queue",
      published: { sourceVersion: 7 },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        headers: {
          "x-njpbs-content-source": "cms-runtime",
          "x-njpbs-source-version": "7",
        },
      }),
    );

    await expect(
      tryRuntimePublication(
        {
          firestore: db,
          actor: { uid: "u1", email: "u1@x" },
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
        { fetchImpl, nonce: "claimed-runtime" },
      ),
    ).resolves.toMatchObject({
      confirmed: true,
      existingQueueId: "scheduler-queue",
      publicReceipt: { status: "confirmed", sourceVersion: 7 },
    });
    expect((await contactRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: "scheduler-queue",
    });
    expect(await adminLogs()).toHaveLength(0);
  });

  it("returns a confirmed runtime publish without calling the build transport", async () => {
    const enqueuePublishBuildFn = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      tryRuntimePublicationFn: vi.fn(async () => ({
        confirmed: true,
        publicReceipt: {
          collection: "cmsPages",
          id: "contact",
          label: "Contact",
          sourceVersion: 7,
          status: "confirmed",
        },
      })),
      enqueuePublishBuildFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          runtimeFirst: true,
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      queueId: null,
      dispatched: false,
      status: "runtime_confirmed",
      transport: "runtime",
      publicReceipt: { status: "confirmed", sourceVersion: 7 },
    });
    expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
  });

  it("reuses a concurrent build claim instead of dispatching a duplicate", async () => {
    const enqueuePublishBuildFn = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      tryRuntimePublicationFn: vi.fn(async () => ({
        confirmed: true,
        existingQueueId: "scheduler-queue",
        publicReceipt: {
          collection: "cmsPages",
          id: "contact",
          label: "Contact",
          sourceVersion: 7,
          status: "confirmed",
        },
      })),
      enqueuePublishBuildFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          runtimeFirst: true,
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      queueId: "scheduler-queue",
      dispatched: false,
      status: "pending",
      existingBuild: true,
      publicReceipt: { status: "confirmed", sourceVersion: 7 },
    });
    expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
  });

  it("keeps the billing kill switch before an active runtime probe", async () => {
    const tryRuntimePublicationFn = vi.fn();
    const enqueuePublishBuildFn = vi.fn();
    const disabled = new Error("Publishing is paused by the billing safety switch");
    disabled.code = "failed-precondition";
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      assertBillingEnabledFn: vi.fn(async () => {
        throw disabled;
      }),
      tryRuntimePublicationFn,
      enqueuePublishBuildFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          runtimeFirst: true,
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/billing safety switch/i);
    expect(tryRuntimePublicationFn).not.toHaveBeenCalled();
    expect(enqueuePublishBuildFn).not.toHaveBeenCalled();
  });

  it("keeps the runtime miss on the normal fallback response", async () => {
    const enqueuePublishBuildFn = vi.fn(async () => ({
      success: true,
      queueId: "fallback-1",
      dispatched: true,
      status: "publishing",
      transport: "github",
      message: "Publish triggered.",
    }));
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      tryRuntimePublicationFn: vi.fn(async () => ({
        confirmed: false,
        publicReceipt: {
          collection: "cmsPages",
          id: "contact",
          label: "Contact",
          sourceVersion: 7,
          status: "unconfirmed",
        },
      })),
      enqueuePublishBuildFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          runtimeFirst: true,
          changes: [
            { collection: "cmsPages", id: "contact", sourceVersion: 7 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      queueId: "fallback-1",
      status: "publishing",
      publicReceipt: { status: "unconfirmed", sourceVersion: 7 },
    });
    expect(enqueuePublishBuildFn).toHaveBeenCalledOnce();
  });

  it("atomically queues serializer work with its audit and revision claim", async () => {
    const contentRef = db.collection("cmsPages").doc("home");
    await contentRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 4 },
    });
    const getToken = vi.fn(() => {
      throw new Error("the serializer transport must not read the GitHub token");
    });
    const fetchImpl = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getTransport: () => "serializer",
      getToken,
      isWritebackConfigured: false,
      fetchImpl,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          changes: [
            { collection: "cmsPages", id: "home", sourceVersion: 4 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      dispatched: false,
      status: "pending",
      transport: "serializer",
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: "pending",
      transport: "serializer",
      triggeredBy: "u1",
    });
    expect((await contentRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: docs[0].id,
      published: { sourceVersion: 4 },
    });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "cms.publish",
      target: docs[0].id,
      after: {
        status: "pending",
        transport: "serializer",
        changesCount: 1,
      },
    });
  });

  it.each(["serializer", "github"])(
    "refuses a new %s queue while publication admission is paused",
    async (transport) => {
      await db.collection("system").doc("cmsPublicationRuntime").set({
        schemaVersion: 1,
        phase: "paused",
        commitSha: "a".repeat(40),
        serializerId: "cloud-publication-primary",
      });

      await expect(enqueuePublishBuild({
        actor: { uid: "u1", email: "u1@x" },
        changes: [],
        readiness: {
          transport,
          token: transport === "github" ? "token" : null,
        },
      }, {
        firestore: db,
        assertPublishedMediaSafeFn: vi.fn(async () => {}),
      })).rejects.toThrow("paused for a serializer handoff");
      expect(await queueDocs()).toHaveLength(0);
      expect(await adminLogs()).toHaveLength(0);
    },
  );

  it("opens an admitted reserved serializer queue after a later pause without GitHub configuration", async () => {
    const queueId = "11111111111111111111";
    const changes = [
      { collection: "cmsPages", id: "home", sourceVersion: 4 },
    ];
    await Promise.all([
      db.collection("system").doc("cmsPublicationRuntime").set({
        schemaVersion: 1,
        phase: "paused",
        commitSha: "a".repeat(40),
        serializerId: "cloud-publication-primary",
      }),
      db.collection("cmsPages").doc("home").set({
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: queueId,
        published: { sourceVersion: 4 },
      }),
      db.collection("cmsPublishQueue").doc(queueId).set({
        status: "reserved",
        transport: "serializer",
        triggeredBy: "u1",
        triggeredByEmail: "u1@x",
        triggeredAt: admin.firestore.Timestamp.fromMillis(1_787_000_000_000),
        completedAt: null,
        error: null,
        changes,
      }),
    ]);

    await withPublishEnv({ CMS_PUBLISH_GITHUB_REPOSITORY: "" }, async isolatedPublish => {
    await expect(isolatedPublish.enqueuePublishBuild({
      actor: { uid: "u1", email: "u1@x" },
      changes,
      readiness: { transport: "serializer" },
      queueId,
      queueReserved: true,
    }, {
      firestore: db,
      assertPublishedMediaSafeFn: vi.fn(async () => {}),
    })).resolves.toMatchObject({ queueId, status: "pending" });
    });
    expect((await db.collection("cmsPublishQueue").doc(queueId).get()).data())
      .toMatchObject({ status: "pending", changes });
  });

  it("refuses an unknown transport before token access or queue mutation", async () => {
    const getToken = vi.fn();
    const fetchImpl = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getTransport: () => "unknown",
      getToken,
      fetchImpl,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe(INVALID_PUBLISH_TRANSPORT_ERROR);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("leaves no serializer queue or revision claim when audit creation fails", async () => {
    const contentRef = db.collection("cmsPages").doc("home");
    await contentRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 4 },
    });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getTransport: () => "serializer",
      adminLogEntryFn: () => {
        throw new Error("audit unavailable");
      },
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          changes: [
            { collection: "cmsPages", id: "home", sourceVersion: 4 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("audit unavailable");
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
    expect((await contentRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: null,
    });
  });

  it("marks only the exact published revision in flight after GitHub accepts its build", async () => {
    const currentRef = db.collection("cmsPages").doc("home");
    const newerRef = db.collection("cmsPages").doc("contact");
    await Promise.all([
      currentRef.set({
        status: "published",
        publishBuildPending: true,
        published: { sourceVersion: 4 },
      }),
      newerRef.set({
        status: "published",
        publishBuildPending: true,
        published: { sourceVersion: 6 },
      }),
    ]);
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          changes: [
            { collection: "cmsPages", id: "home", sourceVersion: 4 },
            { collection: "cmsPages", id: "contact", sourceVersion: 5 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const queue = (await queueDocs())[0];
    expect((await currentRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: queue.id,
    });
    const newer = (await newerRef.get()).data();
    expect(newer.publishBuildPending).toBe(true);
    expect(newer.publishBuildQueueId).toBeUndefined();
  });

  it("refuses before creating a queue doc when writeback is not confirmed", async () => {
    const fetchMock = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: false,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [{ id: "home" }] } }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe(
      "publish pipeline is not fully configured: writeback credential not confirmed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("keeps inline reconciliation until the scheduled replacement is enabled", async () => {
    const now = Date.parse("2026-07-09T16:00:00.000Z");
    const oneDay = 24 * 60 * 60 * 1000;
    const staleTriggeredAt = admin.firestore.Timestamp.fromMillis(now - oneDay);
    const stalePublishingRef = db
      .collection("cmsPublishQueue")
      .doc("stale-publishing");
    const staleContentRef = db.collection("cmsPages").doc("contact");

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
      staleContentRef.set({
        status: "published",
        publishBuildPending: true,
        publishBuildQueueId: "stale-publishing",
        published: { sourceVersion: 3 },
      }),
    ]);

    const fetchMock = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: false,
      fetchImpl: fetchMock,
      now: () => now,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await stalePublishingRef.get()).data()).toMatchObject({
      status: "failed",
      error:
        "Publish marked failed during reconciliation because no terminal workflow status was recorded within 24 hours.",
    });
    expect((await staleContentRef.get()).data()).toMatchObject({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 3 },
    });
  });

  it("dispatches when writeback is confirmed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [{ id: "home" }] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dispatched: true, status: "publishing" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: "publishing",
      triggeredBy: "u1",
    });
  });

  it("refuses dispatch when an admitted legacy snapshot uses an uploaded asset", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("home")
        .set(publishedPageWithAsset("legacy-upload")),
      db.collection("media_assets").doc("legacy-upload").set({
        lifecycle: "active",
        source: "upload",
        mimeType: "image/png",
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [{ id: "contact" }] } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/legacy-upload.*cannot enter public content/i);
    expect(res.body.code).toBe("media_publication_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("checks the still-public snapshot while a page is being revised", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("watch")
        .set(
          publishedPageWithAsset("legacy-upload", {
            status: "draft",
            publishAt: "2027-01-01T00:00:00.000Z",
          }),
        ),
      db.collection("media_assets").doc("legacy-upload").set({
        lifecycle: "active",
        source: "upload",
        mimeType: "image/png",
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
  });

  it("checks a visible snapshot that can become due during the build", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("home")
        .set(
          publishedPageWithAsset("legacy-upload", {
            publishAt: "2026-08-14T20:00:01.000Z",
          }),
        ),
      db.collection("media_assets").doc("legacy-upload").set({
        lifecycle: "active",
        source: "upload",
        mimeType: "image/png",
      }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses a published seed asset with no public projection", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("home")
        .set(publishedPageWithAsset("launch-home")),
      db
        .collection("media_assets")
        .doc("launch-home")
        .set(privateSiteSeedImage("launch-home")),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/launch-home.*projection.*not ready/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses a published seed asset with a mismatched public projection", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("home")
        .set(publishedPageWithAsset("launch-home")),
      db
        .collection("media_assets")
        .doc("launch-home")
        .set(privateSiteSeedImage("launch-home")),
      db
        .collection("media_assets_public")
        .doc("launch-home")
        .set({
          ...publicSiteSeedImage("launch-home"),
          url: "https://media.njpbs.org/cms-media/uploaded.webp",
        }),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/launch-home.*projection.*not ready/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
  });

  it("dispatches when every admitted snapshot uses site seed media", async () => {
    await Promise.all([
      db
        .collection("cmsPages")
        .doc("home")
        .set(publishedPageWithAsset("launch-home")),
      db
        .collection("media_assets")
        .doc("launch-home")
        .set(privateSiteSeedImage("launch-home")),
      db
        .collection("media_assets_public")
        .doc("launch-home")
        .set(publicSiteSeedImage("launch-home")),
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      now: () => Date.parse("2026-08-14T20:00:00.000Z"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dispatched: true, status: "publishing" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await queueDocs()).toHaveLength(1);
  });

  it("uses the emulator default when the writeback flag is unset", async () => {
    await withPublishEnv(
      { CMS_WRITEBACK_CONFIGURED: undefined, FUNCTIONS_EMULATOR: "true" },
      async ({ createCmsPublishHandler: createIsolatedHandler }) => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
        const handler = createIsolatedHandler({
          firestore: db,
          requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
          getToken: () => "tok",
          fetchImpl: fetchMock,
        });
        const res = makeRes();

        await handler(makeReq({ body: { changes: [] } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
          dispatched: true,
          status: "publishing",
        });
        expect(fetchMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("does not dispatch when the audit write fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      logAdminActionFn: vi.fn().mockRejectedValue(new Error("audit unavailable")),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("audit unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("failed");
    expect(docs[0].error).toBe("audit unavailable");
    expect(docs[0].completedAt).toBeTruthy();
  });

  it("writes the audit row before dispatching", async () => {
    const events = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      events.push("dispatch");
      return { ok: true, status: 204 };
    });
    const logAdminActionFn = vi.fn().mockImplementation(async () => {
      events.push("audit:start");
      await Promise.resolve();
      events.push("audit:resolved");
    });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
      logAdminActionFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [{ id: "home" }] } }), res);

    expect(res.statusCode).toBe(200);
    expect(events).toEqual(["audit:start", "audit:resolved", "dispatch"]);
    expect(logAdminActionFn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cms.publish",
        target: expect.any(String),
        after: {
          status: "pending",
          dispatchRequested: true,
          changesCount: 1,
        },
      }),
    );
  });

  it("marks the queue doc failed when the dispatch request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(502);
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("failed");
    expect(docs[0].error).toContain("500");
  });

  it("refuses before creating a queue doc when the publish token lookup fails in production", async () => {
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => {
        throw new Error("secret unavailable");
      },
      allowMissingToken: false,
      fetchImpl: vi.fn(),
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("secret unavailable");
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses before creating a queue doc when the publish token is blank in production", async () => {
    const fetchMock = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "",
      allowMissingToken: false,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe(PUBLISH_TOKEN_NOT_CONFIGURED_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("keeps the queue pending when the publish token lookup fails and missing tokens are allowed", async () => {
    const fetchMock = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => {
        throw new Error("secret unavailable");
      },
      allowMissingToken: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ dispatched: false, status: "pending" });
    expect(fetchMock).not.toHaveBeenCalled();
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("pending");
    expect(docs[0].error).toBeNull();
  });

  it("marks the queue doc failed when the dispatch request throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("network down");
    const docs = await queueDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("failed");
    expect(docs[0].error).toBe("network down");
    expect(docs[0].completedAt).toBeTruthy();
  });

  it("refuses to publish when the billing kill switch is engaged", async () => {
    const fetchMock = vi.fn();
    const handler = createCmsPublishHandler({
      firestore: db,
      requireAdminFn: async () => ({ uid: "u1", email: "u1@x" }),
      assertBillingEnabledFn: async () => {
        throw Object.assign(new Error("billing is disabled"), {
          code: "failed-precondition",
        });
      },
      getToken: () => "tok",
      isWritebackConfigured: true,
      fetchImpl: fetchMock,
    });
    const res = makeRes();

    await handler(makeReq({ body: { changes: [] } }), res);

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await queueDocs()).toHaveLength(0);
  });
});

// A section-scoped editor's publish, end to end (#845).
//
// The save path authorizes a publish against the record's own desk, so a scoped editor can
// commit a published snapshot. The transport used to ask the unsectioned question, which
// refused them right after that snapshot committed: the content was live in Firestore and
// no build was ever dispatched. These cases pin both directions -- in scope succeeds all
// the way to a queue row, out of scope fails before anything moves.
describe("section-scoped publish", () => {
  const POST = "scoped-record-1";

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient({ apiKey: "demo-key", projectId: PROJECT }, "scoped-publish");
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
      { method: "DELETE" },
    );
    await Promise.all(
      ["watch", "support", "station", "compliance"].map((id) =>
        db.collection("sections").doc(id).set({ id, label: id, order: 1 }),
      ),
    );
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
    await deleteApp(clientApp);
  });

  /** An approved record sitting in one desk, ready for the publish save the app makes. */
  async function seedApprovedRecord(section, ownerUid) {
    await db
      .collection("cmsPosts")
      .doc(POST)
      .set({
        id: POST,
        type: "post",
        title: "A record in one desk",
        slug: "a-record-in-one-desk",
        date: "2026-08-21",
        locale: "en",
        tags: [],
        blocks: [],
        section,
        status: "approved",
        version: 1,
        createdBy: ownerUid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: ownerUid,
      });
  }

  async function scopedEditor(email, sections) {
    const user = await signInAs(email);
    await seedUser(user.uid, {
      email: user.email,
      grants: [{ role: "editor", sections }],
    });
    return user;
  }

  it("carries an in-scope publish from the save through to a queued build", async () => {
    const user = await scopedEditor("watch-editor@example.com", ["watch"]);
    await seedApprovedRecord("watch", "somebody-else");

    // Exactly what the Content tab does: commit the published snapshot, then ask the
    // transport for the build that makes it public.
    const saved = await callFn("cmsSaveContent", user.token, {
      collection: "cmsPosts",
      id: POST,
      baseVersion: 1,
      publish: true,
      document: {},
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    const sourceVersion = savedBody.document.version;

    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPosts", id: POST, sourceVersion }],
    });

    expect(build.status).toBe(200);
    const queue = await queueDocs();
    expect(queue).toHaveLength(1);
    expect(queue[0].triggeredBy).toBe(user.uid);
  });

  it("refuses an out-of-scope publish before the save commits anything", async () => {
    const user = await scopedEditor("station-outsider@example.com", ["watch"]);
    await seedApprovedRecord("station", "somebody-else");

    const saved = await callFn("cmsSaveContent", user.token, {
      collection: "cmsPosts",
      id: POST,
      baseVersion: 1,
      publish: true,
      document: {},
    });

    expect(saved.status).toBe(403);
    // Nothing moved: the record is still the approved version nobody published.
    const stored = (await db.collection("cmsPosts").doc(POST).get()).data();
    expect(stored.status).toBe("approved");
    expect(stored.version).toBe(1);
    expect(stored.published).toBeUndefined();
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses the transport too when a scoped caller addresses another desk", async () => {
    // Belt and braces: even if a caller reaches the transport directly, the build for a
    // document outside their desks is refused, and no queue row or audit row is written.
    const user = await scopedEditor("direct-transport@example.com", ["watch"]);
    await seedApprovedRecord("station", "somebody-else");

    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPosts", id: POST, sourceVersion: 1 }],
    });

    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("refuses a scoped caller a build that names no document", async () => {
    // A build that addresses nothing rebuilds the whole site, which is a site-wide act. A
    // desk-scoped grant cannot ask for one.
    const user = await scopedEditor("whole-site@example.com", ["watch"]);

    const build = await callFn("cmsPublish", user.token, { changes: [] });

    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses a scoped caller a change the queue's addressing rules would drop", async () => {
    // An unaddressable change is never authorized against a document, so waving it through
    // would let a scoped caller smuggle an unchecked entry alongside an in-scope one.
    const user = await scopedEditor("malformed-change@example.com", ["watch"]);
    await seedApprovedRecord("watch", "somebody-else");

    const build = await callFn("cmsPublish", user.token, {
      changes: [
        { collection: "cmsPosts", id: POST, sourceVersion: 1 },
        { collection: "cmsPosts", id: POST },
      ],
    });

    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses a scoped caller a document that does not exist", async () => {
    const user = await scopedEditor("absent-doc@example.com", ["watch"]);

    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPosts", id: "never-written", sourceVersion: 1 }],
    });

    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
  });

  it("refuses a scoped caller a draft with an invented source version", async () => {
    const user = await scopedEditor("draft-publisher@example.com", ["watch"]);
    await seedApprovedRecord("watch", "somebody-else");
    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPosts", id: POST, sourceVersion: 777 }],
    });
    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
    expect(await adminLogs()).toHaveLength(0);
  });

  it("lets a scoped editor publish a canonical page in their own public area", async () => {
    // A page's desk is its server-owned public area, so the transport resolves it from the
    // registry rather than from whatever the stored document happens to carry.
    const user = await scopedEditor("watch-pages@example.com", ["watch"]);
    await db.collection("cmsPages").doc("schedule").set({
      id: "schedule",
      template: "programLanding",
      title: "Schedule",
      section: "watch",
      status: "published",
      version: 2,
      publishBuildPending: true,
      publishBuildQueueId: null,
      published: { sourceVersion: 2 },
      blocks: [],
    });

    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPages", id: "schedule", sourceVersion: 2 }],
    });

    expect(build.status).toBe(200);
    expect(await queueDocs()).toHaveLength(1);
  });

  it("refuses a scoped editor a canonical page in another public area", async () => {
    const user = await scopedEditor("watch-not-support@example.com", ["watch"]);
    await db.collection("cmsPages").doc("give").set({
      id: "give",
      template: "programLanding",
      title: "Give",
      section: "watch",
      status: "published",
      version: 2,
      blocks: [],
    });

    // The stored desk says watch; the registry says support, and the registry wins.
    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPages", id: "give", sourceVersion: 2 }],
    });

    expect(build.status).toBe(403);
    expect(await queueDocs()).toHaveLength(0);
  });

  it("leaves a site-wide publisher unchanged, with no per-document reads", async () => {
    const user = await signInAs("sitewide-publisher@example.com");
    await seedUser(user.uid, {
      email: user.email,
      grants: [{ role: "editor" }],
    });

    const build = await callFn("cmsPublish", user.token, {
      changes: [{ collection: "cmsPosts", id: "not-even-stored", sourceVersion: 9 }],
    });

    expect(build.status).toBe(200);
    expect(await queueDocs()).toHaveLength(1);
  });
});

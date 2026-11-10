import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
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
import { initializeApp as initClient, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import save from "../../functions/save.js";
import documentSizePkg from "../../functions/lib/document-size.js";
import postSlugContract from "../../functions/lib/post-slug-contract.js";
import pageContract from "../../functions/lib/public-page-contract.js";
import publishedMediaSafetyPkg from "../../functions/lib/published-media-safety.js";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

const {
  cmsSaveContent,
  createCmsSaveHandler: createCmsSaveHandlerWithProductionBoundaries,
} = save;
// Most cases below use Home as a compact generic page fixture while they test another save
// concern. Keep those cases focused. The dedicated Home-boundary cases use the production
// factory unchanged, and the deployed emulator function also keeps the boundary enabled.
const createCmsSaveHandler = (deps = {}) =>
  createCmsSaveHandlerWithProductionBoundaries({
    enforceHomeEditorBoundary: false,
    ...deps,
  });
const { PAGE_EDITOR_TEMPLATES } = pageContract;
const { PublishedMediaSafetyError } = publishedMediaSafetyPkg;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

let db;
let clientApp;
let clientAuth;

async function signInAs(email, { verified = true, password = "password123" } = {}) {
  // Finish account creation before signing in: signup's auth_time can precede
  // the emulator's validSince, and refreshing a token preserves that auth_time.
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

async function docsIn(collection) {
  const snap = await db.collection(collection).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

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

// A deterministic id minter so tests can assert exactly which blocks were minted.
function sequentialMinter(prefix = "srv") {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

// A barrier for the concurrency tests: `atRead` resolves once a save has read the
// document, and that save goes no further until `release()` is called. Only the first
// read is held -- a save whose transaction is re-run must be free to re-read, which is
// the behaviour these tests are about.
//
// `reads` is the evidence. It counts every read the save made, so a test can assert both
// that the save went through this seam at all (a save that stopped would pass the
// assertions vacuously, on a plain sequence rather than on two overlapping saves) and
// that a contended save re-read rather than committing what it first saw.
function readBarrier() {
  let release;
  let reached;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const barrier = {
    atRead: new Promise((resolve) => {
      reached = resolve;
    }),
    reads: 0,
    release: () => release(),
  };
  barrier.wait = async () => {
    barrier.reads += 1;
    if (barrier.reads > 1) return;
    reached();
    await released;
  };
  return barrier;
}

// Wrap the injected firestore so a test holds one save between reading the document and
// writing it -- the window a concurrent save slips through. Pausing an exact point beats
// racing two real requests: the interleaving is the same every run, so a failure means
// the bug, not the scheduler.
//
// The paused reference is a stand-in, not a real DocumentReference, so every seam that
// receives one unwraps it back to the real ref before handing it to the SDK. Only a
// doc() call that names an id is paused -- that is the content document the handler
// reads; the auto-id audit refs pass straight through. Both read seams are wrapped, so
// the barrier still fires if the read moves inside a transaction.
function firestorePausedAfterRead(realDb, barrier) {
  const paused = (ref) => ({
    __real: ref,
    get: async () => {
      const snap = await ref.get();
      await barrier.wait();
      return snap;
    },
  });
  const unwrap = (ref) => ref?.__real ?? ref;
  return {
    collection: (name) => {
      const coll = realDb.collection(name);
      return { doc: (id) => (id === undefined ? coll.doc() : name === "cmsPages" && id === "home" ? paused(coll.doc(id)) : coll.doc(id)) };
    },
    batch: () => {
      const batch = realDb.batch();
      return {
        set: (ref, data) => batch.set(unwrap(ref), data),
        commit: () => batch.commit(),
      };
    },
    runTransaction: (fn, opts) =>
      realDb.runTransaction(
        (tx) =>
          fn({
            get: async (ref) => {
              const snap = await tx.get(unwrap(ref));
              if (unwrap(ref).path === "cmsPages/home") await barrier.wait();
              return snap;
            },
            set: (ref, data) => tx.set(unwrap(ref), data),
          }),
        opts,
      ),
  };
}

const {
  DOCUMENT_SIZE_BUDGET_BYTES,
  MAX_DOCUMENT_BYTES,
  documentSizeError,
  firestoreDocumentBytes,
} = documentSizePkg;

const divider = (over = {}) => ({
  type: "divider",
  order: 0,
  visible: true,
  data: {},
  ...over,
});

const image = (assetId, over = {}) => ({
  id: `image-${assetId}`,
  type: "image",
  order: 0,
  visible: true,
  data: { assetId, alt: "Image" },
  ...over,
});

// A valid prose block carrying `text` as its paragraph content. The size tests
// use it to reach the document limit with content the block contract accepts,
// so what they prove is the size guard and not a parse rejection.
const prose = ({ text = "", ...over } = {}) => ({
  type: "prose",
  order: 0,
  visible: true,
  data: {
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  },
  ...over,
});

const contentShelf = (over = {}) => ({
  type: "content_shelf",
  order: 0,
  visible: true,
  data: {
    title: "Featured on NJ PBS",
    source: "pbs_featured",
    itemLimit: 8,
    moreLabel: "Browse all",
    moreHref: "https://watch.njpbs.org/",
  },
  ...over,
});

const promotionShelf = (over = {}) => ({
  type: "promotion_playlist",
  order: 0,
  visible: false,
  data: {
    title: "",
    placement: "before_featured",
    cards: [],
  },
  ...over,
});

const postDraft = (title = "A post", over = {}) => ({
  type: "post",
  title,
  date: "2026-07-15",
  tags: [],
  blocks: [],
  ...over,
});

describe("cmsSaveContent function", () => {
  it("binds the publish secret on the deployed save boundary", () => {
    expect(cmsSaveContent.__endpoint.secretEnvironmentVariables).toEqual([
      { key: "CMS_PUBLISH_GITHUB_TOKEN" },
      { key: "CMS_EDGE_ORIGIN_SECRET" },
    ]);
  });

  it("checks publish readiness before opening the snapshot transaction", async () => {
    const firestore = { doc: db.doc.bind(db), runTransaction: vi.fn() };
    const notReady = Object.assign(new Error("publish transport unavailable"), {
      code: "failed-precondition",
    });
    const assertPublishReadyFn = vi.fn(async () => {
      throw notReady;
    });
    const handler = createCmsSaveHandler({
      firestore,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
      assertPublishReadyFn,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 1,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("publish transport unavailable");
    expect(assertPublishReadyFn).toHaveBeenCalledWith({ firestore });
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("returns the stable media publication code from the serializer preflight", async () => {
    const firestore = { doc: db.doc.bind(db), runTransaction: vi.fn() };
    const handler = createCmsSaveHandler({
      firestore,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
      assertPublishReadyFn: vi.fn(async () => ({ transport: "serializer" })),
      assertPublishedMediaSafeFn: vi.fn(async () => {
        throw new PublishedMediaSafetyError(
          "Media asset uploaded-image cannot enter public content until public deployment coordination is active.",
        );
      }),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 1,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error:
        "Media asset uploaded-image cannot enter public content until public deployment coordination is active.",
      code: "media_publication_unavailable",
    });
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("keeps the deployed page contract in parity with the shared public registry", () => {
    expect(PAGE_EDITOR_TEMPLATES).toEqual(
      Object.fromEntries(PUBLIC_PAGES.map((page) => [page.id, page.editorTemplate])),
    );
  });

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
    await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: "DELETE",
    });
    // A sectioned record create must name a registered desk (#845), so the seeded
    // registry has to exist for every create-path case here. Only these four desks are
    // registered, which keeps the "unknown section" cases honest.
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

  // --- auth boundary, through the deployed function (real requireAdmin) ---
  // These two hit the deployed emulator function over HTTP, so the first one pays
  // cmsSaveContent's cold instance spin-up; give them headroom past the 5s default.

  it("answers the admin CORS preflight without an edge secret", async () => {
    const res = await fetch(fnUrl("cmsSaveContent"), {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,x-njpbs-cms-edge",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    const allowHeaders = res.headers
      .get("access-control-allow-headers")
      ?.toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("x-njpbs-cms-edge");
  }, 20000);

  it("rejects an unauthenticated caller", async () => {
    const res = await callFn("cmsSaveContent", null, {
      collection: "cmsPages",
      id: "home",
      document: { title: "Home", blocks: [] },
    });

    expect(res.status).toBe(401);
    expect(await docsIn("cmsPages")).toHaveLength(0);
  }, 20000);

  it("rejects a non-admin caller", async () => {
    const user = await signInAs("nonadmin@example.com");
    await seedUser(user.uid, { email: user.email, role: null });

    const res = await callFn("cmsSaveContent", user.token, {
      collection: "cmsPages",
      id: "home",
      document: { title: "Home", blocks: [] },
    });

    expect(res.status).toBe(403);
    expect(await docsIn("cmsPages")).toHaveLength(0);
  }, 20000);

  it("rejects an inactive admin on the next request", async () => {
    const user = await signInAs("inactive-admin@example.com");
    await seedUser(user.uid, {
      email: user.email,
      active: false,
      tokensValidAfter: 1,
      role: "admin",
    });

    const res = await callFn("cmsSaveContent", user.token, {
      collection: "cmsPages",
      id: "home",
      document: { title: "Home", blocks: [] },
    });

    expect(res.status).toBe(403);
    expect(await docsIn("cmsPages")).toHaveLength(0);
  }, 20000);

  it("saves a page end-to-end for an admin, writing the audit and version rows", async () => {
    const adminUser = await signInAs("admin@example.com");
    await seedUser(adminUser.uid, { email: adminUser.email, role: "admin" });

    const res = await callFn("cmsSaveContent", adminUser.token, {
      collection: "cmsPages",
      id: "home",
      document: {
        title: "Home",
        status: "draft",
        blocks: [promotionShelf({ id: "keep", order: 0 })],
      },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, id: "home", created: true });

    const pages = await docsIn("cmsPages");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      id: "home",
      template: "home",
      title: "Home",
      updatedBy: adminUser.uid,
    });
    expect(pages[0].blocks[0]).toMatchObject({
      type: "promotion_playlist",
      data: {
        placement: "before_featured",
        cards: [],
      },
    });

    const versions = await docsIn("cmsVersionHistory");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      collection: "cmsPages",
      documentId: "home",
      action: "create",
    });
    const logs = await docsIn("admin_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("cms.save");

    // Save is decoupled from publish: no build was enqueued.
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
  });

  // --- request-envelope validation (direct handler, injected admin) ---

  // A site-wide admin: the role every existing case was written against. The
  // grant shape is what lib/auth.js requirePrincipal builds from users/{uid}.
  const adminOk = () => ({
    uid: "u1",
    email: "u1@x",
    principal: { id: "u1", grants: [{ role: "admin" }] },
  });

  async function saveThroughProductionBoundary(body, deps = {}) {
    const handler = createCmsSaveHandlerWithProductionBoundaries({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-09-05T20:00:00.000Z",
      ...deps,
    });
    const res = makeRes();
    await handler(makeReq({ body }), res);
    return res;
  }

  async function saveHomeThroughProductionBoundary(body, deps = {}) {
    return saveThroughProductionBoundary(
      { collection: "cmsPages", id: "home", ...body },
      deps,
    );
  }

  describe("service composition saves", () => {
    const composedSupport = () => ({ id: "support", template: "programLanding", title: "Support NJ PBS",
      version: 4, contentVersion: 4, status: "draft", serviceCompositionVersion: 1, blocks: [], publiclyVisible: true,
      published: { blocks: [], sourceVersion: 3, publishedAt: "2026-10-01T12:00:00Z", metadata: { title: "Published support" } } });

    it("retains composition ownership when staff removes every block without changing the published page", async () => {
      const current = composedSupport();
      await db.collection("cmsPages").doc("support").set(current);
      const reply = await saveThroughProductionBoundary({ collection: "cmsPages", id: "support", baseVersion: 4,
        document: { title: "Edited support", blocks: [] } });
      expect(reply.statusCode).toBe(200);
      const stored = (await db.collection("cmsPages").doc("support").get()).data();
      expect(stored).toMatchObject({ serviceCompositionVersion: 1, title: "Edited support", blocks: [], version: 5 });
      expect(stored.published).toEqual(current.published);
    });

    it("refuses stale or unversioned writes after an operator migration", async () => {
      const current = composedSupport();
      await db.collection("cmsPages").doc("support").set(current);
      const missing = await saveThroughProductionBoundary({ collection: "cmsPages", id: "support", document: { blocks: [] } });
      expect(missing.statusCode).toBe(400);
      expect(missing.body.error).toMatch(/current saved version/);
      const stale = await saveThroughProductionBoundary({ collection: "cmsPages", id: "support", baseVersion: 3, document: { blocks: [] } });
      expect(stale.statusCode).toBe(409);
      expect((await db.collection("cmsPages").doc("support").get()).data()).toEqual(current);
    });

    it("requires the reviewed operator to opt in and prevents ordinary saves from resetting ownership", async () => {
      const current = composedSupport();
      const { serviceCompositionVersion, ...legacy } = current;
      await db.collection("cmsPages").doc("support").set(legacy);
      const optIn = await saveThroughProductionBoundary({ collection: "cmsPages", id: "support", baseVersion: 4,
        document: { serviceCompositionVersion: 1 } });
      expect(optIn.statusCode).toBe(400);
      expect(optIn.body.error).toMatch(/reviewed operator/);
      await db.collection("cmsPages").doc("support").set(current);
      const reset = await saveThroughProductionBoundary({ collection: "cmsPages", id: "support", baseVersion: 4,
        document: { serviceCompositionVersion: null } });
      expect(reset.statusCode).toBe(400);
      expect((await db.collection("cmsPages").doc("support").get()).data()).toEqual(current);
    });
  });


  describe("custom page creation and URL changes", () => {
    it("allows a versioned save with an unchanged implicit page URL but refuses an unversioned rename", async () => {
      await db.collection("cmsPages").doc("faq").set({
        title: "Current title", template: "genericPage", blocks: [],
        status: "draft", version: 3, createdBy: "u1", section: "station",
      });
      const overwritten = await saveThroughProductionBoundary({
        collection: "cmsPages", id: "faq", slug: "faq", baseVersion: 3,
        document: { title: "Recovered editor title" },
      });
      expect(overwritten.statusCode, JSON.stringify(overwritten.body)).toBe(200);
      expect(overwritten.body.document).toMatchObject({ title: "Recovered editor title", version: 4 });
      expect(overwritten.body.document.slug).toBeUndefined();
      expect(overwritten.body.document.previousSlugs).toBeUndefined();

      const renamed = await saveThroughProductionBoundary({
        collection: "cmsPages", id: "faq", slug: "viewer-questions", document: {},
      });
      expect(renamed.statusCode).toBe(400);
      expect((await db.collection("cmsPages").doc("faq").get()).data().version).toBe(4);
    });

    it.each(["cmsPages", "cmsPosts"])("saves hero background media in %s without changing its public snapshot", async collection => {
      await seedMediaAsset("hero-background");
      const id = collection === "cmsPages" ? "contact" : "hero-post";
      const document = { title: "Working", blocks: [], status: "draft", version: 3, createdBy: "u1", section: "station",
        slug: "hero-route", previousSlugs: [], ...(collection === "cmsPosts" ? { type: "post", tags: [] } : { template: "genericPage" }),
        published: { blocks: [], metadata: { title: "Public" }, sourceVersion: 2, publishedAt: "2026-09-01T10:00:00.000Z" },
      };
      await db.collection(collection).doc(id).set(document);
      const response = await saveThroughProductionBoundary({ collection, id, baseVersion: 3,
        document: { heroBackgroundImage: "hero-background", heroBackgroundPosition: "top" } });
      expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
      expect(response.body.document).toMatchObject({ heroBackgroundImage: "hero-background", heroBackgroundPosition: "top", published: document.published });
      const invalid = await saveThroughProductionBoundary({ collection, id, baseVersion: 4,
        document: { heroBackgroundPosition: "url(https://example.org)" } });
      expect(invalid.statusCode).toBe(400);
      expect((await db.collection(collection).doc(id).get()).data().version).toBe(4);
    });

    const pageCreate = (slug, idempotencyKey = "custom-page-attempt-1") => ({
      collection: "cmsPages", slug, section: "station", idempotencyKey,
      document: { title: "A new page", template: "genericPage", blocks: [] },
    });

    it("creates one private custom page and replays a lost create response", async () => {
      const first = await saveThroughProductionBoundary(pageCreate("community-project"));
      expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
      expect(first.body.document.id).toMatch(/^page-[a-f0-9]{32}$/);
      expect(first.body.document).toMatchObject({ slug: "community-project", section: "station", status: "draft", version: 1, previousSlugs: [] });
      expect(first.body.document.published).toBeUndefined();
      const replay = await saveThroughProductionBoundary(pageCreate("community-project"));
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.document.id).toBe(first.body.document.id);
      expect(replay.body.document.version).toBe(1);
      expect((await db.collection("cmsPages").get()).size).toBe(1);
    });

    it("reserves a custom URL once under concurrent creates", async () => {
      const replies = await Promise.all([
        saveThroughProductionBoundary(pageCreate("shared-route", "custom-page-attempt-1")),
        saveThroughProductionBoundary(pageCreate("shared-route", "custom-page-attempt-2")),
      ]);
      expect(replies.map(reply => reply.statusCode).sort()).toEqual([200, 400]);
      expect((await db.collection("cmsPages").get()).size).toBe(1);
    }, 10000);

    it.each(["about", "donate", "posts", "search", "404", "../escape", "https://example.com"])("refuses reserved or invalid page URL %s", async slug => {
      const reply = await saveThroughProductionBoundary(pageCreate(slug));
      expect(reply.statusCode).toBe(400);
      expect((await db.collection("cmsPages").get()).empty).toBe(true);
    });

    it("keeps the editing group authoritative for custom pages", async () => {
      const forbidden = await saveThroughProductionBoundary(pageCreate("support-only"), {
        requirePrincipalFn: () => ({ uid: "scoped", principal: { id: "scoped", grants: [{ role: "editor", sections: ["support"] }] } }),
      });
      expect(forbidden.statusCode).toBe(403);
      const created = await saveThroughProductionBoundary(pageCreate("group-check"));
      const id = created.body.document.id;
      const move = await saveThroughProductionBoundary({ collection: "cmsPages", id, baseVersion: 1, section: "support", document: {} });
      expect(move.statusCode).toBe(400);
      expect((await db.collection("cmsPages").doc(id).get()).data().section).toBe("station");
    });

    it("changes a Program URL while preserving an existing published snapshot and old slug", async () => {
      const snapshot = { sourceVersion: 3, publishedAt: "2026-09-01T10:00:00.000Z", blocks: [], metadata: { type: "program", title: "State of the Arts", slug: "state-of-the-arts", previousSlugs: [], description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Artists in New Jersey." }] }] } } };
      await db.collection("cmsPosts").doc("state-of-the-arts").set({
        id: "state-of-the-arts", type: "program", title: "State of the Arts", description: snapshot.metadata.description,
        slug: "state-of-the-arts", previousSlugs: [], status: "published", version: 4,
        section: "station", createdBy: "u1", published: snapshot,
      });
      const unchanged = await saveThroughProductionBoundary({ collection: "cmsPosts", id: "state-of-the-arts", baseVersion: 4, slug: "state-of-the-arts", document: { genre: "Arts" } });
      expect(unchanged.statusCode, JSON.stringify(unchanged.body)).toBe(200);
      expect(unchanged.body.document).toMatchObject({ slug: "state-of-the-arts", previousSlugs: [] });
      const renamed = await saveThroughProductionBoundary({ collection: "cmsPosts", id: "state-of-the-arts", baseVersion: 5, slug: "state-of-the-arts-nj", document: {} });
      expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
      expect(renamed.body.document).toMatchObject({ slug: "state-of-the-arts-nj", previousSlugs: ["state-of-the-arts"], published: snapshot });
    });

    it.each(["cmsPages", "cmsPosts"])("changes a draft URL in %s while retaining the public snapshot and old routes", async collection => {
      const id = collection === "cmsPages" ? "contact" : "post-route";
      const snapshot = { sourceVersion: 3, publishedAt: "2026-09-01T10:00:00.000Z", blocks: [], metadata: { title: "Published", slug: "old-route", previousSlugs: [], ...(collection === "cmsPosts" ? { type: "post", tags: [] } : {}) } };
      await db.collection(collection).doc(id).set({ id, title: "Working", slug: "old-route", previousSlugs: ["older-route"], section: "station", status: "draft", version: 4, blocks: [], createdBy: "u1", publiclyVisible: true, published: snapshot, ...(collection === "cmsPosts" ? { type: "post", tags: [] } : { template: "genericPage" }) });
      const reply = await saveThroughProductionBoundary({ collection, id, baseVersion: 4, slug: "new-route", document: {} });
      expect(reply.statusCode, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body.document.slug).toBe("new-route");
      expect(reply.body.document.previousSlugs).toEqual(["older-route", "old-route"]);
      expect(reply.body.document.published).toEqual(snapshot);
      const stale = await saveThroughProductionBoundary({ collection, id, baseVersion: 4, slug: "stale-route", document: {} });
      expect(stale.statusCode).toBe(409);
      const unversioned = await saveThroughProductionBoundary({ collection, id, slug: "unguarded-route", document: {} });
      expect(unversioned.statusCode).toBe(400);
      const reclaimed = await saveThroughProductionBoundary({ collection, id, baseVersion: 5, slug: "older-route", document: {} });
      expect(reclaimed.statusCode, JSON.stringify(reclaimed.body)).toBe(200);
      expect(reclaimed.body.document.previousSlugs).toEqual(["old-route", "new-route"]);
    });
  });

  const HOME_CONVERSION_NONCE = "stable-request-nonce";

  function homeConversionRequest(overrides = {}) {
    return {
      baseVersion: 4,
      convertHome: HOME_CONVERSION_NONCE,
      document: { blocks: homeCompositionDefaults() },
      ...overrides,
    };
  }

  function legacyHome(overrides = {}) {
    return {
      id: "home",
      template: "home",
      title: "Legacy Home",
      description: "The recovery copy stays available in version history.",
      status: "draft",
      blocks: [divider({ id: "legacy-copy", order: 0 })],
      published: {
        metadata: { title: "Live Home" },
        blocks: [divider({ id: "live-copy", order: 0 })],
        publishedAt: "2026-09-04T20:00:00.000Z",
        publishedBy: "publisher-1",
      },
      createdAt: "2026-07-01T12:00:00.000Z",
      createdBy: "legacy-editor",
      updatedAt: "2026-09-04T18:00:00.000Z",
      updatedBy: "legacy-editor",
      version: 4,
      ...overrides,
    };
  }

  async function expectRejectedHomeSaveWroteNothing(current) {
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(current);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
    expect(await docsIn("cmsPages/home/mediaUsage")).toHaveLength(0);
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
  }

  it("converts a saved legacy Home atomically and retains its manual shelves", async () => {
    const manualShelves = [
      promotionShelf({
        id: "manual-shelf-a",
        order: 2,
        data: {
          title: "Dolly Parton",
          placement: "before_start",
          cards: [],
        },
      }),
      promotionShelf({
        id: "manual-shelf-b",
        order: 4,
        data: {
          title: "Local favorites",
          placement: "before_more",
          cards: [],
        },
      }),
    ];
    const current = legacyHome({
      blocks: [divider({ id: "legacy-copy", order: 0 }), ...manualShelves],
    });
    await db.collection("cmsPages").doc("home").set(current);
    const proposed = homeCompositionDefaults();
    const expectedMintedIds = Object.fromEntries(
      proposed.map((block, index) => [block.id, `home-${index}`]),
    );

    const res = await saveHomeThroughProductionBoundary(
      homeConversionRequest({ document: { blocks: proposed } }),
      { mintId: sequentialMinter("home") },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      id: "home",
      created: false,
      replayed: false,
      mintedIds: expectedMintedIds,
      document: {
        homeCompositionVersion: 1,
        version: 5,
        published: current.published,
      },
    });
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.blocks.slice(0, 7).map(({ id }) => id)).toEqual(
      proposed.map((_block, index) => `home-${index}`),
    );
    expect(stored.blocks.slice(7)).toEqual(
      manualShelves.map((shelf, index) => ({ ...shelf, order: 7 + index })),
    );
    expect(stored.blocks.filter(({ type }) => type === "promotion_playlist"))
      .toHaveLength(2);
    expect(stored.published).toEqual(current.published);
    expect(stored.homeConversionReceipt).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      version: 5,
      mintedIds: expectedMintedIds,
    });

    const [history] = await docsIn("cmsVersionHistory");
    expect(history.action).toBe("update");
    expect(history.before).toEqual(current);
    expect(history.after).toEqual(stored);
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({ action: "cms.save", target: "cmsPages/home" }),
    ]);
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
  });

  it("converts a legacy Home that has no manual shelf without adding one", async () => {
    await db.collection("cmsPages").doc("home").set(legacyHome());

    const res = await saveHomeThroughProductionBoundary(
      homeConversionRequest(),
      { mintId: sequentialMinter("home") },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.blocks).toHaveLength(7);
    expect(res.body.document.blocks.some(
      ({ type }) => type === "promotion_playlist",
    )).toBe(false);
  });

  it.each([
    ["createOnly", { createOnly: false }],
    ["publish", { publish: false }],
    ["scheduleAt", { scheduleAt: "2026-09-07T20:00:00.000Z" }],
    ["idempotencyKey", { idempotencyKey: "another-request-key" }],
    ["seedFromLegacyPage", { seedFromLegacyPage: { id: "home", version: 4 } }],
    ["section", { section: "watch" }],
  ])(
    "rejects the %s envelope field on Home conversion",
    async (_field, extra) => {
      const current = legacyHome();
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary(
        homeConversionRequest(extra),
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/cannot include another save or publication action/i);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it.each([
    ["metadata", { title: "Client replacement" }],
    ["composition marker", { homeCompositionVersion: 1 }],
  ])(
    "rejects Home conversion document %s",
    async (_label, extraDocument) => {
      const current = legacyHome();
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary(homeConversionRequest({
        document: { blocks: homeCompositionDefaults(), ...extraDocument },
      }));

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/accepts only the seven proposed Home regions/i);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it("rejects Home conversion for another page", async () => {
    const res = await saveThroughProductionBoundary({
      collection: "cmsPages",
      id: "watch",
      ...homeConversionRequest(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only available for cmsPages\/home/i);
    expect(await docsIn("cmsPages")).toHaveLength(0);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("requires an existing legacy Home and its exact version", async () => {
    const absent = await saveHomeThroughProductionBoundary(homeConversionRequest());
    expect(absent.statusCode).toBe(409);
    expect(absent.body.error).toMatch(/open a saved Home draft/i);
    expect(await docsIn("cmsPages")).toHaveLength(0);

    const current = legacyHome();
    await db.collection("cmsPages").doc("home").set(current);
    const missingVersionRequest = homeConversionRequest();
    delete missingVersionRequest.baseVersion;
    const missingVersion = await saveHomeThroughProductionBoundary(
      missingVersionRequest,
    );
    expect(missingVersion.statusCode).toBe(400);
    expect(missingVersion.body.error).toMatch(/exact saved baseVersion/i);

    const newer = { ...current, version: 5 };
    await db.collection("cmsPages").doc("home").set(newer);
    const stale = await saveHomeThroughProductionBoundary(homeConversionRequest());
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened/i);
    await expectRejectedHomeSaveWroteNothing(newer);
  });

  it.each([
    [
      "missing",
      (blocks) => blocks.filter(({ section }) => section !== "home-spotlight"),
      /seven Home regions/i,
    ],
    [
      "hidden",
      (blocks) => blocks.map((block) =>
        block.section === "home-more" ? { ...block, visible: false } : block),
      /home-more region visible/i,
    ],
    [
      "wrong-source",
      (blocks) => blocks.map((block) =>
        block.section === "home-featured"
          ? { ...block, data: { ...block.data, source: "pbs_more" } }
          : block),
      /assigned source/i,
    ],
  ])(
    "rejects conversion with a %s required Home region",
    async (_label, change, error) => {
      const current = legacyHome();
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary(homeConversionRequest({
        document: { blocks: change(homeCompositionDefaults()) },
      }));

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(error);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it.each(["approved", "in_review", "scheduled", "published", "archived"])(
    "refuses Home conversion while the legacy record is %s",
    async (status) => {
      const current = legacyHome({
        status,
        ...(status === "scheduled"
          ? { publishAt: "2026-09-07T20:00:00.000Z" }
          : {}),
      });
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary(homeConversionRequest());

      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatch(/open a saved Home draft/i);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it("refuses Home conversion while publication is pending", async () => {
    const current = legacyHome({ publishBuildPending: true });
    await db.collection("cmsPages").doc("home").set(current);

    const res = await saveHomeThroughProductionBoundary(homeConversionRequest());

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/no publication in progress/i);
    await expectRejectedHomeSaveWroteNothing(current);
  });

  it("authorizes the legacy Home record before converting it", async () => {
    const current = legacyHome();
    await db.collection("cmsPages").doc("home").set(current);
    const contributor = () => ({
      uid: "contributor-1",
      email: "contributor-1@example.com",
      principal: {
        id: "contributor-1",
        grants: [{ role: "contributor" }],
      },
    });

    const res = await saveHomeThroughProductionBoundary(
      homeConversionRequest(),
      { requirePrincipalFn: contributor },
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("You do not have permission to save this record.");
    await expectRejectedHomeSaveWroteNothing(current);
  });

  it.each([
    ["an unreadable block list", { blocks: { recovery: "not-an-array" } }, /not readable/i],
    [
      "a malformed manual shelf",
      {
        blocks: [promotionShelf({
          id: "broken-manual",
          data: { title: "Broken shelf" },
        })],
      },
      /block/i,
    ],
    [
      "more than eight manual shelves",
      {
        blocks: Array.from({ length: 9 }, (_unused, index) =>
          promotionShelf({ id: `manual-${index}`, order: index }),
        ),
      },
      /more than eight manual shelves/i,
    ],
  ])(
    "refuses Home conversion when recovery content has %s",
    async (_label, legacyFields, error) => {
      const current = legacyHome(legacyFields);
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary(homeConversionRequest());

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(error);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it("replays the exact conversion receipt without another write", async () => {
    await db.collection("cmsPages").doc("home").set(legacyHome());
    const mintId = vi.fn(sequentialMinter("home"));
    const request = homeConversionRequest();

    const first = await saveHomeThroughProductionBoundary(request, { mintId });
    expect(first.statusCode).toBe(200);
    const firstState = {
      page: (await db.collection("cmsPages").doc("home").get()).data(),
      history: await docsIn("cmsVersionHistory"),
      audit: await docsIn("admin_logs"),
      usage: await docsIn("cmsPages/home/mediaUsage"),
      queue: await docsIn("cmsPublishQueue"),
    };

    const replay = await saveHomeThroughProductionBoundary(request, { mintId });

    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      created: false,
      replayed: true,
      mintedIds: first.body.mintedIds,
      document: first.body.document,
    });
    expect(mintId).toHaveBeenCalledTimes(7);
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toEqual(firstState.page);
    expect(await docsIn("cmsVersionHistory")).toEqual(firstState.history);
    expect(await docsIn("admin_logs")).toEqual(firstState.audit);
    expect(await docsIn("cmsPages/home/mediaUsage")).toEqual(firstState.usage);
    expect(await docsIn("cmsPublishQueue")).toEqual(firstState.queue);
  });

  it("does not replay a different nonce, payload, or principal", async () => {
    await db.collection("cmsPages").doc("home").set(legacyHome());
    const request = homeConversionRequest();
    const first = await saveHomeThroughProductionBoundary(request, {
      mintId: sequentialMinter("home"),
    });
    expect(first.statusCode).toBe(200);
    const changedBlocks = homeCompositionDefaults();
    changedBlocks.find(({ section }) => section === "home-featured").data.title =
      "A different valid proposal";
    const anotherAdmin = () => ({
      uid: "u2",
      email: "u2@x",
      principal: { id: "u2", grants: [{ role: "admin" }] },
    });
    const attempts = [
      [homeConversionRequest({ convertHome: "another-request-nonce" }), {}],
      [homeConversionRequest({ document: { blocks: changedBlocks } }), {}],
      [request, { requirePrincipalFn: anotherAdmin }],
    ];

    for (const [body, deps] of attempts) {
      const res = await saveHomeThroughProductionBoundary(body, deps);
      expect(res.statusCode).toBe(409);
      expect(res.body.replayed).not.toBe(true);
    }
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toEqual(first.body.document);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn("admin_logs")).toHaveLength(1);
  });

  it("keeps the server receipt through an ordinary save and refuses an old replay", async () => {
    await db.collection("cmsPages").doc("home").set(legacyHome());
    const request = homeConversionRequest();
    const converted = await saveHomeThroughProductionBoundary(request, {
      mintId: sequentialMinter("home"),
    });
    expect(converted.statusCode).toBe(200);
    const receipt = converted.body.document.homeConversionReceipt;

    const advanced = await saveHomeThroughProductionBoundary({
      baseVersion: 5,
      document: {
        title: "Advanced converted Home",
        homeConversionReceipt: {
          fingerprint: "forged",
          version: 999,
          mintedIds: { forged: "forged" },
        },
      },
    });

    expect(advanced.statusCode).toBe(200);
    expect(advanced.body.document).toMatchObject({
      title: "Advanced converted Home",
      version: 6,
      homeConversionReceipt: receipt,
    });
    const beforeReplay = {
      page: (await db.collection("cmsPages").doc("home").get()).data(),
      history: await docsIn("cmsVersionHistory"),
      audit: await docsIn("admin_logs"),
    };

    const replay = await saveHomeThroughProductionBoundary(request);

    expect(replay.statusCode).toBe(409);
    expect(replay.body.error).toMatch(/Home changed after conversion/i);
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toEqual(beforeReplay.page);
    expect(await docsIn("cmsVersionHistory")).toEqual(beforeReplay.history);
    expect(await docsIn("admin_logs")).toEqual(beforeReplay.audit);
  });

  it("lets only one different conversion attempt win a race", async () => {
    await db.collection("cmsPages").doc("home").set(legacyHome());
    const firstBarrier = readBarrier();
    const secondBarrier = readBarrier();
    secondBarrier.release();
    let firstSaving;
    let secondSaving;
    let responses;

    try {
      firstSaving = saveHomeThroughProductionBoundary(
        homeConversionRequest({ convertHome: "race-request-nonce-a" }),
        { firestore: firestorePausedAfterRead(db, firstBarrier) },
      );
      await firstBarrier.atRead;
      secondSaving = saveHomeThroughProductionBoundary(
        homeConversionRequest({ convertHome: "race-request-nonce-b" }),
        { firestore: firestorePausedAfterRead(db, secondBarrier) },
      );
      await secondBarrier.atRead;
      firstBarrier.release();
      responses = await Promise.all([firstSaving, secondSaving]);
    } finally {
      firstBarrier.release();
      secondBarrier.release();
      await Promise.allSettled([firstSaving, secondSaving].filter(Boolean));
    }

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect(firstBarrier.reads + secondBarrier.reads).toBeGreaterThanOrEqual(3);
    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toMatchObject({ homeCompositionVersion: 1, version: 5 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn("admin_logs")).toHaveLength(1);
  }, 10000);

  it("refuses conversion when its complete history row does not fit", async () => {
    const current = legacyHome({
      blocks: Array.from({ length: 20 }, (_unused, index) =>
        prose({ id: `legacy-${index}`, order: index, text: "x".repeat(5_000) })),
    });
    await db.collection("cmsPages").doc("home").set(current);
    let attemptedHistory;
    const documentSizeErrorFn = vi.fn((document, _path, context = {}) => {
      if (context.label === "the version-history row for this save") {
        attemptedHistory = document;
        return {
          reason: "This conversion could not retain its complete history.",
          detail: "complete conversion history exceeds the test budget",
        };
      }
      return null;
    });

    const res = await saveHomeThroughProductionBoundary(
      homeConversionRequest(),
      { documentSizeErrorFn },
    );

    expect(res.statusCode).toBe(413);
    expect(attemptedHistory.before).toEqual(current);
    expect(firestoreDocumentBytes(attemptedHistory.after, "cmsPages/home"))
      .toBeLessThan(firestoreDocumentBytes(current, "cmsPages/home"));
    expect(documentSizeErrorFn.mock.calls.some(
      ([, , context]) => context?.label?.includes("bounded version-history"),
    )).toBe(false);
    await expectRejectedHomeSaveWroteNothing(current);
  });

  it("rejects an ordinary save that tries to convert legacy Home composition", async () => {
    const current = {
      id: "home",
      template: "home",
      title: "Legacy Home",
      status: "draft",
      blocks: [divider({ id: "legacy", order: 0 })],
      version: 4,
    };
    await db.collection("cmsPages").doc("home").set(current);

    const res = await saveHomeThroughProductionBoundary({
      baseVersion: 4,
      document: {
        homeCompositionVersion: 1,
        blocks: homeCompositionDefaults(),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/version-checked Home conversion/i);
    await expectRejectedHomeSaveWroteNothing(current);
  });

  it.each([
    ["absent", {}, 400, /current saved version/i],
    ["stale", { baseVersion: 6 }, 409, /changed since you opened/i],
  ])(
    "rejects an %s baseVersion when saving converted Home",
    async (_label, versionFields, status, error) => {
      const current = {
        id: "home",
        template: "home",
        title: "Converted Home",
        status: "draft",
        homeCompositionVersion: 1,
        blocks: homeCompositionDefaults(),
        version: 7,
      };
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary({
        ...versionFields,
        document: { title: "Edited Home" },
      });

      expect(res.statusCode).toBe(status);
      expect(res.body.error).toMatch(error);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it("saves valid converted Home content at the exact version without changing its published snapshot", async () => {
    const blocks = homeCompositionDefaults();
    const published = {
      metadata: { title: "Live Home", homeCompositionVersion: 1 },
      blocks: structuredClone(blocks),
      publishedAt: "2026-09-04T20:00:00.000Z",
      publishedBy: "publisher-1",
    };
    const current = {
      id: "home",
      template: "home",
      title: "Converted Home",
      status: "draft",
      homeCompositionVersion: 1,
      blocks,
      published,
      version: 7,
    };
    await db.collection("cmsPages").doc("home").set(current);
    const editedBlocks = structuredClone(blocks);
    editedBlocks.find(({ section }) => section === "home-featured").data.title =
      "Featured this week";

    const res = await saveHomeThroughProductionBoundary({
      baseVersion: 7,
      document: {
        blocks: editedBlocks,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ homeCompositionVersion: 1, version: 8 });
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.homeCompositionVersion).toBe(1);
    expect(stored.blocks.find(({ section }) => section === "home-featured").data.title)
      .toBe("Featured this week");
    expect(stored.published).toEqual(published);
    expect(stored.published.blocks).not.toEqual(stored.blocks);
  });

  it.each([
    ["missing", (blocks) => blocks.filter(({ section }) => section !== "home-spotlight"), /seven named regions/i],
    ["hidden", (blocks) => blocks.map((block) => block.section === "home-more" ? { ...block, visible: false } : block), /home-more region visible/i],
    ["wrong-source", (blocks) => blocks.map((block) => block.section === "home-featured" ? { ...block, data: { ...block.data, source: "pbs_more" } } : block), /assigned source/i],
  ])(
    "rejects a converted Home with a %s required region without writes",
    async (_label, change, error) => {
      const current = {
        id: "home",
        template: "home",
        title: "Converted Home",
        status: "draft",
        homeCompositionVersion: 1,
        blocks: homeCompositionDefaults(),
        version: 7,
      };
      await db.collection("cmsPages").doc("home").set(current);

      const res = await saveHomeThroughProductionBoundary({
        baseVersion: 7,
        document: {
          homeCompositionVersion: 1,
          blocks: change(structuredClone(current.blocks)),
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(error);
      await expectRejectedHomeSaveWroteNothing(current);
    },
  );

  it("lets the production save boundary change a Home shelf without changing older blocks", async () => {
    const ignored = divider({ id: "legacy", order: 0 });
    const storedShelf = promotionShelf({ id: "shelf", order: 1 });
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      template: "home",
      title: "Home",
      status: "draft",
      blocks: [ignored, storedShelf],
      version: 1,
    });
    const handler = createCmsSaveHandlerWithProductionBoundaries({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-27T20:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: {
            blocks: [
              ignored,
              promotionShelf({
                id: "shelf",
                order: 1,
                data: {
                  title: "Dolly Parton",
                  placement: "before_start",
                  cards: [],
                },
              }),
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.blocks[0]).toEqual(ignored);
    expect(res.body.document.blocks[1].data.title).toBe("Dolly Parton");
  });

  it("rejects a forged change to an ignored Home block", async () => {
    const ignored = divider({ id: "legacy", order: 0 });
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      template: "home",
      title: "Home",
      status: "draft",
      blocks: [ignored],
      version: 1,
    });
    const handler = createCmsSaveHandlerWithProductionBoundaries({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-27T20:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: { blocks: [{ ...ignored, visible: false }] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Only the manual content shelf/);
    expect((await db.collection("cmsPages").doc("home").get()).data().blocks).toEqual([
      ignored,
    ]);
  });

  it("rejects an unknown collection", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "widgets", document: {} } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Unknown collection");
  });

  it("rejects a non-object document", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "cmsPages", id: "home", document: "nope" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Document must be an object");
  });

  it("requires a URL slug when creating a page", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "cmsPages", document: { title: "x" } } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("A new page requires an available URL slug.");
  });

  it("rejects a page id outside the canonical public-page registry", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "genericPage",
          document: { template: "genericPage", blocks: [] },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Unknown public page id genericPage");
  });

  it("rejects a page template that does not match the canonical public-page registry", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          document: { template: "genericPage", blocks: [] },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "Page watch requires the programLanding editor template",
    );
  });

  it("admits the Staff directory singleton at its canonical save boundary", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "staff",
          document: {
            template: "genericPage",
            title: "Staff",
            description: "Meet the people who make NJ PBS.",
            blocks: [],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages").doc("staff").get()).data()).toMatchObject({
      id: "staff",
      template: "genericPage",
      title: "Staff",
      description: "Meet the people who make NJ PBS.",
      status: "draft",
      version: 1,
    });
  });

  it("refuses create-only page saves after another editor creates the document", async () => {
    await db.collection("cmsPages").doc("watch").set({
      id: "watch",
      template: "programLanding",
      title: "Newer page",
      status: "draft",
      blocks: [],
      version: 1,
    });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          createOnly: true,
          document: { template: "programLanding", title: "Legacy seed", blocks: [] },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/created since you opened it/i);
    expect((await db.collection("cmsPages").doc("watch").get()).data().title).toBe(
      "Newer page",
    );
  });

  it("copies legacy page metadata server-side when creating a page-specific document", async () => {
    const legacyPublished = {
      blocks: [divider({ id: "published-divider" })],
      publishedAt: "2026-01-02T00:00:00.000Z",
      publishedBy: "legacy-publisher",
    };
    await db.collection("cmsPages").doc("programLanding").set({
      id: "programLanding",
      template: "programLanding",
      title: "Legacy landing page",
      seo: { title: "Legacy SEO title", description: "Legacy SEO description" },
      status: "published",
      blocks: [divider({ id: "legacy-divider" })],
      published: legacyPublished,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      updatedBy: "legacy-editor",
      version: 7,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-21T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          createOnly: true,
          seedFromLegacyPage: { id: "programLanding", version: 7 },
          document: {
            template: "programLanding",
            blocks: [divider({ id: "legacy-divider" })],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(stored).toMatchObject({
      id: "watch",
      template: "programLanding",
      title: "Legacy landing page",
      seo: { title: "Legacy SEO title", description: "Legacy SEO description" },
      status: "published",
      published: legacyPublished,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
      updatedBy: "u1",
      version: 1,
    });
    expect(stored.blocks[0].id).toBe("srv-0");
    expect((await db.collection("cmsPages").doc("programLanding").get()).data()).toMatchObject({
      id: "programLanding",
      title: "Legacy landing page",
      version: 7,
    });
  });

  it("refuses a legacy seed that changed after the editor loaded it", async () => {
    await db.collection("cmsPages").doc("programLanding").set({
      id: "programLanding",
      template: "programLanding",
      title: "Newer legacy landing page",
      status: "draft",
      blocks: [],
      version: 8,
    });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          createOnly: true,
          seedFromLegacyPage: { id: "programLanding", version: 7 },
          document: { template: "programLanding", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/legacy page changed since you opened it/i);
    expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
  });

  it("refuses an oversized document with 413 instead of an opaque commit failure", async () => {
    // Thirty blocks is inside the forty-block count cap, so the size guard is the
    // only thing standing between this and Firestore's INVALID_ARGUMENT at commit
    // time. A count cap is not a size cap.
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    const fat = "x".repeat(40000);

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          document: {
            template: "programLanding",
            title: "Watch",
            blocks: Array.from({ length: 30 }, (_unused, index) =>
              prose({ id: `block-${index}`, text: fat }),
            ),
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/too large/);
    expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
  });

  it("names the publish snapshot when publishing is what exceeds the limit", async () => {
    // The document that fits as a draft and does not fit once the publish
    // snapshot is composed into it. This is the case the guard exists for: the
    // editor changed nothing, so a message about shortening what they typed
    // would send them looking for a mistake they did not make.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const fat = "x".repeat(40000);
    const blocks = Array.from({ length: 13 }, (_unused, index) =>
      prose({ id: `block-${index}`, text: fat }),
    );

    const saveRes = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          document: { template: "programLanding", title: "Watch", blocks },
        },
      }),
      saveRes,
    );
    expect(saveRes.statusCode).toBe(200);
    await db.collection("cmsPages").doc("watch").update({ status: "approved" });

    const publishRes = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          publish: true,
          baseVersion: 1,
          document: {},
        },
      }),
      publishRes,
    );

    expect(publishRes.statusCode).toBe(413);
    expect(publishRes.body.error).toMatch(/could not be published/);
    expect(publishRes.body.error).toMatch(/roughly doubles/);
    // The approved version it refused to publish is untouched.
    const stored = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(stored.status).toBe("approved");
    expect(stored.version).toBe(1);
  });

  it("refuses a scheduled save whose future publish snapshot would exceed the limit", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
    });
    const fat = "x".repeat(34000);
    const saveRes = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          document: {
            template: "programLanding",
            title: "Watch",
            blocks: Array.from({ length: 13 }, (_unused, index) =>
              prose({ id: `block-${index}`, text: fat }),
            ),
          },
        },
      }),
      saveRes,
    );
    expect(saveRes.statusCode).toBe(200);
    await db.collection("cmsPages").doc("watch").update({ status: "approved" });

    const res = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "watch",
        baseVersion: 1,
        scheduleAt: "2026-07-20T12:00:00.000Z",
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/could not be published/);
    expect(res.body.error).toMatch(/roughly doubles/);
    expect((await db.collection("cmsPages").doc("watch").get()).data())
      .toMatchObject({ status: "approved", version: 1 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
  });

  it("reports scheduled publish-readiness refusals without an unexpected error log", async () => {
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      log,
      now: () => "2026-07-15T12:00:00.000Z",
    });
    await db.collection("cmsPages").doc("watch").set({
      id: "watch",
      template: "programLanding",
      status: "approved",
      blocks: [divider({ id: "divider" })],
      version: 1,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          scheduleAt: "2026-07-20T12:00:00.000Z",
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("title is required");
    expect(log.error).not.toHaveBeenCalled();
    expect((await db.collection("cmsPages").doc("watch").get()).data())
      .toMatchObject({ status: "approved", version: 1 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("keeps an already scheduled non-post record frozen until cancellation", async () => {
    await db.collection("cmsPosts").doc("legacy-program").set({
      id: "legacy-program",
      type: "program",
      title: "Legacy program",
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Synopsis" }] }],
      },
      status: "scheduled",
      publishAt: "2026-07-20T12:00:00.000Z",
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-program",
          baseVersion: 1,
          document: { title: "Revised legacy program" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cancel scheduled publication/i);
    expect(
      (await db.collection("cmsPosts").doc("legacy-program").get()).data(),
    ).toMatchObject({
      title: "Legacy program",
      status: "scheduled",
      version: 1,
    });
  });

  it("measures version history at the auto-generated document path it writes", async () => {
    const measuredHistoryPaths = [];
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      documentSizeErrorFn: (document, path, context) => {
        if (context?.label?.includes("version-history")) {
          measuredHistoryPaths.push(path);
        }
        return documentSizeError(document, path, context);
      },
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          document: {
            template: "programLanding",
            title: "Watch",
            blocks: [divider({ id: "divider" })],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const [history] = await docsIn("cmsVersionHistory");
    expect(measuredHistoryPaths).toEqual([
      `cmsVersionHistory/${history.id}`,
    ]);
  });

  it("refuses when the version-history row, not the page, is what overflows", async () => {
    // The case a content-document-only check misses. Re-publishing composes a
    // doubled document, and the history row carries the full before AND after, so
    // it reaches the ceiling while the page itself is still well inside it. Before
    // the history row was measured this returned Firestore's raw INVALID_ARGUMENT
    // as a 500.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const fat = "x".repeat(40000);
    // Sized so the first publish fits (draft + doubled = ~840 KB) and the second
    // does not (doubled + doubled = ~1.12 MB), while the page itself stays at
    // ~560 KB, well under the budget, throughout.
    const blocks = Array.from({ length: 7 }, (_unused, index) =>
      prose({ id: `block-${index}`, text: fat }),
    );
    const body = {
      collection: "cmsPages",
      id: "watch",
      document: { template: "programLanding", title: "Watch", blocks },
    };

    const first = makeRes();
    await handler(makeReq({ body }), first);
    expect(first.statusCode).toBe(200);
    await db.collection("cmsPages").doc("watch").update({ status: "approved" });

    const publishOnce = makeRes();
    await handler(
      makeReq({ body: {
        collection: "cmsPages",
        id: "watch",
        publish: true,
        baseVersion: 1,
        document: {},
      } }),
      publishOnce,
    );
    expect(publishOnce.statusCode).toBe(200);

    // The stored page is comfortably inside the budget on its own.
    const stored = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(
      firestoreDocumentBytes(stored, "cmsPages/watch"),
    ).toBeLessThan(DOCUMENT_SIZE_BUDGET_BYTES);
    await db.collection("cmsPages").doc("watch").update({ status: "approved" });

    // Re-publishing it makes before and after both the doubled document.
    const republish = makeRes();
    await handler(
      makeReq({ body: {
        collection: "cmsPages",
        id: "watch",
        publish: true,
        baseVersion: 2,
        document: {},
      } }),
      republish,
    );

    expect(republish.statusCode).toBe(413);
    expect(republish.body.error).toMatch(/too large/);
    // The published page is untouched, still at the version it reached.
    const after = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(after.version).toBe(2);
  });

  it("allows an oversized legacy page to be shortened with a bounded history row", async () => {
    const legacyText = "x".repeat(33000);
    const legacy = {
      id: "watch",
      title: "Legacy watch",
      template: "programLanding",
      status: "draft",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      version: 1,
    };
    const legacyBytes = firestoreDocumentBytes(legacy, "cmsPages/watch");
    expect(legacyBytes).toBeGreaterThan(DOCUMENT_SIZE_BUDGET_BYTES);
    expect(legacyBytes).toBeLessThan(MAX_DOCUMENT_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: "Shortened watch",
            blocks: [divider({ id: "short" })],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      title: "Shortened watch",
      version: 2,
    });
    const history = await docsIn("cmsVersionHistory");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      beforeTruncated: true,
      beforeEstimatedBytes: legacyBytes,
      before: { id: "watch", status: "draft", version: 1 },
      after: { title: "Shortened watch", version: 2 },
    });
    expect(history[0].before.blocks).toBeUndefined();
    const adminLogs = await docsIn("admin_logs");
    expect(adminLogs).toHaveLength(1);
    expect(adminLogs[0].before).toMatchObject({
      id: "watch",
      status: "draft",
      version: 1,
      beforeTruncated: true,
      beforeEstimatedBytes: legacyBytes,
    });
    expect(adminLogs[0].before.blocks).toBeUndefined();
  });

  it("allows a sub-budget page to shrink when its full history row is oversized", async () => {
    const legacyText = "x".repeat(30000);
    const revisedText = "x".repeat(25000);
    const legacy = {
      id: "watch",
      title: "Long watch",
      template: "programLanding",
      status: "draft",
      blocks: Array.from({ length: 20 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      version: 1,
    };
    const legacyBytes = firestoreDocumentBytes(legacy, "cmsPages/watch");
    expect(legacyBytes).toBeLessThan(DOCUMENT_SIZE_BUDGET_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: "Shorter watch",
            blocks: Array.from({ length: 20 }, (_unused, index) =>
              prose({ id: `block-${index}`, text: revisedText, order: index }),
            ),
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const saved = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(firestoreDocumentBytes(saved, "cmsPages/watch")).toBeLessThan(
      legacyBytes,
    );
    const history = await docsIn("cmsVersionHistory");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      beforeTruncated: true,
      beforeEstimatedBytes: legacyBytes,
      before: { id: "watch", status: "draft", version: 1 },
      after: { title: "Shorter watch", version: 2 },
    });
    expect(history[0].before.blocks).toBeUndefined();
  });

  it("routes an oversized legacy unpublish through the dedicated lifecycle action", async () => {
    const legacyText = "x".repeat(33000);
    const legacy = {
      id: "watch",
      title: "Legacy watch",
      template: "programLanding",
      status: "published",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      createdBy: "u1",
      version: 1,
    };
    const legacyBytes = firestoreDocumentBytes(legacy, "cmsPages/watch");
    expect(legacyBytes).toBeGreaterThan(DOCUMENT_SIZE_BUDGET_BYTES);
    expect(legacyBytes).toBeLessThan(MAX_DOCUMENT_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          // The editor sends its complete unchanged working copy with the
          // lifecycle change. No content field is allowed to ride the exception.
          document: {
            title: legacy.title,
            template: legacy.template,
            blocks: legacy.blocks,
            status: "draft",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/dedicated lifecycle action/i);
    const stored = (await db.collection("cmsPages").doc("watch").get()).data();
    expect(stored).toMatchObject({
      title: "Legacy watch",
      status: "published",
      version: 1,
    });
    expect(stored.blocks).toHaveLength(30);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("routes oversized scheduled-page cancellation through the lifecycle action", async () => {
    const legacyText = "x".repeat(33000);
    const legacy = {
      id: "watch",
      title: "Scheduled legacy watch",
      template: "programLanding",
      status: "scheduled",
      publishAt: "2026-07-20T12:00:00.000Z",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      createdBy: "u1",
      version: 1,
    };
    const legacyBytes = firestoreDocumentBytes(legacy, "cmsPages/watch");
    expect(legacyBytes).toBeGreaterThan(DOCUMENT_SIZE_BUDGET_BYTES);
    expect(legacyBytes).toBeLessThan(MAX_DOCUMENT_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: legacy.title,
            template: legacy.template,
            blocks: legacy.blocks,
            status: "draft",
            publishAt: "",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cancel scheduled publication/i);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      status: "scheduled",
      version: 1,
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("does not let a content save backfill a template while unpublishing", async () => {
    const legacyText = "x".repeat(33000);
    const legacy = {
      id: "watch",
      title: "Pre-template legacy watch",
      status: "published",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      createdBy: "u1",
      version: 1,
    };
    const legacyBytes = firestoreDocumentBytes(legacy, "cmsPages/watch");
    expect(legacyBytes).toBeGreaterThan(DOCUMENT_SIZE_BUDGET_BYTES);
    expect(legacyBytes).toBeLessThan(MAX_DOCUMENT_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: legacy.title,
            blocks: legacy.blocks,
            status: "draft",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/dedicated lifecycle action/i);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      status: "published",
      version: 1,
    });
    expect((await db.collection("cmsPages").doc("watch").get()).data().template)
      .toBeUndefined();
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("does not let a content save unpublish a sub-budget page", async () => {
    const legacyText = "x".repeat(20000);
    const legacy = {
      id: "watch",
      title: "Mid-sized legacy watch",
      template: "programLanding",
      status: "published",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      createdBy: "u1",
      version: 1,
    };
    expect(
      firestoreDocumentBytes(legacy, "cmsPages/watch"),
    ).toBeLessThan(DOCUMENT_SIZE_BUDGET_BYTES);
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: legacy.title,
            template: legacy.template,
            blocks: legacy.blocks,
            status: "draft",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/dedicated lifecycle action/i);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      title: "Mid-sized legacy watch",
      status: "published",
      version: 1,
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("still refuses content edits bundled with an oversized legacy unpublish", async () => {
    const legacyText = "x".repeat(33000);
    const legacy = {
      id: "watch",
      title: "Legacy watch",
      template: "programLanding",
      status: "published",
      blocks: Array.from({ length: 30 }, (_unused, index) =>
        prose({ id: `block-${index}`, text: legacyText, order: index }),
      ),
      createdBy: "u1",
      version: 1,
    };
    await db.collection("cmsPages").doc("watch").set(legacy);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: {
            title: "Changed while unpublishing",
            template: legacy.template,
            blocks: legacy.blocks,
            status: "draft",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/dedicated lifecycle action/i);
    expect((await db.collection("cmsPages").doc("watch").get()).data()).toMatchObject({
      title: "Legacy watch",
      status: "published",
      version: 1,
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("rejects an unknown status", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({ body: { collection: "cmsPages", id: "home", document: { status: "live" } } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Unknown status live");
  });

  it("keeps review-state changes explicit but publishes a saved version directly", async () => {
    const approved = {
      id: "home",
      title: "Reviewed home",
      template: "home",
      status: "approved",
      blocks: [],
      createdBy: "u1",
      scheduledPublishFailure: {
        failedAt: "2026-08-13T11:30:00.000Z",
        failedBy: "system:scheduler",
        reason: "The previous scheduled publication failed.",
      },
      version: 4,
    };
    await db.collection("cmsPages").doc("home").set(approved);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });

    const editRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 4,
        document: { title: "Changed after review" },
      },
    }), editRes);
    expect(editRes.statusCode).toBe(400);
    expect(editRes.body.error).toBe("Reopen approved content before editing.");

    await db.collection("cmsPages").doc("home").set({
      ...approved,
      status: "in_review",
    });
    const reviewEditRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 4,
        document: { title: "Changed during review" },
      },
    }), reviewEditRes);
    expect(reviewEditRes.statusCode).toBe(400);
    expect(reviewEditRes.body.error).toBe(
      "Select Edit before changing reviewed content.",
    );

    await db.collection("cmsPages").doc("home").set({
      ...approved,
      status: "draft",
    });
    const approveRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 4,
        document: { status: "approved" },
      },
    }), approveRes);
    expect(approveRes.statusCode).toBe(400);
    expect(approveRes.body.error).toMatch(/dedicated lifecycle action/i);

    const publishRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 4,
        publish: true,
        document: {},
      },
    }), publishRes);
    expect(publishRes.statusCode).toBe(200);

    expect((await db.collection("cmsPages").doc("home").get()).data())
      .toMatchObject({ status: "published", title: "Reviewed home", version: 5 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn("admin_logs")).toHaveLength(1);
  });

  it.each(["draft", "in_review", "approved"])("schedules the exact saved %s version through a future publish action", async status => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      template: "genericPage",
      title: "Contact NJ PBS",
      status,
      blocks: [],
      createdBy: "u1",
      version: 4,
    });
    const assertPublishReadyFn = vi.fn(async () => {});
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        baseVersion: 4,
        scheduleAt: "2026-08-14T09:30:00.000Z",
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      status: "scheduled",
      publishAt: "2026-08-14T09:30:00.000Z",
      version: 5,
    });
    expect(res.body.document.scheduledPublishFailure).toBeUndefined();
    expect(assertPublishReadyFn).toHaveBeenCalledWith({ firestore: db });
    expect(await docsIn("cmsVersionHistory")).toEqual([
      expect.objectContaining({ action: "schedule" }),
    ]);
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({ action: "cms.schedule" }),
    ]);
  });

  it.each(["draft", "in_review", "approved"])("lets a publisher schedule a %s Post without review", async status => {
    await db.collection("cmsPosts").doc("scheduled-post").set({
      id: "scheduled-post", type: "post", title: "Scheduled post", slug: "scheduled-post",
      status, section: "station", tags: [], blocks: [], createdBy: "u1", version: 4,
    });
    const handler = createCmsSaveHandler({
      firestore: db, requirePrincipalFn: adminOk, now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: async () => {},
    });
    const res = makeRes();
    await handler(makeReq({ body: {
      collection: "cmsPosts", id: "scheduled-post", baseVersion: 4, document: {},
      scheduleAt: "2026-08-14T09:30:00.000Z",
    } }), res);

    expect(res.statusCode).toBe(200);
    expect((await db.collection("cmsPosts").doc("scheduled-post").get()).data())
      .toMatchObject({ status: "scheduled", publishAt: "2026-08-14T09:30:00.000Z", version: 5 });
    expect(await docsIn("cmsVersionHistory")).toEqual([
      expect.objectContaining({ action: "schedule", before: expect.objectContaining({ status }) }),
    ]);
    expect(await docsIn("admin_logs")).toEqual([
      expect.objectContaining({ action: "cms.schedule" }),
    ]);
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
  });

  it.each(["draft", "in_review", "approved"])("refuses a Writer scheduling their own %s Post", async status => {
    const before = {
      id: "scheduled-post", type: "post", title: "Scheduled post", slug: "scheduled-post",
      status, section: "station", tags: [], blocks: [], createdBy: "u1", version: 4,
    };
    await db.collection("cmsPosts").doc(before.id).set(before);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({ uid: "u1", principal: { id: "u1", grants: [{ role: "contributor" }] } }),
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: async () => {},
    });
    const res = makeRes();
    await handler(makeReq({ body: {
      collection: "cmsPosts", id: before.id, baseVersion: 4, document: {},
      scheduleAt: "2026-08-14T09:30:00.000Z",
    } }), res);

    expect(res.statusCode).toBe(403);
    expect((await db.collection("cmsPosts").doc(before.id).get()).data()).toEqual(before);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
  });

  it.each([
    ["2026-02-28T15:30:00.000Z", 200],
    ["2026-02-28T15:30:00.001Z", 400],
  ])("enforces the New York one-month ceiling on post scheduling: %s", async (scheduleAt, expectedStatus) => {
    const before = {
      id: "scheduled-post", type: "post", title: "Scheduled post", slug: "scheduled-post",
      status: "approved", section: "station", tags: [], blocks: [], createdBy: "u1", version: 4,
    };
    await db.collection("cmsPosts").doc(before.id).set(before);
    const handler = createCmsSaveHandler({
      firestore: db, requirePrincipalFn: adminOk, now: () => "2026-01-31T15:30:00.000Z",
      assertPublishReadyFn: async () => {},
    });
    const res = makeRes();
    await handler(makeReq({ body: {
      collection: "cmsPosts", id: before.id, baseVersion: 4, document: {}, scheduleAt,
    } }), res);
    expect(res.statusCode).toBe(expectedStatus);
    const stored = (await db.collection("cmsPosts").doc(before.id).get()).data();
    if (expectedStatus === 200) {
      expect(stored).toMatchObject({ status: "scheduled", publishAt: scheduleAt, version: 5 });
      expect(stored.published).toBeUndefined();
    } else {
      expect(res.body.error).toMatch(/one calendar month/);
      expect(stored).toEqual(before);
      expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
      expect(await docsIn("admin_logs")).toHaveLength(0);
    }
  });

  it("refuses to schedule uploaded media until public deployment coordination is active", async () => {
    await seedMediaAsset("uploaded-image", { source: "upload" });
    const before = {
      id: "contact",
      template: "genericPage",
      title: "Contact NJ PBS",
      status: "approved",
      blocks: [image("uploaded-image")],
      createdBy: "u1",
      version: 4,
    };
    await db.collection("cmsPages").doc("contact").set(before);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        baseVersion: 4,
        scheduleAt: "2026-08-14T09:30:00.000Z",
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "Media asset uploaded-image cannot be published until public deployment coordination is active.",
      code: "media_publication_unavailable",
    });
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toEqual(before);
    expect(
      (await db.collection("cmsPages/contact/mediaUsage").get()).empty,
    ).toBe(true);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("normalizes a retained legacy post date before scheduling", async () => {
    await db.collection("cmsPosts").doc("station-update").set({
      id: "station-update",
      type: "post",
      title: "Station update",
      date: "2026-08-13T15:30:00.000Z",
      tags: ["station"],
      slug: "station-update",
      previousSlugs: [],
      locale: "en",
      status: "approved",
      blocks: [],
      createdBy: "u1",
      version: 4,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      id: "station-update",
      baseVersion: 4,
      scheduleAt: "2026-08-14T09:30:00.000Z",
      document: {},
    } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({
      status: "scheduled",
      date: "2026-08-13",
      version: 5,
    });
  });

  it("publishes an approved program into an immutable /programs/ snapshot", async () => {
    // The first non-post record kind with a public route (#923). The snapshot
    // freezes the program form's own fields, carries an empty block list because
    // a program has no block layout, and keeps key art opaque -- that value is a
    // PBS Media Manager identifier, not a station media asset.
    await db.collection("cmsPosts").doc("program-live").set({
      id: "program-live",
      type: "program",
      title: "Due Process",
      genre: "public affairs",
      keyArt: "pbsmm-asset-4821",
      memberOnly: true,
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
      status: "approved",
      createdBy: "u1",
      version: 4,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
      now: () => "2026-08-22T15:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      id: "program-live",
      baseVersion: 4,
      publish: true,
      document: {},
    } }), res);

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const stored = (await db.collection("cmsPosts").doc("program-live").get()).data();
    expect(stored).toMatchObject({
      status: "published",
      publiclyVisible: true,
      version: 5,
    });
    expect(stored.published).toMatchObject({
      blocks: [],
      publishedAt: "2026-08-22T15:00:00.000Z",
      sourceVersion: 5,
      metadata: {
        type: "program",
        title: "Due Process",
        genre: "public affairs",
        keyArt: "pbsmm-asset-4821",
        memberOnly: true,
        slug: "due-process",
        previousSlugs: [],
        locale: "en",
      },
    });
    // Workflow state stays on the working document, never in the public snapshot.
    expect(stored.published.metadata.status).toBeUndefined();
    expect(stored.published.metadata.createdBy).toBeUndefined();
  });

  it("refuses to publish a record kind with no public route", async () => {
    const stored = {
      id: "newsletter-1",
      type: "newsletter",
      title: "The weekly",
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Every Friday." }] },
        ],
      },
      status: "approved",
      createdBy: "u1",
      version: 4,
    };
    await db.collection("cmsPosts").doc("newsletter-1").set(stored);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      id: "newsletter-1",
      baseVersion: 4,
      publish: true,
      document: {},
    } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no public route/i);
    expect((await db.collection("cmsPosts").doc("newsletter-1").get()).data())
      .toEqual(stored);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  // Program and Event have public routes. Sponsor remains a library kind, so
  // scheduling it must still be refused at the save boundary.
  it("rejects scheduling for cmsPosts kinds that have no public route", async () => {
    const stored = {
      id: "sponsor-1",
      type: "sponsor",
      name: "NJ Foundation",
      status: "approved",
      createdBy: "u1",
      version: 4,
    };
    await db.collection("cmsPosts").doc("sponsor-1").set(stored);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      id: "sponsor-1",
      baseVersion: 4,
      scheduleAt: "2026-08-14T09:30:00.000Z",
      document: {},
    } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/only content with a public route can be scheduled/i);
    expect((await db.collection("cmsPosts").doc("sponsor-1").get()).data())
      .toEqual(stored);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("schedules an approved program, which now has a public route", async () => {
    await db.collection("cmsPosts").doc("program-1").set({
      id: "program-1",
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
      status: "approved",
      createdBy: "u1",
      version: 4,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      id: "program-1",
      baseVersion: 4,
      scheduleAt: "2026-08-14T09:30:00.000Z",
      document: {},
    } }), res);

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const stored = (await db.collection("cmsPosts").doc("program-1").get()).data();
    expect(stored).toMatchObject({
      status: "scheduled",
      publishAt: "2026-08-14T09:30:00.000Z",
      version: 5,
    });
    // Scheduling freezes nothing yet: the scheduled runner writes the snapshot.
    expect(stored.published).toBeUndefined();
    // A program is a structured form, so scheduling it must not invent a block
    // list its editor contract does not own.
    expect(stored.blocks).toBeUndefined();
  });

  it.each([
    ["draft", { social: { imageAssetId: 42 } }, /social\.imageAssetId/i],
    ["in_review", { social: { imageAssetId: 42 } }, /social\.imageAssetId/i],
    ["approved", { social: { imageAssetId: 42 } }, /social\.imageAssetId/i],
    ["draft", { blocks: [{ id: "bad", type: "not-a-block", order: 0, visible: true, data: {} }] }, /block/i],
    ["in_review", { blocks: [{ id: "bad", type: "not-a-block", order: 0, visible: true, data: {} }] }, /block/i],
    ["approved", { blocks: [{ id: "bad", type: "not-a-block", order: 0, visible: true, data: {} }] }, /block/i],
  ])("validates the complete %s document before scheduling (%o)", async (status, invalid, message) => {
    const stored = {
      id: "contact",
      template: "genericPage",
      title: "Contact NJ PBS",
      status,
      blocks: [],
      createdBy: "u1",
      version: 4,
      ...invalid,
    };
    await db.collection("cmsPages").doc("contact").set(stored);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
      assertPublishReadyFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPages",
      id: "contact",
      baseVersion: 4,
      scheduleAt: "2026-08-14T09:30:00.000Z",
      document: {},
    } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(message);
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toEqual(stored);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("requires an exact base version for manual publication", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      template: "genericPage",
      title: "Contact NJ PBS",
      status: "approved",
      blocks: [],
      createdBy: "u1",
      version: 4,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/exact saved baseVersion/i);
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toMatchObject({ status: "approved", version: 4 });
  });

  it("refuses scheduling published content, in the past, or through a status field", async () => {
    const draft = {
      id: "contact",
      template: "genericPage",
      title: "Contact NJ PBS",
      status: "draft",
      blocks: [],
      createdBy: "u1",
      version: 4,
    };
    await db.collection("cmsPages").doc("contact").set({ ...draft, status: "published" });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-08-13T12:00:00.000Z",
    });

    const publishedRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        baseVersion: 4,
        scheduleAt: "2026-08-14T09:30:00.000Z",
        document: {},
      },
    }), publishedRes);
    expect(publishedRes.statusCode).toBe(400);
    expect(publishedRes.body.error).toMatch(/save this content as a draft before scheduling/i);

    await db.collection("cmsPages").doc("contact").set({
      ...draft,
      status: "approved",
    });
    const pastRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        baseVersion: 4,
        scheduleAt: "2026-08-13T11:59:59.999Z",
        document: {},
      },
    }), pastRes);
    expect(pastRes.statusCode).toBe(400);
    expect(pastRes.body.error).toMatch(/future/i);

    await db.collection("cmsPages").doc("contact").set(draft);
    const statusRes = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "contact",
        baseVersion: 4,
        document: {
          status: "scheduled",
          publishAt: "2026-08-14T09:30:00.000Z",
        },
      },
    }), statusRes);
    expect(statusRes.statusCode).toBe(400);
    expect(statusRes.body.error).toMatch(/dedicated scheduling action/i);
    expect((await db.collection("cmsPages").doc("contact").get()).data())
      .toEqual(draft);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("rejects a type-invalid block payload before any write or audit", async () => {
    const versionHistoryEntryFn = vi.fn();
    const adminLogEntryFn = vi.fn();
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      versionHistoryEntryFn,
      adminLogEntryFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: {
            title: "Home",
            // a headline whose level is a string is invalid data for the type
            blocks: [{ id: "h", type: "headline", order: 0, visible: true, data: { text: "x", level: "two" } }],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("blocks[0] has invalid data for headline");
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(adminLogEntryFn).not.toHaveBeenCalled();
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("rejects a valid block type that is outside the page's editor template", async () => {
    const versionHistoryEntryFn = vi.fn();
    const adminLogEntryFn = vi.fn();
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
      versionHistoryEntryFn,
      adminLogEntryFn,
    });
    const res = makeRes();

    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Contact",
      template: "genericPage",
      status: "approved",
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

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          baseVersion: 1,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(adminLogEntryFn).not.toHaveBeenCalled();
    expect(await docsIn("cmsPages")).toHaveLength(1);
  });

  it("validates retained page blocks during a metadata-only publish", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Legacy contact",
      template: "genericPage",
      status: "approved",
      // Simulates a legacy/imported working copy that predates the server
      // template gate. Omitting blocks from the publish request must not bypass it.
      blocks: [
        {
          id: "cards",
          type: "card_grid",
          order: 0,
          visible: true,
          data: { cards: [] },
        },
      ],
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          baseVersion: 3,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);
    expect(
      (await db.collection("cmsPages").doc("contact").get()).data(),
    ).toMatchObject({
      status: "approved",
      title: "Legacy contact",
      version: 3,
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("validates retained metadata during a metadata-only publish", async () => {
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      title: "Legacy contact",
      template: "genericPage",
      status: "approved",
      blocks: [],
      // Simulates malformed imported metadata that was never sent by this
      // partial publish request.
      social: { title: 42 },
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          baseVersion: 3,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("social.title must be a string");
    expect(
      (await db.collection("cmsPages").doc("contact").get()).data(),
    ).toMatchObject({
      status: "approved",
      title: "Legacy contact",
      version: 3,
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("normalizes a stored legacy post instant during a metadata-only publish", async () => {
    await db.collection("cmsPosts").doc("legacy-station-update").set({
      id: "legacy-station-update",
      type: "post",
      title: "Published station update",
      date: "2026-07-24 23:30:00-04:00",
      tags: ["station"],
      slug: "legacy-station-update",
      previousSlugs: [],
      locale: "en",
      status: "approved",
      blocks: [],
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-25T12:00:00.000Z",
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-station-update",
          baseVersion: 3,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const post = (
      await db.collection("cmsPosts").doc("legacy-station-update").get()
    ).data();
    expect(post.date).toBe("2026-07-24");
    expect(post.published.metadata.date).toBe("2026-07-24");
    const history = await docsIn("cmsVersionHistory");
    expect(history[0].before.date).toBe("2026-07-24 23:30:00-04:00");
    expect(history[0].after.date).toBe("2026-07-24");
  });

  it("rejects a newly submitted post instant instead of treating it as stored legacy data", async () => {
    await db.collection("cmsPosts").doc("station-update").set({
      id: "station-update",
      type: "post",
      title: "Station update",
      date: "2026-07-24",
      tags: ["station"],
      slug: "station-update",
      previousSlugs: [],
      locale: "en",
      status: "in_review",
      blocks: [],
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "station-update",
          baseVersion: 3,
          publish: true,
          // Omitting type forces the composed boundary to identify the retained post.
          document: { date: "2026-07-24T15:30:00.000Z" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("date must be a valid date");
    expect(
      (await db.collection("cmsPosts").doc("station-update").get()).data(),
    ).toMatchObject({ date: "2026-07-24", version: 3 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("rejects an invalid date in a partial existing-post save that omits type", async () => {
    await db.collection("cmsPosts").doc("partial-post").set({
      id: "partial-post",
      type: "post",
      title: "Partial post",
      date: "2026-07-24",
      tags: [],
      slug: "partial-post",
      previousSlugs: [],
      locale: "en",
      status: "draft",
      blocks: [],
      version: 2,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "partial-post",
          baseVersion: 2,
          document: { date: 42 },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("date must be a string");
    expect(
      (await db.collection("cmsPosts").doc("partial-post").get()).data(),
    ).toMatchObject({ date: "2026-07-24", version: 2 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  // --- the story-date contract (#1041) ---
  //
  // Four separate facts: when the story first published, which day it displays,
  // when it was last meaningfully updated, and whether readers are told about that
  // update. The pure decisions and their time-zone behaviour are covered in
  // site/tests/editorial-dates.test.ts; these cases are about the save boundary
  // actually applying them, in a real transaction, to a real stored document.

  const storePost = async (id, fields) => {
    await db
      .collection("cmsPosts")
      .doc(id)
      .set({
        id,
        type: "post",
        title: "Station update",
        tags: [],
        slug: id,
        previousSlugs: [],
        locale: "en",
        status: "draft",
        blocks: [],
        version: 2,
        ...fields,
      });
  };

  const savePost = async (body, { principal = adminOk, ...deps } = {}) => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: principal,
      enablePublishSnapshot: true,
      ...deps,
    });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "cmsPosts", ...body } }), res);
    return res;
  };

  const readPost = async (id) => (await db.collection("cmsPosts").doc(id).get()).data();

  it.each([
    ["publish", { publish: true }],
    ["schedule", { scheduleAt: "2026-09-08T12:00:00.000Z" }],
  ])("refuses %s for an incomplete Interactive/Data Lab Post", async (_action, request) => {
    await storePost("interactive-post", {
      status: "approved",
      tags: ["format:interactive"],
    });

    const res = await savePost(
      {
        id: "interactive-post",
        baseVersion: 2,
        document: {},
        ...request,
      },
      { now: () => "2026-09-07T12:00:00.000Z" },
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "An Interactive/Data Lab Post must include at least one complete data figure or table, custom HTML block, or approved media or interactive link.",
    );
    expect(await readPost("interactive-post")).toMatchObject({
      status: "approved",
      version: 2,
      tags: ["format:interactive"],
    });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("saves a post draft with no editorial date at all", async () => {
    // The bug this contract exists for: `date` used to be required, so an editor
    // had to type one to save, and the day they started writing became the day the
    // post claimed to have published.
    const res = await savePost({
      section: "watch",
      document: postDraft("Draft with no date", { date: "" }),
    });

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const [post] = await docsIn("cmsPosts");
    // A blank editorial date is a no-op, not a stored empty string: the record has
    // no editorial date at all until publication mints one.
    expect(post.date).toBeUndefined();
    expect(post.editorialDateSource).toBeUndefined();
    expect(post.firstPublishedAt).toBeUndefined();
  });

  it("saves a post draft with a video block through the generated validator (#2751)", async () => {
    const res = await savePost({
      section: "watch",
      document: postDraft("Draft with a video", {
        blocks: [{
          id: "video-1",
          type: "video",
          order: 0,
          visible: true,
          data: {
            sourceId: "video-library",
            assetId: "clip-1",
            title: "County meeting",
            // Server-owned: a client value never reaches the stored draft.
            public: { url: "https://media.njpbs.org/cms-media/video/clip-1/" + "a".repeat(64) + ".mp4" },
          },
        }],
      }),
    });

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const [post] = await docsIn("cmsPosts");
    expect(post.blocks).toEqual([expect.objectContaining({
      type: "video",
      data: { sourceId: "video-library", assetId: "clip-1", title: "County meeting" },
    })]);
  });

  it("mints the first publish time from server time when publication completes", async () => {
    await storePost("first-publish", {
      status: "approved",
      categories: ["Station news", "Press releases"],
      tags: ["Announcement", "Staff"],
    });
    // 11:30 p.m. in New Jersey, which is the following day in UTC. The editorial
    // date has to read as the day the newsroom published, not the UTC day.
    const at = "2026-08-14T03:30:00.000Z";

    const res = await savePost(
      { id: "first-publish", baseVersion: 2, publish: true, document: {} },
      { now: () => at },
    );

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const post = await readPost("first-publish");
    expect(post.firstPublishedAt).toBe(at);
    expect(post.firstPublishedBy).toBe("u1");
    expect(post.editorialDateSource).toBe("firstPublish");
    expect(post.date).toBe("2026-08-13");
    expect(post.published.metadata.firstPublishedAt).toBe(at);
    expect(post.published.metadata.date).toBe("2026-08-13");
    expect(post.published.metadata.categories).toEqual([
      "Station news",
      "Press releases",
    ]);
    expect(post.published.metadata.tags).toEqual(["Announcement", "Staff"]);
  });

  it("does not move the first publish time when a revision is published", async () => {
    const first = "2026-08-14T03:30:00.000Z";
    await storePost("republished", {
      status: "approved",
      publiclyVisible: true,
      date: "2026-08-13",
      editorialDateSource: "firstPublish",
      firstPublishedAt: first,
      firstPublishedBy: "u-first",
      published: {
        blocks: [],
        metadata: { type: "post", title: "Station update", date: "2026-08-13", tags: [] },
        publishedAt: first,
        publishedBy: "u-first",
        sourceVersion: 2,
      },
    });

    const res = await savePost(
      // Publishing an approved record carries no content edits: it puts out exactly
      // the version that was approved.
      { id: "republished", baseVersion: 2, publish: true, document: {} },
      { now: () => "2026-09-01T15:00:00.000Z" },
    );

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const post = await readPost("republished");
    expect(post.firstPublishedAt).toBe(first);
    expect(post.firstPublishedBy).toBe("u-first");
    expect(post.date).toBe("2026-08-13");
    // This revision went out today; the story still first ran in August.
    expect(post.published.publishedAt).toBe("2026-09-01T15:00:00.000Z");
    expect(post.published.metadata.firstPublishedAt).toBe(first);
  });

  it("never invents a first publish time for a post that was already public", async () => {
    await storePost("legacy-public", {
      status: "approved",
      publiclyVisible: true,
      date: "2019-04-02",
      published: {
        blocks: [],
        metadata: { type: "post", title: "Station update", date: "2019-04-02", tags: [] },
        publishedAt: "2026-01-05T12:00:00.000Z",
        publishedBy: "u-old",
        sourceVersion: 1,
      },
    });

    const res = await savePost(
      { id: "legacy-public", baseVersion: 2, publish: true, document: {} },
      { now: () => "2026-09-01T15:00:00.000Z" },
    );

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const post = await readPost("legacy-public");
    expect(post.firstPublishedAt).toBeUndefined();
    expect(post.date).toBe("2019-04-02");
    expect(post.published.metadata.date).toBe("2019-04-02");
  });

  it("records a meaningful update only when the editor asks, and clears the request", async () => {
    await storePost("update-decision", {
      date: "2026-08-13",
      editorialDateSource: "firstPublish",
      firstPublishedAt: "2026-08-14T03:30:00.000Z",
      publiclyVisible: true,
    });

    const asked = await savePost(
      {
        id: "update-decision",
        baseVersion: 2,
        document: { type: "post", recordMeaningfulUpdate: true, showUpdatedDate: true },
      },
      { now: () => "2026-08-20T14:00:00.000Z" },
    );

    expect([asked.statusCode, asked.body?.error]).toEqual([200, undefined]);
    let post = await readPost("update-decision");
    expect(post.meaningfulUpdatedAt).toBe("2026-08-20T14:00:00.000Z");
    expect(post.meaningfulUpdatedBy).toBe("u1");
    expect(post.showUpdatedDate).toBe(true);
    // One-shot: the request does not survive into the next save.
    expect(post.recordMeaningfulUpdate).toBe(false);

    // A typo fix the day after. The story was not meaningfully updated again.
    const typoFix = await savePost(
      {
        id: "update-decision",
        baseVersion: 3,
        document: { type: "post", title: "Station update, corrected" },
      },
      { now: () => "2026-08-21T14:00:00.000Z" },
    );

    expect([typoFix.statusCode, typoFix.body?.error]).toEqual([200, undefined]);
    post = await readPost("update-decision");
    expect(post.meaningfulUpdatedAt).toBe("2026-08-20T14:00:00.000Z");
    expect(post.updatedAt).toBe("2026-08-21T14:00:00.000Z");
    expect(post.date).toBe("2026-08-13");
  });

  it("backdates a published post when an authorized editor sets the date", async () => {
    await storePost("backdate-me", {
      date: "2026-08-13",
      editorialDateSource: "firstPublish",
      firstPublishedAt: "2026-08-14T03:30:00.000Z",
      publiclyVisible: true,
    });

    const res = await savePost({
      id: "backdate-me",
      baseVersion: 2,
      document: { type: "post", date: "2026-07-04" },
    });

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const post = await readPost("backdate-me");
    expect(post.date).toBe("2026-07-04");
    expect(post.editorialDateSource).toBe("backdated");
    // Backdating changes what readers see, never the publication receipt.
    expect(post.firstPublishedAt).toBe("2026-08-14T03:30:00.000Z");
  });

  it("keeps a backdated date through a later publish", async () => {
    await storePost("backdated-publish", {
      status: "approved",
      date: "2026-07-04",
      editorialDateSource: "backdated",
    });

    const res = await savePost(
      { id: "backdated-publish", baseVersion: 2, publish: true, document: {} },
      { now: () => "2026-08-14T13:00:00.000Z" },
    );

    expect([res.statusCode, res.body?.error]).toEqual([200, undefined]);
    const post = await readPost("backdated-publish");
    expect(post.date).toBe("2026-07-04");
    expect(post.firstPublishedAt).toBe("2026-08-14T13:00:00.000Z");
    expect(post.published.metadata.date).toBe("2026-07-04");
  });

  it("leaves an ordinary round-tripped date alone and refuses an impossible one", async () => {
    await storePost("round-trip", {
      date: "2026-08-13",
      editorialDateSource: "firstPublish",
      firstPublishedAt: "2026-08-14T03:30:00.000Z",
      publiclyVisible: true,
    });

    // The admin form loads the record and posts the same day back with a title edit.
    const ordinary = await savePost({
      id: "round-trip",
      baseVersion: 2,
      document: { type: "post", title: "Station update, corrected", date: "2026-08-13" },
    });
    expect([ordinary.statusCode, ordinary.body?.error]).toEqual([200, undefined]);
    expect((await readPost("round-trip")).editorialDateSource).toBe("firstPublish");

    const impossible = await savePost({
      id: "round-trip",
      baseVersion: 3,
      document: { type: "post", date: "2026-02-30" },
    });
    expect(impossible.statusCode).toBe(400);
    expect(impossible.body.error).toBe("date must be a valid date");
  });

  it("leaves untouched legacy post dates and unrelated record date fields opaque", async () => {
    await db.collection("cmsPosts").doc("legacy-partial-post").set({
      id: "legacy-partial-post",
      type: "post",
      title: "Legacy partial post",
      date: 42,
      tags: [],
      slug: "legacy-partial-post",
      previousSlugs: [],
      locale: "en",
      status: "draft",
      blocks: [],
      version: 1,
    });
    await db.collection("cmsPosts").doc("event-with-date").set({
      id: "event-with-date",
      type: "event",
      title: "Community screening",
      date: 42,
      slug: "community-screening",
      previousSlugs: [],
      locale: "en",
      status: "draft",
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });

    const postRes = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-partial-post",
          baseVersion: 1,
          document: { title: "Updated legacy partial post" },
        },
      }),
      postRes,
    );
    expect(postRes.statusCode).toBe(200);
    expect(
      (await db.collection("cmsPosts").doc("legacy-partial-post").get()).data(),
    ).toMatchObject({
      title: "Updated legacy partial post",
      date: 42,
      version: 2,
    });

    const eventRes = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "event-with-date",
          baseVersion: 1,
          document: { date: "legacy import label" },
        },
      }),
      eventRes,
    );
    expect(eventRes.statusCode).toBe(400);
    expect(eventRes.body.error).toBe("Unknown content field date");
    expect(
      (await db.collection("cmsPosts").doc("event-with-date").get()).data(),
    ).toMatchObject({
      date: 42,
      version: 1,
    });
  });

  it("refuses to transition a document into published via save", async () => {
    // A doc that was not already published (here, a brand-new one) cannot be pushed
    // to published through the save path; that transition is the publish flow's job.
    const versionHistoryEntryFn = vi.fn();
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      versionHistoryEntryFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: { title: "Home", status: "published", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/publishing is a separate action/);
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("atomically publishes the exact approved page through the explicit publish action", async () => {
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        template: "home",
        title: "Published title",
        description: "Published description",
        seo: { title: "Search title", noindex: false },
        social: { title: "Share title", vendorKey: "preserved" },
        status: "approved",
        blocks: [
          { id: "stored-1", type: "divider", order: 0, visible: false, data: {} },
          { id: "stored-2", type: "headline", order: 1, visible: true, data: { text: "Hello" } },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        updatedBy: "u0",
        scheduledPublishFailure: {
          failedAt: "2026-07-14T12:00:00.000Z",
          failedBy: "system:scheduler",
          reason: "The previous scheduled publication failed.",
        },
        version: 3,
        contentVersion: 9,
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 3,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).toMatchObject({
      status: "published",
      publiclyVisible: true,
      publishAt: "2026-07-15T12:00:00.000Z",
      version: 4,
      contentVersion: 9,
      publishBuildPending: true,
      published: {
        metadata: {
          title: "Published title",
          description: "Published description",
          seo: { title: "Search title", noindex: false },
          social: { title: "Share title", vendorKey: "preserved" },
        },
        publishedAt: "2026-07-15T12:00:00.000Z",
        publishedBy: "u1",
        sourceVersion: 4,
        contentVersion: 9,
      },
    });
    expect(stored.scheduledPublishFailure).toBeUndefined();
    expect(stored.published.blocks).toEqual(stored.blocks);
    expect(stored.published.blocks).not.toBe(stored.blocks);

    const versions = await docsIn("cmsVersionHistory");
    expect(versions).toHaveLength(1);
    expect(versions[0].action).toBe("publish");
    expect(versions[0].after.published).toEqual(stored.published);
    const logs = await docsIn("admin_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "cms.publish-snapshot",
      target: "cmsPages/home",
    });
    // Pins the summarized before side (#538): status and block count, no second
    // copy of the page in the compliance row.
    expect(logs[0].before).toEqual({ status: "approved", blockCount: 2 });
    expect(logs[0].after).toMatchObject({ status: "published", created: false });
    // And pins where the copy went, which is what makes dropping it lossless.
    expect(versions[0].before.blocks).toEqual([
      { id: "stored-1", type: "divider", order: 0, visible: false, data: {} },
      { id: "stored-2", type: "headline", order: 1, visible: true, data: { text: "Hello" } },
    ]);
  });

  it("commits a serializer queue with the published snapshot", async () => {
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      template: "home",
      title: "Home",
      status: "draft",
      blocks: [],
      createdBy: "u1",
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
      enablePublishSnapshot: true,
      assertPublishReadyFn: vi.fn(async () => ({ transport: "serializer" })),
      assertPublishedMediaSafeFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 3,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.publication).toMatchObject({
      queueId: expect.any(String),
      status: "pending",
      transport: "serializer",
    });
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.publishBuildQueueId).toBe(res.body.publication.queueId);
    const queues = await docsIn("cmsPublishQueue");
    expect(queues).toEqual([
      expect.objectContaining({
        id: res.body.publication.queueId,
        status: "pending",
        transport: "serializer",
        changes: [{ collection: "cmsPages", id: "home", sourceVersion: 4 }],
      }),
    ]);
  });

  it("does not change a published snapshot while admission is paused", async () => {
    const contentRef = db.collection("cmsPages").doc("home");
    const before = {
      id: "home",
      template: "home",
      title: "Home",
      status: "draft",
      blocks: [],
      createdBy: "u1",
      version: 3,
    };
    await Promise.all([
      contentRef.set(before),
      db.collection("system").doc("cmsPublicationRuntime").set({
        schemaVersion: 1,
        phase: "paused",
        commitSha: "a".repeat(40),
        serializerId: "cloud-publication-primary",
      }),
    ]);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
      enablePublishSnapshot: true,
      assertPublishReadyFn: vi.fn(async () => ({ transport: "serializer" })),
      assertPublishedMediaSafeFn: vi.fn(async () => {}),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 3,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/paused for a serializer handoff/i);
    expect((await contentRef.get()).data()).toEqual(before);
    expect(await docsIn("cmsPublishQueue")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("records a null admin-log before for a create, which replaced nothing", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: { title: "Home", blocks: [divider({ order: 0 })] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const logs = await docsIn("admin_logs");
    expect(logs[0].before).toBeNull();
    expect(logs[0].after).toMatchObject({ created: true, blockCount: 1 });
  });

  it("rejects a non-boolean publish action before opening a transaction", async () => {
    const requirePrincipalFn = vi.fn(adminOk);
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          publish: "yes",
          document: { title: "Home", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("publish must be a boolean");
    expect(requirePrincipalFn).toHaveBeenCalledOnce();
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("keeps the deployed save endpoint from exposing publish without transport", async () => {
    await db.collection("cmsPages").doc("home").set({
      id: "home",
      template: "home",
      title: "Home",
      status: "approved",
      blocks: [],
      version: 3,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 3,
          publish: true,
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe(
      "Publish snapshots are not enabled in this deployment",
    );
    expect(await docsIn("cmsPages")).toHaveLength(1);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("refuses an unauthorized publish before reporting disabled transport", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "contributor-1",
        email: "contributor-1@x",
        principal: {
          id: "contributor-1",
          grants: [{ role: "contributor", scope: { siteWide: true } }],
        },
      }),
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          publish: true,
          document: { title: "Home", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("You do not have permission to save this record.");
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("normalizes a scheduled page publish date to the UTC form the scheduler accepts", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T12:00:00.000Z",
    });
    await db.collection("cmsPages").doc("contact").set({
      id: "contact",
      template: "genericPage",
      title: "Scheduled contact page",
      status: "approved",
      blocks: [],
      version: 1,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          baseVersion: 1,
          scheduleAt: "2026-07-20",
          document: {},
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(
      (await db.collection("cmsPages").doc("contact").get()).data().publishAt,
    ).toBe("2026-07-20T00:00:00.000Z");
  });

  it("starts a draft revision when an editor changes published content", async () => {
    const published = {
      blocks: [],
      metadata: { title: "Public Home" },
      publishedAt: "2026-01-02T00:00:00.000Z",
      publishedBy: "u0",
      sourceVersion: 4,
      contentVersion: 8,
    };
    const before = {
      id: "home",
      template: "home",
      title: "Home",
      status: "published",
      publiclyVisible: true,
      blocks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      updatedBy: "u0",
      version: 4,
      contentVersion: 8,
      published,
    };
    await db
      .collection("cmsPages")
      .doc("home")
      .set(before);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "editor-1",
        email: "editor-1@x",
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 4,
          document: {
            title: "Home edited",
            status: "published",
            blocks: [],
            contentVersion: 999,
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored).toMatchObject({
      title: "Home edited",
      status: "draft",
      publiclyVisible: true,
      version: 5,
      contentVersion: 9,
    });
    expect(stored.published).toEqual(published);
    expect(await docsIn("cmsVersionHistory")).toEqual([
      expect.objectContaining({ action: "update", before, after: stored }),
    ]);
  });

  it("keeps an unchanged published save byte-for-byte stable until content changes", async () => {
    const before = {
      id: "home",
      template: "home",
      title: "Home",
      status: "published",
      publiclyVisible: true,
      blocks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      updatedBy: "u0",
      version: 4,
      published: {
        blocks: [],
        metadata: { title: "Home" },
        publishedAt: "2026-01-02T00:00:00.000Z",
        publishedBy: "u0",
        sourceVersion: 4,
      },
    };
    await db
      .collection("cmsPages")
      .doc("home")
      .set(before);

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const unchanged = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 4,
          document: { title: "Home", status: "published", blocks: [] },
        },
      }),
      unchanged,
    );

    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.body.document).toEqual(before);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(before);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);

    const changed = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 4,
          document: { title: "Home revised" },
        },
      }),
      changed,
    );

    expect(changed.statusCode).toBe(200);
    expect(changed.body.document).toMatchObject({
      title: "Home revised",
      status: "draft",
      version: 5,
      contentVersion: 5,
    });
  });

  it("does not let a contributor revise their own published record", async () => {
    const before = {
      id: "home",
      template: "home",
      title: "Home",
      status: "published",
      publiclyVisible: true,
      blocks: [],
      createdBy: "contributor-1",
      version: 4,
      contentVersion: 4,
      published: { blocks: [], sourceVersion: 4, contentVersion: 4 },
    };
    await db.collection("cmsPages").doc("home").set(before);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "contributor-1",
        email: "contributor-1@x",
        principal: { id: "contributor-1", grants: [{ role: "contributor" }] },
      }),
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "home",
        baseVersion: 4,
        document: { title: "Contributor revision" },
      },
    }), res);

    expect(res.statusCode).toBe(403);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(before);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
  });

  it("lets only a publisher add or change custom HTML", async () => {
    const html = { id: "html-1", type: "html", order: 0, visible: true, data: { html: "<p>Results</p>", title: "Results" } };
    const before = {
      id: "contact",
      template: "genericPage",
      title: "Contact",
      status: "draft",
      blocks: [html],
      createdBy: "contributor-1",
      version: 1,
    };
    await db.collection("cmsPages").doc("contact").set(before);
    const contributor = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "contributor-1",
        email: "contributor-1@x",
        principal: { id: "contributor-1", grants: [{ role: "contributor" }] },
      }),
    });
    const save = async (handler, baseVersion, blocks) => {
      const res = makeRes();
      await handler(makeReq({
        body: { collection: "cmsPages", id: "contact", baseVersion, document: { blocks } },
      }), res);
      return res;
    };

    const changed = await save(contributor, 1, [{ ...html, data: { ...html.data, html: "<script>x()</script>" } }]);
    expect(changed.statusCode).toBe(403);
    expect(changed.body.error).toBe("Only editors and admins can add or change custom HTML.");
    const added = await save(contributor, 1, [html, { ...html, id: "html-2", order: 1 }]);
    expect(added.statusCode).toBe(403);
    expect((await db.collection("cmsPages").doc("contact").get()).data()).toEqual(before);

    const unchanged = await save(contributor, 1, [html, divider({ id: "tmp-divider", order: 1 })]);
    expect(unchanged.statusCode).toBe(200);

    const editor = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "editor-1",
        email: "editor-1@x",
        principal: { id: "editor-1", grants: [{ role: "editor", scope: { siteWide: true } }] },
      }),
    });
    const edited = await save(editor, 2, [{ ...html, data: { html: "<p>Updated</p>" } }]);
    expect(edited.statusCode).toBe(200);
  });

  // --- block id assignment (#515): the server owns canonical block ids ---

  it("saves content row membership with canonical IDs and retains it on the next save", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const proposed = [
      { id: "tmp-row", type: "row", order: 0, visible: true, data: { columns: [4, 8] } },
      divider({ id: "tmp-child", order: 1, layout: { rowId: "tmp-row", column: 0 } }),
    ];
    const first = makeRes();
    await handler(makeReq({ body: { collection: "cmsPages", id: "contact", document: { title: "Contact", blocks: proposed } } }), first);
    expect(first.statusCode).toBe(200);
    const saved = first.body.document;
    expect(saved.blocks[1].layout).toEqual({ rowId: saved.blocks[0].id, column: 0 });
    expect(first.body.mintedIds["tmp-row"]).toBe(saved.blocks[0].id);
    expect(saved.status).toBe("draft");
    expect(saved.published).toBeUndefined();

    const second = makeRes();
    await handler(makeReq({ body: {
      collection: "cmsPages", id: "contact", baseVersion: saved.version,
      document: { blocks: [...saved.blocks, divider({ id: "tmp-late", order: 2, layout: { rowId: saved.blocks[0].id, column: 1 } })] },
    } }), second);
    expect(second.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("contact").get()).data();
    expect(stored.blocks[0].id).toBe(saved.blocks[0].id);
    expect(stored.blocks[1]).toEqual(saved.blocks[1]);
    expect(stored.blocks[2].id).toBe(second.body.mintedIds["tmp-late"]);
    expect(stored.blocks[2].layout).toEqual({ rowId: saved.blocks[0].id, column: 1 });
    expect(stored.published).toBeUndefined();
  });

  it("rejects ambiguous content row identities before minting or writing content", async () => {
    const mintId = vi.fn(sequentialMinter());
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk, mintId });
    const res = makeRes();
    await handler(makeReq({ body: {
      collection: "cmsPages", id: "contact", document: { title: "Contact", blocks: [
        { id: "duplicate", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
        { id: "duplicate", type: "row", order: 1, visible: true, data: { columns: [6, 6] } },
        divider({ id: "child", order: 2, layout: { rowId: "duplicate", column: 0 } }),
      ] },
    } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/repeats id/);
    expect(mintId).not.toHaveBeenCalled();
    expect((await db.collection("cmsPages").doc("contact").get()).exists).toBe(false);
  });

  it("mints a canonical id for every block on create (server owns block ids)", async () => {
    // Nothing is stored yet, so no client id is trusted as canonical -- not even one
    // shaped like a real id. A client cannot choose a block's canonical id on create.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: {
            title: "Home",
            blocks: [
              divider({ id: "tmp-abc", order: 0 }), // temp key
              divider({ order: 1 }), // absent id
              divider({ id: "client-picked", order: 2 }), // client-chosen id is not trusted
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const blocks = res.body.document.blocks;
    expect(blocks.map((b) => b.id)).toEqual(["srv-0", "srv-1", "srv-2"]);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.blocks.map((b) => b.id)).toEqual(["srv-0", "srv-1", "srv-2"]);
  });

  it("keeps stored block ids and mints the rest on update (#515)", async () => {
    // Only ids the stored document already owns are preserved. A temp key, and an
    // unknown id the client tries to introduce as canonical, are both minted server-side.
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        status: "draft",
        blocks: [{ id: "stored-1", type: "divider", order: 0, visible: true, data: {} }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 0,
          document: {
            title: "Home",
            status: "draft",
            blocks: [
              divider({ id: "stored-1", order: 0 }), // already stored -> kept
              divider({ id: "tmp-new", order: 1 }), // temp key -> minted
              divider({ id: "not-stored-uuid", order: 2 }), // unknown id -> minted, not trusted
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.blocks.map((b) => b.id)).toEqual(["stored-1", "srv-0", "srv-1"]);
    // The response names which sent id became which canonical one (#538), so the
    // editor does not have to infer it from position. A kept id is not a minting
    // and does not appear.
    expect(res.body.mintedIds).toEqual({
      "tmp-new": "srv-0",
      "not-stored-uuid": "srv-1",
    });
  });

  it("reports no minted ids when every block keeps the id it was sent with", async () => {
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        status: "draft",
        blocks: [{ id: "stored-1", type: "divider", order: 0, visible: true, data: {} }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 0,
          document: { title: "Home", blocks: [divider({ id: "stored-1", order: 0 })] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.mintedIds).toEqual({});
  });

  it("reports a sent id that names a prototype member", async () => {
    // Assigning "__proto__" as a key on a plain object hits the prototype's
    // setter and creates no own property, so that id would be minted and
    // silently left out of a map that promises to name every unique sent id.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: {
            title: "Home",
            blocks: [
              divider({ id: "__proto__", order: 0 }),
              divider({ id: "constructor", order: 1 }),
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const roundTripped = JSON.parse(JSON.stringify(res.body.mintedIds));
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped.constructor).toBe("srv-1");
    expect(Object.entries(roundTripped)).toEqual([
      ["__proto__", "srv-0"],
      ["constructor", "srv-1"],
    ]);
  });

  it("omits sent ids that cannot name one block from the minting map", async () => {
    // A repeated editor key names two blocks; an absent or empty id names none.
    // No entry for any of them could be read as the id that replaced it, so the
    // map carries none and position is what the client has for exactly those.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: {
            title: "Home",
            blocks: [
              divider({ id: "tmp-dup", order: 0 }),
              divider({ id: "tmp-dup", order: 1 }),
              divider({ order: 2 }),
              divider({ id: "", order: 3 }),
              divider({ id: "tmp-unique", order: 4 }),
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.blocks.map((b) => b.id)).toEqual([
      "srv-0",
      "srv-1",
      "srv-2",
      "srv-3",
      "srv-4",
    ]);
    expect(res.body.mintedIds).toEqual({ "tmp-unique": "srv-4" });
  });

  // --- record create with a minted doc id ---

  it("mints a record id when none is provided and reports created", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft(),
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ collection: "cmsPosts", id: "rec-0", created: true });
    const posts = await docsIn("cmsPosts");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: "rec-0",
      title: "A post",
      slug: "a-post",
      previousSlugs: [],
      locale: "en",
      publishAt: "2026-07-15T00:00:00.000Z",
    });
  });

  // --- create retries are idempotent (#542) ---

  it("addresses a retried create at the same document when it carries the same key (#542)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const body = {
      collection: "cmsPosts",
      section: "watch",
      document: postDraft(),
      idempotencyKey: "create-attempt-0001",
    };

    // The first create commits. Its response is what a dropped connection swallows.
    const first = makeRes();
    await handler(makeReq({ body }), first);
    expect(first.statusCode).toBe(200);
    expect(first.body.created).toBe(true);
    expect(first.body.replayed).toBe(false);
    // The id is derived from the key, so it is not one of the ids mintId hands out.
    expect(first.body.id).not.toBe("rec-0");

    // The retry sends the same nonce, having never learned the id.
    const retry = makeRes();
    await handler(makeReq({ body }), retry);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.created).toBe(true);
    expect(retry.body.replayed).toBe(true);

    // One create stays one create: one document, one version, one audit trail. This is
    // the assertion the issue is about -- before the key, the retry left two records.
    const posts = await docsIn("cmsPosts");
    expect(posts).toHaveLength(1);
    expect(posts[0].version).toBe(1);
    expect(retry.body.document.version).toBe(1);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn("admin_logs")).toHaveLength(1);
  });

  it("rejects a create replay after the stored record has advanced", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const body = {
      collection: "cmsPosts",
      section: "watch",
      document: postDraft(),
      idempotencyKey: "create-attempt-0001",
    };

    const first = makeRes();
    await handler(makeReq({ body }), first);
    expect(first.statusCode).toBe(200);

    const intervening = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: first.body.id,
          baseVersion: 1,
          document: { title: "An intervening edit" },
        },
      }),
      intervening,
    );
    expect(intervening.statusCode).toBe(200);
    expect(intervening.body.document.version).toBe(2);

    const retry = makeRes();
    await handler(makeReq({ body }), retry);

    expect(retry.statusCode).toBe(409);
    expect(retry.body.error).toMatch(/changed|reload/i);
    expect(retry.body).toMatchObject({
      conflict: "create-replay-advanced",
      recordId: first.body.id,
    });
    const stored = (
      await db.collection("cmsPosts").doc(first.body.id).get()
    ).data();
    expect(stored).toMatchObject({
      title: "An intervening edit",
      version: 2,
    });
  });

  it("replays a create's own minted block ids instead of minting a second set (#542)", async () => {
    // The subtle half. A replay must hand back what the first attempt stored, block ids
    // included: the editor adopts those ids as canonical (#515), so a replay that re-minted
    // them, or that composed a fresh document to answer with, would leave the editor holding
    // ids no stored block has.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter(),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const body = {
      collection: "cmsPosts",
      section: "watch",
      document: {
        ...postDraft(),
        // The client ids the editor had when it first tried, and still has on the retry.
        blocks: [divider({ id: "tmp-a", order: 0 }), divider({ id: "tmp-b", order: 1 })],
      },
      idempotencyKey: "create-attempt-0001",
    };

    const first = makeRes();
    await handler(makeReq({ body }), first);
    expect(first.statusCode).toBe(200);
    expect(first.body.document.blocks.map((b) => b.id)).toEqual(["srv-0", "srv-1"]);

    const retry = makeRes();
    await handler(makeReq({ body }), retry);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.id).toBe(first.body.id);
    // Same ids, same order, and nothing newly minted: the next id the minter would hand out
    // is still srv-2, so the replay never called it.
    expect(retry.body.document.blocks.map((b) => b.id)).toEqual(["srv-0", "srv-1"]);
    const stored = (await db.collection("cmsPosts").doc(first.body.id).get()).data();
    expect(stored.blocks.map((b) => b.id)).toEqual(["srv-0", "srv-1"]);
    expect(await docsIn("cmsPosts")).toHaveLength(1);
  });

  it("mints a separate record for a second create that carries a different key (#542)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const ids = [];
    for (const key of ["create-attempt-0001", "create-attempt-0002"]) {
      const res = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: postDraft(),
            idempotencyKey: key,
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.replayed).toBe(false);
      ids.push(res.body.id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(await docsIn("cmsPosts")).toHaveLength(2);
  });

  it("treats a changed draft under a reused key as its own create (#542)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const first = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft(),
          idempotencyKey: "create-attempt-0001",
        },
      }),
      first,
    );
    expect(first.statusCode).toBe(200);

    // Same nonce, different draft. Answering this with the stored record would tell the
    // editor its new title was saved while the old one is what is stored, so the address
    // covers the payload and this becomes a create of its own.
    const changed = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft("A different post"),
          idempotencyKey: "create-attempt-0001",
        },
      }),
      changed,
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.body.replayed).toBe(false);
    expect(changed.body.id).not.toBe(first.body.id);
    expect(changed.body.document.title).toBe("A different post");
    expect(await docsIn("cmsPosts")).toHaveLength(2);
  });

  it("replays a retry whose document fields arrive in a different order (#542)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const first = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft(),
          idempotencyKey: "create-attempt-0001",
        },
      }),
      first,
    );
    expect(first.statusCode).toBe(200);

    const retry = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: { blocks: [], tags: [], date: "2026-07-15", title: "A post", type: "post" },
          idempotencyKey: "create-attempt-0001",
        },
      }),
      retry,
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.id).toBe(first.body.id);
    expect(await docsIn("cmsPosts")).toHaveLength(1);
  });

  it("still mints a record id for a create that sends no key (#542)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft(),
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: "rec-0", created: true, replayed: false });
  });

  it("refuses a create key sent beside a record id (#542)", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "rec-0",
          document: { type: "post", title: "A post", blocks: [] },
          idempotencyKey: "create-attempt-0001",
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("idempotencyKey addresses a create; omit id to use it");
  });

  it("refuses a create key with an explicit page id (#542)", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: { title: "Home" },
          idempotencyKey: "create-attempt-0001",
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("idempotencyKey addresses a create; omit id to use it");
  });

  it("refuses a create key that is too short or the wrong type to be a nonce (#542)", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    for (const idempotencyKey of ["short", 12345678, "x".repeat(201)]) {
      const res = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: { type: "post", title: "A post", blocks: [] },
            idempotencyKey,
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe(
        "idempotencyKey must be a string of 8 to 200 characters",
      );
    }
    expect(await docsIn("cmsPosts")).toHaveLength(0);
  });

  it("mints a unique derived slug when two records have the same title (#541)", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    for (const title of ["New Jersey & You!", "New Jersey & You!"]) {
      const res = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: { type: "post", title, date: "2026-07-15", tags: [], blocks: [] },
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }

    const posts = (await docsIn("cmsPosts")).sort((a, b) => a.id.localeCompare(b.id));
    expect(posts.map((post) => post.slug)).toEqual(["new-jersey-you", "new-jersey-you-2"]);
  });

  it("never mints a slug the public build would refuse to route", async () => {
    // The contract mismatch this fixes: the writer used to mint "new" for a post
    // titled "New", and an over-length slug for a long headline, while the build
    // refused both -- and a strict publish build fails on the first invalid
    // document, so one such post bricked every build with no way out short of an
    // admin rename. Minting now goes through the shared contract, so the two
    // sides cannot disagree.
    const { isServerMintableSlugShape, isMintablePostSlug, POST_SLUG_MAX } =
      postSlugContract;
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });

    for (const title of [
      "New",
      "Index",
      "Tags",
      "Trenton ".repeat(40),
      "🎬🎬🎬",
    ]) {
      const res = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: { type: "post", title, date: "2026-07-15", tags: [], blocks: [] },
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      const { slug } = res.body.document;
      expect(isMintablePostSlug(slug)).toBe(true);
      expect(isServerMintableSlugShape(slug)).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(POST_SLUG_MAX);
    }

    const posts = await docsIn("cmsPosts");
    // "New" keeps a readable URL rather than being renamed to something anonymous.
    expect(posts.map((post) => post.slug)).toContain("new-post");
    expect(posts.map((post) => post.slug)).toContain("index-post");
  });

  it("does not mint a slug that another record keeps as a redirect", async () => {
    await db.collection("cmsPosts").doc("renamed-record").set({
      id: "renamed-record",
      type: "post",
      title: "Current title",
      slug: "current-title",
      previousSlugs: ["former-title"],
      locale: "en",
      status: "draft",
      publishAt: "2026-01-01T00:00:00.000Z",
      blocks: [],
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: postDraft("Former title"),
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.slug).toBe("former-title-2");
  });

  it("accepts a program's existing rich-text description on save", async () => {
    const description = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Program synopsis" }] }],
    };
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: { type: "program", title: "Garden State Stories", description },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.description).toEqual(description);
  });

  it("preserves an absent legacy publish date when the record form sends its blank seed", async () => {
    await db.collection("cmsPosts").doc("legacy-program").set({
      id: "legacy-program",
      type: "program",
      title: "Original title",
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      },
      status: "draft",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-program",
          baseVersion: 1,
          document: {
            type: "program",
            title: "Updated title",
            publishAt: "",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPosts").doc("legacy-program").get()).data();
    expect(stored.title).toBe("Updated title");
    expect(stored.slug).toBe("updated-title");
    expect(stored.previousSlugs).toEqual([]);
    expect(stored.locale).toBe("en");
    expect(stored.publishAt).toBeUndefined();
  });

  // Issue #1039 retired Article and #1103 removed the last way to reach it. The save
  // boundary is the API half of that: creating one, and re-saving a record stored
  // before the retirement, both have to be refused by name rather than admitted
  // because the payload happens to be well formed.
  it("refuses to create an article and refuses to rewrite a stored one", async () => {
    const body = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
    };
    await db.collection("cmsPosts").doc("stored-article").set({
      id: "stored-article",
      type: "article",
      title: "Original title",
      body,
      status: "draft",
      createdAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });

    const created = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          document: { type: "article", title: "New story", body },
        },
      }),
      created,
    );
    expect(created.statusCode).toBe(400);
    expect(created.body.error).toMatch(/retired/i);
    expect(created.body.error).toMatch(/Post/);

    const rewritten = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "stored-article",
          baseVersion: 1,
          document: { type: "article", title: "Updated title", body },
        },
      }),
      rewritten,
    );
    expect(rewritten.statusCode).toBe(400);
    expect(rewritten.body.error).toMatch(/retired/i);

    // Nothing was written: the stored record is byte-for-byte what it was, and no
    // second document was minted by the refused create.
    const stored = (await db.collection("cmsPosts").doc("stored-article").get()).data();
    expect(stored.title).toBe("Original title");
    expect(stored.version).toBe(1);
    const articles = await db
      .collection("cmsPosts")
      .where("type", "==", "article")
      .get();
    expect(articles.size).toBe(1);
  });

  it("keeps routing identity server-owned while accepting grouped page metadata", async () => {
    await seedMediaAsset("asset-social-about");
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "about",
          document: {
            template: "programLanding",
            title: "About NJ PBS",
            description: "The station and its public-service mission.",
            seo: {
              title: "About NJ PBS | Public Media in New Jersey",
              description: "Learn about NJ PBS.",
              noindex: false,
            },
            social: {
              title: "Meet NJ PBS",
              description: "Public media for New Jersey.",
              imageAssetId: "asset-social-about",
            },
            blocks: [],
            slug: "attacker-route",
            locale: "fr",
            previousSlugs: ["forged"],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("about").get()).data();
    expect(stored).toMatchObject({
      title: "About NJ PBS",
      description: "The station and its public-service mission.",
      seo: {
        title: "About NJ PBS | Public Media in New Jersey",
        description: "Learn about NJ PBS.",
        noindex: false,
      },
      social: {
        title: "Meet NJ PBS",
        description: "Public media for New Jersey.",
        imageAssetId: "asset-social-about",
      },
    });
    expect(stored.slug).toBeUndefined();
    expect(stored.locale).toBeUndefined();
    expect(stored.previousSlugs).toBeUndefined();
  });

  it("replaces working and published media usage in the content transaction", async () => {
    await Promise.all([
      seedMediaAsset("visible-image"),
      seedMediaAsset("hidden-image"),
      seedMediaAsset("social-image"),
    ]);
    await db.collection("cmsPages").doc("about").set({
      id: "about",
      template: "programLanding",
      title: "About NJ PBS",
      status: "approved",
      social: { imageAssetId: "social-image" },
      blocks: [
        image("visible-image"),
        image("hidden-image", { visible: false, order: 1 }),
      ],
      createdBy: "u1",
      version: 1,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "about",
        baseVersion: 1,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(200);
    const working = (await db.collection("cmsPages/about/mediaUsage").doc("working").get()).data();
    const published = (await db.collection("cmsPages/about/mediaUsage").doc("published").get()).data();
    expect(working).toEqual({
      state: "working",
      sourceVersion: 2,
      assetIds: ["hidden-image", "social-image", "visible-image"],
      occurrenceCount: 3,
    });
    expect(published).toEqual({
      state: "published",
      sourceVersion: 2,
      assetIds: ["social-image", "visible-image"],
      occurrenceCount: 2,
    });
  });

  it("rejects uploaded media before any manual publish write", async () => {
    await seedMediaAsset("uploaded-image", { source: "upload" });
    const before = {
      id: "about",
      template: "programLanding",
      title: "About NJ PBS",
      status: "approved",
      blocks: [image("uploaded-image")],
      createdBy: "u1",
      version: 1,
    };
    const existingUsage = {
      state: "working",
      sourceVersion: 1,
      assetIds: ["uploaded-image"],
      occurrenceCount: 1,
    };
    await Promise.all([
      db.collection("cmsPages").doc("about").set(before),
      db
        .collection("cmsPages/about/mediaUsage")
        .doc("working")
        .set(existingUsage),
    ]);
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      enablePublishSnapshot: true,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "about",
        baseVersion: 1,
        publish: true,
        document: {},
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/public deployment coordination/i);
    expect(res.body.code).toBe("media_publication_unavailable");
    expect((await db.collection("cmsPages").doc("about").get()).data())
      .toEqual(before);
    expect(
      (
        await db
          .collection("cmsPages/about/mediaUsage")
          .doc("working")
          .get()
      ).data(),
    ).toEqual(existingUsage);
    expect(
      (
        await db
          .collection("cmsPages/about/mediaUsage")
          .doc("published")
          .get()
      ).exists,
    ).toBe(false);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("rejects an inactive media reference before any content write", async () => {
    await seedMediaAsset("retired-image", { lifecycle: "tombstoned" });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPages",
        id: "about",
        document: {
          template: "programLanding",
          title: "About NJ PBS",
          blocks: [image("retired-image")],
        },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/not available/i);
    expect((await db.collection("cmsPages").doc("about").get()).exists).toBe(false);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("saves a draft lead image before its accessibility text is complete", async () => {
    await seedMediaAsset("post-lead");
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: () => "station-update",
    });
    const invalid = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPosts",
        section: "watch",
        document: postDraft("Station update", {
          heroImage: "post-lead",
        }),
      },
    }), invalid);

    expect(invalid.statusCode).toBe(200);
    expect(invalid.body.document.heroImage).toBe("post-lead");
    expect(invalid.body.document.heroImageAlt).toBeUndefined();

    const valid = makeRes();
    await handler(makeReq({
      body: {
        collection: "cmsPosts",
        section: "watch",
        id: "station-update",
        baseVersion: 1,
        document: postDraft("Station update", {
          heroImage: "post-lead",
          heroImageAlt: "",
          heroImageDecorative: true,
        }),
      },
    }), valid);

    expect(valid.statusCode).toBe(200);
    expect(
      (await db.collection("cmsPosts").doc("station-update").get()).data(),
    ).toMatchObject({
      heroImage: "post-lead",
      heroImageAlt: "",
      heroImageDecorative: true,
    });
  });

  it("checks lead-image accessibility after applying a partial record overlay", async () => {
    await seedMediaAsset("post-lead");
    await db.collection("cmsPosts").doc("station-update").set({
      id: "station-update",
      ...postDraft("Station update", {
        heroImage: "post-lead",
        heroImageAlt: "A reporter in the NJ PBS newsroom.",
        heroImageDecorative: false,
      }),
      status: "draft",
      createdBy: "u1",
      version: 2,
    });
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
    });
    const res = makeRes();

    await handler(makeReq({
      body: {
        collection: "cmsPosts",
        id: "station-update",
        baseVersion: 2,
        document: { heroImageDecorative: true },
      },
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(
      "heroImageAlt must be empty when heroImageDecorative is true",
    );
    expect(
      (await db.collection("cmsPosts").doc("station-update").get()).data(),
    ).toMatchObject({ version: 2, heroImageDecorative: false });
  });

  it.each([
    {
      label: "post lead image",
      id: "station-update",
      assetField: "heroImage",
      altField: "heroImageAlt",
      decorativeField: "heroImageDecorative",
      stored: postDraft("Station update", {
        heroImage: "old-image",
        heroImageAlt: "The old lead image.",
        heroImageDecorative: false,
      }),
    },
    {
      label: "sponsor logo",
      id: "station-sponsor",
      assetField: "logoAssetId",
      altField: "logoAlt",
      decorativeField: "logoDecorative",
      stored: {
        type: "sponsor",
        name: "Station sponsor",
        href: "https://example.org/",
        logoAssetId: "old-image",
        logoAlt: "The old sponsor logo.",
        logoDecorative: false,
      },
    },
  ])(
    "resets omitted accessibility fields when a partial update replaces a $label",
    async ({ id, assetField, altField, decorativeField, stored }) => {
      await Promise.all([
        seedMediaAsset("old-image"),
        seedMediaAsset("new-image"),
        seedMediaAsset("other-image"),
        db.collection("cmsPosts").doc(id).set({
          id,
          ...stored,
          status: "draft",
          createdBy: "u1",
          version: 2,
        }),
      ]);
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: adminOk,
      });
      const omitted = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id,
            baseVersion: 2,
            document: { [assetField]: "new-image" },
          },
        }),
        omitted,
      );

      expect(omitted.statusCode).toBe(200);
      expect((await db.collection("cmsPosts").doc(id).get()).data()).toMatchObject({
        [assetField]: "new-image",
        [altField]: "",
        [decorativeField]: false,
        version: 3,
      });

      const safe = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id,
            baseVersion: 3,
            document: {
              [assetField]: "other-image",
              [altField]: "The new image.",
              [decorativeField]: false,
            },
          },
        }),
        safe,
      );

      expect(safe.statusCode).toBe(200);
      expect((await db.collection("cmsPosts").doc(id).get()).data()).toMatchObject({
        [assetField]: "other-image",
        [altField]: "The new image.",
        [decorativeField]: false,
        version: 4,
      });

      const removed = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id,
            baseVersion: 4,
            document: { [assetField]: "" },
          },
        }),
        removed,
      );

      expect(removed.statusCode).toBe(200);
      expect((await db.collection("cmsPosts").doc(id).get()).data()).toMatchObject({
        [assetField]: "",
        [altField]: "",
        [decorativeField]: false,
        version: 5,
      });
    },
  );

  it("rejects malformed known metadata fields before they reach Firestore", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: { template: "home", seo: { noindex: "yes" } },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("seo.noindex must be a boolean");
    expect((await db.collection("cmsPages").doc("home").get()).exists).toBe(false);
  });

  it("rejects an unknown page field before it reaches Firestore", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          document: {
            template: "home",
            title: "Home",
            blocks: [],
            surprise: "not part of the page contract",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Unknown content field surprise");
    expect((await db.collection("cmsPages").doc("home").get()).exists).toBe(false);
  });

  it("lets a new draft page become complete through the split block and metadata saves", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const blocksFirst = makeRes();
    const blocksFirstMetadata = makeRes();
    const metadataFirst = makeRes();
    const metadataFirstBlocks = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          createOnly: true,
          document: { template: "programLanding", blocks: [] },
        },
      }),
      blocksFirst,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "watch",
          baseVersion: 1,
          document: { template: "programLanding", title: "Watch" },
        },
      }),
      blocksFirstMetadata,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          createOnly: true,
          document: { template: "genericPage", title: "Contact" },
        },
      }),
      metadataFirst,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "contact",
          baseVersion: 1,
          document: { template: "genericPage", blocks: [] },
        },
      }),
      metadataFirstBlocks,
    );

    expect(blocksFirst.statusCode).toBe(200);
    expect(blocksFirst.body.document).toMatchObject({ status: "draft", blocks: [], version: 1 });
    expect(blocksFirst.body.document.title).toBeUndefined();
    expect(blocksFirstMetadata.statusCode).toBe(200);
    expect(blocksFirstMetadata.body.document).toMatchObject({
      title: "Watch",
      blocks: [],
      version: 2,
    });
    expect(metadataFirst.statusCode).toBe(200);
    expect(metadataFirst.body.document).toMatchObject({
      status: "draft",
      title: "Contact",
      version: 1,
    });
    expect(metadataFirst.body.document.blocks).toBeUndefined();
    expect(metadataFirstBlocks.statusCode).toBe(200);
    expect(metadataFirstBlocks.body.document).toMatchObject({
      title: "Contact",
      blocks: [],
      version: 2,
    });
  });

  it("rejects an incomplete record and a field owned by another record kind", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
    });
    const incomplete = makeRes();
    const wrongKind = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: { type: "sponsor", name: "NJ PBS supporter" },
        },
      }),
      incomplete,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: {
            type: "sponsor",
            name: "NJ PBS supporter",
            href: "https://example.org",
            title: "Wrong record field",
          },
        },
      }),
      wrongKind,
    );

    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.body.error).toBe("href is required");
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.body.error).toBe("Unknown content field title");
    expect(await docsIn("cmsPosts")).toHaveLength(0);
  });

  it("rejects the page contract and unknown roots from the record collection", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      mintId: sequentialMinter("rec"),
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          section: "watch",
          document: {
            type: "page",
            title: "Wrong collection",
            blocks: [],
            surprise: "must not pass through",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Unknown content type page");
    expect(await docsIn("cmsPosts")).toHaveLength(0);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "rejects the inherited record type %s without a server error",
    async (type) => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: adminOk,
        mintId: sequentialMinter("rec"),
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: { type, title: "Malformed import" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe(`Unknown content type ${type}`);
      expect(await docsIn("cmsPosts")).toHaveLength(0);
      expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
      expect(await docsIn("admin_logs")).toHaveLength(0);
    },
  );

  it("preserves an unchanged legacy root field but rejects an attempted change to it", async () => {
    await db.collection("cmsPosts").doc("legacy-sponsor").set({
      id: "legacy-sponsor",
      type: "sponsor",
      name: "Original supporter",
      href: "https://example.org",
      legacyImportCode: "supporter-17",
      status: "draft",
      version: 1,
    });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const unchanged = makeRes();
    const changed = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-sponsor",
          baseVersion: 1,
          document: {
            type: "sponsor",
            name: "Updated supporter",
            href: "https://example.org",
            legacyImportCode: "supporter-17",
          },
        },
      }),
      unchanged,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "legacy-sponsor",
          baseVersion: 2,
          document: {
            type: "sponsor",
            name: "Updated supporter",
            href: "https://example.org",
            legacyImportCode: "changed",
          },
        },
      }),
      changed,
    );

    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.body.document).toMatchObject({
      name: "Updated supporter",
      legacyImportCode: "supporter-17",
    });
    expect(changed.statusCode).toBe(400);
    expect(changed.body.error).toBe("Unknown content field legacyImportCode");
    expect((await db.collection("cmsPosts").doc("legacy-sponsor").get()).data()).toMatchObject({
      legacyImportCode: "supporter-17",
      version: 2,
    });
  });

  it("preserves a legacy Timestamp when the client returns its unchanged transport shape", async () => {
    const importedAt = admin.firestore.Timestamp.fromMillis(1_786_382_400_123);
    const transported = JSON.parse(JSON.stringify(importedAt));
    await db.collection("cmsPosts").doc("timestamp-sponsor").set({
      id: "timestamp-sponsor",
      type: "sponsor",
      name: "Original supporter",
      href: "https://example.org",
      legacyImportedAt: importedAt,
      status: "draft",
      version: 1,
    });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const unchanged = makeRes();
    const changed = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "timestamp-sponsor",
          baseVersion: 1,
          document: {
            type: "sponsor",
            name: "Updated supporter",
            href: "https://example.org",
            legacyImportedAt: transported,
          },
        },
      }),
      unchanged,
    );
    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "timestamp-sponsor",
          baseVersion: 2,
          document: {
            type: "sponsor",
            name: "Updated supporter",
            href: "https://example.org",
            legacyImportedAt: {
              ...transported,
              _seconds: transported._seconds + 1,
            },
          },
        },
      }),
      changed,
    );

    expect(unchanged.statusCode).toBe(200);
    const stored = (await db.collection("cmsPosts").doc("timestamp-sponsor").get()).data();
    expect(stored.legacyImportedAt).toBeInstanceOf(admin.firestore.Timestamp);
    expect(stored.legacyImportedAt.toMillis()).toBe(importedAt.toMillis());
    expect(stored.version).toBe(2);
    expect(changed.statusCode).toBe(400);
    expect(changed.body.error).toBe("Unknown content field legacyImportedAt");
  });

  it("refuses a client-chosen record id on create (#515)", async () => {
    const versionHistoryEntryFn = vi.fn();
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      versionHistoryEntryFn,
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "attacker-chosen-id",
          document: { type: "post", title: "Forged", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/omit id to create/);
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(await docsIn("cmsPosts")).toHaveLength(0);
  });

  it("updates an existing record when a real id is provided", async () => {
    await db
      .collection("cmsPosts")
      .doc("rec-1")
      .set({
        id: "rec-1",
        type: "post",
        title: "Old title",
        date: "2026-07-15",
        tags: [],
        status: "draft",
        blocks: [],
        assignee: "editor-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPosts",
          id: "rec-1",
          baseVersion: 0,
          document: {
            type: "post",
            title: "New title",
            status: "draft",
            blocks: [],
            assignee: "attacker",
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: "rec-1", created: false });
    const stored = (await db.collection("cmsPosts").doc("rec-1").get()).data();
    expect(stored.title).toBe("New title");
    expect(stored.assignee).toBe("editor-1");
    expect(stored.createdAt).toBe("2026-01-01T00:00:00.000Z"); // preserved on update
  });

  // --- update: server-owned fields are protected, publish snapshot preserved ---

  it("preserves createdAt and the publish snapshot and ignores client-set server fields on update", async () => {
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        status: "draft",
        publiclyVisible: true,
        blocks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "u0",
        published: { blocks: [], publishedAt: "2026-01-02T00:00:00.000Z", publishedBy: "u0" },
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: () => ({
        uid: "editor",
        email: "e@x",
        principal: { id: "editor", grants: [{ role: "admin" }] },
      }),
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 0,
          document: {
            title: "Home v2",
            status: "draft",
            blocks: [],
            // hostile / confused client trying to forge server-owned fields
            createdAt: "1999-01-01T00:00:00.000Z",
            updatedBy: "attacker",
            published: { blocks: ["evil"], publishedAt: "x", publishedBy: "attacker" },
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.title).toBe("Home v2");
    expect(stored.status).toBe("draft");
    expect(stored.publiclyVisible).toBe(true);
    expect(stored.createdAt).toBe("2026-01-01T00:00:00.000Z"); // preserved, not forged
    expect(stored.updatedAt).toBe("2026-07-15T00:00:00.000Z"); // server clock
    expect(stored.updatedBy).toBe("editor"); // from auth, not the client
    expect(stored.published).toEqual({
      blocks: [],
      publishedAt: "2026-01-02T00:00:00.000Z",
      publishedBy: "u0",
    }); // carried forward, not the client's evil snapshot

    const versions = await docsIn("cmsVersionHistory");
    expect(versions[0]).toMatchObject({ action: "update", documentId: "home" });
  });

  // --- update: a partial save preserves fields the client did not send ---
  // batch.set() replaces the whole doc, so the compose step must carry forward stored
  // fields the payload omits -- otherwise a metadata-only edit silently wipes content.

  it("preserves stored blocks and other fields when the save omits them", async () => {
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        slug: "home",
        seo: { description: "keep me" },
        status: "draft",
        blocks: [
          { id: "b1", type: "divider", order: 0, visible: true, data: {} },
          { id: "b2", type: "divider", order: 1, visible: true, data: {} },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    // A metadata-only save: the client edits the title and sends no blocks key.
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 0,
          document: { title: "Home (edited)", status: "draft" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.title).toBe("Home (edited)"); // the edit landed
    expect(stored.blocks.map((b) => b.id)).toEqual(["b1", "b2"]); // NOT wiped
    expect(stored.slug).toBe("home"); // preserved
    expect(stored.seo).toEqual({ description: "keep me" }); // preserved
    // and the response echoes the full merged doc, not the partial payload
    expect(res.body.document.blocks).toHaveLength(2);
  });

  it("clears the blocks when the save sends an empty blocks array", async () => {
    // Omitting blocks preserves them; sending an empty array is an explicit clear.
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        status: "draft",
        blocks: [{ id: "b1", type: "divider", order: 0, visible: true, data: {} }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 0,
          document: { title: "Home", status: "draft", blocks: [] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const stored = (await db.collection("cmsPages").doc("home").get()).data();
    expect(stored.blocks).toEqual([]); // explicitly cleared
  });

  it("records the retained block count in the audit row on a metadata-only save", async () => {
    // The compliance record must reflect the committed after-state: a metadata-only
    // save retains the stored blocks, so the audit blockCount is the retained count,
    // not zero.
    await db
      .collection("cmsPages")
      .doc("home")
      .set({
        id: "home",
        title: "Home",
        status: "draft",
        blocks: [
          { id: "b1", type: "divider", order: 0, visible: true, data: {} },
          { id: "b2", type: "divider", order: 1, visible: true, data: {} },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
      });

    const adminLogEntryFn = vi.fn(() => ({ kind: "audit" }));
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      adminLogEntryFn,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: { collection: "cmsPages", id: "home", baseVersion: 0, document: { title: "Edited" } },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(adminLogEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ blockCount: 2 }) }),
    );
  });

  // --- compliance atomicity: content + audit rows commit or fail together ---

  it("writes the content doc and both compliance rows together on success", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      now: () => "2026-07-15T00:00:00.000Z",
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: { collection: "cmsPages", id: "home", document: { title: "Home", blocks: [] } },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(await docsIn("cmsPages")).toHaveLength(1);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
    expect(await docsIn("admin_logs")).toHaveLength(1);
  });

  it("writes nothing when a batched audit row fails (atomic)", async () => {
    // A compliance-row builder that yields a Firestore-invalid value (undefined)
    // fails the batch; the content write shares that batch, so it must not land.
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: adminOk,
      versionHistoryEntryFn: () => ({ documentId: undefined }),
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: { collection: "cmsPages", id: "home", document: { title: "Home", blocks: [] } },
      }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(await docsIn("cmsPages")).toHaveLength(0);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("maps a failed-precondition dependency error to 503", async () => {
    const handler = createCmsSaveHandler({
      firestore: db,
      requirePrincipalFn: async () => {
        throw Object.assign(new Error("system is initializing"), {
          code: "failed-precondition",
        });
      },
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: { collection: "cmsPages", id: "home", document: { title: "Home", blocks: [] } },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe("system is initializing");
  });

  it("rejects a non-POST method", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  // --- concurrent saves (#530) ---
  //
  // A save reads the stored document and overlays the fields the client sent, so the read
  // is what the write is composed against. Two saves that both read before either writes
  // are therefore both composed against the same snapshot, and the second write carries
  // the first's fields backwards to their pre-save values. Nothing errors: the losing
  // editor's change is silently reverted, and the version-history row records a `before`
  // that was already stale when it was written.

  async function seedPage(fields) {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({ body: { collection: "cmsPages", id: "home", document: fields } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    return res.body.document;
  }

  // A save held at its read holds a Firestore transaction open. If an assertion throws
  // before its barrier is released, that transaction is never resolved and its lock
  // outlives the test, timing out every later test that touches the same page. Track the
  // held saves and drain them whatever the outcome, so one failure stays one failure.
  const heldSaves = [];

  afterEach(async () => {
    for (const held of heldSaves) held.barrier.release();
    await Promise.allSettled(heldSaves.map((held) => held.saving));
    heldSaves.length = 0;
  });

  // Start a save through the paused seam. `hold` decides whether it stops at its read
  // waiting for the test, or runs straight through while still reporting its reads.
  //
  // Only ever hold one save at a time. A read inside a transaction takes a shared lock
  // and a commit needs an exclusive one, so a second held transaction on the same page
  // stops the first from committing, and both sit there until a lock timeout.
  function startSave(fields, { hold }) {
    const barrier = readBarrier();
    if (!hold) barrier.release();
    const res = makeRes();
    const saving = createCmsSaveHandler({
      firestore: firestorePausedAfterRead(db, barrier),
      requirePrincipalFn: adminOk,
    })(makeReq({ body: { collection: "cmsPages", id: "home", baseVersion: 1, document: fields } }), res);
    const started = { barrier, res, saving };
    if (hold) heldSaves.push(started);
    return started;
  }

  // Drive the interleaving that loses data. A reads the page and stops. B then reads the
  // same page -- the state A is about to replace -- and goes on to write it. A is let go
  // once B is provably past its read, so B's write is composed against a page that no
  // longer exists by the time it lands.
  async function overlappingSaves(aFields, bFields) {
    const a = startSave(aFields, { hold: true });
    await a.barrier.atRead;

    const b = startSave(bFields, { hold: false });
    await b.barrier.atRead;

    a.barrier.release();
    await Promise.all([a.saving, b.saving]);

    expect([a.res.statusCode, b.res.statusCode].sort()).toEqual([200, 409]);
    // An explicit fresh read/claim is required even when the stale edit touched a
    // different field. This is the same reviewed retry the staff recovery path uses.
    const latest = (await db.collection("cmsPages").doc("home").get()).data();
    const retry = makeRes();
    await createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk })(makeReq({ body: {
      collection: "cmsPages", id: "home", baseVersion: latest.version,
      document: a.res.statusCode === 409 ? aFields : bFields,
    } }), retry);
    expect(retry.statusCode).toBe(200);
    return { a, b };
  }

  it("retains both concurrent field edits only after the stale editor reviews the committed version", async () => {
    await seedPage({ title: "Original", description: "Original description", blocks: [] });

    const { a, b } = await overlappingSaves(
      { title: "A title" },
      { description: "B description" },
    );

    // Neither editor touched the other's field, so both changes must survive.
    const [page] = await docsIn("cmsPages");
    expect(page.title).toBe("A title");
    expect(page.description).toBe("B description");

    // The mechanism, asserted rather than assumed, and the reason this test cannot pass
    // by luck. Both saves read the page before either wrote it, so one of them had to be
    // refused at commit and re-run against what the other had left: two reads for the
    // loser, one for the winner at minimum. Firestore may retry either transaction more
    // than once under contention, so the exact total is deliberately not pinned. Without
    // a re-run each save reads exactly once, whatever the timing, and the total stays at
    // two; requiring at least three keeps the real lost-update invariant deterministic.
    expect(
      a.barrier.reads + b.barrier.reads,
      "neither save re-read, so one of them wrote over a page it had not seen",
    ).toBeGreaterThanOrEqual(3);
  }, 10000);

  it("records the state each concurrent save and its reviewed retry actually replaced", async () => {
    await seedPage({ title: "Original", description: "Original description", blocks: [] });

    await overlappingSaves({ title: "A title" }, { description: "B description" });

    // Version history must read as an unbroken chain: each row's `before` is the row
    // ahead of it. A row whose `before` skips a committed state claims a transition that
    // never happened -- a compliance defect (#196) even when the content itself survived.
    // The server-owned version is what makes the chain checkable.
    const rows = (await docsIn("cmsVersionHistory")).sort(
      (x, y) => x.after.version - y.after.version,
    );
    expect(rows.map((r) => r.after.version)).toEqual([1, 2, 3]);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].before.version, `row ${i} records a before that was never stored`).toBe(
        rows[i - 1].after.version,
      );
      expect(rows[i].before.title).toBe(rows[i - 1].after.title);
      expect(rows[i].before.description).toBe(rows[i - 1].after.description);
    }
  }, 10000);

  // --- base-version echo (#530) ---
  //
  // A transaction serialises the writes but cannot tell that an editor composed a change
  // against content that has since moved: it faithfully overlays a stale field. The echo
  // is what catches that, so the second editor is told rather than silently overruled.
  // Dormant until the editor sends one (#563).

  it("stamps version 1 on create and counts up from there", async () => {
    const created = await seedPage({ title: "Original", blocks: [] });
    expect(created.version).toBe(1);

    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();
    await handler(
      makeReq({ body: { collection: "cmsPages", id: "home", baseVersion: created.version, document: { title: "Second" } } }),
      res,
    );
    expect(res.body.document.version).toBe(2);
  });

  describe("grouped page saves", () => {
    async function savePage(handler, { baseVersion, saveGroupId, document }) {
      const res = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "home",
            baseVersion,
            saveGroupId,
            document,
          },
        }),
        res,
      );
      return res;
    }

    it("counts one blocks save and its next metadata save as one content revision", async () => {
      const created = await seedPage({ title: "Original", blocks: [] });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

      const composition = await savePage(handler, {
        baseVersion: created.version,
        saveGroupId: "page-save-1",
        document: { blocks: [divider({ id: "grouped-divider" })] },
      });
      expect(composition.statusCode).toBe(200);
      expect(composition.body.document).toMatchObject({
        version: 2,
        contentVersion: 2,
        contentSaveGroup: "page-save-1",
      });

      const metadata = await savePage(handler, {
        baseVersion: composition.body.document.version,
        saveGroupId: "page-save-1",
        document: { title: "Grouped title" },
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.body.document).toMatchObject({ version: 3, contentVersion: 2 });
      expect(metadata.body.document.contentSaveGroup).toBeUndefined();

      const stale = await savePage(handler, {
        baseVersion: composition.body.document.version,
        saveGroupId: "page-save-1",
        document: { title: "Stale title" },
      });
      expect(stale.statusCode).toBe(409);
      expect((await db.collection("cmsPages").doc("home").get()).data()).toEqual(
        metadata.body.document,
      );
    });

    it("counts repeated metadata saves that reuse a group id", async () => {
      const created = await seedPage({ title: "Original", blocks: [] });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

      const first = await savePage(handler, {
        baseVersion: created.version,
        saveGroupId: "page-save-1",
        document: { title: "First title" },
      });
      const second = await savePage(handler, {
        baseVersion: first.body.document.version,
        saveGroupId: "page-save-1",
        document: { title: "Second title" },
      });

      expect(first.body.document).toMatchObject({ version: 2, contentVersion: 2 });
      expect(second.body.document).toMatchObject({ version: 3, contentVersion: 3 });
      expect(second.body.document.contentSaveGroup).toBeUndefined();
    });

    it("counts repeated blocks saves that reuse a group id", async () => {
      const created = await seedPage({ title: "Original", blocks: [] });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

      const first = await savePage(handler, {
        baseVersion: created.version,
        saveGroupId: "page-save-1",
        document: { blocks: [divider({ id: "first-divider" })] },
      });
      const second = await savePage(handler, {
        baseVersion: first.body.document.version,
        saveGroupId: "page-save-1",
        document: { blocks: [divider({ id: "second-divider" })] },
      });

      expect(first.body.document).toMatchObject({ version: 2, contentVersion: 2 });
      expect(second.body.document).toMatchObject({
        version: 3,
        contentVersion: 3,
        contentSaveGroup: "page-save-1",
      });
    });

    it("consumes a pending group on a no-op metadata save", async () => {
      const created = await seedPage({ title: "Original", blocks: [] });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

      const composition = await savePage(handler, {
        baseVersion: created.version,
        saveGroupId: "page-save-1",
        document: { blocks: [divider({ id: "grouped-divider" })] },
      });
      const noOp = await savePage(handler, {
        baseVersion: composition.body.document.version,
        saveGroupId: "page-save-1",
        document: { title: "Original" },
      });
      expect(noOp.body.document).toMatchObject({ version: 2, contentVersion: 2 });
      expect(noOp.body.document.contentSaveGroup).toBeUndefined();

      const changed = await savePage(handler, {
        baseVersion: noOp.body.document.version,
        saveGroupId: "page-save-1",
        document: { title: "After no-op" },
      });
      expect(changed.body.document).toMatchObject({ version: 3, contentVersion: 3 });
      expect(changed.body.document.contentSaveGroup).toBeUndefined();
    });
  });

  it("rejects a save whose base version is stale", async () => {
    await seedPage({ title: "Original", slug: "home", blocks: [] });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

    // Editor A saves from version 1, taking the page to version 2.
    const resA = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: { title: "A title" },
        },
      }),
      resA,
    );
    expect(resA.statusCode).toBe(200);

    // Editor B still has version 1 open and saves the same field.
    const resB = makeRes();
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: { title: "B title" },
        },
      }),
      resB,
    );

    expect(resB.statusCode).toBe(409);
    expect(resB.body.error).toMatch(/changed since you opened it/);

    // A's title stands and B's save left no trace: no write, no version bump, and no
    // compliance rows for a change that never happened.
    const [page] = await docsIn("cmsPages");
    expect(page.title).toBe("A title");
    expect(page.version).toBe(2);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(2);
    expect(await docsIn("admin_logs")).toHaveLength(2);
  });

  it("accepts a save whose base version is current", async () => {
    await seedPage({ title: "Original", blocks: [] });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: { title: "Next" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ title: "Next", version: 2 });
  });

  it("rejects a base version on a document that does not exist", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    // Nothing was ever stored, so no editor could have opened version 1 of it.
    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          document: { title: "Home" },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("rejects a malformed base version before reading anything", async () => {
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });

    for (const baseVersion of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      const res = makeRes();
      await handler(
        makeReq({
          body: { collection: "cmsPages", id: "home", baseVersion, document: { title: "Home" } },
        }),
        res,
      );
      expect(res.statusCode, `baseVersion ${JSON.stringify(baseVersion)}`).toBe(400);
    }
    expect(await docsIn("cmsPages")).toHaveLength(0);
  });

  it("refuses a missing base version on saved content", async () => {
    await seedPage({ title: "Original", blocks: [] });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({ body: { collection: "cmsPages", id: "home", document: { title: "Next" } } }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect((await db.collection("cmsPages").doc("home").get()).data()).toMatchObject({ title: "Original", version: 1 });
    expect(await docsIn("cmsVersionHistory")).toHaveLength(1);
  });

  it("ignores a client-sent version, counting saves itself", async () => {
    await seedPage({ title: "Original", blocks: [] });
    const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
    const res = makeRes();

    await handler(
      makeReq({
        body: {
          collection: "cmsPages",
          id: "home",
          baseVersion: 1,
          // A client that could set the stored version could echo its own answer back
          // and defeat the check entirely.
          document: { title: "Next", version: 99 },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.document.version).toBe(2);
    const [page] = await docsIn("cmsPages");
    expect(page.version).toBe(2);
  });
  // Write-path authorization (#529). The endpoint asks lib/content-authorization
  // whether this principal may make this specific save; these cases pin what that
  // means at the HTTP boundary, including what a refused caller is told.
  describe("capability gate", () => {
    const withGrants = (grants, id = "editor-1") => () => ({
      uid: id,
      email: `${id}@x`,
      principal: { id, grants },
    });
    const silentLog = { info() {}, warn() {}, error() {} };

    it("lets a site-wide editor save, and records who created the record", async () => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }]),
        mintId: sequentialMinter("rec"),
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: postDraft("Desk copy"),
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [post] = await docsIn("cmsPosts");
      expect(post.createdBy).toBe("editor-1");
    });

    it("refuses a caller with no grants before reading the document", async () => {
      const reads = [];
      const spy = {
        collection: (name) => {
          reads.push(name);
          return db.collection(name);
        },
        runTransaction: (...args) => db.runTransaction(...args),
      };
      const handler = createCmsSaveHandler({
        firestore: spy,
        requirePrincipalFn: withGrants([], "nobody"),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "home",
            document: { title: "Home", blocks: [] },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("You do not have permission to save this record.");
      expect(reads).toEqual([]);
      expect(await docsIn("cmsPages")).toHaveLength(0);
    });

    it("keeps the reason out of the response and in the log", async () => {
      const warnings = [];
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        log: { info() {}, error() {}, warn: (message, context) => warnings.push(context) },
      });
      const res = makeRes();

      // Someone else's record: seeded by the admin stub, so its owner is u1.
      await seedPage({ title: "Home", blocks: [] });
      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "home",
            document: { title: "Rewritten by a contributor" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("You do not have permission to save this record.");
      expect(warnings[0]).toMatchObject({ uid: "contributor-1" });
      expect(warnings[0].reason).toContain("ownership");
      const [page] = await docsIn("cmsPages");
      expect(page.title).toBe("Home");
    });

    it("does not reveal target existence, version, or status before authorization", async () => {
      await db.collection("cmsPosts").doc("private-post").set({
        id: "private-post",
        type: "post",
        title: "Private draft",
        status: "draft",
        blocks: [],
        createdBy: "another-editor",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        log: silentLog,
      });

      const requests = [
        {
          collection: "cmsPosts",
          id: "missing-post",
          document: { title: "Probe" },
        },
        {
          collection: "cmsPosts",
          id: "private-post",
          baseVersion: 6,
          document: { title: "Probe" },
        },
        {
          collection: "cmsPosts",
          id: "private-post",
          document: { status: "published" },
        },
      ];

      for (const body of requests) {
        const res = makeRes();
        await handler(makeReq({ body }), res);
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe("You do not have permission to save this record.");
      }
      expect((await db.collection("cmsPosts").doc("private-post").get()).data()).toMatchObject({
        title: "Private draft",
        status: "draft",
        version: 7,
      });
    });

    it("authorizes an existing create-only target before reporting its conflict", async () => {
      await db.collection("cmsPages").doc("watch").set({
        id: "watch",
        template: "programLanding",
        title: "Private Watch page",
        status: "draft",
        blocks: [],
        createdBy: "another-editor",
        version: 2,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            document: { template: "programLanding", title: "Probe" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("You do not have permission to save this record.");
    });

    it("refuses a desk-scoped editor, because a record carries no desk yet", async () => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor", sections: ["news"] }]),
        log: silentLog,
        mintId: sequentialMinter("rec"),
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: { type: "post", title: "News desk copy", blocks: [] },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(await docsIn("cmsPosts")).toHaveLength(0);
    });

    it("refuses a contributor scheduling their own draft", async () => {
      const contributor = withGrants([{ role: "contributor" }], "contributor-1");
      const create = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: contributor,
        mintId: sequentialMinter("rec"),
      });
      const createRes = makeRes();
      await create(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: postDraft("My draft"),
          },
        }),
        createRes,
      );
      expect(createRes.statusCode).toBe(200);
      const created = createRes.body.document;

      const schedule = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: contributor,
        log: silentLog,
      });
      const scheduleRes = makeRes();
      await schedule(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: created.id,
            baseVersion: created.version,
            document: { status: "scheduled" },
          },
        }),
        scheduleRes,
      );

      expect(scheduleRes.statusCode).toBe(403);
      const [post] = await docsIn("cmsPosts");
      expect(post.status).toBe("draft");
    });

    it.each(["cmsPages", "cmsPosts"])(
      "lets a contributor save and submit their own %s draft but refuses publish paths",
      async (collection) => {
        const contributor = withGrants(
          [{ role: "contributor" }],
          "contributor-1",
        );
        const assertPublishReadyFn = vi.fn();
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: contributor,
          mintId: sequentialMinter("rec"),
          enablePublishSnapshot: true,
          assertPublishReadyFn,
          log: silentLog,
        });
        const save = async (body) => {
          const res = makeRes();
          await handler(makeReq({ body }), res);
          return res;
        };
        const createBody = collection === "cmsPages"
          ? {
              collection,
              id: "about",
              document: { title: "My page draft", blocks: [] },
            }
          : {
              collection,
              section: "watch",
              document: postDraft("My post draft"),
            };

        const createRes = await save(createBody);
        expect(createRes.statusCode).toBe(200);
        const created = createRes.body.document;

        const editRes = await save({
          collection,
          id: created.id,
          baseVersion: created.version,
          document: { title: "My saved draft" },
        });
        expect(editRes.statusCode).toBe(200);
        expect(editRes.body.document).toMatchObject({
          createdBy: "contributor-1",
          status: "draft",
        });
        const edited = editRes.body.document;

        const injectedStatus = await save({
          collection,
          id: created.id,
          baseVersion: edited.version,
          document: { status: "published" },
        });
        expect(injectedStatus.statusCode).toBe(403);

        const submitRes = await save({
          collection,
          id: created.id,
          baseVersion: edited.version,
          document: { status: "in_review" },
        });
        expect(submitRes.statusCode).toBe(200);
        expect(submitRes.body.document.status).toBe("in_review");

        const publishRes = await save({
          collection,
          id: created.id,
          baseVersion: submitRes.body.document.version,
          publish: true,
          document: {},
        });
        expect(publishRes.statusCode).toBe(403);
        expect(publishRes.body.error).toBe(
          "You do not have permission to save this record.",
        );
        expect(assertPublishReadyFn).not.toHaveBeenCalled();
        expect((await db.collection(collection).doc(created.id).get()).data())
          .toMatchObject({
            createdBy: "contributor-1",
            status: "in_review",
            version: submitRes.body.document.version,
          });
      },
    );

    it("refuses a contributor seeding another editor's draft", async () => {
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Private legacy draft",
        status: "draft",
        blocks: [divider({ id: "legacy-divider" })],
        createdBy: "legacy-editor",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        mintId: sequentialMinter(),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("You do not have permission to save this record.");
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
    });

    it("answers an absent legacy seed like one the caller may not read", async () => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        mintId: sequentialMinter(),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("You do not have permission to save this record.");
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
    });

    it("refuses a soft-deleted legacy seed before composing a new page", async () => {
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Deleted legacy landing page",
        status: "draft",
        blocks: [divider({ id: "legacy-divider" })],
        createdBy: "legacy-editor",
        deleted: true,
        deletedAt: "2026-08-05T00:00:00.000Z",
        deletedBy: "admin-1",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        mintId: sequentialMinter(),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/no longer available/i);
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
      expect(
        (await db.collection("cmsPages").doc("programLanding").get()).data().title,
      ).toBe("Deleted legacy landing page");
    });

    it("refuses a contributor seeding a live legacy page into a new published one", async () => {
      // The seed lives at programLanding; this creates watch. Two documents, two
      // public paths, so cloning a live page into a new one publishes content that
      // was not public before and takes content.publish. Reading the seed's status
      // as though it were this record's would call that no transition at all.
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Legacy landing page",
        status: "published",
        blocks: [divider({ id: "legacy-divider" })],
        createdBy: "contributor-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        updatedBy: "legacy-editor",
        version: 7,
      });
      for (const enablePublishSnapshot of [false, true]) {
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: withGrants(
            [{ role: "contributor" }],
            "contributor-1",
          ),
          mintId: sequentialMinter(),
          enablePublishSnapshot,
          log: silentLog,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPages",
              id: "watch",
              createOnly: true,
              seedFromLegacyPage: { id: "programLanding", version: 7 },
              document: {
                template: "programLanding",
                blocks: [divider({ id: "legacy-divider" })],
              },
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(403);
        expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
      }
    });

    it("lets an editor materialize an archived legacy page without treating create as restore", async () => {
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Archived legacy landing page",
        status: "archived",
        blocks: [divider({ id: "legacy-divider" })],
        createdBy: "editor-1",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        mintId: sequentialMinter(),
        now: () => "2026-08-13T04:00:00.000Z",
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect((await db.collection("cmsPages").doc("watch").get()).data())
        .toMatchObject({
          id: "watch",
          title: "Archived legacy landing page",
          status: "archived",
          createdBy: "editor-1",
          version: 1,
        });
    });

    it("lets an editor seed a live legacy page, and records the caller as owner", async () => {
      // The same save an editor is allowed to make, so the refusal above is about
      // the missing capability and not about seeded creates being blocked.
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Legacy landing page",
        status: "published",
        blocks: [divider({ id: "legacy-divider" })],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        updatedBy: "legacy-editor",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        mintId: sequentialMinter(),
        now: () => "2026-08-12T22:00:00.000Z",
        enablePublishSnapshot: true,
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const stored = (await db.collection("cmsPages").doc("watch").get()).data();
      expect(stored).toMatchObject({
        status: "published",
        publishAt: "2026-08-12T22:00:00.000Z",
        publishBuildPending: true,
        publishBuildQueueId: null,
        published: {
          metadata: { title: "Legacy landing page" },
          publishedAt: "2026-08-12T22:00:00.000Z",
          publishedBy: "editor-1",
          sourceVersion: 1,
        },
      });
      expect(stored.published.blocks).toEqual(stored.blocks);
      // Ownership is the caller's, not the legacy page's: a seeded create is
      // still a create.
      expect(stored.createdBy).toBe("editor-1");
      const versions = await docsIn("cmsVersionHistory");
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ action: "publish", before: null });
      const logs = await docsIn("admin_logs");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "cms.publish-snapshot",
        target: "cmsPages/watch",
      });
    });

    it("refuses a live legacy seed when snapshot publishing is disabled", async () => {
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Legacy landing page",
        status: "published",
        blocks: [divider({ id: "legacy-divider" })],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        updatedBy: "legacy-editor",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        mintId: sequentialMinter(),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(503);
      expect(res.body.error).toMatch(/publish snapshots are not enabled/i);
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
      expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
      expect(await docsIn("admin_logs")).toHaveLength(0);
    });

    it("reports a malformed live legacy seed as a normal publish refusal", async () => {
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        status: "published",
        blocks: [divider({ id: "legacy-divider" })],
        version: 7,
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        mintId: sequentialMinter(),
        enablePublishSnapshot: true,
        log,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("title is required");
      expect(log.error).not.toHaveBeenCalled();
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
      expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
      expect(await docsIn("admin_logs")).toHaveLength(0);
    });

    it("refuses a contributor seeding a scheduled legacy page into a new one", async () => {
      // The scheduled variant of the same hole. A record created as scheduled goes
      // live later with nobody present, so a create that enters scheduled takes
      // content.publish exactly as entering published does.
      await db.collection("cmsPages").doc("programLanding").set({
        id: "programLanding",
        template: "programLanding",
        title: "Legacy landing page",
        status: "scheduled",
        publishAt: "2030-01-01T00:00:00.000Z",
        blocks: [divider({ id: "legacy-divider" })],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        updatedBy: "legacy-editor",
        version: 7,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        mintId: sequentialMinter(),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            createOnly: true,
            seedFromLegacyPage: { id: "programLanding", version: 7 },
            document: {
              template: "programLanding",
              blocks: [divider({ id: "legacy-divider" })],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect((await db.collection("cmsPages").doc("watch").get()).exists).toBe(false);
    });

    it("does not let a save soft-delete a record", async () => {
      // cmsBulkArchive requires admin to soft-delete, and the public build skips a
      // deleted page. Without these fields being server-owned, a site-wide editor
      // could take live content off the site through the save endpoint while
      // holding neither content.delete nor admin.
      await db.collection("cmsPages").doc("watch").set({
        id: "watch",
        template: "programLanding",
        title: "Watch",
        status: "draft",
        blocks: [divider({ id: "keep" })],
        version: 3,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            baseVersion: 3,
            document: {
              template: "programLanding",
              title: "Watch",
              deleted: true,
              deletedAt: "2026-08-05T00:00:00.000Z",
              deletedBy: "editor-1",
            },
          },
        }),
        res,
      );

      // The save itself is fine; the delete fields are simply not the client's to set.
      expect(res.statusCode).toBe(200);
      const stored = (await db.collection("cmsPages").doc("watch").get()).data();
      expect(stored.deleted).toBeUndefined();
      expect(stored.deletedAt).toBeUndefined();
      expect(stored.deletedBy).toBeUndefined();
      expect(stored.status).toBe("draft");
    });

    it("refuses a save whose stored target is already soft-deleted", async () => {
      await db.collection("cmsPages").doc("watch").set({
        id: "watch",
        template: "programLanding",
        title: "Deleted Watch page",
        status: "draft",
        blocks: [divider({ id: "keep" })],
        createdBy: "editor-1",
        deleted: true,
        deletedAt: "2026-08-05T00:00:00.000Z",
        deletedBy: "admin-1",
        version: 3,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "watch",
            baseVersion: 3,
            document: { title: "Resurrected Watch page" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/no longer available/i);
      const stored = (await db.collection("cmsPages").doc("watch").get()).data();
      expect(stored.title).toBe("Deleted Watch page");
      expect(stored.version).toBe(3);
      expect(stored.deleted).toBe(true);
    });

    it("routes archived-record restoration through the dedicated lifecycle action", async () => {
      await db.collection("cmsPosts").doc("archived-post").set({
        id: "archived-post",
        type: "post",
        title: "Archived post",
        date: "2026-07-15",
        tags: [],
        status: "archived",
        blocks: [],
        createdBy: "editor-1",
        version: 3,
      });
      const editorSave = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        log: silentLog,
      });
      const editorRes = makeRes();

      await editorSave(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "archived-post",
            baseVersion: 3,
            document: { status: "draft" },
          },
        }),
        editorRes,
      );

      expect(editorRes.statusCode).toBe(403);
      expect(editorRes.body.error).toMatch(/permission to save/i);
      expect(
        (await db.collection("cmsPosts").doc("archived-post").get()).data().status,
      ).toBe("archived");

      const adminSave = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "admin" }], "admin-1"),
        log: silentLog,
      });
      const adminRes = makeRes();
      await adminSave(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "archived-post",
            baseVersion: 3,
            document: { status: "draft" },
          },
        }),
        adminRes,
      );

      expect(adminRes.statusCode).toBe(400);
      expect(adminRes.body.error).toMatch(/dedicated lifecycle action/i);
      expect(
        (await db.collection("cmsPosts").doc("archived-post").get()).data(),
      ).toMatchObject({ status: "archived", version: 3 });
    });

    it("routes an incomplete recognized legacy record through the dedicated lifecycle action", async () => {
      await db.collection("cmsPosts").doc("legacy-sponsor").set({
        id: "legacy-sponsor",
        type: "sponsor",
        name: "Legacy supporter",
        slug: "legacy-supporter",
        previousSlugs: [],
        locale: "en",
        publishAt: "2026-07-15T00:00:00.000Z",
        status: "published",
        createdBy: "editor-1",
        version: 3,
      });
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "admin" }], "admin-1"),
        log: silentLog,
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "legacy-sponsor",
            baseVersion: 3,
            document: { status: "draft" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/dedicated lifecycle action/i);
      expect(
        (await db.collection("cmsPosts").doc("legacy-sponsor").get()).data(),
      ).toMatchObject({
        name: "Legacy supporter",
        status: "published",
        version: 3,
      });
    });

    it("routes archive through the dedicated lifecycle action", async () => {
      await db.collection("cmsPosts").doc("draft-post").set({
        id: "draft-post",
        type: "post",
        title: "Draft post",
        date: "2026-07-15",
        tags: [],
        status: "draft",
        blocks: [],
        createdBy: "editor-1",
        version: 3,
      });
      const editorSave = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "editor" }], "editor-1"),
        log: silentLog,
      });
      const editorRes = makeRes();

      await editorSave(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "draft-post",
            baseVersion: 3,
            document: { status: "archived" },
          },
        }),
        editorRes,
      );

      expect(editorRes.statusCode).toBe(403);
      expect(editorRes.body.error).toMatch(/permission to save/i);
      expect(
        (await db.collection("cmsPosts").doc("draft-post").get()).data().status,
      ).toBe("draft");

      const adminSave = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "admin" }], "admin-1"),
        log: silentLog,
      });
      const adminRes = makeRes();
      await adminSave(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "draft-post",
            baseVersion: 3,
            document: { status: "archived" },
          },
        }),
        adminRes,
      );

      expect(adminRes.statusCode).toBe(400);
      expect(adminRes.body.error).toMatch(/dedicated lifecycle action/i);
      expect((await db.collection("cmsPosts").doc("draft-post").get()).data())
        .toMatchObject({ status: "draft", version: 3 });
    });

    it("does not let a client claim ownership of the record it creates", async () => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: withGrants([{ role: "contributor" }], "contributor-1"),
        mintId: sequentialMinter("rec"),
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            section: "watch",
            document: {
              type: "post",
              title: "Forged owner",
              date: "2026-07-15",
              tags: [],
              blocks: [],
              createdBy: "somebody-else",
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [post] = await docsIn("cmsPosts");
      expect(post.createdBy).toBe("contributor-1");
    });
  });
  // --- the scoped-grant section (#619) ---
  //
  // Not the page-builder block section: this is the editorial desk that rbac.ts
  // Resource.section keys on. The authorization call sites are wired separately (#845);
  // these cases cover only how the field reaches a document and what stops it moving.
  describe("content section", () => {
    async function registerSections(ids = ["watch", "support", "station", "compliance"]) {
      await Promise.all(
        ids.map((id) => db.collection("sections").doc(id).set({ id, label: id, order: 1 })),
      );
    }

    function newPostDocument(title = "Sectioned post") {
      return { type: "post", title, date: "2026-08-21", tags: [], blocks: [] };
    }

    it("stamps a page with its public-page area, ignoring the editor template", async () => {
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPages", id: "give", document: { title: "Give" } },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      // give and watch share the programLanding template but sit in different desks.
      expect(res.body.document.section).toBe("support");
      expect((await db.collection("cmsPages").doc("give").get()).data().section).toBe(
        "support",
      );
    });

    it("refuses a client-supplied section on a page save", async () => {
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPages",
            id: "give",
            section: "watch",
            document: { title: "Give" },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/editing group is fixed/i);
      expect(await docsIn("cmsPages")).toHaveLength(0);
    });

    it("recomputes a page section that disagrees with the registry", async () => {
      await db.collection("cmsPages").doc("about").set({
        id: "about",
        template: "programLanding",
        title: "About",
        section: "watch",
        version: 1,
      });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPages", id: "about", baseVersion: 1, document: { title: "About NJ PBS" } },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.document.section).toBe("station");
    });

    it("stores a registered section on a record create", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "watch", document: newPostDocument() },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.document.section).toBe("watch");
      const [post] = await docsIn("cmsPosts");
      expect(post.section).toBe("watch");
    });

    it("refuses a create whose section is not in the runtime registry", async () => {
      await registerSections(["watch"]);
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "news", document: newPostDocument() },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Unknown section news/);
      expect(await docsIn("cmsPosts")).toHaveLength(0);
      expect(await docsIn("admin_logs")).toHaveLength(0);
    });

    it("refuses a create against an unseeded registry rather than inventing a desk", async () => {
      // The suite seeds the four desks for every case, because a create now has to name a
      // registered one. Clear them here: the point of this case is that an unregistered
      // name is refused rather than quietly created.
      const seeded = await db.collection("sections").get();
      await Promise.all(seeded.docs.map((entry) => entry.ref.delete()));
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "watch", document: newPostDocument() },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Unknown section watch/);
    });

    it.each([[""], [" watch"], [42]])(
      "rejects a malformed section value (%p)",
      async (value) => {
        const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
        const res = makeRes();

        await handler(
          makeReq({
            body: { collection: "cmsPosts", section: value, document: newPostDocument() },
          }),
          res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/section id/);
      },
    );

    // Two different immutability mechanics, deliberately. A `section` inside the document
    // is silently stripped, because that is what SERVER_MANAGED_CONTENT_FIELDS already
    // does for createdBy and every other server-owned field. A `section` on the request
    // envelope is a deliberate ask, so a differing one is refused out loud rather than
    // quietly dropped.
    it("strips a section sent inside the document overlay", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const create = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "watch", document: newPostDocument() },
        }),
        create,
      );
      const recordId = create.body.id;

      const update = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: recordId,
            baseVersion: create.body.document.version,
            document: { ...newPostDocument("Moved"), section: "compliance" },
          },
        }),
        update,
      );

      expect(update.statusCode).toBe(200);
      expect(update.body.document.section).toBe("watch");
      expect(update.body.document.title).toBe("Moved");
    });

    it("refuses an ordinary save that asks to move the record to another section", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const create = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "watch", document: newPostDocument() },
        }),
        create,
      );
      const recordId = create.body.id;

      const update = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: recordId,
            baseVersion: create.body.document.version,
            section: "compliance",
            document: newPostDocument("Moved"),
          },
        }),
        update,
      );

      expect(update.statusCode).toBe(400);
      expect(update.body.error).toMatch(/cannot be changed/i);
      const [post] = await docsIn("cmsPosts");
      expect(post.section).toBe("watch");
      expect(post.title).toBe("Sectioned post");
    });

    it("accepts a save that restates the record's own section", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const create = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPosts", section: "watch", document: newPostDocument() },
        }),
        create,
      );

      const update = makeRes();
      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: create.body.id,
            baseVersion: create.body.document.version,
            section: "watch",
            document: newPostDocument("Edited"),
          },
        }),
        update,
      );

      expect(update.statusCode).toBe(200);
      expect(update.body.document.section).toBe("watch");
    });

    it("leaves an unsectioned legacy record unsectioned when someone else edits it", async () => {
      await registerSections();
      await db.collection("cmsPosts").doc("legacy-1").set({
        id: "legacy-1",
        type: "post",
        title: "Legacy post",
        date: "2026-01-05",
        tags: [],
        blocks: [],
        version: 3,
      });
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            id: "legacy-1",
            baseVersion: 3,
            document: {
              type: "post",
              title: "Legacy post edited",
              date: "2026-01-05",
              tags: [],
              blocks: [],
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      // A scoped grant denies an unsectioned resource, so inheriting a desk from the last
      // editor would silently widen who can reach this record.
      expect(res.body.document.section).toBeUndefined();
    });

    // The create nonce addresses one attempt. The section is part of what that attempt
    // asked for, so it has to be part of the address -- otherwise a retry that changes
    // only the section lands on the first section's record and is answered as a
    // successful replay, which tells the caller the second desk took when it never did.
    it("replays the same create when the key, document and section all match", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const body = {
        collection: "cmsPosts",
        section: "watch",
        idempotencyKey: "attempt-nonce-0001",
        document: newPostDocument(),
      };

      const first = makeRes();
      await handler(makeReq({ body }), first);
      const second = makeRes();
      await handler(makeReq({ body }), second);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.document.section).toBe("watch");
      // One create: one record, one version, one audit row.
      expect(await docsIn("cmsPosts")).toHaveLength(1);
      expect(second.body.document.version).toBe(1);
      expect(await docsIn("admin_logs")).toHaveLength(1);
    });

    it("gives a retry that changes only the section its own record", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const base = {
        collection: "cmsPosts",
        idempotencyKey: "attempt-nonce-0002",
        document: newPostDocument(),
      };

      const first = makeRes();
      await handler(makeReq({ body: { ...base, section: "watch" } }), first);
      const second = makeRes();
      await handler(makeReq({ body: { ...base, section: "compliance" } }), second);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // The second ask must not be answered with the first desk's record.
      expect(second.body.id).not.toBe(first.body.id);
      expect(second.body.document.section).toBe("compliance");

      const posts = await docsIn("cmsPosts");
      expect(posts).toHaveLength(2);
      expect(posts.map((post) => post.section).sort()).toEqual(["compliance", "watch"]);
    });

    it("refuses a replay that reaches a record stored in another section", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const body = {
        collection: "cmsPosts",
        section: "watch",
        idempotencyKey: "attempt-nonce-0003",
        document: newPostDocument(),
      };

      const first = makeRes();
      await handler(makeReq({ body }), first);

      // Stand in for a nonce minted before the section joined the fingerprint: the
      // address still resolves, but the stored desk is not the one being asked for.
      await db
        .collection("cmsPosts")
        .doc(first.body.id)
        .update({ section: "compliance" });

      const replay = makeRes();
      await handler(makeReq({ body }), replay);

      expect(replay.statusCode).toBe(409);
      expect(replay.body.conflict).toBe("create-replay-section");
      expect(replay.body.error).toMatch(/different section/i);
      expect(await docsIn("cmsPosts")).toHaveLength(1);
    });

    it("replays a create that names the same desk", async () => {
      await registerSections();
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const body = {
        collection: "cmsPosts",
        idempotencyKey: "attempt-nonce-0004",
        section: "watch",
        document: newPostDocument(),
      };

      const first = makeRes();
      await handler(makeReq({ body }), first);
      const second = makeRes();
      await handler(makeReq({ body }), second);

      expect(second.statusCode).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await docsIn("cmsPosts")).toHaveLength(1);
    });

    it("creates an owner-only draft when an admin has not selected a desk", async () => {
      const handler = createCmsSaveHandler({
        firestore: db,
        requirePrincipalFn: adminOk,
        mintId: () => "admin-unassigned",
      });
      const res = makeRes();

      await handler(
        makeReq({
          body: {
            collection: "cmsPosts",
            document: newPostDocument(""),
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        id: "admin-unassigned",
        created: true,
        document: {
          id: "admin-unassigned",
          title: "",
          blocks: [],
          createdBy: "u1",
          unassignedDraft: true,
          version: 1,
        },
      });
      expect(res.body.document.section).toBeUndefined();
      expect(res.body.document.slug).toBeUndefined();
      const titled = makeRes();
      await handler(makeReq({ body: { collection: "cmsPosts", id: "admin-unassigned", baseVersion: res.body.document.version, document: { title: "New Jersey reporting" } } }), titled);
      expect(titled.statusCode).toBe(200);
      expect(titled.body.document.slug).toBe("new-jersey-reporting");

      expect((await db.collection("cmsPosts").doc("admin-unassigned").get()).data())
        .toMatchObject({
          createdBy: "u1",
          unassignedDraft: true,
          version: 2,
        });
    });

    // --- section-scoped writes (#845) ---
    //
    // #619 stored the desk; these are the cases where it actually decides a save. The
    // authorization resource states the document's own desk, so a scoped editor writes
    // inside their grant and nowhere else.
    describe("a section-scoped editor", () => {
      const watchEditor = () => ({
        uid: "scoped-1",
        email: "fixture-bb79e52212@example.org",
        principal: { id: "scoped-1", grants: [{ role: "editor", sections: ["watch"] }] },
      });
      const otherWatchEditor = () => ({
        uid: "scoped-2",
        email: "fixture-40f3d6b537@example.org",
        principal: { id: "scoped-2", grants: [{ role: "editor", sections: ["watch"] }] },
      });

      async function seedRecord(id, section) {
        await db.collection("cmsPosts").doc(id).set({
          id,
          ...newPostDocument("Stored"),
          status: "draft",
          createdBy: "someone-else",
          version: 2,
          ...(section === undefined ? {} : { section }),
        });
      }

      function saveRecord(id) {
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
        });
        const res = makeRes();
        return handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id,
              baseVersion: 2,
              document: newPostDocument("Edited"),
            },
          }),
          res,
        ).then(() => res);
      }

      it("creates and autosaves its own unassigned post draft", async () => {
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
          mintId: () => "scoped-unassigned",
        });
        const create = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              document: newPostDocument(""),
            },
          }),
          create,
        );

        expect(create.statusCode).toBe(200);
        expect(create.body.document).toMatchObject({
          id: "scoped-unassigned",
          title: "",
          blocks: [],
          createdBy: "scoped-1",
          unassignedDraft: true,
          version: 1,
        });
        expect(create.body.document.section).toBeUndefined();

        const autosave = makeRes();
        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: create.body.id,
              baseVersion: 1,
              document: { title: "", blocks: [] },
            },
          }),
          autosave,
        );

        expect(autosave.statusCode).toBe(200);
        expect(autosave.body.id).toBe(create.body.id);
        expect(autosave.body.document).toMatchObject({
          createdBy: "scoped-1",
          unassignedDraft: true,
          version: 1,
        });
        expect(autosave.body.document.section).toBeUndefined();
      });

      it("does not let another editor edit an unassigned draft", async () => {
        const stored = {
          id: "another-editor-draft",
          ...newPostDocument(""),
          status: "draft",
          createdBy: "scoped-1",
          unassignedDraft: true,
          version: 2,
        };
        await db.collection("cmsPosts").doc(stored.id).set(stored);
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: otherWatchEditor,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: stored.id,
              baseVersion: 2,
              document: { title: "Taken over" },
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(403);
        expect((await db.collection("cmsPosts").doc(stored.id).get()).data())
          .toEqual(stored);
        expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
        expect(await docsIn("admin_logs")).toHaveLength(0);
      });

      it("assigns its unassigned draft once inside its scope", async () => {
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
          mintId: () => "draft-to-assign",
        });
        const create = makeRes();
        await handler(
          makeReq({
            body: { collection: "cmsPosts", document: newPostDocument("") },
          }),
          create,
        );
        const beforeAssignment = (
          await db.collection("cmsPosts").doc(create.body.id).get()
        ).data();

        const outOfScope = makeRes();
        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: create.body.id,
              baseVersion: 1,
              section: "compliance",
              document: {},
            },
          }),
          outOfScope,
        );
        expect(outOfScope.statusCode).toBe(403);
        expect((await db.collection("cmsPosts").doc(create.body.id).get()).data())
          .toEqual(beforeAssignment);

        const assigned = makeRes();
        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: create.body.id,
              baseVersion: 1,
              section: "watch",
              document: {},
            },
          }),
          assigned,
        );
        expect(assigned.statusCode).toBe(200);
        expect(assigned.body.document).toMatchObject({
          section: "watch",
          createdBy: "scoped-1",
          version: 2,
        });
        expect(assigned.body.document.unassignedDraft).toBeUndefined();

        const move = makeRes();
        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: create.body.id,
              baseVersion: 2,
              section: "compliance",
              document: {},
            },
          }),
          move,
        );
        expect(move.statusCode).toBe(400);
        expect(move.body.error).toMatch(/cannot be changed/i);
        expect((await db.collection("cmsPosts").doc(create.body.id).get()).data())
          .toEqual(assigned.body.document);
      });

      it("does not accept a forged unassigned marker on a legacy record", async () => {
        const stored = {
          id: "legacy-forged-unassigned",
          ...newPostDocument("Legacy"),
          status: "draft",
          createdBy: "scoped-1",
          version: 2,
        };
        await db.collection("cmsPosts").doc(stored.id).set(stored);
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: stored.id,
              baseVersion: 2,
              document: { title: "Forged", unassignedDraft: true },
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(403);
        expect((await db.collection("cmsPosts").doc(stored.id).get()).data())
          .toEqual(stored);
        expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
        expect(await docsIn("admin_logs")).toHaveLength(0);
      });

      it.each([
        ["publish", { publish: true, document: {} }],
        ["review", { document: { status: "in_review" } }],
      ])("does not let an unassigned draft enter %s", async (_action, request) => {
        const stored = {
          id: "unassigned-lifecycle",
          ...newPostDocument("Ready for review"),
          status: "draft",
          createdBy: "scoped-1",
          unassignedDraft: true,
          version: 2,
        };
        await db.collection("cmsPosts").doc(stored.id).set(stored);
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
          enablePublishSnapshot: true,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              id: stored.id,
              baseVersion: 2,
              ...request,
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(403);
        expect((await db.collection("cmsPosts").doc(stored.id).get()).data())
          .toEqual(stored);
        expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
        expect(await docsIn("admin_logs")).toHaveLength(0);
      });

      it("creates a record into a desk their grant names", async () => {
        await registerSections();
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              section: "watch",
              document: newPostDocument(),
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.document.section).toBe("watch");
      });

      it("cannot create a record into a desk their grant does not name", async () => {
        // The create is authorized against the desk it asks for, so asking for somebody
        // else's desk is refused before anything is written -- a create is otherwise the
        // one write with no stored document to check against.
        await registerSections();
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
        });
        const res = makeRes();

        await handler(
          makeReq({
            body: {
              collection: "cmsPosts",
              section: "compliance",
              document: newPostDocument(),
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(403);
        expect(await docsIn("cmsPosts")).toHaveLength(0);
      });

      it("edits a stored record in their own desk", async () => {
        await registerSections();
        await seedRecord("a-1", "watch");

        const res = await saveRecord("a-1");

        expect(res.statusCode).toBe(200);
        const [post] = await docsIn("cmsPosts");
        expect(post.title).toBe("Edited");
        expect(post.section).toBe("watch");
      });

      it("cannot edit a stored record in another desk", async () => {
        await registerSections();
        await seedRecord("a-2", "compliance");

        const res = await saveRecord("a-2");

        expect(res.statusCode).toBe(403);
        const [post] = await docsIn("cmsPosts");
        expect(post.title).toBe("Stored");
        expect(post.version).toBe(2);
      });

      it("cannot edit a record stored before the registry existed", async () => {
        // Deny-by-default. A record with no desk is outside every scope until a backfill
        // puts it in one, not implicitly inside all of them.
        await registerSections();
        await seedRecord("a-3", undefined);

        const res = await saveRecord("a-3");

        expect(res.statusCode).toBe(403);
        expect((await docsIn("cmsPosts"))[0].version).toBe(2);
      });

      it("saves a canonical page in their own public area, and no other", async () => {
        // A page's desk is server-owned, so /watch/ is the watch desk and /support/ is not,
        // whatever either document stores.
        await registerSections();
        const handler = createCmsSaveHandler({
          firestore: db,
          requirePrincipalFn: watchEditor,
        });

        const inArea = makeRes();
        await handler(
          makeReq({
            body: { collection: "cmsPages", id: "watch", document: { blocks: [] } },
          }),
          inArea,
        );
        expect(inArea.statusCode).toBe(200);
        expect(inArea.body.document.section).toBe("watch");

        const outOfArea = makeRes();
        await handler(
          makeReq({
            body: { collection: "cmsPages", id: "support", document: { blocks: [] } },
          }),
          outOfArea,
        );
        expect(outOfArea.statusCode).toBe(403);
      });
    });

    it("still saves a page, whose desk is never client-supplied", async () => {
      // The create requirement is about records. A canonical page recomputes its desk from
      // the public page registry on every save, so it neither needs nor accepts one.
      const handler = createCmsSaveHandler({ firestore: db, requirePrincipalFn: adminOk });
      const res = makeRes();

      await handler(
        makeReq({
          body: { collection: "cmsPages", id: "watch", document: { blocks: [] } },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.document.section).toBe("watch");    });
  });
});

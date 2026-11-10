import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import preview from "../../functions/preview.js";
import previewSnapshot from "../../functions/lib/preview-snapshot.js";
import previewTarget from "../../functions/lib/preview-target.js";
import { electionBlock, electionRace } from "../fixtures/election-results.ts";
import renditionContract from "../../functions/lib/source-media-rendition.js";

const {
  createCmsPreviewHandler,
  createCmsPreviewStatusHandler,
  enqueuePreview,
  publicPreviewStatus,
  RENDERER_NOT_CONFIGURED_ERROR,
  SERIALIZER_NOT_READY_ERROR,
  INVALID_PREVIEW_TRANSPORT_ERROR,
  PREVIEW_TRANSPORT,
  PREVIEW_SERIALIZER_READY,
  PREVIEW_BUILD_TIMEOUT_MS,
  PREVIEW_BUILD_TIMEOUT_ERROR,
  EMULATOR_RENDERER_SHA,
} = preview;
const { createPreviewSnapshot, createPostPreviewSnapshot } = previewSnapshot;
const { sourceMediaRenditionOutputPrefix } = renditionContract;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

let db;

function previewActor({
  uid = "admin-1",
  email,
  role = "admin",
  sections,
} = {}) {
  return {
    uid,
    ...(email ? { email } : {}),
    principal: {
      id: uid,
      grants: [{ role, ...(sections ? { sections } : {}) }],
    },
  };
}

function page(overrides = {}) {
  return {
    title: "Contact NJ PBS",
    description: "Get in touch.",
    template: "genericPage",
    status: "in_review",
    blocks: [
      { id: "divider", type: "divider", order: 0, visible: true, data: {} },
    ],
    version: 7,
    updatedBy: "editor-1",
    updatedAt: admin.firestore.Timestamp.fromMillis(100),
    ...overrides,
  };
}

function makeReq({ method = "POST", body = {} } = {}) {
  return {
    method,
    body,
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    ip: "10.0.0.1",
  };
}

function makeRes() {
  const response = { statusCode: null, body: null, headersSent: false };
  response.headers = new Map();
  response.set = (name, value) => { response.headers.set(name, value); return response; };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    response.headersSent = true;
    return response;
  };
  return response;
}

function configuredPreviewPipeline() {
  return {
    getTransport: () => "serializer",
    serializerReady: true,
    getRendererSha: () => EMULATOR_RENDERER_SHA,
    assertBillingEnabledFn: async () => true,
  };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("preview.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe("CMS preview snapshot", () => {
  it("freezes custom and renamed page routes with their decorative hero media", () => {
    const id = `page-${"a".repeat(32)}`;
    const source = page({ slug: "community", previousSlugs: ["old-community"],
      heroBackgroundImage: "hero-background", heroBackgroundPosition: "top" });
    const snapshot = createPreviewSnapshot(id, source);
    source.slug = "later-draft";
    expect(previewTarget.previewTargetPath("cmsPages", id, snapshot)).toBe("/community/");
    expect(snapshot.previousSlugs).toEqual(["old-community"]);
    expect(snapshot.heroBackgroundPosition).toBe("top");
    expect(previewSnapshot.referencedPreviewAssetIds(snapshot)).toEqual(["hero-background"]);
    expect(previewTarget.previewTargetPath("cmsPages", "contact", snapshot)).toBe("/community/");
    expect(() => previewTarget.previewTargetPath("cmsPages", id, {})).toThrow(/saved route/);
  });

  it("copies only renderer-owned fields from one exact saved version", () => {
    const source = page({
      seo: { title: "Search title", noindex: false },
      social: { title: "Share title" },
    });
    const snapshot = createPreviewSnapshot("contact", source);

    expect(snapshot).toEqual({
      id: "contact",
      title: "Contact NJ PBS",
      description: "Get in touch.",
      seo: { title: "Search title", noindex: false },
      social: { title: "Share title" },
      template: "genericPage",
      blocks: [
        { id: "divider", type: "divider", order: 0, visible: true, data: {} },
      ],
      version: 7,
    });
    expect(snapshot).not.toHaveProperty("updatedBy");
    expect(snapshot).not.toHaveProperty("updatedAt");

    source.title = "Changed after capture";
    source.blocks[0].visible = false;
    expect(snapshot.title).toBe("Contact NJ PBS");
    expect(snapshot.blocks[0].visible).toBe(true);
  });

  it("uses a private preview title for an unfinished page", () => {
    expect(createPreviewSnapshot("contact", page({ title: " " })).title).toBe("Untitled page");
  });

  it.each([
    ["an archived page", { deleted: true }, /archived/],
    ["a page without a version", { version: undefined }, /saved version/],
    ["a page with malformed blocks", { blocks: [{ type: "divider" }] }, /blocks/],
    ["a page using the wrong template", { template: "home" }, /requires/],
  ])("refuses %s before dispatch", (_label, override, message) => {
    expect(() =>
      createPreviewSnapshot("contact", page(override)),
    ).toThrow(message);
  });
});

describe("CMS preview request", () => {
  const readyRuntime = { schemaVersion: 1, phase: "ready", rendererSha: EMULATOR_RENDERER_SHA, serializerId: "cloud-preview" };
  const cloudFields = { actor: previewActor(), pageId: "contact", persistent: true };
  const cloudDeps = () => ({ ...configuredPreviewPipeline(), firestore: db,
    getTransport: () => "serializer", serializerReady: true });

  it.each([1, 2])("previews incomplete election drafts with ready reader %s", async version => {
    const partial = electionRace({ office: "", sourceLabel: "", sourceUrl: "", asOf: "" });
    partial.candidates[0].votes = null; partial.candidates[0].share = null;
    await db.doc("system/cmsPreviewRuntime").set({ ...readyRuntime, electionResultsVersion: version });
    for (const data of [{ races: [] }, { races: [partial] }]) {
      await db.doc("cmsPages/contact").set(page({ blocks: [{ ...electionBlock(), data }] }));
      const result = await enqueuePreview({ ...cloudFields, persistent: false }, cloudDeps());
      expect((await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data().snapshot.blocks[0].data).toEqual(data);
    }
  });
  it.each([1, 2, 3])("requires the exact reader version for an incomplete expected-vote draft (%s)", async version => {
    const block = electionBlock(electionRace({ office: "", expectedVoteShare: 0 }));
    await db.doc("cmsPages/contact").set(page({ blocks: [block] }));
    await db.doc("system/cmsPreviewRuntime").set({ ...readyRuntime, electionResultsVersion: version });
    const result = enqueuePreview({ ...cloudFields, persistent: false }, cloudDeps());
    if (version === 2) {
      const row = await result;
      expect((await db.doc(`cmsPreviewQueue/${row.queueId}`).get()).data().snapshot.blocks[0]).toEqual(block);
    } else await expect(result).rejects.toMatchObject({ status: 503, code: "preview-renderer-updating" });
  });

  it.each([false, true])("sets cleanup only for expiring previews (persistent %s)", async persistent => {
    const requestedAt = Date.parse("2026-10-17T12:00:00Z");
    await db.doc("cmsPages/contact").set(page());
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const result = await enqueuePreview({ actor: previewActor(), pageId: "contact", persistent },
      { ...cloudDeps(), now: () => requestedAt });
    const row = (await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data();
    if (persistent) expect(row).not.toHaveProperty("purgeAt");
    else expect(row.purgeAt.toMillis()).toBe(requestedAt + 30 * 86400 * 1000);
    expect(row.expiresAt.toMillis()).toBe(requestedAt + 86400 * 1000);
  });

  it.each([undefined, ""])("defaults a missing or empty runtime transport (%s) to an audited serializer queue", async transport => {
    await db.doc("cmsPages/contact").set(page());
    const previous = process.env.CMS_PREVIEW_TRANSPORT;
    if (transport === undefined) delete process.env.CMS_PREVIEW_TRANSPORT;
    else process.env.CMS_PREVIEW_TRANSPORT = transport;
    const requests = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      requests.push(String(url));
      throw new Error("Preview admission must not contact GitHub");
    });
    try {
      const response = makeRes();
      await createCmsPreviewHandler({
        ...configuredPreviewPipeline(), firestore: db, getTransport: undefined,
        requirePrincipalFn: async () => cloudFields.actor,
        log: { error() {}, info() {} },
      })(makeReq({ body: { pageId: "contact" } }), response);
      expect(response.statusCode).toBe(202);
      expect(response.body).toMatchObject({ transport: "serializer", status: "pending", dispatched: false, sourceVersion: 7 });
      expect(requests).toEqual([]);
      const rows = await db.collection("cmsPreviewQueue").get();
      expect(rows.size).toBe(1);
      expect(rows.docs[0].data()).toMatchObject({ transport: "serializer", status: "pending", snapshot: { version: 7 } });
      expect((await db.collection("admin_logs").where("target", "==", response.body.queueId).get()).size).toBe(1);
    } finally {
      network.mockRestore();
      if (previous === undefined) delete process.env.CMS_PREVIEW_TRANSPORT;
      else process.env.CMS_PREVIEW_TRANSPORT = previous;
    }
  });

  it("rejects a configured GitHub transport before storing an HTTP request", async () => {
    await db.doc("cmsPages/contact").set(page());
    const response = makeRes();
    await createCmsPreviewHandler({
      ...configuredPreviewPipeline(), firestore: db, getTransport: () => "github",
      writebackConfigured: true, getToken: () => "legacy-token",
      fetchImpl: async () => ({ ok: true, status: 204 }),
      requirePrincipalFn: async () => cloudFields.actor,
      log: { error() {}, info() {} },
    })(makeReq({ body: { pageId: "contact" } }), response);
    expect(response.statusCode).toBe(503);
    expect(response.body.error).toBe(INVALID_PREVIEW_TRANSPORT_ERROR);
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("signals committed and reused unfinished serializer previews only", async () => {
    await db.doc("cmsPages/contact").set(page());
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const handler = createCmsPreviewHandler({ ...cloudDeps(),
      requirePrincipalFn: async () => cloudFields.actor, log: { error: vi.fn() } });
    const request = makeReq({ body: { pageId: "contact", sourceVersion: 7 } });
    const first = makeRes();
    await handler(request, first);
    expect(first.statusCode).toBe(202);
    expect(first.headers.get("x-njpbs-preview-wake")).toBe(EMULATOR_RENDERER_SHA);
    const queue = db.doc(`cmsPreviewQueue/${first.body.queueId}`);
    expect((await queue.get()).data().status).toBe("pending");
    for (const status of ["pending", "building", "ready"]) {
      await queue.update({ status });
      const retry = makeRes();
      await handler(request, retry);
      expect(retry.statusCode).toBe(202);
      expect(retry.body).toMatchObject({ queueId: first.body.queueId, reused: true, status });
      expect(retry.headers.get("x-njpbs-preview-wake")).toBe(status === "ready" ? undefined : EMULATOR_RENDERER_SHA);
    }
    const denied = makeRes();
    await createCmsPreviewHandler({ ...cloudDeps(),
      requirePrincipalFn: async () => { throw Object.assign(new Error("Denied"), { status: 403 }); },
      log: { error: vi.fn() } })(request, denied);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers.size).toBe(0);
  });

  it("accepts a Post preview from an editor without administrator access", async () => {
    await db.doc("cmsPosts/post-1").set({
      ...page(),
      type: "post",
      status: "draft",
      slug: "garden-state-update",
      previousSlugs: [],
      locale: "en",
      tags: [],
      section: "news",
      createdBy: "another-editor",
    });
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const requirePrincipalFn = vi.fn(async () => ({
      uid: "editor-1",
      email: "editor@example.test",
      principal: {
        id: "editor-1",
        grants: [{ role: "editor", sections: ["news"] }],
      },
    }));
    const handler = createCmsPreviewHandler({
      ...cloudDeps(),
      requirePrincipalFn,
      log: { error: vi.fn(), info: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      pageId: "post-1",
      sourceVersion: 7,
    } }), response);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      collection: "cmsPosts",
      pageId: "post-1",
      sourceVersion: 7,
    });
    expect(requirePrincipalFn).toHaveBeenCalledOnce();
  });

  it.each([
    ["cmsPages", "contact", "draft"],
    ["cmsPages", "contact", "in_review"],
    ["cmsPosts", "post-1", "draft"],
    ["cmsPosts", "post-1", "in_review"],
  ])("lets a Writer preview their own %s %s in %s and read both status paths", async (collection, pageId, status) => {
    await db.doc(`${collection}/${pageId}`).set({
      ...page(), type: "post", status, createdBy: "writer-1", section: "news",
      slug: "garden-state-update", previousSlugs: [], locale: "en", tags: [],
    });
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const deps = { ...cloudDeps(),
      requirePrincipalFn: async () => previewActor({ uid: "writer-1", role: "contributor" }),
      log: { error: vi.fn(), info: vi.fn() },
    };
    const response = makeRes();
    await createCmsPreviewHandler(deps)(makeReq({ body: { collection, pageId, sourceVersion: 7 } }), response);
    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ success: true, collection, pageId, sourceVersion: 7 });
    const job = (await db.doc(`cmsPreviewQueue/${response.body.queueId}`).get()).data();
    expect(job.requestedBy).toBe("writer-1");
    for (const body of [{ queueId: response.body.queueId }, { collection, pageId }]) {
      const statusResponse = makeRes();
      await createCmsPreviewStatusHandler(deps)(makeReq({ body }), statusResponse);
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.body.success).toBe(true);
    }
  });

  it("lets a News Editor preview their own Watch draft through their Writer grant", async () => {
    await db.doc("cmsPosts/post-1").set({ ...page(), type: "post", status: "draft",
      createdBy: "mixed-staff", section: "watch", slug: "watch-update", previousSlugs: [], locale: "en", tags: [] });
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const actor = { uid: "mixed-staff", principal: { id: "mixed-staff", grants: [
      { role: "editor", sections: ["news"] }, { role: "contributor", sections: ["watch"] },
    ] } };
    const response = makeRes();
    await createCmsPreviewHandler({ ...cloudDeps(), requirePrincipalFn: async () => actor,
      log: { error: vi.fn(), info: vi.fn() },
    })(makeReq({ body: { collection: "cmsPosts", pageId: "post-1", sourceVersion: 7 } }), response);
    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ success: true, pageId: "post-1" });
  });

  it("admits active staff across owners and areas while refusing absent records", async () => {
    await db.doc("cmsPosts/post-1").set({
      ...page(),
      type: "post",
      status: "draft",
      slug: "garden-state-update",
      previousSlugs: [],
      locale: "en",
      tags: [],
      section: "news",
      createdBy: "contributor-1",
    });
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);

    for (const principal of [
      { id: "other-writer", grants: [{ role: "contributor" }] },
      { id: "watch-editor", grants: [{ role: "editor", sections: ["watch"] }] },
    ]) {
      const handler = createCmsPreviewHandler({
        ...cloudDeps(),
        requirePrincipalFn: async () => ({ uid: principal.id, principal }),
        log: { error: vi.fn() },
      });
      const response = makeRes();
      await handler(makeReq({ body: {
        collection: "cmsPosts",
        pageId: "post-1",
        sourceVersion: 7,
      } }), response);
      expect(response.statusCode).toBe(202);
      const absent = makeRes();
      await handler(makeReq({ body: { collection: "cmsPosts", pageId: "missing-post", sourceVersion: 7 } }), absent);
      expect(absent.statusCode).toBe(409);
      expect(absent.body).toEqual({ error: "Page missing-post has not been saved yet" });
    }

    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("refuses an unsaved Post without creating preview work", async () => {
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const principal = {
      id: "news-editor",
      grants: [{ role: "editor", sections: ["news"] }],
    };
    const handler = createCmsPreviewHandler({
      ...cloudDeps(),
      requirePrincipalFn: async () => ({ uid: principal.id, principal }),
      log: { error: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: {
      collection: "cmsPosts",
      pageId: "missing-post",
      sourceVersion: 7,
    } }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "Page missing-post has not been saved yet",
    });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it.each([
    ["paused", { ...readyRuntime, phase: "paused" }],
    ["starting", { ...readyRuntime, phase: "starting" }],
    ["another renderer", { ...readyRuntime, rendererSha: "f".repeat(40) }],
    ["invalid schema", { ...readyRuntime, schemaVersion: 2 }],
    ["missing fields", {}],
    ["invalid serializer", { ...readyRuntime, serializerId: "invalid/path" }],
    ["non-string serializer", { ...readyRuntime, serializerId: 123 }],
    ["empty serializer", { ...readyRuntime, serializerId: "" }],
  ])("closes cloud admission for %s without any request mutations", async (_name, runtime) => {
    await db.doc("cmsPages/contact").set(page());
    await db.doc("system/cmsPreviewRuntime").set(runtime);
    const createSnapshot = vi.fn();
    await expect(enqueuePreview(cloudFields, { ...cloudDeps(), createSnapshot })).rejects.toMatchObject({
      status: 503, message: "Preview renderer is updating; try again shortly",
      code: "preview-renderer-updating",
    });
    expect(createSnapshot).not.toHaveBeenCalled();
    for (const collection of ["cmsPreviewQueue", "admin_logs", "cmsPreviewHeads"]) {
      expect((await db.collection(collection).get()).empty).toBe(true);
    }
  });

  it("projects the renderer-updating code through the HTTP boundary", async () => {
    await db.doc("cmsPages/contact").set(page());
    await db.doc("system/cmsPreviewRuntime").set({ ...readyRuntime, phase: "paused" });
    const handler = createCmsPreviewHandler({
      ...cloudDeps(),
      requirePrincipalFn: async () => cloudFields.actor,
      log: { error: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { pageId: "contact", sourceVersion: 7 } }), response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: "Preview renderer is updating; try again shortly",
      code: "preview-renderer-updating",
    });
  });

  it("admits the exact ready cloud runtime and reuses its ready preview while paused", async () => {
    await db.doc("cmsPages/contact").set(page());
    await db.doc("system/cmsPreviewRuntime").set(readyRuntime);
    const first = await enqueuePreview(cloudFields, cloudDeps());
    expect(first).toMatchObject({ status: "pending", dispatched: false });
    const previewUrl = `https://preview.njpbs.org/p/${first.queueId}/`;
    await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ status: "ready", previewUrl });
    const head = db.collection("cmsPreviewHeads").doc(previewTarget.previewContentKey("cmsPages", "contact"));
    await head.update({ readyQueueId: first.queueId });
    await db.doc("system/cmsPreviewRuntime").update({ phase: "paused" });
    const beforeHead = (await head.get()).data();
    expect(await enqueuePreview(cloudFields, cloudDeps())).toMatchObject({
      queueId: first.queueId, status: "ready", previewUrl, reused: true, dispatched: false,
    });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await head.get()).data()).toEqual(beforeHead);
  });

  // Real Firestore contention and retry backoff can exceed the default five seconds.
  it("deduplicates concurrent persistent requests and never dispatches them to GitHub", { timeout: 20_000 }, async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();
    const fields = { actor: previewActor(), pageId: "contact", persistent: true, automatic: true };
    const deps = { ...configuredPreviewPipeline(), firestore: db,
      getTransport: () => "serializer", serializerReady: true, fetchImpl,
      getToken: () => { throw new Error("GitHub must not be used"); } };
    const results = await Promise.all([enqueuePreview(fields, deps), enqueuePreview(fields, deps)]);
    expect(results[0].queueId).toBe(results[1].queueId);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(enqueuePreview(fields, { ...deps, getTransport: () => "github", getToken: () => "test" }))
      .rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the ready preview across saves and limits automatic replacements to five minutes", async () => {
    const started = Date.parse("2026-09-08T12:00:00Z");
    let time = started;
    await db.collection("cmsPages").doc("contact").set(page());
    const fields = { actor: previewActor(), pageId: "contact", persistent: true, automatic: true };
    const deps = { ...configuredPreviewPipeline(), firestore: db,
      getTransport: () => "serializer", serializerReady: true, now: () => time };
    const first = await enqueuePreview(fields, deps);
    const previewUrl = `https://preview.njpbs.org/p/${first.queueId}/`;
    await db.collection("cmsPreviewQueue").doc(first.queueId).update({ status: "ready", previewUrl });
    const head = db.collection("cmsPreviewHeads").doc(previewTarget.previewContentKey("cmsPages", "contact"));
    await head.update({ readyQueueId: first.queueId });
    await db.collection("cmsPages").doc("contact").update({ version: 8 });
    time += 60_000;
    expect(await enqueuePreview(fields, deps)).toMatchObject({ queueId: first.queueId, status: "ready", retryAfterMs: 240_000 });
    time += 240_000;
    const next = await enqueuePreview(fields, deps);
    expect(next.queueId).not.toBe(first.queueId);
    const res = makeRes();
    await createCmsPreviewStatusHandler({ firestore: db, requirePrincipalFn: async () => previewActor(), now: () => time })(
      makeReq({ body: { pageId: "contact", collection: "cmsPages" } }), res);
    expect(res.body).toMatchObject({ latest: { queueId: next.queueId, status: "pending" },
      ready: { queueId: first.queueId, previewUrl, persistent: true, expiresAt: new Date(started + 86400000).toISOString() } });
    time += 8 * 86_400_000;
    const retained = makeRes();
    await createCmsPreviewStatusHandler({ firestore: db, requirePrincipalFn: async () => previewActor(), now: () => time })(
      makeReq({ body: { queueId: first.queueId } }), retained);
    expect(retained.body).toMatchObject({ status: "expired", previewUrl: null, expiresAt: new Date(started + 86400000).toISOString() });
  });

  it("freezes a post draft and its private route without changing publication", async () => {
    const stored = { ...page(), type: "post", status: "draft", slug: "new-report", previousSlugs: [],
      locale: "en", tags: [], credits: [{ kind: "custom", name: "NJ PBS staff" }] };
    await db.collection("cmsPosts").doc("post-1").set(stored);
    const result = await enqueuePreview({ actor: previewActor(), collection: "cmsPosts",
      pageId: "post-1", persistent: true, automatic: true },
    { ...configuredPreviewPipeline(), firestore: db, getTransport: () => "serializer", serializerReady: true });
    const queue = (await db.collection("cmsPreviewQueue").doc(result.queueId).get()).data();
    expect(queue).toMatchObject({ collection: "cmsPosts", pagePath: "/posts/new-report/", sourceVersion: 7,
      snapshot: { id: "post-1", version: 7, published: { metadata: { title: stored.title,
        slug: "new-report", credits: stored.credits }, sourceVersion: 7 } } });
    expect((await db.collection("cmsPosts").doc("post-1").get()).data()).toEqual(stored);
  });

  it("previews unfinished blocks and uses a private route before a Post title exists", () => {
    const blocks = [{ id: "shelf", type: "promotion_playlist", order: 0, visible: true, data: { title: "", placement: "before_featured", cards: [] } }];
    const stored = { ...page(), type: "post", status: "draft", title: "", blocks, previousSlugs: [], locale: "en", tags: [] };
    const snapshot = createPostPreviewSnapshot("unfinished-post", stored);
    expect(snapshot.blocks).toEqual(blocks);
    expect(snapshot.published.metadata.title).toBe("Untitled post");
    expect(snapshot.published.metadata.slug).toMatch(/^draft-[a-f0-9]{24}$/);
    expect(stored).not.toHaveProperty("slug");
    expect(createPreviewSnapshot("contact", page({ blocks })).blocks).toEqual(blocks);
  });

  it("declares a serializer-default transport and a closed serializer gate", () => {
    expect(PREVIEW_TRANSPORT.toSpec()).toMatchObject({
      name: "CMS_PREVIEW_TRANSPORT",
      default: "serializer",
    });
    expect(PREVIEW_SERIALIZER_READY.toSpec()).toMatchObject({
      name: "CMS_PREVIEW_SERIALIZER_READY",
      default: "false",
    });
  });





  it("captures the saved page and audit transactionally without a dispatch", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
    });
    const logAdminActionFn = vi.fn().mockResolvedValue(undefined);

    const result = await enqueuePreview(
      {
        actor: previewActor({ email: "editor@example.com" }),
        pageId: "contact",
        source: "203.0.113.9",
      },
      {
        ...configuredPreviewPipeline(),
        firestore: db,
        getToken: () => "preview-token",
        fetchImpl,
        logAdminActionFn,
        now: () => Date.parse("2026-07-23T12:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      success: true,
      pageId: "contact",
      sourceVersion: 7,
      dispatched: false,
      status: "pending",
    });
    const queue = await db
      .collection("cmsPreviewQueue")
      .doc(result.queueId)
      .get();
    expect(queue.data()).toMatchObject({
      status: "pending",
      transport: "serializer",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: EMULATOR_RENDERER_SHA,
      requestedBy: "admin-1",
      assets: [],
      snapshot: {
        id: "contact",
        title: "Contact NJ PBS",
        version: 7,
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const audits = await db.collection("admin_logs").where("target", "==", result.queueId).get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0].data()).toMatchObject({
      action: "cms.preview.request", target: result.queueId, source: "203.0.113.9",
    });

    await db.collection("cmsPages").doc("contact").update({
      title: "A later save",
      version: 8,
    });
    const unchanged = await db
      .collection("cmsPreviewQueue")
      .doc(result.queueId)
      .get();
    expect(unchanged.data().snapshot).toMatchObject({
      title: "Contact NJ PBS",
      version: 7,
    });
  });

  it("fails closed when the page has not been saved", async () => {
    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getToken: () => "preview-token",
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("refuses the retired transport even when workflow writeback is not confirmed", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getTransport: () => "github",
          writebackConfigured: false,
          getToken: () => "preview-token",
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: INVALID_PREVIEW_TRANSPORT_ERROR,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("refuses an invalid transport before queue creation", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getTransport: () => "other",
          getToken: vi.fn(),
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: INVALID_PREVIEW_TRANSPORT_ERROR,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("refuses serializer work until its service is confirmed ready", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const getToken = vi.fn();
    const fetchImpl = vi.fn();

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getTransport: () => "serializer",
          serializerReady: false,
          writebackConfigured: false,
          getToken,
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: SERIALIZER_NOT_READY_ERROR,
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("atomically queues serializer work without GitHub readiness or dispatch", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const getToken = vi.fn(() => {
      throw new Error("GitHub token must not be read");
    });
    const fetchImpl = vi.fn();
    const logAdminActionFn = vi.fn(() => {
      throw new Error("standalone audit must not run");
    });

    const result = await enqueuePreview(
      {
        actor: previewActor({ email: "editor@example.com" }),
        pageId: "contact",
        source: "203.0.113.9",
      },
      {
        ...configuredPreviewPipeline(),
        firestore: db,
        getTransport: () => "serializer",
        serializerReady: true,
        writebackConfigured: false,
        getToken,
        fetchImpl,
        logAdminActionFn,
        now: () => Date.parse("2026-08-28T12:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      success: true,
      pageId: "contact",
      sourceVersion: 7,
      dispatched: false,
      status: "pending",
      transport: "serializer",
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logAdminActionFn).not.toHaveBeenCalled();
    expect(
      (await db.collection("cmsPreviewQueue").doc(result.queueId).get()).data(),
    ).toMatchObject({
      status: "pending",
      transport: "serializer",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: EMULATOR_RENDERER_SHA,
    });
    const audits = await db
      .collection("admin_logs")
      .where("target", "==", result.queueId)
      .get();
    expect(audits.size).toBe(1);
    expect(audits.docs[0].data()).toMatchObject({
      actorUid: "admin-1",
      action: "cms.preview.request",
      source: "203.0.113.9",
      after: {
        status: "pending",
        transport: "serializer",
        pageId: "contact",
        sourceVersion: 7,
      },
    });
  });

  it("does not expose a serializer queue when its audit cannot be created", async () => {
    await db.collection("cmsPages").doc("contact").set(page());

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getTransport: () => "serializer",
          serializerReady: true,
          adminLogEntryFn: () => {
            throw new Error("audit unavailable");
          },
        },
      ),
    ).rejects.toThrow(/audit unavailable/);
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("refuses before queue creation when the reviewed renderer revision is absent", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getRendererSha: () => "",
          getToken: () => "preview-token",
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: RENDERER_NOT_CONFIGURED_ERROR,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("refuses the retired transport even when the dispatch token is absent", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getTransport: () => "github",
          getToken: () => null,
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: INVALID_PREVIEW_TRANSPORT_ERROR,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("captures referenced public media with the saved page revision", async () => {
    await db.collection("cmsPages").doc("contact").set(
      page({
        social: { imageAssetId: "social-card" },
        blocks: [
          {
            id: "hero",
            type: "image",
            order: 0,
            visible: true,
            data: { assetId: "hero-image", alt: "Hero" },
          },
        ],
      }),
    );
    await Promise.all([
      db.collection("media_assets_public").doc("hero-image").set({
        url: "https://image.pbs.org/hero-v1.jpg",
        mimeType: "image/jpeg",
        width: 1200,
        height: 675,
        mutableInternalField: "not copied",
      }),
      db.collection("media_assets_public").doc("social-card").set({
        url: "https://image.pbs.org/social-v1.png",
        mimeType: "image/png",
      }),
    ]);

    const result = await enqueuePreview(
      {
        actor: previewActor(),
        pageId: "contact",
      },
      {
        ...configuredPreviewPipeline(),
        firestore: db,
        getToken: () => "preview-token",
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          status: 204,
          text: async () => "",
        }),
        logAdminActionFn: vi.fn().mockResolvedValue(undefined),
      },
    );

    await db.collection("media_assets_public").doc("hero-image").update({
      url: "https://image.pbs.org/hero-v2.jpg",
    });
    const queue = (
      await db.collection("cmsPreviewQueue").doc(result.queueId).get()
    ).data();
    expect(queue.assets).toEqual([
      {
        id: "hero-image",
        url: "https://image.pbs.org/hero-v1.jpg",
        mimeType: "image/jpeg",
        width: 1200,
        height: 675,
      },
      {
        id: "social-card",
        url: "https://image.pbs.org/social-v1.png",
        mimeType: "image/png",
      },
    ]);
  });

  // #2760: the stored preview carries only an existing public media.njpbs.org copy of
  // the current viewing copy. A never-published video stays without public data, and
  // no S3 or signed URL ever enters the row.
  // An active video-library item with a ready viewing copy, as cmsPublishSourceVideo reads it.
  const libraryVideo = (assetId, webVersionId) => {
    const asset = {
      sourceId: "video-library", lifecycle: "active", kind: "video", name: "Clip.mp4", originalName: "Clip.mp4",
      nameSort: "clip.mp4", updatedAtSort: "2026-09-14T16:00:00.000Z", mimeType: "video/mp4", sizeBytes: 8_000_000,
      preview: "browser", rightsStatus: "complete", tags: [], version: 1,
      objectKey: `objects/${assetId}.mp4`, objectVersionId: "original-v1",
    };
    const prefix = sourceMediaRenditionOutputPrefix({ id: assetId, ...asset }, "attempt-1");
    return { ...asset, rendition: {
      schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
      sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
      attemptId: "attempt-1", updatedAt: "2026-09-14T16:02:00.000Z",
      web: { objectKey: `${prefix}preview.mp4`, objectVersionId: webVersionId, sizeBytes: 2_000_000, mimeType: "video/mp4" },
      poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 24_000, mimeType: "image/jpeg" },
    } };
  };

  it("captures the current public video copy and nothing private", async () => {
    const hash = (n) => String(n).repeat(64);
    const media = {
      url: `https://media.njpbs.org/cms-media/video/vid-current/${hash(1)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/vid-current/${hash(2)}.jpg`,
      width: 1280,
      height: 720,
      mimeType: "video/mp4",
    };
    const video = (id, assetId, order) => ({
      id, type: "video", order, visible: true,
      data: { sourceId: "video-library", assetId, title: `Clip ${id}` },
    });
    await Promise.all([
      db.collection("cmsPages").doc("contact").set(page({
        blocks: [video("v1", "vid-current", 0), video("v2", "vid-unpublished", 1)],
      })),
      db.collection("cmsPublicVideos").doc("vid-current").set({
        schemaVersion: 1, sourceId: "video-library", assetId: "vid-current", webVersionId: "web-v3", media,
      }),
      db.collection("mediaSourceAssets").doc("vid-current").set(libraryVideo("vid-current", "web-v3")),
      db.collection("mediaSourceAssets").doc("vid-unpublished").set(libraryVideo("vid-unpublished", "web-v1")),
    ]);

    const result = await enqueuePreview(
      { actor: previewActor(), pageId: "contact" },
      {
        ...configuredPreviewPipeline(),
        firestore: db,
        getToken: () => "preview-token",
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" }),
        logAdminActionFn: vi.fn().mockResolvedValue(undefined),
      },
    );

    const queue = (await db.collection("cmsPreviewQueue").doc(result.queueId).get()).data();
    const [current, unpublished] = queue.snapshot.blocks;
    expect(current.data.public).toEqual(media);
    expect(unpublished.data).not.toHaveProperty("public");
    expect(JSON.stringify(queue)).not.toMatch(/amazonaws|X-Amz-|renditions\/|outputs\//);
    expect(queue.previewVideos).toEqual({ "vid-current": media.url, "vid-unpublished": null });
    expect((await db.collection("cmsPages").doc("contact").get()).data().blocks[0].data).not.toHaveProperty("public");
  });

  // A ready preview is reused only while it shows the video copies a new build would.
  it("rebuilds an unchanged draft when its video's public copy changes", async () => {
    await Promise.all([
      db.doc("system/cmsPreviewRuntime").set(readyRuntime),
      db.collection("cmsPages").doc("contact").set(page({
        blocks: [{ id: "v1", type: "video", order: 0, visible: true,
          data: { sourceId: "video-library", assetId: "vid-new", title: "Clip" } }],
      })),
      db.collection("mediaSourceAssets").doc("vid-new").set(libraryVideo("vid-new", "web-v1")),
    ]);
    const head = db.collection("cmsPreviewHeads").doc(previewTarget.previewContentKey("cmsPages", "contact"));
    const markReady = async (queueId) => {
      await db.doc(`cmsPreviewQueue/${queueId}`).update({ status: "ready", previewUrl: `https://preview.njpbs.org/p/${queueId}/` });
      await head.update({ readyQueueId: queueId });
    };
    const first = await enqueuePreview(cloudFields, cloudDeps());
    await markReady(first.queueId);
    expect(await enqueuePreview(cloudFields, cloudDeps())).toMatchObject({ queueId: first.queueId, reused: true });

    const media = {
      url: `https://media.njpbs.org/cms-media/video/vid-new/${"a".repeat(64)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/vid-new/${"b".repeat(64)}.jpg`,
      width: 1280, height: 720, mimeType: "video/mp4",
    };
    await db.collection("cmsPublicVideos").doc("vid-new").set({
      schemaVersion: 1, sourceId: "video-library", assetId: "vid-new", webVersionId: "web-v1", media,
    });
    const second = await enqueuePreview(cloudFields, cloudDeps());
    expect(second).toMatchObject({ status: "pending", dispatched: false });
    expect(second.queueId).not.toBe(first.queueId);
    const queue = (await db.doc(`cmsPreviewQueue/${second.queueId}`).get()).data();
    expect(queue.snapshot.blocks[0].data.public).toEqual(media);
  });

  it.each([
    ["GitHub refuses the dispatch", async () => ({ ok: false, status: 403, text: async () => "repository dispatch denied" })],
    ["the dispatch connection fails", async () => { throw new Error("connection reset"); }],
    ["a dispatch would succeed but its status update fails", async () => ({ ok: true, status: 204, text: async () => "" })],
  ])("keeps serializer admission independent when %s", async (_name, network) => {
    await db.doc("cmsPages/contact").set(page());
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(network);
    const result = await enqueuePreview({ actor: previewActor(), pageId: "contact" }, {
      ...configuredPreviewPipeline(), firestore: db, fetchImpl,
      getToken: () => "preview-token",
      markBuilding: async () => { throw new Error("write unavailable"); },
    });
    expect(result).toMatchObject({ success: true, dispatched: false, status: "pending", transport: "serializer" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await db.collection("cmsPreviewQueue").get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].data()).toMatchObject({ status: "pending", pageId: "contact", sourceVersion: 7, error: null });
    const audits = await db.collection("admin_logs").where("target", "==", result.queueId).get();
    expect(audits.size).toBe(1);
  });

  it("authenticates the HTTP boundary and returns an accepted request", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const handler = createCmsPreviewHandler({
      ...configuredPreviewPipeline(),
      requirePrincipalFn: vi.fn().mockResolvedValue({
        uid: "admin-1",
        email: "editor@example.com",
        principal: { id: "admin-1", grants: [{ role: "admin" }] },
      }),
      firestore: db,
      getToken: () => "preview-token",
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => "",
      }),
      logAdminActionFn: vi.fn().mockResolvedValue(undefined),
      log: { error: vi.fn(), info: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { pageId: "contact" } }), response);

    expect(response.statusCode).toBe(202);
    expect(response.headers.get("x-njpbs-preview-wake")).toBe(EMULATOR_RENDERER_SHA);
    expect(response.body).toMatchObject({
      success: true,
      pageId: "contact",
      status: "pending",
    });
  });

  it("refuses before queue creation when the billing kill switch is engaged", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const fetchImpl = vi.fn();
    const assertBillingEnabledFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("billing is disabled: budget threshold reached"), {
        code: "failed-precondition",
      }),
    );

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getToken: () => "preview-token",
          fetchImpl,
          assertBillingEnabledFn,
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: "billing is disabled: budget threshold reached",
    });
    expect(assertBillingEnabledFn).toHaveBeenCalledWith(db);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });

  it("preserves non-billing failures from the billing state read", async () => {
    await db.collection("cmsPages").doc("contact").set(page());
    const firestoreError = Object.assign(new Error("Firestore unavailable"), {
      code: "unavailable",
    });

    await expect(
      enqueuePreview(
        {
          actor: previewActor(),
          pageId: "contact",
        },
        {
          ...configuredPreviewPipeline(),
          firestore: db,
          getToken: () => "preview-token",
          assertBillingEnabledFn: vi.fn().mockRejectedValue(firestoreError),
        },
      ),
    ).rejects.toBe(firestoreError);
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
});

describe("CMS preview status", () => {
  beforeEach(async () => {
    await db.doc("cmsPages/contact").set(page());
  });

  it("returns an addressed Post preview status to an editor with record access", async () => {
    const requestedAt = admin.firestore.Timestamp.fromDate(
      new Date("2026-10-08T16:00:00.000Z"),
    );
    await db.doc("cmsPosts/post-1").set({
      ...page(),
      type: "post",
      status: "draft",
      section: "news",
      createdBy: "another-editor",
    });
    await db.doc("cmsPreviewQueue/queue123").set({
      status: "building",
      collection: "cmsPosts",
      pageId: "post-1",
      pagePath: "/posts/garden-state-update/",
      sourceVersion: 7,
      requestedAt,
      completedAt: null,
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2026-10-15T16:00:00.000Z"),
      ),
      previewUrl: null,
      error: null,
    });
    const requirePrincipalFn = vi.fn(async () => ({
      uid: "editor-1",
      principal: {
        id: "editor-1",
        grants: [{ role: "editor", sections: ["news"] }],
      },
    }));
    const handler = createCmsPreviewStatusHandler({
      requirePrincipalFn,
      firestore: db,
      now: () => Date.parse("2026-10-08T16:01:00.000Z"),
      log: { error: vi.fn(), warn: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { queueId: "queue123" } }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      queueId: "queue123",
      collection: "cmsPosts",
      pageId: "post-1",
      status: "building",
    });
    expect(requirePrincipalFn).toHaveBeenCalledOnce();
  });

  it.each([
    ["non-owner Writer", { id: "other-writer", grants: [{ role: "contributor" }] }],
    ["out-of-area editor", {
      id: "watch-editor",
      grants: [{ role: "editor", sections: ["watch"] }],
    }],
  ])("shares Post preview status with an active %s", async (_label, principal) => {
    await db.doc("cmsPosts/post-1").set({
      ...page(),
      type: "post",
      status: "draft",
      section: "news",
      createdBy: "owner-1",
    });
    await db.doc("cmsPreviewQueue/queue123").set({
      status: "building",
      collection: "cmsPosts",
      pageId: "post-1",
      sourceVersion: 7,
      requestedAt: admin.firestore.Timestamp.now(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

    for (const body of [
      { queueId: "queue123" },
      { collection: "cmsPosts", pageId: "post-1" },
    ]) {
      const response = makeRes();
      await createCmsPreviewStatusHandler({
        requirePrincipalFn: async () => ({ uid: principal.id, principal }),
        firestore: db,
        log: { error: vi.fn() },
      })(makeReq({ body }), response);
      expect(response.statusCode).toBe(200);
      const absent = makeRes();
      await createCmsPreviewStatusHandler({
        requirePrincipalFn: async () => ({ uid: principal.id, principal }),
        firestore: db, log: { error: vi.fn() },
      })(makeReq({ body: body.queueId
        ? { queueId: "missingqueue" }
        : { collection: "cmsPosts", pageId: "missing-post" } }), absent);
      expect(absent.statusCode).toBe(body.queueId ? 404 : 403);
      expect(absent.body).toEqual({ error: body.queueId ? "Preview request not found" : "You do not have permission to preview this record" });
    }
  });

  it.each([
    ["cmsPages", "contact", { deleted: true }],
    ["cmsPages", "contact", { status: "archived" }],
    ["cmsPosts", "post-1", { deleted: true }],
    ["cmsPosts", "post-1", { status: "archived" }],
  ])("hides ready previews after retiring %s %s with %j", async (collection, pageId, retired) => {
    await db.doc(`${collection}/${pageId}`).set({ ...page(), type: "post", section: "news", ...retired });
    await db.doc("cmsPreviewQueue/queue123").set({ status: "ready", collection, pageId,
      previewUrl: "https://preview.njpbs.org/p/queue123/", sourceVersion: 7,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60_000) });
    await db.doc(`cmsPreviewHeads/${previewTarget.previewContentKey(collection, pageId)}`)
      .set({ latestQueueId: "queue123", readyQueueId: "queue123" });
    const handler = createCmsPreviewStatusHandler({ firestore: db,
      requirePrincipalFn: async () => previewActor(), log: { error: vi.fn() } });
    for (const body of [{ queueId: "queue123" }, { collection, pageId }]) {
      const response = makeRes();
      await handler(makeReq({ body }), response);
      expect(response.statusCode).toBe(body.queueId ? 404 : 403);
      expect(response.body).toEqual({ error: body.queueId
        ? "Preview request not found" : "You do not have permission to preview this record" });
    }
  });

  it("settles a stranded build as failed when the workflow window elapses", async () => {
    const now = Date.parse("2026-07-23T13:00:00.000Z");
    const requestedAt = admin.firestore.Timestamp.fromMillis(
      now - PREVIEW_BUILD_TIMEOUT_MS,
    );
    const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date("2026-07-30T12:00:00.000Z"),
    );
    const queueRef = db.collection("cmsPreviewQueue").doc("queue123");
    await queueRef.set({
      status: "building",
      pageId: "contact",
      sourceVersion: 7,
      previewUrl: null,
      requestedAt,
      completedAt: null,
      expiresAt,
      error: null,
    });
    const handler = createCmsPreviewStatusHandler({
      requirePrincipalFn: vi.fn().mockResolvedValue(previewActor()),
      firestore: db,
      now: () => now,
      log: { error: vi.fn(), warn: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { queueId: "queue123" } }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      previewUrl: null,
      error: PREVIEW_BUILD_TIMEOUT_ERROR,
    });
    expect((await queueRef.get()).data()).toMatchObject({
      status: "failed",
      previewUrl: null,
      error: PREVIEW_BUILD_TIMEOUT_ERROR,
    });
    expect((await queueRef.get()).data().completedAt).toBeDefined();
  });

  it("never returns the captured content snapshot to the browser", async () => {
    const requestedAt = admin.firestore.Timestamp.fromDate(
      new Date("2026-07-23T12:00:00.000Z"),
    );
    const expiresAt = admin.firestore.Timestamp.fromDate(
      new Date("2026-07-30T12:00:00.000Z"),
    );
    await db.collection("cmsPreviewQueue").doc("queue123").set({
      status: "ready",
      pageId: "contact",
      sourceVersion: 7,
      previewUrl: "https://hash.njpbs-preview.pages.dev",
      requestedAt,
      completedAt: requestedAt,
      expiresAt,
      error: null,
      snapshot: page(),
    });
    const handler = createCmsPreviewStatusHandler({
      requirePrincipalFn: vi.fn().mockResolvedValue(previewActor()),
      firestore: db,
      now: () => Date.parse("2026-07-23T12:10:00.000Z"),
      log: { error: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { queueId: "queue123" } }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      queueId: "queue123",
      status: "ready",
      pageId: "contact",
      sourceVersion: 7,
      previewUrl: "https://hash.njpbs-preview.pages.dev",
      error: null,
      requestedAt: "2026-07-23T12:00:00.000Z",
      completedAt: "2026-07-23T12:00:00.000Z",
      expiresAt: "2026-07-24T12:00:00.000Z",
    });
    expect(response.body).not.toHaveProperty("snapshot");
  });

  it("derives expiry without leaking a stale URL", () => {
    expect(
      publicPreviewStatus(
        "queue123",
        {
          status: "ready",
          pageId: "contact",
          sourceVersion: 7,
          previewUrl: "https://hash.njpbs-preview.pages.dev",
          expiresAt: new Date("2026-07-23T12:00:00.000Z"),
        },
        Date.parse("2026-07-24T12:00:00.000Z"),
      ),
    ).toMatchObject({
      status: "expired",
      previewUrl: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["invalid", new Date("not-a-date")],
  ])("does not expose a ready URL with a %s expiry", (_label, expiresAt) => {
    expect(
      publicPreviewStatus(
        "queue123",
        {
          status: "ready",
          pageId: "contact",
          sourceVersion: 7,
          previewUrl: "https://hash.njpbs-preview.pages.dev",
          expiresAt,
        },
        Date.parse("2026-07-24T12:00:00.000Z"),
      ),
    ).toMatchObject({
      status: "expired",
      previewUrl: null,
      expiresAt: null,
    });
  });

  it.each(["", "../other", "queue/child", "space id"])(
    "rejects an unsafe queue id (%s)",
    async (queueId) => {
      const handler = createCmsPreviewStatusHandler({
        requirePrincipalFn: vi.fn().mockResolvedValue(previewActor()),
        firestore: db,
        log: { error: vi.fn() },
      });
      const response = makeRes();

      await handler(makeReq({ body: { queueId } }), response);

      expect(response.statusCode).toBe(400);
    },
  );

  it("does not read status until the caller is authenticated", async () => {
    const authError = Object.assign(new Error("Admin access required"), {
      status: 403,
    });
    const handler = createCmsPreviewStatusHandler({
      requirePrincipalFn: vi.fn().mockRejectedValue(authError),
      firestore: db,
      log: { error: vi.fn() },
    });
    const response = makeRes();

    await handler(makeReq({ body: { queueId: "queue123" } }), response);

    expect(response.statusCode).toBe(403);
  });
});

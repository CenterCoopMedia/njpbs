import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import preview from "../../functions/preview.js";
import targetContract from "../../functions/lib/preview-target.js";

const { enqueuePreview, createCmsPreviewHandler, createCmsPreviewStatusHandler } = preview;
const rendererSha = "a".repeat(40);
const PROJECT = "demo-njpbs";
const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
let db;
let now;
const actor = {
  uid: "admin-1",
  principal: { id: "admin-1", grants: [{ role: "admin" }] },
};
const fields = { actor, collection: "cmsPages", pageId: "contact", persistent: true, sourceVersion: 7 };
function page(overrides = {}) {
  return { title: "Acknowledged draft", description: "Exact draft.", template: "genericPage", status: "draft",
    blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }], version: 7, ...overrides };
}
function deps(overrides = {}) {
  return { firestore: db, getTransport: () => "serializer", serializerReady: true,
    getRendererSha: () => rendererSha, assertBillingEnabledFn: async () => true, now: () => now,
    requirePrincipalFn: async () => fields.actor, log: { error: vi.fn(), warn: vi.fn() }, ...overrides };
}
function req(body) { return { method: "POST", body, headers: {}, ip: null }; }
function res() {
  const response = { statusCode: null, body: null, headersSent: false };
  response.headers = new Map();
  response.set = (name, value) => { response.headers.set(name, value); return response; };
  response.status = status => { response.statusCode = status; return response; };
  response.json = body => { response.body = body; response.headersSent = true; return response; };
  return response;
}
async function ready(receipt) {
  await db.doc(`cmsPreviewQueue/${receipt.queueId}`).update({ status: "ready",
    previewUrl: `https://preview.njpbs.org/s/${receipt.queueId}/`, completedAt: admin.firestore.Timestamp.fromMillis(now) });
  await db.doc(`cmsPreviewHeads/${targetContract.previewContentKey("cmsPages", "contact")}`).update({ readyQueueId: receipt.queueId });
}
async function assertNoAcceptedWork() {
  for (const collection of ["cmsPreviewQueue", "admin_logs", "cmsPreviewHeads"]) {
    expect((await db.collection(collection).get()).empty).toBe(true);
  }
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("preview-exact.test.js");
});
beforeEach(async () => {
  now = Date.parse("2026-09-11T12:00:00Z");
  await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("cmsPages/contact").set(page());
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app?.delete())); });

describe("exact saved preview acceptance", () => {
  it.each([
    { persistent: true, sourceVersion: 7 },
    { persistent: false, sourceVersion: 7 },
    { persistent: true, automatic: true },
  ])("wakes reused unfinished jobs for %j", async options => {
    const handler = createCmsPreviewHandler(deps());
    const request = req({ pageId: "contact", ...options });
    const first = res();
    await handler(request, first);
    expect(first.statusCode).toBe(202);
    expect(first.headers.get("x-njpbs-preview-wake")).toBe(rendererSha);
    for (const status of ["pending", "building"]) {
      await db.doc(`cmsPreviewQueue/${first.body.queueId}`).update({ status });
      const retry = res();
      await handler(request, retry);
      expect(retry.body).toMatchObject({ queueId: first.body.queueId, reused: true, status });
      expect(retry.headers.get("x-njpbs-preview-wake")).toBe(rendererSha);
    }
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
  it("returns the exact Post identity and its frozen slug route", async () => {
    await db.doc("cmsPosts/post-1").set(page({ type: "post", slug: "new-report", previousSlugs: [],
      locale: "en", tags: [], credits: [{ kind: "custom", name: "NJ PBS staff" }] }));
    expect(await enqueuePreview({ ...fields, collection: "cmsPosts", pageId: "post-1" }, deps()))
      .toMatchObject({ collection: "cmsPosts", pageId: "post-1", sourceVersion: 7,
        rendererSha, pagePath: "/posts/new-report/", previewUrl: null, status: "pending" });
  });

  it("uses the saved custom Page route, not a guessed route from its ID", async () => {
    const pageId = `page-${"a".repeat(32)}`;
    await db.doc(`cmsPages/${pageId}`).set(page({ slug: "community" }));
    expect(await enqueuePreview({ ...fields, pageId }, deps()))
      .toMatchObject({ collection: "cmsPages", pageId, sourceVersion: 7, rendererSha, pagePath: "/community/" });
  });

  it("does not coerce a null version at the HTTP boundary into an unversioned request", async () => {
    const response = res();
    await createCmsPreviewHandler(deps())(req({ pageId: "contact", persistent: true, sourceVersion: null }), response);
    expect(response.statusCode).toBe(400);
    await assertNoAcceptedWork();
  });

  it("returns the complete accepted renderer and route receipt", async () => {
    const result = await enqueuePreview(fields, deps());
    expect(result).toMatchObject({ success: true, collection: "cmsPages", pageId: "contact",
      sourceVersion: 7, rendererSha, pagePath: "/contact/", previewUrl: null, status: "pending" });
    const queue = (await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data();
    expect(queue.snapshot.title).toBe("Acknowledged draft");
    await db.doc("cmsPages/contact").update({ version: 8, title: "Later work" });
    expect((await db.doc(`cmsPreviewQueue/${result.queueId}`).get()).data().snapshot).toEqual(queue.snapshot);
  });

  it.each([null, 0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1])("rejects an invalid exact version (%s) before billing or writes", async sourceVersion => {
    const billing = vi.fn();
    await expect(enqueuePreview({ ...fields, sourceVersion }, deps({ assertBillingEnabledFn: billing })))
      .rejects.toMatchObject({ status: 400 });
    expect(billing).not.toHaveBeenCalled();
    await assertNoAcceptedWork();
  });

  it.each([6, 8])("never captures version 7 for a request addressed to version %s", async sourceVersion => {
    await expect(enqueuePreview({ ...fields, sourceVersion }, deps()))
      .rejects.toMatchObject({ status: 409, code: "preview-version-unavailable" });
    await assertNoAcceptedWork();
  });

  it("makes repeated exact acceptance idempotent through the existing head transaction", async () => {
    const [first, second] = await Promise.all([enqueuePreview(fields, deps()), enqueuePreview(fields, deps())]);
    expect(second.queueId).toBe(first.queueId);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
    for (const result of [first, second]) expect(result).toMatchObject({ sourceVersion: 7, rendererSha, collection: "cmsPages", pagePath: "/contact/" });
  });

  it("reuses the exact frozen pending snapshot even after later edits reach storage", async () => {
    const first = await enqueuePreview(fields, deps());
    await db.doc("cmsPages/contact").update({ version: 8 });
    expect(await enqueuePreview(fields, deps())).toMatchObject({ queueId: first.queueId, sourceVersion: 7, rendererSha, reused: true });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });

  it.each(["pending", "building", "ready"])("does not return a ready artifact scheduled for replacement by an unsettled %s job", async status => {
    const first = await enqueuePreview(fields, deps());
    await ready(first);
    await db.doc("cmsPages/contact").update({ version: 8 });
    const next = await enqueuePreview({ ...fields, sourceVersion: 8 }, deps());
    await db.doc(`cmsPreviewQueue/${next.queueId}`).update({ status });
    // The renderer writes ready before it advances the retained head and cleans up.
    expect((await db.doc(`cmsPreviewHeads/${targetContract.previewContentKey("cmsPages", "contact")}`).get()).data().readyQueueId)
      .toBe(first.queueId);
    await expect(enqueuePreview(fields, deps())).rejects.toMatchObject({
      status: 409, code: "preview-version-unavailable",
    });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(2);
    expect((await db.collection("admin_logs").get()).size).toBe(2);
    expect((await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data().status).toBe("ready");
  });

  it("reuses exact retained output after a later save when no replacement is queued", async () => {
    const first = await enqueuePreview(fields, deps());
    await ready(first);
    await db.doc("cmsPages/contact").update({ version: 8 });
    expect(await enqueuePreview(fields, deps())).toMatchObject({ queueId: first.queueId, sourceVersion: 7,
      rendererSha, status: "ready", pagePath: "/contact/", reused: true });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });

  it("does not reconstruct missing exact content from the latest stored draft", async () => {
    const first = await enqueuePreview(fields, deps());
    await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ status: "failed" });
    await db.doc("cmsPages/contact").update({ version: 8 });
    await expect(enqueuePreview(fields, deps())).rejects.toMatchObject({ status: 409, code: "preview-version-unavailable" });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });

  it("keeps an older compatible running job as a blocker, then accepts the requested version", async () => {
    await db.doc("cmsPages/contact").update({ version: 6 });
    const older = await enqueuePreview({ ...fields, sourceVersion: 6 }, deps());
    await db.doc("cmsPages/contact").update({ version: 7 });
    expect(await enqueuePreview(fields, deps())).toMatchObject({ queueId: older.queueId, sourceVersion: 6, status: "pending", rendererSha, reused: true });
    await ready(older);
    const current = await enqueuePreview(fields, deps());
    expect(current).toMatchObject({ sourceVersion: 7, pagePath: "/contact/", status: "pending" });
    expect(current.queueId).not.toBe(older.queueId);
  });

  it("does not return an incompatible running renderer as the accepted exact preview", async () => {
    const oldRenderer = "b".repeat(40);
    await enqueuePreview(fields, deps({ getRendererSha: () => oldRenderer }));
    await expect(enqueuePreview(fields, deps())).rejects.toMatchObject({
      status: 503,
      code: "preview-renderer-updating",
    });
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });

  it("rebuilds exact content for the reviewed renderer instead of reusing a different release", async () => {
    const previous = await enqueuePreview(fields, deps({ getRendererSha: () => "b".repeat(40) }));
    await ready(previous);
    const current = await enqueuePreview(fields, deps());
    expect(current.queueId).not.toBe(previous.queueId);
    expect(current.rendererSha).toBe(rendererSha);
  });

  it("does not apply the automatic cooldown to an explicitly addressed version", async () => {
    const first = await enqueuePreview(fields, deps());
    await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ status: "failed" });
    now += 1_000;
    const exact = await enqueuePreview({ ...fields, automatic: true }, deps());
    expect(exact.queueId).not.toBe(first.queueId);
    expect(exact.status).toBe("pending");
  });

  it("preserves unversioned callers until the staff integration migrates them", async () => {
    const { sourceVersion: _, ...legacy } = fields;
    const result = await enqueuePreview(legacy, deps());
    expect(result.sourceVersion).toBe(7);
  });

  it("still refuses archived content even when an exact retained artifact exists", async () => {
    const first = await enqueuePreview(fields, deps());
    await ready(first);
    await db.doc("cmsPages/contact").update({ status: "archived" });
    await expect(enqueuePreview(fields, deps())).rejects.toMatchObject({ status: 409 });
  });

  it("passes the exact version through the authenticated HTTP boundary", async () => {
    const response = res();
    await createCmsPreviewHandler(deps())(req({ pageId: "contact", persistent: true, sourceVersion: 6 }), response);
    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("preview-version-unavailable");
    await assertNoAcceptedWork();
  });

  it("keeps unauthorized requests outside snapshot acceptance", async () => {
    const response = res();
    const billing = vi.fn();
    await createCmsPreviewHandler(deps({ assertBillingEnabledFn: billing, requirePrincipalFn: async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    } }))(req({ ...fields }), response);
    expect(response.statusCode).toBe(401);
    expect(billing).not.toHaveBeenCalled();
    await assertNoAcceptedWork();
  });

  it("returns addressed renderer and frozen route metadata without content or assets", async () => {
    const first = await enqueuePreview(fields, deps());
    await ready(first);
    await db.doc("cmsPages/contact").update({ version: 8, slug: "contact-updated" });
    const response = res();
    await createCmsPreviewStatusHandler(deps())(req({ queueId: first.queueId }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ queueId: first.queueId, sourceVersion: 7, rendererSha,
      collection: "cmsPages", pagePath: "/contact/", status: "ready" });
    expect(response.body).not.toHaveProperty("snapshot");
    expect(response.body).not.toHaveProperty("assets");
  });
});

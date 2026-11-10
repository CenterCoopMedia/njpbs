import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import preview from "../../functions/preview.js";
import contract from "../../functions/lib/preview-target.js";
const { enqueuePreview, createCmsPreviewStatusHandler } = preview;
const rendererSha = "a".repeat(40);
const now = Date.parse("2026-09-11T16:00:00Z");
const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
let db;
const page = (version = 7) => ({ title: `Draft ${version}`, description: "Private draft", version,
  template: "genericPage", status: "draft", blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }] });
const input = { actor: {
  uid: "staff",
  principal: { id: "staff", grants: [{ role: "admin" }] },
}, collection: "cmsPages", pageId: "contact", persistent: false, sourceVersion: 7 };
const deps = () => ({ firestore: db, getTransport: () => "serializer", serializerReady: true,
  getRendererSha: () => rendererSha, now: () => now, assertBillingEnabledFn: async () => true,
  requirePrincipalFn: async () => input.actor, log: { error: vi.fn() } });
async function accept(fields = {}) { return enqueuePreview({ ...input, ...fields }, deps()); }
async function markReady(queueId) {
  await db.doc(`cmsPreviewQueue/${queueId}`).update({ status: "ready", previewUrl: `https://preview.njpbs.org/p/${queueId}/` });
}
async function history(after, fields = {}) {
  await db.collection("cmsVersionHistory").add({ collection: "cmsPages", documentId: "contact", after, ...fields });
}
// Observe the real emulator transaction; reads and writes still use Firestore.
function observeTransactionReads() {
  const reads = [];
  const batches = [];
  return { reads, batches, firestore: {
    collection: db.collection.bind(db), doc: db.doc.bind(db),
    runTransaction: callback => db.runTransaction(transaction => {
      const get = transaction.get.bind(transaction);
      const getAll = transaction.getAll.bind(transaction);
      transaction.get = target => { reads.push(target.path); return get(target); };
      transaction.getAll = (...refs) => {
        batches.push(refs.map(ref => ref.path));
        return getAll(...refs);
      };
      return callback(transaction);
    }),
  } };
}
async function mediaPage(count) {
  const images = Array.from({ length: count }, (_, index) => ({
    assetId: `asset-${String(index).padStart(2, "0")}`, alt: "Fixture image",
  }));
  const blocks = images.map((image, index) => ({
    id: `image-${index}`, type: "image", order: index, visible: true, data: image,
  }));
  await db.doc("cmsPages/contact").set({ ...page(), blocks });
  const write = db.batch();
  for (const image of images) write.set(db.doc(`media_assets_public/${image.assetId}`), {
    url: `https://image.pbs.org/${image.assetId}.jpg`, mimeType: "image/jpeg",
  });
  await write.commit();
}

beforeAll(() => { if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" }); db = isolatedFirestore("preview-interactive.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("cmsPages/contact").set(page());
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });
describe("interactive immutable previews", () => {
  it("returns a real listener update after one admission read without polling", async () => {
    const accepted = await accept();
    const ref = db.doc(`cmsPreviewQueue/${accepted.queueId}`);
    let observedInitial;
    const initial = new Promise(resolve => { observedInitial = resolve; });
    const unsubscribe = vi.fn();
    const observedRef = { onSnapshot(next, error) {
      const stop = ref.onSnapshot(snapshot => { next(snapshot); observedInitial(); }, error);
      return () => { unsubscribe(); stop(); };
    }, get: vi.fn(() => ref.get()) };
    const auth = vi.fn(async () => input.actor);
    const res = { headersSent: false, status: vi.fn(function () { return this; }),
      json: vi.fn(function () { this.headersSent = true; return this; }) };
    const handler = createCmsPreviewStatusHandler({ ...deps(), requirePrincipalFn: auth,
      firestore: {
        collection: name => name === "cmsPreviewQueue"
          ? { doc: () => observedRef }
          : db.collection(name),
      } });
    const response = handler({ method: "POST", body: { queueId: accepted.queueId, waitMs: 5000, observedStatus: "pending" } }, res);
    await initial;
    expect(res.json).not.toHaveBeenCalled();
    await ref.update({ status: "building" });
    await response;
    expect(res.json.mock.calls[0][0]).toMatchObject({ queueId: accepted.queueId, status: "building", sourceVersion: 7 });
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("snapshot");
    expect(auth).toHaveBeenCalledTimes(2);
    expect(observedRef.get).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing current document after reading both admission locks without writes", async () => {
    await db.doc("cmsPages/contact").delete();
    const observed = observeTransactionReads();
    await expect(enqueuePreview(input, { ...deps(), firestore: observed.firestore }))
      .rejects.toMatchObject({ status: 409, message: "Page contact has not been saved yet" });
    expect(observed.batches).toEqual([["cmsPages/contact",
      `cmsPreviewHeads/${contract.previewContentKey("cmsPages", "contact")}`]]);
    expect(observed.reads).toEqual([]);
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
    expect((await db.collection("cmsPreviewHeads").get()).empty).toBe(true);
  });

  it.each([false, true])("keeps head serialization and reads retained outputs only for persistent=%s", async persistent => {
    const first = await accept({ persistent: true });
    await markReady(first.queueId);
    const headRef = db.doc(`cmsPreviewHeads/${contract.previewContentKey("cmsPages", "contact")}`);
    await headRef.update({ readyQueueId: first.queueId });
    await db.doc("cmsPages/contact").set(page(8));
    const latest = await accept({ persistent: true, sourceVersion: 8 });
    const observed = observeTransactionReads();
    const result = await enqueuePreview({ ...input, persistent, sourceVersion: 8 },
      { ...deps(), firestore: observed.firestore });
    expect([...observed.reads, ...observed.batches.flat()]).toContain(headRef.path);
    if (persistent) {
      expect(observed.batches).toEqual([]);
      expect(observed.reads).toContain("cmsPages/contact");
    } else {
      expect(observed.batches).toEqual([["cmsPages/contact", headRef.path]]);
      expect(observed.reads).not.toContain("cmsPages/contact");
      expect(observed.reads).not.toContain(headRef.path);
    }
    for (const queueId of [first.queueId, latest.queueId]) {
      expect(observed.reads.includes(`cmsPreviewQueue/${queueId}`)).toBe(persistent);
    }
    if (persistent) expect(result.queueId).toBe(latest.queueId);
    else {
      expect(result.queueId).not.toBe(latest.queueId);
      expect((await accept({ sourceVersion: 8 })).queueId).toBe(result.queueId);
      expect((await headRef.get()).data()).toMatchObject({ latestQueueId: latest.queueId,
        readyQueueId: first.queueId, exactQueueId: result.queueId });
    }
  });
  it("freezes all media through bounded reads in the admission transaction", async () => {
    await mediaPage(21);
    const observed = observeTransactionReads();
    const receipt = await enqueuePreview(input, { ...deps(), firestore: observed.firestore });
    const assetBatches = observed.batches.filter(batch => batch[0].startsWith("media_assets_public/"));
    expect(assetBatches.map(batch => batch.length)).toEqual([20, 1]);
    expect(observed.reads.some(path => path?.startsWith("media_assets_public/"))).toBe(false);
    const queue = (await db.doc(`cmsPreviewQueue/${receipt.queueId}`).get()).data();
    expect(queue.assets).toHaveLength(21);
    expect(queue.assets.map(asset => asset.id)).toEqual(
      assetBatches.flat().map(path => path.split("/")[1]));
    await db.doc("media_assets_public/asset-20").update({ url: "https://image.pbs.org/later.jpg" });
    expect((await db.doc(`cmsPreviewQueue/${receipt.queueId}`).get()).data().assets.at(-1).url)
      .toBe("https://image.pbs.org/asset-20.jpg");
  });
  it.each(["missing", "invalid"])("rejects a %s asset in a later batch without accepted work", async kind => {
    await mediaPage(21);
    const asset = db.doc("media_assets_public/asset-20");
    if (kind === "missing") await asset.delete();
    else await asset.update({ mimeType: "application/javascript" });
    await expect(accept()).rejects.toMatchObject({ status: 409,
      message: kind === "missing" ? "Media asset asset-20 is missing" : "Media asset asset-20 is not an image" });
    for (const collection of ["cmsPreviewQueue", "cmsPreviewHeads", "admin_logs"]) {
      expect((await db.collection(collection).get()).empty).toBe(true);
    }
  });
  it("refuses exact requests on the legacy GitHub transport before queue creation", async () => {
    const dispatch = vi.fn();
    const getRendererSha = vi.fn(() => rendererSha);
    const getToken = vi.fn(() => "fixture-token");
    const assertBillingEnabledFn = vi.fn(async () => true);
    await expect(enqueuePreview(input, { ...deps(), getTransport: () => "github",
      writebackConfigured: true, getRendererSha, getToken, assertBillingEnabledFn, fetchImpl: dispatch,
    })).rejects.toMatchObject({ status: 503, message: "Preview pipeline is not configured: preview transport is invalid" });
    expect(getRendererSha).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(assertBillingEnabledFn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("returns a complete expiring receipt without entering retained-export cleanup", async () => {
    const receipt = await accept();
    expect(receipt).toMatchObject({ collection: "cmsPages", pagePath: "/contact/", sourceVersion: 7, rendererSha, previewUrl: null });
    const queued = (await db.doc(`cmsPreviewQueue/${receipt.queueId}`).get()).data();
    expect(queued.persistent).not.toBe(true);
    expect(queued.expiresAt.toMillis()).toBe(now + 86400000);
    expect(queued.snapshot.title).toBe("Draft 7");
    const head = (await db.doc(`cmsPreviewHeads/${contract.previewContentKey("cmsPages", "contact")}`).get()).data();
    expect(head.exactQueueId).toBe(receipt.queueId);
    expect(head.latestQueueId).toBeUndefined();
  });
  it("coalesces simultaneous exact requests through the existing transaction", { timeout: 20_000 }, async () => {
    const [first, second] = await Promise.all([accept(), accept()]);
    expect(first.queueId).toBe(second.queueId);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
  });
  it("reuses exact acceptance after another version displaces the content head", async () => {
    const first = await accept();
    await history(page(7));
    await db.doc("cmsPages/contact").set(page(8));
    const second = await accept({ sourceVersion: 8 });
    expect(second.queueId).not.toBe(first.queueId);
    expect((await accept()).queueId).toBe(first.queueId);
    expect((await accept({ sourceVersion: 8 })).queueId).toBe(second.queueId);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(2);
  });
  it("uses the next save full before-state when a scheduled failure has only an after receipt", async () => {
    await history({ id: "contact", version: 7, status: "approved", contentVersion: 6,
      scheduledPublishFailure: { reason: "Missing media" } }, { restorable: false });
    await history(page(8), { before: { ...page(7), status: "approved" } });
    await db.doc("cmsPages/contact").set(page(8));
    const receipt = await accept();
    expect((await db.doc(`cmsPreviewQueue/${receipt.queueId}`).get()).data().snapshot.title).toBe("Draft 7");
    expect((await db.doc("cmsPages/contact").get()).data().version).toBe(8);
  });
  it("reports an unavailable version when only a bounded history receipt remains", async () => {
    await history({ id: "contact", version: 7, status: "approved" }, { restorable: false });
    await db.doc("cmsPages/contact").set(page(8));
    await expect(accept()).rejects.toMatchObject({ code: "preview-version-unavailable" });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("reuses a ready immutable artifact without extending or replacing its lifetime", async () => {
    const first = await accept(); await markReady(first.queueId);
    const second = await accept();
    expect(second).toMatchObject({ queueId: first.queueId, reused: true, status: "ready", previewUrl: `https://preview.njpbs.org/p/${first.queueId}/` });
  });
  it("does not return an artifact at the edge of expiry", async () => {
    const first = await accept(); await markReady(first.queueId);
    await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ expiresAt: admin.firestore.Timestamp.fromMillis(now + 1000) });
    expect((await accept()).queueId).not.toBe(first.queueId);
  });
  // Real Firestore contention and retry backoff can exceed the default five seconds.
  it.each(["failed", "expired", "timed-out"])("reuses a replacement after a %s attempt, even at the same clock time", { timeout: 20_000 }, async failure => {
    const first = await accept();
    const update = failure === "expired" ? { expiresAt: admin.firestore.Timestamp.fromMillis(now) }
      : failure === "timed-out" ? { requestedAt: admin.firestore.Timestamp.fromMillis(now - 46 * 60000) }
      : { status: "failed", error: "Build failed" };
    await db.doc(`cmsPreviewQueue/${first.queueId}`).update(update);
    const [second, duplicate] = await Promise.all([accept(), accept()]);
    expect(second.queueId).not.toBe(first.queueId);
    expect(duplicate.queueId).toBe(second.queueId);
    expect((await accept()).queueId).toBe(second.queueId);
    expect((await db.collection("cmsPreviewQueue").get()).size).toBe(2);
  });
  it.each(["missing", "truncated", "ambiguous", "other-document"])("refuses %s before-state recovery", async kind => {
    await history({ version: 7, status: "approved" }, { restorable: false });
    if (kind !== "missing") {
      const before = kind === "truncated" ? { version: 7, beforeTruncated: true } : page(7);
      await history(page(8), { before, ...(kind === "other-document" ? { documentId: "about" } : {}) });
      if (kind === "ambiguous") await history(page(9), { before: page(7) });
    }
    await db.doc("cmsPages/contact").set(page(9));
    await expect(accept()).rejects.toMatchObject({ code: "preview-version-unavailable" });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("keeps the earlier exact output addressable while a newer version is queued", async () => {
    const first = await accept(); await markReady(first.queueId);
    await db.doc("cmsPages/contact").set(page(8));
    const second = await accept({ sourceVersion: 8 });
    expect(second.queueId).not.toBe(first.queueId);
    const response = { code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await createCmsPreviewStatusHandler(deps())({ method: "POST", body: { queueId: first.queueId } }, response);
    expect(response.body).toMatchObject({ queueId: first.queueId, sourceVersion: 7, status: "ready", previewUrl: `https://preview.njpbs.org/p/${first.queueId}/` });
  });
  it("captures the acknowledged historical after-state if a later save wins the handoff", async () => {
    await history(page(7)); await db.doc("cmsPages/contact").set(page(8));
    const receipt = await accept();
    const queued = (await db.doc(`cmsPreviewQueue/${receipt.queueId}`).get()).data();
    expect(queued.sourceVersion).toBe(7);
    expect(queued.snapshot.title).toBe("Draft 7");
    expect((await db.doc("cmsPages/contact").get()).data().version).toBe(8);
  });
  it.each([
    { collection: "cmsPosts" }, { documentId: "about" }, { after: page(6) },
  ])("cannot borrow another history identity (%j)", async altered => {
    await history(page(7), altered); await db.doc("cmsPages/contact").set(page(8));
    await expect(accept()).rejects.toMatchObject({ code: "preview-version-unavailable" });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("refuses ambiguous historical versions instead of choosing arbitrary content", async () => {
    await history(page(7)); await history({ ...page(7), title: "Different history" });
    await db.doc("cmsPages/contact").set(page(8));
    await expect(accept()).rejects.toMatchObject({ code: "preview-version-unavailable" });
    expect((await db.collection("cmsPreviewQueue").get()).empty).toBe(true);
  });
  it("still rejects archived current content even with a valid historical draft", async () => {
    await history(page(7)); await db.doc("cmsPages/contact").set({ ...page(8), status: "archived" });
    await expect(accept()).rejects.toMatchObject({ status: 409 });
  });
  it("does not reuse the independently retained background export", async () => {
    const retained = await enqueuePreview({ ...input, persistent: true }, deps());
    const exact = await accept();
    expect(exact.queueId).not.toBe(retained.queueId);
    const head = (await db.doc(`cmsPreviewHeads/${contract.previewContentKey("cmsPages", "contact")}`).get()).data();
    expect(head).toMatchObject({ latestQueueId: retained.queueId, exactQueueId: exact.queueId });
  });
  it.each(["after", "before"])("accepts a Post's saved historical slug from a full %s-state", async side => {
    const post = { ...page(7), type: "post", slug: "original", previousSlugs: [], locale: "en", tags: [], credits: [{ kind: "custom", name: "Staff" }] };
    await db.doc("cmsPosts/story").set({ ...post, version: 8, slug: "new-slug" });
    await history(side === "after" ? post : { ...post, version: 8, slug: "new-slug" }, {
      collection: "cmsPosts", documentId: "story", ...(side === "before" ? { before: post } : {}),
    });
    expect(await accept({ collection: "cmsPosts", pageId: "story" })).toMatchObject({ collection: "cmsPosts", sourceVersion: 7, pagePath: "/posts/original/" });
  });
  it.each(["program", "event"].flatMap(type => ["after", "before"].map(side => ({ type, side }))))(
    "recovers a blockless $type saved version from its full $side-state", async ({ type, side }) => {
      const saved = { type, title: "Original structured record", slug: "original", status: "draft", version: 7,
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved details" }] }] },
        ...(type === "event" ? { startsAt: "2026-10-13T18:00:00Z" } : {}) };
      const current = { ...saved, title: "Changed record", slug: "changed", version: 8 };
      await db.doc("cmsPosts/structured").set(current);
      await history(side === "after" ? saved : current, { collection: "cmsPosts", documentId: "structured",
        ...(side === "before" ? { before: saved } : {}) });
      const accepted = await accept({ collection: "cmsPosts", pageId: "structured" });
      expect(accepted).toMatchObject({ sourceVersion: 7, pagePath: `/${type === "program" ? "programs" : "events"}/original/` });
      const queued = (await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data();
      expect(queued.snapshot.published.metadata).toMatchObject({ type, title: saved.title, description: saved.description });
    },
  );
  it.each(["program", "event"].flatMap(type => ["after", "before"].map(side => ({ type, side }))))(
    "refuses a bounded $type $side-state even if it names the record type", async ({ type, side }) => {
      const current = { type, title: "Changed", slug: "changed", status: "draft", version: 8 };
      const receipt = { type, version: 7, status: "draft", ...(side === "before" ? { beforeTruncated: true } : {}) };
      await db.doc("cmsPosts/structured").set(current);
      await history(side === "after" ? receipt : current, { collection: "cmsPosts", documentId: "structured",
        ...(side === "before" ? { before: receipt } : { restorable: false }) });
      await expect(accept({ collection: "cmsPosts", pageId: "structured" })).rejects.toMatchObject({ code: "preview-version-unavailable" });
    },
  );
});

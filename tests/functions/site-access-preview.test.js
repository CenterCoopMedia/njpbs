import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import { createSiteAccessHandler } from "../../functions/site-access.js";
import { previewContentKey } from "../../functions/lib/preview-target.js";
import { serveStaffSite } from "../../workers/src/staff-site-worker";

const PROJECT = "demo-njpbs";
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const queueId = "AbCdEfGhIjKlMnOpQrSt";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const target = { schemaVersion: 1, queueId, persistent: false };
let db;
let reads;
let readBytes;
let handler;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(HOST ?? "")) throw new Error("A local Firestore emulator is required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("site-access-preview.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  const batch = db.batch();
  batch.set(db.doc("users/writer"), { active: true, email: "writer@example.test", grants: [{ role: "contributor", sections: ["news"] }] });
  batch.set(db.doc("users/editor"), { active: true, email: "editor@example.test", grants: [{ role: "editor", sections: ["news"] }] });
  batch.set(db.doc("cmsPosts/story"), { createdBy: "writer", section: "news", status: "draft" });
  batch.set(db.doc(`cmsPreviewQueue/${queueId}`), { collection: "cmsPosts", pageId: "story", status: "ready", expiresAt: admin.firestore.Timestamp.fromMillis(NOW + 60_000) });
  await batch.commit();
  reads = [];
  readBytes = [];
  const measured = snapshot => {
    reads.push(snapshot.ref.path);
    readBytes.push(snapshot.exists ? Buffer.byteLength(JSON.stringify(snapshot.data()), "utf8") : 0);
    return snapshot;
  };
  const firestore = {
    collection: name => ({ doc: id => ({ path: `${name}/${id}`,
      get: async () => measured(await db.collection(name).doc(id).get()),
    }) }),
    getAll: async (ref, options) => (await db.getAll(db.doc(ref.path), options)).map(measured),
  };
  handler = createSiteAccessHandler({ firestore, now: () => NOW,
    verify: async authorization => {
      const uid = authorization.slice(7);
      return { uid, email: `${uid}@example.test`, emailVerified: true };
    },
  });
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });
async function admission(uid = "writer", preview = target, claims = {}) {
  const res = { code: null, headers: {}, set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.code = code; return this; }, end() {} };
  await handler({ method: "POST", headers: { authorization: `Bearer ${uid}` }, body: preview ? { ...claims, preview } : claims }, res);
  return res;
}

describe("preview access with stored emulator records", () => {
  it("keeps staff access across ownership changes and revokes account and lifecycle changes on existing artifacts", async () => {
    expect((await admission()).code).toBe(204);
    await db.doc("cmsPosts/story").update({ createdBy: "other" });
    expect((await admission()).code).toBe(204);
    await db.doc("cmsPosts/story").update({ status: "submitted", type: "event", unassignedDraft: false });
    expect((await admission()).code).toBe(204);
    await db.doc("cmsPosts/story").update({ createdBy: "writer", status: "submitted" });
    expect((await admission()).code).toBe(204);
    await db.doc("users/writer").update({ active: false });
    expect((await admission()).code).toBe(404);
    await db.doc("users/writer").update({ active: true });
    await db.doc("cmsPosts/story").update({ status: "archived" });
    expect((await admission()).code).toBe(404);
    await db.doc("cmsPosts/story").delete();
    expect((await admission()).code).toBe(404);
  });
  it("keeps cross-area staff access and denies deleted records without changing frozen queue identity", async () => {
    expect((await admission("editor")).code).toBe(204);
    await db.doc("cmsPosts/story").update({ section: "watch" });
    expect((await admission("editor")).code).toBe(204);
    expect((await admission("editor", target, { ownerId: "writer", section: "news" })).code).toBe(204);
    await db.doc("users/editor").update({ grants: [{ role: "editor", sections: ["watch"] }] });
    expect((await admission("editor")).code).toBe(204);
    await db.doc("cmsPosts/story").update({ deleted: true });
    expect((await admission("editor")).code).toBe(404);
  });
  it("expires ordinary and retained output despite a current ready head", async () => {
    await db.doc(`cmsPreviewQueue/${queueId}`).update({ expiresAt: admin.firestore.Timestamp.fromMillis(NOW - 1) });
    expect((await admission()).code).toBe(404);
    await db.doc(`cmsPreviewQueue/${queueId}`).update({ persistent: true });
    const retained = { ...target, persistent: true };
    expect((await admission("writer", retained)).code).toBe(404);
    const head = db.doc(`cmsPreviewHeads/${previewContentKey("cmsPosts", "story")}`);
    await head.set({ readyQueueId: queueId });
    expect((await admission("writer", retained)).code).toBe(404);
    await head.update({ readyQueueId: "different" });
    expect((await admission("writer", retained)).code).toBe(404);
  });
  it.each([
    [{}, 204, 3], [{ published: {} }, 204, 3], [{ published: null }, 204, 3],
    [{ status: "archived" }, 404, 3], [{ deleted: true }, 404, 3],
  ])("checks the current unassigned Post lifecycle %j", async (change, code, count) => {
    await db.doc("cmsPosts/story").set({ type: "post", status: "draft", createdBy: "writer",
      unassignedDraft: true, ...change });
    expect((await admission()).code).toBe(code);
    expect(reads).toHaveLength(count);
    expect((await admission()).code).toBe(code);
    expect(reads).toHaveLength(2 * count);
  });
  it("measures the uncached read count at the gateway/Function boundary", async () => {
    const blocks = Array.from({ length: 24 }, (_, i) => ({ id: `block-${i}`, type: "rich_text",
      data: { html: `<p>${"Draft text. ".repeat(400)}</p>` } }));
    await db.doc("cmsPosts/story").update({ type: "post", blocks });
    await db.doc(`cmsPreviewQueue/${queueId}`).update({
      snapshot: { type: "post", version: 1, blocks },
      assets: Array.from({ length: 10 }, (_, i) => ({ assetId: `asset-${i}`, type: "image",
        publicUrl: `https://assets.example.test/asset-${i}.webp`, title: "Preview image" })),
    });
    const deps = { validateAccess: async uid => (await admission(uid, null)).code,
      validatePreviewAccess: async (uid, identity) => (await admission(uid, identity)).code,
      serve: async () => new Response("fixture bytes"),
    };
    const paths = ["contact/", ...Array.from({ length: 10 }, (_, i) => `_astro/shared-${i}.js`)];
    for (const path of paths) {
      expect((await serveStaffSite(new Request(`https://preview.njpbs.org/p/${queueId}/${path}`, {
        headers: { cookie: "__Host-njpbs-staff=writer" },
      }), deps)).status).toBe(200);
    }
    expect(reads).toHaveLength(33);
    console.log(JSON.stringify({ measurement: "Preview page emulator reads", contentRequests: paths.length,
      reads: reads.length, genericReads: paths.length, addedReads: reads.length - paths.length,
      returnedDataJsonBytes: readBytes.reduce((total, bytes) => total + bytes, 0),
      perRequestDataJsonBytes: readBytes.slice(0, 3),
      fixture: { blocks: blocks.length, textBytesPerBlock: Buffer.byteLength(blocks[0].data.html), assets: 10 },
    }));
    await db.doc(`cmsPreviewQueue/${queueId}`).update({ persistent: true,
      expiresAt: admin.firestore.Timestamp.fromMillis(NOW + 60_000) });
    await db.doc(`cmsPreviewHeads/${previewContentKey("cmsPosts", "story")}`).set({ readyQueueId: queueId });
    reads.length = 0; readBytes.length = 0;
    for (const path of paths) {
      expect((await serveStaffSite(new Request(`https://preview.njpbs.org/s/${queueId}/${path}`, {
        headers: { cookie: "__Host-njpbs-staff=writer" },
      }), deps)).status).toBe(200);
    }
    expect(reads).toHaveLength(33);
    console.log(JSON.stringify({ measurement: "Retained page emulator reads", contentRequests: paths.length,
      reads: reads.length, returnedDataJsonBytes: readBytes.reduce((total, bytes) => total + bytes, 0),
      perRequestDataJsonBytes: readBytes.slice(0, 3) }));
    // Default CI keeps the read/byte contract; timing work needs explicit opt-in.
    if (process.env.SITE_ACCESS_LATENCY_SAMPLES !== undefined) {
      await db.doc(`cmsPreviewQueue/${queueId}`).update({ persistent: false,
        expiresAt: admin.firestore.Timestamp.fromMillis(NOW + 60_000) });
      const generic = [], preview = [];
      // Warm both paths once before paired measurements. No decision is reused.
      await admission("writer", null); await admission();
      for (let i = 0; i < 20; i++) {
        let started = performance.now(); await admission("writer", null); generic.push(performance.now() - started);
        started = performance.now(); await admission(); preview.push(performance.now() - started);
      }
      const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      console.log(JSON.stringify({ measurement: "Preview admission emulator latency", samples: 20,
        genericMedianMs: median(generic), previewMedianMs: median(preview), addedMedianMs: median(preview) - median(generic) }));
    }
  });
});

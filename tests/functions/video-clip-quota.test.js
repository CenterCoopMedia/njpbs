import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import clips from "../../functions/video-clips.js";
import rendition from "../../functions/lib/source-media-rendition.js";
import sourceMedia from "../../functions/source-media.js";
import mediaContract from "../../functions/lib/source-media-contract.js";
import clipContract from "../../functions/lib/video-clip-contract.js";

const now = Date.parse("2026-09-30T23:59:59.999Z");
const source = { id: "video-library", prefix: "objects/" };
const actor = { uid: "staff" };
const request = { sourceId: source.id, assetId: "asset", inMs: 1000, outMs: 5000 };
let db;
const userLimit = () => db.collection("mediaSourceClipLimits").doc(createHash("sha256").update(actor.uid).digest("hex"));
const dayLimit = () => db.doc("mediaSourceClipLimits/day-2026-09-30");

beforeAll(() => { db = isolatedFirestore("video-clip-quota.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const asset = { id: "asset", sourceId: source.id, lifecycle: "active", name: "Video", originalName: "video.mp4", nameSort: "video",
    updatedAtSort: "2026-09-30T15:00:00Z", mimeType: "video/mp4", kind: "video", sizeBytes: 1000, preview: "browser",
    rightsStatus: "pending", tags: [], version: 1, objectKey: "objects/video.mp4", objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: "viewing-attempt", updatedAt: "2026-09-30T15:00:00Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 120 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" } };
  await db.doc("mediaSourceAssets/asset").set(asset);
});

const submit = (fields = {}, at = now) => clips.requestClip({ firestore: db, actor, source, request: { ...request, ...fields }, now: at });

it("registers one durable library asset for concurrent saves and keeps the rendered source version", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const clip = await submit({ inMs: 1251, outMs: 2702 });
    const jobRef = db.doc(`${clipContract.CLIP_JOBS}/${clip.id}`);
    const output = { objectKey: `outputs/clips/${clip.id}/${clip.attemptId}/preview.mp4`,
      objectVersionId: "rendered-v1", sizeBytes: 100, mimeType: "video/mp4", durationSeconds: 1.451 };
    const payload = { sourceId: source.id, assetId: "asset", clipId: clip.id, attemptId: clip.attemptId };
    const writableSource = { ...source, writable: true, access: "active_staff" };
    const principal = role => ({ uid: role, principal: { id: role, grants: [{ role }] } });
    const registry = () => new Map([[source.id, writableSource]]);
    await Promise.all(["editor", "staff"].map(role => db.doc(`users/${role}`).set({ active: true })));
    await db.doc(`mediaSourceStats/${source.id}`).set({ exact: true, sourceId: source.id, activeCount: 1 });
    const copyClip = vi.fn(async (_source, session) => ({ VersionId: "library-v1", ContentLength: 100,
      Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId } }));
    const verifyAppCheck = vi.fn(async () => {});
    const register = role => clips.clipHandler("register", { firestore: db, registry,
      verifyAppCheck, requirePrincipal: async () => principal(role), uploader: { copyClip } });
    async function call(handler, body) {
      const res = { set() {}, status(code) { this.statusCode = code; return this; }, json(result) { this.body = result; return this; } };
      await handler({ method: "POST", headers: { "content-type": "application/json", "x-firebase-appcheck": "app-check" }, body }, res);
      return res;
    }
    expect((await call(register("editor"), payload)).statusCode).toBe(409);
    await jobRef.update({ phase: "ready", active: false, output });
    expect((await call(register("staff"), payload)).statusCode).toBe(403);
    expect((await call(register("editor"), { ...payload, attemptId: "stale-attempt" })).statusCode).toBe(409);
    await jobRef.update({ expiresAt: new Date(now).toISOString() });
    expect((await call(register("editor"), payload)).statusCode).toBe(409);
    expect(copyClip).not.toHaveBeenCalled();
    await jobRef.update({ expiresAt: new Date(now + 60_000).toISOString() });
    await db.doc("mediaSourceAssets/asset").update({ objectVersionId: "original-v2" });
    copyClip.mockRejectedValueOnce(clipContract.problem(409, "The requested rendition is not available"));
    expect((await call(register("editor"), payload)).statusCode).toBe(409);
    expect((await db.collection("mediaSourceAssets").get()).size).toBe(1);
    copyClip.mockImplementationOnce(async (_source, _session, _output, registration) => {
      expect(await registration.claimUpload("copy-upload")).toBe("copy-upload");
      return null;
    });
    expect((await call(register("editor"), payload)).body).toEqual({ success: true, pending: true });
    const [left, right] = await Promise.all([call(register("editor"), payload), call(register("editor"), payload)]);
    expect(left.statusCode).toBe(200);
    expect(right.body).toEqual(left.body);
    expect(copyClip.mock.calls.at(-1)[3].uploadId).toBe("copy-upload");
    const saved = left.body.asset;
    const copies = copyClip.mock.calls.length;
    await jobRef.delete();
    expect((await call(register("editor"), payload)).body.asset).toEqual(saved);
    expect(copyClip).toHaveBeenCalledTimes(copies);
    expect(verifyAppCheck).toHaveBeenCalledWith("app-check");
    const stored = (await db.doc(`mediaSourceAssets/${saved.id}`).get()).data();
    expect(stored).toMatchObject({ lifecycle: "active", objectVersionId: "library-v1", rightsStatus: "pending",
      parentSource: { sourceId: source.id, assetId: "asset", fileVersion: mediaContract.sourceMediaFileVersion("original-v1"), inMs: 1251, outMs: 2702 } });
    expect((await db.collection("mediaSourcePreviewJobs").get()).size).toBe(1);
    expect((await db.doc(`mediaSourceStats/${source.id}`).get()).data().activeCount).toBe(2);
    const deps = { firestore: db, registryFn: registry, requirePrincipalFn: async () => principal("staff"),
      originalStorage: { head: async () => ({}) } };
    const listed = await call(sourceMedia.createCmsListSourceMediaHandler(deps), { sourceId: source.id, assetId: saved.id });
    expect(listed.body.records[0]).toMatchObject({ ...saved, parentSource: stored.parentSource });
    const createReadFn = vi.fn(async (_source, asset, action) => ({ assetId: asset.id, action, url: "https://media.example.org/clip" }));
    const read = () => call(sourceMedia.createCmsCreateSourceMediaReadHandler({ ...deps, createReadFn }),
      { sourceId: source.id, assetId: saved.id, action: "preview" });
    expect((await read()).body.access).toMatchObject({ assetId: saved.id, action: "preview" });
    await db.doc("users/staff").update({ active: false });
    expect((await read()).statusCode).toBe(403);
    expect(createReadFn).toHaveBeenCalledTimes(1);
    await db.doc(`mediaSourceAssets/${saved.id}`).update({ lifecycle: "deleted" });
    expect((await call(register("editor"), payload)).body.error).toMatch(/deleted/);
    await db.doc("mediaSourceAssets/asset").update({ objectVersionId: "original-v1" });
    const rerender = await submit({ inMs: 1251, outMs: 2702 });
    expect(rerender.id).toBe(clip.id);
    expect(rerender.attemptId).not.toBe(clip.attemptId);
    await jobRef.update({ phase: "ready", active: false, output: { ...output,
      objectKey: `outputs/clips/${clip.id}/${rerender.attemptId}/preview.mp4`, objectVersionId: "rendered-v2" } });
    const resaved = await call(register("editor"), { ...payload, attemptId: rerender.attemptId });
    expect(resaved.statusCode).toBe(200);
    expect(resaved.body.asset.id).not.toBe(saved.id);
  } finally {
    clock.mockRestore();
  }
});

describe("video export quota API with real Firestore transactions", () => {
  it.each([
    ["person", "exports", 30, 30, 0], ["station", "exports", 120, 120, 0],
    ["person", "seconds", 86400, 86397, 3], ["station", "seconds", 345600, 345597, 3],
  ])("reports %s %s without spending allowance", async (scope, unit, limit, used, remaining) => {
    const ref = scope === "person" ? userLimit() : dayLimit();
    await ref.set({ day: "2026-09-30", count: unit === "exports" ? used : 0, editorSeconds: unit === "seconds" ? used : 0 });
    const before = (await ref.get()).data();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const res = { set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    try {
      await clips.clipHandler("request", { firestore: db, registry: () => new Map([[source.id, source]]), config: () => ({}),
        verifyAppCheck: async () => {}, requirePrincipal: async () => actor, authorize: async () => {},
        editorExportsEnabled: () => true, originalStorage: { head: () => { throw new Error("Quota refusal must precede storage work"); } },
      })({ method: "POST", headers: { "content-type": "application/json" }, body: { ...request, ...(unit === "seconds" ? { format: "prores_mov" } : {}) } }, res);
    } finally { clock.mockRestore(); }
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: "clip_export_quota", quota: { scope, unit, limit, remaining, resetAt: "2026-10-01T00:00:00.000Z" } });
    expect(res.body.error).toContain("00:00 UTC on 2026-10-01");
    expect(res.body.error).toContain(scope === "person" ? (unit === "seconds" ? "your" : "Your") : "station's");
    expect((await ref.get()).data()).toEqual(before);
    expect((await db.collection("mediaSourceClipJobs").get()).empty).toBe(true);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("resets at UTC midnight, keeps cached requests free, and charges a failed attempt's exact retry once", async () => {
    const first = await submit();
    const jobRef = db.collection("mediaSourceClipJobs").doc(first.id);
    await jobRef.update({ phase: "failed", active: false, retryable: true, errorCode: "conversion_failed" });
    await userLimit().update({ count: 30 });
    await dayLimit().update({ count: 120 });
    const before = (await userLimit().get()).data();
    expect((await submit()).id).toBe(first.id);
    expect((await userLimit().get()).data()).toEqual(before);
    await expect(submit({ retry: true })).rejects.toMatchObject({ status: 429, quota: { remaining: 0 } });
    const afterReset = now + 1;
    const retry = await submit({ retry: true }, afterReset);
    expect(retry.id).toBe(first.id);
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect((await userLimit().get()).data()).toMatchObject({ day: "2026-10-01", count: 1 });
    expect((await db.doc("mediaSourceClipLimits/day-2026-10-01").get()).data()).toMatchObject({ count: 1 });
    expect((await submit({ retry: true }, afterReset)).attemptId).toBe(retry.attemptId);
    expect((await userLimit().get()).data().count).toBe(1);
  });
});

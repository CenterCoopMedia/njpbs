import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import clips from "../../functions/video-clips.js";
import rendition from "../../functions/lib/source-media-rendition.js";

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

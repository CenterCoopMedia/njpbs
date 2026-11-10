import { describe, expect, it, vi } from "vitest";
import { backfillSourceRate, sourceRateFromProbe } from "../../scripts/backfill-video-source-frame-rates.mjs";
import rendition from "../../functions/lib/source-media-rendition.js";

function database() {
  const asset = { sourceId: "video-library", lifecycle: "active", name: "Fixture", originalName: "fixture.mp4",
    nameSort: "fixture", updatedAtSort: "2026-10-05T16:00:00Z", mimeType: "video/mp4", kind: "video", sizeBytes: 1000,
    preview: "browser", rightsStatus: "pending", tags: [], version: 4, objectKey: "objects/fixture.mp4", objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix({ id: "fixture", ...asset }, "preview-v1");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: "preview-v1", updatedAt: "2026-10-05T16:00:00Z",
    web: { objectKey: prefix + "preview.mp4", objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 10 },
    poster: { objectKey: prefix + "preview-poster.0000000.jpg", objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" } };
  const records = new Map([["mediaSourceAssets/fixture", asset]]);
  let auto = 0;
  const ref = (key, id) => ({ key, id, get: async () => ({ id, exists: records.has(key), data: () => records.get(key) }) });
  const db = { records, collection: collection => ({ doc: (id = `audit-${++auto}`) => ref(`${collection}/${id}`, id) }),
    runTransaction: work => work({ set: (item, value) => records.set(item.key, value), get: item => item.get(), update: (item, fields) => {
      const value = records.get(item.key);
      for (const [key, field] of Object.entries(fields)) { const names = key.split("."); let target = value;
        for (const name of names.slice(0, -1)) target = target[name]; target[names.at(-1)] = field; }
    }, create: (item, value) => records.set(item.key, value) }) };
  return db;
}
const source = { id: "video-library", prefix: "objects/" };
const probe = { ProbeResults: [{ Container: { Tracks: [{ TrackType: "video", VideoProperties: { FrameRate: { Numerator: 60000, Denominator: 1001 } } }] } }] };

describe("existing original-rate metadata backfill", () => {
  it("inspects eligibility without Probe or mutation by default", async () => {
    const firestore = database(); const before = structuredClone([...firestore.records]);
    const inspectOriginal = vi.fn();
    expect(await backfillSourceRate({ firestore, source, assetId: "fixture", inspectOriginal })).toEqual({ assetId: "fixture", state: "eligible", apply: false });
    expect(inspectOriginal).not.toHaveBeenCalled(); expect([...firestore.records]).toEqual(before);
  });
  it("records the measured rational rate and audit without changing the original, web copy or staff version", async () => {
    const firestore = database(); const before = structuredClone(firestore.records.get("mediaSourceAssets/fixture"));
    const inspectOriginal = vi.fn(async () => probe);
    expect(await backfillSourceRate({ firestore, source, assetId: "fixture", apply: true, inspectOriginal })).toMatchObject({ state: "measured", sourceFrameRateNumerator: 60000, sourceFrameRateDenominator: 1001 });
    const current = firestore.records.get("mediaSourceAssets/fixture");
    expect(current.objectVersionId).toBe(before.objectVersionId); expect(current.version).toBe(4);
    expect(current.rendition.web.objectVersionId).toBe(before.rendition.web.objectVersionId);
    expect([...firestore.records].find(([key]) => key.startsWith("admin_logs/"))[1]).toMatchObject({ action: "media.source.frame-rate.backfill", after: { sourceObjectVersionId: "original-v1", sourceFrameRateNumerator: 60000 } });
    expect(await backfillSourceRate({ firestore, source, assetId: "fixture", apply: true, inspectOriginal })).toMatchObject({ state: "skipped" });
    expect(inspectOriginal).toHaveBeenCalledTimes(1);
  });
  it("does not write to a changed original or an invalid Probe result", async () => {
    const firestore = database();
    const result = await backfillSourceRate({ firestore, source, assetId: "fixture", apply: true, inspectOriginal: async () => {
      firestore.records.get("mediaSourceAssets/fixture").objectVersionId = "original-v2"; return probe;
    } });
    expect(result.state).toBe("changed");
    expect([...firestore.records.keys()].some(key => key.startsWith("admin_logs/"))).toBe(false);
    for (const result of [{}, { ProbeResults: [] }, { ProbeResults: [probe.ProbeResults[0], probe.ProbeResults[0]] }, { ProbeResults: [{ Container: { Tracks: [] } }] }]) expect(() => sourceRateFromProbe(result)).toThrow();
  });
});

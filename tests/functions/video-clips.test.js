import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import clips from "../../functions/video-clips.js";
import contract from "../../functions/lib/video-clip-contract.js";
import rendition from "../../functions/lib/source-media-rendition.js";
import originals from "../../functions/lib/source-originals.js";
const now = Date.parse("2026-09-15T15:00:00Z");
const source = { id: "video-library", prefix: "objects/", expectedBucketOwner: "123456789012", roleArn: "role" };
function stored() {
  const asset = { id: "asset", sourceId: source.id, lifecycle: "active", name: "Video", originalName: "video.mp4", nameSort: "video",
    updatedAtSort: "2026-09-15T15:00:00Z", mimeType: "video/mp4", kind: "video", sizeBytes: 1000, preview: "browser",
    rightsStatus: "pending", tags: [], version: 1, objectKey: "objects/video.mp4", objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: "viewing-attempt", updatedAt: "2026-09-15T15:00:00Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 120 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" } };
  return asset;
}
function firestore() {
  const records = new Map([["mediaSourceAssets/asset", stored()]]);
  let auto = 0;
  const ref = (collection, id) => ({ id, key: `${collection}/${id}`, async get() {
    return { id, exists: records.has(this.key), data: () => records.get(this.key), ref: this };
  } });
  return { records, doc(path) { const [collection, id] = path.split("/"); return ref(collection, id); }, collection(name) {
    const query = (filters = [], maximum = Infinity, order, after = null) => ({
      doc(id = `auto-${++auto}`) { return ref(name, id); },
      where(field, operation, value) { return query([...filters, [field, value]], maximum, order, after); },
      orderBy(field, direction) { return query(filters, maximum, [field, direction], after); },
      startAfter(cursor) { return query(filters, maximum, order, cursor); },
      limit(value) { return query(filters, value, order, after); }, async get() {
        let rows = [...records].filter(([key, value]) => key.startsWith(`${name}/`) && filters.every(([field, expected]) => value[field] === expected));
        if (order) rows.sort((a, b) => {
          const direction = order[1] === "desc" ? -1 : 1;
          if (order[0] === "__name__") return a[0].localeCompare(b[0]) * direction;
          return (a[1][order[0]].localeCompare(b[1][order[0]]) || a[0].localeCompare(b[0])) * direction;
        });
        if (typeof after === "string") rows = rows.filter(([key]) => key > `${name}/${after}`);
        else if (after) rows = rows.slice(rows.findIndex(([key]) => key === `${name}/${after.id}`) + 1);
        return { docs: await Promise.all(rows.slice(0, maximum).map(([key]) => ref(name, key.slice(name.length + 1)).get())) };
      },
    });
    return query();
  }, async runTransaction(fn) {
    const writes = [];
    const tx = { get: r => r.get(), set: (r, value) => writes.push(() => records.set(r.key, value)),
      update: (r, value) => writes.push(() => records.set(r.key, { ...records.get(r.key), ...value })),
      create: (r, value) => writes.push(() => records.set(r.key, value)) };
    const result = await fn(tx); for (const write of writes) write(); return result;
  } };
}
const request = { sourceId: source.id, assetId: "asset", inMs: 1000, outMs: 5000 };
const submit = (db, fields = {}) => clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: { ...request, ...fields }, now });
function ready(job) { return { ...job, phase: "ready", active: false, output: { objectKey: `outputs/clips/${job.id}/${job.attemptId}/preview.mp4`, objectVersionId: "clip-v1", sizeBytes: 100, mimeType: "video/mp4", durationSeconds: 4 } }; }
function broadcastOutput(job, fields = {}) {
  const start = 29 * 1001 / 30000;
  const end = 150 * 1001 / 30000;
  return { objectKey: `outputs/clips/${job.id}/${job.attemptId}/broadcast.mxf`, objectVersionId: "broadcast-v1",
    sizeBytes: 1000, mimeType: "application/mxf", container: "mxf", videoCodec: "mpeg2", profile: "xdcam_rdd9",
    width: 1920, height: 1080, durationSeconds: end - start, frameRateNumerator: 30000, frameRateDenominator: 1001,
    sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001,
    conversionMethod: "none", timecodeMode: "embedded_or_zero_based",
    scanType: "interlaced", audioChannels: 2, audioTracks: 2, audioCodec: "pcm", audioSampleRate: 48000,
    audioBitDepth: 24, sourceStartSeconds: start, sourceEndSeconds: end, sourceFrameDurationSeconds: 1001 / 30000,
    ...fields };
}
function getJob(db, id) { return db.records.get(`${contract.CLIP_JOBS}/${id}`); }

describe("private clip exports", () => {
  it("checks S3 outside quota locks and reuses an admitted export without another check", async () => {
    const db = firestore(); let transactionOpen = false;
    const transaction = db.runTransaction.bind(db);
    db.runTransaction = async callback => {
      transactionOpen = true;
      try { return await transaction(callback); } finally { transactionOpen = false; }
    };
    const send = vi.fn(async () => {
      expect(transactionOpen).toBe(false);
      return { VersionId: "original-v1", ContentLength: 1000 };
    });
    const originalStorage = originals.createOriginalStorage({ region: "us-east-2" }, { client: { send } });
    const submitOriginal = () => clips.requestClip({ firestore: db, source, actor: { uid: "staff" },
      request: { ...request, format: "original_copy" }, originalStorage, now });
    const first = await submitOriginal();
    expect(first.state).toBe("queued");
    expect((await submitOriginal()).id).toBe(first.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.records.get("mediaSourceClipLimits/day-2026-09-15").count).toBe(1);
  });
  it.each(["replacement", "quota"])("rechecks %s after the unlocked original check", async change => {
    const db = firestore();
    const originalStorage = originals.createOriginalStorage({ region: "us-east-2" }, { client: { send: async () => {
      if (change === "replacement") db.records.get("mediaSourceAssets/asset").objectVersionId = "replacement";
      else db.records.set("mediaSourceClipLimits/day-2026-09-15", { count: clips.GLOBAL_CLIP_EXPORTS_PER_DAY });
      return { VersionId: "original-v1", ContentLength: 1000 };
    } } });
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" },
      request: { ...request, format: "original_copy" }, originalStorage, now })).rejects.toMatchObject({ status: change === "replacement" ? 409 : 429 });
    expect([...db.records.keys()].filter(key => key.startsWith(`${contract.CLIP_JOBS}/`))).toEqual([]);
    expect(db.records.has("mediaSourceClipLimits/original-active")).toBe(false);
  });
  it.each(["SUCCEEDED", "FAILED"])("expires only a confirmed terminal export (%s)", async status => {
    const db = firestore(); const first = await submit(db);
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    const run = client => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => now,
      assertBillingEnabledFn: async () => {} });
    await run({ send: async () => ({}) });
    const job = getJob(db, first.id);
    expect(job.phase).toBe("running");
    expect(job).not.toHaveProperty("purgeAt");
    await run({ send: async () => ({ status, output: JSON.stringify({ id: job.id,
      attemptId: job.attemptId, web: ready(job).output }) }) });
    expect(getJob(db, first.id).phase).toBe(status === "SUCCEEDED" ? "ready" : "failed");
    expect(getJob(db, first.id).purgeAt).toEqual(new Date(now + 30 * 86400 * 1000));
  });

  it("retains a job after repeated uncertain provider responses", async () => {
    const db = firestore(); const first = await submit(db);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db,
        config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" },
        client: { send: async () => { throw new Error("unconfirmed network response"); } },
        now: () => now, assertBillingEnabledFn: async () => {} });
    }
    expect(getJob(db, first.id).phase).toBe("needs_reconciliation");
    expect(getJob(db, first.id)).not.toHaveProperty("purgeAt");
  });
  it("preserves the legacy default identity and separates every output setting", async () => {
    const db=firestore();const first=await submit(db);const job=getJob(db,first.id);
    const fields=[job.sourceId,job.assetId,job.sourceObjectKey,job.sourceObjectVersionId,job.sourceSizeBytes,
      job.inputObjectKey,job.inputObjectVersionId,job.inputSizeBytes,job.inMs,job.outMs,"clip-v1"];
    expect(first.id).toBe(createHash("sha256").update(JSON.stringify(fields)).digest("hex"));
    expect(contract.clipIdentity({...job,resolution:"source",quality:"balanced"})).toBe(first.id);
    const ids=new Set();for(const resolution of ["source","1080p","720p","480p"]) for(const quality of ["smaller","balanced","high"])
      ids.add(contract.clipIdentity({...job,resolution,quality}));
    expect(ids.size).toBe(12);
  });
  it("rejects invalid settings, unknown dimensions and upscaling before a job is created", async () => {
    for(const fields of [{resolution:"4k"},{quality:"best"},{resolution:720},{resolution:null},{quality:null}])
      expect(()=>contract.parseClipRequest({...request,...fields},"request")).toThrow();
    const db=firestore();await expect(submit(db,{resolution:"720p"})).rejects.toMatchObject({status:409});
    Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web,{width:480,height:854});
    await expect(submit(db,{resolution:"720p"})).rejects.toMatchObject({status:409});
    expect((await submit(db,{resolution:"480p",quality:"smaller"}))).toMatchObject({resolution:"480p",quality:"smaller"});
  });
  it("stores settings for retry and carries them into provider input and audit", async () => {
    const db=firestore();Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web,{width:1080,height:1920});
    const first=await submit(db,{resolution:"720p",quality:"high"});const job=getJob(db,first.id);
    Object.assign(job,{phase:"failed",retryable:true,active:false});
    const retry=await submit(db,{resolution:first.resolution,quality:first.quality,retry:true});expect(retry.id).toBe(first.id);
    const client={send:vi.fn(async()=>({}))};
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) },firestore:db,config:{source,workflowArn:"arn:aws:states:us-east-2:123456789012:stateMachine:preview"},client,now:()=>now,assertBillingEnabledFn:async()=>{}});
    expect(JSON.parse(client.send.mock.calls[0][0].input.input)).toMatchObject({resolution:"720p",quality:"high"});
    expect([...db.records].filter(([key])=>key.startsWith("admin_logs/")).at(-1)[1].after).toMatchObject({resolution:"720p",quality:"high"});
  });
  it("retains actual output dimensions and rejects output larger than the chosen cap", async () => {
    const db=firestore();const first=await submit(db);const job=getJob(db,first.id);
    const output={...ready(job).output,width:720,height:1280};const changed={...job,resolution:"720p",quality:"high"};
    const checked=contract.validateClipOutput(changed,{id:job.id,attemptId:job.attemptId,web:output});
    expect(contract.clipSummary({...changed,phase:"ready",output:checked},now)).toMatchObject({width:720,height:1280,resolution:"720p",quality:"high"});
    expect(()=>contract.validateClipOutput(changed,{id:job.id,attemptId:job.attemptId,web:{...output,width:1080,height:1920}})).toThrow("dimensions");
  });
  it("adds source and original-based broadcast formats without changing the legacy identity", async () => {
    const legacyDb = firestore();
    const legacy = await submit(legacyDb);
    const db = firestore();
    const broadcast = await submit(db, { format: "broadcast_mxf" });
    expect(broadcast).toMatchObject({ scope: "clip", format: "broadcast_mxf", inMs: 1000, outMs: 5000 });
    expect(broadcast.id).not.toBe(legacy.id);
    const job = getJob(db, broadcast.id);
    expect(clips.providerInput(job)).toMatchObject({ scope: "clip", format: "broadcast_mxf",
      sourceObjectVersionId: "original-v1", inputObjectVersionId: "web-v1" });
    expect(clips.providerInput(job)).not.toHaveProperty("resolution");
    expect(() => contract.parseClipRequest({ ...request, format: "broadcast_mxf", resolution: "source" }, "request")).toThrow();
  });
  it("admits a full-source export beyond the clip cap and binds it only to the original version", async () => {
    const db = firestore();
    db.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 4 * 60 * 60;
    const sourceRequest = { sourceId: source.id, assetId: "asset", scope: "source", format: "broadcast_mxf" };
    const parsed = contract.parseClipRequest(sourceRequest, "request");
    const result = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: parsed, now });
    const job = getJob(db, result.id);
    expect(result).toMatchObject({ scope: "source", format: "broadcast_mxf", durationMs: 4 * 60 * 60 * 1000 });
    expect(job).not.toHaveProperty("inputObjectKey");
    db.records.get("mediaSourceAssets/asset").rendition.web.objectVersionId = "web-v2";
    expect(contract.sameClipSource(db.records.get("mediaSourceAssets/asset"), job)).toBe(true);
    db.records.get("mediaSourceAssets/asset").objectVersionId = "original-v2";
    expect(contract.sameClipSource(db.records.get("mediaSourceAssets/asset"), job)).toBe(false);
    expect(() => contract.parseClipRequest({ ...sourceRequest, inMs: 0, outMs: 1 }, "request")).toThrow();
    const tooLong = firestore();
    tooLong.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 86400.001;
    await expect(clips.requestClip({ firestore: tooLong, source, actor: { uid: "staff" }, request: parsed, now }))
      .rejects.toMatchObject({ status: 409 });
  });
  it("validates the bounded RDD9 receipt and exact frame-rounded source timing", async () => {
    const db = firestore(); const summary = await submit(db, { format: "broadcast_mxf" });
    const job = getJob(db, summary.id); const output = broadcastOutput(job);
    const checked = contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, broadcast: output });
    expect(contract.clipSummary({ ...job, phase: "ready", active: false, output: checked }, now))
      .toMatchObject({ durationMs: 4037, sourceStartSeconds: 29 * 1001 / 30000, sourceEndSeconds: 150 * 1001 / 30000,
        frameRateNumerator: 30000, scanType: "interlaced", audioChannels: 2 });
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
      broadcast: { ...output, frameRateNumerator: 30, frameRateDenominator: 1 } })).toThrow();
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
      broadcast: { ...output, audioChannels: 1, audioTracks: 1 } })).toThrow();
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
      broadcast: { ...output, sourceStartSeconds: 1.1 } })).toThrow("timing");
  });
  it.each([
    ["prores_mov", "prores", "prores.mov", "video/quicktime", "quicktime", "prores", "prores_422_hq"],
    ["avid_mxf", "avid", "avid.mxf", "application/mxf", "mxf", "vc3", "vc3_class_145_8bit"],
  ])("validates the %s editor receipt", async (format, resultKey, filename, mimeType, container, videoCodec, profile) => {
    const db = firestore(); const summary = await submit(db, { format }); const job = getJob(db, summary.id);
    const output = broadcastOutput(job, { objectKey: `outputs/clips/${job.id}/${job.attemptId}/${filename}`,
      mimeType, container, videoCodec, profile });
    expect(contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, [resultKey]: output }))
      .toMatchObject({ container, videoCodec, profile });
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
      [resultKey]: { ...output, profile: "other" } })).toThrow();
  });
  it.each([
    ["prores_mov", 1920, 1080, 60000, 1001, "progressive", true],
    ["prores_mov", 3840, 2160, 30000, 1001, "progressive", true],
    ["prores_mov", 1080, 1920, 30, 1, "progressive", true],
    ["prores_mov", 4096, 4096, 24, 1, "progressive", true],
    ["prores_mov", 31, 1080, 25, 1, "progressive", false],
    ["prores_mov", 1921, 1080, 25, 1, "progressive", false],
    ["prores_mov", 4098, 1080, 25, 1, "progressive", false],
    ["prores_mov", 1920, 4098, 25, 1, "progressive", false],
    ["prores_mov", 1920, 1080, 27, 1, "progressive", false],
    ["avid_mxf", 1920, 1080, 60, 1, "progressive", true],
    ["avid_mxf", 1280, 720, 24, 1, "progressive", true],
    ["avid_mxf", 1920, 1080, 30, 1, "interlaced", true],
    ["avid_mxf", 3840, 2160, 25, 1, "progressive", false],
    ["avid_mxf", 1080, 1920, 25, 1, "progressive", false],
    ["avid_mxf", 1280, 720, 25, 1, "interlaced", false],
    ["avid_mxf", 1920, 1080, 60, 1, "interlaced", false],
    ["broadcast_mxf", 1920, 1080, 60000, 1001, "progressive", false],
  ])("checks the %s receipt against its own raster/rate/scan contract (%s x %s, %s/%s, %s)",
    async (format, width, height, frameRateNumerator, frameRateDenominator, scanType, accepted) => {
      const db = firestore(); const summary = await submit(db, { format }); const job = getJob(db, summary.id);
      const spec = contract.EDITOR_FORMATS[format];
      const output = broadcastOutput(job, { mimeType: spec.mimeType, container: spec.container,
        videoCodec: spec.videoCodec, profile: spec.profile, objectKey: `outputs/clips/${job.id}/${job.attemptId}/${spec.filename}`,
        width, height, frameRateNumerator, frameRateDenominator, scanType });
      const validate = () => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, [spec.resultKey]: output });
      if (accepted) expect(validate()).toMatchObject({ width, height, frameRateNumerator, frameRateDenominator, scanType });
      else expect(validate).toThrow("clip_output_invalid");
    });
  it.each(["prores_mov", "avid_mxf"])("lets an earlier %s XDCAM rejection retry once under the corrected profile", async format => {
    const db = firestore(); const summary = await submit(db, { format }); const job = getJob(db, summary.id);
    Object.assign(job, { phase: "failed", active: false, retryable: false, errorCode: "editor_video_unsupported" });
    expect(contract.clipSummary(job, now).canRetry).toBe(true);
    const retried = await submit(db, { format, retry: true });
    expect(retried.id).toBe(summary.id);
    expect(getJob(db, summary.id)).toMatchObject({ phase: "pending", attempts: 2 });
    expect(getJob(db, summary.id).attemptId).not.toBe(summary.attemptId);
    Object.assign(getJob(db, summary.id), { phase: "failed", retryable: false,
      errorCode: format === "prores_mov" ? "prores_video_unsupported" : "avid_video_unsupported" });
    expect(contract.clipSummary(getJob(db, summary.id), now).canRetry).toBe(false);
    Object.assign(getJob(db, summary.id), { errorCode: "editor_video_unsupported", attempts: 3 });
    expect(contract.clipSummary(getJob(db, summary.id), now).canRetry).toBe(false);
  });
  it("accepts actual full-source timing without treating the web duration as an exact boundary", async () => {
    const db = firestore(); db.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 3600;
    const parsed = contract.parseClipRequest({ sourceId: source.id, assetId: "asset", scope: "source", format: "broadcast_mxf", frameRateMode: "source" }, "request");
    const summary = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: parsed, now });
    const job = getJob(db, summary.id);
    const output = broadcastOutput(job, { durationSeconds: 3600.4, sourceStartSeconds: 0, sourceEndSeconds: 3600.4,
      sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1, frameRateNumerator: 25, frameRateDenominator: 1, scanType: "progressive", sourceFrameDurationSeconds: 0.04 });
    expect(contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, broadcast: output }))
      .toMatchObject({ sourceStartSeconds: 0, sourceEndSeconds: 3600.4 });
  });
  it("accepts a bounded original end clamp and rejects a materially shorter source", async () => {
    const db = firestore(); const summary = await submit(db, { format: "broadcast_mxf" });
    const job = getJob(db, summary.id);
    const clamped = broadcastOutput(job, { sourceEndSeconds: 4.2 });
    clamped.durationSeconds = clamped.sourceEndSeconds - clamped.sourceStartSeconds;
    expect(contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, broadcast: clamped }))
      .toMatchObject({ sourceEndSeconds: 4.2 });
    const short = { ...clamped, sourceEndSeconds: 3.9,
      durationSeconds: 3.9 - clamped.sourceStartSeconds };
    expect(() => contract.validateClipOutput(job, {
      id: job.id, attemptId: job.attemptId, broadcast: short,
    })).toThrow("timing");
  });

  it.each([{ inMs: -1 }, { inMs: 5000 }, { outMs: 1100 }, { outMs: 2000000 }, { inMs: 1.1 }, { retry: "yes" }, { sourceId: "archive" }, { bucket: "injected" }])("rejects invalid range or source input %j", fields => {
    expect(() => contract.parseClipRequest({ ...request, ...fields }, "request")).toThrow();
  });
  it("deduplicates accepted requests without another quota or audit write", async () => {
    const db = firestore(); const first = await submit(db); const count = db.records.size;
    expect(await submit(db)).toEqual(first); expect(db.records.size).toBe(count);
    expect(getJob(db, first.id).requestedBy).toBe("staff");
  });
  it("refuses out of duration, missing viewing copy and deleted sources", async () => {
    const db = firestore(); await expect(submit(db, { outMs: 121000 })).rejects.toMatchObject({ status: 409 });
    db.records.get("mediaSourceAssets/asset").lifecycle = "deleted";
    await expect(submit(db)).rejects.toMatchObject({ status: 404 });
  });
  it("bounds active exports and daily starts", async () => {
    const db = firestore(); await submit(db);
    await expect(submit(db, { inMs: 2000 })).rejects.toMatchObject({ status: 429 });
    db.records.set("mediaSourceClipLimits/day-2026-09-15", { count: 120 });
    await expect(clips.requestClip({ firestore: db, actor: { uid: "other" }, source, request: { ...request, inMs: 3000 }, now })).rejects.toMatchObject({ status: 429 });
  });
  it("allows thirty clip exports per person per day", async () => {
    expect(clips.USER_CLIP_EXPORTS_PER_DAY).toBe(30);
    expect(clips.GLOBAL_CLIP_EXPORTS_PER_DAY).toBe(120);
    const db = firestore(); const first = await submit(db);
    Object.assign(getJob(db, first.id), { phase: "ready", active: false });
    const userLimitKey = [...db.records.keys()].find(key => key.startsWith("mediaSourceClipLimits/") && !key.includes("day-") && key !== "mediaSourceClipLimits/original-active");
    db.records.get(userLimitKey).count = 29;
    const thirtieth = await submit(db, { inMs: 3000 });
    Object.assign(getJob(db, thirtieth.id), { phase: "ready", active: false });
    expect(db.records.get(userLimitKey).count).toBe(30);
    await expect(submit(db, { inMs: 4000 })).rejects.toMatchObject({ status: 429, code: "clip_export_quota",
      quota: { scope: "person", unit: "exports", limit: 30, remaining: 0, resetAt: "2026-09-16T00:00:00.000Z" } });
  });
  it("bounds original-based daily conversion duration independently of attempt count", async () => {
    const db = firestore();
    db.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 86400;
    const sourceRequest = contract.parseClipRequest({
      sourceId: source.id, assetId: "asset", scope: "source", format: "prores_mov",
    }, "request");
    const first = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" },
      request: sourceRequest, now });
    Object.assign(getJob(db, first.id), { phase: "failed", active: false });
    await expect(submit(db, { format: "broadcast_mxf" })).rejects.toMatchObject({ status: 429 });
    expect(db.records.get("mediaSourceClipLimits/day-2026-09-15").editorSeconds).toBe(86400);
  });
  it("cancels only the exact unclaimed attempt and retains quota accounting", async () => {
    const db = firestore(); const first = await submit(db); const job = getJob(db, first.id);
    expect(job).not.toHaveProperty("purgeAt");
    const cancelled = await clips.cancelClip(db, source, { ...request, clipId: first.id, attemptId: job.attemptId },
      { uid: "staff" }, now + 1);
    expect(cancelled).toMatchObject({ state: "cancelled", canCancel: false, attemptId: job.attemptId });
    expect(getJob(db, first.id).purgeAt).toEqual(new Date(now + 1 + 30 * 86400 * 1000));
    expect(db.records.get("mediaSourceClipLimits/day-2026-09-15").count).toBe(1);
    const client = { send: vi.fn() };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client, now: () => now + 1 });
    expect(client.send).not.toHaveBeenCalled();
    await expect(clips.cancelClip(db, source, { ...request, clipId: first.id, attemptId: job.attemptId },
      { uid: "other" }, now + 1)).rejects.toMatchObject({ status: 404 });
    expect(await clips.cancelClip(db, source, { ...request, clipId: first.id, attemptId: job.attemptId },
      { uid: "staff" }, now + 2)).toMatchObject({ state: "cancelled" });
    const replacement = await submit(db);
    expect(getJob(db, replacement.id)).not.toHaveProperty("purgeAt");
    expect(replacement.attemptId).not.toBe(job.attemptId);
    await expect(clips.cancelClip(db, source, { ...request, clipId: first.id, attemptId: job.attemptId },
      { uid: "staff" }, now + 3)).rejects.toMatchObject({ status: 409 });
    Object.assign(getJob(db, first.id), { phase: "pending", leaseOwner: "worker" });
    await expect(clips.cancelClip(db, source, { ...request, clipId: first.id, attemptId: replacement.attemptId },
      { uid: "staff" }, now + 4)).rejects.toMatchObject({ status: 409 });
    expect(() => contract.parseClipRequest({ sourceId: source.id, assetId: "asset", clipId: first.id }, "cancel")).toThrow();
  });
  it("does not advertise cancellation to a user who reuses another user's export", async () => {
    const db = firestore(); const first = await submit(db);
    expect(first.canCancel).toBe(true);
    const reused = await clips.requestClip({ firestore: db, source, actor: { uid: "other" }, request, now });
    expect(reused).toMatchObject({ id: first.id, canCancel: false });
    const dependencies = { firestore: db, registry: () => new Map([[source.id, source]]),
      editorExportsEnabled: () => false, verifyAppCheck: async () => {},
      requirePrincipal: async () => ({ uid: "other" }), authorize: async () => {} };
    const body = { sourceId: source.id, assetId: "asset", clipId: first.id };
    const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await clips.clipHandler("get", dependencies)({ method: "POST", body,
      rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
    expect(res).toMatchObject({ code: 200, body: { clip: { id: first.id, canCancel: false } } });
  });
  it("does not retry an uncertain provider result; confirmed failure can retry once", async () => {
    const db = firestore(); const first = await submit(db); const job = getJob(db, first.id);
    Object.assign(job, { phase: "needs_reconciliation", active: false });
    await submit(db, { retry: true }); expect(getJob(db, first.id).attemptId).toBe(job.attemptId);
    Object.assign(job, { phase: "failed", retryable: true });
    await submit(db, { retry: true }); expect(getJob(db, first.id).attemptId).not.toBe(job.attemptId);
    expect(getJob(db, first.id).attempts).toBe(2);
  });
  it("recovers a lost start response by the same execution name", async () => {
    const db = firestore(); const first = await submit(db);
    const client = { send: vi.fn(async () => { const error = new Error(); error.name = "ExecutionAlreadyExists"; throw error; }) };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" }, client, now: () => now });
    expect(getJob(db, first.id).phase).toBe("running"); expect(client.send).toHaveBeenCalledTimes(1);
  });
  it("retains the cancel lock after an uncertain first start", async () => {
    const db = firestore(); const first = await submit(db);
    const client = { send: vi.fn(async () => { throw new Error("connection lost"); }) };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: {
      source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview",
    }, client, now: () => now, assertBillingEnabledFn: async () => {} });
    expect(getJob(db, first.id)).toMatchObject({ phase: "pending", failures: 1 });
    expect(getJob(db, first.id).leaseOwner).toEqual(expect.any(String));
    expect(contract.clipSummary(getJob(db, first.id), now).canCancel).toBe(false);
    db.records.set("system/billing", { disabled: true });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: {
      source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview",
    }, client, now: () => now });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(getJob(db, first.id)).toMatchObject({ phase: "pending", failures: 1,
      errorCode: "billing_unavailable" });
    expect(getJob(db, first.id).leaseOwner).toEqual(expect.any(String));
    expect(contract.clipSummary(getJob(db, first.id), now).canCancel).toBe(false);
  });
  it("keeps repeated original-check failures cancellable and recovers before dispatch", async () => {
    const db = firestore(); const first = await submit(db, { format: "original_copy" });
    const client = { send: vi.fn(async () => ({})) };
    const originalClient = { send: vi.fn(async () => { throw Object.assign(new Error("S3 timeout"), { name: "TimeoutError" }); }) };
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    const tick = () => clips.processClipTick({ firestore: db, config, client, originalClient, now: () => now,
      assertBillingEnabledFn: async () => {} });
    for (let attempt = 0; attempt < 6; attempt += 1) await tick();
    expect(client.send).not.toHaveBeenCalled();
    expect(getJob(db, first.id)).toMatchObject({ phase: "pending", active: true, leaseOwner: null,
      failures: 0, errorCode: "original_check_failed" });
    expect(contract.clipSummary(getJob(db, first.id), now).canCancel).toBe(true);
    expect(contract.clipSummary(getJob(db, first.id), now).processing.statusCode).toBe("original_check_failed");
    originalClient.send.mockResolvedValue({ VersionId: "original-v1", ContentLength: 1000 });
    await tick();
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(getJob(db, first.id)).toMatchObject({ phase: "running", errorCode: null });
  });
  it.each(["missing", "changed"])("ends a never-dispatched extraction when its original is %s", async outcome => {
    const db = firestore(); const first = await submit(db, { format: "original_copy" });
    const client = { send: vi.fn() };
    const originalClient = { send: async () => {
      if (outcome === "missing") throw Object.assign(new Error(), { name: "NoSuchKey" });
      return { VersionId: "replaced-version", ContentLength: 1000 };
    } };
    await clips.processClipTick({ firestore: db,
      config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" },
      client, originalClient, now: () => now,
      assertBillingEnabledFn: async () => {} });
    expect(client.send).not.toHaveBeenCalled();
    expect(getJob(db, first.id)).toMatchObject({ phase: "failed", active: false, leaseOwner: null,
      retryable: false, errorCode: "source_unavailable" });
    expect(await submit(db, { format: "original_copy", outMs: 6000 })).toMatchObject({ state: "queued" });
  });
  it("reconciles an uncertain extraction without a new original-read gate", async () => {
    const db = firestore(); const first = await submit(db, { format: "original_copy" });
    Object.assign(getJob(db, first.id), { leaseOwner: "previous-dispatch", failures: 1 });
    const originalClient = { send: vi.fn(async () => { throw new Error("S3 unavailable"); }) };
    const client = { send: vi.fn(async () => { throw Object.assign(new Error(), { name: "ExecutionAlreadyExists" }); }) };
    await clips.processClipTick({ firestore: db,
      config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" },
      client, originalClient, now: () => now, assertBillingEnabledFn: async () => {} });
    expect(originalClient.send).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(getJob(db, first.id)).toMatchObject({ phase: "running", failures: 0 });
  });
  it("polls a started full-source workflow beyond 48 hours from its recorded start", async () => {
    const db = firestore(); db.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 3600;
    const sourceRequest = contract.parseClipRequest({
      sourceId: source.id, assetId: "asset", scope: "source", format: "broadcast_mxf",
    }, "request");
    const first = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" },
      request: sourceRequest, now });
    let currentNow = now;
    const client = { send: vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ status: "RUNNING" }) };
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => currentNow,
      assertBillingEnabledFn: async () => {} });
    expect(getJob(db, first.id).startedAt).toBe(new Date(now).toISOString());
    currentNow += 48.5 * 60 * 60 * 1000;
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => currentNow });
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(getJob(db, first.id)).toMatchObject({ phase: "running", active: true, failures: 0 });
  });
  it("never starts processing or accepts output after source deletion", async () => {
    const db = firestore(); const first = await submit(db); db.records.get("mediaSourceAssets/asset").lifecycle = "deleted";
    const client = { send: vi.fn() }; await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client, now: () => now });
    expect(client.send).not.toHaveBeenCalled(); expect(getJob(db, first.id)).toMatchObject({ active: false, errorCode: "source_unavailable" });
  });
  it("reaches every active export in one tick when more than twenty people export at once", async () => {
    const db = firestore(); const first = await submit(db); db.records.get("mediaSourceAssets/asset").lifecycle = "deleted";
    const ids = Array.from({ length: 25 }, (_, index) => `concurrent-${index}`);
    for (const id of ids) db.records.set(`${contract.CLIP_JOBS}/${id}`, structuredClone(getJob(db, first.id)));
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client: { send: vi.fn() }, now: () => now });
    for (const id of [first.id, ...ids]) expect(getJob(db, id)).toMatchObject({ active: false, errorCode: "source_unavailable" });
  });
  it("stops leasing new exports near the tick timeout and leaves them for the next tick", async () => {
    const db = firestore(); const first = await submit(db); db.records.get("mediaSourceAssets/asset").lifecycle = "deleted";
    db.records.set(`${contract.CLIP_JOBS}/later`, structuredClone(getJob(db, first.id)));
    let clock = now; const tick = () => { const value = clock; clock += 100000; return value; };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client: { send: vi.fn() }, now: tick });
    expect([getJob(db, first.id), getJob(db, "later")].filter(job => job.active)).toHaveLength(1);
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client: { send: vi.fn() }, now: () => clock + 600000 });
    expect(getJob(db, "later")).toMatchObject({ active: false });
  });
  it("signs only exact private output versions and never beyond expiry", async () => {
    const db = firestore(); const first = await submit(db); const job = ready(getJob(db, first.id));
    job.expiresAt = new Date(now + 30000).toISOString();
    const client = { send: vi.fn(async () => ({ VersionId: "clip-v1", ContentLength: 100 })) }; const sign = vi.fn(async () => "private-test-url");
    await clips.clipRead({ renditionBucket: "private-clips" }, source, job, now, { client, sign });
    expect(client.send.mock.calls[0][0].input).toMatchObject({ VersionId: "clip-v1", ExpectedBucketOwner: source.expectedBucketOwner });
    expect(sign.mock.calls[0][2].expiresIn).toBe(30);
    await expect(clips.clipRead({}, source, job, now + 30000, { client, sign })).rejects.toMatchObject({ status: 409 });
  });
  it("signs the exact private MXF with a bounded attachment name", async () => {
    const db = firestore(); const first = await submit(db, { format: "broadcast_mxf" });
    const base = getJob(db, first.id); const job = { ...base, phase: "ready", active: false,
      expiresAt: new Date(now + 30000).toISOString(), output: broadcastOutput(base) };
    const client = { send: vi.fn(async () => ({ VersionId: "broadcast-v1", ContentLength: 1000 })) };
    const sign = vi.fn(async () => "private-test-url");
    await clips.clipRead({ renditionBucket: "private-clips" }, source, job, now, { client, sign });
    expect(sign.mock.calls[0][1].input).toMatchObject({ ResponseContentType: "application/mxf" });
    expect(sign.mock.calls[0][1].input.ResponseContentDisposition).toContain(".mxf");
  });
  it("rejects a stale or unrelated workflow output", async () => {
    const db = firestore(); const first = await submit(db); const job = ready(getJob(db, first.id));
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: "old", web: job.output })).toThrow();
    expect(() => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, web: { ...job.output, objectKey: "outputs/unrelated.mp4" } })).toThrow();
  });
  it("creates a new attempt for an expired cached export", async () => {
    const db = firestore(); const first = await submit(db); const previous = ready(getJob(db, first.id));
    previous.expiresAt = new Date(now - 1).toISOString();
    db.records.set(`${contract.CLIP_JOBS}/${first.id}`, previous);
    expect(contract.clipSummary(previous, now).state).toBe("expired");
    expect((await submit(db)).state).toBe("queued");
    expect(getJob(db, first.id).attemptId).not.toBe(previous.attemptId);
  });
  it.each([
    [JSON.stringify({ errorType: "ValueError", errorMessage: "broadcast_video_format_unsupported" }), false, "editor_video_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "prores_video_format_unsupported" }), false, "prores_video_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "avid_video_format_unsupported" }), false, "avid_video_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "broadcast_video_track_unsupported" }), false, "editor_video_track_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "broadcast_duration_unsupported" }), false, "editor_duration_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "broadcast_audio_layout_unsupported" }), false, "editor_audio_unsupported"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "clip_range_outside_input" }), false, "export_source_mismatch"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "source_export_duration_mismatch" }), true, "conversion_failed"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "broadcast_scan_type_missing" }), true, "conversion_failed"],
    [JSON.stringify({ errorType: "ValueError", errorMessage: "output_changed" }), true, "conversion_failed"],
    ["not json", true, "conversion_failed"],
  ])("saves a worker input rejection as final and other failures as retryable (%s)", async (cause, retryable, errorCode) => {
    const db = firestore(); const first = await submit(db, { format: "broadcast_mxf" });
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({}) }, now: () => now });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({ status: "FAILED", error: "ValueError", cause }) }, now: () => now });
    expect(getJob(db, first.id)).toMatchObject({ phase: "failed", active: false, retryable, errorCode });
    const summary = contract.clipSummary(getJob(db, first.id), now);
    expect(summary.canRetry).toBe(retryable);
    expect(summary.processing.statusCode).toBe(errorCode);
  });
  it.each(["range", "web copy"])("keeps an MP4 range failure final until the %s changes", async (changedInput) => {
    const db = firestore(); const first = await submit(db);
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    const cause = JSON.stringify({ errorType: "ValueError", errorMessage: "clip_range_outside_input" });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({}) }, now: () => now });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({ status: "FAILED", error: "ValueError", cause }) }, now: () => now });
    const failed = getJob(db, first.id);
    expect(failed).toMatchObject({ phase: "failed", active: false, retryable: false, errorCode: "conversion_failed" });
    expect(contract.clipSummary(failed, now).canRetry).toBe(false);
    const limitsBefore = [...db.records].filter(([key]) => key.startsWith("mediaSourceClipLimits/"));
    expect(await submit(db, { retry: true })).toMatchObject({ id: first.id, state: "failed", canRetry: false });
    expect(getJob(db, first.id)).toMatchObject({ attemptId: failed.attemptId, attempts: 1, active: false });
    expect([...db.records].filter(([key]) => key.startsWith("mediaSourceClipLimits/"))).toEqual(limitsBefore);

    // The pinned viewing-copy version and range are both part of the job identity.
    if (changedInput === "web copy") db.records.get("mediaSourceAssets/asset").rendition.web.objectVersionId = "web-v2";
    const corrected = await submit(db, changedInput === "range" ? { outMs: 4000 } : {});
    expect(corrected).toMatchObject({ state: "queued", canRetry: false });
    expect(corrected.id).not.toBe(first.id);
  });
  it("estimates a ready editor export from its codec, frame rate, duration and stored sizes", async () => {
    const db = firestore(); const first = await submit(db, { format: "broadcast_mxf" }); const job = getJob(db, first.id);
    const gib = 2 ** 30;
    Object.assign(job, { phase: "ready", active: false, sourceSizeBytes: 10 * gib,
      output: { durationSeconds: 600, frameRateNumerator: 30000, frameRateDenominator: 1001, sizeBytes: 20 * gib } });
    expect(contract.clipSummary(job, now).processing.estimatedAwsChargeUsd).toBe(0.6693);
    Object.assign(job, { format: "prores_mov", output: { ...job.output, frameRateNumerator: 60000 } });
    expect(contract.clipSummary(job, now).processing.estimatedAwsChargeUsd).toBe(1.0293);
    Object.assign(job, { sourceSizeBytes: 0, output: { ...job.output, durationSeconds: 1.2, sizeBytes: 0 } });
    expect(contract.clipSummary(job, now).processing.estimatedAwsChargeUsd).toBe(0.01);
    Object.assign(job, { expiresAt: new Date(now - 1000).toISOString() });
    expect(contract.clipSummary(job, now)).toMatchObject({ state: "expired", processing: { estimatedAwsChargeUsd: 0.01 } });
    Object.assign(job, { phase: "failed" });
    expect(contract.clipSummary(job, now).processing.estimatedAwsChargeUsd).toBeNull();
    const mp4 = getJob(db, (await submit(db)).id);
    expect(contract.clipSummary(ready(mp4), now).processing.estimatedAwsChargeUsd).toBeNull();
  });
  it.each([[640, 480, 0.024], [1920, 1080, 0.048], [1080, 1920, 0.048],
    [3840, 2160, 0.096], [2160, 3840, 0.096], [4096, 4096, null]])(
    "uses the ProRes short-side resolution price for %s x %s", async (width, height, estimate) => {
      const db = firestore(); const summary = await submit(db, { format: "prores_mov" }); const job = getJob(db, summary.id);
      Object.assign(job, { phase: "ready", active: false, sourceSizeBytes: 0,
        output: { width, height, durationSeconds: 60, frameRateNumerator: 25, frameRateDenominator: 1, sizeBytes: 0 } });
      expect(contract.clipSummary(job, now).processing.estimatedAwsChargeUsd).toBe(estimate);
    });
  it("does not turn an unknown provider state into a retryable failure", async () => {
    const db = firestore(); const first = await submit(db);
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({}) }, now: () => now });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client: { send: async () => ({ status: "UNKNOWN" }) }, now: () => now });
    expect(getJob(db, first.id)).toMatchObject({ phase: "running", failures: 1, active: true });
    expect(contract.clipSummary(getJob(db, first.id), now).canRetry).toBe(false);
  });
  it("pages newest own exports with a stable tie and excludes replaced inputs", async () => {
    const db = firestore(); const first = await submit(db); const original = getJob(db, first.id);
    db.records.delete(`${contract.CLIP_JOBS}/${first.id}`);
    const ids = Array.from({ length: 13 }, (_, index) => index.toString(16).padStart(64, "0"));
    for (let index = 0; index < 13; index++) db.records.set(`${contract.CLIP_JOBS}/${ids[index]}`, {
      ...original, id: ids[index], requestedAt: new Date(now + Math.max(index, 1) * 1000).toISOString(),
      requestedBy: index === 12 ? "other" : "staff", inputObjectVersionId: index === 11 ? "replaced" : original.inputObjectVersionId,
    });
    const listRequest = { sourceId: source.id, assetId: "asset", scope: "clip" };
    const firstPage = await clips.recentClips(db, source, listRequest, { uid: "staff" }, now);
    expect(firstPage.clips.map(job => job.id)).toEqual(ids.slice(1, 11).reverse());
    const nextRequest = contract.parseClipRequest({ ...listRequest, cursor: firstPage.nextCursor }, "get");
    expect(nextRequest.cursor).toEqual({ id: ids[1], requestedAt: new Date(now + 1000).toISOString() });
    const secondPage = await clips.recentClips(db, source, nextRequest, { uid: "staff" }, now);
    expect(secondPage.clips.map(job => job.id)).toEqual([ids[0]]);
    expect(secondPage.nextCursor).toBeNull();
    expect(contract.parseClipRequest({ sourceId: source.id, assetId: "asset" }, "get").clipId).toBeUndefined();
    expect(() => contract.parseClipRequest({ sourceId: source.id, assetId: "asset" }, "read")).toThrow();
  });
  it("rejects a history cursor owned by another actor or bound to another source version", async () => {
    const db = firestore(); const first = await submit(db); const cursor = contract.encodeClipHistoryCursor(getJob(db, first.id));
    const listRequest = contract.parseClipRequest({
      sourceId: source.id, assetId: "asset", scope: "clip", cursor,
    }, "get");
    await expect(clips.recentClips(db, source, listRequest, { uid: "other" }, now))
      .rejects.toMatchObject({ status: 400 });
    db.records.get(`${contract.CLIP_JOBS}/${first.id}`).sourceObjectVersionId = "old-original";
    await expect(clips.recentClips(db, source, listRequest, { uid: "staff" }, now))
      .rejects.toMatchObject({ status: 400 });
  });
  it("rejects a history cursor whose deterministic job moved during retry", async () => {
    const db = firestore(); const first = await submit(db); const job = getJob(db, first.id);
    const cursor = contract.encodeClipHistoryCursor(job);
    Object.assign(job, { phase: "failed", active: false, retryable: true });
    await clips.requestClip({ firestore: db, source, actor: { uid: "staff" },
      request: { ...request, retry: true }, now: now + 1000 });
    const listRequest = contract.parseClipRequest({
      sourceId: source.id, assetId: "asset", scope: "clip", cursor,
    }, "get");
    await expect(clips.recentClips(db, source, listRequest, { uid: "staff" }, now + 1000))
      .rejects.toMatchObject({ status: 400 });
  });
  it("never replays an old pending start after provider name retention", async () => {
    const db = firestore(); await submit(db); const client = { send: vi.fn() };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source }, client, now: () => now + 108 * 86400000 });
    expect(client.send).not.toHaveBeenCalled();
    expect([...db.records.values()].find(job => job.kind === "clip").phase).toBe("needs_reconciliation");
  });
  it("does not release a new download URL after deletion during storage signing", async () => {
    const db = firestore(); const first = await submit(db); const job = ready(getJob(db, first.id));
    job.expiresAt = new Date(Date.now() + 86400000).toISOString(); db.records.set(`${contract.CLIP_JOBS}/${first.id}`, job);
    const handler = clips.clipHandler("read", { firestore: db, registry: () => new Map([[source.id, source]]), config: () => ({}),
      verifyAppCheck: async () => {}, requirePrincipal: async () => ({ uid: "staff" }), authorize: async () => {},
      clipRead: async () => { db.records.get("mediaSourceAssets/asset").lifecycle = "deleted"; return { url: "private-url" }; } });
    const body = { sourceId: source.id, assetId: "asset", clipId: first.id };
    const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
    expect(res.code).toBe(404); expect(JSON.stringify(res.body)).not.toContain("private-url");
  });
  it("accepts low-rate frame rounding but rejects unrelated durations", async () => {
    const db = firestore(); const first = await submit(db); const job = ready(getJob(db, first.id));
    Object.assign(job, { inMs: 0, outMs: 250 });
    const result = { id: job.id, attemptId: job.attemptId, web: { ...job.output, durationSeconds: 1, frameDurationSeconds: 1 } };
    expect(contract.validateClipOutput(job, result)).toMatchObject({ durationSeconds: 1, frameDurationSeconds: 1 });
    expect(() => contract.validateClipOutput(job, { ...result, web: { ...result.web, durationSeconds: 4 } })).toThrow();
    expect(() => contract.validateClipOutput(job, { ...result, web: { ...result.web, frameDurationSeconds: 100 } })).toThrow();
  });
  it("keeps cached status, recent exports and downloads available while processing is off", async () => {
    const db = firestore(); const first = await submit(db); const job = ready(getJob(db, first.id));
    job.expiresAt = new Date(Date.now() + 86400000).toISOString(); db.records.set(`${contract.CLIP_JOBS}/${first.id}`, job);
    const dependencies = { firestore: db, registry: () => new Map([[source.id, source]]), config: () => null,
      readConfig: () => ({ renditionBucket: "private-cached-outputs" }),
      verifyAppCheck: async () => {}, requirePrincipal: async () => ({ uid: "staff" }), authorize: async () => {},
      clipRead: async config => { expect(config.renditionBucket).toBe("private-cached-outputs"); return { url: "private-url" }; } };
    for (const [action, body, status] of [
      ["request", request, 503], ["get", { sourceId: source.id, assetId: "asset", clipId: first.id }, 200],
      ["get", { sourceId: source.id, assetId: "asset" }, 200], ["read", { sourceId: source.id, assetId: "asset", clipId: first.id }, 200],
    ]) {
      const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
      await clips.clipHandler(action, dependencies)({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
      expect(res.code).toBe(status);
    }
    const client = { send: vi.fn() }; await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: null, client });
    expect(client.send).not.toHaveBeenCalled();
  });
  it("checks the real billing flag before start and keeps blocked jobs recoverable", async () => {
    const db = firestore(); const first = await submit(db);
    db.records.set("system/billing", { disabled: true });
    const client = { send: vi.fn(async () => ({})) };
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => now });
    expect(client.send).not.toHaveBeenCalled();
    expect(getJob(db, first.id)).toMatchObject({ phase: "pending", active: true, leaseUntil: 0,
      leaseOwner: null, failures: 0, errorCode: "billing_unavailable" });
    expect(contract.clipSummary(getJob(db, first.id), now).canCancel).toBe(true);
    db.records.set("system/billing", { disabled: false });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => now });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(getJob(db, first.id)).toMatchObject({ phase: "running", errorCode: null });
  });
  it("requires App Check before authorization or data access", async () => {
    const authorize = vi.fn(); const handler = clips.clipHandler("request", { verifyAppCheck: async () => { throw contract.problem(403, "App Check required"); }, authorize });
    const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await handler({ method: "POST", body: request, rawBody: Buffer.from(JSON.stringify(request)), headers: { "content-type": "application/json" } }, res);
    expect(res.code).toBe(403); expect(authorize).not.toHaveBeenCalled();
  });
  it("keeps editor formats disabled until their separately deployed worker is verified", async () => {
    const db = firestore(); const body = { ...request, format: "broadcast_mxf" };
    const handler = clips.clipHandler("request", { firestore: db,
      registry: () => new Map([[source.id, source]]), config: () => ({}),
      editorExportsEnabled: () => false, verifyAppCheck: async () => {},
      requirePrincipal: async () => ({ uid: "staff" }), authorize: async () => {} });
    const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)),
      headers: { "content-type": "application/json" } }, res);
    expect(res).toMatchObject({ code: 503, body: { error: "Clip export request failed" } });
    expect([...db.records.keys()].some(key => key.startsWith("mediaSourceClipJobs/"))).toBe(false);
  });
  it("reports editor export admission on list and exact status reads", async () => {
    const db = firestore(); const first = await submit(db);
    for (const enabled of [false, true]) {
      const dependencies = { firestore: db, registry: () => new Map([[source.id, source]]),
        editorExportsEnabled: () => enabled, verifyAppCheck: async () => {},
        requirePrincipal: async () => ({ uid: "staff" }), authorize: async () => {} };
      for (const body of [
        { sourceId: source.id, assetId: "asset" },
        { sourceId: source.id, assetId: "asset", clipId: first.id },
      ]) {
        const res = { set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
        await clips.clipHandler("get", dependencies)({ method: "POST", body,
          rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
        expect(res).toMatchObject({ code: 200, body: { success: true, editorExportsEnabled: enabled } });
      }
    }
  });
});


describe("29.97 export request and receipt contract", () => {
  it("defaults new editor requests to broadcast, preserves explicit source and separates identities", () => {
    for (const format of ["broadcast_mxf", "prores_mov", "avid_mxf"]) {
      const converted = contract.parseClipRequest({ ...request, format }, "request");
      expect(converted.frameRateMode).toBe("broadcast");
      const sourceRate = contract.parseClipRequest({ ...request, format, frameRateMode: "source" }, "request");
      expect(sourceRate.frameRateMode).toBe("source");
      const legacy = { ...request, format };
      expect(new Set([legacy, converted, sourceRate].map(contract.clipIdentity)).size).toBe(3);
      expect(contract.parseClipRequest({ ...request, format, retry: true }, "request").frameRateMode).toBeUndefined();
    }
    for (const fields of [{ frameRateMode: "fast" }, { format: "prores_mov", frameRateMode: ["25/1"] }, { frameRateMode: "source" }, { format: "original_copy", frameRateMode: "broadcast" }]) {
      expect(() => contract.parseClipRequest({ ...request, ...fields }, "request")).toThrow();
    }
  });
  it("permits an omitted rate only when retrying an existing legacy export", async () => {
    const db = firestore();
    const parsed = contract.parseClipRequest({ ...request, format: "prores_mov", retry: true }, "request");
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: parsed, now }))
      .rejects.toMatchObject({ status: 409 });
    expect([...db.records.keys()].some(key => key.startsWith(contract.CLIP_JOBS + "/"))).toBe(false);
    const legacy = await submit(db, { format: "prores_mov" });
    const job = db.records.get(`${contract.CLIP_JOBS}/${legacy.id}`);
    Object.assign(job, { phase: "failed", active: false, retryable: true });
    const retried = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: parsed, now });
    expect(retried).toMatchObject({ id: legacy.id, frameRateMode: null, state: "queued" });
    expect(db.records.get(`${contract.CLIP_JOBS}/${legacy.id}`).attempts).toBe(2);
  });
  it("accepts standard output choices and rejects impossible XDCAM rates before a job", () => {
    for (const mode of ["24000/1001", "24/1", "25/1", "30/1", "50/1", "60000/1001", "60/1"]) {
      for (const format of ["prores_mov", "avid_mxf"]) {
        expect(contract.parseClipRequest({ ...request, format, frameRateMode: mode }, "request").frameRateMode).toBe(mode);
      }
    }
    for (const mode of ["24/1", "30/1", "60/1"]) {
      expect(() => contract.parseClipRequest({ ...request, format: "broadcast_mxf", frameRateMode: mode }, "request")).toThrow();
    }
    const job = { ...request, format: "prores_mov", frameRateMode: "60/1" };
    expect(contract.clipIdentity(job)).not.toBe(contract.clipIdentity({ ...job, frameRateMode: "broadcast" }));
    expect(contract.clipSummary({ ...job, requestedAt: now }, now)).toMatchObject({ frameRateMode: "60/1", requestedFrameRate: "60/1" });
  });
  it("allows only full-source broadcast MP4 copies and avoids conversion of measured 29.97 originals", async () => {
    const req = contract.parseClipRequest({ sourceId: "video-library", assetId: "asset", format: "broadcast_mp4", scope: "source" }, "request");
    expect(req.frameRateMode).toBe("broadcast");
    expect(() => contract.parseClipRequest({ ...request, format: "broadcast_mp4" }, "request")).toThrow();
    const db = firestore();
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now })).rejects.toMatchObject({ status: 409 });
    Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web, { sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001 });
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now })).rejects.toThrow("already uses the chosen");
    expect([...db.records.keys()].some(key => key.startsWith(contract.CLIP_JOBS + "/"))).toBe(false);
    Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web, { sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1 });
    const result = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now });
    expect(result).toMatchObject({ format: "broadcast_mp4", frameRateMode: "broadcast", sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1 });
    const client = { send: vi.fn(async () => ({})) };
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" }, client, now: () => now, assertBillingEnabledFn: async () => {} });
    expect(JSON.parse(client.send.mock.calls[0][0].input.input)).toMatchObject({ format: "broadcast_mp4", scope: "source", frameRateMode: "broadcast" });
    expect([...db.records].filter(([key]) => key.startsWith("admin_logs/")).at(-1)[1].after).toMatchObject({ frameRateMode: "broadcast", format: "broadcast_mp4" });
  });
  it.each([[1, 2], [120, 1], [240, 1]])("refuses a measured %s/%s copy source before consuming allowance", async (numerator, denominator) => {
    const db = firestore();
    Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web, {
      sourceFrameRateNumerator: numerator, sourceFrameRateDenominator: denominator,
    });
    const req = contract.parseClipRequest({ sourceId: source.id, assetId: "asset", format: "broadcast_mp4", scope: "source" }, "request");
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now }))
      .rejects.toMatchObject({ status: 409 });
    expect([...db.records.keys()].filter(key => !key.startsWith("mediaSourceAssets/"))).toEqual([]);
  });
  it.each([1, 60])("admits the supported %s fps copy boundary", async numerator => {
    const db = firestore();
    Object.assign(db.records.get("mediaSourceAssets/asset").rendition.web, {
      sourceFrameRateNumerator: numerator, sourceFrameRateDenominator: 1,
    });
    const req = contract.parseClipRequest({ sourceId: source.id, assetId: "asset", format: "broadcast_mp4", scope: "source" }, "request");
    await expect(clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now }))
      .resolves.toMatchObject({ state: "queued", sourceFrameRateNumerator: numerator });
  });
  it("verifies video duration separately from full-source container allowance", async () => {
    const db = firestore();
    db.records.get("mediaSourceAssets/asset").rendition.web.durationSeconds = 12;
    const req = contract.parseClipRequest({ sourceId: source.id, assetId: "asset", format: "broadcast_mxf", scope: "source" }, "request");
    const summary = await clips.requestClip({ firestore: db, source, actor: { uid: "staff" }, request: req, now });
    const job = getJob(db, summary.id);
    expect(job.outMs).toBe(12000);
    const output = broadcastOutput(job, { sourceStartSeconds: 0, sourceEndSeconds: 10, durationSeconds: 10.03,
      sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1, sourceFrameDurationSeconds: 0.04,
      scanType: "progressive", conversionMethod: "interpolate" });
    const result = { id: job.id, attemptId: job.attemptId, broadcast: output };
    expect(contract.validateClipOutput(job, result)).toMatchObject({ sourceEndSeconds: 10, durationSeconds: 10.03 });
    expect(() => contract.validateClipOutput(job, { ...result, broadcast: { ...output, durationSeconds: 10.04 } }))
      .toThrow("clip_output_duration_invalid");
    expect([...db.records].find(([key]) => key.startsWith("mediaSourceClipLimits/day-"))[1].editorSeconds).toBe(12);
  });
  it.each([[25, 1], [60000, 1001]])("accepts 4K ProRes broadcast output from a %s/%s source", (numerator, denominator) => {
    const job = { id: "a".repeat(64), attemptId: "attempt", sourceId: "video-library", assetId: "asset",
      format: "prores_mov", scope: "source", frameRateMode: "broadcast", inMs: 0, outMs: 10000 };
    const output = broadcastOutput(job, {
      objectKey: `outputs/clips/${job.id}/${job.attemptId}/prores.mov`, mimeType: "video/quicktime",
      container: "quicktime", videoCodec: "prores", profile: "prores_422_hq", width: 3840, height: 2160,
      scanType: "progressive", durationSeconds: 10, sourceStartSeconds: 0, sourceEndSeconds: 10,
      sourceFrameDurationSeconds: denominator / numerator, sourceFrameRateNumerator: numerator,
      sourceFrameRateDenominator: denominator, conversionMethod: "interpolate",
    });
    const check = (fields = {}) => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId,
      prores: { ...output, ...fields } });
    expect(check()).toMatchObject({ width: 3840, height: 2160, frameRateNumerator: 30000,
      frameRateDenominator: 1001, conversionMethod: "interpolate" });
    expect(() => check({ width: 4098 })).toThrow("clip_output_invalid");
    expect(() => check({ frameRateNumerator: numerator, frameRateDenominator: denominator })).toThrow("clip_output_frame_rate_invalid");
  });
  it("rejects wrong output rate, method, and duration beyond one 29.97 frame", () => {
    const job = { id: "a".repeat(64), attemptId: "attempt", sourceId: "video-library", assetId: "asset", format: "broadcast_mxf", scope: "source", frameRateMode: "broadcast", inMs: 0, outMs: 10000 };
    const output = broadcastOutput(job, { durationSeconds: 10, sourceStartSeconds: 0, sourceEndSeconds: 10,
      sourceFrameDurationSeconds: 1 / 25, sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1, conversionMethod: "interpolate" });
    const check = (fields = {}) => contract.validateClipOutput(job, { id: job.id, attemptId: job.attemptId, broadcast: { ...output, ...fields } });
    expect(check()).toMatchObject({ frameRateNumerator: 30000, frameRateDenominator: 1001, conversionMethod: "interpolate" });
    for (const changed of [{ frameRateNumerator: 25, frameRateDenominator: 1 }, { conversionMethod: "none" }, { sourceFrameRateDenominator: 0 }, { durationSeconds: 10.04 }]) expect(() => check(changed)).toThrow();
    expect(() => check({ durationSeconds: 10.03 })).not.toThrow();
    const keep = { ...job, frameRateMode: "source" };
    expect(contract.validateClipOutput(keep, { id: job.id, attemptId: job.attemptId, broadcast: { ...output, frameRateNumerator: 25, frameRateDenominator: 1, conversionMethod: "none" } }).frameRateNumerator).toBe(25);
  });
});

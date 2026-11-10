import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import clips from "../../functions/video-clips.js";
import contract from "../../functions/lib/video-clip-contract.js";
import rendition from "../../functions/lib/source-media-rendition.js";

const db = isolatedFirestore("original-video-clips.test.js");
const source = { id: "video-library", prefix: "objects/" };
let actors;
let assetId;
let refs;
const hash = value => createHash("sha256").update(value).digest("hex");
const now = Date.parse("2026-10-03T12:00:00Z");
const fixture = name => JSON.parse(readFileSync(new URL(`../../infrastructure/boardwalk-original-clips/fixture-${name}.json`, import.meta.url), "utf8"));

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.GCLOUD_PROJECT?.startsWith("demo-")) {
    throw new Error("Use the demo Firestore emulator");
  }
});
beforeEach(async () => {
  actors = [0, 1].map(() => ({ uid: `original-copy-${randomUUID()}` }));
  assetId = `original-${randomUUID()}`;
  refs = [db.collection("mediaSourceAssets").doc(assetId),
    db.collection("mediaSourceClipLimits").doc("original-active"),
    db.collection("mediaSourceClipLimits").doc("day-2026-10-03"),
    ...actors.map(actor => db.collection("mediaSourceClipLimits").doc(hash(actor.uid)))];
  const asset = { sourceId: source.id, lifecycle: "active", name: "Video", nameSort: "video", originalName: "video.mp4",
    updatedAtSort: new Date(now).toISOString(), mimeType: "video/mp4", kind: "video", sizeBytes: 1000,
    preview: "browser", rightsStatus: "pending", tags: [], version: 1,
    objectKey: "objects/video.mp4", objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix({ ...asset, id: assetId }, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: 1000, attemptId: "viewing-attempt", updatedAt: new Date(now).toISOString(),
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 120 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" } };
  await refs[0].set(asset);
});
afterEach(async () => {
  for (const actor of actors) {
    for (const [collection, field] of [[contract.CLIP_JOBS, "requestedBy"], ["admin_logs", "actorUid"]]) {
      const snapshot = await db.collection(collection).where(field, "==", actor.uid).get();
      refs.push(...snapshot.docs.map(doc => doc.ref));
    }
  }
  await Promise.all(refs.map(ref => ref.delete()));
});
const request = inMs => ({ sourceId: source.id, assetId, scope: "clip", format: "original_copy", inMs, outMs: inMs + 4000 });

describe("original-range admission", () => {
  it("accepts the independently decoded fixture receipt and rejects replaced inputs or incomplete ranges", () => {
    const job = fixture("job");
    const receipt = fixture("receipt");
    expect(contract.validateClipOutput(job, receipt)).toMatchObject({ sourceStartSeconds: 2, sourceEndSeconds: 6,
      videoCodec: "h264", durationSeconds: 4 });
    expect(() => contract.validateClipOutput({ ...job, sourceObjectVersionId: "replaced" }, receipt)).toThrow();
    const short = structuredClone(receipt);
    short.original.sourceEndSeconds = 4;
    expect(() => contract.validateClipOutput(job, short)).toThrow("original_output_timing_invalid");
    const incomplete = structuredClone(receipt);
    incomplete.original.provenance.streams = [];
    expect(() => contract.validateClipOutput(job, incomplete)).toThrow();
  });

  it.each(["FAILED", "TIMED_OUT", "ABORTED", "source replaced"])("keeps the global extraction slot until an uncertain outcome is reconciled: %s", async status => {
    const admitted = await clips.requestClip({ firestore: db, source, actor: actors[0], request: request(1000), now });
    const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
    const tick = client => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => now, assertBillingEnabledFn: async () => {} });
    await tick({ send: async () => ({}) });
    if (status === "source replaced") await refs[0].update({ objectVersionId: "replacement" });
    await tick({ send: async () => ({ status, cause: "unknown integration outcome" }) });
    expect((await db.collection(contract.CLIP_JOBS).doc(admitted.id).get()).data()).toMatchObject({
      phase: "needs_reconciliation", active: false, retryable: false, errorCode: "processing_unconfirmed",
    });
    if (status === "source replaced") await refs[0].update({ objectVersionId: "original-v1" });
    await expect(clips.requestClip({ firestore: db, source, actor: actors[1], request: request(10000), now }))
      .rejects.toMatchObject({ status: 429 });
  });

  it("admits one extraction globally under concurrent requests from different staff", async () => {
    const results = await Promise.allSettled(actors.map((actor, index) => clips.requestClip({
      firestore: db, source, actor, request: request(1000 + index * 1000), now,
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected").reason).toMatchObject({ status: 429 });
    const admitted = results.find(result => result.status === "fulfilled").value;
    const stored = (await db.collection(contract.CLIP_JOBS).doc(admitted.id).get()).data();
    expect(clips.providerInput(stored)).toMatchObject({ format: "original_copy", sourceObjectVersionId: "original-v1" });
    const cancelled = await clips.cancelClip(db, source, { ...request(1000), clipId: stored.id, attemptId: stored.attemptId },
      actors.find(actor => actor.uid === stored.requestedBy), now);
    expect(cancelled.state).toBe("cancelled");
    await expect(clips.requestClip({ firestore: db, source, actor: actors[1], request: request(10000), now })).resolves.toMatchObject({ format: "original_copy" });
  });

  it.each(["accepted", "ambiguous"])("holds the extraction slot when the source changes during %s dispatch", async outcome => {
    const admitted = await clips.requestClip({ firestore: db, source, actor: actors[0], request: request(1000), now });
    await clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db,
      config: { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" },
      now: () => now, assertBillingEnabledFn: async () => {},
      client: { send: async () => {
        await refs[0].update({ objectVersionId: "replacement" });
        if (outcome === "ambiguous") throw new Error("Connection lost after dispatch");
        return {};
      } },
    });
    expect((await db.collection(contract.CLIP_JOBS).doc(admitted.id).get()).data()).toMatchObject({
      phase: "needs_reconciliation", active: false, retryable: false, errorCode: "processing_unconfirmed",
    });
    await refs[0].update({ objectVersionId: "original-v1" });
    await expect(clips.requestClip({ firestore: db, source, actor: actors[1], request: request(10000), now }))
      .rejects.toMatchObject({ status: 429 });
  });

  it("does not dispatch a second extraction when the previous outcome needs reconciliation", async () => {
    const admitted = await clips.requestClip({ firestore: db, source, actor: actors[0], request: request(1000), now });
    await db.collection(contract.CLIP_JOBS).doc(admitted.id).update({ active: false, phase: "needs_reconciliation" });
    await expect(clips.requestClip({ firestore: db, source, actor: actors[1], request: request(10000), now }))
      .rejects.toMatchObject({ status: 429 });
  });

  it("rejects full-source processing and keeps original copy identity distinct from encoded exports", async () => {
    expect(() => contract.parseClipRequest({ sourceId: source.id, assetId, scope: "source", format: "original_copy" }, "request")).toThrow();
    const admitted = await clips.requestClip({ firestore: db, source, actor: actors[0], request: request(1000), now });
    const stored = (await db.collection(contract.CLIP_JOBS).doc(admitted.id).get()).data();
    expect(contract.clipIdentity({ ...stored, format: "prores_mov" })).not.toBe(admitted.id);
    expect(contract.clipIdentity({ ...stored, sourceObjectVersionId: "replaced" })).not.toBe(admitted.id);
  });
});

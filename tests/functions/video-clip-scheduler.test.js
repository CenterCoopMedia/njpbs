import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import clips from "../../functions/video-clips.js";
import contract from "../../functions/lib/video-clip-contract.js";
import rendition from "../../functions/lib/source-media-rendition.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const source = { id: "video-library", prefix: "objects/" };
const config = { source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:preview" };
let db;
let refs = [];

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.GCLOUD_PROJECT?.startsWith("demo-")) {
    throw new Error("Use the demo Firestore emulator");
  }
  db = isolatedFirestore("video-clip-scheduler.test.js");
});
afterEach(async () => {
  const batch = db.batch();
  for (const ref of refs) batch.delete(ref);
  await batch.commit();
  refs = [];
});

async function seed(count) {
  const asset = { id: "clip-scheduler-asset", sourceId: source.id, lifecycle: "active", name: "Video", nameSort: "video",
    originalName: "video.mp4", updatedAtSort: new Date(now).toISOString(), mimeType: "video/mp4", kind: "video",
    sizeBytes: 1000, preview: "browser", rightsStatus: "pending", tags: [], version: 1,
    objectKey: "objects/video.mp4", objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    attemptId: "viewing-attempt", updatedAt: new Date(now).toISOString(),
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 120 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" } };
  const jobs = Array.from({ length: count }, (_, index) => {
    const id = `clip-${String(index).padStart(3, "0")}`;
    return { id, assetId: asset.id, sourceId: source.id, kind: "clip", scope: "clip", format: "web_mp4",
      sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
      inputObjectKey: asset.rendition.web.objectKey, inputObjectVersionId: "web-v1", inputSizeBytes: 500,
      inMs: 1000, outMs: 5000, attemptId: "attempt", phase: "running", active: true, leaseUntil: 0, failures: 0,
      requestedAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
      executionArn: `arn:aws:states:us-east-2:123456789012:execution:preview:${id}-attempt` };
  });
  const assetRef = db.collection("mediaSourceAssets").doc(asset.id);
  const jobRefs = jobs.map(job => db.collection(contract.CLIP_JOBS).doc(job.id));
  refs = [assetRef, db.collection("system").doc("videoClipScheduler"), ...jobRefs];
  const batch = db.batch();
  batch.set(assetRef, asset);
  jobs.forEach((job, index) => batch.set(jobRefs[index], job));
  await batch.commit();
  return { jobs, jobRefs };
}

describe("clip scheduler rotation", () => {
  it.each(["RUNNING", "provider error"])("reaches every persistent active job across budget-limited ticks: %s", async outcome => {
    const { jobs, jobRefs } = await seed(5);
    let clock = now;
    const polled = [];
    const client = { send: async command => {
      polled.push(command.input.executionArn);
      clock += 91000;
      if (outcome === "provider error") throw new Error("Temporary provider failure");
      return { status: outcome };
    } };
    const tick = () => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => clock });
    await tick();
    expect(polled).toEqual(jobs.slice(0, 2).map(job => job.executionArn));
    await tick();
    await tick();
    expect(polled).toEqual(jobs.map(job => job.executionArn));
    for (const ref of jobRefs) expect((await ref.get()).data()).toMatchObject({ active: true, phase: "running" });
    await tick();
    expect(polled.slice(5)).toEqual(jobs.slice(0, 2).map(job => job.executionArn));
  });

  it("continues past a full scan page of leased jobs", async () => {
    const { jobs, jobRefs } = await seed(123);
    const batch = db.batch();
    for (const ref of jobRefs.slice(0, 120)) batch.update(ref, { leaseUntil: now + 300000, leaseOwner: "other-worker" });
    await batch.commit();
    const polled = [];
    const client = { send: async command => { polled.push(command.input.executionArn); return { status: "RUNNING" }; } };
    const tick = () => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => now });
    await tick();
    expect(polled).toEqual([]);
    await tick();
    expect(polled).toEqual(jobs.slice(120).map(job => job.executionArn));
  });

  it("continues after a deleted cursor job and wraps to earlier active jobs", async () => {
    const { jobs, jobRefs } = await seed(3);
    let clock = now;
    const polled = [];
    const client = { send: async command => {
      polled.push(command.input.executionArn);
      clock += 91000;
      return { status: "RUNNING" };
    } };
    const tick = () => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => clock });
    await tick();
    expect(polled).toEqual(jobs.slice(0, 2).map(job => job.executionArn));
    await jobRefs[1].delete();
    await tick();
    expect(polled).toEqual(jobs.map(job => job.executionArn));
    await tick();
    expect(polled.slice(3)).toEqual([jobs[0].executionArn, jobs[2].executionArn]);
  });

  it("preserves another invocation's job lease and revisits it after expiry", async () => {
    const { jobs, jobRefs } = await seed(3);
    await jobRefs[0].update({ leaseUntil: now + 300000, leaseOwner: "other-worker" });
    const polled = [];
    let clock = now;
    const client = { send: async command => { polled.push(command.input.executionArn); return { status: "RUNNING" }; } };
    const tick = () => clips.processClipTick({ originalClient: { send: async () => ({ VersionId: "original-v1", ContentLength: 1000 }) }, firestore: db, config, client, now: () => clock });
    await tick();
    expect(polled).toEqual(jobs.slice(1).map(job => job.executionArn));
    expect((await jobRefs[0].get()).data()).toMatchObject({ leaseUntil: now + 300000, leaseOwner: "other-worker" });
    clock += 300001;
    await tick();
    expect(polled.slice(2)).toEqual(jobs.map(job => job.executionArn));
  });
});

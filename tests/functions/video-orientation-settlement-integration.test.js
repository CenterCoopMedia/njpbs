import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import exports from "../../functions/lib/video-orientation-export.js";
import scheduler from "../../functions/video-transcripts.js";
import uploads from "../../functions/source-media-uploads.js";
import worker from "../../functions/lib/video-transcript-worker.js";

const at = 1_800_000_000_000;
const deadline = at + 2 * 3600_000;
const source = { id: "video-library", bucket: "originals", prefix: "" };
const actor = { uid: "staff", email: "staff@example.test" };
const output = { sizeBytes: 4000, sha256: "b".repeat(64) };
const config = { enabled: false, source, bucket: "renditions", accountId: "123456789012", controlRoleArn: "role" };
let firestore;
let stored;
const uploader = {
  signPut: async () => ({ url: "https://upload.example.test/output.mp4" }),
  head: async (_source, session) => {
    if (!stored) throw Object.assign(new Error("missing"), { name: "NotFound" });
    return { VersionId: "export-v1", ContentLength: session.sizeBytes, ChecksumSHA256: session.checksumSha256,
      Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId } };
  },
};
const assetRef = () => firestore.collection("mediaSourceAssets").doc("asset");
const jobRef = job => firestore.collection(exports.EXPORTS).doc(job.id);
const holdRef = job => firestore.collection("mediaSourcePreviewJobs").doc(uploads.previewHoldId(job.id));

async function issued(orientation = "vertical") {
  const { job } = await exports.requestExport({ firestore, request: { sourceId: source.id, assetId: "asset", orientation }, actor, now: at });
  const lease = await exports.claimExportJob({ firestore, now: at });
  await exports.completeExportJob({ firestore, source, now: at, uploader, objectKeyFn: uploads.objectKey,
    assertBillingEnabled: async () => {}, request: { jobId: job.id, leaseToken: lease.leaseToken,
      output, uploaded: false } });
  return job;
}
const tick = (now = deadline) => scheduler.processTranscriptTick({ firestore, config, uploader, now: () => now });

beforeAll(() => { firestore = isolatedFirestore("orientation-settlement"); });
beforeEach(async () => {
  stored = false;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${firestore.projectId}/databases/(default)/documents`, { method: "DELETE" }, firestore);
  await assetRef().set({ id: "asset", sourceId: source.id, lifecycle: "active", kind: "video", name: "Original meeting",
    originalName: "original.mov", description: "Original description", credit: "Original credit", license: "Original license",
    tags: ["original"], rightsStatus: "complete", objectKey: "objects/asset.mov", objectVersionId: "original-v1", sizeBytes: 100,
    rendition: { state: "ready", web: { objectKey: "outputs/asset/web.mp4", objectVersionId: "web-v1", sizeBytes: 50, durationSeconds: 30 } } });
});

describe("scheduled orientation upload settlement", () => {
  it.each([false, true])("uses metadata from the exported original when replaced=%s", async replaced => {
    const job = await issued();
    const changes = { name: "Edited", originalName: "edited.mov", description: "Edited description", credit: "Edited credit",
      license: "Edited license", tags: ["edited"], rightsStatus: "missing" };
    await assetRef().update({ ...changes, ...(replaced ? { objectVersionId: "replacement-v2" } : {}) });
    stored = true;
    const { leaseToken } = (await jobRef(job).get()).data();
    await exports.completeExportJob({ firestore, source, now: at, clock: () => at, uploader,
      objectKeyFn: uploads.objectKey, completedAssetFn: uploads.completedAsset, assertBillingEnabled: async () => {},
      request: { jobId: job.id, leaseToken, output, uploaded: true } });
    const prefix = replaced ? "Original" : "Edited";
    expect((await firestore.collection("mediaSourceAssets").doc(job.outputAssetId).get()).data()).toMatchObject({
      name: `${prefix}${replaced ? " meeting" : ""} (vertical)`, originalName: `${prefix.toLowerCase()}-vertical.mp4`,
      description: `${prefix} description`, credit: `${prefix} credit`, license: `${prefix} license`,
      tags: [prefix.toLowerCase()], rightsStatus: replaced ? "complete" : "missing" });
  });

  it("releases both staff reservations without a worker or enabled transcription", async () => {
    const jobs = [await issued("vertical"), await issued("horizontal")];
    await tick(deadline - 1);
    for (const job of jobs) expect((await holdRef(job).get()).data().active).toBe(true);
    expect(await tick()).toEqual({ enabled: false });
    for (const job of jobs) {
      expect((await jobRef(job).get()).data()).toMatchObject({ phase: "failed", active: false, errorCode: "export_upload_failed" });
      expect((await holdRef(job).get()).data()).toMatchObject({ active: false, phase: "released" });
    }
    // Staff uploads use this same admission query and can proceed again.
    const active = await firestore.collection("mediaSourcePreviewJobs").where("actorUid", "==", actor.uid).where("active", "==", true).get();
    expect(() => uploads.assertPreviewCapacity(active, active)).not.toThrow();
  });

  it("adopts a stored upload once, preserves replacement metadata, and leaves a busy render slot alone", async () => {
    const job = await issued();
    await assetRef().update({ objectVersionId: "replacement-v2", name: "Replacement", originalName: "replacement.mov",
      description: "Replacement description", credit: "Replacement credit", license: "Replacement license",
      tags: ["replacement"], rightsStatus: "missing" });
    const slot = firestore.collection(worker.WORKERS).doc(worker.WORKER_ID);
    const busy = { kind: "transcript", jobId: "other-job", leaseUntil: deadline + 60_000 };
    await slot.set(busy);
    stored = true;
    await Promise.all([tick(), tick()]);
    await tick();
    expect((await firestore.collection("mediaSourceAssets").doc(job.outputAssetId).get()).data()).toMatchObject({
      name: "Original meeting (vertical)", originalName: "original-vertical.mp4", description: "Original description",
      credit: "Original credit", license: "Original license", tags: ["original"], rightsStatus: "complete" });
    expect((await jobRef(job).get()).data()).toMatchObject({ phase: "complete", active: false });
    expect((await holdRef(job).get()).data()).toMatchObject({ active: false, phase: "consumed" });
    expect((await slot.get()).data()).toEqual(busy);
    expect((await firestore.collection("mediaSourceAssets").get()).size).toBe(2);
  });
});

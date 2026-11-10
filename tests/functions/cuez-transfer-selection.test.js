import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import selection from "../../functions/lib/cuez-transfer-selection.js";
import sourceContract from "../../functions/lib/source-media-contract.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import clips from "../../functions/lib/video-clip-contract.js";
import transcripts from "../../functions/lib/video-transcript-contract.js";
import byok from "../../functions/lib/video-transcript-byok-job.js";
import fallback from "../../functions/lib/video-transcript-fallback-policy.js";
const db = isolatedFirestore("cuez-selection");
const now = Date.parse("2026-10-29T15:00:00Z");
const source = { id: "video-library", bucket: "test-originals", prefix: "objects/", writable: true, access: "active_staff" };
const newsdeskId = "test-newsdesk";
const registry = new Map([[source.id, source]]);
let asset, clip, transcript, aroundId;
const ref = (collection, id) => db.collection(collection).doc(id);
const prepare = request => selection.prepareExportSelection({ firestore: db, request, actorUid: "staff",
  newsdeskId, registry, renditionBucket: "test-renditions", now });
async function request(kind, targetKind) {
  const video = { kind, sourceId: source.id, assetId: "asset", expectedVersion: 1,
    fileVersion: sourceContract.sourceMediaFileVersion(asset.objectVersionId),
    expectedUpdateTime: selection.documentRevision(await ref("mediaSourceAssets", "asset").get()) };
  let chosen = video;
  if (kind === "clip") Object.assign(chosen, { clipId: clip.id, expectedClipOutput: {
    attemptId: clip.attemptId, objectKey: clip.output.objectKey, objectVersionId: clip.output.objectVersionId,
    sizeBytes: clip.output.sizeBytes }, expectedJobUpdateTime: selection.documentRevision(await ref(clips.CLIP_JOBS, clip.id).get()) });
  if (kind === "transcript") Object.assign(chosen, { transcriptId: transcript.id, expectedEditRevision: transcript.editRevision,
    expectedJobUpdateTime: selection.documentRevision(await ref("mediaSourceTranscriptJobs", transcript.id).get()) });
  if (["image", "post", "around-nj"].includes(kind)) {
    const collection = { image: "media_assets", post: "cmsPosts", "around-nj": "aroundNjStories" }[kind];
    const id = { image: "image", post: "post", "around-nj": aroundId }[kind];
    chosen = { kind, ...(kind === "image" ? { assetId: id } : { recordId: id }),
      ...(kind === "around-nj" ? {} : { expectedVersion: 1 }),
      expectedUpdateTime: selection.documentRevision(await ref(collection, id).get()) };
  }
  const target = targetKind ?? ({ transcript: "dossier", post: "new-story", "around-nj": "new-story" }[kind] ?? "story-asset");
  return { workspaceId: newsdeskId, selection: chosen,
    target: { kind: target, ...(target === "new-story" ? {} : { storyId: "story-one" }) }, mappingVersion: 1 };
}
beforeEach(async () => {
  await Promise.all(["mediaSourceAssets", clips.CLIP_JOBS, "mediaSourceTranscriptJobs", "media_assets", "cmsPosts",
    "aroundNjStories", "users", "mediaSourceOriginalStatus", "system/media/replacements"].map(name => db.recursiveDelete(db.collection(name))));
  asset = { id: "asset", sourceId: source.id, lifecycle: "active", name: "Selected video", originalName: "source.mp4",
    nameSort: "selected video", updatedAtSort: "2026-10-29T12:00:00Z", mimeType: "video/mp4", kind: "video",
    sizeBytes: 1000, preview: "browser", rightsStatus: "complete", tags: [], version: 1,
    objectKey: "objects/source.mp4", objectVersionId: "original-v1" };
  const prefix = renditions.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    attemptId: "viewing-attempt", updatedAt: "2026-10-29T12:00:00Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 60 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 10, mimeType: "image/jpeg" } };
  clip = { sourceId: source.id, assetId: asset.id, sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    inputObjectKey: asset.rendition.web.objectKey, inputObjectVersionId: "web-v1", inputSizeBytes: 500,
    inMs: 1000, outMs: 5000, attemptId: "clip-attempt", phase: "ready", expiresAt: "2026-10-30T15:00:00Z" };
  clip.id = clips.clipIdentity(clip);
  clip.output = { objectKey: `outputs/clips/${clip.id}/clip-attempt/preview.mp4`,
    objectVersionId: "clip-v1", sizeBytes: 100, durationSeconds: 4 };
  const settings = { languageCode: "en-US", maxSpeakers: 2 };
  transcript = { id: transcripts.transcriptId(asset, source.bucket, settings), sourceId: source.id, assetId: asset.id,
    sourceBucket: source.bucket, sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, ...settings, phase: "ready", editRevision: 0,
    outputs: { "segments.json": "segments-v1", txt: "text-v1" }, speakerNames: { spk_0: "Reporter" } };
  const canonicalUrl = "https://outlet.example.test/story";
  aroundId = createHash("sha256").update(canonicalUrl).digest("hex");
  await Promise.all([
    ref("users", "staff").set({ active: true, role: "admin", emailVerified: true }),
    ref("mediaSourceAssets", "asset").set(asset), ref(clips.CLIP_JOBS, clip.id).set(clip),
    ref("mediaSourceTranscriptJobs", transcript.id).set(transcript),
    ref("media_assets", "image").set({ name: "Image", originalName: "image.png", lifecycle: "active", version: 1,
      category: "news", kind: "image", mimeType: "image/png", sizeBytes: 100, width: 10, height: 10,
      storageKey: "cms-media/news/image/hash.png", url: "https://media.example.test/image.png" }),
    ref("cmsPosts", "post").set({ title: "Post", version: 1, status: "draft", authorUid: "staff", section: "news" }),
    ref("aroundNjStories", aroundId).set({ canonicalUrl, headline: "Partner headline", outlet: "Example outlet",
      partner: true, summary: "Feed summary", lastSeenAt: "2026-10-29T12:00:00Z" }),
  ]);
});
describe("server selection preparation", () => {
  it.each(["original_copy", "broadcast_mxf", "prores_mov", "avid_mxf", "broadcast_mp4"])("refuses ready %s outputs as web clips", async format => {
    clip = { ...clip, scope: format === "broadcast_mp4" ? "source" : "clip", format };
    clip.id = clips.clipIdentity(clip);
    clip.output.objectKey = `outputs/clips/${clip.id}/clip-attempt/original.mov`;
    await ref(clips.CLIP_JOBS, clip.id).set(clip);
    await expect(prepare(await request("clip"))).rejects.toMatchObject({ code: "output_unavailable" });
  });
  it("refuses a full-source original job selected as a clip", async () => {
    clip = { ...clip, scope: "source", format: "original_copy" };
    clip.id = clips.clipIdentity(clip);
    clip.output.objectKey = `outputs/clips/${clip.id}/clip-attempt/original.mov`;
    await ref(clips.CLIP_JOBS, clip.id).set(clip);
    await expect(prepare(await request("clip"))).rejects.toMatchObject({ code: "output_unavailable" });
  });
  it.each(["archived", "restoring"])("accepts a ready viewing copy with an %s original", async state => {
    await ref("mediaSourceOriginalStatus", asset.id).set({ state, sourceId: asset.sourceId,
      objectKey: asset.objectKey, objectVersionId: asset.objectVersionId, sizeBytes: asset.sizeBytes,
      checkedAt: "2026-10-29T12:00:00Z" });
    expect((await prepare(await request("video"))).resolvedSelection.original.objectVersionId).toBe("original-v1");
    await ref("mediaSourceAssets", asset.id).update({ rendition: null });
    await expect(prepare(await request("video"))).rejects.toMatchObject({ code: "output_unavailable" });
  });
  it.each(["video", "clip", "image", "transcript", "post", "around-nj"])("resolves %s with identities only and rejects a subsequent edit", async kind => {
    const input = await request(kind);
    const result = await prepare(input);
    expect(result.selectionSnapshot).toEqual(input);
    expect(result.initiatedBy).toBe("staff");
    const record = result.resolvedSelection.record;
    expect(record.updateTime).toBe(input.selection.expectedUpdateTime);
    expect(JSON.stringify(result)).not.toMatch(/Feed summary|Partner headline|Reporter|https:|Selected video/);
    await ref(record.collection, record.recordId).update({ description: "Changed without version increment" });
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
  });
  it("records selected clip attempt and cached transcript output versions without creating work", async () => {
    const selectedClip = await prepare(await request("clip"));
    expect(selectedClip.resolvedSelection.clip).toMatchObject({ jobId: clip.id, attemptId: "clip-attempt",
      objectVersionId: "clip-v1", inMs: 1000, outMs: 5000, durationSeconds: 4 });
    const selectedTranscript = await prepare(await request("transcript"));
    expect(selectedTranscript.resolvedSelection.transcript).toMatchObject({ jobId: transcript.id, editRevision: 0,
      segments: { objectVersionId: "segments-v1" }, text: { objectVersionId: "text-v1" } });
    expect((await db.collection(clips.CLIP_JOBS).get()).size).toBe(1);
    expect((await db.collection("mediaSourceTranscriptJobs").get()).size).toBe(1);
    expect((await db.collection("cuezTransferOperations").get()).empty).toBe(true);
  });
  it.each(["file", "version", "deleted"])("refuses a selected video after %s changes", async change => {
    const input = await request("video");
    await ref("mediaSourceAssets", "asset").update({ file: { objectVersionId: "original-v2" },
      version: { version: 2 }, deleted: { lifecycle: "deleted" } }[change]);
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
  });
  it("rejects forged file and clip output identities", async () => {
    const input = await request("video"); input.selection.fileVersion = "other-file";
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
    const selected = await request("clip"); selected.selection.expectedClipOutput.objectVersionId = "other-output";
    await expect(prepare(selected)).rejects.toMatchObject({ code: "selection_changed" });
  });
  it("refuses expired clips, changed transcript edits and in-flight image replacement", async () => {
    await ref(clips.CLIP_JOBS, clip.id).update({ expiresAt: "2026-10-28T12:00:00Z" });
    await expect(prepare(await request("clip"))).rejects.toMatchObject({ code: "output_unavailable" });
    const input = await request("transcript");
    await ref("mediaSourceTranscriptJobs", transcript.id).update({ editedOutputs: { "segments.json": "edit-v2", txt: "text-v2" } });
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
    await ref("system/media/replacements", "image").set({ active: true });
    await expect(prepare(await request("image"))).rejects.toMatchObject({ code: "selection_changed" });
  });
  it("rechecks stored account authority and section-scoped Post access", async () => {
    const input = await request("post");
    await ref("users", "staff").set({ active: true, grants: [{ role: "contributor", sections: ["other"] }] });
    await expect(prepare(input)).rejects.toMatchObject({ code: "not_authorized" });
    await ref("users", "staff").set({ active: false, role: "admin" });
    await expect(prepare(await request("video"))).rejects.toMatchObject({ code: "not_authorized" });
  });
  it("refuses absent or expired Around NJ records and mismatched configured newsdesks", async () => {
    const input = await request("around-nj");
    await ref("aroundNjStories", aroundId).update({ lastSeenAt: "2025-01-01T00:00:00Z" });
    await expect(prepare(await request("around-nj"))).rejects.toMatchObject({ code: "output_unavailable" });
    await ref("aroundNjStories", aroundId).delete();
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
    await expect(prepare({ ...await request("video"), workspaceId: "other" })).rejects.toMatchObject({ code: "not_configured" });
  });
  it("uses the transcript owner's edited output identities and refuses missing cached text", async () => {
    await ref("mediaSourceTranscriptJobs", transcript.id).update({ editRevision: 1,
      editedOutputs: { "segments.json": "edited-segments", txt: "edited-text" } });
    transcript.editRevision = 1;
    const result = await prepare(await request("transcript"));
    expect(result.resolvedSelection.transcript.text).toEqual({
      objectKey: `transcripts/results/${transcript.id}.edited.txt`, objectVersionId: "edited-text" });
    await ref("mediaSourceTranscriptJobs", transcript.id).update({ editedOutputs: { "segments.json": "edited-segments" } });
    await expect(prepare(await request("transcript"))).rejects.toMatchObject({ code: "output_unavailable" });
  });
  it("retains validated origin markers and rejects malformed ones", async () => {
    const marker = { system: "external", operationId: "a".repeat(64), mappingId: null };
    await ref("cmsPosts", "post").update({ cuezOrigin: marker });
    expect((await prepare(await request("post"))).origin).toEqual(marker);
    await ref("cmsPosts", "post").update({ cuezOrigin: { ...marker, operationId: "bad" } });
    await expect(prepare(await request("post"))).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("binds a paid-fallback selection to the child returned by the transcript owner", async () => {
    const child = byok.createJob({ sourceId: source.id, assetId: asset.id, originalBucket: source.bucket,
      originalKey: asset.objectKey, originalVersion: asset.objectVersionId, originalSize: asset.sizeBytes,
      renditionBucket: "test-renditions", renditionKey: asset.rendition.web.objectKey,
      renditionVersion: "web-v1", renditionSize: 500, durationSeconds: 60,
      languageCode: "en-US", maxSpeakers: 2, credentialScope: "organization",
      credentialId: createHash("sha256").update(JSON.stringify(["credential-v1", "organization", null, "elevenlabs"])).digest("hex"),
      credentialRevision: 1 }, { uid: "staff" }, now);
    Object.assign(child, { phase: "ready", active: false, editRevision: 2,
      outputs: { "segments.json": "child-segments", txt: "child-text" } });
    await ref("mediaSourceTranscriptJobs", child.id).set(child);
    await ref("mediaSourceTranscriptJobs", transcript.id).update({ processingPolicy: fallback.PAID_FALLBACK_POLICY,
      paidFallbackState: "ready", fallbackTranscriptId: child.id });
    const input = await request("transcript");
    input.selection.expectedJobUpdateTime = selection.documentRevision(await ref("mediaSourceTranscriptJobs", child.id).get());
    input.selection.expectedEditRevision = 2;
    const result = await prepare(input);
    expect(result.selectionSnapshot.selection.transcriptId).toBe(child.id);
    expect(result.resolvedSelection.transcript).toMatchObject({ jobId: child.id, editRevision: 2,
      segments: { objectVersionId: "child-segments" }, text: { objectVersionId: "child-text" } });
    await ref("mediaSourceTranscriptJobs", child.id).update({ editRevision: 3 });
    await expect(prepare(input)).rejects.toMatchObject({ code: "selection_changed" });
    expect((await db.collection("mediaSourceTranscriptJobs").get()).size).toBe(2);
  });
});

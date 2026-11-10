import { createHash } from "node:crypto";
import selection from "../../functions/lib/cuez-transfer-selection.js";
import sourceContract from "../../functions/lib/source-media-contract.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import clips from "../../functions/lib/video-clip-contract.js";
import transcripts from "../../functions/lib/video-transcript-contract.js";

export const now = Date.parse("2026-10-29T15:00:00Z");
export const newsdeskId = "test-newsdesk";
export const source = { id: "video-library", bucket: "test-originals", prefix: "objects/", writable: true,
  access: "active_staff", expectedBucketOwner: "123456789012" };
export const registry = new Map([[source.id, source]]);
export async function boardwalkFixture(db) {
  const ref = (collection, id) => db.collection(collection).doc(id);
  await Promise.all(["cuezTransferOperations", "cuezMappings", "mediaSourceAssets", "mediaSourceClipJobs", "mediaSourceTranscriptJobs",
    "media_assets", "cmsPosts", "users", "mediaSourceOriginalStatus", "system/media/replacements"].map(name => db.recursiveDelete(db.collection(name))));
  const asset = { id: "asset", sourceId: source.id, lifecycle: "active", name: "Selected video", originalName: "source.mp4",
    nameSort: "selected video", updatedAtSort: "2026-10-29T12:00:00Z", mimeType: "video/mp4", kind: "video",
    sizeBytes: 1000, preview: "browser", rightsStatus: "complete", tags: [], version: 1,
    objectKey: "objects/source.mp4", objectVersionId: "original-v1" };
  const prefix = renditions.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    attemptId: "viewing-attempt", updatedAt: "2026-10-29T12:00:00Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds: 60 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 10, mimeType: "image/jpeg" } };
  const clip = { sourceId: source.id, assetId: asset.id, sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    inputObjectKey: asset.rendition.web.objectKey, inputObjectVersionId: "web-v1", inputSizeBytes: 500,
    inMs: 1000, outMs: 5000, attemptId: "clip-attempt", phase: "ready", expiresAt: "2026-10-30T15:00:00Z" };
  clip.id = clips.clipIdentity(clip);
  clip.output = { objectKey: `outputs/clips/${clip.id}/clip-attempt/preview.mp4`, objectVersionId: "clip-v1", sizeBytes: 100,
    mimeType: "video/mp4", durationSeconds: 4 };
  const settings = { languageCode: "en-US", maxSpeakers: 2 };
  const transcript = { id: transcripts.transcriptId(asset, source.bucket, settings), sourceId: source.id, assetId: asset.id,
    sourceBucket: source.bucket, sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, ...settings, phase: "ready", editRevision: 0,
    outputs: { "segments.json": "segments-v1", txt: "text-v1" }, speakerNames: { spk_0: "Reporter" } };
  await Promise.all([
    ref("users", "staff").set({ active: true, role: "admin", emailVerified: true }),
    ref("mediaSourceAssets", "asset").set(asset), ref("mediaSourceClipJobs", clip.id).set(clip),
    ref("mediaSourceTranscriptJobs", transcript.id).set(transcript),
    ref("media_assets", "image").set({ name: "Image", originalName: "image.png", lifecycle: "active", version: 1,
      category: "news", kind: "image", mimeType: "image/png", sizeBytes: 100, width: 10, height: 10,
      storageKey: `cms-media/news/image/${"a".repeat(64)}.png`, url: `https://media.example.test/cms-media/news/image/${"a".repeat(64)}.png` }),
    ref("cmsPosts", "post").set({ type: "post", title: "Post", summary: "Draft summary", version: 1, status: "draft", createdBy: "staff", section: "news" }),
  ]);
  async function request(kind, newStory = false) {
    let chosen = { kind, sourceId: source.id, assetId: asset.id, expectedVersion: 1,
      fileVersion: sourceContract.sourceMediaFileVersion(asset.objectVersionId),
      expectedUpdateTime: selection.documentRevision(await ref("mediaSourceAssets", asset.id).get()) };
    if (kind === "clip") Object.assign(chosen, { clipId: clip.id, expectedClipOutput: {
      attemptId: clip.attemptId, objectKey: clip.output.objectKey, objectVersionId: clip.output.objectVersionId, sizeBytes: clip.output.sizeBytes },
    expectedJobUpdateTime: selection.documentRevision(await ref("mediaSourceClipJobs", clip.id).get()) });
    if (kind === "transcript") Object.assign(chosen, { transcriptId: transcript.id, expectedEditRevision: 0,
      expectedJobUpdateTime: selection.documentRevision(await ref("mediaSourceTranscriptJobs", transcript.id).get()) });
    if (["image", "post", "around-nj"].includes(kind)) {
      const collection = { image: "media_assets", post: "cmsPosts", "around-nj": "aroundNjStories" }[kind];
      const id = kind === "around-nj" ? createHash("sha256").update("https://outlet.example.test/story").digest("hex") : kind;
      chosen = { kind, [kind === "image" ? "assetId" : "recordId"]: id, ...(kind === "around-nj" ? {} : { expectedVersion: 1 }),
        expectedUpdateTime: selection.documentRevision(await ref(collection, id).get()) };
    }
    const target = newStory || ["post", "around-nj"].includes(kind) ? { kind: "new-story" }
      : { kind: kind === "transcript" ? "dossier" : "story-asset", storyId: "selected-story" };
    return { workspaceId: newsdeskId, selection: chosen, target, mappingVersion: 1 };
  }
  return { ref, request, asset, clip, transcript };
}

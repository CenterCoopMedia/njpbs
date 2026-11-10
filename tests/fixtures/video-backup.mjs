import { createHash } from "node:crypto";
import rendition from "../../functions/lib/source-media-rendition.js";

export const sourceBucket = "synthetic-viewing-copies";
export const identityKey = identity => createHash("sha256").update(JSON.stringify(identity)).digest("hex");

export function assetFixture(id, sizeBytes = 12, versionId = "web-v1") {
  const asset = { sourceId: "video-library", lifecycle: "active", kind: "video", name: `Unpublished ${id}`,
    originalName: `${id}.mxf`, nameSort: id, updatedAtSort: "2026-10-10T10:00:00.000Z",
    mimeType: "application/mxf", sizeBytes: 1000000, version: 1, preview: "download_only",
    rightsStatus: "pending", tags: [], createdAt: "2026-10-10T09:00:00.000Z",
    objectKey: `objects/${id}.mxf`, objectVersionId: "original-v1" };
  const prefix = rendition.sourceMediaRenditionOutputPrefix({ ...asset, id }, "attempt-1");
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    attemptId: "attempt-1", updatedAt: "2026-10-10T10:00:00.000Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: versionId, sizeBytes, mimeType: "video/mp4",
      durationSeconds: 1, width: 160, height: 90 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1",
      sizeBytes: 100, mimeType: "image/jpeg" } };
  return asset;
}

export function sourceIdentity(asset) {
  return { bucket: sourceBucket, key: asset.rendition.web.objectKey, versionId: asset.rendition.web.objectVersionId };
}

// The emulator drill uses the real query. Unit tests use this strict boundary
// fake so a missing source filter, limit or cursor contract fails immediately.
export function fakeDatabase(records) {
  const reads = [];
  return { reads, collection(name) {
    if (name !== "mediaSourceAssets") throw Error("Wrong collection");
    let after = null, limit = null;
    return {
      where(field, operator, value) {
        if (field !== "sourceId" || operator !== "==" || value !== "video-library") throw Error("Unbounded filter");
        return this;
      },
      orderBy() { return this; },
      limit(value) { limit = value; return this; },
      startAfter(value) { after = value; return this; },
      async get() {
        if (!limit || limit > 20) throw Error("Unbounded query");
        reads.push({ after, limit });
        const docs = Object.entries(records).filter(([id, value]) => value.sourceId === "video-library" && (!after || id > after))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([id, value]) => ({ id, data: () => value }));
        return { docs, size: docs.length };
      },
    };
  } };
}

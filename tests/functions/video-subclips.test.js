import { beforeAll, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import subclips from "../../functions/video-subclips.js";
import sourceMedia from "../../functions/lib/source-media-contract.js";
import rendition from "../../functions/lib/source-media-rendition.js";

const db = isolatedFirestore("video-subclips.test.js");
const source = { id: "video-library", access: "active_staff", prefix: "objects/" };
const assetRef = id => db.collection("mediaSourceAssets").doc(id);

function storedAsset(id, objectVersionId, durationSeconds) {
  const asset = { id, sourceId: source.id, lifecycle: "active", name: "Example video", originalName: "video.mp4",
    nameSort: "example video", updatedAtSort: "2026-11-22T16:00:00Z", mimeType: "video/mp4",
    kind: "video", sizeBytes: 1000, preview: "browser", rightsStatus: "pending", tags: [], version: 1,
    objectKey: `objects/${id}.mp4`, objectVersionId };
  const prefix = rendition.sourceMediaRenditionOutputPrefix(asset, "viewing-attempt");
  return { ...asset, rendition: {
    schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey, sourceObjectVersionId: objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: "viewing-attempt", updatedAt: asset.updatedAtSort,
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 500, mimeType: "video/mp4", durationSeconds },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 100, mimeType: "image/jpeg" },
  } };
}

const fileVersion = sourceMedia.sourceMediaFileVersion("original-v1");

async function call(assetId, action, fields = {}, uid = "editor") {
  const res = { set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const handler = subclips.createVideoSubclipsHandler({
    firestore: db, registry: () => new Map([[source.id, source]]), verifyAppCheck: async () => {},
    requirePrincipal: async () => ({ uid, principal: { id: uid, grants: [{ role: "staff", tier: "viewer" }] } }),
  });
  await handler({ method: "POST", headers: { "content-type": "application/json" },
    body: { sourceId: source.id, assetId, action, ...fields } }, res);
  return { code: res.code, ...res.body };
}

beforeAll(async () => {
  await Promise.all([
    db.collection("users").doc("editor").set({ active: true }),
    db.collection("users").doc("other").set({ active: true }),
    db.collection("users").doc("inactive").set({ active: false }),
  ]);
});

it("saves and reopens an exact, private range with metadata as the only write", async () => {
  const id = "save-range";
  const asset = storedAsset(id, "original-v1", 4.0019);
  await assetRef(id).set(asset);
  const collectionsBefore = (await db.listCollections()).map(ref => ref.id);
  const fields = { name: "  Interview  ", fileVersion, inMs: 3751, outMs: 4001 };
  const saved = await call(id, "save", fields);
  expect(saved.code).toBe(200);
  const [clip] = saved.subclips;
  expect(clip).toMatchObject({ ...fields, name: "Interview", state: "current" });
  expect((await call(id, "save", fields)).subclips).toEqual([clip]);
  expect((await call(id, "list")).subclips).toEqual([clip]);
  expect((await call(id, "open", { id: clip.id, fileVersion })).subclips).toEqual([clip]);
  expect((await call(id, "list", {}, "other")).subclips).toEqual([]);
  expect((await call(id, "open", { id: clip.id, fileVersion }, "other")).code).toBe(404);
  expect((await call(id, "save", fields, "inactive")).code).toBe(403);
  expect((await assetRef(id).get()).data()).toEqual(asset);
  expect((await db.listCollections()).map(ref => ref.id).sort()).toEqual(
    [...new Set([...collectionsBefore, "mediaSourceSubclipLibraries"])].sort());
});

it("validates bounds at save and rechecks timing and source availability at open", async () => {
  const id = "changed-range";
  await assetRef(id).set(storedAsset(id, "original-v1", 4.0019));
  const fields = { name: "Opening", fileVersion, inMs: 3751, outMs: 4001 };
  expect((await call(id, "save", { ...fields, outMs: 4000 })).code).toBe(400);
  expect((await call(id, "save", { ...fields, outMs: 4002 })).code).toBe(409);
  const [clip] = (await call(id, "save", fields)).subclips;
  await assetRef(id).set(storedAsset(id, "original-v1", 4));
  expect((await call(id, "list")).subclips).toEqual([{ ...clip, state: "unavailable" }]);
  expect(await call(id, "open", { id: clip.id, fileVersion })).toMatchObject({
    code: 409, error: "This range is unavailable in the current viewing copy.",
  });
  await assetRef(id).set(storedAsset(id, "original-v2", 5));
  const replacement = sourceMedia.sourceMediaFileVersion("original-v2");
  expect((await call(id, "list")).subclips).toEqual([{ ...clip, state: "replaced" }]);
  expect((await call(id, "save", fields)).code).toBe(409);
  expect((await call(id, "open", { id: clip.id, fileVersion: replacement })).code).toBe(409);
  expect((await call(id, "remove", { id: clip.id })).subclips).toEqual([]);
  await assetRef(id).update({ lifecycle: "deleted" });
  expect(await call(id, "list")).toMatchObject({ code: 404, error: "This video is no longer available" });
});

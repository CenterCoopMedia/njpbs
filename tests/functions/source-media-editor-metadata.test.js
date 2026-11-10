import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import firebase from "../../functions/lib/firebase.js";
import contract from "../../functions/lib/source-media-contract.js";
import uploadContract from "../../functions/lib/source-media-upload-contract.js";
import uploads from "../../functions/source-media-uploads.js";
import preview from "../../functions/lib/video-preview-job.js";
import sourceMedia from "../../functions/source-media.js";

const db = isolatedFirestore("source-media-editor-metadata.test.js");
const marker = { startMs: 1250, endMs: 2500, name: "Interview", comment: "Use this answer", type: "Comment", color: 3 };
const source = { id: "video-library", prefix: "shared/", access: "active_staff", writable: true };
const checksum = createHash("sha256").update("test").digest("base64");
let actor;
let refs;
let parentId;
let now;

function fixture(overrides = {}) {
  return { sourceId: "video-library", lifecycle: "active", kind: "video", name: "Parent",
    originalName: "parent.mp4", nameSort: "parent", updatedAtSort: now,
    mimeType: "video/mp4", sizeBytes: 4, version: 1, preview: "browser", rightsStatus: "pending",
    objectKey: "shared/parent.mp4", objectVersionId: "parent-version", tags: [],
    createdAt: now, updatedAt: now, createdBy: actor.uid, ...overrides };
}

async function call(action, body, { uploader, currentActor = actor } = {}) {
  const actions = {
    start: [uploadContract.parseStartUploadRequest, uploads.startUpload, "upload"],
    sign: [uploadContract.parseSignUploadPartsRequest, uploads.signUploadParts, "upload"],
    complete: [value => uploadContract.parseSessionRequest(value, { requiresVersion: true }), uploads.completeUpload, "upload"],
    update: [uploadContract.parseMetadataUpdateRequest, uploads.updateMetadata, "metadata"],
  };
  const [parse, run, operation] = actions[action];
  const handler = uploads.makeHandler({ maxBytes: 96 * 1024, parse, run, operation, usesUploader: action !== "update" }, {
    firestore: db, registryFn: () => new Map([[source.id, source]]),
    requirePrincipalFn: async () => currentActor, verifyAppCheckFn: async () => ({}),
    uploader, nowFn: () => now, log: { error() {} },
  });
  const res = { statusCode: 200, headersSent: false, set() {} };
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.body = value; res.headersSent = true; return res; };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
  return res;
}

function startBody(overrides = {}) {
  return { sourceId: source.id, originalName: "finished.mp4", mimeType: "video/mp4", sizeBytes: 4,
    lastModified: 1234, metadata: { name: "Finished video", markers: [marker] },
    parentSource: { sourceId: source.id, assetId: parentId, inMs: 1000, outMs: 5000 }, ...overrides };
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.GCLOUD_PROJECT?.startsWith("demo-")) {
    throw new Error("Run with the demo Firestore emulator");
  }
});

beforeEach(async () => {
  now = new Date().toISOString();
  const uid = `editor-metadata-${randomUUID()}`;
  actor = { uid, email: `${uid}@example.test`, principal: { id: uid, grants: [{ role: "admin" }] } };
  parentId = `parent-${randomUUID()}`;
  refs = [db.collection("users").doc(uid), db.collection("mediaSourceAssets").doc(parentId)];
  await refs[0].set({ active: true, role: "admin" });
  await refs[1].set(fixture());
});

afterEach(async () => {
  for (const [collection, field] of [[uploads.COLLECTION, "actorUid"], ["mediaSourceAssets", "createdBy"],
    ["admin_logs", "actorUid"], [preview.PREVIEW_JOBS, "actorUid"]]) {
    const found = await db.collection(collection).where(field, "==", actor.uid).get();
    refs.push(...found.docs.map(doc => doc.ref));
  }
  await Promise.all(refs.map(ref => ref.delete()));
});

describe("bounded source-relative editor metadata", () => {
  it("preserves exact marker values and supplies defaults for older assets", () => {
    expect(contract.parseSourceMediaMarkers([marker])).toEqual([marker]);
    const summary = contract.sourceMediaAssetDetail(contract.parseSourceMediaAsset(parentId, fixture()));
    expect(summary).toMatchObject({ markers: [], parentSource: null });
    expect(contract.parseSourceMediaAsset(parentId, fixture({ markers: [{ ...marker, color: 8 }] }))).toBeNull();
  });

  it("rejects invalid marker fields, times, types, colors and count", () => {
    for (const change of [{ startMs: -1 }, { startMs: 0.1 }, { endMs: 0 }, { endMs: Infinity },
      { startMs: Number.MAX_SAFE_INTEGER + 1 }, { type: "Unknown" }, { color: 8 }, { color: 1.5 },
      { name: "x".repeat(201) }, { comment: "x".repeat(1001) }, { url: "https://example.test" }]) {
      expect(() => contract.parseSourceMediaMarkers([{ ...marker, ...change }])).toThrow();
    }
    expect(() => contract.parseSourceMediaMarkers(Array(101).fill(marker))).toThrow();
    expect(contract.parseSourceMediaMarkers([{ ...marker, endMs: marker.startMs }])).toHaveLength(1);
  });

  it("refuses WebLink metadata without altering the asset's existing markers", async () => {
    await refs[1].update({ markers: [marker] });
    const webLink = { ...marker, type: "WebLink" };
    expect(() => contract.parseSourceMediaMarkers([webLink])).toThrow("WebLink");
    const response = await call("update", { sourceId: source.id, assetId: parentId,
      expectedVersion: 1, changes: { markers: [webLink] } });
    expect(response.statusCode).toBe(400);
    expect((await refs[1].get()).data()).toMatchObject({ markers: [marker], version: 1 });
    for (const type of ["Comment", "Chapter", "Segmentation"]) {
      expect(contract.parseSourceMediaMarkers([{ ...marker, type }])).toEqual([{ ...marker, type }]);
    }
  });

  it("bounds serialized UTF-8 bytes independently of count and text lengths", () => {
    const large = { ...marker, comment: "界".repeat(1000) };
    expect(() => contract.parseSourceMediaMarkers(Array(23).fill(large))).toThrow("64 KiB");
    expect(contract.parseSourceMediaMarkers(Array(20).fill(large))).toHaveLength(20);
  });

  it("keeps marker bytes out of list and search summaries and reads them on exact lookup", async () => {
    const markers = Array(20).fill({ ...marker, comment: "界".repeat(1000) });
    await refs[1].update({ markers });
    const parsed = contract.parseSourceMediaAsset(parentId, (await refs[1].get()).data());
    // The same projection serves ordinary lists, saved collections, and the search corpus.
    expect(contract.sourceMediaAssetSummary(parsed)).not.toHaveProperty("markers");
    const page = await sourceMedia.readSourceMediaPage(db, source,
      contract.parseSourceMediaListRequest({ sourceId: source.id, q: "parent" }),
      FieldPath.documentId());
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).not.toHaveProperty("markers");
    expect(Buffer.byteLength(JSON.stringify(page.records))).toBeLessThan(2048);
    const detail = await sourceMedia.readSourceMediaPage(db, source, { assetId: parentId });
    expect(detail.records[0]).toMatchObject({ markers, version: 1 });
    expect(Buffer.byteLength(JSON.stringify(detail.records))).toBeGreaterThan(60000);
  });

  it("accepts a whole parent source or a complete positive range and rejects parent edits", () => {
    expect(contract.parseSourceMediaParent({ sourceId: source.id, assetId: parentId })).toEqual({ sourceId: source.id, assetId: parentId });
    for (const change of [{ sourceId: "archive-originals" }, { assetId: "../other" }, { outMs: 1000 },
      { inMs: -1 }, { inMs: 0.1 }, { outMs: undefined }]) {
      expect(() => uploadContract.parseStartUploadRequest(startBody({ parentSource: { ...startBody().parentSource, ...change } }))).toThrow();
    }
    expect(() => uploadContract.parseMetadataUpdateRequest({ sourceId: source.id, assetId: parentId,
      expectedVersion: 1, changes: { parentSource: startBody().parentSource } })).toThrow();
  });

  it("replaces markers atomically and returns the winner on concurrent version conflict", async () => {
    const body = { sourceId: source.id, assetId: parentId, expectedVersion: 1, changes: { markers: [marker] } };
    const responses = await Promise.all([call("update", body), call("update", body)]);
    expect(responses.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find(result => result.statusCode === 200).body.asset;
    expect(winner).toMatchObject({ markers: [marker], version: 2 });
    expect(responses.find(result => result.statusCode === 409).body.current).toMatchObject({ markers: [marker], version: 2 });
    const clear = await call("update", { ...body, expectedVersion: 2, changes: { markers: [] } });
    expect(clear.body.asset).toMatchObject({ markers: [], version: 3 });
    expect((await refs[1].get()).data().markers).toEqual([]);
  });

  it("accepts bounded marker bodies above the old 16 KiB limit and preserves permissions", async () => {
    const markers = Array(20).fill({ ...marker, comment: "界".repeat(1000) });
    const body = { sourceId: source.id, assetId: parentId, expectedVersion: 1, changes: { markers } };
    expect((await call("update", body)).statusCode).toBe(200);
    const staff = { ...actor, principal: { id: actor.uid, grants: [{ role: "staff" }] } };
    expect((await call("update", { ...body, expectedVersion: 2 }, { currentActor: staff })).statusCode).toBe(403);
  });

  it("refuses missing, deleted, cross-source and out-of-prefix parents before upload admission", async () => {
    const uploader = { async start() { throw new Error("S3 must not admit an invalid parent"); } };
    for (const changes of [{ lifecycle: "deleted" }, { sourceId: "archive-originals" }, { objectKey: "other/private.mp4" }]) {
      await refs[1].set(fixture(changes));
      expect((await call("start", startBody(), { uploader })).statusCode).toBe(404);
    }
    await refs[1].delete();
    expect((await call("start", startBody(), { uploader })).statusCode).toBe(404);
    await refs[1].set(fixture());
    await refs[0].update({ active: false });
    expect((await call("start", startBody(), { uploader })).statusCode).toBe(403);
  });

  it("retains marker and immutable parent metadata through multipart completion and replay", async () => {
    const uploader = {
      async start() { return { uploadId: "synthetic-s3-upload" }; },
      async signParts() { return []; },
      async listParts() { return [{ partNumber: 1, sizeBytes: 4, checksumSha256: checksum, etag: "synthetic-etag" }]; },
      async complete() { return { VersionId: "synthetic-version" }; },
      async head(_source, session) { return { VersionId: "synthetic-version", ContentLength: 4,
        ChecksumSHA256: `${createHash("sha256").update(Buffer.from(checksum, "base64")).digest("base64")}-1`,
        Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId } }; },
    };
    const body = startBody({ requestId: randomUUID(), metadata: { name: "Staff title", description: "Staff description", markers: [marker], metadataUpdateRequested: true } });
    const started = await call("start", body, { uploader });
    expect(started.statusCode).toBe(200);
    expect((await call("start", { ...body, parentSource: { ...body.parentSource, outMs: 6000 } }, { uploader })).statusCode).toBe(409);
    const { sessionId } = started.body.upload;
    const signed = await call("sign", { sourceId: source.id, sessionId, version: 1,
      parts: [{ partNumber: 1, sizeBytes: 4, checksumSha256: checksum }] }, { uploader });
    expect(signed.statusCode).toBe(200);
    const completed = await call("complete", { sourceId: source.id, sessionId, version: signed.body.version }, { uploader });
    expect(completed.statusCode).toBe(200);
    expect(completed.body.asset).toMatchObject({ markers: [marker], parentSource: body.parentSource, version: 1 });
    const stored = (await db.collection("mediaSourceAssets").doc(completed.body.asset.id).get()).data();
    expect(stored).toMatchObject({ markers: [marker], parentSource: body.parentSource, metadataUpdateRequested: true });
    expect(completed.body.asset.metadataUpdateRequested).toBe(true);
    const assetId = completed.body.asset.id;
    expect((await call("update", { sourceId: source.id, assetId, expectedVersion: 2, changes: { metadataUpdateRequested: false } })).statusCode).toBe(409);
    const cleared = await call("update", { sourceId: source.id, assetId, expectedVersion: 1, changes: { metadataUpdateRequested: false, tags: ["interview"] } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.asset).toMatchObject({ metadataUpdateRequested: false, name: "Staff title", description: "Staff description", tags: ["interview"], version: 2 });
    expect((await db.collection("mediaSourceAssets").doc(assetId).get()).data().metadataUpdateRequested).toBe(false);
    expect((await refs[1].get()).data().version).toBe(1);
  });
});

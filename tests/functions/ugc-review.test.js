import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import review from "../../functions/ugc-review.js";
import intake from "../../functions/ugc-intake.js";
import { ugcBucket } from "../helpers/ugc-r2.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import media from "../../functions/media.js";

const PROJECT = "demo-njpbs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNgZGL+D8IMMAYAHtAEFYRc9U8AAAAASUVORK5CYII=",
  "base64",
);
const VIDEO = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypisom"),
  Buffer.alloc(4), Buffer.from("mp41"), Buffer.alloc(12)]);
const DAMAGED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2lWAAAAAElFTkSuQmCC",
  "base64",
);
let db;

function actor(sections) {
  return { uid: "reviewer", email: "reviewer@example.org",
    principal: { id: "reviewer", grants: [{ role: "editor", ...(sections ? { sections } : {}) }] } };
}

function response() {
  return { statusCode: 0, body: null, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
}

function request(body) {
  return { method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)),
    headers: { "content-type": "application/json" } };
}

function stores() {
  const quarantine = new Map();
  const library = new Map();
  const ugc = {
    delete: vi.fn(async key => { quarantine.delete(key); }),
    rejectUpload: vi.fn(async key => { quarantine.set(key, Buffer.alloc(0)); }),
    signGet: vi.fn(async key => `https://private.example/${key}`),
    read: vi.fn(async key => {
      const bytes = quarantine.get(key);
      if (!bytes) throw new Error("Missing quarantine file");
      return (async function* () { yield bytes; })();
    }),
  };
  const media = {
    putStaging: vi.fn(async ({ key, body, mimeType, metadata }) => {
      library.set(key, { body, mimeType, metadata });
    }),
    putFinal: vi.fn(async ({ key, body, mimeType, metadata }) => {
      if (library.has(key)) return { created: false };
      library.set(key, { body, mimeType, metadata });
      return { created: true };
    }),
    head: vi.fn(async key => {
      const stored = library.get(key);
      return stored ? { contentLength: stored.body.length,
        contentType: stored.mimeType, metadata: stored.metadata } : null;
    }),
    deleteStaging: vi.fn(async key => { library.delete(key); }),
    deleteFinal: vi.fn(async key => { library.delete(key); }),
  };
  const uploader = {
    head: vi.fn(async () => { const error = new Error("Missing object");
      error.name = "NotFound"; throw error; }),
    importStream: vi.fn(async (_source, session, body) => {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"))
      .toBe(session.contentHash);
    return { VersionId: "version-1", ContentLength: session.sizeBytes,
      Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId },
      ChecksumSHA256: "checksum" };
    }),
  };
  return { quarantine, library, ugc, media, uploader };
}

async function pending(storage, bytes = PNG, type = "image/png") {
  const id = randomUUID();
  const key = `ugc-quarantine/${id}/${randomUUID()}`;
  storage.quarantine.set(key, bytes);
  await db.collection("ugcSubmissions").doc(id).set({
    submissionId: id, status: "pending", name: "Submitter", email: "submitter@example.org",
    message: "A public submission from the station.",
    consentVersion: "ugc-release-1", consentTextHash: "a".repeat(64),
    consentedAt: admin.firestore.Timestamp.fromDate(new Date("2026-09-28T12:00:00Z")),
    scopes: { broadcast: true, web: true, social: true },
    file: { name: type === "image/png" ? "photo.png" :
      type === "image/jpeg" ? "photo.jpg" : "clip.mp4", type, size: bytes.length },
    contentHash: createHash("sha256").update(bytes).digest("hex"), quarantineKey: key,
    expireAt: admin.firestore.Timestamp.fromDate(new Date("2026-12-27T12:00:00Z")),
    createdAt: admin.firestore.Timestamp.now(),
  });
  return { id, key };
}

function handlers(storage, principal = actor()) {
  return review.createUgcReviewHandlers({ firestore: db,
    requirePrincipalFn: async () => principal, verifyAppCheckFn: async () => ({}),
    storage: () => storage.ugc, mediaStorage: () => storage.media,
    uploader: () => storage.uploader,
    registry: () => new Map([["video-library", { id: "video-library", prefix: "shared/",
      writable: true }]]), now: () => new Date("2026-09-28T13:00:00Z") });
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("ugc-review.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.collection("mediaCategories").doc("general").set({ id: "general", label: "General",
    description: "Test", order: 1, active: true, version: 1 });
  await db.collection("users").doc("reviewer").set({
    active: true, grants: [{ role: "editor" }],
  });
});

describe("UGC review", () => {
  it("denies section-only grants and omits URLs from pending rows", async () => {
    const storage = stores();
    await pending(storage);
    const base = actor();
    for (const grants of [
      [{ role: "editor", sections: ["general"] }],
      [{ role: "editor", sections: [] }],
      [{ role: "editor", sections: null }],
      [{ role: "contributor" }],
    ]) {
      const denied = response();
      await handlers(storage, { ...base, principal: { ...base.principal, grants } }).list(request({}), denied);
      expect(denied.statusCode, JSON.stringify(grants)).toBe(403);
    }
    const listed = response();
    await handlers(storage).list(request({}), listed);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.records[0]).toMatchObject({ status: "pending",
      email: "submitter@example.org", consentVersion: "ugc-release-1" });
    expect(JSON.stringify(listed.body)).not.toContain("quarantine");
    expect(JSON.stringify(listed.body)).not.toContain("https://");
  });

  it("pages pending submissions before older decisions", async () => {
    const storage = stores();
    const oldest = await pending(storage);
    const newest = await pending(storage);
    const rejected = await pending(storage);
    await db.collection("ugcSubmissions").doc(oldest.id).update({
      createdAt: admin.firestore.Timestamp.fromDate(new Date("2026-09-27T12:00:00Z")),
    });
    await db.collection("ugcSubmissions").doc(newest.id).update({
      createdAt: admin.firestore.Timestamp.fromDate(new Date("2026-09-28T12:00:00Z")),
    });
    await db.collection("ugcSubmissions").doc(rejected.id).update({
      status: "rejected", email: admin.firestore.FieldValue.delete(),
      createdAt: admin.firestore.Timestamp.fromDate(new Date("2026-09-29T12:00:00Z")),
    });
    const run = handlers(storage);
    const first = response();
    await run.list(request({ status: "all", limit: 1 }), first);
    expect(first.body.records.map(row => row.id)).toEqual([newest.id]);
    const second = response();
    await run.list(request({ status: "all", limit: 1, cursor: first.body.nextCursor }), second);
    expect(second.body.records.map(row => row.id)).toEqual([oldest.id]);
    const third = response();
    await run.list(request({ status: "all", limit: 1, cursor: second.body.nextCursor }), third);
    expect(third.body.records.map(row => row.id)).toEqual([rejected.id]);
    expect(third.body.records[0].email).toBeUndefined();
  });

  it("keeps an interrupted import visible and resumable without listing email", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionActor: "previous-reviewer", decisionCategory: "general",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    const run = handlers(storage);
    const listed = response();
    await run.list(request({ status: "pending" }), listed);
    expect(listed.body.records[0]).toMatchObject({ id, status: "importing",
      decisionCategory: "general" });
    expect(listed.body.records[0].email).toBeUndefined();
    const imported = response();
    await run.importSubmission(request({ submissionId: id, category: "general" }), imported);
    expect(imported.statusCode).toBe(200);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("imported");
  });

  it("returns a private photo preview and a signed video read", async () => {
    const storage = stores();
    const photo = await pending(storage);
    const video = await pending(storage, VIDEO, "video/mp4");
    const run = handlers(storage);
    const image = response();
    await run.preview(request({ submissionId: photo.id }), image);
    expect(image.headers["Cache-Control"]).toBe("private, no-store");
    expect(image.body).toMatchObject({ mimeType: "image/png",
      url: expect.stringContaining(photo.key) });
    expect(image.body.base64).toBeUndefined();
    const movie = response();
    await run.preview(request({ submissionId: video.id }), movie);
    expect(movie.body).toMatchObject({ mimeType: "video/mp4",
      url: expect.stringContaining(video.key) });
    expect(movie.body.base64).toBeUndefined();
    expect(storage.ugc.signGet).toHaveBeenLastCalledWith(video.key, 3600);
  });

  it("rejects, fences quarantine, deletes PII, and keeps a decision audit", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(200);
    expect(storage.quarantine.get(key)).toEqual(Buffer.alloc(0));
    const row = (await db.collection("ugcSubmissions").doc(id).get()).data();
    expect(row.status).toBe("rejected");
    for (const field of ["name", "email", "message"]) expect(row[field]).toBeUndefined();
    const audit = (await db.collection("ugcReviewAudit").get()).docs.map(doc => doc.data());
    expect(audit).toMatchObject([{ submissionId: id, decision: "rejected",
      actorUid: "reviewer", consentVersion: "ugc-release-1" }]);
  });

  it("keeps a rejected file available for cleanup after a fence failure", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    storage.ugc.rejectUpload.mockRejectedValueOnce(new Error("R2 unavailable"));
    const run = handlers(storage);
    const failed = response();
    await run.reject(request({ submissionId: id }), failed);
    expect(failed.statusCode).toBe(500);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data())
      .toMatchObject({ status: "rejected", quarantineKey: key });
    const retry = response();
    await run.reject(request({ submissionId: id }), retry);
    expect(retry.statusCode).toBe(200);
    expect(storage.quarantine.get(key)).toEqual(Buffer.alloc(0));
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().quarantineKey)
      .toBeUndefined();
  });

  it("settles a staff-cleaned file-check rejection with no verified size and keeps replay fenced", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    const ref = db.collection("ugcSubmissions").doc(id);
    await ref.update({ status: "uploading", size: admin.firestore.FieldValue.delete(),
      clientIpHash: "a".repeat(32) });
    const bucket = ugcBucket();
    // A mismatched byte count fails the real file validator before completion.
    bucket.objects.set(key, { ContentLength: PNG.length + 1, ETag: '"bad-upload"' });
    storage.ugc = bucket.storage;
    const origin = intake.createUgcHandlers({ firestore: db, storage: () => bucket.storage });
    await expect(origin.complete(request({ requestId: id, submissionId: id }), response()))
      .rejects.toMatchObject({ code: "rejected_file" });
    expect((await ref.get()).data()).toMatchObject({ status: "rejected", rejectionReason: "file_check" });
    const quotaRequest = request({ requestId: id, submissionId: id, clientIpHash: "a".repeat(32) });
    quotaRequest.headers["x-njpbs-quota-reconcile"] = "1";
    // Staff cleanup may race a zero-byte quota receipt. It must never delete
    // that marker, even when the original signed URL can still be replayed.
    bucket.hooks.beforeSend = async (command) => {
      if (command.constructor.name !== "PutObjectCommand") return;
      const res = response();
      await origin.complete(quotaRequest, res);
      expect(res.body).toEqual({ quotaBytes: 0 });
    };
    const rejected = response();
    await handlers(storage).reject(request({ submissionId: id }), rejected);
    expect(rejected.statusCode).toBe(200);
    const row = (await ref.get()).data();
    expect(row.quarantineKey).toBeUndefined();
    expect(row.size).toBeUndefined();
    expect(row.quotaKey).toBe(key);
    const res = response();
    await origin.complete(quotaRequest, res);
    expect(res.body).toEqual({ quotaBytes: 0 });
    bucket.hooks.beforeSend = null;
    await expect(bucket.client.send(new PutObjectCommand({ Key: key, ContentLength: PNG.length, IfNoneMatch: "*" })))
      .rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await expect(origin.complete(request({ requestId: id, submissionId: id }), response()))
      .rejects.toMatchObject({ code: "rejected_file" });
    expect(bucket.objects.get(key).ContentLength).toBe(0);
  });

  it("imports a photo and retains consent without email or TTL", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    const run = handlers(storage);
    const result = response();
    await run.importSubmission(request({ submissionId: id, category: "general" }), result);
    expect(result.statusCode).toBe(200);
    expect(result.body.asset).toMatchObject({ kind: "image", id, duplicate: false });
    const asset = (await db.collection("media_assets").doc(id).get()).data();
    expect(asset).toMatchObject({ license: "Public submission ugc-release-1, broadcast, web, and social",
      credit: "Submitter", description: "A public submission from the station.",
      altText: "", source: "upload", tags: ["public-submission"] });
    expect(JSON.stringify(asset)).not.toContain("submitter@example.org");
    expect(asset.thumbnails).toHaveLength(1);
    const row = (await db.collection("ugcSubmissions").doc(id).get()).data();
    expect(row).toMatchObject({ status: "imported", name: "Submitter",
      consentTextHash: "a".repeat(64), scopes: { broadcast: true, web: true, social: true } });
    expect(row.email).toBeUndefined();
    expect(row.expireAt).toBeUndefined();
    expect(storage.quarantine.has(key)).toBe(false);
    const retry = response();
    await run.importSubmission(request({ submissionId: id, category: "general" }), retry);
    expect(retry.body.asset).toEqual(result.body.asset);
    expect((await db.collection("media_assets").get()).size).toBe(1);
  });

  it("removes GPS EXIF before hashing and publishing a JPEG", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3,
      background: "#224466" } }).withExif({ IFD3: {
      GPSLatitudeRef: "N", GPSLatitude: "40/1 13/1 0/1",
    } }).jpeg().toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const storage = stores();
    const { id } = await pending(storage, jpeg, "image/jpeg");
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(200);
    const asset = (await db.collection("media_assets").doc(id).get()).data();
    const published = storage.library.get(asset.storageKey).body;
    expect((await sharp(published).metadata()).exif).toBeUndefined();
    expect(asset.contentHash).toBe(createHash("sha256").update(published).digest("hex"));
    expect(asset.contentHash).not.toBe(createHash("sha256").update(jpeg).digest("hex"));
  });

  it("keeps quarantine when a newer decision replaces the import claim", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    const original = storage.media.putFinal;
    storage.media.putFinal = vi.fn(async (input) => {
      await original(input);
      await db.collection("ugcSubmissions").doc(id).update({
        decisionStartedAt: "2026-09-28T13:11:00Z", decisionActor: "other-reviewer" });
    });
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(409);
    expect(storage.quarantine.has(key)).toBe(true);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data())
      .toMatchObject({ status: "importing", decisionActor: "other-reviewer" });
  });

  it("allows a stale import to switch category and clears its old claim", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    await db.collection("mediaCategories").doc("news").set({ id: "news", label: "News",
      description: "Test", order: 2, active: true, version: 1 });
    storage.media.putFinal.mockRejectedValueOnce(new Error("R2 interrupted"));
    const interrupted = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), interrupted);
    expect(interrupted.statusCode).toBe(500);
    expect((await db.collection("system").doc("media").collection("hashOwners").get()).size).toBe(1);
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionActor: "previous-reviewer", decisionCategory: "general",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "news" }), result);
    expect(result.statusCode).toBe(200);
    expect((await db.collection("media_assets").doc(id).get()).data().category).toBe("news");
    expect(storage.library.size).toBeGreaterThan(0);
  });

  it("allows a stale import to be rejected", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    storage.media.putFinal.mockRejectedValueOnce(new Error("R2 interrupted"));
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), response());
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionActor: "previous-reviewer", decisionCategory: "general",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(200);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("rejected");
    expect((await db.collection("system").doc("media").collection("hashOwners").get()).empty).toBe(true);
    expect(storage.library.size).toBe(0);
    const receipt = await db.collection("admin_logs").doc(`media-discard_${id}`).get();
    expect(receipt.data()?.before?.reason).toBe("ugc_review_decision_changed");
  });

  it("does not reject a row whose photo already reached the library", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), response());
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(409);
    expect((await db.collection("media_assets").doc(id).get()).exists).toBe(true);
  });

  it("rejects a stale import after its photo asset is deleted", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), response());
    await db.collection("media_assets").doc(id).update({ lifecycle: "deleted" });
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(200);
  });

  it("does not reject a stale video with an orphan S3 object", async () => {
    const storage = stores();
    const { id, key } = await pending(storage, VIDEO, "video/mp4");
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionActor: "previous-reviewer", decisionCategory: "general",
      decisionStartedAt: "2026-09-28T12:49:00Z" });
    storage.uploader.head.mockResolvedValue({ ContentLength: VIDEO.length });
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toContain("private video object");
    expect(storage.quarantine.has(key)).toBe(true);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("pending");
  });

  it("rejects a stale import after its deleted video asset is cleared", async () => {
    const storage = stores();
    const { id } = await pending(storage, VIDEO, "video/mp4");
    await db.collection("ugcSubmissions").doc(id).update({ status: "importing",
      decisionActor: "previous-reviewer", decisionStartedAt: "2026-09-28T12:49:00Z" });
    await db.collection("mediaSourceAssets").doc(id).set({ lifecycle: "deleted" });
    const result = response();
    await handlers(storage).reject(request({ submissionId: id }), result);
    expect(result.statusCode).toBe(200);
  });

  it("changes category after a failed import reset the row to pending", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    await db.collection("mediaCategories").doc("news").set({ id: "news", label: "News",
      description: "Test", order: 2, active: true, version: 1 });
    storage.media.putFinal.mockRejectedValueOnce(new Error("R2 interrupted"));
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), response());
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("pending");
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "news" }), result);
    expect(result.statusCode).toBe(200);
    expect((await db.collection("media_assets").doc(id).get()).data().category).toBe("news");
  });

  it("discards an object and claim when its category is archived before commit", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    const original = storage.media.putFinal;
    storage.media.putFinal = vi.fn(async (input) => {
      const result = await original(input);
      await db.collection("mediaCategories").doc("general").update({ active: false });
      return result;
    });
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(400);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collection("system").doc("media").collection("hashOwners").get()).empty).toBe(true);
    expect(storage.library.size).toBe(0);
  });

  it("discards an object and claim when the library is full", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    const batch = db.batch();
    for (let index = 0; index < media.MAX_ACTIVE_MEDIA_ASSETS; index += 1) {
      batch.set(db.collection("media_assets").doc(`existing-${index}`), {
        lifecycle: "active" });
    }
    await batch.commit();
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(507);
    expect((await db.collection("system").doc("media").collection("hashOwners").get()).empty).toBe(true);
    expect(storage.library.size).toBe(0);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("pending");
  });

  it("keeps a damaged photo out of the library", async () => {
    const storage = stores();
    const { id } = await pending(storage, DAMAGED_PNG);
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(415);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("pending");
  });

  it("preserves animated WebP frames and strips source metadata", async () => {
    const frame = (color) => sharp({ create: { width: 2, height: 2, channels: 3,
      background: color } }).raw().toBuffer();
    const animated = await sharp(Buffer.concat([
      await frame({ r: 200, g: 0, b: 0 }), await frame({ r: 0, g: 0, b: 200 }),
    ]), { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
      animated: true, pages: 2 }).withMetadata({ exif: { IFD0: { Copyright: "Private source" } } }).webp().toBuffer();
    const storage = stores();
    const { id } = await pending(storage, animated, "image/webp");
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(200);
    const asset = (await db.collection("media_assets").doc(id).get()).data();
    expect(asset.animated).toBe(true);
    const published = [...storage.library.entries()].find(([key]) =>
      key.startsWith("cms-media/general/") && !key.includes("thumbs"))?.[1];
    expect(published).toBeDefined();
    const metadata = await sharp(published.body, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect(metadata.exif).toBeUndefined();
  });

  it("links a duplicate photo hash to the existing asset", async () => {
    const storage = stores();
    const first = await pending(storage);
    const second = await pending(storage);
    const run = handlers(storage);
    await run.importSubmission(request({ submissionId: first.id, category: "general" }), response());
    const result = response();
    await run.importSubmission(request({ submissionId: second.id, category: "general" }), result);
    expect(result.statusCode).toBe(200);
    expect(result.body.asset).toEqual({ kind: "image", id: first.id, duplicate: true });
    expect((await db.collection("media_assets").get()).size).toBe(1);
    expect(storage.media.putFinal.mock.calls.filter(([value]) =>
      value.key.startsWith("cms-media/general/") && !value.key.includes("/thumbs/"))).toHaveLength(1);
    expect(storage.media.putStaging).toHaveBeenCalledTimes(1);
  });

  it("rechecks duplicate bytes when finalizing an import", async () => {
    const storage = stores();
    const first = await pending(storage);
    const second = await pending(storage);
    const run = handlers(storage);
    await run.importSubmission(request({ submissionId: first.id, category: "general" }), response());
    const transaction = db.runTransaction.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, "runTransaction").mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) await db.collection("media_assets").doc(first.id)
        .update({ contentHash: "f".repeat(64) });
      return transaction(...args);
    });
    try {
      const result = response();
      await run.importSubmission(request({ submissionId: second.id, category: "general" }), result);
      expect(result.statusCode).toBe(409);
      expect((await db.collection("ugcSubmissions").doc(second.id).get()).data().status).toBe("pending");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to link a duplicate to an asset in the trash", async () => {
    const storage = stores();
    const first = await pending(storage);
    const second = await pending(storage);
    const run = handlers(storage);
    await run.importSubmission(request({ submissionId: first.id, category: "general" }), response());
    await db.collection("media_assets").doc(first.id).update({ lifecycle: "trash" });
    const result = response();
    await run.importSubmission(request({ submissionId: second.id, category: "general" }), result);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toContain("not active");
    expect((await db.collection("ugcSubmissions").doc(second.id).get()).data().status)
      .toBe("pending");
  });

  it("imports video with pending rights and starts no preview or transcript", async () => {
    const storage = stores();
    const { id, key } = await pending(storage, VIDEO, "video/mp4");
    await db.collection("mediaSourceStats").doc("video-library").set({
      exact: true, activeCount: 2 });
    const run = handlers(storage);
    const result = response();
    await run.importSubmission(request({ submissionId: id, category: "general" }), result);
    expect(result.statusCode).toBe(200);
    const asset = (await db.collection("mediaSourceAssets").doc(id).get()).data();
    expect(asset).toMatchObject({ sourceId: "video-library", rightsStatus: "pending",
      tags: ["public-submission"], credit: "Submitter", ugcCategory: "general",
      source: "upload", altText: "" });
    expect(asset.rendition).toBeUndefined();
    expect((await db.collection("mediaSourceStats").doc("video-library").get()).data().activeCount).toBe(3);
    expect((await db.collection("mediaSourcePreviewJobs").get()).empty).toBe(true);
    expect((await db.collection("mediaSourceTranscriptJobs").get()).empty).toBe(true);
    const row = (await db.collection("ugcSubmissions").doc(id).get()).data();
    expect(row.email).toBeUndefined();
    expect(row.expireAt).toBeUndefined();
    expect(storage.quarantine.has(key)).toBe(false);
    const retry = response();
    await run.importSubmission(request({ submissionId: id, category: "general" }), retry);
    expect(retry.body.asset).toEqual(result.body.asset);
    expect(storage.uploader.importStream).toHaveBeenCalledTimes(1);
  });

  it("does not create a video asset after its submission claim changes", async () => {
    const storage = stores();
    const { id, key } = await pending(storage, VIDEO, "video/mp4");
    const original = storage.uploader.importStream;
    storage.uploader.importStream = vi.fn(async (...args) => {
      const head = await original(...args);
      await db.collection("ugcSubmissions").doc(id).update({
        status: "rejected", decisionStartedAt: "2026-09-28T13:11:00Z" });
      return head;
    });
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(409);
    expect((await db.collection("mediaSourceAssets").doc(id).get()).exists).toBe(false);
    expect(storage.quarantine.has(key)).toBe(true);
  });

  it("does not commit a video after its category is archived", async () => {
    const storage = stores();
    const { id } = await pending(storage, VIDEO, "video/mp4");
    const original = storage.uploader.importStream;
    storage.uploader.importStream = vi.fn(async (...args) => {
      const head = await original(...args);
      await db.collection("mediaCategories").doc("general").update({ active: false });
      return head;
    });
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);
    expect(result.statusCode).toBe(400);
    expect((await db.collection("mediaSourceAssets").doc(id).get()).exists).toBe(false);
  });

  it("refuses staff-profile as an import destination", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "staff-profile" }), result);
    expect(result.statusCode).toBe(403);
    expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("pending");
  });

  for (const kind of ["photo", "video"]) {
    it.each([
      ["deactivated", { active: false, grants: [{ role: "editor" }] }],
      ["deleted", null],
      ["downgraded", { active: true, grants: [{ role: "contributor" }] }],
      ["scoped", { active: true, grants: [{ role: "editor", sections: ["general"] }] }],
    ])(`refuses a ${kind} commit when its reviewer is %s during storage`, async (_change, profile) => {
      const storage = stores();
      const { id, key } = await pending(storage,
        kind === "photo" ? PNG : VIDEO, kind === "photo" ? "image/png" : "video/mp4");
      await db.collection("mediaSourceStats").doc("video-library").set({
        exact: true, activeCount: 2 });
      const userRef = db.collection("users").doc("reviewer");
      const store = kind === "photo" ? storage.media : storage.uploader;
      const method = kind === "photo" ? "putFinal" : "importStream";
      const original = store[method];
      store[method] = async (...args) => {
        const result = await original(...args);
        if (profile) await userRef.set(profile);
        else await userRef.delete();
        return result;
      };

      const result = response();
      await handlers(storage).importSubmission(request({ submissionId: id,
        category: "general" }), result);

      expect(result.statusCode).toBe(403);
      for (const collection of ["media_assets", "media_assets_public", "mediaSourceAssets",
        "admin_logs", "ugcReviewAudit"]) {
        expect((await db.collection(collection).get()).empty).toBe(true);
      }
      expect((await db.collection("mediaSourceStats").doc("video-library").get()).data())
        .toEqual({ exact: true, activeCount: 2 });
      const row = (await db.collection("ugcSubmissions").doc(id).get()).data();
      expect(row).toMatchObject({ status: "pending", quarantineKey: key,
        email: "submitter@example.org" });
      expect(row.expireAt).toBeDefined();
      expect(row.importedAsset).toBeUndefined();
      expect(row.decisionActor).toBeUndefined();
      expect(storage.quarantine.has(key)).toBe(true);

      store[method] = original;
      await userRef.set({ active: true, grants: [{ role: "editor" }] });
      const retry = response();
      await handlers(storage).importSubmission(request({ submissionId: id,
        category: "general" }), retry);
      expect(retry.statusCode).toBe(200);
      expect((await db.collection("ugcSubmissions").doc(id).get()).data().status).toBe("imported");
    });
  }

  it("refuses import finalization when access is revoked after the photo commit", async () => {
    const storage = stores();
    const { id, key } = await pending(storage);
    const original = storage.media.deleteStaging;
    storage.media.deleteStaging = async (...args) => {
      await original(...args);
      await db.collection("users").doc("reviewer").update({ active: false });
    };
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), result);

    expect(result.statusCode).toBe(403);
    expect((await db.collection("media_assets").doc(id).get()).data().lifecycle).toBe("active");
    expect((await db.collection("ugcReviewAudit").get()).empty).toBe(true);
    const row = (await db.collection("ugcSubmissions").doc(id).get()).data();
    expect(row).toMatchObject({ status: "pending", email: "submitter@example.org",
      quarantineKey: key });
    expect(row.expireAt).toBeDefined();
    expect(row.importedAsset).toBeUndefined();
    expect(storage.quarantine.has(key)).toBe(true);

    await db.collection("users").doc("reviewer").update({ active: true });
    const retry = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), retry);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.asset).toEqual({ kind: "image", id, duplicate: true });
    expect((await db.collection("ugcReviewAudit").get()).size).toBe(1);
    expect(storage.quarantine.has(key)).toBe(false);
  });

  it("attributes a resumed photo commit to the authorized reviewer who completes it", async () => {
    const storage = stores();
    const { id } = await pending(storage);
    const original = storage.media.putFinal;
    storage.media.putFinal = async (...args) => {
      const result = await original(...args);
      await db.collection("users").doc("reviewer").update({ active: false });
      return result;
    };
    const refused = response();
    await handlers(storage).importSubmission(request({ submissionId: id,
      category: "general" }), refused);
    expect(refused.statusCode).toBe(403);

    const next = { uid: "next-reviewer", email: "next-reviewer@example.test",
      principal: { id: "next-reviewer", grants: [{ role: "editor" }] } };
    await db.collection("users").doc(next.uid).set({ active: true, grants: next.principal.grants });
    storage.media.putFinal = original;
    const result = response();
    await handlers(storage, next).importSubmission(request({ submissionId: id,
      category: "general" }), result);

    expect(result.statusCode).toBe(200);
    expect((await db.collection("media_assets").doc(id).get()).data())
      .toMatchObject({ createdBy: next.uid, updatedBy: next.uid });
    const uploads = (await db.collection("admin_logs").get()).docs.map(doc => doc.data());
    expect(uploads).toMatchObject([{ action: "media.upload", actorUid: next.uid,
      actorEmail: next.email, target: `media_assets/${id}` }]);
    const decisions = (await db.collection("ugcReviewAudit").get()).docs.map(doc => doc.data());
    expect(decisions).toMatchObject([{ submissionId: id, actorUid: next.uid, decision: "imported" }]);
    expect((await db.collection("users").doc("reviewer").get()).data().active).toBe(false);
  });

  it("refuses to finalize a duplicate photo after the reviewer loses global access", async () => {
    const storage = stores();
    const first = await pending(storage);
    const second = await pending(storage);
    await handlers(storage).importSubmission(request({ submissionId: first.id,
      category: "general" }), response());
    const original = storage.ugc.read;
    storage.ugc.read = async (...args) => {
      const body = await original(...args);
      await db.collection("users").doc("reviewer").update({
        grants: [{ role: "editor", sections: ["general"] }],
      });
      return body;
    };
    const result = response();
    await handlers(storage).importSubmission(request({ submissionId: second.id,
      category: "general" }), result);

    expect(result.statusCode).toBe(403);
    expect((await db.collection("media_assets").get()).size).toBe(1);
    expect((await db.collection("ugcReviewAudit").get()).size).toBe(1);
    const row = (await db.collection("ugcSubmissions").doc(second.id).get()).data();
    expect(row).toMatchObject({ status: "pending", quarantineKey: second.key,
      email: "submitter@example.org" });
    expect(row.expireAt).toBeDefined();
    expect(row.importedAsset).toBeUndefined();
    expect(storage.quarantine.has(second.key)).toBe(true);
  });
});

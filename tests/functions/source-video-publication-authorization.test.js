import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import publication from "../../functions/source-video-publication.js";
import principals from "../../functions/lib/principal.js";
import renditions from "../../functions/lib/source-media-rendition.js";

const db = isolatedFirestore("source-video-publication-authorization.test.js");
const { createCmsPublishSourceVideoHandler } = publication;
const uid = "video-publication-scope-worker";
const assetId = "video-publication-scope-asset";
const postId = "video-publication-scope-post";
const paths = new Set();
const source = {
  id: "video-library", access: "active_staff", writable: true,
  prefix: "objects/", bucket: "private-originals", expectedBucketOwner: "123456789012",
};
const video = {
  id: "scope-video", type: "video", visible: true, order: 0,
  data: { sourceId: "video-library", assetId, title: "Scope fixture" },
};
const body = { sourceId: "video-library", assetId, collection: "cmsPosts", id: postId };

async function put(path, value) {
  paths.add(path);
  await db.doc(path).set(value);
}

function readyAsset() {
  const asset = {
    sourceId: "video-library", lifecycle: "active", name: "Scope fixture.mov",
    originalName: "Scope fixture.mov", nameSort: "scope fixture.mov",
    updatedAtSort: "2026-10-08T12:00:00.000Z", kind: "video", mimeType: "video/quicktime",
    sizeBytes: 128, objectKey: "objects/scope-fixture.mov", objectVersionId: "original-v1",
    preview: "download_only", rightsStatus: "complete", license: "Station owned",
    credit: "NJ PBS", tags: [], version: 1,
  };
  const prefix = renditions.sourceMediaRenditionOutputPrefix({ id: assetId, ...asset }, "attempt-1");
  asset.rendition = {
    schemaVersion: 1, state: "ready", attemptId: "attempt-1",
    sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, updatedAt: "2026-10-08T12:00:00.000Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 16,
      mimeType: "video/mp4", width: 1280, height: 720, durationSeconds: 1 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1",
      sizeBytes: 8, mimeType: "image/jpeg" },
  };
  return asset;
}

// Storage SDK boundaries retain the public objects, so denial proves no public copy exists.
function stores() {
  const objects = new Map();
  const s3 = { async send(command) {
    if (command.constructor.name !== "GetObjectCommand") throw new Error("Unexpected private storage request");
    const size = command.input.VersionId === "web-v1" ? 16 : 8;
    return { VersionId: command.input.VersionId, ContentLength: size, Body: Readable.from(Buffer.alloc(size, 1)) };
  } };
  const r2 = { async send(command) {
    const key = command.input.Key;
    if (command.constructor.name === "HeadObjectCommand") {
      if (objects.has(key)) return objects.get(key);
      const error = new Error("Not found");
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    if (command.constructor.name !== "PutObjectCommand") throw new Error("Unexpected public storage request");
    const chunks = [];
    for await (const chunk of command.input.Body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    objects.set(key, { ContentLength: bytes.length, ContentType: command.input.ContentType,
      CacheControl: command.input.CacheControl, bytes });
    return {};
  } };
  return { s3, r2, objects };
}

async function setup({ sections = ["watch"], content = {}, collection = "cmsPosts", id = postId,
  profile = { active: true, grants: [{ role: "editor", sections }] } } = {}) {
  await put(`users/${uid}`, profile);
  await put("sections/watch", { label: "Watch" });
  await put("sections/news", { label: "News" });
  if (content !== null) await put(`${collection}/${id}`, {
    type: "post", status: "approved", section: "watch", version: 7,
    createdBy: uid, blocks: [video], ...content,
  });
  await put(`mediaSourceAssets/${assetId}`, readyAsset());
  paths.add(`cmsPublicVideos/${assetId}`);
  const storage = stores();
  const handler = createCmsPublishSourceVideoHandler({
    firestore: db,
    // Auth-token verification is the boundary; user and grant resolution use the real database.
    requirePrincipalFn: async () => ({ uid, principal: await principals.registeredPrincipalFromUserDoc(
      db, uid, (await db.doc(`users/${uid}`).get()).data(),
    ) }),
    registryFn: () => new Map([[source.id, source]]),
    awsConfigFn: () => ({ renditionBucket: "private-renditions", renditionExpectedBucketOwner: source.expectedBucketOwner }),
    s3ClientFn: () => storage.s3,
    r2Fn: () => ({ client: storage.r2, bucket: "public-media" }),
    publicOriginFn: () => "https://media.njpbs.org",
    log: { info() {}, error() {} },
  });
  return { handler, storage };
}

async function call(handler, requestBody) {
  const result = { status: 200, headers: {} };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; },
  };
  await handler({ method: "POST", body: requestBody, headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(requestBody)) }, res);
  return result;
}

async function expectNoPublicCopy(storage) {
  expect(storage.objects.size).toBe(0);
  expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).exists).toBe(false);
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("This suite requires the local demo Firestore emulator");
});
afterEach(async () => {
  for (const path of paths) await db.doc(path).delete();
  paths.clear();
});

describe("public video content authorization (#2822)", () => {
  it.each([
    ["a site-wide editor", { active: true, grants: [{ role: "editor" }] }],
    ["an administrator", { active: true, role: "admin" }],
  ])("keeps the deployed Admin request working for %s", async (_name, profile) => {
    const { handler, storage } = await setup({ profile, content: null });
    const result = await call(handler, { sourceId: "video-library", assetId });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, media: { mimeType: "video/mp4" } });
    expect(storage.objects.size).toBe(2);
    expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).data()).toMatchObject({ publishedBy: uid, assetId });
  });

  it("binds entry videos to the saved Post and refuses withdrawn entries", async () => {
    const liveBlog = { updates: [{ id: "entry", media: { kind: "library-video", data: video.data } }] };
    const { handler, storage } = await setup({ content: { blocks: [], liveBlog } });
    expect((await call(handler, body)).status).toBe(200);
    expect(storage.objects.size).toBe(2);
    await db.doc(`cmsPublicVideos/${assetId}`).delete(); storage.objects.clear();
    await db.doc(`cmsPosts/${postId}`).update({ liveBlog: { updates: [{ ...liveBlog.updates[0], withdrawal: "Withdrawn" }] } });
    expect((await call(handler, body)).status).toBe(403);
    await expectNoPublicCopy(storage);
  });

  it("refuses an unbound request from a scoped editor before making a video public", async () => {
    const { handler, storage } = await setup();
    const result = await call(handler, { sourceId: "video-library", assetId });
    expect(result.status).toBe(400);
    await expectNoPublicCopy(storage);
  });

  it("refuses a scoped editor a video in another section", async () => {
    const { handler, storage } = await setup({ content: { section: "news" } });
    expect((await call(handler, body)).status).toBe(403);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["an unrelated video", [ { ...video, data: { ...video.data, assetId: "another-video" } } ]],
    ["a hidden video", [ { ...video, visible: false } ]],
    ["a video in a hidden row", [
      { id: "hidden-row", type: "row", visible: false, order: 0, data: { columns: [12] } },
      { ...video, order: 1, layout: { rowId: "hidden-row", column: 0 } },
    ]],
  ])("refuses %s even in an authorized section", async (_name, blocks) => {
    const { handler, storage } = await setup({ content: { blocks } });
    expect((await call(handler, body)).status).toBe(403);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["missing content", null, 403],
    ["deleted content", { deleted: true }, 403],
    ["an unassigned draft", { section: null, unassignedDraft: true, status: "draft" }, 403],
  ])("refuses %s without a public copy", async (_name, content, status) => {
    const { handler, storage } = await setup({ content });
    expect((await call(handler, body)).status).toBe(status);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["missing content", null],
    ["deleted content", { deleted: true }],
  ])("returns the same scoped denial for %s and an unauthorized record", async (_name, content) => {
    const { handler, storage } = await setup({ content });
    const absent = await call(handler, body);
    await expectNoPublicCopy(storage);
    await put(`cmsPosts/${postId}`, { section: "news", blocks: [video] });
    const unauthorized = await call(handler, body);
    expect(absent).toEqual(unauthorized);
    expect(absent).toMatchObject({ status: 403,
      body: { error: "You do not have permission to publish this content" },
      headers: { "Cache-Control": "private, no-store" } });
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["missing content", null],
    ["deleted content", { deleted: true }],
  ])("retains an honest not-found answer for site-wide publishers of %s", async (_name, content) => {
    const { handler, storage } = await setup({ content, profile: { active: true, grants: [{ role: "editor" }] } });
    expect(await call(handler, body)).toMatchObject({ status: 404, body: { error: "Content not found" } });
    await expectNoPublicCopy(storage);
  });

  it("uses the canonical page section instead of a forged stored section", async () => {
    const { handler, storage } = await setup({ collection: "cmsPages", id: "about", content: { section: "watch" } });
    expect((await call(handler, { ...body, collection: "cmsPages", id: "about" })).status).toBe(403);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["an unsupported collection", { ...body, collection: "users" }],
    ["a document path", { ...body, id: "post/nested" }],
    ["a client-supplied section", { ...body, section: "watch" }],
    ["a collection without an id", { sourceId: "video-library", assetId, collection: "cmsPosts" }],
    ["an id without a collection", { sourceId: "video-library", assetId, id: postId }],
  ])("refuses %s", async (_name, requestBody) => {
    const { handler, storage } = await setup();
    expect((await call(handler, requestBody)).status).toBe(400);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["a contributor", { active: true, grants: [{ role: "contributor", sections: ["watch"] }] }],
    ["an inactive editor", { active: false, grants: [{ role: "editor", sections: ["watch"] }] }],
    ["an empty grant", { active: true, grants: [{ role: "editor", sections: [] }] }],
  ])("refuses %s without a public copy", async (_name, profile) => {
    const { handler, storage } = await setup({ profile });
    expect((await call(handler, body)).status).toBe(403);
    await expectNoPublicCopy(storage);
  });

  it.each([
    ["a scoped editor", {}],
    ["a site-wide editor", { sections: undefined, profile: { active: true, grants: [{ role: "editor" }] } }],
    ["an administrator", { profile: { active: true, role: "admin" } }],
    ["a canonical page", { collection: "cmsPages", id: "watch", content: { section: "news" } }],
  ])("allows %s to publish a visible video in authorized content", async (_name, options) => {
    const { handler, storage } = await setup(options);
    const result = await call(handler, { ...body, collection: options.collection ?? body.collection, id: options.id ?? body.id });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, media: { mimeType: "video/mp4", width: 1280, height: 720 } });
    expect(storage.objects.size).toBe(2);
    expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).data()).toMatchObject({ publishedBy: uid, assetId });
  });
});

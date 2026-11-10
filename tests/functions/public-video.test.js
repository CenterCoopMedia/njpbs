import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import publicVideo from "../../functions/lib/public-video.js";
import sourceVideoPublication from "../../functions/source-video-publication.js";
import sourceContract from "../../functions/lib/source-media-contract.js";
import renditionContract from "../../functions/lib/source-media-rendition.js";

const {
  PublicVideoError,
  previewVideoState,
  previewVideosCurrent,
  publicVideoKeys,
  publishSourceVideo,
  withPreviewVideos,
  withPublicVideos,
} = publicVideo;
const { createCmsPublishSourceVideoHandler } = sourceVideoPublication;
const { parseSourceMediaAsset } = sourceContract;
const { sourceMediaRenditionOutputPrefix } = renditionContract;

const ASSET_ID = "asset-1";
const WEB_VERSION = "web-version-id";
const POSTER_VERSION = "poster-version-id";
const WEB_SIZE = 2_000_000;
const POSTER_SIZE = 24_000;
const RENDITION_BUCKET = "njpbs-video-renditions-123456789012-us-east-2";
const BUCKET_OWNER = "123456789012";
const R2_BUCKET = "njpbs-cms-media";
const ORIGIN = "https://media.njpbs.org";
const IMMUTABLE = "public, max-age=31536000, immutable";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const VIDEO_KEY = `cms-media/video/${ASSET_ID}/${sha256(WEB_VERSION)}.mp4`;
const POSTER_KEY = `cms-media/video/${ASSET_ID}/${sha256(POSTER_VERSION)}.jpg`;
const VIDEO_URL = `${ORIGIN}/${VIDEO_KEY}`;
const POSTER_URL = `${ORIGIN}/${POSTER_KEY}`;

// Same stored-asset shape as tests/functions/source-media-rendition.test.js.
function storedAsset(overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: "County meeting.mxf",
    originalName: "County meeting.mxf",
    description: "A county government meeting.",
    nameSort: "county meeting.mxf",
    updatedAtSort: "2026-09-14T16:00:00.000Z",
    mimeType: "application/mxf",
    kind: "video",
    sizeBytes: 8_000_000,
    preview: "download_only",
    rightsStatus: "complete",
    license: "Station owned",
    credit: "NJ PBS",
    tags: ["county"],
    version: 1,
    createdAt: "2026-09-14T15:00:00.000Z",
    updatedAt: "2026-09-14T16:00:00.000Z",
    objectKey: "objects/county-meeting.mxf",
    objectVersionId: "original-version-id",
    ...overrides,
  };
}

function readyRendition(assetValue, { web = {}, ...overrides } = {}) {
  const attemptId = "attempt-1";
  const prefix = sourceMediaRenditionOutputPrefix({ id: ASSET_ID, ...assetValue }, attemptId);
  return {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: assetValue.objectKey,
    sourceObjectVersionId: assetValue.objectVersionId,
    sourceSizeBytes: assetValue.sizeBytes,
    attemptId,
    updatedAt: "2026-09-14T16:02:00.000Z",
    web: {
      objectKey: `${prefix}preview.mp4`,
      objectVersionId: WEB_VERSION,
      sizeBytes: WEB_SIZE,
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      durationSeconds: 92.5,
      ...web,
    },
    poster: {
      objectKey: `${prefix}preview-poster.0000000.jpg`,
      objectVersionId: POSTER_VERSION,
      sizeBytes: POSTER_SIZE,
      mimeType: "image/jpeg",
    },
    ...overrides,
  };
}

function storedReadyDoc({ asset = {}, rendition } = {}) {
  const value = storedAsset(asset);
  return { ...value, rendition: rendition === undefined ? readyRendition(value) : rendition(value) };
}

function parsedAsset(options) {
  const asset = parseSourceMediaAsset(ASSET_ID, storedReadyDoc(options));
  expect(asset).not.toBeNull();
  return asset;
}

// Minimal Firestore fake: collection(name).doc(id).get()/set(), plus a tx.get().
function memoryFirestore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  const ref = (collection, id) => ({
    path: `${collection}/${id}`,
    id,
    async get() {
      reads.push(this.path);
      const data = docs.get(this.path);
      return { id, exists: data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
    },
    async set(value) {
      writes.push({ path: this.path, value: structuredClone(value) });
      docs.set(this.path, structuredClone(value));
    },
  });
  const firestore = {
    collection: (collection) => ({ doc: (id) => ref(collection, id) }),
  };
  const tx = {
    get: (docRef) => docRef.get(),
    getAll: (...docRefs) => Promise.all(docRefs.map((docRef) => docRef.get())),
    set: (docRef, value) => docRef.set(value),
    delete: (docRef) => docs.delete(docRef.path),
  };
  firestore.runTransaction = (callback) => callback(tx);
  return { firestore, tx, docs, reads, writes };
}

function notFound() {
  const error = new Error("NotFound");
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

// S3/R2 fakes at the SDK boundary: an object with send(command).
function fakeStores({ r2Heads = {}, s3Objects } = {}) {
  const s3Calls = [];
  const r2Calls = [];
  const bodies = [];
  const objects = s3Objects ?? {
    [WEB_VERSION]: { VersionId: WEB_VERSION, ContentLength: WEB_SIZE },
    [POSTER_VERSION]: { VersionId: POSTER_VERSION, ContentLength: POSTER_SIZE },
  };
  const s3 = {
    send: vi.fn(async (command) => {
      s3Calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name !== "GetObjectCommand") throw new Error("unexpected S3 command");
      const object = objects[command.input.VersionId];
      if (!object) throw new Error("unknown version");
      const Body = { destroy: vi.fn(), version: command.input.VersionId };
      bodies.push(Body);
      return { ...object, Body };
    }),
  };
  const r2 = {
    send: vi.fn(async (command) => {
      r2Calls.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "HeadObjectCommand") {
        const head = r2Heads[command.input.Key];
        if (!head) throw notFound();
        return head;
      }
      if (command.constructor.name === "PutObjectCommand") return {};
      throw new Error("unexpected R2 command");
    }),
  };
  return { s3, r2, s3Calls, r2Calls, bodies };
}

function publishArgs(overrides) {
  return {
    r2Bucket: R2_BUCKET,
    renditionBucket: RENDITION_BUCKET,
    expectedBucketOwner: BUCKET_OWNER,
    publicOrigin: ORIGIN,
    actorUid: "editor-1",
    now: () => "2026-10-07T12:00:00.000Z",
    ...overrides,
  };
}

function storedMedia(overrides = {}) {
  return { url: VIDEO_URL, posterUrl: POSTER_URL, width: 1280, height: 720, mimeType: "video/mp4", ...overrides };
}

function videoBlock(id, assetId, extra = {}) {
  return {
    id,
    type: "video",
    visible: true,
    order: 0,
    data: { sourceId: "video-library", assetId, title: `Video ${id}` },
    ...extra,
  };
}

describe("publicVideoKeys", () => {
  it("names the R2 keys by the sha256 hex of each object version", () => {
    expect(publicVideoKeys(ASSET_ID, { objectVersionId: WEB_VERSION }, { objectVersionId: POSTER_VERSION })).toEqual({
      video: VIDEO_KEY,
      poster: POSTER_KEY,
    });
    expect(VIDEO_KEY).toMatch(/^cms-media\/video\/asset-1\/[a-f0-9]{64}\.mp4$/);
  });
});

describe("publishSourceVideo", () => {
  function multipartStores(webChunks) {
    const r2Calls = [];
    const s3 = {
      send: vi.fn(async (command) => {
        const web = command.input.VersionId === WEB_VERSION;
        const chunks = web ? webChunks : [Buffer.alloc(POSTER_SIZE)];
        return {
          VersionId: command.input.VersionId,
          ContentLength: web ? WEB_SIZE : POSTER_SIZE,
          Body: { destroy: vi.fn(), async *[Symbol.asyncIterator]() { yield* chunks; } },
        };
      }),
    };
    const r2 = {
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        r2Calls.push({ name, input: command.input, size: command.input.Body?.length });
        if (name === "HeadObjectCommand") throw notFound();
        if (name === "CreateMultipartUploadCommand") return { UploadId: "upload-1" };
        if (name === "UploadPartCommand") return { ETag: `"etag-${command.input.PartNumber}"` };
        return {};
      }),
    };
    return { s3, r2, r2Calls };
  }
  const smallParts = { thresholdBytes: 1_000_000, partBytes: 600_000 };

  it("copies a viewing copy above the single-PUT limit in equal parts", async () => {
    const stores = multipartStores(Array.from({ length: 8 }, () => Buffer.alloc(WEB_SIZE / 8)));
    const { firestore } = memoryFirestore();

    await publishSourceVideo({ firestore, asset: parsedAsset(), s3: stores.s3, r2: stores.r2, ...publishArgs(), multipart: smallParts });

    const names = stores.r2Calls.map((call) => call.name);
    expect(names).toEqual([
      "HeadObjectCommand", "CreateMultipartUploadCommand",
      "UploadPartCommand", "UploadPartCommand", "UploadPartCommand", "UploadPartCommand",
      "CompleteMultipartUploadCommand", "HeadObjectCommand", "PutObjectCommand",
    ]);
    expect(stores.r2Calls[1].input).toMatchObject({ Bucket: R2_BUCKET, Key: VIDEO_KEY, ContentType: "video/mp4", CacheControl: IMMUTABLE });
    expect(stores.r2Calls.filter((call) => call.name === "UploadPartCommand").map((call) => [call.input.PartNumber, call.size]))
      .toEqual([[1, 600_000], [2, 600_000], [3, 600_000], [4, 200_000]]);
    expect(stores.r2Calls[6].input.MultipartUpload.Parts).toEqual([1, 2, 3, 4].map((n) => ({ ETag: `"etag-${n}"`, PartNumber: n })));
  });

  it("aborts a multipart copy when the stream ends short, and records nothing", async () => {
    const stores = multipartStores([Buffer.alloc(WEB_SIZE - 1)]);
    const { firestore, docs } = memoryFirestore();

    await expect(publishSourceVideo({ firestore, asset: parsedAsset(), s3: stores.s3, r2: stores.r2, ...publishArgs(), multipart: smallParts }))
      .rejects.toMatchObject({ status: 409 });
    const names = stores.r2Calls.map((call) => call.name);
    expect(names).toContain("AbortMultipartUploadCommand");
    expect(names).not.toContain("CompleteMultipartUploadCommand");
    expect(docs.has(`cmsPublicVideos/${ASSET_ID}`)).toBe(false);
  });

  it("copies the exact web and poster versions to R2 and records the public media", async () => {
    const asset = parsedAsset();
    const stores = fakeStores();
    const { firestore, docs } = memoryFirestore();

    const result = await publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() });

    const gets = stores.s3Calls.filter((call) => call.name === "GetObjectCommand");
    expect(gets.map((call) => call.input)).toEqual([
      { Bucket: RENDITION_BUCKET, Key: asset.rendition.web.objectKey, VersionId: WEB_VERSION, ExpectedBucketOwner: BUCKET_OWNER },
      { Bucket: RENDITION_BUCKET, Key: asset.rendition.poster.objectKey, VersionId: POSTER_VERSION, ExpectedBucketOwner: BUCKET_OWNER },
    ]);
    const puts = stores.r2Calls.filter((call) => call.name === "PutObjectCommand");
    expect(puts).toHaveLength(2);
    expect(puts[0].input).toMatchObject({
      Bucket: R2_BUCKET, Key: VIDEO_KEY, ContentType: "video/mp4", CacheControl: IMMUTABLE, ContentLength: WEB_SIZE,
    });
    expect(puts[0].input.Body).toBe(stores.bodies[0]);
    expect(puts[1].input).toMatchObject({
      Bucket: R2_BUCKET, Key: POSTER_KEY, ContentType: "image/jpeg", CacheControl: IMMUTABLE, ContentLength: POSTER_SIZE,
    });

    const media = storedMedia();
    expect(result).toEqual({ media, copied: true });
    expect(docs.get(`cmsPublicVideos/${ASSET_ID}`)).toMatchObject({
      schemaVersion: 1,
      sourceId: "video-library",
      assetId: ASSET_ID,
      webVersionId: WEB_VERSION,
      posterVersionId: POSTER_VERSION,
      media,
      publishedAt: "2026-10-07T12:00:00.000Z",
      publishedBy: "editor-1",
    });
  });

  it("defaults width and height to 1920x1080 when the rendition lacks them", async () => {
    const asset = parseSourceMediaAsset(ASSET_ID, storedReadyDoc({
      rendition: (value) => {
        const rendition = readyRendition(value);
        delete rendition.web.width;
        delete rendition.web.height;
        return rendition;
      },
    }));
    const stores = fakeStores();
    const { firestore, docs } = memoryFirestore();
    const result = await publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() });
    expect(result.media).toMatchObject({ width: 1920, height: 1080 });
    expect(docs.get(`cmsPublicVideos/${ASSET_ID}`).media).toMatchObject({ width: 1920, height: 1080 });
  });

  it("keeps existing R2 objects of the right size without reading S3 or writing R2", async () => {
    const asset = parsedAsset();
    const stores = fakeStores({
      r2Heads: { [VIDEO_KEY]: { ContentLength: WEB_SIZE }, [POSTER_KEY]: { ContentLength: POSTER_SIZE } },
    });
    const { firestore, docs } = memoryFirestore();
    const result = await publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() });
    expect(stores.s3.send).not.toHaveBeenCalled();
    expect(stores.r2Calls.map((call) => call.name)).toEqual(["HeadObjectCommand", "HeadObjectCommand"]);
    expect(result).toEqual({ media: storedMedia(), copied: false });
    expect(docs.get(`cmsPublicVideos/${ASSET_ID}`).media).toEqual(storedMedia());
  });

  it("rejects with 409 and writes nothing when S3 returns a different version", async () => {
    const asset = parsedAsset();
    const stores = fakeStores({
      s3Objects: { [WEB_VERSION]: { VersionId: "someone-else", ContentLength: WEB_SIZE } },
    });
    const { firestore, writes } = memoryFirestore();
    const error = await publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PublicVideoError);
    expect(error.status).toBe(409);
    expect(stores.r2Calls.some((call) => call.name === "PutObjectCommand")).toBe(false);
    expect(stores.bodies[0].destroy).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("rejects with 409 when the rendition is not ready", async () => {
    const asset = parseSourceMediaAsset(ASSET_ID, storedReadyDoc({
      rendition: (value) => {
        const { web: _web, poster: _poster, ...rest } = readyRendition(value);
        return { ...rest, state: "processing" };
      },
    }));
    expect(asset.rendition.state).toBe("processing");
    const stores = fakeStores();
    const { firestore, writes } = memoryFirestore();
    await expect(publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() }))
      .rejects.toMatchObject({ name: "PublicVideoError", status: 409 });
    expect(stores.s3.send).not.toHaveBeenCalled();
    expect(stores.r2.send).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("rejects with 400 for an asset outside the video library", async () => {
    const asset = parsedAsset({ asset: { sourceId: "audio-library" } });
    const stores = fakeStores();
    const { firestore, writes } = memoryFirestore();
    await expect(publishSourceVideo({ firestore, asset, s3: stores.s3, r2: stores.r2, ...publishArgs() }))
      .rejects.toMatchObject({ name: "PublicVideoError", status: 400 });
    expect(stores.r2.send).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("withPublicVideos", () => {
  const record = {
    schemaVersion: 1,
    sourceId: "video-library",
    assetId: ASSET_ID,
    media: storedMedia(),
  };

  it("stamps public on visible video blocks and replaces a client-supplied stale value", async () => {
    const { firestore, tx } = memoryFirestore({ [`cmsPublicVideos/${ASSET_ID}`]: record });
    const stale = storedMedia({ url: `${ORIGIN}/cms-media/video/${ASSET_ID}/${sha256("old")}.mp4` });
    const text = { id: "t1", type: "text", visible: true, order: 0, data: { html: "<p>Hi</p>" } };
    const block = videoBlock("v1", ASSET_ID);
    block.data.public = stale;
    const document = { title: "Story", blocks: [text, block] };

    const result = await withPublicVideos({ tx, firestore, document });
    expect(result.title).toBe("Story");
    expect(result.blocks[0]).toEqual(text);
    expect(result.blocks[1].data).toEqual({
      sourceId: "video-library", assetId: ASSET_ID, title: "Video v1", public: storedMedia(),
    });
    expect(document.blocks[1].data.public).toBe(stale);
  });

  it("stamps a lead-only library video through the same public-copy contract", async () => {
    const { firestore, tx, reads } = memoryFirestore({ [`cmsPublicVideos/${ASSET_ID}`]: record });
    const document = { blocks: [], leadMedia: { kind: "library-video", data: videoBlock("v1", ASSET_ID).data } };
    const result = await withPublicVideos({ tx, firestore, document, collection: "cmsPosts", documentId: "post-one" });
    expect(result.leadMedia.data.public).toEqual(storedMedia());
    expect(result.blocks).toEqual([]);
    expect(reads).toEqual([`cmsPublicVideos/${ASSET_ID}`]);
    expect(document.leadMedia.data).not.toHaveProperty("public");
    await expect(withPublicVideos({ ...memoryFirestore(), document, collection: "cmsPosts", documentId: "post-one" }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("strips public from a hidden video block and needs no record for it", async () => {
    const { firestore, tx, reads } = memoryFirestore({ [`cmsPublicVideos/${ASSET_ID}`]: record });
    const hidden = videoBlock("v2", "asset-without-record", { visible: false, order: 1 });
    hidden.data.public = storedMedia();
    const document = { blocks: [videoBlock("v1", ASSET_ID), hidden] };

    const result = await withPublicVideos({ tx, firestore, document });
    expect(result.blocks[0].data.public).toEqual(storedMedia());
    expect(result.blocks[1].data).not.toHaveProperty("public");
    expect(reads).toEqual([`cmsPublicVideos/${ASSET_ID}`]);
  });

  it("treats a video inside a hidden row as hidden", async () => {
    const { firestore, tx, reads } = memoryFirestore();
    const row = { id: "r1", type: "row", visible: false, order: 0, data: { columns: [{}, {}] } };
    const inRow = videoBlock("v1", "asset-without-record", { order: 1, layout: { rowId: "r1", column: 0 } });
    const result = await withPublicVideos({ tx, firestore, document: { blocks: [row, inRow] } });
    expect(result.blocks[1].data).not.toHaveProperty("public");
    expect(reads).toEqual([]);
  });

  it("rejects with 409 when a visible video has no public record", async () => {
    const { firestore, tx } = memoryFirestore();
    const error = await withPublicVideos({ tx, firestore, document: { blocks: [videoBlock("v1", ASSET_ID)] } })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PublicVideoError);
    expect(error.status).toBe(409);
  });

  it("rejects with 409 when the stored record has invalid media", async () => {
    const { firestore, tx } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: { ...record, media: { ...record.media, url: "https://evil.example/x.mp4" } },
    });
    await expect(withPublicVideos({ tx, firestore, document: { blocks: [videoBlock("v1", ASSET_ID)] } }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("refuses a visible video on the runtime Contact page with 400, and allows a hidden one", async () => {
    const { firestore, tx, reads } = memoryFirestore({ [`cmsPublicVideos/${ASSET_ID}`]: record });
    await expect(withPublicVideos({
      tx, firestore, collection: "cmsPages", documentId: "contact",
      document: { blocks: [videoBlock("v1", ASSET_ID)] },
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Contact page cannot show a video/) });
    expect(reads).toEqual([]);

    const hidden = await withPublicVideos({
      tx, firestore, collection: "cmsPages", documentId: "contact",
      document: { blocks: [videoBlock("v1", ASSET_ID, { visible: false })] },
    });
    expect(hidden.blocks[0].data).not.toHaveProperty("public");

    const about = await withPublicVideos({
      tx, firestore, collection: "cmsPages", documentId: "about",
      document: { blocks: [videoBlock("v1", ASSET_ID)] },
    });
    expect(about.blocks[0].data.public).toEqual(storedMedia());
  });

  it("returns a document without video blocks unchanged and reads nothing", async () => {
    const { firestore, tx, reads } = memoryFirestore();
    const document = { blocks: [{ id: "t1", type: "text", visible: true, order: 0, data: { html: "<p>x</p>" } }] };
    expect(await withPublicVideos({ tx, firestore, document })).toBe(document);
    expect(reads).toEqual([]);
  });
});

// #2760: a draft preview may show only the existing public copy of the current
// viewing copy. It never creates one, never fails the preview, and never writes.
describe("withPreviewVideos", () => {
  const record = {
    schemaVersion: 1,
    sourceId: "video-library",
    assetId: ASSET_ID,
    webVersionId: WEB_VERSION,
    media: storedMedia(),
  };
  const asset = storedReadyDoc();

  it("stamps the public copy when it matches the current viewing copy", async () => {
    const { firestore, tx, writes } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: record,
      [`mediaSourceAssets/${ASSET_ID}`]: asset,
    });
    const block = videoBlock("v1", ASSET_ID);
    block.data.public = storedMedia({ url: "https://evil.example/x.mp4" });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [block] } });
    expect(result.blocks[0].data).toEqual({
      sourceId: "video-library", assetId: ASSET_ID, title: "Video v1", public: storedMedia(),
    });
    expect(writes).toEqual([]);
  });

  it("previews a lead-only video only while its public copy matches the current viewing copy", async () => {
    const { firestore, tx, writes } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: { ...record, webVersionId: "older-web-version" },
      [`mediaSourceAssets/${ASSET_ID}`]: asset,
    });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [],
      leadMedia: { kind: "library-video", data: { ...videoBlock("v1", ASSET_ID).data, public: storedMedia() } } } });
    expect(result.leadMedia.data).not.toHaveProperty("public");
    expect(result.blocks).toEqual([]);
    expect(previewVideoState(result)).toEqual({ [ASSET_ID]: null });
    expect(writes).toEqual([]);
  });

  it("leaves no public data when the public copy is of an older viewing copy", async () => {
    const { firestore, tx } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: { ...record, webVersionId: "older-web-version" },
      [`mediaSourceAssets/${ASSET_ID}`]: asset,
    });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [videoBlock("v1", ASSET_ID)] } });
    expect(result.blocks[0].data).not.toHaveProperty("public");
  });

  it("accepts a never-published or missing video without public data and without writing", async () => {
    const { firestore, tx, writes } = memoryFirestore({ [`mediaSourceAssets/${ASSET_ID}`]: asset });
    const unpublished = videoBlock("v1", ASSET_ID);
    unpublished.data.public = storedMedia();
    const missing = videoBlock("v2", "asset-deleted", { order: 1 });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [unpublished, missing] } });
    expect(result.blocks[0].data).not.toHaveProperty("public");
    expect(result.blocks[1].data).not.toHaveProperty("public");
    expect(writes).toEqual([]);
  });

  it("strips public from a hidden video block and reads nothing for it", async () => {
    const { firestore, tx, reads } = memoryFirestore();
    const hidden = videoBlock("v1", ASSET_ID, { visible: false });
    hidden.data.public = storedMedia();
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [hidden] } });
    expect(result.blocks[0].data).not.toHaveProperty("public");
    expect(reads).toEqual([]);
  });

  it("ignores stored media outside the public media origin", async () => {
    const { firestore, tx } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: {
        ...record,
        media: storedMedia({ url: `https://njpbs-video.s3.us-east-2.amazonaws.com/${VIDEO_KEY}?X-Amz-Signature=x` }),
      },
      [`mediaSourceAssets/${ASSET_ID}`]: asset,
    });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [videoBlock("v1", ASSET_ID)] } });
    expect(result.blocks[0].data).not.toHaveProperty("public");
  });

  it("shows no public copy of a deleted library item, as publishing would refuse it", async () => {
    const { firestore, tx } = memoryFirestore({
      [`cmsPublicVideos/${ASSET_ID}`]: record,
      [`mediaSourceAssets/${ASSET_ID}`]: storedReadyDoc({ asset: { lifecycle: "deleted" } }),
    });
    const result = await withPreviewVideos({ tx, firestore, document: { blocks: [videoBlock("v1", ASSET_ID)] } });
    expect(result.blocks[0].data).not.toHaveProperty("public");
  });

  it("keeps the preview for a draft asset id that is not a document id, and reads nothing", async () => {
    const { firestore, tx, reads } = memoryFirestore();
    const result = await withPreviewVideos({
      tx, firestore, document: { blocks: [videoBlock("v1", "a/b"), videoBlock("v2", "c/d/e", { order: 1 })] },
    });
    expect(result.blocks.map((block) => block.data)).toEqual([
      { sourceId: "video-library", assetId: "a/b", title: "Video v1" },
      { sourceId: "video-library", assetId: "c/d/e", title: "Video v2" },
    ]);
    expect(reads).toEqual([]);
  });

  it("marks a built preview stale when its video's public copy or library item changes", async () => {
    const { firestore, tx, docs } = memoryFirestore({ [`mediaSourceAssets/${ASSET_ID}`]: asset });
    const document = { blocks: [videoBlock("v1", ASSET_ID)] };
    const placeholder = previewVideoState(await withPreviewVideos({ tx, firestore, document }));
    expect(placeholder).toEqual({ [ASSET_ID]: null });
    expect(await previewVideosCurrent({ tx, firestore, state: placeholder })).toBe(true);

    docs.set(`cmsPublicVideos/${ASSET_ID}`, record);
    expect(await previewVideosCurrent({ tx, firestore, state: placeholder })).toBe(false);
    const playing = previewVideoState(await withPreviewVideos({ tx, firestore, document }));
    expect(playing).toEqual({ [ASSET_ID]: VIDEO_URL });
    expect(await previewVideosCurrent({ tx, firestore, state: playing })).toBe(true);

    const newCut = `${ORIGIN}/cms-media/video/${ASSET_ID}/${sha256("web-version-2")}.mp4`;
    docs.set(`mediaSourceAssets/${ASSET_ID}`, storedReadyDoc({
      rendition: (value) => readyRendition(value, { web: { objectVersionId: "web-version-2" } }),
    }));
    docs.set(`cmsPublicVideos/${ASSET_ID}`, { ...record, webVersionId: "web-version-2", media: storedMedia({ url: newCut }) });
    expect(await previewVideosCurrent({ tx, firestore, state: playing })).toBe(false);

    docs.set(`mediaSourceAssets/${ASSET_ID}`, storedReadyDoc({ asset: { lifecycle: "deleted" } }));
    docs.set(`cmsPublicVideos/${ASSET_ID}`, record);
    expect(await previewVideosCurrent({ tx, firestore, state: playing })).toBe(false);
  });

  it("records no video state for a preview without a visible video", () => {
    expect(previewVideoState({ blocks: [videoBlock("v1", ASSET_ID, { visible: false })] })).toBeNull();
    expect(previewVideoState({ blocks: [] })).toBeNull();
  });
});

describe("cmsPublishSourceVideo handler", () => {
  function response() {
    const res = { statusCode: null, body: null, headersSent: false, headers: new Map() };
    res.set = (name, value) => { res.headers.set(name.toLowerCase(), value); return res; };
    res.status = (statusCode) => { res.statusCode = statusCode; return res; };
    res.json = (body) => { res.body = body; res.headersSent = true; return res; };
    return res;
  }

  function request(body, method = "POST") {
    return {
      method,
      body,
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify(body ?? null)),
    };
  }

  function source() {
    return {
      id: "video-library",
      label: "Shared video library",
      description: "Station video.",
      mediaKind: "video",
      bucket: "njpbs-video-originals-123456789012-us-east-2",
      expectedBucketOwner: BUCKET_OWNER,
      prefix: "objects/",
      roleArn: "arn:aws:iam::123456789012:role/njpbs-boardwalk-video-read",
      access: "active_staff",
      writable: true,
      enabled: true,
    };
  }

  function setup({ role = "editor", stored = storedReadyDoc(), r2Fn, sections, content } = {}) {
    const memory = memoryFirestore({
      ...(stored ? { [`mediaSourceAssets/${ASSET_ID}`]: stored } : {}),
      "cmsPosts/post-1": { type: "post", section: "watch", blocks: [videoBlock("v1", ASSET_ID)], ...content },
    });
    const stores = fakeStores();
    const authorizeFn = vi.fn(async () => {});
    const s3ClientFn = vi.fn(() => stores.s3);
    const handler = createCmsPublishSourceVideoHandler({
      firestore: memory.firestore,
      requirePrincipalFn: async () => ({ uid: "editor-1", principal: { id: "editor-1", grants: [{ role, ...(sections ? { sections } : {}) }] } }),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn,
      awsConfigFn: () => ({
        audience: "aud", region: "us-east-2", renditionBucket: RENDITION_BUCKET, renditionExpectedBucketOwner: BUCKET_OWNER,
      }),
      r2Fn: r2Fn ?? (() => ({ client: stores.r2, bucket: R2_BUCKET })),
      publicOriginFn: () => ORIGIN,
      s3ClientFn,
      log: { info: vi.fn(), error: vi.fn() },
    });
    return { handler, memory, stores, authorizeFn, s3ClientFn };
  }

  const body = { sourceId: "video-library", assetId: ASSET_ID, collection: "cmsPosts", id: "post-1" };

  it("rejects GET with 405", async () => {
    const { handler } = setup();
    const res = response();
    await handler(request(undefined, "GET"), res);
    expect(res.statusCode).toBe(405);
  });

  it.each([
    ["a non video-library source", { sourceId: "audio-library", assetId: ASSET_ID }],
    ["an extra key", { ...body, extra: true }],
    ["a missing asset id", { sourceId: "video-library" }],
  ])("rejects %s with 400", async (_label, value) => {
    const { handler, memory } = setup();
    const res = response();
    await handler(request(value), res);
    expect(res.statusCode).toBe(400);
    expect(memory.reads).toEqual([]);
  });

  it("rejects with 403 when the principal can neither publish nor manage schedules", async () => {
    const { handler, memory, authorizeFn } = setup({ role: "contributor" });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(403);
    expect(authorizeFn).not.toHaveBeenCalled();
    expect(memory.reads).toEqual([]);
  });

  it("returns 404 when the asset is missing", async () => {
    const { handler, stores } = setup({ stored: null });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(404);
    expect(stores.r2.send).not.toHaveBeenCalled();
  });

  it.each(["processing", "failed"])("reports an unchanged %s viewing copy without claiming public storage", async state => {
    const stored = storedReadyDoc();
    stored.rendition.state = state;
    const { handler, stores, memory } = setup({ stored });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("This video has no ready viewing copy yet.");
    expect(stores.s3.send).not.toHaveBeenCalled();
    expect(stores.r2.send).not.toHaveBeenCalled();
    expect(memory.docs.get(`cmsPublicVideos/${ASSET_ID}`)).toBeUndefined();
  });

  it("returns 404 when the stored asset belongs to another source", async () => {
    const { handler, stores } = setup({ stored: storedReadyDoc({ asset: { sourceId: "audio-library" } }) });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(404);
    expect(stores.r2.send).not.toHaveBeenCalled();
  });

  it("returns 503 when the public media store is not configured", async () => {
    const { handler, memory } = setup({
      r2Fn: () => { throw new PublicVideoError("The public media store is not configured", 503); },
    });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(503);
    expect(memory.writes).toEqual([]);
  });

  it.each([[ASSET_ID, 200], ["unrelated-video", 403]])("binds a scoped lead-only copy to the saved asset %s", async (selected, status) => {
    const { handler, memory, stores } = setup({ sections: ["watch"], content: { blocks: [],
      leadMedia: { kind: "library-video", data: videoBlock("v1", selected).data } } });
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(memory.docs.get(`cmsPublicVideos/${ASSET_ID}`)).toMatchObject({ media: storedMedia() });
    else { expect(stores.r2.send).not.toHaveBeenCalled(); expect(memory.writes).toEqual([]); }
  });

  it("publishes and returns the public media with 200", async () => {
    const { handler, memory, s3ClientFn } = setup();
    const res = response();
    await handler(request(body), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, media: storedMedia() });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(s3ClientFn).toHaveBeenCalledWith(expect.objectContaining({ id: "video-library" }), expect.anything());
    expect(memory.docs.get(`cmsPublicVideos/${ASSET_ID}`)).toMatchObject({ media: storedMedia(), publishedBy: "editor-1" });
  });
});

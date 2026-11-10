"use strict";
const { liveBlogVideoBlocks } = require("./live-blog");
const { leadVideoBlocks, withoutPublicLeadVideo } = require("./post-lead-media");

// Public copies of video-library viewing copies (#2751).
//
// Boardwalk calls cmsPublishSourceVideo for each video block before it publishes or
// schedules. That copies the exact S3 object versions of the 1080p web MP4 and its
// poster to R2 under cms-media/video/, then records the public URLs in
// cmsPublicVideos/{assetId}. The save and scheduler transactions read that record and
// stamp `public` into the published snapshot only. They never call AWS or R2.
//
// The R2 key names the object version, so a copy is idempotent: the same version
// always lands on the same key and an existing object of the right size is kept.

const { createHash, randomUUID } = require("node:crypto");
const {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} = require("@aws-sdk/client-s3");
const { isMissingObject } = require("./r2-media");
const {
  VIDEO_BLOCK_SOURCE_ID,
  isPublicVideoData,
} = require("./video-block");
const { visibleLayoutBlocks } = require("./content-layout");
const { ID_PATTERN, parseSourceMediaAsset } = require("./source-media-contract");

const PUBLIC_VIDEO_COLLECTION = "cmsPublicVideos";
const PUBLIC_VIDEO_SCHEMA_VERSION = 1;
// Longer than the copy Function's 540-second deadline and withdrawal's 300 seconds.
const PUBLIC_VIDEO_OPERATION_MS = 15 * 60_000;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// R2 refuses a single PUT above 5 GiB. A larger viewing copy goes up in parts; every
// part but the last has the same size, as R2 requires.
const MULTIPART = Object.freeze({ thresholdBytes: 4 * 1024 ** 3, partBytes: 64 * 1024 ** 2 });
// Pages the public worker renders at runtime inside a built shell that can load
// analytics. They cannot carry a video (VPPA), so a publish refuses one plainly.
const RUNTIME_PAGE_IDS = new Set(["contact"]);

class PublicVideoError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "PublicVideoError";
    this.status = status;
  }
}

function versionName(versionId, publicGeneration) {
  const identity = publicGeneration > 0 ? JSON.stringify([versionId, publicGeneration]) : String(versionId);
  return createHash("sha256").update(identity).digest("hex");
}

function publicVideoKeys(assetId, web, poster, publicGeneration = 0) {
  return {
    video: `cms-media/video/${assetId}/${versionName(web.objectVersionId, publicGeneration)}.mp4`,
    poster: `cms-media/video/${assetId}/${versionName(poster.objectVersionId, publicGeneration)}.jpg`,
  };
}

function publicUrl(origin, key) {
  return `${String(origin).replace(/\/+$/, "")}/${key}`;
}

/** The ready rendition of an asset from parseSourceMediaAsset, or a 409 for staff. */
function readyRendition(asset) {
  const rendition = asset.rendition;
  if (rendition?.state !== "ready" || !rendition.web || !rendition.poster) {
    throw new PublicVideoError("This video has no ready viewing copy yet.");
  }
  return rendition;
}

async function r2HasObject(r2, bucket, key, sizeBytes) {
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength === sizeBytes;
  } catch (error) {
    if (isMissingObject(error) || error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function* fixedParts(body, partBytes) {
  let pending = [];
  let length = 0;
  for await (const piece of body) {
    let rest = Buffer.from(piece);
    while (length + rest.length >= partBytes) {
      const take = partBytes - length;
      pending.push(rest.subarray(0, take));
      yield Buffer.concat(pending, partBytes);
      pending = [];
      length = 0;
      rest = rest.subarray(take);
    }
    if (rest.length) {
      pending.push(rest);
      length += rest.length;
    }
  }
  if (length) yield Buffer.concat(pending, length);
}

async function putInParts({ r2, bucket, key, body, sizeBytes, mimeType, partBytes }) {
  const { UploadId } = await r2.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mimeType,
    CacheControl: IMMUTABLE_CACHE,
  }));
  try {
    const parts = [];
    let copied = 0;
    for await (const part of fixedParts(body, partBytes)) {
      const PartNumber = parts.length + 1;
      const { ETag } = await r2.send(new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber,
        Body: part,
        ContentLength: part.length,
      }));
      parts.push({ ETag, PartNumber });
      copied += part.length;
    }
    if (copied !== sizeBytes) throw new PublicVideoError("The viewing copy changed. Try again.");
    await r2.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    body?.destroy?.();
    await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })).catch(() => {});
    throw error;
  }
}

async function copyVersion({ s3, r2, r2Bucket, renditionBucket, expectedBucketOwner, output, key, multipart }) {
  if (await r2HasObject(r2, r2Bucket, key, output.sizeBytes)) return false;
  const object = await s3.send(new GetObjectCommand({
    Bucket: renditionBucket,
    Key: output.objectKey,
    VersionId: output.objectVersionId,
    ExpectedBucketOwner: expectedBucketOwner,
  }));
  if (object.VersionId !== output.objectVersionId || object.ContentLength !== output.sizeBytes) {
    object.Body?.destroy?.();
    throw new PublicVideoError("The viewing copy changed. Try again.");
  }
  if (output.sizeBytes > multipart.thresholdBytes) {
    await putInParts({
      r2,
      bucket: r2Bucket,
      key,
      body: object.Body,
      sizeBytes: output.sizeBytes,
      mimeType: output.mimeType,
      partBytes: multipart.partBytes,
    });
    return true;
  }
  await r2.send(new PutObjectCommand({
    Bucket: r2Bucket,
    Key: key,
    Body: object.Body,
    ContentLength: output.sizeBytes,
    ContentType: output.mimeType,
    CacheControl: IMMUTABLE_CACHE,
  }));
  return true;
}

/**
 * Copies one ready viewing copy to R2 and records it. Returns the public data the
 * snapshot will carry. `s3` is the client for the video source's read role.
 */
async function publishSourceVideo({
  firestore,
  asset,
  s3,
  r2,
  r2Bucket,
  renditionBucket,
  expectedBucketOwner,
  publicOrigin,
  actorUid,
  pendingWithdrawalUrls = [],
  publicGeneration = 0,
  now = () => new Date().toISOString(),
  multipart = MULTIPART,
  beforeCopy = async () => {},
  writeRecord = record => firestore.collection(PUBLIC_VIDEO_COLLECTION).doc(asset.id).set(record),
}) {
  if (asset.sourceId !== VIDEO_BLOCK_SOURCE_ID) {
    throw new PublicVideoError("Only video-library items can be published.", 400);
  }
  const rendition = readyRendition(asset);
  const keys = publicVideoKeys(asset.id, rendition.web, rendition.poster, publicGeneration);
  const media = {
    url: publicUrl(publicOrigin, keys.video),
    posterUrl: publicUrl(publicOrigin, keys.poster),
    width: rendition.web.width ?? DEFAULT_WIDTH,
    height: rendition.web.height ?? DEFAULT_HEIGHT,
    mimeType: "video/mp4",
  };
  if (!isPublicVideoData(media)) {
    throw new PublicVideoError("The public media origin is not configured for video.", 503);
  }
  await beforeCopy(media);
  const shared = { s3, r2, r2Bucket, renditionBucket, expectedBucketOwner, multipart };
  const copied = await copyVersion({ ...shared, output: rendition.web, key: keys.video });
  const posterCopied = await copyVersion({ ...shared, output: rendition.poster, key: keys.poster });
  await writeRecord({
    schemaVersion: PUBLIC_VIDEO_SCHEMA_VERSION,
    sourceId: asset.sourceId,
    assetId: asset.id,
    webObjectKey: rendition.web.objectKey,
    webVersionId: rendition.web.objectVersionId,
    webSizeBytes: rendition.web.sizeBytes,
    posterObjectKey: rendition.poster.objectKey,
    posterVersionId: rendition.poster.objectVersionId,
    posterSizeBytes: rendition.poster.sizeBytes,
    media,
    publishedAt: now(),
    publishedBy: actorUid,
    ...(publicGeneration > 0 ? { publicGeneration } : {}),
    // Keep deferred withdrawal ownership even on an idempotent scheduled copy.
    // The reference transaction decides when those exact URLs can be removed.
    ...(pendingWithdrawalUrls.length ? { pendingWithdrawalUrls } : {}),
  });
  return { media, copied: copied || posterCopied };
}

function storedPublicVideo(snapshot) {
  if (!snapshot?.exists) return null;
  const record = snapshot.data();
  return record?.revoked !== true &&
    record?.schemaVersion === PUBLIC_VIDEO_SCHEMA_VERSION && isPublicVideoData(record.media)
    ? record.media
    : null;
}

function samePublicVideoSource(current, asset) {
  return current?.lifecycle === "active" && current.sourceId === asset.sourceId &&
    ["objectKey", "objectVersionId", "sizeBytes"].every(field => current[field] === asset[field]) &&
    current.rendition?.state === "ready" && ["web", "poster"].every(kind =>
      ["objectKey", "objectVersionId", "sizeBytes"].every(field =>
        current.rendition?.[kind]?.[field] === asset.rendition?.[kind]?.[field]));
}

/** Serialize network copying with withdrawal before either touches R2. */
async function acquirePublicVideoCopy({ firestore, assetId, asset, freshGeneration = false, now = Date.now() }) {
  if (asset) readyRendition(asset);
  const ref = firestore.collection(PUBLIC_VIDEO_COLLECTION).doc(assetId);
  const operation = { id: randomUUID(), kind: "copy", expiresAt: now + PUBLIC_VIDEO_OPERATION_MS };
  const previous = await firestore.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const record = snapshot.data();
    if (asset && !samePublicVideoSource((await tx.get(firestore.collection("mediaSourceAssets").doc(assetId))).data(), asset)) {
      throw new PublicVideoError("The video changed before its public copy was prepared. Publish again shortly.");
    }
    if (record?.operation?.expiresAt > now) {
      throw new PublicVideoError("This video's public copy is changing. Publish again shortly.");
    }
    const generation = record?.publicGeneration ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) {
      throw new PublicVideoError("This video's public copy generation is invalid.", 503);
    }
    if (record && (record.revoked === true || freshGeneration && record.media)) {
      // Reserve the next generation before copying, and retain it on release.
      // A failed attempt may already own withdrawal intent for its URLs. Its
      // retry (including rollback to an older binary) must never reuse them.
      // Existing media URLs stay intact while this high-water mark advances.
      record.publicGeneration = generation + 1;
    }
    if (record?.operation?.kind === "withdraw") {
      record.pendingWithdrawalUrls = [...new Set([
        ...(record.pendingWithdrawalUrls ?? []), ...record.operation.urls,
      ])];
    }
    if (record) delete record.operation;
    tx.set(ref, { ...record, operation });
    return record;
  });
  // A successful copy replaces the record and clears the operation. On failure,
  // restore it only while this attempt still owns it.
  const release = async () => firestore.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.data()?.operation?.id !== operation.id) return;
    if (previous) tx.set(ref, previous);
    else tx.delete(ref);
  });
  return {
    release,
    operationId: operation.id,
    previous,
    pendingWithdrawalUrls: previous?.pendingWithdrawalUrls ?? [],
    publicGeneration: previous?.publicGeneration ?? 0,
  };
}

/**
 * Stamps `public` on every visible video block of a document about to be frozen into
 * a published snapshot. Reads only Firestore, inside the caller's transaction. A
 * hidden video block has its `public` removed so the snapshot never carries a stale
 * copy. Throws PublicVideoError (409) when a visible video has no public copy.
 */
// Layout projection clones row members. Carry an internal source position through
// that projection so duplicate synthetic/body ids never change source visibility.
function visibleVideoSourceBlocks(blocks) {
  const indexed = blocks.map((block, sourceIndex) => ({ ...block, sourceIndex }));
  return new Set(visibleLayoutBlocks(indexed).map(block => blocks[block.sourceIndex]));
}

function withLiveBlogVideoCopies(document, records) {
  if (document.type !== "post" || !document.liveBlog) return {};
  return { liveBlog: { ...document.liveBlog, updates: document.liveBlog.updates.map(entry => {
    if (entry.media?.kind !== "library-video") return entry;
    const media = withoutPublicLeadVideo(entry.media);
    const copy = entry.withdrawal === undefined ? records.get(media.data.assetId) : undefined;
    return { ...entry, media: { ...media, data: { ...media.data, ...(copy ? { public: copy } : {}) } } };
  }) } };
}

async function withPublicVideos({ tx, firestore, document, collection, documentId }) {
  const leadBlocks = leadVideoBlocks(document?.leadMedia);
  const entryBlocks = liveBlogVideoBlocks(document?.type === "post" ? document.liveBlog : undefined);
  const syntheticBlocks = [...leadBlocks, ...entryBlocks];
  const blocks = Array.isArray(document?.blocks) ? [...document.blocks, ...syntheticBlocks] : null;
  if (!blocks || !blocks.some((block) => block?.type === "video")) return document;
  const visibleBlocks = visibleVideoSourceBlocks(blocks);
  const assetIds = [...new Set(blocks
    .filter((block) => block?.type === "video" && visibleBlocks.has(block))
    .map((block) => block.data?.assetId))];
  if (assetIds.length > 0 && collection === "cmsPages" && RUNTIME_PAGE_IDS.has(documentId)) {
    throw new PublicVideoError(
      "The Contact page cannot show a video because it loads analytics. Remove or hide the video block, then publish.",
      400,
    );
  }
  const records = new Map();
  for (const assetId of assetIds) {
    if (typeof assetId !== "string" || !assetId) {
      throw new PublicVideoError("Choose a video for each video block before publishing.");
    }
    const ref = firestore.collection(PUBLIC_VIDEO_COLLECTION).doc(assetId);
    const media = storedPublicVideo(await tx.get(ref));
    if (!media) {
      throw new PublicVideoError("A video in this content is not ready for the public site yet. Publish again.");
    }
    records.set(assetId, media);
  }
  return {
    ...document,
    ...(leadBlocks.length ? { leadMedia: { ...withoutPublicLeadVideo(document.leadMedia), data: {
      ...withoutPublicLeadVideo(document.leadMedia).data,
      ...(records.get(document.leadMedia.data.assetId) ? { public: records.get(document.leadMedia.data.assetId) } : {}),
    } } } : {}),
    ...withLiveBlogVideoCopies(document, records),
    blocks: blocks.filter(block => !syntheticBlocks.includes(block)).map((block) => {
      if (block?.type !== "video") return block;
      const data = { ...block.data };
      delete data.public;
      return visibleBlocks.has(block)
        ? { ...block, data: { ...data, public: records.get(data.assetId) } }
        : { ...block, data };
    }),
  };
}

function previewVideoAssetIds(blocks, visibleBlocks) {
  return [...new Set(blocks
    .filter((block) => block?.type === "video" && visibleBlocks.has(block))
    .map((block) => block.data?.assetId)
    // An incomplete draft may hold any bounded string; only a real asset id names a document.
    .filter((assetId) => typeof assetId === "string" && ID_PATTERN.test(assetId)))];
}

/**
 * The public copy a draft preview may show for each asset: an existing cmsPublicVideos
 * record of the current web rendition of an active, ready video-library item. The same
 * asset checks as cmsPublishSourceVideo, so a deleted or replaced item shows nothing.
 */
async function currentPreviewVideos({ tx, firestore, assetIds }) {
  const records = new Map();
  if (assetIds.length === 0) return records;
  const snapshots = await tx.getAll(...assetIds.flatMap((assetId) => [
    firestore.collection(PUBLIC_VIDEO_COLLECTION).doc(assetId),
    firestore.collection("mediaSourceAssets").doc(assetId),
  ]));
  assetIds.forEach((assetId, index) => {
    const record = snapshots[index * 2];
    const assetSnapshot = snapshots[index * 2 + 1];
    const media = storedPublicVideo(record);
    const asset = assetSnapshot?.exists ? parseSourceMediaAsset(assetId, assetSnapshot.data()) : null;
    const web = asset?.sourceId === VIDEO_BLOCK_SOURCE_ID && asset.rendition?.state === "ready"
      ? asset.rendition.web : null;
    if (media && typeof web?.objectVersionId === "string" &&
        record.data().webVersionId === web.objectVersionId) {
      records.set(assetId, media);
    }
  });
  return records;
}

/**
 * Stamps `public` on visible video blocks of a draft about to be frozen into a
 * preview, using only an existing public copy that matches the library item's current
 * viewing copy. A preview never creates a public copy and never carries a signed URL:
 * a block with no current copy has no `public`, and the draft renderer shows a
 * placeholder. Never throws for a missing copy and never writes.
 */
async function withPreviewVideos({ tx, firestore, document }) {
  const leadBlocks = leadVideoBlocks(document?.leadMedia);
  const entryBlocks = liveBlogVideoBlocks(document?.type === "post" ? document.liveBlog : undefined);
  const syntheticBlocks = [...leadBlocks, ...entryBlocks];
  const blocks = Array.isArray(document?.blocks) ? [...document.blocks, ...syntheticBlocks] : null;
  if (!blocks || !blocks.some((block) => block?.type === "video")) return document;
  const visibleBlocks = visibleVideoSourceBlocks(blocks);
  const records = await currentPreviewVideos({
    tx, firestore, assetIds: previewVideoAssetIds(blocks, visibleBlocks),
  });
  return {
    ...document,
    ...(leadBlocks.length ? { leadMedia: { ...withoutPublicLeadVideo(document.leadMedia), data: {
      ...withoutPublicLeadVideo(document.leadMedia).data,
      ...(records.get(document.leadMedia.data.assetId) ? { public: records.get(document.leadMedia.data.assetId) } : {}),
    } } } : {}),
    ...withLiveBlogVideoCopies(document, records),
    blocks: blocks.filter(block => !syntheticBlocks.includes(block)).map((block) => {
      if (block?.type !== "video") return block;
      const data = { ...block.data };
      delete data.public;
      const media = visibleBlocks.has(block) ? records.get(data.assetId) : undefined;
      return { ...block, data: media ? { ...data, public: media } : data };
    }),
  };
}

/**
 * What a stamped preview shows for each visible video: asset id to public URL, or null
 * for a placeholder. Null when the preview shows no video. The URL names the version.
 */
function previewVideoState(document) {
  const blocks = [...(Array.isArray(document?.blocks) ? document.blocks : []), ...leadVideoBlocks(document?.leadMedia),
    ...liveBlogVideoBlocks(document?.type === "post" ? document.liveBlog : undefined)];
  const visibleBlocks = visibleVideoSourceBlocks(blocks);
  const assetIds = previewVideoAssetIds(blocks, visibleBlocks);
  if (assetIds.length === 0) return null;
  const urls = new Map(blocks
    .filter((block) => block?.type === "video" && visibleBlocks.has(block) && block.data?.public)
    .map((block) => [block.data.assetId, block.data.public.url]));
  return Object.fromEntries(assetIds.map((assetId) => [assetId, urls.get(assetId) ?? null]));
}

/** True while every video a built preview shows is still what a new build would show. */
async function previewVideosCurrent({ tx, firestore, state }) {
  if (!state || typeof state !== "object") return true;
  const assetIds = Object.keys(state);
  const records = await currentPreviewVideos({ tx, firestore, assetIds });
  return assetIds.every((assetId) => (records.get(assetId)?.url ?? null) === state[assetId]);
}

module.exports = {
  PUBLIC_VIDEO_COLLECTION,
  PUBLIC_VIDEO_OPERATION_MS,
  PublicVideoError,
  acquirePublicVideoCopy,
  publicVideoKeys,
  previewVideoState,
  previewVideosCurrent,
  publishSourceVideo,
  samePublicVideoSource,
  withPreviewVideos,
  withPublicVideos,
};

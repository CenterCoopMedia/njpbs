import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { previewOutputTarget } from "./preview-output-target.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { isConditionalConflict, normalizeMetadata, r2ClientConfig } = require("./lib/r2-media.js");
const CACHE_CONTROL = "private, no-store, max-age=0";
// The bucket has no public origin. The serving Worker supplies the validated
// extension's content type; storage itself never interprets executable content.
const CONTENT_TYPE = "application/octet-stream";
const UPLOAD_CONCURRENCY = 8;

function previewObjects(artifact, target) {
  const match = new RegExp(`^${target.origin.replaceAll(".", "\\.")}\\/(p|s)\\/([A-Za-z0-9]{20})\\/$`).exec(artifact.previewUrl);
  if (!match || !artifact.pageUrl.startsWith(artifact.previewUrl) || !(artifact.files instanceof Map)) {
    throw new Error("Invalid private preview upload identity");
  }
  const queueId = match[2];
  const prefix = match[1] === "s" ? "saved" : "v1";
  const pageFile = `${artifact.pageUrl.slice(artifact.previewUrl.length)}index.html`;
  const assets = [];
  let html;
  let expiry;
  for (const [file, object] of artifact.files) {
    const metadata = object.customMetadata;
    if (typeof file !== "string" || file.split("/").some(segment =>
      !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..") ||
      object.key !== `${prefix}/${queueId}/${file}` || !Buffer.isBuffer(object.body) ||
      object.sha256 !== createHash("sha256").update(object.body).digest("hex") ||
      metadata?.schema !== "njpbs-preview-v1" || metadata.queueid !== queueId ||
      (prefix === "saved" && !/^[a-f0-9]{64}$/.test(metadata.contentkey)) ||
      (metadata.contentkey !== undefined && !/^[a-f0-9]{64}$/.test(metadata.contentkey)) ||
      !/^\d{13}$/.test(metadata.expiresatms) || Number(metadata.expiresatms) <= Date.now()) {
      throw new Error("Invalid private preview upload object");
    }
    expiry ??= metadata.expiresatms;
    if (metadata.expiresatms !== expiry) throw new Error("Preview object expiries differ");
    if (/\.html$/i.test(file)) {
      if (html || file !== pageFile) throw new Error("Preview upload includes another page");
      html = object;
    } else assets.push(object);
  }
  if (!html) throw new Error("Preview upload is missing its page");
  return { assets, html };
}

async function putImmutableObject(client, object, abortSignal, bucket) {
  if (Number(object.customMetadata.expiresatms) <= Date.now()) throw new Error("Preview upload expired");
  const Metadata = { schema: object.customMetadata.schema, queueid: object.customMetadata.queueid,
    expiresatms: object.customMetadata.expiresatms, sha256: object.sha256,
    ...(object.customMetadata.contentkey ? { contentkey: object.customMetadata.contentkey } : {}) };
  const identity = { Bucket: bucket, Key: object.key };
  try {
    await client.send(new PutObjectCommand({ ...identity, Body: object.body,
      ContentLength: object.body.length, ContentType: CONTENT_TYPE,
      CacheControl: CACHE_CONTROL, Metadata, IfNoneMatch: "*" }), { abortSignal });
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
    const stored = await client.send(new HeadObjectCommand(identity), { abortSignal });
    const metadata = normalizeMetadata(stored.Metadata);
    if (stored.ContentLength !== object.body.length || stored.ContentType !== CONTENT_TYPE ||
      stored.CacheControl !== CACHE_CONTROL ||
      Object.entries(Metadata).some(([name, value]) => metadata[name] !== value)) {
      throw new Error("Existing preview object does not match the frozen artifact");
    }
  }
}

/** Immutable assets first, HTML last. Await every in-flight request before
 * reporting failure, so the processor cannot finalize while uploads still run.
 * Credentials stay in this operator, never in the renderer environment.
 */
/** @param {any} artifact
 * @param {{ accessKeyId?: string, secretAccessKey?: string, client?: any, target?: import("./preview-output-target.mjs").PreviewOutputTarget }} [options] */
export async function uploadPrivatePreview(artifact, options = {}) {
  const { accessKeyId, secretAccessKey, client, target = previewOutputTarget() } = options;
  const selected = previewOutputTarget(target.environment, target.projectId);
  if (target.bucket !== selected.bucket || target.origin !== selected.origin) throw new Error("Private preview output target differs");
  const { assets, html } = previewObjects(artifact, selected);
  if (!client && (!accessKeyId || !secretAccessKey)) throw new Error("Private preview storage credentials are required");
  const storage = client ?? new S3Client({ ...r2ClientConfig({ endpoint: cloudflareR2Endpoint(), accessKeyId, secretAccessKey }), maxAttempts: 3 });
  const abortSignal = AbortSignal.timeout(120_000);
  try {
    let next = 0;
    let failed = false;
    const uploadAssets = async () => {
      while (!failed && next < assets.length) {
        const object = assets[next++];
        try { await putImmutableObject(storage, object, abortSignal, selected.bucket); }
        catch (error) { failed = true; throw error; }
      }
    };
    const results = await Promise.allSettled(Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, assets.length) }, uploadAssets));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    await putImmutableObject(storage, html, abortSignal, selected.bucket);
  } finally {
    if (!client) storage.destroy();
  }
}

// Only the latest completed export is retained without an expiry. A conditional
// pointer update prevents a late job or a retry from replacing a newer export.
/** @param {{ contentKey: string, queueId: string, requestedAtMs: number }} identity
 * @param {{ accessKeyId?: string, secretAccessKey?: string, client?: any, target?: import("./preview-output-target.mjs").PreviewOutputTarget }} [options] */
export async function retainPrivatePreview({ contentKey, queueId, requestedAtMs }, options = {}) {
  const { accessKeyId, secretAccessKey, client, target = previewOutputTarget() } = options;
  const selected = previewOutputTarget(target.environment, target.projectId);
  if (target.bucket !== selected.bucket || target.origin !== selected.origin) throw new Error("Private preview output target differs");
  if (!/^[a-f0-9]{64}$/.test(contentKey) || !/^[A-Za-z0-9]{20}$/.test(queueId) ||
      !Number.isSafeInteger(requestedAtMs) || requestedAtMs < 1) {
    throw new Error("Invalid retained preview identity");
  }
  if (!client && (!accessKeyId || !secretAccessKey)) throw new Error("Private preview storage credentials are required");
  const storage = client ?? new S3Client({ ...r2ClientConfig({ endpoint: cloudflareR2Endpoint(), accessKeyId, secretAccessKey }), maxAttempts: 3 });
  const identity = { Bucket: selected.bucket, Key: `current/${contentKey}` };
  const abortSignal = AbortSignal.timeout(30_000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let current;
      try { current = await storage.send(new HeadObjectCommand(identity), { abortSignal }); }
      catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; }
      if (current) {
        const metadata = normalizeMetadata(current.Metadata);
        if (metadata.schema !== "njpbs-preview-current-v1" || !/^\d+$/.test(metadata.requestedatms) ||
            !/^[A-Za-z0-9]{20}$/.test(metadata.queueid) || !current.ETag) {
          throw new Error("Stored preview pointer is invalid");
        }
        if (Number(metadata.requestedatms) > requestedAtMs) return false;
        if (Number(metadata.requestedatms) === requestedAtMs) {
          if (metadata.queueid !== queueId) throw new Error("Preview pointer order conflicts");
          return true;
        }
      }
      try {
        await storage.send(new PutObjectCommand({ ...identity, Body: queueId,
          ContentType: "text/plain", CacheControl: CACHE_CONTROL,
          Metadata: { schema: "njpbs-preview-current-v1", queueid: queueId,
            requestedatms: String(requestedAtMs) },
          ...(current ? { IfMatch: current.ETag } : { IfNoneMatch: "*" }) }), { abortSignal });
        return true;
      } catch (error) {
        // S3 can report a concurrent conditional PUT as 409 instead of 412.
        if (!isConditionalConflict(error) && error?.$metadata?.httpStatusCode !== 409) throw error;
      }
    }
    throw new Error("Preview pointer changed repeatedly");
  } finally {
    if (!client) storage.destroy();
  }
}

// A replacement has already become ready before this runs. Remove only the
// previous saved export; legacy reviewer links keep their existing lifecycle.
/** @param {string} queueId
 * @param {{ accessKeyId?: string, secretAccessKey?: string, client?: any, target?: import("./preview-output-target.mjs").PreviewOutputTarget }} [options] */
export async function removeRetainedPreview(queueId, options = {}) {
  const { accessKeyId, secretAccessKey, client, target = previewOutputTarget() } = options;
  const selected = previewOutputTarget(target.environment, target.projectId);
  if (target.bucket !== selected.bucket || target.origin !== selected.origin) throw new Error("Private preview output target differs");
  if (!/^[A-Za-z0-9]{20}$/.test(queueId)) throw new Error("Invalid saved preview cleanup identity");
  if (!client && (!accessKeyId || !secretAccessKey)) throw new Error("Private preview storage credentials are required");
  const storage = client ?? new S3Client({ ...r2ClientConfig({ endpoint: cloudflareR2Endpoint(), accessKeyId, secretAccessKey }), maxAttempts: 3 });
  const Prefix = `saved/${queueId}/`;
  const abortSignal = AbortSignal.timeout(60_000);
  try {
    // Re-list the prefix after each deletion so a lost delete response can be
    // retried without a cursor skipping remaining objects.
    for (;;) {
      const result = await storage.send(new ListObjectsV2Command({ Bucket: selected.bucket, Prefix, MaxKeys: 1000 }), { abortSignal });
      const objects = result.Contents ?? [];
      if (objects.length === 0) return;
      if (objects.some(object => typeof object.Key !== "string" || !object.Key.startsWith(Prefix))) {
        throw new Error("Preview cleanup returned an object outside its queue");
      }
      const removed = await storage.send(new DeleteObjectsCommand({ Bucket: selected.bucket,
        Delete: { Objects: objects.map(object => ({ Key: object.Key })), Quiet: true } }), { abortSignal });
      if (removed.Errors?.length) throw new Error("Saved preview cleanup did not complete");
    }
  } finally {
    if (!client) storage.destroy();
  }
}

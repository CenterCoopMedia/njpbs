"use strict";

const {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { parseSourceMediaRendition } = require("./source-media-rendition");

const { assertOriginalReadable, mapOriginalStorageError } = require("./source-original-state");

const READ_URL_TTL_SECONDS = 5 * 60;
const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;
const S3_BUCKET_PATTERN = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

class SourceObjectError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SourceObjectError";
    this.status = status;
  }
}

function safeDownloadName(value) {
  const name = typeof value === "string" ? value : "video";
  const safe = name.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
  return safe.slice(0, 180) || "video";
}

function readFileName(asset, kind) {
  const originalName = safeDownloadName(asset.originalName);
  if (kind === "original") return originalName;
  const stem = originalName.replace(/\.[^.]*$/, "") || "video";
  return kind === "poster" ? `${stem}-poster.jpg` : `${stem}.mp4`;
}

function readDisposition(asset, action, kind = "original") {
  const mode = action === "preview" || action === "poster" ? "inline" : "attachment";
  return `${mode}; filename="${readFileName(asset, kind)}"`;
}

function missingObject(error) {
  return error?.name === "NotFound" || error?.name === "NoSuchKey" ||
    error?.$metadata?.httpStatusCode === 404;
}

function originalTarget(source, asset) {
  return {
    kind: "original",
    bucket: source.bucket,
    expectedBucketOwner: source.expectedBucketOwner,
    objectKey: asset.objectKey,
    objectVersionId: asset.objectVersionId,
    sizeBytes: asset.sizeBytes,
    mimeType: asset.mimeType,
  };
}

function renditionTarget(config, source, asset, kind) {
  const rendition = parseSourceMediaRendition(asset.rendition, asset);
  if (
    rendition?.state !== "ready" ||
    !S3_BUCKET_PATTERN.test(config.renditionBucket ?? "") ||
    !AWS_ACCOUNT_ID_PATTERN.test(config.renditionExpectedBucketOwner ?? "") ||
    config.renditionExpectedBucketOwner !== source.expectedBucketOwner
  ) return null;
  const output = rendition[kind];
  return output ? {
    kind,
    bucket: config.renditionBucket,
    expectedBucketOwner: config.renditionExpectedBucketOwner,
    objectKey: output.objectKey,
    objectVersionId: output.objectVersionId,
    sizeBytes: output.sizeBytes,
    mimeType: output.mimeType,
  } : null;
}

function readTarget(config, source, asset, action) {
  if (action === "download") return originalTarget(source, asset);
  if (action === "download_web") {
    const target = renditionTarget(config, source, asset, "web");
    if (!target) throw new SourceObjectError(409, "The viewing copy is not available");
    return target;
  }
  if (action === "poster") {
    const target = renditionTarget(config, source, asset, "poster");
    if (!target) throw new SourceObjectError(409, "The video poster is not available");
    return target;
  }
  if (action !== "preview") {
    throw new SourceObjectError(400, "Source media read action is invalid");
  }
  const target = renditionTarget(config, source, asset, "web");
  if (target) return target;
  if (asset.preview !== "browser") {
    throw new SourceObjectError(409, "This video is available for download only");
  }
  return originalTarget(source, asset);
}

function objectRequest(target) {
  return {
    Bucket: target.bucket,
    Key: target.objectKey,
    VersionId: target.objectVersionId,
    ExpectedBucketOwner: target.expectedBucketOwner,
  };
}

async function verifyTarget(client, target, options) {
  let head;
  try {
    head = await client.send(new HeadObjectCommand(objectRequest(target)), options);
  } catch (error) {
    if (missingObject(error)) {
      if (target.kind === "original") {
        throw new SourceObjectError(404, "Media asset not found");
      }
      throw new SourceObjectError(409, "The requested rendition is not available");
    }
    throw mapOriginalStorageError(error);
  }
  if (
    head.VersionId !== target.objectVersionId ||
    head.ContentLength !== target.sizeBytes
  ) {
    const message = target.kind === "original"
      ? "The indexed media version is no longer available"
      : "The requested rendition is not available";
    throw new SourceObjectError(409, message);
  }
  return head;
}

function createS3MediaSourceReader(config, deps = {}) {
  const S3ClientCtor = deps.S3ClientCtor ?? S3Client;
  const credentialProviderFn = deps.createAwsRoleCredentialProviderFn ??
    ((value) => deps.createAwsRoleCredentialsFn
      ? () => deps.createAwsRoleCredentialsFn(value)
      : createAwsRoleCredentialProvider(value));
  const signUrlFn = deps.getSignedUrlFn ?? getSignedUrl;
  const nowFn = deps.nowFn ?? (() => Date.now());

  const clients = new Map();
  function clientFor(source) {
    if (clients.has(source.roleArn)) return clients.get(source.roleArn);
    const credentials = credentialProviderFn({
      roleArn: source.roleArn,
      audience: config.audience,
      region: config.region,
    });
    const client = new S3ClientCtor({ region: config.region, credentials });
    clients.set(source.roleArn, client);
    return client;
  }

  return async function createRead(source, asset, action) {
    const client = clientFor(source);
    const original = originalTarget(source, asset);
    let target = readTarget(config, source, asset, action);
    const privateRead = await deps.privateReadFn?.(source, asset, action, readDisposition(asset, action, target.kind));
    if (privateRead) return privateRead;
    const originalHead = await verifyTarget(client, original);
    if (target.kind !== "original") {
      try {
        await verifyTarget(client, target);
      } catch (error) {
        if (
          action !== "preview" ||
          !(error instanceof SourceObjectError) ||
          asset.preview !== "browser"
        ) throw error;
        target = original;
      }
    }
    if (target.kind === "original") assertOriginalReadable(originalHead);
    const disposition = action === "preview" || action === "poster"
      ? "inline"
      : "attachment";
    const command = new GetObjectCommand({
      ...objectRequest(target),
      ResponseContentType: target.mimeType,
      ResponseContentDisposition: readDisposition(asset, action, target.kind),
    });
    const url = await signUrlFn(client, command, { expiresIn: READ_URL_TTL_SECONDS });
    return {
      assetId: asset.id,
      action,
      url,
      expiresAt: new Date(nowFn() + READ_URL_TTL_SECONDS * 1000).toISOString(),
      mimeType: target.mimeType,
      disposition,
      supportsRange: true,
    };
  };
}

module.exports = {
  READ_URL_TTL_SECONDS,
  SourceObjectError,
  createS3MediaSourceReader,
  readDisposition,
  safeDownloadName,
  originalTarget,
  objectRequest,
  verifyTarget,
};

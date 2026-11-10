"use strict";

const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

function isConditionalConflict(error) {
  return (
    error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed"
  );
}

function isMissingObject(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.Code === "NoSuchKey" ||
    ((error?.name === "NotFound" || error?.Code === "NotFound") &&
      error?.$metadata?.httpStatusCode === 404)
  );
}

function normalizeMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      key.toLocaleLowerCase("en-US"),
      String(value),
    ]),
  );
}

function r2ClientConfig({ endpoint, accessKeyId, secretAccessKey }) {
  return {
    region: "auto",
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId, secretAccessKey },
  };
}

class R2MediaStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, client } = {}) {
    if (!bucket) throw new Error("CMS_MEDIA_R2_BUCKET is not configured");
    this.bucket = bucket;
    this.client =
      client ??
      new S3Client(
        r2ClientConfig({
          endpoint,
          accessKeyId,
          secretAccessKey,
        }),
      );
  }

  async putStaging({ key, body, mimeType, metadata }) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: mimeType,
        CacheControl: "no-store",
        Metadata: metadata,
      }),
    );
  }

  async putFinal({ key, body, mimeType, metadata }) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: mimeType,
          CacheControl: "public, max-age=31536000, immutable",
          Metadata: metadata,
          IfNoneMatch: "*",
        }),
      );
      return { created: true };
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      return { created: false };
    }
  }

  async head(key) {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    return {
      contentLength: result.ContentLength ?? null,
      contentType: result.ContentType ?? null,
      metadata: normalizeMetadata(result.Metadata),
    };
  }

  async headIfExists(key) {
    try {
      return await this.head(key);
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async get(key) {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async deleteStaging(key) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async deleteFinal(key, thumbnailKeys = []) {
    for (const objectKey of [...thumbnailKeys, key]) {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );
    }
  }
}

module.exports = {
  R2MediaStorage,
  isConditionalConflict,
  isMissingObject,
  normalizeMetadata,
  r2ClientConfig,
};

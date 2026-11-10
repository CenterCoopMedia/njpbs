"use strict";

const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const {
  isConditionalConflict,
  isMissingObject,
  normalizeMetadata,
  r2ClientConfig,
} = require("./r2-media");

class R2VoiceoverStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, client } = {}) {
    if (!endpoint) throw new Error("CMS_VOICEOVER_R2_ENDPOINT is not configured");
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("CMS voiceover R2 credentials are not configured");
    }
    if (!bucket) throw new Error("CMS_VOICEOVER_R2_BUCKET is not configured");
    this.bucket = bucket;
    this.client = client ?? new S3Client(r2ClientConfig({
      endpoint,
      accessKeyId,
      secretAccessKey,
    }));
  }

  async getIfExists(key) {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        body: result.Body,
        contentLength: result.ContentLength ?? null,
        contentType: result.ContentType ?? null,
        metadata: normalizeMetadata(result.Metadata),
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async headIfExists(key) {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return {
        contentLength: result.ContentLength ?? null,
        contentType: result.ContentType ?? null,
        metadata: normalizeMetadata(result.Metadata),
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async putIfAbsent({ key, body, contentHash }) {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: "audio/wav",
        CacheControl: "private, no-store",
        Metadata: { sha256: contentHash },
        IfNoneMatch: "*",
      }));
      return { created: true };
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      return { created: false };
    }
  }
}

module.exports = { R2VoiceoverStorage };

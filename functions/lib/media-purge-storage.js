"use strict";

const { S3Client, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { isMissingObject, r2ClientConfig } = require("./r2-media");

// Only the sweep's dedicated, bucket-scoped reader/deleter is supplied here.
class MediaPurgeStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, publicBucket, masterBucket, client,
    clock = Date.now }) {
    if (!publicBucket || !masterBucket || publicBucket === masterBucket) throw new Error("Purge buckets are invalid");
    this.buckets = { public: publicBucket, masters: masterBucket };
    this.clock = clock;
    this.client = client ?? new S3Client({ ...r2ClientConfig({ endpoint, accessKeyId, secretAccessKey }), maxAttempts: 1 });
  }

  async send(Command, store, key, deadlineMs) {
    const remaining = Math.min(10_000, deadlineMs - this.clock());
    if (!this.buckets[store] || !Number.isFinite(remaining) || remaining <= 0) throw new Error("Purge I/O deadline elapsed");
    return this.client.send(new Command({ Bucket: this.buckets[store], Key: key }), {
      abortSignal: AbortSignal.timeout(Math.floor(remaining)),
    });
  }

  async remove(object, deadlineMs) {
    await this.send(DeleteObjectCommand, object.store, object.key, deadlineMs);
    try {
      await this.send(HeadObjectCommand, object.store, object.key, deadlineMs);
    } catch (error) {
      if (isMissingObject(error)) return;
      throw error;
    }
    throw new Error("Purge object is still present");
  }

  async listMasters(cursor) {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.buckets.masters, Prefix: "masters/", MaxKeys: 100,
      ...(cursor ? { ContinuationToken: cursor } : {}),
    }), { abortSignal: AbortSignal.timeout(10_000) });
    if (result.IsTruncated && !result.NextContinuationToken) throw new Error("Master listing cursor is missing");
    return { objects: (result.Contents || []).map((item) => ({ key: item.Key,
      lastModified: item.LastModified?.toISOString(), sizeBytes: item.Size })),
    cursor: result.IsTruncated ? result.NextContinuationToken : null };
  }
}

module.exports = { MediaPurgeStorage };

"use strict";

const { DeleteObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { isConditionalConflict, r2ClientConfig } = require("./r2-media");
const { MASTER_EXTENSIONS, masterObjectKey } = require("./media-master-contract");

// Uploaded originals kept beside a published web copy. They live in their own
// private bucket, which no public domain serves. Downloads require an authorized,
// short signed read. Keys are content-addressed: the same original is stored once.

class R2MediaMasterStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, client, clockMs = () => Date.now() } = {}) {
    if (!bucket) throw new Error("CMS_MEDIA_MASTER_R2_BUCKET is not configured");
    this.bucket = bucket;
    this.clockMs = clockMs;
    this.client = client ?? new S3Client(r2ClientConfig({
      endpoint,
      accessKeyId,
      secretAccessKey,
    }));
  }

  async delete(key, { deadlineMs = this.clockMs() + 30_000 } = {}) {
    // Recheck the absolute lease deadline at the storage boundary as well. A
    // stale executor must not start a fresh request after another worker finished.
    const remainingMs = Math.floor(Math.min(30_000, deadlineMs - this.clockMs()));
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      const error = new Error("Master cleanup deletion deadline elapsed");
      error.code = "delete_deadline_elapsed";
      throw error;
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      // Bound retries and sockets together, well inside the cleanup execution lease.
      abortSignal: AbortSignal.timeout(remainingMs),
    });
  }

  /** Stores the master once. An existing object at the same key is the same bytes. */
  async putIfAbsent({ key, body, mimeType, contentHash }) {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: mimeType,
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

module.exports = { MASTER_EXTENSIONS, R2MediaMasterStorage, masterObjectKey };

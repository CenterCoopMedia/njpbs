"use strict";

const { HeadObjectCommand, GetObjectCommand, PutObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");

const PART_BYTES = 8 * 1024 ** 2;
const missing = error => ["NoSuchKey", "NotFound"].includes(error.name) && error.$metadata?.httpStatusCode === 404;

// R2 does not document conditional multipart completion. One host/state lock
// owns the archive prefix; HEAD alone is not a distributed lock.
function createR2BackupDestination({ client, bucket, singleWriter, assertPrivate }) {
  if (!client || !bucket || singleWriter !== true || typeof assertPrivate !== "function") {
    throw Error("Private R2 single-writer binding required");
  }
  const input = key => {
    if (!/^viewing-copies-v1\/[a-f0-9]{64}\.(mp4|json)$/.test(key)) throw Error("Invalid archive key");
    return { Bucket: bucket, Key: key };
  };
  return {
    async read(key) {
      await assertPrivate(bucket);
      try { return (await client.send(new GetObjectCommand(input(key)))).Body; }
      catch (error) { if (missing(error)) return null; throw error; }
    },
    async putIfAbsent(key, body, { sizeBytes, contentType }) {
      await assertPrivate(bucket);
      const target = input(key);
      try { await client.send(new HeadObjectCommand(target)); return false; }
      catch (error) { if (!missing(error)) throw error; }
      if (Buffer.isBuffer(body)) {
        await client.send(new PutObjectCommand({ ...target, Body: body,
          ContentLength: sizeBytes, ContentType: contentType, IfNoneMatch: "*" }));
        return true;
      }
      // Parts are bounded in memory; the MP4 is already size/digest checked on
      // local disk. Use multipart for all streamed files, including >5 GiB.
      const { UploadId } = await client.send(new CreateMultipartUploadCommand({ ...target,
        ContentType: contentType }));
      if (!UploadId) throw Error("Missing multipart identity");
      const upload = { ...target, UploadId };
      const parts = [];
      let part = Buffer.allocUnsafe(PART_BYTES), used = 0, total = 0;
      async function sendPart() {
        const PartNumber = parts.length + 1;
        const { ETag } = await client.send(new UploadPartCommand({ ...upload, PartNumber,
          Body: part.subarray(0, used), ContentLength: used }));
        if (!ETag) throw Error("Missing part receipt");
        parts.push({ PartNumber, ETag });
        used = 0;
        part = Buffer.allocUnsafe(PART_BYTES);
      }
      try {
        for await (const chunk of body) {
          total += chunk.length;
          if (total > sizeBytes) throw Error("Object exceeds expected size");
          for (let offset = 0; offset < chunk.length;) {
            const length = Math.min(PART_BYTES - used, chunk.length - offset);
            chunk.copy(part, used, offset, offset + length);
            used += length;
            offset += length;
            if (used === PART_BYTES) await sendPart();
          }
        }
        if (total !== sizeBytes) throw Error("Incomplete object");
        if (used) await sendPart();
        await client.send(new CompleteMultipartUploadCommand({ ...upload, MultipartUpload: { Parts: parts } }));
        return true;
      } catch (error) {
        // Abort removes only this unfinished multipart upload, never a file.
        // A killed process may leave parts: the later bucket lifecycle must
        // clean those without expiring archived MP4s or sidecars.
        await client.send(new AbortMultipartUploadCommand(upload)).catch(() => {});
        throw error;
      }
    },
  };
}

module.exports = { createR2BackupDestination };

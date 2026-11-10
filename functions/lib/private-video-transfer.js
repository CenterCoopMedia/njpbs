"use strict";

const { createHash } = require("node:crypto");
const { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, UploadPartCommand } = require("@aws-sdk/client-s3");
const { PART_BYTES, sha256 } = require("./private-video-copy");

function sourceRequest(config, output) {
  return { Bucket: config.renditionBucket, ExpectedBucketOwner: config.renditionExpectedBucketOwner,
    Key: output.objectKey, VersionId: output.objectVersionId };
}

async function boundedBody(body, expected) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      length += chunk.length;
      if (length > expected) throw Error("private_copy_size_invalid");
      chunks.push(Buffer.from(chunk));
    }
    if (length !== expected) throw Error("private_copy_size_invalid");
    return Buffer.concat(chunks, length);
  } finally { body.destroy?.(); }
}

function partRange(output, index) {
  const start = index * PART_BYTES;
  const end = Math.min(output.sizeBytes, start + PART_BYTES) - 1;
  return { start, end, length: end - start + 1, Range: `bytes=${start}-${end}` };
}

function createPrivateVideoTransfer({ s3, r2, bucket, config }) {
  async function remove(job) {
    for (const file of Object.values(job.files)) {
      const target = { Bucket: bucket, Key: file.key };
      if (file.uploadId) {
        try { await r2.send(new AbortMultipartUploadCommand({ ...target, UploadId: file.uploadId })); }
        catch (error) { if (error.name !== "NoSuchUpload") throw error; }
      }
      await r2.send(new DeleteObjectCommand(target));
    }
  }

  async function head(job, file, output) {
    const result = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: file.key }));
    if (result.ContentLength !== output.sizeBytes || result.Metadata?.binding !== job.id ||
        result.Metadata?.generation !== job.generation || !result.ETag) throw Error("private_copy_identity_invalid");
    return result;
  }

  async function step(job, save) {
    const kind = Object.keys(job.files).find((name) => job.files[name].phase !== "ready");
    if (!kind) return save({ phase: "ready", active: false, leaseUntil: 0, failures: 0 });
    const file = { ...job.files[kind] };
    const output = job.identity[kind];
    const target = { Bucket: bucket, Key: file.key };
    const persist = () => save({ files: { ...job.files, [kind]: file }, failures: 0 });
    if (file.phase === "pending") {
      const original = await s3.send(new HeadObjectCommand(sourceRequest(config, output)));
      if (original.VersionId !== output.objectVersionId || original.ContentLength !== output.sizeBytes) {
        throw Error("private_copy_source_changed");
      }
      const result = await r2.send(new CreateMultipartUploadCommand({ ...target, ContentType: output.mimeType,
        CacheControl: "private, max-age=3600", Metadata: { binding: job.id, generation: job.generation } }));
      file.uploadId = result.UploadId;
      file.phase = "uploading";
      // A lost create response leaves only an incomplete upload, covered by lifecycle.
      if (!await persist()) await r2.send(new AbortMultipartUploadCommand({ ...target, UploadId: file.uploadId }));
      return;
    }
    if (file.phase === "uploading") {
      const index = file.parts.length;
      if (index < Math.ceil(output.sizeBytes / PART_BYTES)) {
        const range = partRange(output, index);
        const result = await s3.send(new GetObjectCommand({ ...sourceRequest(config, output), Range: range.Range }));
        if (result.VersionId !== output.objectVersionId || result.ContentLength !== range.length ||
            result.ContentRange !== `bytes ${range.start}-${range.end}/${output.sizeBytes}`) {
          result.Body?.destroy?.();
          throw Error("private_copy_source_changed");
        }
        const bytes = await boundedBody(result.Body, range.length);
        const digest = sha256(bytes);
        const uploaded = await r2.send(new UploadPartCommand({ ...target, UploadId: file.uploadId,
          PartNumber: index + 1, Body: bytes, ContentLength: bytes.length }));
        file.parts = [...file.parts, { ETag: uploaded.ETag, PartNumber: index + 1, sha256: digest }];
        return persist();
      }
      // Recover a lost completion response by HEAD, then verify every destination range.
      try { await head(job, file, output); }
      catch (error) {
        if (!["NotFound", "NoSuchKey"].includes(error.name) && error?.$metadata?.httpStatusCode !== 404) throw error;
        await r2.send(new CompleteMultipartUploadCommand({ ...target, UploadId: file.uploadId,
          MultipartUpload: { Parts: file.parts.map(({ ETag, PartNumber }) => ({ ETag, PartNumber })) } }));
      }
      const completed = await head(job, file, output);
      file.etag = completed.ETag;
      file.phase = "verifying";
      return persist();
    }
    if (file.phase !== "verifying") throw Error("private_copy_phase_invalid");
    if (file.verifiedParts < file.parts.length) {
      const range = partRange(output, file.verifiedParts);
      const result = await r2.send(new GetObjectCommand({ ...target, Range: range.Range, IfMatch: file.etag }));
      if (result.ContentLength !== range.length || result.ETag !== file.etag ||
          result.ContentRange !== `bytes ${range.start}-${range.end}/${output.sizeBytes}`) {
        result.Body?.destroy?.();
        throw Error("private_copy_checksum_invalid");
      }
      const bytes = await boundedBody(result.Body, range.length);
      if (sha256(bytes) !== file.parts[file.verifiedParts].sha256) throw Error("private_copy_checksum_invalid");
      file.verifiedParts += 1;
      return persist();
    }
    if (output.sha256) {
      const result = await r2.send(new GetObjectCommand({ ...target, IfMatch: file.etag }));
      const hash = createHash("sha256");
      let size = 0;
      try {
        if (result.ETag !== file.etag || result.ContentLength !== output.sizeBytes) throw Error("private_copy_checksum_invalid");
        for await (const chunk of result.Body) {
          size += chunk.length;
          if (size > output.sizeBytes) throw Error("private_copy_checksum_invalid");
          hash.update(chunk);
        }
        if (size !== output.sizeBytes || hash.digest("hex") !== output.sha256) throw Error("private_copy_checksum_invalid");
      } finally { result.Body?.destroy?.(); }
      file.fullSha256 = output.sha256;
    }
    file.checksum = sha256(file.parts.map((part) => part.sha256).join(""));
    file.checksumAlgorithm = "sha256-parts-v1";
    file.phase = "ready";
    return persist();
  }
  return { step, remove };
}

module.exports = { boundedBody, partRange, createPrivateVideoTransfer };

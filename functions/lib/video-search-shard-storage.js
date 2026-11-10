"use strict";

const { createHash } = require("node:crypto");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const shardKey = digest => `transcripts/results/search-v1/${digest}.json`;

function createVideoSearchShardStorage(config, dependencies = {}) {
  const s3 = dependencies.s3 ?? new S3Client({ region: config.region, maxAttempts: 3,
    credentials: createAwsRoleCredentialProvider({ roleArn: config.controlRoleArn, audience: config.audience, region: config.region }) });
  const location = digest => ({ Bucket: config.bucket, Key: shardKey(digest), ExpectedBucketOwner: config.accountId });
  return {
    async put(content) {
      const Body = JSON.stringify(content);
      if (Buffer.byteLength(Body) > MAX_SHARD_BYTES) throw new Error("search_shard_too_large");
      const digest = hash(Body);
      const result = await s3.send(new PutObjectCommand({ ...location(digest), Body, ContentType: "application/json",
        CacheControl: "private, no-store", ServerSideEncryption: "AES256" }));
      if (!result.VersionId) throw new Error("search_shard_version_missing");
      return { digest, objectVersion: result.VersionId };
    },
    async read(descriptor) {
      if (!/^[a-f0-9]{64}$/.test(descriptor?.digest ?? "") || !descriptor.objectVersion) throw new Error("search_shard_invalid");
      const response = await s3.send(new GetObjectCommand({ ...location(descriptor.digest), VersionId: descriptor.objectVersion }));
      const buffers = [];
      let bytes = 0;
      try {
        if (response.ContentLength > MAX_SHARD_BYTES) throw new Error("search_shard_too_large");
        for await (const chunk of response.Body) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_SHARD_BYTES) throw new Error("search_shard_too_large");
          buffers.push(buffer);
        }
      } finally { response.Body?.destroy?.(); }
      const body = Buffer.concat(buffers);
      if (hash(body) !== descriptor.digest) throw new Error("search_shard_digest_mismatch");
      const content = JSON.parse(body.toString("utf8"));
      if (content.schema !== 1 || !Array.isArray(content.chunks)) throw new Error("search_shard_invalid");
      return content;
    },
  };
}

module.exports = { createVideoSearchShardStorage, hash, MAX_SHARD_BYTES };

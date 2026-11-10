"use strict";

const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

// Caller supplies a dedicated read-only client and the approved rendition
// bucket binding. No client, credential provider or cloud target is created here.
function createVideoBackupSource({ client, bucket, expectedBucketOwner }) {
  if (!bucket || !expectedBucketOwner) throw new Error("Source binding required");
  function input(identity) {
    if (identity.bucket !== bucket || !identity.key.startsWith("outputs/") ||
        !identity.key.endsWith("/preview.mp4") || !identity.versionId) {
      throw new Error("Invalid viewing-copy source");
    }
    return { Bucket: bucket, ExpectedBucketOwner: expectedBucketOwner,
      Key: identity.key, VersionId: identity.versionId };
  }
  return {
    async head(identity) {
      const result = await client.send(new HeadObjectCommand(input(identity)));
      return { sizeBytes: result.ContentLength, versionId: result.VersionId };
    },
    async read(identity) {
      const result = await client.send(new GetObjectCommand(input(identity)));
      return { body: result.Body, sizeBytes: result.ContentLength, versionId: result.VersionId };
    },
  };
}

module.exports = { createVideoBackupSource };

"use strict";

const { createHash } = require("node:crypto");
const {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { SourceObjectError, verifyTarget } = require("./s3-media-source");

const PART_URL_TTL_SECONDS = 15 * 60;

function compositeSha256(parts) {
  const combined = Buffer.concat(parts.map((part) => Buffer.from(part.checksumSha256, "base64")));
  return `${createHash("sha256").update(combined).digest("base64")}-${parts.length}`;
}

function createS3MediaUploader(config, deps = {}) {
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

  function address(source, session) {
    return {
      Bucket: source.bucket,
      Key: session.objectKey,
      ExpectedBucketOwner: source.expectedBucketOwner,
    };
  }

  async function start(source, session) {
    const client = clientFor(source);
    const result = await client.send(new CreateMultipartUploadCommand({
      ...address(source, session),
      ContentType: session.mimeType,
      ChecksumAlgorithm: "SHA256",
      Metadata: {
        "boardwalk-session": session.id,
        "boardwalk-asset": session.assetId,
      },
    }));
    if (typeof result.UploadId !== "string" || !result.UploadId) {
      throw new Error("S3 did not return a multipart upload id");
    }
    return { uploadId: result.UploadId };
  }

  async function signParts(source, session, parts) {
    const client = clientFor(source);
    return Promise.all(parts.map(async (part) => {
      const command = new UploadPartCommand({
        ...address(source, session),
        UploadId: session.s3UploadId,
        PartNumber: part.partNumber,
        ContentLength: part.sizeBytes,
        ChecksumSHA256: part.checksumSha256,
      });
      const url = await signUrlFn(client, command, {
        expiresIn: PART_URL_TTL_SECONDS,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      });
      return {
        partNumber: part.partNumber,
        url,
        expiresAt: new Date(nowFn() + PART_URL_TTL_SECONDS * 1000).toISOString(),
        requiredHeaders: { "x-amz-checksum-sha256": part.checksumSha256 },
      };
    }));
  }

  // A worker-rendered file arrives in one PUT bound to its exact size and
  // SHA-256, so S3 rejects any other bytes.
  async function signPut(source, session, expiresIn) {
    const client = clientFor(source);
    const command = new PutObjectCommand({
      ...address(source, session),
      ContentType: session.mimeType,
      ContentLength: session.sizeBytes,
      ChecksumSHA256: session.checksumSha256,
      Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId },
    });
    const headers = new Set(["x-amz-checksum-sha256", "x-amz-meta-boardwalk-session",
      "x-amz-meta-boardwalk-asset", "content-type"]);
    const url = await signUrlFn(client, command, { expiresIn, unhoistableHeaders: headers, signableHeaders: headers });
    return {
      url,
      expiresAt: new Date(nowFn() + expiresIn * 1000).toISOString(),
      requiredHeaders: {
        "content-type": session.mimeType,
        "x-amz-checksum-sha256": session.checksumSha256,
        "x-amz-meta-boardwalk-session": session.id,
        "x-amz-meta-boardwalk-asset": session.assetId,
      },
    };
  }

  async function listParts(source, session) {
    const client = clientFor(source);
    const parts = [];
    let marker;
    do {
      const result = await client.send(new ListPartsCommand({
        ...address(source, session),
        UploadId: session.s3UploadId,
        PartNumberMarker: marker,
        MaxParts: 1000,
      }));
      for (const part of result.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          checksumSha256: part.ChecksumSHA256,
          sizeBytes: part.Size,
        });
      }
      if (result.IsTruncated) {
        const nextMarker = result.NextPartNumberMarker;
        if (
          typeof nextMarker !== "string" || !/^\d{1,5}$/.test(nextMarker) ||
          Number(nextMarker) < 1 || Number(nextMarker) > 10_000 ||
          (marker !== undefined && Number(nextMarker) <= Number(marker))
        ) {
          throw new Error("S3 multipart pagination did not advance");
        }
        marker = nextMarker;
      } else {
        marker = undefined;
      }
    } while (marker !== undefined);
    return parts;
  }

  async function complete(source, session, parts) {
    const client = clientFor(source);
    return client.send(new CompleteMultipartUploadCommand({
      ...address(source, session),
      UploadId: session.s3UploadId,
      MultipartUpload: {
        Parts: parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
          ChecksumSHA256: part.checksumSha256,
        })),
      },
    }));
  }

  async function head(source, session, versionId) {
    const client = clientFor(source);
    return client.send(new HeadObjectCommand({
      ...address(source, session),
      ...(versionId ? { VersionId: versionId } : {}),
      ChecksumMode: "ENABLED",
    }));
  }

  async function cancel(source, session) {
    const client = clientFor(source);
    await client.send(new AbortMultipartUploadCommand({
      ...address(source, session),
      UploadId: session.s3UploadId,
    }));
  }

  async function copyClip(source, session, output, registration) {
    const client = clientFor(source);
    const target = address(source, session);
    const options = { abortSignal: AbortSignal.timeout(100_000) };
    const from = { ...output, bucket: config.renditionBucket, expectedBucketOwner: source.expectedBucketOwner };
    if (!from.bucket || from.bucket === source.bucket) throw new SourceObjectError(503, "Clip storage is unavailable");
    await verifyTarget(client, from, options);
    async function existingCopy() {
      try {
        return await client.send(new HeadObjectCommand(target), options);
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    }
    const existing = await existingCopy();
    if (existing) return existing;

    const abortCopy = UploadId => client.send(new AbortMultipartUploadCommand({ ...target, UploadId }),
      { abortSignal: AbortSignal.timeout(5000) }).catch(() => {});
    let UploadId = registration.uploadId;
    if (!UploadId) {
      const started = await client.send(new CreateMultipartUploadCommand({ ...target,
        ContentType: session.mimeType,
        Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId },
      }), options);
      if (!started.UploadId) throw new Error("Clip copy did not return an upload id");
      try {
        UploadId = await registration.claimUpload(started.UploadId);
      } finally {
        if (UploadId !== started.UploadId) await abortCopy(started.UploadId);
      }
    }
    const upload = { ...target, UploadId };
    const copySource = `${from.bucket}/${from.objectKey.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(from.objectVersionId)}`;
    const partBytes = 4 * 1024 ** 3;
    const count = Math.ceil(output.sizeBytes / partBytes);
    try {
      // One batch fits the HTTP window. The upload and its finished parts survive a retry.
      const listed = await client.send(new ListPartsCommand({ ...upload, MaxParts: 1000 }), options);
      const parts = new Map((listed.Parts ?? []).map(part => [part.PartNumber, part.ETag]));
      const numbers = Array.from({ length: count }, (_, index) => index + 1);
      const missing = numbers.filter(number => !parts.get(number));
      const batch = await Promise.allSettled(missing.slice(0, 4).map(async PartNumber => {
        const result = await client.send(new UploadPartCopyCommand({ ...upload, PartNumber,
          CopySource: copySource, ExpectedSourceBucketOwner: from.expectedBucketOwner,
          ...(count > 1 ? { CopySourceRange: `bytes=${(PartNumber - 1) * partBytes}-${Math.min(PartNumber * partBytes, output.sizeBytes) - 1}` } : {}),
        }), options);
        if (!result.CopyPartResult?.ETag || result.CopySourceVersionId !== from.objectVersionId) {
          throw new SourceObjectError(409, "The clip output is no longer available");
        }
        parts.set(PartNumber, result.CopyPartResult.ETag);
      }));
      for (const part of batch) if (part.status === "rejected") throw part.reason;
      if (missing.length > 4) return null;
      await client.send(new CompleteMultipartUploadCommand({ ...upload, IfNoneMatch: "*",
        MultipartUpload: { Parts: numbers.map(PartNumber => ({ PartNumber, ETag: parts.get(PartNumber) })) } }), options);
    } catch (error) {
      if (error?.name !== "NoSuchUpload" && ![409, 412].includes(error?.$metadata?.httpStatusCode)) throw error;
      const winner = await existingCopy();
      await abortCopy(UploadId);
      if (winner) return winner;
      await registration.clearUpload(UploadId);
      return null;
    }
    const stored = await existingCopy();
    if (!stored) throw new SourceObjectError(409, "The saved video copy is unavailable. Try saving the clip again.");
    return stored;
  }

  // Server-side imports stream from quarantine in bounded parts. They do not
  // create a browser upload session or admit a viewing-copy job.
  async function importStream(source, session, body) {
    const client = clientFor(source);
    const { uploadId } = await start(source, session);
    const parts = [];
    const partBytes = 8 * 1024 * 1024;
    let chunks = [];
    let buffered = 0;
    let total = 0;
    const contentHash = createHash("sha256");
    async function sendPart(bytes) {
      const partNumber = parts.length + 1;
      const checksumSha256 = createHash("sha256").update(bytes).digest("base64");
      const result = await client.send(new UploadPartCommand({
        ...address(source, session), UploadId: uploadId,
        PartNumber: partNumber, Body: bytes, ContentLength: bytes.length,
        ChecksumSHA256: checksumSha256,
      }));
      parts.push({ PartNumber: partNumber, ETag: result.ETag,
        ChecksumSHA256: checksumSha256 });
    }
    try {
      for await (const chunk of body) {
        chunks.push(chunk);
        buffered += chunk.length;
        total += chunk.length;
        contentHash.update(chunk);
        if (total > session.sizeBytes) throw new Error("Import exceeds the inspected size");
        while (buffered >= partBytes) {
          const joined = Buffer.concat(chunks);
          await sendPart(joined.subarray(0, partBytes));
          chunks = joined.length > partBytes ? [joined.subarray(partBytes)] : [];
          buffered = joined.length - partBytes;
        }
      }
      if (total !== session.sizeBytes) throw new Error("Import size changed");
      if (session.contentHash && contentHash.digest("hex") !== session.contentHash) {
        throw new Error("Import hash changed");
      }
      if (buffered) await sendPart(Buffer.concat(chunks));
      await client.send(new CompleteMultipartUploadCommand({
        ...address(source, session), UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));
      return head(source, session);
    } catch (error) {
      await cancel(source, { ...session, s3UploadId: uploadId }).catch(() => {});
      throw error;
    }
  }

  return { cancel, complete, copyClip, head, importStream, listParts, signParts, signPut, start };
}

module.exports = {
  PART_URL_TTL_SECONDS,
  compositeSha256,
  createS3MediaUploader,
};

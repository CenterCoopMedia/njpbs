"use strict";

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { objectRequest, verifyTarget } = require("./s3-media-source");
const { transferError } = require("./cuez-transfer-contract");

function createTransferStorage({ region, audience, fetchImpl = globalThis.fetch, clientFor, sign = getSignedUrl }) {
  const clients = new Map();
  const client = source => {
    if (clientFor) return clientFor(source);
    if (!source?.roleArn || !region || !audience) throw transferError("not_configured");
    if (!clients.has(source.id)) clients.set(source.id, new S3Client({ region,
      credentials: createAwsRoleCredentialProvider({ roleArn: source.roleArn, audience, region }) }));
    return clients.get(source.id);
  };

  async function deliveryUrl(target, ttl) {
    try {
      if (target.publicUrl) {
        const response = await fetchImpl(target.publicUrl, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10000) });
        void response.body?.cancel().catch(() => {});
        if (!response.ok || Number(response.headers.get("content-length")) !== target.sizeBytes) throw transferError("output_unavailable");
        return target.publicUrl;
      }
      const object = { ...target, kind: "web" };
      const s3 = client(target.source);
      await verifyTarget(s3, object, { abortSignal: AbortSignal.timeout(10000) });
      return await sign(s3, new GetObjectCommand({ ...objectRequest(object), ResponseContentType: "video/mp4" }), { expiresIn: ttl });
    } catch (error) {
      if (error.code === "not_configured") throw error;
      throw transferError("output_unavailable");
    }
  }

  async function readText(target) {
    let body;
    try {
      const result = await client(target.source).send(new GetObjectCommand({ Bucket: target.bucket,
        Key: target.objectKey, VersionId: target.objectVersionId, ExpectedBucketOwner: target.source.expectedBucketOwner }),
      { abortSignal: AbortSignal.timeout(10000) });
      body = result.Body;
      if (!body || result.VersionId !== target.objectVersionId || result.ContentLength > target.maximumBytes) throw new Error();
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > target.maximumBytes) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch { throw transferError("output_unavailable"); }
    finally { body?.destroy?.(); }
  }

  return { deliveryUrl, readText };
}

module.exports = { createTransferStorage };

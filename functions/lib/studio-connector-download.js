"use strict";

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { manifestKey, packageKey, parseConnectorManifest } = require("./studio-connector-package");

const DOWNLOAD_TTL_SECONDS = 300;

function createConnectorDownload({ storage, sign = getSignedUrl, now = Date.now }) {
  return async (sourceSha, download) => {
    const store = storage();
    const key = manifestKey(sourceSha);
    const manifestHead = await store.headIfExists(key);
    if (!manifestHead) return { available: false, sourceSha };
    if (!manifestHead.contentLength || manifestHead.contentLength > 16 * 1024) throw new Error("Connector manifest is unavailable");
    const manifest = parseConnectorManifest(JSON.parse((await store.get(key)).toString("utf8")), sourceSha);
    const objectKey = packageKey(sourceSha, manifest.sha256);
    const object = await store.headIfExists(objectKey);
    if (!object || object.contentLength !== manifest.sizeBytes || object.metadata.sha256 !== manifest.sha256 ||
        object.metadata.source !== sourceSha) throw new Error("Connector package is unavailable");
    const result = { available: true, ...manifest };
    if (!download) return result;
    const url = await sign(store.client, new GetObjectCommand({ Bucket: store.bucket, Key: objectKey,
      ResponseContentType: "application/zip", ResponseContentDisposition: `attachment; filename="${manifest.filename}"`,
      ResponseCacheControl: "private, no-store" }), { expiresIn: DOWNLOAD_TTL_SECONDS });
    return { ...result, url, expiresAtMs: now() + DOWNLOAD_TTL_SECONDS * 1000 };
  };
}

module.exports = { createConnectorDownload, DOWNLOAD_TTL_SECONDS };

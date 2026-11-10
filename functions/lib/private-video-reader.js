"use strict";

const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { COPIES, copyIdentity, enqueueCopy, verifiedFile, currentIdentity } = require("./private-video-copy");

const PRIVATE_READ_TTL_SECONDS = 5 * 60;

function createPrivateVideoReader({ firestore, storage, now = Date.now, sign = getSignedUrl }) {
  return async (source, asset, action, disposition) => {
    if (!["preview", "poster", "download_web"].includes(action)) return null;
    const binding = copyIdentity(source, asset);
    if (!binding) return null;
    let r2;
    try { r2 = storage(); } catch { return null; }
    if (!r2) return null;
    const kind = action === "poster" ? "poster" : "web";
    let repair = false;
    try {
      const job = (await firestore.collection(COPIES).doc(binding.id).get()).data();
      const file = verifiedFile(job, kind);
      repair = job?.phase === "ready" && !file;
      if (file) {
        let head;
        try { head = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: file.key })); }
        catch (error) {
          if (["NotFound", "NoSuchKey"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) repair = true;
          throw error;
        }
        if (head.ContentLength === file.sizeBytes && head.ETag === file.etag &&
            head.Metadata?.binding === binding.id && head.Metadata?.generation === job.generation) {
          // Do not issue a link after a concurrent replacement, withdrawal or deletion.
          const fresh = await firestore.collection("mediaSourceAssets").doc(asset.id).get();
          if (currentIdentity(source, fresh)?.id !== binding.id) return null;
          const command = new GetObjectCommand({ Bucket: r2.bucket, Key: file.key,
            ResponseContentType: file.mimeType, ResponseContentDisposition: disposition,
            ResponseCacheControl: `private, max-age=${PRIVATE_READ_TTL_SECONDS}` });
          const url = await sign(r2.client, command, { expiresIn: PRIVATE_READ_TTL_SECONDS });
          return { assetId: asset.id, action, url, expiresAt: new Date(now() + PRIVATE_READ_TTL_SECONDS * 1000).toISOString(),
            mimeType: file.mimeType, disposition: action === "download_web" ? "attachment" : "inline", supportsRange: true };
        }
        repair = true;
      }
    } catch {
      // A missing, corrupt or unavailable copy uses the existing authorized S3 path.
      // Storage errors can contain credentials. Never log or persist their text.
    }
    await enqueueCopy({ firestore, source, assetId: asset.id, repair }).catch(() => {});
    return null;
  };
}
module.exports = { PRIVATE_READ_TTL_SECONDS, createPrivateVideoReader };

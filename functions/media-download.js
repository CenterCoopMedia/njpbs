"use strict";

// Staff downloads of library files. The public media domain serves files inline and a browser
// ignores the download attribute on a cross-origin link, so Download opened the file in a tab.
// This endpoint applies the same access rule as the library list, then signs a short read of the
// stored object with an attachment Content-Disposition. The public domain does not change.

const { GetObjectCommand, HeadObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { hasCapability } = require("./lib/rbac");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { mediaAssetSummary } = require("./lib/media-library");
const { MEDIA_TYPES, assertAssetId } = require("./lib/media-contract");
const { r2ClientConfig } = require("./lib/r2-media");
const { retainedOriginal } = require("./lib/media-master-contract");

const R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const R2_BUCKET = defineString("CMS_MEDIA_R2_BUCKET", { default: "" });
const MASTER_R2_BUCKET = defineString("CMS_MEDIA_MASTER_R2_BUCKET", { default: "" });

const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
const MAX_DOWNLOAD_JSON_BYTES = 2 * 1024;
const MAX_FILENAME_LENGTH = 180;
const FORBIDDEN_MESSAGE = "You do not have permission to download media.";
const UNAVAILABLE_MESSAGE = "Media asset is unavailable";

class MediaDownloadError extends Error {
  constructor(status, message, { cause, operation } = {}) {
    super(message, { cause });
    this.name = "MediaDownloadError";
    this.status = status;
    this.operation = operation;
  }
}

// Diagnostics must never serialize SDK messages, stacks, URLs or credential-bearing objects.
const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "MediaDownloadError", "AuthError", "JsonRequestError",
  "AbortError", "TimeoutError", "NotFound", "NoSuchKey", "NoSuchBucket", "AccessDenied",
  "Forbidden", "ServiceUnavailable", "InternalError", "CredentialsProviderError", "EndpointError",
]);
const SAFE_NETWORK_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]);
function downloadFailureDetails(error) {
  const cause = error instanceof MediaDownloadError && error.cause ? error.cause : error;
  const providerStatus = cause?.$metadata?.httpStatusCode;
  const code = cause?.code;
  return {
    errorName: SAFE_ERROR_NAMES.has(cause?.name) ? cause.name : "UnexpectedError",
    message: error instanceof MediaDownloadError ? error.message : "Unexpected download failure",
    operation: error instanceof MediaDownloadError && error.operation === "original HEAD"
      ? "original HEAD" : "prepare download",
    ...(Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599 ? { providerStatus } : {}),
    ...((Number.isInteger(code) && code >= 0 && code <= 16) || SAFE_NETWORK_CODES.has(code) ? { code } : {}),
  };
}

function parseDownloadRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["assetId", "variant"].includes(key)) ||
      typeof body.assetId !== "string" ||
      (Object.hasOwn(body, "variant") && !["original", "web"].includes(body.variant))) {
    throw new MediaDownloadError(400, "Request must include assetId and an optional original or web variant");
  }
  try {
    return { assetId: assertAssetId(body.assetId), variant: body.variant ?? "web" };
  } catch {
    throw new MediaDownloadError(400, "assetId is invalid");
  }
}

// The saved name keeps the library's original filename. An optimized upload stores a WebP web
// copy, so the extension follows the stored type when the original extension does not match.
function downloadFileName(originalName, mimeType) {
  const extension = MEDIA_TYPES[mimeType]?.extension ?? "";
  const cleaned = [...String(originalName ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ||
        character === "/" || character === "\\" ? "_" : character;
    })
    .join("")
    .trim();
  const separator = cleaned.lastIndexOf(".");
  const stem = (separator > 0 ? cleaned.slice(0, separator) : cleaned) || "download";
  const current = separator > 0 ? cleaned.slice(separator + 1).toLowerCase() : "";
  const matches = current === extension || (extension === "jpg" && current === "jpeg");
  const suffix = extension ? `.${matches ? cleaned.slice(separator + 1) : extension}` : "";
  return [...stem].slice(0, MAX_FILENAME_LENGTH - suffix.length).join("") + suffix;
}

function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// RFC 6266: a plain ASCII filename for old clients, and filename* for the exact UTF-8 name.
function attachmentDisposition(fileName) {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\%]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

function storedObjectKey(assetId, data) {
  const key = data?.storageKey;
  const type = MEDIA_TYPES[data?.mimeType];
  if (typeof key !== "string" || !type) return null;
  const parts = key.split("/");
  return parts.length === 4 && parts[0] === "cms-media" && parts[1] === data.category &&
    parts[2] === assetId && new RegExp(`^[a-f0-9]{64}\\.${type.extension}$`).test(parts[3])
    ? key
    : null;
}

function hasMediaLibraryCapability(principal) {
  return hasCapability(principal, "media.upload") || hasCapability(principal, "media.manage");
}

function createDefaultSigner({ client: suppliedClient } = {}) {
  let client = suppliedClient;
  return async ({ key, disposition, variant = "web", mimeType }) => {
    const endpoint = R2_ENDPOINT.value().trim();
    const bucket = (variant === "original" ? MASTER_R2_BUCKET : R2_BUCKET).value().trim();
    const accessKeyId = R2_ACCESS_KEY_ID.value().trim();
    const secretAccessKey = R2_SECRET_ACCESS_KEY.value().trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey ||
        (variant === "original" && bucket === R2_BUCKET.value().trim())) {
      throw new MediaDownloadError(503, "The media store is not configured");
    }
    client ??= new S3Client(r2ClientConfig({ endpoint, accessKeyId, secretAccessKey }));
    if (variant === "original") {
      try {
        // Old receipts can outlive an object. Probe only after explicit download authorization.
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
          throw new MediaDownloadError(404, UNAVAILABLE_MESSAGE, { cause: error, operation: "original HEAD" });
        }
        throw new MediaDownloadError(503, "The original could not be checked. Try again.", {
          cause: error, operation: "original HEAD",
        });
      }
    }
    return getSignedUrl(client, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: disposition,
      ...(variant === "original" ? {
        ResponseContentType: mimeType,
        ResponseCacheControl: "private, no-store",
      } : {}),
    }), { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  };
}

function createCmsCreateMediaDownloadHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    signFn = createDefaultSigner(),
    nowFn = Date.now,
    log = logger,
  } = deps;
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_DOWNLOAD_JSON_BYTES);
      const { assetId, variant } = parseDownloadRequest(req.body);
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      const audioReadAdmitted = isAudioReadAdmitted(user);
      if (!hasMediaLibraryCapability(user.principal) && !audioReadAdmitted) {
        throw new MediaDownloadError(403, FORBIDDEN_MESSAGE);
      }
      const snapshot = await firestore.collection("media_assets").doc(assetId).get();
      const data = snapshot.exists ? snapshot.data() : null;
      const summary = data ? mediaAssetSummary(snapshot.id, data) : null;
      // Private voiceover takes have their own endpoint and are not in the public store.
      const key = summary && summary.source !== "voiceover" ? storedObjectKey(assetId, data) : null;
      if (!key || !mayUseMedia(user.principal, summary.category, summary.kind, audioReadAdmitted)) {
        throw new MediaDownloadError(404, UNAVAILABLE_MESSAGE);
      }
      const master = variant === "original" && summary.kind === "image" && summary.source === "upload"
        ? retainedOriginal(data.master) : null;
      if (variant === "original" && !master) {
        throw new MediaDownloadError(404, UNAVAILABLE_MESSAGE);
      }
      const fileName = downloadFileName(summary.originalName, master?.mimeType ?? summary.mimeType);
      const url = await signFn({
        key: master?.key ?? key,
        disposition: attachmentDisposition(fileName),
        ...(master ? { variant: "original", mimeType: master.mimeType } : {}),
      });
      res.status(200).json({
        success: true,
        url,
        fileName,
        expiresAt: new Date(nowFn() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      });
    } catch (error) {
      if (res.headersSent) return;
      // Auth errors (401 and 403) carry their own status, as in cmsListMedia.
      const known = error instanceof MediaDownloadError || error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = known && Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) log.error("cmsCreateMediaDownload failed", { status, ...downloadFailureDetails(error) });
      else if (error instanceof MediaDownloadError && error.operation === "original HEAD") {
        log.warn("cmsCreateMediaDownload original unavailable", { status, ...downloadFailureDetails(error) });
      }
      res.status(status).json({ error: known ? error.message : "Failed to prepare the download" });
    }
  };
}

const cmsCreateMediaDownload = cmsOnRequest(
  {
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 30,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
  },
  createCmsCreateMediaDownloadHandler(),
);

module.exports = {
  DOWNLOAD_URL_TTL_SECONDS,
  FORBIDDEN_MESSAGE,
  UNAVAILABLE_MESSAGE,
  attachmentDisposition,
  cmsCreateMediaDownload,
  createCmsCreateMediaDownloadHandler,
  createDefaultSigner,
  downloadFileName,
};

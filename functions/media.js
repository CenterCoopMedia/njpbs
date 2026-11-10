"use strict";

const { preparePublicMediaChangeInTransaction } = require("./lib/public-release-producer");

const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Busboy = require("busboy");
const { PDFDocument } = require("pdf-lib");
const { MAX_AUDIO_BYTES } = require("./lib/voiceover-review");
const { voiceoverMediaLocator } = require("./lib/voiceover-media");
const { WaveAudioError, inspectWaveAudio } = require("./lib/wave-audio");
const sharp = require("sharp");
const { cmsOnRequest } = require("./lib/cms-edge");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const {
  DISCARD_REASONS,
  appendDiscardReceipt,
} = require("./lib/media-discard-audit");
const { assertBillingEnabled } = require("./lib/billing-state");
const { isApprovedActiveAccount } = require("./lib/active-account");
const { can, hasCapability } = require("./lib/rbac");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const { requestHeader } = require("./lib/http-json");
const { mediaAssetSummary } = require("./lib/media-library");
const {
  readMediaAdmission,
  writeMediaAdmission,
  bumpMediaDiscoveryRevision,
  withMediaDiscovery,
} = require("./lib/media-discovery");
const {
  MediaCategoryValidationError,
  requireActiveMediaCategory,
  requireManagedMediaCategories,
} = require("./lib/media-categories");
const {
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_CONFIGURED_UPLOAD_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_WEB_COPY_PIXELS,
  MediaValidationError,
  finalObjectKey,
  mediaProjection,
  mediaType,
  normalizeOriginalName,
  normalizeUploadMetadata,
  publicMediaUrl,
  stagingObjectKey,
  thumbnailObjectKey,
} = require("./lib/media-contract");
const {
  AUTHOR_PHOTO_CATEGORY,
  AUTHOR_PHOTO_MAX_BYTES,
  AUTHOR_PHOTO_MIME_TYPES,
  AUTHOR_PHOTO_MIN_DIMENSION,
} = require("./lib/author-profile-contract");
const { R2MediaStorage } = require("./lib/r2-media");
const {
  MASTER_EXTENSIONS,
  R2MediaMasterStorage,
  masterObjectKey,
} = require("./lib/r2-media-masters");
const { cleanupUploadMaster, queueUploadMasterCleanup } = require("./lib/media-master-cleanup");
const { addMediaThumbnails, thumbnailWidths } = require("./lib/media-thumbnails");
const { readImageCredits, webCopyExif } = require("./lib/image-credits");

// Retain the upload admission cap independently of the larger active-list scan
// ceiling. Raising listing capacity does not authorize more uploads.
const MAX_ACTIVE_MEDIA_ASSETS = 500;
// Self-service profile uploads need room for a current photo and replacements,
// but they must not be an unbounded way to consume the shared media library.
const MAX_SCOPED_PROFILE_PHOTOS = 5;

const R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const R2_BUCKET = defineString("CMS_MEDIA_R2_BUCKET", { default: "" });
// The private bucket for uploaded originals. Empty means masters are not kept yet:
// the web copy still publishes and the asset records that its master was not kept.
const MASTER_R2_BUCKET = defineString("CMS_MEDIA_MASTER_R2_BUCKET", {
  default: "",
});
const MEDIA_PUBLIC_ORIGIN = defineString("CMS_MEDIA_PUBLIC_ORIGIN", {
  default: "https://media.njpbs.org",
});
const MEDIA_MAX_UPLOAD_BYTES = defineString("CMS_MEDIA_MAX_UPLOAD_BYTES", {
  default: String(DEFAULT_MAX_UPLOAD_BYTES),
});
const RESERVATION_LEASE_MS = 15 * 60 * 1_000;
const MAX_MULTIPART_OVERHEAD_BYTES = 128 * 1024;
const MEDIA_ALLOWED_ORIGINS = Object.freeze([
  "https://admin.njpbs.org",
  /^https:\/\/(?:[a-z0-9-]+\.)?njpbs-admin\.pages\.dev$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/,
]);
const ALLOWED_FIELDS = new Set([
  "name",
  "category",
  "categories",
  "description",
  "altText",
  "license",
  "credit",
  "tags",
  "imageProcessing",
  "metadataUpdateRequested",
]);
const WEBP_PROCESSING_MODE = "webp";
const WEBP_SOURCE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
// The web copy of an optimized JPEG or PNG fits both limits. A larger upload is
// scaled down, never refused (the 100-megapixel decode cap still applies).
const MAX_WEB_COPY_LONG_SIDE = 6_000;
const FORBIDDEN_MESSAGE = "You do not have permission to upload media.";
const PROFILE_PHOTO_FORBIDDEN_MESSAGE =
  "CMS authoring access is required to add a staff profile photo.";

class MediaRequestError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = "MediaRequestError";
    this.status = status;
    this.details = details;
  }
}

// A deliberate refusal, not a partial failure: the commit transaction found the
// active library already at its cap. It is thrown from inside commitUpload so the
// handler must distinguish it from a genuine commit fault and never rewrite it into
// a generic recovery error.
class MediaCapacityError extends MediaRequestError {
  constructor() {
    super("The media library has reached its active media limit", 507);
    this.name = "MediaCapacityError";
  }
}

class ProfilePhotoCapacityError extends MediaCapacityError {
  constructor() {
    super();
    this.name = "ProfilePhotoCapacityError";
    this.message = `A staff member can keep at most ${MAX_SCOPED_PROFILE_PHOTOS} active profile photos`;
    this.status = 409;
  }
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null
  );
}

function readMaxUploadBytes() {
  const value = Number.parseInt(MEDIA_MAX_UPLOAD_BYTES.value(), 10);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_UPLOAD_BYTES
  ) {
    throw new MediaRequestError(
      "The media upload limit is not configured",
      503,
    );
  }
  return value;
}

function validateUploadRequest(req, maxBytes) {
  const encoding = requestHeader(req, "content-encoding");
  if (
    encoding !== undefined &&
    encoding.toLocaleLowerCase("en-US") !== "identity"
  ) {
    throw new MediaRequestError("Compressed uploads are not supported", 415);
  }
  const contentType = requestHeader(req, "content-type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType)) {
    throw new MediaRequestError(
      "Content-Type must be multipart/form-data",
      415,
    );
  }
  if (!Buffer.isBuffer(req.rawBody)) {
    throw new MediaRequestError("A multipart file upload is required");
  }
  if (req.rawBody.length > maxBytes + MAX_MULTIPART_OVERHEAD_BYTES) {
    throw new MediaRequestError(
      `The upload exceeds the ${maxBytes} byte file limit`,
      413,
    );
  }
}

function parseMultipartUpload(req, maxBytes, allowedFields = ALLOWED_FIELDS) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(req.rawBody)) {
      reject(new MediaRequestError("A multipart file upload is required"));
      return;
    }
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: maxBytes,
          files: 1,
          fields: allowedFields.size,
          fieldSize: 8_000,
          // Busboy emits partsLimit when it observes the boundary after the
          // last admitted part. Keep one sentinel slot; the independent file
          // and field limits still reject any additional submitted part.
          parts: allowedFields.size + 2,
        },
      });
    } catch {
      reject(
        new MediaRequestError("A valid multipart file upload is required"),
      );
      return;
    }

    const fields = {};
    let upload = null;
    let failure = null;
    const fail = (error) => {
      if (!failure) failure = error;
    };

    parser.on("field", (name, value, info) => {
      if (!allowedFields.has(name)) {
        fail(new MediaRequestError(`Unknown upload field ${name}`));
        return;
      }
      if (info?.valueTruncated) {
        fail(new MediaRequestError(`Upload field ${name} is too long`));
        return;
      }
      if (Object.hasOwn(fields, name)) {
        fail(new MediaRequestError(`Upload field ${name} must appear once`));
        return;
      }
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || upload !== null) {
        fail(
          new MediaRequestError("Upload exactly one file in the file field"),
        );
        stream.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      upload = {
        originalName: info.filename,
        mimeType: String(info.mimeType ?? "").toLocaleLowerCase("en-US"),
        buffer: null,
      };
      stream.on("limit", () => {
        fail(
          new MediaRequestError(
            `The file exceeds the ${maxBytes} byte upload limit`,
            413,
          ),
        );
      });
      stream.on("data", (chunk) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on("end", () => {
        upload.buffer = Buffer.concat(chunks, size);
      });
    });
    parser.on("filesLimit", () => {
      fail(new MediaRequestError("Upload exactly one file in the file field"));
    });
    parser.on("fieldsLimit", () => {
      fail(new MediaRequestError("The upload has too many metadata fields"));
    });
    parser.on("partsLimit", () => {
      fail(new MediaRequestError("The upload has too many parts"));
    });
    parser.on("error", (error) => {
      fail(
        new MediaRequestError(
          error?.message || "The multipart upload is invalid",
        ),
      );
    });
    parser.on("close", () => {
      if (failure) {
        reject(failure);
        return;
      }
      if (
        !upload ||
        !Buffer.isBuffer(upload.buffer) ||
        upload.buffer.length === 0
      ) {
        reject(
          new MediaRequestError(
            "Upload exactly one non-empty file in the file field",
          ),
        );
        return;
      }
      resolve({ ...upload, fields });
    });
    parser.end(req.rawBody);
  });
}

async function inspectUpload(buffer, declaredMimeType) {
  const type = mediaType(declaredMimeType);
  if (!type)
    throw new MediaValidationError("This file type is not supported", 415);
  if (type.kind === "document") {
    try {
      const document = await PDFDocument.load(buffer, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false,
      });
      document.getPageCount();
    } catch {
      throw new MediaValidationError(
        "The file content does not match its PDF type",
        415,
      );
    }
    return { width: null, height: null, animated: false };
  }
  if (type.kind === "audio") {
    if (buffer.length > MAX_AUDIO_BYTES) throw new MediaValidationError("Choose a WAV file that is 10 MiB or smaller", 413);
    try {
      inspectWaveAudio(buffer);
    } catch (error) {
      if (!(error instanceof WaveAudioError)) throw error;
      throw new MediaValidationError(error.message, 415);
    }
    return { width: null, height: null, animated: false };
  }

  let metadata;
  let image;
  try {
    image = sharp(buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    metadata = await image.metadata();
  } catch {
    throw new MediaValidationError("The image cannot be decoded safely", 415);
  }
  if (metadata.format !== type.sharpFormat) {
    throw new MediaValidationError(
      "The file content does not match its image type",
      415,
    );
  }
  const storedWidth = metadata.width;
  const storedHeight = metadata.pageHeight ?? metadata.height;
  if (
    !Number.isInteger(storedWidth) ||
    storedWidth < 1 ||
    !Number.isInteger(storedHeight) ||
    storedHeight < 1 ||
    storedWidth * storedHeight > MAX_IMAGE_PIXELS
  ) {
    throw new MediaValidationError(
      "The image dimensions are invalid or too large",
      415,
    );
  }
  try {
    // metadata() reads headers only. stats() visits every pixel, including all
    // animation frames, without returning a full raw pixel buffer to JavaScript.
    await image.stats();
  } catch {
    throw new MediaValidationError("The image cannot be decoded safely", 415);
  }
  const swapsAxes =
    Number.isInteger(metadata.orientation) &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8;
  const displayWidth = swapsAxes ? storedHeight : storedWidth;
  const displayHeight = swapsAxes ? storedWidth : storedHeight;
  return {
    width: displayWidth,
    height: displayHeight,
    animated: (metadata.pages ?? 1) > 1,
  };
}

function inspectionParts(inspection) {
  return {
    dimensions: { width: inspection.width, height: inspection.height },
    animated: inspection.animated === true,
  };
}

function withEmbeddedCredits(metadata, credits) {
  if (!credits) return metadata;
  const fit = (value, max) => (value ? value.slice(0, max).trim() || null : null);
  return {
    ...metadata,
    credit: metadata.credit ?? fit(credits.credit ?? credits.copyright, 300),
    description: metadata.description ?? fit(credits.caption, 2_000),
  };
}

/** The web copy's size: the displayed size scaled down to fit both limits, never up. */
function webCopyDimensions({ width, height }) {
  const scale = Math.min(
    1,
    MAX_WEB_COPY_LONG_SIDE / Math.max(width, height),
    Math.sqrt(MAX_WEB_COPY_PIXELS / (width * height)),
  );
  if (scale === 1) return { width, height };
  // The small allowance keeps a side that lands exactly on a limit (7000 x 6/7)
  // from losing a pixel to floating-point error.
  return {
    width: Math.max(1, Math.floor(width * scale + 1e-6)),
    height: Math.max(1, Math.floor(height * scale + 1e-6)),
  };
}

async function processUploadImage(buffer, mimeType, mode, dimensions) {
  if (mode === undefined || mode === "") return { buffer, mimeType, credits: null };
  if (mode !== WEBP_PROCESSING_MODE) {
    throw new MediaValidationError("Image processing must be webp");
  }
  if (!WEBP_SOURCE_MIME_TYPES.has(mimeType)) {
    throw new MediaValidationError(
      "Only JPEG and PNG files can be converted to WebP",
      415,
    );
  }
  if (
    !Number.isInteger(dimensions?.width) ||
    !Number.isInteger(dimensions?.height) ||
    dimensions.width < 1 ||
    dimensions.height < 1
  ) {
    throw new MediaValidationError("The image dimensions are invalid", 415);
  }
  try {
    // The same decode cap as inspection, so every image that passed inspection
    // can be decoded here. `dimensions` is the displayed size, after orientation.
    const source = sharp(buffer, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    const credits = readImageCredits(await source.metadata());
    const target = webCopyDimensions(dimensions);
    let pipeline = source.rotate();
    if (target.width !== dimensions.width || target.height !== dimensions.height) {
      // Both sides come from one scale, so "fill" keeps the aspect ratio to within a
      // pixel. "inside" would recompute the scale from the rounded side and could
      // come out one pixel short of the target.
      pipeline = pipeline.resize({
        width: target.width,
        height: target.height,
        fit: "fill",
      });
    }
    // Only the credit, caption and copyright are written back. Every other
    // embedded field, including a GPS position, is dropped.
    const exif = webCopyExif(credits);
    if (exif) pipeline = pipeline.withExif(exif);
    const processed = await pipeline
      .webp({ quality: 82, smartSubsample: true, effort: 4 })
      .toBuffer();
    return { buffer: processed, mimeType: "image/webp", credits };
  } catch {
    throw new MediaValidationError(
      "The image could not be optimized safely",
      415,
    );
  }
}

function objectMetadata({ contentHash, assetId, attemptId, sizeBytes }) {
  return {
    contenthash: contentHash,
    assetid: assetId,
    attemptid: attemptId,
    sizebytes: String(sizeBytes),
  };
}

function storedObjectMatches(object, expected) {
  return Boolean(
    object &&
    object.contentLength === expected.sizeBytes &&
    object.contentType === expected.mimeType &&
    object.metadata?.contenthash === expected.contentHash &&
    object.metadata?.assetid === expected.assetId &&
    object.metadata?.attemptid === expected.attemptId &&
    object.metadata?.sizebytes === String(expected.sizeBytes),
  );
}

async function putOrConfirm({
  storage,
  method,
  key,
  body,
  mimeType,
  metadata,
  expected,
}) {
  try {
    const result = await storage[method]({ key, body, mimeType, metadata });
    if (result?.created === false) {
      const existing = await storage.head(key);
      if (!storedObjectMatches(existing, expected)) {
        throw new MediaRequestError(
          "The immutable media key is already occupied",
          409,
        );
      }
    }
  } catch (error) {
    if (error instanceof MediaRequestError) throw error;
    try {
      const existing = await storage.head(key);
      if (storedObjectMatches(existing, expected)) return;
    } catch {
      // The original write error is more useful than a secondary failed HEAD.
    }
    throw error;
  }
}

function ownerRef(firestore, contentHash) {
  return firestore
    .collection("system")
    .doc("media")
    .collection("hashOwners")
    .doc(contentHash);
}

function mayUseMediaCategory(principal, category, kind, audioReadAdmitted = false) {
  return mayUseMedia(principal, category, kind, audioReadAdmitted);
}

/**
 * The ratified profile-photo policy, enforced on the bytes rather than on what
 * the form promised: still-image types only, at most 5 MiB, and at least
 * 400x400. The license may be any text: the rights basis staff confirm is saved
 * with the profile that uses the photo.
 */
function assertProfilePhotoUpload({ mimeType, sizeBytes, dimensions, animated = false }) {
  if (!AUTHOR_PHOTO_MIME_TYPES.includes(mimeType)) {
    throw new MediaValidationError(
      "A profile photo must be a JPEG, PNG, WebP or AVIF image",
      415,
    );
  }
  if (animated === true) {
    throw new MediaValidationError("A profile photo must be a still image", 415);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > AUTHOR_PHOTO_MAX_BYTES) {
    throw new MediaValidationError("A profile photo must be 5 MB or smaller", 413);
  }
  if (
    !Number.isInteger(dimensions?.width) ||
    !Number.isInteger(dimensions?.height) ||
    dimensions.width < AUTHOR_PHOTO_MIN_DIMENSION ||
    dimensions.height < AUTHOR_PHOTO_MIN_DIMENSION
  ) {
    throw new MediaValidationError(
      `A profile photo must be at least ${AUTHOR_PHOTO_MIN_DIMENSION} by ${AUTHOR_PHOTO_MIN_DIMENSION} pixels`,
      400,
    );
  }
}

function uploadRecordFromClaim({ contentHash, claim, publicOrigin, nowIso, thumbnailAttempt = false }) {
  return withMediaDiscovery(claim.assetId, {
    id: claim.assetId,
    name: claim.recordSeed.metadata.name,
    originalName: claim.recordSeed.originalName,
    category: claim.recordSeed.metadata.category,
    categories: claim.recordSeed.metadata.categories ?? [
      claim.recordSeed.metadata.category,
    ],
    tags: claim.recordSeed.metadata.tags,
    description: claim.recordSeed.metadata.description,
    metadataUpdateRequested: claim.recordSeed.metadata.metadataUpdateRequested === true,
    altText: claim.recordSeed.metadata.altText,
    license: claim.recordSeed.metadata.license,
    credit: claim.recordSeed.metadata.credit,
    mimeType: claim.mimeType,
    kind: mediaType(claim.mimeType).kind,
    // Commit the thumbnail retry state atomically with the original. The
    // synchronous thumbnail attempt changes it to ready only after persistence.
    ...(thumbnailAttempt && mediaType(claim.mimeType).kind === "image"
      ? { thumbnailStatus: "retryable" } : {}),
    sizeBytes: claim.sizeBytes,
    width: claim.recordSeed.dimensions.width,
    height: claim.recordSeed.dimensions.height,
    ...(typeof claim.recordSeed.animated === "boolean"
      ? { animated: claim.recordSeed.animated }
      : {}),
    ...(claim.recordSeed.master ? { master: claim.recordSeed.master } : {}),
    contentHash,
    storageKey: claim.finalKey,
    url: publicMediaUrl(publicOrigin, claim.finalKey),
    lifecycle: "active",
    source: "upload",
    version: 1,
    createdAt: claim.createdAt,
    createdBy: claim.recordSeed.actor.uid,
    updatedAt: nowIso,
    updatedBy: claim.recordSeed.actor.uid,
  });
}

/**
 * Whether a duplicate's asset id may be shown to this caller.
 *
 * The ordinary answer is capability: a caller authorized for the committed
 * asset's own category may see its id. That left the scoped profile-photo path
 * with no way out at all. A contributor holds no `media.upload`, so a lost
 * response on an upload whose bytes already committed came back as a 409 with a
 * null id -- and they cannot browse the library to find the asset they just
 * created, so their own head shot became unreachable. Verified ownership is the
 * second answer: the caller was authorized for this upload under the scoped
 * profile path, the committed asset is in that same category, and the record says
 * they created it. Ownership is read from the stored asset, never claimed.
 */
async function mayDiscloseDuplicate(
  transaction,
  firestore,
  { owner, principal, scopedCategory, actorUid, audioReadAdmitted = false },
) {
  if (mayUseMediaCategory(principal, owner.category)) return true;
  const audioReadable = audioReadAdmitted && can(principal, "media.audio.read");
  const ownPhoto = typeof scopedCategory === "string" && owner.category === scopedCategory &&
    typeof actorUid === "string" && actorUid.length > 0;
  if ((!audioReadable && !ownPhoto) || typeof owner.assetId !== "string") return false;
  const asset = await transaction.get(
    firestore.collection("media_assets").doc(owner.assetId),
  );
  if (!asset.exists) return false;
  const summary = mediaAssetSummary(asset.id, asset.data());
  return (audioReadable && summary?.kind === "audio" && summary.category === owner.category) ||
    (ownPhoto && asset.data()?.createdBy === actorUid);
}

async function reserveHashOwner({
  firestore,
  contentHash,
  claim,
  nowDate,
  principal,
  // Non-null when this request was authorized through the scoped profile-photo
  // path rather than a media capability: the one category that authorization
  // covers, and the uid whose own assets it covers within it.
  scopedCategory = null,
  actorUid = null,
  scopedOwnerUid = null,
  audioReadAdmitted = false,
}) {
  const ref = ownerRef(firestore, contentHash);
  const reservation = await firestore.runTransaction(async (transaction) => {
    // Category lifecycle is checked in the same transaction that reserves the
    // immutable upload claim. An archive racing this request therefore cannot
    // let a new asset commit into a category that was inactive at reservation.
    await requireManagedMediaCategories(
      transaction,
      firestore,
      claim.recordSeed.metadata.categories ?? [claim.category],
    );
    await requireMasterAvailable(transaction, firestore, claim.recordSeed.master);
    const current = await transaction.get(ref);
    // Imported voiceovers retain private objects and have no public upload receipt.
    // Check their canonical media records before reserving a new public WAV object.
    if (!current.exists && claim.mimeType === "audio/wav") {
      const matches = await transaction.get(firestore.collection("media_assets")
        .where("contentHash", "==", contentHash).limit(101));
      const duplicate = matches.docs.find(snapshot => voiceoverMediaLocator(snapshot.id, snapshot.data()));
      if (duplicate || matches.size > 100) {
        const stored = duplicate?.data();
        throw new MediaRequestError("This file is already in the media library", 409, {
          duplicateAssetId: stored && mayUseMediaCategory(
            principal, stored.category, "audio", audioReadAdmitted,
          ) ? duplicate.id : null,
        });
      }
    }
    if (current.exists) {
      const owner = current.data();
      if (owner.state === "purged" && owner.assetId && owner.attemptId) {
        transaction.set(ref.collection("superseded").doc(owner.attemptId), owner);
        transaction.set(ref, claim);
        return { claim, resumed: false };
      }
      if (owner.state === "committed") {
        if (
          typeof owner.supersededByContentHash === "string" &&
          /^[a-f0-9]{64}$/.test(owner.supersededByContentHash) &&
          typeof owner.assetId === "string" &&
          typeof owner.attemptId === "string" &&
          owner.attemptId.length > 0
        ) {
          const supersedingAsset = await transaction.get(
            firestore.collection("media_assets").doc(owner.assetId),
          );
          if (
            !supersedingAsset.exists ||
            !/^[a-f0-9]{64}$/.test(supersedingAsset.data()?.contentHash ?? "") ||
            supersedingAsset.data()?.contentHash === contentHash
          ) {
            throw new MediaRequestError(
              "This historical media receipt needs operator recovery",
              503,
            );
          }
          // One hash-owner document identifies the current binary. Preserve the
          // superseded receipt separately before the new upload claims this key.
          transaction.create(ref.collection("superseded").doc(owner.attemptId), owner);
          transaction.set(ref, claim);
          return { claim, resumed: false };
        }
        // Reveal the existing asset id only to a caller authorized for the
        // committed asset's own category, or one whose own scoped upload it is.
        // The claimed category is attacker controlled, so it cannot decide
        // disclosure. Otherwise return generic duplicate evidence with no id.
        const disclose = await mayDiscloseDuplicate(transaction, firestore, {
          owner,
          principal,
          scopedCategory,
          actorUid,
          audioReadAdmitted,
        });
        throw new MediaRequestError(
          "This file is already in the media library",
          409,
          {
            duplicateAssetId: disclose ? (owner.assetId ?? null) : null,
          },
        );
      }
      if (owner.operation === "replacement") {
        throw new MediaRequestError(
          "A media replacement claim cannot be resumed as an upload",
          503,
        );
      }
      if (
        owner.state !== "reserved" &&
        owner.state !== "object_ready" &&
        owner.state !== "capacity_cleanup"
      ) {
        throw new MediaRequestError(
          "This upload claim needs operator recovery",
          503,
        );
      }
      const leaseExpiresAt = Date.parse(owner.leaseExpiresAt);
      if (!Number.isFinite(leaseExpiresAt)) {
        throw new MediaRequestError(
          "This upload claim has an invalid recovery lease",
          503,
        );
      }
      if (leaseExpiresAt > nowDate.getTime() && owner.attemptId !== claim.attemptId) {
        throw new MediaRequestError(
          "An upload of this file is already being recovered. Try again later.",
          409,
          { retryable: true },
        );
      }
      let expectedFinalKey;
      try {
        expectedFinalKey = finalObjectKey({
          category: owner.category,
          assetId: owner.assetId,
          contentHash,
          mimeType: owner.mimeType,
        });
        if (owner.stagingKey !== stagingObjectKey(owner.attemptId)) {
          throw new Error("staging key mismatch");
        }
        const seed = owner.recordSeed;
        const normalizedMetadata = normalizeUploadMetadata(
          seed?.metadata,
          seed?.originalName,
        );
        const canonicalSeed = {
          ...seed.metadata,
          categories: seed.metadata.categories ?? [seed.metadata.category],
        };
        if (
          !isDeepStrictEqual(normalizedMetadata, canonicalSeed) ||
          typeof seed.actor?.uid !== "string" ||
          seed.actor.uid.length === 0 ||
          (seed.actor.email !== null && typeof seed.actor.email !== "string")
        ) {
          throw new Error("record seed mismatch");
        }
      } catch {
        throw new MediaRequestError(
          "This upload claim has invalid recovery metadata",
          503,
        );
      }
      if (
        owner.finalKey !== expectedFinalKey ||
        owner.category !== claim.category ||
        owner.mimeType !== claim.mimeType ||
        owner.sizeBytes !== claim.sizeBytes
      ) {
        throw new MediaRequestError(
          "The pending upload uses different file metadata and cannot be resumed",
          409,
        );
      }
      if (scopedOwnerUid !== null && owner.recordSeed.actor.uid !== scopedOwnerUid) {
        throw new MediaRequestError(
          "This file is already reserved by another account",
          409,
        );
      }
      if ((owner.recordSeed.master?.contentHash ?? null) !==
          (claim.recordSeed.master?.contentHash ?? null)) {
        throw new MediaRequestError("The pending upload uses a different original", 409);
      }
      const resumed = {
        ...owner,
        recordSeed: {
          ...owner.recordSeed,
          ...(typeof owner.recordSeed?.animated === "boolean" ||
          typeof claim.recordSeed?.animated !== "boolean"
            ? {}
            : { animated: claim.recordSeed.animated }),
          // Reserve the original key again before retrying private storage.
          ...(claim.recordSeed.master ? { master: owner.recordSeed?.master?.retained === true
            ? owner.recordSeed.master : claim.recordSeed.master } : {}),
        },
        state:
          owner.state === "capacity_cleanup" ? "object_ready" : owner.state,
        capacityCleanupAt: null,
        updatedAt: claim.updatedAt,
        leaseExpiresAt: claim.leaseExpiresAt,
        resumedAt: claim.updatedAt,
        recoveryCount: Number.isInteger(owner.recoveryCount)
          ? owner.recoveryCount + 1
          : 1,
      };
      transaction.set(ref, resumed);
      return { claim: resumed, resumed: true };
    }
    transaction.set(ref, claim);
    return { claim, resumed: false };
  });
  return { ref, ...reservation };
}

async function markObjectReady({ firestore, ref, attemptId, nowIso }) {
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    const owner = current.exists ? current.data() : null;
    if (!owner || owner.attemptId !== attemptId) {
      throw new MediaRequestError(
        "The upload reservation changed before the object was ready",
        503,
        {
          retryable: true,
        },
      );
    }
    if (owner.state === "object_ready" || owner.state === "committed") return;
    if (owner.state !== "reserved") {
      throw new MediaRequestError(
        "The upload reservation is not recoverable",
        503,
      );
    }
    transaction.update(ref, {
      state: "object_ready",
      objectReadyAt: nowIso,
      updatedAt: nowIso,
    });
  });
}

function scopedProfilePhotos(firestore, ownerUid) {
  return firestore
    .collection("media_assets")
    .where("createdBy", "==", ownerUid)
    .where("category", "==", AUTHOR_PHOTO_CATEGORY)
    .where("lifecycle", "==", "active")
    .select()
    .limit(MAX_SCOPED_PROFILE_PHOTOS);
}

async function commitUpload({
  firestore,
  ref,
  attemptId,
  record,
  projection,
  actor,
  source,
  nowIso,
  expectedLeaseExpiresAt = null,
  profilePhotoOwnerUid = null,
  adminLogEntryFn = adminLogEntry,
  authorizeInTransaction,
}) {
  const capacityError = await firestore.runTransaction(async (transaction) => {
    if (authorizeInTransaction) await authorizeInTransaction(transaction);
    const current = await transaction.get(ref);
    const owner = current.exists ? current.data() : null;
    if (
      !owner ||
      owner.attemptId !== attemptId ||
      owner.state !== "object_ready" ||
      !isDeepStrictEqual(owner.recordSeed?.master ?? null, record.master ?? null) ||
      (expectedLeaseExpiresAt !== null &&
        owner.leaseExpiresAt !== expectedLeaseExpiresAt)
    ) {
      throw new MediaRequestError(
        "The upload reservation is not ready to commit",
        503,
        {
          retryable: true,
        },
      );
    }
    // A deletion fence also serializes a delayed commit against master cleanup.
    await requireMasterAvailable(transaction, firestore, owner.recordSeed?.master);
    // The reservation check cannot cover an archive that lands after the R2
    // copy. Read the category again in this final transaction so an archive
    // and the media record creation serialize on the same registry document.
    await requireActiveMediaCategory(
      transaction,
      firestore,
      record.category,
    );
    if (profilePhotoOwnerUid !== null) {
      if (
        record.category !== AUTHOR_PHOTO_CATEGORY ||
        record.createdBy !== profilePhotoOwnerUid
      ) {
        throw new MediaRequestError(
          "The scoped profile-photo owner does not match the upload",
          503,
        );
      }
      const profilePhotos = await transaction.get(
        scopedProfilePhotos(firestore, profilePhotoOwnerUid),
      );
      if (profilePhotos.size >= MAX_SCOPED_PROFILE_PHOTOS) {
        return new ProfilePhotoCapacityError();
      }
    }
    let admission;
    try {
      admission = await readMediaAdmission(transaction, firestore);
    } catch (error) {
      if (error.code === "media-admission-overflow") return new MediaCapacityError();
      throw error;
    }
    if (admission.activeCount >= admission.limit) {
      // Remember a reconciled count on refusal, too, so retries do not rescan.
      writeMediaAdmission(transaction, firestore, admission.activeCount, admission.revision);
      return new MediaCapacityError();
    }
    const privateRef = firestore.collection("media_assets").doc(record.id);
    const publicRef = firestore
      .collection("media_assets_public")
      .doc(record.id);
    const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
      id: record.id, version: record.version, after: projection, mediaSource: record });
    writeReleaseChange();
    transaction.create(privateRef, record);
    transaction.create(publicRef, projection);
    bumpMediaDiscoveryRevision(transaction, firestore, {
      admissionCount: admission.activeCount + 1, admissionRevision: admission.revision + 1,
    });
    transaction.set(ref, {
      ...owner,
      state: "committed",
      committedAt: nowIso,
      updatedAt: nowIso,
    });
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "media.upload",
        target: `media_assets/${record.id}`,
        before: null,
        after: {
          contentHash: record.contentHash,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          category: record.category,
          categories: record.categories,
          license: record.license,
        },
        source,
      }),
    );
  }).catch(async (error) => {
    // A competing upload may fill the quota while the SDK exhausts contention
    // attempts. Preserve receipt recovery if an earlier attempt already landed.
    if (![10, 409].includes(error?.code) || profilePhotoOwnerUid === null) throw error;
    const [profilePhotos, uploaded] = await Promise.all([
      scopedProfilePhotos(firestore, profilePhotoOwnerUid).get(),
      firestore.collection("media_assets").doc(record.id).get(),
    ]);
    if (profilePhotos.size >= MAX_SCOPED_PROFILE_PHOTOS && !uploaded.exists) {
      return new ProfilePhotoCapacityError();
    }
    throw error;
  });
  // Complete the capacity refusal before cleanup takes the claim's write lock.
  // Throwing inside the callback starts an asynchronous SDK rollback instead.
  if (capacityError) throw capacityError;
}

async function discardUploadAfterCommitRejection({
  firestore,
  storage,
  ref,
  attemptId,
  finalKey,
  thumbnailKeys = [],
  stagingKeys,
  nowIso,
  leaseExpiresAt,
  discardReason,
  rejectionLabel,
  masterStorageFactory = createDefaultMasterStorage,
  allowReserved = false,
  adminLogEntryFn = adminLogEntry,
}) {
  // Terminal checks must stay in the commit transaction to serialize with the
  // state they protect. Lock the exact losing claim before touching R2 so a
  // committed claim can never lose its object. Keep the established
  // capacity_cleanup state name so older in-flight claims stay recoverable.
  let previousState = "object_ready";
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(ref);
    const owner = current.exists ? current.data() : null;
    if (
      !owner ||
      owner.attemptId !== attemptId ||
      (owner.state !== "object_ready" && !(allowReserved && owner.state === "reserved")) ||
      owner.leaseExpiresAt !== leaseExpiresAt
    ) {
      throw new MediaRequestError(
        `The ${rejectionLabel} upload changed before cleanup`,
        503,
        { retryable: true, attemptId },
      );
    }
    previousState = owner.state;
    transaction.update(ref, {
      state: "capacity_cleanup",
      capacityCleanupAt: nowIso,
      updatedAt: nowIso,
      leaseExpiresAt,
    });
  });

  try {
    await cleanupUploadMaster({ firestore, ref, attemptId, leaseExpiresAt,
      masterStorageFactory, nowIso });
    if (thumbnailKeys.length) {
      await storage.deleteFinal(finalKey, thumbnailKeys);
    } else {
      await storage.deleteFinal(finalKey);
    }
    for (const key of new Set(stagingKeys.filter(Boolean))) {
      await storage.deleteStaging(key);
    }
    await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists) return;
      const owner = current.data();
      if (owner.attemptId !== attemptId || owner.state !== "capacity_cleanup") {
        throw new MediaRequestError(
          `The ${rejectionLabel} upload changed during cleanup`,
          503,
          { retryable: true, attemptId },
        );
      }
      // Destructive removal, so it is audited in the same commit that finishes
      // it (#205): the finished object is already gone from the media store and
      // the claim is going with it, and nothing else in the system will hold
      // what this row keeps. The receipt reads before the delete because a
      // Firestore transaction cannot read after it writes, and it is keyed by
      // the attempt so a discard that is interrupted here and finished by the
      // recovery pass leaves exactly one row.
      await appendDiscardReceipt(transaction, firestore, {
        adminLogEntryFn,
        contentHash: owner.contentHash ?? ref.id,
        owner,
        attemptId,
        finalKey,
        reason: discardReason,
      });
      transaction.delete(ref);
    });
  } catch (error) {
    try {
      await firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(ref);
        if (!current.exists) return;
        const owner = current.data();
        if (
          owner.attemptId === attemptId &&
          owner.state === "capacity_cleanup"
        ) {
          transaction.update(ref, {
            state: previousState,
            capacityCleanupAt: null,
            updatedAt: nowIso,
            leaseExpiresAt,
          });
        }
      });
    } catch {
      // The capacity-cleanup state remains lease-backed and recoverable.
    }
    throw error;
  }
}

async function discardCapacityRejectedUpload(args) {
  return discardUploadAfterCommitRejection({
    ...args,
    discardReason: DISCARD_REASONS.capacity,
    rejectionLabel: "capacity-rejected",
  });
}

async function discardCategoryRejectedUpload(args) {
  return discardUploadAfterCommitRejection({
    ...args,
    discardReason: DISCARD_REASONS.category,
    rejectionLabel: "category-rejected",
  });
}

async function discardUgcDecisionUpload(args) {
  return discardUploadAfterCommitRejection({
    ...args,
    discardReason: DISCARD_REASONS.ugcDecision,
    rejectionLabel: "UGC decision",
    allowReserved: true,
  });
}

async function committedUpload(
  firestore,
  { contentHash, attemptId, record, allowTombstoned = false },
) {
  const [ownerSnapshot, privateSnapshot, publicSnapshot] = await Promise.all([
    ownerRef(firestore, contentHash).get(),
    firestore.collection("media_assets").doc(record.id).get(),
    firestore.collection("media_assets_public").doc(record.id).get(),
  ]);
  if (!ownerSnapshot.exists || !privateSnapshot.exists) return false;
  const owner = ownerSnapshot.data();
  const stored = privateSnapshot.data();
  const exactBinding =
    owner.state === "committed" &&
    owner.attemptId === attemptId &&
    owner.assetId === record.id &&
    owner.category === record.category &&
    owner.finalKey === record.storageKey &&
    stored.id === record.id &&
    stored.contentHash === record.contentHash &&
    stored.storageKey === record.storageKey &&
    stored.category === record.category &&
    stored.source === "upload";
  if (!exactBinding) return false;
  if (stored.lifecycle === "tombstoned") {
    return allowTombstoned && !publicSnapshot.exists;
  }
  return (
    stored.lifecycle === "active" &&
    publicSnapshot.exists &&
    isDeepStrictEqual(publicSnapshot.data(), mediaProjection(stored))
  );
}

function createDefaultStorage() {
  const endpoint = R2_ENDPOINT.value().trim();
  const bucket = R2_BUCKET.value().trim();
  let accessKeyId;
  let secretAccessKey;
  try {
    accessKeyId = R2_ACCESS_KEY_ID.value().trim();
    secretAccessKey = R2_SECRET_ACCESS_KEY.value().trim();
  } catch {
    throw new MediaRequestError(
      "The media store credentials are not configured",
      503,
    );
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new MediaRequestError("The media store is not configured", 503);
  }
  return new R2MediaStorage({ endpoint, bucket, accessKeyId, secretAccessKey });
}

/** The private master store, or null while its bucket is not configured. */
function createDefaultMasterStorage() {
  const bucket = MASTER_R2_BUCKET.value().trim();
  if (!bucket) return null;
  const endpoint = R2_ENDPOINT.value().trim();
  const accessKeyId = R2_ACCESS_KEY_ID.value().trim();
  const secretAccessKey = R2_SECRET_ACCESS_KEY.value().trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  return new R2MediaMasterStorage({ endpoint, bucket, accessKeyId, secretAccessKey });
}

// Publish the original key in the reservation before touching private storage.
function masterIntent(upload, dimensions) {
  const contentHash = createHash("sha256").update(upload.buffer).digest("hex");
  return {
    contentHash,
    mimeType: upload.mimeType,
    sizeBytes: upload.buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    ...(Object.hasOwn(MASTER_EXTENSIONS, upload.mimeType)
      ? { key: masterObjectKey({ contentHash, mimeType: upload.mimeType }) } : {}),
    retained: false,
    reason: "pending",
  };
}

// Keep the private-store result recoverable even if the public write fails.
async function recordMasterResult({ firestore, refs, attemptId, leaseExpiresAt, master }) {
  await firestore.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    for (const snapshot of snapshots) {
      const claim = snapshot.data();
      if (!claim || claim.attemptId !== attemptId || claim.leaseExpiresAt !== leaseExpiresAt ||
          (master.key && claim.recordSeed?.master?.key !== master.key) ||
          !["reserved", "object_ready"].includes(claim.state) ||
          claim.recordSeed?.master?.contentHash !== master.contentHash) {
        throw new MediaRequestError("The original reservation changed before it was ready", 503,
          { retryable: true, attemptId });
      }
      // A failed PUT receipt has no key, but must still honor the reserved key's
      // fence so it cannot erase recovery evidence while deletion is in flight.
      await requireMasterAvailable(transaction, firestore, claim.recordSeed.master);
    }
    for (const snapshot of snapshots) {
      transaction.update(snapshot.ref, {
        recordSeed: { ...snapshot.data().recordSeed, master },
      });
    }
  });
}

async function requireMasterAvailable(transaction, firestore, master) {
  if (!master?.key) return;
  const lock = await transaction.get(
    firestore.doc(`system/media/masterLocks/${master.contentHash}`),
  );
  if (lock.data()?.state === "purging") {
    throw new MediaRequestError("The original is being purged. Try again later.", 503,
      { retryable: true });
  }
}

/**
 * Keeps the uploaded original privately when the published file is a converted
 * web copy. A failed private write can still publish the web copy after its
 * possible partial object is cleaned up. Failed cleanup keeps the claim pending.
 */
async function retainMaster({ masterStorageFactory, upload, dimensions, log, onStoreFailure }) {
  const contentHash = createHash("sha256").update(upload.buffer).digest("hex");
  const base = {
    contentHash,
    mimeType: upload.mimeType,
    sizeBytes: upload.buffer.length,
    width: dimensions.width,
    height: dimensions.height,
  };
  if (!Object.hasOwn(MASTER_EXTENSIONS, upload.mimeType)) {
    return { ...base, retained: false, reason: "unsupported" };
  }
  let masterStorage;
  try {
    masterStorage = await masterStorageFactory();
  } catch (error) {
    log.warn("cmsUploadMedia master store is unavailable", {
      error: error?.message || String(error),
      contentHash,
    });
    return { ...base, retained: false, reason: "store-failed" };
  }
  if (!masterStorage) return { ...base, retained: false, reason: "not-configured" };
  const key = masterObjectKey({ contentHash, mimeType: upload.mimeType });
  try {
    await masterStorage.putIfAbsent({
      key,
      body: upload.buffer,
      mimeType: upload.mimeType,
      contentHash,
    });
  } catch (error) {
    log.warn("cmsUploadMedia master was not kept", {
      error: error?.message || String(error),
      contentHash,
    });
    // Keep the PUT cause even if cleanup of a possible partial object also fails.
    if (onStoreFailure) await onStoreFailure();
    return { ...base, retained: false, reason: "store-failed" };
  }
  return { ...base, retained: true, key };
}

/** Verify and process the binary identically for uploads and replacements. */
async function prepareMediaUpload({
  upload, limit, inspectUploadFn = inspectUpload,
  processUploadImageFn = processUploadImage, profilePhoto = false,
}) {
  let { dimensions, animated } = inspectionParts(
    await inspectUploadFn(upload.buffer, upload.mimeType),
  );
  if (profilePhoto) {
    assertProfilePhotoUpload({
      mimeType: upload.mimeType,
      sizeBytes: upload.buffer.length,
      dimensions,
      animated,
    });
  }
  const storedUpload = await processUploadImageFn(
    upload.buffer,
    upload.mimeType,
    upload.fields.imageProcessing,
    dimensions,
  );
  if (storedUpload.buffer.length > limit) {
    throw new MediaRequestError(
      `The processed file exceeds the ${limit} byte upload limit`,
      413,
    );
  }
  const processed =
    storedUpload.buffer !== upload.buffer ||
    storedUpload.mimeType !== upload.mimeType;
  const sourceDimensions = dimensions;
  if (processed) {
    ({ dimensions, animated } = inspectionParts(
      await inspectUploadFn(storedUpload.buffer, storedUpload.mimeType),
    ));
    if (profilePhoto) {
      assertProfilePhotoUpload({
        mimeType: storedUpload.mimeType,
        sizeBytes: storedUpload.buffer.length,
        dimensions,
        animated,
      });
    }
  }
  return { storedUpload, dimensions, animated, processed, sourceDimensions };
}

function createCmsUploadMediaHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    parseUploadFn = parseMultipartUpload,
    inspectUploadFn = inspectUpload,
    processUploadImageFn = processUploadImage,
    assertBillingEnabledFn = assertBillingEnabled,
    storageFactory = createDefaultStorage,
    masterStorageFactory = createDefaultMasterStorage,
    mintId = randomUUID,
    now = () => new Date(),
    maxUploadBytes = readMaxUploadBytes,
    publicOrigin = () => MEDIA_PUBLIC_ORIGIN.value(),
    adminLogEntryFn = adminLogEntry,
    commitUploadFn = commitUpload,
    committedUploadFn = committedUpload,
    log = logger,
  } = deps;

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let unclaimedStagingKey = null;
    let claimedStagingKey = null;
    let storage = null;
    let reservationCreated = false;
    let uploadContext = null;
    let masterCleanup = null;
    try {
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      // Authors and profile managers without media.upload can upload only a
      // profile photograph. The category below confines this exception.
      const generalUpload = hasCapability(actor.principal, "media.upload");
      if (!generalUpload) {
        if (!hasCapability(actor.principal, "content.create") &&
            !hasCapability(actor.principal, "profiles.manage")) {
          res.status(403).json({ error: FORBIDDEN_MESSAGE });
          return;
        }
        if (!(await isApprovedActiveAccount(firestore, actor.uid))) {
          res.status(403).json({ error: PROFILE_PHOTO_FORBIDDEN_MESSAGE });
          return;
        }
      }

      try {
        await assertBillingEnabledFn(firestore);
      } catch (error) {
        if (error?.code === "failed-precondition") {
          throw new MediaRequestError(error.message, 503);
        }
        throw error;
      }

      const configuredLimit =
        typeof maxUploadBytes === "function"
          ? maxUploadBytes()
          : maxUploadBytes;
      const limit = generalUpload
        ? configuredLimit
        : Math.min(configuredLimit, AUTHOR_PHOTO_MAX_BYTES);
      validateUploadRequest(req, limit);
      const upload = await parseUploadFn(req, limit);
      const metadata = normalizeUploadMetadata(
        upload.fields,
        upload.originalName,
      );
      const profilePhoto = metadata.category === AUTHOR_PHOTO_CATEGORY;
      // Held past the authorization check because a duplicate-bytes retry has to
      // know this caller was authorized for this one category: without it a
      // scoped uploader recovering a lost response is told "already in the
      // library" and refused the id of the asset they themselves created.
      let scopedCategory = null;
      let profilePhotoOwnerUid = null;
      if (profilePhoto) {
        // A media uploader works in every category; otherwise the caller needs
        // content.create or profiles.manage and gets only this category.
        const categoryUpload = generalUpload;
        scopedCategory = metadata.category;
        if (!categoryUpload) {
          profilePhotoOwnerUid = actor.uid;
        }
        if (
          !categoryUpload &&
          (metadata.categories.length !== 1 ||
            metadata.categories[0] !== metadata.category)
        ) {
          throw new MediaValidationError(
            "A self-service profile photo cannot use additional categories",
          );
        }
        if (
          upload.fields.imageProcessing !== undefined &&
          upload.fields.imageProcessing !== ""
        ) {
          throw new MediaValidationError(
            "Profile photos must keep the original file",
          );
        }
      } else if (!generalUpload) {
        // The profile-photo scope buys nothing here: every other category still
        // needs the real, site-wide upload capability.
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }
      if (upload.buffer.length > limit) {
        throw new MediaRequestError(
          `The file exceeds the ${limit} byte upload limit`,
          413,
        );
      }
      const { storedUpload, dimensions, animated, processed, sourceDimensions } =
        await prepareMediaUpload({
          upload, limit, inspectUploadFn, processUploadImageFn, profilePhoto,
        });
      const recordMetadata = withEmbeddedCredits(metadata, storedUpload.credits);
      const contentHash = createHash("sha256")
        .update(storedUpload.buffer)
        .digest("hex");
      const proposedAssetId = mintId();
      const proposedAttemptId = mintId();
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      const proposedFinalKey = finalObjectKey({
        category: metadata.category,
        assetId: proposedAssetId,
        contentHash,
        mimeType: storedUpload.mimeType,
      });
      const resolvedPublicOrigin =
        typeof publicOrigin === "function" ? publicOrigin() : publicOrigin;
      publicMediaUrl(resolvedPublicOrigin, proposedFinalKey);
      const proposedStagingKey = stagingObjectKey(proposedAttemptId);
      const proposedObject = {
        contentHash,
        assetId: proposedAssetId,
        attemptId: proposedAttemptId,
        sizeBytes: storedUpload.buffer.length,
        mimeType: storedUpload.mimeType,
      };
      const proposedR2Metadata = objectMetadata(proposedObject);
      uploadContext = {
        contentHash,
        assetId: proposedAssetId,
        attemptId: proposedAttemptId,
      };
      storage = await storageFactory();
      unclaimedStagingKey = proposedStagingKey;
      // Only a converted web copy needs a master; otherwise the published file is
      // the original.
      const master = processed ? masterIntent(upload, sourceDimensions) : null;

      await putOrConfirm({
        storage,
        method: "putStaging",
        key: proposedStagingKey,
        body: storedUpload.buffer,
        mimeType: storedUpload.mimeType,
        metadata: proposedR2Metadata,
        expected: proposedObject,
      });

      const claim = {
        state: "reserved",
        attemptId: proposedAttemptId,
        assetId: proposedAssetId,
        category: metadata.category,
        finalKey: proposedFinalKey,
        stagingKey: proposedStagingKey,
        sizeBytes: storedUpload.buffer.length,
        mimeType: storedUpload.mimeType,
        recordSeed: {
          metadata: recordMetadata,
          originalName: normalizeOriginalName(upload.originalName),
          dimensions,
          animated,
          ...(master ? { master } : {}),
          actor: {
            uid: actor.uid,
            email: actor.email ?? null,
          },
          source: getClientIp(req),
        },
        createdAt: nowIso,
        updatedAt: nowIso,
        leaseExpiresAt: new Date(
          nowDate.getTime() + RESERVATION_LEASE_MS,
        ).toISOString(),
      };
      const reservation = await reserveHashOwner({
        firestore,
        contentHash,
        claim,
        nowDate,
        principal: actor.principal,
        scopedCategory,
        actorUid: actor.uid,
        scopedOwnerUid: profilePhotoOwnerUid,
        audioReadAdmitted: isAudioReadAdmitted(actor),
      });
      reservationCreated = true;
      const ref = reservation.ref;
      const activeClaim = reservation.claim;
      masterCleanup = { firestore, ref, attemptId: activeClaim.attemptId,
        leaseExpiresAt: activeClaim.leaseExpiresAt, masterStorageFactory, nowIso };
      // The reservation owns this staging object even if master persistence fails.
      if (!reservation.resumed) unclaimedStagingKey = null;
      if (processed && activeClaim.recordSeed.master?.retained !== true) {
        activeClaim.recordSeed.master = await retainMaster({
          masterStorageFactory, upload, dimensions: sourceDimensions, log,
          onStoreFailure: () => cleanupUploadMaster(masterCleanup),
        });
        await recordMasterResult({ firestore, refs: [ref], attemptId: activeClaim.attemptId,
          leaseExpiresAt: activeClaim.leaseExpiresAt, master: activeClaim.recordSeed.master });
      }
      const assetId = activeClaim.assetId;
      const attemptId = activeClaim.attemptId;
      const finalKey = activeClaim.finalKey;
      const recordSeed = activeClaim.recordSeed;
      claimedStagingKey = activeClaim.stagingKey;
      const expectedObject = {
        contentHash,
        assetId,
        attemptId,
        sizeBytes: activeClaim.sizeBytes,
        mimeType: activeClaim.mimeType,
      };
      const r2Metadata = objectMetadata(expectedObject);
      uploadContext = { contentHash, assetId, attemptId };
      publicMediaUrl(resolvedPublicOrigin, finalKey);

      try {
        await putOrConfirm({
          storage,
          method: "putFinal",
          key: finalKey,
          body: storedUpload.buffer,
          mimeType: storedUpload.mimeType,
          metadata: r2Metadata,
          expected: expectedObject,
        });
      } catch (error) {
        log.error("cmsUploadMedia final object needs recovery", {
          error: error?.message || String(error),
          attemptId,
          assetId,
          contentHash,
          finalKey,
        });
        throw new MediaRequestError(
          "The upload needs recovery before it can be retried",
          503,
          { retryable: true, attemptId },
        );
      }
      await markObjectReady({ firestore, ref, attemptId, nowIso });

      const record = uploadRecordFromClaim({
        contentHash,
        claim: activeClaim,
        publicOrigin: resolvedPublicOrigin,
        nowIso,
        thumbnailAttempt: true,
      });
      const projection = mediaProjection(record);
      const responseAsset = mediaAssetSummary(record.id, record);
      if (!responseAsset) {
        throw new MediaRequestError("The media record is invalid", 503, {
          retryable: true,
          attemptId,
        });
      }
      try {
        await commitUploadFn({
          firestore,
          ref,
          attemptId,
          record,
          projection,
          actor: recordSeed.actor,
          source: recordSeed.source,
          nowIso,
          profilePhotoOwnerUid,
          expectedLeaseExpiresAt: activeClaim.leaseExpiresAt,
          adminLogEntryFn,
        });
      } catch (error) {
        if (
          error instanceof MediaCapacityError ||
          error instanceof MediaCategoryValidationError
        ) {
          const categoryRejected =
            error instanceof MediaCategoryValidationError;
          try {
            const discardRejectedUpload = categoryRejected
              ? discardCategoryRejectedUpload
              : discardCapacityRejectedUpload;
            await discardRejectedUpload({
              firestore,
              storage,
              masterStorageFactory,
              ref,
              attemptId,
              finalKey,
              thumbnailKeys: record.kind === "image"
                ? thumbnailWidths(record.width).map((width) =>
                  thumbnailObjectKey({
                    category: record.category,
                    assetId: record.id,
                    contentHash,
                    width,
                  }))
                : [],
              stagingKeys: [claimedStagingKey, unclaimedStagingKey],
              nowIso,
              leaseExpiresAt: activeClaim.leaseExpiresAt,
            });
            claimedStagingKey = null;
            unclaimedStagingKey = null;
          } catch (cleanupError) {
            const rejection = categoryRejected ? "category" : "capacity";
            log.error(`cmsUploadMedia ${rejection} cleanup needs recovery`, {
              error: cleanupError?.message || String(cleanupError),
              attemptId,
              assetId,
              contentHash,
              finalKey,
            });
            throw new MediaRequestError(
              `The ${rejection}-rejected upload needs recovery before it can be retried`,
              503,
              { retryable: true, attemptId },
            );
          }
          throw error;
        }
        if (
          !(await committedUploadFn(firestore, {
            contentHash,
            attemptId,
            record,
            projection,
          }))
        ) {
          log.error("cmsUploadMedia commit needs recovery", {
            error: error?.message || String(error),
            attemptId,
            assetId,
            contentHash,
          });
          throw new MediaRequestError(
            "The upload needs recovery before it can be retried",
            503,
            { retryable: true, attemptId },
          );
        }
      }

      for (const key of new Set(
        [claimedStagingKey, unclaimedStagingKey].filter(Boolean),
      )) {
        try {
          await storage.deleteStaging(key);
        } catch (error) {
          log.warn("cmsUploadMedia could not remove staging object", {
            error: error?.message || String(error),
            attemptId,
            stagingKey: key,
          });
        }
      }
      unclaimedStagingKey = null;
      const finalRecord = await addMediaThumbnails({
        firestore,
        storage,
        record,
        buffer: storedUpload.buffer,
        publicOrigin: resolvedPublicOrigin,
        log,
      });
      res.status(201).json({
        success: true,
        asset: mediaAssetSummary(finalRecord.id, finalRecord),
      });
    } catch (error) {
      if (masterCleanup) {
        try {
          const terminal = error instanceof MediaValidationError ||
            error instanceof MediaCategoryValidationError ||
            (error instanceof MediaRequestError && error.status >= 400 && error.status < 500 &&
              !error.details?.retryable);
          if (terminal) await cleanupUploadMaster(masterCleanup);
          else await queueUploadMasterCleanup(masterCleanup);
        } catch (cleanupError) {
          log.error("cmsUploadMedia master cleanup needs recovery", {
            error: cleanupError?.message || String(cleanupError),
            attemptId: masterCleanup.attemptId,
          });
        }
      }
      if (unclaimedStagingKey && storage) {
        try {
          await storage.deleteStaging(unclaimedStagingKey);
        } catch (cleanupError) {
          log.warn("cmsUploadMedia could not remove unclaimed staging object", {
            error: cleanupError?.message || String(cleanupError),
            stagingKey: unclaimedStagingKey,
          });
        }
      }
      if (res.headersSent) return;
      const expected =
        error instanceof MediaRequestError ||
        error instanceof MediaValidationError ||
        error instanceof MediaCategoryValidationError;
      let responseError = error;
      if (reservationCreated && !expected) {
        log.error("cmsUploadMedia failed", {
          error: error?.message || String(error),
          ...uploadContext,
        });
        responseError = new MediaRequestError(
          "The upload needs recovery before it can be retried",
          503,
          { retryable: true, attemptId: uploadContext?.attemptId ?? null },
        );
      } else if (!expected && (error?.status ?? 500) >= 500) {
        log.error("cmsUploadMedia failed", {
          error: error?.message || String(error),
          ...uploadContext,
        });
      }
      const status =
        typeof responseError?.status === "number" ? responseError.status : 500;
      const safeMessage =
        status < 500 ||
        responseError instanceof MediaRequestError ||
        responseError instanceof MediaValidationError ||
        responseError instanceof MediaCategoryValidationError;
      res.status(status).json({
        error: safeMessage
          ? responseError.message
          : "The media file could not be uploaded",
        ...(responseError instanceof MediaRequestError
          ? responseError.details
          : {}),
      });
    }
  };
}

const cmsUploadMedia = cmsOnRequest(
  {
    cors: MEDIA_ALLOWED_ORIGINS,
    memory: "1GiB",
    concurrency: 1,
    maxInstances: 5,
    timeoutSeconds: 120,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
  },
  createCmsUploadMediaHandler(),
);

module.exports = {
  ALLOWED_FIELDS,
  FORBIDDEN_MESSAGE,
  PROFILE_PHOTO_FORBIDDEN_MESSAGE,
  assertProfilePhotoUpload,
  isApprovedActiveAccount,
  MEDIA_MAX_UPLOAD_BYTES,
  MEDIA_PUBLIC_ORIGIN,
  MAX_ACTIVE_MEDIA_ASSETS,
  MAX_SCOPED_PROFILE_PHOTOS,
  MAX_MULTIPART_OVERHEAD_BYTES,
  MEDIA_ALLOWED_ORIGINS,
  MAX_WEB_COPY_LONG_SIDE,
  MAX_WEB_COPY_PIXELS,
  MASTER_R2_BUCKET,
  MediaCapacityError,
  ProfilePhotoCapacityError,
  MediaRequestError,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  RESERVATION_LEASE_MS,
  cmsUploadMedia,
  commitUpload,
  committedUpload,
  createDefaultMasterStorage,
  createDefaultStorage,
  createCmsUploadMediaHandler,
  discardCapacityRejectedUpload,
  discardCategoryRejectedUpload,
  discardUgcDecisionUpload,
  inspectUpload,
  prepareMediaUpload,
  mayDiscloseDuplicate,
  processUploadImage,
  markObjectReady,
  mayUseMediaCategory,
  objectMetadata,
  ownerRef,
  parseMultipartUpload,
  putOrConfirm,
  reserveHashOwner,
  readMaxUploadBytes,
  retainMaster,
  masterIntent,
  recordMasterResult,
  requireMasterAvailable,
  storedObjectMatches,
  uploadRecordFromClaim,
  validateUploadRequest,
  webCopyDimensions,
  WEBP_PROCESSING_MODE,
  WEBP_SOURCE_MIME_TYPES,
};

"use strict";

const { isApprovedActiveAccount } = require("./active-account");
const { can, hasCapability } = require("./rbac");
const {
  MEDIA_CATEGORIES_COLLECTION,
  parseMediaCategoryDefinition,
} = require("./media-categories");

const AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;
const AWS_ROLE_ARN_PATTERN = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const S3_BUCKET_PATTERN = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const ARCHIVE_CATEGORY_ID = "archive";

class MediaSourceAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MediaSourceAccessError";
    this.status = status;
  }
}

function enabled(value) {
  return value === true || value === "true";
}

function validPrivateSource(source) {
  const roleMatch = typeof source.roleArn === "string"
    ? source.roleArn.match(AWS_ROLE_ARN_PATTERN)
    : null;
  return Boolean(
    source &&
    typeof source.id === "string" &&
    typeof source.label === "string" &&
    typeof source.description === "string" &&
    S3_BUCKET_PATTERN.test(source.bucket ?? "") &&
    AWS_ACCOUNT_ID_PATTERN.test(source.expectedBucketOwner ?? "") &&
    roleMatch &&
    roleMatch[1] === source.expectedBucketOwner &&
    typeof source.prefix === "string" &&
    !source.prefix.startsWith("/") &&
    source.prefix.length <= 512 &&
    (source.access === "active_staff" || source.access === "archive") &&
    typeof source.writable === "boolean" &&
    (!source.writable || source.prefix === "")
  );
}

function buildMediaSourceRegistry(config) {
  const candidates = [
    {
      id: "video-library",
      label: "Videos",
      description: "Browse station videos for production, preview, and download.",
      mediaKind: "video",
      bucket: config.videoBucket,
      expectedBucketOwner: config.videoAccountId,
      prefix: config.videoPrefix ?? "",
      roleArn: config.videoRoleArn,
      access: "active_staff",
      writable: true,
      enabled: enabled(config.videoEnabled),
    },
    {
      id: "archive-originals",
      label: "NJ Spotlight News archive originals",
      description: "Preserved originals from the NJ Spotlight News transfer.",
      mediaKind: "video",
      bucket: config.archiveOriginalsBucket,
      expectedBucketOwner: config.archiveAccountId,
      prefix: config.archiveOriginalsPrefix ?? "",
      roleArn: config.archiveRoleArn,
      access: "archive",
      writable: false,
      enabled: enabled(config.archiveEnabled),
    },
    {
      id: "archive-working",
      label: "NJ Spotlight News archive working files",
      description: "Working copies prepared from the NJ Spotlight News archive.",
      mediaKind: "video",
      bucket: config.archiveWorkingBucket,
      expectedBucketOwner: config.archiveAccountId,
      prefix: config.archiveWorkingPrefix ?? "",
      roleArn: config.archiveRoleArn,
      access: "archive",
      writable: true,
      enabled: enabled(config.archiveEnabled),
    },
  ];
  return new Map(
    candidates
      .filter((source) => source.enabled && validPrivateSource(source))
      .map((source) => [source.id, Object.freeze(source)]),
  );
}

async function hasActiveArchiveCategory(firestore) {
  const snapshot = await firestore
    .collection(MEDIA_CATEGORIES_COLLECTION)
    .doc(ARCHIVE_CATEGORY_ID)
    .get();
  if (!snapshot.exists) return false;
  return parseMediaCategoryDefinition(ARCHIVE_CATEGORY_ID, snapshot.data())?.active === true;
}

// Tier accounts follow the staff access ladder: Viewer reads video, and shared
// transcript requests, edits and reviews start with Contributor media management.
// Legacy roles keep video-read transcript access until their accounts move to a tier.
function mayChangeSharedTranscripts(principal, hasCapabilityFn = hasCapability) {
  if (!hasCapabilityFn(principal, "media.video.read")) return false;
  const tierAccount = (principal?.grants ?? []).some((grant) => grant?.tier !== undefined);
  return !tierAccount || hasCapabilityFn(principal, "media.video.manage");
}

async function authorizeMediaSource({
  firestore,
  actor,
  source,
  operation,
  isApprovedActiveAccountFn = isApprovedActiveAccount,
  // A caller checking several archive sources may read the category once and pass the answer.
  archiveCategoryActiveFn = hasActiveArchiveCategory,
  canFn = can,
  hasCapabilityFn = hasCapability,
}) {
  if (!source) {
    throw new MediaSourceAccessError(404, "Media source not found");
  }
  if (!(await isApprovedActiveAccountFn(firestore, actor?.uid))) {
    throw new MediaSourceAccessError(403, "Media source access denied");
  }
  if (!hasCapabilityFn(actor?.principal, "media.video.read")) {
    throw new MediaSourceAccessError(403, "Media source access denied");
  }
  if (operation === "delete") {
    if (source.id !== "video-library" || !source.writable ||
        !canFn(actor?.principal, "media.video.manage", {})) {
      throw new MediaSourceAccessError(403, "Media source delete access denied");
    }
    return true;
  }
  const writesSource = operation === "upload" || operation === "metadata";
  if (writesSource && !source.writable) {
    throw new MediaSourceAccessError(403, "Media source upload access denied");
  }
  if (source.access === "active_staff") {
    const requiredCapability = operation === "upload"
      ? "media.upload"
      : operation === "metadata"
        ? "media.video.manage"
        : null;
    if (requiredCapability && !canFn(actor?.principal, requiredCapability, {})) {
      throw new MediaSourceAccessError(403, "Media source access denied");
    }
    if (operation === "transcript" && !mayChangeSharedTranscripts(actor?.principal, hasCapabilityFn)) {
      throw new MediaSourceAccessError(403, "Media source access denied");
    }
    return true;
  }
  if (source.access !== "archive" || !(await archiveCategoryActiveFn(firestore))) {
    throw new MediaSourceAccessError(403, "Media source access denied");
  }
  // Archive category activation remains a source availability check, not an area.
  const allowed = writesSource
    ? canFn(actor?.principal, operation === "metadata" ? "media.video.manage" : "media.upload", {})
    : canFn(actor?.principal, "media.upload", {}) ||
      canFn(actor?.principal, "media.video.manage", {});
  if (!allowed) {
    throw new MediaSourceAccessError(403, "Media source access denied");
  }
  return true;
}

function mediaSourceSummary(source) {
  return {
    id: source.id,
    label: source.label,
    description: source.description,
    mediaKind: source.mediaKind,
    canBrowse: true,
    canUpload: source.writable,
    canEditMetadata: false,
    canRequestProduction: false,
    canDelete: false,
  };
}

function objectKeyWithinSource(source, key) {
  return typeof key === "string" && key.length > 0 &&
    !key.startsWith("/") && (source.prefix === "" || key.startsWith(source.prefix));
}

module.exports = {
  ARCHIVE_CATEGORY_ID,
  MediaSourceAccessError,
  authorizeMediaSource,
  buildMediaSourceRegistry,
  hasActiveArchiveCategory,
  mayChangeSharedTranscripts,
  mediaSourceSummary,
  objectKeyWithinSource,
  validPrivateSource,
};

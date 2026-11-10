"use strict";

// Deployment-safe CommonJS mirror of the author/staff/profile decision core in
// packages/content-core/src/author-profiles.ts (issue #1044, lane 1). Firebase
// uploads `functions/` as its own CommonJS source bundle and cannot import the
// TypeScript module, so the write path runs a hand-written copy -- the same
// arrangement, for the same reason, as functions/lib/rbac.js.
//
// site/tests/author-profile-parity.test.ts pins every exported constant and
// every decision result in this file to the canonical module. Without it the
// two could fork silently and the deployed boundary would start accepting a
// social URL, a slug, or a snapshot field that the model the rest of the app
// reasons about would refuse.
//
// Partial-edit semantics, mirrored from the canonical module and relied on by
// the store: for `photo`, an OMITTED field (`undefined`) PRESERVES the stored
// photograph and an EXPLICIT `null` CLEARS it. A form need not edit the
// photograph at all, so reading a missing photo field as a removal would wipe
// an author's picture on every bio edit. Keep the three states distinct.
//
// This module reads no database, verifies no token, and generates no randomness.
// The callable boundary in functions/author-profiles.js resolves the trusted
// principal, supplies the clock and the random bytes, and asks this module what
// the resulting document should be.

const AUTHOR_PROFILE_API_VERSION = 1;

const AUTHOR_PROFILE_COLLECTIONS = Object.freeze({
  staffRecords: "cmsStaffRecords",
  workingProfiles: "cmsAuthorProfiles",
  publicProfiles: "cmsAuthorProfilesPublic",
  slugIndex: "cmsAuthorSlugs",
});

const AUTHOR_PUBLIC_ROUTE_BASE = "/authors/";

const AUTHOR_ID_PREFIX = "au_";
const AUTHOR_ID_ENTROPY_CHARS = 32;
const AUTHOR_ID_PATTERN = new RegExp(
  `^${AUTHOR_ID_PREFIX}[0-9a-f]{${AUTHOR_ID_ENTROPY_CHARS}}$`,
);

function isAuthorId(value) {
  return typeof value === "string" && AUTHOR_ID_PATTERN.test(value);
}

function mintAuthorId(randomHex) {
  const normalized = String(randomHex).trim().toLowerCase();
  if (
    !/^[0-9a-f]+$/.test(normalized) ||
    normalized.length < AUTHOR_ID_ENTROPY_CHARS
  ) {
    throw new Error("mintAuthorId requires at least 32 hex characters of entropy");
  }
  return `${AUTHOR_ID_PREFIX}${normalized.slice(0, AUTHOR_ID_ENTROPY_CHARS)}`;
}

const AUTHOR_NAME_MAX = 120;
const AUTHOR_JOB_TITLE_MAX = 120;
const AUTHOR_BIO_MAX = 1000;
const AUTHOR_SLUG_MAX = 80;
const AUTHOR_PHOTO_ASSET_ID_MAX = 128;

// -- profile photographs -----------------------------------------------------
//
// A profile photograph is an ordinary Media Manager asset (#204) that a profile
// points at, under the same content-hash staging, immutable-key, and tombstone
// rules as every other asset. See the canonical module for the full rationale;
// the parity test pins every constant and decision below to it.

const AUTHOR_PHOTO_CATEGORY = "staff-profile";
const AUTHOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const AUTHOR_PHOTO_MIN_DIMENSION = 400;
const AUTHOR_PHOTO_CREDIT_MAX = 300;

const AUTHOR_PHOTO_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

const AUTHOR_PHOTO_RIGHTS_BASES = Object.freeze([
  "own-photo",
  "station-photo",
  "licensed-photo",
]);

const AUTHOR_PHOTO_LICENSE_BY_BASIS = Object.freeze({
  "own-photo": "Profile photo: supplied by the staff member, cleared for use",
  "station-photo": "Profile photo: NJ PBS or Montclair State photograph",
  "licensed-photo": "Profile photo: licensed from a third party, credit required",
});

const AUTHOR_PHOTO_CREDIT_REQUIRED_BASES = Object.freeze(["licensed-photo"]);

const AUTHOR_PUBLIC_PHOTO_FIELDS = Object.freeze([
  "assetId",
  "url",
  "mimeType",
  "width",
  "height",
  "focalX",
  "focalY",
  "credit",
  "thumbnails",
]);

const FOCAL_DECIMALS = 3;

function isAuthorPhotoRightsBasis(value) {
  return typeof value === "string" && AUTHOR_PHOTO_RIGHTS_BASES.includes(value);
}

function authorPhotoCreditRequired(basis) {
  return AUTHOR_PHOTO_CREDIT_REQUIRED_BASES.includes(basis);
}

function normalizeFocal(value) {
  if (value === undefined || value === null) return 0.5;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null;
  const factor = 10 ** FOCAL_DECIMALS;
  return Math.round(numeric * factor) / factor;
}

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
  );
}

// Shape and bounds only. Whether the asset exists, is a still image of the right
// size, and lives in the profile category is decided against the stored record by
// checkAuthorPhotoAsset -- those are facts the client does not own.
function normalizeAuthorPhotoRequest(input) {
  const errors = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["A profile photo must be an object"] };
  }

  let assetId = "";
  const rawAssetId = input.assetId;
  if (typeof rawAssetId !== "string") {
    errors.push("A profile photo requires a Media Manager asset id");
  } else {
    const trimmed = rawAssetId.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > AUTHOR_PHOTO_ASSET_ID_MAX ||
      !/^[A-Za-z0-9_-]+$/.test(trimmed)
    ) {
      errors.push("Photo asset id is not a valid Media Manager asset id");
    } else {
      assetId = trimmed;
    }
  }

  const focalX = normalizeFocal(input.focalX);
  const focalY = normalizeFocal(input.focalY);
  if (focalX === null || focalY === null) {
    errors.push("The photo focal point must be between 0 and 1");
  }

  const rightsBasis = input.rightsBasis;
  if (!isAuthorPhotoRightsBasis(rightsBasis)) {
    errors.push("Confirm how NJ PBS may use this photo");
  }

  let credit = null;
  const rawCredit = input.credit;
  if (rawCredit !== undefined && rawCredit !== null) {
    if (typeof rawCredit !== "string") {
      errors.push("Photo credit must be text");
    } else {
      const value = collapseWhitespace(stripControlCharacters(rawCredit));
      if (value.length > AUTHOR_PHOTO_CREDIT_MAX) {
        errors.push(
          `Photo credit must be at most ${AUTHOR_PHOTO_CREDIT_MAX} characters`,
        );
      } else if (value.length > 0) {
        credit = value;
      }
    }
  }
  if (
    isAuthorPhotoRightsBasis(rightsBasis) &&
    authorPhotoCreditRequired(rightsBasis) &&
    credit === null
  ) {
    errors.push("A licensed photo requires a credit line");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { assetId, focalX, focalY, credit, rightsBasis },
  };
}

// Every failure rather than the first, so an author fixing a photograph is told
// about the type and the size in one answer.
function checkAuthorPhotoAsset(asset, assetId, { requireFrameClassification = true } = {}) {
  if (!asset) return ["That photo is not in the media library"];
  const errors = [];
  if (asset.id !== assetId) {
    errors.push("That photo is not in the media library");
  }
  if (asset.lifecycle !== "active") {
    errors.push("That photo has been removed from the media library");
  }
  if (!AUTHOR_PHOTO_MIME_TYPES.includes(asset.mimeType)) {
    errors.push("A profile photo must be a JPEG, PNG, WebP or AVIF image");
  }
  if (asset.animated === true || (
    requireFrameClassification &&
    ["image/png", "image/webp", "image/avif"].includes(asset.mimeType) &&
    asset.animated !== false
  )) {
    errors.push("A profile photo must be a still image");
  }
  if (
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1 ||
    asset.sizeBytes > AUTHOR_PHOTO_MAX_BYTES
  ) {
    errors.push("A profile photo must be 5 MB or smaller");
  }
  if (
    !Number.isSafeInteger(asset.width) ||
    !Number.isSafeInteger(asset.height) ||
    asset.width < AUTHOR_PHOTO_MIN_DIMENSION ||
    asset.height < AUTHOR_PHOTO_MIN_DIMENSION
  ) {
    errors.push(
      `A profile photo must be at least ${AUTHOR_PHOTO_MIN_DIMENSION} by ${AUTHOR_PHOTO_MIN_DIMENSION} pixels`,
    );
  }
  if (!isHttpsUrl(asset.url)) {
    errors.push("That photo has no usable address");
  }
  return errors;
}

// Bind the rights basis a profile claims to the license the media library
// actually recorded for the file.
//
// The upload writes one of the three attestation strings onto the asset, and that
// string is the rights record: it is what says whether the person supplied the
// photograph, whether the station shot it, or whether it is licensed from a third
// party and therefore needs a credit line. Nothing before this compared the two,
// so a crafted profile update could attach a licensed third-party photograph
// while claiming `own-photo` -- dodging the required credit and writing a false
// rights basis into both the profile and the audit trail.
//
// Separate from checkAuthorPhotoAsset because it is the one photo check that
// needs the request as well as the record; the stored-photo revalidation path has
// no library record to compare against and must not run it.
function checkAuthorPhotoRights(asset, rightsBasis) {
  if (!asset) return [];
  if (!isAuthorPhotoRightsBasis(rightsBasis)) return [];
  if (asset.license === AUTHOR_PHOTO_LICENSE_BY_BASIS[rightsBasis]) return [];
  return [
    "The rights you chose do not match how this photo is recorded in the media library",
  ];
}

// Library thumbnails copied onto a profile. The object key stays in the media
// record. A later response can draw a small portrait without the original.
function admittedAuthorPhotoThumbnails(value) {
  if (!Array.isArray(value)) return [];
  const thumbnails = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !Number.isSafeInteger(item.width) || item.width < 1 ||
      !Number.isSafeInteger(item.height) || item.height < 1 ||
      typeof item.url !== "string"
    ) continue;
    let url;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    thumbnails.push({ url: item.url, width: item.width, height: item.height });
  }
  return thumbnails;
}

// The attestation timestamp survives a crop or credit edit of the same
// photograph under the same basis, and is re-taken whenever the photograph or the
// basis changes -- a new binary or a new claim is a new attestation.
function composeAuthorPhoto({ request, asset, existing = null, nowIso, actor }) {
  const carriedOver =
    existing !== null &&
    existing.assetId === request.assetId &&
    existing.rightsBasis === request.rightsBasis;
  const thumbnails = admittedAuthorPhotoThumbnails(asset.thumbnails);
  return {
    assetId: request.assetId,
    url: asset.url,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    focalX: request.focalX,
    focalY: request.focalY,
    credit: request.credit,
    rightsBasis: request.rightsBasis,
    attestedAt: carriedOver ? existing.attestedAt : nowIso,
    attestedBy: carriedOver ? existing.attestedBy : actor,
    attachedAt:
      existing !== null && existing.assetId === request.assetId
        ? existing.attachedAt
        : nowIso,
    ...(thumbnails.length ? { thumbnails } : {}),
  };
}

// A profile can be revalidated long after it was saved -- on publish, on an admin
// edit -- and a photograph that no longer satisfies the policy must not ride a
// later save onto a public page.
function validateStoredAuthorPhoto(photo) {
  if (photo === null || photo === undefined) return [];
  if (typeof photo !== "object" || Array.isArray(photo)) {
    return ["A profile photo must be an object"];
  }
  const errors = normalizeAuthorPhotoRequest({
    assetId: photo.assetId,
    focalX: photo.focalX,
    focalY: photo.focalY,
    credit: photo.credit,
    rightsBasis: photo.rightsBasis,
  }).errors.slice();
  errors.push(
    ...checkAuthorPhotoAsset(
      {
        id: typeof photo.assetId === "string" ? photo.assetId : "",
        category: AUTHOR_PHOTO_CATEGORY,
        mimeType: typeof photo.mimeType === "string" ? photo.mimeType : "",
        sizeBytes: typeof photo.sizeBytes === "number" ? photo.sizeBytes : 0,
        width: typeof photo.width === "number" ? photo.width : null,
        height: typeof photo.height === "number" ? photo.height : null,
        url: typeof photo.url === "string" ? photo.url : "",
        lifecycle: "active",
        createdBy: null,
        ...(typeof photo.animated === "boolean" ? { animated: photo.animated } : {}),
      },
      typeof photo.assetId === "string" ? photo.assetId : "",
      { requireFrameClassification: false },
    ),
  );
  if (typeof photo.attestedAt !== "string" || photo.attestedAt.length === 0) {
    errors.push("A profile photo requires a recorded attestation");
  }
  return [...new Set(errors)];
}

function toPublicAuthorPhoto(photo) {
  if (photo === null || typeof photo !== "object" || Array.isArray(photo)) {
    return null;
  }
  if (validateStoredAuthorPhoto(photo).length > 0) return null;
  const thumbnails = admittedAuthorPhotoThumbnails(photo.thumbnails);
  return {
    assetId: photo.assetId,
    url: photo.url,
    mimeType: photo.mimeType,
    width: photo.width,
    height: photo.height,
    focalX: photo.focalX,
    focalY: photo.focalY,
    credit: photo.credit ?? null,
    ...(thumbnails.length ? { thumbnails } : {}),
  };
}

const SOCIAL_PLATFORMS = Object.freeze(["x", "bluesky", "linkedin"]);

// Exact HTTPS host and path allowlists. Nothing here is a substring or suffix
// match: the host must equal an allowed host and the path must be exactly the
// platform's profile path. See the canonical module for the full rationale.
const PLATFORM_RULES = Object.freeze({
  x: Object.freeze({
    hosts: Object.freeze(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
    canonicalHost: "x.com",
    pathPrefix: "/",
    reservedPathHandles: Object.freeze(["home", "messages", "settings"]),
    handlePattern: /^[A-Za-z0-9_]{1,15}$/,
    handleMax: 15,
    lowercaseHandle: false,
  }),
  bluesky: Object.freeze({
    hosts: Object.freeze(["bsky.app", "www.bsky.app"]),
    canonicalHost: "bsky.app",
    pathPrefix: "/profile/",
    handlePattern:
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    handleMax: 253,
    lowercaseHandle: true,
  }),
  linkedin: Object.freeze({
    hosts: Object.freeze(["linkedin.com", "www.linkedin.com"]),
    canonicalHost: "www.linkedin.com",
    pathPrefix: "/in/",
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,98}[A-Za-z0-9])$/,
    handleMax: 100,
    lowercaseHandle: true,
  }),
});

function isSocialPlatform(value) {
  return typeof value === "string" && SOCIAL_PLATFORMS.includes(value);
}

function stripLeadingAt(value) {
  return value.startsWith("@") ? value.slice(1) : value;
}

function handleFromUrl(platform, rawUrl) {
  const rule = PLATFORM_RULES[platform];
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.port !== "") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (!rule.hosts.includes(parsed.hostname.toLowerCase())) return null;

  const path =
    parsed.pathname.endsWith("/") && parsed.pathname !== "/"
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
  if (!path.startsWith(rule.pathPrefix)) return null;
  const handle = path.slice(rule.pathPrefix.length);
  if (handle === "" || handle.includes("/")) return null;
  if (rule.reservedPathHandles?.includes(handle.toLowerCase())) return null;
  if (handle.includes("%")) return null;
  return handle;
}

function normalizeSocialLink(platform, input) {
  const rule = PLATFORM_RULES[platform];
  if (!rule) return { ok: false, error: `Unsupported social platform: ${platform}` };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: `${platform} link must be an object` };
  }
  const rawHandle = input.handle;
  const rawUrl = input.url;
  if (typeof rawUrl !== "string") {
    return { ok: false, error: `${platform} link requires a url` };
  }

  const url = rawUrl.trim();
  if (url.length === 0) {
    return { ok: false, error: `${platform} link requires a url` };
  }

  const urlHandle = handleFromUrl(platform, url);
  if (urlHandle === null) {
    return {
      ok: false,
      error: `${platform} url must be an https ${platform} profile url`,
    };
  }

  if (rawHandle !== undefined && typeof rawHandle !== "string") {
    return { ok: false, error: `${platform} handle must be text when supplied` };
  }
  const handle =
    rawHandle === undefined ? urlHandle : stripLeadingAt(rawHandle.trim());
  if (handle.length === 0) {
    return { ok: false, error: `${platform} handle must not be empty when supplied` };
  }
  if (handle.length > rule.handleMax) {
    return {
      ok: false,
      error: `${platform} handle must be at most ${rule.handleMax} characters`,
    };
  }

  const comparableHandle = rule.lowercaseHandle ? handle.toLowerCase() : handle;
  if (!rule.handlePattern.test(comparableHandle)) {
    return {
      ok: false,
      error: `${platform} handle is not a valid ${platform} handle`,
    };
  }

  if (urlHandle.toLowerCase() !== comparableHandle.toLowerCase()) {
    return {
      ok: false,
      error: `${platform} handle and url must name the same profile`,
    };
  }

  return {
    ok: true,
    value: {
      handle: comparableHandle,
      url: `https://${rule.canonicalHost}${rule.pathPrefix}${comparableHandle}`,
    },
  };
}

function slugifyAuthorName(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AUTHOR_SLUG_MAX)
    .replace(/-+$/g, "");
}

const RESERVED_AUTHOR_SLUGS = Object.freeze([
  "index",
  "new",
  "edit",
  "admin",
  "api",
  "staff",
  "authors",
  "author",
  "me",
  "search",
  "rss",
  "feed",
]);

const AUTHOR_SLUG_FALLBACK_ROOT = "njpbs-author";

// -- author-page controls -----------------------------------------------------

const AUTHOR_HIDDEN_POSTS_MAX = 50;
const POST_REFERENCE_MAX = 128;

function isPostReference(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= POST_REFERENCE_MAX &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

function isValidAuthorSlug(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AUTHOR_SLUG_MAX &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    !RESERVED_AUTHOR_SLUGS.includes(value)
  );
}

function resolveAuthorSlug(base, taken, fallback) {
  const seed = isValidAuthorSlug(base) ? base : slugifyAuthorName(fallback);
  const root = isValidAuthorSlug(seed) ? seed : AUTHOR_SLUG_FALLBACK_ROOT;
  if (!taken.has(root) && isValidAuthorSlug(root)) return root;
  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${root
      .slice(0, AUTHOR_SLUG_MAX - tail.length)
      .replace(/-+$/g, "")}${tail}`;
    if (!taken.has(candidate) && isValidAuthorSlug(candidate)) return candidate;
  }
  throw new Error("No available author slug for this name");
}

const AUTHOR_PUBLIC_SNAPSHOT_FIELDS = Object.freeze([
  "authorId",
  "slug",
  "previousSlugs",
  "displayName",
  "jobTitle",
  "bio",
  "photo",
  "links",
  "pinnedPostId",
  "hiddenPostIds",
  "publishedAt",
  "snapshotVersion",
]);

// Documentation and test fixture only. toPublicAuthorSnapshot does not consult
// this list: a denylist the builder depended on would fail open for the next
// private field nobody remembered to add.
const AUTHOR_PRIVATE_FIELDS = Object.freeze([
  "uid",
  "lifecycle",
  "archivedAt",
  "archivedBy",
  "email",
  "role",
  "grants",
  "status",
  "visibility",
  "createdBy",
  "updatedBy",
  "withdrawnBy",
  "withdrawnReason",
  "publishedBy",
  "tokensValidAfter",
]);

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripControlCharacters(value, { allowNewlines = false } = {}) {
  // C0 and C1 controls, zero-width and bidi-override characters. Newlines are
  // spared only in the bio, the one multi-line field. Matching control
  // characters is the point here, so no-control-regex is disabled deliberately:
  // a bidi override in a display name would let one byline visually impersonate
  // another.
  /* eslint-disable no-control-regex */
  const pattern = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g
    : /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  /* eslint-enable no-control-regex */
  return value.replace(pattern, "");
}

function normalizeBio(value) {
  return stripControlCharacters(value, { allowNewlines: true })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function validateAuthorProfileDraft(input) {
  const errors = [];
  const source = input && typeof input === "object" ? input : {};

  const rawName = source.displayName;
  let displayName = "";
  if (typeof rawName !== "string") {
    errors.push("A public display name is required");
  } else {
    displayName = collapseWhitespace(stripControlCharacters(rawName));
    if (displayName.length === 0) {
      errors.push("A public display name is required");
    } else if (displayName.length > AUTHOR_NAME_MAX) {
      errors.push(`Display name must be at most ${AUTHOR_NAME_MAX} characters`);
    }
  }

  let jobTitle = null;
  if (source.jobTitle !== undefined && source.jobTitle !== null) {
    if (typeof source.jobTitle !== "string") {
      errors.push("Job title must be text");
    } else {
      const value = collapseWhitespace(stripControlCharacters(source.jobTitle));
      if (value.length > AUTHOR_JOB_TITLE_MAX) {
        errors.push(
          `Job title must be at most ${AUTHOR_JOB_TITLE_MAX} characters`,
        );
      } else if (value.length > 0) {
        jobTitle = value;
      }
    }
  }

  let bio = null;
  if (source.bio !== undefined && source.bio !== null) {
    if (typeof source.bio !== "string") {
      errors.push("Bio must be text");
    } else {
      const value = normalizeBio(source.bio);
      if (value.length > AUTHOR_BIO_MAX) {
        errors.push(`Bio must be at most ${AUTHOR_BIO_MAX} characters`);
      } else if (value.length > 0) {
        bio = value;
      }
    }
  }

  // Omitted preserves, null clears. A submission that says nothing about the
  // photograph must not be read as "the author removed their photo". A present
  // photograph arrives already resolved against the media library, so this is a
  // re-check of the stored shape rather than the attachment gate.
  let photo;
  if (source.photo === undefined) {
    photo = undefined;
  } else if (source.photo === null) {
    photo = null;
  } else {
    const photoErrors = validateStoredAuthorPhoto(source.photo);
    if (photoErrors.length > 0) {
      errors.push(...photoErrors);
    } else {
      photo = source.photo;
    }
  }

  const links = {};
  const rawLinks = source.links;
  if (rawLinks !== undefined && rawLinks !== null) {
    if (typeof rawLinks !== "object" || Array.isArray(rawLinks)) {
      errors.push("Social links must be an object");
    } else {
      for (const key of Object.keys(rawLinks)) {
        if (!isSocialPlatform(key)) {
          errors.push(`Unsupported social platform: ${key}`);
        }
      }
      for (const platform of SOCIAL_PLATFORMS) {
        const entry = rawLinks[platform];
        if (entry === undefined || entry === null) continue;
        const result = normalizeSocialLink(platform, entry);
        if (!result.ok || !result.value) {
          errors.push(result.error ?? `${platform} link is invalid`);
          continue;
        }
        links[platform] = result.value;
      }
    }
  }

  // Author-page controls. Both follow the photograph's omitted-preserves rule,
  // and both are bounded here rather than trusted from the client.
  let pinnedPostId;
  if (source.pinnedPostId === undefined) {
    pinnedPostId = undefined;
  } else if (source.pinnedPostId === null || source.pinnedPostId === "") {
    pinnedPostId = null;
  } else if (!isPostReference(source.pinnedPostId)) {
    errors.push("A pinned post must be named by a valid post id");
  } else {
    pinnedPostId = source.pinnedPostId;
  }

  let hiddenPostIds;
  if (source.hiddenPostIds === undefined) {
    hiddenPostIds = undefined;
  } else if (source.hiddenPostIds === null) {
    hiddenPostIds = [];
  } else if (!Array.isArray(source.hiddenPostIds)) {
    errors.push("Hidden posts must be a list");
  } else if (source.hiddenPostIds.length > AUTHOR_HIDDEN_POSTS_MAX) {
    errors.push(
      `At most ${AUTHOR_HIDDEN_POSTS_MAX} posts can be hidden from an author page`,
    );
  } else if (source.hiddenPostIds.some((entry) => !isPostReference(entry))) {
    errors.push("Each hidden post must be named by a valid post id");
  } else {
    hiddenPostIds = [...new Set(source.hiddenPostIds)];
  }

  if (
    typeof pinnedPostId === "string" &&
    Array.isArray(hiddenPostIds) &&
    hiddenPostIds.includes(pinnedPostId)
  ) {
    errors.push("A pinned post cannot also be hidden from the author page");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { displayName, jobTitle, bio, photo, links, pinnedPostId, hiddenPostIds },
  };
}

function newAuthorWorkingProfile(seed) {
  return {
    authorId: seed.authorId,
    uid: seed.uid,
    lifecycle: "active",
    archivedAt: null,
    archivedBy: null,
    displayName: seed.displayName,
    jobTitle: null,
    bio: null,
    photo: null,
    links: {},
    pinnedPostId: null,
    hiddenPostIds: [],
    visibility: "private",
    slug: null,
    previousSlugs: [],
    publishedAt: null,
    publishedBy: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: 1,
    createdAt: seed.nowIso,
    createdBy: seed.actor,
    updatedAt: seed.nowIso,
    updatedBy: seed.actor,
  };
}

/**
 * Apply a validated draft. An omitted photo (`undefined`) keeps the stored one;
 * only an explicit `null` removes it.
 */
function applyAuthorProfileEdit(profile, fields, { nowIso, actor }) {
  const pinnedPostId =
    fields.pinnedPostId === undefined
      ? (profile.pinnedPostId ?? null)
      : fields.pinnedPostId;
  const carried = fields.hiddenPostIds ?? profile.hiddenPostIds ?? [];
  // Pinning is an explicit "show this at the top", so it wins over a hide
  // recorded earlier; otherwise the pin would render nothing.
  const hiddenPostIds = carried.filter((entry) => entry !== pinnedPostId);
  return {
    ...profile,
    displayName: fields.displayName,
    jobTitle: fields.jobTitle,
    bio: fields.bio,
    photo: fields.photo === undefined ? profile.photo : fields.photo,
    links: fields.links,
    pinnedPostId,
    hiddenPostIds,
    version: profile.version + 1,
    updatedAt: nowIso,
    updatedBy: actor,
  };
}

function checkAuthorProfilePublishReadiness(profile, staffStatus) {
  const errors = [];
  if (profile.lifecycle === "archived") {
    errors.push("An archived author profile cannot be published");
  }
  if (profile.uid !== null && staffStatus !== "active") {
    errors.push("An inactive staff account cannot publish a public profile");
  }
  const validation = validateAuthorProfileDraft({
    displayName: profile.displayName,
    jobTitle: profile.jobTitle,
    bio: profile.bio,
    photo: profile.photo,
    links: profile.links,
    pinnedPostId: profile.pinnedPostId,
    hiddenPostIds: profile.hiddenPostIds,
  });
  if (!validation.ok) errors.push(...validation.errors);
  return { ok: errors.length === 0, errors };
}

function publishAuthorProfile(profile, { slug, nowIso, actor }) {
  if (!isValidAuthorSlug(slug)) {
    throw new Error("publishAuthorProfile requires a valid slug");
  }
  if (profile.slug !== null && profile.slug !== slug) {
    throw new Error("An existing author slug can only be changed by an admin rename");
  }
  return {
    ...profile,
    visibility: "published",
    slug,
    publishedAt: nowIso,
    publishedBy: actor,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: profile.version + 1,
    updatedAt: nowIso,
    updatedBy: actor,
  };
}

function withdrawAuthorProfile(profile, { nowIso, actor, reason }) {
  return {
    ...profile,
    visibility: "private",
    publishedAt: null,
    publishedBy: null,
    withdrawnAt: nowIso,
    withdrawnBy: actor,
    withdrawnReason: reason,
    version: profile.version + 1,
    updatedAt: nowIso,
    updatedBy: actor,
  };
}

function renameAuthorSlug(profile, { slug, nowIso, actor }) {
  if (!isValidAuthorSlug(slug)) {
    throw new Error("renameAuthorSlug requires a valid slug");
  }
  if (profile.slug === null) {
    throw new Error("An unpublished profile has no slug to rename");
  }
  if (profile.slug === slug) return profile;
  // Uncapped by contract. `cmsAuthorSlugs` reserves every slug an author has
  // ever held so none is reissued, and the profile plus its public snapshot
  // carry the same complete list, so every retired URL keeps redirecting. A cap
  // here would drop the oldest slug from the redirect set while leaving it
  // permanently reserved -- an author URL that neither resolves nor can be
  // reused. Renames are rare and a slug is at most 80 characters.
  const retained = [
    profile.slug,
    ...profile.previousSlugs.filter(
      (entry) => entry !== profile.slug && entry !== slug,
    ),
  ];
  return {
    ...profile,
    slug,
    previousSlugs: retained,
    version: profile.version + 1,
    updatedAt: nowIso,
    updatedBy: actor,
  };
}

function publicLinks(links) {
  const out = {};
  if (links === null || typeof links !== "object" || Array.isArray(links)) {
    return out;
  }
  for (const platform of SOCIAL_PLATFORMS) {
    const result = normalizeSocialLink(platform, links[platform]);
    if (result.ok && result.value) {
      out[platform] = { handle: result.value.handle, url: result.value.url };
    }
  }
  return out;
}

// The ONLY function that may write to cmsAuthorProfilesPublic. It constructs its
// result field by field from a fixed list; there is no spread of the working
// profile anywhere in it, so email, uid, CMS role, grants, and every future
// private field are excluded by construction rather than by deletion.
function toPublicAuthorSnapshot(profile) {
  if (!isAuthorId(profile.authorId)) {
    throw new Error("A public author snapshot requires a minted authorId");
  }
  if (!isValidAuthorSlug(profile.slug)) {
    throw new Error("A public author snapshot requires a minted slug");
  }
  const displayName = collapseWhitespace(
    stripControlCharacters(String(profile.displayName ?? "")),
  );
  if (displayName.length === 0 || displayName.length > AUTHOR_NAME_MAX) {
    throw new Error("A public author snapshot requires a bounded display name");
  }

  const jobTitle =
    typeof profile.jobTitle === "string" && profile.jobTitle.trim().length > 0
      ? collapseWhitespace(stripControlCharacters(profile.jobTitle)).slice(
          0,
          AUTHOR_JOB_TITLE_MAX,
        )
      : null;
  const bio =
    typeof profile.bio === "string" && profile.bio.trim().length > 0
      ? normalizeBio(profile.bio).slice(0, AUTHOR_BIO_MAX)
      : null;
  const photo = toPublicAuthorPhoto(profile.photo);
  const previousSlugs = (
    Array.isArray(profile.previousSlugs) ? profile.previousSlugs : []
  )
    .filter((entry) => isValidAuthorSlug(entry));

  return {
    authorId: profile.authorId,
    slug: profile.slug,
    previousSlugs,
    displayName,
    jobTitle,
    bio,
    photo,
    links: publicLinks(profile.links),
    pinnedPostId: isPostReference(profile.pinnedPostId) ? profile.pinnedPostId : null,
    hiddenPostIds: [
      ...new Set(
        (Array.isArray(profile.hiddenPostIds) ? profile.hiddenPostIds : []).filter(
          (entry) => isPostReference(entry) && entry !== profile.pinnedPostId,
        ),
      ),
    ].slice(0, AUTHOR_HIDDEN_POSTS_MAX),
    publishedAt:
      typeof profile.publishedAt === "string" ? profile.publishedAt : null,
    snapshotVersion:
      Number.isSafeInteger(profile.version) && profile.version > 0
        ? profile.version
        : 1,
  };
}

function authorPublicPath(slug) {
  if (!isValidAuthorSlug(slug)) {
    throw new Error("authorPublicPath requires a valid slug");
  }
  return `${AUTHOR_PUBLIC_ROUTE_BASE}${slug}/`;
}

module.exports = {
  AUTHOR_BIO_MAX,
  AUTHOR_HIDDEN_POSTS_MAX,
  AUTHOR_ID_PREFIX,
  AUTHOR_JOB_TITLE_MAX,
  AUTHOR_NAME_MAX,
  AUTHOR_PHOTO_ASSET_ID_MAX,
  AUTHOR_PHOTO_CATEGORY,
  AUTHOR_PHOTO_CREDIT_MAX,
  AUTHOR_PHOTO_CREDIT_REQUIRED_BASES,
  AUTHOR_PHOTO_LICENSE_BY_BASIS,
  AUTHOR_PHOTO_MAX_BYTES,
  AUTHOR_PHOTO_MIME_TYPES,
  AUTHOR_PHOTO_MIN_DIMENSION,
  AUTHOR_PHOTO_RIGHTS_BASES,
  AUTHOR_PRIVATE_FIELDS,
  AUTHOR_PROFILE_API_VERSION,
  AUTHOR_PROFILE_COLLECTIONS,
  AUTHOR_PUBLIC_PHOTO_FIELDS,
  AUTHOR_PUBLIC_ROUTE_BASE,
  AUTHOR_PUBLIC_SNAPSHOT_FIELDS,
  AUTHOR_SLUG_FALLBACK_ROOT,
  AUTHOR_SLUG_MAX,
  POST_REFERENCE_MAX,
  RESERVED_AUTHOR_SLUGS,
  SOCIAL_PLATFORMS,
  applyAuthorProfileEdit,
  authorPhotoCreditRequired,
  authorPublicPath,
  checkAuthorPhotoAsset,
  checkAuthorPhotoRights,
  checkAuthorProfilePublishReadiness,
  composeAuthorPhoto,
  isAuthorId,
  isAuthorPhotoRightsBasis,
  isPostReference,
  isSocialPlatform,
  isValidAuthorSlug,
  mintAuthorId,
  newAuthorWorkingProfile,
  normalizeAuthorPhotoRequest,
  normalizeSocialLink,
  publishAuthorProfile,
  renameAuthorSlug,
  resolveAuthorSlug,
  slugifyAuthorName,
  toPublicAuthorPhoto,
  toPublicAuthorSnapshot,
  validateAuthorProfileDraft,
  validateStoredAuthorPhoto,
  withdrawAuthorProfile,
};


// Author/staff/profile data foundation for the NJ PBS newsroom CMS (issue #1044,
// lane 1). This module is the pure decision core: it reads no database, verifies
// no token, and mints no randomness of its own. The Cloud Functions boundary in
// functions/author-profiles.js resolves a trusted principal, supplies the clock
// and the random bytes, and asks this module what the resulting document should
// look like.
//
// Four identities stay separate, and this file only ever describes the last two:
//
//   1. Firebase Auth identity      -- sign-in and verified email.
//   2. `users/{uid}`               -- CMS access, role, grants, preferences.
//   3. `cmsStaffRecords/{uid}`     -- private account-to-author linkage spine.
//   4. `cmsAuthorProfiles/{authorId}` -- the private working author profile,
//      with a detached public snapshot in `cmsAuthorProfilesPublic/{authorId}`.
//
// The staff record in (3) is deliberately NOT `StaffRecord` from content-model.ts.
// That type is an editorial CONTENT record -- a public "our team" listing an
// editor writes and publishes like any other page. This one is an account
// artifact: it exists to bind a Firebase uid to a stable `authorId` and to carry
// staff status. Repurposing the content record would put account linkage inside
// publishable editorial content, which is exactly the mixing the four-identity
// split exists to prevent.
//
// The single rule the redaction half of this file enforces: a public snapshot is
// BUILT, never filtered. Every public field is copied by name into a fresh
// object, so a field added to the working profile later -- an email, a role, an
// internal note -- cannot reach the public surface by being forgotten in a
// denylist. See `toPublicAuthorSnapshot`.
//
// Partial-edit semantics, which every caller of `validateAuthorProfileDraft`
// and `applyAuthorProfileEdit` depends on: for `photo`, an OMITTED field
// (`undefined`) PRESERVES the stored photograph, and an EXPLICIT `null` CLEARS
// it. The text fields are not partial in that way -- a draft always carries the
// name, job title, bio and links it wants stored. The photograph is different
// because a form need not edit it at all: treating a missing photo field as
// "remove the photo" would delete an author's picture every time they fixed a
// typo in their bio. Keep the three states distinct.
//
// Ratified decisions this schema encodes (issue #1044, 2026-08-21 decision
// record): required public name; optional job title, bounded bio, photo, and
// social links; never public email or CMS role; server-created stable slug at
// first publication with later changes admin-only and preserved through
// previousSlugs redirects; owner Publish/Unpublish after automated validation
// with admin/super-admin override and no human approval queue.

/** Response envelope version for every author-profile callable. */
export const AUTHOR_PROFILE_API_VERSION = 1;

/** Firestore collections this foundation owns. All are default-deny (server-only). */
export const AUTHOR_PROFILE_COLLECTIONS = {
  /** Private account-linkage spine, keyed by Firebase uid. */
  staffRecords: "cmsStaffRecords",
  /** Private working author profile, keyed by the server-minted authorId. */
  workingProfiles: "cmsAuthorProfiles",
  /** Detached public snapshot, keyed by authorId. Published profiles only. */
  publicProfiles: "cmsAuthorProfilesPublic",
  /** Slug reservation and redirect index, keyed by slug. */
  slugIndex: "cmsAuthorSlugs",
} as const;

/** Public route base for author pages, per the ratified route decision. */
export const AUTHOR_PUBLIC_ROUTE_BASE = "/authors/";

// -- identity ---------------------------------------------------------------

/**
 * `authorId` is an opaque, server-minted, permanently stable join key. It is
 * never a uid and never a slug: a uid would leak the account identity into
 * published byline snapshots, and a slug changes. Post bylines join on this
 * value, so it must outlive both a rename and a deactivation.
 */
export const AUTHOR_ID_PREFIX = "au_";
const AUTHOR_ID_ENTROPY_CHARS = 32;
const AUTHOR_ID_PATTERN = new RegExp(
  `^${AUTHOR_ID_PREFIX}[0-9a-f]{${AUTHOR_ID_ENTROPY_CHARS}}$`,
);

export function isAuthorId(value: unknown): value is string {
  return typeof value === "string" && AUTHOR_ID_PATTERN.test(value);
}

/**
 * Build an authorId from caller-supplied random hex. The randomness is the
 * caller's (node:crypto at the boundary) so this module stays pure and the
 * format stays asserted in one place.
 */
export function mintAuthorId(randomHex: string): string {
  const normalized = String(randomHex).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length < AUTHOR_ID_ENTROPY_CHARS) {
    throw new Error("mintAuthorId requires at least 32 hex characters of entropy");
  }
  return `${AUTHOR_ID_PREFIX}${normalized.slice(0, AUTHOR_ID_ENTROPY_CHARS)}`;
}

// -- bounded public fields ---------------------------------------------------

export const AUTHOR_NAME_MAX = 120;
export const AUTHOR_JOB_TITLE_MAX = 120;
export const AUTHOR_BIO_MAX = 1000;
export const AUTHOR_SLUG_MAX = 80;
export const AUTHOR_PHOTO_ASSET_ID_MAX = 128;

// -- profile photographs -----------------------------------------------------
//
// A profile photograph is an ordinary Media Manager asset (#204) that a profile
// points at. It is never a second, private store of images: the binary lives in
// R2 under the same content-hash staging, immutable-key, and tombstone rules as
// every other asset, and this module only describes the reference and the crop.
//
// The ratified policy (issue #1044, 2026-08-21 decision record) is encoded here:
// a required rights-basis attestation at upload, credit required only when the
// basis is a licensed third-party photograph, a narrow still-image type set, a
// 5 MiB ceiling, at least 400x400 pixels, a 1:1 focal crop, automated validation
// only with no human review queue, and removal that withdraws use while the
// original binary survives behind the tombstone fence.

/**
 * The one Media Manager category a profile photograph may live in. It is also
 * the only category the scoped self-service upload path may write to, so a
 * contributor who can set their own photograph gains no other DAM access.
 */
export const AUTHOR_PHOTO_CATEGORY = "staff-profile";

/** 5 MiB, per the ratified policy. Well under the 25 MiB general media cap. */
export const AUTHOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Both edges must reach this, so a 1:1 crop never upscales past the source. */
export const AUTHOR_PHOTO_MIN_DIMENSION = 400;

export const AUTHOR_PHOTO_CREDIT_MAX = 300;

/**
 * Still-image types only. GIF and PDF are absent deliberately: an animated
 * avatar is not a portrait, and a document is not an image.
 */
export const AUTHOR_PHOTO_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

/**
 * What the person attaching the photograph asserts about the right to publish
 * it. One of these is required -- there is no "unspecified" -- because the
 * attestation is the rights record for a photograph of a real person.
 */
export const AUTHOR_PHOTO_RIGHTS_BASES = [
  "own-photo",
  "station-photo",
  "licensed-photo",
] as const;

export type AuthorPhotoRightsBasis = (typeof AUTHOR_PHOTO_RIGHTS_BASES)[number];

/**
 * The license text written onto the Media Manager asset for each basis. The DAM
 * requires a license on every upload; for a profile photograph that license IS
 * the attestation, so the two cannot disagree and no separate rights field has
 * to be kept in step.
 */
export const AUTHOR_PHOTO_LICENSE_BY_BASIS: Record<AuthorPhotoRightsBasis, string> = {
  "own-photo": "Profile photo: supplied by the staff member, cleared for use",
  "station-photo": "Profile photo: NJ PBS or Montclair State photograph",
  "licensed-photo": "Profile photo: licensed from a third party, credit required",
};

/** Bases that cannot be published without a credit line. */
export const AUTHOR_PHOTO_CREDIT_REQUIRED_BASES: readonly AuthorPhotoRightsBasis[] = [
  "licensed-photo",
];

export function isAuthorPhotoRightsBasis(
  value: unknown,
): value is AuthorPhotoRightsBasis {
  return (
    typeof value === "string" &&
    (AUTHOR_PHOTO_RIGHTS_BASES as readonly string[]).includes(value)
  );
}

export function authorPhotoCreditRequired(basis: AuthorPhotoRightsBasis): boolean {
  return AUTHOR_PHOTO_CREDIT_REQUIRED_BASES.includes(basis);
}

/** What the client may say about a photograph. Everything else is server-derived. */
export interface AuthorPhotoRequest {
  assetId: string;
  /** Focal point of the 1:1 crop, in normalized image coordinates. */
  focalX: number;
  focalY: number;
  credit: string | null;
  rightsBasis: AuthorPhotoRightsBasis;
}

/**
 * The Media Manager facts a photograph is checked against. The storage boundary
 * reads these from `media_assets/{assetId}`; nothing in this shape is ever taken
 * from the request, because a client that could state its own dimensions could
 * state its way past the minimum.
 */
export interface AuthorPhotoAssetFacts {
  id: string;
  category: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  lifecycle: string;
  createdBy: string | null;
  /** True when the stored file has more than one frame. */
  animated?: boolean;
  /** The rights attestation the upload recorded, checked against the basis. */
  license?: string | null;
  /** Generated renditions. The object key never belongs on a profile. */
  thumbnails?: unknown;
}

/**
 * The stored photograph on a working profile. It carries the rendering facts
 * (url, dimensions, type) alongside the reference so the public snapshot can be
 * built without joining the media library, which is the same detachment rule the
 * rest of the snapshot follows.
 */
export interface AuthorPhoto {
  assetId: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  focalX: number;
  focalY: number;
  credit: string | null;
  rightsBasis: AuthorPhotoRightsBasis;
  attestedAt: string;
  attestedBy: string;
  attachedAt: string;
  thumbnails?: readonly AuthorPhotoThumbnail[];
}

export interface AuthorPhotoThumbnail {
  url: string;
  width: number;
  height: number;
}

/** The public half of a photograph: enough to render the crop, and no more. */
export interface AuthorPublicPhoto {
  assetId: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  focalX: number;
  focalY: number;
  credit: string | null;
  thumbnails?: readonly AuthorPhotoThumbnail[];
}

/** The exact public photo field list, asserted by the redaction test. */
export const AUTHOR_PUBLIC_PHOTO_FIELDS: readonly string[] = [
  "assetId",
  "url",
  "mimeType",
  "width",
  "height",
  "focalX",
  "focalY",
  "credit",
  "thumbnails",
];

const FOCAL_DECIMALS = 3;

/** Clamp and round one focal coordinate. Absent means centered, not invalid. */
function normalizeFocal(value: unknown): number | null {
  if (value === undefined || value === null) return 0.5;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null;
  const factor = 10 ** FOCAL_DECIMALS;
  return Math.round(numeric * factor) / factor;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
  );
}

export interface AuthorPhotoRequestValidation {
  ok: boolean;
  value?: AuthorPhotoRequest;
  errors: string[];
}

/**
 * Validate the client half of a photograph attachment. This checks shape and
 * bounds only: whether the asset exists, is a still image of the right size, and
 * lives in the profile category is decided against the stored record by
 * `checkAuthorPhotoAsset`, because those are facts the client does not own.
 */
export function normalizeAuthorPhotoRequest(
  input: unknown,
): AuthorPhotoRequestValidation {
  const errors: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["A profile photo must be an object"] };
  }
  const source = input as Record<string, unknown>;

  let assetId = "";
  const rawAssetId = source.assetId;
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

  const focalX = normalizeFocal(source.focalX);
  const focalY = normalizeFocal(source.focalY);
  if (focalX === null || focalY === null) {
    errors.push("The photo focal point must be between 0 and 1");
  }

  const rightsBasis = source.rightsBasis;
  if (!isAuthorPhotoRightsBasis(rightsBasis)) {
    errors.push("Confirm how NJ PBS may use this photo");
  }

  let credit: string | null = null;
  const rawCredit = source.credit;
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
    value: {
      assetId,
      focalX: focalX as number,
      focalY: focalY as number,
      credit,
      rightsBasis: rightsBasis as AuthorPhotoRightsBasis,
    },
  };
}

/**
 * Check a stored Media Manager record against the ratified photo policy. Returns
 * every failure rather than the first, so an author fixing a photograph is told
 * about the type and the size in one answer.
 */
export function checkAuthorPhotoAsset(
  asset: AuthorPhotoAssetFacts | null | undefined,
  assetId: string,
  { requireFrameClassification = true }: { requireFrameClassification?: boolean } = {},
): string[] {
  if (!asset) return ["That photo is not in the media library"];
  const errors: string[] = [];
  if (asset.id !== assetId) {
    errors.push("That photo is not in the media library");
  }
  if (asset.lifecycle !== "active") {
    errors.push("That photo has been removed from the media library");
  }
  if (!(AUTHOR_PHOTO_MIME_TYPES as readonly string[]).includes(asset.mimeType)) {
    errors.push("A profile photo must be a JPEG, PNG, WebP or AVIF image");
  }
  if (asset.animated === true || (
    requireFrameClassification &&
    (["image/png", "image/webp", "image/avif"] as readonly string[]).includes(asset.mimeType) &&
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
    (asset.width as number) < AUTHOR_PHOTO_MIN_DIMENSION ||
    (asset.height as number) < AUTHOR_PHOTO_MIN_DIMENSION
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

/**
 * Bind the rights basis a profile claims to the license the media library
 * actually recorded for the file.
 *
 * The upload writes one of the three attestation strings onto the asset, and
 * that string is the rights record: it is what says whether the person supplied
 * the photograph, whether the station shot it, or whether it is licensed from a
 * third party and therefore needs a credit line. Nothing before this compared
 * the two, so a crafted profile update could attach a licensed third-party
 * photograph while claiming `own-photo` -- dodging the required credit and
 * writing a false rights basis into both the profile and the audit trail.
 *
 * Separate from `checkAuthorPhotoAsset` because it is the one photo check that
 * needs the request as well as the record; the stored-photo revalidation path
 * has no library record to compare against and must not run it.
 */
export function checkAuthorPhotoRights(
  asset: AuthorPhotoAssetFacts | null | undefined,
  rightsBasis: string,
): string[] {
  if (!asset) return [];
  if (!isAuthorPhotoRightsBasis(rightsBasis)) return [];
  const expected = AUTHOR_PHOTO_LICENSE_BY_BASIS[rightsBasis];
  if (asset.license === expected) return [];
  return [
    "The rights you chose do not match how this photo is recorded in the media library",
  ];
}

function admittedAuthorPhotoThumbnails(value: unknown): AuthorPhotoThumbnail[] {
  if (!Array.isArray(value)) return [];
  const thumbnails: AuthorPhotoThumbnail[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const thumbnail = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(thumbnail.width) ||
      Number(thumbnail.width) < 1 ||
      !Number.isSafeInteger(thumbnail.height) ||
      Number(thumbnail.height) < 1 ||
      typeof thumbnail.url !== "string"
    ) continue;
    let url: URL;
    try {
      url = new URL(thumbnail.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
    thumbnails.push({
      url: thumbnail.url,
      width: thumbnail.width as number,
      height: thumbnail.height as number,
    });
  }
  return thumbnails;
}

/**
 * Build the stored photograph from a validated request and the asset's own
 * facts. The attestation timestamp survives a crop or credit edit of the same
 * photograph under the same basis, and is re-taken whenever the photograph or
 * the basis changes -- a new binary or a new claim is a new attestation.
 */
export function composeAuthorPhoto({
  request,
  asset,
  existing = null,
  nowIso,
  actor,
}: {
  request: AuthorPhotoRequest;
  asset: AuthorPhotoAssetFacts;
  existing?: AuthorPhoto | null;
  nowIso: string;
  actor: string;
}): AuthorPhoto {
  const carriedOver =
    existing !== null &&
    existing.assetId === request.assetId &&
    existing.rightsBasis === request.rightsBasis;
  const thumbnails = admittedAuthorPhotoThumbnails(asset.thumbnails);
  return {
    assetId: request.assetId,
    url: asset.url,
    mimeType: asset.mimeType,
    width: asset.width as number,
    height: asset.height as number,
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

/**
 * Re-check an already-stored photograph. A profile can be revalidated long after
 * it was saved -- on publish, on an admin edit -- and a photograph that no longer
 * satisfies the policy must not ride a later save onto a public page.
 */
export function validateStoredAuthorPhoto(photo: unknown): string[] {
  if (photo === null || photo === undefined) return [];
  if (typeof photo !== "object" || Array.isArray(photo)) {
    return ["A profile photo must be an object"];
  }
  const value = photo as Record<string, unknown>;
  const errors = normalizeAuthorPhotoRequest({
    assetId: value.assetId,
    focalX: value.focalX,
    focalY: value.focalY,
    credit: value.credit,
    rightsBasis: value.rightsBasis,
  }).errors.slice();
  errors.push(
    ...checkAuthorPhotoAsset(
      {
        id: typeof value.assetId === "string" ? value.assetId : "",
        category: AUTHOR_PHOTO_CATEGORY,
        mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
        sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
        width: typeof value.width === "number" ? value.width : null,
        height: typeof value.height === "number" ? value.height : null,
        url: typeof value.url === "string" ? value.url : "",
        lifecycle: "active",
        createdBy: null,
        ...(typeof value.animated === "boolean" ? { animated: value.animated } : {}),
      },
      typeof value.assetId === "string" ? value.assetId : "",
      { requireFrameClassification: false },
    ),
  );
  if (typeof value.attestedAt !== "string" || value.attestedAt.length === 0) {
    errors.push("A profile photo requires a recorded attestation");
  }
  return [...new Set(errors)];
}

/** The public half of a stored photograph, built field by field. */
export function toPublicAuthorPhoto(photo: unknown): AuthorPublicPhoto | null {
  if (photo === null || typeof photo !== "object" || Array.isArray(photo)) {
    return null;
  }
  if (validateStoredAuthorPhoto(photo).length > 0) return null;
  const value = photo as unknown as AuthorPhoto;
  const thumbnails = admittedAuthorPhotoThumbnails(value.thumbnails);
  return {
    assetId: value.assetId,
    url: value.url,
    mimeType: value.mimeType,
    width: value.width,
    height: value.height,
    focalX: value.focalX,
    focalY: value.focalY,
    credit: value.credit ?? null,
    ...(thumbnails.length ? { thumbnails } : {}),
  };
}

// -- social links ------------------------------------------------------------

export const SOCIAL_PLATFORMS = ["x", "bluesky", "linkedin"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialLink {
  handle: string;
  url: string;
}

export type AuthorSocialLinks = Partial<Record<SocialPlatform, SocialLink>>;

/**
 * Exact HTTPS host and path allowlists. A profile URL is attacker-supplied text
 * that will become a public outbound link, so nothing here is a substring or
 * suffix match: the host must equal an allowed host, and the path must be
 * exactly the platform's profile path with a handle that matches the platform's
 * own handle grammar. Query strings, fragments, ports, and credentials are all
 * refused rather than stripped -- a URL carrying them is not the URL the author
 * meant to publish.
 */
interface PlatformRule {
  hosts: readonly string[];
  /** Path prefix that must precede the handle, including the leading slash. */
  pathPrefix: string;
  /** Single-segment application routes that are not profile handles. */
  reservedPathHandles?: readonly string[];
  handlePattern: RegExp;
  handleMax: number;
  /** Canonical host used when rebuilding the stored URL. */
  canonicalHost: string;
  /** True when the platform's handles are case-insensitive. */
  lowercaseHandle: boolean;
}

const PLATFORM_RULES: Record<SocialPlatform, PlatformRule> = {
  x: {
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    canonicalHost: "x.com",
    pathPrefix: "/",
    reservedPathHandles: ["home", "messages", "settings"],
    handlePattern: /^[A-Za-z0-9_]{1,15}$/,
    handleMax: 15,
    lowercaseHandle: false,
  },
  bluesky: {
    hosts: ["bsky.app", "www.bsky.app"],
    canonicalHost: "bsky.app",
    pathPrefix: "/profile/",
    // Bluesky handles are domain names: at least one dot, no leading/trailing
    // hyphen in any label.
    handlePattern:
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    handleMax: 253,
    lowercaseHandle: true,
  },
  linkedin: {
    hosts: ["linkedin.com", "www.linkedin.com"],
    canonicalHost: "www.linkedin.com",
    pathPrefix: "/in/",
    handlePattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,98}[A-Za-z0-9])$/,
    handleMax: 100,
    lowercaseHandle: true,
  },
};

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return (
    typeof value === "string" &&
    (SOCIAL_PLATFORMS as readonly string[]).includes(value)
  );
}

function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Parse an author-supplied profile URL against one platform's allowlist and
 * return the handle it addresses. Returns null for anything that is not exactly
 * an HTTPS profile URL on an allowed host.
 */
function handleFromUrl(platform: SocialPlatform, rawUrl: string): string | null {
  const rule = PLATFORM_RULES[platform];
  let parsed: URL;
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

  // One optional trailing slash is tolerated; anything deeper is a different
  // resource (a post, a status, a company page) and is refused.
  const path = parsed.pathname.endsWith("/") && parsed.pathname !== "/"
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  if (!path.startsWith(rule.pathPrefix)) return null;
  const handle = path.slice(rule.pathPrefix.length);
  if (handle === "" || handle.includes("/")) return null;
  if (rule.reservedPathHandles?.includes(handle.toLowerCase())) return null;
  // Percent-encoding is not part of any allowed handle grammar. Refuse it
  // rather than decoding, so `%2f` can never become a path separator.
  if (handle.includes("%")) return null;
  return handle;
}

export interface SocialLinkResult {
  ok: boolean;
  value?: SocialLink;
  error?: string;
}

/**
 * Validate one profile URL and derive the compatibility handle stored with it.
 * Older callers can still supply a handle; when they do, it must name the same
 * profile as the URL.
 */
export function normalizeSocialLink(
  platform: SocialPlatform,
  input: unknown,
): SocialLinkResult {
  const rule = PLATFORM_RULES[platform];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: `${platform} link must be an object` };
  }
  const rawHandle = (input as { handle?: unknown }).handle;
  const rawUrl = (input as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return { ok: false, error: `${platform} link requires a url` };
  }

  const url = rawUrl.trim();
  if (url.length === 0) {
    return { ok: false, error: `${platform} link requires a url` };
  }

  const urlHandle = handleFromUrl(platform, url);
  if (urlHandle === null) {
    return { ok: false, error: `${platform} url must be an https ${platform} profile url` };
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
    return { ok: false, error: `${platform} handle is not a valid ${platform} handle` };
  }

  if (urlHandle.toLowerCase() !== comparableHandle.toLowerCase()) {
    return { ok: false, error: `${platform} handle and url must name the same profile` };
  }

  // Store the rebuilt canonical URL rather than the author's text, so the public
  // snapshot never carries an unreviewed string.
  return {
    ok: true,
    value: {
      handle: comparableHandle,
      url: `https://${rule.canonicalHost}${rule.pathPrefix}${comparableHandle}`,
    },
  };
}

// -- slugs -------------------------------------------------------------------

/**
 * Derive the base slug for a display name. Diacritics are folded, everything
 * outside `a-z0-9` becomes a single hyphen, and the result is bounded. An empty
 * result means the name has no sluggable characters at all, and the caller must
 * fall back rather than mint an empty route.
 */
export function slugifyAuthorName(name: string): string {
  return String(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AUTHOR_SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * Slugs that must never be minted for an author because they would collide with
 * a route or read as an official page.
 */
export const RESERVED_AUTHOR_SLUGS: readonly string[] = [
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
];

export function isValidAuthorSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AUTHOR_SLUG_MAX &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    !RESERVED_AUTHOR_SLUGS.includes(value)
  );
}

/**
 * Last-resort slug root for a display name with no sluggable characters at all
 * (a name written entirely in emoji, or in a script that folds to nothing).
 * Deliberately not "author": that word is reserved, so using it here would make
 * every fallback slug start at "-2".
 */
export const AUTHOR_SLUG_FALLBACK_ROOT = "njpbs-author";

// -- author-page controls ------------------------------------------------------

/**
 * How many posts one author may hide from their own author page.
 *
 * Bounded because the list rides inside the profile document and inside its
 * public snapshot, and an unbounded one would grow both without limit. Fifty is
 * far past any real use: hiding is meant for the handful of items an author does
 * not want fronting their page, not for curating a whole archive by exclusion.
 */
export const AUTHOR_HIDDEN_POSTS_MAX = 50;

/** Upper bound on a stored post reference, matching the media-asset id bound. */
export const POST_REFERENCE_MAX = 128;

/**
 * Whether a value is usable as a reference to a post document.
 *
 * This is a shape check, not an existence check: the profile boundary cannot
 * read cmsPosts, and it does not need to. A pin or a hide that names a post
 * which is not published, or which no longer exists, is simply ignored by the
 * public build. What the pattern does buy is that a stored reference can never
 * carry a slash, a dot segment, or a control character into a Firestore path or
 * a rendered attribute.
 */
export function isPostReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= POST_REFERENCE_MAX &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

/**
 * Pick the first free slug for a base, appending `-2`, `-3`, ... on collision.
 * `taken` is the set of every slug ever claimed -- current AND previous -- so a
 * retired slug is never reissued to a different author and its redirect keeps
 * pointing at one person.
 */
export function resolveAuthorSlug(
  base: string,
  taken: ReadonlySet<string>,
  fallback: string,
): string {
  const seed = isValidAuthorSlug(base) ? base : slugifyAuthorName(fallback);
  const root = isValidAuthorSlug(seed) ? seed : AUTHOR_SLUG_FALLBACK_ROOT;
  if (!taken.has(root) && isValidAuthorSlug(root)) return root;
  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${root.slice(0, AUTHOR_SLUG_MAX - tail.length).replace(/-+$/g, "")}${tail}`;
    if (!taken.has(candidate) && isValidAuthorSlug(candidate)) return candidate;
  }
  throw new Error("No available author slug for this name");
}

// -- documents ---------------------------------------------------------------

export type AuthorProfileVisibility = "private" | "published";
export type AuthorProfileLifecycle = "active" | "archived";
export type StaffRecordStatus = "active" | "inactive";

/** The private working author profile. Only its snapshot is ever public. */
export interface AuthorWorkingProfile {
  authorId: string;
  /** Linked Firebase uid, when this profile has a CMS account. Private. */
  uid: string | null;
  lifecycle: AuthorProfileLifecycle;
  archivedAt: string | null;
  archivedBy: string | null;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  /**
   * The attached profile photograph, or null. The reference and its crop, not
   * the binary: the image itself is an ordinary Media Manager asset.
   */
  photo: AuthorPhoto | null;
  links: AuthorSocialLinks;
  /**
   * One post the author wants at the top of their own author page, or null.
   * A pin is a presentation choice on one page; it changes nothing about the
   * post itself and is invisible everywhere else on the site.
   */
  pinnedPostId: string | null;
  /**
   * Posts this author does not want listed on their own author page.
   *
   * Removal from ONE page, never an unpublish: the post stays public, stays at
   * its own URL, and stays listed on every coauthor's page. That is the whole
   * reason this lives on the profile rather than on the post -- a coauthor
   * cannot reach into someone else's byline, and one author's presentation
   * choice cannot take a published story off the site.
   */
  hiddenPostIds: string[];
  visibility: AuthorProfileVisibility;
  /** Minted at first publication and stable thereafter. */
  slug: string | null;
  previousSlugs: string[];
  publishedAt: string | null;
  publishedBy: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawnReason: WithdrawalReason | null;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * The detached public snapshot. Every field here is public by construction; the
 * type has no optional escape hatch and no index signature, so adding a private
 * field to the working profile cannot widen it.
 */
export interface AuthorPublicSnapshot {
  authorId: string;
  slug: string;
  previousSlugs: string[];
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  photo: AuthorPublicPhoto | null;
  links: AuthorSocialLinks;
  /** The author's pinned post, carried so the static build can front it. */
  pinnedPostId: string | null;
  /** Posts to leave off this author page only. Never an unpublish. */
  hiddenPostIds: string[];
  publishedAt: string | null;
  snapshotVersion: number;
}

/** The exact public field list, asserted by the redaction test. */
export const AUTHOR_PUBLIC_SNAPSHOT_FIELDS: readonly string[] = [
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
];

/**
 * Fields that must never appear in public output, named so the guarantee is
 * testable rather than merely intended. This list is documentation and test
 * fixture only -- `toPublicAuthorSnapshot` does not consult it, because a
 * denylist that the builder depended on would fail open for the next field
 * nobody remembered to add.
 */
export const AUTHOR_PRIVATE_FIELDS: readonly string[] = [
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
];

// -- validation --------------------------------------------------------------

export interface AuthorProfileDraftInput {
  displayName?: unknown;
  jobTitle?: unknown;
  bio?: unknown;
  /** An already-resolved stored photograph, or null. Never a raw request. */
  photo?: unknown;
  links?: unknown;
  pinnedPostId?: unknown;
  hiddenPostIds?: unknown;
}

export interface AuthorProfileDraftFields {
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  /**
   * Three states, not two. `undefined` means the submission said nothing about
   * the photo, so `applyAuthorProfileEdit` keeps whatever is stored; `null` is
   * an explicit "remove the photo"; an object is a photograph already resolved
   * against the media library. See the omitted-preserves note in this module's
   * header.
   */
  photo?: AuthorPhoto | null;
  links: AuthorSocialLinks;
  /**
   * Three states, like the photograph. `undefined` means the submission said
   * nothing about the pin, so the stored one is kept; `null` clears it. The
   * admin roster edits a profile's text without rendering these controls at
   * all, so a whole-state rule here would silently discard an author's pin
   * every time an admin fixed a job title.
   */
  pinnedPostId?: string | null;
  /** Same three states as the pin: omitted preserves, null or [] clears. */
  hiddenPostIds?: string[];
}

export interface AuthorProfileValidation {
  ok: boolean;
  value?: AuthorProfileDraftFields;
  errors: string[];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Strip control characters that would corrupt public rendering or smuggle
 * direction overrides into a byline. Newlines survive only in the bio, which is
 * the one multi-line field.
 */
function stripControlCharacters(value: string, { allowNewlines = false } = {}): string {
  // C0 and C1 controls, zero-width and bidi-override characters. Newlines are
  // spared only in the bio, the one multi-line field. A bidi override in a
  // display name would let one author's byline visually impersonate another.
  const pattern = allowNewlines
    ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g
    : /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
  return value.replace(pattern, "");
}

function normalizeBio(value: string): string {
  return stripControlCharacters(value, { allowNewlines: true })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Validate one author-supplied profile draft. Every rule is automated: the
 * ratified publication authority has no human approval queue, so this function
 * is the entire gate between an author's typing and a public page.
 */
export function validateAuthorProfileDraft(
  input: AuthorProfileDraftInput,
): AuthorProfileValidation {
  const errors: string[] = [];

  const rawName = input.displayName;
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

  let jobTitle: string | null = null;
  if (input.jobTitle !== undefined && input.jobTitle !== null) {
    if (typeof input.jobTitle !== "string") {
      errors.push("Job title must be text");
    } else {
      const value = collapseWhitespace(stripControlCharacters(input.jobTitle));
      if (value.length > AUTHOR_JOB_TITLE_MAX) {
        errors.push(`Job title must be at most ${AUTHOR_JOB_TITLE_MAX} characters`);
      } else if (value.length > 0) {
        jobTitle = value;
      }
    }
  }

  let bio: string | null = null;
  if (input.bio !== undefined && input.bio !== null) {
    if (typeof input.bio !== "string") {
      errors.push("Bio must be text");
    } else {
      const value = normalizeBio(input.bio);
      if (value.length > AUTHOR_BIO_MAX) {
        errors.push(`Bio must be at most ${AUTHOR_BIO_MAX} characters`);
      } else if (value.length > 0) {
        bio = value;
      }
    }
  }

  // Omitted preserves, null clears. A submission that says nothing about the
  // photograph must not be read as "the author removed their photo", because a
  // form that only edits text carries no photo field at all. When a photograph
  // is present it arrives here already resolved against the media library, so
  // this is a re-check of the stored shape rather than the attachment gate --
  // the gate is `checkAuthorPhotoAsset` at the storage boundary, the only place
  // that can read what the asset actually is.
  let photo: AuthorPhoto | null | undefined;
  if (input.photo === undefined) {
    photo = undefined;
  } else if (input.photo === null) {
    photo = null;
  } else {
    const photoErrors = validateStoredAuthorPhoto(input.photo);
    if (photoErrors.length > 0) {
      errors.push(...photoErrors);
    } else {
      photo = input.photo as AuthorPhoto;
    }
  }

  const links: AuthorSocialLinks = {};
  const rawLinks = input.links;
  if (rawLinks !== undefined && rawLinks !== null) {
    if (typeof rawLinks !== "object" || Array.isArray(rawLinks)) {
      errors.push("Social links must be an object");
    } else {
      for (const key of Object.keys(rawLinks as Record<string, unknown>)) {
        if (!isSocialPlatform(key)) {
          errors.push(`Unsupported social platform: ${key}`);
        }
      }
      for (const platform of SOCIAL_PLATFORMS) {
        const entry = (rawLinks as Record<string, unknown>)[platform];
        // Optional and blank by default: an absent or cleared platform is not
        // an error, it is the normal state.
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
  let pinnedPostId: string | null | undefined;
  if (input.pinnedPostId === undefined) {
    pinnedPostId = undefined;
  } else if (input.pinnedPostId === null || input.pinnedPostId === "") {
    pinnedPostId = null;
  } else if (!isPostReference(input.pinnedPostId)) {
    errors.push("A pinned post must be named by a valid post id");
  } else {
    pinnedPostId = input.pinnedPostId;
  }

  let hiddenPostIds: string[] | undefined;
  if (input.hiddenPostIds === undefined) {
    hiddenPostIds = undefined;
  } else if (input.hiddenPostIds === null) {
    hiddenPostIds = [];
  } else if (!Array.isArray(input.hiddenPostIds)) {
    errors.push("Hidden posts must be a list");
  } else if (input.hiddenPostIds.length > AUTHOR_HIDDEN_POSTS_MAX) {
    errors.push(
      `At most ${AUTHOR_HIDDEN_POSTS_MAX} posts can be hidden from an author page`,
    );
  } else if (input.hiddenPostIds.some((entry) => !isPostReference(entry))) {
    errors.push("Each hidden post must be named by a valid post id");
  } else {
    // Deduplicated, first occurrence wins, order otherwise preserved: the list
    // is a set with a stable written form, so two saves of the same choices
    // produce the same document and the same snapshot.
    hiddenPostIds = [...new Set(input.hiddenPostIds as string[])];
  }

  // A pin and a hide on the same post contradict each other, and silently
  // preferring one would hide a choice the author made. Refuse and say so.
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

// -- lifecycle ---------------------------------------------------------------

export type WithdrawalReason = "owner" | "admin" | "deactivation" | "archive";

export interface AuthorProfileSeed {
  authorId: string;
  uid: string | null;
  displayName: string;
  nowIso: string;
  actor: string;
}

/** The document a brand-new profile starts as. Profiles start private. */
export function newAuthorWorkingProfile(seed: AuthorProfileSeed): AuthorWorkingProfile {
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
 * Apply a validated draft to a working profile. Visibility is untouched, and an
 * omitted photo (`undefined`) keeps the stored one -- only an explicit `null`
 * removes it.
 */
export function applyAuthorProfileEdit(
  profile: AuthorWorkingProfile,
  fields: AuthorProfileDraftFields,
  { nowIso, actor }: { nowIso: string; actor: string },
): AuthorWorkingProfile {
  const pinnedPostId =
    fields.pinnedPostId === undefined
      ? (profile.pinnedPostId ?? null)
      : fields.pinnedPostId;
  const carried = fields.hiddenPostIds ?? profile.hiddenPostIds ?? [];
  // The merged state has to satisfy the same invariant a single submission
  // does. Pinning is an explicit "show this at the top", so it wins over a hide
  // that was recorded earlier; the alternative is a pin that renders nothing
  // and no way for the author to see why.
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

export interface PublishReadiness {
  ok: boolean;
  errors: string[];
}

/**
 * Whether a profile may become public right now. Two independent conditions:
 * the content has to pass the same automated validation an edit passes, and the
 * staff account behind it has to be active. A deactivated account can never
 * publish, which is the same rule that withdraws a snapshot on deactivation.
 */
export function checkAuthorProfilePublishReadiness(
  profile: AuthorWorkingProfile,
  staffStatus: StaffRecordStatus | null,
): PublishReadiness {
  const errors: string[] = [];
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

/**
 * Mark a profile published against a slug. The slug is minted once, at first
 * publication, and reused on every later publication: withdrawing and
 * republishing must not move an author's public URL.
 */
export function publishAuthorProfile(
  profile: AuthorWorkingProfile,
  { slug, nowIso, actor }: { slug: string; nowIso: string; actor: string },
): AuthorWorkingProfile {
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

/**
 * Take a profile off the public site. The slug and previousSlugs survive so the
 * route stays reserved and a later republication is the same URL; only the
 * snapshot goes away, which the storage boundary deletes in the same
 * transaction.
 */
export function withdrawAuthorProfile(
  profile: AuthorWorkingProfile,
  {
    nowIso,
    actor,
    reason,
  }: { nowIso: string; actor: string; reason: WithdrawalReason },
): AuthorWorkingProfile {
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

/**
 * Admin-only slug rename. The outgoing slug is retained in `previousSlugs` in
 * the same shape as `EditorialBase.previousSlugs`, which is what the public
 * build reads to emit permanent redirects.
 */
export function renameAuthorSlug(
  profile: AuthorWorkingProfile,
  { slug, nowIso, actor }: { slug: string; nowIso: string; actor: string },
): AuthorWorkingProfile {
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
    ...profile.previousSlugs.filter((entry) => entry !== profile.slug && entry !== slug),
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

// -- redaction ---------------------------------------------------------------

function publicLinks(links: unknown): AuthorSocialLinks {
  const out: AuthorSocialLinks = {};
  if (links === null || typeof links !== "object" || Array.isArray(links)) return out;
  for (const platform of SOCIAL_PLATFORMS) {
    const entry = (links as Record<string, unknown>)[platform];
    // Rebuild each link from its two public fields by name. A stored link
    // object carrying extra keys -- a note, an internal id -- cannot ride along.
    const result = normalizeSocialLink(platform, entry);
    if (result.ok && result.value) {
      out[platform] = { handle: result.value.handle, url: result.value.url };
    }
  }
  return out;
}

/**
 * Build the detached public snapshot. This is the ONLY function that may write
 * to `cmsAuthorProfilesPublic`, and it constructs its result field by field
 * from a fixed list. There is no spread of the working profile anywhere in this
 * function, so email, uid, CMS role, grants, and every future private field are
 * excluded by construction rather than by remembering to delete them.
 *
 * Throws for an unpublishable profile: a snapshot without a slug or a name has
 * no valid public route or byline, and silently emitting a degraded one would
 * put a broken page on njpbs.org.
 */
export function toPublicAuthorSnapshot(
  profile: AuthorWorkingProfile,
): AuthorPublicSnapshot {
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
    .filter((entry): entry is string => isValidAuthorSlug(entry));

  return {
    authorId: profile.authorId,
    slug: profile.slug,
    previousSlugs,
    displayName,
    jobTitle,
    bio,
    photo,
    links: publicLinks(profile.links),
    // Rebuilt from the stored values rather than copied, and bounded again
    // here: a snapshot is what reaches njpbs.org, so a stale or hand-edited
    // profile document cannot put an unbounded list or an unsafe id into it.
    pinnedPostId: isPostReference(profile.pinnedPostId) ? profile.pinnedPostId : null,
    hiddenPostIds: [
      ...new Set(
        (Array.isArray(profile.hiddenPostIds) ? profile.hiddenPostIds : []).filter(
          (entry): entry is string =>
            isPostReference(entry) && entry !== profile.pinnedPostId,
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

/** The public route an author snapshot resolves to. */
export function authorPublicPath(slug: string): string {
  if (!isValidAuthorSlug(slug)) {
    throw new Error("authorPublicPath requires a valid slug");
  }
  return `${AUTHOR_PUBLIC_ROUTE_BASE}${slug}/`;
}


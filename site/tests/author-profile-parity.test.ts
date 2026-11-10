// @vitest-environment node
//
// Pins the CommonJS mirror in functions/lib/author-profile-contract.js to the
// canonical author-profile core in packages/content-core/src/author-profiles.ts.
// The functions bundle cannot import the TypeScript module, so the deployed
// write path runs a hand-written copy; without this test the two could fork
// silently and the boundary that actually publishes a profile would start
// accepting a social URL, a slug, or a snapshot field the model refuses.
//
// The cases are shared with the canonical spec's intent rather than invented
// here: every allowlist rejection, every slug edge, and the polluted-profile
// redaction fixture are all run through both implementations and compared.

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as ts from "../../packages/content-core/src/author-profiles";
import type { AuthorWorkingProfile } from "../../packages/content-core/src/author-profiles";

const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/author-profile-contract.js");

const NOW = "2026-08-21T18:00:00.000Z";
const AUTHOR_ID = ts.mintAuthorId("f".repeat(32));

describe("exported constants", () => {
  it("agrees on every shared constant", () => {
    expect(cjs.AUTHOR_PROFILE_API_VERSION).toBe(ts.AUTHOR_PROFILE_API_VERSION);
    expect({ ...cjs.AUTHOR_PROFILE_COLLECTIONS }).toEqual({
      ...ts.AUTHOR_PROFILE_COLLECTIONS,
    });
    expect(cjs.AUTHOR_PUBLIC_ROUTE_BASE).toBe(ts.AUTHOR_PUBLIC_ROUTE_BASE);
    expect(cjs.AUTHOR_ID_PREFIX).toBe(ts.AUTHOR_ID_PREFIX);
    expect(cjs.AUTHOR_NAME_MAX).toBe(ts.AUTHOR_NAME_MAX);
    expect(cjs.AUTHOR_JOB_TITLE_MAX).toBe(ts.AUTHOR_JOB_TITLE_MAX);
    expect(cjs.AUTHOR_BIO_MAX).toBe(ts.AUTHOR_BIO_MAX);
    expect(cjs.AUTHOR_SLUG_MAX).toBe(ts.AUTHOR_SLUG_MAX);
    // Neither mirror may reintroduce a retired-slug cap: a dropped slug stays
    // permanently reserved in cmsAuthorSlugs, so capping the list would leave an
    // author URL that neither redirects nor can be reissued.
    expect(cjs.AUTHOR_PREVIOUS_SLUGS_MAX).toBeUndefined();
    expect(
      (ts as Record<string, unknown>).AUTHOR_PREVIOUS_SLUGS_MAX,
    ).toBeUndefined();
    expect(cjs.AUTHOR_PHOTO_ASSET_ID_MAX).toBe(ts.AUTHOR_PHOTO_ASSET_ID_MAX);
    // The photo policy is a ratified decision, so a fork here would let the
    // deployed boundary accept a photograph the model refuses -- an animated
    // avatar, an over-size file, or one with no rights attestation.
    expect(cjs.AUTHOR_PHOTO_CATEGORY).toBe(ts.AUTHOR_PHOTO_CATEGORY);
    expect(cjs.AUTHOR_PHOTO_MAX_BYTES).toBe(ts.AUTHOR_PHOTO_MAX_BYTES);
    expect(cjs.AUTHOR_PHOTO_MIN_DIMENSION).toBe(ts.AUTHOR_PHOTO_MIN_DIMENSION);
    expect(cjs.AUTHOR_PHOTO_CREDIT_MAX).toBe(ts.AUTHOR_PHOTO_CREDIT_MAX);
    expect([...cjs.AUTHOR_PHOTO_MIME_TYPES]).toEqual([
      ...ts.AUTHOR_PHOTO_MIME_TYPES,
    ]);
    expect([...cjs.AUTHOR_PHOTO_RIGHTS_BASES]).toEqual([
      ...ts.AUTHOR_PHOTO_RIGHTS_BASES,
    ]);
    expect([...cjs.AUTHOR_PHOTO_CREDIT_REQUIRED_BASES]).toEqual([
      ...ts.AUTHOR_PHOTO_CREDIT_REQUIRED_BASES,
    ]);
    expect({ ...cjs.AUTHOR_PHOTO_LICENSE_BY_BASIS }).toEqual({
      ...ts.AUTHOR_PHOTO_LICENSE_BY_BASIS,
    });
    expect([...cjs.AUTHOR_PUBLIC_PHOTO_FIELDS]).toEqual([
      ...ts.AUTHOR_PUBLIC_PHOTO_FIELDS,
    ]);
    expect(cjs.AUTHOR_SLUG_FALLBACK_ROOT).toBe(ts.AUTHOR_SLUG_FALLBACK_ROOT);
    expect([...cjs.SOCIAL_PLATFORMS]).toEqual([...ts.SOCIAL_PLATFORMS]);
    expect([...cjs.RESERVED_AUTHOR_SLUGS]).toEqual([
      ...ts.RESERVED_AUTHOR_SLUGS,
    ]);
    expect([...cjs.AUTHOR_PUBLIC_SNAPSHOT_FIELDS]).toEqual([
      ...ts.AUTHOR_PUBLIC_SNAPSHOT_FIELDS,
    ]);
    expect([...cjs.AUTHOR_PRIVATE_FIELDS]).toEqual([...ts.AUTHOR_PRIVATE_FIELDS]);
  });
});

// Every URL shape worth deciding twice. The lookalike hosts and the encoded
// separator matter most: those are where a hand-copied allowlist is most likely
// to fork, and each fork would fail open on a public outbound link.
const LINK_CASES: Array<[string, unknown]> = [
  ["x", { handle: "njpbs", url: "https://x.com/njpbs" }],
  ["x", { url: "https://x.com/njpbs" }],
  ["x", { url: "https://x.com/home" }],
  ["x", { url: "https://x.com/messages" }],
  ["x", { url: "https://x.com/settings" }],
  ["x", { handle: "@njpbs", url: "https://twitter.com/njpbs" }],
  ["x", { handle: "njpbs", url: "https://www.x.com/njpbs/" }],
  ["x", { handle: "njpbs", url: "http://x.com/njpbs" }],
  ["x", { handle: "njpbs", url: "https://x.com.evil.example/njpbs" }],
  ["x", { handle: "njpbs", url: "https://evilx.com/njpbs" }],
  ["x", { handle: "njpbs", url: "https://x.com:8443/njpbs" }],
  ["x", { handle: "njpbs", url: "https://user:pw@x.com/njpbs" }],
  ["x", { handle: "njpbs", url: "https://x.com/njpbs?utm=1" }],
  ["x", { handle: "njpbs", url: "https://x.com/njpbs#top" }],
  ["x", { handle: "njpbs", url: "https://x.com/njpbs/status/1" }],
  ["x", { handle: "njpbs", url: "https://x.com/nj%2Fpbs" }],
  ["x", { handle: "other", url: "https://x.com/njpbs" }],
  ["x", { handle: "njpbs", url: "javascript:alert(1)" }],
  ["x", { handle: "a".repeat(16), url: "https://x.com/aaaa" }],
  ["x", null],
  ["x", []],
  ["x", { handle: 1, url: 2 }],
  ["x", {}],
  ["bluesky", { handle: "njpbs.bsky.social", url: "https://bsky.app/profile/njpbs.bsky.social" }],
  ["bluesky", { url: "https://bsky.app/profile/njpbs.bsky.social" }],
  ["bluesky", { handle: "njpbs", url: "https://bsky.app/profile/njpbs" }],
  ["bluesky", { handle: "NJPBS.bsky.social", url: "https://www.bsky.app/profile/njpbs.bsky.social" }],
  ["linkedin", { handle: "morgan-editor", url: "https://www.linkedin.com/in/morgan-editor" }],
  ["linkedin", { url: "https://www.linkedin.com/in/morgan-editor" }],
  ["linkedin", { handle: "Morgan-Editor", url: "https://linkedin.com/in/morgan-editor/" }],
  ["linkedin", { handle: "njpbs", url: "https://www.linkedin.com/company/njpbs" }],
];

describe("social link decisions", () => {
  it.each(LINK_CASES)("decides a %s link identically", (platform, input) => {
    const tsResult = ts.normalizeSocialLink(
      platform as ts.SocialPlatform,
      input,
    );
    const cjsResult = cjs.normalizeSocialLink(platform, input);
    expect(cjsResult).toEqual(tsResult);
  });
});

const SLUG_CASES = [
  "morgan-editor",
  "Morgan",
  "authors",
  "admin",
  "author",
  "",
  "-leading",
  "trailing-",
  "double--hyphen",
  "a".repeat(81),
  "njpbs-author",
];

const NAME_CASES = [
  "Morgan Editor",
  "  José  Ramírez-Díaz ",
  "!!!",
  "",
  "Ünïcödé Ñame",
  "a".repeat(200),
];

describe("slug decisions", () => {
  it.each(SLUG_CASES)("validates %j identically", (slug) => {
    expect(cjs.isValidAuthorSlug(slug)).toBe(ts.isValidAuthorSlug(slug));
  });

  it.each(NAME_CASES)("slugifies %j identically", (name) => {
    expect(cjs.slugifyAuthorName(name)).toBe(ts.slugifyAuthorName(name));
  });

  it("resolves collisions identically", () => {
    const taken = new Set(["morgan-editor", "morgan-editor-2", "njpbs-author"]);
    for (const name of NAME_CASES) {
      const base = ts.slugifyAuthorName(name);
      expect(cjs.resolveAuthorSlug(base, taken, name)).toBe(
        ts.resolveAuthorSlug(base, taken, name),
      );
    }
  });
});

/** A stored photograph both implementations must accept unchanged. */
const VALID_PHOTO = {
  assetId: "asset-123",
  url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/abc.jpg",
  mimeType: "image/jpeg",
  width: 800,
  height: 800,
  sizeBytes: 120_000,
  focalX: 0.5,
  focalY: 0.4,
  credit: null,
  rightsBasis: "own-photo",
  attestedAt: NOW,
  attestedBy: "uid-abc",
  attachedAt: NOW,
};

const PHOTO_REQUEST_CASES: unknown[] = [
  { assetId: "asset-123", rightsBasis: "own-photo" },
  { assetId: "asset-123", rightsBasis: "own-photo", focalX: 0.123456, focalY: 1 },
  { assetId: "asset-123", rightsBasis: "own-photo", focalX: 1.4 },
  { assetId: "asset-123", rightsBasis: "licensed-photo" },
  { assetId: "asset-123", rightsBasis: "licensed-photo", credit: " Ryan  Jones " },
  { assetId: "asset-123", rightsBasis: "made-up" },
  { assetId: "", rightsBasis: "own-photo" },
  { assetId: "../etc/passwd", rightsBasis: "own-photo" },
  { rightsBasis: "own-photo" },
  null,
  "asset-123",
];

const PHOTO_ASSET_CASES: unknown[] = [
  {
    id: "asset-123",
    category: "staff-profile",
    mimeType: "image/jpeg",
    sizeBytes: 120_000,
    width: 800,
    height: 800,
    url: "https://media.njpbs.org/x.jpg",
    lifecycle: "active",
    createdBy: "uid-abc",
  },
  {
    id: "asset-123",
    category: "news",
    mimeType: "image/jpeg",
    sizeBytes: 120_000,
    width: 800,
    height: 800,
    url: "https://media.njpbs.org/x.jpg",
    lifecycle: "active",
    createdBy: "uid-abc",
  },
  {
    id: "asset-123",
    category: "staff-profile",
    mimeType: "image/gif",
    sizeBytes: 6_000_000,
    width: 100,
    height: 800,
    url: "http://media.njpbs.org/x.gif",
    lifecycle: "tombstoned",
    createdBy: null,
  },
  null,
];

describe("profile photo decisions", () => {
  it.each(PHOTO_REQUEST_CASES.map((c, i) => [i, c] as const))(
    "normalizes photo request case %i identically",
    (_index, request) => {
      expect(cjs.normalizeAuthorPhotoRequest(request)).toEqual(
        ts.normalizeAuthorPhotoRequest(request),
      );
    },
  );

  it.each(PHOTO_ASSET_CASES.map((c, i) => [i, c] as const))(
    "checks photo asset case %i identically",
    (_index, asset) => {
      expect(cjs.checkAuthorPhotoAsset(asset, "asset-123")).toEqual(
        ts.checkAuthorPhotoAsset(asset as never, "asset-123"),
      );
    },
  );

  // The rights basis is bound to the license the library recorded, so the two
  // mirrors must refuse the same mismatches: a fork here is how a licensed
  // third-party photograph gets attached as "own-photo" with no credit line.
  it.each([
    ["own-photo", "Profile photo: supplied by the staff member, cleared for use"],
    ["own-photo", "Profile photo: licensed from a third party, credit required"],
    ["station-photo", "Profile photo: NJ PBS or Montclair State photograph"],
    ["licensed-photo", "NJ PBS owned"],
    ["licensed-photo", undefined],
    ["not-a-basis", "Profile photo: NJ PBS or Montclair State photograph"],
  ] as const)("checks the rights basis %s against license %s identically", (basis, license) => {
    const asset = { ...(PHOTO_ASSET_CASES[0] as object), license } as never;
    expect(cjs.checkAuthorPhotoRights(asset, basis)).toEqual(
      ts.checkAuthorPhotoRights(asset, basis),
    );
  });

  it("passes a matching basis and refuses a mismatched one", () => {
    const licensed = {
      ...(PHOTO_ASSET_CASES[0] as object),
      license: ts.AUTHOR_PHOTO_LICENSE_BY_BASIS["licensed-photo"],
    } as never;
    expect(ts.checkAuthorPhotoRights(licensed, "licensed-photo")).toEqual([]);
    expect(ts.checkAuthorPhotoRights(licensed, "own-photo")).toHaveLength(1);
    // No asset is not this check's refusal to make: checkAuthorPhotoAsset already
    // says "that photo is not in the media library", and repeating it would show
    // an author two errors for one missing file.
    expect(ts.checkAuthorPhotoRights(null, "own-photo")).toEqual([]);
  });

  it("composes, revalidates, and redacts a photograph identically", () => {
    const request = ts.normalizeAuthorPhotoRequest({
      assetId: "asset-123",
      rightsBasis: "licensed-photo",
      credit: "Ryan Jones",
      focalX: 0.25,
    }).value!;
    const asset = {
      ...(PHOTO_ASSET_CASES[0] as object),
      thumbnails: [
        {
          url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/thumbs/a-w480.webp",
          width: 480,
          height: 480,
          storageKey: "cms-media/secret",
        },
        { url: "javascript:alert(1)", width: 960, height: 960 },
      ],
    } as never;
    const args = { request, asset, nowIso: NOW, actor: "uid-abc" };
    const composed = ts.composeAuthorPhoto(args);
    expect(cjs.composeAuthorPhoto(args)).toEqual(composed);
    expect(cjs.validateStoredAuthorPhoto(composed)).toEqual(
      ts.validateStoredAuthorPhoto(composed),
    );
    expect(cjs.toPublicAuthorPhoto(composed)).toEqual(
      ts.toPublicAuthorPhoto(composed),
    );
    expect(composed.thumbnails).toEqual([{
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/thumbs/a-w480.webp",
      width: 480,
      height: 480,
    }]);
    expect(Object.keys(ts.toPublicAuthorPhoto(composed) ?? {}).sort()).toEqual(
      [...ts.AUTHOR_PUBLIC_PHOTO_FIELDS].sort(),
    );
    expect(JSON.stringify(ts.toPublicAuthorPhoto(composed))).not.toContain("storageKey");
    expect(JSON.stringify(ts.toPublicAuthorPhoto(composed))).not.toContain("javascript:");
    for (const basis of ts.AUTHOR_PHOTO_RIGHTS_BASES) {
      expect(cjs.authorPhotoCreditRequired(basis)).toBe(
        ts.authorPhotoCreditRequired(basis),
      );
      expect(cjs.isAuthorPhotoRightsBasis(basis)).toBe(true);
    }
    expect(cjs.isAuthorPhotoRightsBasis("made-up")).toBe(false);
  });
});

const DRAFT_CASES: unknown[] = [
  { displayName: "Alex Reporter" },
  { displayName: "   " },
  { displayName: 42 },
  { displayName: "a".repeat(121) },
  { displayName: "Alex‮ Reporter " },
  { displayName: "Alex", jobTitle: "j".repeat(121) },
  { displayName: "Alex", bio: "b".repeat(1001) },
  { displayName: "Alex", bio: "line one\n\n\n\nline two   " },
  { displayName: "Alex", photo: VALID_PHOTO },
  { displayName: "Alex", photo: null },
  { displayName: "Alex", photo: { ...VALID_PHOTO, assetId: "../etc/passwd" } },
  { displayName: "Alex", photo: { ...VALID_PHOTO, mimeType: "image/gif" } },
  { displayName: "Alex", photo: { ...VALID_PHOTO, width: 399 } },
  { displayName: "Alex", photo: { ...VALID_PHOTO, attestedAt: "" } },
  { displayName: "Alex", photo: "asset-123" },
  { displayName: "Alex", links: { mastodon: { handle: "x", url: "https://e.org/x" } } },
  {
    displayName: "Alex",
    links: {
      x: { handle: "alex", url: "http://x.com/alex" },
      linkedin: { handle: "alex", url: "https://example.org/alex" },
    },
  },
  {
    displayName: "Alex",
    links: { x: { handle: "njpbs", url: "https://x.com/njpbs" }, bluesky: null },
  },
  { displayName: "Alex", links: [] },
  {},
];

describe("draft validation decisions", () => {
  it.each(DRAFT_CASES.map((c, i) => [i, c] as const))(
    "validates draft case %i identically",
    (_index, draft) => {
      expect(cjs.validateAuthorProfileDraft(draft)).toEqual(
        ts.validateAuthorProfileDraft(draft as never),
      );
    },
  );
});

describe("lifecycle and snapshot decisions", () => {
  const seed = {
    authorId: AUTHOR_ID,
    uid: "uid-abc",
    displayName: "Morgan Editor",
    nowIso: NOW,
    actor: "uid-abc",
  };

  it("creates, edits, publishes, withdraws, and renames identically", () => {
    const tsProfile = ts.newAuthorWorkingProfile(seed);
    const cjsProfile = cjs.newAuthorWorkingProfile(seed);
    expect(cjsProfile).toEqual(tsProfile);

    const fields = ts.validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      jobTitle: "Director",
      bio: "Leads the center.",
      links: { x: { handle: "njpbs", url: "https://x.com/njpbs" } },
    }).value!;
    const edit = { nowIso: NOW, actor: "uid-abc" };
    const tsEdited = ts.applyAuthorProfileEdit(tsProfile, fields, edit);
    expect(cjs.applyAuthorProfileEdit(cjsProfile, fields, edit)).toEqual(tsEdited);

    // Omitted preserves, null clears -- identically on both sides.
    const withPhoto = { ...tsEdited, photo: VALID_PHOTO } as never;
    expect(
      ts.applyAuthorProfileEdit(withPhoto, fields, edit).photo?.assetId,
    ).toBe("asset-123");
    expect(cjs.applyAuthorProfileEdit(withPhoto, fields, edit)).toEqual(
      ts.applyAuthorProfileEdit(withPhoto, fields, edit),
    );
    const clearing = ts.validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      photo: null,
    }).value!;
    expect(ts.applyAuthorProfileEdit(withPhoto, clearing, edit).photo).toBeNull();
    expect(cjs.applyAuthorProfileEdit(withPhoto, clearing, edit)).toEqual(
      ts.applyAuthorProfileEdit(withPhoto, clearing, edit),
    );

    for (const status of ["active", "inactive"] as const) {
      expect(cjs.checkAuthorProfilePublishReadiness(tsEdited, status)).toEqual(
        ts.checkAuthorProfilePublishReadiness(tsEdited, status),
      );
    }

    const publishArgs = { slug: "morgan-editor", nowIso: NOW, actor: "uid-abc" };
    const tsPublished = ts.publishAuthorProfile(tsEdited, publishArgs);
    expect(cjs.publishAuthorProfile(tsEdited, publishArgs)).toEqual(tsPublished);

    const withdrawArgs = {
      nowIso: NOW,
      actor: "uid-admin",
      reason: "deactivation" as const,
    };
    expect(cjs.withdrawAuthorProfile(tsPublished, withdrawArgs)).toEqual(
      ts.withdrawAuthorProfile(tsPublished, withdrawArgs),
    );

    const renameArgs = { slug: "s-editor", nowIso: NOW, actor: "uid-admin" };
    expect(cjs.renameAuthorSlug(tsPublished, renameArgs)).toEqual(
      ts.renameAuthorSlug(tsPublished, renameArgs),
    );

    expect(cjs.toPublicAuthorSnapshot(tsPublished)).toEqual(
      ts.toPublicAuthorSnapshot(tsPublished),
    );
  });

  it("redacts the same polluted profile identically", () => {
    const polluted = {
      ...ts.publishAuthorProfile(ts.newAuthorWorkingProfile(seed), {
        slug: "morgan-editor",
        nowIso: NOW,
        actor: "uid-abc",
      }),
      previousSlugs: ["s-editor", "authors", "Bad-Slug"],
      photo: { ...VALID_PHOTO, internalNote: "supplied by HR" },
      links: {
        x: { handle: "njpbs", url: "https://x.com/njpbs", addedBy: "uid-abc" },
        linkedin: { handle: "alex", url: "http://linkedin.com/in/alex" },
      },
      email: "user-01bcb01b1e@example.org",
      role: "super_admin",
      grants: [{ role: "editor" }],
    } as unknown as AuthorWorkingProfile;

    const tsSnapshot = ts.toPublicAuthorSnapshot(polluted);
    expect(cjs.toPublicAuthorSnapshot(polluted)).toEqual(tsSnapshot);
    // And both agree the private values are gone, not merely equal to each other.
    const serialized = JSON.stringify(tsSnapshot);
    expect(serialized).not.toContain("user-01bcb01b1e@example.org");
    expect(serialized).not.toContain("super_admin");
    expect(serialized).not.toContain("uid-abc");
  });

  it("throws on the same invalid snapshot inputs", () => {
    const base = ts.publishAuthorProfile(ts.newAuthorWorkingProfile(seed), {
      slug: "morgan-editor",
      nowIso: NOW,
      actor: "uid-abc",
    });
    for (const broken of [
      { ...base, slug: null },
      { ...base, authorId: "uid-abc" },
      { ...base, displayName: " " },
    ] as AuthorWorkingProfile[]) {
      expect(() => ts.toPublicAuthorSnapshot(broken)).toThrow();
      expect(() => cjs.toPublicAuthorSnapshot(broken)).toThrow();
    }
  });

  it("builds the same public path", () => {
    expect(cjs.authorPublicPath("morgan-editor")).toBe(
      ts.authorPublicPath("morgan-editor"),
    );
  });
});

// @vitest-environment node
//
// Spec for the author/staff/profile data foundation (issue #1044, lane 1).
//
// The load-bearing test in this file is the redaction suite at the bottom. Every
// other rule here is recoverable if it breaks -- a rejected slug or an over-long
// bio is a validation bug someone notices. A private field reaching
// `cmsAuthorProfilesPublic` is a disclosure that ships to njpbs.org and stays in
// the static build, so that guarantee is asserted against a deliberately
// polluted profile rather than against a tidy fixture.

import { describe, expect, it } from "vitest";
import {
  AUTHOR_BIO_MAX,
  AUTHOR_ID_PREFIX,
  AUTHOR_JOB_TITLE_MAX,
  AUTHOR_NAME_MAX,
  AUTHOR_PHOTO_CATEGORY,
  AUTHOR_PHOTO_CREDIT_MAX,
  AUTHOR_PHOTO_MAX_BYTES,
  AUTHOR_PHOTO_MIME_TYPES,
  AUTHOR_PHOTO_MIN_DIMENSION,
  AUTHOR_PHOTO_RIGHTS_BASES,
  AUTHOR_PRIVATE_FIELDS,
  AUTHOR_PROFILE_API_VERSION,
  AUTHOR_PROFILE_COLLECTIONS,
  AUTHOR_SLUG_FALLBACK_ROOT,
  AUTHOR_PUBLIC_PHOTO_FIELDS,
  AUTHOR_PUBLIC_SNAPSHOT_FIELDS,
  SOCIAL_PLATFORMS,
  applyAuthorProfileEdit,
  authorPhotoCreditRequired,
  authorPublicPath,
  checkAuthorPhotoAsset,
  checkAuthorProfilePublishReadiness,
  composeAuthorPhoto,
  isAuthorId,
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
  type AuthorPhoto,
  type AuthorPhotoAssetFacts,
  type AuthorWorkingProfile,
} from "../../packages/content-core/src/author-profiles";

const NOW = "2026-08-21T18:00:00.000Z";
const LATER = "2026-08-21T19:00:00.000Z";
const AUTHOR_ID = mintAuthorId("a".repeat(32));

/**
 * A stored profile photograph that satisfies every ratified bound. Tests that
 * care about one rule vary that rule from here rather than restating a whole
 * valid photograph, so a bound added later fails loudly in one place.
 */
function storedPhoto(): AuthorPhoto {
  return {
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
}

function baseProfile(
  overrides: Partial<AuthorWorkingProfile> = {},
): AuthorWorkingProfile {
  return {
    ...newAuthorWorkingProfile({
      authorId: AUTHOR_ID,
      uid: "uid-abc",
      displayName: "Morgan Editor",
      nowIso: NOW,
      actor: "uid-abc",
    }),
    ...overrides,
  };
}

describe("author identity", () => {
  it("mints a stable opaque id that is neither a uid nor a slug", () => {
    const id = mintAuthorId("0123456789abcdef0123456789abcdef");
    expect(id).toBe(`${AUTHOR_ID_PREFIX}0123456789abcdef0123456789abcdef`);
    expect(isAuthorId(id)).toBe(true);
    // A uid and a slug must both fail the format check, so a caller cannot pass
    // one where an authorId belongs and have it quietly accepted.
    expect(isAuthorId("uid-abc")).toBe(false);
    expect(isAuthorId("morgan-editor")).toBe(false);
    expect(isAuthorId(`${AUTHOR_ID_PREFIX}short`)).toBe(false);
  });

  it("refuses entropy that is too short or not hex", () => {
    expect(() => mintAuthorId("abc")).toThrow(/entropy/i);
    expect(() => mintAuthorId("z".repeat(32))).toThrow(/entropy/i);
  });

  it("names four separate storage surfaces", () => {
    expect(AUTHOR_PROFILE_COLLECTIONS).toEqual({
      staffRecords: "cmsStaffRecords",
      workingProfiles: "cmsAuthorProfiles",
      publicProfiles: "cmsAuthorProfilesPublic",
      slugIndex: "cmsAuthorSlugs",
    });
    // None of them is `users`: CMS access data and profile data never share a
    // document.
    expect(Object.values(AUTHOR_PROFILE_COLLECTIONS)).not.toContain("users");
    expect(AUTHOR_PROFILE_API_VERSION).toBe(1);
  });
});

describe("social link allowlists", () => {
  const valid = [
    ["x", "njpbs", "https://x.com/njpbs", "https://x.com/njpbs"],
    ["x", "@njpbs", "https://twitter.com/njpbs", "https://x.com/njpbs"],
    ["x", "njpbs", "https://www.x.com/njpbs/", "https://x.com/njpbs"],
    [
      "bluesky",
      "njpbs.bsky.social",
      "https://bsky.app/profile/njpbs.bsky.social",
      "https://bsky.app/profile/njpbs.bsky.social",
    ],
    [
      "linkedin",
      "morgan-editor",
      "https://www.linkedin.com/in/morgan-editor",
      "https://www.linkedin.com/in/morgan-editor",
    ],
    [
      "linkedin",
      "Morgan-Editor",
      "https://linkedin.com/in/morgan-editor/",
      "https://www.linkedin.com/in/morgan-editor",
    ],
  ] as const;

  it.each(valid)(
    "accepts a %s handle/url pair and stores the canonical url",
    (platform, handle, url, expected) => {
      const result = normalizeSocialLink(platform, { handle, url });
      expect(result.ok).toBe(true);
      expect(result.value?.url).toBe(expected);
    },
  );

  it.each(valid)(
    "derives the internal %s handle from a profile url",
    (platform, _handle, url, expected) => {
      const result = normalizeSocialLink(platform, { url });
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({
        handle:
          platform === "x"
            ? "njpbs"
            : platform === "bluesky"
              ? "njpbs.bsky.social"
              : "morgan-editor",
        url: expected,
      });
    },
  );

  it.each(["home", "messages", "settings"])(
    "rejects the X /%s navigation route as a profile",
    (route) => {
      for (const input of [
        { url: `https://x.com/${route}` },
        {
          handle: route.toUpperCase(),
          url: `https://www.x.com/${route.toUpperCase()}/`,
        },
      ]) {
        const result = normalizeSocialLink("x", input);
        expect(result.ok).toBe(false);
        expect(result.value).toBeUndefined();
        expect(result.error).toContain("profile url");
      }
    },
  );

  it.each(["home_team", "messagesdesk", "settings_news"])(
    "keeps the profile-shaped X handle %s valid",
    (handle) => {
      expect(normalizeSocialLink("x", { url: `https://x.com/${handle}` })).toEqual({
        ok: true,
        value: { handle, url: `https://x.com/${handle}` },
      });
    },
  );

  // Each of these is a way an allowlist that matched loosely would fail open.
  const rejected: Array<[string, unknown, string]> = [
    [
      "x",
      { handle: "njpbs", url: "http://x.com/njpbs" },
      "plain http is not https",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com.evil.example/njpbs" },
      "a lookalike host that merely starts with the allowed host",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://evilx.com/njpbs" },
      "a lookalike host that merely ends with the allowed host",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com:8443/njpbs" },
      "an explicit port",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://user:pw@x.com/njpbs" },
      "embedded credentials",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com/njpbs?utm_source=cms" },
      "a query string",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com/njpbs#pinned" },
      "a fragment",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com/njpbs/status/1" },
      "a deeper path that is a post, not a profile",
    ],
    [
      "x",
      { handle: "njpbs", url: "https://x.com/nj%2Fpbs" },
      "a percent-encoded path separator",
    ],
    [
      "x",
      { handle: "someone-else", url: "https://x.com/njpbs" },
      "a handle that does not name the same profile as its url",
    ],
    [
      "x",
      { handle: "njpbs", url: "javascript:alert(1)" },
      "a javascript: url",
    ],
    [
      "x",
      { handle: "njpbs", url: "data:text/html,<script>" },
      "a data: url",
    ],
    ["x", { handle: "njpbs" }, "a handle with no url"],
    [
      "bluesky",
      { handle: "njpbs", url: "https://bsky.app/profile/njpbs" },
      "a bluesky handle with no domain",
    ],
    [
      "linkedin",
      {
        handle: "njpbs",
        url: "https://www.linkedin.com/company/njpbs",
      },
      "a linkedin company path rather than /in/",
    ],
  ];

  it.each(rejected)("rejects a %s link with %s", (platform, input) => {
    const result = normalizeSocialLink(
      platform as (typeof SOCIAL_PLATFORMS)[number],
      input,
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(typeof result.error).toBe("string");
  });
});

describe("profile draft validation", () => {
  it("requires a public display name", () => {
    expect(validateAuthorProfileDraft({}).ok).toBe(false);
    expect(validateAuthorProfileDraft({ displayName: "   " }).ok).toBe(false);
    expect(validateAuthorProfileDraft({ displayName: 42 }).ok).toBe(false);
    expect(
      validateAuthorProfileDraft({ displayName: "a".repeat(AUTHOR_NAME_MAX + 1) }).ok,
    ).toBe(false);
  });

  it("treats job title, bio, photo, and links as optional and blank by default", () => {
    const result = validateAuthorProfileDraft({ displayName: "Alex Reporter" });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      displayName: "Alex Reporter",
      jobTitle: null,
      bio: null,
      // Omitted, not cleared: the field the submission never mentioned.
      photo: undefined,
      links: {},
    });
  });

  it("separates an omitted photo from an explicitly cleared one", () => {
    expect(
      validateAuthorProfileDraft({ displayName: "Alex Reporter" }).value?.photo,
    ).toBeUndefined();
    expect(
      validateAuthorProfileDraft({ displayName: "Alex Reporter", photo: null }).value
        ?.photo,
    ).toBeNull();
    expect(
      validateAuthorProfileDraft({ displayName: "Alex Reporter", photo: storedPhoto() })
        .value?.photo?.assetId,
    ).toBe("asset-123");
    expect(
      validateAuthorProfileDraft({
        displayName: "Alex Reporter",
        photo: { ...storedPhoto(), assetId: "../etc/passwd" },
      }).ok,
    ).toBe(false);
  });

  it("keeps a stored photo through a text-only edit and clears it only on request", () => {
    // A form that edits text alone never mentions the photograph, and must not
    // delete it.
    const stored = baseProfile({ photo: storedPhoto() });
    const text = validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      bio: "Covers local news collaboration.",
    });
    expect(text.ok).toBe(true);
    expect(
      applyAuthorProfileEdit(stored, text.value!, { nowIso: NOW, actor: "uid-abc" })
        .photo?.assetId,
    ).toBe("asset-123");

    const cleared = validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      photo: null,
    });
    expect(
      applyAuthorProfileEdit(stored, cleared.value!, { nowIso: NOW, actor: "uid-abc" })
        .photo,
    ).toBeNull();
  });

  it("bounds the bio and the job title", () => {
    expect(
      validateAuthorProfileDraft({
        displayName: "Alex Reporter",
        bio: "b".repeat(AUTHOR_BIO_MAX + 1),
      }).ok,
    ).toBe(false);
    expect(
      validateAuthorProfileDraft({
        displayName: "Alex Reporter",
        jobTitle: "j".repeat(AUTHOR_JOB_TITLE_MAX + 1),
      }).ok,
    ).toBe(false);
  });

  it("strips control and bidi-override characters from the display name", () => {
    const result = validateAuthorProfileDraft({
      displayName: "Alex\u202E Reporter\u0000",
    });
    expect(result.value?.displayName).toBe("Alex Reporter");
  });

  it("rejects an unsupported social platform rather than ignoring it", () => {
    const result = validateAuthorProfileDraft({
      displayName: "Alex Reporter",
      links: { mastodon: { handle: "alex", url: "https://example.org/alex" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/mastodon/);
  });

  it("reports every invalid link rather than stopping at the first", () => {
    const result = validateAuthorProfileDraft({
      displayName: "Alex Reporter",
      links: {
        x: { handle: "alex", url: "http://x.com/alex" },
        linkedin: { handle: "alex", url: "https://example.org/alex" },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe("slugs", () => {
  it("derives a bounded lowercase slug from a display name", () => {
    expect(slugifyAuthorName("Morgan Editor")).toBe("morgan-editor");
    expect(slugifyAuthorName("  José  Ramírez-Díaz ")).toBe("jose-ramirez-diaz");
    expect(slugifyAuthorName("!!!")).toBe("");
  });

  it("rejects reserved and malformed slugs", () => {
    expect(isValidAuthorSlug("authors")).toBe(false);
    expect(isValidAuthorSlug("admin")).toBe(false);
    expect(isValidAuthorSlug("Morgan")).toBe(false);
    expect(isValidAuthorSlug("-leading")).toBe(false);
    expect(isValidAuthorSlug("double--hyphen")).toBe(false);
    expect(isValidAuthorSlug("")).toBe(false);
  });

  it("suffixes on collision and never reissues a retired slug", () => {
    // The taken set carries current AND previous slugs, so a renamed author's
    // old route can never be handed to someone else and start resolving to the
    // wrong person.
    const taken = new Set(["morgan-editor", "morgan-editor-2"]);
    expect(resolveAuthorSlug("morgan-editor", taken, "Morgan Editor")).toBe(
      "morgan-editor-3",
    );
  });

  it("falls back when a name has no sluggable characters", () => {
    // Not "author": that word is reserved, so a fallback root of "author"
    // would make every fallback slug start at "-2".
    expect(resolveAuthorSlug("", new Set(), "!!!")).toBe(AUTHOR_SLUG_FALLBACK_ROOT);
    expect(
      resolveAuthorSlug("", new Set([AUTHOR_SLUG_FALLBACK_ROOT]), "!!!"),
    ).toBe(`${AUTHOR_SLUG_FALLBACK_ROOT}-2`);
  });

  it("builds the ratified public route base", () => {
    expect(authorPublicPath("morgan-editor")).toBe("/authors/morgan-editor/");
    expect(() => authorPublicPath("Admin")).toThrow();
  });
});

describe("publish state machine", () => {
  it("starts every profile private with no slug", () => {
    const profile = baseProfile();
    expect(profile.visibility).toBe("private");
    expect(profile.slug).toBeNull();
    expect(profile.previousSlugs).toEqual([]);
    expect(profile.lifecycle).toBe("active");
    expect(profile.archivedAt).toBeNull();
  });

  it("allows a manager-created profile to publish before an account is linked", () => {
    const readiness = checkAuthorProfilePublishReadiness(
      baseProfile({ uid: null }),
      null,
    );
    expect(readiness).toEqual({ ok: true, errors: [] });
  });

  it("refuses publication after a profile is archived", () => {
    const readiness = checkAuthorProfilePublishReadiness(
      baseProfile({ uid: null, lifecycle: "archived", archivedAt: LATER }),
      null,
    );
    expect(readiness.ok).toBe(false);
    expect(readiness.errors.join(" ")).toMatch(/archived/i);
  });

  it("refuses publication for an inactive staff account", () => {
    const readiness = checkAuthorProfilePublishReadiness(baseProfile(), "inactive");
    expect(readiness.ok).toBe(false);
    expect(readiness.errors.join(" ")).toMatch(/inactive/i);
  });

  it("refuses publication when the working content would fail validation", () => {
    const readiness = checkAuthorProfilePublishReadiness(
      baseProfile({ displayName: "   " }),
      "active",
    );
    expect(readiness.ok).toBe(false);
  });

  it("publishes, withdraws, and republishes to the same slug", () => {
    const published = publishAuthorProfile(baseProfile(), {
      slug: "morgan-editor",
      nowIso: NOW,
      actor: "uid-abc",
    });
    expect(published.visibility).toBe("published");
    expect(published.slug).toBe("morgan-editor");

    const withdrawn = withdrawAuthorProfile(published, {
      nowIso: NOW,
      actor: "uid-admin",
      reason: "admin",
    });
    expect(withdrawn.visibility).toBe("private");
    expect(withdrawn.publishedAt).toBeNull();
    expect(withdrawn.withdrawnReason).toBe("admin");
    // The slug survives withdrawal: republishing must not move the author's URL.
    expect(withdrawn.slug).toBe("morgan-editor");

    const republished = publishAuthorProfile(withdrawn, {
      slug: "morgan-editor",
      nowIso: NOW,
      actor: "uid-abc",
    });
    expect(republished.slug).toBe("morgan-editor");
    expect(republished.withdrawnAt).toBeNull();
  });

  it("refuses to move an existing slug through a publish", () => {
    const published = publishAuthorProfile(baseProfile(), {
      slug: "morgan-editor",
      nowIso: NOW,
      actor: "uid-abc",
    });
    expect(() =>
      publishAuthorProfile(published, {
        slug: "someone-else",
        nowIso: NOW,
        actor: "uid-abc",
      }),
    ).toThrow(/admin rename/i);
  });

  it("retains the outgoing slug on an admin rename for redirects", () => {
    const published = publishAuthorProfile(baseProfile(), {
      slug: "morgan-editor",
      nowIso: NOW,
      actor: "uid-abc",
    });
    const renamed = renameAuthorSlug(published, {
      slug: "s-editor",
      nowIso: NOW,
      actor: "uid-admin",
    });
    expect(renamed.slug).toBe("s-editor");
    expect(renamed.previousSlugs).toEqual(["morgan-editor"]);

    const renamedAgain = renameAuthorSlug(renamed, {
      slug: "morgan-m",
      nowIso: NOW,
      actor: "uid-admin",
    });
    expect(renamedAgain.previousSlugs).toEqual(["s-editor", "morgan-editor"]);
  });

  it("retires every slug an author has ever held, with no cap", () => {
    // A dropped slug stays permanently reserved in cmsAuthorSlugs, so a capped
    // list would leave an author URL that neither redirects nor can be reissued.
    let profile = publishAuthorProfile(baseProfile(), {
      slug: "author-0",
      nowIso: NOW,
      actor: "uid-abc",
    });
    for (let index = 1; index <= 25; index += 1) {
      profile = renameAuthorSlug(profile, {
        slug: `author-${index}`,
        nowIso: NOW,
        actor: "uid-admin",
      });
    }
    expect(profile.slug).toBe("author-25");
    expect(profile.previousSlugs).toHaveLength(25);
    expect(profile.previousSlugs).toContain("author-0");
    expect(toPublicAuthorSnapshot(profile).previousSlugs).toHaveLength(25);
  });

  it("bumps the version on every state change so a stale write conflicts", () => {
    const profile = baseProfile();
    const edited = applyAuthorProfileEdit(
      profile,
      {
        displayName: "Morgan Editor",
        jobTitle: "Director",
        bio: null,
        photo: null,
        links: {},
      },
      { nowIso: NOW, actor: "uid-abc" },
    );
    expect(edited.version).toBe(profile.version + 1);
    expect(
      publishAuthorProfile(edited, { slug: "s-editor", nowIso: NOW, actor: "uid-abc" })
        .version,
    ).toBe(edited.version + 1);
  });
});

describe("public snapshot redaction", () => {
  // A working profile carrying every private field the four-identity split is
  // meant to keep apart, plus junk a future schema change could add. The
  // snapshot builder must not carry any of it forward.
  const polluted = {
    ...baseProfile({
      slug: "morgan-editor",
      previousSlugs: ["s-editor"],
      visibility: "published",
      publishedAt: NOW,
      publishedBy: "uid-abc",
      jobTitle: "Director, Center for Cooperative Media",
      bio: "Morgan leads the center.",
      photo: storedPhoto(),
      links: {
        x: { handle: "njpbs", url: "https://x.com/njpbs" },
      },
      version: 7,
    }),
    email: "user-01bcb01b1e@example.org",
    role: "super_admin",
    grants: [{ role: "editor", sections: ["news"] }],
    tokensValidAfter: 1234,
    internalNote: "do not share",
    status: "active",
  } as unknown as AuthorWorkingProfile;

  it("emits exactly the ratified public field list and nothing else", () => {
    const snapshot = toPublicAuthorSnapshot(polluted);
    expect(Object.keys(snapshot).sort()).toEqual(
      [...AUTHOR_PUBLIC_SNAPSHOT_FIELDS].sort(),
    );
  });

  it("never carries email, uid, CMS role, or grants into public output", () => {
    const serialized = JSON.stringify(toPublicAuthorSnapshot(polluted));
    for (const field of AUTHOR_PRIVATE_FIELDS) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    // The values, not only the key names: a private value re-keyed under a
    // public name would still be a disclosure.
    expect(serialized).not.toContain("user-01bcb01b1e@example.org");
    expect(serialized).not.toContain("@example.org");
    expect(serialized).not.toContain("uid-abc");
    expect(serialized).not.toContain("super_admin");
    expect(serialized).not.toContain("do not share");
  });

  it("rebuilds each social link rather than passing the stored object through", () => {
    const snapshot = toPublicAuthorSnapshot({
      ...polluted,
      links: {
        x: {
          handle: "njpbs",
          url: "https://x.com/njpbs",
          // A private annotation stored beside a link must not ride along.
          addedBy: "uid-abc",
        },
      } as never,
    });
    expect(snapshot.links.x).toEqual({
      handle: "njpbs",
      url: "https://x.com/njpbs",
    });
    expect(Object.keys(snapshot.links.x ?? {})).toEqual(["handle", "url"]);
  });

  it("drops a stored link that no longer passes the allowlist", () => {
    // A link written before a rule tightened, or through a compromised path,
    // must not be republished just because it is already in the database.
    const snapshot = toPublicAuthorSnapshot({
      ...polluted,
      links: { x: { handle: "njpbs", url: "http://x.com/njpbs" } } as never,
    });
    expect(snapshot.links.x).toBeUndefined();
  });

  it("refuses to build a snapshot without a minted slug, authorId, or name", () => {
    expect(() => toPublicAuthorSnapshot({ ...polluted, slug: null })).toThrow();
    expect(() =>
      toPublicAuthorSnapshot({ ...polluted, authorId: "uid-abc" }),
    ).toThrow();
    expect(() => toPublicAuthorSnapshot({ ...polluted, displayName: " " })).toThrow();
  });

  it("keeps previousSlugs so the public build can emit permanent redirects", () => {
    const snapshot = toPublicAuthorSnapshot(polluted);
    expect(snapshot.previousSlugs).toEqual(["s-editor"]);
    expect(snapshot.photo).toEqual({
      assetId: "asset-123",
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/abc.jpg",
      mimeType: "image/jpeg",
      width: 800,
      height: 800,
      focalX: 0.5,
      focalY: 0.4,
      credit: null,
    });
  });

  it("builds the public photo from a fixed field list, dropping the rights record", () => {
    const snapshot = toPublicAuthorSnapshot({
      ...polluted,
      photo: {
        ...storedPhoto(),
        // Fields a later schema change could add beside the photograph. None of
        // them may reach a public page just because they sat next to one that does.
        attestedBy: "uid-abc",
        internalNote: "supplied by HR",
      } as never,
    });
    const keys = Object.keys(snapshot.photo ?? {}).sort();
    expect(keys).toEqual(
      [...AUTHOR_PUBLIC_PHOTO_FIELDS].filter((field) => field !== "thumbnails").sort(),
    );
    expect(keys.every((field) => AUTHOR_PUBLIC_PHOTO_FIELDS.includes(field))).toBe(true);
    expect(JSON.stringify(snapshot.photo)).not.toContain("uid-abc");
    expect(JSON.stringify(snapshot.photo)).not.toContain("HR");
  });

  it("drops a stored photo that no longer satisfies the policy", () => {
    // A photograph saved before a bound tightened, or written through a path
    // that never checked it, must not be republished on the next save.
    const snapshot = toPublicAuthorSnapshot({
      ...polluted,
      photo: { ...storedPhoto(), width: 200, height: 200 } as never,
    });
    expect(snapshot.photo).toBeNull();
  });
});

// -- profile photographs ------------------------------------------------------
//
// The ratified policy is automated end to end: no human reviews a photograph
// before it can appear beside a byline, so these bounds are the entire gate
// between an upload and a face on njpbs.org.

describe("profile photo policy", () => {
  it("states the ratified bounds", () => {
    expect(AUTHOR_PHOTO_CATEGORY).toBe("staff-profile");
    expect(AUTHOR_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(AUTHOR_PHOTO_MIN_DIMENSION).toBe(400);
    expect([...AUTHOR_PHOTO_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
    // GIF and PDF are supported media types generally, and are deliberately not
    // portraits.
    expect([...AUTHOR_PHOTO_MIME_TYPES]).not.toContain("image/gif");
    expect([...AUTHOR_PHOTO_MIME_TYPES]).not.toContain("application/pdf");
    expect([...AUTHOR_PHOTO_RIGHTS_BASES]).toEqual([
      "own-photo",
      "station-photo",
      "licensed-photo",
    ]);
  });

  it("requires a rights basis and makes credit conditional on it", () => {
    expect(
      normalizeAuthorPhotoRequest({ assetId: "asset-123", focalX: 0.5, focalY: 0.5 })
        .errors.join(" "),
    ).toMatch(/how NJ PBS may use this photo/i);
    expect(authorPhotoCreditRequired("own-photo")).toBe(false);
    expect(authorPhotoCreditRequired("station-photo")).toBe(false);
    expect(authorPhotoCreditRequired("licensed-photo")).toBe(true);

    const licensed = normalizeAuthorPhotoRequest({
      assetId: "asset-123",
      rightsBasis: "licensed-photo",
    });
    expect(licensed.ok).toBe(false);
    expect(licensed.errors.join(" ")).toMatch(/credit/i);
    expect(
      normalizeAuthorPhotoRequest({
        assetId: "asset-123",
        rightsBasis: "licensed-photo",
        credit: "  Ryan  Jones ",
      }).value?.credit,
    ).toBe("Ryan Jones");
    expect(
      normalizeAuthorPhotoRequest({
        assetId: "asset-123",
        rightsBasis: "licensed-photo",
        credit: "a".repeat(AUTHOR_PHOTO_CREDIT_MAX + 1),
      }).ok,
    ).toBe(false);
  });

  it("centers an unstated focal point and refuses one outside the image", () => {
    const centered = normalizeAuthorPhotoRequest({
      assetId: "asset-123",
      rightsBasis: "own-photo",
    });
    expect(centered.value).toMatchObject({ focalX: 0.5, focalY: 0.5 });
    expect(
      normalizeAuthorPhotoRequest({
        assetId: "asset-123",
        rightsBasis: "own-photo",
        focalX: 0.123456,
        focalY: 0.9,
      }).value,
    ).toMatchObject({ focalX: 0.123, focalY: 0.9 });
    for (const focalX of [-0.1, 1.2, Number.NaN, "left"]) {
      expect(
        normalizeAuthorPhotoRequest({
          assetId: "asset-123",
          rightsBasis: "own-photo",
          focalX,
        }).ok,
      ).toBe(false);
    }
  });

  it("refuses an asset id that is not a Media Manager id", () => {
    for (const assetId of ["", "../etc/passwd", "a/b", "a".repeat(200)]) {
      expect(
        normalizeAuthorPhotoRequest({ assetId, rightsBasis: "own-photo" }).ok,
      ).toBe(false);
    }
  });

  it("checks the asset against the library record rather than the request", () => {
    const facts = (overrides: Partial<AuthorPhotoAssetFacts> = {}): AuthorPhotoAssetFacts => ({
      id: "asset-123",
      category: AUTHOR_PHOTO_CATEGORY,
      mimeType: "image/jpeg",
      sizeBytes: 120_000,
      width: 800,
      height: 800,
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/abc.jpg",
      lifecycle: "active",
      createdBy: "uid-abc",
      ...overrides,
    });
    expect(checkAuthorPhotoAsset(facts(), "asset-123")).toEqual([]);
    expect(checkAuthorPhotoAsset(null, "asset-123")).toHaveLength(1);
    // Any library category may supply a profile photo.
    expect(checkAuthorPhotoAsset(facts({ category: "news" }), "asset-123")).toEqual([]);
    expect(
      checkAuthorPhotoAsset(facts({ mimeType: "image/gif" }), "asset-123").join(" "),
    ).toMatch(/JPEG, PNG, WebP or AVIF/);
    expect(
      checkAuthorPhotoAsset(facts({ animated: true }), "asset-123").join(" "),
    ).toMatch(/still image/);
    expect(
      checkAuthorPhotoAsset(facts({ mimeType: "image/webp" }), "asset-123").join(" "),
    ).toMatch(/still image/);
    expect(
      checkAuthorPhotoAsset(facts({ mimeType: "image/webp", animated: false }), "asset-123"),
    ).toEqual([]);
    expect(
      checkAuthorPhotoAsset(
        facts({ sizeBytes: AUTHOR_PHOTO_MAX_BYTES + 1 }),
        "asset-123",
      ).join(" "),
    ).toMatch(/5 MB or smaller/);
    expect(
      checkAuthorPhotoAsset(
        facts({ width: AUTHOR_PHOTO_MIN_DIMENSION - 1 }),
        "asset-123",
      ).join(" "),
    ).toMatch(/400 by 400/);
    expect(
      checkAuthorPhotoAsset(
        facts({ height: AUTHOR_PHOTO_MIN_DIMENSION - 1 }),
        "asset-123",
      ).join(" "),
    ).toMatch(/400 by 400/);
    // Exactly the minimum passes: the bound is inclusive, so a 400x400 head shot
    // is usable rather than off by one.
    expect(
      checkAuthorPhotoAsset(
        facts({ width: AUTHOR_PHOTO_MIN_DIMENSION, height: AUTHOR_PHOTO_MIN_DIMENSION }),
        "asset-123",
      ),
    ).toEqual([]);
    expect(
      checkAuthorPhotoAsset(facts({ lifecycle: "tombstoned" }), "asset-123").join(" "),
    ).toMatch(/removed from the media library/i);
    expect(
      checkAuthorPhotoAsset(facts({ url: "http://media.njpbs.org/x.jpg" }), "asset-123")
        .join(" "),
    ).toMatch(/usable address/i);
  });

  it("re-takes the attestation when the photo or the basis changes, and keeps it otherwise", () => {
    const asset: AuthorPhotoAssetFacts = {
      id: "asset-123",
      category: AUTHOR_PHOTO_CATEGORY,
      mimeType: "image/jpeg",
      sizeBytes: 120_000,
      width: 800,
      height: 800,
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/abc.jpg",
      lifecycle: "active",
      createdBy: "uid-abc",
    };
    const first = composeAuthorPhoto({
      request: {
        assetId: "asset-123",
        focalX: 0.5,
        focalY: 0.4,
        credit: null,
        rightsBasis: "own-photo",
      },
      asset,
      nowIso: NOW,
      actor: "uid-abc",
    });
    expect(first.attestedAt).toBe(NOW);
    expect(first.attestedBy).toBe("uid-abc");

    // Re-cropping the same photograph under the same basis is not a new claim.
    const recropped = composeAuthorPhoto({
      request: {
        assetId: "asset-123",
        focalX: 0.2,
        focalY: 0.2,
        credit: null,
        rightsBasis: "own-photo",
      },
      asset,
      existing: first,
      nowIso: LATER,
      actor: "uid-other",
    });
    expect(recropped.attestedAt).toBe(NOW);
    expect(recropped.attachedAt).toBe(first.attachedAt);
    expect(recropped.focalX).toBe(0.2);

    // A different rights basis is a different claim, and so is a different photo.
    expect(
      composeAuthorPhoto({
        request: {
          assetId: "asset-123",
          focalX: 0.5,
          focalY: 0.5,
          credit: "Ryan Jones",
          rightsBasis: "licensed-photo",
        },
        asset,
        existing: first,
        nowIso: LATER,
        actor: "uid-other",
      }).attestedAt,
    ).toBe(LATER);
    expect(
      composeAuthorPhoto({
        request: {
          assetId: "asset-456",
          focalX: 0.5,
          focalY: 0.5,
          credit: null,
          rightsBasis: "own-photo",
        },
        asset: { ...asset, id: "asset-456" },
        existing: first,
        nowIso: LATER,
        actor: "uid-other",
      }).attachedAt,
    ).toBe(LATER);
  });

  it("treats an attached photo as part of the profile draft and clears on null", () => {
    const withPhoto = validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      photo: storedPhoto(),
    });
    expect(withPhoto.ok).toBe(true);
    expect(withPhoto.value?.photo?.assetId).toBe("asset-123");
    expect(
      validateAuthorProfileDraft({ displayName: "Morgan Editor", photo: null })
        .value?.photo,
    ).toBeNull();
    const broken = validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      photo: { ...storedPhoto(), attestedAt: "" },
    });
    expect(broken.ok).toBe(false);
    expect(broken.errors.join(" ")).toMatch(/attestation/i);
  });

  it("refuses to publish a profile whose stored photo no longer validates", () => {
    const readiness = checkAuthorProfilePublishReadiness(
      baseProfile({ photo: { ...storedPhoto(), mimeType: "image/gif" } as AuthorPhoto }),
      "active",
    );
    expect(readiness.ok).toBe(false);
    expect(readiness.errors.join(" ")).toMatch(/JPEG, PNG, WebP or AVIF/);
  });

  it("keeps a stored WebP that has no frame flag and still rejects an animated one", () => {
    const stored = {
      ...storedPhoto(),
      mimeType: "image/webp",
      url: "https://media.njpbs.org/cms-media/staff-profile/asset-123/abc.webp",
    };
    expect(validateStoredAuthorPhoto(stored)).toEqual([]);
    expect(toPublicAuthorPhoto(stored)).toMatchObject({ mimeType: "image/webp" });
    expect(
      validateStoredAuthorPhoto({ ...stored, animated: true }).join(" "),
    ).toMatch(/still image/);
    const composed = composeAuthorPhoto({
      request: {
        assetId: "asset-123",
        focalX: 0.5,
        focalY: 0.4,
        credit: null,
        rightsBasis: "own-photo",
      },
      asset: {
        id: "asset-123",
        category: AUTHOR_PHOTO_CATEGORY,
        mimeType: "image/webp",
        sizeBytes: 120_000,
        width: 800,
        height: 800,
        url: stored.url,
        lifecycle: "active",
        createdBy: "uid-abc",
        animated: false,
      },
      nowIso: NOW,
      actor: "uid-abc",
    });
    expect(validateStoredAuthorPhoto(composed)).toEqual([]);
    expect(validateAuthorProfileDraft({
      displayName: "Morgan Editor",
      photo: composed,
    }).ok).toBe(true);
  });

  it("keeps a valid photo through the public photo builder and drops a broken one", () => {
    expect(toPublicAuthorPhoto(storedPhoto())).toMatchObject({ assetId: "asset-123" });
    expect(toPublicAuthorPhoto(null)).toBeNull();
    expect(toPublicAuthorPhoto({ ...storedPhoto(), url: "javascript:alert(1)" })).toBeNull();
    expect(validateStoredAuthorPhoto(null)).toEqual([]);
  });
});

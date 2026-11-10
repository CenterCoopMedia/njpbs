import { describe, expect, it } from "vitest";
import {
  assertAuthorRouteUniqueness,
  projectAuthorPhoto,
  projectAuthorSnapshot,
  withAuthorPortraitDisplay,
} from "../src/lib/cms-authors-loader";
import { AUTHOR_PRIVATE_FIELDS } from "../../packages/content-core/src/author-profiles";

const AUTHOR_ID = "au_" + "1".repeat(32);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    authorId: AUTHOR_ID,
    slug: "ada-reporter",
    previousSlugs: [],
    displayName: "Ada Reporter",
    jobTitle: "Statehouse reporter",
    bio: "Covers the Legislature.",
    photo: null,
    links: {},
    pinnedPostId: null,
    hiddenPostIds: [],
    publishedAt: "2026-08-20T12:00:00.000Z",
    snapshotVersion: 3,
    ...overrides,
  };
}

describe("projection", () => {
  it("projects a usable snapshot to /authors/{slug}/", () => {
    const projected = projectAuthorSnapshot(AUTHOR_ID, snapshot());
    expect(projected?.path).toBe("/authors/ada-reporter/");
    expect(projected?.displayName).toBe("Ada Reporter");
    expect(projected?.sourceVersion).toBe(3);
  });

  it("carries nothing private into the build data", () => {
    const privateEmail = "private-author@example.org";
    const polluted = snapshot({
      uid: "uid-secret",
      email: privateEmail,
      role: "superAdmin",
    });
    const projected = projectAuthorSnapshot(AUTHOR_ID, polluted);
    const serialized = JSON.stringify(projected);
    for (const field of AUTHOR_PRIVATE_FIELDS) {
      if (field === "publishedBy") continue;
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain("uid-secret");
    expect(serialized).not.toContain(privateEmail);
  });

  it("refuses a snapshot whose stored authorId disagrees with its path id", () => {
    expect(
      projectAuthorSnapshot(AUTHOR_ID, snapshot({ authorId: "au_" + "2".repeat(32) })),
    ).toBeNull();
  });

  it("refuses a snapshot with no usable slug or no name", () => {
    expect(projectAuthorSnapshot(AUTHOR_ID, snapshot({ slug: "Ada Reporter" }))).toBeNull();
    expect(projectAuthorSnapshot(AUTHOR_ID, snapshot({ slug: "authors" }))).toBeNull();
    expect(projectAuthorSnapshot(AUTHOR_ID, snapshot({ displayName: "   " }))).toBeNull();
    expect(projectAuthorSnapshot(AUTHOR_ID, snapshot({ snapshotVersion: 0 }))).toBeNull();
  });
});

describe("social links", () => {
  it("keeps only links the shared allowlist rebuilds", () => {
    const projected = projectAuthorSnapshot(
      AUTHOR_ID,
      snapshot({
        links: {
          x: { handle: "adareporter", url: "https://x.com/adareporter" },
          bluesky: { handle: "ada", url: "https://bsky.example.com/ada" },
        },
      }),
    );
    expect(projected?.links).toEqual([
      { platform: "x", url: "https://x.com/adareporter" },
    ]);
  });
});

describe("the photograph", () => {
  const photo = (overrides: Record<string, unknown> = {}) => ({
    assetId: "asset-one",
    url: "https://media.njpbs.org/cms-media/ada.jpg",
    mimeType: "image/jpeg",
    width: 800,
    height: 800,
    focalX: 0.25,
    focalY: 0.75,
    credit: null,
    ...overrides,
  });

  it("turns the focal point into object-position percentages", () => {
    expect(projectAuthorPhoto(photo())).toMatchObject({ focalX: 25, focalY: 75 });
  });

  it("centres a photograph with no focal point rather than refusing it", () => {
    expect(
      projectAuthorPhoto(photo({ focalX: undefined, focalY: undefined })),
    ).toMatchObject({ focalX: 50, focalY: 50 });
  });

  it("renders a portrait thumbnail and keeps the original for social metadata", () => {
    const projected = projectAuthorPhoto(photo({
      thumbnails: [
        { url: "https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/a-w1600.webp", width: 1600, height: 1600 },
        { url: "https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/a-w480.webp", width: 480, height: 480 },
        {
          url: "https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/a-w960.webp",
          width: 960,
          height: 960,
          storageKey: "cms-media/secret",
        },
      ],
    }));
    expect(projected?.url).toBe("https://media.njpbs.org/cms-media/ada.jpg");
    expect(projected?.displayUrl).toBe("https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/a-w960.webp");
    expect(projectAuthorPhoto(photo({
      thumbnails: [{ url: "https://cdn.example.com/thumb.webp", width: 960, height: 960 }],
    }))?.displayUrl).toBe("https://media.njpbs.org/cms-media/ada.jpg");
    expect(projectAuthorPhoto(photo({
      thumbnails: [{
        url: "https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/wide-w960.webp",
        width: 960,
        height: 96,
      }],
    }))?.displayUrl).toBe("https://media.njpbs.org/cms-media/ada.jpg");
    expect(projectAuthorPhoto(photo({
      thumbnails: [{
        url: "https://media.njpbs.org/cms-media/staff-profile/asset-one/thumbs/only-w480.webp",
        width: 480,
        height: 480,
      }],
    }))?.displayUrl).toBe("https://media.njpbs.org/cms-media/ada.jpg");
  });

  it("drops an off-origin or unsized photograph and keeps the author page", () => {
    expect(withAuthorPortraitDisplay({
      photo: { url: "https://media.njpbs.org/cms-media/ada.jpg" },
    }).photo?.displayUrl).toBe("https://media.njpbs.org/cms-media/ada.jpg");
    expect(projectAuthorPhoto(photo({ url: "https://cdn.example.com/a.jpg" }))).toBeNull();
    expect(projectAuthorPhoto(photo({ width: 0 }))).toBeNull();
    const projected = projectAuthorSnapshot(
      AUTHOR_ID,
      snapshot({ photo: photo({ url: "https://cdn.example.com/a.jpg" }) }),
    );
    expect(projected).not.toBeNull();
    expect(projected?.photo).toBeNull();
  });
});

describe("author-page controls", () => {
  it("carries a bounded, route-safe pin and hidden list", () => {
    const projected = projectAuthorSnapshot(
      AUTHOR_ID,
      snapshot({
        pinnedPostId: "post-1",
        hiddenPostIds: ["post-2", "post-2", "bad/id", "post-3"],
      }),
    );
    expect(projected?.pinnedPostId).toBe("post-1");
    expect(projected?.hiddenPostIds).toEqual(["post-2", "post-3"]);
  });

  it("never lets the pinned post also be hidden", () => {
    const projected = projectAuthorSnapshot(
      AUTHOR_ID,
      snapshot({ pinnedPostId: "post-1", hiddenPostIds: ["post-1"] }),
    );
    expect(projected?.hiddenPostIds).toEqual([]);
  });
});

describe("retired slugs and route uniqueness", () => {
  it("keeps every retired slug as a redirect source", () => {
    const projected = projectAuthorSnapshot(
      AUTHOR_ID,
      snapshot({ previousSlugs: ["ada-r", "ada-reporter", "a-reporter"] }),
    );
    // The live slug is dropped: a page must not redirect to itself.
    expect(projected?.previousSlugs).toEqual(["ada-r", "a-reporter"]);
  });

  it("refuses two authors claiming one route", () => {
    const one = projectAuthorSnapshot(AUTHOR_ID, snapshot())!;
    const two = projectAuthorSnapshot("au_" + "2".repeat(32), {
      ...snapshot(),
      authorId: "au_" + "2".repeat(32),
      slug: "other-name",
      previousSlugs: ["ada-reporter"],
    })!;
    expect(() => assertAuthorRouteUniqueness([one, two])).toThrow(/routes collide/);
  });
});

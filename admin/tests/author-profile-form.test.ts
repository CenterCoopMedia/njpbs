import { describe, expect, it } from "vitest";
import {
  authorProfileFormChanged,
  authorProfileFormFromProfile,
  emptyAuthorProfileForm,
  photoFormValueFromAsset,
  validateAuthorProfileForm,
  type AuthorPhotoFormValue,
  type AuthorProfileFormValues,
} from "../src/lib/author-profile-form";

/** An attached photograph, as the form holds one. */
function photoValue(): AuthorPhotoFormValue {
  return {
    assetId: "asset-1",
    url: "https://media.njpbs.org/cms-media/staff-profile/asset-1/a.jpg",
    width: 800,
    height: 800,
    focalX: 0.25,
    focalY: 0.75,
    credit: "",
    rightsBasis: "own-photo",
  };
}

function form(
  overrides: Partial<AuthorProfileFormValues> = {},
): AuthorProfileFormValues {
  return { ...emptyAuthorProfileForm(), displayName: "Sam Morgan", ...overrides };
}

describe("author profile form values", () => {
  it("fills every field from a stored profile and leaves absent values blank", () => {
    const values = authorProfileFormFromProfile({
      displayName: "Sam Morgan",
      jobTitle: null,
      bio: "Director of the Center for Cooperative Media.",
      photo: null,
      links: { x: { handle: "smorgan", url: "https://x.com/smorgan" } },
    });

    expect(values.displayName).toBe("Sam Morgan");
    expect(values.jobTitle).toBe("");
    expect(values.bio).toBe("Director of the Center for Cooperative Media.");
    expect(values.links.x).toEqual({
      url: "https://x.com/smorgan",
    });
    expect(values.links.bluesky).toEqual({ url: "" });
  });

  it("sees a change in any field, including a profile link", () => {
    const base = form();
    expect(authorProfileFormChanged(base, form())).toBe(false);
    expect(authorProfileFormChanged(base, form({ jobTitle: "Director" }))).toBe(true);
    expect(
      authorProfileFormChanged(
        base,
        form({
          links: { ...base.links, x: { url: "https://x.com/smorgan" } },
        }),
      ),
    ).toBe(true);
  });
});

describe("author profile form validation", () => {
  it("requires a public display name", () => {
    const result = validateAuthorProfileForm(form({ displayName: "   " }));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.displayName).toBe(
      "Enter the name that should appear on your published work.",
    );
    expect(result.value).toBeUndefined();
  });

  it("bounds the name, job title and bio", () => {
    const result = validateAuthorProfileForm(
      form({
        displayName: "a".repeat(121),
        jobTitle: "b".repeat(121),
        bio: "c".repeat(1001),
      }),
    );
    expect(result.fieldErrors.displayName).toBe("Use 120 characters or fewer.");
    expect(result.fieldErrors.jobTitle).toBe("Use 120 characters or fewer.");
    expect(result.fieldErrors.bio).toBe("Use 1000 characters or fewer.");
  });

  it("sends the optional fields as null when they are left blank", () => {
    const result = validateAuthorProfileForm(form());
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      displayName: "Sam Morgan",
      jobTitle: null,
      bio: null,
      // Explicitly null, not omitted: the server preserves a stored photograph
      // for an absent key, so a form that shows the photo section has to say
      // when there is none.
      photo: null,
      links: {},
      // The author-page controls are always stated too, for the same reason the
      // photo is: this form renders them, so it owns their whole state.
      pinnedPostId: null,
      hiddenPostIds: [],
    });
  });

  it("sends the attached photo, its crop and its credit", () => {
    const result = validateAuthorProfileForm(form({ photo: photoValue() }));
    expect(result.ok).toBe(true);
    expect(result.value?.photo).toEqual({
      assetId: "asset-1",
      focalX: 0.25,
      focalY: 0.75,
      credit: null,
      rightsBasis: "own-photo",
    });
    expect(
      validateAuthorProfileForm(
        form({ photo: { ...photoValue(), credit: "  Ryan Jones  " } }),
      ).value?.photo?.credit,
    ).toBe("Ryan Jones");
  });

  it("requires a credit for a licensed photo", () => {
    const result = validateAuthorProfileForm(
      form({ photo: { ...photoValue(), rightsBasis: "licensed-photo", credit: " " } }),
    );
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.photo).toMatch(/credit/i);
  });

  it("treats attaching, cropping, recrediting and removing a photo as changes", () => {
    const withPhoto = form({ photo: photoValue() });
    expect(authorProfileFormChanged(withPhoto, form())).toBe(true);
    expect(authorProfileFormChanged(withPhoto, withPhoto)).toBe(false);
    expect(
      authorProfileFormChanged(withPhoto, form({ photo: { ...photoValue(), focalY: 0.1 } })),
    ).toBe(true);
    expect(
      authorProfileFormChanged(
        withPhoto,
        form({ photo: { ...photoValue(), credit: "Ryan Jones" } }),
      ),
    ).toBe(true);
    expect(
      authorProfileFormChanged(
        withPhoto,
        form({ photo: { ...photoValue(), assetId: "asset-2" } }),
      ),
    ).toBe(true);
    // Whitespace-only credit edits are not changes worth offering a save for.
    expect(
      authorProfileFormChanged(withPhoto, form({ photo: { ...photoValue(), credit: " " } })),
    ).toBe(false);
  });

  it("fills the photo fields from a stored profile and centers a new upload", () => {
    const values = authorProfileFormFromProfile({
      displayName: "Sam Morgan",
      jobTitle: null,
      bio: null,
      photo: {
        assetId: "asset-1",
        url: "https://media.njpbs.org/p.jpg",
        mimeType: "image/jpeg",
        width: 800,
        height: 800,
        sizeBytes: 1000,
        focalX: 0.25,
        focalY: 0.75,
        credit: "Ryan Jones",
        rightsBasis: "licensed-photo",
        attestedAt: "2026-08-21T18:00:00.000Z",
      },
      links: {},
    });
    expect(values.photo).toEqual({
      assetId: "asset-1",
      url: "https://media.njpbs.org/p.jpg",
      width: 800,
      height: 800,
      focalX: 0.25,
      focalY: 0.75,
      credit: "Ryan Jones",
      rightsBasis: "licensed-photo",
    });
    expect(
      photoFormValueFromAsset(
        { id: "asset-2", url: "https://media.njpbs.org/q.jpg", width: 600, height: 900 },
        "own-photo",
        "",
      ),
    ).toMatchObject({ assetId: "asset-2", focalX: 0.5, focalY: 0.5, credit: "" });
  });

  it("sends the attached photo, its crop and its credit", () => {
    const result = validateAuthorProfileForm(form({ photo: photoValue() }));
    expect(result.ok).toBe(true);
    expect(result.value?.photo).toEqual({
      assetId: "asset-1",
      focalX: 0.25,
      focalY: 0.75,
      credit: null,
      rightsBasis: "own-photo",
    });
    expect(
      validateAuthorProfileForm(
        form({ photo: { ...photoValue(), credit: "  Ryan Jones  " } }),
      ).value?.photo?.credit,
    ).toBe("Ryan Jones");
  });

  it("requires a credit for a licensed photo", () => {
    const result = validateAuthorProfileForm(
      form({ photo: { ...photoValue(), rightsBasis: "licensed-photo", credit: " " } }),
    );
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.photo).toMatch(/credit/i);
  });

  it("treats attaching, cropping, recrediting and removing a photo as changes", () => {
    const withPhoto = form({ photo: photoValue() });
    expect(authorProfileFormChanged(withPhoto, form())).toBe(true);
    expect(authorProfileFormChanged(withPhoto, withPhoto)).toBe(false);
    expect(
      authorProfileFormChanged(withPhoto, form({ photo: { ...photoValue(), focalY: 0.1 } })),
    ).toBe(true);
    expect(
      authorProfileFormChanged(
        withPhoto,
        form({ photo: { ...photoValue(), credit: "Ryan Jones" } }),
      ),
    ).toBe(true);
    expect(
      authorProfileFormChanged(
        withPhoto,
        form({ photo: { ...photoValue(), assetId: "asset-2" } }),
      ),
    ).toBe(true);
    // Whitespace-only credit edits are not changes worth offering a save for.
    expect(
      authorProfileFormChanged(withPhoto, form({ photo: { ...photoValue(), credit: " " } })),
    ).toBe(false);
  });

  it("fills the photo fields from a stored profile and centers a new upload", () => {
    const values = authorProfileFormFromProfile({
      displayName: "Sam Morgan",
      jobTitle: null,
      bio: null,
      photo: {
        assetId: "asset-1",
        url: "https://media.njpbs.org/p.jpg",
        mimeType: "image/jpeg",
        width: 800,
        height: 800,
        sizeBytes: 1000,
        focalX: 0.25,
        focalY: 0.75,
        credit: "Ryan Jones",
        rightsBasis: "licensed-photo",
        attestedAt: "2026-08-21T18:00:00.000Z",
      },
      links: {},
    });
    expect(values.photo).toEqual({
      assetId: "asset-1",
      url: "https://media.njpbs.org/p.jpg",
      width: 800,
      height: 800,
      focalX: 0.25,
      focalY: 0.75,
      credit: "Ryan Jones",
      rightsBasis: "licensed-photo",
    });
    expect(
      photoFormValueFromAsset(
        { id: "asset-2", url: "https://media.njpbs.org/q.jpg", width: 600, height: 900 },
        "own-photo",
        "",
      ),
    ).toMatchObject({ assetId: "asset-2", focalX: 0.5, focalY: 0.5, credit: "" });
  });

  it("derives the stored handle from a valid profile link", () => {
    const base = emptyAuthorProfileForm();
    const result = validateAuthorProfileForm(
      form({
        links: {
          ...base.links,
          bluesky: { url: "https://bsky.app/profile/example-reporter.bsky.social" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.value?.links?.bluesky).toEqual({
      handle: "example-reporter.bsky.social",
      url: "https://bsky.app/profile/example-reporter.bsky.social",
    });
  });

  it("refuses a link outside the allowlist", () => {
    const base = emptyAuthorProfileForm();
    const offHost = validateAuthorProfileForm(
      form({
        links: {
          ...base.links,
          x: { url: "https://twitter.example/smorgan" },
        },
      }),
    );
    expect(offHost.ok).toBe(false);
    expect(offHost.fieldErrors.x).toContain("https://x.com/yourhandle");

  });

  it("sends the canonical link the contract rebuilds, not the typed string", () => {
    const base = emptyAuthorProfileForm();
    const result = validateAuthorProfileForm(
      form({
        links: {
          ...base.links,
          x: { url: "https://www.x.com/SMorgan/" },
          linkedin: {
            url: "https://www.linkedin.com/in/sam-morgan",
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.value?.links).toEqual({
      x: { handle: "SMorgan", url: "https://x.com/SMorgan" },
      linkedin: {
        handle: "sam-morgan",
        url: "https://www.linkedin.com/in/sam-morgan",
      },
    });
  });
});

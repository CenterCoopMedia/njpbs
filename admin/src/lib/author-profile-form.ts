// The author profile form's own model: what the fields hold, how a stored profile fills
// them, and what a submission has to satisfy before it is worth a request.
//
// The server is the authority. Every rule here also runs in the Cloud Function, and a
// refusal there is the real answer -- this exists so an author sees "that is not an X
// profile link" beside the field instead of a red banner after a round trip. It mirrors
// the shared contract in packages/content-core rather than restating it: the length
// bounds and the link allowlist are imported, so a change to the contract cannot leave a
// friendlier-but-wrong copy of the rules behind in the UI.
import {
  AUTHOR_BIO_MAX,
  AUTHOR_HIDDEN_POSTS_MAX,
  AUTHOR_JOB_TITLE_MAX,
  AUTHOR_NAME_MAX,
  AUTHOR_PHOTO_CREDIT_MAX,
  SOCIAL_PLATFORMS,
  isPostReference,
  authorPhotoCreditRequired,
  isAuthorPhotoRightsBasis,
  normalizeSocialLink,
  validateAuthorProfileDraft,
  type AuthorPhotoRightsBasis,
  type SocialPlatform,
} from "../../../packages/content-core/src/author-profiles";
import type {
  AuthorPhotoRequest,
  AuthorProfileDraft,
  AuthorSocialLinks,
  SelfAuthorProfile,
} from "./functions";

export const AUTHOR_PROFILE_LIMITS = {
  displayName: AUTHOR_NAME_MAX,
  jobTitle: AUTHOR_JOB_TITLE_MAX,
  bio: AUTHOR_BIO_MAX,
  photoCredit: AUTHOR_PHOTO_CREDIT_MAX,
} as const;

export const AUTHOR_PLATFORMS = SOCIAL_PLATFORMS;

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: "X",
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
};

export const PLATFORM_URL_EXAMPLES: Record<SocialPlatform, string> = {
  x: "https://x.com/yourhandle",
  bluesky: "https://bsky.app/profile/you.bsky.social",
  linkedin: "https://www.linkedin.com/in/yourhandle",
};

export interface SocialLinkFields {
  url: string;
}

/**
 * An attached photograph as the form holds it. The address and the dimensions
 * come back from the upload and are carried only so the crop can be previewed --
 * the server reads them from the media library again on save, so nothing here is
 * trusted on the way back in.
 */
export interface AuthorPhotoFormValue {
  assetId: string;
  url: string;
  width: number | null;
  height: number | null;
  focalX: number;
  focalY: number;
  credit: string;
  rightsBasis: AuthorPhotoRightsBasis;
  /** Preview only. A save sends the asset id, not these addresses. */
  thumbnails?: readonly { url: string; width: number; height: number }[];
}

export interface AuthorProfileFormValues {
  displayName: string;
  jobTitle: string;
  bio: string;
  photo: AuthorPhotoFormValue | null;
  links: Record<SocialPlatform, SocialLinkFields>;
  /** The post shown first on this author's page, or null for none. */
  pinnedPostId: string | null;
  /** Posts left off this author's page. Never an unpublish. */
  hiddenPostIds: string[];
}

export type AuthorProfileFieldName =
  | "displayName"
  | "jobTitle"
  | "bio"
  | "photo"
  | "pinnedPostId"
  | "hiddenPostIds"
  | SocialPlatform;

/**
 * The editable content of a submission. The version is deliberately not part of it:
 * `expectedVersion` is required on every mutation, and it belongs to the record the
 * form was opened against, not to what the author typed.
 */
export type AuthorProfileDraftContent = Omit<AuthorProfileDraft, "expectedVersion">;

export interface AuthorProfileFormValidation {
  ok: boolean;
  fieldErrors: Partial<Record<AuthorProfileFieldName, string>>;
  /** Anything the shared contract refused that no single field owns. */
  formErrors: string[];
  value?: AuthorProfileDraftContent;
}

function emptyLinks(): Record<SocialPlatform, SocialLinkFields> {
  return {
    x: { url: "" },
    bluesky: { url: "" },
    linkedin: { url: "" },
  };
}

export function emptyAuthorProfileForm(): AuthorProfileFormValues {
  return {
    displayName: "",
    jobTitle: "",
    bio: "",
    photo: null,
    links: emptyLinks(),
    pinnedPostId: null,
    hiddenPostIds: [],
  };
}

/** The form value for a photograph that has just been uploaded. */
export function photoFormValueFromAsset(
  asset: {
    id: string;
    url: string;
    width: number | null;
    height: number | null;
    thumbnails?: AuthorPhotoFormValue["thumbnails"];
  },
  rightsBasis: AuthorPhotoRightsBasis,
  credit: string,
): AuthorPhotoFormValue {
  return {
    assetId: asset.id,
    url: asset.url,
    width: asset.width,
    height: asset.height,
    ...(asset.thumbnails?.length ? { thumbnails: asset.thumbnails } : {}),
    // A new photograph starts centered. Most head shots are already centered, so
    // this is the answer that needs no adjustment most of the time.
    focalX: 0.5,
    focalY: 0.5,
    credit,
    rightsBasis,
  };
}

/** Fill the form from a stored profile. Absent optional values become empty fields. */
export function authorProfileFormFromProfile(
  profile: Pick<
    SelfAuthorProfile,
    "displayName" | "jobTitle" | "bio" | "links" | "photo"
  > &
    // Optional so a profile stored before the author-page controls existed fills
    // the form as "no pin, nothing hidden" instead of failing to open at all.
    Partial<Pick<SelfAuthorProfile, "pinnedPostId" | "hiddenPostIds">>,
): AuthorProfileFormValues {
  const links = emptyLinks();
  for (const platform of SOCIAL_PLATFORMS) {
    const stored = profile.links?.[platform];
    if (stored) {
      links[platform] = { url: stored.url };
    }
  }
  const stored = profile.photo ?? null;
  return {
    displayName: profile.displayName ?? "",
    jobTitle: profile.jobTitle ?? "",
    bio: profile.bio ?? "",
    photo:
      stored && isAuthorPhotoRightsBasis(stored.rightsBasis)
        ? {
            assetId: stored.assetId,
            url: stored.url,
            width: stored.width,
            height: stored.height,
            focalX: stored.focalX,
            focalY: stored.focalY,
            credit: stored.credit ?? "",
            rightsBasis: stored.rightsBasis,
            ...(stored.thumbnails?.length ? { thumbnails: stored.thumbnails } : {}),
          }
        : null,
    links,
    pinnedPostId: profile.pinnedPostId ?? null,
    hiddenPostIds: [...(profile.hiddenPostIds ?? [])],
  };
}

/** Whether the photograph, its crop, or its rights details differ. */
export function authorPhotoChanged(
  a: AuthorPhotoFormValue | null,
  b: AuthorPhotoFormValue | null,
): boolean {
  if (a === null || b === null) return a !== b;
  return (
    a.assetId !== b.assetId ||
    a.focalX !== b.focalX ||
    a.focalY !== b.focalY ||
    a.credit.trim() !== b.credit.trim() ||
    a.rightsBasis !== b.rightsBasis
  );
}

/** Whether two form states differ, so an unchanged form does not offer a save. */
export function authorProfileFormChanged(
  a: AuthorProfileFormValues,
  b: AuthorProfileFormValues,
): boolean {
  if (a.displayName !== b.displayName) return true;
  if (a.jobTitle !== b.jobTitle) return true;
  if (a.bio !== b.bio) return true;
  if (authorPhotoChanged(a.photo, b.photo)) return true;
  if (a.pinnedPostId !== b.pinnedPostId) return true;
  // Order is not meaning in the hidden list, but it is stable in practice and a
  // positional compare is what makes an added-then-removed round trip read as
  // unchanged rather than as an edit worth a request.
  if (a.hiddenPostIds.length !== b.hiddenPostIds.length) return true;
  if (a.hiddenPostIds.some((id, index) => id !== b.hiddenPostIds[index])) return true;
  return SOCIAL_PLATFORMS.some(
    (platform) => a.links[platform].url !== b.links[platform].url,
  );
}

/**
 * Check a form submission and, when it passes, return the draft body to send.
 *
 * A social link is optional. A filled link is checked against the same allowlist
 * the server uses. The contract derives the compatibility handle and rebuilds the
 * canonical URL, so the author's typed string never travels.
 */
export function validateAuthorProfileForm(
  values: AuthorProfileFormValues,
): AuthorProfileFormValidation {
  const fieldErrors: Partial<Record<AuthorProfileFieldName, string>> = {};

  const displayName = values.displayName.trim();
  if (displayName.length === 0) {
    fieldErrors.displayName =
      "Enter the name that should appear on your published work.";
  } else if (displayName.length > AUTHOR_NAME_MAX) {
    fieldErrors.displayName = `Use ${AUTHOR_NAME_MAX} characters or fewer.`;
  }

  const jobTitle = values.jobTitle.trim();
  if (jobTitle.length > AUTHOR_JOB_TITLE_MAX) {
    fieldErrors.jobTitle = `Use ${AUTHOR_JOB_TITLE_MAX} characters or fewer.`;
  }

  const bio = values.bio.trim();
  if (bio.length > AUTHOR_BIO_MAX) {
    fieldErrors.bio = `Use ${AUTHOR_BIO_MAX} characters or fewer.`;
  }

  const links: AuthorSocialLinks = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const label = PLATFORM_LABELS[platform];
    const url = values.links[platform].url.trim();
    if (url === "") continue;
    const normalized = normalizeSocialLink(platform, { url });
    if (!normalized.ok || !normalized.value) {
      fieldErrors[platform] =
        `Check this ${label} profile link. Use a link like ${PLATFORM_URL_EXAMPLES[platform]}.`;
      continue;
    }
    links[platform] = normalized.value;
  }

  // Explicitly null when there is no photograph: the server preserves a stored
  // photograph for an omitted key, so removal has to say so rather than stay
  // quiet. A save from this form is always the whole photo state.
  let photo: AuthorPhotoRequest | null = null;
  if (values.photo) {
    const credit = values.photo.credit.trim();
    if (credit.length > AUTHOR_PHOTO_CREDIT_MAX) {
      fieldErrors.photo = `Use ${AUTHOR_PHOTO_CREDIT_MAX} characters or fewer for the photo credit.`;
    } else if (authorPhotoCreditRequired(values.photo.rightsBasis) && credit === "") {
      fieldErrors.photo = "Add the photographer's credit for a licensed photo.";
    } else {
      photo = {
        assetId: values.photo.assetId,
        focalX: values.photo.focalX,
        focalY: values.photo.focalY,
        credit: credit === "" ? null : credit,
        rightsBasis: values.photo.rightsBasis,
      };
    }
  }

  const pinnedPostId = values.pinnedPostId;
  if (pinnedPostId !== null && !isPostReference(pinnedPostId)) {
    fieldErrors.pinnedPostId = "That pinned post could not be recognized.";
  }
  const hiddenPostIds = [...new Set(values.hiddenPostIds)];
  if (hiddenPostIds.length > AUTHOR_HIDDEN_POSTS_MAX) {
    fieldErrors.hiddenPostIds = `Leave at most ${AUTHOR_HIDDEN_POSTS_MAX} posts off this page.`;
  } else if (hiddenPostIds.some((id) => !isPostReference(id))) {
    fieldErrors.hiddenPostIds = "One of those posts could not be recognized.";
  } else if (pinnedPostId !== null && hiddenPostIds.includes(pinnedPostId)) {
    fieldErrors.pinnedPostId =
      "A pinned post is shown, so it cannot also be left off the page.";
  }

  const draft = {
    displayName,
    jobTitle: jobTitle === "" ? null : jobTitle,
    bio: bio === "" ? null : bio,
    photo,
    links,
    pinnedPostId,
    hiddenPostIds,
  };

  // The shared contract runs last and has the final say. Anything it refuses that the
  // field checks above did not already name is surfaced as a form-level message rather
  // than swallowed, so a contract rule added later still reaches the author.
  const contractCheck = validateAuthorProfileDraft({ ...draft, photo: undefined });
  const formErrors =
    contractCheck.ok || Object.keys(fieldErrors).length > 0
      ? []
      : contractCheck.errors;

  const ok = Object.keys(fieldErrors).length === 0 && contractCheck.ok;
  return {
    ok,
    fieldErrors,
    formErrors,
    value: ok ? draft : undefined,
  };
}

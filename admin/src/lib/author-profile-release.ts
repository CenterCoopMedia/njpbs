/**
 * The operator's reviewed release assertion for public author-profile routes.
 *
 * Defaults off. Enable only after current-host route, privacy and withdrawal
 * acceptance. This build flag controls the Publish affordance and related copy;
 * it does not deploy routes or publish/withdraw any profile by itself.
 */
export const AUTHOR_PAGES_LIVE = import.meta.env.VITE_AUTHOR_PAGES_LIVE === "true";

export type AuthorPhotoAssetSource = "library" | "upload";
export type AuthorPhotoSaveMode = "immediate" | "profile-save";
export type AuthorPhotoSubject = "self" | "other";

export interface AuthorProfileReleaseCopy {
  addressHint: string;
  adminOverview: string;
  adminPublishedBadge: string;
  adminPublishedDescription: (publicPath?: string | null) => string;
  adminPublishingDescription: string;
  adminStateColumn: string;
  photoDescription: (who: string) => string;
  publishedStatus: (publicPath?: string | null) => string;
  publishingDescription: string;
  selfProfileDescription: (profileIsPublished: boolean) => string;
}

/** Select every route-state sentence from the public author-route gate. */
export function buildAuthorProfileReleaseCopy(
  pagesLive: boolean,
): AuthorProfileReleaseCopy {
  if (pagesLive) {
    return {
      addressHint:
        "The address stays the same if you unpublish and publish again, even if you change your name.",
      adminOverview:
        "Open a staff member's profile to correct it or take it off the public site. Profile changes are recorded in the activity log and do not change anyone's role or access.",
      adminPublishedBadge: "Published",
      adminPublishedDescription: (publicPath) =>
        `This profile is public${publicPath ? ` at ${publicPath}` : ""}. Withdrawing takes that page down. Their published work stays online, and they keep their CMS access.`,
      adminPublishingDescription:
        "Publishing puts the person's name, job title, bio, photo and links on a public page anyone can read, and links their published work to it. Withdrawing takes that page down. Their work stays published either way.",
      adminStateColumn: "Public profile",
      photoDescription: (who) =>
        `Optional. A square crop of ${who} photo appears beside ${who} published work.`,
      publishedStatus: (publicPath) =>
        `Your profile is published${publicPath ? ` at ${publicPath}` : ""}.`,
      publishingDescription:
        "Publishing puts your name, job title, bio, photo and links on a public page anyone can read, and links your published work to it. Unpublishing takes that page down. Your work stays published either way.",
      selfProfileDescription: (profileIsPublished) =>
        profileIsPublished
          ? "This is what readers see beside your work on njpbs.org. Saving your profile updates the public page."
          : "This is what readers will see beside your work on njpbs.org. Saving keeps your profile in the CMS. Nothing from this profile appears on the public site until the profile is published.",
    };
  }

  return {
    addressHint:
      "The reserved address stays the same if you unpublish and publish again, even if you change your name.",
    adminOverview:
      "Open a staff member's profile to correct it or withdraw its published profile data. Self-service profile publication is paused. Profile changes are recorded in the activity log and do not change anyone's role or access.",
    adminPublishedBadge: "Published in CMS",
    adminPublishedDescription: (publicPath) =>
      `This profile is marked published in the CMS${publicPath ? ` at ${publicPath}` : ""}. Self-service profile publication is paused. Withdrawing removes its public profile data; confirm removal on the public site. Their published work stays online, and they keep their CMS access.`,
    adminPublishingDescription:
      "Self-service profile publication is paused. Administrators can still publish profiles. Publishing puts the person's name, job title, bio, photo and links on a public page anyone can read. Published profiles can still be updated or unpublished.",
    adminStateColumn: "Profile state",
    photoDescription: (who) =>
      `Optional. Use a square crop of ${who} photo for the public profile. Self-service profile publication is paused.`,
    publishedStatus: (publicPath) =>
      `Your profile is marked published in the CMS${publicPath ? ` at ${publicPath}` : ""}. Self-service profile publication is paused.`,
    publishingDescription:
      "Self-service profile publication is paused. Administrators can still publish profiles. Publishing puts the person's name, job title, bio, photo and links on a public page anyone can read. Published profiles can still be updated or unpublished.",
    selfProfileDescription: (profileIsPublished) =>
      profileIsPublished
        ? "This profile is marked published in the CMS. Saving updates its public profile data. Check the public page to confirm changes. Self-service profile publication is paused."
        : "Saving keeps your profile in the CMS. Your private profile is not public. Self-service profile publication is paused.",
  };
}

export const AUTHOR_PROFILE_RELEASE_COPY = buildAuthorProfileReleaseCopy(
  AUTHOR_PAGES_LIVE,
);

interface AuthorPhotoActionCopyOptions {
  assetSource: AuthorPhotoAssetSource;
  profileIsPublished: boolean;
  saveMode: AuthorPhotoSaveMode;
  subject: AuthorPhotoSubject;
}

/** Explain the file, save, and release effects of one photo choice. */
export function authorPhotoActionCopy({
  assetSource,
  profileIsPublished,
  saveMode,
  subject,
}: AuthorPhotoActionCopyOptions): string {
  const profile = subject === "self" ? "your profile" : "this profile";
  const action =
    assetSource === "library"
      ? saveMode === "immediate"
        ? `This uses the existing media asset and saves it to ${profile}. It does not upload another copy.`
        : `This uses the existing media asset. It does not upload another copy. Save ${profile} to attach it.`
      : saveMode === "immediate"
        ? `This action uploads the photo and saves it to ${profile}.`
        : `Uploading adds the photo to the media library. Save ${profile} to attach it.`;

  if (AUTHOR_PAGES_LIVE) {
    return profileIsPublished
      ? `${action} Saving the photo updates the public profile.`
      : `${action} The photo can appear after the profile is published.`;
  }

  return profileIsPublished
    ? `${action} This profile is marked published in the CMS. Saved photo changes update its public profile data. Check the public page to confirm changes.`
    : subject === "other"
      ? `${action} This profile is private. An administrator can publish it, making this photo public.`
      : `${action} This profile is private. The photo can appear publicly after the profile is published; self-service profile publication is paused.`;
}

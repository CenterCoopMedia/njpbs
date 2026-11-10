import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  projectPublishedCmsSettings,
  type CmsSettingsPublishedSnapshot,
} from "../../../packages/content-core/src/cms-settings.ts";

export { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID };

export interface PublicHomepageBannerDocument {
  id: string;
  [key: string]: unknown;
}

export interface PublicHomepageBannerBuildData {
  settingId: typeof PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID;
  enabled: boolean;
  message: string;
  link?: { label: string; href: string };
  secondLink?: { label: string; href: string };
  njDecides?: boolean;
  liveLabel?: string;
  startsAt?: string;
  endsAt?: string;
  excludedPaths?: readonly string[];
  sourceVersion: number;
  publishedAt: string;
}

export interface ProjectedPublicHomepageBanner {
  data: PublicHomepageBannerBuildData;
  publishedSnapshot: CmsSettingsPublishedSnapshot;
}

/**
 * Project the one published public homepage setting.
 *
 * Missing and unpublished documents produce no artifact. A present published
 * snapshot is strict: the shared settings contract validates and canonicalizes
 * it before any value can enter the public bundle. Working values are ignored.
 */
export function projectPublicHomepageBannerArtifact(
  document: PublicHomepageBannerDocument | undefined,
): ProjectedPublicHomepageBanner | null {
  if (document === undefined) return null;
  if (document.id !== PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID) {
    throw new Error("The public homepage banner document id is invalid");
  }
  let snapshot: CmsSettingsPublishedSnapshot | null;
  try {
    snapshot = projectPublishedCmsSettings({
      documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      document,
    });
  } catch (error) {
    throw new Error(
      `The public homepage banner published snapshot is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!snapshot) return null;
  const values = snapshot.values as {
    enabled: boolean;
    message: string;
    linkLabel?: string;
    linkHref?: string;
    secondLinkLabel?: string;
    secondLinkHref?: string;
    njDecides?: boolean;
    liveLabel?: string;
    startsAt?: string;
    endsAt?: string;
    excludedPaths?: readonly string[];
  };
  const hasLink =
    typeof values.linkLabel === "string" &&
    values.linkLabel.trim() !== "" &&
    typeof values.linkHref === "string" &&
    values.linkHref.trim() !== "";
  return {
    data: {
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: values.enabled,
      message: values.message,
      ...(hasLink
        ? { link: { label: values.linkLabel!, href: values.linkHref! } }
        : {}),
      ...(hasLink && values.secondLinkLabel?.trim() && values.secondLinkHref?.trim()
        ? { secondLink: { label: values.secondLinkLabel, href: values.secondLinkHref } }
        : {}),
      ...(typeof values.njDecides === "boolean"
        ? { njDecides: values.njDecides }
        : {}),
      ...(typeof values.liveLabel === "string"
        ? { liveLabel: values.liveLabel }
        : {}),
      ...(typeof values.startsAt === "string"
        ? { startsAt: values.startsAt }
        : {}),
      ...(typeof values.endsAt === "string"
        ? { endsAt: values.endsAt }
        : {}),
      ...(values.excludedPaths ? { excludedPaths: [...values.excludedPaths] } : {}),
      sourceVersion: snapshot.sourceVersion,
      publishedAt: snapshot.publishedAt,
    },
    publishedSnapshot: snapshot,
  };
}

export function projectPublicHomepageBanner(
  document: PublicHomepageBannerDocument | undefined,
): PublicHomepageBannerBuildData | null {
  return projectPublicHomepageBannerArtifact(document)?.data ?? null;
}


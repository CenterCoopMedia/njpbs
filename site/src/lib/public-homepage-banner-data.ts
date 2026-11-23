import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  activeHomepageBannerContent,
  projectPublishedCmsSettings,
  type CmsSettingsPublishedSnapshot,
  type LegacyHomepageBannerSettingsValues,
  type PublicHomepageBannerSettingsValues,
  type StandardHomepageBannerPresentation,
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
  standardPresentation?: StandardHomepageBannerPresentation;
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
  const stored = snapshot.values as unknown as PublicHomepageBannerSettingsValues | LegacyHomepageBannerSettingsValues;
  const values = activeHomepageBannerContent(stored);
  const { njDecides } = values;
  let standardPresentation: StandardHomepageBannerPresentation | undefined;
  if ("standard" in stored && !njDecides) {
    const { startsAt, endsAt, backgroundColor, textColor, linkColor } = stored.standard;
    if (startsAt || endsAt || backgroundColor || textColor || linkColor) {
      standardPresentation = {
        ...(startsAt ? { startsAt } : {}),
        ...(endsAt ? { endsAt } : {}),
        ...(backgroundColor ? { backgroundColor } : {}),
        ...(textColor ? { textColor } : {}),
        ...(linkColor ? { linkColor } : {}),
      };
    }
  }
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
      ...(typeof njDecides === "boolean"
        ? { njDecides }
        : {}),
      ...(typeof values.liveLabel === "string"
        ? { liveLabel: values.liveLabel }
        : {}),
      ...(!standardPresentation && typeof values.startsAt === "string"
        ? { startsAt: values.startsAt }
        : {}),
      ...(!standardPresentation && typeof values.endsAt === "string"
        ? { endsAt: values.endsAt }
        : {}),
      ...(values.excludedPaths ? { excludedPaths: [...values.excludedPaths] } : {}),
      ...(standardPresentation ? { standardPresentation } : {}),
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


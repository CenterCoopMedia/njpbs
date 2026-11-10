import type { PostsBrowseConfig } from "../../../packages/content-core/src/posts-browse.ts";
import type { Loader } from "astro/loaders";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import {
  SITE_NAVIGATION_SETTINGS_ID,
  projectPublishedCmsSettings,
  type CmsSettingsPublishedSnapshot,
  type SiteNavigationColumn,
  type SiteNavigationLink,
} from "../../../packages/content-core/src/cms-settings.ts";
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";

export { SITE_NAVIGATION_SETTINGS_ID };

export interface SiteNavigationDocument {
  id: string;
  [key: string]: unknown;
}

export interface SiteNavigationBuildData {
  postsBrowse?: PostsBrowseConfig;
  settingId: typeof SITE_NAVIGATION_SETTINGS_ID;
  header: SiteNavigationLink[];
  footer: SiteNavigationColumn[];
  sourceVersion: number;
  publishedAt: string;
}

/**
 * The outcome of one cutoff read.
 *
 * `published` enters the bundle. Every other status renders
 * DEFAULT_SITE_NAVIGATION. `invalid` keeps the snapshot's source version when it
 * is addressable, so the receipt can record the fallback for that exact version
 * and a navigation-only publication can still activate.
 */
export type ProjectedSiteNavigation =
  | {
      status: "published";
      data: SiteNavigationBuildData;
      publishedSnapshot: CmsSettingsPublishedSnapshot;
    }
  | { status: "missing" }
  | { status: "unpublished" }
  | { status: "invalid"; sourceVersion: number | null; reason: string };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addressableSourceVersion(document: SiteNavigationDocument): number | null {
  const published = document.published;
  if (!plainObject(published)) return null;
  const sourceVersion = published.sourceVersion;
  return Number.isSafeInteger(sourceVersion) && Number(sourceVersion) >= 1
    ? Number(sourceVersion)
    : null;
}

/**
 * Project the published site navigation without ever failing the build.
 *
 * Navigation is part of every public page. A missing document, an unpublished
 * document, or a snapshot that no longer passes the shared settings contract
 * renders the committed seed instead. Working values are ignored.
 */
export function projectSiteNavigationArtifact(
  document: SiteNavigationDocument | undefined,
): ProjectedSiteNavigation {
  if (document === undefined) return { status: "missing" };
  if (document.id !== SITE_NAVIGATION_SETTINGS_ID) {
    throw new Error("The site navigation document id is invalid");
  }
  let snapshot: CmsSettingsPublishedSnapshot | null;
  try {
    snapshot = projectPublishedCmsSettings({
      documentId: SITE_NAVIGATION_SETTINGS_ID,
      document,
    });
  } catch (error) {
    return {
      status: "invalid",
      sourceVersion: addressableSourceVersion(document),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!snapshot) return { status: "unpublished" };
  const values = snapshot.values as {
    header: SiteNavigationLink[];
    footer: SiteNavigationColumn[];
    postsBrowse?: PostsBrowseConfig;
  };
  return {
    status: "published",
    data: {
      settingId: SITE_NAVIGATION_SETTINGS_ID,
      header: values.header,
      footer: values.footer,
      ...(values.postsBrowse ? { postsBrowse: values.postsBrowse } : {}),
      sourceVersion: snapshot.sourceVersion,
      publishedAt: snapshot.publishedAt,
    },
    publishedSnapshot: snapshot,
  };
}

/** Read only the immutable, cutoff-bound public bundle. */
export function siteNavigationLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-site-navigation-preview-${previewInput.sha256}`
      : "cms-site-navigation-artifact-v3",
    load: async ({ store, logger, parseData }) => {
      store.clear();
      if (!previewInput && !artifactBundlePath) {
        logger.info("site navigation loader: no public artifact bundle; the layout renders the seed.");
        return;
      }
      const bundle = previewContent
        ? await previewContent.load()
        : await readPublicArtifactBundle(artifactBundlePath!);
      const navigation = bundle.settings.find(
        (setting) => setting.settingId === SITE_NAVIGATION_SETTINGS_ID,
      );
      if (!navigation) {
        logger.info("site navigation loader: no published navigation in the bundle; the layout renders the seed.");
        return;
      }
      store.set({
        id: SITE_NAVIGATION_SETTINGS_ID,
        data: await parseData({ id: SITE_NAVIGATION_SETTINGS_ID, data: { ...navigation } }),
      });
      logger.info(
        `site navigation loader: loaded published navigation version ${navigation.sourceVersion}.`,
      );
    },
  };
}

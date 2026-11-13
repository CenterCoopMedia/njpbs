import { COVERAGE_LABELS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { STORY_CTAS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import type { Loader } from "astro/loaders";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import {
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  projectPublishedCmsSettings,
  type CmsSettingsPublishedSnapshot,
  type PublicSiteChromeSettingsValues,
} from "../../../packages/content-core/src/cms-settings.ts";
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";

export { PUBLIC_SITE_CHROME_SETTINGS_ID };

export interface PublicSiteChromeDocument {
  id: string;
  [key: string]: unknown;
}

export interface PublicSiteChromeBuildData extends PublicSiteChromeSettingsValues {
  settingId: typeof PUBLIC_SITE_CHROME_SETTINGS_ID;
  sourceVersion: number;
  publishedAt: string;
}

/**
 * The outcome of one cutoff read. It follows the site navigation contract:
 * only `published` enters the bundle, and every other status renders the
 * source default. `invalid` keeps an addressable source version so the receipt
 * can record the fallback and a chrome-only publication can still activate.
 */
export type ProjectedPublicSiteChrome =
  | {
      status: "published";
      data: PublicSiteChromeBuildData;
      publishedSnapshot: CmsSettingsPublishedSnapshot;
    }
  | { status: "missing" }
  | { status: "unpublished" }
  | { status: "invalid"; sourceVersion: number | null; reason: string };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addressableSourceVersion(document: PublicSiteChromeDocument): number | null {
  const published = document.published;
  if (!plainObject(published)) return null;
  const sourceVersion = published.sourceVersion;
  return Number.isSafeInteger(sourceVersion) && Number(sourceVersion) >= 1
    ? Number(sourceVersion)
    : null;
}

/**
 * Project the published public-site chrome without ever failing the build.
 * Working values are ignored.
 */
export function projectPublicSiteChromeArtifact(
  document: PublicSiteChromeDocument | undefined,
): ProjectedPublicSiteChrome {
  if (document === undefined) return { status: "missing" };
  if (document.id !== PUBLIC_SITE_CHROME_SETTINGS_ID) {
    throw new Error("The public-site chrome document id is invalid");
  }
  let snapshot: CmsSettingsPublishedSnapshot | null;
  try {
    snapshot = projectPublishedCmsSettings({
      documentId: PUBLIC_SITE_CHROME_SETTINGS_ID,
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
  const values = snapshot.values as unknown as PublicSiteChromeSettingsValues;
  return {
    status: "published",
    data: {
      settingId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      ...values,
      sourceVersion: snapshot.sourceVersion,
      publishedAt: snapshot.publishedAt,
    },
    publishedSnapshot: snapshot,
  };
}

/** Read only the immutable, cutoff-bound public bundle. */
export function publicSiteChromeLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-public-site-chrome-preview-${previewInput.sha256}`
      : "cms-public-site-chrome-artifact-v1",
    load: async ({ store, logger, parseData }) => {
      store.clear();
      if (!previewInput && !artifactBundlePath) {
        logger.info("public-site chrome loader: no public artifact bundle; the layout renders the default.");
        return;
      }
      const bundle = previewContent
        ? await previewContent.load()
        : await readPublicArtifactBundle(artifactBundlePath!);
      const chrome = bundle.settings.filter(
        (setting) => setting.settingId === STORY_CTAS_SETTINGS_ID || setting.settingId === COVERAGE_LABELS_SETTINGS_ID || setting.settingId === PUBLIC_SITE_CHROME_SETTINGS_ID || setting.settingId === NJ_DECIDES_SETTINGS_ID,
      );
      for (const setting of chrome) store.set({
        id: setting.settingId,
        data: await parseData({ id: setting.settingId, data: { ...setting } }),
      });
      logger.info(
        `public-site chrome loader: loaded ${chrome.length} published setting(s).`,
      );
    },
  };
}

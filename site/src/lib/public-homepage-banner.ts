import type { Loader } from "astro/loaders";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, type PublicHomepageBannerBuildData } from "./public-homepage-banner-data.ts";
export * from "./public-homepage-banner-data.ts";
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";

/** Read only the immutable, cutoff-bound public bundle. */
export function publicHomepageBannerLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-public-homepage-banner-preview-${previewInput.sha256}`
      : "cms-public-homepage-banner-artifact-v3",
    load: async ({ store, logger, parseData }) => {
      store.clear();
      if (!previewInput && !artifactBundlePath) {
        logger.info("public homepage banner loader: no public artifact bundle; skipping.");
        return;
      }
      const bundle = previewContent
        ? await previewContent.load()
        : await readPublicArtifactBundle(artifactBundlePath!);
      // Site navigation shares the bundle's settings list and has its own collection.
      const banners = bundle.settings.filter(
        (setting): setting is PublicHomepageBannerBuildData =>
          setting.settingId === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      );
      for (const setting of banners) {
        store.set({
          id: setting.settingId,
          data: await parseData({ id: setting.settingId, data: { ...setting } }),
        });
      }
      logger.info(
        `public homepage banner loader: loaded ${banners.length} setting(s) from the exact public artifact bundle.`,
      );
    },
  };
}

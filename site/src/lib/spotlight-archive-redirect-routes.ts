import type { AstroIntegration } from "astro";
import { SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS } from "../../../packages/content-core/src/spotlight-archive-paths";
import { cmsRoutedContentEnabled } from "./build-target";
import { resolveCmsPreviewInput } from "./cms-preview-input";

export const spotlightArchiveRedirectRoutes: AstroIntegration = {
  name: "njpbs-spotlight-archive-redirects",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      if (!cmsRoutedContentEnabled(process.env) || process.env.CMS_PREVIEW_EXPORT_PATH || resolveCmsPreviewInput()) return;
      injectRoute({
        pattern: `${SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS}[shard].json`,
        entrypoint: "./src/pages/_spotlight-archive-redirects/[shard].json.ts",
      });
    },
  },
};

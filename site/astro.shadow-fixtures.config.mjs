import productionConfig from "./astro.config.mjs";
import { defineConfig } from "astro/config";
import { spotlightArchiveRedirectRoutes } from "./src/lib/spotlight-archive-redirect-routes.ts";
export default defineConfig({
  site: "https://njpbs.org",
  srcDir: "./tests/fixtures/shadow-posts/static",
  cacheDir: "./.public-post-fixture-cache",
  outDir: "./.shadow-static-fixtures",
  output: "static",
  // Use the ordinary production image policy as the independent oracle.
  image: productionConfig.image,
  integrations: [spotlightArchiveRedirectRoutes],
  build: { format: "directory" },
});

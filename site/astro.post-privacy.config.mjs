import { defineConfig } from "astro/config";

// Compile only the retired Post privacy fixtures, apart from shadow parity output.
export default defineConfig({
  site: "https://njpbs.org",
  srcDir: "./tests/fixtures/shadow-posts/privacy",
  cacheDir: "./.astro/post-route-privacy/cache",
  outDir: "./.astro/post-route-privacy/dist",
  output: "static",
  image: { service: { entrypoint: "astro/assets/services/noop" }, remotePatterns: [] },
});

import { defineConfig } from "astro/config";

// Focused real-template metadata proof; no CMS loaders, credentials or site build.
export default defineConfig({
  site: "https://njpbs.org",
  srcDir: "./tests/fixtures/nj-decides-social",
  publicDir: "./tests/fixtures/nj-decides-social/public",
  cacheDir: "./.astro/nj-decides-social/cache",
  outDir: "./.astro/nj-decides-social/dist",
  image: { service: { entrypoint: "astro/assets/services/noop" }, remotePatterns: [] },
  integrations: [{ name: "nj-decides-social-routes", hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      // These fixed routes have no props; render the real entrypoints directly.
      injectRoute({ pattern: "/data-hub/", entrypoint: "./src/pages/data-hub/[...hub].astro", prerender: true });
      injectRoute({ pattern: "/staff/", entrypoint: "./src/pages/staff/[...index].astro", prerender: true });
    },
  } }],
});

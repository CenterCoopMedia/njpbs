import { defineConfig } from "astro/config";
import productionConfig from "./astro.config.mjs";
export default defineConfig({
  site: "https://njpbs.org", srcDir: "./tests/fixtures/published-pages/static",
  cacheDir: "./.public-page-fixture-cache",
  outDir: "./.public-page-static-fixtures", output: "static", image: productionConfig.image,
  markdown: productionConfig.markdown,
  build: { format: "directory" }, integrations: [{ name: "public-page-parity-routes", hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({ pattern: "/", entrypoint: "./src/pages/index.astro", prerender: true });
      injectRoute({ pattern: "/[...slug]", entrypoint: "./src/pages/[...slug].astro", prerender: true });
      injectRoute({ pattern: "/staff/", entrypoint: "./src/pages/staff/[...index].astro", prerender: true });
    },
  } }],
});

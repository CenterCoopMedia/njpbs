import { defineConfig } from "astro/config";
import productionConfig from "./astro.config.mjs";
export default defineConfig({ site: "https://njpbs.org", srcDir: "./tests/fixtures/published-records/static",
  cacheDir: "./.public-page-static-fixtures/record-cache",
  outDir: "./.public-page-static-fixtures/records", output: "static", image: productionConfig.image,
  build: { format: "directory" }, integrations: [{ name: "public-record-parity-routes", hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      for (const family of ["programs", "events", "shows"]) {
        injectRoute({ pattern: `/${family}/`, entrypoint: `./src/pages/${family}/[...index].astro`, prerender: true });
        injectRoute({ pattern: `/${family}/[...slug]`, entrypoint: `./src/pages/${family}/[...slug].astro`, prerender: true });
      }
    },
  } }],
});

import shadowConfig from "./astro.shadow.config.mjs";
import { publicPostRenderEnvironment } from "./scripts/public-post-render-environment.ts";
import { createRequire } from "node:module";
import compiledRendererAdapter from "./scripts/compiled-renderer-adapter.mjs";
const targetContract = createRequire(import.meta.url)("../functions/lib/publication-target.js");
const environment = publicPostRenderEnvironment(process.env);
const target = targetContract.publicationTarget(environment.CMS_DEPLOYMENT_ENVIRONMENT);
export default {
  ...shadowConfig,
  adapter: compiledRendererAdapter({ publicPostsOnly: true, publicPages: true, publicRecords: true }),
  outDir: "./.public-post-renderer",
  build: { ...shadowConfig.build, assetsPrefix: `${target.origin}/posts/_no-build-assets` },
  // Public templates run in workerd, which has no Node process global. Seal the
  // render environment at compilation; never copy the publisher's environment.
  vite: { ...shadowConfig.vite, define: { "process.env": JSON.stringify(environment),
    __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__: JSON.stringify(target.environment) },
    plugins: [{ name: "sealed-public-schedule", enforce: "pre",
      resolveId(source) {
        if (/\/schedule-data(?:\.ts)?$/.test(source)) return new URL("./src/lib/published-schedule-data.ts", import.meta.url).pathname;
      },
    }],
  },
};

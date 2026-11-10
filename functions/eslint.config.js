"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // Generated from checked TypeScript source; do not lint esbuild output.
  { ignores: ["lib/cms-image-variants.js", "lib/data-hub-composition.js", "lib/data-hub-reporting.js", "lib/data-hub-reporting-sources.js", "lib/datasets.js",
      "lib/data-figure.js", "lib/live-blog.js", "lib/election-results.js", "lib/election-result-sources.js", "lib/county-comparison.js", "lib/town-lookup.js",
      "lib/dataset-figures.js", "lib/cost-hardware.js", "lib/post-lead-media.js", "lib/post-formats.js", "lib/data-table.js", "lib/block-content-validation.js", "lib/published-resource-check.js", "lib/bio-profiles.js", "lib/video-block.js", "lib/home-source-catalog.js", "lib/home-retained-sources.js", "lib/home-newscast-data.js", "lib/home-hero.js", "lib/published-vocabulary.js", "lib/content-link.js", "lib/posts-browse-contract.js"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },
];

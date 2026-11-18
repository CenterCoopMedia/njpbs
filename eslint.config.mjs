import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const fromFunctions = createRequire(new URL("./functions/package.json", import.meta.url));
const fromSite = createRequire(new URL("./site/package.json", import.meta.url));
const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];

function functionsConfig() {
  const globals = fromFunctions("globals");
  // These committed outputs are regenerated from TypeScript.
  const generated = [
    "cms-image-variants", "data-hub-composition", "data-hub-reporting", "data-hub-reporting-sources",
    "datasets", "data-figure", "live-blog", "election-results", "election-result-sources",
    "county-comparison", "town-lookup", "dataset-figures", "cost-hardware", "post-lead-media",
    "post-formats", "data-table", "block-content-validation", "published-resource-check",
    "bio-profiles", "video-block", "home-source-catalog", "home-retained-sources", "home-newscast-data",
    "home-hero", "published-vocabulary", "content-link", "posts-browse-contract",
  ];

  return [
    { ignores: generated.map((name) => `lib/${name}.js`) },
    fromFunctions("@eslint/js").configs.recommended,
    { languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: globals.node } },
    { files: ["**/*.mjs"], languageOptions: { sourceType: "module" } },
  ];
}

function astroAccessibility(astro) {
  return [
    { ignores: ["dist/**", ".astro/**"] },
    ...astro.configs["jsx-a11y-recommended"],
    {
      files: ["**/*.astro"],
      rules: {
        // The homepage program rails are keyboard-focusable scroll containers.
        "astro/jsx-a11y/no-noninteractive-tabindex": [
          "error",
          { tags: [], roles: ["tabpanel", "group"], allowExpressionValues: true },
        ],
      },
    },
  ];
}

function reportConfig() {
  const { defineConfig } = fromSite("eslint/config");
  const astro = fromSite("eslint-plugin-astro");
  const globals = fromSite("globals");
  const ts = fromSite("typescript-eslint");
  const hooks = fromSite("eslint-plugin-react-hooks");
  const scriptFiles = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

  return defineConfig(
    { files: scriptFiles, extends: [fromSite("@eslint/js").configs.recommended] },
    { files: typescriptFiles, extends: [ts.configs.recommended] },
    ...astro.configs.recommended,
    ...astroAccessibility(astro),
    { files: scriptFiles, languageOptions: { globals: globals.node } },
    {
      files: ["**/*.{jsx,tsx}"],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    {
      files: ["admin/src/**", "admin/public/**", "site/src/**"],
      languageOptions: { globals: globals.browser },
    },
    {
      files: ["workers/**", "cms-api/src/**", "site/worker*/**", "admin/public/*-sw.js"],
      languageOptions: { globals: globals.serviceworker },
    },
    { files: ["functions/**/*.js"], languageOptions: { sourceType: "commonjs" } },
    {
      files: ["admin/**/*.{js,jsx,ts,tsx}", "**/*.{jsx,tsx}"],
      plugins: { "react-hooks": hooks },
      rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
    },
    {
      files: [...scriptFiles, "**/*.astro"],
      rules: {
        "max-lines-per-function": ["error", { max: 200, IIFEs: true }],
        complexity: ["warn", 20],
      },
    },
  );
}

// The package commands keep their existing scopes and required rules.
const cwd = process.cwd();
export default cwd === fileURLToPath(new URL("./functions", import.meta.url)) ? functionsConfig()
  : cwd === fileURLToPath(new URL("./site", import.meta.url))
    ? astroAccessibility(fromSite("eslint-plugin-astro"))
    : reportConfig();

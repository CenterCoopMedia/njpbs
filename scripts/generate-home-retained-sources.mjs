// After inspecting a regenerated bundle, pin its Git blob in functionGraphSource
// and run the committed renderer graph tests.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

await build({
  entryPoints: ["site/src/lib/home-retained-sources-entry.ts"],
  outfile: "functions/lib/home-retained-sources.js",
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  preserveSymlinks: true,
  // Functions deployment contains lib/, rather than the Site source layout.
  // createRequire must resolve these existing runtime modules beside this output.
  plugins: [{ name: "functions-reader-requires", setup(builder) {
    builder.onLoad({ filter: /(?:cms-current-code-context|public-artifact-inventory)\.ts$/ }, async ({ path }) => ({
      loader: "ts", contents: (await readFile(path, "utf8")).replace(
        /\b(require|requireModule)\(\s*(["'])(?:\.\.\/)+functions\/lib\/([^"']+)\2/g,
        (_match, method, quote, module) => `${method}(${quote}./${module}${quote}`),
    }));
  } }],
  define: { "import.meta.url": "__generatedReaderModuleUrl" },
  banner: { js: "// Generated from site/src/lib/home-retained-sources-entry.ts.\n// Regenerate with: node scripts/generate-home-retained-sources.mjs\n\"use strict\";\nconst __generatedReaderModuleUrl = require(\"node:url\").pathToFileURL(__filename).href;" },
});

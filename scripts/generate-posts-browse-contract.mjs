import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../functions/lib/posts-browse-contract.js", import.meta.url);
const result = await build({
  stdin: { contents: 'export { validatePostsBrowse } from "./packages/content-core/src/posts-browse.ts";', resolveDir: root },
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none", write: false,
  banner: { js: "// Generated from packages/content-core/src/posts-browse.ts.\n// Regenerate with: node scripts/generate-posts-browse-contract.mjs" },
});
const text = result.outputFiles[0].text;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== text) throw new Error("Posts browsing contract needs regeneration.");
} else await writeFile(output, text);

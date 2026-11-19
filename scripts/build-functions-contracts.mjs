import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const generators = [
  ["bio-profiles"],
  ["block-content-validation"],
  ["cms-image-variants"],
  ["content-link"],
  ["cost-hardware"],
  ["county-comparison"],
  ["data-figure", ["data-figure", "dataset-figures"]],
  ["data-hub-composition"],
  ["data-hub-reporting"],
  ["data-hub-reporting-sources"],
  ["data-table-contract", ["data-table"]],
  ["datasets"],
  ["election-result-sources"],
  ["election-results"],
  ["home-hero"],
  ["home-newscast-data"],
  ["home-retained-sources"],
  ["home-source-catalog"],
  ["live-blog"],
  ["live-production", ["live-production-contract"]],
  ["post-format-contract", ["post-formats"]],
  ["post-lead-media"],
  ["posts-browse-contract"],
  ["published-resource-check"],
  ["published-vocabulary"],
  ["town-lookup"],
  ["video-block"],
];

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || (mode && mode !== "--preflight")) {
  throw new Error("Usage: npm run functions:build [-- --preflight]");
}

// Some generators resolve input and output paths from the repository root.
process.chdir(root);
await Promise.all(generators.map(([name]) => import(`./generate-${name}.mjs`)));

// Local preflight exercises edits immediately. Hosted preflight also checks
// the committed bytes because the deploy path still consumes them.
if (mode === "--preflight" && process.env.GITHUB_ACTIONS === "true") {
  const paths = generators.flatMap(([name, outputs = [name]]) =>
    outputs.map(output => `functions/lib/${output}.js`));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
  const committed = new Set(git("ls-tree", "-rz", "--name-only", "HEAD", "--", ...paths));
  const changed = git("diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--", ...paths);
  const stale = [...paths.filter(path => !committed.has(path)), ...changed];
  if (stale.length) {
    throw new Error(`Commit the outputs from npm run functions:build:\n${stale.join("\n")}`);
  }
  console.log(`${paths.length} committed Functions contracts match the build.`);
}

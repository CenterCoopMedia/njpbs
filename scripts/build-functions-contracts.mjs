import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || (mode && mode !== "--preflight")) {
  throw new Error("Usage: npm run functions:build [-- --preflight]");
}

const scripts = new URL("./", import.meta.url);
const generators = readdirSync(scripts).sort()
  .filter(name => /^generate-.+\.mjs$/.test(name))
  .flatMap(name => {
    // The data-figure generator writes two entry points to a shared directory.
    if (name === "generate-data-figure.mjs") {
      return [{ name, outputs: ["functions/lib/data-figure.js", "functions/lib/dataset-figures.js"] }];
    }
    const source = readFileSync(new URL(name, scripts), "utf8");
    const output = source.match(/\boutfile:\s*"(functions\/lib\/[^"\n]+\.js)"/)?.[1];
    return output ? [{ name, outputs: [output] }] : [];
  });

// Some generators resolve input and output paths from the repository root.
process.chdir(fileURLToPath(new URL("../", scripts)));
await Promise.all(generators.map(({ name }) => import(new URL(name, scripts))));

// Local preflight exercises edits immediately. Hosted preflight also checks
// the committed bytes because the deploy path still consumes them.
if (mode === "--preflight" && process.env.GITHUB_RUN_ID) {
  const paths = new Set(generators.flatMap(({ outputs }) => outputs));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
  const committed = new Set(git("grep", "-zl", "^// Generated from ", "HEAD", "--", "functions/lib")
    .map(path => path.slice("HEAD:".length)));
  const changed = git("diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--", ...paths);
  const stale = new Set([
    ...[...paths].filter(path => !committed.has(path)),
    ...[...committed].filter(path => !paths.has(path)),
    ...changed,
  ]);
  if (stale.size) {
    throw new Error(`Generated Functions outputs differ from the commit. Run npm run functions:build and check these paths:\n${[...stale].join("\n")}`);
  }
  console.log(`${paths.size} committed Functions contracts match the build.`);
}

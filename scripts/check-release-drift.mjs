#!/usr/bin/env node
// Read-only drift check of the checked-out commit against one CMS target: docs/release/drift-check.md.
//   node scripts/check-release-drift.mjs <development|production> [--source <sha>] [--after] [--compare <facts.json>] [--facts <out.json>]
// The checker and the live-part list come from this checkout; the source commit is read through git only, never run.
// Exit 1 when a stopping check fails (with --after, also when a live part differs from this commit).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { functionsPaths, rendererPaths } from "./lib/cms-release-paths.mjs";
import { cmsTarget } from "./lib/cms-target.mjs";
import { checkReleaseDrift } from "./lib/release-drift.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  after: { type: "boolean", default: false }, source: { type: "string" }, compare: { type: "string" }, facts: { type: "string" } } });
const [environment] = positionals;
if (!["development", "production"].includes(environment) || positionals.length !== 1) {
  console.error("Usage: check-release-drift.mjs <development|production> [--source <sha>] [--after] [--compare <facts.json>] [--facts <out.json>]");
  process.exit(64);
}

// Variables arrive as one JSON object (toJSON(vars)), as in deploy-cms.mjs; a name set in the environment wins.
// config-input: CMS_DEPLOYMENT_VARIABLES_JSON
for (const [name, value] of Object.entries(JSON.parse(process.env.CMS_DEPLOYMENT_VARIABLES_JSON || "{}"))) process.env[name] ??= value;
const target = cmsTarget({ ...process.env, CMS_TARGET: environment });

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const sha = git("rev-parse", "--verify", `${values.source ?? "HEAD"}^{commit}`);
const lastChange = paths => git("log", "-1", "--format=%H", sha, "--", ...paths);
const gitFile = (commit, path) => execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const registryAt = commit => JSON.parse(git("show", `${commit}:config/release-surfaces.json`));

// The edge snippet as the README builds it, from the source's files and this checkout's locked esbuild.
// The files are unpacked under site/ so that package imports resolve to site/node_modules.
function snippetSha256() {
  const esbuild = resolve(root, "site/node_modules/.bin/esbuild");
  if (!existsSync(esbuild)) return undefined;
  const dir = mkdtempSync(resolve(root, "site/.drift-source-"));
  try {
    execFileSync("sh", ["-c", 'git archive "$1" site/snippets site/src packages | tar -x -C "$2"', "sh", sha, dir], { cwd: root });
    const bundle = execFileSync(esbuild, [resolve(dir, "site/snippets/legacy-redirects/snippet.js"), "--bundle", "--format=esm", "--platform=browser",
      "--target=es2022", "--minify", "--legal-comments=none"], { cwd: resolve(dir, "site"), maxBuffer: 1 << 20 });
    return createHash("sha256").update(bundle).digest("hex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const source = {
  sha,
  functionsSha: lastChange(functionsPaths),
  rendererSha: lastChange(rendererPaths),
  files: Object.fromEntries(["firestore.rules", "storage.rules"].map(path => [path, gitFile(sha, path)])),
  snippetSha256: snippetSha256(),
  async exportsAt(commit) {
    try { return new Set(registryAt(commit).functions.find(row => row.entrypoint === "functions/index.js").exports.map(e => e.name)); }
    catch { return null; }
  },
  async behind(liveSha) {
    const range = `${liveSha}..origin/main`;
    const commits = Number(git("rev-list", "--count", range));
    const oldest = git("log", "--reverse", "--format=%ct", range).split("\n")[0];
    return { commits, days: oldest ? Math.floor((Date.now() / 1000 - Number(oldest)) / 86400) : 0 };
  },
};

const compare = values.compare && existsSync(values.compare) && readFileSync(values.compare, "utf8").trim()
  ? JSON.parse(readFileSync(values.compare, "utf8")) : null;
console.log(`Release drift of ${environment} against ${sha}${values.after ? " (after a release)" : ""}`);
// The live parts are this checkout's list; the exported Functions are the source's.
const registry = JSON.parse(readFileSync(resolve(root, "config/release-surfaces.json"), "utf8"));
source.exported = await source.exportsAt(sha);
// The registry exists on main since Nov. 14, 2026, and production is newer; a release never goes back
// before it, so an older source is refused rather than compared (review decision, #680).
if (!source.exported) {
  console.log(`FAIL the source ${sha} predates config/release-surfaces.json; compare a commit from Nov. 14, 2026 or later`);
  process.exit(1);
}
const { lines, failed, facts } = await checkReleaseDrift({ target, registry, source, env: process.env,
  http: fetch, after: values.after, compare });
for (const line of lines) console.log(line);
if (values.facts) writeFileSync(values.facts, JSON.stringify(facts));
console.log(failed ? "Release drift: FAILED" : "Release drift: passed");
process.exit(failed ? 1 : 0);

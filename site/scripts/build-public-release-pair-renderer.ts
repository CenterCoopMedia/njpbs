import { assertDevelopmentSource } from "../../scripts/render-development-config.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { sealPublicReleasePairRenderer } from "./public-release-pair-renderer-release.mjs";
import { publicPostRenderEnvironment } from "./public-post-render-environment";
import { installPublicReleasePairSemanticEngine } from "./public-release-pair-semantic-engine";
import { installPublicReleasePairPagefindEngine } from "./public-release-pair-pagefind-engine";
import { PAIR_SEARCH_AUTHORITY_FILE, publicReleasePairSearchAuthorityBytes } from "./public-release-pair-search-authority";
import { PAIR_CONTENT_FEED_AUTHORITY_FILE, publicReleasePairContentFeedAuthorityBytes } from "./public-release-pair-content-feed-authority";
import { PAIR_SOURCE_INPUTS_FILE } from "./public-release-pair-source-inputs";
const site = fileURLToPath(new URL("..", import.meta.url));
const root = path.dirname(site);
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trimEnd();
const sha = git("rev-parse", "HEAD");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source-inputs" || !args[1])) throw new Error("Expected optional --source-inputs file");
const sourceInputs = args.length ? await readFile(path.resolve(args[1])) : null;
if (sourceInputs) {
  const refuse = () => { throw new Error("Pair source inputs differ"); };
  if (sourceInputs.length < 1 || sourceInputs.length > 4096) refuse();
  let value: any;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceInputs)); } catch { refuse(); }
  const cursor = value?.baselineCursor;
  if (!value || Object.keys(value).sort().join() !== "baselineCursor,logBaselineDigest,schemaVersion,sourceMemberCensusDigest" || value.schemaVersion !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.logBaselineDigest) || !/^[a-f0-9]{64}$/.test(value.sourceMemberCensusDigest) ||
      !cursor || Object.keys(cursor).sort().join() !== "baselineDigest,lastDigest,sequence" || !/^[a-f0-9]{64}$/.test(cursor.baselineDigest) ||
      !/^[a-f0-9]{64}$/.test(cursor.lastDigest) || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 ||
      cursor.sequence === 0 && cursor.lastDigest !== cursor.baselineDigest) refuse();
}
if (!assertDevelopmentSource(root)) throw new Error("Compile pair renderer from clean exact source");
const directory = path.join(site, ".public-post-renderer");
const existing = JSON.parse(await readFile(path.join(directory, "renderer-release.json"), "utf8"));
if (existing.rendererSha !== sha) throw new Error("Public renderer was compiled from another source");
const environment = publicPostRenderEnvironment({ ...process.env,
  CMS_DEPLOYMENT_ENVIRONMENT: process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? existing.environment ?? "production",
  DATA_HUB_PUBLIC: process.env.DATA_HUB_PUBLIC ?? (existing.dataHubReportingVersion === 1 ? "1" : undefined) }), dataHub = environment.DATA_HUB_PUBLIC === "1";
if ((existing.environment ?? "production") !== environment.CMS_DEPLOYMENT_ENVIRONMENT ||
    (existing.dataHubReportingVersion === 1) !== dataHub || (existing.dataHubCompositionVersion === 1) !== dataHub) {
  throw new Error("Private pair compiler target differs");
}
execFileSync(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"), "build", "--config", "astro.public-release-pair.config.mjs"], {
  cwd: site, env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...environment,
    ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York", CMS_COMPILED_RENDERER_SHA: sha }, stdio: "inherit",
});
await writeFile(path.join(directory, "renderer-release.json"), JSON.stringify(existing) + "\n");
await mkdir(path.join(directory, "runtime"), { recursive: true });
await build({ entryPoints: [path.join(site, "scripts/render-public-release-pair.ts")], outfile: path.join(directory, "runtime/pair.mjs"),
  banner: { js: 'import { createRequire as __pairRequire } from "node:module"; const require = __pairRequire(import.meta.url);' },
  bundle: true, platform: "node", format: "esm", target: "node22" });
// These bytes survive the private Astro compile and are part of the exact
// sealed graph. The source owner later compares sourceInputs to its real epoch
// receipt; a caller-supplied label cannot make a code pack qualify.
await writeFile(path.join(directory, PAIR_SEARCH_AUTHORITY_FILE), publicReleasePairSearchAuthorityBytes(sha), { flag: "wx", mode: 0o600 });
await writeFile(path.join(directory, PAIR_CONTENT_FEED_AUTHORITY_FILE), publicReleasePairContentFeedAuthorityBytes(sha), { flag: "wx", mode: 0o600 });
if (sourceInputs) await writeFile(path.join(directory, PAIR_SOURCE_INPUTS_FILE), sourceInputs, { flag: "wx", mode: 0o600 });
await installPublicReleasePairPagefindEngine(directory);
await installPublicReleasePairSemanticEngine(directory, process.env.PAIR_SEMANTIC_MODEL_CACHE);
if (git("rev-parse", "HEAD") !== sha || !assertDevelopmentSource(root)) throw new Error("Pair renderer source changed");
process.stdout.write(JSON.stringify(await sealPublicReleasePairRenderer(directory, sha)) + "\n");

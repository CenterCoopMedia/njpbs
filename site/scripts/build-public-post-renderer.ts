import { assertDevelopmentSource } from "../../scripts/render-development-config.mjs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataHubPageEnabled } from "../src/lib/build-target.ts";
import { publicPostRenderEnvironment } from "./public-post-render-environment";
import { publicationTarget } from "../../functions/lib/publication-target";
import pageReaderContract from "../../functions/lib/page-reader-contract.js";
const site = fileURLToPath(new URL("..", import.meta.url));
const repo = path.dirname(site);
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trimEnd();
const phase = process.argv[2];
if (process.argv.length > 3 || (phase && !["--compile-only", "--copy-assets", "--test-pages"].includes(phase))) throw new Error("Invalid public Post compile phase");
const testPages = phase === "--test-pages";
const sha = git("rev-parse", "HEAD");
const target = publicationTarget(testPages ? "development" : process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production");
const releaseSeal = { schemaVersion: 1, rendererSha: sha, liveBlogVersion: 1, electionResultsVersion: 2,
  pageReaderVersion: pageReaderContract.PAGE_READER_VERSION,
  ...(dataHubPageEnabled(process.env) ? { dataHubReportingVersion: 1, dataHubCompositionVersion: 1 } : {}),
  ...(target.environment === "development" ? { environment: "development" } : {}) };
const seal = path.join(site, testPages ? ".public-page-renderer/renderer-release.json" : ".public-post-renderer/renderer-release.json");
if (phase !== "--copy-assets") {
  if (!assertDevelopmentSource(repo)) throw new Error("Compile public Post templates from clean exact source");
  execFileSync(process.execPath, [path.join(site, "node_modules/astro/bin/astro.mjs"), "build", "--config",
    testPages ? "astro.public-page-renderer.config.mjs" : "astro.public-post.config.mjs"], {
    cwd: site, env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...publicPostRenderEnvironment(testPages
      ? { CMS_DEPLOYMENT_ENVIRONMENT: "development", DATA_HUB_PUBLIC: process.env.DATA_HUB_PUBLIC, PUBLIC_ONLY: process.env.PUBLIC_ONLY } : process.env), ASTRO_TELEMETRY_DISABLED: "1",
      TZ: "America/New_York", CMS_COMPILED_RENDERER_SHA: sha }, stdio: "inherit",
  });
  if (git("rev-parse", "HEAD") !== sha || !assertDevelopmentSource(repo)) throw new Error("Public Post source changed during compilation");
  await writeFile(seal, JSON.stringify(releaseSeal) + "\n");
}
if (phase !== "--compile-only" && !testPages) {
  const release = JSON.parse(await readFile(seal, "utf8"));
  // Workers Builds compiles before its approved syncs. Only those data outputs
  // may differ when copying the compiled client graph after the static build.
  const syncOutputs = ["site/src/data/launch-media-manager.json", "site/src/data/spotlight-news.json", "site/src/data/schedule.json"];
  if (!isDeepStrictEqual(release, releaseSeal) || !assertDevelopmentSource(repo, process.env, { allowedChanges: syncOutputs })) {
    throw new Error("Public Post source changed after compilation");
  }
  const assets = path.join(site, "dist/posts/_no-build-assets");
  await mkdir(assets, { recursive: true });
  await cp(path.join(site, ".public-post-renderer/client"), assets, { recursive: true });
  await writeFile(path.join(assets, "renderer-release.json"), JSON.stringify(release) + "\n");
}

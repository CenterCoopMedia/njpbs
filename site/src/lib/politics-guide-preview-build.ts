import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { parsePoliticsResource } from "../../../admin/src/lib/politics-resource";
import { parseElectionDirectory } from "../../../admin/src/lib/election-directory";
import { politicsGuidePreviewEnabled, type PoliticsPreviewAsset } from "./politics-guide-preview";

let presentation: Promise<Map<string, string>> | undefined;

function sourceRoot(): string {
  // Astro prerenders a bundled endpoint under site/dist, so import.meta.url
  // no longer names src/lib. Find this checkout from either module location.
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(directory, "admin/dev-preview/politics-guide.tsx")) && existsSync(path.join(directory, "site/package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the politics preview source checkout.");
    directory = parent;
  }
}

/** Server/build-only; never imported by a browser entry or a public page. */
export async function readPoliticsPreviewAsset(asset: PoliticsPreviewAsset, env: Record<string, string | undefined>): Promise<string> {
  if (!politicsGuidePreviewEnabled(env)) throw new Error("The politics guide preview is disabled for this build.");
  const repoRoot = sourceRoot();
  const siteRoot = path.join(repoRoot, "site");
  if (asset === "nj-politics.json" || asset === "nj-election-2026.json") {
    const fixtureMode = env.POLITICS_PREVIEW_FIXTURE_MODE === "1";
    if (fixtureMode && env.CI !== "true") throw new Error("Politics preview fixtures require CI=true.");
    const directory = fixtureMode ? "admin/tests/fixtures/resources" : "admin/private-resources";
    const value: unknown = JSON.parse(await readFile(path.join(repoRoot, directory, asset), "utf8"));
    if (asset === "nj-politics.json") parsePoliticsResource(value); else parseElectionDirectory(value);
    return `${JSON.stringify(value)}\n`;
  }
  if (asset !== "guide.js" && asset !== "guide.css") throw new Error("Unknown politics preview asset.");
  // A single compilation supplies both endpoints during one static build.
  presentation ??= build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, "admin/dev-preview/politics-guide.tsx")],
    bundle: true, write: false, format: "esm", target: "es2022", minify: true,
    jsx: "automatic", sourcemap: false, legalComments: "inline",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [path.join(siteRoot, "node_modules")],
    external: ["/brand/*"], outdir: "politics-preview-build",
  }).then(result => new Map(result.outputFiles.map(file => [file.path.endsWith(".css") ? "guide.css" : "guide.js", file.text]))).catch(error => { presentation = undefined; throw error; });
  const output = (await presentation).get(asset);
  if (!output) throw new Error(`Missing politics preview asset: ${asset}`);
  return output;
}

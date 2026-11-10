"use strict";
const { build } = require("esbuild");
const { mkdir, copyFile, cp, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function main() {
  const local = process.argv.includes("--local");
  const testOnly = process.argv.includes("--test");
  if (local && testOnly) throw new Error("Select one panel build profile");
  const configuredOrigin = require("./config.js").apiOrigin;
  if (!local && !testOnly && new URL(configuredOrigin).hostname.endsWith(".example.org"))
    throw new Error("Render CMS_PRODUCTION_API_ORIGIN in a disposable checkout before a panel release build");
  const directory = local ? "dist-local" : "dist";
  const destination = path.join(__dirname, directory);
  let revision = "";
  try {
    const git = args => execFileSync("git", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const { assertDevelopmentSource } = await import("../scripts/render-development-config.mjs");
    if (!testOnly && assertDevelopmentSource(path.resolve(__dirname, ".."))) revision = git(["rev-parse", "HEAD"]);
  } catch { /* Source archives and edited checkouts cannot claim a release revision. */ }
  await mkdir(destination, { recursive: true });
  await build({
    absWorkingDir: __dirname, entryPoints: ["index.js"], outfile: `${directory}/index.js`,
    bundle: true, format: "cjs", platform: "browser", target: "es2020",
    external: ["uxp", "premierepro", "fs", "os"],
    define: { __BOARDWALK_LOCAL__: String(local), __BOARDWALK_REVISION__: JSON.stringify(revision) },
  });
  const html = await readFile(path.join(__dirname, "index.html"), "utf8");
  // UXP treats link elements as stylesheets; native icons come from the manifest.
  await writeFile(path.join(destination, "index.html"), html.replace(/^\s*<link rel="icon"[^\r\n]*\r?\n/m, ""));
  await copyFile(path.join(__dirname, "index.css"), path.join(destination, "index.css"));
  const manifest = JSON.parse(await readFile(path.join(__dirname, "manifest.json"), "utf8"));
  if (testOnly) {
    manifest.id += ".test";
    manifest.name = "Boardwalk test";
    manifest.entrypoints[0].label.default = "Boardwalk test";
  }
  if (local) {
    manifest.id += ".local";
    manifest.name = "Boardwalk local";
    manifest.entrypoints[0].label.default = "Boardwalk local";
    manifest.requiredPermissions.network.domains = ["http://localhost/", "https://*.s3.us-east-2.amazonaws.com"];
    manifest.requiredPermissions.launchProcess.schemes = ["http"];
  }
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(destination, "build-receipt.json"), JSON.stringify({
    pluginId: manifest.id, pluginVersion: manifest.version, sourceRevision: revision || null, local, testOnly,
  }, null, 2) + "\n");
  await cp(path.join(__dirname, "icons"), path.join(destination, "icons"), { recursive: true });
  await mkdir(path.join(destination, "brand"), { recursive: true });
  await copyFile(path.join(__dirname, "../site/src/styles/design-tokens.css"), path.join(destination, "brand/tokens.css"));
  await copyFile(path.join(__dirname, "../admin/public/brand/njpbs-horizontal-white.svg"), path.join(destination, "brand/njpbs-horizontal-white.svg"));
  await copyFile(path.join(__dirname, "node_modules/js-sha256/LICENSE.txt"), path.join(destination, "sha256-license.txt"));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

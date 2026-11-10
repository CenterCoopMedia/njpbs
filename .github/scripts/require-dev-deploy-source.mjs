import { repositoryIdentity } from "../../scripts/lib/repository-identity.mjs";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devDeploySourceSha } from "../../scripts/lib/dev-deploy-source.mjs";
import { requireReleaseSource } from "./require-release-source.mjs";

export function requireDevDeploySource({ env, releaseRoot, trustedRoot }) {
  const sourceSha = devDeploySourceSha(env), trustedWorkflowSha = env.GITHUB_SHA;
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git(trustedRoot, "rev-parse", "HEAD") !== trustedWorkflowSha ||
      git(trustedRoot, "status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Dev trusted workflow checkout must match its immutable source");
  }
  const origin = git(releaseRoot, "remote", "get-url", "origin");
  const { repository } = repositoryIdentity(env);
  if (![
    `https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`,
  ].includes(origin)) throw new Error("Dev deploy canonical origin refused");
  requireReleaseSource({ sha: sourceSha, cwd: releaseRoot });
  git(releaseRoot, "merge-base", "--is-ancestor", sourceSha, trustedWorkflowSha);
  // These modes retain their exact-workflow-source authorization contracts.
  if ((env.CMS_DEV_RENDERER_ONLY === "true" || env.CMS_DEV_INSTALL_READER_BRIDGE === "true") && sourceSha !== trustedWorkflowSha) {
    throw new Error("Dev bootstrap and reader installation still require the exact workflow source");
  }
  const manifest = JSON.parse(readFileSync(resolve(releaseRoot, ".github/cms-deploy-compatibility.json"), "utf8"));
  if (manifest.contracts?.cmsDevReleaseChecks?.version !== 1) throw new Error("Dev pin lacks cmsDevReleaseChecks version 1");
  const files = ["scripts/smoke-cms-functions.mjs", "scripts/smoke-dev-cms-functions.mjs", "scripts/check-dev-anonymous-refusal.mjs", "scripts/lib/dev-deploy-source.mjs",
    "scripts/deploy-dev-functions.mjs", "scripts/deploy-dev-reader-mounts.mjs", "scripts/deploy-dev-preview-gateways.mjs", "preview-renderer/deploy-dev.mjs",
    "functions/dev-index.js", "functions/dev-manifest.js"];
  git(releaseRoot, "ls-files", "--error-unmatch", "--", ...files);
  for (const file of files) {
    if (!lstatSync(resolve(releaseRoot, file)).isFile()) throw new Error("Dev release checks must be committed files");
  }
  return { schemaVersion: 1, environment: "development", deploySha: sourceSha,
    releaseChecksSha: sourceSha, trustedWorkflowSha, releaseChecksContractVersion: 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = requireDevDeploySource({ env: process.env, releaseRoot: process.cwd(),
    trustedRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../..") });
  writeFileSync(resolve(process.env.RUNNER_TEMP, "dev-release-sources.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Dev release checks: ${receipt.releaseChecksSha}; trusted workflow: ${receipt.trustedWorkflowSha}`);
}

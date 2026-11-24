import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CMS_RELEASE_CHECK_FILES = Object.freeze([
  "scripts/configure-cms-functions.mjs",
  "scripts/lib/functions-configuration.mjs",
  "config/functions-configuration.json",
  "config/functions-deployment.json",
  "scripts/check-cms-secret-iam.mjs",
  "scripts/assert-r2-lifecycle.mjs",
  "scripts/lib/studio-title-files.mjs",
  "agents/vmix/configuration.mjs",
  "scripts/backfill-page-seed-media.mjs",
  "scripts/backfill-media-thumbnails.mjs",
  "scripts/seed-media-categories.mjs",
  "scripts/backfill-media-category-assignments.mjs",
  "scripts/backfill-author-profiles.mjs",
  "scripts/seed-content-sections.mjs",
  "scripts/backfill-byline-projections.mjs",
  "scripts/backfill-media-discovery.mjs",
  "scripts/retire-cms-functions.mjs", "scripts/lib/functions-retirement.mjs",
  "scripts/component-runner.mjs", "scripts/lib/deployment-components.mjs",
  "scripts/smoke-cms-functions.mjs", "scripts/lib/functions-secret-versions.mjs",
  "scripts/cms-component-receipt.mjs", "scripts/lib/cms-component-receipt.mjs",
  "scripts/deploy-cms-api-worker.mjs", "scripts/lib/cloudflare-worker-readback.mjs",
  "scripts/cms-release-plan.mjs", "scripts/lib/cms-release-plan.mjs",
  "scripts/lib/cms-renderer-graph.mjs", "scripts/deploy-cms-function-batches.mjs",
  "scripts/lib/functions-deploy-inventory.mjs", "scripts/lib/provider-call.mjs", "scripts/confirm-admin-revision.mjs",
  "scripts/check-admin-pages-security.mjs",
]);
export const CMS_FUNCTION_CONTRACT_FILES = Object.freeze([
  "scripts/functions-contract-sources.json", "scripts/lib/functions-contracts.mjs", "scripts/compile-functions-contracts.mjs",
]);

// This gate runs from the trusted workflow checkout, before selected code runs.
export function requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot, dispatchInputs, target = "production" }) {
  if (target !== "production" && target !== "development") throw new Error("CMS deploy target must be production or development");
  for (const [label, sha, cwd] of [
    ["Release checks", releaseSha, releaseRoot],
    ["Trusted workflow", trustedWorkflowSha, trustedRoot],
  ]) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error(`${label} requires an explicit full SHA`);
    const git = (...args) => execFileSync("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (git("rev-parse", "HEAD") !== sha || git("status", "--porcelain", "--untracked-files=no")) {
      throw new Error(`${label} checkout must be clean and equal its pinned SHA`);
    }
  }
  const hasContractRecipe = execFileSync("git", ["ls-tree", "--name-only", releaseSha, "--", CMS_FUNCTION_CONTRACT_FILES[0]], {
    cwd: releaseRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const releaseFiles = [...CMS_RELEASE_CHECK_FILES, ...(hasContractRecipe ? CMS_FUNCTION_CONTRACT_FILES : []),
    ...(target === "development" ? ["scripts/lib/cms-target.mjs", "config/functions-deployment.development.json",
      "scripts/cms-reader-binding.mjs"] : [])];
  execFileSync("git", ["ls-files", "--error-unmatch", "--", ".github/cms-deploy-compatibility.json", "admin/package.json", ...releaseFiles], {
    cwd: releaseRoot, stdio: ["ignore", "pipe", "pipe"],
  });
  const manifest = JSON.parse(readFileSync(resolve(releaseRoot, ".github/cms-deploy-compatibility.json"), "utf8"));
  const version = manifest.contracts?.cmsReleaseChecks?.version;
  if (version !== 1) {
    throw new Error("Release checks require a supported cmsReleaseChecks contract");
  }
  // Older sources name production Workers in their operators. The dev Cloudflare
  // token can edit those Workers, so a dev run needs a source that selects its target.
  if (target === "development" && manifest.contracts?.cmsReleaseTargets?.version !== 1) {
    throw new Error("A development deploy requires a release source with the cmsReleaseTargets contract");
  }
  for (const path of releaseFiles) {
    if (!lstatSync(resolve(releaseRoot, path)).isFile()) throw new Error(`Release operator must be a committed file: ${path}`);
  }
  // These native safety policies formerly ran from trusted main. Fix forward:
  // a selected source may not reinstate older IAM or retention validation.
  for (const path of ["scripts/check-cms-secret-iam.mjs", "scripts/assert-r2-lifecycle.mjs"]) {
    const blob = (cwd, sha) => execFileSync("git", ["rev-parse", `${sha}:${path}`], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (blob(releaseRoot, releaseSha) !== blob(trustedRoot, trustedWorkflowSha)) {
      throw new Error(`Release source must retain the trusted native validator: ${path}`);
    }
  }
  const admin = JSON.parse(readFileSync(resolve(releaseRoot, "admin/package.json"), "utf8"));
  if (typeof admin.scripts?.["test:boot"] !== "string" || !admin.scripts["test:boot"].trim()) {
    throw new Error("Release checks require the Admin test:boot contract");
  }
  // Production receipts keep their original fields; the release command decodes them strictly.
  const receipt = { schemaVersion: 1, deploySha: releaseSha, releaseChecksSha: releaseSha, trustedWorkflowSha, releaseChecksContractVersion: version,
    ...(target === "development" ? { target } : {}) };
  if (!dispatchInputs) return receipt;
  const inputs = JSON.parse(dispatchInputs);
  if (!correlatedDispatchAccepted(inputs, { releaseSha, target })) {
    throw new Error("Correlated CMS dispatch requires the reviewed deploy ref and default settings");
  }
  return { ...receipt, releaseDispatchId: inputs.release_dispatch_id };
}

/** The one rule for a release run's correlated dispatch: the reviewed deploy
 * ref, its dispatch id and every other input at its default. The release plan
 * advises only inputs this accepts (cms-release-plan.test.js). */
export function correlatedDispatchAccepted(dispatched, { releaseSha, target = "production" }) {
  // GitHub can omit optional inputs whose default is an empty string.
  const inputs = {
    emergency_authorization: "", migrations: "", reader_operation_id: "", reader_install_authorization: "", target: "production",
    ...dispatched,
  };
  const releaseDispatchId = inputs.release_dispatch_id;
  return typeof releaseDispatchId === "string" && /^[a-f0-9]{32}$/.test(releaseDispatchId) && isDeepStrictEqual(inputs, {
    deploy_ref: releaseSha, release_dispatch_id: releaseDispatchId, cloudflare_pages_branch: "main",
    emergency_release: false, emergency_authorization: "", force_firebase: false, migrations: "",
    install_reader_bridge: false, reader_operation_id: "", reader_install_authorization: "", target,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = requireCmsReleaseSources({
    releaseSha: process.env.CMS_RELEASE_CHECKS_SHA,
    trustedWorkflowSha: process.env.CMS_TRUSTED_WORKFLOW_SHA,
    dispatchInputs: process.env.CMS_CORRELATED_DISPATCH_INPUTS,
    target: process.env.CMS_TARGET || undefined,
    releaseRoot: process.cwd(),
    trustedRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  });
  writeFileSync(resolve(process.env.RUNNER_TEMP, "cms-release-sources.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`CMS release checks: ${receipt.releaseChecksSha}; trusted workflow: ${receipt.trustedWorkflowSha}`);
}

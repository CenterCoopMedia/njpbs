import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse } from "yaml";
import { requireDevDeploySource } from "../../.github/scripts/require-dev-deploy-source.mjs";
import { assertDevDeployCheckout } from "../../scripts/lib/dev-deploy-source.mjs";

const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
let root, releaseRoot, trustedRoot, sourceSha, trustedSha, env;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(cwd) {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Reviewed source");
  return git(cwd, "rev-parse", "HEAD");
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dev-deploy-source-"));
  releaseRoot = join(root, "release"); trustedRoot = join(root, "trusted");
  const files = ["scripts/smoke-cms-functions.mjs", "scripts/smoke-dev-cms-functions.mjs", "scripts/check-dev-anonymous-refusal.mjs", "scripts/lib/dev-deploy-source.mjs",
    "scripts/deploy-dev-functions.mjs", "scripts/deploy-dev-reader-mounts.mjs", "scripts/deploy-dev-preview-gateways.mjs", "preview-renderer/deploy-dev.mjs",
    "functions/dev-index.js", "functions/dev-manifest.js"];
  for (const file of files) {
    mkdirSync(join(releaseRoot, file, ".."), { recursive: true });
    writeFileSync(join(releaseRoot, file), "// Reviewed fixture source\n");
  }
  mkdirSync(join(releaseRoot, ".github"));
  writeFileSync(join(releaseRoot, ".github/cms-deploy-compatibility.json"), JSON.stringify({ contracts: { cmsDevReleaseChecks: { version: 1 } } }));
  git(releaseRoot, "init", "-b", "main");
  git(releaseRoot, "remote", "add", "origin", "https://github.com/example-owner/example-repo.git");
  sourceSha = commit(releaseRoot);
  cpSync(releaseRoot, trustedRoot, { recursive: true });
  writeFileSync(join(trustedRoot, "later.txt"), "Main advances while the pin ships\n");
  trustedSha = commit(trustedRoot);
  git(releaseRoot, "fetch", trustedRoot, "main:refs/remotes/origin/main");
  env = { CANONICAL_GITHUB_REPOSITORY: "example-owner/example-repo", CANONICAL_GITHUB_REPOSITORY_ID: "424242", GITHUB_REPOSITORY: "example-owner/example-repo", GITHUB_REPOSITORY_ID: "424242", CMS_DEPLOY_OWNER: "fixture-owner", DEPLOY_SHA: sourceSha, GITHUB_SHA: trustedSha, GITHUB_WORKFLOW_SHA: trustedSha,
    GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-owner", GITHUB_TRIGGERING_ACTOR: "fixture-owner",
    RUNNER_ENVIRONMENT: "github-hosted", GITHUB_WORKFLOW_REF: "example-owner/example-repo/.github/workflows/cms-dev-deploy.yml@refs/heads/main" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const check = (patch = {}) => requireDevDeploySource({ env: { ...env, ...patch }, releaseRoot, trustedRoot });

it("keeps NEW and its checker identity after trusted main advances", () => {
  expect(sourceSha).not.toBe(trustedSha);
  expect(check()).toEqual({ schemaVersion: 1, environment: "development", deploySha: sourceSha,
    releaseChecksSha: sourceSha, trustedWorkflowSha: trustedSha, releaseChecksContractVersion: 1 });
  expect(assertDevDeployCheckout(env, releaseRoot)).toBe(sourceSha);
  expect(() => assertDevDeployCheckout({ ...env, DEPLOY_SHA: trustedSha }, releaseRoot)).toThrow("selected pin");
  git(releaseRoot, "checkout", "--detach", trustedSha);
  expect(check({ DEPLOY_SHA: trustedSha }).deploySha).toBe(trustedSha);
});

it.each([undefined, "", "main", "a".repeat(7), "f".repeat(40)])("refuses a missing, moving or unmatched pin %j", DEPLOY_SHA => {
  expect(() => check({ DEPLOY_SHA })).toThrow();
});
it.each(["GITHUB_SHA", "GITHUB_WORKFLOW_SHA", "GITHUB_REF", "GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR",
  "RUNNER_ENVIRONMENT", "GITHUB_WORKFLOW_REF"])("refuses an unbound hosted workflow: %s", name => {
  expect(() => check({ [name]: "untrusted" })).toThrow();
});
it.each(["release", "trusted"])("refuses dirty %s code before credentials", side => {
  const cwd = side === "release" ? releaseRoot : trustedRoot;
  writeFileSync(join(cwd, "functions/dev-index.js"), "// Unreviewed code\n");
  expect(() => check()).toThrow();
});
it("refuses an old pin without the new dev identity contract", () => {
  writeFileSync(join(trustedRoot, ".github/cms-deploy-compatibility.json"), JSON.stringify({ contracts: {} }));
  const old = commit(trustedRoot);
  git(releaseRoot, "fetch", trustedRoot, "main:refs/remotes/origin/main");
  git(releaseRoot, "checkout", "--detach", old);
  expect(() => check({ DEPLOY_SHA: old, GITHUB_SHA: old, GITHUB_WORKFLOW_SHA: old })).toThrow("cmsDevReleaseChecks");
});
it("refuses a reviewed ancestor without the reader update command before selected code can run", () => {
  const command = join(trustedRoot, "scripts/deploy-dev-reader-mounts.mjs");
  rmSync(command);
  const unsupported = commit(trustedRoot);
  writeFileSync(command, "// Reviewed update-capable deployment\n");
  const current = commit(trustedRoot);
  git(releaseRoot, "fetch", trustedRoot, "main:refs/remotes/origin/main");
  git(releaseRoot, "checkout", "--detach", unsupported);
  expect(() => check({ DEPLOY_SHA: unsupported, GITHUB_SHA: current, GITHUB_WORKFLOW_SHA: current }))
    .toThrow("scripts/deploy-dev-reader-mounts.mjs");
});
it.each(["CMS_DEV_RENDERER_ONLY", "CMS_DEV_INSTALL_READER_BRIDGE"])("keeps the exact-workflow-source restriction for %s", name => {
  expect(() => check({ [name]: "true" })).toThrow("exact workflow source");
  git(releaseRoot, "checkout", "--detach", trustedSha);
  expect(check({ DEPLOY_SHA: trustedSha, [name]: "true" }).deploySha).toBe(trustedSha);
});
it("refuses a noncanonical origin", () => {
  git(releaseRoot, "remote", "set-url", "origin", "https://example.test/unreviewed.git");
  expect(() => check()).toThrow("canonical origin");
});

it("binds both dev jobs to the pin and runs the shared action from the trusted checkout before selected code", () => {
  const action = parse(readFileSync(new URL("../../.github/actions/dev-deploy-source-gates/action.yml", import.meta.url), "utf8"));
  expect(action.runs.using).toBe("composite");
  for (const job of Object.values(workflow.jobs)) {
    expect(job.environment).toBe("development");
    expect(job.env.DEPLOY_SHA).toBe("${{ inputs.deploy_ref || github.sha }}");
    expect(job.steps[0].with.ref).toBe("${{ inputs.deploy_ref || github.sha }}");
    const trusted = job.steps.find(step => step.name === "Check out trusted dev source gates");
    expect(trusted.with.ref).toBe("${{ github.sha }}");
    expect(trusted.with["sparse-checkout"]).toBeUndefined();
    expect(trusted.with["persist-credentials"]).toBe(false);
    const composite = job.steps.find(step => step.name === "Verify dev deploy source gates");
    expect(composite.uses).toBe("./.dev-deploy-gate/.github/actions/dev-deploy-source-gates");
    expect(job.steps.indexOf(composite)).toBeGreaterThan(job.steps.indexOf(trusted));
    const selected = job.steps.findIndex(step => step.run?.startsWith("node scripts/") || step.run?.startsWith("node .github/"));
    expect(selected).toBeGreaterThan(job.steps.indexOf(composite));
    expect(composite.with["github-token"]).toBe("${{ github.token }}");
    expect(composite.with["renderer-only"]).toBe("${{ inputs.renderer_only }}");
    expect(composite.with["install-reader-bridge"]).toBe("${{ inputs.install_reader_bridge }}");
    expect(job.permissions.actions).toBe("read");
  }
  const steps = action.runs.steps;
  const gate = steps.findIndex(step => step.name === "Require the exact reviewed dev pin");
  const ci = steps.findIndex(step => step.name === "Require successful main CI for the exact dev pin");
  const scan = steps.findIndex(step => step.name === "Metered-API source scan before execution");
  const compatibility = steps.findIndex(step => step.name === "Require compatible dev Firestore rules");
  const cleanup = steps.findIndex(step => step.name === "Remove the temporary trusted gate checkout");
  expect(gate).toBeGreaterThan(0); expect(ci).toBeGreaterThan(gate);
  expect(compatibility).toBeGreaterThan(ci); expect(scan).toBeGreaterThan(compatibility);
  expect(cleanup).toBeGreaterThan(scan);
  expect(steps[ci].run).toBe("node .dev-deploy-gate/.github/scripts/require-main-ci.mjs");
  expect(steps[ci].env.GH_TOKEN).toBe("${{ inputs.github-token }}");
  expect(steps.filter(step => step.run).every(step => step.shell === "bash")).toBe(true);
  const deploy = workflow.jobs.deploy.steps;
  expect(deploy.findIndex(step => step.name === "Verify the complete dev smoke manifest before mutation"))
    .toBeLessThan(deploy.findIndex(step => step.name === "Authenticate to dev Firebase with OIDC"));
});

it("restores a clean selected checkout before the strict bootstrap and reader operators", () => {
  cpSync(trustedRoot, join(releaseRoot, ".dev-deploy-gate"), { recursive: true });
  expect(git(releaseRoot, "status", "--porcelain", "--untracked-files=normal")).toContain(".dev-deploy-gate/");
  const action = parse(readFileSync(new URL("../../.github/actions/dev-deploy-source-gates/action.yml", import.meta.url), "utf8"));
  const cleanup = action.runs.steps.find(step => step.name === "Remove the temporary trusted gate checkout");
  execFileSync("bash", ["-eu", "-c", cleanup.run], { cwd: releaseRoot });
  expect(git(releaseRoot, "status", "--porcelain", "--untracked-files=normal")).toBe("");
  expect(git(releaseRoot, "rev-parse", "HEAD")).toBe(sourceSha);
});

it("executes the trusted scanner in a complete repository layout", () => {
  const scanner = new URL("../../.github/scripts/metered-api-scan.mjs", import.meta.url);
  expect(() => execFileSync(process.execPath, [scanner.pathname], { stdio: ["ignore", "pipe", "pipe"] })).not.toThrow();
});


it.each(["current", "below floor", "changed rules"])("checks %s rules with the trusted compatibility gate before mutation", kind => {
  const action = parse(readFileSync(new URL("../../.github/actions/dev-deploy-source-gates/action.yml", import.meta.url), "utf8"));
  const step = action.runs.steps.find(step => step.name === "Require compatible dev Firestore rules");
  expect(step).toBeDefined();
  const checker = ".github/scripts/cms-deploy-compatibility.mjs";
  mkdirSync(join(releaseRoot, ".dev-deploy-gate/.github/scripts"), { recursive: true });
  cpSync(new URL(`../../${checker}`, import.meta.url), join(releaseRoot, ".dev-deploy-gate", checker));
  mkdirSync(join(releaseRoot, ".github/scripts"), { recursive: true });
  writeFileSync(join(releaseRoot, checker), 'throw new Error("selected checker must not run");');
  const manifest = JSON.parse(readFileSync(new URL("../../.github/cms-deploy-compatibility.json", import.meta.url), "utf8"));
  if (kind === "below floor") manifest.contracts.cmsEditorLocks.version = 5;
  writeFileSync(join(releaseRoot, ".github/cms-deploy-compatibility.json"), JSON.stringify(manifest));
  const rules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
  writeFileSync(join(releaseRoot, "firestore.rules"), kind === "changed rules"
    ? rules.replace("validEditorLockReleaseData(lockId) &&", "false &&") : rules);
  const result = spawnSync("bash", ["-e", "-c", `${step.run}
printf reached > mutation`], {
    cwd: releaseRoot, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_WORKSPACE: releaseRoot },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(kind === "current" ? 0 : 1);
  if (kind === "current") expect(readFileSync(join(releaseRoot, "mutation"), "utf8")).toBe("reached");
  else {
    expect(() => readFileSync(join(releaseRoot, "mutation"))).toThrow();
    expect(result.stderr).toContain(kind === "below floor" ? "predates required floor" : "does not satisfy");
  }
});

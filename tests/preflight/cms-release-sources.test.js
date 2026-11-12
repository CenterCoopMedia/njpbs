import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import { CMS_RELEASE_CHECK_FILES, requireCmsReleaseSources } from "../../.github/scripts/require-cms-release-sources.mjs";
import { requireReleaseSource } from "../../.github/scripts/require-release-source.mjs";
import { decideRelease, fingerprintExecutionSource, fingerprintReceiptExecutionSource } from "../../scripts/lib/cms-release-plan.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflow = parse(readCmsDeployWorkflow());
let root, releaseRoot, trustedRoot, releaseSha, trustedWorkflowSha;
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
function commit(cwd, message) {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cms-release-sources-"));
  releaseRoot = join(root, "release");
  trustedRoot = join(root, "trusted");
  mkdirSync(join(releaseRoot, "scripts"), { recursive: true });
  mkdirSync(join(releaseRoot, "functions"));
  writeFileSync(join(releaseRoot, "functions/index.js"), "exports.health = health;\n");
  for (const path of CMS_RELEASE_CHECK_FILES) {
    mkdirSync(join(releaseRoot, path, ".."), { recursive: true });
    writeFileSync(join(releaseRoot, path), "export {};\n");
  }
  for (const path of ["scripts/component-runner.mjs", "scripts/lib/deployment-components.mjs", "scripts/lib/cms-component-receipt.mjs", "scripts/render-development-config.mjs", "config/development-inputs.json"]) {
    mkdirSync(join(releaseRoot, path, ".."), { recursive: true });
    cpSync(join(repoRoot, path), join(releaseRoot, path));
  }
  cpSync(join(repoRoot, "scripts/smoke-cms-functions.mjs"), join(releaseRoot, "scripts/smoke-cms-functions.mjs"));
  cpSync(join(repoRoot, "functions/index.js"), join(releaseRoot, "functions/index.js"));
  mkdirSync(join(releaseRoot, "admin"));
  writeFileSync(join(releaseRoot, "admin/package.json"), JSON.stringify({ scripts: { "test:boot": "vitest run tests/boot.test.ts" } }));
  mkdirSync(join(releaseRoot, ".github/scripts"), { recursive: true });
  cpSync(join(repoRoot, ".github/scripts/require-cms-release-sources.mjs"), join(releaseRoot, ".github/scripts/require-cms-release-sources.mjs"));
  cpSync(join(repoRoot, ".github/cms-deploy-compatibility.json"), join(releaseRoot, ".github/cms-deploy-compatibility.json"));
  git(releaseRoot, "init", "-b", "main");
  releaseSha = commit(releaseRoot, "Reviewed release");
  cpSync(releaseRoot, trustedRoot, { recursive: true });
  writeFileSync(join(trustedRoot, "scripts/smoke-cms-functions.mjs"),
    'throw new Error("Later main smoke must not run");\n' + readFileSync(join(releaseRoot, "scripts/smoke-cms-functions.mjs"), "utf8"));
  trustedWorkflowSha = commit(trustedRoot, "Later trusted main changes smoke");
  git(releaseRoot, "fetch", trustedRoot, "main:refs/remotes/origin/main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("CMS release source contract", () => {
  it("holds an old-base emergency before mutation and admits a post-adoption freeze source", () => {
    const compatibleLiveBase = releaseSha;
    writeFileSync(join(releaseRoot, ".github/cms-deploy-compatibility.json"), JSON.stringify({ contracts: {} }));
    const oldLiveBase = commit(releaseRoot, "Pre-adoption live base without release-checks contract");
    writeFileSync(join(releaseRoot, "authorized-fix.txt"), "Only the authorized application fix\n");
    releaseSha = commit(releaseRoot, "Emergency fix on the old live base");
    const authorize = base => requireReleaseSource({ sha: releaseSha, emergency: true,
      authorization: `EMERGENCY ${releaseSha} FROM ${base} #4418: Fixture authorized fix`, cwd: releaseRoot });
    expect(authorize(oldLiveBase)).toBe(releaseSha);
    expect(() => requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot })).toThrow("cmsReleaseChecks");
    git(releaseRoot, "checkout", "--detach", compatibleLiveBase);
    writeFileSync(join(releaseRoot, "authorized-fix.txt"), "Only the authorized application fix\n");
    releaseSha = commit(releaseRoot, "Emergency fix after compatible paired adoption");
    expect(authorize(compatibleLiveBase)).toBe(releaseSha);
    expect(requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot }).releaseChecksSha).toBe(releaseSha);
  });
  it.each(["missing source", "missing workflow", "unavailable source object", "unavailable workflow object"])("requires a full release for an unavailable receipt baseline: %s", async kind => {
    const mutation = { sourceSha: releaseSha, trustedWorkflowSha };
    if (kind === "missing source") delete mutation.sourceSha;
    if (kind === "missing workflow") delete mutation.trustedWorkflowSha;
    if (kind === "unavailable source object") mutation.sourceSha = "f".repeat(40);
    if (kind === "unavailable workflow object") mutation.trustedWorkflowSha = "f".repeat(40);
    const trustedReceiptFingerprint = await fingerprintReceiptExecutionSource(mutation, { cwd: releaseRoot });
    expect(trustedReceiptFingerprint).toBeNull();
    const receipt = { schemaVersion: 1, state: "complete", mutation: { sourceSha: releaseSha, inputFingerprint: "e".repeat(64) } };
    const input = { functionsReceipt: receipt, rendererReceipt: receipt,
      trustedFingerprint: await fingerprintExecutionSource(releaseSha, trustedWorkflowSha, { cwd: releaseRoot }), trustedReceiptFingerprint };
    expect(decideRelease(input)).toMatchObject({ functionsMutated: true, releaseReason: "trusted_source_changed" });
    expect(decideRelease({ ...input, forceFirebase: true })).toMatchObject({ functionsMutated: true, releaseReason: "force_firebase" });
  });
  it("fingerprints release helpers at NEW and trusted gates at their separate workflow SHA", async () => {
    const deps = { cwd: releaseRoot };
    const original = await fingerprintExecutionSource(releaseSha, releaseSha, deps);
    const laterMainHelper = await fingerprintExecutionSource(releaseSha, trustedWorkflowSha, deps);
    expect(laterMainHelper).toBe(original);
    expect(await fingerprintExecutionSource(trustedWorkflowSha, trustedWorkflowSha, deps)).not.toBe(original);
    writeFileSync(join(trustedRoot, ".github/scripts/require-cms-release-sources.mjs"), "// Changed trusted gate\n");
    const changedGate = commit(trustedRoot, "Changed trusted authorization gate");
    git(releaseRoot, "fetch", trustedRoot, "main:refs/remotes/origin/main");
    expect(await fingerprintExecutionSource(releaseSha, changedGate, deps)).not.toBe(original);
  });
  it("keeps a reviewed ancestor NEW and its release checks after trusted main advances", () => {
    expect(requireReleaseSource({ sha: releaseSha, cwd: releaseRoot })).toBe(releaseSha);
    execFileSync(process.execPath, [join(trustedRoot, ".github/scripts/require-cms-release-sources.mjs")], {
      cwd: releaseRoot,
      env: { ...process.env, CMS_RELEASE_CHECKS_SHA: releaseSha, CMS_TRUSTED_WORKFLOW_SHA: trustedWorkflowSha, RUNNER_TEMP: root },
    });
    expect(JSON.parse(readFileSync(join(root, "cms-release-sources.json"), "utf8"))).toEqual({
      schemaVersion: 1, deploySha: releaseSha, releaseChecksSha: releaseSha, trustedWorkflowSha, releaseChecksContractVersion: 1,
    });
    // Run the workflow's real smoke shell blocks against distinct Git trees.
    mkdirSync(join(releaseRoot, ".cms-smoke-gate"));
    cpSync(join(trustedRoot, "scripts"), join(releaseRoot, ".cms-smoke-gate/scripts"), { recursive: true });
    expect(() => execFileSync(process.execPath, [".cms-smoke-gate/scripts/smoke-cms-functions.mjs"], {
      cwd: releaseRoot, stdio: ["ignore", "pipe", "pipe"],
    })).toThrow("Later main smoke must not run");
    const network = join(root, "network.mjs");
    writeFileSync(network, `globalThis.fetch = async (url, init = {}) => {
      const { origin, pathname } = new URL(url);
      if (origin === "https://admin.njpbs.org") return new Response(null, {status: 200});
      if (origin === "https://us-central1-njpbs-site.cloudfunctions.net") return new Response(null, {status: 403});
      if (origin !== "https://cms-api.example.test") throw Error("Unexpected smoke origin");
      if (pathname === "/health") return new Response(null, {status: 200});
      if (init.method === "OPTIONS") return new Response(null, {status: 204, headers: {
        "access-control-allow-origin": "https://admin.njpbs.org", "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization,content-type,x-firebase-appcheck",
      }});
      return new Response(null, {status: init.method === "GET" ? 405 : 401});
    };`);
    for (const name of ["smoke-manifest", "live-smoke"]) {
      const script = workflow.jobs[name].steps.find(step => step.name === (name === "smoke-manifest" ? "Require the deployed function manifest to match the smoke gate" : "Smoke-test deployed CMS boundaries")).run;
      const output = execFileSync("bash", ["-eu", "-c", script], {
        cwd: releaseRoot, encoding: "utf8", env: { ...process.env, CMS_PRODUCTION_API_ORIGIN: "https://cms-api.example.test",
          DEPLOY_SHA: releaseSha, GATE_SHA: trustedWorkflowSha, GITHUB_OUTPUT: join(root, "outputs"), NODE_OPTIONS: `--import=${network}` },
      });
      expect(output).toContain("CMS production export manifest: matched");
    }
  });

  it.each(["", "main", "a".repeat(7)])("refuses an omitted or moving release ref %j", releaseSha => {
    expect(() => requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot })).toThrow("explicit full SHA");
  });
  it.each(["scripts/component-runner.mjs", "scripts/lib/deployment-components.mjs", "scripts/lib/functions-retirement.mjs", "scripts/retire-cms-functions.mjs"])("refuses an untracked replacement for %s", file => {
    rmSync(join(releaseRoot, file));
    releaseSha = commit(releaseRoot, "Source without component dispatcher input");
    writeFileSync(join(releaseRoot, file), "throw new Error('untracked replacement');\n");
    expect(() => requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot })).toThrow(file);
  });
  it.each(["missing contract", "unsupported contract", "missing receipt helper", "untracked receipt helper", "missing Admin boot",
    "stale IAM validator", "stale lifecycle validator"])("refuses a clean selected source with %s before mutation", kind => {
    if (kind.endsWith("receipt helper")) rmSync(join(releaseRoot, "scripts/cms-component-receipt.mjs"));
    else if (kind === "missing Admin boot") writeFileSync(join(releaseRoot, "admin/package.json"), "{}");
    else if (kind.startsWith("stale")) writeFileSync(join(releaseRoot, "scripts", kind.includes("IAM") ? "check-cms-secret-iam.mjs" : "assert-r2-lifecycle.mjs"), "// Stale native policy\n");
    else writeFileSync(join(releaseRoot, ".github/cms-deploy-compatibility.json"), JSON.stringify({ contracts: kind === "missing contract" ? {} : { cmsReleaseChecks: { version: 2 } } }));
    releaseSha = commit(releaseRoot, `Unsupported source: ${kind}`);
    if (kind === "untracked receipt helper") writeFileSync(join(releaseRoot, "scripts/cms-component-receipt.mjs"), "export {};\n");
    expect(() => requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot })).toThrow(
      kind.startsWith("stale") ? "trusted native validator" : kind.endsWith("receipt helper") ? "scripts/cms-component-receipt.mjs" : kind === "missing Admin boot" ? "test:boot" : "cmsReleaseChecks",
    );
  });
  it.each(["release", "trusted", "dirty release", "dirty trusted"])("refuses %s identity drift", kind => {
    if (kind === "release") releaseSha = trustedWorkflowSha;
    if (kind === "trusted") trustedWorkflowSha = releaseSha;
    if (kind === "dirty release" || kind === "dirty trusted") {
      writeFileSync(join(kind === "dirty release" ? releaseRoot : trustedRoot, "functions/index.js"), "changed\n");
    }
    expect(() => requireCmsReleaseSources({ releaseSha, trustedWorkflowSha, releaseRoot, trustedRoot })).toThrow("clean and equal its pinned SHA");
  });

  it("gates every selected tree before release code runs and never overlays trusted helpers", () => {
    expect(workflow.on.workflow_dispatch.inputs.deploy_ref).toMatchObject({ required: true });
    expect(workflow.on.workflow_dispatch.inputs.deploy_ref).not.toHaveProperty("default");
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const gate = job.steps.find(step => step.name === "Require pinned release and trusted workflow identities");
      expect(gate, name).toBeDefined();
      expect(gate.env.CMS_RELEASE_CHECKS_SHA, name).toBe("${{ inputs.deploy_ref }}");
      expect(gate.env.CMS_TRUSTED_WORKFLOW_SHA, name).toBe("${{ github.sha }}");
      const firstSelectedCommand = job.steps.findIndex(step => /(?:node |import .*from ["'])\.?\/?scripts\//.test(step.run ?? ""));
      // Contract jobs run only the trusted checker against the release tree.
      if (["admin-contract", "contract-settlement"].includes(name)) expect(firstSelectedCommand, name).toBe(-1);
      else expect(firstSelectedCommand, name).toBeGreaterThan(job.steps.indexOf(gate));
      if (name === "preview-renderer") expect(gate.if).toBe("vars.CMS_PREVIEW_CLOUD_ENABLED == 'true'");
      for (const step of job.steps) expect(step.run ?? "").not.toMatch(/cp \.(?:metered-api|cms-smoke)-gate\/scripts\//);
    }
    const artifact = workflow.jobs["admin-build"].steps.find(step => step.with?.name === "cms-release-source-identities");
    expect(artifact.with["if-no-files-found"]).toBe("error");
  });
});

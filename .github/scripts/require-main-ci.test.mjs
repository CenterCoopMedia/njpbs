import { repositoryFixture } from "../../tests/helpers/repository-identity.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import { readCmsDeployWorkflow } from "../../tests/helpers/cms-deploy-workflow.mjs";
import { requireMainCi, requireReleaseCi } from "./require-main-ci.mjs";
import { releaseAuthorization, releaseInputs, requireReleaseSource } from "./require-release-source.mjs";

// The Policy job installs the site package only, which declares yaml.
const { parse } = createRequire(new URL("../../site/package.json", import.meta.url))("yaml");
const repository = "CenterCoopMedia/njpbs";
const sha = "a".repeat(40);
const main = "b".repeat(40);
const run = {
  id: 123, event: "push", head_branch: "main", head_sha: sha,
  status: "completed", conclusion: "success", path: ".github/workflows/ci.yml",
  repository: { id: 1442374012, full_name: repository }, head_repository: { id: 1442374012, full_name: repository },
};
const job = { name: "ci", run_id: run.id, head_sha: sha, status: "completed", conclusion: "success" };

test("the trusted Pages sparse checkout can load its CI proof dependencies", () => {
  const workflow = readFileSync(new URL("../workflows/pages.yml", import.meta.url), "utf8");
  const sparseBlock = workflow.match(/path: \.release-gate\n\s+sparse-checkout: \|\n((?: {12}[^\n]+\n)+)/)?.[1];
  assert.ok(sparseBlock, "trusted gate declares its sparse inputs");
  const directory = mkdtempSync(join(tmpdir(), "release-gate-checkout-"));
  const root = new URL("../../", import.meta.url).pathname;
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, directory]);
    execFileSync("git", ["sparse-checkout", "set", "--cone", ...sparseBlock.trim().split(/\s+/)], { cwd: directory });
    execFileSync("git", ["checkout", "--quiet", "HEAD"], { cwd: directory });
    execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./.github/scripts/require-main-ci.mjs')"],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function check(runs = [run], jobs = [job]) {
  return requireMainCi({ env: repositoryFixture, repository, sha, request: async (path) =>
    path.includes("/jobs?") ? { jobs, total_count: jobs.length } : { workflow_runs: runs },
  });
}

test("accepts the deploy SHA's own green main run after main moves", async () => {
  assert.notEqual(sha, main);
  const requests = [];
  assert.equal(await requireMainCi({ env: repositoryFixture, repository, sha, request: async (path) => {
    requests.push(path);
    return path.includes("/jobs?") ? { jobs: [job], total_count: 1 } : { workflow_runs: [run] };
  } }), run.id);
  assert.ok(requests[0].includes(`head_sha=${sha}`));
  assert.ok(!requests.some((path) => path.includes(main)));
});

test("rejects a green newer SHA, PR/manual run, wrong workflow or repository", async () => {
  for (const changed of [
    { head_sha: main }, { event: "pull_request" }, { event: "workflow_dispatch" },
    { head_branch: "feature" }, { path: ".github/workflows/other.yml" },
    { repository: { full_name: "elsewhere/repo" } },
    { head_repository: { full_name: "elsewhere/repo" } },
    { status: "in_progress" }, { conclusion: "failure" }, { id: "123" },
  ]) await assert.rejects(check([{ ...run, ...changed }]), /No successful main CI/);
});

test("requires a completed successful ci job for the same SHA and run", async () => {
  for (const changed of [
    { name: "PR metadata" }, { head_sha: main }, { run_id: 456 },
    { status: "queued" }, { conclusion: "skipped" }, { conclusion: "failure" },
    { conclusion: "cancelled" },
  ]) await assert.rejects(check([run], [{ ...job, ...changed }]), /No successful main CI/);
  await assert.rejects(check([]), /No successful main CI/);
  await assert.rejects(check([run], []), /No successful main CI/);
});

test("finds ci on later job pages and fails closed on API or incomplete data", async () => {
  assert.equal(await requireMainCi({ env: repositoryFixture, repository, sha, request: async (path) => {
    if (!path.includes("/jobs?")) return { workflow_runs: [run] };
    return path.endsWith("page=1")
      ? { jobs: [{ ...job, name: "Policy" }], total_count: 2 }
      : { jobs: [job], total_count: 2 };
  } }), run.id);
  await assert.rejects(requireMainCi({ env: repositoryFixture, repository, sha, request: async () => { throw new Error("API failed"); } }), /API failed/);
  await assert.rejects(requireMainCi({ env: repositoryFixture, repository, sha: "main" }), /full deploy SHA/);
  await assert.rejects(requireMainCi({ env: repositoryFixture, repository, sha, request: async (path) =>
    path.includes("/jobs?") ? { jobs: [], total_count: 1 } : { workflow_runs: [run] },
  }), /Incomplete main CI/);
});

test("main runs finish in parent and reusable workflows; PR and queue work can cancel", () => {
  for (const file of ["ci.yml", "admin-ci.yml", "firebase-ci.yml"]) {
    const workflow = readFileSync(new URL(`../workflows/${file}`, import.meta.url), "utf8");
    const cancel = workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(cancel, `${file}: conditional cancellation missing`);
    for (const [event, ref, expected] of [
      ["push", "refs/heads/main", false],
      ["pull_request", "refs/pull/1/merge", true],
      ["merge_group", "refs/heads/gh-readonly-queue/main/a", true],
      ["workflow_dispatch", "refs/heads/main", true],
    ]) assert.equal(runInNewContext(cancel, { github: { event_name: event, ref } }), expected, file);
  }
});

test("deploy runs the gate from its trusted workflow checkout before installing target code", () => {
  const workflow = readFileSync(new URL("../workflows/cms-staging-deploy.yml", import.meta.url), "utf8");
  const build = workflow.split("\n  admin-build:\n")[1].split("\n  smoke-manifest:\n")[0];
  assert.match(build, /actions: read/);
  assert.match(build, /node "\$RUNNER_TEMP\/release-gate"\/\.github\/scripts\/require-release-source\.mjs/);
  assert.match(build, /DEPLOY_SHA: \$\{\{ steps.reviewed_ref.outputs.deploy_sha \}\}/);
  const gate = 'node "$RUNNER_TEMP/admin-status-gate"/.github/scripts/require-main-ci.mjs';
  assert.ok(build.indexOf(gate) > build.indexOf("path: .admin-status-gate"));
  assert.ok(build.indexOf(gate) < build.indexOf("npm ci --ignore-scripts"));
});

const authorization = (target = sha, base = main) => `EMERGENCY ${target} FROM ${base} #1: synthetic emergency fixture`;
const emergency = { emergency: true, authorization: authorization() };

test("emergency authorization is explicit and binds full target and live base SHAs", () => {
  assert.equal(releaseAuthorization({ sha }), null);
  for (const value of ["", `EMERGENCY ${sha}`, authorization(main), authorization(sha, sha),
    authorization().replace("#1:", "reason:"), `${authorization()}\ninjected`]) {
    assert.throws(() => releaseAuthorization({ sha, emergency: true, authorization: value }));
  }
  assert.throws(() => releaseAuthorization({ sha, authorization: authorization() }), /requires emergency mode/);
  assert.throws(() => releaseInputs({ EMERGENCY_RELEASE: "yes" }), /Invalid/);
  assert.equal(releaseAuthorization({ sha, ...emergency }).liveBase, main);
  assert.equal(releaseAuthorization({ sha, emergency: true, authorization: authorization().replace("EMERGENCY", "CRITICAL") }).kind, "CRITICAL");
  assert.throws(() => releaseAuthorization({ sha, emergency: true, authorization: authorization().replace("EMERGENCY", "ROUTINE") }));
});

test("emergency CI requires successful exact-head CI and native ci; normal mode stays main-only", async () => {
  const request = (runs, jobs = [job]) => async path => path.includes("/jobs?")
    ? { jobs, total_count: jobs.length } : { workflow_runs: runs };
  for (const event of ["workflow_dispatch"]) {
    const ciRun = { ...run, event, head_branch: "emergency/fixture" };
    const queries = [];
    assert.equal(await requireReleaseCi({ env: repositoryFixture, repository, sha, ...emergency, request: async path => {
      queries.push(path); return request([ciRun])(path);
    } }), run.id);
    assert.ok(queries[0].includes(`head_sha=${sha}`));
    assert.ok(!queries[0].includes("branch=main"));
    for (const change of [{ head_sha: main }, { conclusion: "failure" }, { status: "queued" },
      { path: ".github/workflows/other.yml" }, { event: "pull_request_target" }, { event: "pull_request" },
      { head_repository: { full_name: "fork/repo" } }, { repository: { full_name: "fork/repo" } }]) {
      await assert.rejects(requireReleaseCi({ env: repositoryFixture, repository, sha, ...emergency,
        request: request([{ ...ciRun, ...change }]) }), /No successful emergency CI/);
    }
    for (const jobs of [[], [{ ...job, head_sha: main }], [{ ...job, conclusion: "skipped" }],
      [{ ...job, run_id: 456 }], [{ ...job, name: "PR metadata" }]]) {
      await assert.rejects(requireReleaseCi({ env: repositoryFixture, repository, sha, ...emergency, request: request([ciRun], jobs) }), /No successful emergency CI/);
    }
  }
  await assert.rejects(requireReleaseCi({ env: repositoryFixture, repository, sha, ...emergency, request: request([]) }), /No successful emergency CI/);
  await assert.rejects(requireReleaseCi({ env: repositoryFixture, repository, sha, emergency: true,
    request: () => { throw new Error("must not query before authorization"); } }), /requires coordinator authorization/);
});

test("source gate enforces first-parent descent, exact clean source, and normal main ancestry", () => {
  const cwd = mkdtempSync(join(tmpdir(), "emergency-release-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    const tree = git("mktree");
    const commit = (parents, message) => git("commit-tree", tree, ...parents.flatMap(p => ["-p", p]), "-m", message);
    const root = commit([], "root");
    const live = commit([root], "live");
    const normal = commit([live], "normal main");
    const fix = commit([live], "emergency fix");
    const wrong = commit([root], "wrong base");
    const secondParentOnly = commit([wrong, live], "live only through second parent");
    git("update-ref", "refs/remotes/origin/main", normal);
    for (const target of [fix, wrong, secondParentOnly]) {
      git("checkout", "--quiet", "--detach", target);
      const options = { sha: target, cwd, emergency: true, authorization: authorization(target, live) };
      if (target === fix) assert.equal(requireReleaseSource(options), fix);
      else assert.throws(() => requireReleaseSource(options), /first-parent chain/);
      assert.throws(() => requireReleaseSource({ sha: target, cwd }));
    }
    git("checkout", "--quiet", "--detach", live);
    assert.equal(requireReleaseSource({ sha: live, cwd }), live); // older normal pin, not main tip
    assert.throws(() => requireReleaseSource({ sha: fix, cwd, emergency: true, authorization: authorization(fix, live) }), /exact deploy SHA/);
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    git("config", "--local", "core.filemode", "false");
    // A tracked change is refused before ancestry or CI can authorize it.
    execFileSync("git", ["read-tree", "--empty"], { cwd });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${git("hash-object", "-w", "--stdin")},dirty`], { cwd });
    assert.throws(() => requireReleaseSource({ sha: live, cwd }), /clean/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("every CMS ancestry boundary and Pages use trusted gates with step-scoped emergency inputs", () => {
  const cms = readFileSync(new URL("../workflows/cms-staging-deploy.yml", import.meta.url), "utf8");
  for (const name of ["admin-build", "firebase-preflight", "cms-api", "firebase", "preview-renderer"]) {
    const block = cms.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
    assert.match(block, /ref: \$\{\{ github.sha \}\}\n          path: \.release-gate/);
    assert.match(block, /EMERGENCY_RELEASE: \$\{\{ inputs.emergency_release \|\| false \}\}/);
    assert.match(block, /EMERGENCY_AUTHORIZATION: \$\{\{ inputs.emergency_authorization \|\| '' \}\}/);
    assert.match(block, /node "\$RUNNER_TEMP\/release-gate"\/\.github\/scripts\/require-release-source.mjs/);
    assert.ok(block.indexOf("path: .release-gate") < block.indexOf('node "$RUNNER_TEMP/release-gate"/'));
  }
  const pages = readFileSync(new URL("../workflows/pages.yml", import.meta.url), "utf8");
  assert.match(pages, /\[ "\$GITHUB_EVENT_NAME" = "workflow_dispatch" \]/);
  assert.match(pages, /node \.release-gate\/\.github\/scripts\/require-main-ci.mjs/);
  for (const workflow of [cms, pages]) {
    assert.match(workflow, /emergency_release:\n(?:.*\n){2}        default: false/);
    const rootEnv = workflow.match(/^env:\n(?:  .*\n)*/m)?.[0] ?? "";
    assert.doesNotMatch(rootEnv, /EMERGENCY_RELEASE|EMERGENCY_AUTHORIZATION/);
  }
});

test("every CMS consumer pins clean release helpers separately from trusted workflow gates", async () => {
  const workflow = parse(readCmsDeployWorkflow());
  const consumers = ["admin-build", "smoke-manifest", "firebase-preflight", "cms-api", "firebase", "preview-renderer", "live-smoke", "admin-deploy"];
  for (const name of consumers) {
    const steps = workflow.jobs[name].steps;
    const gate = steps.find(step => step.name === "Require pinned release and trusted workflow identities");
    assert.ok(gate, name);
    assert.deepEqual(gate.env, { CMS_RELEASE_CHECKS_SHA: "${{ inputs.deploy_ref }}", CMS_TRUSTED_WORKFLOW_SHA: "${{ github.sha }}" });
    const directory = gate.run.match(/\$RUNNER_TEMP\/([a-z-]+)"\/\.github\/scripts\/require-cms-release-sources\.mjs$/)?.[1];
    assert.ok(directory, name);
    const checkout = steps.find(step => step.with?.path === `.${directory}`);
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    const sparse = checkout.with["sparse-checkout"];
    assert.ok(sparse === undefined || sparse.includes(".github/scripts"));
    assert.ok(steps.indexOf(checkout) < steps.indexOf(gate));
    const selectedCode = steps.findIndex(step => /(?:node |import .*from ["'])\.?\/?scripts\//.test(step.run ?? ""));
    assert.ok(selectedCode > steps.indexOf(gate), name);
    for (const step of steps) assert.doesNotMatch(step.run ?? "", /cp .*\/scripts\/lib\/repository-identity\.mjs/);
  }
  const { RELEASE_CHECK_PATHS } = await import('../../scripts/lib/cms-release-plan.mjs');
  for (const path of ['scripts/lib/repository-identity.mjs', 'scripts/lib/studio-title-files.mjs', 'agents/vmix/configuration.mjs']) {
    assert.ok(RELEASE_CHECK_PATHS.includes(path));
  }
});

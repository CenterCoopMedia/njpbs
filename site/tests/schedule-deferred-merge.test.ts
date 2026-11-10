import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = parse(readFileSync(path.join(repoRoot, ".github/workflows/schedule-bake.yml"), "utf8"));
const sha = "a".repeat(40);
const repository = { id: 123456, full_name: "fixture-owner/source-site" };
const appSlug = "schedule-bake-fixture";
// REST workflow-run and PR fields, checked against the provider responses.
const run = () => ({
  workflow_id: 287129385, path: ".github/workflows/ci.yml", event: "pull_request",
  status: "completed", conclusion: "success", repository, head_repository: repository,
  head_branch: "automation/schedule-bake", head_sha: sha,
  pull_requests: [{ number: 2593,
    head: { sha, ref: "automation/schedule-bake", repo: repository },
    base: { ref: "main", repo: repository } }],
});
const github = () => ({
  event_name: "workflow_run", triggering_actor: `${appSlug}[bot]`, repository: repository.full_name, repository_id: String(repository.id), ref: "refs/heads/main",
  workflow_ref: "fixture-owner/source-site/.github/workflows/schedule-bake.yml@refs/heads/main",
  event: { workflow_run: run() },
});

describe("deferred schedule merge", () => {
  it("admits the canonical scheduled and manual writer before concurrency", () => {
    const expression = new Function("github", "vars", "format", `return (${workflow.jobs.bake.if});`);
    const variables = { CANONICAL_GITHUB_REPOSITORY: repository.full_name,
      CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id), SCHEDULE_BAKE_APP_SLUG: appSlug };
    const event = { event_name: "schedule", repository: repository.full_name, repository_id: String(repository.id),
      ref: "refs/heads/main", workflow_ref: `${repository.full_name}/.github/workflows/schedule-bake.yml@refs/heads/main` };
    const admitted = (data = event, settings = variables) => expression(data, settings,
      (pattern: string, value: string) => pattern.replace("{0}", value));

    expect(admitted()).toBe(true);
    expect(admitted({ ...event, event_name: "workflow_dispatch" })).toBe(true);
    const transferred = "fixture-owner/transferred-site";
    expect(admitted({ ...event, repository: transferred,
      workflow_ref: `${transferred}/.github/workflows/schedule-bake.yml@refs/heads/main` },
    { ...variables, CANONICAL_GITHUB_REPOSITORY: transferred })).toBe(true);
    for (const overrides of [
      { event_name: "pull_request" }, { event_name: "workflow_run" }, { event_name: "push" },
      { repository: "fork/source-site" }, { repository_id: "789" }, { ref: "refs/heads/feature" },
      { workflow_ref: `${repository.full_name}/.github/workflows/other.yml@refs/heads/main` },
      { workflow_ref: `${repository.full_name}/.github/workflows/schedule-bake.yml@refs/heads/feature` },
    ]) expect(admitted({ ...event, ...overrides })).toBe(false);
    for (const name of ["CANONICAL_GITHUB_REPOSITORY", "CANONICAL_GITHUB_REPOSITORY_ID", "SCHEDULE_BAKE_APP_SLUG"]) {
      expect(admitted(event, { ...variables, [name]: "" })).toBe(false);
    }
  });

  it("admits the trusted CI completion before shared writer concurrency", () => {
    expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"], branches: ["automation/schedule-bake"] });
    const job = workflow.jobs["deferred-admission"];
    const mergeJob = workflow.jobs["deferred-merge"];
    const expression = new Function("github", "vars", "format", `return (${job.if});`);
    const admitted = (data: any, expectedRepository = repository.full_name) => expression(data, {
      CANONICAL_GITHUB_REPOSITORY: expectedRepository, CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id),
      SCHEDULE_BAKE_APP_SLUG: appSlug,
    }, (pattern: string, value: string) => pattern.replace("{0}", value));
    expect(admitted(github())).toBe(true);
    const org = "fixture-org/transferred-site";
    expect(admitted({ ...github(), repository: org,
      workflow_ref: `${org}/.github/workflows/schedule-bake.yml@refs/heads/main`,
      event: { workflow_run: { ...run(), repository: { ...repository, full_name: org },
        head_repository: { ...repository, full_name: org } } } }, org)).toBe(true);
    expect(expression(github(), { CANONICAL_GITHUB_REPOSITORY: repository.full_name,
      CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id), SCHEDULE_BAKE_APP_SLUG: "" },
    (pattern: string, value: string) => pattern.replace("{0}", value))).toBe(false);
    for (const overrides of [
      { event_name: "workflow_dispatch" }, { repository: "fork/njpbs-site" }, { ref: "refs/heads/feature" },
      { workflow_ref: "fixture-owner/source-site/.github/workflows/other.yml@refs/heads/main" },
      { workflow_ref: "fixture-owner/source-site/.github/workflows/schedule-bake.yml@refs/heads/feature" },
    ]) expect(admitted({ ...github(), ...overrides })).toBe(false);
    for (const overrides of [
      { event: "push" }, { conclusion: "failure" }, { head_branch: "feature" },
      { head_repository: { full_name: "fork/njpbs-site" } },
    ]) expect(admitted({ ...github(), event: { workflow_run: { ...run(), ...overrides } } })).toBe(false);
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency).toBeUndefined();
    expect(mergeJob.concurrency).toEqual(workflow.jobs.bake.concurrency);
    expect(mergeJob.needs).toBe("deferred-admission");
    expect(mergeJob.if).toBe("needs.deferred-admission.outputs.number != ''");
    expect(job.outputs).toEqual({ number: "${{ steps.admission.outputs.number }}", head_sha: "${{ steps.admission.outputs.head_sha }}" });
    expect(job.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    expect(job.steps[0].with).toMatchObject({ ref: "main", "persist-credentials": false });
    const admission = job.steps.findIndex((step: { id?: string }) => step.id === "admission");
    expect(admission).toBeGreaterThan(0);
    expect(job.steps.some((step: { id?: string }) => step.id === "app-token")).toBe(false);
    const recheck = mergeJob.steps.findIndex((step: { id?: string }) => step.id === "admission");
    const token = mergeJob.steps.findIndex((step: { id?: string }) => step.id === "app-token");
    expect(recheck).toBeLessThan(token);
    expect(mergeJob.steps[recheck].run).toBe(job.steps[admission].run);
    expect(mergeJob.steps[recheck].env).toEqual(job.steps[admission].env);
    expect(mergeJob.permissions).toEqual(job.permissions);
    expect(mergeJob.steps[token].if).toBe("steps.admission.outputs.number != ''");
    expect(mergeJob.steps.filter((step: { name?: string }) => step.name !== undefined && step.name !== "Recheck schedule CI completion inside writer concurrency" && step.name !== "Report deferred merge failure to Healthchecks")
      .every((step: { if?: string }) => step.if === "steps.admission.outputs.number != ''")).toBe(true);
    const identity = mergeJob.steps.find((step: { name?: string }) => step.name === "Set schedule bot identity for rebases");
    const bakeIdentity = workflow.jobs.bake.steps.find((step: { id?: string }) => step.id === "commit");
    for (const line of identity.run.trim().split("\n")) expect(bakeIdentity.run).toContain(line);
    const deferredMerge = mergeJob.steps.find((step: { name?: string }) => step.name === "Merge the verified deferred schedule-only update");
    expect(deferredMerge.run).toContain("bash .github/scripts/merge-schedule-pr.sh");
    expect(deferredMerge.run).toContain("export CI_WAIT_DEADLINE=");
    expect(workflow.jobs.bake.steps.some((step: { run?: string }) => step.run?.includes("merge-schedule-pr.sh"))).toBe(false);
    expect(deferredMerge.env).toMatchObject({ PR_NUMBER: "${{ steps.admission.outputs.number }}", HEAD_SHA: "${{ steps.admission.outputs.head_sha }}" });
  });

  it("starts the alert job only for a trusted non-success CI completion", () => {
    const job = workflow.jobs["ci-failure-alert"];
    const expression = new Function("github", "vars", "format", `return (${job.if});`);
    const admitted = (data: any, expectedRepository = repository.full_name) => expression(data, {
      CANONICAL_GITHUB_REPOSITORY: expectedRepository, CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id),
      SCHEDULE_BAKE_APP_SLUG: appSlug,
    }, (pattern: string, value: string) => pattern.replace("{0}", value));
    expect(admitted(github())).toBe(false);
    const failed = { ...github(), event: { workflow_run: { ...run(), conclusion: "failure" } } };
    expect(admitted(failed)).toBe(true);
    for (const overrides of [
      { event_name: "schedule" }, { event_name: "workflow_dispatch" },
      { triggering_actor: "other-user" }, { ref: "refs/heads/feature" },
      { workflow_ref: "fixture-owner/source-site/.github/workflows/schedule-bake.yml@refs/heads/feature" },
      { repository: "fork/njpbs-site" },
    ]) expect(admitted({ ...failed, ...overrides })).toBe(false);
    for (const overrides of [
      { conclusion: "neutral" }, { conclusion: "skipped" }, { event: "push" }, { head_branch: "feature" }, { head_repository: { full_name: "fork/njpbs-site" } },
    ]) expect(admitted({ ...failed, event: { workflow_run: { ...failed.event.workflow_run, ...overrides } } })).toBe(false);
    expect(job.steps[0].with).toEqual({ ref: "main", "persist-credentials": false });
    expect(job.environment).toBe("schedule-bake");
    expect(job.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    expect(JSON.stringify(job)).not.toContain("SCHEDULE_BAKE_APP_PRIVATE_KEY");
    for (const name of ["deferred-admission", "deferred-merge"]) {
      const failureStep = workflow.jobs[name].steps.at(-1);
      const condition = new Function("failure", "steps", "env", "github", "vars", "format", `return (${failureStep.if});`);
      for (const failed of [true, false]) {
        expect(condition(() => failed, { admission: { outputs: { number: "" } } },
          { HEALTHCHECKS_CONFIGURED: "true" }, github(), { CANONICAL_GITHUB_REPOSITORY: repository.full_name,
            CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id), SCHEDULE_BAKE_APP_SLUG: appSlug },
          (pattern: string, value: string) => pattern.replace("{0}", value))).toBe(failed);
      }
    }
  });

  it.each([
    "current", "org", "qualified-path", "failed-alert", "cancelled-alert", "neutral-alert", "skipped-alert", "api-error-alert", "passing-alert", "stale-alert", "fork-alert", "fork", "other-workflow", "other-path", "other-branch", "push", "failed", "running",
    "untrusted-writer", "other-bot", "missing-author", "human-app-name", "stale-head", "closed", "fork-pr", "other-pr", "other-base", "wrong-pr-sha", "wrong-pr-repo", "wrong-run-repo-id", "wrong-head-repo-id", "no-pr", "api-error",
  ])("resolves the live exact-head PR and rejects unrelated completions: %s", (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "schedule-admission-"));
    const payload = run();
    const activeRepository = mode === "org" ? "fixture-org/transferred-site" : repository.full_name;
    if (mode === "org") {
      payload.repository = { ...repository, full_name: activeRepository };
      payload.head_repository = payload.repository;
    }
    let prs = [{ number: 2593, headRefOid: sha, isCrossRepository: false, author: { login: `app/${appSlug}`, is_bot: true } }];
    switch (mode) {
      case "untrusted-writer": prs[0].author = { login: "writer", is_bot: false }; break;
      case "other-bot": prs[0].author.login = "app/other-bot"; break;
      case "missing-author": delete (prs[0] as { author?: unknown }).author; break;
      case "human-app-name": prs[0].author.is_bot = false; break;
      case "qualified-path": payload.path = ".github/workflows/ci.yml@refs/pull/2593/merge"; break;
      case "fork": payload.head_repository = { ...repository, full_name: "fork/njpbs-site" }; break;
      case "other-workflow": payload.workflow_id = 123; break;
      case "other-path": payload.path = ".github/workflows/other.yml"; break;
      case "other-branch": payload.head_branch = "feature"; break;
      case "push": payload.event = "push"; break;
      case "failed": payload.conclusion = "failure"; break;
      case "failed-alert": payload.conclusion = "failure"; break;
      case "cancelled-alert": payload.conclusion = "cancelled"; break;
      case "neutral-alert": payload.conclusion = "neutral"; break;
      case "skipped-alert": payload.conclusion = "skipped"; break;
      case "stale-alert": payload.conclusion = "failure"; prs[0].headRefOid = "b".repeat(40); break;
      case "fork-alert": payload.conclusion = "failure"; payload.head_repository = { ...repository, full_name: "fork/njpbs-site" }; break;
      case "running": payload.status = "in_progress"; break;
      case "stale-head": prs[0].headRefOid = "b".repeat(40); break;
      case "closed": prs = []; break;
      case "fork-pr": prs[0].isCrossRepository = true; break;
      case "other-pr": payload.pull_requests[0].number = 2594; break;
      case "other-base": payload.pull_requests[0].base.ref = "develop"; break;
      case "wrong-pr-sha": payload.pull_requests[0].head.sha = "b".repeat(40); break;
      case "wrong-pr-repo": payload.pull_requests[0].head.repo = { ...repository, id: 99 }; break;
      case "wrong-run-repo-id": payload.repository = { ...repository, id: 99 }; break;
      case "wrong-head-repo-id": payload.head_repository = { ...repository, id: 99 }; break;
      case "no-pr": payload.pull_requests = []; break;
    }
    try {
      writeFileSync(path.join(root, "run.json"), JSON.stringify(payload));
      writeFileSync(path.join(root, "prs.json"), JSON.stringify(prs));
      writeFileSync(path.join(root, "output"), "");
      writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -euo pipefail
if [ "$FIXTURE_MODE" = api-error ] || [ "$FIXTURE_MODE" = api-error-alert ]; then exit 42; fi
case "$1 $2" in
  "api repos/${activeRepository}/actions/workflows/ci.yml") echo 287129385 ;;
  "api repos/${activeRepository}/actions/runs/777")
    test "$3" = --jq
    jq -c "$4" "$FIXTURE_ROOT/run.json" ;;
  "pr list") cat "$FIXTURE_ROOT/prs.json" ;;
  *) exit 89 ;;
esac
`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", [".github/scripts/admit-schedule-ci.sh", ...(mode.endsWith("-alert") ? ["failure"] : [])], {
        cwd: repoRoot, encoding: "utf8", timeout: 5000,
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
          CANONICAL_GITHUB_REPOSITORY: activeRepository, CANONICAL_GITHUB_REPOSITORY_ID: String(repository.id), SCHEDULE_BAKE_APP_SLUG: appSlug,
          GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_REPOSITORY: activeRepository, GITHUB_OUTPUT: path.join(root, "output"), RUN_ID: "777" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(mode.startsWith("api-error") ? 42 : 0);
      const accepted = ["current", "org", "qualified-path", "failed-alert", "cancelled-alert"].includes(mode);
      expect(readFileSync(path.join(root, "output"), "utf8")).toBe(accepted ? `number=2593\nhead_sha=${sha}\n` : "");
      if (mode.endsWith("-alert")) {
        writeFileSync(path.join(root, "alerts"), "");
        writeFileSync(path.join(root, "curl"), '#!/bin/bash\necho alert >> "$FIXTURE_ROOT/alerts"\n', { mode: 0o755 });
        const alert = workflow.jobs["ci-failure-alert"].steps.at(-1);
        const shouldAlert = new Function("steps", "env", "failure", `return (${alert.if});`)(
          { admission: { outputs: { number: accepted ? "2593" : "" } } }, { HEALTHCHECKS_CONFIGURED: "true" }, () => result.status !== 0);
        if (shouldAlert) {
          const reported = spawnSync("bash", ["-e", "-c", alert.run], {
            env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, HEALTHCHECKS_URL: "https://heartbeat.invalid/test" },
            encoding: "utf8", timeout: 5000,
          });
          expect(reported.status, reported.stderr).toBe(0);
        }
        expect(readFileSync(path.join(root, "alerts"), "utf8")).toBe(accepted || mode === "api-error-alert" ? "alert\n" : "");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails schedule admission closed without the configured App slug", () => {
    const result = spawnSync("/bin/bash", [".github/scripts/admit-schedule-ci.sh"], {
      cwd: repoRoot, encoding: "utf8", env: { PATH: "/usr/bin:/bin", RUN_ID: "777",
        GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_OUTPUT: "/dev/null" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SCHEDULE_BAKE_APP_SLUG");
  });
});

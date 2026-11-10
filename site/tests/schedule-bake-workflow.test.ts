import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ciWait = read("../../.github/scripts/wait-schedule-ci.sh");
const mergeScript = read("../../.github/scripts/merge-schedule-pr.sh");
const workflow = read("../../.github/workflows/schedule-bake.yml");
const pagesWorkflow = read("../../.github/workflows/pages.yml");
const wranglerConfig = read("../../workers/wrangler.jsonc");
const packageJson = read("../package.json");
const productionBuild = read("../scripts/build-with-production-sync.mjs");
const appSlug = "schedule-bake-fixture";

describe("schedule bake automation", () => {
  it("runs twice daily with the site toolchain", () => {
    expect(workflow).toContain('cron: "0 9 * * *"');
    expect(workflow).toContain('cron: "0 21 * * *"');
    expect(workflow).toContain("group: schedule-bake");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v7");
    expect(workflow).toContain('node-version: "22"');
    expect(workflow).toContain("cache-dependency-path: site/package-lock.json");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run sync:schedule");
  });

  it("allows manual recovery only from reviewed main", () => {
    const config = parse(workflow);
    expect(config.on).toHaveProperty("workflow_dispatch");
    // A rejected dispatch must be skipped before it enters bake concurrency.
    expect(config.concurrency).toBeUndefined();
    expect(config.jobs.bake.concurrency).toEqual({ group: "schedule-bake", "cancel-in-progress": false });
    for (const admission of ["vars.CANONICAL_GITHUB_REPOSITORY != ''", "vars.CANONICAL_GITHUB_REPOSITORY_ID != ''",
      "vars.SCHEDULE_BAKE_APP_SLUG != ''", "github.repository == vars.CANONICAL_GITHUB_REPOSITORY",
      "github.repository_id == vars.CANONICAL_GITHUB_REPOSITORY_ID",
      "github.workflow_ref == format('{0}/.github/workflows/schedule-bake.yml@refs/heads/main', vars.CANONICAL_GITHUB_REPOSITORY)",
      "github.ref == 'refs/heads/main'", "github.event_name == 'schedule'", "github.event_name == 'workflow_dispatch'"]) {
      expect(config.jobs.bake.if).toContain(admission);
    }
    expect(config.jobs.bake.steps.find((step: { name?: string }) => step.name === "Bake schedule").env)
      .toEqual({ REQUIRE_FRESH_CONTENT: "1" });
  });

  it("updates the baked file through the protected-main pull request path", () => {
    expect(workflow).toContain("site/src/data/schedule.json");
    expect(workflow).toContain("automation/schedule-bake");
    expect(workflow).toContain("gh pr create");
    expect(workflow).not.toContain("gh workflow run ci.yml");
    expect(ciWait).toContain("--event pull_request");
    expect(workflow).not.toContain("--event workflow_dispatch");
    expect(workflow).not.toMatch(/git push[^\n]+HEAD:main/);
    expect(workflow).toContain("committed fourteen-day schedule window");
  });

  it("uses the schedule bake app for repository writes", () => {
    expect(workflow).toContain("permissions:\n  actions: read");
    expect(workflow).toContain(
      "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
    );
    expect(workflow).toContain(
      "client-id: ${{ vars.SCHEDULE_BAKE_APP_CLIENT_ID }}",
    );
    expect(workflow).toContain(
      "private-key: ${{ secrets.SCHEDULE_BAKE_APP_PRIVATE_KEY }}",
    );
    expect(workflow).toContain("SCHEDULE_BAKE_APP_SLUG: ${{ vars.SCHEDULE_BAKE_APP_SLUG }}");
    expect(workflow).toContain("format('{0}[bot]', vars.SCHEDULE_BAKE_APP_SLUG)");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain("permission-pull-requests: write");
    expect(workflow).toContain("token: ${{ steps.app-token.outputs.token }}");
    const steps = parse(workflow).jobs.bake.steps;
    expect(parse(workflow).jobs.bake.permissions).toEqual({ contents: "read", actions: "read" });
    const checkout = steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v7");
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with.token).toBeUndefined();
    expect(steps.findIndex((step: { id?: string }) => step.id === "app-token"))
      .toBeGreaterThan(steps.findIndex((step: { name?: string }) => step.name === "Bake schedule"));
    const push = steps.find((step: { name?: string }) => step.name === "Push schedule update");
    expect(push.if).toBe("steps.commit.outputs.changed == 'true'");
    expect(push.run).toContain("credential.helper=!gh auth git-credential");
    const bakeTokens = steps.map((step: { env?: { GH_TOKEN?: string } }) => step.env?.GH_TOKEN);
    expect(bakeTokens.filter((token: string | undefined) => token === "${{ steps.app-token.outputs.token }}")).toHaveLength(2);
    expect(bakeTokens.filter((token: string | undefined) => token === "${{ github.token }}")).toHaveLength(1);
    expect(workflow).toContain("Schedule bake app credentials are missing");
  });

  it("merges only the exact schedule-only head after required CI succeeds", () => {
    expect(ciWait).toContain('if [ "$conclusion" = "success" ]');
    const mergeStep = parse(workflow).jobs["deferred-merge"].steps.find(
      (step: { name?: string }) => step.name === "Merge the verified deferred schedule-only update",
    );
    expect(mergeStep.if).toBe("steps.admission.outputs.number != ''");
    expect(mergeScript).toContain("gh pr diff");
    expect(workflow).toContain("site/src/data/schedule.json");
    expect(mergeScript).toContain("--match-head-commit");
    expect(mergeScript).toContain("gh pr merge");
    expect(mergeScript).toContain("--squash");
  });

  it("finishes a completed bake successfully while the PR awaits CI", () => {
    const steps = parse(workflow).jobs.bake.steps;
    const commands = steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(commands).not.toMatch(/wait-schedule-ci|merge-schedule-pr|CI_WAIT_DEADLINE/);
    const report = steps.findIndex((step: { name?: string }) => step.name === "Report deferred schedule merge");
    expect(steps[report].if).toBe("steps.commit.outputs.changed == 'true'");
    expect(steps[report].run).toContain("awaits CI");
    expect(steps[report + 1]).toMatchObject({
      name: "Report result to Healthchecks",
      if: "always() && env.HEALTHCHECKS_CONFIGURED == 'true'",
      env: { JOB_STATUS: "${{ job.status }}" },
    });
    expect(steps[report + 1].run).toContain('if [ "$JOB_STATUS" = "success" ]');
  });

  it.each([
    { mode: "present", reads: 1, waits: 0, status: 0 },
    { mode: "late", reads: 5, waits: 4, status: 0 },
    { mode: "missing", reads: 5, waits: 4, status: 1 },
    { mode: "api-error", reads: 1, waits: 0, status: 42 },
  ])("discovers the exact-head CI event without waiting for completion: $mode", ({ mode, reads, waits, status }) => {
    const step = parse(workflow).jobs.bake.steps.find((step: { name?: string }) => step.name === "Confirm schedule CI run exists");
    expect(step.run).not.toMatch(/status|conclusion|watch|CI_WAIT_DEADLINE/);
    expect(step.run).toContain("timeout 60s bash -euo pipefail");
    const root = mkdtempSync(path.join(tmpdir(), "schedule-discovery-"));
    try {
      writeFileSync(path.join(root, "reads"), "0");
      writeFileSync(path.join(root, "waits"), "");
      writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -euo pipefail
test "$1 $2" = "run list"
case "$*" in *"--event pull_request"*) ;; *) exit 89 ;; esac
case "$*" in *"env.HEAD_SHA"*) ;; *) exit 89 ;; esac
reads=$(cat "$FIXTURE_ROOT/reads")
reads=$((reads + 1))
echo "$reads" > "$FIXTURE_ROOT/reads"
if [ "$FIXTURE_MODE" = api-error ]; then exit 42; fi
if [ "$FIXTURE_MODE" = present ] || { [ "$FIXTURE_MODE" = late ] && [ "$reads" -eq 5 ]; }; then echo 777; fi
`, { mode: 0o755 });
      writeFileSync(path.join(root, "sleep"), '#!/bin/bash\ntest "$1" = 12 || exit 89\necho wait >> "$FIXTURE_ROOT/waits"\n', { mode: 0o755 });
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
          GITHUB_REPOSITORY: "fixture/repository", HEAD_SHA: "a".repeat(40) }, encoding: "utf8", timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(status);
      expect(Number(readFileSync(path.join(root, "reads"), "utf8"))).toBe(reads);
      expect(readFileSync(path.join(root, "waits"), "utf8").match(/wait/g) ?? []).toHaveLength(waits);
      if (mode === "missing") expect(result.stderr).toContain("No CI run found");
      const resultStep = parse(workflow).jobs.bake.steps.at(-1);
      expect(resultStep.if).toContain("always()");
      expect(resultStep.run).toContain('endpoint="${HEALTHCHECKS_URL}/fail?rid=${HEALTHCHECKS_RUN_ID}"');
      writeFileSync(path.join(root, "curl"), '#!/bin/bash\nprintf "%s\\n" "${!#}" >> "$FIXTURE_ROOT/pings"\n', { mode: 0o755 });
      const reported = spawnSync("bash", ["-e", "-c", resultStep.run], {
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root,
          HEALTHCHECKS_URL: "https://heartbeat.invalid/test", HEALTHCHECKS_RUN_ID: "fixture",
          JOB_STATUS: status === 0 ? "success" : "failure" }, encoding: "utf8", timeout: 5000,
      });
      expect(reported.status, reported.stderr).toBe(0);
      expect(readFileSync(path.join(root, "pings"), "utf8")).toBe(
        `https://heartbeat.invalid/test${status === 0 ? "" : "/fail"}?rid=fixture\n`);

    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("treats a missing schedule update pull request as an empty result", () => {
    expect(workflow).toContain("--jq '.[0].number // empty'");
    expect(workflow).not.toContain("--jq '.[0].number'");
  });

  it.each([
    { mode: "converges", status: 0, views: 3, waits: 2 },
    { mode: "mismatch", status: 1, views: 30, waits: 30 },
    { mode: "api-error", status: 42, views: 1, waits: 0 },
  ])("waits for the exact pushed head and fails closed: $mode", ({ mode, status, views, waits }) => {
    const step = parse(workflow).jobs.bake.steps.find(
      (candidate: { name?: string }) => candidate.name === "Open schedule update pull request",
    );
    const root = mkdtempSync(path.join(tmpdir(), "schedule-pr-head-"));
    const expectedSha = "a".repeat(40);
    try {
      writeFileSync(path.join(root, "views"), "0");
      writeFileSync(path.join(root, "waits"), "");
      writeFileSync(path.join(root, "output"), "");
      // Execute the real workflow step. These adapters permit only its reads;
      // sleep records a retry without delaying the test or contacting GitHub.
      writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -euo pipefail
if [ "$1 $2" = "pr list" ]; then echo 2508; exit 0; fi
test "$1 $2" = "pr view"
attempt=$(cat "$FIXTURE_ROOT/views")
attempt=$((attempt + 1))
echo "$attempt" > "$FIXTURE_ROOT/views"
if [ "$FIXTURE_MODE" = "api-error" ]; then echo 'fixture API failure' >&2; exit 42; fi
if [ "$FIXTURE_MODE" = "converges" ] && [ "$attempt" -ge 3 ]; then
  echo "$EXPECTED_SHA"
else
  echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
fi
`, { mode: 0o755 });
      writeFileSync(path.join(root, "git"), '#!/bin/bash\ntest "$*" = "rev-parse HEAD" || exit 89\necho "$EXPECTED_SHA"\n', { mode: 0o755 });
      writeFileSync(path.join(root, "sleep"), '#!/bin/bash\ntest "$1" = 2 || exit 89\necho wait >> "$FIXTURE_ROOT/waits"\n', { mode: 0o755 });
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
          EXPECTED_SHA: expectedSha, GITHUB_REPOSITORY: "fixture/repository", GITHUB_OUTPUT: path.join(root, "output") },
        encoding: "utf8", timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      expect(Number(readFileSync(path.join(root, "views"), "utf8"))).toBe(views);
      expect(readFileSync(path.join(root, "waits"), "utf8").match(/wait/g) ?? []).toHaveLength(waits);
      expect(readFileSync(path.join(root, "output"), "utf8")).toBe(
        status === 0 ? `number=2508\nhead_sha=${expectedSha}\n` : "",
      );
      if (mode === "mismatch") expect(result.stderr).toContain(`expected ${expectedSha}, observed ${"b".repeat(40)}`);
      if (mode === "api-error") expect(result.stderr).toContain("fixture API failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: "clean", status: 0, pushes: 0 },
    { mode: "behind-once", status: 0, pushes: 1 },
    { mode: "always-behind", status: 1, pushes: 2 },
    { mode: "blocked", status: 1, pushes: 0 },
    { mode: "ci-pending", status: 0, pushes: 1 },
    { mode: "ci-failed", status: 1, pushes: 1 },
    { mode: "initial-ci-pending", status: 0, pushes: 0 },
    { mode: "initial-ci-failed", status: 1, pushes: 0 },
    { mode: "fork", status: 1, pushes: 0 },
    { mode: "untrusted-writer", status: 1, pushes: 0 },
    { mode: "other-bot", status: 1, pushes: 0 },
    { mode: "missing-author", status: 1, pushes: 0 },
    { mode: "human-app-name", status: 1, pushes: 0 },
    { mode: "author-api-error", status: 42, pushes: 0 },
    { mode: "wrong-base", status: 1, pushes: 0 },
    { mode: "wrong-branch", status: 1, pushes: 0 },
    { mode: "wrong-head", status: 1, pushes: 0 },
    { mode: "extra-file", status: 1, pushes: 0 },
    { mode: "diff-error", status: 42, pushes: 0 },
    { mode: "bot-thread", status: 0, pushes: 0 },
    { mode: "human-thread", status: 1, pushes: 0 },
    { mode: "human-reply", status: 1, pushes: 0 },
  ])("rebases a schedule PR that falls behind main before merging: $mode", ({ mode, status, pushes }) => {
    const root = mkdtempSync(path.join(tmpdir(), "schedule-merge-"));
    const firstSha = "a".repeat(40);
    try {
      writeFileSync(path.join(root, "head"), firstSha);
      writeFileSync(path.join(root, "pushes"), "");
      writeFileSync(path.join(root, "merged"), "");
      writeFileSync(path.join(root, "resolved"), "");
      // Execute the real workflow step. The adapters model the PR, CI, and a
      // local rebase that produces a new head; nothing contacts GitHub.
      writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -euo pipefail
head=$(cat "$FIXTURE_ROOT/head")
case "$1 $2" in
  "pr view")
    case "$*" in
      *"--json author"*)
        case "$FIXTURE_MODE" in
          untrusted-writer) author='{"login":"writer","is_bot":false}' ;;
          other-bot) author='{"login":"app/other-bot","is_bot":true}' ;;
          missing-author) author=null ;;
          human-app-name) author='{"login":"app/${appSlug}","is_bot":false}' ;;
          author-api-error) exit 42 ;;
          *) author='{"login":"app/${appSlug}","is_bot":true}' ;;
        esac
        printf '{"author":%s}\\n' "$author" ;;
      *"--json state "*) echo OPEN ;;
      *"--json baseRefName "*) if [ "$FIXTURE_MODE" = wrong-base ]; then echo develop; else echo main; fi ;;
      *"--json headRefName "*) if [ "$FIXTURE_MODE" = wrong-branch ]; then echo attacker; else echo automation/schedule-bake; fi ;;
      *"--json headRefOid "*) if [ "$FIXTURE_MODE" = wrong-head ]; then echo stale; else echo "$head"; fi ;;
      *"--json isCrossRepository "*) if [ "$FIXTURE_MODE" = fork ]; then echo true; else echo false; fi ;;
      *"--json headRepositoryOwner "*) echo fixture ;;
      *"--json mergeStateStatus "*)
        case "$FIXTURE_MODE" in
          clean|fork|wrong-base|wrong-branch|wrong-head|extra-file|diff-error|untrusted-writer|other-bot|missing-author|human-app-name|author-api-error) echo CLEAN ;;
          blocked|human-thread|human-reply) echo BLOCKED ;;
          bot-thread) if [ -s "$FIXTURE_ROOT/resolved" ]; then echo CLEAN; else echo BLOCKED; fi ;;
          always-behind) echo BEHIND ;;
          behind-once|ci-pending|ci-failed) if [ "$head" = "$FIRST_SHA" ]; then echo BEHIND; else echo CLEAN; fi ;;
        esac ;;
      *) exit 89 ;;
    esac ;;
  "pr diff")
    echo site/src/data/schedule.json
    if [ "$FIXTURE_MODE" = extra-file ]; then echo .github/workflows/ci.yml; fi
    if [ "$FIXTURE_MODE" = diff-error ]; then exit 42; fi ;;
  "run list")
    test "$GH_TOKEN" = actions-token
    test "$HEAD_SHA" = "$head"
    case "$FIXTURE_MODE" in
      initial-ci-pending) printf '777\\tin_progress\\tpending\\n' ;;
      initial-ci-failed) printf '777\\tcompleted\\tfailure\\n' ;;
      ci-pending) if [ "$head" = "$FIRST_SHA" ]; then printf '777\\tcompleted\\tsuccess\\n'; else printf '777\\tin_progress\\tpending\\n'; fi ;;
      ci-failed) if [ "$head" = "$FIRST_SHA" ]; then printf '777\\tcompleted\\tsuccess\\n'; else printf '777\\tcompleted\\tfailure\\n'; fi ;;
      *) printf '777\\tcompleted\\tsuccess\\n' ;;
    esac ;;
  "pr merge") echo "$*" > "$FIXTURE_ROOT/merged" ;;
  "api graphql")
    test "$GH_TOKEN" = app-token
    case "$*" in
      *resolveReviewThread*) echo "$*" >> "$FIXTURE_ROOT/resolved" ;;
      *)
        case "$FIXTURE_MODE" in
          bot-thread) threads='[{"id":"PRRT_bot","isResolved":false,"comments":{"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"chatgpt-codex-connector"}}]}},{"id":"PRRT_done","isResolved":true,"comments":{"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"chatgpt-codex-connector"}}]}}]' ;;
          human-thread) threads='[{"id":"PRRT_human","isResolved":false,"comments":{"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"writer"}}]}}]' ;;
          human-reply) threads='[{"id":"PRRT_reply","isResolved":false,"comments":{"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"chatgpt-codex-connector"}},{"author":{"login":"writer"}}]}}]' ;;
          *) threads='[]' ;;
        esac
        case "$*" in *"--paginate"*'after:$endCursor'*) ;; *) exit 89 ;; esac
        printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":%s}}}}}\\n' "$threads" | jq -r "\${!#}" ;;
    esac ;;
  *) exit 89 ;;
esac
`, { mode: 0o755 });
      writeFileSync(path.join(root, "git"), `#!/bin/bash
set -euo pipefail
case "$1" in
  fetch|checkout|rebase) ;;
  rev-parse) n=$(wc -l < "$FIXTURE_ROOT/pushes"); printf '%040d\n' $((n + 1)) ;;
  push) echo "$2" >> "$FIXTURE_ROOT/pushes"; n=$(wc -l < "$FIXTURE_ROOT/pushes"); printf '%040d' "$n" > "$FIXTURE_ROOT/head" ;;
  *) exit 89 ;;
esac
`, { mode: 0o755 });
      writeFileSync(path.join(root, "sleep"), "#!/bin/bash\ntest \"$1\" = 2 || exit 89\n", { mode: 0o755 });
      const result = spawnSync("bash", [".github/scripts/merge-schedule-pr.sh"], {
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_MODE: mode,
          FIRST_SHA: firstSha, HEAD_SHA: firstSha, PR_NUMBER: "2518", GH_TOKEN: "app-token", SCHEDULE_BAKE_APP_SLUG: appSlug,
          ACTIONS_TOKEN: "actions-token", GITHUB_REPOSITORY: "fixture/repository",
          CI_WAIT_DEADLINE: "0", GITHUB_STEP_SUMMARY: path.join(root, "summary") },
        cwd: repoRoot,
        encoding: "utf8", timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      if (["untrusted-writer", "other-bot", "missing-author", "human-app-name"].includes(mode)) {
        expect(result.stderr).toContain("Schedule PR 2518 must be authored by the schedule-bake App");
      }
      const pushLines = readFileSync(path.join(root, "pushes"), "utf8").split("\n").filter(Boolean);
      expect(pushLines).toHaveLength(pushes);
      // Each push is leased to the exact head that was verified before it.
      pushLines.forEach((lease, index) => {
        const expected = index === 0 ? firstSha : String(index).padStart(40, "0");
        expect(lease).toBe(`--force-with-lease=refs/heads/automation/schedule-bake:${expected}`);
      });
      // Only an open review-bot thread is resolved; a person's thread still blocks.
      const resolved = readFileSync(path.join(root, "resolved"), "utf8");
      if (mode === "bot-thread") {
        expect(resolved).toContain("threadId=PRRT_bot");
        expect(resolved).not.toContain("PRRT_done");
      } else {
        expect(resolved).toBe("");
      }
      const merged = readFileSync(path.join(root, "merged"), "utf8");
      if (status === 0 && mode !== "ci-pending" && mode !== "initial-ci-pending") {
        const mergedSha = pushes === 0 ? firstSha : String(pushes).padStart(40, "0");
        expect(merged).toContain(`--match-head-commit ${mergedSha}`);
      } else {
        expect(merged).toBe("");
        if (mode === "ci-pending" || mode === "initial-ci-pending") {
          expect(readFileSync(path.join(root, "summary"), "utf8")).toContain("CI pending");
        } else {
          if (["fork", "wrong-base", "wrong-branch", "wrong-head", "extra-file", "diff-error", "untrusted-writer", "other-bot", "missing-author", "human-app-name", "author-api-error"].includes(mode)) return;
          expect(result.stderr).toContain(mode === "ci-failed" || mode === "initial-ci-failed" ? "completed with failure" :
            ["blocked", "human-thread", "human-reply"].includes(mode) ? "not mergeable: BLOCKED" : "not mergeable: BEHIND");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { observation: "777\tcompleted\tsuccess", status: 0, ready: "true" },
    { observation: "progression", status: 0, ready: "true" },
    { observation: "late-arrival", status: 0, ready: "false" },
    { observation: "777\tqueued\tpending", status: 0, ready: "false" },
    { observation: "777\tin_progress\tpending", status: 0, ready: "false" },
    { observation: "", status: 1, ready: "" },
    { observation: "missing-discovery", status: 1, ready: "" },
    { observation: "777\tcompleted\tfailure", status: 1, ready: "" },
    { observation: "777\tcompleted\tcancelled", status: 1, ready: "" },
    { observation: "777\tcompleted\ttimed_out", status: 1, ready: "" },
    { observation: "777\tcompleted\tpending", status: 1, ready: "" },
    { observation: "777\tsurprise\tpending", status: 1, ready: "" },
    { observation: "api-error", status: 1, ready: "" },
  ])("routes CI success, pending and real errors: $observation", ({ observation, status, ready }) => {
    const root = mkdtempSync(path.join(tmpdir(), "schedule-ci-wait-"));
    try {
      writeFileSync(path.join(root, "output"), "");
      writeFileSync(path.join(root, "clock"), observation === "progression" ? "100" : "1400");
      writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -euo pipefail
test "$1 $2" = "run list"
test "$HEAD_SHA" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
case "$*" in *"--event pull_request"*) ;; *) exit 89 ;; esac
if [ "$OBSERVATION" = api-error ]; then exit 42; fi
if [ "$OBSERVATION" = missing-discovery ]; then exit 0; fi
if [ "$OBSERVATION" = late-arrival ]; then
  if [ -f "$FIXTURE_ROOT/polled" ]; then printf '777\\tqueued\\tpending\\n'; else touch "$FIXTURE_ROOT/polled"; fi
  exit 0
fi
if [ "$OBSERVATION" = progression ]; then
  if [ -f "$FIXTURE_ROOT/polled" ]; then printf '777\\tcompleted\\tsuccess\\n'; else
    touch "$FIXTURE_ROOT/polled"
    printf '777\\tqueued\\tpending\\n'
  fi
  exit 0
fi
printf '%s\\n' "$OBSERVATION"
`, { mode: 0o755 });
      // The ordinary cases expire the CI deadline. Missing-event discovery
      // advances 30 seconds per read; progression stays inside both deadlines.
      writeFileSync(path.join(root, "date"), `#!/bin/bash
clock=$(cat "$FIXTURE_ROOT/clock")
echo "$clock"
if [ "$OBSERVATION" = progression ]; then exit 0; fi
if [ "$OBSERVATION" = missing-discovery ] || { [ "$OBSERVATION" = late-arrival ] && [ "$clock" -ge 1400 ]; }; then
  echo $((clock + 30)) > "$FIXTURE_ROOT/clock"
elif [ "$clock" -lt 1400 ]; then
  echo 1400 > "$FIXTURE_ROOT/clock"
else
  echo $((clock + 60)) > "$FIXTURE_ROOT/clock"
fi
`, { mode: 0o755 });
      writeFileSync(path.join(root, "sleep"), '#!/bin/bash\ntest "$1" = 15 || exit 89\necho wait >> "$FIXTURE_ROOT/waits"\n', { mode: 0o755 });
      const result = spawnSync("bash", [".github/scripts/wait-schedule-ci.sh"], {
        cwd: repoRoot,
        env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, OBSERVATION: observation,
          HEAD_SHA: "a".repeat(40), PR_NUMBER: "2518", GITHUB_REPOSITORY: "fixture/repository",
          CI_WAIT_DEADLINE: "1300", GITHUB_OUTPUT: path.join(root, "output"),
          GITHUB_STEP_SUMMARY: path.join(root, "summary") },
        encoding: "utf8", timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(ready === "false" ? 2 : status);
      expect(readFileSync(path.join(root, "output"), "utf8")).toBe("");
      if (ready === "false") expect(readFileSync(path.join(root, "summary"), "utf8")).toContain("CI pending");
      if (observation === "" || observation === "missing-discovery") expect(result.stderr).toContain("No CI run found");
      if (observation === "progression" || observation === "late-arrival") expect(readFileSync(path.join(root, "waits"), "utf8")).toBe("wait\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the merge path closed without the configured App slug", () => {
    const result = spawnSync("/bin/bash", [".github/scripts/merge-schedule-pr.sh"], {
      cwd: repoRoot, encoding: "utf8", env: { PATH: "/usr/bin:/bin", PR_NUMBER: "2518",
        HEAD_SHA: "a".repeat(40), GITHUB_REPOSITORY: "fixture/repository", ACTIONS_TOKEN: "actions-token", CI_WAIT_DEADLINE: "0" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SCHEDULE_BAKE_APP_SLUG");
  });

  it("reports each run to the configured Healthchecks endpoint", () => {
    expect(workflow).toContain("secrets.HEALTHCHECKS_SCHEDULE_BAKE");
    expect(workflow).toMatch(
      /- name: Report start to Healthchecks\r?\n\s+if: env\.HEALTHCHECKS_CONFIGURED == 'true'/,
    );
    expect(workflow).toMatch(
      /- name: Report result to Healthchecks\r?\n\s+if: always\(\) && env\.HEALTHCHECKS_CONFIGURED == 'true'/,
    );
    expect(workflow).toContain("/start?rid=");
    expect(workflow).toContain("/fail?rid=");
    expect(workflow).toContain("job.status");
  });

  it("says so on the run summary when the heartbeat is unarmed", () => {
    // The two report steps are skipped when the secret is unset, which is correct
    // (an unconfigured heartbeat should not fail the bake) but silent: the run goes
    // green and absent alerting is indistinguishable from working alerting. The
    // annotation is the only thing that makes the gap visible on the run itself.
    expect(workflow).toMatch(
      /- name: Warn when the Healthchecks heartbeat is unarmed\r?\n\s+if: env\.HEALTHCHECKS_CONFIGURED != 'true'/,
    );
    expect(workflow).not.toContain("FLEET_MONITOR_CONFIGURED");
    expect(workflow).not.toContain("SCHEDULE_BAKE_FLEET_MONITOR");
    expect(workflow).toContain("::warning title=");
    const warningStep = workflow.match(
      /- name: Warn when the Healthchecks heartbeat is unarmed[\s\S]*?(?=\r?\n      - name:)/,
    )?.[0];
    expect(warningStep).toContain("run: >-");
    expect(warningStep).not.toMatch(/\\\r?\n/);
    // It has to name the secret, or the reader is told there is a gap and not how
    // to close it.
    expect(workflow).toContain("HEALTHCHECKS_SCHEDULE_BAKE is unset");
  });

  it("keeps the Healthchecks ping URL out of job scope", () => {
    // Job scope exposes only a boolean, so the `if:` guards can branch on it
    // without the secret URL reaching checkout, setup-node, or npm ci.
    expect(workflow).toContain(
      "HEALTHCHECKS_CONFIGURED: ${{ secrets.HEALTHCHECKS_SCHEDULE_BAKE != '' }}",
    );
    // The raw secret is bound at step scope only, once per report step, so it is
    // never in the environment of the install steps that run third-party code.
    const urlBindings = workflow.match(
      /HEALTHCHECKS_URL: \$\{\{ secrets\.HEALTHCHECKS_SCHEDULE_BAKE \}\}/g,
    );
    expect(urlBindings).toHaveLength(5);
    // No job-scoped assignment of the raw URL (that was the leak this guards).
    expect(workflow).not.toMatch(
      /^ {6}HEALTHCHECKS_URL: \$\{\{ secrets\.HEALTHCHECKS_SCHEDULE_BAKE \}\}/m,
    );
  });

  it("bakes before both checked-in production build paths", () => {
    const pagesSync = pagesWorkflow.indexOf("npm run sync:schedule");
    const pagesBuild = pagesWorkflow.indexOf("npm run build");
    expect(pagesSync).toBeGreaterThan(-1);
    expect(pagesSync).toBeLessThan(pagesBuild);

    expect(packageJson).toContain(
      '"build": "tsx scripts/build-with-production-sync.mjs"',
    );
    expect(productionBuild).toContain('env.WORKERS_CI === "1"');
    expect(productionBuild).toContain('env.WORKERS_CI_BRANCH === "production"');
    expect(productionBuild).toContain("syncSchedule(env)");
    const workersSync = productionBuild.indexOf("await syncSchedule(env)");
    const workersBuild = productionBuild.indexOf("await build(");
    expect(workersSync).toBeGreaterThan(-1);
    expect(workersBuild).toBeGreaterThan(workersSync);
    expect(productionBuild.slice(workersBuild)).toContain("root: siteRoot");
    expect(wranglerConfig).toContain("WORKERS_CI=1");
  });
});

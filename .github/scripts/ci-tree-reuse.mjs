import { repositoryMatches } from "../../scripts/lib/repository-identity.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Allow normal PR-to-merge delays without trusting days-old CI runtimes.
const MAX_REUSE_AGE_MS = 6 * 60 * 60 * 1000;

// Keep this fail-closed when a consumer is renamed or sharded differently.
export const fullJobs = [
  "Policy", "Docs", "Site", "ci",
  "Admin / admin (1)", "Admin / admin (2)",
  ...[1, 2, 3, 4].map((shard) => `Admin / admin-visual (${shard})`),
  "Admin / admin-visual-complete",
  "Firebase / firebase",
  ...[1, 2, 3, 4].map((shard) => `Firebase / functions (${shard})`),
];

function ranOnGithubHostedRunner(job) {
  // Standard hosted jobs use group 0. Labels alone can also be set on custom runners.
  return job.runner_group_id === 0 && job.runner_group_name === "GitHub Actions" &&
    Array.isArray(job.labels) && job.labels.length === 1 &&
    ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"].includes(job.labels[0]);
}

export async function findReusableRun({ repository, tree, inputsHash, request, now = Date.now(), env = process.env }) {
  if (!repositoryMatches(repository, env)) return { reused: "false" };
  if (!Number.isFinite(now) || !/^[a-f0-9]{64}$/.test(inputsHash)) return { reused: "false" };
  // A bounded lookup is an optimization: a miss always runs the full suite.
  const { workflow_runs: runs } = await request(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=100`,
  );
  for (const run of runs) {
    if (run.event !== "pull_request" || run.status !== "completed" || run.conclusion !== "success" ||
        run.path?.split("@")[0] !== ".github/workflows/ci.yml" ||
        !repositoryMatches(run.repository?.full_name, env, run.repository?.id ?? "") ||
        !repositoryMatches(run.head_repository?.full_name, env, run.head_repository?.id ?? "") ||
        run.head_commit?.id !== run.head_sha ||
        !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.id)) continue;

    // created_at also bounds reruns: refreshing updated_at cannot revive an old runtime.
    const created = Date.parse(run.created_at);
    const completed = Date.parse(run.updated_at);
    if ([created, completed].some((time) => !Number.isFinite(time) || time > now ||
        now - time > MAX_REUSE_AGE_MS) || completed < created) continue;

    // GitHub clears run.pull_requests after merge. Its immutable reusable
    // workflow references retain the synthetic merge SHA actually tested.
    const admin = run.referenced_workflows?.find((workflow) =>
      /^[a-f0-9]{40}$/.test(workflow.sha) &&
      workflow.path === `${repository}/.github/workflows/admin-ci.yml@${workflow.sha}` &&
      /^refs\/pull\/[1-9][0-9]*\/merge$/.test(workflow.ref));
    if (!admin || !run.referenced_workflows.some((workflow) =>
      workflow.path === `${repository}/.github/workflows/firebase-ci.yml@${admin.sha}` &&
      workflow.sha === admin.sha && workflow.ref === admin.ref)) continue;
    const testedSha = admin.sha;
    const prNumber = admin.ref.split("/")[2];

    // A branch tree alone is insufficient: verify the actual tested merge tree.
    const commit = await request(`/repos/${repository}/git/commits/${testedSha}`);
    if (commit.sha !== testedSha || commit.tree?.sha !== tree) continue;
    const pr = await request(`/repos/${repository}/pulls/${prNumber}`);
    if (pr.base?.ref !== "main" || pr.base.repo?.id !== run.repository.id ||
        pr.head?.sha !== run.head_sha || pr.head.repo?.id !== run.repository.id) continue;
    const jobs = [];
    for (let page = 1; ; page++) {
      const result = await request(
        `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
      );
      jobs.push(...result.jobs);
      if (jobs.length >= result.total_count) break;
      if (result.jobs.length === 0 || page >= 10) throw new Error("Incomplete jobs response");
    }
    if (jobs.some((job) => job.status !== "completed" || job.conclusion !== "success" ||
        !ranOnGithubHostedRunner(job)) ||
        !fullJobs.every((name) => jobs.some((job) => job.name === name))) continue;
    const aggregate = jobs.find((job) => job.name === "ci");
    if (!aggregate.steps?.some((step) => step.name === `Full CI inputs ${inputsHash}` &&
        step.status === "completed" && step.conclusion === "success")) continue;
    return { reused: "true", run_id: String(run.id), tree };
  }
  return { reused: "false" };
}

export async function reuseFromEnvironment(env = process.env, fetcher = fetch) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") {
    return { reused: "false" };
  }
  const tree = execFileSync("git", ["rev-parse", `${env.GITHUB_SHA}^{tree}`], { encoding: "utf8" }).trim();
  const signal = AbortSignal.timeout(20_000);
  try {
    return await findReusableRun({
      repository: env.GITHUB_REPOSITORY, env, tree, inputsHash: env.CI_INPUTS_HASH,
      request: async (path) => {
        const response = await fetcher(`${env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}` },
          signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("GitHub lookup failed");
        return response.json();
      },
    });
  } catch {
    console.log("Tree reuse lookup unavailable; running full CI.");
    return { reused: "false" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await reuseFromEnvironment();
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
  console.log(result.reused === "true"
    ? `Reusing full CI run ${result.run_id} for identical tree ${result.tree}.`
    : "No eligible recent full PR run; running normal CI.");
}

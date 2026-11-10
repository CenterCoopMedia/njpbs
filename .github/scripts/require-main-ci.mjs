import { repositoryMatches } from "../../scripts/lib/repository-identity.mjs";
import { pathToFileURL } from "node:url";
import { releaseAuthorization, releaseInputs } from "./require-release-source.mjs";

// An ancestor deploy uses its own main CI, regardless of later main commits.
export async function requireMainCi({ repository, sha, request, env = process.env }) {
  return requireReleaseCi({ repository, sha, request, env });
}

export async function requireReleaseCi({ repository, sha, request, emergency = false, authorization = "", env = process.env }) {
  if (!repositoryMatches(repository, env)) throw new Error("Canonical repository identity refused");
  releaseAuthorization({ sha, emergency, authorization });
  const proof = emergency ? "emergency" : "main";
  const filter = emergency ? "" : "branch=main&event=push&";
  const { workflow_runs: runs } = await request(
    `/repos/${repository}/actions/workflows/ci.yml/runs?${filter}status=success&head_sha=${sha}&per_page=100`,
  );
  for (const run of runs) {
    const allowedEvent = emergency
      ? run.event === "workflow_dispatch"
      : run.event === "push" && run.head_branch === "main";
    if (!allowedEvent || run.head_sha !== sha ||
        run.status !== "completed" || run.conclusion !== "success" ||
        run.path?.split("@")[0] !== ".github/workflows/ci.yml" ||
        !repositoryMatches(run.repository?.full_name, env, run.repository?.id ?? "") ||
        !repositoryMatches(run.head_repository?.full_name, env, run.head_repository?.id ?? "") || !Number.isSafeInteger(run.id)) continue;

    let count = 0;
    for (let page = 1; page <= 10; page++) {
      const { jobs, total_count: total } = await request(
        `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
      );
      if (jobs.some((job) => job.name === "ci" && job.run_id === run.id &&
          job.head_sha === sha && job.status === "completed" && job.conclusion === "success")) {
        return run.id;
      }
      count += jobs.length;
      if (count >= total) break;
      if (jobs.length === 0 || page === 10) throw new Error(`Incomplete ${proof} CI jobs response`);
    }
  }
  throw new Error(`No successful ${proof} CI/ci proof for deploy SHA ${sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const signal = AbortSignal.timeout(30_000);
  const run = await requireReleaseCi({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.DEPLOY_SHA,
    ...releaseInputs(),
    request: async (path) => {
      const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}` },
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error("Main CI lookup failed");
      return response.json();
    },
  });
  console.log(`Deploy SHA ${process.env.DEPLOY_SHA} passed exact-source CI run ${run}.`);
}

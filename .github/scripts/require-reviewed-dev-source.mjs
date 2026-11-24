import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha40 = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

// A development trial may run an unmerged change only from the exact head of
// an open pull request into main whose head carries a successful
// cross-review status, and whose reviewed base is in main's history. The
// review receipt is the control on what that code does. Production never
// calls this; its paths keep the main ancestry and main CI checks.
export async function requireReviewedDevSource({ repository, sha, request }) {
  if (!sha40(sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("Invalid reviewed dev source input");
  }
  const pulls = await request(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) throw new Error("Incomplete pull request lookup");
  const pull = pulls.find(p => p?.state === "open" && p.draft === false && p.head?.sha === sha &&
    p.head?.repo?.full_name === repository && p.base?.ref === "main" && p.base?.repo?.full_name === repository);
  if (!pull || !Number.isSafeInteger(pull.number)) {
    throw new Error(`Dev source ${sha} is not on main and is not the head of an open pull request into main`);
  }
  const statuses = [];
  for (let page = 1; ; page++) {
    const combined = await request(`/repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`);
    if (combined?.sha !== sha || !Array.isArray(combined.statuses) || !Number.isSafeInteger(combined.total_count)) {
      throw new Error("Incomplete review status lookup");
    }
    statuses.push(...combined.statuses);
    if (statuses.length >= combined.total_count) break;
    if (combined.statuses.length === 0 || page === 10) throw new Error("Incomplete review status lookup");
  }
  const reviews = statuses.filter(s => typeof s?.context === "string" && s.context.startsWith("cross-review/"));
  if (reviews.length === 0 || reviews.some(s => s.state !== "success")) {
    throw new Error(`Pull request ${pull.number} head ${sha} has no passing cross-review status`);
  }
  for (const review of reviews) {
    const scope = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})(?:#|$)/.exec(review.target_url ?? "");
    if (!scope || scope[1] !== repository || scope[3] !== sha) {
      throw new Error(`Review status ${review.context} does not name the exact dev source`);
    }
    // The review covered base...head; the base must already be main code.
    const base = scope[2];
    const comparison = await request(`/repos/${repository}/compare/${base}...main?per_page=1`);
    if (comparison?.base_commit?.sha !== base || comparison.merge_base_commit?.sha !== base ||
        !["ahead", "identical"].includes(comparison.status)) {
      throw new Error(`Review status ${review.context} covers a base outside main`);
    }
  }
  return pull.number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  const signal = AbortSignal.timeout(30_000);
  try {
    const number = await requireReviewedDevSource({
      repository: process.env.GITHUB_REPOSITORY,
      sha,
      request: async (path) => {
        const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}` },
          signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("Reviewed dev source lookup failed");
        return response.json();
      },
    });
    // Later trusted steps in this job read the verified source; nothing runs
    // selected code before this step.
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `DEV_REVIEWED_SOURCE=${sha}\nDEV_SOURCE_KIND=pr_head\n`);
    console.log(`Dev source ${sha} is the reviewed head of pull request ${number}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Reviewed dev source refused");
    process.exitCode = 1;
  }
}

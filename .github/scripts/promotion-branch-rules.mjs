// The promotion workflow pushes production or development (jawn-ops #1147).
// It does not check branch protection itself, so this check proves from live
// GitHub rules that development gets the same rules from the same rulesets as
// production: no deletion, fast-forward only, linear history, the ci check
// (with its parameters) and the update lock. The branch-rules API hides bypass
// actors; matching ruleset ids means both branches share one bypass list, which
// the read-only precheck compares with docs/release/*.ruleset.json. It stops a
// development promotion onto an unprotected branch.
const repository = process.env.CANONICAL_GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("CANONICAL_GITHUB_REPOSITORY is required");

async function rules(branch) {
  const response = await fetch(`https://api.github.com/repos/${repository}/rules/branches/${branch}?per_page=100`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN}`, "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${branch} rules: HTTP ${response.status}`);
  const rows = await response.json();
  return rows.map(({ type, ruleset_id, parameters }) => JSON.stringify({ type, ruleset_id, parameters: parameters ?? null })).sort();
}

const [production, development] = await Promise.all([rules("production"), rules("development")]);
const types = production.map(row => JSON.parse(row).type);
if (!["deletion", "non_fast_forward", "required_linear_history", "required_status_checks", "update"].every(type => types.includes(type))) {
  throw new Error(`production lacks an expected rule: ${types.join(", ")}`);
}
if (JSON.stringify(production) !== JSON.stringify(development)) {
  throw new Error(`development rules differ from production:\nproduction ${production.join("\n")}\ndevelopment ${development.join("\n")}`);
}
console.log(`Promotion branch rules match: ${types.sort().join(", ")}`);

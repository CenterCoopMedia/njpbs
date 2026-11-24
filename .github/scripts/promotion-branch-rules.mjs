// The promotion workflow pushes production or development (jawn-ops #1147).
// It does not check branch protection itself, so this check proves from live
// GitHub rules what each branch carries. Production: ruleset 27212671's no
// deletion, fast-forward only, linear history and the ci check (with its
// parameters), plus the update lock of ruleset 27270959. Development: only
// that update lock. Development accepts any commit of this repository, moved
// by force when needed (Joe, Nov. 24, 2026: development is for unreviewed
// experiments, with a single writer), so it keeps only the lock that limits
// who may move it. The branch-rules API hides bypass actors; the shared
// ruleset id means both branches share one bypass list for the update lock,
// which the read-only precheck compares with docs/release/*.ruleset.json.
const repository = process.env.CANONICAL_GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("CANONICAL_GITHUB_REPOSITORY is required");

const PRODUCTION_RULESET = 27212671;
const UPDATE_RULESET = 27270959;

async function rules(branch) {
  const response = await fetch(`https://api.github.com/repos/${repository}/rules/branches/${branch}?per_page=100`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN}`, "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${branch} rules: HTTP ${response.status}`);
  return (await response.json()).map(({ type, ruleset_id, parameters }) => ({ type, ruleset_id, parameters: parameters ?? null }));
}

const shape = rows => rows.map(({ type, ruleset_id }) => `${type}@${ruleset_id}`).sort();
const [production, development] = await Promise.all([rules("production"), rules("development")]);
const expectedProduction = [...["deletion", "non_fast_forward", "required_linear_history", "required_status_checks"]
  .map(type => `${type}@${PRODUCTION_RULESET}`), `update@${UPDATE_RULESET}`].sort();
const expectedDevelopment = [`update@${UPDATE_RULESET}`];
if (JSON.stringify(shape(production)) !== JSON.stringify(expectedProduction)) {
  throw new Error(`production rules differ:\nexpected ${expectedProduction.join(", ")}\nfound ${shape(production).join(", ")}`);
}
if (JSON.stringify(shape(development)) !== JSON.stringify(expectedDevelopment)) {
  throw new Error(`development rules differ:\nexpected ${expectedDevelopment.join(", ")}\nfound ${shape(development).join(", ")}`);
}
const lock = rows => JSON.stringify(rows.find(row => row.type === "update").parameters);
if (lock(production) !== lock(development)) throw new Error("development's update lock differs from production's");
console.log(`Promotion branch rules match: production ${expectedProduction.join(", ")}; development ${expectedDevelopment.join(", ")}`);

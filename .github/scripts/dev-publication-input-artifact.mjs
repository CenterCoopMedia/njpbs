import { repositoryMatches } from "../../scripts/lib/repository-identity.mjs";
// Report retained Actions input to the caller. Missing input does not authorize
// fresh preparation on a rerun; expired or incomplete metadata refuses.
export async function hasRetainedDevInput({ env = process.env, fetchImpl = fetch } = {}) {
  if (!repositoryMatches(env.GITHUB_REPOSITORY, env) || !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") || !env.GH_TOKEN) {
    throw new Error("Invalid dev retry artifact lookup");
  }
  const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Dev retry artifact lookup failed");
  const result = await response.json();
  if (!Array.isArray(result.artifacts) || result.total_count !== result.artifacts.length) {
    throw new Error("Dev retry artifact inventory is incomplete");
  }
  const inputs = result.artifacts.filter(artifact => artifact.name === "dev-publication-input");
  if (!inputs.length) return false;
  if (inputs.length !== 1 || inputs[0].expired !== false) throw new Error("Retained dev input is expired or ambiguous");
  return true;
}

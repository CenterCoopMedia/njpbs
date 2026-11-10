import { repositoryMatches } from "../../scripts/lib/repository-identity.mjs";
import dispatch from "../../functions/lib/cms-publish-dispatch.js";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const refusalMessages = Object.freeze({
  api_lookup: "Dev reconciliation provenance check failed: API lookup",
  run_or_input_identity: "Dev reconciliation provenance check failed: run or input identity",
  actor_admission: "Dev reconciliation provenance check failed: actor admission",
  environment_write: "Dev reconciliation provenance check failed: environment write",
});
class ReconcileRefusal extends Error {
  constructor(category) { super(refusalMessages[category]); this.category = category; }
}
export function devReconcileRefusalMessage(error) {
  return error instanceof ReconcileRefusal && Object.hasOwn(refusalMessages, error.category)
    ? refusalMessages[error.category] : "Dev reconciliation provenance check failed: internal error";
}

export function devReconcileEnvironment(run, env) {
  const { RETAINED_RUN_ID: runId, RETAINED_QUEUE_ID: queueId,
    RETAINED_GENERATION: generation, RETAINED_WORKER_VERSION_ID: versionId } = env;
  if (!/^[1-9][0-9]*$/.test(runId ?? "") || String(run?.id) !== runId ||
      !/^[A-Za-z0-9]{20}$/.test(queueId ?? "") || !/^[1-9][0-9]*$/.test(generation ?? "") ||
      !Number.isSafeInteger(Number(generation)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(versionId ?? "") ||
      run.path !== ".github/workflows/cms-dev-publish.yml" || run.head_branch !== "main" ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") || !repositoryMatches(env.GITHUB_REPOSITORY, env) ||
      run.repository?.full_name !== env.GITHUB_REPOSITORY ||
      run.head_repository?.full_name !== env.GITHUB_REPOSITORY || run.status !== "completed" ||
      !["failure", "cancelled"].includes(run.conclusion) || env.CMS_DEV_PUBLISH_ENABLED !== "false") {
    throw new ReconcileRefusal("run_or_input_identity");
  }
  const trusted = dispatch.trustedPublishActors(env);
  const actor = run.actor?.login;
  const devActor = env.CMS_DEV_DISPATCH_ACTOR;
  const admitted = run.event === "push" ? trusted.includes(actor) :
    run.event === "repository_dispatch" && devActor && !trusted.includes(devActor) && actor === devActor;
  if (!trusted.length || !admitted || !(run.triggering_actor?.login === actor || trusted.includes(run.triggering_actor?.login))) {
    throw new ReconcileRefusal("actor_admission");
  }
  return { SOURCE_SHA: run.head_sha, QUEUE_ID: queueId, DEV_RECONCILE_GENERATION: generation,
    DEV_RECONCILE_WORKER_VERSION_ID: versionId };
}

export async function writeDevReconcileEnvironment(env, { fetchRun = fetch, appendEnvironment = appendFileSync } = {}) {
  const runId = env.RETAINED_RUN_ID;
  if (!repositoryMatches(env.GITHUB_REPOSITORY, env) ||
      !/^[1-9][0-9]*$/.test(runId ?? "")) throw new ReconcileRefusal("run_or_input_identity");
  let run;
  try {
    const response = await fetchRun(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new ReconcileRefusal("api_lookup");
    run = await response.json();
  } catch {
    // Neither the API response body nor a network/JSON exception is safe to log.
    throw new ReconcileRefusal("api_lookup");
  }
  const values = devReconcileEnvironment(run, env);
  try {
    appendEnvironment(env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  } catch {
    throw new ReconcileRefusal("environment_write");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeDevReconcileEnvironment(process.env).catch(error => {
    console.error(devReconcileRefusalMessage(error)); process.exitCode = 1;
  });
}

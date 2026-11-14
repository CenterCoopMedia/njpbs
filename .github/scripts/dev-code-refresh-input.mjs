import { repositoryMatches, workflowMatches } from "../../scripts/lib/repository-identity.mjs";

// A fresh manual code refresh uses the existing push publication owner. It
// cannot accept a retained queue or choose source outside this main event.
export function manualDevCodeRefresh(event, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || event?.inputs?.action !== "refresh") return false;
  const owner = env.CMS_DEPLOY_OWNER;
  let trusted;
  try { trusted = JSON.parse(env.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS || "[]"); } catch { /* Refused below. */ }
  if (!owner || !Array.isArray(trusted) || !trusted.includes(owner) ||
      env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner ||
      env.GITHUB_REF !== "refs/heads/main" || env.QUEUE_ID ||
      !repositoryMatches(env.GITHUB_REPOSITORY, env, env.GITHUB_REPOSITORY_ID ?? "") ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "cms-dev-publish.yml", env) ||
      ["run_id", "queue_id", "generation", "worker_version_id"].some(key => event.inputs[key])) {
    throw new Error("Invalid manual development code refresh");
  }
  return true;
}

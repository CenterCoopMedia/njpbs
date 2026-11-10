import { repositoryMatches, workflowMatches } from "./repository-identity.mjs";
import { deploymentOwner } from "./deployment-settings.mjs";
import { execFileSync } from "node:child_process";

// The application pin and the hosted workflow keep separate identities.
export function devDeploySourceSha(env) {
  const owner = deploymentOwner(env);
  const sha = /^[a-f0-9]{40}$/;
  if (!sha.test(env.DEPLOY_SHA ?? "") || !sha.test(env.GITHUB_SHA ?? "") ||
      env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner ||
      env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      !repositoryMatches(env.GITHUB_REPOSITORY, env, env.GITHUB_REPOSITORY_ID ?? "") ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "cms-dev-deploy.yml", env)) {
    throw new Error("Dev deploy source identity refused");
  }
  return env.DEPLOY_SHA;
}

export function assertDevDeployCheckout(env, root) {
  const sourceSha = devDeploySourceSha(env);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (head !== sourceSha) throw new Error("Dev deploy checkout differs from the selected pin");
  return sourceSha;
}

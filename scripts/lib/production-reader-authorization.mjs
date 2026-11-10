import { workflowMatches } from "./repository-identity.mjs";
import { deploymentOwner } from "./deployment-settings.mjs";
const refuse = () => { throw new Error("Production reader deployment authorization refused"); };

// A separate production authorization, over the existing production owners.
// No development target or credential can be translated into this binding.
export function productionReaderBinding(env = process.env) {
  if (![undefined, "false", "true"].includes(env.CMS_PRODUCTION_INSTALL_READER_BRIDGE)) refuse();
  if (env.CMS_PRODUCTION_INSTALL_READER_BRIDGE !== "true") {
    if (env.CMS_PRODUCTION_READER_OPERATION_ID || env.CMS_PRODUCTION_READER_INSTALL_AUTHORIZATION) refuse();
    return null;
  }
  const owner = deploymentOwner(env);
  if (env.CMS_DEPLOYMENT_ENVIRONMENT !== "production" || env.FIREBASE_PROJECT_ID !== "njpbs-site" ||
      env.CMS_PRODUCTION_READER_INSTALL_AUTHORIZATION !== "INSTALL_PRODUCTION_READERS" || env.FORCE_FIREBASE !== "true" ||
      !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(env.CMS_PRODUCTION_READER_OPERATION_ID ?? "") ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || env.DEPLOY_SHA !== env.GITHUB_SHA ||
      env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "cms-staging-deploy.yml", env) ||
      !/^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_RUN_ATTEMPT !== "1") refuse();
  return { CMS_READER_BRIDGE_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true",
    CMS_READER_BRIDGE_OPERATION_ID: env.CMS_PRODUCTION_READER_OPERATION_ID,
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: `functions-${env.GITHUB_RUN_ID}-1`,
    CMS_READER_BRIDGE_CMS_API_CANDIDATE: `cmsApi-${env.GITHUB_RUN_ID}-1` };
}

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertDevDeployCheckout } from "./lib/dev-deploy-source.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { assertDevTargets, assertDevConfigs, devPublicationIdentity } from "./assert-dev-cms-targets.mjs";
import { assertNoFunctionDeletions, loadFunctionDeployManifest, readFunctionsDeployInventory } from "./lib/functions-deploy-inventory.mjs";

export async function deployDevFunctions({ env = process.env, root = new URL("../", import.meta.url), request, runCommand = execFileSync } = {}) {
  const sourceSha = assertDevDeployCheckout(env, root);
  assertDevTargets(env);
  assertDevConfigs(root, env);
  if (env.CMS_DEV_PUBLISH_ENABLED !== "false") throw new Error("Hold dev publishing before Functions deployment");
  const dotenv = readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8");
  const revisions = dotenv.split(/\r?\n/).filter(line => line.startsWith("CMS_ADMIN_BUILD_REVISION=") && line !== "CMS_ADMIN_BUILD_REVISION=");
  if (revisions.length !== 1 || revisions[0] !== `CMS_ADMIN_BUILD_REVISION=${sourceSha}`) {
    throw new Error("Dev Functions revision differs from the selected pin");
  }
  for (const [key, value] of Object.entries(devPublicationIdentity(env))) {
    const lines = dotenv.split(/\r?\n/).filter(line => line.startsWith(`${key}=`));
    if (lines.length !== 1 || lines[0] !== `${key}=${value}`) throw new Error("Dev Functions publication identity differs from configuration");
  }
  const require = createRequire(new URL("package.json", root));
  const { devFunctionManifest } = require("./functions/dev-manifest.js");
  const { readCloudPublicationWakeDeployment } = require("./functions/lib/cloud-publication-wake-deployment.js");
  const projectId = "njpbs-site-dev";
  const names = Object.keys(devFunctionManifest(readCloudPublicationWakeDeployment({ env: { GCLOUD_PROJECT: projectId } })));
  const manifest = loadFunctionDeployManifest(names, projectId, root);
  if (!request) {
    try {
      const { GoogleAuth } = require("google-auth-library");
      const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
      request = options => client.request(options);
    } catch { throw new Error("Could not authenticate the dev Functions inventory read"); }
  }
  const readInventory = async (url, pageToken) => {
    try {
      const fields = url.includes("/v1/") ? "functions(name,labels,eventTrigger),nextPageToken,unreachable" :
        "functions(name,labels,environment,eventTrigger),nextPageToken,unreachable";
      return (await request({ url, params: { pageSize: 100, fields, ...(pageToken ? { pageToken } : {}) } })).data;
    } catch { throw new Error("Could not read live Functions deployment inventory"); }
  };
  assertNoFunctionDeletions(manifest, await readFunctionsDeployInventory(projectId, readInventory), { projectId, codebase: "dev" });
  console.log(`Verified no deletions against the ${names.length}-function dev manifest`);
  try {
    runCommand("npx", ["--no-install", "firebase", "deploy", "--project", projectId,
      "--config", "firebase.dev.json", "--only", "functions:dev", "--force", "--non-interactive"], { stdio: "inherit" });
  } catch { throw new Error("Dev Functions deployment did not complete"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployDevFunctions().catch(error => { console.error(error.message); process.exitCode = 1; });
}

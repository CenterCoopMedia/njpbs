import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertDevDeployCheckout } from "./lib/dev-deploy-source.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { assertDevTargets, assertDevConfigs, devPublicationIdentity } from "./assert-dev-cms-targets.mjs";
import { assertNoFunctionDeletions, loadFunctionDeployManifest, readFunctionsDeployInventory } from "./lib/functions-deploy-inventory.mjs";
import { functionsInventoryIdentity } from "./lib/cms-component-receipt.mjs";
import { runtimeParametersMatch, selectFunctionTargets } from "./lib/cms-release-plan.mjs";
import { servingRuntimeParameters } from "./lib/functions-configuration.mjs";
import { failureText, faultCause } from "./lib/provider-call.mjs";

const projectId = "njpbs-site-dev";
const codebase = "dev";
const devInventory = inventory => inventory.filter(fn => fn.labels?.["firebase-functions-codebase"] === codebase);
const functionName = fn => fn.name.split("/").at(-1);

async function readDevFunctions(root, request) {
  if (!request) {
    try {
      const { GoogleAuth } = createRequire(new URL("package.json", root))("google-auth-library");
      const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
      request = options => client.request(options);
    } catch (error) { throw new Error("Could not authenticate the dev Functions inventory read", faultCause(error)); }
  }
  return readFunctionsDeployInventory(projectId, async (url, pageToken) => {
    try {
      const fields = url.includes("/v1/") ? "functions(name,labels,eventTrigger),nextPageToken,unreachable" :
        "functions(name,labels,environment,eventTrigger,state,updateTime,buildConfig,serviceConfig),nextPageToken,unreachable";
      return (await request({ url, params: { pageSize: 100, fields, ...(pageToken ? { pageToken } : {}) }, retry: false })).data;
    } catch (error) { throw new Error("Could not read live Functions deployment inventory", faultCause(error)); }
  }, { includeMetadata: true });
}

function sameDevSourceInputs(root, sourceSha, baseline, inputFingerprint, live) {
  if (!/^[a-f0-9]{40}$/.test(baseline?.sourceSha ?? "") || baseline.inputFingerprint !== inputFingerprint ||
      !isDeepStrictEqual(baseline.providerIdentities, functionsInventoryIdentity(live))) return false;
  try {
    execFileSync("git", ["diff", "--quiet", baseline.sourceSha, sourceSha, "--", "firebase.dev.json"],
      { cwd: root, stdio: "ignore" });
    return true;
  } catch { return false; }
}

export function planDevFunctions(names, live, expected, sameSourceInputs) {
  const active = new Map(live.filter(fn => fn.state === "ACTIVE").map(fn => [functionName(fn), fn]));
  const runtimeChanges = Object.fromEntries(names.map(name => {
    const fn = active.get(name);
    const changes = sameSourceInputs ? [] : ["dev_source_or_inventory_unproven"];
    if (!fn) changes.push("dev_function_not_active");
    else for (const key of Object.keys(expected)) {
      if (fn.serviceConfig?.environmentVariables?.[key] !== expected[key]) changes.push(`runtime_parameter:${key}`);
    }
    return [name, changes];
  }));
  return selectFunctionTargets(names, { runtimeChanges });
}

async function verifyDeployedDevFunctions(names, expected, root, request) {
  const live = devInventory(await readDevFunctions(root, request));
  if (!isDeepStrictEqual(live.map(functionName).sort(), [...names].sort()) ||
      live.some(fn => fn.state !== "ACTIVE" || fn.buildConfig?.entryPoint !== functionName(fn))) {
    throw new Error("Deployed dev Functions do not match the exact active manifest");
  }
  if (!runtimeParametersMatch(live, expected)) {
    const differences = Object.keys(expected).filter(key =>
      live.some(fn => fn.serviceConfig?.environmentVariables?.[key] !== expected[key]));
    throw new Error(`Deployed dev Functions runtime parameters differ: ${differences.join(", ")}`);
  }
  console.log(`Verified runtime configuration for ${live.length} dev Functions`);
}

export async function deployDevFunctions({ env = process.env, root = new URL("../", import.meta.url), request,
  runCommand = execFileSync, baseline, inputFingerprint, verifyOnly = false,
  beforeDeploy = async () => {}, afterDeploy = async () => {} } = {}) {
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
  const names = Object.keys(devFunctionManifest(readCloudPublicationWakeDeployment({ env: { GCLOUD_PROJECT: projectId } })));
  const expected = servingRuntimeParameters(parseEnv(dotenv));
  if (verifyOnly) return verifyDeployedDevFunctions(names, expected, root, request);
  const manifest = loadFunctionDeployManifest(names, projectId, root);
  const planStarted = performance.now();
  const inventory = await readDevFunctions(root, request);
  assertNoFunctionDeletions(manifest, inventory, { projectId, codebase });
  console.log(`Verified no deletions against the ${names.length}-function dev manifest`);
  const live = devInventory(inventory);
  const { targets, reasons } = planDevFunctions(names, live, expected,
    sameDevSourceInputs(root, sourceSha, baseline, inputFingerprint, live));
  console.log(`Dev Functions plan: ${JSON.stringify({ targetCount: targets.length, manifestCount: names.length,
    durationMs: Math.round(performance.now() - planStarted) })}`);
  for (const [name, reasonsForExport] of Object.entries(reasons)) {
    console.log(`Dev Functions target: ${JSON.stringify({ name, reasons: reasonsForExport })}`);
  }
  await beforeDeploy();
  if (!targets.length) {
    console.log("Dev Functions deploy: 0 ms (no targets)");
    return;
  }
  const filter = targets.length === names.length ? "functions:dev" : targets.map(name => `functions:dev:${name}`).join(",");
  const started = performance.now();
  try {
    runCommand("npx", ["--no-install", "firebase", "deploy", "--project", projectId,
      "--config", "firebase.dev.json", "--only", filter, "--force", "--non-interactive"], { stdio: "inherit" });
  } catch (error) { throw new Error("Dev Functions deployment did not complete", faultCause(error)); }
  console.log(`Dev Functions deploy: ${Math.round(performance.now() - started)} ms`);
  await afterDeploy(names);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--verify-deployed")) {
    console.error("Expected no arguments or --verify-deployed");
    process.exitCode = 1;
  } else {
    deployDevFunctions({ verifyOnly: args.length === 1 }).catch(error => { console.error(failureText(error)); process.exitCode = 1; });
  }
}

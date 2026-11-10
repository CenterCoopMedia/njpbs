import { ComponentReceiptError } from "./lib/cms-component-receipt.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { explicitCloudWakeDecision } from "./lib/cms-release-plan.mjs";
import { assertNoFunctionDeletions, loadFunctionDeployManifest, readFunctionsDeployInventory, requestDeploymentInventory } from "./lib/functions-deploy-inventory.mjs";

const PROJECT = "njpbs-site";
const REGION = "us-central1";
export { REGION as FUNCTION_DEPLOY_REGION };
const CLOUD_WAKE_FUNCTIONS = ["onNoBuildCloudState", "onNoBuildCloudCandidate", "onNoBuildCloudRelease"];

export { explicitCloudWakeDecision, requestDeploymentInventory };

export async function loadCloudWakeDeployment({
  env = process.env,
  readerPath,
  preparePath,
  prepare,
  read,
} = {}) {
  if (!readerPath || !preparePath || !existsSync(readerPath) || !existsSync(preparePath)) {
    throw new ComponentReceiptError("Cloud wake deployment inputs are required");
  }
  const decision = explicitCloudWakeDecision(env);
  if (decision.environment !== "production") {
    throw new ComponentReceiptError("The function batch runner deploys the production codebase only");
  }
  await prepare({ environment: decision.environment, enabled: decision.enabled });
  const deployment = read({ env: { GCLOUD_PROJECT: PROJECT, GOOGLE_CLOUD_PROJECT: PROJECT } });
  if (deployment.enabled !== decision.enabled || deployment.environment !== "production") {
    throw new ComponentReceiptError("Cloud wake discovery does not match the explicit decision");
  }
  return { ...deployment, projectId: PROJECT };
}

export function assertCloudWakeSettings(functions) {
  for (const name of CLOUD_WAKE_FUNCTIONS) {
    const fn = functions.find((value) => value.name?.split("/").at(-1) === name);
    const secrets = fn?.serviceConfig?.secretEnvironmentVariables ?? [];
    const min = fn?.serviceConfig?.minInstanceCount ?? 0;
    if (!fn || fn.state !== "ACTIVE" || min !== 0 || fn.serviceConfig?.maxInstanceCount !== 2 ||
        !secrets.some((secret) => secret.key === "CMS_PUBLICATION_WAKE_TOKEN")) {
      throw new ComponentReceiptError(`Cloud wake handler settings are invalid: ${name}`);
    }
  }
}

export function cloudWakeFunctionPlan(targets, deployment) {
  const names = functionBatches(targets).flat();
  if (typeof deployment?.enabled !== "boolean") throw new ComponentReceiptError("Invalid cloud wake deployment decision");
  if (deployment.enabled && CLOUD_WAKE_FUNCTIONS.some((name) => !names.includes(name))) {
    throw new ComponentReceiptError("Enabled cloud wake handlers are missing from the deploy manifest");
  }
  const selected = names.filter((name) => deployment.enabled || !CLOUD_WAKE_FUNCTIONS.includes(name));
  return { names: selected, retired: deployment.enabled ? [] : CLOUD_WAKE_FUNCTIONS };
}

export function selectedFunctionBatches(manifestNames, selection = "all") {
  const selected = selection === "all" ? manifestNames : functionBatches(selection).flat();
  if (!selected.length || selected.some(name => !manifestNames.includes(name))) {
    throw new ComponentReceiptError("Selected Functions differ from the complete manifest");
  }
  return Array.from({ length: Math.ceil(selected.length / 10) }, (_, index) => selected.slice(index * 10, index * 10 + 10));
}

export function functionDeploymentPhase(names, selection, phase = "complete", previewTargets = "") {
  const batches = selectedFunctionBatches(names, selection);
  if (phase === "complete") return { batches, readyNames: names };
  if (phase !== "before-preview" || selection === "all") throw new ComponentReceiptError("Invalid Functions deployment phase");
  const preview = new Set(selectedFunctionBatches(names, previewTargets).flat());
  const ordinary = batches.flat();
  if (ordinary.some(name => preview.has(name))) throw new ComponentReceiptError("A preview reader cannot deploy before the pause");
  return { batches, readyNames: ordinary };
}

export function assertCloudWakeRetired(names, functions) {
  if (functions.some((fn) => names.includes(fn.name?.split("/").at(-1)))) {
    throw new ComponentReceiptError("Inactive cloud wake handlers must be retired before deployment");
  }
}
export const FUNCTION_SCHEDULES = Object.freeze([
  { name: "onMediaPurgeSweep", schedules: ["30 3 * * *"], timeZone: "America/New_York", retryCount: 0 },
  { name: "onCmsSaveWarmup", schedules: ["*/5 9-20 * * *"], timeZone: "America/New_York", retryCount: 0 },
  { name: "onNoBuildPostConfirmationRecovery", schedules: ["* * * * *", "every 1 minutes"], timeZone: "UTC" },
  ...["onVideoPreviewTick", "onPrivateVideoCopyTick", "onVideoClipTick", "onVideoTranscriptTick", "onVideoTranscriptByokTick"]
    .map((name) => ({ name, schedules: ["* * * * *", "every 1 minutes"], timeZone: "UTC" })),
  { name: "onSourceVideoReplacementTick", schedules: ["* * * * *", "every 1 minutes"], timeZone: "UTC", retryCount: 0 },
  { name: "onPublicVideoWithdrawalRecovery", schedules: ["*/15 * * * *", "every 15 minutes"], timeZone: "UTC" },
  { name: "onCostLedgerRefresh", schedules: ["0 8 * * 1"], timeZone: "America/New_York" },
  { name: "onElectionResultsSourcePoll", schedules: ["0 8,20 * * *"], timeZone: "America/New_York" },
]);

export function functionBatches(targets) {
  if (!/^functions:[A-Za-z][A-Za-z0-9]*(,functions:[A-Za-z][A-Za-z0-9]*)*$/.test(targets ?? "")) {
    throw new ComponentReceiptError("Invalid function target list");
  }
  const names = targets.split(",").map((target) => target.slice("functions:".length));
  if (new Set(names).size !== names.length) throw new ComponentReceiptError("Duplicate function target");
  return Array.from({ length: Math.ceil(names.length / 10) }, (_, index) => names.slice(index * 10, index * 10 + 10));
}

export function assertFunctionsReady(names, functions) {
  const byName = new Map(functions.map((fn) => [fn.name?.split("/").at(-1), fn]));
  const missing = names.filter((name) => {
    const fn = byName.get(name);
    return !fn || fn.state !== "ACTIVE" || fn.buildConfig?.entryPoint !== name;
  });
  if (missing.length) throw new ComponentReceiptError(`Deployed functions are not active: ${missing.join(", ")}`);
}

export function assertSchedulesReady(names, jobs, functions, project = PROJECT) {
  for (const { name, schedules, timeZone, retryCount } of FUNCTION_SCHEDULES.filter((value) => names.includes(value.name))) {
    const id = `firebase-schedule-${name}-${REGION}`;
    const job = jobs.find((value) => value.name?.split("/").at(-1) === id);
    const fn = functions.find((value) => value.name?.split("/").at(-1) === name);
    const serviceUri = fn?.serviceConfig?.uri;
    const targets = [serviceUri, `https://${REGION}-${project}.cloudfunctions.net/${name}`];
    // Cloud Scheduler can add a root slash to the exact Cloud Run service URL.
    if (/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app\/?$/.test(serviceUri ?? "")) {
      targets.push(serviceUri.endsWith("/") ? serviceUri.slice(0, -1) : `${serviceUri}/`);
    }
    // Omitted protobuf retry fields use zero defaults. Both limits must be zero
    // to disable retries; a nonzero duration can retry even with retryCount=0.
    const retriesDisabled = (job?.retryConfig?.retryCount ?? 0) === 0 &&
      /^0(?:\.0{1,9})?s$/.test(job?.retryConfig?.maxRetryDuration ?? "0s");
    if (!fn?.serviceConfig?.uri || !targets.includes(job?.httpTarget?.uri) ||
        job?.httpTarget?.httpMethod !== "POST" || !job || job.state !== "ENABLED" || !job.httpTarget?.oidcToken?.serviceAccountEmail ||
        !schedules.includes(job.schedule) || job.timeZone !== timeZone || (retryCount === 0 && !retriesDisabled)) {
      throw new ComponentReceiptError(`Scheduler is missing or invalid: ${name}`);
    }
  }
}


export async function listPages(request, url, field) {
  const values = [];
  let pageToken;
  const seen = new Set();
  do {
    const page = await request(url, pageToken);
    if (!Array.isArray(page[field] ?? [])) throw new ComponentReceiptError("Invalid deployment inventory");
    values.push(...(page[field] ?? []));
    pageToken = page.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new ComponentReceiptError("Repeated deployment inventory page");
    seen.add(pageToken);
  } while (pageToken);
  return values;
}


function expiredFunctionFailures(output, names, project = PROJECT) {
  const summaries = [...output.matchAll(/^Functions deploy had errors with the following functions:\n((?:\t[^\n]+\n)+)/gm)];
  if (summaries.length !== 1) return [];
  const failed = summaries[0][1].trimEnd().split("\n").map(line => line.match(/^\t([A-Za-z][A-Za-z0-9]*)\(us-central1\)$/)?.[1]);
  if (failed.some(name => !names.includes(name)) || new Set(failed).size !== failed.length) return [];

  // Firebase prints unlabelled build errors, then a separate failed-name list.
  // Require one retryable diagnostic per failed name; unknown errors fail closed.
  // Retryable: a Cloud Build EXPIRED build, or a refused invoker policy read of
  // the function's Cloud Run service after its update. Redeploying the named
  // function repeats the update and the policy write.
  const diagnostics = output.split("\n").filter(line => /\b(?:errors?|failed|failure|denied)\b/i.test(line));
  const expired = diagnostics.filter(line => /^Build failed with status: EXPIRED(?: and message:.*)?$/.test(line));
  const refusedPolicy = diagnostics.filter(line => failed.some(name =>
    line === `Failed to get the IAM Policy on the Service projects/${project}/locations/${REGION}/services/${name.toLowerCase()}`));
  const allowed = line => expired.includes(line) || refusedPolicy.includes(line) ||
    line === "Functions deploy had errors with the following functions:" ||
    /^Error: There was an error deploying functions:?$/.test(line) ||
    /^\W*functions: Deploys failed\. Skipping deletes\.$/.test(line) ||
    failed.some(name => line === `- Error Failed to update function ${name} in region ${REGION}` ||
      line === `- Error Failed to create function ${name} in region ${REGION}`);
  return expired.length + refusedPolicy.length === failed.length && diagnostics.every(allowed) ? failed : [];
}

function runFunctionDeploy(names, launch, project) {
  return new Promise((resolve, reject) => {
    const child = launch("npx", ["--no-install", "firebase", "deploy", "--project", project,
      "--only", names.map((name) => `functions:${name}`).join(","), "--force", "--non-interactive"],
    { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const observe = (chunk, stream) => {
      stream.write(chunk);
      output += chunk.toString();
    };
    child.stdout.on("data", (chunk) => observe(chunk, process.stdout));
    child.stderr.on("data", (chunk) => observe(chunk, process.stderr));
    child.on("error", () => reject(new ComponentReceiptError("Could not start Firebase deployment")));
    child.on("close", (code) => {
      resolve({ code, output: stripVTControlCharacters(output).replace(/\r\n/g, "\n") });
    });
  });
}

export async function deployBatch(names, launch = spawn, project = PROJECT, { manifest, request, wait = pause } = {}) {
  if (!Array.isArray(names) || !names.length || !Array.isArray(manifest) ||
      names.some(name => !manifest.some(fn => fn.name === name))) throw new ComponentReceiptError("Function batch differs from the exact manifest");
  let pending = names;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertNoFunctionDeletions(manifest, await readFunctionsDeployInventory(project, request), { projectId: project, codebase: "default", only: pending });
    const { code, output } = await runFunctionDeploy(pending, launch, project);
    if (code === 0 && output.includes("Deploy complete!")) return;
    const failed = code !== 0 ? expiredFunctionFailures(output, pending, project) : [];
    if (attempt === 3 || !failed.length) throw new ComponentReceiptError("Firebase deployment did not confirm completion");
    pending = failed;
    console.log(`Retrying function deployment, attempt ${attempt + 1} of 3: ${pending.join(", ")}`);
    await wait(10_000);
  }
}

export async function main({ retireCloudWake, verifyOnly = false } = {}) {
  const require = createRequire(import.meta.url);
  const readerPath = fileURLToPath(new URL("../functions/lib/cloud-publication-wake-deployment.js", import.meta.url));
  const preparePath = fileURLToPath(new URL("./prepare-cloud-publication-wake.mjs", import.meta.url));
  const deployment = await loadCloudWakeDeployment({
    readerPath,
    preparePath,
    prepare: async (decision) => {
      const { prepareCloudPublicationWake } = await import(pathToFileURL(preparePath).href);
      await prepareCloudPublicationWake(decision);
    },
    read: (options) => require(readerPath).readCloudPublicationWakeDeployment(options),
  });
  const { names, retired } = cloudWakeFunctionPlan(process.env.FUNCTION_TARGETS, deployment);
  const { batches, readyNames } = functionDeploymentPhase(names, process.env.CMS_FUNCTION_DEPLOY_TARGETS,
    process.env.CMS_FUNCTION_DEPLOY_PHASE, process.env.CMS_PREVIEW_FUNCTION_TARGETS);
  const project = deployment.projectId;
  const manifest = loadFunctionDeployManifest(names, project);
  if (!verifyOnly && !deployment.enabled && retired.length) {
    if (typeof retireCloudWake !== "function") throw new ComponentReceiptError("Cloud wake retirement requires the original attempt runner");
    await retireCloudWake(retired, project);
  }
  const { GoogleAuth } = require("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  const request = (url, pageToken) => requestDeploymentInventory(client, url, pageToken);
  const parent = `projects/${project}/locations/${REGION}`;
  const functionsUrl = `https://cloudfunctions.googleapis.com/v2/${parent}/functions`;
  assertCloudWakeRetired(retired, await listPages(request, functionsUrl, "functions"));
  // Firebase recommends ten or fewer functions per deploy to avoid mutation quotas.
  // https://firebase.google.com/docs/functions/manage-functions
  if (!verifyOnly) {
    for (const [index, batch] of batches.entries()) {
      console.log(`Deploying function batch ${index + 1} of ${batches.length}`);
      await deployBatch(batch, spawn, project, { manifest, request });
    }
  }
  const functions = await listPages(request, functionsUrl, "functions");
  assertCloudWakeRetired(retired, functions);
  assertFunctionsReady(readyNames, functions);
  if (deployment.enabled) assertCloudWakeSettings(functions);
  const jobs = await listPages(request, `https://cloudscheduler.googleapis.com/v1/${parent}/jobs`, "jobs");
  assertSchedulesReady(readyNames, jobs, functions, project);
  console.log(`Verified ${readyNames.length} active functions and their schedulers`);
}

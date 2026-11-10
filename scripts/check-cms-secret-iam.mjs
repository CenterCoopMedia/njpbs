#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadFunctionSource, functionDeployManifest, readFunctionsDeployInventory, requestDeploymentInventory, FunctionsDeployInventoryError } from "./lib/functions-deploy-inventory.mjs";


const PROJECT = "njpbs-site";
const DEPLOY_ACCOUNT = process.env.FIREBASE_DEPLOY_SERVICE_ACCOUNT ?? "";
const EMAIL = /^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/;

// Use the SDK's discovery metadata, including lazy exports and generated
// optional bindings. Commented exports and development-only secrets stay out.
export function secretRequirements(source, projectNumber) {
  if (!/^[1-9][0-9]*$/.test(projectNumber)) throw new FunctionsDeployInventoryError("Invalid project number for runtime secret IAM");
  functionDeployManifest(Object.keys(source), source);
  const requirements = new Map();
  for (const [name, fn] of Object.entries(source)) {
    // Firebase serializes SDK ResetValue instances as null (platform default).
    const endpoint = JSON.parse(JSON.stringify(fn.__endpoint));
    const secrets = endpoint.secretEnvironmentVariables ?? [];
    if (!Array.isArray(secrets)) throw new FunctionsDeployInventoryError(`Invalid secret bindings for ${name}`);
    const runtime = endpoint.serviceAccountEmail ?? (endpoint.platform === "gcfv2"
      ? `${projectNumber}-compute@developer.gserviceaccount.com` : `${PROJECT}@appspot.gserviceaccount.com`);
    if (typeof runtime !== "string" || !EMAIL.test(runtime)) throw new FunctionsDeployInventoryError(`Unresolved runtime identity for ${name}`);
    for (const secret of secrets) {
      if (!secret || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.key) ||
          (secret.secret !== undefined && secret.secret !== secret.key) ||
          (secret.projectId !== undefined && ![PROJECT, projectNumber].includes(secret.projectId))) {
        throw new FunctionsDeployInventoryError(`Invalid secret binding for ${name}`);
      }
      if (!requirements.has(secret.key)) requirements.set(secret.key, new Set());
      requirements.get(secret.key).add(runtime);
    }
  }
  if (!requirements.size) throw new FunctionsDeployInventoryError("No deployed Functions secret bindings found");
  return requirements;
}

function gcloud(args) {
  try {
    return execFileSync("gcloud", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }).trim();
  } catch {
    throw new FunctionsDeployInventoryError(`Could not read CMS IAM metadata: gcloud ${args.join(" ")}`);
  }
}

export function checkSecretIam(requirements, readPolicy, deployAccount = DEPLOY_ACCOUNT) {
  for (const [secret, runtimes] of requirements) {
    let policy;
    try { policy = JSON.parse(readPolicy(secret)); }
    catch { throw new FunctionsDeployInventoryError(`Could not read IAM policy for secret ${secret}`); }
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        !Array.isArray(policy.bindings ?? [])) throw new FunctionsDeployInventoryError(`Invalid IAM policy for secret ${secret}`);
    const needs = [[deployAccount, ["roles/secretmanager.viewer", "roles/secretmanager.admin"]],
      ...[...runtimes].map(runtime => [runtime, ["roles/secretmanager.secretAccessor"]])];
    for (const [account, roles] of needs) {
      if (!(policy.bindings ?? []).some(binding => roles.includes(binding?.role) && !binding.condition &&
          Array.isArray(binding.members) && binding.members.includes(`serviceAccount:${account}`))) {
        throw new FunctionsDeployInventoryError(`Secret ${secret} needs an unconditional ${roles.join(" or ")} binding for ${account === deployAccount ? "the configured deploy identity" : "its declared runtime identity"}`);
      }
    }
  }
}

// Firebase uses the declared Gen 2 runtime identity for its Eventarc trigger,
// falling back to Compute Engine's default account. See docs/cms/functions-deploy.md#event-trigger-iam.
export function eventTriggerRequirements(source, projectNumber) {
  if (!/^[1-9][0-9]*$/.test(projectNumber)) throw new FunctionsDeployInventoryError("Invalid project number for event trigger IAM");
  return functionDeployManifest(Object.keys(source), source).filter(fn => fn.platform === "gcfv2" && fn.eventType)
    .map(fn => {
      const endpoint = JSON.parse(JSON.stringify(source[fn.name].__endpoint));
      const account = endpoint.serviceAccountEmail ?? `${projectNumber}-compute@developer.gserviceaccount.com`;
      if (typeof account !== "string" || !EMAIL.test(account)) throw new FunctionsDeployInventoryError(`Unresolved event trigger identity for ${fn.name}`);
      return { name: fn.name, region: fn.region, account };
    });
}

function eventPolicy(value) {
  try {
    const policy = JSON.parse(value);
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || !Array.isArray(policy.bindings ?? [])) throw new FunctionsDeployInventoryError();
    return policy;
  } catch { throw new FunctionsDeployInventoryError("Could not read event trigger IAM policy metadata"); }
}

function eventRole(policy, account, role) {
  return (policy.bindings ?? []).some(binding => binding?.role === role && !binding.condition &&
    Array.isArray(binding.members) && binding.members.includes(`serviceAccount:${account}`));
}

export function checkEventTriggerIam(requirements, readProjectPolicy, readServicePolicy, { allowFirstDeploy = false } = {}) {
  const pending = [];
  if (!requirements.length) return pending;
  const projectPolicy = eventPolicy(readProjectPolicy());
  // Check every receiver before looking up invocation grants or reading secrets.
  for (const { name, account } of requirements) {
    if (!eventRole(projectPolicy, account, "roles/eventarc.eventReceiver")) {
      throw new FunctionsDeployInventoryError(`Event trigger ${name} needs an unconditional roles/eventarc.eventReceiver binding on ${PROJECT} for serviceAccount:${account}`);
    }
  }
  for (const requirement of requirements) {
    if (eventRole(projectPolicy, requirement.account, "roles/run.invoker")) continue;
    const raw = readServicePolicy(requirement);
    if (raw === null && allowFirstDeploy) { pending.push(requirement); continue; }
    const servicePolicy = eventPolicy(raw);
    if (!eventRole(servicePolicy, requirement.account, "roles/run.invoker")) {
      throw new FunctionsDeployInventoryError(`Event trigger ${requirement.name} needs an unconditional roles/run.invoker binding for serviceAccount:${requirement.account}`);
    }
  }
  return pending;
}

function readEventServicePolicy({ name, region, account }, { allowFirstDeploy = false, existingNames, postDeploy = false } = {}) {
  if (allowFirstDeploy) {
    if (!(existingNames instanceof Set) || !existingNames.size) throw new FunctionsDeployInventoryError("Complete nonempty Functions inventory required");
    if (!existingNames.has(`projects/${PROJECT}/locations/${region}/functions/${name}`)) return null;
  }
  const service = gcloud(["functions", "describe", name, "--gen2", `--region=${region}`,
    `--project=${PROJECT}`, "--format=value(serviceConfig.service)"]);
  const prefix = `projects/${PROJECT}/locations/${region}/services/`;
  const serviceName = service.startsWith(prefix) ? service.slice(prefix.length) : "";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(serviceName)) throw new FunctionsDeployInventoryError(`Could not identify the Cloud Run service for event trigger ${name}`);
  const policy = gcloud(["run", "services", "get-iam-policy", serviceName, `--region=${region}`, `--project=${PROJECT}`, "--format=json"]);
  return policy;
}

async function firstDeployFunctionNames() {
  // Keep the full API envelopes: formatted gcloud rows discard unreachable regions.
  const token = gcloud(["auth", "print-access-token"]);
  try {
    const client = { request: async ({ url, params }) => {
      const target = new URL(url);
      target.searchParams.set("fields", url.includes("/v1/") ? "functions(name,labels,eventTrigger),nextPageToken,unreachable" :
        "functions(name,labels,environment,eventTrigger),nextPageToken,unreachable");
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      const response = await fetch(target, { headers: { Authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(), { response: { status: response.status } });
      }
      return { data: await response.json() };
    } };
    const inventory = await readFunctionsDeployInventory(PROJECT, (url, pageToken) => requestDeploymentInventory(client, url, pageToken));
    if (!inventory.length || inventory.some(fn => typeof fn.name !== "string" ||
        !new RegExp(`^projects/${PROJECT}/locations/[a-z]+-[a-z]+\\d/functions/[A-Za-z][A-Za-z0-9-]*$`).test(fn.name))) throw new FunctionsDeployInventoryError();
    return new Set(inventory.map(fn => fn.name));
  } catch { throw new FunctionsDeployInventoryError("Complete nonempty Functions inventory required for first deployment"); }
}

export async function main(sourceRoot = new URL("../", import.meta.url), { preDeploy = false, postDeploy = false } = {}) {
  if (!EMAIL.test(DEPLOY_ACCOUNT)) throw new FunctionsDeployInventoryError("Configure FIREBASE_DEPLOY_SERVICE_ACCOUNT as a Google service account");
  if (preDeploy || postDeploy) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!/^[a-f0-9]{40}$/.test(head) || head !== process.env.DEPLOY_SHA) throw new FunctionsDeployInventoryError("Event deployment source differs from its pin");
  }
  if (preDeploy) {
    const environment = process.env.CLOUD_PUBLICATION_WAKE_ENVIRONMENT;
    const decision = process.env.CLOUD_PUBLICATION_WAKE_ENABLED;
    if (environment !== "production" || !["true", "false"].includes(decision)) {
      throw new FunctionsDeployInventoryError("An explicit production cloud wake decision is required");
    }
    const { prepareCloudPublicationWake } = await import("./prepare-cloud-publication-wake.mjs");
    const { default: wakeDeployment } = await import("../functions/lib/cloud-publication-wake-deployment.js");
    const path = new URL("functions/cloud-publication-wake.generated.json", sourceRoot);
    const enabled = decision === "true";
    await prepareCloudPublicationWake({ environment, enabled, path });
    const deployment = wakeDeployment.readCloudPublicationWakeDeployment({ path, env: { GCLOUD_PROJECT: PROJECT } });
    if (!existsSync(path) || deployment.environment !== environment || deployment.enabled !== enabled) {
      throw new FunctionsDeployInventoryError("Cloud wake artifact differs from its selected decision");
    }
  }
  if (postDeploy) {
    // Reuse the key already validated and installed for Firebase, without a
    // second authentication step or persistent gcloud configuration.
    const credential = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    if (credential.type !== "service_account" || credential.project_id !== PROJECT || credential.client_email !== DEPLOY_ACCOUNT) {
      throw new FunctionsDeployInventoryError("Invalid Firebase IAM read credential");
    }
    process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  } else if (gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]) !== DEPLOY_ACCOUNT) {
    throw new FunctionsDeployInventoryError(`FIREBASE_SERVICE_ACCOUNT must authenticate ${DEPLOY_ACCOUNT}`);
  }
  const read = postDeploy
    ? args => requestDeploymentInventory({ request: async () => ({ data: gcloud(args) }) }, "gcloud-read")
    : async args => gcloud(args);
  const number = await read(["projects", "describe", PROJECT, "--format=value(projectNumber)"]);
  const source = loadFunctionSource(PROJECT, sourceRoot);
  const events = eventTriggerRequirements(source, number);
  if (postDeploy) {
    const projectPolicy = await read(["projects", "get-iam-policy", PROJECT, "--format=json"]);
    const policies = new Map();
    for (const { name, region, account } of events) {
      const actual = await read(["functions", "describe", name, "--gen2", `--region=${region}`,
        `--project=${PROJECT}`, "--format=value(eventTrigger.serviceAccountEmail)"]) || `${number}-compute@developer.gserviceaccount.com`;
      if (actual !== account) throw new FunctionsDeployInventoryError(`Event trigger ${name} differs from its selected source identity`);
      if (eventRole(eventPolicy(projectPolicy), account, "roles/run.invoker")) continue;
      const service = await read(["functions", "describe", name, "--gen2", `--region=${region}`,
        `--project=${PROJECT}`, "--format=value(serviceConfig.service)"]);
      const prefix = `projects/${PROJECT}/locations/${region}/services/`;
      const serviceName = service.startsWith(prefix) ? service.slice(prefix.length) : "";
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(serviceName)) throw new FunctionsDeployInventoryError(`Could not identify the Cloud Run service for event trigger ${name}`);
      const policy = await read(["run", "services", "get-iam-policy", serviceName, `--region=${region}`, `--project=${PROJECT}`, "--format=json"]);
      if (!eventRole(eventPolicy(policy), account, "roles/run.invoker")) {
        throw new FunctionsDeployInventoryError(`Event trigger ${name} needs an authorized grant: gcloud run services add-iam-policy-binding ${serviceName} --member=serviceAccount:${account} --role=roles/run.invoker --condition=None --region=${region} --project=${PROJECT}`);
      }
      policies.set(`${name}:${region}`, policy);
    }
    checkEventTriggerIam(events, () => projectPolicy, ({ name, region }) => policies.get(`${name}:${region}`));
    console.log(`Verified receiver and invocation IAM after deployment for ${events.length} Functions event triggers`);
    return;
  }
  const existingNames = preDeploy ? await firstDeployFunctionNames() : undefined;
  const pending = checkEventTriggerIam(events, () => gcloud(["projects", "get-iam-policy", PROJECT, "--format=json"]),
    requirement => readEventServicePolicy(requirement, { allowFirstDeploy: preDeploy, existingNames, postDeploy }), { allowFirstDeploy: preDeploy });
  console.log(`Verified event receiver IAM for ${events.length} Functions; ${pending.length} new service invocation grants require post-deploy verification`);
  const requirements = secretRequirements(source, number);
  checkSecretIam(requirements, secret => gcloud([
    "secrets", "get-iam-policy", secret, `--project=${PROJECT}`, "--format=json",
  ]));
  console.log(`Verified deploy and runtime IAM for ${requirements.size} deployed Functions secrets`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, mode, ...extra] = process.argv.slice(2);
    if (extra.length || mode && !["--pre-deploy", "--post-deploy"].includes(mode)) {
      throw new FunctionsDeployInventoryError("Expected a source root and optional --pre-deploy or --post-deploy");
    }
    await main(source ? pathToFileURL(`${resolve(source)}/`) : undefined,
      { preDeploy: mode === "--pre-deploy", postDeploy: mode === "--post-deploy" });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

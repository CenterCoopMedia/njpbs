#!/usr/bin/env node
// An ordinary CMS deploy writes the Functions dotenv from the configuration
// table and deploys the committed CMS API config; neither holds the reader
// bridge binding. This step binds the readers for the run instead
// (CenterCoopMedia/njpbs#561):
// - development binds every run (the binding cms-dev-deploy wrote every run);
// - production carries a live binding that has no installed proof. Production
//   has none today, so its runs change nothing. A binding with an installed
//   proof keeps today's behavior and is only logged (CenterCoopMedia/njpbs#584).
// After both receipts complete, the run records and verifies this run's
// reader candidates, which the mount descriptor reads on every request.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { cmsTarget } from "./lib/cms-target.mjs";

const require = createRequire(import.meta.url);
export const READER_KEYS = Object.freeze(["CMS_READER_BRIDGE_ENABLED", "CMS_READER_BRIDGE_OPERATION_ID",
  "CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE", "CMS_READER_BRIDGE_CMS_API_CANDIDATE"]);
const fail = message => { throw new Error(message); };

export async function selectReaderBinding({ env = process.env, target = cmsTarget(env), readLiveApiVars, readInstalledProof,
  readCompatibilityReceipts, log = console.log }) {
  // Only a completed reader install may be kept bound; a first install keeps its separate authorization.
  const { currentReader } = require("../functions/lib/cms-preview-pair.js");
  const receipts = await readCompatibilityReceipts();
  try { for (const component of ["functions", "cmsApi"]) currentReader(receipts[component], component); }
  catch {
    log("No completed reader install; this deploy leaves the readers unbound");
    return null;
  }
  if (target.environment === "development") {
    const { devReaderUpdateDeployment } = require("../functions/lib/dev-reader-deployment.js");
    return devReaderUpdateDeployment({ ...env, FIREBASE_PROJECT_ID: target.projectId, CMS_DEPLOYMENT_ENVIRONMENT: "development" });
  }
  const live = await readLiveApiVars();
  if (live.CMS_READER_BRIDGE_ENABLED !== "true") return null;
  const operationId = live.CMS_READER_BRIDGE_OPERATION_ID;
  if (!/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(operationId ?? "")) fail("The live CMS API reader binding is invalid");
  if (await readInstalledProof(operationId)) {
    log(`Reader operation ${operationId} has an installed proof; this deploy does not carry it (CenterCoopMedia/njpbs#584)`);
    return null;
  }
  if (!/^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]{0,3}$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) fail("Run identity is required");
  return { CMS_READER_BRIDGE_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true",
    CMS_READER_BRIDGE_OPERATION_ID: operationId,
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: `functions-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    CMS_READER_BRIDGE_CMS_API_CANDIDATE: `cmsApi-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` };
}

export function bindFunctionsDotenv(text, binding) {
  const lines = text.split("\n").filter(line => line && !Object.hasOwn(binding, line.slice(0, line.indexOf("="))));
  return `${[...lines, ...Object.entries(binding).map(([key, value]) => `${key}=${value}`)].join("\n")}\n`;
}

// A rerun of a bound run cannot finish consistently: review of #561 found that the forced paired
// release redeployed the Worker under verified candidates, that a skipped deploy left the CMS API
// receipt open, and that completion then used the new run attempt; a rerun that deploys Functions
// and then stops leaves them bound to candidates no record step writes. Selection and both bind
// steps refuse before their mutation. A new dispatch recovers cleanly (startReceipt takes over the
// open receipt; the run binds anew).
export function assertFirstAttempt(env) {
  if (env.GITHUB_RUN_ATTEMPT !== "1") fail("A bound run cannot be rerun; dispatch a new run");
}

export function bindApiConfig(config, binding) {
  return { ...config, vars: { ...config.vars, ...Object.fromEntries(READER_KEYS.map(key => [key, binding[key]])) } };
}

function candidateInput(component, legacy, binding) {
  const name = binding[component === "functions" ? "CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE" : "CMS_READER_BRIDGE_CMS_API_CANDIDATE"];
  const match = name?.match(/^[A-Za-z]+-([0-9]{1,20})-([0-9]{1,4})$/);
  if (!match || legacy?.schemaVersion !== 1 || legacy.state !== "complete") fail(`The ${component} receipt is not complete`);
  const { sourceSha, trustedWorkflowSha, inputFingerprint, configurationFingerprint } = legacy.mutation;
  return { component, sourceSha, trustedWorkflowSha, runId: match[1], runAttempt: Number(match[2]), inputFingerprint, configurationFingerprint };
}

// Records both candidates from their completed receipts, verifies them against
// the live Functions and CMS API version, and reads the descriptor back.
export async function recordReaderCandidates({ firestore, binding, collect, receipts, mount }) {
  const inputs = [];
  for (const component of ["functions", "cmsApi"]) {
    const input = candidateInput(component, (await firestore.doc(`cmsDeploymentReceipts/${component}`).get()).data(), binding);
    await receipts.startCandidateReceipt(firestore, input);
    await receipts.verifyCandidateReceipt(firestore, input, { collect });
    inputs.push(input);
  }
  for (const input of inputs) await receipts.commitLiveReaderReceipt(firestore, { ...input, supported: mount.SUPPORT }, { collect });
  return mount.readCmsReaderMountDescriptor({ firestore, environment: binding });
}

// GitHub drops a job output that contains any masked value, and the lines of a
// multiline JSON secret mask "{" and "}"; the binding crosses jobs as base64.
export const encodeBinding = selected => Buffer.from(JSON.stringify(selected)).toString("base64");

// The bind and record steps run from the release source, which may predate the base64 binding.
export const releaseSourceBinds = source => source.includes("export function decodeBinding(");

export function decodeBinding(value) {
  return value ? JSON.parse(Buffer.from(value, "base64").toString("utf8")) : null;
}

const binding = () => {
  const parsed = decodeBinding(process.env.CMS_READER_BINDING ?? "");
  if (!parsed || READER_KEYS.some(key => typeof parsed[key] !== "string")) fail("CMS_READER_BINDING is required");
  return parsed;
};

async function cloudflare(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${path}`,
    { redirect: "error", headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok || body?.success !== true) fail("The live CMS API reader binding could not be read");
  return body.result;
}

async function liveApiVars(target) {
  const version = (await cloudflare(`workers/scripts/${target.cmsApiWorker}/deployments`))?.deployments?.[0]?.versions?.[0]?.version_id;
  if (!/^[a-f0-9-]{36}$/.test(version ?? "")) fail("The live CMS API version could not be read");
  const bindings = (await cloudflare(`workers/scripts/${target.cmsApiWorker}/versions/${version}`))?.resources?.bindings ?? [];
  return Object.fromEntries(bindings.filter(row => row.type === "plain_text" && READER_KEYS.includes(row.name)).map(row => [row.name, row.text]));
}

async function main([command, component]) {
  const target = cmsTarget();
  const { withFirestore } = await import("./cms-component-receipt.mjs");
  if (command === "select") {
    const selected = await withFirestore(firestore => selectReaderBinding({ target,
      readLiveApiVars: () => liveApiVars(target),
      readInstalledProof: async operationId => (await firestore.doc(`cmsReaderBridgeInstalledProofs/${operationId}`).get()).exists,
      readCompatibilityReceipts: async () => Object.fromEntries(await Promise.all(["functions", "cmsApi"].map(async component =>
        [component, (await firestore.doc(`cmsReaderCompatibilityReceipts/${component}`).get()).data()]))),
    }));
    if (selected) assertFirstAttempt(process.env);
    // The bind and record steps run from the release source; refuse before any mutation if it predates them.
    const release = "scripts/cms-reader-binding.mjs";
    if (selected && !releaseSourceBinds(existsSync(release) ? readFileSync(release, "utf8") : "")) {
      fail(`This release source cannot keep the readers bound; deploy a source whose ${release} decodes the base64 binding`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `binding=${selected ? encodeBinding(selected) : ""}\n`);
    console.log(selected ? `Readers bound to operation ${selected.CMS_READER_BRIDGE_OPERATION_ID}` : "No reader binding for this run");
  } else if (command === "bind" && component === "functions") {
    assertFirstAttempt(process.env);
    const path = `functions/.env.${target.projectId}`;
    writeFileSync(path, bindFunctionsDotenv(readFileSync(path, "utf8"), binding()));
  } else if (command === "bind" && component === "cmsApi") {
    assertFirstAttempt(process.env);
    const path = target.environment === "development" ? "cms-api/wrangler.dev.jsonc" : "cms-api/wrangler.jsonc";
    writeFileSync(path, `${JSON.stringify(bindApiConfig(JSON.parse(readFileSync(path, "utf8")), binding()), null, 2)}\n`);
  } else if (command === "record") {
    const selected = binding();
    const receipts = await import("./lib/cms-component-receipt.mjs");
    const { readEnabledCmsReaderProviders } = await import("./lib/cms-enabled-reader-provider.mjs");
    const { GoogleAuth } = require("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const apiVars = Object.fromEntries(READER_KEYS.map(key => [key, selected[key]]));
    const collect = async name => (await readEnabledCmsReaderProviders({ projectId: target.projectId,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID, sourceSha: process.env.DEPLOY_SHA, binding: selected, apiVars,
      expectedWorkerVersion: process.env.DEPLOYED_WORKER_VERSION || undefined,
      readGoogleToken: async () => (await (await auth.getClient()).getAccessToken()).token,
      readCloudflareToken: async () => process.env.CLOUDFLARE_API_TOKEN }))[name];
    const descriptor = await withFirestore(firestore => recordReaderCandidates({ firestore, binding: selected, collect, receipts,
      mount: require("../functions/lib/cms-reader-mount-descriptor.js") }));
    console.log(`Readers verified: operation ${descriptor.operationId}`);
  } else fail("Usage: cms-reader-binding.mjs select | bind functions|cmsApi | record");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

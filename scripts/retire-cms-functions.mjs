#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { withFirestore } from "./cms-component-receipt.mjs";
import { ComponentReceiptError, assertLegacyPreviewProtocol, readReceipt, requireRunAttempt, requireRunId, requireSha } from "./lib/cms-component-receipt.mjs";
import { extractProductionExports } from "./smoke-cms-functions.mjs";
import { FUNCTION_DEPLOY_REGION, cloudWakeFunctionPlan, explicitCloudWakeDecision, functionBatches, main as deployFunctions } from "./deploy-cms-function-batches.mjs";
import { readFunctionsDeployInventory } from "./lib/functions-deploy-inventory.mjs";
import { applyFunctionRetirements, planFunctionRetirements, requireRetirementScope, validateRetirementPlan } from "./lib/functions-retirement.mjs";

const execute = promisify(execFile);
const refuse = () => { throw new ComponentReceiptError("Functions retirement original attempt or provider proof is unavailable"); };

export function retirementContext(firestore, env = process.env) {
  const sourceSha = requireSha(env.DEPLOY_SHA), trustedWorkflowSha = requireSha(env.GITHUB_SHA);
  const source = readFileSync("functions/index.js", "utf8");
  const committed = execFileSync("git", ["show", `${sourceSha}:functions/index.js`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sourceSha || source !== committed) refuse();
  const rawNames = functionBatches(env.FUNCTION_TARGETS).flat().sort();
  if (!isDeepStrictEqual(rawNames, extractProductionExports(source).sort())) refuse();
  const configuration = JSON.parse(readFileSync("firebase.json", "utf8"));
  if (configuration.functions?.source !== "functions" || configuration.functions?.codebase !== "default"
    || firestore.projectId !== "njpbs-site") refuse();
  const targetNames = cloudWakeFunctionPlan(env.FUNCTION_TARGETS, explicitCloudWakeDecision(env)).names;
  return { sourceSha, trustedWorkflowSha, runId: requireRunId(env.GITHUB_RUN_ID), runAttempt: requireRunAttempt(env.GITHUB_RUN_ATTEMPT),
    targetNames, scope: { projectId: firestore.projectId, region: FUNCTION_DEPLOY_REGION, codebase: configuration.functions.codebase } };
}

function ownedReceipt(row, context) {
  if (row?.schemaVersion !== 1 || row.component !== "functions" || row.state !== "in_progress"
    || row.mutation?.sourceSha !== context.sourceSha || row.mutation.trustedWorkflowSha !== context.trustedWorkflowSha
    || row.mutation.runId !== context.runId || row.mutation.runAttempt !== context.runAttempt) refuse();
  return row;
}

const samePlanOwner = (plan, context) => plan.sourceSha === context.sourceSha
  && plan.trustedWorkflowSha === context.trustedWorkflowSha && plan.runId === context.runId;

export async function retirementReceipt(firestore, context, patch = {}) {
  return firestore.runTransaction(async tx => {
    const protocol = await tx.get(firestore.doc("system/cmsPreviewRuntime"));
    assertLegacyPreviewProtocol(protocol.exists ? protocol.data() : null);
    const ref = firestore.collection("cmsDeploymentReceipts").doc("functions");
    const row = ownedReceipt((await tx.get(ref)).data(), context);
    if (patch.retirementPlan && row.mutation.retirementPlan && samePlanOwner(row.mutation.retirementPlan, context)
      && !isDeepStrictEqual(patch.retirementPlan, row.mutation.retirementPlan)) refuse();
    const plan = patch.retirementPlan ?? row.mutation.retirementPlan;
    if (!plan) refuse();
    validateRetirementPlan(plan, context);
    const next = { ...row, mutation: { ...row.mutation, ...patch } };
    if (Object.keys(patch).length) tx.set(ref, next);
    return next;
  });
}

export function retirementProvider(scope, readToken, fetchImpl = fetch, launch = execute) {
  scope = requireRetirementScope(scope);
  const request = async (url, pageToken, method = "GET") => {
    const target = new URL(url);
    if (pageToken) target.searchParams.set("pageToken", pageToken);
    if (method === "GET") target.searchParams.set("pageSize", "100");
    try {
      const token = await readToken();
      if (!token || typeof token.access_token !== "string") refuse();
      const response = await fetchImpl(target, { method, headers: { authorization: `Bearer ${token.access_token}` },
        redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); refuse(); }
      return method === "DELETE" ? {} : await response.json();
    } catch { refuse(); }
  };
  return {
    listFunctions: () => readFunctionsDeployInventory(scope.projectId, request, { includeMetadata: true }),
    listSchedules: async () => {
      const jobs = [], seen = new Set(); let pageToken;
      do {
        const body = await request(`https://cloudscheduler.googleapis.com/v1/projects/${scope.projectId}/locations/${scope.region}/jobs`, pageToken);
        if (!body || typeof body !== "object" || !Array.isArray(body.jobs ?? [])
          || Object.keys(body).some(key => !["jobs", "nextPageToken"].includes(key))
          || body.nextPageToken !== undefined && typeof body.nextPageToken !== "string") refuse();
        jobs.push(...(body.jobs ?? [])); pageToken = body.nextPageToken;
        if (jobs.length > 5000) refuse();
        if (pageToken && seen.has(pageToken)) refuse();
        seen.add(pageToken);
      } while (pageToken);
      return jobs;
    },
    deleteFunction: (name, selected) => {
      if (!/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(name) || !isDeepStrictEqual(selected, scope)) refuse();
      return launch("npx", ["--no-install", "firebase", "functions:delete", name,
        "--project", selected.projectId, "--region", selected.region, "--force", "--non-interactive"],
      { timeout: 300000, maxBuffer: 64 * 1024 });
    },
    deleteSchedule: name => {
      const prefix = `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-`;
      if (!name.startsWith(prefix) || !name.endsWith(`-${scope.region}`)
        || !/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(name.slice(prefix.length, -(scope.region.length + 1)))) refuse();
      return request(`https://cloudscheduler.googleapis.com/v1/${name}`, undefined, "DELETE");
    },
  };
}

export async function prepareRetirements(firestore, context, provider) {
  const receipt = ownedReceipt(await readReceipt(firestore, "functions"), context);
  const pendingPlan = receipt.mutation.retirementPlan;
  if (pendingPlan && samePlanOwner(pendingPlan, context)) return retirementReceipt(firestore, context);
  const prior = receipt.lastComplete?.functionGraph;
  const priorNames = prior?.version === 2 && /^[a-f0-9]{64}$/.test(prior.globalFingerprint ?? "") && prior.exports && !Array.isArray(prior.exports)
    && Object.values(prior.exports).every(row => /^[a-f0-9]{64}$/.test(row?.fingerprint ?? "") && typeof row?.preview === "boolean")
    ? Object.keys(prior.exports) : [];
  const functions = await provider.listFunctions();
  const jobs = await provider.listSchedules();
  const plan = planFunctionRetirements({ ...context, priorNames, functions, jobs, pendingPlan });
  return retirementReceipt(firestore, context, { retirementPlan: plan, retirementStarted: receipt.mutation.retirementStarted === true, retirementComplete: false });
}

export async function deployWithRetirements(firestore, context, provider, deploy = deployFunctions, phase = process.env.CMS_FUNCTION_DEPLOY_PHASE) {
  const row = await retirementReceipt(firestore, context, { retirementStarted: true, retirementComplete: false });
  const plan = row.mutation.retirementPlan;
  const io = { ...provider,
    assertAttempt: async () => {
      const current = await retirementReceipt(firestore, context);
      if (!isDeepStrictEqual(current.mutation.retirementPlan, plan)) refuse();
    } };
  await deploy({ retireCloudWake: async (names, project) => {
    if (project !== context.scope.projectId || !Array.isArray(names) || names.some(name => context.targetNames.includes(name))) refuse();
    await applyFunctionRetirements(plan, context, io, plan.entries.filter(entry => names.includes(entry.name)).map(entry => entry.name));
  } });
  if (phase === "before-preview") return;
  const result = await applyFunctionRetirements(plan, context, io);
  await retirementReceipt(firestore, context, { retirementComplete: true });
  return result;
}

export async function main(argv) {
  const command = argv[0];
  if (argv.length !== 1 || !["prepare", "deploy", "verify"].includes(command)) refuse();
  // The retained verify-only operation does not mutate providers or receipts.
  if (command === "verify") return deployFunctions({ verifyOnly: true });
  return withFirestore(async (firestore, app) => {
    const context = retirementContext(firestore);
    const provider = retirementProvider(context.scope, () => app.options.credential.getAccessToken());
    if (command === "prepare") return prepareRetirements(firestore, context, provider);
    return deployWithRetirements(firestore, context, provider);
  });
}

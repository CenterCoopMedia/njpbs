#!/usr/bin/env node
import { parseMigrationSelection, selectMigrations } from "./lib/deployment-components.mjs";
import { appendFileSync } from "node:fs";
import { cert, deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { cmsTarget } from "./lib/cms-target.mjs";
import { ComponentReceiptError, collectLiveIdentities, edgeOriginSecretFingerprint, fingerprintFunctionGraph, fingerprintInputs, readReceipt } from "./lib/cms-component-receipt.mjs";
import { fingerprintRendererGraph } from "./lib/cms-renderer-graph.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { currentVersionMatches } from "./lib/functions-secret-versions.mjs";
import { studioTitleFilesParameter } from "./lib/studio-title-files.mjs";
import { resolveDiscovery } from "./configure-cms-functions.mjs";
import { configurationInputs, RUNTIME_PARAMETERS, runtimeParameters, servingRuntimeParameters } from "./lib/functions-configuration.mjs";
import {
  ADMIN_REVISION_INTAKE_FLOOR,
  adminRevisionChanges,
  assertLegacyCmsWorkflow,
  baselineMutation,
  boundSecretVersionChanges,
  cloudWakeConfigurationFingerprint,
  decideRelease,
  deploymentVariablesFingerprint,
  deploymentSecretsUnchanged,
  explicitCloudWakeDecision,
  fingerprintFunctionsRenderSource,
  functionsForRuntimeComparison,
  functionSourceProof,
  omittedFunctionNames,
  withoutFunctions,
  componentReceiptRunCompleted,
  runtimeParameterChanges,
} from "./lib/cms-release-plan.mjs";

const execFileAsync = promisify(execFile);

export async function desiredRuntimeParameters(env, execute) {
  // Invalid enabled Studio configuration must abort preflight, rather than
  // selecting a full release that fails after preview mutation begins.
  studioTitleFilesParameter(env.VITE_CMS_STUDIO_CONFIGURATION, env.VITE_LIVE_PRODUCTION_ENABLED);
  try {
    const input = configurationInputs(env);
    return servingRuntimeParameters(runtimeParameters(input, resolveDiscovery({ ...env, ...input }, execute)));
  } catch {
    // Errors may contain secret-derived parameter input or child env details.
    return null;
  }
}

async function isAncestor(floor, sha, cwd) {
  if (!sha) return false;
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", floor, sha], { cwd });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  throw new ComponentReceiptError(message);
}

async function loadCredential() {
  const { readFileSync } = await import("node:fs");
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8")
    : process.env.FIREBASE_SERVICE_ACCOUNT || process.env.CMS_PREVIEW_FIREBASE_ACCOUNT;
  if (!raw) fail("Firebase credentials are required");
  const parsed = raw.trim().startsWith("{") ? JSON.parse(raw) : JSON.parse(readFileSync(raw, "utf8"));
  const { projectId } = cmsTarget();
  if (parsed.project_id !== projectId) fail(`Firebase project must be ${projectId}`);
  return parsed;
}

export function releasePlanOutputLines(plan, { deploySha, edgeFingerprint, configurationFingerprint, variablesFingerprint, rendererFingerprint, selectedMigrations = [], requestedMigrations = [] }) {
  return [
    "preview_protocol=schema-one",
    `selected_migrations=${selectedMigrations.join(",")}`,
    `requested_migrations=${requestedMigrations.join(",")}`,
    `functions_mutated=${plan.functionsMutated}`,
    `function_deploy_targets=${plan.functionDeployTargets}`,
    `function_reasons=${JSON.stringify(plan.functionReasons ?? {})}`,
    `preview_pause_late=${plan.previewPauseLate === true}`,
    `functions_before_preview=${plan.functionsBeforePreview ?? ""}`,
    `functions_during_preview=${plan.functionsDuringPreview ?? ""}`,
    `renderer_input_fingerprint=${rendererFingerprint ?? ""}`,
    `edge_origin_secret_fingerprint=${edgeFingerprint}`,
    `functions_configuration_fingerprint=${configurationFingerprint}`,
    `functions_variables_fingerprint=${variablesFingerprint}`,
    `preview_paused=${plan.previewPaused}`,
    `live_functions_sha=${plan.liveFunctionsSha ?? ""}`,
    `renderer_target_sha=${plan.rendererTargetSha ?? deploySha}`,
    `configuration_requires_release=${plan.configurationRequiresRelease}`,
    `release_reason=${plan.releaseReason}`,
    `reader_rebind=${plan.readerRebind === true}`,
  ];
}

export async function main() {
  const requestedMigrations = parseMigrationSelection(process.env.CMS_DEPLOY_MIGRATIONS ?? "");
  // Validate before credentials, provider reads or release-plan outputs.
  try {
    studioTitleFilesParameter(process.env.VITE_CMS_STUDIO_CONFIGURATION, process.env.VITE_LIVE_PRODUCTION_ENABLED);
  } catch (error) {
    fail(error.message === "Studio feature configuration is unavailable" ? error.message : "Studio preset configuration is unavailable");
  }
  const deploySha = process.env.DEPLOY_SHA;
  const trustedSha = process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(deploySha ?? "") || !/^[0-9a-f]{40}$/.test(trustedSha ?? "")) {
    fail("DEPLOY_SHA and GITHUB_SHA must be full revisions");
  }
  const decision = explicitCloudWakeDecision(process.env);
  const manifest = process.env.FUNCTION_TARGETS;
  const manifestNames = manifest === undefined ? null
    : /^functions:[A-Za-z][A-Za-z0-9]*(,functions:[A-Za-z][A-Za-z0-9]*)*$/.test(manifest)
      ? manifest.split(",").map(name => name.slice("functions:".length)) : [];
  const omittedNames = omittedFunctionNames(decision);
  const edgeFingerprint = edgeOriginSecretFingerprint(process.env);
  const variablesFingerprint = deploymentVariablesFingerprint(process.env.CMS_DEPLOYMENT_VARIABLES_JSON);
  const configurationFingerprint = cloudWakeConfigurationFingerprint(edgeFingerprint, decision, variablesFingerprint);
  const parsed = await loadCredential();
  const created = getApps().length === 0;
  const app = getApps()[0] || initializeApp({ credential: cert(parsed), projectId: cmsTarget().projectId });
  try {
    const firestore = getFirestore(app);
    await assertLegacyCmsWorkflow(firestore);
    const { GoogleAuth } = createRequire(import.meta.url)("google-auth-library");
    const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
    const desiredVersions = new Map();
    const readClient = { request: async options => {
      const result = await client.request({ ...options, timeout: 15_000 });
      if (options.url.endsWith("/versions/latest")) {
        const match = result.data?.name?.match(/\/secrets\/([^/]+)\/versions\/([0-9]+)$/);
        if (match) desiredVersions.set(match[1], match[2]);
      }
      return result;
    } };
    const secretsUnchanged = await deploymentSecretsUnchanged(process.env,
      (name, desired) => currentVersionMatches(name, desired, readClient));
    const [functionsReceipt, rendererReceipt, functionsFingerprint, rendererGraph, renderFingerprint, runtime] =
      await Promise.all([
        readReceipt(firestore, "functions"),
        readReceipt(firestore, "renderer"),
        fingerprintInputs(deploySha, "functions", { cwd: process.env.GITHUB_WORKSPACE }),
        fingerprintRendererGraph(deploySha, { cwd: process.env.GITHUB_WORKSPACE, onUnknown(code, file) {
          const reason = /^[a-z_]{1,64}$/.test(code) ? code : "unresolved";
          const path = typeof file === "string" && /^[A-Za-z0-9_./-]{1,200}$/.test(file) ? ` (${file})` : "";
          process.stderr.write(`Renderer graph fallback: ${reason}${path}; full paired release required\n`);
        } }),
        fingerprintFunctionsRenderSource(trustedSha, { cwd: process.env.GITHUB_WORKSPACE }),
        fingerprintFunctionGraph(deploySha, { cwd: process.env.GITHUB_WORKSPACE, includeRuntimeInputs: true }),
      ]);
    const rendererFingerprint = rendererGraph?.fingerprint ?? await fingerprintInputs(deploySha, "renderer", { cwd: process.env.GITHUB_WORKSPACE });
    const baseline = baselineMutation(functionsReceipt, {
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }).mutation;
    const [receiptRenderFingerprint, priorRuntime] = await Promise.all([
      fingerprintFunctionsRenderSource(baseline?.trustedWorkflowSha, { cwd: process.env.GITHUB_WORKSPACE }),
      fingerprintFunctionGraph(baseline?.sourceSha, { cwd: process.env.GITHUB_WORKSPACE, includeRuntimeInputs: true }),
    ]);
    // Contract capture uses the committed graphs without the deploy job's manifest.
    const sourceProof = functionSourceProof(priorRuntime, runtime, baseline?.functionGraph);
    const desiredParameters = await desiredRuntimeParameters({
      ...process.env,
      CMS_ADMIN_BUILD_REVISION: deploySha,
      CMS_PREVIEW_RENDERER_SHA: baseline?.previewRendererSha ?? baseline?.sourceSha ?? deploySha,
    });
    const functionGraph = runtime?.graph;
    let liveFunctions = null;
    const liveFunctionsIdentities = await collectLiveIdentities("functions", {
      firestore, inspectFunctions: functions => {
        liveFunctions = functionsForRuntimeComparison(functions, withoutFunctions(functionGraph, omittedNames));
      },
    }).catch(() => null);
    // Production intake resolves the Admin revision from live status after the
    // revision floor. The renderer pin follows the independent preview plan.
    const comparedParameterKeys = Object.keys(RUNTIME_PARAMETERS).filter(key =>
      key !== "CMS_ADMIN_BUILD_REVISION" && key !== "CMS_PREVIEW_RENDERER_SHA");
    const parameterChanges = runtimeParameterChanges(liveFunctions, desiredParameters, runtime?.reads, comparedParameterKeys);
    const revisionChanges = cmsTarget().environment === "development"
      ? adminRevisionChanges(liveFunctions, deploySha, runtime?.reads) : {};
    const secretChanges = await boundSecretVersionChanges(liveFunctions, async (project, secret) =>
      (await client.request({ url: `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}/versions/latest`,
        timeout: 15_000 })).data, desiredVersions);
    // Fixed booleans only: identify every false predicate without exposing
    // desired parameters, secret values, provider responses or exceptions.
    process.stdout.write([
      `configuration_secrets_unchanged=${secretsUnchanged === true}`,
      `configuration_parameters_match=${parameterChanges !== null && Object.values(parameterChanges).every(reasons => !reasons.length)}`,
      `configuration_bindings_current=${secretChanges !== null && Object.values(secretChanges).every(reasons => !reasons.length)}`,
    ].join("\n") + "\n");
    // A dev run reads the dev renderer with its own token, never CLOUDFLARE_API_TOKEN.
    const rendererToken = cmsTarget().environment === "development"
      ? { cloudflareToken: process.env.CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN ?? "" } : {};
    const liveRendererIdentities = await collectLiveIdentities("renderer", { firestore, ...rendererToken }).catch(() => null);
    const liveFunctionsSha = functionsReceipt?.state === "complete"
      ? functionsReceipt.mutation?.sourceSha
      : functionsReceipt?.lastComplete?.sourceSha;
    const [functionsRunCompleted, rendererRunCompleted] = await Promise.all([functionsReceipt, rendererReceipt].map(receipt =>
      componentReceiptRunCompleted(receipt, { token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
        currentRunId: process.env.GITHUB_RUN_ID, currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT })));
    const plan = decideRelease({
      variablesFingerprint,
      configurationRequiresRelease: !secretsUnchanged
        || parameterChanges === null
        || secretChanges === null,
      runtimeChanges: parameterChanges && secretChanges && Object.fromEntries(Object.keys(parameterChanges).map(name =>
        [name, [...parameterChanges[name], ...secretChanges[name], ...(revisionChanges[name] ?? [])]])),
      sourceProof,
      deploySha,
      functionGraph,
      manifestNames,
      omittedNames,
      readerBinding: ["required", "current"].includes(process.env.CMS_READER_REBIND)
        ? { required: process.env.CMS_READER_REBIND === "required" } : null,
      forceFirebase: process.env.FORCE_FIREBASE,
      functionsReceipt,
      rendererReceipt,
      functionsRunCompleted, rendererRunCompleted,
      functionsFingerprint,
      configurationFingerprint,
      baselineConfigurationFingerprint: /^[a-f0-9]{64}$/.test(baseline?.variablesFingerprint ?? "")
        ? cloudWakeConfigurationFingerprint(edgeFingerprint, decision, baseline.variablesFingerprint)
        : null,
      rendererFingerprint,
      rendererGraphAvailable: rendererGraph !== null,
      renderFingerprint,
      receiptRenderFingerprint,
      liveFunctionsIdentities,
      liveRendererIdentities,
      currentRun: {
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      targetHasAdminRevisionIntake: await isAncestor(
        ADMIN_REVISION_INTAKE_FLOOR,
        deploySha,
        process.env.GITHUB_WORKSPACE,
      ),
      liveHasAdminRevisionIntake: await isAncestor(
        ADMIN_REVISION_INTAKE_FLOOR,
        liveFunctionsSha,
        process.env.GITHUB_WORKSPACE,
      ),
    });
    if (plan.abort) {
      if (plan.blockedComponent === "renderer") {
        fail(`Renderer receipt run ${plan.retry.afterRun ?? "(unknown)"} is active or could not be verified (in_progress_receipt). ` +
          "Once that run has completed, dispatch CMS staging deploy again on the same reviewed commit with its default inputs; the plan then treats the receipt as stale");
      }
      fail(`An in-progress CMS receipt is still active (${plan.releaseReason})`);
    }
    const selectedMigrations = await selectMigrations(baseline?.sourceSha, deploySha, requestedMigrations, {
      cwd: process.env.GITHUB_WORKSPACE, functionsMutated: plan.functionsMutated,
    });
    const output = process.env.GITHUB_OUTPUT;
    const lines = releasePlanOutputLines(plan, { deploySha, edgeFingerprint, configurationFingerprint, variablesFingerprint, rendererFingerprint, selectedMigrations, requestedMigrations });
    process.stdout.write(`${lines.join("\n")}\n`);
    if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  } finally {
    if (created) await deleteApp(app);
  }
}

#!/usr/bin/env node
import { parseMigrationSelection, selectMigrations } from "./lib/deployment-components.mjs";
import { appendFileSync } from "node:fs";
import { cert, deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { ComponentReceiptError, collectLiveIdentities, edgeOriginSecretFingerprint, fingerprintFunctionGraph, fingerprintInputs, readReceipt } from "./lib/cms-component-receipt.mjs";
import { fingerprintRendererGraph } from "./lib/cms-renderer-graph.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { currentVersionMatches } from "./lib/functions-secret-versions.mjs";
import { studioTitleFilesParameter } from "./lib/studio-title-files.mjs";
import {
  ADMIN_REVISION_INTAKE_FLOOR,
  assertLegacyCmsWorkflow,
  baselineMutation,
  boundSecretVersionsCurrent,
  cloudWakeConfigurationFingerprint,
  decideRelease,
  deploymentVariablesFingerprint,
  deploymentSecretsUnchanged,
  explicitCloudWakeDecision,
  fingerprintExecutionSource,
  fingerprintReceiptExecutionSource,
  functionsForRuntimeComparison,
  componentReceiptRunCompleted,
  runtimeParametersMatch,
} from "./lib/cms-release-plan.mjs";

const execFileAsync = promisify(execFile);

export async function desiredRuntimeParameters(env, execute = execFileAsync) {
  // Invalid enabled Studio configuration must abort preflight, rather than
  // selecting a full release that fails after preview mutation begins.
  const studioTitles = studioTitleFilesParameter(env.VITE_CMS_STUDIO_CONFIGURATION, env.VITE_LIVE_PRODUCTION_ENABLED);
  try {
    const variables = JSON.parse(env.CMS_DEPLOYMENT_VARIABLES_JSON);
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!/^[a-f0-9]{32}$/.test(account ?? "")) return null;
    const map = JSON.parse(env.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP);
    const expected = {
      CMS_STUDIO_TITLE_FILES: studioTitles,
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: env.CMS_BUG_REPORT_TELEGRAM_CHAT_ID,
      CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: JSON.stringify(map).replaceAll("'", "\\u0027"),
      CMS_STAFF_EMAIL_ACCOUNT_ID: account,
      ...Object.fromEntries(["CMS_MEDIA_R2_ENDPOINT", "CMS_PRIVATE_VIDEO_R2_ENDPOINT", "CMS_VOICEOVER_R2_ENDPOINT"]
        .map(key => [key, `https://${account}.r2.cloudflarestorage.com`])),
    };
    // The existing metadata-only resolvers write local, gitignored discovery
    // flags. Compare their effective output, including provider readiness, with
    // every serving function in memory. Never persist secret-derived params.
    for (const script of ["resolve-media-purge.sh", "resolve-cost-ledger-pulls.sh"]) {
      const { stdout } = await execute("bash", [`scripts/${script}`], {
        cwd: env.GITHUB_WORKSPACE,
        env: { ...Object.fromEntries(["PATH", "HOME", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"]
          // config-input: CLOUDSDK_CONFIG, GOOGLE_APPLICATION_CREDENTIALS, HOME, PATH
          .filter(key => typeof env[key] === "string").map(key => [key, env[key]])),
        ...Object.fromEntries(Object.entries(variables).filter(([key]) => /^(?:COST_LEDGER_|CMS_MEDIA_PURGE_)/.test(key))),
        ...(env.GOOGLE_APPLICATION_CREDENTIALS ? { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: env.GOOGLE_APPLICATION_CREDENTIALS } : {}) },
        timeout: 120_000, maxBuffer: 64 * 1024,
      });
      for (const line of stdout.trim().split("\n")) {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
        if (!match) return null;
        expected[match[1]] = match[2];
      }
    }
    return expected;
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
  if (parsed.project_id !== "njpbs-site") fail("Firebase project must be njpbs-site");
  return parsed;
}

export function releasePlanOutputLines(plan, { deploySha, edgeFingerprint, configurationFingerprint, variablesFingerprint, rendererFingerprint, selectedMigrations = [], requestedMigrations = [] }) {
  return [
    "preview_protocol=schema-one",
    `selected_migrations=${selectedMigrations.join(",")}`,
    `requested_migrations=${requestedMigrations.join(",")}`,
    `functions_mutated=${plan.functionsMutated}`,
    `function_deploy_targets=${plan.functionDeployTargets}`,
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
  const edgeFingerprint = edgeOriginSecretFingerprint(process.env);
  const variablesFingerprint = deploymentVariablesFingerprint(process.env.CMS_DEPLOYMENT_VARIABLES_JSON);
  const configurationFingerprint = cloudWakeConfigurationFingerprint(edgeFingerprint, decision, variablesFingerprint);
  const parsed = await loadCredential();
  const created = getApps().length === 0;
  const app = getApps()[0] || initializeApp({ credential: cert(parsed), projectId: "njpbs-site" });
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
    const [functionsReceipt, rendererReceipt, functionsFingerprint, rendererGraph, trustedFingerprint, functionGraph] =
      await Promise.all([
        readReceipt(firestore, "functions"),
        readReceipt(firestore, "renderer"),
        fingerprintInputs(deploySha, "functions", { cwd: process.env.GITHUB_WORKSPACE }),
        fingerprintRendererGraph(deploySha, { cwd: process.env.GITHUB_WORKSPACE, onUnknown(code, file) {
          const reason = /^[a-z_]{1,64}$/.test(code) ? code : "unresolved";
          const path = typeof file === "string" && /^[A-Za-z0-9_./-]{1,200}$/.test(file) ? ` (${file})` : "";
          process.stderr.write(`Renderer graph fallback: ${reason}${path}; full paired release required\n`);
        } }),
        fingerprintExecutionSource(deploySha, trustedSha, { cwd: process.env.GITHUB_WORKSPACE }),
        fingerprintFunctionGraph(deploySha, { cwd: process.env.GITHUB_WORKSPACE }),
      ]);
    const rendererFingerprint = rendererGraph?.fingerprint ?? await fingerprintInputs(deploySha, "renderer", { cwd: process.env.GITHUB_WORKSPACE });
    const baseline = baselineMutation(functionsReceipt, {
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }).mutation;
    const trustedReceiptFingerprint = await fingerprintReceiptExecutionSource(baseline, { cwd: process.env.GITHUB_WORKSPACE });
    const desiredParameters = await desiredRuntimeParameters(process.env);
    let parametersMatch = false;
    let liveFunctions = null;
    const liveFunctionsIdentities = await collectLiveIdentities("functions", {
      firestore, inspectFunctions: functions => {
        liveFunctions = functionsForRuntimeComparison(functions, functionGraph);
        parametersMatch = runtimeParametersMatch(liveFunctions, desiredParameters);
      },
    }).catch(() => null);
    const bindingsCurrent = await boundSecretVersionsCurrent(liveFunctions, async (project, secret) =>
      (await client.request({ url: `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}/versions/latest`,
        timeout: 15_000 })).data, desiredVersions);
    // Fixed booleans only: identify every false predicate without exposing
    // desired parameters, secret values, provider responses or exceptions.
    process.stdout.write([
      `configuration_secrets_unchanged=${secretsUnchanged === true}`,
      `configuration_parameters_match=${parametersMatch === true}`,
      `configuration_bindings_current=${bindingsCurrent === true}`,
    ].join("\n") + "\n");
    const liveRendererIdentities = await collectLiveIdentities("renderer", { firestore }).catch(() => null);
    const liveFunctionsSha = functionsReceipt?.state === "complete"
      ? functionsReceipt.mutation?.sourceSha
      : functionsReceipt?.lastComplete?.sourceSha;
    const [functionsRunCompleted, rendererRunCompleted] = await Promise.all([functionsReceipt, rendererReceipt].map(receipt =>
      componentReceiptRunCompleted(receipt, { token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
        currentRunId: process.env.GITHUB_RUN_ID, currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT })));
    const plan = decideRelease({
      variablesFingerprint,
      configurationRequiresRelease: !secretsUnchanged
        || !parametersMatch
        || !bindingsCurrent,
      deploySha,
      functionGraph,
      forceFirebase: process.env.FORCE_FIREBASE,
      functionsReceipt,
      rendererReceipt,
      functionsRunCompleted, rendererRunCompleted,
      functionsFingerprint,
      configurationFingerprint,
      rendererFingerprint,
      rendererGraphAvailable: rendererGraph !== null,
      trustedFingerprint,
      trustedReceiptFingerprint,
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
        fail("Renderer receipt run is active or could not be verified (in_progress_receipt). Confirm the run has stopped, then start CMS staging deploy with force_firebase=true on the same reviewed commit");
      }
      fail(`An in-progress CMS receipt is still active (${plan.releaseReason})`);
    }
    const selectedMigrations = plan.functionsMutated ? requestedMigrations
      : await selectMigrations(baseline.sourceSha, deploySha, requestedMigrations, { cwd: process.env.GITHUB_WORKSPACE });
    const output = process.env.GITHUB_OUTPUT;
    const lines = releasePlanOutputLines(plan, { deploySha, edgeFingerprint, configurationFingerprint, variablesFingerprint, rendererFingerprint, selectedMigrations, requestedMigrations });
    process.stdout.write(`${lines.join("\n")}\n`);
    if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  } finally {
    if (created) await deleteApp(app);
  }
}

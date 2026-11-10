import { repositoryMatches } from "./repository-identity.mjs";
import { ComponentReceiptError, assertLegacyPreviewProtocol, configurationFingerprint, fingerprintPaths, FUNCTION_GRAPH_VERSION } from "./cms-component-receipt.mjs";

export async function assertLegacyCmsWorkflow(firestore) {
  const row = await firestore.doc("system/cmsPreviewRuntime").get();
  return assertLegacyPreviewProtocol(row.exists ? row.data() : null);
}

export function explicitCloudWakeDecision(env) {
  const environment = env?.CLOUD_PUBLICATION_WAKE_ENVIRONMENT;
  const enabled = env?.CLOUD_PUBLICATION_WAKE_ENABLED;
  if ((environment !== "production" && environment !== "development") || (enabled !== "true" && enabled !== "false")) {
    throw new ComponentReceiptError("An explicit cloud wake deployment decision is required");
  }
  return { environment, enabled: enabled === "true" };
}

export { FUNCTION_RUNTIME_VARIABLES, CMS_RELEASE_SECRET_NAMES } from "./functions-configuration.mjs";
import { FUNCTION_RUNTIME_VARIABLES, CMS_RELEASE_SECRET_NAMES } from "./functions-configuration.mjs";

export function deploymentVariablesFingerprint(raw) {
  let values;
  try { values = JSON.parse(raw); } catch { throw new ComponentReceiptError("Deployment variables are invalid"); }
  if (!values || typeof values !== "object" || Array.isArray(values)
    || Object.values(values).some(value => typeof value !== "string")) throw new ComponentReceiptError("Deployment variables are invalid");
  return configurationFingerprint({ variables: JSON.stringify(Object.fromEntries(
    FUNCTION_RUNTIME_VARIABLES.map(key => [key, values[key] ?? ""]))) });
}


// Compare only in memory; receipts contain no new secret-value digest.
export async function deploymentSecretsUnchanged(env, matches) {
  if (env.CMS_PUBLISH_GITHUB_TOKEN_PROVISIONING?.trim()) return false;
  try {
    for (const name of CMS_RELEASE_SECRET_NAMES) {
      // config-input: CMS_BUG_REPORT_GITHUB_TOKEN, CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET, CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN
      // config-input: CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET, CMS_EDGE_ORIGIN_SECRET, CMS_MEDIA_CACHE_PURGE_TOKEN
      // config-input: CMS_STAFF_EMAIL_API_TOKEN, CMS_VOICEOVER_R2_ACCESS_KEY_ID, CMS_VOICEOVER_R2_SECRET_ACCESS_KEY
      if (!env[name] || !await matches(name, Buffer.from(env[name], "utf8"))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Retained exports outside the selected source (for example billingKillSwitch)
// are not updated by a CMS release. Keep them in the provider identity, but do
// not require them to carry this release's dotenv or secret bindings.
export function functionsForRuntimeComparison(functions, graph) {
  const names = Object.keys(graph?.exports ?? {});
  if (!Array.isArray(functions) || !names.length || names.some(name => !/^[A-Za-z][A-Za-z0-9]*$/.test(name))) return null;
  const selected = names.map(name => functions.filter(fn =>
    fn?.name === `projects/njpbs-site/locations/us-central1/functions/${name}`));
  if (selected.some(matches => matches.length !== 1
    || (matches[0].labels?.["firebase-functions-codebase"] ?? "default") !== "default"
    || matches[0].buildConfig?.entryPoint !== matches[0].name.split("/").at(-1))) return null;
  return selected.flat();
}

export async function boundSecretVersionsCurrent(functions, describe, comparedVersions = new Map()) {
  if (!Array.isArray(functions) || !functions.length) return false;
  const versions = new Map();
  try {
    for (const fn of functions) {
      for (const binding of fn?.serviceConfig?.secretEnvironmentVariables ?? []) {
        const { projectId, secret, version } = binding;
        if (!/^(?:njpbs-site|[0-9]+)$/.test(projectId ?? "") || !/^[A-Za-z0-9_-]+$/.test(secret ?? "")
          || !/^[1-9][0-9]*$/.test(version ?? "")) return false;
        const key = `${projectId}/${secret}`;
        if (!versions.has(key)) versions.set(key, Promise.resolve(describe(projectId, secret)));
        const latest = await versions.get(key);
        const match = latest?.name?.match(/^projects\/(?:njpbs-site|[0-9]+)\/secrets\/([A-Za-z0-9_-]+)\/versions\/([1-9][0-9]*)$/);
        if (latest?.state !== "ENABLED" || !match || match[1] !== secret || match[2] !== version
          || (comparedVersions.has(secret) && comparedVersions.get(secret) !== version)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function runtimeParametersMatch(functions, expected) {
  return Array.isArray(functions) && functions.length > 0 && expected
    && Object.keys(expected).length > 0 && Object.values(expected).every(value => typeof value === "string")
    && functions.every(fn => Object.entries(expected).every(([key, value]) =>
      fn?.serviceConfig?.environmentVariables?.[key] === value));
}

export function cloudWakeConfigurationFingerprint(edgeFingerprint, decision, variablesFingerprint = null) {
  if (!/^[a-f0-9]{64}$/.test(edgeFingerprint ?? "")) {
    throw new ComponentReceiptError("Functions configuration fingerprint is required");
  }
  if ((decision?.environment !== "production" && decision?.environment !== "development") || typeof decision?.enabled !== "boolean") {
    throw new ComponentReceiptError("An explicit cloud wake deployment decision is required");
  }
  return configurationFingerprint({
    CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: edgeFingerprint,
    CLOUD_PUBLICATION_WAKE_ENVIRONMENT: decision.environment,
    CLOUD_PUBLICATION_WAKE_ENABLED: decision.enabled ? "true" : "false",
    ...(variablesFingerprint ? { DEPLOYMENT_VARIABLES_FINGERPRINT: variablesFingerprint } : {}),
  });
}

export const ADMIN_REVISION_INTAKE_FLOOR = "8bf66cc984917486a76c1632182723ef16337d7d";

export const TRUSTED_RELEASE_PATHS = Object.freeze([
  "scripts/render-development-config.mjs",
  "config/development-inputs.json",
  ".github/workflows/cms-staging-deploy.yml",
  ".github/scripts",
  "scripts/lib/production-reader-authorization.mjs",
  "scripts/check-cms-secret-iam.mjs",
  "scripts/lib/functions-deploy-inventory.mjs",
  "scripts/assert-r2-lifecycle.mjs",
]);

export const RELEASE_CHECK_PATHS = Object.freeze([
  "scripts/configure-cms-functions.mjs",
  "scripts/lib/functions-configuration.mjs",
  "config/functions-configuration.json",
  "config/functions-deployment.json",
  "scripts/check-cms-secret-iam.mjs",
  "scripts/assert-r2-lifecycle.mjs",
  "scripts/retire-cms-functions.mjs", "scripts/lib/functions-retirement.mjs",
  "scripts/component-runner.mjs", "scripts/lib/deployment-components.mjs",
  "scripts/deploy-cms-function-batches.mjs",
  "scripts/lib/functions-deploy-inventory.mjs",
  "scripts/lib/functions-secret-versions.mjs",
  "scripts/smoke-cms-functions.mjs",
  "scripts/cms-component-receipt.mjs",
  "scripts/lib/cms-component-receipt.mjs",
  "scripts/lib/cms-renderer-graph.mjs",
  "scripts/lib/cms-release-plan.mjs",
  "scripts/lib/repository-identity.mjs",
  "scripts/lib/studio-title-files.mjs",
  "agents/vmix/configuration.mjs",
  "scripts/cms-release-plan.mjs",
  "scripts/confirm-admin-revision.mjs",
  "scripts/check-admin-pages-security.mjs",
]);

function sortKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SERIALIZER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function rendererIdentityCoreMatches(left, right) {
  return left.applicationId === right.applicationId
    && SHA_PATTERN.test(left.rendererSha ?? "")
    && SHA_PATTERN.test(right.rendererSha ?? "")
    && left.rendererSha === right.rendererSha
    && SERIALIZER_PATTERN.test(left.serializerId ?? "")
    && SERIALIZER_PATTERN.test(right.serializerId ?? "")
    && left.serializerId === right.serializerId;
}

function validRendererV2(identity) {
  return identity.identityVersion === "2"
    && FINGERPRINT_PATTERN.test(identity.identityFingerprint ?? "")
    && identity.workerScript === "njpbs-cms-preview-renderer"
    && typeof identity.workerDeploymentId === "string"
    && identity.workerDeploymentId.length > 0
    && identity.workerDeploymentId.length <= 80
    && FINGERPRINT_PATTERN.test(identity.workerScheduleFingerprint ?? "");
}

function rendererIdentitiesMatch(left, right) {
  if (!rendererIdentityCoreMatches(left, right)) return false;
  if (left.identityVersion === "2" && right.identityVersion === "2") {
    if (!validRendererV2(left) || !validRendererV2(right)) return false;
    return left.identityFingerprint === right.identityFingerprint
      && left.workerScript === right.workerScript
      && left.workerDeploymentId === right.workerDeploymentId
      && left.workerScheduleFingerprint === right.workerScheduleFingerprint;
  }
  const leftIsCurrent = left.identityVersion === "2";
  const rightIsCurrent = right.identityVersion === "2";
  if (leftIsCurrent === rightIsCurrent) return false;
  const current = leftIsCurrent ? left : right;
  const legacy = leftIsCurrent ? right : left;
  return Boolean(
    validRendererV2(current)
      && !legacy.identityVersion
      && FINGERPRINT_PATTERN.test(legacy.identityFingerprint ?? "")
      && current.legacyIdentityFingerprint
      && current.legacyIdentityFingerprint === legacy.identityFingerprint,
  );
}

export function identitiesMatch(left, right) {
  if (!left || !right) return false;
  if (left.applicationId || right.applicationId) {
    return rendererIdentitiesMatch(left, right);
  }
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

export function baselineMutation(receipt, currentRun = {}) {
  if (!receipt || receipt.schemaVersion !== 1) return { blocked: "missing_receipt" };
  const mutation = receipt.mutation;
  const sameAttempt = mutation?.runId === currentRun.runId
    && Number(mutation?.runAttempt) === Number(currentRun.runAttempt);
  if (receipt.state === "in_progress" && !sameAttempt) {
    return { blocked: "in_progress_receipt" };
  }
  if (receipt.state === "in_progress" && sameAttempt) {
    return receipt.lastComplete ? { mutation: receipt.lastComplete } : { blocked: "missing_receipt" };
  }
  if (receipt.state !== "complete" || !mutation?.sourceSha || !mutation?.inputFingerprint) {
    return { blocked: "missing_receipt" };
  }
  return { mutation };
}

// The workflow's concurrency group excludes another CMS deploy while this
// preflight runs. Check the latest attempt so a rerun cannot look abandoned.
export async function componentReceiptRunCompleted(receipt, { token, repository, currentRunId, currentRunAttempt, fetchImpl = fetch }) {
  const runId = receipt?.mutation?.runId;
  const attempt = Number(receipt?.mutation?.runAttempt);
  if (receipt?.schemaVersion !== 1 || !["functions", "renderer"].includes(receipt.component) || receipt.state !== "in_progress"
    || !/^[0-9]{1,20}$/.test(runId ?? "")
    || !Number.isSafeInteger(attempt) || attempt < 1 || !token
    || !repositoryMatches(repository, process.env)) return false;
  // A rerun replaces its stopped prior attempt; another run requires native
  // latest-attempt proof below. Neither path overrides an active owner.
  if (runId === currentRunId) return Number.isSafeInteger(Number(currentRunAttempt)) && Number(currentRunAttempt) > attempt;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const run = await response.json();
    return Number.isSafeInteger(run.id) && String(run.id) === runId
      && run.repository?.full_name === repository
      && typeof run.path === "string"
      && run.path.split("@")[0] === ".github/workflows/cms-staging-deploy.yml"
      && run.event === "workflow_dispatch" && run.status === "completed"
      && Number.isSafeInteger(run.run_attempt) && run.run_attempt >= attempt;
  } catch {
    return false;
  }
}

// The CMS API job plans its own Worker release so a partial rerun cannot reuse
// a stale skip. A configuration release always deploys the Worker. A Functions
// upload alone does not select the Worker. The Worker skips only when its
// complete receipt, inputs,
// trusted deploy source, secret configuration and live deployment all match.
// Missing or changed edge-secret agreement aborts before the Worker changes.
// Other missing, unreadable or changed inputs deploy.
export function planCmsApiRelease({
  configurationRequiresRelease,
  edgeOriginSecretFingerprint = null,
  expectedEdgeOriginSecretFingerprint = null,
  receipt = null,
  inputFingerprint = null,
  trustedFingerprint = null,
  trustedReceiptFingerprint = null,
  configurationFingerprint = null,
  liveIdentities = null,
}) {
  if (
    !FINGERPRINT_PATTERN.test(edgeOriginSecretFingerprint ?? "") ||
    edgeOriginSecretFingerprint !== expectedEdgeOriginSecretFingerprint
  ) {
    return { abort: true, mutated: false, reason: "edge_origin_secret_mismatch" };
  }
  const deploy = (reason) => ({ mutated: true, reason });
  if (String(configurationRequiresRelease) !== "false") {
    return deploy("paired_release");
  }
  const mutation = receipt?.mutation;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.state !== "complete" ||
    !FINGERPRINT_PATTERN.test(mutation?.inputFingerprint ?? "")
  ) {
    return deploy("receipt_not_complete");
  }
  if (!FINGERPRINT_PATTERN.test(inputFingerprint ?? "") || inputFingerprint !== mutation.inputFingerprint) {
    return deploy("inputs_changed");
  }
  if (!FINGERPRINT_PATTERN.test(trustedFingerprint ?? "") || trustedFingerprint !== trustedReceiptFingerprint) {
    return deploy("trusted_source_changed");
  }
  if (
    !FINGERPRINT_PATTERN.test(configurationFingerprint ?? "") ||
    configurationFingerprint !== mutation.configurationFingerprint
  ) {
    return deploy("configuration_changed");
  }
  if (!identitiesMatch(liveIdentities, mutation.providerIdentities)) {
    return deploy("live_identity_mismatch");
  }
  return { mutated: false, reason: "unchanged" };
}

export function decideRelease({
  configurationRequiresRelease = false,
  variablesFingerprint = null,
  deploySha = null,
  functionGraph = null,
  forceFirebase = false,
  functionsReceipt = null,
  rendererReceipt = null,
  functionsFingerprint,
  configurationFingerprint = null,
  rendererFingerprint,
  rendererGraphAvailable = false,
  trustedFingerprint,
  trustedReceiptFingerprint,
  liveFunctionsIdentities = null,
  liveRendererIdentities = null,
  currentRun = {},
  rendererRunCompleted = false,
  functionsRunCompleted = false,
  targetHasAdminRevisionIntake = false,
  liveHasAdminRevisionIntake = false,
}) {
  const full = (reason, liveFunctionsSha = null) => ({
    abort: false,
    functionsMutated: true,
    previewPaused: true,
    liveFunctionsSha,
    rendererTargetSha: null,
    configurationRequiresRelease: true,
    releaseReason: reason,
    functionDeployTargets: "all",
  });
  const recoveringFunctions = functionsRunCompleted === true && functionsReceipt?.state === "in_progress";
  const functionsBase = recoveringFunctions ? { mutation: functionsReceipt.lastComplete } : baselineMutation(functionsReceipt, currentRun);
  if (functionsBase.blocked === "in_progress_receipt") {
    return {
      abort: true,
      functionsMutated: false,
      previewPaused: false,
      liveFunctionsSha: null,
      rendererTargetSha: null,
      configurationRequiresRelease: true,
      releaseReason: "in_progress_receipt",
    };
  }
  if (forceFirebase === true || forceFirebase === "true") {
    return full("force_firebase", functionsBase.mutation?.sourceSha);
  }
  const rendererBase = baselineMutation(rendererReceipt, currentRun);
  if (rendererBase.blocked === "in_progress_receipt") {
    if (rendererRunCompleted === true) {
      return full("stale_renderer_receipt", functionsBase.mutation?.sourceSha);
    }
    return {
      abort: true,
      functionsMutated: false,
      previewPaused: false,
      liveFunctionsSha: functionsBase.mutation?.sourceSha ?? null,
      rendererTargetSha: null,
      configurationRequiresRelease: true,
      releaseReason: "in_progress_receipt",
      blockedComponent: "renderer",
    };
  }
  if (recoveringFunctions) return full("stale_functions_receipt", functionsReceipt.lastComplete?.sourceSha);
  if (functionsBase.blocked) {
    return full(functionsBase.blocked === "missing_receipt" ? "missing_functions_receipt" : functionsBase.blocked);
  }
  if (rendererBase.blocked) {
    return full(
      rendererBase.blocked === "missing_receipt" ? "missing_renderer_receipt" : rendererBase.blocked,
      functionsBase.mutation.sourceSha,
    );
  }
  if (configurationRequiresRelease) return full("runtime_configuration_changed", functionsBase.mutation.sourceSha);
  if (variablesFingerprint !== null && (!FINGERPRINT_PATTERN.test(variablesFingerprint)
    || variablesFingerprint !== functionsBase.mutation.variablesFingerprint)) {
    return full("runtime_variables_changed", functionsBase.mutation.sourceSha);
  }
  if (trustedFingerprint !== trustedReceiptFingerprint) {
    return full("trusted_source_changed", functionsBase.mutation.sourceSha);
  }
  if (
    !FINGERPRINT_PATTERN.test(configurationFingerprint ?? "") ||
    configurationFingerprint !== functionsBase.mutation.configurationFingerprint
  ) {
    return full("functions_configuration_changed", functionsBase.mutation.sourceSha);
  }
  if (!identitiesMatch(liveFunctionsIdentities, functionsBase.mutation.providerIdentities)) {
    return full("live_functions_identity_mismatch", functionsBase.mutation.sourceSha);
  }
  if (!identitiesMatch(liveRendererIdentities, rendererBase.mutation.providerIdentities)) {
    return full("live_renderer_identity_mismatch", functionsBase.mutation.sourceSha);
  }
  if (!targetHasAdminRevisionIntake || !liveHasAdminRevisionIntake) {
    return full("admin_revision_floor", functionsBase.mutation.sourceSha);
  }
  if (
    (functionsBase.mutation.previewRendererSha ?? functionsBase.mutation.sourceSha) !== rendererBase.mutation.sourceSha ||
    liveRendererIdentities?.rendererSha !== rendererBase.mutation.sourceSha
  ) {
    return full("paired_release_mismatch", functionsBase.mutation.sourceSha);
  }
  const priorGraph = functionsBase.mutation.functionGraph;
  const validGraph = graph => graph?.version === FUNCTION_GRAPH_VERSION
    && FINGERPRINT_PATTERN.test(graph.globalFingerprint ?? "")
    && graph.exports && Object.keys(graph.exports).length > 0
    && Object.entries(graph.exports).every(([name, value]) => /^[A-Za-z][A-Za-z0-9]*$/.test(name)
      && FINGERPRINT_PATTERN.test(value?.fingerprint ?? "") && typeof value.preview === "boolean");
  if (!validGraph(functionGraph) || !validGraph(priorGraph)) {
    return full("function_graph_unavailable", functionsBase.mutation.sourceSha);
  }
  const names = Object.keys(functionGraph.exports).sort();
  if (functionGraph.globalFingerprint !== priorGraph.globalFingerprint
    || names.join(",") !== Object.keys(priorGraph.exports).sort().join(",")) {
    return full("functions_configuration_changed", functionsBase.mutation.sourceSha);
  }
  if (!rendererGraphAvailable) return full("renderer_graph_unavailable", functionsBase.mutation.sourceSha);
  const rendererChanged = rendererFingerprint !== rendererBase.mutation.inputFingerprint;
  const targets = names.filter(name => functionGraph.exports[name].fingerprint !== priorGraph.exports[name].fingerprint
    || (rendererChanged && functionGraph.exports[name].preview));
  // A changed aggregate with no accounted module change is an incomplete graph.
  if ((functionsFingerprint !== functionsBase.mutation.inputFingerprint && !targets.length)
    || (rendererChanged && !names.some(name => functionGraph.exports[name].preview))
    || ((targets.length || rendererChanged) && !SHA_PATTERN.test(deploySha ?? ""))) {
    return full("function_graph_unavailable", functionsBase.mutation.sourceSha);
  }
  return {
    abort: false,
    functionsMutated: targets.length > 0,
    previewPaused: rendererChanged,
    liveFunctionsSha: functionsBase.mutation.sourceSha,
    rendererTargetSha: rendererChanged ? deploySha : rendererBase.mutation.sourceSha,
    configurationRequiresRelease: false,
    releaseReason: rendererChanged ? "renderer_inputs_changed" : targets.length ? "functions_modules_changed" : "unchanged",
    functionDeployTargets: targets.map(name => `functions:${name}`).join(","),
    previewPauseLate: rendererChanged,
    functionsBeforePreview: rendererChanged ? targets.filter(name => !functionGraph.exports[name].preview).map(name => `functions:${name}`).join(",") : "",
    functionsDuringPreview: rendererChanged ? targets.filter(name => functionGraph.exports[name].preview).map(name => `functions:${name}`).join(",") : "",
  };
}

export async function fingerprintTrustedSource(sha, deps = {}) {
  return fingerprintPaths(sha, TRUSTED_RELEASE_PATHS, deps);
}

// Compare the code that runs, using each receipt's separate source pins.
export async function fingerprintExecutionSource(sourceSha, trustedWorkflowSha, deps = {}) {
  const [releaseChecks, trustedWorkflow] = await Promise.all([
    fingerprintPaths(sourceSha, RELEASE_CHECK_PATHS, deps),
    fingerprintTrustedSource(trustedWorkflowSha, deps),
  ]);
  return configurationFingerprint({ releaseChecks, trustedWorkflow });
}

// A retired freeze commit can be absent from fetched main history. An unknown
// baseline requires a full release; it must not prevent that release entirely.
export async function fingerprintReceiptExecutionSource(mutation, deps = {}) {
  try {
    return await fingerprintExecutionSource(mutation?.sourceSha, mutation?.trustedWorkflowSha, deps);
  } catch {
    return null;
  }
}

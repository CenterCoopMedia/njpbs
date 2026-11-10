import { CONFIGURATION_INPUTS, configurationInputs } from "../../scripts/lib/functions-configuration.mjs";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { FUNCTION_RUNTIME_VARIABLES, functionsForRuntimeComparison, runtimeParametersMatch, boundSecretVersionsCurrent, CMS_RELEASE_SECRET_NAMES, deploymentSecretsUnchanged, deploymentVariablesFingerprint, cloudWakeConfigurationFingerprint, decideRelease, explicitCloudWakeDecision, fingerprintExecutionSource, identitiesMatch, planCmsApiRelease, componentReceiptRunCompleted } from "../../scripts/lib/cms-release-plan.mjs";
import { releasePlanOutputLines, desiredRuntimeParameters } from "../../scripts/cms-release-plan.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const FINGERPRINT = "c".repeat(64);
const RENDERER_FP = "d".repeat(64);
const EDGE_FP = "6".repeat(64);
const TRUSTED_FP = "e".repeat(64);
const GRAPH = { version: 2, globalFingerprint: FINGERPRINT, exports: { health: { fingerprint: FINGERPRINT, preview: false }, cmsPreview: { fingerprint: FINGERPRINT, preview: true }, cmsPreviewStatus: { fingerprint: FINGERPRINT, preview: true } } };
const IDENTITIES = { region: "us-central1", inventoryFingerprint: "f".repeat(64) };
const RENDERER_IDS = {
  identityVersion: "2",
  applicationId: "11111111-1111-1111-1111-111111111111",
  identityFingerprint: "1".repeat(64),
  legacyIdentityFingerprint: "2".repeat(64),
  workerScript: "njpbs-cms-preview-renderer",
  workerDeploymentId: "33333333-3333-3333-3333-333333333333",
  workerScheduleFingerprint: "4".repeat(64),
  rendererSha: SHA,
  serializerId: "cloudflare-preview",
};

function completeReceipt(component, extras = {}) {
  return {
    schemaVersion: 1,
    component,
    state: "complete",
    mutation: {
      functionGraph: GRAPH,
      sourceSha: SHA,
      trustedWorkflowSha: SHA,
      runId: "1",
      runAttempt: 1,
      configurationFingerprint: EDGE_FP,
      inputFingerprint: component === "functions" ? FINGERPRINT : RENDERER_FP,
      providerIdentities: component === "functions" ? IDENTITIES : RENDERER_IDS,
      ...extras.mutation,
    },
    lastComplete: null,
  };
}

function eligible() {
  return {
    deploySha: OTHER, functionGraph: structuredClone(GRAPH), rendererGraphAvailable: true,
    functionsReceipt: completeReceipt("functions"), rendererReceipt: completeReceipt("renderer"),
    functionsFingerprint: FINGERPRINT, configurationFingerprint: EDGE_FP,
    rendererFingerprint: RENDERER_FP, trustedFingerprint: TRUSTED_FP, trustedReceiptFingerprint: TRUSTED_FP,
    liveFunctionsIdentities: IDENTITIES, liveRendererIdentities: RENDERER_IDS,
    targetHasAdminRevisionIntake: true, liveHasAdminRevisionIntake: true,
  };
}

describe("selective Functions releases", () => {
  it.each([false, true])("emits the candidate renderer SHA on a full/forced plan (force=%s)", forceFirebase => {
    const plan = decideRelease({ forceFirebase });
    expect(plan.functionsMutated).toBe(true);
    const lines = releasePlanOutputLines(plan, { deploySha: OTHER, edgeFingerprint: EDGE_FP,
      configurationFingerprint: EDGE_FP, variablesFingerprint: FINGERPRINT });
    expect(lines).toContain(`renderer_target_sha=${OTHER}`);
    expect(lines).toContain("preview_paused=true");
  });
  it("fingerprints exactly the variables consumed by the Functions dotenv writer", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
    const writer = workflow.jobs.firebase.steps.find(step => step.name === "Configure functions runtime params");
    expect(writer.env.CMS_DEPLOYMENT_VARIABLES_JSON).toBe("${{ toJSON(vars) }}");
    const baseline = deploymentVariablesFingerprint("{}");
    for (const [key, row] of Object.entries(CONFIGURATION_INPUTS)) {
      if (!row.variable) continue;
      const variables = JSON.stringify({ [row.variable]: "synthetic-change" });
      expect(configurationInputs({ CMS_DEPLOYMENT_VARIABLES_JSON: variables })[key]).toBe("synthetic-change");
      expect(deploymentVariablesFingerprint(variables), row.variable).not.toBe(baseline);
    }
    expect(deploymentVariablesFingerprint('{"UNRELATED_VARIABLE":"synthetic-change"}')).toBe(baseline);
    const input = eligible();
    input.functionsReceipt.mutation.variablesFingerprint = FINGERPRINT;
    expect(decideRelease({ ...input, variablesFingerprint: FINGERPRINT }).functionsMutated).toBe(false);
    expect(decideRelease({ ...input, variablesFingerprint: "9".repeat(64) }).releaseReason).toBe("runtime_variables_changed");
  });

  it("compares secret-derived parameters and effective resolver outputs against every serving function", async () => {
    const env = { CMS_DEPLOYMENT_VARIABLES_JSON: '{"COST_LEDGER_GCP_PULL":"true"}',
      VITE_LIVE_PRODUCTION_ENABLED: "true",
      VITE_CMS_STUDIO_CONFIGURATION: JSON.stringify({ schemaVersion: 1, vmixHost: "127.0.0.1", vmixPort: 12345,
        apiAccessMode: "loopback-without-login", backgroundInput: 500,
        inputs: { headline: 501, name_title: 502 }, overlayInputs: { headline: 503, name_title: 504 },
        titleFiles: { headline: "Synthetic headline.gtzip", name_title: "Synthetic name.gtzip" } }),
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "123", CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{ "456": "test-admin" }',
      GITHUB_TOKEN: "synthetic-must-not-inherit", CMS_STAFF_EMAIL_API_TOKEN: "synthetic-must-not-inherit",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/adc.json" };
    const expected = await desiredRuntimeParameters(env, async (_program, [script], options) => {
      expect(options.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).toBe(env.GOOGLE_APPLICATION_CREDENTIALS);
      expect(options.env.COST_LEDGER_GCP_PULL).toBe("true");
      expect(options.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(options.env).not.toHaveProperty("CMS_STAFF_EMAIL_API_TOKEN");
      expect(options.env).not.toHaveProperty("VITE_CMS_STUDIO_CONFIGURATION");
      return { stdout: script.includes("media-purge") ? "CMS_MEDIA_PURGE_SWEEP_ENABLED=false\n" : "COST_LEDGER_GCP_PULL=false\n" };
    });
    expect(expected.CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP).toBe('{"456":"test-admin"}');
    expect(JSON.parse(expected.CMS_STUDIO_TITLE_FILES)).toEqual({ headline: "Synthetic headline.gtzip", name_title: "Synthetic name.gtzip" });
    const live = () => [{ serviceConfig: { environmentVariables: { ...expected } } }];
    expect(runtimeParametersMatch(live(), expected)).toBe(true);
    for (const key of ["CMS_STUDIO_TITLE_FILES", "CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP", "CMS_BUG_REPORT_TELEGRAM_CHAT_ID", "CMS_STAFF_EMAIL_ACCOUNT_ID", "CMS_MEDIA_R2_ENDPOINT", "CMS_MEDIA_PURGE_SWEEP_ENABLED", "COST_LEDGER_GCP_PULL"]) {
      const functions = [...live(), ...live()];
      functions[1].serviceConfig.environmentVariables[key] = "changed";
      expect(runtimeParametersMatch(functions, expected)).toBe(false);
    }
    expect(runtimeParametersMatch([], expected)).toBe(false);
    expect(runtimeParametersMatch(live(), null)).toBeFalsy();
    expect(await desiredRuntimeParameters(env, async () => { throw new Error("synthetic private child error"); })).toBeNull();
    for (const preset of [undefined, "", "{}", "not-json"]) {
      let calls = 0;
      await expect(desiredRuntimeParameters({ ...env, VITE_CMS_STUDIO_CONFIGURATION: preset }, async () => {
        calls++; throw new Error("Unexpected resolver call");
      })).rejects.toThrow("Studio preset configuration is unavailable");
      expect(calls).toBe(0);
      const optional = await desiredRuntimeParameters({ ...env, VITE_LIVE_PRODUCTION_ENABLED: "false",
        VITE_CMS_STUDIO_CONFIGURATION: preset }, async () => ({ stdout: "COST_LEDGER_GCP_PULL=false\n" }));
      expect(optional.CMS_STUDIO_TITLE_FILES).toBe("");
      expect(runtimeParametersMatch([{ serviceConfig: { environmentVariables: { ...optional } } }], optional)).toBe(true);
    }
    const optionalConfigured = await desiredRuntimeParameters({ ...env, VITE_LIVE_PRODUCTION_ENABLED: "false" },
      async () => ({ stdout: "COST_LEDGER_GCP_PULL=false\n" }));
    expect(optionalConfigured.CMS_STUDIO_TITLE_FILES).toBe(expected.CMS_STUDIO_TITLE_FILES);
    await expect(desiredRuntimeParameters({ ...env, VITE_LIVE_PRODUCTION_ENABLED: "invalid" }))
      .rejects.toThrow("Studio feature configuration is unavailable");
  });
  it("forces the full path for changed variables or desired/bound secret versions", async () => {
    const a = deploymentVariablesFingerprint('{"CMS_MEDIA_PURGE_SWEEP_ENABLED":"true","TVSS_CALLSIGN":"value"}');
    expect(deploymentVariablesFingerprint('{"TVSS_CALLSIGN":"value","CMS_MEDIA_PURGE_SWEEP_ENABLED":"true"}')).toBe(a);
    expect(deploymentVariablesFingerprint('{"CMS_MEDIA_PURGE_SWEEP_ENABLED":"true","TVSS_CALLSIGN":"value","NJPBS_CI_OVERFLOW_FLEET_ENABLED":"false"}')).toBe(a);
    expect(deploymentVariablesFingerprint('{"CMS_MEDIA_PURGE_SWEEP_ENABLED":"false","TVSS_CALLSIGN":"value"}')).not.toBe(a);
    expect(deploymentVariablesFingerprint('{"LIVE_PRODUCTION_ENABLED":"true"}'))
      .not.toBe(deploymentVariablesFingerprint('{"LIVE_PRODUCTION_ENABLED":"false"}'));
    expect(cloudWakeConfigurationFingerprint(EDGE_FP, { environment: "production", enabled: true }, a))
      .not.toBe(cloudWakeConfigurationFingerprint(EDGE_FP, { environment: "production", enabled: true }));
    const env = Object.fromEntries(CMS_RELEASE_SECRET_NAMES.map(name => [name, "synthetic-value"]));
    expect(await deploymentSecretsUnchanged(env, async () => true)).toBe(true);
    expect(await deploymentSecretsUnchanged(env, async () => { throw Error("synthetic private failure"); })).toBe(false);
    expect(await deploymentSecretsUnchanged(env, async name => name !== "CMS_STAFF_EMAIL_API_TOKEN")).toBe(false);
    expect(await deploymentSecretsUnchanged({ ...env, CMS_PUBLISH_GITHUB_TOKEN_PROVISIONING: "synthetic" }, async () => true)).toBe(false);
    const fn = version => ({ serviceConfig: { secretEnvironmentVariables: [{ projectId: "njpbs-site", secret: "PBS_TVSS_AUTH", version }] } });
    const latest = async () => ({ name: "projects/123/secrets/PBS_TVSS_AUTH/versions/3", state: "ENABLED" });
    expect(await boundSecretVersionsCurrent([fn("3"), fn("3")], latest)).toBe(true);
    expect(await boundSecretVersionsCurrent([fn("2"), fn("3")], latest)).toBe(false);
    expect(await boundSecretVersionsCurrent([fn("latest")], latest)).toBe(false);
    expect(await boundSecretVersionsCurrent([fn("3")], async () => { throw Error("metadata unavailable"); })).toBe(false);
    expect(await boundSecretVersionsCurrent([fn("3")], latest, new Map([["PBS_TVSS_AUTH", "2"]]))).toBe(false);
    expect(decideRelease({ ...eligible(), configurationRequiresRelease: true }))
      .toMatchObject({ functionDeployTargets: "all", previewPaused: true, releaseReason: "runtime_configuration_changed" });
  });
  it.each(["unchanged", "parameter", "secret value", "secret version", "binding"])("plans %s configuration against the exact managed exports", async change => {
    const expected = { CMS_STAFF_EMAIL_ACCOUNT_ID: "synthetic-account" };
    const fn = name => ({
      name: `projects/njpbs-site/locations/us-central1/functions/${name}`,
      buildConfig: { entryPoint: name },
      serviceConfig: { environmentVariables: { ...expected }, secretEnvironmentVariables: [
        { projectId: "njpbs-site", secret: "CMS_STAFF_EMAIL_API_TOKEN", version: "3" },
      ] },
    });
    const managed = Object.keys(GRAPH.exports).map(fn);
    // A complete CMS release intentionally leaves these legacy exports alone.
    const retained = [fn("cmsGetPublishedSettings"), fn("billingKillSwitch")];
    retained.forEach(fn => { fn.serviceConfig.environmentVariables = {}; });
    retained[0].serviceConfig.secretEnvironmentVariables[0].version = "1";
    const inventory = [...managed, ...retained];
    const before = structuredClone(inventory);
    const selected = functionsForRuntimeComparison(inventory, GRAPH);
    expect(selected).toEqual(managed);
    expect(inventory).toEqual(before);
    if (change === "parameter") managed[1].serviceConfig.environmentVariables.CMS_STAFF_EMAIL_ACCOUNT_ID = "changed";
    if (change === "binding") managed[1].serviceConfig.secretEnvironmentVariables[0].version = "2";
    const env = Object.fromEntries(CMS_RELEASE_SECRET_NAMES.map(name => [name, "synthetic-value"]));
    const secretsUnchanged = await deploymentSecretsUnchanged(env, async () => change !== "secret value");
    const parametersMatch = runtimeParametersMatch(selected, expected);
    const bindingsCurrent = await boundSecretVersionsCurrent(selected, async () => ({
      name: `projects/123/secrets/CMS_STAFF_EMAIL_API_TOKEN/versions/${change === "secret version" ? "4" : "3"}`,
      state: "ENABLED",
    }), new Map([["CMS_STAFF_EMAIL_API_TOKEN", "3"]]));
    expect({ secretsUnchanged, parametersMatch, bindingsCurrent }).toEqual({
      secretsUnchanged: change !== "secret value", parametersMatch: change !== "parameter",
      bindingsCurrent: change !== "secret version" && change !== "binding",
    });
    expect(decideRelease({ ...eligible(), configurationRequiresRelease: !secretsUnchanged || !parametersMatch || !bindingsCurrent }))
      .toMatchObject(change === "unchanged"
        ? { functionsMutated: false, previewPaused: false, functionDeployTargets: "", releaseReason: "unchanged" }
        : { functionsMutated: true, functionDeployTargets: "all", releaseReason: "runtime_configuration_changed" });
  });
  it("refuses missing, ambiguous or differently owned runtime comparison exports", () => {
    const fn = { name: "projects/njpbs-site/locations/us-central1/functions/health", buildConfig: { entryPoint: "health" } };
    const graph = { exports: { health: GRAPH.exports.health } };
    expect(functionsForRuntimeComparison([fn], graph)).toEqual([fn]);
    for (const inventory of [null, [], [fn, fn], [{ ...fn, labels: { "firebase-functions-codebase": "other" } }],
      [{ ...fn, buildConfig: { entryPoint: "other" } }], [{ ...fn, name: fn.name.replace("us-central1", "us-east1") }]]) {
      const selected = functionsForRuntimeComparison(inventory, graph);
      expect(selected).toBeNull();
      expect(runtimeParametersMatch(selected, { KEY: "value" })).toBe(false);
    }
    expect(functionsForRuntimeComparison([fn], null)).toBeNull();
    expect(functionsForRuntimeComparison([fn], { exports: {} })).toBeNull();
  });
  it.each([true, false])("automatic configuration drift cannot override an unverified renderer writer (%s)", missingFunctions => {
    const input = eligible();
    if (missingFunctions) input.functionsReceipt = null;
    input.rendererReceipt = { ...input.rendererReceipt, state: "in_progress" };
    expect(decideRelease({ ...input, configurationRequiresRelease: true }))
      .toMatchObject({ abort: true, blockedComponent: "renderer", releaseReason: "in_progress_receipt" });
  });
  it("deploys only graph readers of the exact preview pin on a renderer-only change", () => {
    const input = eligible();
    input.rendererFingerprint = "9".repeat(64);
    expect(decideRelease(input)).toMatchObject({
      functionsMutated: true, previewPaused: true, rendererTargetSha: OTHER,
      configurationRequiresRelease: false,
      functionDeployTargets: "functions:cmsPreview,functions:cmsPreviewStatus",
    });
  });
  it("deploys only changed export closures and preserves the separate preview identity", () => {
    const input = eligible();
    input.functionGraph.exports.health.fingerprint = "9".repeat(64);
    input.functionsFingerprint = "9".repeat(64);
    const first = decideRelease(input);
    expect(first).toMatchObject({ functionsMutated: true, previewPaused: false, rendererTargetSha: SHA, functionDeployTargets: "functions:health" });
    input.functionsReceipt.mutation = { ...input.functionsReceipt.mutation, sourceSha: OTHER, previewRendererSha: SHA,
      functionGraph: input.functionGraph, inputFingerprint: input.functionsFingerprint };
    expect(decideRelease(input)).toMatchObject({ functionsMutated: false, previewPaused: false, rendererTargetSha: SHA, liveFunctionsSha: OTHER });
  });
  it("takes the union of changed closures and preview-control readers", () => {
    const input = eligible();
    input.functionGraph.exports.health.fingerprint = "9".repeat(64);
    input.rendererFingerprint = "9".repeat(64);
    expect(decideRelease(input).functionDeployTargets).toBe("functions:cmsPreview,functions:cmsPreviewStatus,functions:health");
  });
  it.each([null, {}, { ...GRAPH, version: 1 }, { ...GRAPH, exports: {} }])("fails closed on incomplete target graph %j", graph => {
    expect(decideRelease({ ...eligible(), functionGraph: graph })).toMatchObject({ functionsMutated: true, previewPaused: true, functionDeployTargets: "all" });
  });
  it("keeps unknown renderer graphs on the original full path", () => {
    expect(decideRelease({ ...eligible(), rendererGraphAvailable: false })).toMatchObject({
      functionsMutated: true, previewPaused: true, functionDeployTargets: "all", releaseReason: "renderer_graph_unavailable",
    });
  });
  it("deploys ordinary changed closures before pausing the exact preview readers", () => {
    const input = eligible();
    input.rendererFingerprint = "9".repeat(64);
    input.functionGraph.exports.health.fingerprint = "9".repeat(64);
    const plan = decideRelease(input);
    expect(plan).toMatchObject({ previewPauseLate: true, functionsBeforePreview: "functions:health",
      functionsDuringPreview: "functions:cmsPreview,functions:cmsPreviewStatus", rendererTargetSha: OTHER });
    const lines = releasePlanOutputLines(plan, { deploySha: OTHER, rendererFingerprint: input.rendererFingerprint });
    expect(lines).toContain("preview_pause_late=true");
    expect(lines).toContain("functions_before_preview=functions:health");
    expect(lines).toContain(`renderer_input_fingerprint=${input.rendererFingerprint}`);
  });
  it("requires the full release for old receipts, config changes, or unaccounted Functions changes", () => {
    const old = eligible();
    delete old.functionsReceipt.mutation.functionGraph;
    expect(decideRelease(old).releaseReason).toBe("function_graph_unavailable");
    const config = eligible();
    config.functionGraph.globalFingerprint = "9".repeat(64);
    expect(decideRelease(config).releaseReason).toBe("functions_configuration_changed");
    expect(decideRelease({ ...eligible(), functionsFingerprint: "9".repeat(64) }).releaseReason).toBe("function_graph_unavailable");
  });
  it.each(["force", "identities", "trusted", "configuration"])("preserves the full recovery path for %s", reason => {
    const input = eligible();
    if (reason === "force") input.forceFirebase = true;
    if (reason === "identities") input.liveFunctionsIdentities = null;
    if (reason === "trusted") input.trustedReceiptFingerprint = null;
    if (reason === "configuration") input.configurationFingerprint = null;
    expect(decideRelease(input)).toMatchObject({ functionsMutated: true, previewPaused: true, configurationRequiresRelease: true, functionDeployTargets: "all" });
  });
});

describe("stopped component receipt recovery", () => {
  const receipt = {
    ...completeReceipt("renderer"), state: "in_progress",
    mutation: { runId: "1001", runAttempt: 1 },
  };
  // Synthetic failed-run identity in GitHub's documented response shape.
  const completedRun = {
    id: 1001, run_attempt: 1, status: "completed", conclusion: "failure",
    repository: { full_name: "CenterCoopMedia/njpbs" },
    path: ".github/workflows/cms-staging-deploy.yml@main", event: "workflow_dispatch",
  };
  const options = {
    token: "synthetic-job-token", repository: "CenterCoopMedia/njpbs", currentRunId: "1002",
  };
  const response = run => async () => new Response(JSON.stringify(run));

  it.each([
    ".github/workflows/cms-staging-deploy.yml",
    ".github/workflows/cms-staging-deploy.yml@main",
    ".github/workflows/cms-staging-deploy.yml@refs/heads/main",
  ])("accepts the CMS workflow path from GitHub: %s", async path => {
    // Accept both a bare workflow path and the documented @ref form.
    for (const component of ["functions", "renderer"]) {
      expect(await componentReceiptRunCompleted({ ...receipt, component }, {
        ...options, fetchImpl: response({ ...completedRun, path }),
      })).toBe(true);
    }
  });

  it("uses the job token only on the fixed GitHub run endpoint", async () => {
    let request;
    await componentReceiptRunCompleted(receipt, {
      ...options, fetchImpl: async (url, init) => {
        request = { url, ...init };
        return new Response(JSON.stringify(completedRun));
      },
    });
    expect(request).toMatchObject({
      url: "https://api.github.com/repos/CenterCoopMedia/njpbs/actions/runs/1001",
      headers: { Authorization: "Bearer synthetic-job-token", Accept: "application/vnd.github+json" },
      redirect: "error",
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["success", "failure", "cancelled", "timed_out"])("releases both sides after a %s renderer run", async conclusion => {
    const rendererRunCompleted = await componentReceiptRunCompleted(receipt, {
      ...options, fetchImpl: response({ ...completedRun, conclusion }),
    });
    expect(rendererRunCompleted).toBe(true);
    expect(decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"), rendererReceipt: receipt, rendererRunCompleted,
    })).toMatchObject({
      abort: false, functionsMutated: true, previewPaused: true, configurationRequiresRelease: true,
      rendererTargetSha: null, liveFunctionsSha: SHA, releaseReason: "stale_renderer_receipt",
    });
  });

  it.each([
    { status: "in_progress" }, { status: "queued" }, { status: "waiting" },
    { status: "requested" }, { status: "pending" }, { status: "unknown" },
    { id: 1 }, { run_attempt: 0 }, { run_attempt: undefined },
    { repository: { full_name: "other/repo" } }, { path: ".github/workflows/ci.yml@main" }, { path: null }, { event: "pull_request" },
  ])("keeps the renderer receipt blocked without completed-run proof: %j", async changes => {
    const rendererRunCompleted = await componentReceiptRunCompleted(receipt, {
      ...options, fetchImpl: response({ ...completedRun, ...changes }),
    });
    expect(rendererRunCompleted).toBe(false);
    expect(decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"), rendererReceipt: receipt, rendererRunCompleted,
    })).toMatchObject({ abort: true, releaseReason: "in_progress_receipt", blockedComponent: "renderer" });
  });

  it("checks the latest run attempt rather than trusting a completed older attempt", async () => {
    const newerReceipt = { ...receipt, mutation: { ...receipt.mutation, runAttempt: 2 } };
    expect(await componentReceiptRunCompleted(newerReceipt, { ...options, fetchImpl: response(completedRun) })).toBe(false);
    expect(await componentReceiptRunCompleted(receipt, {
      ...options, fetchImpl: response({ ...completedRun, run_attempt: 2, status: "in_progress" }),
    })).toBe(false);
    expect(await componentReceiptRunCompleted(receipt, {
      ...options, fetchImpl: response({ ...completedRun, run_attempt: 2 }),
    })).toBe(true);
    expect(await componentReceiptRunCompleted({ ...receipt, component: "functions" }, {
      ...options, currentRunId: "1001", currentRunAttempt: "2", fetchImpl: async () => { throw new Error("must not request current run"); },
    })).toBe(true);
  });

  it.each([
    async () => new Response("private provider body", { status: 403 }),
    async () => new Response("not JSON"),
    async () => { throw new Error("synthetic-job-token private request"); },
  ])("fails closed on API errors without exposing their details", async fetchImpl => {
    expect(await componentReceiptRunCompleted(receipt, { ...options, fetchImpl })).toBe(false);
  });

  it.each([
    { token: "" }, { repository: "other/repo" }, { currentRunId: "1001" },
  ])("does not request an untrusted or current run: %j", async changes => {
    let requested = false;
    expect(await componentReceiptRunCompleted(receipt, {
      ...options, ...changes, fetchImpl: async () => { requested = true; throw new Error("must not request"); },
    })).toBe(false);
    expect(requested).toBe(false);
  });

  it.each([
    null, { ...receipt, schemaVersion: 2 }, { ...receipt, component: "cmsApi" },
    { ...receipt, state: "complete" }, { ...receipt, mutation: {} },
    { ...receipt, mutation: { runId: "../1", runAttempt: 1 } },
    { ...receipt, mutation: { runId: "1001", runAttempt: 0 } },
  ])("does not request a malformed or unrelated receipt: %j", async invalidReceipt => {
    let requested = false;
    expect(await componentReceiptRunCompleted(invalidReceipt, {
      ...options, fetchImpl: async () => { requested = true; throw new Error("must not request"); },
    })).toBe(false);
    expect(requested).toBe(false);
  });

  it.each([true, false])("recovers stopped Functions attempts with or without a plan, including force_firebase=%s", forceFirebase => {
    for (const pending of [false, true]) for (const stopped of [false, true]) {
      const functionsReceipt = { ...completeReceipt("functions"), state: "in_progress", lastComplete: completeReceipt("functions").mutation };
      if (pending) functionsReceipt.mutation.retirementPlan = { sourceSha: SHA };
      const plan = decideRelease({
        functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
        functionsReceipt, functionsRunCompleted: stopped, rendererReceipt: completeReceipt("renderer"), forceFirebase,
      });
      if (stopped) expect(plan).toMatchObject({ abort: false, functionsMutated: true, previewPaused: true });
      else expect(plan).toMatchObject({ abort: true, functionsMutated: false, releaseReason: "in_progress_receipt" });
      if (stopped && !forceFirebase) {
        expect(decideRelease({ functionGraph: GRAPH, deploySha: OTHER, functionsReceipt, functionsRunCompleted: true, rendererReceipt: receipt }))
          .toMatchObject({ abort: true, blockedComponent: "renderer" });
      }
    }
  });
});

describe("CMS release plan", () => {
  it("releases when only the selected secret provisioning helper changes", async () => {
    const listTree = async (sha, paths) => paths.includes("scripts/lib/functions-secret-versions.mjs")
      ? `100644 blob ${sha} scripts/lib/functions-secret-versions.mjs\n`
      : "";
    const trustedFingerprint = await fingerprintExecutionSource(OTHER, SHA, { listTree });
    const trustedReceiptFingerprint = await fingerprintExecutionSource(SHA, SHA, { listTree });
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint,
      trustedReceiptFingerprint,
    });
    expect(plan).toMatchObject({
      functionsMutated: true,
      releaseReason: "trusted_source_changed",
    });
  });

  it("skips Functions and renderer when receipts, fingerprints, and live identities match", () => {
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      currentRun: { runId: "9", runAttempt: 1 },
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan).toMatchObject({
      abort: false,
      functionsMutated: false,
      previewPaused: false,
      liveFunctionsSha: SHA,
      rendererTargetSha: SHA,
      configurationRequiresRelease: false,
      releaseReason: "unchanged",
    });
  });

  it.each(["9".repeat(64), null, undefined, "invalid"])("releases both sides when the recorded edge digest is %s", (recorded) => {
    // #2672: Source and bound Secret Manager version identities stay unchanged
    // when only the GitHub edge secret changes.
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions", { mutation: { configurationFingerprint: recorded } }),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan).toMatchObject({
      abort: false,
      functionsMutated: true,
      configurationRequiresRelease: true,
      releaseReason: "functions_configuration_changed",
    });
  });

  it("cannot skip a deploy when the wake decision changes", () => {
    const enabled = cloudWakeConfigurationFingerprint(EDGE_FP, { environment: "production", enabled: true });
    const disabled = cloudWakeConfigurationFingerprint(EDGE_FP, { environment: "production", enabled: false });
    expect(enabled).toMatch(/^[a-f0-9]{64}$/);
    expect(disabled).not.toBe(enabled);
    expect(cloudWakeConfigurationFingerprint(EDGE_FP, { environment: "production", enabled: true })).toBe(enabled);
    expect(explicitCloudWakeDecision({
      CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "production",
      CLOUD_PUBLICATION_WAKE_ENABLED: "true",
    })).toEqual({ environment: "production", enabled: true });
    expect(() => explicitCloudWakeDecision({ CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "production" })).toThrow(/explicit cloud wake/i);
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions", { mutation: { configurationFingerprint: enabled } }),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: disabled,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan).toMatchObject({ functionsMutated: true, releaseReason: "functions_configuration_changed" });
  });

  it("selects the paired release when Functions and renderer receipts disagree", () => {
    const renderer = completeReceipt("renderer");
    renderer.mutation.sourceSha = OTHER;
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: renderer,
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan.functionsMutated).toBe(true);
    expect(plan.releaseReason).toBe("paired_release_mismatch");
  });

  it("selects the paired release when renderer inputs change", () => {
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: "9".repeat(64),
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
    });
    expect(plan.functionsMutated).toBe(true);
    expect(plan.previewPaused).toBe(true);
    expect(plan.releaseReason).toBe("renderer_inputs_changed");
  });

  it("aborts a forced release while another attempt is in progress", () => {
    const functionsReceipt = completeReceipt("functions");
    functionsReceipt.state = "in_progress";
    functionsReceipt.lastComplete = functionsReceipt.mutation;
    functionsReceipt.mutation = { ...functionsReceipt.mutation, runId: "8", runAttempt: 1 };
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      forceFirebase: true,
      functionsReceipt,
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      currentRun: { runId: "9", runAttempt: 1 },
    });
    expect(plan.abort).toBe(true);
    expect(plan.releaseReason).toBe("in_progress_receipt");
  });

  it("forces the paired release", () => {
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      forceFirebase: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
    });
    expect(plan.releaseReason).toBe("force_firebase");
    expect(plan.functionsMutated).toBe(true);
  });

  it("uses lastComplete when this attempt already marked in progress", () => {
    const functionsReceipt = completeReceipt("functions");
    functionsReceipt.state = "in_progress";
    functionsReceipt.lastComplete = functionsReceipt.mutation;
    functionsReceipt.mutation = { ...functionsReceipt.mutation, runId: "9", runAttempt: 2, sourceSha: OTHER };
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt,
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      currentRun: { runId: "9", runAttempt: 2 },
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan.releaseReason).toBe("unchanged");
    expect(plan.liveFunctionsSha).toBe(SHA);
  });

  it("aborts when another attempt still holds an in-progress receipt", () => {
    const functionsReceipt = completeReceipt("functions");
    functionsReceipt.state = "in_progress";
    functionsReceipt.lastComplete = functionsReceipt.mutation;
    functionsReceipt.mutation = { ...functionsReceipt.mutation, runId: "8", runAttempt: 1 };
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt,
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      currentRun: { runId: "9", runAttempt: 1 },
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: true,
    });
    expect(plan.abort).toBe(true);
    expect(plan.functionsMutated).toBe(false);
    expect(plan.releaseReason).toBe("in_progress_receipt");
  });

  it("refuses a no-op when live Functions predate live Admin revision intake", () => {
    const plan = decideRelease({
      functionGraph: GRAPH, deploySha: OTHER, rendererGraphAvailable: true,
      functionsReceipt: completeReceipt("functions"),
      rendererReceipt: completeReceipt("renderer"),
      functionsFingerprint: FINGERPRINT,
      configurationFingerprint: EDGE_FP,
      rendererFingerprint: RENDERER_FP,
      trustedFingerprint: TRUSTED_FP,
      trustedReceiptFingerprint: TRUSTED_FP,
      liveFunctionsIdentities: IDENTITIES,
      liveRendererIdentities: RENDERER_IDS,
      targetHasAdminRevisionIntake: true,
      liveHasAdminRevisionIntake: false,
    });
    expect(plan.functionsMutated).toBe(true);
    expect(plan.releaseReason).toBe("admin_revision_floor");
  });

  it("does not treat identity objects as equal when a serving revision changes", () => {
    expect(identitiesMatch(IDENTITIES, { ...IDENTITIES, inventoryFingerprint: "0".repeat(64) })).toBe(false);
  });

  it("matches renderer identities when only phase differs", () => {
    const base = {
      ...RENDERER_IDS,
      phase: "ready",
    };
    expect(identitiesMatch(base, { ...base, phase: "paused" })).toBe(true);
    expect(identitiesMatch(base, { ...base, serializerId: "other" })).toBe(false);
    expect(identitiesMatch(base, { ...base, applicationId: "22222222-2222-2222-2222-222222222222" })).toBe(false);
    expect(identitiesMatch(base, { ...base, rendererSha: "" })).toBe(false);
    expect(identitiesMatch(base, { ...base, workerDeploymentId: "other" })).toBe(false);
    expect(identitiesMatch(base, { ...base, workerScheduleFingerprint: "other" })).toBe(false);
    expect(identitiesMatch({ ...base, identityFingerprint: undefined }, { ...base, identityFingerprint: undefined })).toBe(false);
  });

  it("matches a legacy renderer receipt through its original fingerprint", () => {
    const legacy = {
      applicationId: RENDERER_IDS.applicationId,
      identityFingerprint: RENDERER_IDS.legacyIdentityFingerprint,
      rendererSha: SHA,
      serializerId: RENDERER_IDS.serializerId,
      phase: "ready",
    };
    expect(identitiesMatch(RENDERER_IDS, legacy)).toBe(true);
    expect(identitiesMatch(RENDERER_IDS, { ...legacy, identityFingerprint: "9".repeat(64) })).toBe(false);
  });
});

describe("CMS API Worker release plan", () => {
  const CMS_API_FP = "5".repeat(64);
  const CONFIG_FP = "7".repeat(64);
  const CMS_API_IDS = { script: "njpbs-cms-api", deploymentId: "66666666-6666-6666-6666-666666666666" };
  const workerReceipt = (extras = {}) => ({
    schemaVersion: 1,
    component: "cmsApi",
    state: "complete",
    mutation: {
      functionGraph: GRAPH,
      sourceSha: SHA,
      trustedWorkflowSha: SHA,
      runId: "1",
      runAttempt: 1,
      inputFingerprint: CMS_API_FP,
      providerIdentities: CMS_API_IDS,
      configurationFingerprint: CONFIG_FP,
    },
    lastComplete: null,
    ...extras,
  });
  const matching = {
    edgeOriginSecretFingerprint: EDGE_FP,
    expectedEdgeOriginSecretFingerprint: EDGE_FP,
    functionsMutated: "false",
    configurationRequiresRelease: "false",
    receipt: workerReceipt(),
    inputFingerprint: CMS_API_FP,
    trustedFingerprint: TRUSTED_FP,
    trustedReceiptFingerprint: TRUSTED_FP,
    configurationFingerprint: CONFIG_FP,
    liveIdentities: CMS_API_IDS,
  };

  it("skips the Worker only when receipt, inputs, trusted source, secrets, and live deployment match", () => {
    expect(planCmsApiRelease(matching)).toEqual({ mutated: false, reason: "unchanged" });
  });

  it.each([true, false, "true", "false", "", undefined])("keeps a verified Worker unchanged across unrelated Functions selection (%j)", functionsMutated => {
    expect(planCmsApiRelease({ ...matching, functionsMutated })).toEqual({ mutated: false, reason: "unchanged" });
  });

  it("deploys the Worker when NEW changes its operator under the same trusted workflow", async () => {
    const listTree = async (sha, paths) => paths.includes("scripts/lib/functions-secret-versions.mjs")
      ? `100644 blob ${sha} scripts/lib/functions-secret-versions.mjs\n` : "";
    expect(planCmsApiRelease({
      ...matching,
      trustedFingerprint: await fingerprintExecutionSource(OTHER, OTHER, { listTree }),
      trustedReceiptFingerprint: await fingerprintExecutionSource(SHA, OTHER, { listTree }),
    })).toEqual({ mutated: true, reason: "trusted_source_changed" });
  });

  it.each(["true", "false"])("aborts a Worker secret change after preflight even with functionsMutated=%s", (functionsMutated) => {
    for (const digest of ["9".repeat(64), null, undefined, "invalid"]) {
      expect(planCmsApiRelease({
        ...matching,
        functionsMutated,
        edgeOriginSecretFingerprint: digest,
      })).toEqual({ abort: true, mutated: false, reason: "edge_origin_secret_mismatch" });
      expect(planCmsApiRelease({
        ...matching,
        functionsMutated,
        expectedEdgeOriginSecretFingerprint: digest,
      })).toEqual({ abort: true, mutated: false, reason: "edge_origin_secret_mismatch" });
    }
  });

  it.each([
    ["a configuration release", { configurationRequiresRelease: "true" }, "paired_release"],
    ["a missing configuration plan output", { configurationRequiresRelease: undefined }, "paired_release"],
    ["no receipt", { receipt: null }, "receipt_not_complete"],
    ["an in-progress receipt", { receipt: workerReceipt({ state: "in_progress" }) }, "receipt_not_complete"],
    ["an unsupported receipt version", { receipt: workerReceipt({ schemaVersion: 2 }) }, "receipt_not_complete"],
    ["changed Worker inputs", { inputFingerprint: "8".repeat(64) }, "inputs_changed"],
    ["an unreadable input fingerprint", { inputFingerprint: null }, "inputs_changed"],
    ["a changed trusted deploy source", { trustedReceiptFingerprint: "9".repeat(64) }, "trusted_source_changed"],
    ["an unreadable trusted source", { trustedFingerprint: null }, "trusted_source_changed"],
    ["an unreadable trusted receipt source", { trustedReceiptFingerprint: null }, "trusted_source_changed"],
    ["a rotated secret", { configurationFingerprint: "0".repeat(64) }, "configuration_changed"],
    ["an unreadable secret digest", { configurationFingerprint: null }, "configuration_changed"],
    [
      "a receipt with no secret digest",
      { receipt: workerReceipt({ mutation: { ...workerReceipt().mutation, configurationFingerprint: null } }) },
      "configuration_changed",
    ],
    ["another live deployment", { liveIdentities: { ...CMS_API_IDS, deploymentId: "other" } }, "live_identity_mismatch"],
    ["an unreadable live deployment", { liveIdentities: null }, "live_identity_mismatch"],
  ])("deploys the Worker with %s", (_label, override, reason) => {
    expect(planCmsApiRelease({ ...matching, ...override })).toEqual({ mutated: true, reason });
  });
});

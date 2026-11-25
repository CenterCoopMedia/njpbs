import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { assertFirstAttempt, bindApiConfig, bindFunctionsDotenv, decodeBinding, encodeBinding, liveBindingCurrent, recordReaderCandidates,
  releaseSourceBinds, releaseSourceRebinds, selectReaderBinding } from "../../scripts/cms-reader-binding.mjs";
import { cmsTarget } from "../../scripts/lib/cms-target.mjs";

const require = createRequire(import.meta.url);
const production = cmsTarget({});
const development = cmsTarget({ CMS_TARGET: "development", CMS_DEV_ADMIN_ORIGIN: "https://dev-admin.njpbs.org",
  CMS_DEV_API_ORIGIN: "https://dev-cms-api.njpbs.org", CMS_DEV_PUBLIC_ORIGIN: "https://dev.njpbs.org", CMS_DEV_MEDIA_ORIGIN: "https://dev-media.njpbs.org",
  CMS_DEV_API_WORKER: "njpbs-dev-cms-api", CMS_DEV_PREVIEW_RENDERER: "njpbs-dev-cms-preview-renderer", CMS_DEV_ADMIN_PAGES: "njpbs-dev-admin" });
const run = { GITHUB_RUN_ID: "45310500950", GITHUB_RUN_ATTEMPT: "2" };
const unreachable = () => { throw new Error("unexpected read"); };
const reader = component => ({ schemaVersion: 2, component, state: "complete", lastComplete: { schemaVersion: 2, component,
  sourceSha: "a".repeat(40), inputFingerprint: "b".repeat(64), configurationFingerprint: "c".repeat(64),
  providerIdentities: { version: "v1" }, verifiedAt: "2026-11-24T00:00:00.000Z",
  supported: require("../../functions/lib/cms-reader-mount-descriptor.js").SUPPORT } });
const installed = async () => ({ functions: reader("functions"), cmsApi: reader("cmsApi") });

describe("CMS reader binding for an ordinary deploy", () => {
  it("changes nothing for production without a live binding (production today)", async () => {
    const readInstalledProof = vi.fn();
    await expect(selectReaderBinding({ env: run, target: production, readCompatibilityReceipts: installed, readLiveApiVars: async () => ({}), readInstalledProof })).resolves.toBeNull();
    await expect(selectReaderBinding({ env: run, target: production, readCompatibilityReceipts: installed,
      readLiveApiVars: async () => ({ CMS_READER_BRIDGE_ENABLED: "false" }), readInstalledProof })).resolves.toBeNull();
    expect(readInstalledProof).not.toHaveBeenCalled();
  });

  it("leaves a production binding with an installed proof as today and logs it", async () => {
    const log = vi.fn();
    await expect(selectReaderBinding({ env: run, target: production, log, readCompatibilityReceipts: installed, readInstalledProof: async () => true,
      readLiveApiVars: async () => ({ CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-prod-1" }) })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("#584"));
  });

  it("carries a live production binding without a proof onto this run's candidates", async () => {
    await expect(selectReaderBinding({ env: run, target: production, readCompatibilityReceipts: installed, readInstalledProof: async () => false,
      readLiveApiVars: async () => ({ CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-prod-1",
        CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-1-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-1-1" }) })).resolves.toEqual({
      CMS_READER_BRIDGE_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true",
      CMS_READER_BRIDGE_OPERATION_ID: "reader-prod-1",
      CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-45310500950-2", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-45310500950-2" });
  });

  it("keeps the live development binding only while its candidates, receipts and Worker are current", async () => {
    const live = { CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-dev-1-1" };
    const stored = { functions: reader("functions"), cmsApi: reader("cmsApi") };
    const input = { log: vi.fn(), readLiveApiVars: async () => live, readCompatibilityReceipts: async () => stored,
      readDescriptor: vi.fn(async () => ({ readers: { functions: stored.functions.lastComplete, cmsApi: stored.cmsApi.lastComplete } })),
      planWorker: async () => ({ mutated: false, reason: "unchanged" }) };
    await expect(liveBindingCurrent(input)).resolves.toBe(true);
    expect(input.readDescriptor).toHaveBeenCalledWith(live);
    const moved = { ...stored.functions.lastComplete, providerIdentities: { version: "v2" } };
    for (const change of [
      { readLiveApiVars: async () => { throw new Error("unread"); } },
      { readDescriptor: async () => { throw new Error("CMS reader mount unavailable"); } },
      { readDescriptor: async () => ({ readers: { functions: moved, cmsApi: stored.cmsApi.lastComplete } }) },
      { readCompatibilityReceipts: async () => ({ ...stored, cmsApi: { ...stored.cmsApi, state: "in_progress" } }) },
      { planWorker: async () => ({ mutated: true, reason: "inputs_changed" }) },
      { planWorker: async () => { throw new Error("unread"); } },
    ]) await expect(liveBindingCurrent({ ...input, ...change })).resolves.toBe(false);
  });

  it("selects a development binding from this run for a rebind", async () => {
    const binding = await selectReaderBinding({ env: { ...run, CMS_DEV_PUBLISH_ENABLED: "false" }, target: development,
      readCompatibilityReceipts: installed, readLiveApiVars: unreachable, readInstalledProof: unreachable });
    expect(binding).toEqual(require("../../functions/lib/dev-reader-deployment.js").devReaderUpdateDeployment({ ...run,
      CMS_DEV_PUBLISH_ENABLED: "false", FIREBASE_PROJECT_ID: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "development" }));
    expect(binding.CMS_READER_BRIDGE_OPERATION_ID).toBe("reader-dev-45310500950-2");
    await expect(selectReaderBinding({ env: { ...run, CMS_DEV_PUBLISH_ENABLED: "true" }, target: development,
      readCompatibilityReceipts: installed, readLiveApiVars: unreachable, readInstalledProof: unreachable })).rejects.toThrow();
  });

  it("leaves the readers unbound before a completed reader install, on both targets", async () => {
    for (const target of [development, production]) {
      await expect(selectReaderBinding({ env: { ...run, CMS_DEV_PUBLISH_ENABLED: "false" }, target, log: vi.fn(),
        readCompatibilityReceipts: async () => ({ functions: reader("functions") }), readLiveApiVars: unreachable, readInstalledProof: unreachable }))
        .resolves.toBeNull();
    }
  });

  it("writes the binding into the Functions dotenv and only the bridge keys into the API config", () => {
    const binding = { CMS_READER_BRIDGE_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-dev-1-1",
      CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-1-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-1-1" };
    expect(bindFunctionsDotenv("A=1\nCMS_READER_BRIDGE_ENABLED=false\nPUBLIC_RELEASE_READERS_ENABLED=false\n", binding)).toBe(
      "A=1\nCMS_READER_BRIDGE_ENABLED=true\nPUBLIC_RELEASE_READERS_ENABLED=true\nCMS_READER_BRIDGE_OPERATION_ID=reader-dev-1-1\n" +
      "CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE=functions-1-1\nCMS_READER_BRIDGE_CMS_API_CANDIDATE=cmsApi-1-1\n");
    const api = bindApiConfig({ name: "w", vars: { A: "1", CMS_READER_BRIDGE_ENABLED: "false" } }, binding);
    expect(api.vars).toEqual({ A: "1", CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-dev-1-1",
      CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-1-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-1-1" });
  });

  it("records each candidate from its completed receipt, then the compatibility receipts", async () => {
    const mutation = component => ({ sourceSha: "a".repeat(40), trustedWorkflowSha: "b".repeat(40),
      inputFingerprint: component.slice(0, 1).repeat(64), configurationFingerprint: "c".repeat(64), runId: "9", runAttempt: 1 });
    const firestore = { doc: path => ({ get: async () => ({ data: () => ({ schemaVersion: 1, state: "complete", mutation: mutation(path.split("/")[1]) }) }) }) };
    const calls = [];
    const receipts = { startCandidateReceipt: async (_f, input) => calls.push(["start", input]),
      verifyCandidateReceipt: async (_f, input) => calls.push(["verify", input.component]),
      commitLiveReaderReceipt: async (_f, input) => calls.push(["commit", input.component, input.supported]) };
    const mount = { SUPPORT: { adminSession: [1, 2] }, readCmsReaderMountDescriptor: async () => ({ operationId: "reader-dev-45310500950-2" }) };
    const binding = { CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-45310500950-2", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-45310500950-2" };
    await expect(recordReaderCandidates({ firestore, binding, collect: vi.fn(), receipts, mount })).resolves.toEqual({ operationId: "reader-dev-45310500950-2" });
    expect(calls.map(row => row.slice(0, 2))).toEqual([["start", calls[0][1]], ["verify", "functions"], ["start", calls[2][1]], ["verify", "cmsApi"],
      ["commit", "functions"], ["commit", "cmsApi"]]);
    expect(calls[0][1]).toEqual({ component: "functions", ...mutation("functions"), runId: "45310500950", runAttempt: 2 });
    expect(calls[4][2]).toEqual({ adminSession: [1, 2] });
  });

  it("passes the binding between jobs without the braces a multiline secret masks", () => {
    const binding = { CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-dev-45330201062-1" };
    expect(encodeBinding(binding)).not.toMatch(/[{}]/);
    expect(decodeBinding(encodeBinding(binding))).toEqual(binding);
    expect(decodeBinding("")).toBeNull();
    // A release source from before the base64 binding (036901d parses JSON) is refused in preflight.
    expect(releaseSourceBinds(readFileSync(new URL("../../scripts/cms-reader-binding.mjs", import.meta.url), "utf8"))).toBe(true);
    expect(releaseSourceBinds("const parsed = value ? JSON.parse(value) : null;")).toBe(false);
    expect(releaseSourceBinds("")).toBe(false);
    // A release source whose plan cannot rebind keeps the forced full release.
    expect(releaseSourceRebinds(readFileSync(new URL("../../scripts/cms-release-plan.mjs", import.meta.url), "utf8"))).toBe(true);
    expect(releaseSourceRebinds("forceFirebase: process.env.FORCE_FIREBASE")).toBe(false);
  });

  it("refuses a rerun of a bound run before selection and before each bind", () => {
    expect(() => assertFirstAttempt({ GITHUB_RUN_ATTEMPT: "1" })).not.toThrow();
    expect(() => assertFirstAttempt({ GITHUB_RUN_ATTEMPT: "2" })).toThrow("dispatch a new run");
    const source = readFileSync(new URL("../../scripts/cms-reader-binding.mjs", import.meta.url), "utf8");
    expect(source).toContain("if (selected) assertFirstAttempt(process.env);");
    // The firebase job refuses before any receipt write or preview pause; the bind steps refuse again.
    const firebase = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8")).jobs.firebase.steps;
    expect(firebase[1]).toMatchObject({ name: "Refuse a rerun of a bound run", if: "needs.firebase-preflight.outputs.reader_binding != ''" });
    expect(firebase[1].run).toContain('[ "$GITHUB_RUN_ATTEMPT" = 1 ] || {');
    // The workflow refuses too, so an older release-source binder never runs on a rerun.
    const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
    const steps = Object.fromEntries(Object.values(workflow.jobs).flatMap(job => job.steps).filter(row => row.name).map(row => [row.name, row]));
    for (const name of ["Bind the CMS readers into the Functions configuration", "Bind the CMS readers into the CMS API config"]) {
      const run = steps[name].run;
      expect(run.indexOf('[ "$GITHUB_RUN_ATTEMPT" = 1 ] || {')).toBeGreaterThan(-1);
      expect(run.indexOf('[ "$GITHUB_RUN_ATTEMPT" = 1 ] || {')).toBeLessThan(run.indexOf("node scripts/cms-reader-binding.mjs bind"));
    }
    for (const write of ["writeFileSync(path, bindFunctionsDotenv(", "writeFileSync(path, `${JSON.stringify(bindApiConfig("]) {
      const at = source.indexOf(write);
      expect(source.lastIndexOf("assertFirstAttempt(process.env);", at)).toBeGreaterThan(source.lastIndexOf("} else if", at));
    }
  });

  it("binds only a run whose binding is set and keeps production's force and Worker conditions", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
    const steps = Object.fromEntries(Object.values(workflow.jobs).flatMap(job => job.steps).filter(row => row.name).map(row => [row.name, row]));
    expect(steps["Select the CMS reader binding"].run).toContain("$RUNNER_TEMP/cms-smoke-gate/scripts/cms-reader-binding.mjs");
    for (const name of ["Bind the CMS readers into the Functions configuration", "Bind the CMS readers into the CMS API config",
      "Record and verify this run's CMS reader candidates"]) expect(steps[name].if).toContain("reader_binding != ''");
    const preflight = workflow.jobs["firebase-preflight"];
    expect(preflight.outputs.reader_binding).toBe("${{ steps.reader_binding.outputs.binding || (steps.release_plan.outputs.reader_rebind == 'true' && steps.reader_binding.outputs.rebind || '') }}");
    const api = workflow.jobs["cms-api"].steps;
    const refusal = api.findIndex(row => row.name === "Refuse a Worker deploy that would drop the kept reader binding");
    expect(api[refusal].if).toBe("needs.firebase-preflight.outputs.reader_rebind_mode != '' && needs.firebase-preflight.outputs.reader_binding == '' && steps.cms_api_plan.outputs.mutated != 'false'");
    expect(refusal).toBeGreaterThan(api.findIndex(row => row.name === "Plan the CMS API Worker release"));
    expect(refusal).toBeLessThan(api.findIndex(row => row.name === "Mark the CMS API receipt in progress"));
    // With no binding (production today) each expression reduces to its earlier form.
    expect(steps["Plan Functions and renderer release"].env.FORCE_FIREBASE).toBe("${{ inputs.force_firebase || steps.reader_binding.outputs.binding != '' }}");
    expect(steps["Deploy CMS API Worker"].if).toBe("steps.cms_api_plan.outputs.mutated != 'false' || needs.firebase-preflight.outputs.reader_binding != ''");
    expect(steps["Confirm the live CMS API identity"].if).toBe("steps.cms_api_plan.outputs.mutated == 'false' && needs.firebase-preflight.outputs.reader_binding == ''");
  });
});

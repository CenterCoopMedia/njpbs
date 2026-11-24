import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { bindApiConfig, bindFunctionsDotenv, recordReaderCandidates, selectReaderBinding } from "../../scripts/cms-reader-binding.mjs";
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

  it("binds development every run with the binding cms-dev-deploy wrote", async () => {
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
    const receipts = { candidateReceiptRef: () => ({ get: async () => ({ data: () => undefined }) }),
      startCandidateReceipt: async (_f, input) => calls.push(["start", input]),
      verifyCandidateReceipt: async (_f, input) => calls.push(["verify", input.component]),
      commitLiveReaderReceipt: async (_f, input) => calls.push(["commit", input.component, input.supported]) };
    const mount = { SUPPORT: { adminSession: [1, 2] }, readCmsReaderMountDescriptor: async () => ({ operationId: "reader-dev-45310500950-2" }) };
    const binding = { CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-45310500950-2", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-45310500950-2" };
    await expect(recordReaderCandidates({ firestore, binding, collect: vi.fn(), receipts, mount })).resolves.toEqual({ operationId: "reader-dev-45310500950-2" });
    expect(calls.map(row => row.slice(0, 2))).toEqual([["start", calls[0][1]], ["verify", "functions"], ["start", calls[2][1]], ["verify", "cmsApi"],
      ["commit", "functions"], ["commit", "cmsApi"]]);
    expect(calls[0][1]).toEqual({ component: "functions", ...mutation("functions"), runId: "45310500950", runAttempt: 2 });
    expect(calls[4][2]).toEqual({ adminSession: [1, 2] });
    // A rerun keeps both candidates an earlier attempt verified and only commits the receipts.
    calls.length = 0;
    receipts.candidateReceiptRef = () => ({ get: async () => ({ data: () => ({ state: "verified" }) }) });
    await recordReaderCandidates({ firestore, binding, collect: vi.fn(), receipts, mount });
    expect(calls.map(row => row.slice(0, 2))).toEqual([["commit", "functions"], ["commit", "cmsApi"]]);
  });

  it("binds only a run whose binding is set and keeps production's force and Worker conditions", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
    const steps = Object.fromEntries(Object.values(workflow.jobs).flatMap(job => job.steps).filter(row => row.name).map(row => [row.name, row]));
    expect(steps["Select the CMS reader binding"].run).toContain("$RUNNER_TEMP/cms-smoke-gate/scripts/cms-reader-binding.mjs");
    for (const name of ["Bind the CMS readers into the Functions configuration", "Bind the CMS readers into the CMS API config",
      "Record and verify this run's CMS reader candidates"]) expect(steps[name].if).toContain("reader_binding != ''");
    // With no binding (production today) each expression reduces to its earlier form.
    expect(steps["Plan Functions and renderer release"].env.FORCE_FIREBASE).toBe("${{ inputs.force_firebase || steps.reader_binding.outputs.binding != '' }}");
    expect(steps["Deploy CMS API Worker"].if).toBe("(steps.cms_api_plan.outputs.mutated != 'false' || steps.reader_bind_api.outputs.redeploy == 'true') && steps.reader_bind_api.outputs.redeploy != 'false'");
    expect(steps["Confirm the live CMS API identity"].if).toBe("(steps.cms_api_plan.outputs.mutated == 'false' && steps.reader_bind_api.outputs.redeploy != 'true') || steps.reader_bind_api.outputs.redeploy == 'false'");
  });
});

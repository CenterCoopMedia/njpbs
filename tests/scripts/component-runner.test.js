import { FunctionsConfigurationError } from "../../scripts/lib/functions-configuration.mjs";
import { execFileSync } from "node:child_process";
import { CmsSmokeError } from "../../scripts/smoke-cms-functions.mjs";
import { FunctionsDeployInventoryError } from "../../scripts/lib/functions-deploy-inventory.mjs";
import { describe, expect, it, vi } from "vitest";
import { DEPLOYMENT_COMPONENTS, RECEIPT_INPUT_PATHS } from "../../scripts/lib/deployment-components.mjs";
import { ComponentReceiptError, RECEIPT_INPUT_PATHS as receiptPaths } from "../../scripts/lib/cms-component-receipt.mjs";
import { componentFailureDiagnostic, main, runComponentOperation } from "../../scripts/component-runner.mjs";
import { CMS_RELEASE_CHECK_FILES } from "../../.github/scripts/require-cms-release-sources.mjs";
import { RELEASE_CHECK_PATHS } from "../../scripts/lib/cms-release-plan.mjs";

describe("component runner", () => {
  it("uses the same immutable selection paths as the receipt owner", () => {
    expect(receiptPaths).toBe(RECEIPT_INPUT_PATHS);
    for (const [component, row] of Object.entries(DEPLOYMENT_COMPONENTS)) {
      if (Object.hasOwn(RECEIPT_INPUT_PATHS, component)) expect(RECEIPT_INPUT_PATHS[component]).toBe(row.inputPaths);
      expect(Object.isFrozen(row.inputPaths)).toBe(true);
      expect(Object.isFrozen(row.operations)).toBe(true);
      for (const adapter of Object.values(row.operations)) expect(Object.isFrozen(adapter)).toBe(true);
    }
  });

  it.each([
    ["functions", "protocol", "cms-component-receipt.mjs", ["protocol"]],
    ["functions", "plan", "cms-release-plan.mjs", []],
    ["functions", "deploy", "retire-cms-functions.mjs", ["deploy"]],
    ["functions", "prepare", "retire-cms-functions.mjs", ["prepare"]],
    ["functions", "verify", "retire-cms-functions.mjs", ["verify"]],
    ["functions", "manifest", "smoke-cms-functions.mjs", ["--manifest-only", "--index", "functions/index.js"]],
    ["functions", "smoke", "smoke-cms-functions.mjs", ["--live-only", "--index", "functions/index.js"]],
    ["cmsApi", "plan", "cms-component-receipt.mjs", ["plan", "--component", "cmsApi", "--source-sha", "a".repeat(40)]],
    ...["functions", "renderer", "cmsApi"].flatMap(component =>
      ["start", "complete", "confirm", "read", "abandon"].map(operation =>
        [component, operation, "cms-component-receipt.mjs", [operation, "--component", component, "--source-sha", "a".repeat(40)]])),
  ])("delegates %s %s once to its existing state owner", async (component, operation, file, expected) => {
    const execute = vi.fn(async () => "settled by adapter");
    const load = vi.fn(async () => ({ main: execute }));
    const args = expected.includes("--source-sha") ? ["--source-sha", "a".repeat(40)] : [];
    expect(await runComponentOperation(component, operation, args, load)).toBe("settled by adapter");
    expect(load).toHaveBeenCalledExactlyOnceWith(new URL(`../../scripts/${file}`, import.meta.url).href);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    ["pair-install", "deploy", []], ["renderer", "deploy", []], ["cmsApi", "deploy", []],
    ["renderer", "plan", []], ["__proto__", "plan", []], ["functions", "constructor", []],
    ["functions", "plan", ["extra"]], ["cmsApi", "plan", ["--component", "functions"]],
    ["cmsApi", "read", ["--component=functions"]], ["cmsApi", "read", [null]],
  ])("refuses unsupported/ambiguous %s %s before loading code", async (component, operation, argv) => {
    const load = vi.fn();
    await expect(runComponentOperation(component, operation, argv, load)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it("preserves safe refusal diagnostics and redacts native/provider errors", () => {
    expect(componentFailureDiagnostic(new ComponentReceiptError("Receipt is not complete"))).toBe("Receipt is not complete");
    for (const ErrorType of [CmsSmokeError, FunctionsDeployInventoryError, FunctionsConfigurationError]) {
      expect(componentFailureDiagnostic(new ErrorType("Native boundary proof failed"))).toBe("Native boundary proof failed");
    }
    for (const error of [new Error("synthetic-private-value"), new SyntaxError("synthetic-private-value")]) {
      expect(componentFailureDiagnostic(error)).toBe("Component operation did not complete");
    }
  });

  it("tracks the dispatcher and table at the selected source pin", () => {
    for (const file of ["scripts/component-runner.mjs", "scripts/lib/deployment-components.mjs"]) {
      expect(CMS_RELEASE_CHECK_FILES).toContain(file);
      expect(RELEASE_CHECK_PATHS).toContain(file);
    }
  });

  it("keeps migrations explicit and policy/repair inspection free of deployment operations", async () => {
    expect(DEPLOYMENT_COMPONENTS.migrations.selection).toBe("explicit");
    for (const component of ["firestoreRules", "firestoreIndexes", "storageRules", "migrations"]) {
      expect(Object.keys(DEPLOYMENT_COMPONENTS[component].operations)).toEqual(["inputs"]);
      await expect(runComponentOperation(component, "deploy")).rejects.toThrow("Unsupported");
    }
  });

  it("inspects a policy fingerprint from one explicit committed source without provider credentials", () => {
    const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = JSON.parse(execFileSync(process.execPath,
      [new URL("../../scripts/component-runner.mjs", import.meta.url).pathname, "firestoreRules", "inputs", source],
      { encoding: "utf8", env: {}, stdio: ["ignore", "pipe", "pipe"] }));
    expect(result).toMatchObject({ component: "firestoreRules", sourceSha: source });
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses invalid CLI input without exposing it or loading provider adapters", () => {
    try {
      execFileSync(process.execPath, [new URL("../../scripts/component-runner.mjs", import.meta.url).pathname,
        "synthetic-private-input", "deploy"], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
      expect.unreachable("invalid component must fail");
    } catch (error) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toBe("");
      expect(error.stderr.toString()).toBe("Component operation did not complete\n");
    }
  });
});

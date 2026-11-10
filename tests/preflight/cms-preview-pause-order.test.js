import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflow = parse(readCmsDeployWorkflow());
const steps = workflow.jobs.firebase.steps;
const step = name => steps.find(value => value.name === name);
const position = name => steps.findIndex(value => value.name === name);

describe("selective preview pause boundary", () => {
  it("checks production reader refusals before preview can pause and plans API before reserving its candidate", () => {
    const preflight = "Preflight production reader attempts before preview admission can pause";
    expect(position(preflight)).toBeGreaterThan(-1);
    for (const name of ["Mark the renderer receipt in progress", "Pause cloud preview admission before changing Functions",
      "Pause preview admission before the preview Functions subset"]) expect(position(preflight)).toBeLessThan(position(name));
    expect(step(preflight).run).toContain("production-reader-deployment.mjs preflight functions");
    const api = workflow.jobs["cms-api"].steps;
    expect(api.findIndex(value => value.name === "Plan the CMS API Worker release")).toBeLessThan(
      api.findIndex(value => value.name === "Bind and start the original production API reader candidate"));
    const admin = workflow.jobs["admin-build"].steps;
    const auth = admin.findIndex(value => value.name === "Validate the separate production reader installation authorization");
    expect(auth).toBeGreaterThan(admin.findIndex(value => value.name === "Metered-API source scan for current Admin status gate"));
    expect(admin[auth].run).toContain('process.env.RUNNER_TEMP + "/admin-status-gate/scripts/lib/production-reader-authorization.mjs"');
  });
  it("finishes dependency installation, runtime configuration and ordinary Functions before the late pause", () => {
    const late = "Pause preview admission before the preview Functions subset";
    expect(step("Install Site release dependencies before mutation").if).toContain("preview_paused == 'true'");
    expect(step("Install Site release dependencies before mutation").if).toContain("CMS_PREVIEW_CLOUD_ENABLED == 'true'");
    for (const name of ["Install Site release dependencies before mutation", "Configure functions runtime params",
      "Deploy Firebase rules and indexes before the preview pause", "Deploy ordinary Functions before the preview pause"]) expect(position(name)).toBeLessThan(position(late));
    expect(position(late)).toBeLessThan(position("Deploy Firebase rules, indexes, and functions"));
    const ordinary = step("Deploy ordinary Functions before the preview pause");
    expect(ordinary.if).toContain("preview_pause_late == 'true'");
    expect(ordinary.if).toContain("CMS_PREVIEW_CLOUD_ENABLED == 'true'");
    expect(ordinary.env.CMS_FUNCTION_DEPLOY_PHASE).toBe("before-preview");
    expect(ordinary.env.DEPLOY_SHA).toBe("${{ needs.admin-build.outputs.deploy_sha }}");
    expect(ordinary.env.FUNCTION_TARGETS).toContain("smoke-manifest.outputs.function_targets");
    expect(ordinary.env.CMS_PREVIEW_FUNCTION_TARGETS).toContain("functions_during_preview");
    expect(ordinary.run).toBe("node scripts/component-runner.mjs functions deploy");
    const check = "Check preview dependencies before ordinary Functions mutate";
    expect(position(check)).toBeLessThan(position("Deploy Firebase rules and indexes before the preview pause"));
    expect(position(check)).toBeLessThan(position("Deploy ordinary Functions before the preview pause"));
    expect(step(check).run).toContain('deploy-cms-preview-cloud.ts preflight "$RENDERER_SHA"');
  });
  it("retains the original pause for unknown, configuration, force and recovery plans", () => {
    expect(step("Pause cloud preview admission before changing Functions").if).toContain("preview_pause_late != 'true'");
    for (const name of ["Pause cloud preview admission before changing Functions", "Pause preview admission before the preview Functions subset"]) {
      expect(step(name).if).toContain("preview_protocol == 'schema-one'");
      expect(step(name).run).toContain('deploy-cms-preview-cloud.ts pause "$RENDERER_SHA"');
    }
    expect(step("Pause cloud preview admission before changing Functions").run).toContain('deploy-cms-preview-cloud.ts preflight "$RENDERER_SHA"');
    expect(step("Pause preview admission before the preview Functions subset").run).not.toContain(".ts preflight");
    const final = step("Deploy Firebase rules, indexes, and functions");
    expect(final.env.CMS_FUNCTION_DEPLOY_TARGETS).toContain("CMS_PREVIEW_CLOUD_ENABLED == 'true'");
    expect(final.env.CMS_FUNCTION_DEPLOY_TARGETS).toContain("functions_during_preview || needs.firebase-preflight.outputs.function_deploy_targets");
    expect(final.env.FIRESTORE_DEPLOYED_BEFORE_PREVIEW).toContain("steps.deploy_rules_before_preview.outcome");
    expect(final.run).toContain('if [ "$FIRESTORE_DEPLOYED_BEFORE_PREVIEW" != success ]; then');
  });
  it("never abandons a receipt after either Functions phase attempted mutation", () => {
    const abandon = steps.find(value => value.run?.includes("component-runner.mjs functions abandon"));
    expect(abandon.if).toContain("steps.deploy_functions.outcome == 'skipped'");
    expect(abandon.if).toContain("steps.deploy_functions_before_preview.outcome == 'skipped'");
  });
  it("records the exact planner input fingerprint in both renderer reservation paths", () => {
    const starts = Object.values(workflow.jobs).flatMap(job => job.steps ?? []).filter(value =>
      value.run?.includes("component-runner.mjs renderer start"));
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start.env.RENDERER_INPUT_FINGERPRINT).toContain("firebase-preflight.outputs.renderer_input_fingerprint");
      expect(start.run).toContain('--input-fingerprint "$RENDERER_INPUT_FINGERPRINT"');
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { applyFunctionRetirements, planFunctionRetirements, validateRetirementPlan } from "../../scripts/lib/functions-retirement.mjs";

const scope = { projectId: "njpbs-site", region: "us-central1", codebase: "default" };
const context = { scope, sourceSha: "a".repeat(40), trustedWorkflowSha: "b".repeat(40), runId: "100", runAttempt: 1, targetNames: ["health"] };
const fn = (name, patch = {}) => ({ name: `projects/${scope.projectId}/locations/${scope.region}/functions/${name}`,
  platform: "gcfv2", state: "ACTIVE", updateTime: "2026-01-01T00:00:00Z",
  labels: { "deployment-tool": "cli-firebase", "firebase-functions-codebase": "default" },
  serviceConfig: { revision: `${name.toLowerCase()}-00001`, uri: `https://${name.toLowerCase()}-fixture-uc.a.run.app` }, ...patch });
const job = (name, patch = {}) => ({ name: `projects/${scope.projectId}/locations/${scope.region}/jobs/firebase-schedule-${name}-${scope.region}`,
  state: "ENABLED", schedule: "* * * * *", timeZone: "UTC", userUpdateTime: "2026-01-01T00:00:00Z",
  httpTarget: { uri: fn(name).serviceConfig.uri, httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.org" } }, ...patch });
const scheduled = name => fn(name, { labels: { ...fn(name).labels, "deployment-scheduled": "true" } });
function fixture(functions = [fn("health"), fn("oldHandler")], jobs = []) {
  const plan = planFunctionRetirements({ ...context, priorNames: ["health", "oldHandler"], functions, jobs });
  let liveFunctions = structuredClone(functions), liveJobs = structuredClone(jobs);
  const io = { assertAttempt: vi.fn(async () => {}), listFunctions: vi.fn(async () => liveFunctions), listSchedules: vi.fn(async () => liveJobs),
    deleteFunction: vi.fn(async name => { liveFunctions = liveFunctions.filter(row => !row.name.endsWith(`/functions/${name}`)); }),
    deleteSchedule: vi.fn(async name => { liveJobs = liveJobs.filter(row => row.name !== name); }) };
  return { plan, io, functions: value => { liveFunctions = value; }, jobs: value => { liveJobs = value; } };
}

describe("manifest-scoped Functions retirement", () => {
  it("selects only explicit predecessor exports missing from the complete target", async () => {
    const test = fixture();
    expect(test.plan.entries.map(row => row.name)).toEqual(["oldHandler"]);
    expect(await applyFunctionRetirements(test.plan, context, test.io, [])).toEqual({ retired: 0 });
    await expect(applyFunctionRetirements(test.plan, context, test.io, ["unknown"])).rejects.toThrow("invalid_retirement_selection");
    expect(test.io.deleteFunction).not.toHaveBeenCalled();
    expect(await applyFunctionRetirements(test.plan, context, test.io)).toEqual({ retired: 1 });
    expect(test.io.deleteFunction).toHaveBeenCalledExactlyOnceWith("oldHandler", scope);
    expect(test.io.deleteSchedule).not.toHaveBeenCalled();
  });

  it("does not select another codebase or region, and refuses target collisions", () => {
    const other = fn("foreign", { labels: { "deployment-tool": "cli-firebase", "firebase-functions-codebase": "other" } });
    const distant = { ...fn("remote"), name: "projects/njpbs-site/locations/us-east1/functions/remote" };
    expect(fixture([fn("health"), other, distant]).plan.entries).toEqual([]);
    expect(() => fixture([fn("health", { labels: other.labels })])).toThrow();
  });

  it.each([
    () => [fn("health"), fn("unknown")],
    () => [fn("health"), { ...scheduled("oldHandler"), platform: "gcfv1", versionId: "1" }],
    () => [fn("health"), fn("oldHandler", { labels: {} })],
    () => [fn("health"), fn("oldHandler", { labels: { "deployment-tool": "manual" } })],
    () => [fn("health"), fn("oldHandler", { updateTime: null })],
    () => [fn("health"), fn("oldHandler", { name: "projects/foreign-project/locations/us-central1/functions/oldHandler" })],
  ])("refuses incomplete scope/ownership before mutation", inventory => {
    expect(() => fixture(inventory())).toThrow();
  });

  it.each([[], ["health", "health"], ["health;exit"]])("refuses an invalid target manifest %j", targetNames => {
    expect(() => planFunctionRetirements({ ...context, targetNames, functions: [] })).toThrow();
  });

  it("requires the original run/source/scope and preserves the original attempt over a rerun", () => {
    const { plan } = fixture();
    expect(validateRetirementPlan(plan, { ...context, runAttempt: 2 })).toBe(plan);
    for (const patch of [{ sourceSha: "c".repeat(40) }, { runId: "101" }, { trustedWorkflowSha: "c".repeat(40) },
      { scope: { ...scope, region: "us-east1" } }, { targetNames: ["different"] }]) {
      expect(() => validateRetirementPlan(plan, { ...context, ...patch })).toThrow();
    }
    expect(plan.runAttempt).toBe(1);
  });

  it("rechecks identity and ownership immediately before each delete", async () => {
    for (const changed of [fn("oldHandler", { labels: {} }), fn("oldHandler", { updateTime: "2026-01-02T00:00:00Z" })]) {
      const test = fixture(); test.functions([fn("health"), changed]);
      await expect(applyFunctionRetirements(test.plan, context, test.io)).rejects.toThrow();
      expect(test.io.deleteFunction).not.toHaveBeenCalled();
    }
  });

  it("keeps a partial provider failure incomplete and settles a lost response by absence", async () => {
    const failed = fixture(); failed.io.deleteFunction.mockRejectedValue(Error("synthetic private provider failure"));
    await expect(applyFunctionRetirements(failed.plan, context, failed.io)).rejects.toThrow("function_absence_unverified");
    const lost = fixture(); lost.io.deleteFunction.mockImplementation(async () => { lost.functions([fn("health")]); throw Error("lost response"); });
    expect(await applyFunctionRetirements(lost.plan, context, lost.io)).toEqual({ retired: 1 });
    expect(await applyFunctionRetirements(lost.plan, { ...context, runAttempt: 2 }, lost.io)).toEqual({ retired: 1 });
    expect(lost.plan.runAttempt).toBe(1);
  });

  it("carries native cleanup ownership and in-flight export scope into a forward release", async () => {
    const test = fixture([fn("health"), scheduled("oldHandler")], [job("oldHandler")]);
    test.functions([fn("health")]);
    const next = { ...context, sourceSha: "c".repeat(40), runId: "101" };
    const plan = planFunctionRetirements({ ...next, pendingPlan: test.plan, functions: [fn("health")], jobs: [job("oldHandler")] });
    expect(plan.entries[0].origin).toEqual(test.plan.entries[0].origin);
    expect(await applyFunctionRetirements(plan, next, test.io)).toEqual({ retired: 1 });
    expect(test.io.deleteFunction).not.toHaveBeenCalled();
    expect(test.io.deleteSchedule).toHaveBeenCalledExactlyOnceWith(job("oldHandler").name, scope);
    const pending = planFunctionRetirements({ ...context, targetNames: ["health", "partialHandler"], functions: [fn("health")] });
    const adopted = planFunctionRetirements({ ...next, pendingPlan: pending, functions: [fn("health"), fn("partialHandler")] });
    expect(adopted.entries.map(entry => entry.name)).toEqual(["partialHandler"]);
    expect(adopted.entries[0].origin.runId).toBe(next.runId);
    expect(planFunctionRetirements({ ...next, targetNames: ["health", "oldHandler"], pendingPlan: test.plan,
      functions: [fn("health"), fn("oldHandler")] }).entries).toEqual([]);
  });

  it("refuses an orphan without original ownership, a changed route, and silent schedule deletion failure", async () => {
    expect(() => fixture([fn("health")], [job("oldHandler")])).toThrow("orphan_scheduler_without_original_plan");
    const changed = fixture([fn("health"), scheduled("oldHandler")], [job("oldHandler")]);
    changed.jobs([job("oldHandler", { httpTarget: { uri: "https://other.example.org", httpMethod: "POST" } })]);
    await expect(applyFunctionRetirements(changed.plan, context, changed.io)).rejects.toThrow();
    expect(changed.io.deleteFunction).not.toHaveBeenCalled();
    const failed = fixture([fn("health"), scheduled("oldHandler")], [job("oldHandler")]);
    failed.io.deleteSchedule.mockResolvedValue(undefined);
    await expect(applyFunctionRetirements(failed.plan, context, failed.io)).rejects.toThrow("scheduler_absence_unverified");
  });

  it("checks the writer/attempt before mutating and never copies secret values into a plan", async () => {
    const test = fixture([fn("health"), fn("oldHandler", { serviceConfig: { ...fn("oldHandler").serviceConfig,
      environmentVariables: { SECRET: "synthetic-private-value" } } })]);
    expect(JSON.stringify(test.plan)).not.toContain("synthetic-private-value");
    test.io.assertAttempt.mockRejectedValue(Error("writer changed"));
    await expect(applyFunctionRetirements(test.plan, context, test.io)).rejects.toThrow("writer changed");
    expect(test.io.deleteFunction).not.toHaveBeenCalled();
  });
});

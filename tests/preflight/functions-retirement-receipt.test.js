import { describe, expect, it, vi } from "vitest";
import { abandonReceipt, completeReceipt, startReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { deployWithRetirements, prepareRetirements, retirementProvider, retirementReceipt } from "../../scripts/retire-cms-functions.mjs";

const scope = { projectId: "njpbs-site", region: "us-central1", codebase: "default" };
const context = { scope, sourceSha: "a".repeat(40), trustedWorkflowSha: "b".repeat(40), runId: "100", runAttempt: 1, targetNames: ["health"] };
const fn = name => ({ name: `projects/njpbs-site/locations/us-central1/functions/${name}`, platform: "gcfv2", state: "ACTIVE",
  updateTime: "2026-01-01T00:00:00Z", labels: { "deployment-tool": "cli-firebase", "firebase-functions-codebase": "default" },
  serviceConfig: { revision: `${name.toLowerCase()}-00001`, uri: `https://${name.toLowerCase()}-fixture-uc.a.run.app` } });
function database(extraNames = []) {
  let stored = { schemaVersion: 1, component: "functions", state: "in_progress", mutation: { ...context, inputFingerprint: "c".repeat(64) },
    lastComplete: { sourceSha: "d".repeat(40), inputFingerprint: "e".repeat(64), functionGraph: { version: 2, globalFingerprint: "f".repeat(64),
      exports: { health: { fingerprint: "1".repeat(64), preview: false }, oldHandler: { fingerprint: "2".repeat(64), preview: false } } } } };
  for (const name of extraNames) stored.lastComplete.functionGraph.exports[name] = { fingerprint: "3".repeat(64), preview: false };
  const snapshot = () => ({ exists: true, data: () => structuredClone(stored) });
  const ref = { get: async () => snapshot() };
  const db = { projectId: "njpbs-site", doc: () => ({ protocol: true }), collection: () => ({ doc: () => ref }),
    runTransaction: async work => work({ get: async ref => ref.protocol ? { exists: false } : snapshot(), set: (_ref, row) => { stored = structuredClone(row); } }) };
  let functions = [fn("health"), fn("oldHandler"), ...extraNames.map(fn)];
  const provider = { listFunctions: vi.fn(async () => functions), listSchedules: vi.fn(async () => []),
    deleteFunction: vi.fn(async name => { functions = functions.filter(row => !row.name.endsWith(`/functions/${name}`)); }), deleteSchedule: vi.fn() };
  return { db, provider, read: () => stored, write: row => { stored = row; } };
}

describe("Functions retirement original attempt", () => {
  it("prepares in the existing receipt and completes only after target deploy and absence proof", async () => {
    const test = database(); const oldComplete = structuredClone(test.read().lastComplete);
    await prepareRetirements(test.db, context, test.provider);
    expect(test.read().lastComplete).toEqual(oldComplete);
    expect(test.read().mutation.retirementPlan.runAttempt).toBe(1);
    await expect(completeReceipt(test.db, { component: "functions", ...context, providerIdentities: { activeCount: "1" } })).rejects.toThrow("absence has not been proved");
    const deploy = vi.fn(async () => expect(test.provider.deleteFunction).not.toHaveBeenCalled());
    await deployWithRetirements(test.db, context, test.provider, deploy, "complete");
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(test.read().mutation.retirementComplete).toBe(true);
    expect(test.read().lastComplete).toEqual(oldComplete);
    await completeReceipt(test.db, { component: "functions", ...context, providerIdentities: { activeCount: "1" } });
    expect(test.read().state).toBe("complete");
  });

  it("preserves the original plan and failure state over a same-source rerun", async () => {
    const test = database(); await prepareRetirements(test.db, context, test.provider);
    const original = structuredClone(test.read().mutation.retirementPlan);
    await expect(deployWithRetirements(test.db, context, test.provider, async () => { throw Error("partial target deployment"); }))
      .rejects.toThrow("partial target deployment");
    expect(test.read().mutation.retirementStarted).toBe(true);
    expect(test.read().mutation.retirementComplete).toBe(false);
    expect(test.provider.deleteFunction).not.toHaveBeenCalled();
    await startReceipt(test.db, { component: "functions", ...context, runAttempt: 2, inputFingerprint: "c".repeat(64) });
    expect(test.read().mutation.retirementPlan).toEqual(original);
    expect(test.read().mutation.retirementPlan.runAttempt).toBe(1);
    await expect(abandonReceipt(test.db, { component: "functions", runId: context.runId, runAttempt: 2 })).rejects.toThrow("cannot claim no provider mutation");
    await deployWithRetirements(test.db, { ...context, runAttempt: 2 }, test.provider, async () => {});
    expect(test.read().mutation.retirementComplete).toBe(true);
  });

  it("does not retire during the ordinary pre-preview subset", async () => {
    const test = database(); await prepareRetirements(test.db, context, test.provider);
    await deployWithRetirements(test.db, context, test.provider, async () => {}, "before-preview");
    expect(test.provider.deleteFunction).not.toHaveBeenCalled();
    expect(test.read().mutation.retirementComplete).toBe(false);
  });

  it("keeps native original identities while a forward source takes the writer reservation", async () => {
    const test = database(); await prepareRetirements(test.db, context, test.provider);
    const original = structuredClone(test.read());
    await expect(retirementReceipt(test.db, context, { retirementPlan: { ...original.mutation.retirementPlan, priorNames: [] } })).rejects.toThrow();
    await expect(deployWithRetirements(test.db, context, test.provider, async () => { throw Error("source build failed"); })).rejects.toThrow("source build failed");
    const next = { ...context, sourceSha: "c".repeat(40), trustedWorkflowSha: "d".repeat(40), runId: "101" };
    await startReceipt(test.db, { component: "functions", ...next, inputFingerprint: "c".repeat(64) });
    expect(test.read().lastComplete).toEqual(original.lastComplete);
    await expect(abandonReceipt(test.db, { component: "functions", runId: "101", runAttempt: 1 })).rejects.toThrow("cannot claim no provider mutation");
    await expect(retirementReceipt(test.db, context)).rejects.toThrow();
    await prepareRetirements(test.db, next, test.provider);
    expect(test.read().mutation.retirementPlan.entries[0].origin).toEqual({ sourceSha: context.sourceSha,
      trustedWorkflowSha: context.trustedWorkflowSha, runId: context.runId, runAttempt: 1 });
    await deployWithRetirements(test.db, next, test.provider, async () => {});
    await completeReceipt(test.db, { component: "functions", ...next, providerIdentities: { activeCount: "1" } });
    expect(test.read().state).toBe("complete");
    expect(test.read().lastComplete.sourceSha).toBe(next.sourceSha);
  });

  it("cannot abandon a started first attempt or deploy without a prepared plan", async () => {
    const test = database();
    const deploy = vi.fn();
    await expect(deployWithRetirements(test.db, context, test.provider, deploy)).rejects.toThrow();
    expect(deploy).not.toHaveBeenCalled();
    await prepareRetirements(test.db, context, test.provider);
    await retirementReceipt(test.db, context, { retirementStarted: true });
    await expect(abandonReceipt(test.db, { component: "functions", runId: "100", runAttempt: 1 })).rejects.toThrow("cannot claim no provider mutation");
  });

  it("uses the same credential only on the scoped Google APIs and never puts it in delete arguments", async () => {
    const requests = [], launches = [];
    const provider = retirementProvider(scope, async () => ({ access_token: "synthetic-private-token" }), async (url, options) => {
      requests.push({ url: String(url), ...options });
      return new Response(JSON.stringify(options.method === "DELETE" ? {} : { jobs: [] }));
    }, async (program, args) => { launches.push({ program, args }); });
    await provider.listSchedules();
    await provider.deleteSchedule("projects/njpbs-site/locations/us-central1/jobs/firebase-schedule-oldHandler-us-central1", scope);
    await provider.deleteFunction("oldHandler", scope);
    expect(requests.every(row => row.headers.authorization === "Bearer synthetic-private-token" && row.redirect === "error")).toBe(true);
    expect(requests[1].url).not.toContain("pageSize");
    expect(requests[1].method).toBe("DELETE");
    expect(launches).toEqual([{ program: "npx", args: ["--no-install", "firebase", "functions:delete", "oldHandler", "--project", "njpbs-site", "--region", "us-central1", "--force", "--non-interactive"] }]);
    expect(JSON.stringify(launches)).not.toContain("synthetic-private-token");
  });
});

it("uses the full original journal while retiring only cloud-wake entries before batch readiness", async () => {
  const test = database(["otherOld"]); await prepareRetirements(test.db, context, test.provider);
  const originalPlan = structuredClone(test.read().mutation.retirementPlan);
  await deployWithRetirements(test.db, context, test.provider, async ({ retireCloudWake }) => {
    await expect(retireCloudWake(["health"], scope.projectId)).rejects.toThrow();
    await expect(retireCloudWake(["oldHandler"], "foreign-project")).rejects.toThrow();
    await retireCloudWake(["oldHandler", "alreadyAbsent"], scope.projectId);
    expect(test.provider.deleteFunction).toHaveBeenCalledExactlyOnceWith("oldHandler", scope);
    expect((await test.provider.listFunctions()).map(row => row.name.split("/").at(-1))).toEqual(["health", "otherOld"]);
    expect(test.read().mutation.retirementPlan).toEqual(originalPlan);
  });
  expect(test.read().mutation.retirementComplete).toBe(true);
  expect(test.provider.deleteFunction.mock.calls.map(([name]) => name)).toEqual(["oldHandler", "otherOld"]);
});

it.each([
  () => ({ jobs: [], nextPageToken: "repeat" }),
  () => ({ jobs: "partial" }),
  () => ({ jobs: [], unexpected: true }),
  () => ({ jobs: [], nextPageToken: 1 }),
])("refuses malformed or partial Scheduler inventories", body => {
  const provider = retirementProvider(scope, async () => ({ access_token: "synthetic-token" }), async () => new Response(JSON.stringify(body())));
  return expect(provider.listSchedules()).rejects.toThrow("original attempt or provider proof");
});

it("keeps provider failures value-free and rejects a foreign Scheduler deletion", async () => {
  const provider = retirementProvider(scope, async () => ({ access_token: "synthetic-token" }), async () => { throw Error("synthetic-private-body"); });
  await expect(provider.listSchedules()).rejects.toThrow("Functions retirement original attempt or provider proof is unavailable");
  expect(() => provider.deleteSchedule("projects/foreign-project/locations/us-central1/jobs/firebase-schedule-oldHandler-us-central1")).toThrow();
});

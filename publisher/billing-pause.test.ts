import { expect, it, vi } from "vitest";
import cloudWork from "../functions/lib/no-build-cloud-work.js";
import background from "../functions/lib/post-background-outputs.js";
import { noBuildPostMaintenance } from "../site/scripts/no-build-post-background";
import { fakeFirestore } from "../tests/helpers/master-cleanup-firestore.js";
import { documents, runtime, digest } from "../tests/no-build-cloud-contract";

const ready = { schemaVersion: 1, phase: "ready", commitSha: runtime.release, serializerId: "cloudflare-publisher" };
it("sleeps before owner selection during a billing pause and resumes", async () => {
  const docs = documents();
  docs["system/cmsPublicationRuntime"] = { ...ready };
  docs["system/billing"] = { disabled: true };
  const read = vi.fn(async (name: string) => docs[name] ?? null);
  const listOwners = vi.fn(async () => []);
  expect(await cloudWork.readNoBuildCloudWork({ read, listOwners, runtime })).toEqual({ maintenance: false, reconcile: false });
  expect(await cloudWork.activeCloudPostStates({ read, listOwners, runtime })).toEqual([]);
  expect(listOwners).not.toHaveBeenCalled();
  expect(read.mock.calls.every(([name]) => ["system/billing", "system/cmsPublicationRuntime"].includes(name))).toBe(true);
  docs["system/billing"] = { disabled: false };
  docs["system/cmsPublicationRuntime"] = { ...ready };
  expect((await cloudWork.readNoBuildCloudWork({ read, listOwners, runtime, now: 1000 })).maintenance).toBe(true);
});

it("keeps the absent billing default and propagates unreadable spending controls", async () => {
  expect(await cloudWork.cloudBillingPaused({ read: async () => null, runtime })).toBe(false);
  await expect(cloudWork.readNoBuildCloudWork({ runtime, read: async () => { throw Error("read unavailable"); } })).rejects.toThrow("read unavailable");
});

it("does no producer selection or preparation during a billing pause", async () => {
  const { firestore, rows, queries } = fakeFirestore();
  rows.set("system/cmsPublicationRuntime", ready);
  rows.set("system/billing", { disabled: true });
  const buildPublication = vi.fn();
  const maintain = noBuildPostMaintenance({ firestore, commitSha: runtime.release, runtime,
    stateDirectory: "/unused-paused-fixture", distDirectory: "/unused-paused-fixture/dist", buildEnvironment: {}, buildPublication } as never);
  const before = structuredClone(rows);
  await maintain();
  expect(rows).toEqual(before);
  expect(queries).toEqual([]);
  expect(buildPublication).not.toHaveBeenCalled();
  rows.set("system/billing", { disabled: false });
  rows.set("system/cmsPublicationRuntime", ready);
  await maintain();
  expect(queries.some(query => query.path === "system/publicDeployment/noBuildPostOwners")).toBe(true);
});

it.each(["home", "listings", "programs", "events"])("fences the %s task claim transaction against a concurrent billing pause", async output => {
  const { firestore, rows, hooks } = fakeFirestore();
  rows.set("system/cmsPublicationRuntime", ready);
  rows.set("system/billing", { disabled: false });
  rows.set("system/publicDeployment/contexts/public", { schemaVersion: 1, revision: 1 });
  const after = background.dependency(null);
  const taskPath = `cmsPublishQueue/${"A".repeat(20)}/backgroundOutputs/${output}`;
  const state = { schemaVersion: 1, owner: "post-background-v1", runtime, revision: 1, contextOnly: true,
    output, taskPath, after, contextDigest: digest, status: "pending" };
  const task = { ...state, status: "pending", attempts: 0, nextAttemptAt: 0,
    dependencies: { before: after, after, homePlacementPaths: [] } };
  rows.set(`cmsBackgroundOutputs/${output}`, state);
  rows.set(taskPath, task);
  const build = vi.fn(async () => { throw Error("fixture build boundary"); });
  const artifacts = { put: vi.fn(), get: vi.fn() };
  const owner = background.createPostBackgroundOutputs({ firestore, runtime, enabled: true,
    recoveryOutputs: [output], build, artifacts, readContextInTransaction: async () => ({ rendererSha: runtime.release, digest, withdrawalRevision: 0 }), now: () => 1000 });
  hooks.beforeCommit = (writes: unknown[]) => {
    if (writes.length) { rows.set("system/billing", { disabled: true }); hooks.beforeCommit = null; }
  };
  await owner.recover();
  expect(rows.get(taskPath)).toEqual(task);
  expect(build).not.toHaveBeenCalled();
  expect(artifacts.put).not.toHaveBeenCalled();
  expect(artifacts.get).not.toHaveBeenCalled();
  rows.set("system/billing", { disabled: false });
  await owner.recover();
  expect(build).toHaveBeenCalledOnce();
  expect(rows.get(taskPath)).toMatchObject({ attempts: 1, status: "failed" });
});

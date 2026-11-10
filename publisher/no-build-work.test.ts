import { expect, it } from "vitest";
import { checkCloudContextWorkContract, checkCloudWorkContract, documents, runtime, preparationPath, digest, staleFamilyDocuments } from "../tests/no-build-cloud-contract";
import cloudWork from "../functions/lib/no-build-cloud-work.js";
import { backgroundHealth } from "../functions/lib/post-background-outputs.js";
import { createHash } from "node:crypto";

it("keeps the due, idle, withdrawal and ownership contract in Node", async () => {
  await expect(checkCloudWorkContract()).resolves.toBeUndefined();
});
it.each(["missing", "retry", "malformed"])("keeps accepted Post family and reserved withdrawal work visible with %s private retention", async preview => {
  const docs = documents(); const aggregateQueue = docs[`cmsPublishQueue/${"D".repeat(20)}`];
  if (preview === "missing") delete aggregateQueue.previewContext;
  else if (preview === "retry") aggregateQueue.previewContext = { status: "failed", contextDigest: digest,
    publicationGeneration: 1, manifestId: null, publicationArtifactReceiptDigest: null, attempts: 1, startedAt: 900, nextAttemptAt: 1000 };
  else aggregateQueue.previewContext.manifestId = "bad";
  const input = { runtime, now: 1000, read: async (name: string) => docs[name] ?? null };
  expect((await cloudWork.readNoBuildCloudWork(input)).maintenance).toBe(true);
  docs["system/publicDeployment/noBuildPosts/current"].visible = false;
  docs[`cmsPublishQueue/${docs["system/publicDeployment/noBuildPosts/current"].operationId}`].homeFullBuild = { status: "reserved" };
  expect((await cloudWork.readNoBuildCloudWork(input)).maintenance).toBe(true);
});
it.each(["paused", "narrowed"])("keeps accepted cloud operations due when admission is %s", async mode => {
  const docs = documents();
  const state = docs["system/publicDeployment/noBuildPosts/current"];
  docs["system/noBuildPostAdmission"] = { schemaVersion: 2, revision: 2, enabled: mode !== "paused",
    families: { posts: mode === "narrowed" ? { mode: "ids", ids: ["another-post"] } : { mode: "all" } },
    backgroundBucket: "fixture-bucket" };
  const input = { runtime, now: 1000, read: async (path: string) => docs[path] ?? null };
  expect(await cloudWork.currentCloudPostStates(input)).toEqual([state]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
  state.visible = false;
  expect(await cloudWork.currentCloudPostStates(input)).toEqual([state]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
});
it("retains selected current ownership for health during preparation backoff and exhaustion", async () => {
  const docs = documents();
  const read = async (path: string) => docs[path] ?? null;
  for (const preparation of [
    { runtime, status: "building", attempts: 1, nextAttemptAt: 2000 },
    { runtime, status: "failed", attempts: 4, nextAttemptAt: null },
  ]) {
    docs[preparationPath] = preparation;
    expect(await cloudWork.currentCloudPostStates({ read, runtime, listOwners: async () => [] }))
      .toEqual([docs["system/publicDeployment/noBuildPosts/current"]]);
    expect((await cloudWork.readNoBuildCloudWork({ read, runtime, now: 1000 })).maintenance).toBe(false);
  }
});
it("does not wake for an exhausted, delayed or other-release preparation", async () => {
  const docs = documents();
  for (const preparation of [
    { runtime, status: "failed", attempts: 4, nextAttemptAt: null },
    { runtime, status: "building", attempts: 1, nextAttemptAt: 1001 },
    { runtime: { ...runtime, release: "b".repeat(40) }, status: "verified" },
  ]) {
    docs[preparationPath] = preparation;
    expect(await cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => docs[path] ?? null }))
      .toEqual({ maintenance: false, reconcile: false });
  }
});

it("requests regeneration while a prior-release family remains healthy to serve", async () => {
  const docs = staleFamilyDocuments();
  const family = docs["cmsBackgroundOutputs/listings"];
  const health = backgroundHealth(family, family.after,
    { rendererSha: runtime.release, digest, withdrawalRevision: 0, changedAt: 900 }, 1000);
  expect(health).toMatchObject({ current: false, releaseCompatible: true, reason: "release_pending" });
  expect(health.expiresAt).toBeGreaterThan(1000);
  expect(await cloudWork.readNoBuildCloudWork({ runtime, now: 1000, read: async path => docs[path] ?? null }))
    .toEqual({ maintenance: true, reconcile: false });
});

it("discovers both Post owners while the global family belongs to the second", async () => {
  const docs = documents();
  const secondOperation = "C".repeat(20);
  const second = { ...docs["system/publicDeployment/noBuildPosts/current"],
    postId: "second", operationId: secondOperation, slug: "second", ownedSlugs: ["second"] };
  const secondTask = `cmsPublishQueue/${secondOperation}/backgroundOutputs/listings`;
  docs["system/noBuildPostAdmission"] = { schemaVersion: 2, revision: 2, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" };
  docs[`cmsPublishQueue/${secondOperation}`] = { transport: "post-no-build-v1", backgroundRuntime: runtime,
    noBuildPost: { postId: "second", operationId: secondOperation, sourceVersion: 1 } };
  docs["cmsBackgroundOutputs/listings"] = { runtime, postId: "second", contextDigest: digest,
    status: "pending", taskPath: secondTask };
  docs[secondTask] = { runtime, postId: "second", status: "pending", attempts: 0, nextAttemptAt: 1000 };
  const input = { runtime, now: 1000, read: async (path: string) => docs[path] ?? null, listOwners: async () => [second] };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([docs["system/publicDeployment/noBuildPosts/current"], second]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
  docs[`cmsPublishQueue/${secondOperation}/backgroundPreparation/${digest}`] = {
    runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([docs["system/publicDeployment/noBuildPosts/current"]]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: false, reconcile: false });
});

it("ignores historic preparation failures and refuses duplicate or mismatched current owners", async () => {
  const docs = documents();
  const state = docs["system/publicDeployment/noBuildPosts/current"];
  docs[`cmsPublishQueue/${state.operationId}/backgroundPreparation/${"f".repeat(64)}`] = {
    runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  const input = { runtime, now: 1000, read: async (path: string) => docs[path] ?? null };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([state]);
  await expect(cloudWork.activeCloudPostStates({ ...input, listOwners: async () => [{ ...state }] }))
    .rejects.toThrow("Ambiguous cloud Post ownership");
  docs[`cmsPublishQueue/${state.operationId}`].noBuildPost.postId = "other";
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([]);
});

it("prepares a new active context without rebinding the retained Post or queue release", async () => {
  const docs = documents();
  const nextRelease = "b".repeat(40);
  const nextRuntime = { ...runtime, release: nextRelease };
  const state = docs["system/publicDeployment/noBuildPosts/current"];
  docs["system/publicDeployment"].activeCommitSha = nextRelease;
  docs["system/publicDeployment/noBuildPosts/capability"] = { schemaVersion: 2,
    rendererSha: nextRelease, servingEnabled: true, generation: 2 };
  docs["system/publicDeployment/contexts/public"].revision = 2;
  const nextDigest = createHash("sha256").update("njpbs-public-context-v1:2").digest("hex");
  const input = { runtime: nextRuntime, now: 1000, read: async (path: string) => docs[path] ?? null };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([state]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
  expect(state.runtime).toEqual(runtime);
  expect(docs[`cmsPublishQueue/${state.operationId}`].backgroundRuntime).toEqual(runtime);
  docs[`cmsPublishQueue/${state.operationId}/backgroundPreparation/${nextDigest}`] = {
    runtime, status: "verified", attempts: 1, nextAttemptAt: null };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
  // A predecessor Post preparation cannot suppress independent cloud context work.
  expect(docs["system/publicDeployment/aggregateContexts/current"].runtime).toEqual(runtime);
  const aggregate = docs["system/publicDeployment/aggregateContexts/current"];
  Object.assign(aggregate, { runtime: nextRuntime, contextDigest: nextDigest });
  const aggregateQueue = docs[`cmsPublishQueue/${aggregate.operationId}`];
  Object.assign(aggregateQueue, { runtime: nextRuntime, publicContext: { contextDigest: nextDigest } });
  aggregateQueue.previewContext.contextDigest = nextDigest;
  // With context initialization already settled, the retained verified Post
  // preparation is still asleep and keeps its original release provenance.
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: false, reconcile: false });
});

it("keeps a due family successor under its original queue when current preparation is exhausted", async () => {
  const docs = documents();
  const retainedOperation = "B".repeat(20);
  const retainedTask = `cmsPublishQueue/${retainedOperation}/backgroundOutputs/listings-2`;
  docs[preparationPath] = { runtime, status: "failed", attempts: 4, nextAttemptAt: null };
  docs["cmsBackgroundOutputs/listings"].taskPath = retainedTask;
  docs[retainedTask] = { runtime, postId: "pilot", status: "pending", attempts: 0, nextAttemptAt: 1000 };
  docs[`cmsPublishQueue/${retainedOperation}`] = { transport: "post-no-build-v1", backgroundRuntime: runtime,
    noBuildPost: { postId: "pilot", operationId: retainedOperation, sourceVersion: 1 } };
  const input = { runtime, now: 1000, read: async (path: string) => docs[path] ?? null };
  expect(await cloudWork.activeCloudPostStates(input)).toEqual([]);
  expect(await cloudWork.readNoBuildCloudWork(input)).toEqual({ maintenance: true, reconcile: false });
});

it("wakes and settles independent context work without Post admission", async () => {
  await expect(checkCloudContextWorkContract()).resolves.toBeUndefined();
});

import { checkAggregateContextHealthContract } from "../tests/no-build-cloud-health-contract";
it("reports exhausted context preparation without a Post owner", async () => {
  await expect(checkAggregateContextHealthContract()).resolves.toBeUndefined();
});

import { checkMissingAggregateHealthContract } from "../tests/no-build-cloud-health-contract";
it("reports a missing initial aggregate job as overdue", async () => {
  await expect(checkMissingAggregateHealthContract()).resolves.toBeUndefined();
});

import { checkPageHomeHealthContract } from "../tests/no-build-cloud-health-contract";
it("yields monitoring only to a validated Page Home pair", async () => {
  await expect(checkPageHomeHealthContract()).resolves.toBeUndefined();
});

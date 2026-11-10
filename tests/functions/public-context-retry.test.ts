import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../functions/lib/firebase.js";
import publication from "../../functions/lib/public-context-publication.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import { main, parsePublicContextRetryArguments, retryPublicContextPublication } from "../../site/scripts/retry-public-context-publication";

const sourceSha = "a".repeat(40);
const operationId = "A".repeat(20);
const runtime = { owner: "cloudflare", release: sourceSha };
const input = { operationId, sourceSha, contextRevision: 1, apply: false };
const preparationPath = `cmsPublishQueue/${operationId}/backgroundPreparation/${context.publicContextDigest(1)}`;
beforeEach(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use demo Firestore emulators");
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await db.recursiveDelete(db.collection("cmsPublishQueue"));
  await db.recursiveDelete(db.collection("cmsBackgroundOutputs"));
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeCommitSha: sourceSha,
    activeGeneration: 1, activeDeploymentId: "11111111-1111-4111-8111-111111111111", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sourceSha, serializerId: "cloudflare-publisher" });
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId, runtime, reason: "context", contextRevision: 1 });
    accepted.write();
  });
  await db.doc(preparationPath).set({ schemaVersion: 1, runtime, contextDigest: context.publicContextDigest(1),
    status: "failed", attempts: 4, claim: null, nextAttemptAt: null, inputDigest: "b".repeat(64),
    reservation: { cutoffAt: 1700000000000, buildBatchId: "retained-original", generation: 2, commitSha: sourceSha } });
  await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "failed", attempts: 4, nextAttemptAt: null });
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
});
async function snapshot() {
  const docs = await db.getAll(db.doc(publication.CURRENT_PATH), db.doc(`cmsPublishQueue/${operationId}`), db.doc(preparationPath),
    ...publication.OUTPUTS.flatMap(output => [db.doc(`cmsBackgroundOutputs/${output}`), db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/${output}`)]));
  return docs.map(row => ({ data: row.data(), updateTime: row.updateTime }));
}

it("defaults the operator to dry-run and writes nothing, including update times", async () => {
  const parsed = parsePublicContextRetryArguments(["--operation-id", operationId, "--source-sha", sourceSha, "--context-revision", "1"]);
  expect(parsed.apply).toBe(false);
  const before = await snapshot();
  const result = await retryPublicContextPublication({ firestore: db, input: parsed });
  expect(result.applied).toBe(false);
  expect(await snapshot()).toEqual(before);
  expect((await db.doc(`cmsPublishQueue/${result.successorId}`).get()).exists).toBe(false);
});

it.each(["context", "source", "preparation-lease", "family-lease", "deployment-lease"])("refuses a moved or leased %s without writes", async kind => {
  if (kind === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  if (kind === "source") await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
  if (kind === "preparation-lease") await db.doc(preparationPath).update({ status: "building", claim: "held", nextAttemptAt: Date.now() + 600_000 });
  if (kind === "family-lease") await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "building", claim: "held", nextAttemptAt: Date.now() + 60_000 });
  if (kind === "deployment-lease") await db.doc("system/publicDeployment").update({ state: "deploying" });
  const before = await snapshot();
  await expect(retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } })).rejects.toThrow("retry refused");
  expect(await snapshot()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it.each([null, "unknown", Number.NaN, Number.POSITIVE_INFINITY, -1])("refuses an unknown held lease expiry %s without writes", async nextAttemptAt => {
  await db.doc(preparationPath).update({ status: "building", claim: "held", nextAttemptAt });
  const before = await snapshot();
  await expect(retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } })).rejects.toThrow("retry refused");
  expect(await snapshot()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it("creates a guarded successor and preserves the exhausted preparation and original acceptance", async () => {
  const before = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data();
  const preparation = (await db.doc(preparationPath).get()).data();
  const result = await retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } });
  expect(result.applied).toBe(true);
  expect(result.successorId).not.toBe(operationId);
  expect((await db.doc(publication.CURRENT_PATH).get()).data().operationId).toBe(result.successorId);
  expect((await db.doc(preparationPath).get()).data()).toEqual(preparation);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data().publicContext).toEqual(before.publicContext);
  expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).get()).data().attempts).toBe(4);
  expect((await db.doc(`cmsPublishQueue/${result.successorId}`).get()).data()).toMatchObject({ status: "pending", retryOfQueueId: operationId,
    publicContext: { contextRevision: 1, contextDigest: context.publicContextDigest(1), runtime } });
  expect((await db.doc(`cmsPublishQueue/${result.successorId}/backgroundOutputs/search`).get()).data()).toMatchObject({ status: "pending", attempts: 0 });
});

it("fences an expired exhausted preparation claim without resetting its attempt budget or reservation", async () => {
  await db.doc(preparationPath).update({ status: "building", claim: "expired-worker", nextAttemptAt: Date.now() - 1 });
  const preparation = (await db.doc(preparationPath).get()).data()!;
  const before = await snapshot();
  await retryPublicContextPublication({ firestore: db, input });
  expect(await snapshot()).toEqual(before);
  const result = await retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } });
  expect((await db.doc(preparationPath).get()).data()).toEqual({ ...preparation, status: "failed", claim: null, nextAttemptAt: null });
  expect((await db.doc(`cmsPublishQueue/${result.successorId}`).get()).data()).toMatchObject({ status: "pending", retryOfQueueId: operationId });
});

it.each([60_000, -1])("refuses a selected Post preparation claimant with lease offset %s without changing it", async offset => {
  const postId = "P".repeat(20);
  const taskPath = `cmsPublishQueue/${postId}/backgroundOutputs/search`;
  const postPreparation = db.doc(`cmsPublishQueue/${postId}/backgroundPreparation/${context.publicContextDigest(1)}`);
  await db.doc(taskPath).set({ runtime, status: "pending", claim: null, nextAttemptAt: Date.now() });
  await db.doc("cmsBackgroundOutputs/search").update({ taskPath });
  await postPreparation.set({ runtime, status: "building", claim: "post-worker", nextAttemptAt: Date.now() + offset, attempts: 4 });
  const before = await snapshot();
  const original = await postPreparation.get();
  await expect(retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } })).rejects.toThrow("retry refused");
  expect(await snapshot()).toEqual(before);
  expect((await postPreparation.get()).data()).toEqual(original.data());
  expect((await postPreparation.get()).updateTime).toEqual(original.updateTime);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

// Issue #3276: the commit can succeed even when the client never receives it.
it("recovers the accepted successor after a lost commit response without duplicating or relabeling it", async () => {
  const before = await snapshot();
  const lostReplyDb = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      await (target.runTransaction as any)(...args);
      throw new Error("Injected lost commit response");
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(retryPublicContextPublication({ firestore: lostReplyDb, input: { ...input, apply: true } }))
    .rejects.toThrow("Injected lost commit response");
  // Follow the CLI guidance through current to the queue's original retry identity.
  const current = (await db.doc(publication.CURRENT_PATH).get()).data()!;
  const successorRef = db.doc(`cmsPublishQueue/${current.operationId}`);
  const successor = await successorRef.get();
  expect(current.operationId).not.toBe(operationId);
  expect(successor.data()).toMatchObject({ retryOfQueueId: operationId, runtime,
    publicContext: { operationId: current.operationId, contextRevision: 1, contextDigest: context.publicContextDigest(1), runtime } });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!.publicContext).toEqual(before[1].data!.publicContext);
  expect((await db.doc(preparationPath).get()).data()).toEqual(before[2].data);
  const accepted = await snapshot();
  await expect(retryPublicContextPublication({ firestore: db, input: { ...input, apply: true } })).rejects.toThrow("retry refused");
  expect(await snapshot()).toEqual(accepted);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
  const readback = await successorRef.get();
  expect(readback.data()).toEqual(successor.data());
  expect(readback.updateTime).toEqual(successor.updateTime);
});

it("prints credential-safe successor recovery guidance on an unconfirmed CLI outcome", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const previousExitCode = process.exitCode;
  try {
    // Emulator routing refuses before any credential read; every failure uses the same safe catch.
    await main([]);
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const message = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(message).toContain("An apply may already have committed");
    expect(message).toContain("system/publicDeployment/aggregateContexts/current");
    expect(message).toContain("cmsPublishQueue/<operationId>");
    expect(message).toContain("retryOfQueueId");
    expect(message).toContain("original --operation-id");
  } finally {
    stderr.mockRestore(); stdout.mockRestore(); process.exitCode = previousExitCode;
  }
});

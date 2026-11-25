import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { runNoBuildCloudRelease } from "../../site/scripts/no-build-cloud-release";
import { openCmsPublicationCloudTokenJournal } from "../../site/scripts/cms-publication-cloud-token-journal";
import * as sourceGuard from "../../site/scripts/cms-publication-runtime-guard";

const load = createRequire(import.meta.url);
const { assertPublicDeploymentRetiredCloudReleaseBatch } = load("../../functions/lib/public-deployment.js");
const queueId = "3440aaaaaaaaaaaaaaaa", buildBatchId = `cms-${queueId}`;
const newSha = "a".repeat(40);
const requestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${queueId}`;
const batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const journalPath = "cmsPublicationSerializerJournals/cloudflare-publisher";
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>, firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>, scratch: string, sourceCheckout: string;
const paths = [requestPath, batchPath, journalPath];
const cleanup = async () => { for (const name of paths) await firestore.doc(name).delete(); };
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use the isolated demo Firestore emulator");
  }
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT }, "release3440");
  firestore = firebaseAdminRuntime.getFirestore(app);
  scratch = await mkdtemp(path.join(tmpdir(), "release3440-"));
  sourceCheckout = path.join(scratch, "source");
  execFileSync("git", ["init", "--quiet", sourceCheckout]);
  execFileSync("git", ["-C", sourceCheckout, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Release fixture", "-c", "user.email=fixture@example.test",
    "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Synthetic release source"]);
});
beforeEach(cleanup);
afterAll(async () => { if (firestore) await cleanup(); if (app) await firebaseAdminRuntime.deleteApp(app); if (scratch) await rm(scratch, { recursive: true, force: true }); });
function documents(commitSha = newSha): Record<string, Record<string, unknown>> {
  const runtime = { owner: "cloudflare", release: commitSha };
  return {
    [requestPath]: { schemaVersion: 1, queueId, buildBatchId, runtime, commitSha,
      inputSha256: "c".repeat(64), artifactCheckpointDigest: "d".repeat(64), status: "failed", attempts: 4,
      nextAttemptAt: 0, failureReason: "PRIVATE legacy reason https://example.test/?token=fixture" },
    [batchPath]: { status: "ready", runtime, commitSha, generation: 298, reservedAgainstGeneration: 297 },
  };
}
async function seed(docs: Record<string, object> = documents()) {
  for (const [name, value] of Object.entries(docs)) await firestore.doc(name).set(value);
}
it("keeps retrying after a fifth failure, records each safe reason and caps only the pause between attempts", async () => {
  // Run the real source guard against a clean synthetic Git checkout, so
  // unrelated edits in the developer/CI checkout cannot change this stage.
  const sourceSha = execFileSync("git", ["-C", sourceCheckout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const realSourceGuard = sourceGuard.assertCmsPublicationSourceCheckout;
  const guarded = vi.spyOn(sourceGuard, "assertCmsPublicationSourceCheckout").mockImplementation(commit => realSourceGuard(commit,
    async args => execFileSync("git", ["-C", sourceCheckout, ...args], { encoding: "utf8" })));
  const docs = documents(sourceSha);
  docs[requestPath] = { ...docs[requestPath], attempts: 4, nextAttemptAt: Date.now() - 1000 };
  await seed(docs);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = async () => {
    const started = Date.now();
    await runNoBuildCloudRelease({ firestore, serializerId: "cloudflare-publisher", commitSha: sourceSha,
      stateDirectory: scratch, cloudflareApiToken: "fixture-token", previewStorageCredential: {} as never,
      storage: { readInput: async () => { throw Object.assign(new Error("PRIVATE Authorization Bearer fixture https://example.test/?token=fixture provider body"), { status: 403 }); } } as never });
    return { started, finished: Date.now(), failed: (await firestore.doc(requestPath).get()).data()! };
  };
  try {
    // The fifth failure stays retryable after the old 16-minute backoff step.
    let { started, finished, failed } = await run();
    expect(failed).toMatchObject({ status: "failed", attempts: 5 });
    expect(failed.nextAttemptAt).toBeGreaterThanOrEqual(started + 16 * 60_000);
    expect(failed.nextAttemptAt).toBeLessThanOrEqual(finished + 16 * 60_000);
    expect(failed.failureReason).toMatch(/^input read:/); expect(failed.failureReason).toContain("HTTP 403");
    expect(failed.failureReason).not.toContain("exhausted");
    expect(failed.failureReason.length).toBeLessThanOrEqual(300);
    expect(failed.failureReason).not.toMatch(/PRIVATE|Authorization|Bearer|https?:|token=|provider body/);
    expect(logged.mock.calls).toEqual([[failed.failureReason]]);
    // A later failure is retried again; its pause is capped at 30 minutes.
    await firestore.doc(requestPath).update({ attempts: 9, nextAttemptAt: Date.now() - 1000 });
    ({ started, finished, failed } = await run());
    expect(failed).toMatchObject({ status: "failed", attempts: 10, failureReason: expect.stringMatching(/^input read:/) });
    expect(failed.nextAttemptAt).toBeGreaterThanOrEqual(started + 30 * 60_000);
    expect(failed.nextAttemptAt).toBeLessThanOrEqual(finished + 30 * 60_000);
    expect(logged).toHaveBeenCalledTimes(2);
    expect((await firestore.doc(journalPath).get()).exists).toBe(true);
  } finally { logged.mockRestore(); guarded.mockRestore(); }
});
it("clears the previous failure reason when the retained batch is already deployed without another provider call", async () => {
  await seed(); await firestore.doc(batchPath).update({ status: "deployed" });
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloudflare-publisher", runtime: { owner: "cloudflare", release: newSha } });
  await journal.reserve({ queueId, buildBatchId, commitSha: newSha });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runNoBuildCloudRelease({ firestore, serializerId: "cloudflare-publisher", commitSha: newSha,
      stateDirectory: scratch, cloudflareApiToken: "fixture-token", previewStorageCredential: {} as never,
      storage: { readInput: async () => { throw new Error("The deployed release must not read storage"); } } as never });
    expect((await firestore.doc(requestPath).get()).data()).toMatchObject({ status: "deployed", nextAttemptAt: null, failureReason: null });
    expect(logged).not.toHaveBeenCalled();
    expect(await journal.read()).toBeNull();
  } finally { logged.mockRestore(); }
});

const nextQueueId = "3440bbbbbbbbbbbbbbbb";
const pointerPath = "system/publicDeployment";
const nextRequestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${nextQueueId}`;
const nextBatchPath = `system/publicDeployment/buildBatches/cms-${nextQueueId}`;
const oldSha = "b".repeat(40);
const at = (millis: number) => firebaseAdminRuntime.Timestamp.fromMillis(millis);
paths.push(pointerPath, nextRequestPath, nextBatchPath, `${batchPath}/candidates/worker`);
function reservation(id: string, generation: number) {
  return { schemaVersion: 1, buildBatchId: `cms-${id}`, status: "reserved", runtime: { owner: "cloudflare", release: newSha }, commitSha: newSha,
    generation, reservedAgainstGeneration: 318, reservedAgainstCommitSha: oldSha, reservedAgainstDeploymentId: "deployment-318",
    cutoffAt: at(1_700_000_000_000), reservedAt: at(1_700_000_000_000) };
}
async function seedReserved(request: object = {}) {
  await seed({ [requestPath]: { ...documents()[requestPath], attempts: 1, nextAttemptAt: 0, failureReason: null, ...request },
    [batchPath]: reservation(queueId, 320),
    [pointerPath]: { state: "idle", activeCommitSha: oldSha, activeGeneration: 318, activeDeploymentId: "deployment-318", lastReservedGeneration: 321 } });
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloudflare-publisher", runtime: { owner: "cloudflare", release: newSha } });
  await journal.reserve({ queueId, buildBatchId, commitSha: newSha });
  return journal;
}
const runRelease = (readInput: () => Promise<Buffer | null>) => runNoBuildCloudRelease({ firestore, serializerId: "cloudflare-publisher",
  commitSha: newSha, stateDirectory: scratch, cloudflareApiToken: "fixture-token", previewStorageCredential: {} as never, storage: { readInput } as never });
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const guarded = vi.spyOn(sourceGuard, "assertCmsPublicationSourceCheckout").mockResolvedValue(undefined as never);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try { return await work(); } finally { logged.mockRestore(); guarded.mockRestore(); }
}

it.each([["a due request", {}], ["a request the removed attempt limit parked", { attempts: 4, nextAttemptAt: null }]])(
  "settles refused sealed bytes for %s and lets the next release start", async (_label, request) => quietly(async () => {
    const journal = await seedReserved(request);
    await runRelease(async () => Buffer.from("other bytes"));
    expect((await firestore.doc(requestPath).get()).data()).toMatchObject({ status: "failed", nextAttemptAt: null,
      failureReason: expect.stringMatching(/^input read:/), refusalReceipt: { reason: "cloud_release_input_refused" } });
    const retired = (await firestore.doc(batchPath).get()).data();
    expect(assertPublicDeploymentRetiredCloudReleaseBatch(retired, buildBatchId)).toEqual(retired);
    expect(await journal.read()).toBeNull();
    await seed({ [nextRequestPath]: { ...documents()[requestPath], queueId: nextQueueId, buildBatchId: `cms-${nextQueueId}`, attempts: 0,
      status: "pending", failureReason: null }, [nextBatchPath]: reservation(nextQueueId, 321) });
    const read = vi.fn(async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); });
    await runRelease(read);
    expect(read).toHaveBeenCalledWith(nextQueueId);
    expect((await journal.read())?.queueId).toBe(nextQueueId);
  }));

it.each([["has no sealed proof", {}], ["carries a malformed proof", { proof: { schemaVersion: 1, preparationId: "other" } }]])(
  "settles a prepared release that %s and lets the next release take the journal", async (_label, documents: { proof?: object }) => quietly(async () => {
    const journal = await seedReserved({ preparationId: queueId, preparedArtifact: {} });
    const entry = `system/publicReleasePreparations/entries/${queueId}`;
    if (documents.proof) await seed({ [`${entry}/proofs/complete`]: documents.proof });
    await runRelease(async () => { throw new Error("A prepared release must not read its input"); });
    await firestore.doc(`${entry}/proofs/complete`).delete();
    expect((await firestore.doc(requestPath).get()).data()).toMatchObject({ status: "failed", nextAttemptAt: null,
      failureReason: expect.stringMatching(/^release verification:/), refusalReceipt: { reason: "cloud_release_input_refused" } });
    expect((await firestore.doc(batchPath).get()).data()).toMatchObject({ status: "retired" });
    const { job } = await journal.reserve({ queueId: nextQueueId, buildBatchId: `cms-${nextQueueId}`, commitSha: newSha });
    expect(job.queueId).toBe(nextQueueId);
  }));

it.each([["a provider failure", { status: "reserved" }, async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); }],
  ["an uncertain activation", { status: "reconciling" }, async () => Buffer.from("other bytes")]])(
  "keeps the journal and the request retryable after %s", async (_label, batch, readInput) => quietly(async () => {
    const journal = await seedReserved();
    await firestore.doc(batchPath).update(batch);
    await runRelease(readInput as () => Promise<Buffer | null>);
    const request = (await firestore.doc(requestPath).get()).data()!;
    expect(request.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(request.refusalReceipt).toBeUndefined();
    expect((await journal.read())?.queueId).toBe(queueId);
    expect((await firestore.doc(batchPath).get()).data()).toMatchObject(batch);
  }));

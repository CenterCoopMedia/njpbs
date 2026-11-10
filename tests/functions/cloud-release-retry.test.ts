import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { retryCmsPublicationCloudRelease } from "../../site/scripts/stage-cms-publication-cloud-release";
import { runNoBuildCloudRelease } from "../../site/scripts/no-build-cloud-release";
import { openCmsPublicationCloudTokenJournal } from "../../site/scripts/cms-publication-cloud-token-journal";
import * as sourceGuard from "../../site/scripts/cms-publication-runtime-guard";

const queueId = "3440aaaaaaaaaaaaaaaa", buildBatchId = `cms-${queueId}`;
const newSha = "a".repeat(40), oldSha = "b".repeat(40), retryAt = 1791948000000;
const requestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${queueId}`;
const batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const pointerPath = "system/publicDeployment", runtimePath = "system/cmsPublicationRuntime";
const journalPath = "cmsPublicationSerializerJournals/cloudflare-publisher";
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>, firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>, scratch: string, sourceCheckout: string;
const paths = [requestPath, batchPath, pointerPath, runtimePath, journalPath];
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
      nextAttemptAt: null, failureReason: "PRIVATE legacy reason https://example.test/?token=fixture" },
    [batchPath]: { status: "ready", runtime, commitSha, generation: 298, reservedAgainstGeneration: 297 },
    [pointerPath]: { state: "idle", activeCommitSha: oldSha, activeGeneration: 297,
      newestEligibleBuildBatchId: buildBatchId, newestEligibleGeneration: 298 },
    [runtimePath]: { phase: "paused", commitSha, cloud: { phase: "paused", commitSha, serializerId: "cloudflare-publisher" } },
  };
}
async function seed(docs: Record<string, object> = documents()) {
  for (const [name, value] of Object.entries(docs)) await firestore.doc(name).set(value);
}
const retry = (apply = false) => retryCmsPublicationCloudRelease({ firestore, queueId, commitSha: newSha, oldCommitSha: oldSha, apply, now: () => retryAt });
const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async name => [name, (await firestore.doc(name).get()).data()])));

it("defaults to a read-only checked proposal and applies only the four reviewed request fields", async () => {
  await seed(); const before = await snapshot();
  const dry = await retry();
  expect(dry).toMatchObject({ written: false, dryRun: true, generation: 298, activeGeneration: 297,
    before: { status: "failed", attempts: 4, nextAttemptAt: null },
    after: { status: "pending", attempts: 0, nextAttemptAt: retryAt, failureReason: null } });
  expect(JSON.stringify(dry)).not.toMatch(/PRIVATE|token=|legacy reason/);
  expect(await snapshot()).toEqual(before);
  expect(await retry(true)).toMatchObject({ written: true, dryRun: false });
  const after = await snapshot();
  expect(after[requestPath]).toEqual({ ...before[requestPath], status: "pending", attempts: 0, nextAttemptAt: retryAt, failureReason: null });
  for (const name of [batchPath, pointerPath, runtimePath, journalPath]) expect(after[name]).toEqual(before[name]);
  await expect(retry(true)).rejects.toThrow("exhausted failed state");
});
it.each([requestPath, batchPath, pointerPath, runtimePath])("refuses a missing %s without writing", async name => {
  await seed(); await firestore.doc(name).delete(); const before = await snapshot();
  await expect(retry(true)).rejects.toThrow("required cloud release document"); expect(await snapshot()).toEqual(before);
});

// The operator task's independent fences: request ownership/exhaustion/digests,
// ready batch, idle predecessor/newest eligibility and both paused source pins.
const refusals: [string, string, object][] = [
  ["request schema", requestPath, { schemaVersion: 2 }], ["request operation", requestPath, { queueId: "other" }],
  ["request batch", requestPath, { buildBatchId: "other" }],
  ["request owner", requestPath, { runtime: { owner: "node-compute", release: newSha } }],
  ["request release", requestPath, { runtime: { owner: "cloudflare", release: oldSha } }],
  ["request commit", requestPath, { commitSha: oldSha }], ["pending request", requestPath, { status: "pending" }],
  ["deployed request", requestPath, { status: "deployed" }], ["not exhausted", requestPath, { attempts: 3 }],
  ["over budget", requestPath, { attempts: 5 }], ["scheduled request", requestPath, { nextAttemptAt: retryAt }],
  ["input digest", requestPath, { inputSha256: "bad" }], ["checkpoint digest", requestPath, { artifactCheckpointDigest: "D".repeat(64) }],
  ["reserved batch", batchPath, { status: "reserved" }], ["deployed batch", batchPath, { status: "deployed" }],
  ["batch commit", batchPath, { commitSha: oldSha }], ["batch owner", batchPath, { runtime: { owner: "node-compute", release: newSha } }],
  ["batch release", batchPath, { runtime: { owner: "cloudflare", release: oldSha } }], ["invalid generation", batchPath, { generation: 0 }],
  ["noninteger generation", batchPath, { generation: 298.5 }], ["busy pointer", pointerPath, { state: "acquired" }],
  ["uncertain pointer", pointerPath, { state: "reconciling" }], ["new active source", pointerPath, { activeCommitSha: newSha }],
  ["different newest batch", pointerPath, { newestEligibleBuildBatchId: "cms-other" }],
  ["different newest generation", pointerPath, { newestEligibleGeneration: 299 }],
  ["different predecessor generation", pointerPath, { activeGeneration: 296 }],
  ["different reservation predecessor", batchPath, { reservedAgainstGeneration: 296 }],
  ["negative active generation", pointerPath, { activeGeneration: -1 }],
  ["unpaused publishing", runtimePath, { phase: "ready" }],
  ["unpaused cloud", runtimePath, { cloud: { phase: "ready", commitSha: newSha, serializerId: "cloudflare-publisher" } }],
  ["different common pin", runtimePath, { commitSha: oldSha }],
  ["different cloud pin", runtimePath, { cloud: { phase: "paused", commitSha: oldSha, serializerId: "cloudflare-publisher" } }],
  ["different cloud serializer", runtimePath, { cloud: { phase: "paused", commitSha: newSha, serializerId: "cloudflare-dev-publisher" } }],
  ["missing cloud control", runtimePath, { cloud: null }],
];
it.each(refusals)("refuses %s and preserves every document", async (_label, name, change) => {
  await seed(); await firestore.doc(name).update(change); const before = await snapshot();
  await expect(retry(true)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});

it("records a real failed attempt's safe input-read reason, logs exactly that reason and clears it on a reviewed retry", async () => {
  // Run the real source guard against a clean synthetic Git checkout, so
  // unrelated edits in the developer/CI checkout cannot change this stage.
  const sourceSha = execFileSync("git", ["-C", sourceCheckout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const realSourceGuard = sourceGuard.assertCmsPublicationSourceCheckout;
  const guarded = vi.spyOn(sourceGuard, "assertCmsPublicationSourceCheckout").mockImplementation(commit => realSourceGuard(commit,
    async args => execFileSync("git", ["-C", sourceCheckout, ...args], { encoding: "utf8" })));
  const docs = documents(sourceSha);
  docs[requestPath] = { ...docs[requestPath], attempts: 3, nextAttemptAt: Date.now() - 1000 };
  await seed(docs);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runNoBuildCloudRelease({ firestore, serializerId: "cloudflare-publisher", commitSha: sourceSha,
      stateDirectory: scratch, cloudflareApiToken: "fixture-token", previewStorageCredential: {} as never,
      storage: { readInput: async () => { throw Object.assign(new Error("PRIVATE Authorization Bearer fixture https://example.test/?token=fixture provider body"), { status: 403 }); } } as never });
    const failed = (await firestore.doc(requestPath).get()).data()!;
    expect(failed).toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null });
    expect(failed.failureReason).toMatch(/^input read:/); expect(failed.failureReason).toContain("HTTP 403");
    expect(failed.failureReason).toContain("Automatic retry attempts exhausted");
    expect(failed.failureReason.length).toBeLessThanOrEqual(300);
    expect(failed.failureReason).not.toMatch(/PRIVATE|Authorization|Bearer|https?:|token=|provider body/);
    expect(logged.mock.calls).toEqual([[failed.failureReason]]);
    await retryCmsPublicationCloudRelease({ firestore, queueId, commitSha: sourceSha, oldCommitSha: oldSha, apply: true, now: () => retryAt });
    expect((await firestore.doc(requestPath).get()).data()).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: retryAt, failureReason: null });
    expect((await firestore.doc(journalPath).get()).exists).toBe(true);
  } finally { logged.mockRestore(); guarded.mockRestore(); }
});
it.each(["pending", "failed"].flatMap(status => ["reserved", "ready", "reconciling"].flatMap(batchStatus =>
  ["deployed", "failed"].map(terminalStatus => [status, batchStatus, terminalStatus]))))(
  "annotates an older exhausted %s request with a %s batch, then settles as %s", async (status, batchStatus, terminalStatus) => {
  const docs = documents();
  docs[requestPath] = { ...docs[requestPath], status, nextAttemptAt: 0 };
  docs[batchPath] = { ...docs[batchPath], status: batchStatus };
  if (batchStatus === "reconciling") docs[pointerPath] = { ...docs[pointerPath], state: "reconciling", lease: { retained: "fixture-lease" } };
  await seed(docs);
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloudflare-publisher", runtime: { owner: "cloudflare", release: newSha } });
  await journal.reserve({ queueId, buildBatchId, commitSha: newSha });
  const before = await snapshot();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = () => runNoBuildCloudRelease({ firestore, serializerId: "cloudflare-publisher", commitSha: newSha,
    stateDirectory: scratch, cloudflareApiToken: "fixture-token", previewStorageCredential: {} as never,
    storage: { readInput: async () => { throw new Error("Exhaustion must not touch storage"); } } as never });
  try {
    await run();
    const after = await snapshot();
    expect(after[requestPath]).toEqual({ ...before[requestPath], status: "failed", nextAttemptAt: null,
      failureReason: expect.stringContaining(batchStatus === "reconciling"
        ? "exhausted while activation remains nonterminal" : "exhausted without a terminal result") });
    if (batchStatus !== "reconciling") expect(after[requestPath]!.failureReason).not.toContain("activation");
    for (const name of [batchPath, pointerPath, runtimePath, journalPath]) expect(after[name]).toEqual(before[name]);
    expect(logged.mock.calls).toEqual([[after[requestPath]!.failureReason]]);
    await run();
    expect(await snapshot()).toEqual(after);
    expect(logged).toHaveBeenCalledOnce();
    await firestore.doc(batchPath).update({ status: terminalStatus });
    await run();
    const settled = (await firestore.doc(requestPath).get()).data()!;
    expect(settled).toMatchObject({ status: terminalStatus, nextAttemptAt: null, failureReason: terminalStatus === "failed"
      ? expect.stringContaining("failed terminal batch") : null });
    if (terminalStatus === "failed") expect(settled.failureReason).not.toMatch(/remains nonterminal|without a terminal result|Retain the original journal/);
    expect(await journal.read()).toBeNull();
  } finally { logged.mockRestore(); }
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

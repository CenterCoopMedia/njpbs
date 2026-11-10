import { beforeAll, beforeEach, expect, it } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import dev from "../../scripts/lib/dev-publication.cjs";
import deployment from "../../functions/lib/public-deployment.js";
import target from "../../functions/lib/publication-target.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import contract from "../../functions/lib/dev-publication-preupload.js";
import { runDevPreuploadSettlement } from "../../scripts/settle-dev-preupload-failure.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordedDevPreuploadSourceBlob as readSourceBlob, devPreuploadRetryFixture } from "../helpers/dev-preupload-sources.js";

// Synthetic code-refresh identities preserve native shapes; no live SDK read
// or credential is used by these emulator cases.
const identity = { queueId: "e8a1597005e84ced55ee", buildBatchId: "cms-e8a1597005e84ced55ee",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const request = { schemaVersion: 1, target: target.publicationTarget("development"), identity, generation: 122,
  inputDigest: "f".repeat(64), failure: { runId: "1001", runAttempt: 1, jobId: "2001",
    completedAt: "2026-10-31T20:37:11Z", code: "retained_dev_renderer_source_differs", logDigest: "e".repeat(64) } };
const paths = { queue: `cmsPublishQueue/${identity.queueId}`, batch: `system/publicDeployment/buildBatches/${identity.buildBatchId}` };
paths.input = `${paths.batch}/inputs/devFrozen`; paths.receipt = `${paths.batch}/retirements/devPreupload`;
let db;
beforeAll(() => { db = isolatedFirestore("dev-preupload-settlement"); });
const read = async path => (await db.doc(path).get()).data();
const snapshots = async () => Object.fromEntries(await Promise.all(Object.entries({ ...paths, pointer: "system/publicDeployment" })
  .map(async ([key, path]) => [key, await read(path)])));
const settle = (value = request, options) => dev.settleDevPreuploadFailure(db, value, options);
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 121, lastReservedGeneration: 121, newestEligibleGeneration: 121,
    activeDeploymentId: "11111111-2222-4333-8444-555555555555", activeCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
    newestEligibleBuildBatchId: "cms-PPPPPPPPPPPPPPPPPPPP" });
  await db.doc(paths.queue).set({ status: "pending", transport: "github", environment: "development", projectId: "njpbs-site-dev",
    triggeredBy: "dev-code-refresh", triggeredByEmail: null, triggeredAt: Timestamp.fromDate(new Date("2026-10-31T20:30:20Z")),
    completedAt: null, error: null, changes: [], runtime: { owner: "cloudflare", release: identity.commitSha } });
  // Exercise the existing reservation/input writers, rather than hand-making
  // the batch or artifactBuild shapes the new owner must consume.
  await dev.reserveDevPublication(db, identity);
  await dev.recordDevInputs(db, identity, request.inputDigest);
  // The process clock is later than the historical failure. Bind its recorded
  // timestamps to the actual failed-run window at this clock boundary.
  const reservedAt = Timestamp.fromDate(new Date("2026-10-31T20:30:22Z"));
  await db.doc(paths.batch).update({ cutoffAt: reservedAt, reservedAt });
  await db.doc(paths.queue).update({ "artifactBuild.cutoffAt": reservedAt });
  await db.doc(paths.input).update({ recordedAt: Timestamp.fromDate(new Date("2026-10-31T20:30:50Z")) });
});

it("settles the exact reserved attempt as failed/not-published, preserves evidence, and is immutable on repeat", async () => {
  const before = await snapshots();
  expect(await dev.finishDevPublication(db, identity)).toBe("unclaimed");
  const receipt = await settle();
  const after = await snapshots();
  expect(receipt).toMatchObject({ reason: "dev_publish_failed_before_upload", outcome: "failed_not_published", request });
  expect(after.pointer).toEqual(before.pointer);
  expect(after.input).toEqual(before.input);
  expect(after.batch).toEqual({ ...before.batch, status: "retired", retiredAt: receipt.retiredAt,
    retirementReceipt: Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "retiredAt")) });
  expect(after.queue).toMatchObject({ ...before.queue, status: "failed", error: "Retained dev renderer source differs",
    completedAt: receipt.retiredAt, preUploadFailureReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await settle()).toEqual(receipt);
  expect(await settle(request, { readOnly: true })).toEqual(receipt);
  expect(await snapshots()).toEqual(after);
  expect((await dev.readDevPublication(db, identity)).batch.status).toBe("retired");
  expect(await dev.finishDevPublication(db, identity)).toBe("unclaimed");
  expect(() => contract.assertDevPreuploadRetiredBatch(after.batch, identity.buildBatchId)).not.toThrow();
});

it("settles an old never-uploaded reservation after a distinct newer generation succeeds, preserving the newer site", async () => {
  await db.doc("system/publicDeployment").update({ activeGeneration: 123, lastReservedGeneration: 123,
    newestEligibleGeneration: 123, newestEligibleBuildBatchId: "cms-ZZZZZZZZZZZZZZZZZZZZ",
    activeCommitSha: "c".repeat(40), activeDeploymentId: "33333333-2222-4333-8444-555555555555" });
  const before = await snapshots();
  const receipt = await settle();
  expect(receipt).toMatchObject({ outcome: "failed_not_published", request: { generation: 122 } });
  expect(await read("system/publicDeployment")).toEqual(before.pointer);
  expect(await read(paths.input)).toEqual(before.input);
  expect(await settle()).toEqual(receipt);
});

it.each(["active", "eligible", "selected batch"])("refuses an apparently %s target even with a reserved row", async mode => {
  const pointer = await read("system/publicDeployment");
  await db.doc("system/publicDeployment").set({ ...pointer, newestEligibleGeneration: 123,
    lastReservedGeneration: 123, newestEligibleBuildBatchId: "cms-ZZZZZZZZZZZZZZZZZZZZ",
    ...(mode === "active" ? { activeGeneration: 122 } : {}),
    ...(mode === "eligible" ? { newestEligibleGeneration: 122, newestEligibleBuildBatchId: identity.buildBatchId } : {}),
    ...(mode === "selected batch" ? { newestEligibleBuildBatchId: identity.buildBatchId } : {}) });
  const before = await snapshots();
  await expect(settle()).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
});

it.each([
  ["candidate", () => db.doc(`${paths.batch}/candidates/worker`).set({ workerVersionId: "real-upload-may-exist" })],
  ["media staging", () => db.doc(`${paths.batch}/manifests/publicMedia`).set({ status: "staged" })],
  ["orphan media verification", () => db.doc(`${paths.batch}/manifests/publicMedia/verifications/complete`).set({ status: "ready" })],
  ["ready batch", () => db.doc(paths.batch).update({ status: "ready", readyAt: Timestamp.now() })],
  ["lease on reserved batch", () => db.doc(paths.batch).update({ leaseToken: "uncertain" })],
  ["live root lease", async () => {
    const pointer = await read("system/publicDeployment");
    await db.doc("system/publicDeployment").set({ ...pointer, state: "deploying", newestEligibleGeneration: 122,
      newestEligibleBuildBatchId: identity.buildBatchId, candidateGeneration: 122, candidateBuildBatchId: identity.buildBatchId,
      candidateCommitSha: identity.commitSha, leaseToken: "live-lease", leaseAcquiredAt: Timestamp.now(),
      predecessorGeneration: pointer.activeGeneration, predecessorDeploymentId: pointer.activeDeploymentId,
      predecessorCommitSha: pointer.activeCommitSha });
  }],
  ["publishing queue", () => db.doc(paths.queue).update({ status: "publishing" })],
  ["claimed queue", () => db.doc(paths.queue).update({ claim: "live-owner" })],
  ["deployment claim", () => db.doc(paths.queue).update({ deploymentClaim: { status: "started" } })],
  ["editorial queue", () => db.doc(paths.queue).update({ changes: [{ collection: "cmsPages", id: "home", sourceVersion: 1 }] })],
  ["serializer queue", () => db.doc(paths.queue).update({ transport: "serializer" })],
  ["production queue", () => db.doc(paths.queue).update({ environment: "production", projectId: "njpbs-site" })],
  ["other queue generation", () => db.doc(paths.queue).update({ "artifactBuild.generation": 123 })],
  ["other batch generation", () => db.doc(paths.batch).update({ generation: 123 })],
  ["other source", () => db.doc(paths.batch).update({ commitSha: "b".repeat(40) })],
  ["unknown batch field", () => db.doc(paths.batch).update({ uploadStarted: true })],
  ["missing input", () => db.doc(paths.input).delete()],
  ["missing queue", () => db.doc(paths.queue).delete()],
  ["missing batch", () => db.doc(paths.batch).delete()],
  ["changed input", () => db.doc(paths.input).update({ inputDigest: "d".repeat(64) })],
  ["input after failure", () => db.doc(paths.input).update({ recordedAt: Timestamp.now() })],
  ["legacy journal", () => db.doc("system/devPublication").set({ state: "idle" })],
  ["release writer", () => db.doc("system/publicDeployment/releaseWriter/fence").set({ schemaVersion: 2, operationId: "install", attemptDigest: "d".repeat(64) })],
  ["partial receipt", () => db.doc(paths.receipt).set({ outcome: "failed_not_published" })],
])("refuses %s without changing queue, batch, input or pointer", async (_name, mutate) => {
  await mutate();
  const before = await snapshots();
  await expect(settle()).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
});

it.each(["queue", "generation", "input", "run", "attempt", "production", "database"])("refuses a mismatched %s request", async mode => {
  const value = structuredClone(request), before = await snapshots();
  if (mode === "queue") value.identity.queueId = "Z".repeat(20);
  if (mode === "generation") value.generation++;
  if (mode === "input") value.inputDigest = "d".repeat(64);
  if (mode === "run") value.failure.runId = "41239189108";
  if (mode === "attempt") value.failure.runAttempt = 3;
  if (mode === "production") value.target = target.publicationTarget("production");
  await expect(mode === "database" ? dev.settleDevPreuploadFailure({ projectId: "njpbs-site" }, value) : settle(value)).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
});

it.each(["receipt", "queue", "input", "batch", "different failure"])("refuses changed %s after settlement", async mode => {
  await settle();
  const value = structuredClone(request);
  if (mode === "receipt") await db.doc(paths.receipt).update({ outcome: "deployed" });
  if (mode === "queue") await db.doc(paths.queue).update({ triggeredBy: "another-run" });
  if (mode === "input") await db.doc(paths.input).update({ recordedAt: Timestamp.now() });
  if (mode === "batch") await db.doc(paths.batch).update({ reservedAt: Timestamp.now() });
  if (mode === "different failure") value.failure.jobId = "124650687341";
  const before = await snapshots();
  await expect(settle(value)).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
});

it("readback cannot write a missing receipt", async () => {
  const before = await snapshots();
  await expect(settle(request, { readOnly: true })).rejects.toThrow();
  expect(await snapshots()).toEqual(before);
});

it("the existing dev pause/history census recognizes the native retirement and rejects a forged receipt", async () => {
  await settle();
  const attempt = { oldRuntime: { commitSha: identity.commitSha, serializerId: "original-primary",
    cloud: { serializerId: "cloudflare-dev-publisher" } } };
  const census = () => db.runTransaction(transaction => pause.recoveryInternals.drain(db, transaction, attempt, true), { readOnly: true });
  expect(await census()).toMatchObject({ queues: 1, batches: 1, retiredBatches: 1 });
  await db.doc(paths.batch).update({ "retirementReceipt.request.generation": FieldValue.increment(1) });
  await expect(census()).rejects.toThrow();
});

it("runs packet plan/apply/readback through the actual operator into the isolated SDK, with no credential file", async () => {
  // Like the real operator, this case requires a clean committed source tree.
  // Only its credential/SDK and GitHub network boundaries are replaced.
  const directory = await mkdtemp(join(tmpdir(), "dev-preupload-packet-"));
  try {
    const log = Buffer.from("2026-10-31T20:37:07.3818223Z Retained dev renderer source differs\n");
    const value = structuredClone(request); value.failure.logDigest = createHash("sha256").update(log).digest("hex");
    const packet = { schemaVersion: 1, kind: "dev-preupload-settlement",
      operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), request: value,
      credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com",
        privateKeyId: "b".repeat(40), secretRef: "pass://fixture/njpbs-site-dev/seed-writer" } };
    const bytes = JSON.stringify(packet), filename = join(directory, "packet.json");
    await writeFile(filename, bytes);
    const args = ["--packet", filename, "--packet-digest", createHash("sha256").update(bytes).digest("hex")];
    const run = { id: 1001, run_attempt: 1, status: "completed", conclusion: "failure", event: "push",
      path: ".github/workflows/cms-dev-publish.yml", head_branch: "main", head_sha: identity.commitSha,
      repository: { full_name: "CenterCoopMedia/njpbs" }, head_repository: { full_name: "CenterCoopMedia/njpbs" },
      actor: { login: "fixture-user" }, triggering_actor: { login: "fixture-user" } };
    const github = async path => {
      if (path.endsWith("/logs")) return log;
      if (path.includes("/jobs?")) return { total_count: 1, jobs: [{ id: 2001, run_id: run.id, run_attempt: 1,
        head_sha: identity.commitSha, name: "finalize", status: "completed", conclusion: "failure", completed_at: value.failure.completedAt,
        steps: [{ number: 10, name: "Upload only to dev, verify receipts, and settle dev queue", conclusion: "failure" },
          { number: 11, conclusion: "success" }] }] };
      if (path.includes("/runs?status=")) return { total_count: 0 };
      if (path.startsWith("environments/")) return null;
      if (path.startsWith("actions/variables/")) return { value: "false" };
      return run;
    };
    const openSdk = async () => ({ firestore: db, close: async () => {} });
    const before = await snapshots();
    const plan = JSON.parse(execFileSync(process.execPath, ["scripts/settle-dev-preupload-failure.mjs", ...args], { encoding: "utf8" }));
    expect(plan).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0 });
    expect(await snapshots()).toEqual(before);
    const first = await runDevPreuploadSettlement([...args, "--apply"], { openSdk, github, readSourceBlob });
    const receiptTime = (await db.doc(paths.receipt).get()).updateTime;
    expect(first.receipt).toMatchObject({ outcome: "failed_not_published", request: value });
    expect((await runDevPreuploadSettlement([...args, "--apply"], { openSdk, github, readSourceBlob })).receipt).toEqual(first.receipt);
    expect((await db.doc(paths.receipt).get()).updateTime).toEqual(receiptTime);
    expect((await runDevPreuploadSettlement([...args, "--readback"], { openSdk })).receipt).toEqual(first.receipt);
    const bad = join(directory, "bad.json"), badBytes = JSON.stringify({ ...packet, credential: "synthetic-sensitive-sentinel" });
    await writeFile(bad, badBytes);
    try {
      execFileSync(process.execPath, ["scripts/settle-dev-preupload-failure.mjs", "--packet", bad, "--packet-digest",
        createHash("sha256").update(badBytes).digest("hex"), "--apply"], { stdio: ["ignore", "pipe", "pipe"] });
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error.status).toBe(1);
      expect(error.stdout.toString()).toBe("");
      expect(error.stderr.toString()).toBe('{"status":"refused","code":"dev-preupload-settlement-refused"}\n');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("settles original reservation 124 through the attempt-2 operator and preserves generation 123 and immutable history", async () => {
  const { request: value, github, skipped } = devPreuploadRetryFixture();
  const id = value.identity;
  const queuePath = `cmsPublishQueue/${id.queueId}`, batchPath = `system/publicDeployment/buildBatches/${id.buildBatchId}`;
  const inputPath = `${batchPath}/inputs/devFrozen`, receiptPath = `${batchPath}/retirements/devPreupload`;
  await db.doc("system/publicDeployment").update({ activeGeneration: 123, lastReservedGeneration: 123,
    newestEligibleGeneration: 123, newestEligibleBuildBatchId: "cms-ZZZZZZZZZZZZZZZZZZZZ",
    activeCommitSha: "cccccccccccccccccccccccccccccccccccccccc", activeDeploymentId: "33333333-2222-4333-8444-555555555555" });
  const { artifactBuild, ...unreservedQueue } = await read(paths.queue);
  await db.doc(queuePath).set({ ...unreservedQueue, runtime: { owner: "cloudflare", release: id.commitSha } });
  await dev.reserveDevPublication(db, id);
  await dev.recordDevInputs(db, id, value.inputDigest);
  const reservedAt = Timestamp.fromDate(new Date("2026-11-01T16:00:00Z"));
  await db.doc(batchPath).update({ cutoffAt: reservedAt, reservedAt });
  await db.doc(queuePath).update({ "artifactBuild.cutoffAt": reservedAt });
  await db.doc(inputPath).update({ recordedAt: Timestamp.fromDate(new Date("2026-11-01T16:00:30Z")) });
  const capture = async () => Promise.all([queuePath, batchPath, inputPath, receiptPath, "system/publicDeployment"].map(read));
  const before = await capture();
  const directory = await mkdtemp(join(tmpdir(), "dev-preupload-retry-"));
  try {
    const packet = { schemaVersion: 1, kind: "dev-preupload-settlement",
      operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), request: value,
      credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com",
        privateKeyId: "b".repeat(40), secretRef: "pass://fixture/njpbs-site-dev/seed-writer" } };
    const bytes = JSON.stringify(packet), filename = join(directory, "packet.json");
    await writeFile(filename, bytes);
    const args = ["--packet", filename, "--packet-digest", createHash("sha256").update(bytes).digest("hex")];
    let sdkOpens = 0;
    const openSdk = async () => { sdkOpens++; return { firestore: db, close: async () => {} }; };
    const plan = await runDevPreuploadSettlement(args);
    expect(plan).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0 });
    // An earlier executed step must refuse before even opening the SDK.
    skipped.jobs[0].steps.push({ number: 1, conclusion: "failure" });
    await expect(runDevPreuploadSettlement([...args, "--apply"], { openSdk, github, readSourceBlob })).rejects.toThrow();
    expect(sdkOpens).toBe(0);
    expect(await capture()).toEqual(before);
    skipped.jobs[0].steps = [];
    const { receipt } = await runDevPreuploadSettlement([...args, "--apply"], { openSdk, github, readSourceBlob });
    const after = await capture(), receiptTime = (await db.doc(receiptPath).get()).updateTime;
    expect(receipt).toMatchObject({ outcome: "failed_not_published", request: value });
    expect(after[0]).toMatchObject({ status: "failed", runtime: before[0].runtime, artifactBuild: before[0].artifactBuild });
    expect(after[1]).toEqual({ ...before[1], status: "retired", retiredAt: receipt.retiredAt,
      retirementReceipt: Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "retiredAt")) });
    expect(after[2]).toEqual(before[2]);
    expect(after[4]).toEqual(before[4]);
    expect(after[4]).toMatchObject({ activeGeneration: 123, lastReservedGeneration: 124 });
    expect((await runDevPreuploadSettlement([...args, "--apply"], { openSdk, github, readSourceBlob })).receipt).toEqual(receipt);
    expect((await runDevPreuploadSettlement([...args, "--readback"], { openSdk })).receipt).toEqual(receipt);
    expect((await db.doc(receiptPath).get()).updateTime).toEqual(receiptTime);
    expect(await capture()).toEqual(after);
    expect(await dev.finishDevPublication(db, id)).toBe("unclaimed");
    const attempt = { oldRuntime: { commitSha: id.commitSha, serializerId: "original-primary",
      cloud: { serializerId: "cloudflare-dev-publisher" } } };
    // The unrelated #4546 fixture is still reserved; inspect the shared census
    // only after retiring it through its own original request.
    await settle();
    expect(await db.runTransaction(transaction => pause.recoveryInternals.drain(db, transaction, attempt, true), { readOnly: true }))
      .toMatchObject({ queues: 2, batches: 2, retiredBatches: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

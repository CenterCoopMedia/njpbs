import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { pairFirestoreReader, readPrivatePairRecord } from "../../publisher/pair-work-reader";
import { wakePublicReleasePair } from "../../publisher/release-pair-wake";
import { startPublicReleasePairServer } from "../../site/scripts/public-release-pair-server";
import { withPublicReleasePairExecutionLease } from "../../site/scripts/public-release-pair-runtime";
import { configurePublicReleasePairPublisher } from "../../scripts/configure-public-release-pair-publisher.mjs";
import { pairSourceGitEnvironment } from "../../site/scripts/run-cms-publication-pair-cloud";
import { capturedSnapshotDigest, seedCapturedPairInput } from "../helpers/captured-public-release-pair-input.js";

let db;
const pair = releasePair();
const identity = { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment, journalNamespace: pair.publisher.journalNamespace };
const taskInput = { kind: "qualification", sourceOperationId: "operation-one", sourceVersion: 7, snapshotDigest: capturedSnapshotDigest, contextSequence: 12 };
const enqueue = async input => {
  const captured = await seedCapturedPairInput(db, pair, input);
  return db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair, input: captured.taskInput }));
};
beforeAll(() => { db = isolatedFirestore("public-release-pair-wiring.test.js"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
});
function reader() {
  // Firestore emulator's Admin bypass; the request adapter below
  // refuses every origin/project except this loopback demo database.
  return pairFirestoreReader({ projectId: db.projectId, token: "owner", request: async (url, options) => {
    const source = new URL(url);
    if (source.origin !== "https://firestore.googleapis.com" || !source.pathname.startsWith(`/v1/projects/${db.projectId}/`)) throw new Error("Only this demo project may be read");
    return fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${source.pathname}${source.search}`, options);
  } });
}

it("wakes from an actual due activation continuation after staging is gone and ignores quarantined continuations", async () => {
  const taskId = "a".repeat(64), rest = reader(), now = Date.now();
  const ref = db.doc(`${work.publicReleasePairPath(pair.pairId)}/activationPending/${taskId}`);
  await ref.create({ schemaVersion: 2, intent: { taskId }, nextAttemptAt: 0 });
  expect(await rest.hasPendingStaging(pair.pairId, now)).toBe(false);
  expect(await rest.hasPendingStaging(pair.pairId, now, "activationPending")).toBe(true);
  let started = false;
  expect(await wakePublicReleasePair({ pair, identity,
    readWork: async () => ({ taskIds: [], activationPending: await rest.hasPendingStaging(pair.pairId, now, "activationPending") }),
    start: async () => { started = true; } })).toBe(true);
  expect(started).toBe(true);
  await ref.update({ nextAttemptAt: null });
  expect(await rest.hasPendingStaging(pair.pairId, now, "activationPending")).toBe(false);
});

it("keeps credentials and Git routing overrides out of source-check subprocesses", () => {
  const projected = pairSourceGitEnvironment({ PATH: "/usr/bin", HOME: "/fixture", GIT_DIR: "/other/source",
    CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-only", ACTIVATION_TOKEN: "fixture-only", GOOGLE_APPLICATION_CREDENTIALS: "/fixture/credential" });
  expect(Object.keys(projected).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH"]);
});

it("uses actual Firestore REST serialization for the same bounded due predicate as the SDK", async () => {
  const rest = reader();
  await db.doc("system/billing").set({ disabled: false, costAmount: 1.25, budgetAmount: 0, ratio: Infinity, alertThresholdExceeded: 0.9 });
  expect(await rest.read("system/billing")).toEqual({ disabled: false });
  expect(work.publicReleasePairKey(pair.pairId)).toMatch(/^[a-f0-9]{64}$/);
  expect(await readPrivatePairRecord(rest, identity, pair.publisher.workerVersionId)).toEqual(pair);
  await expect(readPrivatePairRecord(rest, identity, "00000000-0000-4000-8000-000000000000")).rejects.toThrow("version differs");
  const { taskId } = await enqueue(taskInput);
  const now = Date.now();
  const hinted = await work.readPublicReleasePairWorkHint({ pair, read: rest.read, now,
    listDue: (field, limit) => rest.listDue(pair.pairId, field, now, limit) });
  expect(hinted).toEqual(await work.readPublicReleasePairWork({ firestore: db, pair, now }));
  expect(hinted.taskIds).toEqual([taskId]);
  const claim = await work.claimPublicReleasePairWork({ firestore: db, pair, taskId, now });
  const running = await work.readPublicReleasePairWorkHint({ pair, read: rest.read, now,
    listDue: (field, limit) => rest.listDue(pair.pairId, field, now, limit) });
  expect(running.taskIds).toEqual([]);
  await work.settlePublicReleasePairWork({ firestore: db, pair, taskId, token: claim.token, manifestDigest: "e".repeat(64), now: now + 1 });
});

it("boots an honest preflight server without an executor and cannot claim work through a flag", async () => {
  const { taskId } = await enqueue(taskInput);
  const server = await startPublicReleasePairServer({ firestore: db, pair, host: "127.0.0.1", port: 0 });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const response = await fetch(`${origin}/wake`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "waiting-for-executor", pairId: pair.pairId, executorInstalled: false, busy: false });
    expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/work/${taskId}`).get()).data().attempts).toBe(0);
    expect((await fetch(`${origin}/wake?task=other`, { method: "POST" })).status).toBe(404);
    await db.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).update({ status: "retired" });
    expect((await fetch(`${origin}/health`)).status).toBe(503);
  } finally { await server.close(); }
});

it("runs the installed private executor and keeps the original public pointer unchanged", async () => {
  const { taskId } = await enqueue(taskInput);
  let finish;
  const executed = new Promise(resolve => { finish = resolve; });
  const server = await startPublicReleasePairServer({ firestore: db, pair, host: "127.0.0.1", port: 0,
    execute: async ({ outputPrefix, identity: task }) => {
      expect(outputPrefix).toContain(`/claims/`);
      expect(task.pair.commitSha).toBe(pair.commitSha);
      finish();
      return { manifestDigest: "f".repeat(64) };
    } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address.port}/wake`, { method: "POST" });
    expect(response.status).toBe(200);
    await executed;
    await server.waitForCurrentWork();
  } finally { await server.close(); }
  expect((await db.doc(`${work.publicReleasePairPath(pair.pairId)}/work/${taskId}`).get()).data().status).toBe("complete");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(legacy.initialPublicDeploymentPointer());
  expect(await reader().hasPendingStaging(pair.pairId)).toBe(true);
});

it("clears a recovered drain failure before acknowledging and retaining the next busy task", async () => {
  const { taskId } = await enqueue(taskInput);
  const base = work.publicReleasePairPath(pair.pairId);
  let attempts = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const server = await startPublicReleasePairServer({ firestore: db, pair, host: "127.0.0.1", port: 0,
    execute: async ({ renew }) => {
      if (++attempts === 1) {
        const batch = db.batch(), expired = Date.now() - 1;
        batch.update(db.doc(`${base}/work/${taskId}`), { leaseUntil: expired });
        batch.update(db.doc(`${base}/journals/${pair.publisher.journalNamespace}`), { "job.leaseUntil": expired });
        await batch.commit();
        await renew();
      }
      markStarted();
      await held;
      return { manifestDigest: "e".repeat(64) };
    } });
  const origin = `http://127.0.0.1:${server.address.port}`;
  try {
    await (await fetch(`${origin}/wake`, { method: "POST" })).body.cancel();
    await server.waitForCurrentWork();
    expect((await fetch(`${origin}/health`)).status).toBe(503);
    const resumed = await fetch(`${origin}/wake`, { method: "POST" });
    expect(resumed.status).toBe(200);
    await resumed.body.cancel();
    await started;
    const busy = await fetch(`${origin}/health`);
    expect(busy.status).toBe(200);
    expect(await busy.json()).toMatchObject({ status: "ready", busy: true, failureCode: null });
    release();
    await server.waitForCurrentWork();
  } finally { release(); await server.close(); }
  expect((await db.doc(`${base}/work/${taskId}`).get()).data()).toMatchObject({ status: "complete", attempts: 2 });
});

it("stops waiting for an executor that ignores an expired lease", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let executionSignal;
  try {
    const execution = withPublicReleasePairExecutionLease({ leaseUntil: 1010,
      execute: ({ signal }) => { executionSignal = signal; return new Promise(() => {}); },
      renew: async () => ({ leaseUntil: 1020 }) });
    const refused = expect(execution).rejects.toMatchObject({ code: "lease-expired" });
    await vi.advanceTimersByTimeAsync(10);
    await refused;
    expect(executionSignal.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("constructs isolated private configs without legacy bindings or self-referential version UUIDs", () => {
  const legacyConfig = JSON.parse(readFileSync(new URL("../../publisher/wrangler.json", import.meta.url), "utf8"));
  const production = { ...pair, environment: "production" };
  const imageReference = `registry.cloudflare.com/example/pair@${pair.publisher.imageDigest}`;
  const config = configurePublicReleasePairPublisher({ pair: production, retainedPairs: [], legacyConfig, imageReference });
  expect(config.main).toMatch(/\/publisher\/pair-worker\.ts$/);
  expect(config.containers[0]).toMatchObject({ name: pair.publisher.application, image: imageReference, max_instances: 1, class_name: "PairPublicationRuntime" });
  expect(config.durable_objects.bindings).toEqual([{ name: "PAIR_PUBLISHER", class_name: "PairPublicationRuntime" }]);
  expect(config.secrets.required).toEqual(["FIREBASE_SERVICE_ACCOUNT"]);
  expect(config.vars.PAIR_EXECUTOR_READY).toBe("false");
  const enabled = configurePublicReleasePairPublisher({ pair: production, retainedPairs: [], legacyConfig, imageReference, executorReady: true });
  expect(enabled.vars.PAIR_EXECUTOR_READY).toBe("true");
  expect({ ...enabled, vars: { ...enabled.vars, PAIR_EXECUTOR_READY: "false" } }).toEqual(config);
  for (const executorReady of ["true", 1, null, [true]]) {
    expect(() => configurePublicReleasePairPublisher({ pair: production, retainedPairs: [], legacyConfig, imageReference, executorReady })).toThrow("readiness must be explicit");
  }
  expect(config.routes).toEqual([]);
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.r2_buckets).toEqual([{ binding: "PAIR_CONTENT", bucket_name: legacyConfig.r2_buckets[0].bucket_name }]);
  expect(config).not.toHaveProperty("migrations");
  const reassigned = { ...production, publisher: { ...production.publisher, workerVersionId: "00000000-0000-4000-8000-000000000000" } };
  expect(configurePublicReleasePairPublisher({ pair: reassigned, retainedPairs: [], legacyConfig, imageReference })).toEqual(config);
  expect(configurePublicReleasePairPublisher({ pair: reassigned, retainedPairs: [], legacyConfig, imageReference, executorReady: true })).toEqual(enabled);
  expect(() => configurePublicReleasePairPublisher({ pair: production, retainedPairs: [], legacyConfig, imageReference: "mutable:latest" })).toThrow();
  const dockerfile = readFileSync(new URL("../../publisher/Dockerfile.pair", import.meta.url), "utf8");
  expect(dockerfile).toContain("run-cms-publication-pair-cloud.ts");
  expect(dockerfile).not.toContain("run-cms-publication-cloud.ts");
});

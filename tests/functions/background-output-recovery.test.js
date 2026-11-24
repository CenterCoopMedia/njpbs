import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { Timestamp } from "firebase-admin/firestore";
import background from "../../functions/lib/post-background-outputs.js";
import publication from "../../functions/lib/public-context-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import work from "../../functions/lib/no-build-cloud-work.js";
import alerts from "../../functions/lib/public-context-alerts.js";
import { interruptConfirmation } from "../helpers/interrupt-confirmation.js";

const runtime = { owner: "cloudflare", release: "a".repeat(40) };
const db = isolatedFirestore("background-output-recovery.test.js");
const operationId = "A".repeat(20);
const contextDigest = context.publicContextDigest(1);
const paths = { listings: ["/posts/"], authors: ["/authors/public-author/"], feed: ["/feeds/news.xml"],
  contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"] };
const taskRef = () => db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`);
let directory;
let time;
let fault;
let duringBuild;
let builds;
let observations;

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use a local demo Firestore emulator");
  }
  directory = await mkdtemp(join(tmpdir(), "background-recovery-"));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
beforeEach(async () => {
  await Promise.all(["cmsPublishQueue", "cmsBackgroundOutputs", "cmsPosts"].map(name => db.recursiveDelete(db.collection(name))));
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await db.doc("system/cmsContextJobAlerts").delete();
  await db.doc("system/billing").delete();
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: runtime.release, activeGeneration: 1 });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: runtime.release, serializerId: "cloudflare-publisher" });
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, operationId,
      runtime, reason: "settings", contextRevision: 1 });
    accepted.write();
  });
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({ schemaVersion: 1, runtime,
    contextDigest, status: "verified", attempts: 1, preparedDigest: "e".repeat(64), admissionRevision: null,
    reservation: { commitSha: runtime.release, buildBatchId: "original", generation: 2, cutoffAt: Timestamp.fromMillis(1700000000000) } });
  time = Date.now() + 1000;
  fault = duringBuild = null;
  builds = 0;
  observations = [];
});

function owner(firestore = db) {
  return background.createPostBackgroundOutputs({ firestore, runtime, enabled: true, now: () => time,
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: {
      async put(key, bytes) { await mkdir(dirname(join(directory, key)), { recursive: true }); await writeFile(join(directory, key), bytes); },
      async get(key) {
        if (key.includes("/search/") && fault?.storage) throw Object.assign(new Error("private provider token and body"), { code: fault.storage });
        const bytes = await readFile(join(directory, key));
        return key.includes("/search/") && fault?.corrupt ? Buffer.from("corrupt") : bytes;
      },
    },
    async build(task) {
      if (task.output === "search") {
        builds++;
        await duringBuild?.();
        if (fault?.build) throw Object.assign(new Error("private provider token and body"), fault.build);
      }
      return { input: { kind: "public-background", rendererSha: runtime.release, contextDigest, routes: [] },
        assets: [], files: paths[task.output].map(path => ({ path, contentType: "text/plain", bytes: "Public fixture" })) };
    } });
}
const readWork = () => work.readNoBuildCloudWork({ runtime, now: time, read: async path => (await db.doc(path).get()).data() ?? null });
const check = send => alerts.checkPublicContextAlerts({ firestore: db, now: () => time, send, log: { error() {}, info: (_message, data) => observations.push(...data.observations) } });

it("alerts when only the video catalog fails an attempt", async () => {
  const catalog = "V".repeat(20);
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, operationId: catalog,
      runtime, reason: "provider-refresh", contextRevision: 1, videoCatalog: true });
    accepted.write();
  });
  const queue = db.doc(`cmsPublishQueue/${catalog}`);
  const batch = db.batch();
  for (const output of publication.OUTPUTS) batch.update(queue.collection("backgroundOutputs").doc(output), { status: "verified" });
  batch.update(queue.collection("backgroundOutputs").doc("videoCatalog"), { status: "failed", attempts: 4, nextAttemptAt: null,
    lastAttempt: { failureClass: "validation", retryable: false } });
  batch.update(queue, { status: "failed" });
  await batch.commit();
  const sent = [];
  await check(message => sent.push(message));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("background output videoCatalog: failed");
  expect(sent[0]).toContain("background output aggregate: failed");
});

// Four failed attempts. Each leaves its next attempt scheduled.
async function failFour() {
  const worker = owner();
  for (let attempt = 1; attempt <= 4; attempt++) {
    await worker.recover();
    if (attempt < 4) time = (await taskRef().get()).data().nextAttemptAt;
  }
  await publication.settlePublicContext({ firestore: db, operationId, runtime });
}

it("retries a transient failure past four attempts at its backoff and seals the aggregate on success", async () => {
  fault = { storage: 503 };
  await failFour();
  const failed = (await taskRef().get()).data();
  expect(failed).toMatchObject({ attempts: 4, status: "failed", nextAttemptAt: time + 480_000,
    slowRetryAt: null, lastAttempt: { failureClass: "storage_readback", retryable: true } });
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ aggregateReceipt: null });
  // Public search recovery stays paced.
  expect((await readWork()).maintenance).toBe(false);
  time = failed.nextAttemptAt - 1;
  await owner().recover();
  expect(builds).toBe(4);
  expect((await readWork()).maintenance).toBe(false);
  time++;
  expect((await readWork()).maintenance).toBe(true);
  fault = null;
  const originalPreparation = (await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).data();
  await owner().recover();
  await owner().recover();
  expect(builds).toBe(5);
  expect((await taskRef().get()).data()).toMatchObject({ attempts: 5, status: "verified", slowRetryAt: null, lastAttempt: { failureClass: null } });
  expect((await readWork()).maintenance).toBe(true); // Interrupted settlement is recoverable too.
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(true);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", aggregateReceipt: { contextDigest } });
  expect((await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).data()).toEqual(originalPreparation);
  const attempts = await taskRef().collection("attempts").get();
  expect(attempts.size).toBe(5);
  expect(JSON.stringify(attempts.docs.map(row => row.data()))).not.toContain("private");
});

it("doubles the pause after the fourth failure up to 30 minutes and stops spending while billing is paused", async () => {
  fault = { storage: "ECONNRESET" };
  await failFour();
  time = (await taskRef().get()).data().nextAttemptAt;
  await db.doc("system/billing").set({ disabled: true });
  expect((await readWork()).maintenance).toBe(false);
  await owner().recover();
  expect(builds).toBe(4);
  await db.doc("system/billing").delete();
  await owner().recover();
  expect((await taskRef().get()).data()).toMatchObject({ attempts: 5, slowRetryAt: null, nextAttemptAt: time + 960_000 });
  await owner().recover();
  expect(builds).toBe(5);
  for (const attempts of [6, 7]) {
    time = (await taskRef().get()).data().nextAttemptAt;
    await owner().recover();
    expect((await taskRef().get()).data()).toMatchObject({ status: "failed", attempts, nextAttemptAt: time + 1_800_000 });
  }
  expect(builds).toBe(7);
});

it.each(["corrupt", "validation", "permission"])("keeps retrying a %s failure after four attempts", async kind => {
  fault = kind === "corrupt" ? { corrupt: true } : kind === "permission" ? { storage: 403 } : { build: {} };
  await failFour();
  expect((await taskRef().get()).data()).toMatchObject({ attempts: 4, nextAttemptAt: time + 480_000, slowRetryAt: null,
    lastAttempt: { failureClass: kind === "validation" ? "validation" : "storage_readback", retryable: false } });
  time = (await taskRef().get()).data().nextAttemptAt;
  fault = null;
  await owner().recover();
  expect(builds).toBe(5);
  expect((await taskRef().get()).data()).toMatchObject({ attempts: 5, status: "verified" });
});

it("records timeout without retaining the provider message", async () => {
  fault = { build: { name: "TimeoutError" } };
  await owner().recover();
  expect((await taskRef().get()).data()).toMatchObject({ lastAttempt: { failureClass: "timeout", retryable: true } });
  expect(JSON.stringify((await taskRef().get()).data())).not.toContain("private provider");
});

it("records context change and never seals bytes generated for the prior context", async () => {
  duringBuild = () => db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await owner().recover();
  expect((await taskRef().get()).data()).toMatchObject({ status: "failed", receipt: null,
    lastAttempt: { failureClass: "context_changed", retryable: false } });
  expect(await publication.settlePublicContext({ firestore: db, operationId, runtime })).toBe(false);
});

it("records a lost lease on its own attempt without overwriting the next claimant", async () => {
  duringBuild = () => taskRef().update({ claim: "next-claim" });
  await owner().recover();
  expect((await taskRef().get()).data().claim).toBe("next-claim");
  expect((await taskRef().get()).data().receipt).toBeUndefined();
  const attempts = await taskRef().collection("attempts").get();
  expect(attempts.size).toBe(1);
  expect(attempts.docs[0].data()).toMatchObject({ failureClass: "lease_lost", retryable: true });
});

it("retries an interrupted fourth background claim on the same child once its claim expires", async () => {
  fault = { storage: 503 };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await owner().recover();
    time = (await taskRef().get()).data().nextAttemptAt;
  }
  await owner(interruptConfirmation(db, taskRef())).recover();
  const claimed = (await taskRef().get()).data();
  expect(claimed).toMatchObject({ attempts: 4, claim: expect.any(String), nextAttemptAt: time + 3_640_000 });
  expect(builds).toBe(3);
  time += 3_639_999;
  await owner().recover();
  expect((await taskRef().get()).data()).toEqual(claimed);
  const originalState = (await db.doc("cmsBackgroundOutputs/search").get()).data();
  expect(originalState.taskPath).toBe(taskRef().path);
  time++;
  fault = null;
  await owner().recover();
  expect(builds).toBe(4);
  expect((await taskRef().get()).data()).toMatchObject({ status: "verified", attempts: 5, claim: null,
    nextAttemptAt: null, runtime, revision: claimed.revision, contextDigest: claimed.contextDigest });
  expect((await db.doc("cmsBackgroundOutputs/search").get()).data()).toMatchObject({
    taskPath: originalState.taskPath, revision: originalState.revision });
  expect((await db.collection("cmsPublishQueue").get()).docs.map(row => row.id)).toEqual([operationId]);
});

it("reclaims an expired claim after five attempts and schedules its next retry", async () => {
  fault = { storage: 503 };
  await failFour();
  await taskRef().update({ attempts: 5, claim: "11111111-1111-4111-8111-111111111111", nextAttemptAt: time - 1, startedAt: time - 60_000 });
  expect((await readWork()).maintenance).toBe(true);
  await owner().recover();
  expect(builds).toBe(5);
  expect((await taskRef().get()).data()).toMatchObject({ status: "failed", attempts: 6, nextAttemptAt: time + 1_800_000, slowRetryAt: null });
  expect((await readWork()).maintenance).toBe(false);
});

it("alerts a stalled failed output on the next minute pass, deduplicates and retries delivery", async () => {
  fault = { storage: 403 };
  await failFour();
  // The retry is overdue by the stalled-work window: its wake stopped.
  time = (await taskRef().get()).data().nextAttemptAt + 900_000;
  const messages = [];
  await check(async () => { throw new Error("private send failure"); });
  await check(async message => { messages.push(message); });
  expect(messages).toHaveLength(0);
  time += 60_000;
  await check(async message => { messages.push(message); });
  await check(async message => { messages.push(message); });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain(`background output search: failed; failure class storage_readback; job ${operationId}`);
  expect(messages[0]).not.toContain("private");
});

it("logs a second attempt without Telegram", async () => {
  await owner().recover();
  const messages = [];
  await check(async message => { messages.push(message); });
  expect(messages).toEqual([]);
  await taskRef().update({ attempts: 2, lastAttempt: { durationMs: 1, failureClass: null } });
  await check(async message => { messages.push(message); });
  expect(messages).toEqual([]);
  expect(observations).toContainEqual({ output: "search", jobId: operationId, reason: "multiple_attempts", failureClass: "none" });
  await taskRef().update({ attempts: 3, lastAttempt: { durationMs: 1, failureClass: null } });
  await check(async message => { messages.push(message); });
  await taskRef().update({ attempts: 4, lastAttempt: { durationMs: 15_000, failureClass: null } });
  await check(async message => { messages.push(message); });
  expect(messages).toEqual([]);
  expect(observations).toHaveLength(1);
});

it("logs a scheduled retry and alerts if its wake later stalls", async () => {
  fault = { storage: 503 };
  await failFour();
  const messages = [];
  await check(async message => messages.push(message));
  expect(messages).toEqual([]);
  expect(observations.some(value => value.reason === "failed")).toBe(true);
  time = (await taskRef().get()).data().nextAttemptAt + 900_000;
  await check(async message => messages.push(message));
  await check(async message => messages.push(message));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("search: failed");
});

it.each(["retry", "expired_claim"])("escalates overdue %s output recovery exactly once", async kind => {
  fault = { storage: 503 };
  await failFour();
  const dueAt = (await taskRef().get()).data().nextAttemptAt;
  if (kind === "expired_claim") await taskRef().update({ status: "pending", claim: "expired-final-claim",
    nextAttemptAt: dueAt, slowRetryAt: null });
  const messages = [];
  const observe = () => check(async message => messages.push(message));
  await observe();
  time = dueAt + 900_000 - 1; await observe();
  expect(messages).toEqual([]);
  time++; await observe(); await observe();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("search: failed");
});

it.each([false, true])("alerts aggregate preparation failure even when families verified=%s", async verified => {
  if (verified) await owner().recover();
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed", error: "background_preparation_failed" });
  const messages = [];
  await check(async message => { messages.push(message); });
  expect(messages).toEqual([`NJ PBS background output aggregate: failed; failure class validation; job ${operationId}.`]);
});

it("alerts repeated preparation failure after staff retries without any output attempt", async () => {
  const preparationRef = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  const fail = async () => {
    await preparationRef.update({ status: "failed", attempts: 4, nextAttemptAt: null });
    await publication.failPublicContextPreparation({ firestore: db, operationId, runtime });
  };
  const messages = [];
  await fail();
  await check(async message => { messages.push(message); });
  await db.runTransaction(async transaction => {
    const retry = await publication.retryPublicContextInTransaction({ transaction, firestore: db, operationId, runtime });
    retry();
  });
  expect((await preparationRef.get()).data()).toMatchObject({ status: "failed", attempts: 0 });
  await fail();
  await check(async message => { messages.push(message); });
  await check(async message => { messages.push(message); });
  expect(messages).toEqual(Array(2).fill(`NJ PBS background output aggregate: failed; failure class validation; job ${operationId}.`));
  expect((await taskRef().get()).data().attempts).toBe(0);
  expect(builds).toBe(0);
});

it("bounds failed-output Telegram delivery and records every diagnostic once", async () => {
  const jobId = "J".repeat(200);
  for (const output of ["home", ...Object.keys(paths), "programs", "events"]) {
    const taskPath = `cmsPublishQueue/${jobId}/backgroundOutputs/${output}`;
    const task = { runtime, owner: "post-background-v1", output, revision: 1, attempts: 4, status: "failed", nextAttemptAt: null,
      lastAttempt: { failureClass: "timeout", durationMs: 20_000 } };
    await db.doc(taskPath).set(task);
    await db.doc(`cmsBackgroundOutputs/${output}`).set({ ...task, taskPath });
  }
  const messages = [];
  for (let pass = 0; pass < 5; pass++) await check(async message => { messages.push(message); });
  expect(messages).toHaveLength(2);
  expect(messages.every(message => message.length < 4096)).toBe(true);
  const lines = messages.flatMap(message => message.split("\n"));
  expect(lines).toHaveLength(9);
  expect(new Set(lines).size).toBe(9);
  expect(lines.every(line => line.includes(": failed;"))).toBe(true);
  expect(observations).toHaveLength(18);
  expect(new Set(observations.map(value => `${value.output}:${value.reason}`)).size).toBe(18);
});

it("allows only one claimant of a fifth attempt while the first worker is building", async () => {
  fault = { storage: 503 };
  await failFour();
  time = (await taskRef().get()).data().nextAttemptAt;
  fault = null;
  let entered;
  let release;
  const building = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  duringBuild = async () => { entered(); await resume; };
  const first = owner().recover();
  await building;
  try { await owner().recover(); }
  finally { release(); await first; }
  expect(builds).toBe(5);
  expect((await taskRef().get()).data()).toMatchObject({ attempts: 5, status: "verified" });
});

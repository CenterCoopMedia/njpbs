import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { Firestore } from "firebase-admin/firestore";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import protocol from "../../functions/lib/public-release-pair.js";
import admissions from "../../functions/lib/public-release-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { bumpPublicContextRevision } from "../../functions/lib/public-context-revision.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { recoverDueOriginalPublicReleaseWork, recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { writePublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
import { publicReleasePairRpcStore } from "../../site/scripts/public-release-pair-storage-rpc";
import { publicReleasePairSourceInputPath } from "../../site/scripts/public-release-pair-input-storage";
import sourceLimits, { type HistoricalSourceMetric } from "../../functions/lib/public-release-source-limits.js";

const document = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
const contract = { schemaVersion: 2, families: ["posts", "settings", "context"], features: [] };
const change = { kind: "post", id: document.id, action: "publish", sourceVersion: document.published.sourceVersion, snapshot: document.published };
let firestore: Firestore, runtime: Miniflare, store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
let time: number;
const state = async (path: string) => (await firestore.doc(path).get()).data();
beforeAll(async () => {
  firestore = isolatedFirestore("original-work-recovery");
  runtime = new Miniflare({ workers: [{ config: { name: "original-recovery", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "original-recovery" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  time = 1_000;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, firestore);
});

async function accepted(operationId = "original-operation") {
  const seeded = await seedSwitch(firestore, { admittedContract: contract });
  await firestore.doc(`${admissions.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await firestore.doc(`${admissions.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  for (const pair of [seeded.old, seeded.next]) await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/journals/${pair.publisher.journalNamespace}`)
    .set({ schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null });
  const accepted = await firestore.runTransaction(async transaction => {
    const prepared = await admissions.preparePairPublicationInTransaction({ firestore, transaction, operationId,
      source: admissions.publicationSource(change), change, contextRevision: 13 });
    prepared.write(); transaction.set(firestore.doc(`cmsPosts/${document.id}`), document);
    bumpPublicContextRevision(transaction, firestore);
    return prepared.admission;
  });
  const entry = (await state("system/publicReleaseChanges/entries/0000000000000001"))!;
  const input = capturedPairInput(seeded.old, { kind: "accepted", sourceOperationId: operationId,
    contextSequence: accepted.changeSequence }, { baselineDigest: entry.previousDigest, lastDigest: entry.entryDigest });
  // Real R2 upload/readback and actual SDK H ownership, without an enqueue or
  // a wake. Recovery must discover the durable admission on its own.
  const captured = await capturePublicReleasePairInput({ firestore, store, pair: seeded.old, plan: input.root,
    expectedSource: input.root.source, expectedCursor: input.cursor, bindSourceOperation: true,
    files: (async function* () { yield* input.files; })() });
  const options = { firestore, store, pair: seeded.old, operationId, now: () => time };
  return { ...seeded, accepted, captured, input, options, due: admissions.publicationPendingPath(seeded.old.pairId, operationId) };
}

it("atomically retains the global obligation and an original-pair recovery hint, then recovers a missed wake", async () => {
  const { old, options, accepted: original, due } = await accepted();
  const census = await state(admissions.ADMISSIONS), marker = await state(`${admissions.ADMISSIONS}/pending/${original.operationId}`);
  expect(marker).toEqual({ schemaVersion: 2, operationId: original.operationId, admissionDigest: protocol.publicReleaseDigest(original) });
  expect(await state(due)).toMatchObject({ ...marker, nextAttemptAt: 0 });
  expect((await firestore.collection(`${work.publicReleasePairPath(old.pairId)}/work`).get()).empty).toBe(true);
  const first = await recoverDueOriginalPublicReleaseWork(options);
  expect(first).toEqual([{ operationId: original.operationId, status: "queued", taskId: expect.any(String) }]);
  const task = await state(`${work.publicReleasePairPath(old.pairId)}/work/${first[0].taskId}`);
  expect(task).toMatchObject({ status: "pending", attempts: 0, identity: { pair: original.pair, kind: "accepted",
    sourceOperationId: original.operationId, sourceVersion: original.source.sourceVersion, contextSequence: original.changeSequence } });
  expect(await state(admissions.ADMISSIONS)).toEqual(census);
  expect(await state(`${admissions.ADMISSIONS}/pending/${original.operationId}`)).toEqual(marker);
  expect(await state(`cmsPosts/${document.id}`)).toEqual(document);
  expect(await state(`cmsPublishQueue/${original.operationId}`)).toMatchObject({ status: "pending", execution: null, terminalReceipt: null });
  expect(await recoverDueOriginalPublicReleaseWork(options)).toEqual([]);
  time += 30_000;
  expect(await recoverDueOriginalPublicReleaseWork(options)).toEqual(first);
  expect(await state(`${work.publicReleasePairPath(old.pairId)}/work/${first[0].taskId}`)).toEqual(task);
});

it("reopens the original immutable H after selection and current source change, preserving a running original claim", async () => {
  const { old, selector, options, captured } = await accepted();
  await firestore.doc("system/publicDeployment").set({ ...selector, epoch: 2, selectedPair: selector.recoveryPair,
    recoveryPair: selector.selectedPair, activeCommitSha: selector.recoveryPair.commitSha,
    activeDeploymentId: selector.recoveryPair.publicWorkerVersionId,
    contentHead: { ...selector.contentHead, pairId: selector.recoveryPair.pairId } });
  await firestore.doc(`cmsPosts/${document.id}`).update({ version: 99, "published.sourceVersion": 98 });
  const first = await recoverOriginalPublicReleaseWork(options);
  expect(first.status).toBe("queued");
  const claim = await work.claimPublicReleasePairWork({ firestore, pair: old, taskId: first.taskId!, now: time });
  const originalTask = await state(`${work.publicReleasePairPath(old.pairId)}/work/${first.taskId}`);
  const originalJournal = await state(`${work.publicReleasePairPath(old.pairId)}/journals/${old.publisher.journalNamespace}`);
  time += 30_000;
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "running", taskId: first.taskId });
  expect(claim!.identity.inputManifestDigest).toBe(captured.receipt.inputManifestDigest);
  expect(await state(`${work.publicReleasePairPath(old.pairId)}/work/${first.taskId}`)).toEqual(originalTask);
  expect(await state(`${work.publicReleasePairPath(old.pairId)}/journals/${old.publisher.journalNamespace}`)).toEqual(originalJournal);
  expect((await state(`cmsPosts/${document.id}`))!.published.sourceVersion).toBe(98);
});

it("does not enqueue while billing is paused or another recovery lease is held", async () => {
  const { options, due } = await accepted();
  await firestore.doc("system/billing").set({ disabled: true });
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "paused" });
  await firestore.doc("system/billing").delete();
  await firestore.doc(due).update({ recoveryLease: { token: "a".repeat(36), until: time + 100 } });
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "busy" });
  time += 101;
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "queued" });
});

it("records the original completed execution without acknowledging publication or clearing its obligation", async () => {
  const { options, old, input } = await accepted();
  const first = await recoverOriginalPublicReleaseWork(options);
  const claim = (await work.claimPublicReleasePairWork({ firestore, pair: old, taskId: first.taskId!, now: time }))!;
  const claimDigest = protocol.publicReleaseDigest(claim.token);
  const output = await writePublicReleasePairView({ store, pair: old, identity: claim.identity, claimDigest, cursor: input.cursor,
    outputs: (async function* () { yield { path: "/original/", status: 200 as const, headers: { "content-type": "text/html", "cache-control": "no-store" },
      bytes: new TextEncoder().encode("<html>Original private computation</html>") }; })() });
  await work.settlePublicReleasePairWork({ firestore, pair: old, taskId: first.taskId!, token: claim.token,
    manifestDigest: output.manifestDigest, now: time + 1 });
  const census = await state(admissions.ADMISSIONS), root = await state("system/publicDeployment");
  time += 30_000;
  const result = await recoverOriginalPublicReleaseWork(options);
  expect(result).toMatchObject({ status: "rendered", taskId: first.taskId,
    execution: { identity: claim.identity, claimDigest, manifestDigest: output.manifestDigest } });
  expect(await state(`cmsPublishQueue/${options.operationId}`)).toMatchObject({ status: "pending", terminalReceipt: null, execution: result.execution });
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
  expect(await state(admissions.ADMISSIONS)).toEqual(census);
  expect(await state("system/publicDeployment")).toEqual(root);
  time += 30_000;
  expect(await recoverOriginalPublicReleaseWork(options)).toEqual(result);
});

it("preserves retryability when billing pauses after reservation and before enqueue", async () => {
  const { options, due } = await accepted();
  const pausedStore = { put: store.put.bind(store), async get(key: string) {
    await firestore.doc("system/billing").set({ disabled: true });
    return store.get(key);
  } };
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(await recoverOriginalPublicReleaseWork({ ...options, store: pausedStore })).toMatchObject({ status: "paused" });
    expect(await state(due)).toMatchObject({ recoveryFailures: 0, recoveryFailure: "temporarily-unavailable", recoveryLease: null });
    await firestore.doc("system/billing").set({ disabled: false });
    time += 30_000;
  }
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "queued" });
  expect(await state(`cmsPublishQueue/${options.operationId}`)).toMatchObject({ status: "pending" });
});

it.each(["rpc-503", "rpc-fetch", "provider-timeout", "sdk-unavailable"])("defers %s without charging corruption attempts", async failure => {
  const { options, due } = await accepted();
  const rpc = failure.startsWith("rpc-");
  if (rpc) vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    expect(String(input)).toMatch(/^http:\/\/pair-storage\.internal\//);
    if (failure === "rpc-fetch") throw new TypeError("Private transport unavailable");
    return new Response(null, { status: 503 });
  });
  const unavailable = rpc ? publicReleasePairRpcStore() : { async get(): Promise<never> {
    if (failure === "provider-timeout") throw new DOMException("Private provider timed out", "TimeoutError");
    throw Object.assign(new Error("SDK unavailable"), { code: 14 });
  }, put: store.put.bind(store) };
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await recoverOriginalPublicReleaseWork({ ...options, store: unavailable })).toMatchObject({ status: "retry" });
      expect(await state(due)).toMatchObject({ recoveryFailures: 0, recoveryFailure: "temporarily-unavailable" });
      time += 30_000;
    }
  } finally { vi.restoreAllMocks(); }
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "queued" });
});

it("quarantines corrupt original H after bounded failures while retaining source, queue, marker and census debt", async () => {
  const { options, captured, due } = await accepted();
  await store.delete(captured.receipt.manifestKey);
  const census = await state(admissions.ADMISSIONS), source = await state(`cmsPosts/${document.id}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: attempt === 3 ? "quarantined" : "retry" });
    expect(await state(due)).toMatchObject({ recoveryFailures: attempt, nextAttemptAt: attempt === 3 ? null : time + 30_000 });
    time += 30_000;
  }
  expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: "quarantined" });
  expect(await state(`cmsPublishQueue/${options.operationId}`)).toMatchObject({ status: "failed", execution: null, terminalReceipt: null });
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
  expect(await state(admissions.ADMISSIONS)).toEqual(census);
  expect(await state(`cmsPosts/${document.id}`)).toEqual(source);
});

it.each(["changes", "rootFiles", "censusBytes", "transactionMs", "readMs"] as HistoricalSourceMetric[])("handles the actual %s historical limit without confusing a hard limit and elapsed time", async metric => {
  const { options, due } = await accepted();
  const limit = sourceLimits.historicalSourceHeadroom().checks[metric].limit;
  let error: unknown;
  try { sourceLimits.checkHistoricalSourceLimit(metric, limit + 1); } catch (caught) { error = caught; }
  expect(sourceLimits.isHistoricalSourceLimitError(error)).toBe(true);
  const unavailable = { put: store.put.bind(store), async get(): Promise<never> { throw error; } };
  const permanent = ["changes", "rootFiles", "censusBytes"].includes(metric);
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await recoverOriginalPublicReleaseWork({ ...options, store: unavailable })).toMatchObject({
      status: permanent && attempt === 3 ? "quarantined" : "retry" });
    expect(await state(due)).toMatchObject({ recoveryFailures: permanent ? attempt : 0 });
    time += 30_000;
  }
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
  expect(await state(`cmsPublishQueue/${options.operationId}`)).toMatchObject({ status: permanent ? "failed" : "pending" });
});

it("serializes concurrent missed-wake recovery into one original task", async () => {
  const { options, old } = await accepted();
  const results = await Promise.all([recoverOriginalPublicReleaseWork(options), recoverOriginalPublicReleaseWork(options)]);
  expect(results.some(result => result.status === "queued")).toBe(true);
  expect(results.every(result => ["queued", "busy", "not-due"].includes(result.status))).toBe(true);
  expect((await firestore.collection(`${work.publicReleasePairPath(old.pairId)}/work`).get()).size).toBe(1);
});

it("parks a poisoned hint without losing its global census debt or starving the next bounded pass", async () => {
  const { options, due, accepted: original } = await accepted();
  const census = await state(admissions.ADMISSIONS), queue = await state(`cmsPublishQueue/${original.operationId}`);
  const bad = admissions.publicationPendingPath(options.pair.pairId, "poison-operation");
  await firestore.doc(bad).set({ schemaVersion: 2, operationId: "poison-operation", admissionDigest: "f".repeat(64), nextAttemptAt: 0 });
  await firestore.doc(due).update({ nextAttemptAt: 1 });
  expect(await recoverDueOriginalPublicReleaseWork({ ...options, limit: 1 })).toEqual([{ operationId: "poison-operation", status: "quarantined" }]);
  expect(await recoverDueOriginalPublicReleaseWork({ ...options, limit: 1 })).toEqual([{ operationId: original.operationId, status: "queued", taskId: expect.any(String) }]);
  expect(await state(admissions.ADMISSIONS)).toEqual(census);
  expect(await state(`cmsPublishQueue/${original.operationId}`)).toEqual(queue);
});

it("parks malformed global marker evidence instead of repeatedly consuming the bounded discovery slot", async () => {
  const { options, due } = await accepted();
  await firestore.doc(`${admissions.ADMISSIONS}/pending/${options.operationId}`).update({ unexpected: true });
  expect(await recoverDueOriginalPublicReleaseWork(options)).toEqual([{ operationId: options.operationId, status: "quarantined" }]);
  expect(await state(due)).toMatchObject({ nextAttemptAt: null, recoveryFailure: "original-admission-unavailable" });
  expect(await recoverDueOriginalPublicReleaseWork(options)).toEqual([]);
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
});

it("charges bounded evidence failures for a malformed original H binding", async () => {
  const { options, old, captured, due } = await accepted();
  await firestore.doc(publicReleasePairSourceInputPath(old, captured.root.scope)).update({ unexpected: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await recoverOriginalPublicReleaseWork(options)).toMatchObject({ status: attempt === 3 ? "quarantined" : "retry" });
    expect(await state(due)).toMatchObject({ recoveryFailures: attempt });
    time += 30_000;
  }
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
});

it("installs discovery only with explicit activation ownership and adoption, before the existing worker poll", async () => {
  const { options, old } = await accepted();
  const base = { firestore, store, pair: old, clock: () => time };
  expect(createPublicReleasePairExecutor(base)).not.toHaveProperty("beforePoll");
  expect(() => createPublicReleasePairExecutor({ ...base, originalRecovery: { enabled: true } })).toThrow();
  const executor = createPublicReleasePairExecutor({ ...base, originalRecovery: { enabled: true },
    publication: { activate: activateStagedPublicReleasePairPublication } });
  await firestore.doc(`${admissions.ADMISSIONS}/controls/adoption`).update({ enabled: false });
  await executor.beforePoll!({});
  expect((await firestore.collection(`${work.publicReleasePairPath(old.pairId)}/work`).get()).empty).toBe(true);
  await firestore.doc(`${admissions.ADMISSIONS}/controls/adoption`).update({ enabled: true });
  const seen: unknown[] = [];
  expect(await runPublicReleasePairWorkOnce({ ...base, beforePoll: executor.beforePoll,
    async execute({ identity }) { seen.push(identity); throw new work.PairExecutionError("input-unavailable"); } })).toBe("retry-recorded");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "accepted", sourceOperationId: options.operationId, pair: protocol.publicReleasePairReference(old) });
  expect(await state(`${admissions.ADMISSIONS}/pending/${options.operationId}`)).toBeDefined();
  expect(await state(`cmsPublishQueue/${options.operationId}`)).toMatchObject({ status: "pending", execution: null, terminalReceipt: null });
});

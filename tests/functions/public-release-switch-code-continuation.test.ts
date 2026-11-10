import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { createPublicReleaseSwitchCodeContinuation } from "../../site/scripts/public-release-switch-code-continuation";
import { bindPublicReleaseSwitchCodeContinuation } from "../../site/scripts/public-release-switch-code-binding";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { startPublicReleasePairServer } from "../../site/scripts/public-release-pair-server";
import { publicReleaseSwitchCodeWriteStore } from "../../site/scripts/public-release-switch-code-write-transport";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { pairOwnerCodeSnapshotReader } from "../../publisher/pair-owner-code-reader";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { decodePairEvidenceFields } from "../../publisher/pair-work-reader";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
import work from "../../functions/lib/public-release-pair-work.js";
import p from "../../functions/lib/public-release-pair.js";
import switches from "../../functions/lib/public-release-switch.js";
import codeOwner from "../../functions/lib/public-release-switch-code-owner.js";
import mediaRetention from "../../functions/lib/public-release-media-retention.js";
import { publicReleasePairSourceInputPath } from "../../site/scripts/public-release-pair-input-storage";
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const network = globalThis.fetch, writes: string[] = [], refusals: number[] = [], diagnostics: unknown[] = [];
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "code-runtime", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "code-runtime" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  const database = isolatedFirestore("switch-code-continuation");
  fixture = await switchedPairFixture(database, store);
  const { firestore, pair } = fixture;
  await firestore.doc("system/publicReleaseAdmissions/controls/adoption").set({ schemaVersion: 2, enabled: true });
  const request = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://firestore.googleapis.com") throw new Error("Unexpected CODE evidence destination");
    const response = await network(`http://${process.env.FIRESTORE_EMULATOR_HOST}${url.pathname}${url.search}`, init);
    diagnostics.push({ path: url.pathname.split("/documents")[1], status: response.status });
    return response;
  };
  const read = async (path: string) => (await firestore.doc(path).get()).data() ?? null;
  const authority = { pair, read,
    codeSnapshot: async <T>(run: (read: any) => Promise<T>) => {
      try { return await pairOwnerCodeSnapshotReader({ projectId: database.projectId, token: "owner", decode: decodePairEvidenceFields, request })(run); }
      catch (error) { diagnostics.push({ error: (error as Error).name, frames: (error as Error).stack?.split("\n").slice(1, 5) }); throw error; }
    },
    ...pairOwnerEvidenceClient({ pair, projectId: database.projectId, token: "owner", decode: decodePairEvidenceFields, request }) };
  const bucket = { get: store.get.bind(store), put: async (key: string, ...args: any[]) => {
    writes.push(key); return (store.put as any)(key, ...args);
  } };
  vi.stubGlobal("fetch", (input: any, init?: RequestInit) => {
    const req = new Request(input, init), host = new URL(req.url).hostname;
    if (host === "pair-owner-write.internal") return pairOwnerWriteRpc(req, bucket as any, authority).then(response => {
      if (response.status >= 400 && response.status !== 412) refusals.push(response.status); return response;
    });
    if (host === "pair-terminal.internal") return pairTerminalRpc(req, store as any, authority, { prove: async () => { throw new Error("No canonical proof in CODE storage"); } });
    return network(req);
  });
}, 120_000);
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await runtime?.dispose(); });
it("yields CODE capture to an existing accepted-work due hint", async () => {
  const { firestore, pair, codeOperationId } = fixture, ref = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/work/priority-only`);
  // Query-only hint: this row is removed before the real claim owner runs.
  await ref.create({ acceptedDueAt: 0 });
  try {
    const continuation = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair,
      store: { async get(): Promise<never> { throw new Error("Staff work has priority over CODE storage"); },
        async put(): Promise<never> { throw new Error("Staff work has priority over CODE storage"); } } });
    await continuation.beforePoll!({});
    expect((await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/switchCodePending/${codeOperationId}`).get()).exists).toBe(false);
    expect(writes).toHaveLength(0);
  } finally { await ref.delete(); }
});
it("parks terminal historical capture failures while retrying storage outages without spending the refusal budget", async () => {
  const { firestore, pair, codeOperationId } = fixture;
  const outbox = firestore.doc(`system/publicReleaseChanges/captures/${codeOperationId}`), original = (await outbox.get()).data()!;
  const pending = firestore.doc(codeOwner.codePendingPath(pair, codeOperationId));
  let now = Date.now();
  try {
    const unavailable = { async get(): Promise<never> { throw new work.PairExecutionError("storage-unavailable"); },
      async put(): Promise<never> { throw new Error("No write is permitted on failed capture"); } };
    const continuation = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair, store: unavailable, clock: () => now });
    await outbox.set({ ...original, status: "failed" });
    for (let attempt = 1; attempt <= 4; attempt++) {
      await continuation.beforePoll!({});
      expect((await pending.get()).data()).toMatchObject({ failures: Math.min(attempt, 3),
        nextAttemptAt: attempt < 3 ? now + 30_000 : null, lastFailure: "source-refused", lease: null });
      now += 30_001;
    }
    await outbox.set(original); await pending.delete();
    for (let attempt = 0; attempt < 4; attempt++) {
      await continuation.beforePoll!({});
      expect((await pending.get()).data()).toMatchObject({ failures: 0, nextAttemptAt: now + 30_000,
        lastFailure: "temporarily-unavailable", lease: null });
      now += 30_001;
    }
    expect(writes).toHaveLength(0);
    expect((await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get()).docs
      .some(row => row.data().identity.sourceOperationId === codeOperationId)).toBe(false);
  } finally { await outbox.set(original); await pending.delete(); }
});
it("recovers a missed CODE wake through actual leased H, completed G and private create-only replay without editorial admission", async () => {
  const { firestore, pair, codeOperationId } = fixture;
  const before = p.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  const queueBefore = (await firestore.collection("cmsPublishQueue").get()).docs.map(row => row.data());
  let now = Date.now();
  const continuation = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair, clock: () => now,
    store: publicReleaseTerminalTransport(pair.environment).store,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest inputs"); } },
    captureStore: (operationId, lease) => publicReleaseSwitchCodeWriteStore({ pair, operationId, lease }),
    replayStore: operationId => publicReleaseSwitchCodeWriteStore({ pair, operationId }) });
  const owner = (await firestore.runTransaction(transaction => codeOwner.readSelectedSwitchCodeSourceInTransaction({
    firestore, transaction, pair, operationId: codeOperationId }), { readOnly: true }))!;
  const binding = firestore.doc(publicReleasePairSourceInputPath(pair, owner.scope));
  const originalTransaction = firestore.runTransaction.bind(firestore);
  let lost = false;
  const interrupted = vi.spyOn(firestore, "runTransaction").mockImplementation((async (...args: any[]) => {
    const result = await (originalTransaction as any)(...args);
    if (!lost && (await binding.get()).exists) { lost = true; throw new Error("Injected lost response after H binding commit"); }
    return result;
  }) as any);
  try { await continuation.beforePoll!({}); }
  finally { interrupted.mockRestore(); }
  expect(lost).toBe(true); expect((await binding.get()).exists).toBe(true);
  const capture = firestore.doc(`system/publicReleaseChanges/captures/${codeOperationId}`);
  const key = p.publicReleaseDigest({ pair: p.publicReleasePairReference(pair), kind: "recovery" });
  expect((await capture.get()).data()!.packs[key]).toBeUndefined();
  const search = firestore.doc(`system/publicReleaseChanges/operations/${codeOperationId}/evidence/searchInputs`);
  expect((await search.get()).exists).toBe(false);
  const boundDigest = (await binding.get()).data()!.inputManifestDigest;
  const mediaPin = firestore.doc(mediaRetention.pinPath(pair, boundDigest));
  expect((await mediaPin.get()).exists).toBe(false);
  now += 30_001;
  let expiredAfterBookkeeping = false;
  const late = vi.spyOn(firestore, "runTransaction").mockImplementation((async (...args: any[]) => {
    const result = await (originalTransaction as any)(...args);
    if (!expiredAfterBookkeeping && (await capture.get()).data()!.packs[key]?.status === "captured") {
      expiredAfterBookkeeping = true; now += 180_001;
    }
    return result;
  }) as any);
  try { await continuation.beforePoll!({}); }
  finally { late.mockRestore(); }
  expect(expiredAfterBookkeeping).toBe(true);
  const expiredPending = (await firestore.doc(codeOwner.codePendingPath(pair, codeOperationId)).get()).data()!;
  expect(expiredPending.failures).toBe(0); expect(expiredPending.nextAttemptAt).not.toBeNull();
  expect(expiredPending.lease.until).toBeLessThanOrEqual(now);
  expect((await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get()).docs
    .some(row => row.data().identity.sourceOperationId === codeOperationId)).toBe(false);
  expect((await binding.get()).data()!.inputManifestDigest).toBe(boundDigest);
  expect((await capture.get()).data()!.packs[key]).toMatchObject({ status: "captured", inputManifestDigest: boundDigest });
  expect((await search.get()).exists).toBe(true);
  expect((await mediaPin.get()).data()).toMatchObject({ kind: "pair-media-retention", inputManifestDigest: boundDigest });
  await continuation.beforePoll!({});
  const tasks = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/work`).get();
  const task = tasks.docs.find(row => row.data().identity.sourceOperationId === codeOperationId)!;
  if (!task) {
    const pending = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/switchCodePending/${codeOperationId}`).get()).data();
    throw new Error(JSON.stringify({ failure: pending?.lastFailure, failures: pending?.failures, writeCount: writes.length, refusals, diagnostics }));
  }
  expect(task).toBeDefined(); expect(task.data().identity.kind).toBe("recovery");
  expect(task.data().status).toBe("pending");
  const pendingRef = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/switchCodePending/${codeOperationId}`);
  const pendingBefore = (await pendingRef.get()).data()!, taskBefore = task.data();
  // The work owner's exact terminal-failure shape cannot be auto-reclaimed.
  await task.ref.update({ status: "failed", attempts: 4, nextAttemptAt: null, lastFailure: "render-failed" });
  await pendingRef.update({ nextAttemptAt: 0 });
  await continuation.beforePoll!({});
  expect((await pendingRef.get()).data()).toMatchObject({ lease: null, nextAttemptAt: null, failures: 3, lastFailure: "work-failed" });
  const quarantinedWriteCount = writes.length;
  await continuation.beforePoll!({}); expect(writes.length).toBe(quarantinedWriteCount);
  // Restore the private failure fixture before exercising the real G owner.
  await task.ref.set(taskBefore); await pendingRef.set(pendingBefore);
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: task.id }, store);
  const completed = { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest };
  const stagedRef = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/views/${completed.manifestDigest}`);
  const stagedBefore = (await stagedRef.get()).data()!;
  // A completed receipt precedes G's staged row. Ordinary staging backoff
  // must remain pending through repeated CODE polls, never charge corruption.
  await stagedRef.delete();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await continuation.completed!(completed);
      expect((await pendingRef.get()).data()).toMatchObject({ failures: 0, lastFailure: "replay-pending" });
      expect((await pendingRef.get()).data()!.nextAttemptAt).not.toBeNull();
    }
  } finally { await stagedRef.set(stagedBefore); }
  const pins = firestore.doc("system/cmsPublicationRuntime"), ready = (await pins.get()).data()!;
  let paused = false;
  const readStore = publicReleaseSwitchCodeWriteStore({ pair, operationId: codeOperationId });
  const raced = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair, store, clock: () => now,
    replayStore: () => ({ put: readStore.put, async get(key) {
      if (!paused) { paused = true; await pins.set({ ...ready, phase: "paused", cloud: { ...ready.cloud, phase: "paused" } }); }
      return readStore.get(key);
    } }) });
  const quarantineRef = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/stagingFailures/${task.id}`);
  await quarantineRef.create({ schemaVersion: 2, status: "quarantined", taskId: task.id, identity: completed.identity,
    claimDigest: completed.claimDigest, manifestDigest: completed.manifestDigest, attempts: 3, nextAttemptAt: null,
    failedAt: now, lastFailure: "byte-mismatch" });
  await continuation.completed!(completed);
  expect((await pendingRef.get()).data()).toMatchObject({ failures: 0, nextAttemptAt: null, lastFailure: "replay-predecessor-failed" });
  const stoppedWrites = writes.length;
  await continuation.beforePoll!({}); expect(writes.length).toBe(stoppedWrites);
  const bound = bindPublicReleaseSwitchCodeContinuation({ continuation: raced,
    executor: createPublicReleasePairExecutor({ firestore, pair, store, clock: () => now }) });
  const server = await startPublicReleasePairServer({ firestore, pair, ...bound, host: "127.0.0.1", port: 0,
    execute: async () => { throw new Error("Explicit repair must not render or claim another task"); } });
  try {
    if (!server.address || typeof server.address === "string") throw new Error("No private repair address");
    const request = () => network(`http://127.0.0.1:${server.address && typeof server.address !== "string" ? server.address.port : 0}/retry-staging`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id }) });
    const response = await request();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "staged", taskId: task.id });
    expect((await quarantineRef.get()).exists).toBe(false);
    expect(paused).toBe(true);
    const debt = (await pendingRef.get()).data()!;
    expect(debt.failures).toBe(0); expect(debt.nextAttemptAt).not.toBeNull();
    expect(p.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data()).contentHead).toEqual(before.contentHead);
    await pins.set(ready);
    const originalCompleted = (await task.ref.get()).data();
    const resumed = await request(); expect(resumed.status).toBe(200); await resumed.body?.cancel();
    expect((await pendingRef.get()).exists).toBe(false);
    const repairedRoot = await firestore.doc(switches.ROOT).get();
    const repeated = await request(); expect(repeated.status).toBe(200); await repeated.body?.cancel();
    expect((await repairedRoot.ref.get()).updateTime!.isEqual(repairedRoot.updateTime!)).toBe(true);
    expect((await task.ref.get()).data()).toEqual(originalCompleted);
  } finally { await pins.set(ready); await server.close(); }
  const after = p.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  expect(after.contentHead.contextSequence).toBe(staged.claim.identity.contextSequence);
  expect(after.contentHead.contextSequence).toBeGreaterThan(before.contentHead.contextSequence);
  expect(after.epoch).toBe(before.epoch); expect(after.activeGeneration).toBe(before.activeGeneration);
  expect((await firestore.collection("cmsPublishQueue").get()).docs.map(row => row.data())).toEqual(queueBefore);
  expect((await firestore.collection("system/publicReleaseAdmissions/terminalReceipts").get()).empty).toBe(true);
  expect(writes.some(key => key.startsWith(`release-pair-inputs/v2/${pair.pairId}/`))).toBe(true);
  expect(writes.some(key => key.startsWith(`release-pair-replay/v2/${p.publicReleaseDigest(pair)}/`))).toBe(true);
  expect((await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/switchCodePending/${codeOperationId}`).get()).exists).toBe(false);
}, 120_000);

it("verifies the original completed activation without storage/replay work on subsequent polls", async () => {
  const { firestore, pair } = fixture;
  const deny = { async get(): Promise<never> { throw new Error("Activated CODE must not reread storage"); },
    async put(): Promise<never> { throw new Error("Activated CODE must not rewrite storage"); } };
  const continuation = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair, store: deny });
  const root = await firestore.doc(switches.ROOT).get(), count = writes.length;
  await continuation.beforePoll!({}); await continuation.beforePoll!({});
  expect(writes.length).toBe(count);
  expect((await root.ref.get()).updateTime!.isEqual(root.updateTime!)).toBe(true);
});
it("a shared release-writer fence leaves the normal pair drain available", async () => {
  const { firestore, pair } = fixture, fence = firestore.doc("system/publicDeployment/releaseWriter/fence");
  await fence.create({ schemaVersion: 2, operationId: "another-release", attemptDigest: "a".repeat(64) });
  try {
    const continuation = createPublicReleaseSwitchCodeContinuation({ enabled: true, firestore, pair, store });
    const { runPublicReleasePairWorkOnce } = await import("../../site/scripts/public-release-pair-runtime");
    expect(await runPublicReleasePairWorkOnce({ firestore, pair, beforePoll: continuation.beforePoll,
      execute: async () => { throw new Error("The completed fixture has no due work"); } })).toBe("idle");
  } finally { await fence.delete(); }
});

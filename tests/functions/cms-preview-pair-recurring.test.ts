import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pair, reader, receipt, candidate, selector, proof } from "../helpers/cms-preview-pairs.js";
import { installClosureReaders, recordInstalledClosureReaders } from "../helpers/cms-preview-closure-readers.js";
import { bridgeFixture } from "../helpers/cms-reader-bridge.js";
import { openCmsPreviewCloudTokenJournal as openLegacyJournal } from "../fixtures/cms-preview-before-recurring/token-journal";
import { openCmsPreviewCloudTokenJournal } from "../../site/scripts/cms-preview-cloud-token-journal";
import { planPairedCmsRelease } from "../../scripts/lib/cms-preview-pair-release.mjs";
import { installCmsReaderBridge } from "../../scripts/lib/cms-reader-bridge-install.mjs";
const require = createRequire(import.meta.url), pairs = require("../../functions/lib/cms-preview-pair.js");
const sessions = require("../../functions/lib/cms-reader-session.js"), closures = require("../../functions/lib/cms-preview-pair-reader-closure.js");
const legacySessions = require("../fixtures/cms-preview-before-recurring/reader-session.cjs");
let sequence = 0;
async function fixture(previewRequest = 1) {
  const db = isolatedFirestore(`preview-recurring-${++sequence}`), now = Date.now(), old = pair("old"), selected = pair("selected", "b");
  const third = pair("third", "c"), next = { ...third, requirements: { ...third.requirements, previewRequest } };
  for (const value of [old, selected, next]) await pairs.registerPair(db, value);
  const initial = selector(selected, old);
  await db.doc(pairs.SELECTOR_PATH).set(initial);
  await db.doc(pairs.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, state: "complete", component: "renderer", pairId: selected.pairId,
    selectorDigest: pairs.digest(initial), lastComplete: candidate(selected, now).mutation });
  const liveReaders = await installClosureReaders(db, now);
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(candidate(next, now));
  const closeRequest = { operationId: "preview-close-old", expectedSelectorDigest: pairs.digest(initial), pairId: old.pairId };
  const switchRequest = { operationId: "preview-select-third", expectedSelectorDigest: pairs.digest(initial), newPairId: next.pairId,
    proofDigest: await pairs.recordProof(db, { ...proof(selected, next, now),
      readerDigests: Object.fromEntries(Object.entries(liveReaders).map(([key, value]) => [key, pairs.digest(value)])) }) };
  const close = (at = now) => closures.closeRecoveryReaderIssuance(db, closeRequest, at);
  const select = (at = now) => pairs.selectPair(db, switchRequest, at);
  const current = async () => (await db.doc(pairs.SELECTOR_PATH).get()).data();
  return { db, now, old, selected, next, initial, close, select, current, closeRequest, switchRequest, liveReaders };
}
it("third selection waits for original recovery leases while new sessions continue without extending that frontier", async () => {
  const f = await fixture(), live = reader("cmsApi", f.now);
  const original = await sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 1000 }, f.now);
  const closure = await f.close(f.now + 1);
  const newer = await sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 5000 }, f.now + 2);
  await sessions.assertSession(f.db, { sessionId: newer.sessionId, principalId: "staff", readerDigest: newer.readerDigest }, f.now + 3);
  await sessions.assertSession(f.db, { sessionId: original.sessionId, principalId: "staff", readerDigest: original.readerDigest }, f.now + 3);
  const dependency = (await f.db.doc(`${closures.COLLECTION}/${f.old.pairId}/readers/${original.readerDigest}`).get()).data()!;
  expect(dependency.maxExpiresAt).toBe(original.expiresAt); expect(newer.expiresAt).toBeGreaterThan(dependency.maxExpiresAt);
  await expect(f.select(original.expiresAt - 1)).rejects.toThrow("old Admin sessions"); expect(await f.current()).toEqual(f.initial);
  const selected = await f.select(original.expiresAt);
  expect(selected.selector).toMatchObject({ selectedPairId: f.next.pairId, recoveryPairId: f.selected.pairId, epoch: 2 });
  expect(selected.retirement).toMatchObject({ pairId: f.old.pairId, closureDigest: pairs.digest(closure) });
  expect(await f.select(original.expiresAt + 100)).toEqual(selected);
  expect(await sessions.assertSession(f.db, { sessionId: newer.sessionId, principalId: "staff", readerDigest: newer.readerDigest }, original.expiresAt)).toEqual(newer);
  const journal = await openCmsPreviewCloudTokenJournal({ firestore: f.db, serializerId: f.old.serializerId });
  await expect(journal.reserve({ queueId: "A".repeat(20), buildBatchId: `preview-${"A".repeat(20)}`, commitSha: f.old.rendererSha })).rejects.toThrow("retained incarnation");
  expect(await journal.read()).toBeNull();
});
it("confirmed expiry recovery and history sweep leave every retirement authority and the third selection intact", async () => {
  const f = await fixture(), live = reader("cmsApi", f.now), attempt = { reader: live, principalId: "staff", ttlMs: 1000 };
  const original = await sessions.openSession(f.db, attempt, f.now), digest = original.readerDigest;
  const closure = await f.close(f.now + 1);
  await expect(sessions.openSession(f.db, { ...attempt, sessionId: original.sessionId }, original.expiresAt)).rejects.toMatchObject({
    expiredLeases: [{ sessionId: original.sessionId, expiresAt: original.expiresAt }] });
  const recovered = await sessions.openSession(f.db, { ...attempt, ttlMs: 5000 }, original.expiresAt);
  await sessions.closeReader(f.db, digest, { retiredOnly: true });
  const authorities = () => Promise.all([`cmsReaderSessionWindows/${digest}`, `${closures.COLLECTION}/${f.old.pairId}/readers/${digest}`, `${closures.COLLECTION}/${f.old.pairId}`]
    .map(async path => (await f.db.doc(path).get()).data()));
  const before = await authorities(), expired = await sessions.assertPairReaderWindowsExpired(f.db, f.old.pairId, original.expiresAt);
  expect(before[1].maxExpiresAt).toBe(original.expiresAt);
  await expect(sessions.sweepClosedReaderSessions(f.db, digest, recovered.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  expect(await sessions.sweepClosedReaderSessions(f.db, digest, recovered.expiresAt)).toEqual({ readerDigest: digest, deleted: 2, complete: true });
  expect(await authorities()).toEqual(before);
  expect(await sessions.assertPairReaderWindowsExpired(f.db, f.old.pairId, original.expiresAt)).toEqual(expired);
  await expect(sessions.openSession(f.db, { ...attempt, sessionId: original.sessionId }, recovered.expiresAt)).rejects.toThrow("no longer issues");
  const selected = await f.select(recovered.expiresAt);
  expect(selected.retirement).toMatchObject({ pairId: f.old.pairId, closureDigest: pairs.digest(closure) });
});
it("fences base-revision reader issuance, including an installed endpoint that never opened a session", async () => {
  const f = await fixture();
  const legacyReaders = await recordInstalledClosureReaders(f.db, f.now, Object.fromEntries(Object.entries(f.liveReaders).map(([key, value]) => [key,
    { ...value, sourceSha: "d".repeat(40) }])));
  const original = await legacySessions.openSession(f.db, { reader: legacyReaders.cmsApi, principalId: "staff", ttlMs: 1000 }, f.now);
  const neverUsed = sessions.readerSessionDigest(legacyReaders.functions);
  expect((await f.db.doc(`cmsReaderSessionWindows/${neverUsed}`).get()).exists).toBe(false);
  const closure = await f.close(f.now + 1);
  expect(closure.readerFence.closedReaderDigests).toEqual(expect.arrayContaining([original.readerDigest, neverUsed]));
  for (const reader of Object.values(legacyReaders)) await expect(legacySessions.openSession(f.db,
    { reader, principalId: "staff", ttlMs: 5000 }, f.now + 2)).rejects.toThrow("no longer issues");
  expect(await legacySessions.assertSession(f.db, { sessionId: original.sessionId, principalId: "staff", readerDigest: original.readerDigest }, f.now + 3)).toEqual(original);
  expect((await f.db.doc(`${closures.COLLECTION}/${f.old.pairId}/readers/${original.readerDigest}`).get()).data()!.maxExpiresAt).toBe(original.expiresAt);
  await sessions.openSession(f.db, { reader: f.liveReaders.cmsApi, principalId: "staff", ttlMs: 5000 }, f.now + 4);
  expect((await f.select(original.expiresAt)).selector.selectedPairId).toBe(f.next.pairId);
});
it.each(["functions", "cmsApi"])("refuses closure until the actual deployed %s session implementation proves closure support", async component => {
  const f = await fixture(), identity = sessions.readerSessionDigest(f.liveReaders[component]);
  await f.db.doc(`cmsReaderSessionWindows/${identity}`).delete();
  await legacySessions.openSession(f.db, { reader: f.liveReaders[component], principalId: "staff", ttlMs: 1000 }, f.now);
  await expect(f.close()).rejects.toThrow("Closure-aware deployed");
  expect((await f.db.doc(`${closures.COLLECTION}/${f.old.pairId}`).get()).exists).toBe(false);
  expect(await f.current()).toEqual(f.initial);
});
it.each(["started", "uncertain"])("refuses closure and retirement across a %s reader-install attempt", async state => {
  const f = await fixture(), attempt = f.db.doc("cmsReaderBridgeInstallAttempts/reader-in-flight");
  await attempt.set({ schemaVersion: 2, state, requestDigest: "a".repeat(64) });
  await expect(f.close()).rejects.toThrow("must settle");
  await attempt.delete(); await f.close();
  await attempt.set({ schemaVersion: 2, state, requestDigest: "a".repeat(64) });
  await expect(f.select()).rejects.toThrow("must settle");
  expect(await f.current()).toEqual(f.initial);
  expect((await f.db.doc(`cmsPreviewSerializerJournals/${f.old.serializerId}`).get()).exists).toBe(false);
});
it("a deployed source without its actual installed proof cannot authorize closure", async () => {
  const f = await fixture(), proofs = await f.db.collection("cmsReaderBridgeInstalledProofs").get();
  for (const row of proofs.docs) await row.ref.delete();
  await expect(f.close()).rejects.toThrow("Closure-aware deployed"); expect(await f.current()).toEqual(f.initial);
});
it("accepts both proof namespaces written by the real reader installer before closure and replacement", async () => {
  const f = await fixture(), fixtureBridge = bridgeFixture(f.now), request = { ...fixtureBridge.request, readers: f.liveReaders };
  const proofs = require("../../functions/lib/cms-reader-bridge-proof.js"), identity = proofs.cmsReaderBridgeProofKey(f.liveReaders);
  const record = (await f.db.doc(`cmsReaderBridgeInstalledProofs/${identity}`).get()).data()!;
  await f.db.doc(`cmsReaderBridgeInstalledProofs/${identity}`).delete();
  await f.db.doc(`cmsReaderBridgeInstalledProofs/${request.operationId}`).delete();
  await f.db.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`).set({ schemaVersion: 2, state: "complete",
    requestDigest: pairs.digest(request), proof: record.proof });
  const result = await installCmsReaderBridge({ firestore: f.db, request, now: () => f.now,
    candidates: { functions: { component: "functions" }, cmsApi: { component: "cmsApi" } },
    commitReader: async (_db: unknown, input: { component: string }) => (await f.db.doc(`${pairs.READER_RECEIPTS}/${input.component}`).get()).data(),
    readProviders: async () => Object.fromEntries(Object.entries(f.liveReaders).map(([key, value]) => [key, value.providerIdentities])),
    readLiveState: async () => fixtureBridge.state, assertStateInTransaction: async () => pairs.digest(fixtureBridge.state) });
  expect((await f.db.doc(`cmsReaderBridgeInstalledProofs/${request.operationId}`).get()).data()).toEqual(result);
  expect((await f.db.doc(`cmsReaderBridgeInstalledProofs/${identity}`).get()).data()).toEqual(result);
  await f.close(); expect((await f.select()).selector.selectedPairId).toBe(f.next.pairId);
});
it("an uncertain old-reader probe can fix forward by fencing its original request identities without another probe", async () => {
  const f = await fixture(), { runOperator } = require("../../scripts/replace-cms-preview-pair.cjs");
  const request = { ...bridgeFixture(f.now).request, operationId: "reader-uncertain-old",
    readers: Object.fromEntries(Object.entries(f.liveReaders).map(([key, value]) => [key, { ...value, sourceSha: "d".repeat(40) }])) };
  const attempt = f.db.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`);
  await attempt.set({ schemaVersion: 2, state: "uncertain", requestDigest: pairs.digest(request) });
  await expect(f.close()).rejects.toThrow("must settle");
  await expect(runOperator({ firestore: f.db, command: "fence-reader", input: { ...request, expectedStateDigest: "e".repeat(64) } })).rejects.toThrow();
  const result = await runOperator({ firestore: f.db, command: "fence-reader", input: request });
  expect(await runOperator({ firestore: f.db, command: "fence-reader", input: request })).toEqual(result);
  for (const reader of Object.values(request.readers)) await expect(legacySessions.openSession(f.db, { reader, principalId: "staff", ttlMs: 1000 }, f.now)).rejects.toThrow("no longer issues");
  await f.close(); expect((await f.select()).selector.selectedPairId).toBe(f.next.pairId);
  expect((await attempt.get()).data()!.state).toBe("uncertain");
});
it("the attempt fence refuses closing unstamped current deployed readers before changing their issuance windows", async () => {
  const f = await fixture(), { runOperator } = require("../../scripts/replace-cms-preview-pair.cjs");
  for (const reader of Object.values(f.liveReaders)) {
    await f.db.doc(`cmsReaderSessionWindows/${sessions.readerSessionDigest(reader)}`).delete();
    await legacySessions.openSession(f.db, { reader, principalId: "staff", ttlMs: 1000 }, f.now);
  }
  const request = { ...bridgeFixture(f.now).request, readers: f.liveReaders };
  await f.db.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`).set({ schemaVersion: 2, state: "uncertain", requestDigest: pairs.digest(request) });
  await expect(runOperator({ firestore: f.db, command: "fence-reader", input: request })).rejects.toThrow("Current CMS readers");
  expect((await f.db.collection("cmsPreviewReaderAttemptFences").get()).empty).toBe(true);
  await legacySessions.openSession(f.db, { reader: f.liveReaders.cmsApi, principalId: "staff", ttlMs: 1000 }, f.now);
});
it("an uncertain probe of already-current closure-aware readers records evidence without closing Admin issuance", async () => {
  const f = await fixture(), { runOperator } = require("../../scripts/replace-cms-preview-pair.cjs");
  const request = { ...bridgeFixture(f.now).request, operationId: "reader-current-uncertain", readers: f.liveReaders };
  await f.db.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`).set({ schemaVersion: 2, state: "uncertain", requestDigest: pairs.digest(request) });
  await expect(f.close()).rejects.toThrow("must settle");
  await runOperator({ firestore: f.db, command: "fence-reader", input: request });
  for (const reader of Object.values(f.liveReaders)) expect((await f.db.doc(`cmsReaderSessionWindows/${sessions.readerSessionDigest(reader)}`).get()).data()!.closed).toBe(false);
  await f.close();
  await sessions.openSession(f.db, { reader: f.liveReaders.cmsApi, principalId: "staff", ttlMs: 5000 }, f.now + 1);
  expect((await f.select()).selector.selectedPairId).toBe(f.next.pairId);
});
it("fencing an uncertain closure-aware probe before installation preserves the next readers' issuance", async () => {
  const f = await fixture(), { runOperator } = require("../../scripts/replace-cms-preview-pair.cjs");
  const readers = Object.fromEntries(Object.entries(f.liveReaders).map(([key, value]) => [key, { ...value, sourceSha: "e".repeat(40) }]));
  for (const reader of Object.values(readers)) await sessions.openSession(f.db, { reader, principalId: "probe", ttlMs: 1 }, f.now - 2);
  const request = { ...bridgeFixture(f.now).request, operationId: "reader-next-uncertain", readers };
  await f.db.doc(`cmsReaderBridgeInstallAttempts/${request.operationId}`).set({ schemaVersion: 2, state: "uncertain", requestDigest: pairs.digest(request) });
  await runOperator({ firestore: f.db, command: "fence-reader", input: request });
  const installed = await installClosureReaders(f.db, f.now, readers);
  await f.close();
  await sessions.openSession(f.db, { reader: installed.cmsApi, principalId: "staff", ttlMs: 5000 }, f.now + 1);
  expect((await f.db.doc(`cmsReaderSessionWindows/${sessions.readerSessionDigest(installed.cmsApi)}`).get()).data()!.closed).toBe(false);
});
it("a terminal journal record fences the base-revision image after selection and survives idempotent clear", async () => {
  const f = await fixture(), old = await openLegacyJournal({ firestore: f.db, serializerId: f.old.serializerId });
  await f.close(); const selected = await f.select();
  const path = f.db.doc(`cmsPreviewSerializerJournals/${f.old.serializerId}`), tombstone = (await path.get()).data();
  expect(tombstone).toEqual(selected.retirement.retiredJournal);
  expect(tombstone).toMatchObject({ schemaVersion: 2, job: null, retirement: { pairId: f.old.pairId } });
  await expect(old.reserve({ queueId: "A".repeat(20), buildBatchId: `preview-${"A".repeat(20)}`, commitSha: f.old.rendererSha })).rejects.toThrow("journal is invalid");
  const current = await openCmsPreviewCloudTokenJournal({ firestore: f.db, serializerId: f.old.serializerId });
  expect(await current.read()).toBeNull();
  expect(await current.clear({ queueId: "A".repeat(20), claimToken: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) })).toEqual({ idempotent: true });
  expect((await path.get()).data()).toEqual(tombstone);
});
it("recovery closure races session issuance on the same document and cannot be retimed by a retry", async () => {
  const f = await fixture(), live = reader("cmsApi", f.now);
  const [lease, closure] = await Promise.all([sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 1000 }, f.now), f.close()]);
  expect(await f.close(f.now + 500)).toEqual(closure);
  const path = `${closures.COLLECTION}/${f.old.pairId}/readers/${lease.readerDigest}`;
  const before = (await f.db.doc(path).get()).data();
  const newer = await sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 10_000 }, f.now + 1);
  await sessions.assertSession(f.db, { sessionId: newer.sessionId, principalId: "staff", readerDigest: newer.readerDigest }, f.now + 2);
  expect((await f.db.doc(path).get()).data()).toEqual(before);
  await f.select(f.now + 1000);
});
it("operator clock skew cannot pause selected-pair sessions or extend the captured recovery frontier", async () => {
  const f = await fixture(), live = reader("cmsApi", f.now);
  const original = await sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 1000 }, f.now);
  await f.close(f.now + 60_000);
  const newer = await sessions.openSession(f.db, { reader: live, principalId: "staff", ttlMs: 5000 }, f.now + 1);
  expect(await sessions.assertSession(f.db, { sessionId: newer.sessionId, principalId: "staff", readerDigest: newer.readerDigest }, f.now + 2)).toEqual(newer);
  expect((await f.db.doc(`${closures.COLLECTION}/${f.old.pairId}/readers/${original.readerDigest}`).get()).data()!.maxExpiresAt).toBe(original.expiresAt);
});
it("closure conservatively captures leases that predate this recovery pair's retention", async () => {
  const f = await fixture(), earlier = pair("earlier", "d"); await pairs.registerPair(f.db, earlier);
  await f.db.doc(pairs.SELECTOR_PATH).set(selector(f.selected, earlier));
  const lease = await sessions.openSession(f.db, { reader: reader("cmsApi", f.now), principalId: "staff", ttlMs: 1000 }, f.now);
  const dependency = f.db.doc(`${closures.COLLECTION}/${f.old.pairId}/readers/${lease.readerDigest}`);
  expect((await dependency.get()).exists).toBe(false);
  await f.db.doc(pairs.SELECTOR_PATH).set(f.initial); await f.close(f.now + 1);
  expect((await dependency.get()).data()!.maxExpiresAt).toBe(lease.expiresAt);
  await expect(f.select(lease.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  expect((await f.select(lease.expiresAt)).selector.selectedPairId).toBe(f.next.pairId);
});
it("a third pair cannot displace unclosed recovery and closure cannot target selected or a stale selector", async () => {
  const f = await fixture(); await expect(f.select()).rejects.toThrow(); expect(await f.current()).toEqual(f.initial);
  await expect(closures.closeRecoveryReaderIssuance(f.db, { ...f.closeRequest, pairId: f.selected.pairId }, f.now)).rejects.toThrow();
  await expect(closures.closeRecoveryReaderIssuance(f.db, { ...f.closeRequest, expectedSelectorDigest: "f".repeat(64) }, f.now)).rejects.toThrow();
  expect((await f.db.doc(`${closures.COLLECTION}/${f.selected.pairId}`).get()).exists).toBe(false);
});
it.each(["pending", "building"])("closure leaves OLD %s work and its original journal retained until both drain", async status => {
  const f = await fixture(); await f.close();
  const id = "A".repeat(20), queue = f.db.doc(`cmsPreviewQueue/${id}`);
  await queue.set({ serializerId: f.old.serializerId, previewPairId: f.old.pairId, status });
  const journal = await openCmsPreviewCloudTokenJournal({ firestore: f.db, serializerId: f.old.serializerId });
  const reserved = await journal.reserve({ queueId: id, buildBatchId: `preview-${id}`, commitSha: f.old.rendererSha });
  await expect(f.select()).rejects.toThrow("outstanding work");
  await queue.update({ status: "ready" }); await expect(f.select()).rejects.toThrow("outstanding work");
  expect(await f.current()).toEqual(f.initial);
  await journal.clear({ queueId: id, claimToken: reserved.job.claimToken }); expect((await f.select()).selector.selectedPairId).toBe(f.next.pairId);
});
it("an incompatible historical Admin lease keeps its original expiry even after current readers advance", async () => {
  const f = await fixture(2); await f.close();
  const lease = await sessions.openSession(f.db, { reader: reader("cmsApi", f.now), principalId: "staff", ttlMs: 1000 }, f.now + 1);
  const next = f.next;
  const newReaders = await installClosureReaders(f.db, f.now, Object.fromEntries(Object.entries(f.liveReaders).map(([component, value]) => [component,
    { ...value, sourceSha: "d".repeat(40), supported: { ...value.supported, previewRequest: [1, 2] } }])));
  const nextProof = { ...proof(f.selected, next, f.now), readerDigests: Object.fromEntries(Object.entries(newReaders).map(([key, value]) => [key, pairs.digest(value)])) };
  const request = { ...f.switchRequest, proofDigest: await pairs.recordProof(f.db, nextProof) };
  await expect(pairs.selectPair(f.db, request, f.now + 2)).rejects.toThrow("both retained");
  await sessions.closeReader(f.db, lease.readerDigest);
  await expect(pairs.selectPair(f.db, request, lease.expiresAt - 1)).rejects.toThrow();
  expect((await pairs.selectPair(f.db, request, lease.expiresAt)).selector.selectedPairId).toBe(next.pairId);
});
it("a closed incarnation cannot be reselected and a third-pair plan names its retirement gates", async () => {
  const f = await fixture(); await f.close();
  const rollback = { ...f.switchRequest, newPairId: f.old.pairId };
  await expect(pairs.selectPair(f.db, rollback, f.now)).rejects.toThrow("cannot be selected again");
  const plan = planPairedCmsRelease({ selector: f.initial, selectedPair: f.selected, recoveryPair: f.old, candidatePair: f.next,
    functionsReceipt: receipt("functions", f.now), cmsApiReceipt: receipt("cmsApi", f.now) });
  expect(plan).toMatchObject({ previewPaused: false, retiringPairId: f.old.pairId });
  expect(plan.order).toContain("close-recovery-reader-issuance"); expect(await f.current()).toEqual(f.initial);
});
it("the real operator plans, closes, selects and reads back against only its explicit demo target", async () => {
  const f = await fixture(), directory = await mkdtemp(path.join(tmpdir(), "preview-recurring-operator-"));
  const script = fileURLToPath(new URL("../../scripts/replace-cms-preview-pair.cjs", import.meta.url));
  const file = path.join(directory, "request.json"), project = (f.db as any).projectId;
  const run = async (command: string, input: unknown) => {
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    return JSON.parse(execFileSync(process.execPath, [script, command, project, file], { encoding: "utf8", input: "",
      env: { ...process.env, METADATA_SERVER_DETECTION: "none" }, timeout: 20_000 }));
  };
  try {
    const legacy = { ...bridgeFixture(f.now).request, operationId: "reader-cli-uncertain",
      readers: Object.fromEntries(Object.entries(f.liveReaders).map(([key, value]) => [key, { ...value, sourceSha: "e".repeat(40) }])) };
    await f.db.doc(`cmsReaderBridgeInstallAttempts/${legacy.operationId}`).set({ schemaVersion: 2, state: "uncertain", requestDigest: pairs.digest(legacy) });
    expect(await run("fence-reader", legacy)).toMatchObject({ operationId: legacy.operationId, requestDigest: pairs.digest(legacy) });
    const closurePlan = await run("plan", { operationId: f.switchRequest.operationId });
    expect(closurePlan.phase).toBe("close-recovery"); expect(await f.current()).toEqual(f.initial);
    expect(await run("close", closurePlan.closeRequest)).toMatchObject({ pairId: f.old.pairId });
    expect(await f.current()).toEqual(f.initial);
    const plan = await run("plan", { operationId: f.switchRequest.operationId, newPairId: f.next.pairId, proofDigest: f.switchRequest.proofDigest });
    expect(plan.plan.retiringPairId).toBe(f.old.pairId);
    const selected = await run("select", plan.selectionRequest);
    expect(selected.selector.selectedPairId).toBe(f.next.pairId);
    expect(await run("receipt", { operationId: f.switchRequest.operationId })).toMatchObject({ selector: selected.selector });
    const refused = spawnSync(process.execPath, [script, "select", "njpbs-site-dev", file], { encoding: "utf8", input: "must-not-be-consumed",
      env: { ...process.env, METADATA_SERVER_DETECTION: "none" }, timeout: 20_000 });
    expect(refused.status).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toBe("Recurring preview operator refused.\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
it("a full24h drain uses a proof-free closure then a newly qualified candidate and selection plan", async () => {
  const f = await fixture(), { runOperator } = require("../../scripts/replace-cms-preview-pair.cjs");
  const lease = await sessions.openSession(f.db, { reader: reader("cmsApi", f.now), principalId: "staff", ttlMs: sessions.MAX_SESSION_MS }, f.now);
  await f.db.doc(`${pairs.PROOFS}/${f.switchRequest.proofDigest}`).delete();
  const closePlan = await runOperator({ firestore: f.db, command: "plan", input: { operationId: f.switchRequest.operationId } });
  expect(closePlan).not.toHaveProperty("selectionRequest");
  await runOperator({ firestore: f.db, command: "close", input: closePlan.closeRequest, now: f.now + 1 });
  const after = lease.expiresAt + 1;
  await expect(f.select(after)).rejects.toThrow(); expect(await f.current()).toEqual(f.initial);
  const liveReaders = await installClosureReaders(f.db, after);
  const fresh = candidate(f.next, after); fresh.mutation.runId = "200";
  await f.db.doc("cmsDeploymentCandidates/renderer-200-1").set(fresh);
  const freshProof = { ...proof(f.selected, f.next, after), candidateReceiptId: "renderer-200-1",
    readerDigests: Object.fromEntries(Object.entries(liveReaders).map(([key, value]) => [key, pairs.digest(value)])) };
  const proofDigest = await pairs.recordProof(f.db, freshProof);
  const plan = await runOperator({ firestore: f.db, command: "plan", input: { operationId: f.switchRequest.operationId,
    newPairId: f.next.pairId, proofDigest }, now: after });
  expect((await runOperator({ firestore: f.db, command: "select", input: plan.selectionRequest, now: after })).selector.selectedPairId).toBe(f.next.pairId);
});
it("cancellation before a selection commit preserves the original selector and receipt", async () => {
  const f = await fixture(); await f.close(); const signal = AbortSignal.abort();
  await expect(pairs.selectPair(f.db, { ...f.switchRequest, signal }, f.now)).rejects.toThrow();
  expect(await f.current()).toEqual(f.initial); expect((await f.db.doc(`${pairs.SWITCHES}/${f.switchRequest.operationId}`).get()).exists).toBe(false);
});

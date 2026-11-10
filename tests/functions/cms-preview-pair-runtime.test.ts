import { beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { pair, receipt, candidate, selector, proof } from "../helpers/cms-preview-pairs.js";
import { assertPreviewRuntimeIdentity, confirmPreviewRuntimeReady, previewPairDrained, assertPreviewPairRetirement } from "../../site/scripts/cms-preview-cloud-control";
import { openCmsPreviewCloudTokenJournal } from "../../site/scripts/cms-preview-cloud-token-journal";
const require = createRequire(import.meta.url);
const pairs = require("../../functions/lib/cms-preview-pair.js");
const { enqueuePreview } = require("../../functions/preview.js");
const { claimCmsPreviewQueue, finishCmsPreviewQueue } = require("../../functions/lib/cms-preview-serializer.js");
const db = isolatedFirestore("preview-pair-runtime");
const old = pair("old"), next = pair("new", "b"), initial = selector(old, next);
let now: number;
const actor = { uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } };
const fields = { actor, collection: "cmsPages", pageId: "contact", sourceVersion: 7, persistent: false };
const deps = () => ({ firestore: db, getTransport: () => "serializer", serializerReady: true,
  getRendererSha: () => old.rendererSha, assertBillingEnabledFn: async () => true, now: () => now });
const current = async () => (await db.doc(pairs.SELECTOR_PATH).get()).data();
async function select() {
  return pairs.selectPair(db, { operationId: "preview-switch", newPairId: next.pairId,
    expectedSelectorDigest: pairs.digest(initial), proofDigest: await pairs.recordProof(db, proof(old, next, now)) }, now);
}
beforeEach(async () => {
  now = Date.now();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await pairs.registerPair(db, old); await pairs.registerPair(db, next);
  await db.doc(pairs.SELECTOR_PATH).set(initial);
  await db.doc(pairs.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: "renderer", state: "complete",
    pairId: old.pairId, selectorDigest: pairs.digest(initial), lastComplete: candidate(old, now).mutation });
  for (const component of ["functions", "cmsApi"]) await db.doc(`${pairs.READER_RECEIPTS}/${component}`).set(receipt(component, now));
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(candidate(next, now));
  await db.doc("cmsPages/contact").set({ title: "Saved", description: "Saved page", template: "genericPage", status: "draft",
    blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }], version: 7 });
});
it.each([false, true])("retries the original saved operation after a switch (retained=%s)", async persistent => {
  const first = await enqueuePreview({ ...fields, persistent }, deps());
  const frozen = (await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data()!;
  expect(frozen).toMatchObject({ previewPairId: old.pairId, serializerId: old.serializerId, previewEpoch: 1, previewRequestContract: 1 });
  await select();
  expect(await enqueuePreview({ ...fields, persistent }, deps())).toMatchObject({ queueId: first.queueId,
    previewPairId: old.pairId, rendererSha: old.rendererSha, reused: true });
  expect((await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data()).toEqual(frozen);
  await db.doc("cmsPages/contact").update({ version: 8 });
  const second = await enqueuePreview({ ...fields, persistent, sourceVersion: 8 }, deps());
  expect(second).toMatchObject({ previewPairId: next.pairId, rendererSha: next.rendererSha });
  expect((await db.doc(`cmsPreviewQueue/${second.queueId}`).get()).data()).toMatchObject({ previewEpoch: 2, serializerId: next.serializerId });
});
it("acceptance racing selection keeps each frozen row entirely on one side", async () => {
  const [accepted] = await Promise.all([enqueuePreview(fields, deps()), select()]);
  const row = (await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()!;
  const owner = row.previewPairId === old.pairId ? old : next;
  expect(row).toMatchObject({ rendererSha: owner.rendererSha, serializerId: owner.serializerId,
    previewEpoch: owner === old ? 1 : 2, snapshot: { version: 7 } });
  expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
});
it("OLD claims and settles only its own work after NEW selection, retaining its journal", async () => {
  const accepted = await enqueuePreview(fields, deps());
  const journal = await openCmsPreviewCloudTokenJournal({ firestore: db, serializerId: old.serializerId });
  const { job } = await journal.reserve({ queueId: accepted.queueId, buildBatchId: `preview-${accepted.queueId}`, commitSha: old.rendererSha });
  await select();
  const input = { firestore: db, queueId: accepted.queueId, rendererSha: old.rendererSha,
    serializerId: old.serializerId, claimToken: job.claimToken, now: () => now + 1_000 };
  await expect(claimCmsPreviewQueue({ ...input, rendererSha: next.rendererSha, serializerId: next.serializerId })).rejects.toThrow("another retained pair");
  expect(await claimCmsPreviewQueue(input)).toHaveProperty("outcome", "claimed");
  expect(await previewPairDrained(db, old.pairId)).toBe(false);
  const row = (await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()!;
  await finishCmsPreviewQueue({ ...input, pageId: fields.pageId, sourceVersion: 7, status: "ready", expiresAtMs: row.expiresAt.toMillis() });
  expect(await previewPairDrained(db, old.pairId)).toBe(false);
  await journal.clear({ queueId: accepted.queueId, claimToken: job.claimToken });
  expect(await previewPairDrained(db, old.pairId)).toBe(true);
  expect((await current())!.selectedPairId).toBe(next.pairId);
});
it("retained startup attests only itself and cannot pause or rewrite selection", async () => {
  await select();
  const before = await current();
  await confirmPreviewRuntimeReady(db, old.rendererSha, old.serializerId, { "source-check": 12 });
  await confirmPreviewRuntimeReady(db, next.rendererSha, next.serializerId);
  expect(await current()).toEqual(before);
  expect((await db.doc(`cmsPreviewPairReadiness/${old.pairId}`).get()).data()).toMatchObject({ rendererSha: old.rendererSha, phase: "ready" });
  await expect(assertPreviewRuntimeIdentity(db, next.rendererSha, old.serializerId)).rejects.toThrow("retained pair");
  await expect(assertPreviewRuntimeIdentity(db, old.rendererSha, "preview-other")).rejects.toThrow();
});
it("expires OLD work without transferring a claim or changing the selector", async () => {
  const accepted = await enqueuePreview(fields, deps());
  await select();
  const row = (await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()!;
  await db.doc(`cmsPreviewQueue/${accepted.queueId}`).update({ expiresAt: new Date(now + 500) });
  await expect(claimCmsPreviewQueue({ firestore: db, queueId: accepted.queueId, rendererSha: old.rendererSha,
    serializerId: old.serializerId, claimToken: "22222222-2222-4222-8222-222222222222", now: () => now + 1_000 })).resolves.toMatchObject({ outcome: "terminal", status: "expired" });
  expect((await current())!.selectedPairId).toBe(next.pairId);
});

it("keeps selected/recovery pairs and supported Admin sessions out of retirement", async () => {
  const sessions = require("../../functions/lib/cms-reader-session.js");
  const readers = [receipt("functions", now).lastComplete, receipt("cmsApi", now).lastComplete];
  const digests = readers.map(reader => sessions.readerSessionDigest(reader));
  await expect(assertPreviewPairRetirement(db, old.pairId, digests, now)).rejects.toThrow("still retained");
  await expect(assertPreviewPairRetirement(db, next.pairId, digests, now)).rejects.toThrow("still retained");
  const leases = await Promise.all(readers.map((reader, i) => sessions.openSession(db, { reader, principalId: "staff",
    sessionId: `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`, ttlMs: 60_000 }, now)));
  await Promise.all(digests.map(value => sessions.closeReader(db, value)));
  // A future separately authorized selector removes the incarnation before reuse.
  // This fixture only proves that the gate itself never edits that selector.
  const replacement = selector(pair("later", "c"), next);
  await db.doc(pairs.SELECTOR_PATH).set(replacement);
  await expect(assertPreviewPairRetirement(db, old.pairId, digests, now)).rejects.toThrow("old Admin sessions");
  const evidence = await assertPreviewPairRetirement(db, old.pairId, digests, leases[0].expiresAt);
  expect(evidence).toMatchObject({ pairId: old.pairId, selectorDigest: pairs.digest(replacement) });
  expect(await current()).toEqual(replacement);
});

it.each(["ready", "failed", "expired"])("allows a fresh retained preview after a finished legacy %s head", async status => {
  const first = await enqueuePreview({ ...fields, persistent: true }, deps());
  const ref = db.doc(`cmsPreviewQueue/${first.queueId}`);
  const { previewPairId, serializerId, previewEpoch, previewRequestContract, ...legacy } = (await ref.get()).data()!;
  await ref.set({ ...legacy, status });
  const replacement = await enqueuePreview({ ...fields, persistent: true }, deps());
  expect(replacement.queueId).not.toBe(first.queueId);
  expect(replacement.previewPairId).toBe(old.pairId);
});

it("refuses unrelated closed reader windows as retirement proof for actual deployed components", async () => {
  const sessions=require("../../functions/lib/cms-reader-session.js");
  const replacement=selector(pair("later","c"),next);
  await db.doc(pairs.SELECTOR_PATH).set(replacement);
  const otherReaders=["e","f"].map(source=>({...receipt("functions",now).lastComplete,sourceSha:source.repeat(40)}));
  const unrelated=otherReaders.map(reader=>sessions.readerSessionDigest(reader));
  await Promise.all(unrelated.map(digest=>sessions.closeReader(db,digest)));
  await expect(assertPreviewPairRetirement(db,old.pairId,unrelated,now)).rejects.toThrow("current deployed reader");
  expect(await current()).toEqual(replacement);
});

it.each([["pending", true], ["building", true], ["pending", false], ["building", false]])("retries original retained v7 %s after NEW v8 replaces the head (explicit initial version=%s)", async (status, explicit) => {
  const first = await enqueuePreview({ ...fields, sourceVersion: explicit ? 7 : undefined, persistent: true }, deps());
  await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ status });
  const frozen = (await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data();
  await select();
  await db.doc("cmsPages/contact").update({ version: 8 });
  const newer = await enqueuePreview({ ...fields, persistent: true, sourceVersion: 8 }, deps());
  expect(newer.previewPairId).toBe(next.pairId);
  expect(await enqueuePreview({ ...fields, persistent: true }, deps())).toMatchObject({ queueId: first.queueId, previewPairId: old.pairId, reused: true });
  expect((await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data()).toEqual(frozen);
  expect((await db.collection("cmsPreviewQueue").get()).size).toBe(2);
});

it("keeps prior deployed reader leases in the retirement proof after both component receipts advance", async () => {
  const sessions = require("../../functions/lib/cms-reader-session.js");
  const oldReader = receipt("functions", now).lastComplete;
  const lease = await sessions.openSession(db, { reader: oldReader, principalId: "staff", ttlMs: 60_000 }, now);
  const replacements = ["functions", "cmsApi"].map(component => ({ ...receipt(component, now).lastComplete, sourceSha: "e".repeat(40) }));
  for (const reader of replacements) await db.doc(`${pairs.READER_RECEIPTS}/${reader.component}`).set({ schemaVersion: 2, component: reader.component, state: "complete", lastComplete: reader });
  const required = replacements.map(reader => sessions.readerSessionDigest(reader));
  await Promise.all(required.map(digest => sessions.closeReader(db, digest)));
  const later = pair("later", "c"); await pairs.registerPair(db, later);
  await db.doc(pairs.SELECTOR_PATH).set(selector(later, next));
  expect(await sessions.assertSession(db, { sessionId: lease.sessionId, principalId: "staff", readerDigest: lease.readerDigest }, now)).toEqual(lease);
  await expect(assertPreviewPairRetirement(db, old.pairId, required, now)).rejects.toThrow("old Admin sessions");
  await sessions.closeReader(db, lease.readerDigest);
  await expect(assertPreviewPairRetirement(db, old.pairId, required, now)).rejects.toThrow("old Admin sessions");
  const evidence = await assertPreviewPairRetirement(db, old.pairId, required, lease.expiresAt);
  expect(evidence.expired.map(value => value.readerDigest)).toContain(lease.readerDigest);
});

it("retires only the expired pair dependencies while current and prior scoped readers keep issuing sessions", async () => {
  const sessions = require("../../functions/lib/cms-reader-session.js");
  const oldReader = receipt("functions", now).lastComplete;
  const original = await sessions.openSession(db, { reader: oldReader, principalId: "staff", ttlMs: 60_000 }, now);
  expect(original.pairDependencyVersion).toBe(1);
  const later = pair("later", "c"); await pairs.registerPair(db, later);
  await db.doc(pairs.SELECTOR_PATH).set(selector(later, next));
  const replacements = ["functions", "cmsApi"].map(component => ({ ...receipt(component, now).lastComplete, sourceSha: "e".repeat(40) }));
  for (const reader of replacements) {
    await db.doc(`${pairs.READER_RECEIPTS}/${reader.component}`).set({ schemaVersion: 2, component: reader.component, state: "complete", lastComplete: reader });
    await sessions.openSession(db, { reader, principalId: "staff", ttlMs: 60_000 }, now + 30_000);
  }
  await sessions.assertSession(db, { sessionId: original.sessionId, principalId: "staff", readerDigest: original.readerDigest }, now + 30_000);
  const priorNewLease = await sessions.openSession(db, { reader: oldReader, principalId: "staff", ttlMs: 60_000 }, now + 30_000);
  const required = replacements.map(reader => sessions.readerSessionDigest(reader));
  await expect(assertPreviewPairRetirement(db, old.pairId, required, original.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  expect((await db.collection("cmsReaderSessionWindows").get()).docs.every(row => row.data().closed === false)).toBe(true);
  const result = await assertPreviewPairRetirement(db, old.pairId, required, original.expiresAt);
  expect(result.expired).toContainEqual({ readerDigest: original.readerDigest, maxExpiresAt: original.expiresAt });
  expect(await sessions.assertSession(db, { sessionId: priorNewLease.sessionId, principalId: "staff", readerDigest: original.readerDigest }, original.expiresAt)).toEqual(priorNewLease);
  await expect(sessions.openSession(db, { reader: replacements[0], principalId: "staff", ttlMs: 60_000 }, original.expiresAt)).resolves.toMatchObject({ pairDependencyVersion: 1 });
  const dependency = (await db.doc(`cmsPreviewPairReaderWindows/${old.pairId}/readers/${original.readerDigest}`).get()).data();
  expect(dependency.maxExpiresAt).toBe(original.expiresAt);
});

it("keeps legacy unscoped leases in history without upgrading their window on schema-two adoption", async () => {
  const sessions = require("../../functions/lib/cms-reader-session.js");
  const legacyReader = receipt("functions", now).lastComplete;
  await db.doc(pairs.SELECTOR_PATH).delete();
  const legacyLease = await sessions.openSession(db, { reader: legacyReader, principalId: "staff", ttlMs: 60_000 }, now);
  await db.doc(pairs.SELECTOR_PATH).set(initial);
  const second = await sessions.openSession(db, { reader: legacyReader, principalId: "staff", ttlMs: 30_000 }, now);
  expect(legacyLease.pairDependencyVersion).toBeUndefined(); expect(second.pairDependencyVersion).toBeUndefined();
  const later = pair("later", "c"); await pairs.registerPair(db, later);
  await db.doc(pairs.SELECTOR_PATH).set(selector(later, next));
  const replacements = ["functions", "cmsApi"].map(component => ({ ...receipt(component, now).lastComplete, sourceSha: "e".repeat(40) }));
  for (const reader of replacements) {
    await db.doc(`${pairs.READER_RECEIPTS}/${reader.component}`).set({ schemaVersion: 2, component: reader.component, state: "complete", lastComplete: reader });
    await sessions.openSession(db, { reader, principalId: "staff", ttlMs: 120_000 }, now);
  }
  const required = replacements.map(reader => sessions.readerSessionDigest(reader));
  await expect(assertPreviewPairRetirement(db, old.pairId, required, now)).rejects.toThrow("old Admin sessions");
  await sessions.closeReader(db, legacyLease.readerDigest);
  await expect(assertPreviewPairRetirement(db, old.pairId, required, legacyLease.expiresAt - 1)).rejects.toThrow("old Admin sessions");
  await expect(assertPreviewPairRetirement(db, old.pairId, required, legacyLease.expiresAt)).resolves.toMatchObject({ pairId: old.pairId });
});

it.each(["pending","building"])("preserves the typed updating state for an unretained %s head", async status => {
  const first=await enqueuePreview({...fields,persistent:true},deps());
  const ref=db.doc(`cmsPreviewQueue/${first.queueId}`);
  const {previewPairId,...unretained}=(await ref.get()).data()!;
  await ref.set({...unretained,status});
  await expect(enqueuePreview({...fields,persistent:true},deps())).rejects.toMatchObject({status:503,code:"preview-renderer-updating"});
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { releaseSelector } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import retention from "../../functions/lib/public-release-media-retention.js";
import coverage from "../../functions/lib/public-release-media-coverage.js";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { preparePublicReleasePairMediaPin, retainPreparedPublicReleasePairMediaPin,
  preparePublicReleasePairCodeMediaPin, preparePublicReleasePairMediaPinInTransaction } from "../../site/scripts/public-release-pair-media-pin";
import { capturePublicReleasePairInput, openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";

let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>, directory: string;
const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
const store: PairViewStore = {
  async put(key, bytes, options) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), metadata: { ...options.customMetadata } }); },
  async get(key) { const value = objects.get(key); return value ? { size: value.bytes.length, customMetadata: value.metadata,
    body: new Response(new Uint8Array(value.bytes)).body! } : null; },
};
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-media-pin-"));
  fixture = await publicReleasePairCompositeFixture({ firestore: isolatedFirestore("pair-media-pin"), store, directory });
  await coverage.initializePublicReleasePairMediaCoverage({ firestore: fixture.firestore, pair: fixture.sourcePair });
}, 30_000);
afterAll(async () => { await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
const capture = () => captureHistoricalPublicReleasePairInput({ firestore: fixture.firestore, pair: fixture.pair, store,
  sourceOperationId: "composite-post-change", providerStore: { async get() { throw new Error("No latest-source fallback"); },
    async put() { throw new Error("No provider writes"); } } });

it("pins the actual H media roster and repeats without overwriting the pin", async () => {
  const { firestore, pair, content } = fixture, ref = firestore.doc(retention.pinPath(pair, content.receipt.inputManifestDigest));
  const before = await ref.get(), pin = retention.parsePairMediaPin(before.data(), pair);
  expect(pin.assetIds).toHaveLength(1);
  expect(pin.inputReceiptDigest).toBe(protocol.publicReleaseDigest(content.receipt));
  const state = await firestore.doc(coverage.coveragePath(pair)).get();
  const inputs = await firestore.collection(`${fixture.base}/inputs`).get();
  expect(state.data()).toMatchObject({ phase: "tracking", totalInputs: inputs.size, pinnedInputs: inputs.size, pendingInputs: 0 });
  await capture();
  expect((await ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).updateTime!.isEqual(state.updateTime!)).toBe(true);
  const proof = await preparePublicReleasePairMediaPin({ firestore, store, pair, receipt: content.receipt });
  await expect(retainPreparedPublicReleasePairMediaPin({ firestore, proof: { ...proof } })).rejects.toThrow();
  expect((await ref.get()).data()).toEqual(pin);
});

it("requires the original CODE H pin as well as later historical H before coverage is complete", async () => {
  const { firestore, pair, codePack } = fixture, ref = firestore.doc(retention.pinPath(pair, codePack.receipt.inputManifestDigest));
  const pin = retention.parsePairMediaPin((await ref.get()).data(), pair);
  expect(pin.scope.sourceOperationId).toBe(`baseline-codepack-${fixture.global.logBaselineDigest}`);
  expect(pin.assetIds).toHaveLength(1);
  const coverage = () => firestore.runTransaction(transaction =>
    retention.assertPublicReleasePairMediaPinsInTransaction({ firestore, transaction }), { readOnly: true });
  await expect(coverage()).resolves.toBeUndefined();
  await ref.delete(); await expect(coverage()).rejects.toThrow();
  const proof = await preparePublicReleasePairCodeMediaPin({ firestore, store, pair });
  const baseline = firestore.doc(`${fixture.base}/codePacks/baseline`), original = (await baseline.get()).data()!;
  await baseline.update({ codePackManifestDigest: "f".repeat(64) });
  await expect(retainPreparedPublicReleasePairMediaPin({ firestore, proof })).rejects.toThrow();
  expect((await ref.get()).exists).toBe(false);
  await baseline.set(original);
  await capture();
  expect((await ref.get()).data()).toEqual(pin);
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof });
  expect((await ref.get()).data()).toEqual(pin);
  await expect(coverage()).resolves.toBeUndefined();
});

it("commits pending-pin debt with H once and clears it only with the actual pin transaction", async () => {
  const { firestore, pair, content, base } = fixture;
  const opened = await openPublicReleasePairInput({ firestore, store, pair,
    identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...content.root.scope,
      inputManifestDigest: content.receipt.inputManifestDigest }, expectedSource: content.root.source, expectedCursor: content.root.cursor });
  const plan = { ...content.root, scope: { ...content.root.scope, sourceOperationId: "interrupted-pin-qualification" } };
  const capturePending = () => capturePublicReleasePairInput({ firestore, store, pair, plan, expectedSource: plan.source,
    expectedCursor: plan.cursor, bindSourceOperation: true, files: (async function* () {
      for (const file of content.root.files) yield { name: file.name, bytes: await opened.readFile(file.name) };
    })() });
  const before = coverage.parseCoverage((await firestore.doc(coverage.coveragePath(pair)).get()).data(), pair);
  const captured = await capturePending(), stateRef = firestore.doc(coverage.coveragePath(pair));
  const pendingState = await stateRef.get(), marker = firestore.doc(coverage.markerPath(pair, captured.receipt.inputManifestDigest));
  expect((await firestore.doc(`${base}/inputs/${captured.receipt.inputManifestDigest}`).get()).exists).toBe(true);
  expect(pendingState.data()).toMatchObject({ phase: "tracking", totalInputs: before.totalInputs + 1,
    pinnedInputs: before.pinnedInputs, pendingInputs: 1 });
  expect((await marker.get()).data()).toMatchObject({ status: "pending", pinDigest: null,
    inputReceiptDigest: protocol.publicReleaseDigest(captured.receipt) });
  await capturePending();
  expect((await stateRef.get()).updateTime!.isEqual(pendingState.updateTime!)).toBe(true);
  await expect(firestore.runTransaction(transaction => coverage.assertPairMediaCoverageInTransaction({ firestore, transaction, pair }),
    { readOnly: true })).rejects.toThrow();
  const proof = await preparePublicReleasePairMediaPin({ firestore, store, pair, receipt: captured.receipt });
  await expect(firestore.runTransaction(async transaction => {
    const prepared = await preparePublicReleasePairMediaPinInTransaction({ firestore, transaction, proof });
    prepared.write(); throw new Error("Injected exit before SDK commit");
  })).rejects.toThrow("Injected exit before SDK commit");
  expect((await marker.get()).data()!.status).toBe("pending");
  expect((await stateRef.get()).data()!.pendingInputs).toBe(1);
  expect((await firestore.doc(retention.pinPath(pair, captured.receipt.inputManifestDigest)).get()).exists).toBe(false);
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof });
  expect((await marker.get()).data()).toMatchObject({ status: "pinned", pinDigest: proof.retentionDigest });
  expect((await stateRef.get()).data()).toMatchObject({ totalInputs: before.totalInputs + 1,
    pinnedInputs: before.pinnedInputs + 1, pendingInputs: 0 });
});

it("refuses a conflicting chunk before marking the outbox captured, then atomically repairs from the original H", async () => {
  const { firestore, pair, content, base } = fixture, ref = firestore.doc(retention.pinPath(pair, content.receipt.inputManifestDigest));
  const pin = retention.parsePairMediaPin((await ref.get()).data(), pair);
  const chunk = firestore.doc(`${base}/mediaUsage/chunk-${pin.chunks[0]}`);
  const originalChunk = (await chunk.get()).data()!;
  const outbox = firestore.doc("system/publicReleaseChanges/captures/composite-post-change");
  await ref.delete(); await chunk.set({ ...originalChunk, sourceMetadataDigest: "e".repeat(64) });
  await outbox.update({ status: "pending", packs: {} });
  await expect(capture()).rejects.toThrow();
  expect((await ref.get()).exists).toBe(false);
  expect((await outbox.get()).data()!.packs).toEqual({});
  await chunk.delete(); await capture();
  expect((await ref.get()).data()).toEqual(pin);
  expect((await chunk.get()).data()).toEqual(originalChunk);
  const value = (await outbox.get()).data()!;
  expect(Object.values(value.packs)).toContainEqual(expect.objectContaining({ status: "captured",
    inputManifestDigest: content.receipt.inputManifestDigest, receiptDigest: pin.inputReceiptDigest }));
});

it("protects retained media across selection epochs and holds missing-head or capture-gap absence", async () => {
  const { firestore, pair, content } = fixture;
  const pin = retention.parsePairMediaPin((await firestore.doc(retention.pinPath(pair, content.receipt.inputManifestDigest)).get()).data(), pair);
  const hold = (root: unknown, assetId: string) => firestore.runTransaction(transaction =>
    retention.readRetainedPairMediaHoldInTransaction({ firestore, transaction, root, assetId }), { readOnly: true });
  for (const epoch of [1, 7]) expect(await hold({ ...releaseSelector(), epoch }, pin.assetIds[0])).toBe("pair-retained");
  const outbox = firestore.doc("system/publicReleaseChanges/captures/composite-post-change");
  await outbox.update({ status: "pending" });
  expect(await hold(releaseSelector(), "never-captured")).toBe("capture-gap");
  await outbox.update({ status: "captured" });
  expect(await hold(releaseSelector(), "never-captured")).toBe("pair-retention-unproven");
});

it("re-enrolls exact pins once after ledger loss and leaves incomplete legacy coverage fenced", async () => {
  const { firestore, pair } = fixture, ref = firestore.doc(coverage.coveragePath(pair));
  const original = coverage.parseCoverage((await ref.get()).data(), pair);
  await ref.delete();
  const rebuilt = await coverage.initializePublicReleasePairMediaCoverage({ firestore, pair });
  expect(rebuilt.phase).toBe("needs-migration");
  expect(rebuilt.ledgerId).not.toBe(original.ledgerId);
  const proof = await preparePublicReleasePairCodeMediaPin({ firestore, store, pair });
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof });
  await capture();
  const enrolled = await ref.get();
  expect(enrolled.data()).toMatchObject({ phase: "needs-migration", totalInputs: 2, pinnedInputs: 2, pendingInputs: 0 });
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof });
  await capture();
  expect((await ref.get()).updateTime!.isEqual(enrolled.updateTime!)).toBe(true);
  await expect(firestore.runTransaction(transaction => coverage.assertPairMediaCoverageInTransaction({ firestore, transaction, pair }),
    { readOnly: true })).rejects.toThrow();
});

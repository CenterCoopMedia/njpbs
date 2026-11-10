import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import protocol from "../../functions/lib/public-release-pair.js";
import coverage from "../../functions/lib/public-release-media-coverage.js";
import { preparePublicReleaseMediaMigration, applyPreparedPublicReleaseMediaMigration,
  readPublicReleaseMediaMigrationReceipt } from "../../site/scripts/public-release-media-migration";
import { capturePublicReleasePairInput, openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { preparePublicReleasePairMediaPin, retainPreparedPublicReleasePairMediaPin } from "../../site/scripts/public-release-pair-media-pin";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";

let runtime: Miniflare, store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>, directory: string;
let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "media-migration", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "media-migration" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  directory = await mkdtemp(path.join(os.tmpdir(), "media-migration-"));
  fixture = await publicReleasePairCompositeFixture({ firestore: isolatedFirestore("media-migration"), store, directory });
}, 60_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
const options = () => ({ firestore: fixture.firestore, pair: fixture.pair, store });
async function loseLedger() {
  const { firestore, pair } = fixture;
  await firestore.doc(coverage.coveragePath(pair)).delete();
  return coverage.initializePublicReleasePairMediaCoverage({ firestore, pair });
}
async function captureAnotherInput() {
  const { firestore, pair, content } = fixture;
  const opened = await openPublicReleasePairInput({ firestore, pair, store,
    identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...content.receipt.scope,
      inputManifestDigest: content.receipt.inputManifestDigest }, expectedSource: content.receipt.source, expectedCursor: content.receipt.cursor });
  const plan = { ...content.root, scope: { ...content.root.scope, sourceOperationId: "late-media-migration-input" } };
  return capturePublicReleasePairInput({ firestore, pair, store, plan, expectedSource: plan.source, expectedCursor: plan.cursor,
    bindSourceOperation: true, files: (async function* () {
      for (const file of plan.files) yield { name: file.name, bytes: await opened.readFile(file.name) };
    })() });
}

it("re-proves actual historical/CODE H on R2, commits one complete ledger, and reads its original receipt after a lost response", async () => {
  const { firestore, pair, base } = fixture, operationId = "original-media-migration";
  expect((await loseLedger()).phase).toBe("needs-migration");
  const proof = await preparePublicReleaseMediaMigration({ ...options(), operationId });
  expect(proof.inputCount).toBe((await firestore.collection(`${base}/inputs`).get()).size);
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).data()!.phase).toBe("needs-migration");
  await expect(applyPreparedPublicReleaseMediaMigration({ firestore, proof: { ...proof } })).rejects.toThrow();
  const result = await applyPreparedPublicReleaseMediaMigration({ firestore, proof });
  expect(result.idempotent).toBe(false);
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).data()).toMatchObject({ phase: "tracking",
    totalInputs: proof.inputCount, pinnedInputs: proof.inputCount, pendingInputs: 0 });
  const committed = await firestore.doc(coverage.coveragePath(pair)).get();
  expect(await applyPreparedPublicReleaseMediaMigration({ firestore, proof })).toEqual({ ...result, idempotent: true });
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).updateTime!.isEqual(committed.updateTime!)).toBe(true);
  expect(await readPublicReleaseMediaMigrationReceipt({ firestore, pair, operationId })).toEqual(result.receipt);
  expect((await firestore.collection(`${base}/mediaRetentionMigrations`).get()).size).toBe(1);
});

it("refuses preparation made stale by a newly captured H and resumes only after its actual pin", async () => {
  const { firestore, pair } = fixture;
  await loseLedger();
  const stale = await preparePublicReleaseMediaMigration({ ...options(), operationId: "before-new-H" });
  const captured = await captureAnotherInput();
  await expect(applyPreparedPublicReleaseMediaMigration({ firestore, proof: stale })).rejects.toThrow();
  expect(await readPublicReleaseMediaMigrationReceipt({ firestore, pair, operationId: "before-new-H" })).toBeNull();
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).data()).toMatchObject({ phase: "needs-migration", pendingInputs: 1 });
  const pin = await preparePublicReleasePairMediaPin({ ...options(), receipt: captured.receipt });
  await retainPreparedPublicReleasePairMediaPin({ firestore, proof: pin });
  const current = await preparePublicReleaseMediaMigration({ ...options(), operationId: "after-new-H" });
  expect(current.inputCount).toBe(stale.inputCount + 1);
  await applyPreparedPublicReleaseMediaMigration({ firestore, proof: current });
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).data()).toMatchObject({ phase: "tracking", pendingInputs: 0 });
});

it("refuses altered original H bytes and leaves incomplete accounting held", async () => {
  const { firestore, pair, content } = fixture;
  await loseLedger();
  const metadata = content.root.files.find(file => file.name === "source-metadata.json")!;
  const broken: PairViewStore = { put: async () => { throw new Error("Migration reads immutable R2 only"); },
    async get(key) {
      const value = await store.get(key);
      if (!value || key !== metadata.objectKey) return value;
      await value.body.cancel();
      return { size: value.size, customMetadata: value.customMetadata,
        body: new Response(new TextEncoder().encode("{}")).body! };
    } };
  await expect(preparePublicReleaseMediaMigration({ firestore, pair, store: broken, operationId: "corrupt-original-H" })).rejects.toThrow();
  expect((await firestore.doc(coverage.coveragePath(pair)).get()).data()!.phase).toBe("needs-migration");
  expect(await readPublicReleaseMediaMigrationReceipt({ firestore, pair, operationId: "corrupt-original-H" })).toBeNull();
});

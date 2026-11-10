import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { qualifyPublicReleasePair, verifyStoredQualificationEvidence,
  assertPublicReleasePairQualificationCurrentInTransaction } from "../../site/scripts/public-release-pair-qualification";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "../../site/scripts/public-release-pair-qualification-source";
import { preparePublicReleasePairPublicationSeals, assertPublicReleasePairPublicationSealsCurrentInTransaction } from "../../site/scripts/public-release-pair-publication-seals";

let runtime: Miniflare, fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>;
let db: ReturnType<typeof isolatedFirestore>, store: R2Bucket;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-qualification-split.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "qualification-split", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "qualification-split" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = await qualifiedPairFixture(db, store, { draftSettings: 510 });
}, 60_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });

it("records the real over-budget outside census and keeps both transaction guards under 500 reads", async () => {
  const result = await qualifyPublicReleasePair({ firestore: db, ...fixture, qualificationId: "split-census" });
  expect(result.receipt.sourceValidation.mode).toBe("split");
  expect(result.receipt.sourceValidation.outsideReadCount).toBeGreaterThan(500);
  expect(result.receipt.sourceValidation.transactionReadCount).toBeLessThanOrEqual(500);
  // Draft-only source documents affect measured scan cost, never its public seal.
  await db.doc("cmsSettings/private-draft-0").update({ draft: { title: "A later working draft" } });
  const before = fixture.received;
  const ordinary = await preparePublicReleasePairPublicationSeals({ firestore: db, ...fixture, signal: AbortSignal.timeout(30_000) });
  const ordinaryGuard = await db.runTransaction(async original => {
    const readTracker = trackQualificationTransactionReads(original), transaction = readTracker.transaction;
    await transaction.getAll(...Array.from({ length: 90 }, (_, index) => db.doc(`cmsSettings/private-draft-${index}`)));
    const current = await assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore: db, transaction,
      pair: fixture.pair, prepared: ordinary, readTracker });
    expect(current.sourceValidation.transactionReadCount).toBe(assertQualificationTransactionReadBudget(readTracker));
    return current;
  });
  expect(ordinaryGuard.sourceValidation.mode).toBe("split");
  expect(ordinaryGuard.sourceValidation.outsideReadCount).toBeGreaterThan(500);
  expect(ordinaryGuard.sourceValidation.transactionReadCount).toBeLessThanOrEqual(500);
  expect(fixture.received).toBe(before);
  const retained = await verifyStoredQualificationEvidence({ firestore: db, ...fixture, receipt: result.receipt, signal: AbortSignal.timeout(30_000) });
  const foreignTracker = await db.runTransaction(async transaction => trackQualificationTransactionReads(transaction), { readOnly: true });
  const current = await db.runTransaction(async original => {
    const readTracker = trackQualificationTransactionReads(original), transaction = readTracker.transaction;
    // Switch-owned reads share the same allowance before either pair guard.
    await transaction.getAll(...Array.from({ length: 90 }, (_, index) => db.doc(`cmsSettings/private-draft-${index}`)));
    const input = { firestore: db, transaction, pair: fixture.pair, qualificationId: result.receipt.qualificationId,
      receiptDigest: result.digest, ...retained, readTracker };
    await expect(assertPublicReleasePairQualificationCurrentInTransaction({ ...input,
      readTracker: { ...readTracker, readCount: () => 499 } })).rejects.toMatchObject({ code: "qualification-validator-unproven" });
    await expect(assertPublicReleasePairQualificationCurrentInTransaction({ ...input,
      readTracker: foreignTracker })).rejects.toMatchObject({ code: "qualification-validator-unproven" });
    const first = await assertPublicReleasePairQualificationCurrentInTransaction(input), afterFirst = readTracker.readCount();
    const second = await assertPublicReleasePairQualificationCurrentInTransaction(input);
    expect(first.sourceValidation.transactionReadCount).toBe(afterFirst);
    expect(second.sourceValidation.transactionReadCount).toBeGreaterThan(afterFirst);
    expect(assertQualificationTransactionReadBudget(readTracker)).toBe(second.sourceValidation.transactionReadCount);
    return second;
  });
  expect(current.sourceValidation.mode).toBe("split");
  expect(current.sourceValidation.transactionReadCount).toBeLessThanOrEqual(500);
  await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
  await expect(db.runTransaction(transaction => assertPublicReleasePairPublicationSealsCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, prepared: ordinary }))).rejects.toThrow();
  await expect(db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, qualificationId: result.receipt.qualificationId,
    receiptDigest: result.digest, ...retained }))).rejects.toThrow();
}, 30_000);

import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { Timestamp } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import { preparePublicReleasePairPublicationSource, assertPreparedQualificationSource } from "../../site/scripts/public-release-pair-qualification-source";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { preparePublicReleasePairPublicationSeals, assertPublicReleasePairPublicationSealsCurrentInTransaction,
  trackQualificationTransactionReads, assertQualificationTransactionReadBudget,
  type PreparedPublicReleasePairPublicationSeals } from "../../site/scripts/public-release-pair-publication-seals";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";

let runtime: Miniflare, fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>;
let db: ReturnType<typeof isolatedFirestore>, store: R2Bucket;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-publication-seals.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "publication-seals", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "publication-seals" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = await qualifiedPairFixture(db, store);
}, 60_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
const prepare = (signal = AbortSignal.timeout(30_000), selectedStore: PairViewStore = store) => preparePublicReleasePairPublicationSeals({
  firestore: db, store: selectedStore, pair: fixture.pair, witnessDigest: fixture.witnessDigest, signal });
const guard = (prepared: PreparedPublicReleasePairPublicationSeals) => db.runTransaction(transaction =>
  assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore: db, transaction, pair: fixture.pair, prepared }));
async function changed(path: string, value: Record<string, unknown> | null, run: () => Promise<unknown>) {
  const ref = db.doc(path), old = await ref.get();
  try { if (value === null) await ref.delete(); else await ref.set(value); await run(); }
  finally { if (old.exists) await ref.set(old.data()!); else await ref.delete(); }
}

it("prepares current seals using only original H root and metadata, with no HTTP, receipt or selection", async () => {
  const reads: string[] = [], received = fixture.received;
  const sealStore: PairViewStore = { put: async () => { throw new Error("No seal writes"); }, async get(key) {
    reads.push(key); if (reads.length > 2) throw new Error("Full closure must not be re-read"); return store.get(key);
  } };
  const before = (await db.doc("system/publicDeployment").get()).data();
  const prepared = await prepare(undefined, sealStore);
  expect(prepared.pairDigest).toBe(protocol.publicReleaseDigest(fixture.pair));
  expect(prepared.witnessDigest).toBe(fixture.witnessDigest);
  expect(prepared.headCursor).toEqual(fixture.witness.headCursor);
  const result = await db.runTransaction(async original => {
    const readTracker = trackQualificationTransactionReads(original), transaction = readTracker.transaction;
    await transaction.getAll(...Array.from({ length: 12 }, (_, index) => db.doc(`cmsSettings/draft-${index}`)));
    const current = await assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore: db, transaction,
      pair: fixture.pair, prepared, readTracker });
    expect(current.sourceValidation.transactionReadCount).toBe(assertQualificationTransactionReadBudget(readTracker));
    return current;
  });
  expect(result.sourceValidation.mode).toBe("full");
  expect(result.authority.sealsDigest).toBe(prepared.sealsDigest);
  expect(reads).toHaveLength(2);
  expect(fixture.received).toBe(received);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection(`${work.publicReleasePairPath(fixture.pair.pairId)}/qualifications`).get()).empty).toBe(true);
}, 30_000);

it("refuses copied preparation and trackers from a different transaction", async () => {
  const prepared = await prepare();
  await expect(guard({ ...prepared })).rejects.toMatchObject({ code: "qualification-validator-unproven" });
  const readTracker = await db.runTransaction(async transaction => trackQualificationTransactionReads(transaction), { readOnly: true });
  await expect(db.runTransaction(transaction => assertPublicReleasePairPublicationSealsCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, prepared, readTracker }))).rejects.toMatchObject({ code: "qualification-validator-unproven" });
});

it("never substitutes metadata-only preparation for a complete candidate input-closure check", async () => {
  const proof = await replay.openPublicReleasePairReplayWitnessProof({ firestore: db, pair: fixture.pair,
    headCursor: fixture.witness.headCursor, witnessDigest: fixture.witnessDigest });
  const captured = (await db.doc(`${work.publicReleasePairPath(fixture.pair.pairId)}/inputs/${proof.headView.identity.inputManifestDigest}`).get()).data()!;
  const source = await preparePublicReleasePairPublicationSource({ firestore: db, store, pair: fixture.pair,
    witness: fixture.witness, witnessDigest: fixture.witnessDigest, headView: proof.headView,
    captured: captured as Parameters<typeof preparePublicReleasePairPublicationSource>[0]["captured"], signal: AbortSignal.timeout(30_000) });
  expect(() => assertPreparedQualificationSource(fixture.pair, fixture.witnessDigest, source,
    source.metadata.digest, protocol.publicReleaseDigest(source.headView))).toThrow("source-census-unproven");
});

it("binds the opaque preparation to its original pair and Firestore instance", async () => {
  const prepared = await prepare(), foreign = isolatedFirestore("publication-seals-other-database");
  await expect(db.runTransaction(transaction => assertPublicReleasePairPublicationSealsCurrentInTransaction({
    firestore: foreign, transaction, pair: fixture.pair, prepared }))).rejects.toMatchObject({ code: "qualification-validator-unproven" });
  await expect(db.runTransaction(transaction => assertPublicReleasePairPublicationSealsCurrentInTransaction({
    firestore: db, transaction, pair: { ...fixture.pair, pairId: "another-pair" }, prepared }))).rejects.toThrow();
});

it("refuses cancellation before preparation and after preparation before the late guard", async () => {
  const cancelled = AbortSignal.abort();
  await expect(prepare(cancelled)).rejects.toThrow();
  const controller = new AbortController(), prepared = await prepare(controller.signal);
  controller.abort();
  await expect(guard(prepared)).rejects.toThrow();
});

it("refuses a missing original source metadata object without reading other immutable files", async () => {
  let reads = 0;
  const missing: PairViewStore = { put: async () => { throw new Error("No writes"); }, async get(key) {
    return ++reads === 1 ? store.get(key) : null;
  } };
  await expect(prepare(undefined, missing)).rejects.toThrow();
  expect(reads).toBe(2);
});

it("refuses a missing installed reader seal before preparation", async () => {
  await changed(readerSealPath(fixture.pair), null, async () => { await expect(prepare()).rejects.toThrow(); });
});

it("refuses a reader seal revoked after preparation", async () => {
  const prepared = await prepare();
  await changed(readerSealPath(fixture.pair), null, async () => { await expect(guard(prepared)).rejects.toThrow(); });
});

it("refuses a changed real Data Hub capability after preparation", async () => {
  const prepared = await prepare(), old = (await db.doc(readerSealPath(fixture.pair)).get()).data()!;
  await changed(readerSealPath(fixture.pair), { ...old, capabilities: { ...old.capabilities,
    page: { ...old.capabilities.page, dataHubCompositionVersion: 0 } } }, async () => { await expect(guard(prepared)).rejects.toThrow(); });
});

it("refuses unlogged public roster drift and permits a working-only draft", async () => {
  const prepared = await prepare();
  await changed("cmsSettings/working-draft", { draft: { title: "Working only" } }, async () => {
    await expect(guard(prepared)).resolves.toHaveProperty("sourceValidation.mode", "full");
  });
  await changed("cmsAuthorProfilesPublic/unlogged-author", { displayName: "A new public author" }, async () => {
    await expect(guard(prepared)).rejects.toThrow();
  });
});

it("refuses a live log head change immediately before the guarded write", async () => {
  const prepared = await prepare(), path = "system/publicReleaseChanges", head = (await db.doc(path).get()).data()!;
  await changed(path, { ...head, sequence: head.sequence + 1, lastDigest: "f".repeat(64) }, async () => {
    await expect(guard(prepared)).rejects.toMatchObject({ code: "stale-qualification" });
  });
});

it("refuses seals when the actual late SDK read time is more than a minute after preparation", async () => {
  const prepared = await prepare();
  await expect(db.runTransaction(original => {
    const transaction = new Proxy(original, { get(target, key) {
      if (key === "getAll") return async (...refs: Parameters<typeof original.getAll>) =>
        (await target.getAll(...refs)).map(row => row.ref.path !== "system/publicReleaseChanges" ? row :
          new Proxy(row, { get(snapshot, field) {
            if (field === "readTime") return Timestamp.fromMillis(snapshot.readTime.toMillis() + 60_001);
            const value = Reflect.get(snapshot, field, snapshot);
            return typeof value === "function" ? value.bind(snapshot) : value;
          } }));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return assertPublicReleasePairPublicationSealsCurrentInTransaction({ firestore: db, transaction, pair: fixture.pair, prepared });
  })).rejects.toMatchObject({ code: "stale-qualification" });
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import type { DocumentData } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { qualifyPublicReleasePair, verifyStoredQualificationEvidence,
  assertPublicReleasePairQualificationCurrentInTransaction } from "../../site/scripts/public-release-pair-qualification";
import { qualificationReceiptPath } from "../../site/scripts/public-release-pair-qualification-receipt";
import { verifyPairNamespaceRemoteAbsence } from "../../site/scripts/public-release-pair-qualification-bytes";
import { openPublicReleasePairViewMetadata } from "../../site/scripts/public-release-pair-view-storage";
import { createPrivatePairReaderClient } from "../../site/scripts/public-release-pair-reader-client";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";

let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
let fixture: Awaited<ReturnType<typeof qualifiedPairFixture>> | undefined;
let qualificationId = "", caseNumber = 0, requestsBeforeCase = 0;
let restored: Array<{ path: string; value: DocumentData }> = [];
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-qualification.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "pair-qualification", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "pair-qualification" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = await qualifiedPairFixture(db, store);
  const paths = ["system/publicDeployment/contexts/public", "cmsPosts/story", "system/publicDeployment/noBuildPostOwners/story", readerSealPath(fixture.pair),
    `${work.publicReleasePairPath(fixture.pair.pairId)}/replayWitnesses/${fixture.witnessDigest}`,
    `${work.publicReleasePairPath(fixture.pair.pairId)}/receipts/${protocol.publicReleaseDigest(fixture.codePackView.identity)}`,
    `${work.publicReleasePairPath(fixture.pair.pairId)}/replayCapsules/${fixture.witness.capsuleDigest}`,
    composite.publicReleasePairCompositeProofPath(fixture.pair, fixture.contentView.manifestDigest)];
  restored = (await db.getAll(...paths.map(path => db.doc(path)))).map(row => ({ path: row.ref.path, value: row.data()! }));
  // Reuse this fully verified immutable CODE/Schedule/H/G/replay baseline.
  // Each test gets a new qualification identity and restores its live controls.
  // Individual private HTTP reads retain their fixed three-second deadline.
}, 60_000);
beforeEach(() => { qualificationId = `qualify-case-${++caseNumber}`; requestsBeforeCase = prepared().received; });
afterEach(async () => {
  fixture?.setTransform(undefined); fixture?.setReaderStore(store);
  await db.doc("cmsSettings/qualifier-unlogged").delete();
  const batch = db.batch(); for (const row of restored) batch.set(db.doc(row.path), row.value); await batch.commit();
});
afterAll(async () => { await fixture?.close(); fixture = undefined; await runtime?.dispose(); });
const prepared = () => { if (!fixture) throw new Error("Missing fixture"); return fixture; };
const qualify = () => qualifyPublicReleasePair({ firestore: db, ...prepared(), qualificationId });
async function assertNoReceipt() {
  expect((await db.doc(qualificationReceiptPath(prepared().pair, qualificationId)).get()).exists).toBe(false);
}
it("qualifies all settled code, aggregates, owned aliases and withdrawals through actual HTTP, granting nothing", async () => {
  const candidate = prepared(), pointer = (await db.doc("system/publicDeployment").get()).data();
  let rssMime: string | undefined;
  candidate.setTransform(async response => {
    if (response.status === 200) for (const output of (await response.clone().json() as any).outputs) {
      if (output.path === "/feeds/news.xml") rssMime = output.headers["content-type"];
    }
    return response;
  });
  const result = await qualify();
  expect(result.idempotent).toBe(false); expect(candidate.received).toBeGreaterThanOrEqual(2);
  expect(result.receipt.sourceValidation.mode).toBe("full");
  expect(result.receipt.sourceValidation.transactionReadCount).toBeLessThanOrEqual(500);
  expect(result.receipt.coverage.content).toBeGreaterThanOrEqual(4); expect(result.receipt.coverage.baseline).toBeGreaterThan(10);
  // The native composite's canonical RSS MIME replaces the generic XML baseline.
  expect(result.receipt.coverage.overlay).toBe(1); expect(result.receipt.coverage.absence).toBe(0);
  expect(rssMime).toBe("application/rss+xml; charset=utf-8");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
  expect((await db.doc("system/noBuildPostAdmission").get()).exists).toBe(false);
  const retained = await verifyStoredQualificationEvidence({ firestore: db, store, pair: candidate.pair, witness: candidate.witness,
    namespaces: candidate.namespaces, receipt: result.receipt, signal: AbortSignal.timeout(20_000) });
  const current = await db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: candidate.pair, qualificationId: result.receipt.qualificationId,
    receiptDigest: result.digest, selectedViews: retained.selectedViews, namespaces: retained.namespaces, catalogs: retained.catalogs, composites: retained.composites, source: retained.source }));
  expect(current.digest).toBe(result.digest);
});
it("reuses the exact qualification identity without refreshing its original time or proof", async () => {
  const result = await qualify();
  const retry = await qualify();
  expect(retry.idempotent).toBe(true); expect(retry.receipt).toEqual(result.receipt); expect(retry.digest).toBe(result.digest);
});
it("refuses self-consistent wrong remote bytes before creating a receipt", async () => {
  prepared().setTransform(async response => {
    if (response.status !== 200) return response;
    const value = await response.json() as any, bytes = Buffer.from("Different deployed output");
    value.outputs[0].bodyBase64 = bytes.toString("base64"); value.outputs[0].bytes = bytes.length;
    value.outputs[0].bodyDigest = createHash("sha256").update(bytes).digest("hex");
    return new Response(JSON.stringify(value), { headers: response.headers });
  });
  await expect(qualify()).rejects.toThrow("reader-mismatch"); await assertNoReceipt();
});
it.each(["context", "seal"])("refuses live %s drift during actual private I/O", async kind => {
  let changed = false;
  prepared().setTransform(async response => {
    if (!changed) { changed = true;
      if (kind === "context") await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
      else await db.doc(readerSealPath(prepared().pair)).delete();
    }
    return response;
  });
  await expect(qualify()).rejects.toThrow(); await assertNoReceipt();
});
it("refuses missing durable replay proof before remote reads", async () => {
  const candidate = prepared();
  await db.doc(`${work.publicReleasePairPath(candidate.pair.pairId)}/replayWitnesses/${candidate.witnessDigest}`).delete();
  await expect(qualify()).rejects.toMatchObject({ code: "replay-unproven" });
  expect(candidate.received - requestsBeforeCase).toBe(0); await assertNoReceipt();
});
it.each(["context", "seal", "owner", "capsule", "composite"])("rechecks %s inside the later guard transaction", async kind => {
  const candidate = prepared(), result = await qualify();
  const retained = await verifyStoredQualificationEvidence({ firestore: db, store, pair: candidate.pair, witness: candidate.witness,
    namespaces: candidate.namespaces, receipt: result.receipt, signal: AbortSignal.timeout(20_000) });
  const guard = () => db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: candidate.pair, qualificationId: result.receipt.qualificationId,
    receiptDigest: result.digest, selectedViews: retained.selectedViews, namespaces: retained.namespaces, catalogs: retained.catalogs, composites: retained.composites, source: retained.source }));
  if (kind === "context") await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
  else if (kind === "seal") await db.doc(readerSealPath(candidate.pair)).delete();
  else if (kind === "owner") await db.doc(`${work.publicReleasePairPath(candidate.pair.pairId)}/receipts/${protocol.publicReleaseDigest(candidate.codePackView.identity)}`).delete();
  else if (kind === "composite") await db.doc(composite.publicReleasePairCompositeProofPath(candidate.pair, candidate.contentView.manifestDigest)).delete();
  else await db.doc(`${work.publicReleasePairPath(candidate.pair.pairId)}/replayCapsules/${candidate.witness.capsuleDigest}`).delete();
  await expect(guard()).rejects.toThrow();
  expect((await db.doc(qualificationReceiptPath(candidate.pair, result.receipt.qualificationId)).get()).data()).toEqual(result.receipt);
});
it("refuses a missing closed composite proof before issuing private HTTP reads", async () => {
  const candidate = prepared();
  await db.doc(composite.publicReleasePairCompositeProofPath(candidate.pair, candidate.contentView.manifestDigest)).delete();
  await expect(qualify()).rejects.toThrow();
  expect(candidate.received - requestsBeforeCase).toBe(0); await assertNoReceipt();
});

it("obtains typed absence over actual HTTP only outside the complete original namespace", async () => {
  const candidate = prepared(), namespace = candidate.namespaces.find(row => row.namespace === "/pagefind/")!;
  const staged = (await db.doc(`${work.publicReleasePairPath(candidate.pair.pairId)}/views/${namespace.view.manifestDigest}`).get()).data()!;
  const evidence: unknown[] = [];
  const result = await verifyPairNamespaceRemoteAbsence({ ...candidate, selectedView: namespace.view,
    stagedReadbackDigest: staged.readbackDigest, signal: AbortSignal.timeout(20_000), evidence: async row => { evidence.push(row); },
    absence: { namespace: "/pagefind/", namespaceRootDigest: namespace.namespaceRootDigest,
      namespaceManifestDigest: namespace.namespaceManifestDigest, cursor: namespace.cursor, paths: ["/pagefind/former-shard.pf_index"] } });
  expect(result.absenceCount).toBe(1); expect(evidence).toEqual([expect.objectContaining({ kind: "absence", status: 404, bytes: 0,
    path: "/pagefind/former-shard.pf_index", namespaceRootDigest: namespace.namespaceRootDigest })]);
  await assertNoReceipt();
});
it.each(["missing", "corrupt", "transport"])("refuses %s declared namespace bytes without typed absence over actual HTTP", async mode => {
  const candidate = prepared(), namespace = candidate.namespaces.find(row => row.namespace === "/pagefind/")!, path = namespace.members[0].path;
  const metadata = await openPublicReleasePairViewMetadata({ store, pair: candidate.pair, ...namespace.view });
  const descriptor = await metadata.output(path); expect(descriptor).toBeDefined();
  candidate.setReaderStore({ put: (...args) => store.put(...args), async get(key) {
    if (key !== descriptor!.objectKey) return store.get(key);
    if (mode === "transport") throw new Error("Fixture storage unavailable");
    if (mode === "missing") return null;
    const original = await store.get(key), bytes = new Uint8Array(await original!.arrayBuffer()); bytes[0] ^= 1;
    return { size: bytes.length, customMetadata: original!.customMetadata, body: new Response(bytes).body! };
  } });
  const client = createPrivatePairReaderClient(candidate);
  await expect(client({ ...namespace.view, paths: [], absence: { namespace: "/pagefind/", namespaceRootDigest: namespace.namespaceRootDigest,
    namespaceManifestDigest: namespace.namespaceManifestDigest, cursor: namespace.cursor, paths: [path] } })).rejects.toThrow();
  await expect(client({ ...namespace.view, paths: [path] })).rejects.toThrow();
  await assertNoReceipt();
});

it.each(["version", "snapshot"])("refuses preexisting published/owner %s drift with an unchanged public log", async mode => {
  const source = await db.doc("cmsPosts/story").get(), owner = await db.doc("system/publicDeployment/noBuildPostOwners/story").get();
  const head = (await db.doc("system/publicReleaseChanges").get()).data();
  const published = { ...source.data()!.published, ...(mode === "version" ? { sourceVersion: 8 }
    : { metadata: { ...source.data()!.published.metadata, title: "A different published title" } }) };
  const batch = db.batch();
  batch.update(source.ref, { published, version: 8 });
  batch.update(owner.ref, { sourceVersion: published.sourceVersion, snapshotDigest: protocol.publicReleaseDigest(published) });
  await batch.commit();
  expect((await db.doc("system/publicReleaseChanges").get()).data()).toEqual(head);
  await expect(qualify()).rejects.toMatchObject({ code: "source-census-mismatch" });
  await assertNoReceipt();
});

it.each(["before", "during"])("refuses unlogged global source roster drift %s private I/O", async when => {
  const change = () => db.doc("cmsSettings/qualifier-unlogged").set({ published: { sourceVersion: 1, title: "Changed public setting" } });
  const head = (await db.doc("system/publicReleaseChanges").get()).data();
  if (when === "before") await change();
  else {
    let changed = false;
    prepared().setTransform(async response => { if (!changed) { changed = true; await change(); } return response; });
  }
  await expect(qualify()).rejects.toMatchObject({ code: "source-census-mismatch" });
  expect((await db.doc("system/publicReleaseChanges").get()).data()).toEqual(head);
  if (when === "before") expect(prepared().received - requestsBeforeCase).toBe(0);
  await assertNoReceipt();
});
it("rechecks the complete small source census at the later guard and rejects copied preparation hints", async () => {
  const candidate = prepared(), result = await qualify();
  const retained = await verifyStoredQualificationEvidence({ firestore: db, store, pair: candidate.pair, witness: candidate.witness,
    namespaces: candidate.namespaces, receipt: result.receipt, signal: AbortSignal.timeout(30_000) });
  const guard = (source = retained.source) => db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: candidate.pair, qualificationId: result.receipt.qualificationId,
    receiptDigest: result.digest, selectedViews: retained.selectedViews, namespaces: retained.namespaces, catalogs: retained.catalogs, composites: retained.composites, source }));
  await expect(guard({ ...retained.source })).rejects.toMatchObject({ code: "source-census-unproven" });
  await db.doc("cmsSettings/qualifier-unlogged").set({ published: { sourceVersion: 1, title: "Changed after preparation" } });
  await expect(guard()).rejects.toMatchObject({ code: "source-census-mismatch" });
});

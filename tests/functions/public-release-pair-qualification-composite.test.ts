import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { qualifyPublicReleasePair, verifyStoredQualificationEvidence,
  assertPublicReleasePairQualificationCurrentInTransaction } from "../../site/scripts/public-release-pair-qualification";
import { qualificationReceiptPath } from "../../site/scripts/public-release-pair-qualification-receipt";
import catalog from "../../functions/lib/public-release-pair-catalog-images.js";

let runtime: Miniflare, db: ReturnType<typeof isolatedFirestore>, store: R2Bucket;
let fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>;
let originalProof: FirebaseFirestore.DocumentData;
const proofPath = () => catalog.publicReleasePairCatalogImagesProofPath(fixture.pair, fixture.contentView.manifestDigest);
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-qualification-composite.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "qualification-composite", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "qualification-composite" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = await qualifiedPairFixture(db, store, { catalog: true });
  originalProof = (await db.doc(proofPath()).get()).data()!;
}, 60_000);
afterEach(async () => { fixture?.setTransform(undefined); if (originalProof) await db.doc(proofPath()).set(originalProof); });
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });

it("qualifies every catalog-owned image over actual HTTP beside the closed ordinary, aggregate and code outputs", async () => {
  const paths = new Set<string>(), reads = new Map<string, number>(), mimes = new Map<string, string>(), statuses = new Map<string, number>();
  fixture.setTransform(async response => {
    if (response.status === 200) for (const output of (await response.clone().json() as any).outputs) {
      paths.add(output.path); reads.set(output.path, (reads.get(output.path) ?? 0) + 1);
      mimes.set(output.path, output.headers["content-type"]);
      statuses.set(output.path, output.status);
    }
    return response;
  });
  const qualified = await qualifyPublicReleasePair({ firestore: db, ...fixture, qualificationId: "complete-catalog" });
  expect(qualified.receipt.coverage.overlay).toBe(4);
  expect(mimes.get("/feeds/news.xml")).toBe("application/rss+xml; charset=utf-8");
  expect(statuses.get("/programs/one/")).toBe(200);
  expect(statuses.get("/shows/one/")).toBe(200);
  expect(statuses.get("/shows/")).toBe(200);
  expect([...paths]).toEqual(expect.arrayContaining(["/_astro/art.avif", "/_astro/art.png", "/_astro/art.webp", "/programs/one/", "/shows/one/", "/feeds/news.xml"]));
  // PNG already exists identically in the code baseline. Its baseline bytes
  // and the original catalog G copy both need actual HTTP evidence.
  expect(reads.get("/_astro/art.png")).toBe(2);
  expect(reads.get("/_astro/art.avif")).toBe(1);
  expect(reads.get("/_astro/art.webp")).toBe(1);
  const retained = await verifyStoredQualificationEvidence({ firestore: db, ...fixture, receipt: qualified.receipt, signal: AbortSignal.timeout(30_000) });
  expect(retained.composites).toHaveLength(1);
  expect(retained.catalogs[0].manifest.members).toHaveLength(3);
  const current = await db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, qualificationId: qualified.receipt.qualificationId, receiptDigest: qualified.digest, ...retained }));
  expect(current.digest).toBe(qualified.digest);
  await expect(db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, qualificationId: qualified.receipt.qualificationId, receiptDigest: qualified.digest,
    ...retained, composites: [] }))).rejects.toMatchObject({ code: "stale-qualification" });
  await db.doc(proofPath()).delete();
  await expect(db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, qualificationId: qualified.receipt.qualificationId, receiptDigest: qualified.digest,
    ...retained }))).rejects.toThrow();
});
it("refuses self-consistent changed catalog bytes returned by the actual private reader", async () => {
  let changed = false;
  fixture.setTransform(async response => {
    if (response.status !== 200) return response;
    const value = await response.json() as any, output = value.outputs.find((row: any) => row.path === "/_astro/art.png");
    if (output) {
      const bytes = Buffer.from("Wrong remote image"); changed = true;
      output.bodyBase64 = bytes.toString("base64"); output.bytes = bytes.length;
      output.bodyDigest = createHash("sha256").update(bytes).digest("hex");
    }
    return new Response(JSON.stringify(value), { headers: response.headers });
  });
  const qualificationId = "wrong-catalog";
  await expect(qualifyPublicReleasePair({ firestore: db, ...fixture, qualificationId })).rejects.toMatchObject({ code: "reader-mismatch" });
  expect(changed).toBe(true);
  expect((await db.doc(qualificationReceiptPath(fixture.pair, qualificationId)).get()).exists).toBe(false);
});

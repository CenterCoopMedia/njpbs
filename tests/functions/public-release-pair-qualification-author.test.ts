import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { qualifyPublicReleasePair, verifyStoredQualificationEvidence,
  assertPublicReleasePairQualificationCurrentInTransaction } from "../../site/scripts/public-release-pair-qualification";
import { qualificationReceiptPath } from "../../site/scripts/public-release-pair-qualification-receipt";

let runtime: Miniflare, db: ReturnType<typeof isolatedFirestore>, store: R2Bucket;
let fixture: Awaited<ReturnType<typeof qualifiedPairFixture>>;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-qualification-author.test.ts");
  runtime = new Miniflare({ workers: [{ config: { name: "qualification-author", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "qualification-author" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  fixture = await qualifiedPairFixture(db, store, { authors: true, draftSettings: 510 });
}, 90_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });

it("qualifies current author aliases and historical withdrawals through actual HTTP and rechecks public authors inside a split guard", async () => {
  const responses = new Map<string, { status: number; headers: Record<string, string>; bytes: number }>();
  fixture.setTransform(async response => {
    if (response.status === 200) for (const output of (await response.clone().json() as any).outputs) if (output.path.startsWith("/authors/")) responses.set(output.path, output);
    return response;
  });
  const qualified = await qualifyPublicReleasePair({ firestore: db, ...fixture, qualificationId: "complete-author" });
  expect(qualified.receipt.sourceValidation.mode).toBe("split");
  expect(responses.get("/authors/ada/")?.status).toBe(200);
  expect(responses.get("/authors/static/index.html")?.status).toBe(200);
  expect(responses.get("/authors/ada-old/")).toMatchObject({ status: 308, bytes: 0, headers: { location: "/authors/ada/" } });
  for (const path of ["/authors/retired/", "/authors/retired-old/"]) expect(responses.get(path)).toMatchObject({ status: 410, bytes: 0 });
  const retained = await verifyStoredQualificationEvidence({ firestore: db, ...fixture, receipt: qualified.receipt, signal: AbortSignal.timeout(30_000) });
  const guard = () => db.runTransaction(transaction => assertPublicReleasePairQualificationCurrentInTransaction({
    firestore: db, transaction, pair: fixture.pair, qualificationId: qualified.receipt.qualificationId, receiptDigest: qualified.digest, ...retained }));
  const current = await guard();
  expect(current.sourceValidation.mode).toBe("split"); expect(current.sourceValidation.transactionReadCount).toBeLessThanOrEqual(500);
  fixture.setTransform(async response => {
    if (response.status !== 200) return response;
    const value = await response.json() as any, alias = value.outputs.find((row: any) => row.path === "/authors/ada-old/");
    if (alias) alias.headers.location = "/authors/wrong/";
    return new Response(JSON.stringify(value), { headers: response.headers });
  });
  await expect(qualifyPublicReleasePair({ firestore: db, ...fixture, qualificationId: "wrong-author-alias" })).rejects.toMatchObject({ code: "reader-mismatch" });
  expect((await db.doc(qualificationReceiptPath(fixture.pair, "wrong-author-alias")).get()).exists).toBe(false);
  fixture.setTransform(undefined);
  const profile = db.doc(`cmsAuthorProfilesPublic/${fixture.authorId}`), original = (await profile.get()).data()!;
  // No log or context change accompanies these deliberately invalid mutations.
  await profile.update({ bio: "Unlogged public biography drift" });
  await expect(guard()).rejects.toMatchObject({ code: "source-census-mismatch" });
  await profile.set(original);
  await db.doc("cmsAuthorProfilesPublic/au_" + "d".repeat(32)).set({ ...original, authorId: "au_" + "d".repeat(32), slug: "new-unlogged" });
  await expect(guard()).rejects.toMatchObject({ code: "source-census-mismatch" });
}, 30_000);

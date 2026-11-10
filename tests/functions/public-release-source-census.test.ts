import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import log from "../../functions/lib/public-release-change-log.js";
import { projectPublicReleasePairSourceCensusDocuments, preparePublicReleasePairSourceCensus, assertPublicReleasePairSourceCensusInTransaction, measurePublicReleasePairSourceCensusReads } from "../../site/scripts/public-release-pair-source-census";
const fixture = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
let db: ReturnType<typeof isolatedFirestore>;
const cursor = { baselineDigest: "a".repeat(64), sequence: 0, lastDigest: "a".repeat(64) };
beforeAll(() => { db = isolatedFirestore("public-release-source-census.test.ts"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set({ schemaVersion: 2, ...cursor });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "original", activeCommitSha: "a".repeat(40), lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "original" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 2 });
  await db.doc("cmsPosts/story").set(fixture);
  await db.doc("cmsPosts/draft").set({ type: "post", version: 1, status: "draft", title: "Private" });
});
async function frozen() {
  const census = await db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const documents = new Map<string, any>();
  for (const value of census.values) for (const document of JSON.parse(value.json).documents) if (document.data !== null) documents.set(document.path, document.data);
  return { documents, expected: projectPublicReleasePairSourceCensusDocuments(documents) };
}
it("compares actual public documents rather than multi-document event body digests", async () => {
  const { expected } = await frozen();
  const prepared = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  expect(prepared.metadata).toEqual(expected);
  expect(prepared.transactionEligible).toBe(true);
  expect(prepared.validatorCount).toBe(3);
  expect(await db.runTransaction(transaction => assertPublicReleasePairSourceCensusInTransaction({ firestore: db, transaction, expected, cursor }), { readOnly: true })).toEqual(prepared);
});
it("qualifies legacy static owner bodies while keeping modern proof and all other source fields exact", async () => {
  const ownerPath = "system/publicDeployment/noBuildPostOwners/story";
  const proof = { schemaVersion: 1, postId: "story", operationId: "S".repeat(20), sourceVersion: 7, visible: true,
    slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"], snapshotDigest: "b".repeat(64), contextDigest: "c".repeat(64),
    files: ["/posts/", "/posts/shadow-fixture/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js", "/search/meaning-index.json",
      "/_publication.json", "/_content-status.json", "/sitemap-index.xml"].map(path => ({ path, bytes: 1, digest: "d".repeat(64) })) };
  const owner = { schemaVersion: 1, postId: "story", operationId: proof.operationId, generation: 1, sourceVersion: 7,
    rendererSha: "a".repeat(40), mode: "static", visible: true, slug: proof.slug, ownedSlugs: proof.ownedSlugs };
  await db.doc(ownerPath).set({ ...owner, staticProof: proof });
  const modern = await frozen(), legacyDocuments = new Map(modern.documents);
  legacyDocuments.set(ownerPath, owner);
  const expected = projectPublicReleasePairSourceCensusDocuments(legacyDocuments);
  const actual = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  expect(actual.metadata).toEqual(expected);
  expect(await db.runTransaction(transaction => assertPublicReleasePairSourceCensusInTransaction({ firestore: db, transaction, expected, cursor }), { readOnly: true })).toEqual(actual);
  const exact = await preparePublicReleasePairSourceCensus({ firestore: db, expected: modern.expected, cursor });
  expect(exact.readCount).toBe(actual.readCount);
  await db.doc(ownerPath).update({ staticProof: { ...proof, contextDigest: "e".repeat(64) } });
  await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected: modern.expected, cursor })).rejects.toMatchObject({ code: "source-census-mismatch" });
  await db.doc(ownerPath).update({ generation: 2, staticProof: proof });
  await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).rejects.toMatchObject({ code: "source-census-mismatch" });
  await db.doc(ownerPath).update({ generation: 1 });
  await db.doc("system/publicDeployment/contexts/public").update({ revision: 3 });
  await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).rejects.toMatchObject({ code: "source-census-mismatch" });
});
it("observes actual census read cost without retaining raw data or claiming freshness", async () => {
  const { expected } = await frozen();
  const measured = await measurePublicReleasePairSourceCensusReads({ firestore: db });
  const prepared = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  expect(measured).toEqual({ censusOnly: true, readCount: prepared.readCount - 2,
    validatorCount: expected.members.length, excludesProtocolAndManifestReads: true });
  expect(Object.keys(measured).sort()).toEqual(["censusOnly", "excludesProtocolAndManifestReads", "readCount", "validatorCount"]);
});
it("ignores draft saves, draft cardinality and reconstructed context timestamps in public identity", async () => {
  const { expected, documents } = await frozen();
  const before = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  await db.doc("cmsPosts/story").update({ version: 100, title: "Private change", status: "draft", publiclyVisible: true });
  await db.doc("cmsPosts/draft-two").set({ type: "post", version: 5, status: "draft" });
  await db.doc("system/publicDeployment/contexts/public").update({ changedAt: new Date() });
  const after = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  expect(after.metadata.digest).toBe(before.metadata.digest);
  expect(after.readCount).toBeGreaterThan(before.readCount);
  documents.get("system/publicDeployment/contexts/public").changedAt = "2026-10-28T00:00:00.000Z";
  expect(projectPublicReleasePairSourceCensusDocuments(documents).digest).toBe(expected.digest);
});
it.each(["snapshot", "visibility", "new public document", "owner", "log head"])("refuses %s drift under the unchanged witness", async mode => {
  const { expected } = await frozen();
  if (mode === "snapshot") await db.doc("cmsPosts/story").update({ "published.metadata.title": "Unlogged publication" });
  if (mode === "visibility") await db.doc("cmsPosts/story").update({ publiclyVisible: false });
  if (mode === "new public document") await db.doc("cmsPosts/new-story").set(fixture);
  if (mode === "owner") await db.doc("system/publicDeployment/noBuildPostOwners/story").set({ schemaVersion: 1, ownedSlugs: ["new-route"], visible: true });
  if (mode === "log head") await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).update({ sequence: 1, lastDigest: "b".repeat(64) });
  await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).rejects.toMatchObject({ code: "source-census-mismatch" });
});
it("normalizes approved library history and private media to the same original public semantics", async () => {
  await db.doc("cmsPosts/newsletter").set({ type: "newsletter", title: "Original card", signupUrl: "https://njpbs.org/signup/", status: "approved", version: 1 });
  await db.doc("media_assets/art").set({ source: "site_seed", lifecycle: "active", url: "https://media.njpbs.org/art.png", mimeType: "image/png", width: 10, height: 10, altText: "Art", privateField: "ignored" });
  await db.doc("media_assets_public/art").set({ url: "https://media.njpbs.org/art.png", mimeType: "image/png", width: 10, height: 10, altText: "Art" });
  const { expected } = await frozen();
  expect((await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).metadata).toEqual(expected);
  await db.doc("media_assets/art").update({ privateField: "changed" });
  expect((await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).metadata.digest).toBe(expected.digest);
});
it("refuses unknown and malformed frozen projections by name", async () => {
  const { documents } = await frozen();
  documents.set("system/new-public-dependency", { schemaVersion: 1 });
  expect(() => projectPublicReleasePairSourceCensusDocuments(documents)).toThrowError("source-census-projection-unsupported");
  documents.delete("system/new-public-dependency"); documents.get("cmsPosts/story").published.sourceVersion = 0;
  expect(() => projectPublicReleasePairSourceCensusDocuments(documents)).toThrowError("source-census-mismatch");
});
it("stops before starting metadata reads when the caller deadline has expired", async () => {
  const { expected } = await frozen();
  const control = new AbortController(), reason = new Error("qualification deadline"); control.abort(reason);
  let reads = 0;
  const firestore = { doc: () => ({ get: async () => { reads++; throw new Error("No read permitted"); } }) };
  await expect(preparePublicReleasePairSourceCensus({ firestore: firestore as any, expected, cursor, signal: control.signal })).rejects.toBe(reason);
  expect(reads).toBe(0);
});
it.each([4, 10, 14])("preserves retryable SDK error %s rather than reporting source drift", async code => {
  const { expected } = await frozen();
  const failure = Object.assign(new Error("SDK transport failure"), { code });
  const firestore = { doc: () => ({ get: async () => { throw failure; } }) };
  await expect(preparePublicReleasePairSourceCensus({ firestore: firestore as any, expected, cursor })).rejects.toBe(failure);
  const transaction = { get: async () => { throw failure; } };
  await expect(assertPublicReleasePairSourceCensusInTransaction({ firestore: db, transaction: transaction as any, expected, cursor })).rejects.toBe(failure);
});
it("returns an active cancellation and starts no later reads after the bounded SDK request settles", async () => {
  const { expected } = await frozen();
  const control = new AbortController(), reason = new Error("qualification canceled");
  let started!: () => void, finish!: (value: any) => void, calls = 0;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<any>(resolve => { finish = resolve; });
  const query = { limit() { return this; }, orderBy() { return this; }, startAfter() { return this; },
    get() { calls++; started(); return pending; } };
  const firestore = { doc: () => ({ get: async () => { calls++; return { data: () => ({ schemaVersion: 2, ...cursor }) }; } }), collection: () => query };
  const preparing = preparePublicReleasePairSourceCensus({ firestore: firestore as any, expected, cursor, signal: control.signal });
  await beginning; control.abort(reason);
  await expect(preparing).rejects.toBe(reason);
  finish({ size: 0, docs: [] }); await pending; await Promise.resolve();
  expect(calls).toBe(2);
});
it("bounds every outside query page and the complete read allowance prospectively", async () => {
  const { expected } = await frozen();
  let actualReads = 0, largestPage = 0;
  const query = { bound: 0, limit(value: number) { return { ...this, bound: value }; },
    orderBy() { return this; }, startAfter() { return this; },
    async get() { largestPage = Math.max(largestPage, this.bound); actualReads += this.bound;
      return { size: this.bound, docs: Array.from({ length: this.bound }, () => ({ data: () => fixture })) }; } };
  const firestore = { doc: () => ({ get: async () => { actualReads++; return { data: () => ({ schemaVersion: 2, ...cursor }) }; } }),
    collection: () => query };
  await expect(preparePublicReleasePairSourceCensus({ firestore: firestore as any, expected, cursor })).rejects.toMatchObject({ code: "source-census-read-limit" });
  expect(largestPage).toBeLessThanOrEqual(100); expect(actualReads).toBeLessThanOrEqual(20_000);
});
it("bounds transaction queries before reading and reports the over-500 split separately from source identity", async () => {
  const { expected } = await frozen();
  for (let offset = 0; offset < 501; offset += 250) {
    const batch = db.batch();
    for (let index = offset; index < Math.min(501, offset + 250); index++) batch.set(db.doc(`cmsPosts/private-${index}`), { type: "post", status: "draft", version: 1 });
    await batch.commit();
  }
  const outside = await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor });
  expect(outside.metadata.digest).toBe(expected.digest); expect(outside.transactionEligible).toBe(false);
  const reads: number[] = [];
  await expect(db.runTransaction(transaction => {
    const guard = new Proxy(transaction, { get(target, key) {
      if (key === "get") return async (reference: any) => { const result: any = await target.get(reference); reads.push(result.docs ? result.size : 1); return result; };
      if (key === "getAll") return async (...refs: any[]) => { reads.push(refs.length); return target.getAll(...refs); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    return assertPublicReleasePairSourceCensusInTransaction({ firestore: db, transaction: guard, expected, cursor, maxDocuments: 250 });
  }, { readOnly: true })).rejects.toMatchObject({ code: "source-census-transaction-limit" });
  expect(reads.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(250);
});

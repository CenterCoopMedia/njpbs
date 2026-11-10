import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
const require = createRequire(import.meta.url), api = require("../../functions/lib/cms-pair-editorial-context.js"), p = require("../../functions/lib/public-release-pair.js");
let sequence = 0;
function fixture() {
  const db = isolatedFirestore(`paired-editorial-context-${++sequence}`), pair = releasePair(), digest = letter => letter.repeat(64);
  const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: "cms-11111111111111111111", generation: 1,
    commitSha: pair.commitSha, artifactDigest: digest("1"), artifactReceiptDigest: digest("2"), mediaManifestDigest: digest("3") };
  const source = { schemaVersion: 2, kind: "pair-editorial-context-source", pair: pairReference(pair), pairDigest: p.publicReleaseDigest(pair),
    identity: { schemaVersion: 2, pair: pairReference(pair), kind: "accepted", sourceOperationId: "editorial-operation", sourceVersion: 1,
      snapshotDigest: digest("4"), contextSequence: 0, inputManifestDigest: digest("5") }, claimDigest: digest("6"), viewManifestDigest: digest("7"),
    cursor: { baselineDigest: digest("8"), sequence: 0, lastDigest: digest("8") }, renderedAt: "2026-10-28T12:00:00.000Z", sourcePair: pairReference(pair),
    originalCode: { reference: { publication, manifest: { schemaVersion: 1, buildBatchId: publication.buildBatchId,
      artifactReceiptDigest: publication.artifactReceiptDigest, sha256: digest("9"), byteLength: 1, key: `public-context/${publication.buildBatchId}/${digest("9")}.json` } }, qualifiedCodeDigest: digest("a") },
    documents: [{ path: "cmsPosts/story", data: { published: { sourceVersion: 2 } } }],
    homeSources: { publication: { buildBatchId: publication.buildBatchId, generation: 1, commitSha: pair.commitSha } } };
  const read = () => db.runTransaction(transaction => api.readPairEditorialContextManifest({ firestore: db, transaction, pair, viewManifestDigest: source.viewManifestDigest }), { readOnly: true });
  return { db, pair, source, read };
}
it("writes an immutable content-addressed source and exact retries without changing public authority", async () => {
  const f = fixture(), root = { schemaVersion: 2, unchanged: true }; await f.db.doc("system/publicDeployment").set(root);
  const result = await api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source });
  expect(await f.read()).toEqual(result.manifest); expect((await api.readPairEditorialContextBytes({ firestore: f.db, pair: f.pair, manifest: result.manifest })).source).toEqual(f.source);
  expect(await api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source })).toEqual(result);
  expect((await f.db.doc("system/publicDeployment").get()).data()).toEqual(root);
  const changed = structuredClone(f.source); changed.documents[0].data.published.sourceVersion = 3;
  await expect(api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: changed })).rejects.toThrow(); expect(await f.read()).toEqual(result.manifest);
});
it("large context is split into separately verified bounded chunks", async () => {
  const f = fixture(); f.source.documents[0].data.publicText = "x".repeat(api.CHUNK_BYTES + 100);
  const result = await api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source });
  expect(result.manifest.chunks).toHaveLength(2);
  expect((await api.readPairEditorialContextBytes({ firestore: f.db, pair: f.pair, manifest: await f.read() })).source).toEqual(f.source);
});
it("preserves frozen approval history required to project library cards", async () => {
  const f = fixture(); f.source.documents.push({ path: "cmsVersionHistory/release-source-approved", data: {
    collection: "cmsPosts", documentId: "sponsor", action: "approve", after: { version: 2, status: "approved", type: "sponsor" } } });
  const { manifest } = await api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source });
  expect((await api.readPairEditorialContextBytes({ firestore: f.db, pair: f.pair, manifest })).source.documents).toEqual(f.source.documents);
});
it.each(["missing", "bytes", "extra", "index", "manifest"])("refuses %s retained data without overwriting it", async field => {
  const f = fixture(), { manifest } = await api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source });
  const prefix = `${api.ROOT}/${p.publicReleaseDigest(f.pair)}`;
  const chunk = f.db.doc(`${prefix}/chunks/${manifest.chunks[0]}`);
  if (field === "missing") await chunk.delete();
  if (field === "bytes") await chunk.update({ base64: Buffer.from("changed").toString("base64") });
  if (field === "extra") await chunk.update({ extra: true });
  if (field === "index") await f.db.doc(`${prefix}/views/${f.source.viewManifestDigest}`).update({ bodyDigest: "f".repeat(64) });
  if (field === "manifest") await f.db.doc(`${prefix}/contexts/${manifest.bodyDigest}`).update({ claimDigest: "f".repeat(64) });
  await expect((async () => api.readPairEditorialContextBytes({ firestore: f.db, pair: f.pair, manifest: await f.read() }))()).rejects.toThrow();
});
it.each(["pair", "source", "cursor", "private-path"])("refuses invalid %s source before any manifest/index is visible", async field => {
  const f = fixture();
  if (field === "pair") f.source.pairDigest = "f".repeat(64);
  if (field === "source") f.source.originalCode.reference.publication.commitSha = "f".repeat(40);
  if (field === "cursor") f.source.cursor.sequence = 2;
  if (field === "private-path") f.source.documents[0].path = "privateCredentials/forbidden";
  await expect(api.writePairEditorialContext({ firestore: f.db, pair: f.pair, source: f.source })).rejects.toThrow();
  expect((await f.db.collection(`${api.ROOT}/${p.publicReleaseDigest(f.pair)}/views`).get()).empty).toBe(true);
});

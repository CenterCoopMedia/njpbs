import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import { derivePublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-images";
import { bindQualificationCatalogs, assertQualificationCatalogsInTransaction } from "../../site/scripts/public-release-pair-qualification-catalog";
import type { PairReplayContext } from "../../site/scripts/public-release-pair-replay";
import type { QualificationCatalog } from "../../site/scripts/public-release-pair-qualification-catalog";
const { pair } = sealedPair(), old = releasePair("b", "b".repeat(40)), captured = capturedPairInput(pair);
const reference = { identity: { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), ...captured.taskInput },
  claimDigest: "a".repeat(64), manifestDigest: "b".repeat(64), manifestBytes: 2048 };
const codePackView = { ...reference, manifestDigest: "1".repeat(64), identity: { ...reference.identity, inputManifestDigest: "2".repeat(64) } };
const witness = { fromCursor: captured.cursor, headCursor: captured.cursor, codePackView };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const request = { schemaVersion: 1, read: frozenReplayProgramRead(old.commitSha), homeSourcesFile: null, resources: [] };
const provenance = { schemaVersion: 1, pair: old, rendererSha: old.commitSha, readerContractDigest: old.readerContractDigest, readerReceiptDigest: old.readerReceiptDigest };
const inputDigest = hash(encode(request)), provenanceDigest = hash(encode(provenance));
const files = new Map([["read.json", encode(request)], ["reader-provenance.json", encode(provenance)]]);
const context: PairReplayContext = { pair, identity: reference.identity,
  route: { path: "/programs/one/", method: "GET", renderer: "record", inputFile: "read.json",
    dependencies: [{ name: "read.json", digest: inputDigest }, { name: "reader-provenance.json", digest: provenanceDigest }] },
  request, provenance, inputDigest, provenanceDigest, renderedAt: "2026-10-28T04:00:00.000Z",
  readFrozenFile: async name => { const bytes = files.get(name); if (!bytes) throw new Error("Missing fixture H"); return bytes; } };
async function* contexts() { yield context; }
const { manifest } = await derivePublicReleasePairCatalogImages({ pair, identity: reference.identity, root: captured.root, contexts: contexts() });
const bytes = encode(manifest), digest = hash(bytes);
function selection(): QualificationCatalog {
  return { view: reference, manifest, proof: { schemaVersion: 1, kind: "pair-catalog-images-proof", status: "staged", pairDigest: protocol.publicReleaseDigest(pair),
    taskId: protocol.publicReleaseDigest(reference.identity), identity: reference.identity, claimDigest: reference.claimDigest,
    viewManifestDigest: reference.manifestDigest, viewReadbackDigest: "3".repeat(64), inputManifestDigest: reference.identity.inputManifestDigest,
    cursor: captured.cursor, descriptor: { digest, bytes: bytes.length,
      key: view.publicReleasePairViewObjectKey(pair, reference.identity, reference.claimDigest, digest) },
    memberCount: manifest.members.length, memberBytes: manifest.members.reduce((sum, member) => sum + member.size, 0),
    authority: { baselineInputManifestDigest: codePackView.identity.inputManifestDigest, baselineViewManifestDigest: codePackView.manifestDigest,
      baselineCodePackManifestDigest: "4".repeat(64), codeAssetManifestDigest: pair.codeAssetManifestDigest } } };
}
it("binds the actual owner-derived original catalog, both original and NEW identities and every member", () => {
  const result = bindQualificationCatalogs(pair, witness, [selection()]);
  expect(result.catalogs[0].manifest.members).toHaveLength(3);
  expect(result.catalogs[0].manifest.catalogs[0].rendererSha).toBe(old.commitSha);
  expect(result.catalogProofDigest).not.toBe(protocol.publicReleaseDigest([]));
});
it.each(["claim", "baseline", "manifest", "count", "cursor", "duplicate"])("refuses catalog %s disagreement", mode => {
  const value = structuredClone(selection());
  if (mode === "claim") value.view = { ...value.view, claimDigest: "5".repeat(64) };
  if (mode === "baseline") value.proof = { ...value.proof, authority: { ...value.proof.authority, baselineViewManifestDigest: "5".repeat(64) } };
  if (mode === "manifest") value.manifest = { ...value.manifest, members: value.manifest.members.map((member, index) => index ? member : { ...member, sha256: "5".repeat(64) }) };
  if (mode === "count") value.proof = { ...value.proof, memberCount: value.proof.memberCount + 1 };
  if (mode === "cursor") value.proof = { ...value.proof, cursor: { ...value.proof.cursor, sequence: value.proof.cursor.sequence + 1 } };
  expect(() => bindQualificationCatalogs(pair, witness, mode === "duplicate" ? [value, value] : [value])).toThrow();
});
it("refuses an omitted catalog seal before any transaction read", async () => {
  const bound = bindQualificationCatalogs(pair, witness, [selection()]);
  await expect(assertQualificationCatalogsInTransaction({ firestore: {} as never, transaction: {} as never, pair,
    witness: witness as never, catalogs: [], expectedDigest: bound.catalogProofDigest })).rejects.toThrow("stale-qualification");
});

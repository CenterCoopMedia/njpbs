import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import codec from "../../functions/lib/public-release-pair-catalog-images.js";
import { derivePublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-images";
import type { PairReplayContext } from "../../site/scripts/public-release-pair-replay";
const pair = releasePair(), old = releasePair("b", "b".repeat(40)), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), ...captured.taskInput };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture(mutate?: (read: ReturnType<typeof frozenReplayProgramRead>) => void) {
  const read = frozenReplayProgramRead(old.commitSha); mutate?.(read);
  const request = { schemaVersion: 1, read, homeSourcesFile: null, resources: [] };
  const provenance = { schemaVersion: 1, pair: old, rendererSha: old.commitSha, readerContractDigest: old.readerContractDigest, readerReceiptDigest: old.readerReceiptDigest };
  const inputDigest = hash(encode(request)), provenanceDigest = hash(encode(provenance)), files = new Map([["read.json", encode(request)], ["reader-provenance.json", encode(provenance)]]);
  const context: PairReplayContext = { pair, identity, route: { path: "/programs/one/", method: "GET", renderer: "record", inputFile: "read.json",
    dependencies: [{ name: "read.json", digest: inputDigest }, { name: "reader-provenance.json", digest: provenanceDigest }] },
    request, provenance, inputDigest, provenanceDigest, renderedAt: "2026-10-28T04:00:00.000Z", readFrozenFile: async name => { const file = files.get(name); if (!file) throw new Error("Missing H"); return file; } };
  async function* contexts() { yield context; }
  return derivePublicReleasePairCatalogImages({ pair, identity, root: captured.root, contexts: contexts() });
}
it("derives exact file authority from the actual original frozen catalog and retains its reader/source seals", async () => {
  const value = await fixture();
  expect(value.manifest.members.map(member => member.path)).toEqual(["/_astro/art.avif", "/_astro/art.png", "/_astro/art.webp"]);
  for (const member of value.manifest.members) expect(hash(await value.readMember(member.path))).toBe(member.sha256);
  expect(value.manifest.catalogs[0]).toMatchObject({ rendererSha: old.commitSha, originalPairDigest: protocol.publicReleaseDigest(old),
    readerContractDigest: old.readerContractDigest, readerReceiptDigest: old.readerReceiptDigest });
  await expect(value.readMember("/_astro/unlisted.png")).rejects.toMatchObject({ reason: "catalog-unlisted" });
});
it.each(["absent", "identical", "bytes", "mime", "compiled"])("applies %s NEW baseline catalog collision policy", async mode => {
  const value = await fixture(), image = value.manifest.members[0];
  const before = { ...image, family: "clientAsset", source: "static" };
  if (mode === "bytes") before.sha256 = "f".repeat(64);
  if (mode === "mime") before.mime = "application/javascript; charset=utf-8";
  if (mode === "compiled") { before.source = "compiled"; before.family = "compiledGraph"; }
  const baseline = { members: mode === "absent" ? [] : [before] };
  if (["absent", "identical"].includes(mode)) expect(() => codec.assertPublicReleasePairCatalogBaseline(value.manifest, baseline)).not.toThrow();
  else expect(() => codec.assertPublicReleasePairCatalogBaseline(value.manifest, baseline)).toThrow(expect.objectContaining({ reason: "catalog-baseline-collision" }));
});
it("refuses a file injected into an otherwise valid catalog without a program image reference", async () => {
  await expect(fixture(read => { read.programImageDescriptors.files.push({ ...read.programImageDescriptors.files[0], path: "/_astro/unlisted.png", contentType: "image/png" }); })).rejects.toThrow();
});
it("refuses code/static paths even when the caller rehashes catalog metadata", async () => {
  const value = await fixture(), raw = structuredClone(value.manifest);
  (raw.members[0] as any).path = "/_astro/takeover.js";
  expect(() => codec.parsePublicReleasePairCatalogImages(raw, pair, identity)).toThrow();
  (raw.members[0] as any).path = "/brand/logo.png";
  expect(() => codec.parsePublicReleasePairCatalogImages(raw, pair, identity)).toThrow();
});
it("normalizes authority key order before full JSON hashing after a Firestore map round trip", async () => {
  const value = await fixture(), reordered = structuredClone(value.manifest);
  (reordered as any).catalogs = reordered.catalogs.map(row => Object.fromEntries(Object.entries(row).reverse()));
  expect(JSON.stringify(codec.parsePublicReleasePairCatalogImages(reordered, pair, identity))).toBe(JSON.stringify(value.manifest));
});

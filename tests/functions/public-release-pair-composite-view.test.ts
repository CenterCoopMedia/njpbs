import { expect, it } from "vitest";
import codec from "../../functions/lib/public-release-pair-composite-view.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { createHash } from "node:crypto";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
function fixture() {
  const authority = { baselineInputManifestDigest: "a".repeat(64), baselineCodePackManifestDigest: "b".repeat(64), baselineViewManifestDigest: "c".repeat(64),
    codeAssetManifestDigest: pair.codeAssetManifestDigest, sourceDependencyDigest: "d".repeat(64), sourceCensusDigest: "e".repeat(64), searchInputDigest: "f".repeat(64) };
  return { schemaVersion: 1, kind: "pair-composite-manifest", pairDigest: captured.root.pairDigest, inputManifestDigest: identity.inputManifestDigest,
    cursor: captured.root.cursor, authority, members: [{ path: "/about/", role: "route", kind: "page", status: 200, mime: "text/html; charset=utf-8",
      size: 3, sha256: "a".repeat(64), sourceDependencyDigest: authority.sourceDependencyDigest },
    { path: "/feeds/news.xml", role: "auxiliary", kind: "rss", status: 200, mime: "application/rss+xml; charset=utf-8",
      size: 4, sha256: "b".repeat(64), sourceDependencyDigest: authority.sourceDependencyDigest }] };
}
it("normalizes retained key order and preserves ordinary snapshot/H input identity separately", () => {
  const value = fixture(), parsed = codec.parsePublicReleasePairCompositeManifest(value, pair, identity, captured.root.cursor);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.members = value.members.map(row => Object.fromEntries(Object.entries(row).reverse()));
  reordered.authority = Object.fromEntries(Object.entries(value.authority).reverse());
  expect(codec.publicReleasePairCompositeManifestDigest(codec.parsePublicReleasePairCompositeManifest(reordered, pair, identity))).toBe(codec.publicReleasePairCompositeManifestDigest(parsed));
  expect(parsed.inputManifestDigest).toBe(identity.inputManifestDigest);
  expect(parsed.cursor).toEqual(captured.root.cursor);
});
function authorFixture() {
  const value = fixture();
  const owner = { authorId: "au_" + "a".repeat(32), sourceVersion: 4, snapshotDigest: "a".repeat(64),
    canonicalPath: "/authors/name/", sourceCensusDigest: value.authority.sourceCensusDigest, readerProvenanceDigest: "b".repeat(64) };
  const empty = createHash("sha256").update("").digest("hex");
  const members = [
    ...value.members.slice(0, 1),
    { path: "/authors/name-old/", role: "auxiliary", kind: "author", status: 308, mime: "text/html; charset=utf-8", size: 0,
      sha256: empty, sourceDependencyDigest: value.authority.sourceDependencyDigest, owner },
    { path: "/authors/name/", role: "auxiliary", kind: "author", status: 200, mime: "text/html; charset=utf-8", size: 3,
      sha256: "c".repeat(64), sourceDependencyDigest: value.authority.sourceDependencyDigest, owner },
    { path: "/authors/withdrawn/", role: "auxiliary", kind: "author", status: 410, mime: "text/html; charset=utf-8", size: 0,
      sha256: empty, sourceDependencyDigest: value.authority.sourceDependencyDigest, owner },
    ...value.members.slice(1),
  ];
  return { ...value, members };
}
it("binds exact author auxiliary pages, aliases and withdrawals with canonical owner key order", () => {
  const value = authorFixture(), parsed = codec.parsePublicReleasePairCompositeManifest(value, pair, identity);
  const reordered = { ...value, members: value.members.map(row => "owner" in row
    ? { ...row, owner: Object.fromEntries(Object.entries(row.owner).reverse()) } : row) };
  expect(codec.publicReleasePairCompositeManifestDigest(codec.parsePublicReleasePairCompositeManifest(reordered, pair, identity)))
    .toBe(codec.publicReleasePairCompositeManifestDigest(parsed));
});
it.each(["missing-owner", "wrong-census", "alias-body", "withdrawal-body", "canonical-path", "namespace"])("refuses author %s confusion", mode => {
  const value = authorFixture(), row = value.members[1] as any;
  if (mode === "missing-owner") delete row.owner;
  if (mode === "wrong-census") row.owner.sourceCensusDigest = "0".repeat(64);
  if (mode === "alias-body") row.size = 1;
  if (mode === "withdrawal-body") value.members[3].sha256 = "0".repeat(64);
  if (mode === "canonical-path") (value.members[2] as any).owner.canonicalPath = "/authors/other/";
  if (mode === "namespace") row.path = "/authors/name/child/";
  expect(() => codec.parsePublicReleasePairCompositeManifest(value, pair, identity)).toThrow();
});
it.each(["path", "role", "kind", "source", "cursor", "pair", "code", "duplicate", "author"])("refuses composite %s confusion", mode => {
  const value = fixture();
  if (mode === "path") value.members[1].path = "/feeds/unlisted.xml";
  if (mode === "role") value.members[1].role = "baseline-dynamic";
  if (mode === "kind") value.members[1].kind = "publication";
  if (mode === "source") value.members[1].sourceDependencyDigest = "0".repeat(64);
  if (mode === "cursor") value.cursor = { ...value.cursor, lastDigest: "0".repeat(64) };
  if (mode === "pair") value.pairDigest = "0".repeat(64);
  if (mode === "code") value.authority.codeAssetManifestDigest = "0".repeat(64);
  if (mode === "duplicate") value.members[1] = value.members[0];
  if (mode === "author") value.members[0].path = "/authors/name/";
  expect(() => codec.parsePublicReleasePairCompositeManifest(value, pair, identity, captured.root.cursor)).toThrow();
});

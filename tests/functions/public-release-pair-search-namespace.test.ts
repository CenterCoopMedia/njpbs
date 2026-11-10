import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import codec from "../../functions/lib/public-release-pair-search-namespace.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const members = [
  { path: "/pagefind/pagefind-entry.json", mime: "application/json; charset=utf-8", size: 4, sha256: hash("json") },
  { path: "/pagefind/pagefind.js", mime: "application/javascript; charset=utf-8", size: 2, sha256: hash("js") },
];
const manifest = () => ({ schemaVersion: 1, kind: "pair-search-namespace", namespace: "/pagefind/", pairDigest: protocol.publicReleaseDigest(pair),
  inputManifestDigest: identity.inputManifestDigest, cursor: captured.cursor, members: structuredClone(members) });
it("seals a complete namespace in exact field order and separately binds the original pair, H root and cursor", () => {
  const raw = manifest(), parsed = codec.parsePublicReleasePairSearchNamespace(raw, pair, identity, captured.cursor);
  const expected = JSON.stringify(members.map(row => ({ path: row.path, mime: row.mime, size: row.size, sha256: row.sha256 })));
  expect(codec.publicReleasePairSearchNamespaceRootDigest(parsed.members)).toBe(hash(expected));
  expect(codec.publicReleasePairSearchNamespaceManifestDigest(raw, pair, identity)).toBe(hash(JSON.stringify(raw)));
  const laterIdentity = { ...identity, contextSequence: identity.contextSequence + 1 };
  const later = { ...raw, cursor: { ...captured.cursor, sequence: laterIdentity.contextSequence, lastDigest: "d".repeat(64) } };
  expect(codec.publicReleasePairSearchNamespaceRootDigest(later.members)).toBe(codec.publicReleasePairSearchNamespaceRootDigest(parsed.members));
  expect(codec.publicReleasePairSearchNamespaceManifestDigest(later, pair, laterIdentity)).not.toBe(codec.publicReleasePairSearchNamespaceManifestDigest(raw, pair, identity));
});
it.each(["missing-entry", "outside", "duplicate", "unsorted", "mismatched-pair", "mismatched-input", "mismatched-cursor", "unknown-field", "bad-size", "bad-digest", "bad-mime"])("refuses %s", mode => {
  const raw = manifest();
  if (mode === "missing-entry") raw.members.pop();
  if (mode === "outside") raw.members[0].path = "/elsewhere/pagefind-entry.json";
  if (mode === "duplicate") raw.members[1] = structuredClone(raw.members[0]);
  if (mode === "unsorted") raw.members.reverse();
  if (mode === "mismatched-pair") raw.pairDigest = "f".repeat(64);
  if (mode === "mismatched-input") raw.inputManifestDigest = "f".repeat(64);
  if (mode === "mismatched-cursor") raw.cursor = { ...raw.cursor, lastDigest: "f".repeat(64) };
  if (mode === "unknown-field") Object.assign(raw, { complete: true });
  if (mode === "bad-size") raw.members[0].size = -1;
  if (mode === "bad-digest") raw.members[0].sha256 = "bad";
  if (mode === "bad-mime") raw.members[0].mime = "application/json\r\nset-cookie: injected";
  expect(() => codec.parsePublicReleasePairSearchNamespace(raw, pair, identity, captured.cursor)).toThrow();
});
it("canonicalizes metadata key order before hashing but preserves exact member byte identities", () => {
  const raw = manifest(), reverseKeys = { members: raw.members.map(row => ({ sha256: row.sha256, size: row.size, mime: row.mime, path: row.path })),
    cursor: raw.cursor, inputManifestDigest: raw.inputManifestDigest, pairDigest: raw.pairDigest, namespace: raw.namespace, kind: raw.kind, schemaVersion: raw.schemaVersion };
  expect(codec.publicReleasePairSearchNamespaceManifestDigest(reverseKeys, pair, identity)).toBe(codec.publicReleasePairSearchNamespaceManifestDigest(raw, pair, identity));
  const changed = manifest(); changed.members[0].sha256 = "a".repeat(64);
  expect(codec.publicReleasePairSearchNamespaceRootDigest(changed.members)).not.toBe(codec.publicReleasePairSearchNamespaceRootDigest(raw.members));
});

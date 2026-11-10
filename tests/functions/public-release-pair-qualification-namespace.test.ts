import { expect, it } from "vitest";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { parsePublicReleasePairSearchNamespace, publicReleasePairSearchNamespaceRootDigest,
  publicReleasePairSearchNamespaceManifestDigest } from "../../site/scripts/public-release-pair-search-namespace";
import { publicReleasePairContentFeedNamespaceRootDigest, publicReleasePairContentFeedNamespaceManifestDigest } from "../../site/scripts/public-release-pair-content-feed-namespace";
import { bindQualificationNamespaces } from "../../site/scripts/public-release-pair-qualification-namespace";
const { pair } = sealedPair(), captured = capturedPairInput(pair);
const reference = { identity: { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), ...captured.taskInput },
  claimDigest: "a".repeat(64), manifestDigest: "b".repeat(64), manifestBytes: 2048 };
const members = ["/pagefind/pagefind-entry.json", "/pagefind/pagefind.js"].map(path => ({ path,
  mime: path.endsWith(".json") ? "application/json; charset=utf-8" : "application/javascript; charset=utf-8", size: 1, sha256: "c".repeat(64) }));
const manifest = parsePublicReleasePairSearchNamespace({ schemaVersion: 1, kind: "pair-search-namespace", namespace: "/pagefind/",
  pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: reference.identity.inputManifestDigest, cursor: captured.cursor, members }, pair, reference.identity);
const head = { ...captured.cursor, sequence: captured.cursor.sequence + 1, lastDigest: "d".repeat(64) };
const witness = { fromCursor: captured.cursor, headCursor: head };
function selection() {
  return { namespace: "/pagefind/" as const, namespaceRootDigest: publicReleasePairSearchNamespaceRootDigest(manifest.members),
    namespaceManifestDigest: publicReleasePairSearchNamespaceManifestDigest(manifest, pair, reference.identity), cursor: captured.cursor,
    headCursor: head, view: reference, manifest, members: manifest.members,
    priorPaths: [...members.map(row => row.path), "/pagefind/transient.pf_index"].sort(view.comparePrivatePairArtifactPaths),
    withdrawnPaths: ["/pagefind/transient.pf_index"] };
}
it("binds both namespace digests and transient withdrawals without retagging the producing cursor", () => {
  const result = bindQualificationNamespaces(pair, witness, [selection()]);
  expect(result.namespaces[0].cursor).toEqual(captured.cursor);
  expect(result.namespaces[0].headCursor).toEqual(head);
  expect(result.namespaces[0].withdrawnPaths).toEqual(["/pagefind/transient.pf_index"]);
  const later = { ...head, sequence: head.sequence + 1, lastDigest: "e".repeat(64) };
  const advanced = bindQualificationNamespaces(pair, { ...witness, headCursor: later }, [{ ...selection(), headCursor: later }]);
  expect(advanced.namespaceProofDigest).not.toBe(result.namespaceProofDigest);
  expect(advanced.namespaces[0].namespaceManifestDigest).toBe(result.namespaces[0].namespaceManifestDigest);
  expect(advanced.namespaces[0].cursor).toEqual(captured.cursor);
});
it.each(["root", "manifest", "retag", "missing-prior", "missing-withdrawal", "head", "duplicate-prior"])("refuses %s proof disagreement", mode => {
  const value = selection();
  if (mode === "root") value.namespaceRootDigest = "f".repeat(64);
  if (mode === "manifest") value.namespaceManifestDigest = "f".repeat(64);
  if (mode === "retag") value.cursor = head;
  if (mode === "missing-prior") value.priorPaths = [];
  if (mode === "missing-withdrawal") value.withdrawnPaths = [];
  if (mode === "head") value.headCursor = captured.cursor;
  if (mode === "duplicate-prior") value.priorPaths.push(value.priorPaths.at(-1)!);
  expect(() => bindQualificationNamespaces(pair, witness, [value])).toThrow();
});

function feedSelection() {
  const manifest = { schemaVersion: 1 as const, kind: "pair-content-feed-namespace" as const, namespace: "/api/v1/content/" as const,
    pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: reference.identity.inputManifestDigest, cursor: captured.cursor,
    index: { path: "/api/v1/content.json" as const, mime: "application/json; charset=utf-8", size: 1, sha256: "c".repeat(64), pageCount: 0 }, members: [] };
  return { namespace: manifest.namespace, namespaceRootDigest: publicReleasePairContentFeedNamespaceRootDigest(manifest.members),
    namespaceManifestDigest: publicReleasePairContentFeedNamespaceManifestDigest(manifest, pair, reference.identity),
    cursor: captured.cursor, headCursor: head, view: reference, manifest, members: manifest.members,
    index: { ...manifest.index, view: reference, cursor: captured.cursor },
    priorPaths: ["/api/v1/content/1.json"], withdrawnPaths: ["/api/v1/content/1.json"] };
}
it("binds both complete namespaces including a zero-page feed and prior withdrawals", () => {
  const proof = bindQualificationNamespaces(pair, witness, [selection(), feedSelection()]);
  expect(proof.namespaces.map(row => row.namespace)).toEqual(["/pagefind/", "/api/v1/content/"]);
  expect(proof.namespaces[1].members).toEqual([]);
  expect(bindQualificationNamespaces(pair, witness, [feedSelection(), selection()]).namespaceProofDigest).not.toBe(proof.namespaceProofDigest);
});
it.each(["index-view", "index-cursor", "index-roster", "foreign-prior", "duplicate-namespace"])("refuses feed %s mismatch", mode => {
  const value = feedSelection();
  if (mode === "index-view") value.index.view = { ...reference, claimDigest: "e".repeat(64) };
  if (mode === "index-cursor") value.index.cursor = head;
  if (mode === "index-roster") value.index.pageCount = 1;
  if (mode === "foreign-prior") value.priorPaths = value.withdrawnPaths = ["/api/v1/content/arbitrary.json"];
  expect(() => bindQualificationNamespaces(pair, witness, mode === "duplicate-namespace" ? [value, value] : [value])).toThrow();
});

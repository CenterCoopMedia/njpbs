import { expect, it } from "vitest";
import protocol from "../../functions/lib/public-release-pair.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { parseReaderRequest, parseReaderReply } from "../../site/scripts/public-release-pair-reader-contract";

const { pair, seals } = sealedPair(), captured = capturedPairInput(pair);
const request = () => ({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair),
  identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...captured.taskInput },
  claimDigest: "a".repeat(64), manifestDigest: "b".repeat(64), manifestBytes: 2048,
  nonce: "c".repeat(64), paths: [], absence: { namespace: "/pagefind/", namespaceRootDigest: "d".repeat(64),
    namespaceManifestDigest: "e".repeat(64), cursor: captured.cursor, paths: ["/pagefind/retired.pf_index"] } });
function reply() {
  const wanted = parseReaderRequest(request(), pair);
  return { schemaVersion: 2, kind: "private-pair-read", requestDigest: protocol.publicReleaseDigest(wanted), seals,
    stagedReadbackDigest: "f".repeat(64), outputs: [], namespaceAbsence: { namespace: "/pagefind/",
      namespaceRootDigest: wanted.absence!.namespaceRootDigest, namespaceManifestDigest: wanted.absence!.namespaceManifestDigest,
      cursor: captured.cursor, outputs: [{ path: "/pagefind/retired.pf_index", status: 404, kind: "namespace-absent" }] } };
}
it("binds an absence-only reply to both namespace digests, original cursor and actual request nonce", () => {
  const parsed = parseReaderReply(reply(), pair, parseReaderRequest(request(), pair));
  expect(parsed.namespaceAbsence?.outputs).toEqual([{ path: "/pagefind/retired.pf_index", status: 404, kind: "namespace-absent" }]);
  expect(parsed.outputs).toEqual([]);
});
it.each(["root", "manifest", "cursor", "nonce", "path", "status", "kind", "omission"])("refuses changed %s absence proof", mode => {
  const value = reply();
  if (mode === "root") value.namespaceAbsence.namespaceRootDigest = "0".repeat(64);
  if (mode === "manifest") value.namespaceAbsence.namespaceManifestDigest = "0".repeat(64);
  if (mode === "cursor") value.namespaceAbsence.cursor = { ...captured.cursor, sequence: 11 };
  if (mode === "nonce") value.requestDigest = "0".repeat(64);
  if (mode === "path") value.namespaceAbsence.outputs[0].path = "/pagefind/other.pf_index";
  if (mode === "status") value.namespaceAbsence.outputs[0].status = 503;
  if (mode === "kind") value.namespaceAbsence.outputs[0].kind = "unavailable";
  if (mode === "omission") value.namespaceAbsence.outputs = [];
  expect(() => parseReaderReply(value, pair, parseReaderRequest(request(), pair))).toThrow();
});
it.each(["namespace", "missing-manifest", "foreign-path", "duplicate", "oversized", "mixed-oversized", "cursor"])(
  "refuses %s requests before any transport", mode => {
    const value = request();
    if (mode === "namespace") value.absence.namespace = "/other/";
    if (mode === "missing-manifest") value.absence.namespaceManifestDigest = "";
    if (mode === "foreign-path") value.absence.paths = ["/_astro/main.js"];
    if (mode === "duplicate") value.absence.paths.push(value.absence.paths[0]);
    if (mode === "oversized" || mode === "mixed-oversized") value.absence.paths = Array.from({ length: 33 }, (_, i) => `/pagefind/${String(i).padStart(2, "0")}.bin`);
    if (mode === "mixed-oversized") { value.absence.paths.pop(); (value.paths as string[]).push("/current/"); }
    if (mode === "cursor") value.absence.cursor = { ...captured.cursor, sequence: 11 };
    expect(() => parseReaderRequest(value, pair)).toThrow();
  });

it("binds numbered feed absence to the same immutable reader envelope", () => {
  const value = request(); value.absence.namespace = "/api/v1/content/";
  value.absence.paths = ["/api/v1/content/1.json", "/api/v1/content/20.json"];
  const parsed = parseReaderRequest(value, pair), response = reply();
  response.requestDigest = protocol.publicReleaseDigest(parsed);
  response.namespaceAbsence = { ...response.namespaceAbsence, namespace: value.absence.namespace,
    outputs: value.absence.paths.map(path => ({ path, status: 404, kind: "namespace-absent" })) };
  expect(parseReaderReply(response, pair, parsed).namespaceAbsence?.outputs).toHaveLength(2);
});
it.each(["/api/v1/content/0.json", "/api/v1/content/01.json", "/api/v1/content.json", "/api/v1/content/1.js", "/api/v1/content/arbitrary.json"])(
  "refuses non-numbered feed absence %s", path => {
    const value = request(); value.absence.namespace = "/api/v1/content/"; value.absence.paths = [path];
    expect(() => parseReaderRequest(value, pair)).toThrow();
  });

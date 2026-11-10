import { expect, it } from "vitest";
import protocol from "../../functions/lib/public-release-pair.js";
import codec from "../../functions/lib/public-release-pair-view.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const claim = "e".repeat(64), empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
it.each(["/assets/café.svg", "/画像/番組.webp", "/_pair-compiled/runtime/pair.mjs", "/pagefind/index-😀.pf_index", "/assets/empty.js"])("accepts an exact NFC private artifact %s", path => {
  expect(codec.isPrivatePairArtifactPath(path)).toBe(true);
  expect(codec.parsePublicReleasePairViewOutput({ path, status: 200, bytes: 0, bodyDigest: empty,
    objectKey: codec.publicReleasePairViewObjectKey(pair, identity, claim, empty),
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } }, pair, identity, claim).path).toBe(path);
});
it.each([["/_home-sources.json", "application/json; charset=utf-8"], ["/rendered.html", "text/html; charset=utf-8"]])("refuses an empty rendered body at %s", (path, mime) => {
  expect(() => codec.parsePublicReleasePairViewOutput({ path, status: 200, bytes: 0, bodyDigest: empty,
    objectKey: codec.publicReleasePairViewObjectKey(pair, identity, claim, empty),
    headers: { "content-type": mime, "cache-control": "no-store" } }, pair, identity, claim)).toThrow();
});
it.each(["/", "/folder/", "/cafe\u0301.svg", "/../secret", "/x/./y", "/x//y", "/x%20y", "/x?y", "/x#y", "/x\\y", "/x\ny", "/x\u0085y", "/x\ud800", "/" + "😀".repeat(256)])("refuses unsafe/aliased artifact path %s", path => {
  expect(codec.isPrivatePairArtifactPath(path)).toBe(false);
});
it("keeps rendered root and trailing-slash routes nonempty and redirect locations ASCII", () => {
  const output = { path: "/about/", status: 200, bytes: 0, bodyDigest: empty,
    objectKey: codec.publicReleasePairViewObjectKey(pair, identity, claim, empty),
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } };
  expect(() => codec.parsePublicReleasePairViewOutput(output, pair, identity, claim)).toThrow();
  expect(() => codec.parsePublicReleasePairViewOutput({ ...output, status: 308,
    headers: { ...output.headers, location: "/café.svg" } }, pair, identity, claim)).toThrow();
});
it("orders BMP and astral filenames by exact UTF8 bytes across page boundaries", () => {
  const paths = ["/\ue000.bin", "/😀.bin"];
  expect(codec.comparePrivatePairArtifactPaths(paths[0], paths[1])).toBe(-1);
  expect(codec.comparePrivatePairArtifactPaths(paths[1], paths[0])).toBe(1);
  expect(codec.comparePrivatePairArtifactPaths(paths[0], paths[0])).toBe(0);
  const output = (path: string) => ({ path, status: 200, bytes: 0, bodyDigest: empty,
    objectKey: codec.publicReleasePairViewObjectKey(pair, identity, claim, empty),
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  const page = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), taskId: protocol.publicReleaseDigest(identity),
    claimDigest: claim, index: 0, outputs: paths.map(output) };
  expect(codec.parsePublicReleasePairViewPage(page, pair, identity, claim).outputs.map(row => row.path)).toEqual(paths);
  expect(() => codec.parsePublicReleasePairViewPage({ ...page, outputs: [...page.outputs].reverse() }, pair, identity, claim)).toThrow();
  const root = { schemaVersion: 2, kind: "private-pair-view", pairDigest: protocol.publicReleaseDigest(pair), identity, claimDigest: claim,
    cursor: captured.cursor, pages: paths.map((path, index) => ({ index, digest: (index ? "a" : "b").repeat(64), count: 1, bytes: 0,
      firstPath: path, lastPath: path })), outputCount: 2, outputBytes: 0 };
  expect(codec.parsePublicReleasePairViewRoot(root, pair).pages.map(row => row.firstPath)).toEqual(paths);
  expect(() => codec.parsePublicReleasePairViewRoot({ ...root, pages: [...root.pages].reverse().map((row, index) => ({ ...row, index })) }, pair)).toThrow();
});

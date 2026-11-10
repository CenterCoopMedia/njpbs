import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import codec from "../../functions/lib/public-release-pair-view.js";
import { parsePublicReleasePairRenderPlan } from "../../site/scripts/public-release-pair-render-plan";
const pair = releasePair(), captured = capturedPairInput(pair), claimDigest = "e".repeat(64);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const bodyDigest = createHash("sha256").update("").digest("hex");
const target = "https://example.test/results?a=1&b=2#today";
const output = { path: "/posts/story/", status: 302, bodyDigest, bytes: 0,
  objectKey: codec.publicReleasePairViewObjectKey(pair, identity, claimDigest, bodyDigest),
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", location: target } };
it("retains an exact HTTPS 302 and refuses credentials, HTTP, missing noindex and redirect bodies", () => {
  expect(codec.parsePublicReleasePairViewOutput(output, pair, identity, claimDigest).headers.location).toBe(target);
  for (const location of ["http://example.test/", "https://user:pass@example.test/", "/relative/", "https://example.test/\n"]) expect(() => codec.parsePublicReleasePairViewOutput({ ...output, headers: { ...output.headers, location } }, pair, identity, claimDigest)).toThrow();
  expect(() => codec.parsePublicReleasePairViewOutput({ ...output, bytes: 1 }, pair, identity, claimDigest)).toThrow();
  const { "x-robots-tag": _robots, ...headers } = output.headers;
  expect(() => codec.parsePublicReleasePairViewOutput({ ...output, headers }, pair, identity, claimDigest)).toThrow();
});
it.each(["post", "page", "context"])("admits normal 200 and temporary 302 plans for %s, with exact frozen dependencies", renderer => {
  const root = { ...captured.root, entryFiles: ["render-plan.json", "snapshot.json"], files: [...captured.root.files,
    { name: "render-plan.json", digest: "d".repeat(64), bytes: 1024, objectKey: "fixture", dependencies: ["context.json", "snapshot.json"] }].sort((a,b) => a.name < b.name ? -1 : 1) };
  const plan = { schemaVersion: 1, pairDigest: root.pairDigest, snapshotDigest: root.scope.snapshotDigest,
    renderedAt: "2026-11-02T20:00:00.000Z", routes: [{ path: "/posts/story/", method: "GET", renderer, inputFile: "context.json", dependencies: captured.root.files.map(file => ({ name: file.name, digest: file.digest })) }],
    expectedOutputs: [{ path: "/posts/story/", status: 302, contentType: "text/html; charset=utf-8" }] };
  expect(parsePublicReleasePairRenderPlan(plan, root).expectedOutputs[0].status).toBe(302);
  plan.expectedOutputs[0].status = 200;
  expect(parsePublicReleasePairRenderPlan(plan, root).expectedOutputs[0].status).toBe(200);
  plan.routes[0].renderer = "json"; plan.expectedOutputs[0].status = 302;
  expect(() => parsePublicReleasePairRenderPlan(plan, root)).toThrow();
});

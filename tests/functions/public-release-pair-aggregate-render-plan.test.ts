import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { parsePublicReleasePairRenderPlan } from "../../site/scripts/public-release-pair-render-plan";
import { openPublicReleasePairRenderPlans } from "../../site/scripts/public-release-pair-render-plans";
import { parsePublicReleasePairAggregateRenderPlan } from "../../site/scripts/public-release-pair-aggregate-render-plan";
function fixture() {
  const captured = capturedPairInput(releasePair());
  const raw = { schemaVersion: 1, pairDigest: captured.root.pairDigest, snapshotDigest: captured.scope.snapshotDigest,
    renderedAt: "2026-10-28T04:00:00.000Z", routes: [{ path: "/posts/story/", method: "GET", renderer: "post", inputFile: "context.json",
      dependencies: captured.root.files.map(file => ({ name: file.name, digest: file.digest })) }],
    expectedOutputs: [{ path: "/posts/story/", status: 200, contentType: "text/html; charset=utf-8" }] };
  const dependencies = ["context.json", "snapshot.json"];
  const root = { ...captured.root, entryFiles: ["render-plan.json", "snapshot.json", "source-dependencies.json"],
    files: [...captured.root.files, { name: "render-plan.json", digest: "d".repeat(64), bytes: 1024, objectKey: "fixture", dependencies }] };
  const ordinary = parsePublicReleasePairRenderPlan(raw, root);
  const aggregate = { schemaVersion: 1, kind: "pair-aggregate-render-plan", pairDigest: root.pairDigest, cursor: root.cursor,
    renderedAt: ordinary.renderedAt, routes: raw.routes, expectedOutputs: raw.expectedOutputs };
  const seal = () => {
    const bytes = new TextEncoder().encode(JSON.stringify(aggregate));
    root.files = root.files.filter(file => !["aggregate-render-plan.json", "source-dependencies.json"].includes(file.name));
    root.files.push({ name: "aggregate-render-plan.json", digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, objectKey: "fixture", dependencies: [...dependencies] });
    root.files.push({ name: "source-dependencies.json", digest: "f".repeat(64), bytes: 1, objectKey: "fixture", dependencies: ["aggregate-render-plan.json"] });
    return bytes;
  };
  return { root, ordinary, aggregate, seal };
}
it("binds full aggregate routes to the original H cursor/time/snapshot while retaining the strict ordinary route grammar", () => {
  const value = fixture(), parsed = parsePublicReleasePairAggregateRenderPlan(value.seal(), value.root, value.ordinary);
  expect(parsed).toEqual(value.ordinary);
  expect(parsed.snapshotDigest).toBe(value.root.scope.snapshotDigest);
});
it.each(["missing", "bytes", "cursor", "time", "pair", "renderer", "dependency", "unknown"])("refuses aggregate %s mismatch", mode => {
  const value = fixture();
  if (mode === "cursor") value.aggregate.cursor = { ...value.aggregate.cursor, lastDigest: "e".repeat(64) };
  if (mode === "time") value.aggregate.renderedAt = "2026-10-28T04:01:00.000Z";
  if (mode === "pair") value.aggregate.pairDigest = "e".repeat(64);
  if (mode === "renderer") value.aggregate.routes[0].renderer = "latest";
  if (mode === "dependency") value.aggregate.routes[0].dependencies.pop();
  if (mode === "unknown") Object.assign(value.aggregate, { latest: true });
  const bytes = value.seal();
  if (mode === "missing") value.root.entryFiles = value.root.entryFiles.filter(file => file !== "source-dependencies.json");
  if (mode === "bytes") bytes[0] ^= 1;
  expect(() => parsePublicReleasePairAggregateRenderPlan(bytes, value.root, value.ordinary)).toThrow();
});

it("combines the source plans while retaining separate ordinal files and ordinary ownership on an overlap", async () => {
  const value = fixture(), aggregateBytes = value.seal();
  const read = async (name: string) => name === "render-plan.json" ? new TextEncoder().encode(JSON.stringify(value.ordinary)) : aggregateBytes;
  const plans = await openPublicReleasePairRenderPlans(value.root, read);
  expect(plans.plan.routes).toHaveLength(1);
  expect(plans.selected[0]).toMatchObject({ filePrefix: "", index: 0 });
  expect(plans.overlaps).toEqual([{ path: "/posts/story/", ordinaryIndex: 0, aggregateIndex: 0 }]);
  expect(plans.ordinaryPlan.snapshotDigest).toBe(value.root.scope.snapshotDigest);
});
it("rejects an overlapping route whose source plans disagree on output status", async () => {
  const value = fixture(); value.aggregate.expectedOutputs[0].status = 308;
  const bytes = value.seal();
  await expect(openPublicReleasePairRenderPlans(value.root, async name => name === "render-plan.json"
    ? new TextEncoder().encode(JSON.stringify(value.ordinary)) : bytes)).rejects.toThrow();
});

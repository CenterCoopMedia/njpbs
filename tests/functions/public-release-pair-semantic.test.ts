import { expect, it, vi } from "vitest";
import { MODEL_ID, MODEL_REVISION } from "../../packages/browser-search/contracts";
import { extractPassages } from "../../site/src/search/build-corpus";
import { buildPublicReleasePairSemanticIndex } from "../../site/scripts/public-release-pair-semantic";
const source = (title = "Original title", text = "Exact accepted article body.") => `<html lang="en"><head><title>${title}</title></head><body><main data-pagefind-body><h1>${title}</h1><p>${text}</p></main></body></html>`;
const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const original = extractPassages(source(), "/posts/one/", "public").map(passage => ({ ...passage, vector }));
async function run(html: string, override: Record<string, unknown> = {}, priorBytes?: Uint8Array) {
  const encode = vi.fn(async () => [...vector]), dispose = vi.fn(async () => {}), createEncoder = vi.fn(async () => ({ encode, dispose, modelLoadMs: 1 }));
  async function* files() { yield { path: "/posts/one/", bytes: new TextEncoder().encode(html) }; }
  const result = await buildPublicReleasePairSemanticIndex({ html: files(), baselineBytes: bytes({ version: 1, model: MODEL_ID, revision: MODEL_REVISION, passages: original, ...override }), priorBytes, createEncoder });
  return { result, createEncoder, encode, dispose };
}
it("reuses only the exact full encoder input without loading a model", async () => {
  const value = await run(source()); expect(value.createEncoder).not.toHaveBeenCalled(); expect(value.result.metrics).toMatchObject({ reused: 1, encoded: 0 });
});
it.each(["body", "title"])("re-encodes a %s-only change, including a title change with the same passage ID", async mode => {
  const value = await run(mode === "body" ? source("Original title", "Changed article body.") : source("New title"));
  expect(value.encode).toHaveBeenCalledTimes(1); expect(value.dispose).toHaveBeenCalledTimes(1); expect(value.result.metrics.encoded).toBe(1);
  const next = JSON.parse(new TextDecoder().decode(value.result.bytes)).passages[0];
  if (mode === "title") expect(next.id).toBe(original[0].id);
});
it("refuses another model revision before loading any encoder", async () => {
  await expect(run(source(), { revision: "another" })).rejects.toMatchObject({ reason: "semantic-model-revision-mismatch" });
});
const prior = (override = {}) => bytes({ version: 1, model: MODEL_ID, revision: MODEL_REVISION, passages: original, ...override });
it("reuses exact prior passages against an empty CODE baseline and rebuilds current metadata", async () => {
  const value = await run(source(), { passages: [] }, prior({ passages: original.map(passage => ({ ...passage, url: "/former/" })) }));
  expect(value.createEncoder).not.toHaveBeenCalled(); expect(value.result.metrics).toMatchObject({ reused: 1, encoded: 0 });
  expect(JSON.parse(new TextDecoder().decode(value.result.bytes)).passages[0].url).toBe("/posts/one/");
});
it.each([source("New title"), source("Original title", "Changed body.")])("encodes changed prior content even when its route or ID stays the same", async html => {
  const value = await run(html, { passages: [] }, prior()); expect(value.encode).toHaveBeenCalledTimes(1);
});
it.each([new Uint8Array(), prior({ revision: "another" }), prior({ passages: original.map(passage => ({ ...passage, vector: [1] })) })])(
  "freshly encodes on doubt about optional prior vectors", async suspect => {
    const value = await run(source(), {}, suspect); expect(value.encode).toHaveBeenCalledTimes(1);
  });
it("does not restore withdrawn passages from either prior roster", async () => {
  const value = await run("<html><head></head><body></body></html>", {}, prior());
  expect(JSON.parse(new TextDecoder().decode(value.result.bytes)).passages).toEqual([]);
  expect(value.createEncoder).not.toHaveBeenCalled();
});
it("keeps exact CODE vectors when a passage was absent from the prior roster", async () => {
  const value = await run(source(), {}, prior({ passages: [] }));
  expect(value.createEncoder).not.toHaveBeenCalled(); expect(value.result.metrics.reused).toBe(1);
});
it("freshly encodes on disagreement between CODE and prior vectors", async () => {
  const value = await run(source(), {}, prior({ passages: original.map(passage => ({ ...passage, vector: vector.map(value => value ? -1 : 0) })) }));
  expect(value.encode).toHaveBeenCalledTimes(1); expect(value.result.metrics.reused).toBe(0);
});

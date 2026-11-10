import { expect, it } from "vitest";
import retention from "../../functions/lib/public-release-media-retention.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import coverage from "../../functions/lib/public-release-media-coverage.js";

const pair = releasePair();
const receipt: any = { scope: { kind: "qualification", sourceOperationId: "original", sourceVersion: 1,
  snapshotDigest: "a".repeat(64), contextSequence: 0 }, inputManifestDigest: "b".repeat(64) };
const pin = (assetIds = ["art"]) => retention.buildPairMediaPin({ pair, receipt,
  sourceMetadataDigest: "c".repeat(64), assetIds });

it("binds ordered, bounded media chunks to their full pair and original H receipt", () => {
  const ids = Array.from({ length: 201 }, (_, index) => `art-${String(index).padStart(4, "0")}`);
  const value = pin(ids), chunks = retention.chunksForPin(value);
  expect(chunks.map(chunk => chunk.assetIds.length)).toEqual([100, 100, 1]);
  expect(value.chunks).toEqual(chunks.map(chunk => protocol.publicReleaseDigest(chunk)));
  expect(value.inputReceiptDigest).toBe(protocol.publicReleaseDigest(receipt));
  expect(value.assetIds).toEqual(ids);
  expect(() => retention.parsePairMediaPin(value, releasePair("b", "b".repeat(40)))).toThrow();
});

it.each(["duplicate", "unsorted", "invalid", "overflow", "changed roster", "missing chunk", "changed metadata"])("refuses %s pin evidence", mode => {
  const value = structuredClone(pin(["art", "other"]));
  if (mode === "duplicate") value.assetIds = ["art", "art"];
  if (mode === "unsorted") value.assetIds.reverse();
  if (mode === "invalid") value.assetIds = ["../art"];
  if (mode === "overflow") value.assetIds = Array.from({ length: 5001 }, (_, index) => `art-${String(index).padStart(4, "0")}`);
  if (mode === "changed roster") value.assetIds = ["new"];
  if (mode === "missing chunk") value.chunks = [];
  if (mode === "changed metadata") value.sourceMetadataDigest = "d".repeat(64);
  expect(() => retention.parsePairMediaPin(value, pair)).toThrow();
});

it.each([null, undefined, { schemaVersion: 1 }, { schemaVersion: 1, state: "deploying" }])("keeps the schema-one path free of pair reads (%j)", async root => {
  const deny = new Proxy({}, { get() { throw new Error("No pair or SDK work on schema one"); } });
  expect(await retention.readRetainedPairMediaHoldInTransaction({ firestore: deny as any,
    transaction: deny as any, root, assetId: "art" })).toBeNull();
});

it("checks complete accounting with bounded reads even after a large retained history", async () => {
  let reads = 0;
  const state = { schemaVersion: 2, kind: "pair-media-input-coverage", pairDigest: protocol.publicReleaseDigest(pair),
    ledgerId: "d".repeat(64), phase: "tracking", totalInputs: 100_000, pinnedInputs: 100_000, pendingInputs: 0, revision: 200_000 };
  const firestore = { doc: (path: string) => ({ path }), collection() { throw new Error("No history rescan on a tracked pair"); } };
  const transaction = { async get(reference: { path: string }) {
    reads++; expect(reference.path).toBe(coverage.coveragePath(pair)); return { data: () => state };
  } };
  await expect(coverage.assertPairMediaCoverageInTransaction({ firestore: firestore as any,
    transaction: transaction as any, pair })).resolves.toEqual(state);
  expect(reads).toBeLessThanOrEqual(8);
});

it.each(["missing", "migration", "pending", "corrupt"])("refuses %s accounting instead of certifying absent media", async mode => {
  const state = { schemaVersion: 2, kind: "pair-media-input-coverage", pairDigest: protocol.publicReleaseDigest(pair),
    ledgerId: "d".repeat(64), phase: mode === "migration" ? "needs-migration" : "tracking", totalInputs: 2,
    pinnedInputs: mode === "pending" ? 1 : 2, pendingInputs: mode === "pending" ? 1 : 0, revision: 4 };
  if (mode === "corrupt") state.totalInputs = 0;
  const firestore = { doc: (path: string) => ({ path }) }, transaction = { async get() { return { data: () => mode === "missing" ? undefined : state }; } };
  await expect(coverage.assertPairMediaCoverageInTransaction({ firestore: firestore as any,
    transaction: transaction as any, pair })).rejects.toThrow();
});

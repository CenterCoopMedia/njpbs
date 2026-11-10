import { expect, it } from "vitest";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import history from "../../functions/lib/public-release-pair-replay-history.js";
import inventory from "../../functions/lib/public-release-pair-replay-inventory.js";
import { createHash } from "node:crypto";

const pair = releasePair(),
  anchor = "b".repeat(64),
  globalReceipt = "c".repeat(64);
const cursor = { baselineDigest: anchor, sequence: 0, lastDigest: anchor };
const reference = {
  identity: {
    schemaVersion: 2,
    pair: protocol.publicReleasePairReference(pair),
    kind: "qualification",
    sourceOperationId: "baseline",
    sourceVersion: 1,
    snapshotDigest: "d".repeat(64),
    contextSequence: 0,
    inputManifestDigest: "e".repeat(64),
  },
  claimDigest: "f".repeat(64),
  manifestDigest: "a".repeat(64),
  manifestBytes: 100,
};
const baseline = () => ({
  schemaVersion: 2,
  pairDigest: protocol.publicReleaseDigest(pair),
  logBaselineDigest: globalReceipt,
  cursor,
  sourceInventoryDigest: "1".repeat(64),
  codeAssetManifestDigest: pair.codeAssetManifestDigest,
  inputReceiptDigests: ["2".repeat(64), "3".repeat(64)],
  viewReceiptDigests: ["4".repeat(64), "5".repeat(64)],
  views: [
    {
      ...reference,
      identity: {
        ...reference.identity,
        sourceOperationId: `baseline-${globalReceipt}`,
        snapshotDigest: "1".repeat(64),
      },
    },
  ],
  codePackView: { ...reference, manifestDigest: "0".repeat(64) },
  contentViewDigest: "6".repeat(64),
  codePackOverlayDigest: "7".repeat(64),
});
const witness = () => ({
  schemaVersion: 2,
  pairRef: protocol.publicReleasePairReference(pair),
  pairDigest: protocol.publicReleaseDigest(pair),
  logBaselineDigest: globalReceipt,
  pairBaselineDigest: "1".repeat(64),
  fromCursor: cursor,
  headCursor: cursor,
  pageCount: 0,
  logPagesRootDigest: history.emptyReplayHistory(pair, cursor).logPagesRootDigest,
  coveredMembersDigest: "2".repeat(64),
  contentViewDigest: "3".repeat(64),
  codeAssetManifestDigest: pair.codeAssetManifestDigest,
  codePackOverlayDigest: "4".repeat(64),
  codePackView: reference,
  capsuleDigest: "8".repeat(64),
  completedAt: 1_000,
});

it("keeps the global receipt digest separate from the log anchor and code baseline", () => {
  expect(replay.parseReplayPairBaseline(baseline(), pair).logBaselineDigest).toBe(globalReceipt);
  expect(replay.parseReplayWitness(witness(), pair).fromCursor.baselineDigest).toBe(anchor);
  expect(globalReceipt).not.toBe(anchor);
  expect(replay.parseReplayWitness(witness(), pair).codePackView.identity.snapshotDigest).not.toBe(
    reference.identity.inputManifestDigest,
  );
});
it("refuses each missing witness field, unknown fields and another full pair seal", () => {
  for (const field of Object.keys(witness())) {
    const value = witness();
    delete value[field];
    expect(() => replay.parseReplayWitness(value, pair)).toThrow();
  }
  expect(() => replay.parseReplayWitness({ ...witness(), baselineDigest: anchor }, pair)).toThrow();
  expect(() =>
    replay.parseReplayWitness(witness(), {
      ...pair,
      bindingsDigest: "9".repeat(64),
    }),
  ).toThrow();
});
it("refuses invalid history counts, missing roots, inverted cursors and an empty history forgery", () => {
  expect(() =>
    replay.parseReplayWitness(
      {
        ...witness(),
        headCursor: { ...cursor, sequence: 1, lastDigest: "9".repeat(64) },
      },
      pair,
    ),
  ).toThrow();
  expect(() => replay.parseReplayWitness({ ...witness(), pageCount: -1 }, pair)).toThrow();
  expect(() =>
    replay.parseReplayWitness(
      {
        ...witness(),
        fromCursor: { ...cursor, sequence: 2, lastDigest: "8".repeat(64) },
        headCursor: { ...cursor, sequence: 1, lastDigest: "9".repeat(64) },
        pageCount: 1,
        logPagesRootDigest: "7".repeat(64),
      },
      pair,
    ),
  ).toThrow();
  expect(() =>
    replay.parseReplayWitness(
      {
        ...witness(),
        fromCursor: { ...cursor, sequence: 1, lastDigest: "8".repeat(64) },
        headCursor: { ...cursor, sequence: 1, lastDigest: "9".repeat(64) },
      },
      pair,
    ),
  ).toThrow();
});
it("requires every baseline original receipt and refuses a future baseline view", () => {
  expect(() => replay.parseReplayPairBaseline({ ...baseline(), inputReceiptDigests: [] }, pair)).toThrow();
  expect(() => replay.parseReplayPairBaseline({ ...baseline(), viewReceiptDigests: [] }, pair)).toThrow();
  expect(() => replay.parseReplayPairBaseline({ ...baseline(), views: [] }, pair)).toThrow();
  const future = {
    ...baseline().views[0],
    identity: { ...baseline().views[0].identity, contextSequence: 1 },
  };
  expect(() => replay.parseReplayPairBaseline({ ...baseline(), views: [future] }, pair)).toThrow();
});

it("refuses a duplicate baseline/code-pack view and a forged checkpoint schema", () => {
  expect(() => replay.parseReplayPairBaseline({ ...baseline(), codePackView: reference }, pair)).toThrow();
  const checkpoint = {
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    pairBaselineDigest: "1".repeat(64),
    cursor,
    history: history.emptyReplayHistory(pair, cursor),
    coveredMembersDigest: "2".repeat(64),
    contentViewDigest: "3".repeat(64),
    codePackOverlayDigest: "4".repeat(64),
    capsuleDigest: "8".repeat(64),
    witnessDigest: null,
  };
  expect(replay.parseReplayCheckpoint(checkpoint, pair)).toEqual(checkpoint);
  expect(() => replay.parseReplayCheckpoint({ ...checkpoint, schemaVersion: 3 }, pair)).toThrow();
  expect(() =>
    replay.parseReplayCheckpoint(
      {
        ...checkpoint,
        history: { ...checkpoint.history, logPagesRootDigest: "0".repeat(64) },
      },
      pair,
    ),
  ).toThrow();
  expect(() => replay.parseReplayCheckpoint({ ...checkpoint, unverified: true }, pair)).toThrow();
});

function baselineSelection(
  path,
  { dynamic = true, body = "New receipt", mime = "application/json; charset=utf-8" } = {},
) {
  const bytes = Buffer.from("Retained receipt");
  const artifact = {
    path,
    mime: "application/json; charset=utf-8",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    family: dynamic ? "aggregate" : "static",
    source: dynamic ? "aggregate" : "static",
    dynamic,
  };
  return {
    artifacts: new Map([[path, artifact]]),
    content: new Map(),
    overlay: new Map(),
    reference,
    baseline: true,
    compositeVerified: true,
    outputs: [
      {
        path,
        status: 200,
        headers: { "content-type": mime },
        bytes: Buffer.byteLength(body),
        bodyDigest: createHash("sha256").update(body).digest("hex"),
      },
    ],
  };
}

it.each(["bytes", "size", "mime"])(
  "refuses a static baseline %s mismatch even with composite proof",
  (mode) => {
    const state = baselineSelection("/static.json", {
      dynamic: false,
      body: "Modified receipt",
    });
    if (mode === "size") {
      state.outputs[0].bodyDigest = state.artifacts.get("/static.json").sha256;
      state.outputs[0].bytes = state.artifacts.get("/static.json").size + 1;
    }
    if (mode === "mime") {
      state.outputs[0].bodyDigest = state.artifacts.get("/static.json").sha256;
      state.outputs[0].bytes = state.artifacts.get("/static.json").size;
      state.outputs[0].headers["content-type"] = "text/plain; charset=utf-8";
    }
    expect(() => inventory.selectReplayOutputs(state)).toThrow();
    expect(state.overlay.size).toBe(0);
  },
);

it("keeps equal dynamic baseline bytes in the original code pack", () => {
  const state = baselineSelection("/_publication.json", {
    body: "Retained receipt",
  });
  inventory.selectReplayOutputs(state);
  expect(state.overlay.size).toBe(0);
  expect(state.content.size).toBe(0);
});

it("requires a completed composite proof before an initial dynamic receipt overlay", () => {
  const state = baselineSelection("/_publication.json");
  expect(() => inventory.selectReplayOutputs({ ...state, compositeVerified: false })).toThrow();
  expect(state.overlay.size).toBe(0);
  inventory.selectReplayOutputs(state);
  expect([...state.overlay.values()]).toEqual([
    {
      path: "/_publication.json",
      view: reference,
      bodyDigest: state.outputs[0].bodyDigest,
    },
  ]);
});

it("refuses an unlisted dynamic file instead of adding baseline authority", () => {
  const state = baselineSelection("/_publication.json");
  state.outputs[0].path = "/unlisted-dynamic.json";
  expect(() => inventory.selectReplayOutputs(state)).toThrow();
  expect(state.overlay.size).toBe(0);
  expect(state.content.size).toBe(0);
});

it("selects changed dynamic MIME only from the complete composite proof", () => {
  const state = baselineSelection("/feeds/news.xml", {
    body: "Retained receipt",
    mime: "application/rss+xml; charset=utf-8",
  });
  expect(() => inventory.selectReplayOutputs({ ...state, compositeVerified: false })).toThrow();
  expect(state.overlay.size).toBe(0);
  inventory.selectReplayOutputs(state);
  expect(state.overlay.get("/feeds/news.xml").bodyDigest).toBe(state.outputs[0].bodyDigest);
});

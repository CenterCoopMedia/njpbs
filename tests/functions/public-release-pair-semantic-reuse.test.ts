import { expect, it } from "vitest";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { publicReleasePairSemanticReuse } from "../../site/scripts/public-release-pair-semantic-reuse";
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const claim = "e".repeat(64), bytes = new TextEncoder().encode("original staged bytes");
it("retains only an original completed run, with independent byte copies", async () => {
  const cache = publicReleasePairSemanticReuse(pair, async () => releaseSelector());
  await cache.staged(identity, claim, bytes);
  expect(await cache.begin(identity, claim)).toBeUndefined();
  const input = new Uint8Array(bytes); await cache.staged(identity, claim, input); input[0] ^= 1;
  const reused = (await cache.begin(identity, claim))!; expect(reused).toEqual(bytes); reused[0] ^= 1;
  expect(await cache.begin(identity, claim)).toEqual(bytes);
});
it("drops retained vectors after a switch, including a later return to the original pair", async () => {
  let selector = releaseSelector();
  const cache = publicReleasePairSemanticReuse(pair, async () => selector);
  await cache.begin(identity, claim); await cache.staged(identity, claim, bytes);
  selector = { ...selector, epoch: selector.epoch + 1, switchOperationId: "switch-two" };
  expect(await cache.begin(identity, claim)).toBeUndefined();
  selector = releaseSelector();
  expect(await cache.begin(identity, claim)).toBeUndefined();
});
it("keeps reuse across content-head advances within the same switch epoch", async () => {
  let selector = releaseSelector();
  const cache = publicReleasePairSemanticReuse(pair, async () => selector);
  await cache.begin(identity, claim); await cache.staged(identity, claim, bytes);
  selector = { ...selector, contentHead: { ...selector.contentHead, contextSequence: 1, manifestDigest: "d".repeat(64) } };
  expect(await cache.begin(identity, claim)).toEqual(bytes);
});
it("does not retain a run that crosses a switch or a different claim", async () => {
  let selector = releaseSelector();
  const cache = publicReleasePairSemanticReuse(pair, async () => selector);
  await cache.begin(identity, claim); selector = { ...selector, epoch: 2 };
  await cache.staged(identity, claim, bytes); expect(await cache.begin(identity, claim)).toBeUndefined();
  await cache.staged(identity, "f".repeat(64), bytes); expect(await cache.begin(identity, claim)).toBeUndefined();
});
it("treats selector loss as a cache miss and isolates pair instances", async () => {
  let unavailable = false;
  const cache = publicReleasePairSemanticReuse(pair, async () => { if (unavailable) throw new Error("offline"); return releaseSelector(); });
  await cache.begin(identity, claim); await cache.staged(identity, claim, bytes);
  unavailable = true; expect(await cache.begin(identity, claim)).toBeUndefined();
  unavailable = false; expect(await cache.begin(identity, claim)).toBeUndefined();
  const other = publicReleasePairSemanticReuse(releasePair("b"), async () => releaseSelector());
  await expect(other.begin(identity, claim)).rejects.toThrow();
});

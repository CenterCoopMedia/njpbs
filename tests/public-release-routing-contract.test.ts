import { expect, it, vi } from "vitest";
import protocol from "../functions/lib/public-release-pair.js";
import { parseSelectorReceipt } from "../packages/content-core/src/public-release-routing";
import { createRoutingObserver } from "../workers/src/public-release-routing-observer";
import { releaseSelector } from "./helpers/private-public-release-pair.js";

it("keeps Worker receipt parsing strict and compatible with the Node selector contract", () => {
  const selector = releaseSelector();
  expect(parseSelectorReceipt({ environment: "development", selector, readStartedAt: 1 }, "development").selector)
    .toEqual(protocol.parsePublicReleaseSelector(selector));
  for (const key of Object.keys(selector)) {
    const invalid: any = structuredClone(selector); delete invalid[key];
    expect(() => parseSelectorReceipt({ environment: "development", selector: invalid, readStartedAt: 1 }, "development")).toThrow();
  }
  for (const patch of [{ epoch: 0 }, { schemaVersion: 1 }, { state: "deploying" }, { extra: true },
    { activeCommitSha: "b".repeat(40) }, { recoveryPair: selector.selectedPair },
    { contentHead: { ...selector.contentHead, extra: true } }, { selectedPair: { ...selector.selectedPair, commitSha: [selector.activeCommitSha] } }]) {
    expect(() => parseSelectorReceipt({ environment: "development", selector: { ...selector, ...patch }, readStartedAt: 1 }, "development")).toThrow();
  }
});

it("leaves disabled measurement without allocations or binding access", () => {
  const env = { PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED: "false", get PAIR_ROUTING_ANALYTICS(): never { throw new Error("Touched binding"); } };
  const random = vi.spyOn(crypto, "getRandomValues");
  expect(createRoutingObserver(env)).toBeUndefined(); expect(random).not.toHaveBeenCalled(); random.mockRestore();
});

it("counts sampled isolate cache/refresh events without URL, content or credentials", () => {
  const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(value => { (value as Uint32Array).fill(0); return value; });
  const writeDataPoint = vi.fn();
  const observer = createRoutingObserver({ PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED: "true", CF_VERSION_METADATA: { id: "version" }, PAIR_ROUTING_ANALYTICS: { writeDataPoint } })!;
  for (const event of ["isolate-start", "request", "cache-hit", "refresh", "refresh-join", "refresh-failed"] as const) observer(event, 12);
  expect(writeDataPoint).toHaveBeenCalledTimes(6);
  const events = writeDataPoint.mock.calls.map(([point]) => point);
  expect(new Set(events.map(point => point.blobs[1])).size).toBe(1);
  expect(events.every(point => point.blobs.length === 3 && point.doubles[1] === 0.01)).toBe(true);
  random.mockRestore();
});

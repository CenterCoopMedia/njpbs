import { expect, it } from "vitest";
import { createOriginalPublicReleaseContinuation, bindOriginalPublicReleaseContinuation,
  originalPublicReleaseRetryDelay } from "../../site/scripts/public-release-original-continuation";

it.each([undefined, false, "true", 1])("does no SDK, storage, proof or pair work without literal enablement (%s)", enabled => {
  const options = new Proxy({ enabled }, { get(target, key) {
    if (key === "enabled") return target.enabled;
    throw new Error("Disabled continuation accessed a private dependency");
  } });
  expect(createOriginalPublicReleaseContinuation(options as any)).toEqual({});
});

it("preserves the exact executor and its existing hooks when original continuation is absent", () => {
  const deny = new Proxy({}, { get() { throw new Error("Disabled binding must not read authority"); } });
  const executor = { beforePoll: Symbol("existing preview recovery"), recover: Symbol("existing staging recovery") };
  expect(bindOriginalPublicReleaseContinuation({ firestore: deny as any, pair: deny as any,
    executor: executor as any, continuation: {} })).toBe(executor);
});

it("grows pending backoff beyond the container idle window and caps it at five minutes", () => {
  expect([1, 2, 3, 9, 10, 16].map(originalPublicReleaseRetryDelay)).toEqual([1_000, 2_000, 4_000, 256_000, 300_000, 300_000]);
  for (const invalid of [0, -1, 1.5, 17, NaN, Infinity]) expect(() => originalPublicReleaseRetryDelay(invalid)).toThrow();
});

import { expect, it } from "vitest";
import policy from "../../functions/lib/background-output-attempt.js";

// Characterization of the retained queue/child contracts at bc0e4d36.
const families = [
  ["post", { transport: "post-no-build-v1" }, "pending", "Public Post confirmation is unavailable"],
  ["page", { transport: "page-no-build-v1" }, "pending", "Public Page confirmation is unavailable"],
  ["home", { owner: "page-no-build-v1" }, "pending", "Public Home refresh confirmation is unavailable"],
  ["postProof", {}, "failed", "Public Post check is unavailable"],
  ["background", {}, "failed", "background_generation_failed"],
];

it.each(families)("preserves %s attempt budgets, lease and failure feedback", (family, identity, failedStatus, error) => {
  const original = { ...identity, status: "pending", attempts: 0, nextAttemptAt: 1_000, claim: null };
  expect(policy.publicationAttempt(original, family, 999)).toBeNull();
  expect(policy.publicationAttempt(original, family, 1_000)).toBe("claim");
  // Each failure's due time comes from the existing 1m/2m/4m contract.
  for (const [attempts, due] of [[1, 61_000], [2, 121_000], [3, 241_000], [4, null]]) {
    const row = { ...original, attempts: attempts - 1 };
    const claimed = { ...row, ...policy.publicationClaim(row, "claim", 1_000) };
    expect(claimed).toMatchObject({ attempts, claim: "claim", nextAttemptAt: 61_000 });
    expect(policy.publicationAttempt(claimed, family, 60_999)).toBeNull();
    expect(policy.publicationAttempt(claimed, family, 61_000)).toBe(attempts === 4 ? "exhaust" : "claim");
    expect(policy.publicationFailure(claimed, family, 1_000)).toEqual({
      status: attempts === 4 ? "failed" : failedStatus, claim: null, nextAttemptAt: due, error,
    });
  }
  expect(original).toEqual({ ...identity, status: "pending", attempts: 0, nextAttemptAt: 1_000, claim: null });
});

it("retains Home's initial child shape and the separate proof's exhausted status", () => {
  expect(policy.publicationAttempt({ owner: "page-no-build-v1", status: "pending" }, "home", 0)).toBe("claim");
  expect(policy.publicationAttempt({ transport: "page-no-build-v1", status: "pending" }, "page", 0)).toBeNull();
  const row = { status: "pending", attempts: 4, nextAttemptAt: 0, claim: null };
  expect(policy.publicationAttempt(row, "postProof", 0)).toBe("exhaust");
  expect(policy.publicationAttempt({ ...row, status: "failed" }, "postProof", 0)).toBeNull();
  expect(policy.publicationAttempt({ ...row, transport: "post-no-build-v1" }, "post", 0)).toBeNull();
});

it.each(families.slice(0, 3))("keeps %s manual retry behind its own owner and an unclaimed failure", (family, identity) => {
  const row = { ...identity, status: "failed", claim: null };
  expect(policy.publicationRetry(row, family)).toBe(true);
  expect(policy.publicationRetry({ ...row, claim: "active" }, family)).toBe(false);
  expect(policy.publicationRetry({ ...row, status: "pending" }, family)).toBe(false);
  expect(policy.publicationRetry({ ...row, transport: "foreign", owner: "foreign" }, family)).toBe(false);
});

it("limits slow transient retries and longer leases to their original background instance", () => {
  const row = { status: "failed", attempts: 4, nextAttemptAt: null, claim: null,
    lastAttempt: { retryable: true, failureClass: "lease_lost" }, slowRetryAt: 600_000 };
  expect(policy.publicationAttempt(row, "background", 599_999)).toBeNull();
  expect(policy.publicationAttempt(row, "background", 600_000)).toBe("claim");
  expect(policy.publicationClaim(row, "slow", 600_000, 90_000)).toEqual({ attempts: 5, claim: "slow", nextAttemptAt: 690_000 });
  expect(policy.publicationAttempt({ ...row, lastAttempt: { retryable: false, failureClass: "validation" } }, "background", 600_000)).toBeNull();
  expect(policy.publicationAttempt(row, "postProof", 600_000)).toBeNull();
  expect(policy.publicationAttempt({ ...row, transport: "post-no-build-v1" }, "post", 600_000)).toBeNull();
});

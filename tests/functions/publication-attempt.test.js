import { expect, it } from "vitest";
import policy from "../../functions/lib/background-output-attempt.js";

const families = [
  ["post", { transport: "post-no-build-v1" }, "pending", "Public Post confirmation is unavailable"],
  ["page", { transport: "page-no-build-v1" }, "pending", "Public Page confirmation is unavailable"],
  ["home", { owner: "page-no-build-v1" }, "pending", "Public Home refresh confirmation is unavailable"],
  ["postProof", {}, "failed", "Public Post check is unavailable"],
];
const refused = Object.assign(new Error("Public Post receipt does not match"), { code: "public_receipt_refused" });

it.each(families)("%s waits without an attempt cap and ends only on a refused public answer", (family, identity, waiting, error) => {
  const original = { ...identity, status: "pending", attempts: 0, nextAttemptAt: 1_000, claim: null };
  expect(policy.publicationAttempt(original, family, 999)).toBeNull();
  let row = original;
  for (let wake = 0; wake < 8; wake++) {
    const due = row.nextAttemptAt;
    expect(policy.publicationAttempt(row, family, due)).toBe("claim");
    const claimed = { ...row, ...policy.publicationClaim(row, "claim", due) };
    // Row readers know 4 as the end, so a waiting row stays below it.
    expect(claimed).toMatchObject({ attempts: Math.min(wake + 1, 3), claim: "claim" });
    expect(policy.publicationAttempt(claimed, family, due + 60_000)).toBeNull();
    expect(policy.publicationFailure(claimed, family, due, refused)).toEqual({
      status: "failed", attempts: 4, claim: null, nextAttemptAt: null, error });
    row = { ...claimed, ...policy.publicationFailure(claimed, family, due, new Error("The state moved")) };
    expect(row).toMatchObject({ status: waiting, claim: null, nextAttemptAt: due + 60_000, error });
  }
  expect(original).toEqual({ ...identity, status: "pending", attempts: 0, nextAttemptAt: 1_000, claim: null });
});

it("retains Home's initial child shape and refuses a malformed row", () => {
  expect(policy.publicationAttempt({ owner: "page-no-build-v1", status: "pending" }, "home", 0)).toBe("claim");
  expect(policy.publicationAttempt({ transport: "page-no-build-v1", status: "pending" }, "page", 0)).toBeNull();
  const row = { status: "failed", attempts: 4, nextAttemptAt: null, claim: null };
  expect(policy.publicationAttempt(row, "postProof", 0)).toBeNull();
  expect(policy.publicationAttempt({ ...row, transport: "post-no-build-v1", nextAttemptAt: 0, attempts: -1 }, "post", 0)).toBeNull();
});

it("keeps the background owner's attempt contract", () => {
  const row = { status: "failed", attempts: 3, nextAttemptAt: 1_000, claim: null };
  expect(policy.publicationAttempt({ ...row, attempts: 4 }, "background", 1_000)).toBe("exhaust");
  expect(policy.publicationFailure(row, "background", 1_000)).toMatchObject({ status: "failed", nextAttemptAt: 241_000 });
  expect(policy.publicationFailure({ ...row, attempts: 4 }, "background", 1_000)).toMatchObject({ status: "failed", nextAttemptAt: null });
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

import { describe, expect, it } from "vitest";
import policy from "../../functions/lib/background-output-attempt.js";
import recovery from "../../functions/lib/no-build-post-recovery.js";

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

describe("which public answers are final", () => {
  const current = { rendererSha: "a".repeat(40), contextDigest: "b".repeat(64) };
  const answer = (status, headers = {}) => Object.assign(new Error("Refused"), { code: "public_receipt_refused",
    origin: policy.publicAnswerOrigin(new Response(null, { status, headers })) });
  const from = ({ rendererSha, contextDigest }) => ({ "x-njpbs-renderer-sha": rendererSha, "x-njpbs-context-sha256": contextDigest });

  it("ends on a wrong receipt from the current renderer and context", () => {
    expect(policy.publicAnswerRefused(answer(200, from(current)), current)).toBe(true);
    expect(policy.publicAnswerRefused(answer(410, from(current)), current)).toBe(true);
    expect(policy.publicAnswerRefused(refused, current)).toBe(true);
  });

  it("waits for another renderer, another context and an unmarked 410", () => {
    expect(policy.publicAnswerRefused(answer(200, from({ ...current, rendererSha: "c".repeat(40) })), current)).toBe(false);
    expect(policy.publicAnswerRefused(answer(200, from({ ...current, contextDigest: "d".repeat(64) })), current)).toBe(false);
    expect(policy.publicAnswerRefused(answer(410, { "x-njpbs-gone-branch": "post-reader-deleted" }), current)).toBe(false);
    // A deployment under way has no current renderer yet.
    expect(policy.publicAnswerRefused(answer(200, from(current)))).toBe(false);
  });

  it("ends on a durable withdrawal and on an answer with no receipt at all", () => {
    expect(policy.publicAnswerRefused(answer(410, { "x-njpbs-withdrawal-revision": "4" }), current)).toBe(true);
    expect(policy.publicAnswerRefused(answer(404), current)).toBe(true);
  });

  it("keeps a skewed answer's row pending with the next wake", () => {
    const row = { transport: "page-no-build-v1", status: "pending", attempts: 2, nextAttemptAt: 0, claim: "claim" };
    const old = answer(200, from({ ...current, rendererSha: "c".repeat(40) }));
    expect(policy.publicationFailure(row, "page", 1_000, old, current)).toMatchObject({ status: "pending", nextAttemptAt: 61_000 });
    expect(policy.publicationFailure(row, "page", 1_000, answer(200, from(current)), current))
      .toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null });
  });
});

it.each([500, 503, 520, 522, 525, 429])("reads again after a %i that carries no public receipt", async status => {
  const answers = [new Response(null, { status }), new Response("ok")];
  const read = once => recovery.readPublicPostAfterRefresh("https://njpbs.org/posts/x/", async () => answers.shift(), undefined, {}, { once });
  await expect(read(true)).rejects.toMatchObject({ code: recovery.REFRESH_PENDING });
  expect((await read(true)).status).toBe(200);
});

it("judges a 500 that carries a public header", async () => {
  const response = await recovery.readPublicPostAfterRefresh("https://njpbs.org/posts/x/",
    async () => new Response(null, { status: 500, headers: { "x-njpbs-content-source": "cms-no-build" } }), undefined, {}, { once: true });
  expect(response.status).toBe(500);
});

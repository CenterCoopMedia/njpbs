import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CmsRateLimiter } from "../src/rate-limiter";

function limiter(name: string) {
  const namespace = env.RATE_LIMITERS as unknown as DurableObjectNamespace<CmsRateLimiter>;
  return namespace.getByName(name);
}

describe("CmsRateLimiter", () => {
  it("returns a bounded Retry-After and refills from persisted time", async () => {
    const stub = limiter("refill-test");
    const policy = { capacity: 2, refillPerSecond: 0.5, nowMs: 1_000 };

    await expect(stub.consume(policy)).resolves.toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await expect(stub.consume(policy)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
    await expect(stub.consume(policy)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 2,
    });

    await evictDurableObject(stub);
    await expect(
      limiter("refill-test").consume({ ...policy, nowMs: 3_000 }),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it("shares one budget across concurrent stubs", async () => {
    const firstWorker = limiter("shared-burst-test");
    const secondWorker = limiter("shared-burst-test");
    const request = { capacity: 3, refillPerSecond: 0.01, nowMs: 10_000 };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? firstWorker : secondWorker).consume(request),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
    expect(
      results.filter((result) => !result.allowed).every(
        (result) => result.retryAfterSeconds === 100,
      ),
    ).toBe(true);
  });

  it("persists batch costs and does not spend a refused batch", async () => {
    const stub = limiter("weighted-poster-batch");
    const policy = { capacity: 120, refillPerSecond: 2, cost: 100, nowMs: 1_000 };
    await expect(stub.consume(policy)).resolves.toEqual({
      allowed: true, remaining: 20, retryAfterSeconds: 0,
    });
    await evictDurableObject(stub);
    const reopened = limiter("weighted-poster-batch");
    await expect(reopened.consume(policy)).resolves.toEqual({
      allowed: false, remaining: 20, retryAfterSeconds: 40,
    });
    await expect(reopened.consume({ ...policy, cost: 20 })).resolves.toMatchObject({
      allowed: true, remaining: 0,
    });
    await expect(reopened.consume({ ...policy, nowMs: 51_000 })).resolves.toMatchObject({
      allowed: true, remaining: 0,
    });
  });

  it.each([0, -1, 1.5, 121, Number.NaN])("rejects an invalid batch cost %s", async (cost) => {
    // Catch inside the real object: The test pool reports rejected RPCs twice.
    const rejection = await runInDurableObject(limiter(`invalid-cost-${cost}`),
      instance => instance.consume({ capacity: 120, refillPerSecond: 2, cost })
        .then(() => null, error => error.message));
    expect(rejection).toBe("Rate limit cost must be a whole number within capacity");
  });
});

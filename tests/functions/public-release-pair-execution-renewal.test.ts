import { expect, it, vi } from "vitest";
import { publicReleasePairExecutionRenewal } from "../../site/scripts/public-release-pair-execution-renewal";
it("coalesces overlapping checkpoints and renews long work before original lease expiry", async () => {
  let time = 0, release!: (value: { leaseUntil: number }) => void;
  const original = vi.fn(() => new Promise<{ leaseUntil: number }>(resolve => { release = resolve; }));
  const renew = publicReleasePairExecutionRenewal(original, new AbortController().signal, () => time);
  const first = renew(), overlap = renew(); expect(original).toHaveBeenCalledTimes(1);
  release({ leaseUntil: 60_000 }); await Promise.all([first, overlap]);
  time = 14_999; await renew(); expect(original).toHaveBeenCalledTimes(1);
  time = 15_000; const next = renew(); expect(original).toHaveBeenCalledTimes(2);
  release({ leaseUntil: 75_000 }); expect(await next).toEqual({ leaseUntil: 75_000 });
});
it("never hides renewal failure or external abort behind a retained checkpoint", async () => {
  const failure = new Error("original claim lost"), original = vi.fn(async () => { throw failure; });
  const renew = publicReleasePairExecutionRenewal(original, new AbortController().signal);
  await expect(renew()).rejects.toBe(failure); await expect(renew()).rejects.toBe(failure); expect(original).toHaveBeenCalledTimes(1);
  const controller = new AbortController(), cached = publicReleasePairExecutionRenewal(async () => ({ leaseUntil: 60_000 }), controller.signal);
  await cached(); controller.abort(); await expect(cached()).rejects.toThrow();
});

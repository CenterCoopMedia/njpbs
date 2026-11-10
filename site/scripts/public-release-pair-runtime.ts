import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";

/** Stop waiting for an executor that ignores a lost/expired lease. Its old
 * claim-specific storage prefix remains separate from the replacement attempt.
 */
export async function withPublicReleasePairExecutionLease<T>({ leaseUntil, clock = Date.now, signal, execute, renew }: {
  leaseUntil: number;
  clock?: () => number;
  signal?: AbortSignal;
  execute(context: { signal: AbortSignal; renew(): Promise<{ leaseUntil: number }> }): Promise<T>;
  renew(): Promise<{ leaseUntil: number }>;
}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectLease: (reason: work.PairExecutionError) => void = () => {};
  const expired = new Promise<never>((_, reject) => { rejectLease = reject; });
  const lose = (code: "lease-expired" | "lease-lost") => {
    controller.abort();
    rejectLease(new work.PairExecutionError(code));
  };
  const arm = (until: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => lose("lease-expired"), Math.max(0, until - clock()));
  };
  const stop = () => lose("lease-lost");
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  arm(leaseUntil);
  try {
    return await Promise.race([expired, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new work.PairExecutionError("lease-lost");
      return execute({ signal: controller.signal,
      renew: async () => {
        if (controller.signal.aborted) throw new work.PairExecutionError("lease-lost");
        let renewed: { leaseUntil: number };
        try { renewed = await renew(); }
        catch { lose("lease-lost"); throw new work.PairExecutionError("lease-lost"); }
        if (controller.signal.aborted) throw new work.PairExecutionError("lease-lost");
        arm(renewed.leaseUntil);
        return renewed;
      } });
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** Pair-local work runner with an executor that verifies and retains exact-source
 * view bytes. Long work renews its lease through the supplied callback. This
 * runner never constructs the global activation owner.
 */
export async function runPublicReleasePairWorkOnce({ firestore, pair, execute, clock = Date.now, signal, stage, beforePoll }: {
  firestore: Firestore;
  pair: PublicReleasePair;
  execute(input: {
    identity: work.PairTaskIdentity;
    outputPrefix: string;
    renew(): Promise<{ leaseUntil: number }>;
    signal: AbortSignal;
  }): Promise<{ manifestDigest: string }>;
  stage?(input: { identity: work.PairTaskIdentity; claimDigest: string; manifestDigest: string; signal?: AbortSignal }): Promise<void>;
  clock?: () => number;
  signal?: AbortSignal;
  beforePoll?(input: { signal?: AbortSignal }): Promise<void>;
}): Promise<"idle" | "complete" | "retry-recorded"> {
  await beforePoll?.({ signal });
  const { taskIds } = await work.readPublicReleasePairWork({ firestore, pair, now: clock() });
  if (!taskIds.length) return "idle";
  const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId: taskIds[0], now: clock() });
  if (!claim) return "idle";
  let result: { manifestDigest: string };
  try {
    result = await withPublicReleasePairExecutionLease({ leaseUntil: claim.leaseUntil, clock, signal,
      execute: context => execute({ identity: claim.identity, outputPrefix: claim.outputPrefix, ...context }),
      renew: async () => {
        try { return await work.renewPublicReleasePairWork({ firestore, pair, taskId: claim.taskId, token: claim.token, now: clock() }); }
        catch { throw new work.PairExecutionError("lease-lost"); }
      } });
  } catch (error) {
    const now = clock();
    const failureCode = error instanceof work.PairExecutionError ? error.code : "unexpected-executor-error";
    try {
      await work.settlePublicReleasePairWork({ firestore, pair, taskId: claim.taskId, token: claim.token,
        manifestDigest: null, retryAt: now + 1_000, failureCode, now });
    } catch { throw new work.PairExecutionError(failureCode); }
    return "retry-recorded";
  }
  // An uncertain settlement must propagate to durable reconciliation; never
  // re-run execution or convert an already committed receipt into a failure.
  await work.settlePublicReleasePairWork({ firestore, pair, taskId: claim.taskId, token: claim.token,
    manifestDigest: result.manifestDigest, now: clock() });
  await stage?.({ identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token),
    manifestDigest: result.manifestDigest, signal });
  return "complete";
}

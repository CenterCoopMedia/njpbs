import { performance } from "node:perf_hooks";
/** Checkpoints can occur once per file/output, while a lease needs at most
 * one renewal per quarter of its 60-second duration. Coalesce concurrent calls
 * and keep the runner's original expiry/abort and final owner checks intact. */
export function publicReleasePairExecutionRenewal(renew: () => Promise<{ leaseUntil: number }>, signal: AbortSignal,
  now = () => performance.now()) {
  let previous: { leaseUntil: number } | undefined, renewedAt = -Infinity, pending: Promise<{ leaseUntil: number }> | undefined;
  let failure: unknown, failed = false;
  return async () => {
    signal.throwIfAborted();
    if (failed) throw failure;
    if (pending) return pending;
    if (previous && now() - renewedAt < 15_000) return previous;
    pending = renew().then(value => {
      signal.throwIfAborted(); previous = value; renewedAt = now(); return value;
    }).catch(error => { failed = true; failure = error; throw error; }).finally(() => { pending = undefined; });
    return pending;
  };
}

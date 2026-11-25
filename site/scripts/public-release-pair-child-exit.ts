import work from "../../functions/lib/public-release-pair-work.js";

/** The sandboxed renderer has no output channel but its exit code. It exits with
 * this code (EX_TEMPFAIL) when the host had no room or handle for it. */
export const PAIR_RENDER_RETRY_EXIT = 75;

/** A failed child process says nothing about the frozen input only when it was
 * killed (bwrap reports 128 plus the signal) or the host had no capacity. */
export function pairRenderFailure(code: number | null, failed = false): "render-interrupted" | "render-failed" {
  return failed || code === null || code > 128 || code === PAIR_RENDER_RETRY_EXIT ? "render-interrupted" : "render-failed";
}

/** The sandbox has no network, so only host capacity can pass on its own here.
 * A missing service answer is a render that asked for one and stays final. */
export function exitWithPairRenderFailure() {
  process.once("uncaughtException", error => {
    console.error(error);
    process.exit(work.isHostCapacityFailure(error) ? PAIR_RENDER_RETRY_EXIT : 1);
  });
}

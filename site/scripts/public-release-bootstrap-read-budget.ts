import { performance } from "node:perf_hooks";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { prepareBootstrapQualificationGuard } from "./bootstrap-public-release-selector";
import { withinReaderDeadline } from "./public-release-pair-reader-contract";

export const BOOTSTRAP_READ_BUDGET_MS = 30_000;
export const BOOTSTRAP_READ_MEASUREMENT_LIMIT_MS = BOOTSTRAP_READ_BUDGET_MS / 2;
export class BootstrapReadBudgetError extends Error {
  constructor(readonly measurement: ReturnType<typeof receipt>) { super("Bootstrap full-closure read budget was refused"); }
}
function receipt(attempt: ReturnType<typeof bootstrap.parseBootstrapAttempt>, elapsed: number, completed: boolean) {
  const value = { schemaVersion: 2, kind: "public-release-bootstrap-read-measurement", attemptDigest: protocol.publicReleaseDigest(attempt),
    pairDigests: [attempt.currentPair, attempt.recoveryPair].map(protocol.publicReleaseDigest), qualifications: attempt.qualifications,
    elapsedMilliseconds: elapsed, budgetMilliseconds: BOOTSTRAP_READ_BUDGET_MS, maximumMilliseconds: BOOTSTRAP_READ_MEASUREMENT_LIMIT_MS,
    completed, accepted: completed && elapsed <= BOOTSTRAP_READ_MEASUREMENT_LIMIT_MS };
  return Object.freeze({ ...value, receiptDigest: protocol.publicReleaseDigest(value) });
}

/** Timed, read-only traversal of BOTH actual full qualified closures. It uses
 * the real owner and guarded transport with every per-GET authority check;
 * no object/byte memo, batching or serialized timing receipt can authorize CAS.
 * Even an accepted measurement retains the original shared 30s deadline for
 * the later source guards and transaction budget. A separate measure run is
 * informational; apply always repeats this fresh preparation itself. */
export async function prepareMeasuredBootstrapQualification({ clock = () => performance.now(), ...input }:
  Parameters<typeof prepareBootstrapQualificationGuard>[0] & { clock?: () => number }) {
  const attempt = bootstrap.parseBootstrapAttempt(input.attempt), start = clock();
  if (!Number.isFinite(start)) throw new Error("Bootstrap measurement clock was refused");
  const signal = AbortSignal.any([AbortSignal.timeout(BOOTSTRAP_READ_BUDGET_MS), ...(input.signal ? [input.signal] : [])]);
  let guard: Awaited<ReturnType<typeof prepareBootstrapQualificationGuard>> | undefined;
  try { guard = await withinReaderDeadline(signal, () => prepareBootstrapQualificationGuard({ ...input, attempt, signal })); }
  catch { /* Only safe receipt metadata is returned; provider errors stay private. */ }
  const elapsed = clock() - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Bootstrap measurement clock was refused");
  const measurement = receipt(attempt, elapsed, guard !== undefined && !signal.aborted);
  if (!measurement.accepted || !guard) throw new BootstrapReadBudgetError(measurement);
  return { qualificationGuard: guard, measurement };
}

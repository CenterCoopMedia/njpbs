import type { PublicReleasePair, PublicReleaseSelector } from "../packages/content-core/src/public-release";
import p from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";

/** A durable wake hint only. Actual CODE/source/lease authority is derived
 * independently in the private server transaction before any owner write. */
export async function pendingSelectedSwitchCode({ pair, selector, now, read }: {
  pair: PublicReleasePair; selector: PublicReleaseSelector; now: number;
  read(path: string): Promise<Record<string, unknown> | null>;
}) {
  if (selector.epoch < 2 || p.publicReleaseDigest(selector.selectedPair) !== p.publicReleaseDigest(p.publicReleasePairReference(pair))) return false;
  const operationId = p.publicReleaseDigest({ kind: "public-release-switch", operationId: selector.switchOperationId });
  const base = work.publicReleasePairPath(pair.pairId);
  if (await read(`${base}/switchCodeActivations/${operationId}`)) return false;
  const pending = await read(`${base}/switchCodePending/${operationId}`);
  if (!pending) return true;
  if (pending.schemaVersion !== 2 || pending.kind !== "switch-code-pending" || pending.operationId !== operationId ||
      pending.pairDigest !== p.publicReleaseDigest(pair) || pending.nextAttemptAt !== null &&
      (!Number.isSafeInteger(pending.nextAttemptAt) || Number(pending.nextAttemptAt) < 0)) throw new Error("Private CODE continuation differs");
  if (pending.lease !== null) {
    const lease = pending.lease as Record<string, unknown> | undefined;
    if (!lease || !Number.isSafeInteger(lease.until) || Number(lease.until) < 1) throw new Error("Private CODE lease differs");
    if (Number(lease.until) > now) return false;
  }
  return pending.nextAttemptAt !== null && Number(pending.nextAttemptAt) <= now;
}

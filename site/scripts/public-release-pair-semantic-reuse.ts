import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import views from "../../functions/lib/public-release-pair-view.js";

/** One bounded, process-local index from actual completed G readback. This
 * grants no source/output authority, and is discarded at a selector switch. */
export function publicReleasePairSemanticReuse(pair: PublicReleasePair, readSelector: () => Promise<unknown>) {
  let retained: { switchKey: string; bytes: Uint8Array } | undefined;
  let pending: { taskId: string; claimDigest: string; switchKey: string | null } | undefined;
  const switchKey = async () => {
    try {
      const selector = protocol.parseVersionedPublicDeployment(await readSelector());
      return protocol.publicReleaseDigest(selector.schemaVersion === 2 ? {
        epoch: selector.epoch, selectedPair: selector.selectedPair, recoveryPair: selector.recoveryPair,
        activeGeneration: selector.activeGeneration, switchOperationId: selector.switchOperationId,
      } : selector);
    } catch { return null; } // Optional computation reuse; all authority checks remain with the executor.
  };
  return {
    async begin(identity: PairTaskIdentity, claimDigest: string) {
      const taskId = protocol.publicReleaseDigest(views.parseViewIdentity(identity, pair));
      const key = await switchKey();
      if (!key || retained?.switchKey !== key) retained = undefined;
      pending = { taskId, claimDigest, switchKey: key };
      return retained ? new Uint8Array(retained.bytes) : undefined;
    },
    async staged(identity: PairTaskIdentity, claimDigest: string, bytes?: Uint8Array) {
      const before = pending; pending = undefined;
      const key = await switchKey();
      if (!before || !key || before.switchKey !== key || before.claimDigest !== claimDigest ||
          before.taskId !== protocol.publicReleaseDigest(views.parseViewIdentity(identity, pair)) ||
          !bytes || bytes.length < 1 || bytes.length > views.BODY_BYTES_LIMIT) {
        retained = undefined; return;
      }
      retained = { switchKey: key, bytes: new Uint8Array(bytes) };
    },
  };
}

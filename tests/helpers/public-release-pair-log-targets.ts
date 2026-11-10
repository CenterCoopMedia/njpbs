import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairClaim } from "../../functions/lib/public-release-pair-work";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { createHash } from "node:crypto";
import {
  isPublicReleasePairProjection,
  projectPublicReleasePairReplay,
} from "../../site/scripts/public-release-pair-replay";
import {
  openPublicReleasePairReplayContext,
  writePublicReleasePairReplayProof,
  preparePublicReleasePairReplayReadback,
} from "../../site/scripts/public-release-pair-replay-storage";
import { readPublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
type Owner = {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  claim: PairClaim;
  claimDigest: string;
  manifestDigest: string;
  manifestBytes: number;
};
/** Use the executor's actual target producer. The supplied rendered bytes are
 * fixed fixture data; their hashes bind those exact G bytes to real projections. */
export async function writeReplayTargetFixture(options: Owner & { bodies: Map<string, Uint8Array> }) {
  const owner = { ...options, identity: options.claim.identity, viewManifestDigest: options.manifestDigest };
  const captured = await openPublicReleasePairReplayContext(owner);
  async function* targets() {
    for (const route of captured.plan.routes) {
      if (!isPublicReleasePairProjection(route.renderer)) continue;
      const context = await captured.context(route),
        projected = await projectPublicReleasePairReplay(context);
      const bytes = options.bodies.get(route.path);
      if (!bytes) throw new Error("Missing fixture renderer output");
      yield { receipt: projected.receipt, bodyDigest: createHash("sha256").update(bytes).digest("hex"), status: 200 };
    }
  }
  await writePublicReleasePairReplayProof({ ...owner, targets: targets() });
}
export async function stageReplayTargetFixture(options: Owner) {
  const owner = { ...options, identity: options.claim.identity, viewManifestDigest: options.manifestDigest };
  const verification = await preparePublicReleasePairReplayReadback(owner);
  for await (const output of readPublicReleasePairView({
    ...owner,
    manifestDigest: options.manifestDigest,
    manifestBytes: options.manifestBytes,
  }))
    await verification.output(output);
  await verification.complete();
  await verification.persist();
}

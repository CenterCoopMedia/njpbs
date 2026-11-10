import type { Firestore } from "firebase-admin/firestore";
import holds, { type RehearsalHoldPlan } from "../../functions/lib/public-release-rehearsal-hold.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { preparePublicReleasePublicationTerminal, releasePreparedPublicReleaseRehearsalHold } from "./public-release-publication-terminal";

export { reserveRehearsalPublicationHold, readRehearsalPublicationHold, cancelRehearsalPublicationHold } from "../../functions/lib/public-release-rehearsal-hold.js";
export type { RehearsalHoldPlan } from "../../functions/lib/public-release-rehearsal-hold.js";

/** Private installed-rehearsal action. Caller binds the existing sealed
 * continuation's GET-only terminal/ingress transport, never ordinary fetch.
 * It grants no installation, new acceptance or provider mutation. */
export async function releaseRehearsalPublicationHold(options: Omit<Parameters<typeof preparePublicReleasePublicationTerminal>[0], "operationId"> & {
  firestore: Firestore; plan: RehearsalHoldPlan; holdDigest: string; actionId: string; enabled?: boolean;
}) {
  if (options.enabled !== true) throw new protocol.PublicReleaseProtocolError();
  const plan = holds.parsePlan(options.plan);
  if (options.actionId !== plan.releaseActionId) throw new protocol.PublicReleaseProtocolError();
  options.signal?.throwIfAborted();
  const original = await holds.readRehearsalPublicationHold({ firestore: options.firestore, plan });
  if (!original || protocol.publicReleaseDigest(original.intent) !== options.holdDigest) throw new protocol.PublicReleaseProtocolError();
  if (original.outcome?.outcome === "released") return { idempotent: true, outcome: original.outcome };
  if (original.status !== "held") throw new protocol.PublicReleaseProtocolError();
  const proof = await preparePublicReleasePublicationTerminal({ ...options, operationId: plan.operationId });
  options.signal?.throwIfAborted();
  return releasePreparedPublicReleaseRehearsalHold({ ...options, plan, proof });
}

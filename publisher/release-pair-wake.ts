import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import pairs from "../functions/lib/public-release-pair.js";

export type PairWakeIdentity = Readonly<{ pairId: string; commitSha: string; environment: string; journalNamespace: string }>;

/** Private-binding adapter for a later pair-aware Worker entrypoint. No HTTP
 * route is added. Both a wake and minute recovery re-read durable work; event
 * order, caller-supplied job ids and old active-release defaults are irrelevant.
 */
export async function wakePublicReleasePair({ pair: rawPair, identity, readWork, start }: {
  pair: PublicReleasePair;
  identity: PairWakeIdentity;
  readWork(): Promise<{ taskIds: string[]; stagingPending?: boolean; activationPending?: boolean; publicationPending?: boolean }>;
  start(): Promise<void>;
}): Promise<boolean> {
  const pair = pairs.parsePublicReleasePair(rawPair);
  if (!identity || Object.keys(identity).length !== 4 || identity.pairId !== pair.pairId ||
      identity.commitSha !== pair.commitSha || identity.environment !== pair.environment ||
      identity.journalNamespace !== pair.publisher.journalNamespace) throw new Error("Publisher wake pair differs");
  const work = await readWork();
  if (!work.taskIds.length && work.stagingPending !== true && work.activationPending !== true && work.publicationPending !== true) return false;
  await start();
  return true;
}

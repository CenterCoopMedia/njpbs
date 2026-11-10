import { releasePair, pairReference } from "./public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { publicReleaseBaselineCodeFixture } from "./public-release-baseline-code.ts";
export async function enrollPublicReleaseLog(db, sha = "a".repeat(40)) {
  const pair = releasePair("a", sha), head = log.initialPublicReleaseChangeHead("f".repeat(64));
  await db.doc(work.publicReleasePairPath(pair.pairId)).set(pair);
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  const code = publicReleaseBaselineCodeFixture(db, sha);
  await baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch: "fixture-epoch" });
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: "fixture-epoch", pair: pairReference(pair), head });
  return { pair, head };
}
export async function publicReleaseEntries(db) {
  return (await db.collection(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries`).orderBy("sequence").get()).docs.map(row => row.data());
}

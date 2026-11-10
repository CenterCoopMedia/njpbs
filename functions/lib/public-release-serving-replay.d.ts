import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector, PublicReleaseChangeHead } from "../../packages/content-core/src/public-release";
import type { PairViewLocator } from "./public-release-serving";
export function readComposedPairArtifactInTransaction(input: { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  contentHead: PublicReleaseSelector["contentHead"]; changes: PublicReleaseChangeHead; path: string }): Promise<{
  locator: PairViewLocator; proofLocator: PairViewLocator | null; artifactPath: string; expectedBodyDigest: string | null; absent: boolean; witnessDigest: string;
}>;

import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleaseChange } from "../../packages/content-core/src/public-release";
export type PublicReleaseChangeEvidence = {
 entry: PublicReleaseChange;
 members: { change: PublicReleaseChange["changes"][number]; snapshot: any; contentDigest: string;
   body: { schemaVersion: 2; kind: PublicReleaseChange["changes"][number]["kind"]; id: string; action: PublicReleaseChange["changes"][number]["action"]; sourceVersion: number; snapshot: any; documents: { path: string; data: any }[] } }[];
 createdAt: number;
};
export function assertReadPublicReleaseChangeEvidenceInTransaction(options: { firestore: Firestore; transaction: Transaction; entry: unknown }): Promise<PublicReleaseChangeEvidence>;

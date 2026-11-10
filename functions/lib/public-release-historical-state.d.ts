import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PublicReleaseChangeBaseline, PublicReleaseSourceMember } from "./public-release-change-baseline";
import type { PublicReleaseChangeEvidence } from "./public-release-change-evidence";
export type HistoricalPublicReleaseState = {
 receipt: PublicReleaseChangeBaseline; logBaselineDigest: string; baselineMembers: PublicReleaseSourceMember[];
 cursor: { baselineDigest: string; sequence: number; lastDigest: string }; documents: Map<string, any>;
 sourceBodies: Map<string, PublicReleaseChangeEvidence["members"][number]["body"]>; sourceMembers: Map<string, string>;
 headroom?: ReturnType<typeof import("./public-release-source-limits").historicalSourceHeadroom>;
 accepted: PublicReleaseChangeEvidence[]; event: PublicReleaseChangeEvidence | null; originalPair: PublicReleasePair; renderedAt: string;
};
export function reconstructPublicReleaseState(options: { firestore: Firestore; sourceOperationId?: string; logBaselineDigest?: string }): Promise<HistoricalPublicReleaseState>;

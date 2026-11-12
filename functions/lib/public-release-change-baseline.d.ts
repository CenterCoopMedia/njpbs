import type { EnrollmentRequest, EnrollmentReceipt } from "./public-release-change-enrollment";
import type { Firestore, Transaction } from "firebase-admin/firestore";
export type PublicReleaseSourceMember = Readonly<{ collection: string; id: string; publicRevision: number | string; contentDigest: string }>;
import type { PublicReleaseChangeBaseline } from "./public-release-change-baseline-receipt";
export { parsePublicReleaseChangeBaseline, type PublicReleaseChangeBaseline } from "./public-release-change-baseline-receipt";
export function capturePublicReleaseChangeBaseline(options: { firestore: Firestore; logEpoch: string; codeAssetManifestDigest?: string | null; currentCodeRequest?: typeof fetch; readSecret?: () => string; enrollment?: EnrollmentRequest; dryRun?: boolean }): Promise<{
 receipt: PublicReleaseChangeBaseline; sourceMembers: PublicReleaseSourceMember[]; logBaselineDigest: string;
 enrollment?: { idempotent: boolean; receipt: EnrollmentReceipt; receiptDigest: string } }>;
export function assertReadPublicReleaseChangeBaselineInTransaction(options: { firestore: Firestore; transaction: Transaction; logBaselineDigest: string }): Promise<{
 receipt: PublicReleaseChangeBaseline; sourceMembers: PublicReleaseSourceMember[] }>;
export function readPublicReleaseSourceCensusInTransaction(options: { firestore: Firestore; transaction: Transaction }): Promise<{
 sourceMembers: PublicReleaseSourceMember[]; values: { contentDigest: string; json: string }[]; sourceMemberCensusDigest: string }>;

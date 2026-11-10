import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";

type PairUploadBase = Readonly<{
  kind: "private-pair-publisher-upload";
  accountId: string;
  imageReference: string;
  bundleDigest: string;
  configurationDigest: string;
}>;
export type PairUploadPlan = PairUploadBase & Readonly<{
  schemaVersion: 2;
  pairTemplate: Omit<PublicReleasePair, "publisher"> & { publisher: Omit<PublicReleasePair["publisher"], "workerVersionId"> };
} | {
  schemaVersion: 3;
  pairTemplate: Omit<PublicReleasePair, "publisher" | "publicWorker" | "readerReceiptDigest"> & {
    publisher: Omit<PublicReleasePair["publisher"], "workerVersionId">;
    publicWorker: Omit<PublicReleasePair["publicWorker"], "versionId">;
  };
  slotInstall: { operationId: string; readerOrigin: string };
}>;
export type PairFirstInstallMember = { name: string; planDigest: string; tag: string; workerId: string; versionId: string; deploymentId: string };
export type PairFirstInstallation = { operationId: string; installPlanDigest: string; slot: PairFirstInstallMember; ingress: PairFirstInstallMember };
/** Local parsing only; the unassigned candidate must never be persisted. */
export function publicReleasePairUploadCandidate(plan: PairUploadPlan, workerVersionId?: string): PublicReleasePair;
export function publicReleasePairUploadCompletionPath(pairId: string): string;
export function readPublicReleasePairUploadPair(input: { firestore: Firestore; plan: PairUploadPlan; workerVersionId: string }): Promise<PublicReleasePair>;
export function completePublicReleasePairUpload(input: { firestore: Firestore; plan: PairUploadPlan; pair: PublicReleasePair; installation: PairFirstInstallation }): Promise<{ idempotent: boolean; pair: PublicReleasePair }>;
export function assertPublicReleasePairFirstInstallSlot(input: { firestore: Firestore; pair: PublicReleasePair; operationId: string; readerOrigin: string }): Promise<void>;
export type PairUploadReadback = Readonly<{
  planDigest: string; publisherApplication: string; workerVersionId: string;
  bundleDigest: string; configurationDigest: string; imageDigest: string;
}>;
export type PairRolloutReadback = Readonly<{
  publisherApplication: string; publisherWorkerVersionId: string; imageDigest: string;
  publicService: string; publicWorkerVersionId: string;
  publisherDeploymentId: string; publicDeploymentId: string;
  publisherTrafficPercent: 100; publicTrafficPercent: 100;
}>;
export function parsePublicReleasePairUploadPlan(value: unknown): PairUploadPlan;
export function publicReleasePairUploadPath(pairId: string): string;
export function reservePublicReleasePairUpload(input: { firestore: Firestore; plan: PairUploadPlan }): Promise<{
  mayStartInstall: boolean; planDigest: string; state: "reserved" | "uncertain" | "uploaded"; workerVersionId: string | null;
}>;
export function recordPublicReleasePairUploadReadback(input: {
  firestore: Firestore; plan: PairUploadPlan; readback?: PairUploadReadback | null;
}): Promise<{ idempotent: boolean; workerVersionId: string | null }>;
export function reservePublicReleasePairRollout(input: { firestore: Firestore; pair: PublicReleasePair }): Promise<{
  mayStartProviderWrite: boolean; state: "reserved" | "uncertain" | "verified";
}>;
export function recordPublicReleasePairRolloutReadback(input: {
  firestore: Firestore; pair: PublicReleasePair; readback?: PairRolloutReadback | null;
}): Promise<{ idempotent: boolean }>;

export type PairInstallOperation = "identity" | "version" | "deployment" | "container" | "trigger";
export function reservePublicReleasePairInstallOperation(input: {
  firestore: Firestore; plan: PairUploadPlan; operation: PairInstallOperation; requestDigest: string;
}): Promise<{ mayStartProviderWrite: boolean; state: "reserved" | "uncertain" | "verified" }>;
export function recordPublicReleasePairInstallOperation(input: {
  firestore: Firestore; plan: PairUploadPlan; operation: PairInstallOperation; requestDigest: string; readbackDigest?: string | null;
}): Promise<{ idempotent: boolean }>;

export function assertPublicReleasePairUploadRegistration(transaction: Transaction, firestore: Firestore,
  pair: PublicReleasePair, registry: { schemaVersion: 2; pairIds: string[] }): Promise<void>;

import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { CurrentCodeReference } from "./current-public-code-source";
import type { PairCodeReference, PairCodePublication } from "./public-release-pair-code-reference";
export type PairScheduleCode = Readonly<{ selector: PublicReleaseSelector; pairCodeReference: PairCodeReference;
  descriptor: PairCodePublication["historicalCode"] }>;
export type QualifiedPairScheduleCode = Readonly<{ reference: CurrentCodeReference;
  publication: CurrentCodeReference["publication"]; publicContext: Readonly<Record<string, unknown>> }>;
export function readPairScheduleCodeInTransaction(input: { firestore: Firestore; transaction: Transaction;
  selector: PublicReleaseSelector; rendererSha: string; reference?: CurrentCodeReference;
  environment: "production" | "development" }): Promise<PairScheduleCode>;
export function createPairScheduleCodeContextReader(input: { firestore: Firestore; rendererSha: string;
  releaseSelector: PublicReleaseSelector; signal?: AbortSignal; environment: "production" | "development" }):
  (() => Promise<QualifiedPairScheduleCode>) & { readHistoricalCodeContext(): Promise<QualifiedPairScheduleCode>;
    readReference(): Promise<CurrentCodeReference> };

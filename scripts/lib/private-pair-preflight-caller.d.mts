import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";

export const PRIVATE_PREFLIGHT_ATTEMPTS: "privatePairPreflightAttempts";
export class PrivatePairPreflightError extends Error {
  constructor(code: string, uncertain?: boolean);
  code: string;
  uncertain: boolean;
  refusalHealth?: Readonly<{ ready: false; pairId: string; reason?: "billing-disabled" | "waiting-for-executor" | "not-ready" }>;
}
type PublisherIdentity = Readonly<{ pairId: string; commitSha: string; environment: "production" | "development"; journalNamespace: string }>;
type PreviewIdentity = Readonly<{ pairId: string; rendererSha: string; serializerId: string }>;
export type PrivatePairPreflightPlan = Readonly<{
  schemaVersion: 1; operationId: string; accountId: string; workerName: string; workerVersion: string; installedTargetDigest: string;
} & (
  { kind: "publisher"; identity: PublisherIdentity } |
  { kind: "preview"; identity: PreviewIdentity } |
  { kind: "reader-installation"; identity: PublicReleasePair }
)>;
export function preflightDigest(value: unknown): string;
export function parsePrivatePairPreflightPlan(value: unknown): PrivatePairPreflightPlan;
export function createPrivatePairPreflightCaller(options: {
  firestore: Firestore; plan: unknown;
  readToken(): string | Promise<string>;
  assertTargetCurrent(input: { plan: PrivatePairPreflightPlan }): string | Promise<string>;
  fetchImpl?: typeof fetch; clock?: () => number; signal?: AbortSignal;
}): (identity: unknown) => Promise<unknown>;

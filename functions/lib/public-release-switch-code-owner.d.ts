import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairInputScope } from "./public-release-pair-input";
import type { SwitchCodeSource } from "./public-release-switch-code-recovery";
export type SelectedSwitchCodeSource = Readonly<{ scope: PairInputScope; source: SwitchCodeSource; selector: PublicReleaseSelector }>;
export type SwitchCodePending = Readonly<{ schemaVersion: 2; kind: "switch-code-pending"; operationId: string; pairDigest: string;
  scope: PairInputScope; sourceDigest: string; lease: Readonly<{ token: string; until: number }> | null;
  nextAttemptAt: number | null; failures: number; lastFailure: null | "temporarily-unavailable" | "source-refused" | "replay-pending" | "work-failed" | "replay-predecessor-failed" }>;
export function switchCodeOperationId(operationId: string): string;
export function codePendingPath(pair: PublicReleasePair, operationId: string): string;
export function parseSwitchCodePending(value: unknown, pair: PublicReleasePair, owner: SelectedSwitchCodeSource): SwitchCodePending;
export function readSelectedSwitchCodeSourceInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; operationId?: string }): Promise<SelectedSwitchCodeSource | null>;
export function assertSelectedSwitchCodeCaptureLeaseInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; operationId: string; token: string; now: number }): Promise<Readonly<{ owner: SelectedSwitchCodeSource; pending: SwitchCodePending }>>;

export function assertSwitchCodeActivationInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; owner: SelectedSwitchCodeSource; value: unknown }): Promise<object>;

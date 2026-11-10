import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairInputScope, PairInputCursor } from "./public-release-pair-input";
export type SwitchCodeSource = Readonly<{ pairDigest: string; scopeDigest: string; eventDigest: string;
  selector: PublicReleaseSelector; source: Readonly<{ kind: "provider"; id: "public-code"; action: "dependency" }>; cursor: PairInputCursor }>;
export function readSwitchCodeSourceInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; scope: PairInputScope }): Promise<SwitchCodeSource>;
export function assertSwitchCodeRecoveryInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; scope: PairInputScope; inputManifestDigest: string }): Promise<Readonly<{
    pairDigest: string; scopeDigest: string; inputManifestDigest: string; eventDigest: string }>>;

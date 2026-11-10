import type { Firestore,Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair,PublicReleaseSelector,PublicReleaseChangeHead } from "../../packages/content-core/src/public-release";
export function readServingCursor(input:{firestore:Firestore;transaction:Transaction;global:PublicReleaseChangeHead;sequence:number}):Promise<PublicReleaseChangeHead>;
export function readActivatedPairServingHeadInTransaction(input:{firestore:Firestore;transaction:Transaction;pair:PublicReleasePair;
 current:PublicReleaseSelector;head:unknown;global:unknown}):Promise<{contentHead:PublicReleaseSelector["contentHead"];changes:PublicReleaseChangeHead}|null>;
